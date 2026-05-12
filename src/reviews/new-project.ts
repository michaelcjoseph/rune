import { updateReviewSession, onReviewSessionDeleted } from './session.js';
import type { ReviewSession } from './session.js';
import type { ReviewTypeHandler } from './orchestrator.js';
import type { MessageSender } from '../transport/sender.js';
import { registerReviewHandler } from './orchestrator.js';
import { askClaudeWithContext, runAgent } from '../ai/claude.js';
import { gitCommitAndPush } from '../vault/git.js';
import { PROJECT_ROOT } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('new-project');

// Searched against lowercased response — LLM output is "## Project Brief" (title-case)
const OUTLINE_MARKER_LOWER = '## project brief';

const DEFAULT_INSTRUCTIONS = `You are a product interviewer helping plan a new Jarvis project.

Your goal is to understand what the user wants to build through targeted, conversational questions.

Discovery areas (work through these naturally — don't list them all at once):
1. Problem/opportunity — what pain point or gap does this address?
2. User journey — how does the user trigger and interact with this feature?
3. Goals and non-goals — what's in scope vs. explicitly out of scope?
4. Technical approach — any preferences, constraints, or integration points?
5. Implementation phases — natural MVP vs. future phases?
6. Success criteria — how do we know this worked?

Rules:
- Ask 1-2 focused questions at a time, never a long list
- Probe for specifics when answers are vague ("what does that look like in practice?")
- Build on previous answers — don't ask for things already established
- After 5-10 exchanges (or when you have enough to write a full spec), synthesize a project brief
- Do not write any files or generate code during the interview

When ready, output the brief using EXACTLY this format (the ## header triggers the approval flow):

## Project Brief

**Name:** [Human-readable project name]
**Slug:** [kebab-case-slug for the directory, e.g. "my-feature-name"]

### Overview
[What this is, why it matters, how it fits into Jarvis — 2-4 sentences]

### Core Value Proposition
[One sentence: the key benefit to Jarvis]

### Goals
1. Primary: [main objective]
2. Secondary: [supporting objective]
3. Tertiary: [nice-to-have, if any]

### Non-Goals
- [explicitly out of scope]

### User Journey
[Step-by-step happy path with entry and exit points]

### Requirements
[WHEN/THEN style requirements grouped by feature area]

### Technical Approach
[New modules, integration points, key implementation notes]

### Implementation Phases
**Phase 1 — [Name]:** [deliverables]
**Phase 2 — [Name]:** [deliverables]

### Success Metrics
[How we measure success]

### Open Questions
- [Unresolved items, or "None" if resolved]`;

const APPROVAL_OPTIONS = [
  { value: 'yes', label: 'Approve & write spec' },
  { value: 'cancel', label: 'Cancel' },
];

const sessionPrompts = new Map<string, string>();

onReviewSessionDeleted((id) => sessionPrompts.delete(id));

function buildSystemPrompt(topic: string | null): string {
  const opener = topic ? `The user wants to build: ${topic}` : 'You are helping the user plan a new Jarvis project.';
  return `${opener}\n\n${DEFAULT_INSTRUCTIONS}`;
}

const newProjectHandler: ReviewTypeHandler = {
  async start(session: ReviewSession, sender: MessageSender): Promise<void> {
    const systemPrompt = buildSystemPrompt(session.topic);
    sessionPrompts.set(session.claudeSessionId, systemPrompt);
    // Persisted so the prompt can be reconstructed after a server restart
    updateReviewSession(session.chatId, { prepContext: systemPrompt });

    await sender.send(session.chatId, 'Starting project planning interview. Send /done to cancel at any time.');
    sender.startTyping(session.chatId);

    try {
      const opener = session.topic
        ? `I want to build: ${session.topic}`
        : "Let's plan a new Jarvis project.";
      const result = await askClaudeWithContext(opener, session.claudeSessionId, systemPrompt);
      sender.stopTyping(session.chatId);

      if (result.error) {
        log.error('New project interview start failed', { error: result.error });
        await sender.send(session.chatId, `Failed to start interview: ${result.error}`);
        updateReviewSession(session.chatId, { phase: 'done' });
        return;
      }

      updateReviewSession(session.chatId, { phase: 'interview' });
      await sender.send(session.chatId, result.text || 'Ready to plan together.');
    } catch (err) {
      sender.stopTyping(session.chatId);
      throw err;
    }
  },

  async handleMessage(session: ReviewSession, text: string, sender: MessageSender): Promise<void> {
    if (text.toLowerCase().trim() === '/done') {
      updateReviewSession(session.chatId, { phase: 'done' });
      sessionPrompts.delete(session.claudeSessionId);
      await sender.send(session.chatId, 'Project planning cancelled.');
      return;
    }

    switch (session.phase) {
      case 'interview':
        return handleInterview(session, text, sender);
      case 'approval':
        return handleApproval(session, text, sender);
      case 'writeup':
        await sender.send(session.chatId, 'Writing project files... please wait.');
        return;
      default:
        log.warn('Unexpected message in new-project session', { phase: session.phase, chatId: session.chatId });
    }
  },
};

