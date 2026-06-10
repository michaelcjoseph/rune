/**
 * Test suite for `src/mcp/tools/log-conversation.ts` — project 16-claude-app-connector,
 * Phase 1, test-plan.md §4 "log_conversation tool".
 *
 * Written TEST-FIRST: the implementation module does not exist yet.
 * Every test in this file is expected to be RED until the implementation lands.
 *
 * Contract:
 *   logConversation(input: LogConversationInput, deps: LogConversationDeps): Promise<McpTextResult>
 *
 * Mechanics:
 *   - Dynamic import via computed specifier defeats tsc's static resolution so
 *     the file is tsc-clean before the module exists.
 *   - Every test calls requireLogConversationFn() which fails with a clean
 *     "implementation pending" message when the module is absent — never an
 *     import crash.
 *   - deps use plain vi.fn() fakes — no real fs, no temp dirs.
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Local structural types — mirror the future module's public surface so the
// test file is tsc-clean today while the implementation module does not exist.
// These are CASTING ONLY; they must stay in sync with the final module types.
// ---------------------------------------------------------------------------

interface LogConversationInput {
  mode: 'full' | 'summary';
  content: string;
  kb_worthy?: boolean; // default false
}

interface LogConversationDeps {
  /** Returns absolute journal path; throws when vault unwritable. */
  appendToJournal: (text: string) => string;
  /** Returns vault-relative knowledge/raw/conversations/... path. */
  saveConversationSource: (summary: string) => string;
  /** KB ingestion queue; throws on failure. */
  enqueue: (source: string, guidance?: string) => void;
  /** Throws/rejects on git failure. */
  commitAndPush: (message: string) => Promise<void>;
}

interface McpTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type LogConversationFn = (
  input: LogConversationInput,
  deps: LogConversationDeps,
) => Promise<McpTextResult>;

// ---------------------------------------------------------------------------
// Dynamic import — computed specifier bypasses tsc static resolution.
// ---------------------------------------------------------------------------

const IMPL_PENDING =
  'src/mcp/tools/log-conversation.ts not implemented yet — implementation pending';

