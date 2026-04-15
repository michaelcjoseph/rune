import TelegramBot from 'node-telegram-bot-api';
import { updateReviewSession, onReviewSessionDeleted } from './session.js';
import type { ReviewSession } from './session.js';
import type { ReviewTypeHandler } from './orchestrator.js';
import { registerReviewHandler } from './orchestrator.js';
import { askClaudeWithContext } from '../ai/claude.js';
import { readVaultFile } from '../vault/files.js';
import { sendLongMessage, startTyping, stopTyping } from '../integrations/telegram/client.js';
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

const sessionPrompts = new Map<string, string>();

onReviewSessionDeleted((id) => sessionPrompts.delete(id));

function gatherWritingContext(): string {
  const sections: string[] = [];

  const voice = readVaultFile('writing/voice.md');
  if (voice?.trim()) {
    sections.push(`## Writing Voice & Style\n${voice.trim()}`);
  }

  const topics = readVaultFile('writing/topics.md');
  if (topics?.trim()) {
    sections.push(`## Topic Queue\n${topics.trim()}`);
  }

  return sections.join('\n\n');
}

function buildSystemPrompt(topic: string): string {
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
  async start(session: ReviewSession, bot: TelegramBot): Promise<void> {
    const topic = session.topic || 'untitled';

    const systemPrompt = buildSystemPrompt(topic);
    sessionPrompts.set(session.claudeSessionId, systemPrompt);
    updateReviewSession(session.chatId, { prepContext: systemPrompt });

    await bot.sendMessage(session.chatId, `Blog session started: "${topic}"\nSend /done when finished.`);
    const typing = startTyping(bot, session.chatId);

    try {
      const result = await askClaudeWithContext(
        `I want to write about: ${topic}`,
        session.claudeSessionId,
        systemPrompt,
      );
      stopTyping(typing);

      if (result.error) {
        log.error('Blog start failed', { error: result.error });
        await bot.sendMessage(session.chatId, `Failed to start blog session: ${result.error}`);
        updateReviewSession(session.chatId, { phase: 'done' });
        return;
      }

      updateReviewSession(session.chatId, { phase: 'interview' });
      await sendLongMessage(bot, session.chatId, result.text || 'Ready to write together.');
    } catch (err) {
      stopTyping(typing);
      throw err;
    }
  },

  async handleMessage(session: ReviewSession, text: string, bot: TelegramBot): Promise<void> {
    if (text.toLowerCase().trim() === '/done') {
      updateReviewSession(session.chatId, { phase: 'done' });
      sessionPrompts.delete(session.claudeSessionId);
      await bot.sendMessage(session.chatId, 'Blog session ended.');
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
      await bot.sendMessage(session.chatId, 'Session context lost. Start a new /blog session.');
      updateReviewSession(session.chatId, { phase: 'done' });
      return;
    }

    const typing = startTyping(bot, session.chatId);
    try {
      const result = await askClaudeWithContext(text, session.claudeSessionId, systemPrompt);
      stopTyping(typing);

      if (result.error) {
        log.error('Blog message failed', { error: result.error });
        await bot.sendMessage(session.chatId, `Error: ${result.error}`);
        return;
      }

      await sendLongMessage(bot, session.chatId, result.text || '');
    } catch (err) {
      stopTyping(typing);
      throw err;
    }
  },
};

registerReviewHandler('blog', blogHandler);
