import { updateReviewSession, onReviewSessionDeleted } from './session.js';
import type { ReviewSession } from './session.js';
import type { ReviewTypeHandler } from './orchestrator.js';
import type { MessageSender } from '../transport/sender.js';
import { registerReviewHandler } from './orchestrator.js';
import { askClaudeWithContext } from '../ai/claude.js';
import { readVaultFile } from '../vault/files.js';
import { composeWriterContext } from '../writer/memory.js';
import { detectCompletionSentinel } from '../writer/sentinel.js';
import { captureLessons } from '../writer/capture.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('blog');

const SKILL_PATH = '.claude/skills/blog/SKILL.md';
const DEFAULT_INSTRUCTIONS = `You are a writing partner helping me develop a blog post through interview-style conversation.

Rules:
- Start by understanding what I want to say and why
- Help me find the story and structure through questions
- Surface the interesting angles I might be missing
- When we have enough material, propose an outline
- No artifacts or documents until I approve the outline`;

// Capture (parse → privacy → append → git commit) must never hold the blog turn
// open indefinitely — e.g. a `.git/index` lock contended by the nightly job. The
// user's reply is already sent before capture runs, so on timeout we log and
// close the session anyway.
const CAPTURE_TIMEOUT_MS = 20_000;

const sessionPrompts = new Map<string, string>();

/** Reject if `p` doesn't settle within `ms`, clearing the timer either way. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

onReviewSessionDeleted((id) => sessionPrompts.delete(id));

function gatherWritingContext(): string {
  const sections: string[] = [];

  // Voice is no longer read here — it's injected centrally via the `voice: true`
  // flag on askClaudeWithContext below, so a single source of truth (the system
  // prompt) carries it through every turn of the session.
  const topics = readVaultFile('writing/topics.md');
  if (topics?.trim()) {
    sections.push(`## Topic Queue\n${topics.trim()}`);
  }

  return sections.join('\n\n');
}

// The BASE blog instructions (skill/default text + topic queue). The writer
// role's SOUL charter is layered on top by composeWriterContext (project 12),
// which prepends SOUL to these instructions on the system channel and keeps the
// accumulating memory.md on the low-authority user channel.
function buildBaseInstructions(topic: string): string {
  const skill = readVaultFile(SKILL_PATH);
  const instructions = skill?.trim() || DEFAULT_INSTRUCTIONS;
  const writingContext = gatherWritingContext();

  const parts = [`You are a writing partner. Blog topic: ${topic}`, instructions];
  if (writingContext) {
    parts.push(writingContext);
  }
  return parts.join('\n\n');
}

const blogHandler: ReviewTypeHandler = {
  async start(session: ReviewSession, sender: MessageSender): Promise<void> {
    const topic = session.topic || 'untitled';

    // Compose the writer role: SOUL charter (+ base blog instructions) carries
    // system-prompt authority; the accumulating memory.md rides the first user
    // turn as low-authority reference, never the system prompt. Only the
    // memory-free systemInstructions is persisted as prepContext, so session
    // recovery (handleMessage) can never promote memory into the system channel.
    const { systemInstructions, referenceContext } = composeWriterContext(buildBaseInstructions(topic));
    sessionPrompts.set(session.claudeSessionId, systemInstructions);
    updateReviewSession(session.chatId, { prepContext: systemInstructions });

    await sender.send(session.chatId, `Blog session started: "${topic}"\nSend /done when finished.`);
    sender.startTyping(session.chatId);

    const topicTurn = `I want to write about: ${topic}`;
    const firstTurn = referenceContext ? `${referenceContext}\n\n${topicTurn}` : topicTurn;

    try {
      const result = await askClaudeWithContext(
        firstTurn,
        session.claudeSessionId,
        systemInstructions,
        { opLabel: 'review:blog', voice: true },
      );
      sender.stopTyping(session.chatId);

      if (result.error) {
        log.error('Blog start failed', { error: result.error });
        await sender.send(session.chatId, `Failed to start blog session: ${result.error}`);
        updateReviewSession(session.chatId, { phase: 'done' });
        return;
      }

      updateReviewSession(session.chatId, { phase: 'interview' });
      await sender.send(session.chatId, result.text || 'Ready to write together.');
    } catch (err) {
      sender.stopTyping(session.chatId);
      throw err;
    }
  },

  async handleMessage(session: ReviewSession, text: string, sender: MessageSender): Promise<void> {
    if (text.toLowerCase().trim() === '/done') {
      updateReviewSession(session.chatId, { phase: 'done' });
      sessionPrompts.delete(session.claudeSessionId);
      await sender.send(session.chatId, 'Blog session ended.');
      return;
    }

    let systemPrompt = sessionPrompts.get(session.claudeSessionId);
    if (!systemPrompt && session.prepContext) {
      log.info('Reconstructing system prompt from persisted prepContext', { sessionId: session.claudeSessionId });
      systemPrompt = session.prepContext;
      sessionPrompts.set(session.claudeSessionId, systemPrompt);
    }
    if (!systemPrompt) {
      log.error('Missing system prompt for blog session', { sessionId: session.claudeSessionId });
      await sender.send(session.chatId, 'Session context lost. Start a new /blog session.');
      updateReviewSession(session.chatId, { phase: 'done' });
      return;
    }

    sender.startTyping(session.chatId);
    try {
      const result = await askClaudeWithContext(text, session.claudeSessionId, systemPrompt, { opLabel: 'review:blog', voice: true });
      sender.stopTyping(session.chatId);

      if (result.error) {
        log.error('Blog message failed', { error: result.error });
        await sender.send(session.chatId, `Error: ${result.error}`);
        return;
      }

      // Server-owned closure: the writer can't issue /done, so it emits a
      // final-line sentinel. On detection, strip it from the user-visible reply,
      // run capture, and close the session.
      const raw = result.text || '';
      const detection = detectCompletionSentinel(raw);
      if (!detection.complete) {
        await sender.send(session.chatId, raw);
        return;
      }

      await sender.send(session.chatId, detection.cleaned || 'All set — session closed.');

      // Capture is fault-isolated: a parse/privacy/commit failure must never deny
      // the user their session close. The raw text (with the candidate block) is
      // the capture input; TS does the gating, filtering, and commit.
      try {
        await withTimeout(
          captureLessons({ assistantText: raw, fallbackTopic: session.topic ?? undefined }),
          CAPTURE_TIMEOUT_MS,
          'writer memory capture',
        );
      } catch (err) {
        log.error('Writer memory capture failed', { error: (err as Error).message });
      }

      // Close order mirrors the /done path: drop the in-memory prompt first, then
      // persist phase 'done'.
      sessionPrompts.delete(session.claudeSessionId);
      updateReviewSession(session.chatId, { phase: 'done' });
    } catch (err) {
      sender.stopTyping(session.chatId);
      throw err;
    }
  },
};

registerReviewHandler('blog', blogHandler);