async function handleInterview(session: ReviewSession, text: string, sender: MessageSender): Promise<void> {
  let systemPrompt = sessionPrompts.get(session.claudeSessionId);
  if (!systemPrompt && session.prepContext) {
    log.info('Reconstructing system prompt from persisted prepContext', { sessionId: session.claudeSessionId });
    systemPrompt = session.prepContext;
    sessionPrompts.set(session.claudeSessionId, systemPrompt);
  }
  if (!systemPrompt) {
    log.error('Missing system prompt for new-project session', { sessionId: session.claudeSessionId });
    await sender.send(session.chatId, 'Session context lost. Start a new /new-project session.');
    updateReviewSession(session.chatId, { phase: 'done' });
    return;
  }

  sender.startTyping(session.chatId);
  try {
    const result = await askClaudeWithContext(text, session.claudeSessionId, systemPrompt);
    sender.stopTyping(session.chatId);

    if (result.error) {
      log.error('Interview message failed', { error: result.error });
      await sender.send(session.chatId, `Error: ${result.error}`);
      return;
    }

    const responseText = result.text || '';
    const briefIdx = responseText.toLowerCase().indexOf(OUTLINE_MARKER_LOWER);

    if (briefIdx !== -1) {
      const brief = responseText.slice(briefIdx).trim();
      updateReviewSession(session.chatId, { outline: brief, phase: 'approval' });
      await sender.send(session.chatId, responseText);
      await sender.send(session.chatId, '\nReply *yes* to generate spec/tasks/test-plan, *cancel* to stop, or send corrections to the brief.', {
        approval: { prompt: 'Approve and write project files?', options: APPROVAL_OPTIONS },
      });
    } else {
      await sender.send(session.chatId, responseText);
    }
  } catch (err) {
    sender.stopTyping(session.chatId);
    throw err;
  }
}

async function handleApproval(session: ReviewSession, text: string, sender: MessageSender): Promise<void> {
  const lower = text.toLowerCase().trim();

  if (['yes', 'y', 'approve', 'confirm', 'ok'].includes(lower)) {
    // Update phase before first await so concurrent messages see 'writeup' in handleMessage
    updateReviewSession(session.chatId, { phase: 'writeup' });
    await runSetupWriter(session, sender);
  } else if (['no', 'n', 'cancel', 'skip'].includes(lower)) {
    updateReviewSession(session.chatId, { phase: 'done' });
    sessionPrompts.delete(session.claudeSessionId);
    await sender.send(session.chatId, 'Project planning cancelled.');
  } else {
    // User sent a correction — feed it back to Claude to produce a revised brief
    await applyBriefCorrection(session, text, sender);
  }
}

async function applyBriefCorrection(session: ReviewSession, correction: string, sender: MessageSender): Promise<void> {
  const systemPrompt = sessionPrompts.get(session.claudeSessionId) ?? session.prepContext ?? '';

  sender.startTyping(session.chatId);
  try {
    const result = await askClaudeWithContext(
      `Please revise the Project Brief with this correction: ${correction}`,
      session.claudeSessionId,
      systemPrompt,
    );
    sender.stopTyping(session.chatId);

    if (result.error) {
      log.error('Brief correction failed', { error: result.error });
      await sender.send(session.chatId, `Error applying correction: ${result.error}\n\nReply *yes* to approve the existing brief or *cancel* to stop.`, {
        approval: { prompt: 'Approve and write project files?', options: APPROVAL_OPTIONS },
      });
      return;
    }

    const responseText = result.text || '';
    const briefIdx = responseText.toLowerCase().indexOf(OUTLINE_MARKER_LOWER);
    if (briefIdx !== -1) {
      updateReviewSession(session.chatId, { outline: responseText.slice(briefIdx).trim() });
    }

    await sender.send(session.chatId, responseText);
    await sender.send(session.chatId, '\nReply *yes* to generate files, *cancel* to stop, or send more corrections.', {
      approval: { prompt: 'Approve and write project files?', options: APPROVAL_OPTIONS },
    });
  } catch (err) {
    sender.stopTyping(session.chatId);
    throw err;
  }
}

async function runSetupWriter(session: ReviewSession, sender: MessageSender): Promise<void> {
  await sender.send(session.chatId, 'Writing spec, tasks, and test plan...');
  sender.startTyping(session.chatId);

  try {
    const agentPrompt = `Create the project files for the following approved Project Brief.

Project root: ${PROJECT_ROOT}
Templates are at: ${PROJECT_ROOT}/docs/projects/templates/
Project index: ${PROJECT_ROOT}/docs/projects/index.md

Approved Project Brief:
${session.outline}`;

    const result = await runAgent('project-setup-writer', agentPrompt);
    sender.stopTyping(session.chatId);

    if (result.error) {
      log.error('project-setup-writer failed', { error: result.error });
      await sender.send(session.chatId, `Failed to write project files: ${result.error}`);
      updateReviewSession(session.chatId, { phase: 'done' });
      sessionPrompts.delete(session.claudeSessionId);
      return;
    }

    try {
      const slugMatch = session.outline?.match(/\*\*Slug:\*\*\s*([a-z0-9-]+)/i);
      if (!slugMatch) {
        log.warn('Could not parse slug from project brief, using fallback', { outline: session.outline?.slice(0, 100) });
      }
      const slug = slugMatch?.[1] ?? 'new-project';
      await gitCommitAndPush(`New project setup: ${slug}`);
    } catch (err) {
      log.error('Git commit failed after project setup', { error: (err as Error).message });
    }

    updateReviewSession(session.chatId, { phase: 'done' });
    sessionPrompts.delete(session.claudeSessionId);
    await sender.send(session.chatId, `Project files created.\n\n${result.text || ''}`);
  } catch (err) {
    sender.stopTyping(session.chatId);
    sessionPrompts.delete(session.claudeSessionId);
    throw err;
  }
}

registerReviewHandler('new-project', newProjectHandler);
