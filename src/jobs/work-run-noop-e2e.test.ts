/**
 * Phase 6 end-to-end validation (project 11, test-plan.md §6).
 *
 * The single assertion the whole project exists to guarantee: a deliberately
 * EMPTY work run (exits 0, zero commits, zero task transitions, clean tree —
 * exactly the 2026-05-30 `7828477a` shape) must classify as `noop` AND emit the
 * no-op alert — never read as `✅ finished` success. This wires the two halves
 * together:
 *
 *   1. `workRunApplier.apply()` over an empty run → a terminal event carrying
 *      `data.outcome === 'noop'` (the classifier, Phase 2).
 *   2. that same terminal event, fed through the real `TelegramSender`
 *      emission path → a Telegram message that says "no-op", not "finished"
 *      (the alert, Phase 4).
 *
 * Unlike a validation phase that precedes new code, the behavior asserted here
 * was delivered in Phases 2 + 4, so this e2e is GREEN on arrival — that passing
 * state IS the §6 success condition (the taxonomy fires end-to-end). It is the
 * regression guard that a future change can never silently reintroduce the
 * silent-success bug.
 *
 * The apply()-side harness mirrors `work-runner.test.ts`; the alert-side harness
 * mirrors `telegram-sender.test.ts`. The two config mocks are merged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — merged apply() (work-runner) + alert (telegram-sender) surfaces.
// ---------------------------------------------------------------------------

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  execFile: vi.fn((_file, _args, cb) => cb(null, { stdout: '', stderr: '' })),
  execFileSync: vi.fn(() => '/usr/local/bin/claude'),
}));

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockStatSync = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
  statSync: mockStatSync,
}));

const TEST_PROJECT_ROOT = '/test/jarvis';

// Merged config: work-runner reads PROJECT_ROOT/caps/WORK_RUNS_DIR; telegram-
// sender reads TG_MAX_MESSAGE_LENGTH/TELEGRAM_BOT_TOKEN/TELEGRAM_USER_ID.
vi.mock('../config.js', () => ({
  PROJECT_ROOT: TEST_PROJECT_ROOT,
  default: {
    PROJECT_ROOT: TEST_PROJECT_ROOT,
    WORK_RUN_PER_PROJECT_CAP: 1,
    WORK_RUN_GLOBAL_CAP: 2,
    WORKSPACE_DIR: undefined,
    WORK_RUNS_DIR: '/tmp/test-work-runs',
    WORK_RUNS_INDEX_FILE: '/tmp/test-work-runs/index.jsonl',
    // Phase 3.5 gated-merge wiring reads these in the common apply() path.
    WORKTREE_ROOT: '/tmp/test-worktrees',
    PRODUCTS_CONFIG_FILE: '/tmp/test-products.json',
    WORK_RUN_GATE_COMMAND_TIMEOUT_MS: 600_000,
    TG_MAX_MESSAGE_LENGTH: 4096,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 42,
  },
}));

const mockActiveRuns = new Map<string, any>();
vi.mock('../transport/mutations.js', () => ({ activeRuns: mockActiveRuns }));

vi.mock('../ai/claude.js', () => ({
  CLAUDE_BIN: '/usr/local/bin/claude',
  registerActiveProcess: vi.fn(),
  unregisterActiveProcess: vi.fn(),
  getProjectMcpArgs: () => ['--strict-mcp-config', '--mcp-config', '/tmp/test-project/.claude/settings.json'],
}));

vi.mock('./work-run-gc-runner.js', () => ({ runWorkRunGc: vi.fn().mockResolvedValue(undefined) }));

const mockCreateWorktree = vi.fn();
const mockDestroyWorktree = vi.fn();
vi.mock('./sandbox-runtime.js', () => ({
  createWorktree: mockCreateWorktree,
  destroyWorktree: mockDestroyWorktree,
  defaultRunGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
  // Phase 3.5: the gated-merge wiring reads the product config (baseBranch /
  // repoPath / validationCommands) in the common apply() path. A noop run never
  // reaches the gate/merge, so this just needs to resolve.
  getProductConfig: vi.fn(() => ({
    product: 'jarvis',
    repoPath: '/test/repo/jarvis',
    baseBranch: 'main',
    egressAllowlist: [],
    validationCommands: ['npm run build', 'npm test'],
  })),
}));

// Telegram client — inspect the emitted message text without real I/O.
const mockSendLongMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../integrations/telegram/client.js', () => ({
  sendLongMessage: mockSendLongMessage,
  startTyping: vi.fn().mockReturnValue(42 as unknown as ReturnType<typeof setInterval>),
  stopTyping: vi.fn(),
}));

const FAKE_WORKTREE = '/test/worktrees/jarvis/06-webview';
function fakeSandboxSpec(overrides: Record<string, unknown> = {}) {
  return {
    product: 'jarvis',
    project: '06-webview',
    worktree: FAKE_WORKTREE,
    egressAllowlist: [],
    baseSha: 'basesha0000000000000000000000000000000000',
    ...overrides,
  };
}

const { workRunApplier, __setWorkRunRuntimeForTest, __resetWorkRunRuntimeForTest } =
  await import('./work-runner.js');
const { TelegramSender } = await import('../transport/telegram-sender.js');

// ---------------------------------------------------------------------------
// Harness (apply side, copied from work-runner.test.ts) ----------------------
// ---------------------------------------------------------------------------

// Empty-run git stub: every command returns empty → zero commits, clean tree,
// no task transitions → classifyOutcome === 'noop'.
const emptyGitStub = () => vi.fn(async () => ({ stdout: '', stderr: '' }));

function makeFakeSink() {
  return {
    path: '/tmp/work-runs/run/transcript.jsonl',
    append: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    destroy: vi.fn(() => {}),
  };
}

const PROJECTS_DIR = `${TEST_PROJECT_ROOT}/docs/projects`;

function makeFakeChild(opts: { exitCode?: number; stdoutLines?: string[] } = {}) {
  const { exitCode = 0, stdoutLines = [] } = opts;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as any;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  child.pid = 12345;
  setTimeout(() => {
    for (const line of stdoutLines) stdout.emit('data', Buffer.from(line + '\n'));
    child.emit('close', exitCode, null);
  }, 0);
  return child;
}

function setupValidProject(slug = '06-webview') {
  const liveDir = join(PROJECTS_DIR, slug);
  const worktreeDir = join(FAKE_WORKTREE, 'docs', 'projects', slug);
  mockReaddirSync.mockImplementation((p: string) =>
    (p === PROJECTS_DIR || p === join(FAKE_WORKTREE, 'docs', 'projects')) ? [slug] : []);
  mockStatSync.mockImplementation((p: string) =>
    (p === liveDir || p === worktreeDir)
      ? { isDirectory: () => true }
      : { isDirectory: () => false, mtimeMs: Date.now() });
  mockExistsSync.mockImplementation((p: string) =>
    p === join(liveDir, 'spec.md') || p === join(liveDir, 'tasks.md') ||
    p === join(worktreeDir, 'spec.md') || p === join(worktreeDir, 'tasks.md'));
  mockReadFileSync.mockImplementation((p: string) => {
    if (p === join(liveDir, 'spec.md') || p === join(worktreeDir, 'spec.md')) return '# Spec\n\nDo something.';
    if (p === join(liveDir, 'tasks.md') || p === join(worktreeDir, 'tasks.md')) return '## Phase A\n\n- [ ] Task 1\n';
    return '';
  });
}

function mockBot() {
  return { sendMessage: vi.fn().mockResolvedValue({}), sendChatAction: vi.fn().mockResolvedValue(true) } as any;
}

/** Wait one macrotask so the sender's fire-and-forget `void this.send()` resolves. */
const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Test ----------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe('Phase 6 §6 — empty run classifies noop and emits the no-op alert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReset();
    mockActiveRuns.clear();
    mockCreateWorktree.mockImplementation(async () => fakeSandboxSpec());
    mockDestroyWorktree.mockImplementation(async () => {});
    mockSendLongMessage.mockResolvedValue(undefined);
    __setWorkRunRuntimeForTest({
      runGit: emptyGitStub() as never,
      workRunsDir: '/tmp/test-work-runs',
      workRunsIndexFile: '/tmp/test-work-runs/index.jsonl',
      createSink: () => makeFakeSink() as never,
      writeSummary: vi.fn() as never,
      appendIndexRow: vi.fn() as never,
      runForensics: (vi.fn(async () => ({ forensicsPath: '/tmp/x', files: [] }))) as never,
    });
  });

  afterEach(() => {
    __resetWorkRunRuntimeForTest();
  });

  it('an empty exit-0 run yields a completed terminal with outcome=noop, and the alert says no-op (not finished)', async () => {
    setupValidProject('06-webview');
    mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0 }));

    const descriptor = {
      id: 'noop-e2e-1',
      kind: 'work-run',
      payload: { projectSlug: '06-webview' },
      status: 'running',
    } as any;
    const ctx = { bus: null as any, cancel: () => false };

    // --- Half 1: classification ---
    const events: any[] = [];
    for await (const event of workRunApplier.apply(descriptor, ctx)) events.push(event);

    const terminal = events.find(e => e.kind === 'completed' || e.kind === 'failed');
    expect(terminal).toBeDefined();
    // status stays within the enum (completed), but the verdict rides on outcome.
    expect(terminal.kind).toBe('completed');
    expect(terminal.data.outcome).toBe('noop');

    // --- Half 2: the alert emitted from THAT terminal event ---
    // Reconstruct the BusMutationEvent the sender sees, faithful to what
    // mutations.ts publishes: mutationKind = descriptor.kind ('work-run'),
    // subKind = the terminal event's kind, and `data` taken verbatim from
    // `event.data` (NOT re-read from descriptor.outcome — mutations.ts stamps
    // the descriptor separately but the bus frame carries event.data as-is).
    const busEvent = {
      kind: 'mutation-event' as const,
      mutationId: descriptor.id,
      mutationKind: 'work-run' as const,
      subKind: terminal.kind as 'completed' | 'failed',
      ts: '2026-05-30T12:00:00.000Z',
      data: terminal.data,
      userId: 42,
    } as any;

    const sender = new TelegramSender(mockBot());
    sender.onMutationEvent(busEvent);
    await flush();

    expect(mockSendLongMessage).toHaveBeenCalledTimes(1);
    const text = String(mockSendLongMessage.mock.calls[0]![2]);
    // The whole point of project 11: a do-nothing run never reads as success.
    expect(text.toLowerCase()).toContain('no-op');
    expect(text).not.toContain('✅');
    expect(text.toLowerCase()).not.toContain('finished');
  });
});
