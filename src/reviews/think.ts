import TelegramBot from 'node-telegram-bot-api';
import { updateReviewSession } from './session.js';
import type { ReviewSession } from './session.js';
import type { ReviewTypeHandler } from './orchestrator.js';
import { registerReviewHandler } from './orchestrator.js';
import { askClaudeWithContext } from '../ai/claude.js';
import { readVaultFile } from '../vault/files.js';
import { sendLongMessage, startTyping, stopTyping } from '../integrations/telegram/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('think');

const SKILL_PATH = '.claude/skills/think/SKILL.md';
const DEFAULT_INSTRUCTIONS = `Help me think through this. Don't solve it—help me clarify my own thinking.

Rules:
- Ask more than tell
- Surface assumptions I might be making
- No artifacts or documents, just dialogue`;

const sessionPrompts = new Map<string, string>();
let pendingTopic: string | null = null;

export function setThinkTopic(topic: string): void {
  pendingTopic = topic;
}

function buildSystemPrompt(topic: string): string {
  const skill = readVaultFile(SKILL_PATH);
  const instructions = skill?.trim() || DEFAULT_INSTRUCTIONS;
  return `You are a thinking partner helping me explore: ${topic}

${instructions}`;
}

const thinkHandler: ReviewTypeHandler = {
  async start(session: ReviewSession, bot: TelegramBot): Promise<void> {
    const topic = pendingTopic || 'general thinking';
    pendingTopic = null;

    const systemPrompt = buildSystemPrompt(topic);
    sessionPrompts.set(session.claudeSessionId, systemPrompt);
    updateReviewSession(session.chatId, { prepContext: systemPrompt });

    await bot.sendMessage(session.chatId, `Thinking session started: "${topic}"\nSend /done when finished.`);
    const typing = startTyping(bot, session.chatId);

    try {
      const result = await askClaudeWithContext(
        `I want to think through: ${topic}`,
        session.claudeSessionId,
        systemPrompt,
      );
      stopTyping(typing);

      if (result.error) {
        log.error('Think start failed', { error: result.error });
        await bot.sendMessage(session.chatId, `Failed to start thinking session: ${result.error}`);
        updateReviewSession(session.chatId, { phase: 'done' });
        return;
      }

      updateReviewSession(session.chatId, { phase: 'interview' });
      await sendLongMessage(bot, session.chatId, result.text || 'Ready to think together.');
    } catch (err) {
      stopTyping(typing);
      throw err;
    }
  },

  async handleMessage(session: ReviewSession, text: string, bot: TelegramBot): Promise<void> {
    if (text.toLowerCase().trim() === '/done') {
      updateReviewSession(session.chatId, { phase: 'done' });
      sessionPrompts.delete(session.claudeSessionId);
      await bot.sendMessage(session.chatId, 'Thinking session ended.');
      return;
    }

    let systemPrompt = sessionPrompts.get(session.claudeSessionId);
    if (!systemPrompt && session.prepContext) {
      log.info('Reconstructing system prompt from persisted prepContext', { sessionId: session.claudeSessionId });
      systemPrompt = session.prepContext;
      sessionPrompts.set(session.claudeSessionId, systemPrompt);
    }
    if (!systemPrompt) {
      log.error('Missing system prompt for think session', { sessionId: session.claudeSessionId });
      await bot.sendMessage(session.chatId, 'Session context lost. Start a new /think session.');
      updateReviewSession(session.chatId, { phase: 'done' });
      return;
    }

    const typing = startTyping(bot, session.chatId);
    try {
      const result = await askClaudeWithContext(text, session.claudeSessionId, systemPrompt);
      stopTyping(typing);

      if (result.error) {
        log.error('Think message failed', { error: result.error });
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

registerReviewHandler('think', thinkHandler);