async function loadLogConversationModule(): Promise<Record<string, unknown> | null> {
  const specifier = './log-conversation' + '.js';
  try {
    return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Load the module and return the typed logConversation function, or fail THIS test
 *  with a clean "implementation pending" message. Called per-test so each
 *  red is an isolated, descriptive assertion failure — never an import crash. */
async function requireLogConversationFn(): Promise<LogConversationFn> {
  const mod = await loadLogConversationModule();
  if (!mod || typeof mod.logConversation !== 'function') {
    expect.fail(IMPL_PENDING);
  }
  return mod.logConversation as LogConversationFn;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const FAKE_JOURNAL_PATH = '/fake/vault/journals/2026_06_10.md';
const FAKE_KB_SOURCE_PATH = 'knowledge/raw/conversations/conversation-fixture.md';

/** Builds a minimal valid deps bag. All fns are vi.fn() mocks — tests assert
 *  on deps.* directly. */
function makeDeps(overrides?: Partial<LogConversationDeps>): LogConversationDeps {
  return {
    appendToJournal: vi.fn().mockReturnValue(FAKE_JOURNAL_PATH),
    saveConversationSource: vi.fn().mockReturnValue(FAKE_KB_SOURCE_PATH),
    enqueue: vi.fn(),
    commitAndPush: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §4 Tests
// ---------------------------------------------------------------------------

describe('logConversation — §4 log_conversation tool (log-conversation.ts)', () => {
  // -------------------------------------------------------------------------
  // Test 1 🔴 — mode:full happy path
  // -------------------------------------------------------------------------
  it('1: mode:full → appendToJournal called with verbatim content, commitAndPush called, saveConversationSource + enqueue NOT called', async () => {
    const logConversation = await requireLogConversationFn();
    const deps = makeDeps();
    const content = 'This is the full reconstructed transcript.';

    const result = await logConversation({ mode: 'full', content }, deps);

    // appendToJournal called exactly once with the content verbatim (no transformation)
    expect(deps.appendToJournal).toHaveBeenCalledOnce();
    expect(deps.appendToJournal).toHaveBeenCalledWith(content);

    // commit happened
    expect(deps.commitAndPush).toHaveBeenCalledOnce();

    // KB path NOT taken for mode:full
    expect(deps.saveConversationSource).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();

    // success result
    expect(result.isError).toBeFalsy();

    // result text contains the journal path returned by appendToJournal
    const text = result.content[0]!.text;
    expect(text).toContain(FAKE_JOURNAL_PATH);
  });

  // -------------------------------------------------------------------------
  // Test 2 🔴 — mode:full ignores kb_worthy:true
  // -------------------------------------------------------------------------
  it('2: mode:full with kb_worthy:true → saveConversationSource and enqueue still NOT called (full mode has no KB path)', async () => {
    const logConversation = await requireLogConversationFn();
    const deps = makeDeps();
    const content = 'Full transcript content, even though kb_worthy is true.';

    const result = await logConversation({ mode: 'full', content, kb_worthy: true }, deps);

    // KB path must not be taken regardless of kb_worthy
    expect(deps.saveConversationSource).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();

    // still wrote journal and committed
    expect(deps.appendToJournal).toHaveBeenCalledOnce();
    expect(deps.commitAndPush).toHaveBeenCalledOnce();

    expect(result.isError).toBeFalsy();
  });

  // -------------------------------------------------------------------------
  // Test 3 🔴 — mode:summary without kb_worthy
  // -------------------------------------------------------------------------
  it('3: mode:summary (kb_worthy omitted → default false) → appendToJournal called with "- " + content, no save/enqueue, commit called', async () => {
    const logConversation = await requireLogConversationFn();
    const deps = makeDeps();
    const content = 'Had a great conversation about the new product.';

    const result = await logConversation({ mode: 'summary', content }, deps);

    // appendToJournal called with single bullet
    expect(deps.appendToJournal).toHaveBeenCalledOnce();
    expect(deps.appendToJournal).toHaveBeenCalledWith('- ' + content);

    // KB path NOT taken
    expect(deps.saveConversationSource).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();

    // commit happened
    expect(deps.commitAndPush).toHaveBeenCalledOnce();

    expect(result.isError).toBeFalsy();

    // result text contains the journal path
    const text = result.content[0]!.text;
    expect(text).toContain(FAKE_JOURNAL_PATH);
  });

  // -------------------------------------------------------------------------
  // Test 4 🔴 — mode:summary + kb_worthy:true
  // -------------------------------------------------------------------------
  it('4: mode:summary + kb_worthy:true → appendToJournal("- " + content), saveConversationSource(content), enqueue(kbPath), commitAndPush, result contains journal path AND KB path', async () => {
    const logConversation = await requireLogConversationFn();
    const deps = makeDeps();
    const content = 'Discussed onboarding friction and next steps.';

    const result = await logConversation({ mode: 'summary', content, kb_worthy: true }, deps);

    // appendToJournal called with bullet
    expect(deps.appendToJournal).toHaveBeenCalledOnce();
    expect(deps.appendToJournal).toHaveBeenCalledWith('- ' + content);

    // saveConversationSource called with the content
    expect(deps.saveConversationSource).toHaveBeenCalledOnce();
    expect(deps.saveConversationSource).toHaveBeenCalledWith(content);

    // enqueue called with the path returned by saveConversationSource as its
    // FIRST argument; the optional guidance argument is the implementation's
    // choice, so only the path is pinned.
    expect(deps.enqueue).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.enqueue).mock.calls[0]![0]).toBe(FAKE_KB_SOURCE_PATH);

    // commit happened
    expect(deps.commitAndPush).toHaveBeenCalledOnce();

    expect(result.isError).toBeFalsy();

    // result text contains BOTH the journal path AND the KB source path (the
    // queue id per tech-spec output {journalPath, kbQueueId?}), plus an
    // explicit enqueue confirmation so the queue id isn't there incidentally.
    const text = result.content[0]!.text;
    expect(text).toContain(FAKE_JOURNAL_PATH);
    expect(text).toContain(FAKE_KB_SOURCE_PATH);
    expect(text).toMatch(/queue|kb/i);
  });

  // -------------------------------------------------------------------------
  // Test 5 🔴 — Unwritable vault
  // -------------------------------------------------------------------------
  it('5: unwritable vault → appendToJournal throws → resolves (not rejects) with isError true, text matches /journal|vault|write/i, commitAndPush NOT called', async () => {
    const logConversation = await requireLogConversationFn();
    const deps = makeDeps({
      appendToJournal: vi.fn(() => {
        throw new Error('EACCES: permission denied');
      }),
    });

    // Tool must RESOLVE (not throw/reject) with an error result
    const result = await logConversation(
      { mode: 'full', content: 'some transcript' },
      deps,
    );

    expect(result.isError).toBe(true);

    // nothing to commit — commit must NOT be called
    expect(deps.commitAndPush).not.toHaveBeenCalled();

    // KB path never reached
    expect(deps.saveConversationSource).not.toHaveBeenCalled();

    const text = result.content[0]!.text;
    expect(text).toMatch(/journal|vault|write/i);
    // The error must not masquerade as (partial) success.
    expect(text).not.toMatch(/success|written|logged/i);
  });

  // NOTE on test-plan §4 "today's journal file not existing yet is handled":
  // that 🔴 item is the production appendToJournal primitive's behavior — it
  // initializes a missing journal file itself and is pinned green in
  // src/vault/journal.test.ts ("creates journal file if it does not exist").
  // This suite injects appendToJournal, so the item is covered by delegation,
  // not re-tested here.

  // -------------------------------------------------------------------------
  // Test 6 🔴 — Git commit failure after successful journal write
  // -------------------------------------------------------------------------
  it('6: commitAndPush rejects → resolves with isError true, text matches /git|commit|push/i, appendToJournal WAS called', async () => {
    const logConversation = await requireLogConversationFn();
    const deps = makeDeps({
      commitAndPush: vi.fn().mockRejectedValue(new Error('remote: repository not found')),
    });

    const result = await logConversation(
      { mode: 'summary', content: 'Short summary.' },
      deps,
    );

    expect(result.isError).toBe(true);

    // appendToJournal WAS called — the write happened; error must not hide this
    expect(deps.appendToJournal).toHaveBeenCalledOnce();

    const text = result.content[0]!.text;
    expect(text).toMatch(/git|commit|push/i);
  });

  // -------------------------------------------------------------------------
  // Test 7 🟡 — KB enqueue failure after successful journal write
  // -------------------------------------------------------------------------
  it('7: enqueue throws after journal write succeeds (mode:summary, kb_worthy:true) → resolves with isError true, text mentions journal write (/journal/i) AND queue failure (/queue|enqueue|kb/i)', async () => {
    const logConversation = await requireLogConversationFn();
    const deps = makeDeps({
      enqueue: vi.fn(() => {
        throw new Error('queue write failed: ENOSPC');
      }),
    });

    const result = await logConversation(
      { mode: 'summary', content: 'KB-worthy summary.', kb_worthy: true },
      deps,
    );

    expect(result.isError).toBe(true);

    // journal write DID happen — partial write must not read as full success
    expect(deps.appendToJournal).toHaveBeenCalledOnce();

    const text = result.content[0]!.text;
    // must mention that journal write landed
    expect(text).toMatch(/journal/i);
    // must surface the queue failure distinctly
    expect(text).toMatch(/queue|enqueue|kb/i);
  });

  // -------------------------------------------------------------------------
  // Test 8a 🟡 — Malformed mode
  // -------------------------------------------------------------------------
  it('8a: malformed mode ("verbose" as never) → resolves with isError true, text matches /mode/i, NO deps called at all', async () => {
    const logConversation = await requireLogConversationFn();
    const deps = makeDeps();

    const result = await logConversation(
      { mode: 'verbose' as never, content: 'some content' },
      deps,
    );

    expect(result.isError).toBe(true);

    // no partial write
    expect(deps.appendToJournal).not.toHaveBeenCalled();
    expect(deps.saveConversationSource).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();

    const text = result.content[0]!.text;
    expect(text).toMatch(/mode/i);
  });

  // -------------------------------------------------------------------------
  // Test 8b 🟡 — Missing/empty content
  // -------------------------------------------------------------------------
  it('8b: missing/empty content → resolves (not rejects) with isError true, NO deps called', async () => {
    const logConversation = await requireLogConversationFn();
    const deps = makeDeps();

    await expect(
      logConversation({ mode: 'summary', content: '' }, deps),
    ).resolves.toMatchObject({ isError: true });

    expect(deps.appendToJournal).not.toHaveBeenCalled();
    expect(deps.saveConversationSource).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.commitAndPush).not.toHaveBeenCalled();
  });
});
