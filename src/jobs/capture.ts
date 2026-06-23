import { getAllSessions, deleteSession, transportLabel, type Transport, type SessionScope } from '../vault/sessions.js';
import { summarizeSession } from '../ai/claude.js';
import { appendToJournal } from '../vault/journal.js';
import { getTimestamp } from '../utils/time.js';
import { gitCommitAndPush } from '../vault/git.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('capture');

/**
 * Capture all active conversation sessions across both transports: summarize
 * each, append to journal, delete. Used by both the /capture-sessions HTTP
 * endpoint and the nightly job.
 */
export async function captureSessions(source = 'nightly'): Promise<{ captured: number }> {
  const entries = getAllSessions();
  let captured = 0;
  const capturedKeys: { userId: number; transport: Transport; scope?: SessionScope }[] = [];

  for (const { userId, transport, scope, session } of entries) {
    try {
      const result = await summarizeSession(session.sessionId);
      if (result.text) {
        const ts = getTimestamp();
        const summaryLines = result.text.split('\n').map((l) => `\t- ${l}`).join('\n');
        const entry = `- ${ts} [[jarvis]] ${transportLabel(transport)}\n${summaryLines}`;
        appendToJournal(entry);
        captured++;
        capturedKeys.push({ userId, transport, scope });
      }
    } catch (err) {
      log.error(`Failed to capture session ${transport}:${userId}`, { error: (err as Error).message });
    }
  }

  // Only delete sessions that were successfully captured
  for (const { userId, transport, scope } of capturedKeys) {
    if (scope) {
      deleteSession(userId, transport, scope);
    } else {
      deleteSession(userId, transport);
    }
  }

  if (captured > 0) {
    await gitCommitAndPush(`Conversations captured (${source})`);
  }

  return { captured };
}
