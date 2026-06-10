/**
 * Production dependency binding for the `log_conversation` MCP tool handler.
 *
 * Separate from ./log-conversation.ts (the pure handler) because this module
 * pulls src/config.ts (env-var-required at import) through its vault/kb
 * imports; src/mcp/server.ts loads it only via dynamic import inside the
 * tool handler.
 *
 * NOTE on vault git concurrency: commitAndPush shares the vault working tree
 * with every other vault committer (nightly, /fresh, morning prep, log_idea).
 * `git add -A` commits whatever is dirty at that moment — the long-standing
 * vault-wide serialization gap, not introduced here. The journal append
 * itself is serialized below.
 */

import { appendToJournal, saveConversationSource } from '../../vault/journal.js';
import { enqueue } from '../../kb/queue.js';
import { withFileLock } from '../../intent/backlog-write-lock.js';
import { gitCommitAndPushOrThrow } from '../../vault/git.js';
import { sanitizeMcpError } from './sanitize.js';
import { createLogger } from '../../utils/logger.js';
import type { LogConversationDeps } from './log-conversation.js';

const log = createLogger('log-conversation-deps');

/** Single lock key serializing all journal appends from this tool — the MCP
 *  endpoint is concurrently callable and appendToJournal is a logical
 *  read-modify-write on today's journal file. */
const JOURNAL_LOCK_KEY = 'vault-journal-append';

/** Build the live deps bag: the existing journal/conversation-source/queue
 *  primitives over the live vault working tree, plus the strict (throwing)
 *  vault commit helper. */
export function buildProductionLogConversationDeps(): LogConversationDeps {
  return {
    appendToJournal: (text) => withFileLock(JOURNAL_LOCK_KEY, () => appendToJournal(text)),
    saveConversationSource,
    enqueue,
    commitAndPush: async (message) => {
      const outcome = await gitCommitAndPushOrThrow(message);
      if (outcome === 'nothing-to-commit') {
        // Not an error (identical content can no-op), but after a journal
        // append something SHOULD have been staged — keep it detectable.
        log.warn('commitAndPush: nothing to commit after a vault write', { message });
      }
    },
    sanitizeError: sanitizeMcpError,
  };
}
