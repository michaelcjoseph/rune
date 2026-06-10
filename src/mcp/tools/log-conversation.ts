/**
 * `log_conversation` MCP tool handler — project 16-claude-app-connector,
 * Phase 1 (spec R1, tech-spec "R1 — log_conversation contract").
 *
 * Writes a finished App conversation into today's journal — `mode:'full'`
 * appends the App-reconstructed transcript verbatim (maps to /fresh-full),
 * `mode:'summary'` appends a single bullet (maps to /fresh) and, when
 * `kb_worthy`, also writes the content to knowledge/raw/conversations/ and
 * enqueues it for KB ingestion. Pure vault-writer: summary text and the
 * kb-worthy judgment are the App Claude's job (ported prompt) — this tool
 * performs NO summarization and reads NO session state.
 *
 * PURE MODULE: every effect is injected via {@link LogConversationDeps}; the
 * production binding lives in ./log-conversation-deps.ts (config-required),
 * loaded lazily by src/mcp/server.ts.
 */

import { errText, ok, err, type McpTextResult } from './types.js';

export interface LogConversationInput {
  /** 'full' = reconstructed transcript; 'summary' = one-line bullet. */
  mode: 'full' | 'summary';
  content: string;
  /** Summary mode only: also write to the KB raw-source queue (default false). */
  kb_worthy?: boolean;
}

export interface LogConversationDeps {
  /** Journal appender (src/vault/journal.ts appendToJournal in production —
   *  initializes a missing journal file itself); returns the journal path;
   *  throws when the vault is unwritable. May be async (production wraps it
   *  in a per-file lock). */
  appendToJournal: (text: string) => string | Promise<string>;
  /** Conversation raw-source writer (saveConversationSource in production);
   *  returns the vault-relative knowledge/raw/conversations/ path. */
  saveConversationSource: (summary: string) => string;
  /** KB ingestion-queue enqueue (src/kb/queue.ts); throws on failure. */
  enqueue: (source: string, guidance?: string) => void;
  /** Commit + push the write; MUST throw/reject on git failure. */
  commitAndPush: (message: string) => Promise<void>;
  /** Optional error-text sanitizer applied before failure messages surface
   *  to the (eventually remote) caller. */
  sanitizeError?: (message: string) => string;
}

/** Trust-boundary size cap on the LLM-supplied content. Deliberately large —
 *  mode:'full' carries whole reconstructed transcripts — but bounded so a
 *  pathological payload can't balloon the vault commit or the KB queue. */
export const CONTENT_MAX_CHARS = 200_000;

/**
 * Log a conversation to the vault. Never throws — every failure path
 * resolves to an `isError` result, and a partial write (journal landed, KB
 * half failed) is reported distinctly so it never reads as a full success.
 */
export async function logConversation(
  input: LogConversationInput,
  deps: LogConversationDeps,
): Promise<McpTextResult> {
  const clean = deps.sanitizeError ?? ((s: string) => s);

  // ---- validation (before any vault write) ----
  if (input.mode !== 'full' && input.mode !== 'summary') {
    return err(`Invalid mode ${JSON.stringify(input.mode)} — must be 'full' or 'summary'. Nothing was written.`);
  }
  const content = typeof input.content === 'string' ? input.content : '';
  if (content.trim() === '') {
    return err('Missing or empty content — nothing was written.');
  }
  if (content.length > CONTENT_MAX_CHARS) {
    return err(`Content exceeds ${CONTENT_MAX_CHARS} characters — nothing was written.`);
  }

  // ---- journal write ----
  // Summary mode is a single bullet: collapse embedded newlines so the
  // journal line stays structurally valid. Full mode is verbatim by design.
  const journalText =
    input.mode === 'summary' ? `- ${content.replace(/[\r\n]+/g, ' ').trim()}` : content;
  let journalPath: string;
  try {
    journalPath = await deps.appendToJournal(journalText);
  } catch (writeErr) {
    return err(`Journal write failed — nothing was captured in the vault: ${clean(errText(writeErr))}`);
  }

  // ---- KB raw-source write + enqueue (summary mode, kb_worthy only) ----
  let kbSourcePath: string | undefined;
  if (input.mode === 'summary' && input.kb_worthy === true) {
    try {
      kbSourcePath = deps.saveConversationSource(content);
      deps.enqueue(kbSourcePath);
    } catch (kbErr) {
      // Partial write: the journal entry landed but the KB half failed.
      // Best-effort commit so the journal half is at least durable, then
      // surface the partial state distinctly — never as a full success.
      let commitNote = '';
      try {
        await deps.commitAndPush('log_conversation: journal entry (KB enqueue failed)');
      } catch (commitErr) {
        commitNote = ` The journal commit also failed: ${clean(errText(commitErr))}.`;
      }
      return err(
        `PARTIAL: the journal entry landed at ${clean(journalPath)}, but the KB queue/enqueue half FAILED — the conversation is NOT in the KB raw-source queue: ${clean(errText(kbErr))}.${commitNote}`,
      );
    }
  }

  // ---- commit (failure must surface — never a phantom success) ----
  try {
    await deps.commitAndPush(`log_conversation: ${input.mode}${kbSourcePath ? ' + KB enqueue' : ''}`);
  } catch (commitErr) {
    return err(
      `Journal entry was appended at ${clean(journalPath)}${kbSourcePath ? ` (and KB source saved at ${kbSourcePath})` : ''} but the git commit/push FAILED — the capture is NOT durable yet: ${clean(errText(commitErr))}`,
    );
  }

  // journalPath is sanitized on the SUCCESS path too — appendToJournal
  // returns an absolute vault path, and this text reaches the App caller.
  if (kbSourcePath !== undefined) {
    return ok(
      `Conversation logged to the journal at ${clean(journalPath)} and queued for KB ingestion (queue id: ${kbSourcePath}).`,
    );
  }
  return ok(`Conversation logged to the journal at ${clean(journalPath)}.`);
}
