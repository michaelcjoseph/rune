import { getAllSessions, deleteSession } from '../vault/sessions.js';
import { summarizeSession } from '../ai/claude.js';
import { appendToJournal } from '../vault/journal.js';
import { getTimestamp } from '../utils/time.js';
import { gitCommitAndPush } from '../vault/git.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('capture');

/**
 * Capture all active TG sessions: summarize each, append to journal, delete.
 * Used by both the /capture-sessions HTTP endpoint and the nightly job.
 */
export async function captureSessions(source = 'nightly'): Promise<{ captured: number }> {
  const sessions = getAllSessions();
  let captured = 0;
  const capturedChatIds: number[] = [];

  for (const [chatId, session] of sessions) {
    try {
      const result = await summarizeSession(session.sessionId);
      if (result.text) {
        const ts = getTimestamp();
        const summaryLines = result.text.split('\n').map((l) => `\t- ${l}`).join('\n');
        const entry = `- ${ts} [[jarvis]] telegram chat\n${summaryLines}`;
        appendToJournal(entry);
        captured++;
        capturedChatIds.push(chatId);
      }
    } catch (err) {
      log.error(`Failed to capture session ${chatId}`, { error: (err as Error).message });
    }
  }

  // Only delete sessions that were successfully captured
  for (const chatId of capturedChatIds) {
    deleteSession(chatId);
  }

  if (captured > 0) {
    await gitCommitAndPush(`TG sessions captured (${source})`);
  }

  return { captured };
}
