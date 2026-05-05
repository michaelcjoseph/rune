import { updateReviewSession, onReviewSessionDeleted } from './session.js';
import type { ReviewSession } from './session.js';
import type { ReviewTypeHandler } from './orchestrator.js';
import type { MessageSender } from '../transport/sender.js';
import { registerReviewHandler } from './orchestrator.js';
import { askClaudeWithContext } from '../ai/claude.js';
import { readVaultFile } from '../vault/files.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('health');

const SKILL_PATH = '.claude/skills/health/SKILL.md';
const DEFAULT_INSTRUCTIONS = `You are a health coach. Help me understand my health data, make better decisions about sleep, recovery, exercise, and nutrition.

Rules:
- Ask clarifying questions before giving advice
- Reference my actual data when available
- Be direct about trade-offs
- No artifacts or documents, just dialogue`;

const sessionPrompts = new Map<string, string>();

onReviewSessionDeleted((id) => sessionPrompts.delete(id));

function gatherHealthContext(): string {
  const sections: string[] = [];

  const trends = readVaultFile('health/whoop/trends.md');
  if (trends?.trim()) {
    sections.push(`## Recent Health Trends\n${trends.trim()}`);
  }

  const plan = readVaultFile('health/plan.md');
  if (plan?.trim()) {
    sections.push(`## Workout Plan\n${plan.trim()}`);
  }

  return sections.join('\n\n');
}

function buildSystemPrompt(focus: string): string {
  const skill = readVaultFile(SKILL_PATH);
  const instructions = skill?.trim() || DEFAULT_INSTRUCTIONS;
  const healthContext = gatherHealthContext();

  const parts = [`You are a health coach. Focus: ${focus}`, instructions];
  if (healthContext) {
    parts.push(healthContext);
  }
  return parts.join('\n\n');
}

const healthHandler: ReviewTypeHandler = {
  async start(session: ReviewSession, sender: MessageSender): Promise<void> {
    const focus = session.topic || 'general health coaching';

    const systemPrompt = buildSystemPrompt(focus);
    sessionPrompts.set(session.claudeSessionId, systemPrompt);
    updateReviewSession(session.chatId, { prepContext: systemPrompt });

    await sender.send(session.chatId, `Health session started: "${focus}"\nSend /done when finished.`);
    sender.startTyping(session.chatId);

    try {
      const result = await askClaudeWithContext(
        `I want to discuss: ${focus}`,
        session.claudeSessionId,
        systemPrompt,
      );
      sender.stopTyping(session.chatId);

      if (result.error) {
        log.error('Health start failed', { error: result.error });
        await sender.send(session.chatId, `Failed to start health session: ${result.error}`);
        updateReviewSession(session.chatId, { phase: 'done' });
        return;
      }

      updateReviewSession(session.chatId, { phase: 'interview' });
      await sender.send(session.chatId, result.text || 'Ready to discuss your health.');
    } catch (err) {
      sender.stopTyping(session.chatId);
      throw err;
    }
  },

  async handleMessage(session: ReviewSession, text: string, sender: MessageSender): Promise<void> {
    if (text.toLowerCase().trim() === '/done') {
      updateReviewSession(session.chatId, { phase: 'done' });
      sessionPrompts.delete(session.claudeSessionId);
      await sender.send(session.chatId, 'Health session ended.');
      return;
    }

    let systemPrompt = sessionPrompts.get(session.claudeSessionId);
    if (!systemPrompt && session.prepContext) {
      log.info('Reconstructing system prompt from persisted prepContext', { sessionId: session.claudeSessionId });
      systemPrompt = session.prepContext;
      sessionPrompts.set(session.claudeSessionId, systemPrompt);
    }
    if (!systemPrompt) {
      log.error('Missing system prompt for health session', { sessionId: session.claudeSessionId });
      await sender.send(session.chatId, 'Session context lost. Start a new /health session.');
      updateReviewSession(session.chatId, { phase: 'done' });
      return;
    }

    sender.startTyping(session.chatId);
    try {
      const result = await askClaudeWithContext(text, session.claudeSessionId, systemPrompt);
      sender.stopTyping(session.chatId);

      if (result.error) {
        log.error('Health message failed', { error: result.error });
        await sender.send(session.chatId, `Error: ${result.error}`);
        return;
      }

      await sender.send(session.chatId, result.text || '');
    } catch (err) {
      sender.stopTyping(session.chatId);
      throw err;
    }
  },
};

registerReviewHandler('health', healthHandler);
