import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

// --- Mocks before any dynamic imports ---

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock child_process: spawn returns a controllable fake child
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  execFileSync: vi.fn(() => '/usr/local/bin/claude'),
}));

// Mock node:fs for existsSync/readFileSync/readdirSync/statSync
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

// The project root used by work-runner
const TEST_PROJECT_ROOT = '/test/jarvis';

vi.mock('../config.js', () => ({
  PROJECT_ROOT: TEST_PROJECT_ROOT,
  default: {
    PROJECT_ROOT: TEST_PROJECT_ROOT,
    WORK_RUN_PER_PROJECT_CAP: 1,
    WORK_RUN_GLOBAL_CAP: 2,
    // Project 15 (P0.2) — read at module load into TERMINAL_DRAIN_MS /
    // REAP_SIGKILL_MS. Spec defaults so the watchdog timing matches the tests.
    WORK_RUN_TERMINAL_DRAIN_MS: 30_000,
    WORK_RUN_REAP_GRACE_MS: 5_000,
    WORKSPACE_DIR: undefined,
    TELEGRAM_USER_ID: 42,
    // Used by productionRuntimeDeps() (the seam __resetWorkRunRuntimeForTest
    // restores between tests) so the restored object has a defined dir even
    // though every test re-injects its own via __setWorkRunRuntimeForTest.
    WORK_RUNS_DIR: '/tmp/test-work-runs',
    WORK_RUNS_INDEX_FILE: '/tmp/test-work-runs/index.jsonl',
    // Phase 3.5 gated-merge wiring reads these in the common apply() path: the
    // integration-worktree path (`join(WORKTREE_ROOT, …)`), the product config
    // path (passed to the mocked getProductConfig), and the per-command gate
    // timeout (passed to the mocked runGate).
    WORKTREE_ROOT: '/tmp/test-worktrees',
    PRODUCTS_CONFIG_FILE: '/tmp/test-products.json',
    WORK_RUN_GATE_COMMAND_TIMEOUT_MS: 600_000,
  },
}));

// Mock mutations module to control activeRuns
const mockActiveRuns = new Map<string, any>();
vi.mock('../transport/mutations.js', () => ({
  activeRuns: mockActiveRuns,
}));

// Mock claude.ts for registerActiveProcess/unregisterActiveProcess
const mockRegisterActiveProcess = vi.fn();
const mockUnregisterActiveProcess = vi.fn();
vi.mock('../ai/claude.js', () => ({
  CLAUDE_BIN: '/usr/local/bin/claude',
  registerActiveProcess: mockRegisterActiveProcess,
  unregisterActiveProcess: mockUnregisterActiveProcess,
  // Same flags execClaude prepends. Tests look up args by indexOf so the
  // exact values don't matter, only that the call resolves to something.
  getProjectMcpArgs: () => ['--strict-mcp-config', '--mcp-config', '/tmp/test-project/.claude/settings.json'],
}));

// Mock the GC runner — work-runner's completion finally fires it best-effort;
// the GC pass itself is covered by work-run-gc.test.ts, so here it's a no-op.
vi.mock('./work-run-gc-runner.js', () => ({
  runWorkRunGc: vi.fn().mockResolvedValue(undefined),
}));

// Mock sandbox-runtime: createWorktree/destroyWorktree return controllable
// stubs. Tests assert on call args; production wires the real git worktree
// lifecycle (`src/jobs/sandbox-runtime.ts`). `defaultRunGit` is exported by the
// real module and reused by work-runner's production deps — the mock provides a
// no-op stand-in so a missing export can't crash module-eval (tests inject
// their own git runner via the runtime seam regardless).
const mockCreateWorktree = vi.fn();
const mockDestroyWorktree = vi.fn();
// `getProductConfig` is the Phase 3.5 baseBranch source — the gated-merge wiring
// reads `getProductConfig(product, …).baseBranch` to know what `main` the run
// would land on. Inert until that wiring imports it (hold mode never reads it).
const mockGetProductConfig = vi.fn(() => ({
  product: 'jarvis',
  repoPath: '/test/repo/jarvis',
  baseBranch: 'main',
  egressAllowlist: [],
  validationCommands: ['npm run build', 'npm test'],
}));
vi.mock('./sandbox-runtime.js', () => ({
  createWorktree: mockCreateWorktree,
  destroyWorktree: mockDestroyWorktree,
  defaultRunGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
  getProductConfig: mockGetProductConfig,
}));

// --- Phase 3.5 (live gated-merge activation) test seams ---

// Spy-wrap the REAL runFinalizer so the existing hold-mode tests keep real
// behavior (the wrap calls through) while the Phase 3.5 live-wiring tests assert
// the MODE and the effects apply() constructs. The `vi.hoisted` holder lets the
// (hoisted) vi.mock factory publish the spy back to the test body.
const finalizerHarness = vi.hoisted(() => ({ runFinalizerSpy: undefined as any }));
vi.mock('./work-run-finalizer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./work-run-finalizer.js')>();
  finalizerHarness.runFinalizerSpy = vi.fn(actual.runFinalizer);
  return { ...actual, runFinalizer: finalizerHarness.runFinalizerSpy };
});

// Gate runtime + per-base-branch merge lock. work-runner does NOT import these
// in `hold` mode, so the mocks sit inert until the Phase 3.5 gated-merge wiring
// imports them. Defaults: a GREEN gate + a pass-through lock, so the happy-path
// wiring test goes green once apply() composes the gate effect as
// `gate = () => withBaseBranchLock(product, baseBranch, () => runGate(...))`.
const mockRunGate = vi.fn(
  async (): Promise<{ ok: true } | { ok: false; reason: string }> => ({ ok: true }),
);
vi.mock('./work-run-gate-runtime.js', () => ({ runGate: mockRunGate }));
const mockWithBaseBranchLock = vi.fn(
  async (_product: string, _base: string, fn: () => unknown) => fn(),
);
vi.mock('./work-run-merge-lock.js', () => ({
  withBaseBranchLock: mockWithBaseBranchLock,
  baseBranchLockKey: (p: string, b: string) => `${p}:${b}`,
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

// --- Dynamic imports after mocks ---

const {
  workRunApplier,
  __setWorkRunRuntimeForTest,
  __resetWorkRunRuntimeForTest,
  __setKillProcessTreeForTest,
  __resetKillProcessTreeForTest,
} = await import('./work-runner.js');

// --- Runtime-deps test doubles (Phase 2: classification + persist seam) ---

/** A controllable GitRunner stub. Default responses classify a clean exit-0
 *  run as `noop` (zero commits, clean tree), matching the prior exit-code
 *  behavior most existing tests assert. Individual tests override per key. */
function makeGitStub(responses: Record<string, { stdout: string; stderr: string }> = {}) {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const stub = vi.fn(async (args: string[], opts?: { cwd?: string }) => {
    calls.push({ args: [...args], cwd: opts?.cwd });
    for (const [key, resp] of Object.entries(responses)) {
      if (args.some(a => a.includes(key))) return resp;
    }
    return { stdout: '', stderr: '' };
  });
  return { stub, calls };
}

/** Records appendIndexRow calls so tests can assert the rolling index row is
 *  written with the classified outcome. */
let indexRows: Array<{ filePath: string; row: any }>;

/** A fake transcript sink recording appends + a finish() spy, so tests can
 *  assert flush-before-terminal ordering without a real WriteStream. */
function makeFakeSink(path = '/tmp/work-runs/run/transcript.jsonl') {
  const appended: unknown[] = [];
  const finish = vi.fn(async () => {});
  const destroy = vi.fn(() => {});
  const sink = {
    path,
    append: vi.fn(async (event: unknown) => { appended.push(event); }),
    finish,
    destroy,
  };
  return { sink, appended, finish, destroy };
}

// --- Helpers ---

const PROJECTS_DIR = `${TEST_PROJECT_ROOT}/docs/projects`;

/** Build a fake child process that behaves like spawn() output */
function makeFakeChild(opts: {
  exitCode?: number;
  exitSignal?: string | null;
  stdoutLines?: string[];
  stderrLines?: string[];
} = {}) {
  const { exitCode = 0, exitSignal = null, stdoutLines = [], stderrLines = [] } = opts;

  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as any;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  child.pid = 12345;

  // Schedule events on next ticks
  setTimeout(() => {
    for (const line of stdoutLines) {
      stdout.emit('data', Buffer.from(line + '\n'));
    }
    for (const line of stderrLines) {
      stderr.emit('data', Buffer.from(line + '\n'));
    }
    child.emit('close', exitCode, exitSignal);
  }, 0);

  return child;
}

/** Set up the fs mocks so findProjectDir("06-webview") succeeds in BOTH the
 *  live tree (used by validate's pre-flight) and inside the worktree (used by
 *  apply after createWorktree). The worktree's `docs/projects` lives under the
 *  fake sandbox path (FAKE_WORKTREE/docs/projects), so the test fixture must
 *  answer for paths under both roots. */
function setupValidProject(slug: string = '06-webview') {
  const dirName = slug;
  const liveDir = join(PROJECTS_DIR, dirName);
  const worktreeDir = join(FAKE_WORKTREE, 'docs', 'projects', dirName);

  mockReaddirSync.mockImplementation((p: string) => {
    if (p === PROJECTS_DIR || p === join(FAKE_WORKTREE, 'docs', 'projects')) {
      return [dirName];
    }
    return [];
  });
  mockStatSync.mockImplementation((p: string) => {
    if (p === liveDir || p === worktreeDir) {
      return { isDirectory: () => true };
    }
    return { isDirectory: () => false, mtimeMs: Date.now() };
  });
  mockExistsSync.mockImplementation((p: string) => {
    return (
      p === join(liveDir, 'spec.md') ||
      p === join(liveDir, 'tasks.md') ||
      p === join(worktreeDir, 'spec.md') ||
      p === join(worktreeDir, 'tasks.md')
    );
  });
  mockReadFileSync.mockImplementation((p: string) => {
    if (p === join(liveDir, 'spec.md') || p === join(worktreeDir, 'spec.md')) {
      return '# Spec\n\nDo something.';
    }
    if (p === join(liveDir, 'tasks.md') || p === join(worktreeDir, 'tasks.md')) {
      return '## Phase A\n\n- [x] Task 1\n- [ ] Task 2\n';
    }
    return '';
  });

  return { dir: liveDir, worktreeDir, dirName };
}

// --- Tests ---

describe('workRunApplier', () => {
  // Per-test handles on the injected persist seam so assertions can inspect
  // what apply() wrote. Re-created in each beforeEach.
  let writeSummarySpy: ReturnType<typeof vi.fn>;
  let currentSink: ReturnType<typeof makeFakeSink>;
  let gitStub: ReturnType<typeof makeGitStub>;
  let runForensicsSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets call history but NOT implementations — reset
    // mockSpawn explicitly so a prior test's `mockImplementation(throw ...)`
    // doesn't bleed across the test boundary and cause apparent failures
    // for the wrong reason.
    mockSpawn.mockReset();
    mockActiveRuns.clear();
    // Default: createWorktree returns a usable sandbox; destroyWorktree is
    // a no-op. Individual tests override these (e.g. to make createWorktree
    // throw) before invoking apply.
    mockCreateWorktree.mockImplementation(async () => fakeSandboxSpec());
    mockDestroyWorktree.mockImplementation(async () => {});

    // Inject the Phase 2 classification + persist seam with test doubles:
    //  - git stub returns empty for every command → a clean exit-0 run
    //    classifies `noop` (preserving the prior completed-on-0 behavior most
    //    existing tests assert),
    //  - createSink hands out a fresh fake sink (recorded on `currentSink`),
    //  - writeSummary is a spy so persistence can be asserted without real fs.
    writeSummarySpy = vi.fn();
    gitStub = makeGitStub();
    currentSink = makeFakeSink();
    indexRows = [];
    // runForensics is stubbed (the real export writes real fs, which node:fs is
    // mocked away from here) — its own contract is covered by
    // work-run-forensics.test.ts; here we only assert it's invoked correctly.
    runForensicsSpy = vi.fn(async () => ({ forensicsPath: '/tmp/test-work-runs/x', files: [] }));
    __setWorkRunRuntimeForTest({
      runGit: gitStub.stub as never,
      workRunsDir: '/tmp/test-work-runs',
      workRunsIndexFile: '/tmp/test-work-runs/index.jsonl',
      createSink: () => currentSink.sink as never,
      writeSummary: writeSummarySpy as never,
      appendIndexRow: ((filePath: string, row: any) => { indexRows.push({ filePath, row }); }) as never,
      runForensics: runForensicsSpy as never,
    });
    // Stub the process-group reaper for every test so a cancel/exit reap never
    // fires a real `process.kill(-pid)` at the fake test pid (12345). Tests that
    // assert on reaping install their own spy via __setKillProcessTreeForTest.
    __setKillProcessTreeForTest(() => {});
  });

  afterEach(() => {
    __resetWorkRunRuntimeForTest();
    __resetKillProcessTreeForTest();
  });

  describe('validate', () => {
    it('returns ok: false when projectSlug is missing', () => {
      const result = workRunApplier.validate({} as any);
      expect(result.ok).toBe(false);
      expect((result as any).reason).toContain('projectSlug');
    });

    it('returns ok: false when projectSlug is empty string', () => {
      const result = workRunApplier.validate({ projectSlug: '' });
      expect(result.ok).toBe(false);
    });

    it('returns ok: false when project directory is not found in docs/projects/', () => {
      mockReaddirSync.mockReturnValue(['01-mvp', '02-journal-kb']);
      mockStatSync.mockReturnValue({ isDirectory: () => true });

      const result = workRunApplier.validate({ projectSlug: 'nonexistent-project' });
      expect(result.ok).toBe(false);
      expect((result as any).reason).toContain('nonexistent-project');
    });

    it('returns ok: false when spec.md is missing', () => {
      const slug = 'no-spec';
      mockReaddirSync.mockReturnValue([slug]);
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      // existsSync returns false for spec.md
      mockExistsSync.mockReturnValue(false);

      const result = workRunApplier.validate({ projectSlug: slug });
      expect(result.ok).toBe(false);
      expect((result as any).reason).toContain('spec.md');
    });

    it('returns ok: false when per-project cap is reached', () => {
      const slug = '06-webview';
      setupValidProject(slug);

      // Simulate an existing running run for this slug
      mockActiveRuns.set('existing-run', {
        descriptor: {
          kind: 'work-run',
          payload: { projectSlug: slug },
          status: 'running',
        },
      });

      const result = workRunApplier.validate({ projectSlug: slug });
      expect(result.ok).toBe(false);
      expect((result as any).reason).toContain('already running');
    });

    it('returns ok: false when global cap is reached', () => {
      setupValidProject('06-webview');

      // Two existing running work-runs = hit the global cap (default 2)
      mockActiveRuns.set('run-1', {
        descriptor: { kind: 'work-run', payload: { projectSlug: 'other-1' }, status: 'running' },
      });
      mockActiveRuns.set('run-2', {
        descriptor: { kind: 'work-run', payload: { projectSlug: 'other-2' }, status: 'running' },
      });

      const result = workRunApplier.validate({ projectSlug: '06-webview' });
      expect(result.ok).toBe(false);
      expect((result as any).reason).toContain('global');
    });

    it('returns ok: true for a valid existing project with spec.md (using 06-webview fixture)', () => {
      setupValidProject('06-webview');

      const result = workRunApplier.validate({ projectSlug: '06-webview' });
      expect(result.ok).toBe(true);
    });

    it('matches a project directory by slug suffix (e.g. "06-webview" matches dir "06-webview")', () => {
      // Directory name is "06-webview" and slug is "webview" — should match via endsWith
      const slug = 'webview';
      mockReaddirSync.mockReturnValue(['06-webview']);
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('spec.md');
      });

      const result = workRunApplier.validate({ projectSlug: slug });
      expect(result.ok).toBe(true);
    });
  });

  describe('apply — spawn args', () => {
    it('spawns claude with cwd=sandbox.worktree (NOT PROJECT_ROOT) for self-edit isolation', async () => {
      // The root cause of the 2026-05-27 incident: spawning into PROJECT_ROOT
      // means an agent editing Jarvis's source files triggers tsx watch to
      // SIGTERM the parent. Running inside a worktree breaks the loop —
      // tsx watch only watches PROJECT_ROOT, not the worktree under
      // .worktrees/<product>/<project>.
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-1',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
        source: 'webview',
        target: { type: 'work-run', ref: '06-webview' },
        preview: { summary: 'work-run on 06-webview' },
        createdAt: new Date().toISOString(),
      } as any;

      const ctx = { bus: null as any, cancel: () => false };

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptor, ctx)) {
        events.push(event);
      }

      expect(mockSpawn).toHaveBeenCalledOnce();
      const [bin, args, spawnOpts] = mockSpawn.mock.calls[0]!;

      expect(typeof bin).toBe('string');
      // cwd must be the worktree, not the live tree — the whole point of Fix 1.
      expect(spawnOpts.cwd).toBe(FAKE_WORKTREE);
      // The relative `--add-dir docs/projects/<dirName>` flag from the
      // pre-worktree version is gone: under a worktree cwd the path resolves
      // differently and the worktree already contains the project dir in
      // its HEAD tree, so the flag was redundant.
      expect(args).not.toContain('--add-dir');
      // Headless `claude -p` must skip permission prompts or every mutating
      // tool auto-denies (the 2026-06-01 noop). Mirrors execClaude.
      expect(args).toContain('--dangerously-skip-permissions');
      // Spawned detached so the child leads its own process group — the
      // prerequisite for reaping orphaned grandchildren that would otherwise
      // wedge the run open (docs/projects/bugs.md).
      expect(spawnOpts.detached).toBe(true);
    });

    it('yields a completed terminal event on exit code 0', async () => {
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-ok',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptor, ctx)) {
        events.push(event);
      }

      const terminal = events.find(e => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal).toBeDefined();
      expect(terminal.kind).toBe('completed');
    });

    it('yields a failed terminal event on non-zero exit code', async () => {
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 1, exitSignal: null });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-fail',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptor, ctx)) {
        events.push(event);
      }

      const terminal = events.find(e => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal).toBeDefined();
      expect(terminal.kind).toBe('failed');
    });

    it('converts stream-json assistant envelopes into human-readable output events (not raw JSON)', async () => {
      // Phase 1 "Stream spawn + convert": stdout is now newline-delimited
      // stream-json, not raw text. Each assistant text envelope must surface
      // its text as an `output` event line — the drawer renders readable
      // lines, never the raw JSON envelope.
      setupValidProject('06-webview');
      const envelopes = [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'line one' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'line two' }] } }),
      ];
      const fakeChild = makeFakeChild({ exitCode: 0, stdoutLines: envelopes });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-out',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptor, ctx)) {
        events.push(event);
      }

      const lines = events.filter(e => e.kind === 'output').map(e => e.data.line as string);
      expect(lines).toContain('line one');
      expect(lines).toContain('line two');
      // Never the raw JSON envelope
      expect(lines.some(l => l.includes('"type":"assistant"'))).toBe(false);
    });

    it('surfaces an error tool_result (is_error:true) as a ⨯-marked output event (Fix #1)', async () => {
      // Phase 6 follow-on Fix #1: a permission-gate denial arrives as a
      // `user`/`tool_result` `is_error:true` frame. Previously it rendered
      // nothing, so a silent no-op run had no visible explanation. It must now
      // become a readable `⨯` output line in the drawer / ring buffer.
      setupValidProject('06-webview');
      const envelopes = [
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: 'This command requires approval', is_error: true, tool_use_id: 'toolu_x' }],
          },
        }),
        JSON.stringify({ type: 'result', result: 'done' }),
      ];
      const fakeChild = makeFakeChild({ exitCode: 0, stdoutLines: envelopes });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-err',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptor, ctx)) {
        events.push(event);
      }

      const lines = events.filter(e => e.kind === 'output').map(e => e.data.line as string);
      expect(lines.some(l => l.includes('⨯') && l.includes('This command requires approval'))).toBe(true);
    });

    it('redacts secrets from output event lines on the display/bus path (Fix #1 hardening)', async () => {
      // `streamJsonToDisplay` only scrubs host paths; the display/bus path must
      // also redact secrets so a credential-bearing error message echoed by a
      // tool_result never reaches the in-memory ring buffer or the bus → WS/TG
      // surfaces un-redacted. (The durable sink redacts independently.)
      setupValidProject('06-webview');
      const secret = `ghp_${'A'.repeat(36)}`;
      const envelopes = [
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: `git push failed: https://${secret}@github.com/x.git`, is_error: true, tool_use_id: 'toolu_s' }],
          },
        }),
        JSON.stringify({ type: 'result', result: 'done' }),
      ];
      const fakeChild = makeFakeChild({ exitCode: 0, stdoutLines: envelopes });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-secret',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptor, ctx)) {
        events.push(event);
      }

      const lines = events.filter(e => e.kind === 'output').map(e => e.data.line as string);
      // The raw secret must never appear in a display line
      expect(lines.some(l => l.includes(secret))).toBe(false);
      // The error is still surfaced (redacted form), not dropped
      expect(lines.some(l => l.includes('⨯') && l.includes('git push failed'))).toBe(true);
    });

    it('emits keep-alive events on a 30s ticker while the child is alive and stops on close', async () => {
      // The applier's process-liveness ticker. Distinct from output
      // events — fires regardless of stdout activity so the supervision
      // store's lastChildAliveAt stays fresh during long quiet LLM calls.
      // See src/transport/mutations.ts for the upsert throttle that
      // matches this cadence; see supervision.isStalled for why this
      // distinct signal exists.
      vi.useFakeTimers();
      try {
        setupValidProject('06-webview');

        // Construct a fake child that does NOT auto-close — we control
        // when it ends so the ticker has time to fire repeatedly.
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        const child = new EventEmitter() as any;
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = vi.fn();
        child.pid = 12345;
        mockSpawn.mockReturnValue(child);

        const descriptor = {
          id: 'mut-keepalive',
          kind: 'work-run',
          payload: { projectSlug: '06-webview' },
          status: 'running',
        } as any;
        const ctx = { bus: null as any, cancel: () => false };

        const events: any[] = [];
        const consume = (async () => {
          for await (const event of workRunApplier.apply(descriptor, ctx)) {
            events.push(event);
          }
        })();

        // Let the synchronous spawn + handler registration + setInterval
        // install settle in microtasks.
        await vi.advanceTimersByTimeAsync(0);

        // Three ticks worth of fake time → three keep-alive events.
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.advanceTimersByTimeAsync(30_000);

        const tickEventsBeforeClose = events.filter((e) => e.kind === 'keep-alive');
        expect(tickEventsBeforeClose.length).toBe(3);

        // Close the child and let the loop finish.
        child.emit('close', 0, null);
        await vi.advanceTimersByTimeAsync(0);
        await consume;

        // After close, advancing time must not produce more keep-alive
        // events — the ticker must be cleared on close (otherwise the
        // timer leaks past every run).
        const countAfterClose = events.filter((e) => e.kind === 'keep-alive').length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(events.filter((e) => e.kind === 'keep-alive').length).toBe(countAfterClose);
      } finally {
        vi.useRealTimers();
      }
    });

    it('completes a wedged run: agent exits but stdio never closes (orphaned grandchild holds the pipes)', async () => {
      // The wedge bug (docs/projects/bugs.md): the agent emits its terminal
      // result and the process exits, but a grandchild it spawned (e.g. a hung
      // `vitest`) inherited the stdio fds and keeps them open, so `close` never
      // fires. Keying completion only on `close` left the run `running` for
      // hours. The fix keys off `exit` + reaps the process group.
      vi.useFakeTimers();
      try {
        setupValidProject('06-webview');
        const killSpy = vi.fn();
        __setKillProcessTreeForTest(killSpy);

        // Manual child that emits its terminal result + `exit`, but NEVER `close`.
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        const child = new EventEmitter() as any;
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = vi.fn();
        child.pid = 12345;
        mockSpawn.mockReturnValue(child);

        const descriptor = {
          id: 'mut-wedge',
          kind: 'work-run',
          payload: { projectSlug: '06-webview' },
          status: 'running',
        } as any;

        const events: any[] = [];
        let finished = false;
        const consume = (async () => {
          for await (const event of workRunApplier.apply(descriptor, { bus: null as any, cancel: () => false })) {
            events.push(event);
          }
          finished = true;
        })();

        await vi.advanceTimersByTimeAsync(0);
        // Agent finishes: terminal result on stdout, then the process exits 0 —
        // but no `close` (the grandchild still holds the pipes).
        stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', result: 'done' }) + '\n'));
        child.emit('exit', 0, null);
        await vi.advanceTimersByTimeAsync(0);

        // Reap kicks off immediately with a group SIGTERM.
        expect(killSpy).toHaveBeenCalledWith(child, 'SIGTERM');
        // Not done yet — `close` never fired.
        expect(finished).toBe(false);

        // Past the SIGKILL grace + the force-done ceiling, the run completes
        // anyway instead of hanging forever.
        await vi.advanceTimersByTimeAsync(10_000);
        await consume;

        expect(killSpy).toHaveBeenCalledWith(child, 'SIGKILL');
        expect(finished).toBe(true);
        const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
        expect(terminal).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    // -----------------------------------------------------------------------
    // P0.2 (project 15) — terminal-result watchdog. test-plan §3. WRITE-FIRST.
    //
    // The NEW gap (distinct from the wedge test above): the agent emits a
    // terminal `result` and then the process NEVER exits — `exit` never fires
    // because backgrounded tasks (a hung `vitest`) keep `claude -p` alive. The
    // existing reapTree() is triggered only from `on('exit')`, so nothing
    // finalizes; the run sits `running` for hours (the d0679453 incident).
    //
    // The watchdog the impl must add: on the terminal `result` envelope, open a
    // bounded drain window (WORK_RUN_TERMINAL_DRAIN_MS). If the child exits on
    // its own within it, teardown proceeds via the existing exit-keyed path with
    // NO watchdog reap. If it does NOT, the watchdog reaps the process group
    // (SIGTERM → SIGKILL → force-complete) and stamps the exit fact
    // `reaped-after-terminal-result` so the classifier can tell an internal
    // post-result reap apart from an external kill.
    //
    // RED cases: "never exits → reap + exit fact" and the incident-shape replay
    // (no watchdog exists yet → no reap, run never finishes). GREEN guards:
    // "exits within window → no watchdog reap" and "not killed before the drain
    // deadline" both hold under current code and protect against a
    // finalize-immediately-on-result regression (the unsafe early proposal).
    // -----------------------------------------------------------------------
    describe('terminal-result watchdog (P0.2)', () => {
      /** Manual child that emits nothing on its own — the test drives stdout +
       *  exit/close explicitly so the drain window can be exercised. */
      function makeManualChild() {
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        const child = new EventEmitter() as any;
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = vi.fn();
        child.pid = 12345;
        return { child, stdout, stderr };
      }

      const RESULT_LINE = Buffer.from(
        JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\n',
      );

      it('result emitted then child never exits → drain → group reap → reaped-after-terminal-result', async () => {
        vi.useFakeTimers();
        let child: any;
        let consume: Promise<void> | undefined;
        try {
          setupValidProject('06-webview');
          const killSpy = vi.fn();
          __setKillProcessTreeForTest(killSpy);
          const m = makeManualChild();
          child = m.child;
          mockSpawn.mockReturnValue(child);

          const descriptor = {
            id: 'mut-watchdog-hang', kind: 'work-run',
            payload: { projectSlug: '06-webview' }, status: 'running',
          } as any;

          const events: any[] = [];
          let finished = false;
          consume = (async () => {
            for await (const e of workRunApplier.apply(descriptor, { bus: null as any, cancel: () => false })) {
              events.push(e);
            }
            finished = true;
          })().catch(() => { /* current-code red path: the loop never completes */ });

          await vi.advanceTimersByTimeAsync(0);
          // Agent reports success but the process never exits (hung background task).
          m.stdout.emit('data', RESULT_LINE);
          // No `exit`, no `close`. Advance past the drain window + SIGKILL grace +
          // force-done ceiling (drain 30s + reap 3s + force 10s, with headroom).
          await vi.advanceTimersByTimeAsync(60_000);

          // The watchdog must have reaped the group and force-completed the run.
          expect(killSpy).toHaveBeenCalledWith(child, 'SIGTERM');
          expect(finished).toBe(true);
          const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
          expect(terminal).toBeDefined();
          expect((terminal!.data as any)?.exit?.exitFact).toBe('reaped-after-terminal-result');
        } finally {
          // Release any still-hanging consume on the red path, THEN await it so
          // the generator is fully drained before timers/seams are reset.
          try { child?.emit('close', null, 'SIGKILL'); } catch { /* already closed */ }
          await consume;
          vi.useRealTimers();
          __resetKillProcessTreeForTest();
        }
      });

      it('result emitted then child exits within the drain window → no watchdog reap, clean exit fact', async () => {
        vi.useFakeTimers();
        let child: any;
        try {
          setupValidProject('06-webview');
          const killSpy = vi.fn();
          __setKillProcessTreeForTest(killSpy);
          const m = makeManualChild();
          child = m.child;
          mockSpawn.mockReturnValue(child);

          const descriptor = {
            id: 'mut-watchdog-clean', kind: 'work-run',
            payload: { projectSlug: '06-webview' }, status: 'running',
          } as any;

          const events: any[] = [];
          let finished = false;
          const consume = (async () => {
            for await (const e of workRunApplier.apply(descriptor, { bus: null as any, cancel: () => false })) {
              events.push(e);
            }
            finished = true;
          })().catch(() => {});

          await vi.advanceTimersByTimeAsync(0);
          m.stdout.emit('data', RESULT_LINE);
          // Child exits on its own well within the drain window, then stdio closes.
          await vi.advanceTimersByTimeAsync(2_000);
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
          await vi.advanceTimersByTimeAsync(0);
          await consume;

          expect(finished).toBe(true);
          const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
          expect(terminal).toBeDefined();
          // Teardown went through the exit-keyed path — NOT a watchdog reap.
          expect((terminal!.data as any)?.exit?.exitFact).not.toBe('reaped-after-terminal-result');
        } finally {
          vi.useRealTimers();
          __resetKillProcessTreeForTest();
        }
      });

      it('does NOT kill the child immediately on result (no signal before the drain deadline)', async () => {
        vi.useFakeTimers();
        let child: any;
        try {
          setupValidProject('06-webview');
          const killSpy = vi.fn();
          __setKillProcessTreeForTest(killSpy);
          const m = makeManualChild();
          child = m.child;
          mockSpawn.mockReturnValue(child);

          const descriptor = {
            id: 'mut-watchdog-nokill', kind: 'work-run',
            payload: { projectSlug: '06-webview' }, status: 'running',
          } as any;

          const consume = (async () => {
            for await (const _e of workRunApplier.apply(descriptor, { bus: null as any, cancel: () => false })) {
              /* drain */
            }
          })().catch(() => {});

          await vi.advanceTimersByTimeAsync(0);
          m.stdout.emit('data', RESULT_LINE);
          // Advance only PART of the drain window — the child must not be killed
          // yet (guards against the unsafe finalize-immediately-on-result path
          // that re-introduces the false `failed` the 2026-06-04 fix removed).
          await vi.advanceTimersByTimeAsync(5_000);
          expect(killSpy).not.toHaveBeenCalled();

          // Release the run for cleanup.
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
          await vi.advanceTimersByTimeAsync(0);
          await consume;
        } finally {
          vi.useRealTimers();
          __resetKillProcessTreeForTest();
        }
      });

      it('incident replay shape: result:success then a never-exiting child reaches a terminal state with no human', async () => {
        vi.useFakeTimers();
        let child: any;
        let consume: Promise<void> | undefined;
        try {
          setupValidProject('06-webview');
          // beforeEach already installs a no-op kill stub; this test doesn't
          // assert on reaping, so it neither overrides nor resets that seam.
          const m = makeManualChild();
          child = m.child;
          mockSpawn.mockReturnValue(child);

          const descriptor = {
            id: 'mut-incident-d0679453', kind: 'work-run',
            payload: { projectSlug: '06-webview' }, status: 'running',
          } as any;

          const events: any[] = [];
          let finished = false;
          consume = (async () => {
            for await (const e of workRunApplier.apply(descriptor, { bus: null as any, cancel: () => false })) {
              events.push(e);
            }
            finished = true;
          })().catch(() => {});

          await vi.advanceTimersByTimeAsync(0);
          m.stdout.emit('data', RESULT_LINE);
          // The keep-alive ticker stays fresh forever (the incident: "quiet, not
          // stalled") — only the watchdog can break the wedge. Inject the clock
          // past the drain window; no exit, no external kill.
          await vi.advanceTimersByTimeAsync(60_000);

          expect(finished).toBe(true);
          expect(events.some((e) => e.kind === 'completed' || e.kind === 'failed')).toBe(true);
        } finally {
          try { child?.emit('close', null, 'SIGKILL'); } catch { /* already closed */ }
          await consume;
          vi.useRealTimers();
          // afterEach resets the kill seam; this test installed no override.
        }
      });
    });

    it('calls createWorktree with product=jarvis, project=slug, branch=jarvis-work/<slug>', async () => {
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'abcdef12-3456-7890-abcd-ef1234567890',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      for await (const _ of workRunApplier.apply(descriptor, ctx)) {
        // consume
      }

      expect(mockCreateWorktree).toHaveBeenCalledOnce();
      const callArgs = mockCreateWorktree.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs.product).toBe('jarvis');
      expect(callArgs.project).toBe('06-webview');
      // Stable per-PROJECT branch (NOT per-run-id), so the next run resumes this
      // branch instead of re-forking off main and restarting from Phase 1
      // (docs/projects/bugs.md). Independent of the run id.
      expect(callArgs.branch).toBe('jarvis-work/06-webview');
    });

    it('adds a RESUME note to the agent prompt when createWorktree resumed an existing branch', async () => {
      setupValidProject('06-webview');
      // createWorktree reports it checked out an existing (in-progress) branch.
      mockCreateWorktree.mockImplementation(async () => fakeSandboxSpec({ resumed: true }));
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-resume', kind: 'work-run', payload: { projectSlug: '06-webview' }, status: 'running',
      } as any;
      for await (const _ of workRunApplier.apply(descriptor, { bus: null as any, cancel: () => false })) {
        // consume
      }

      expect(mockSpawn).toHaveBeenCalledOnce();
      const [, args] = mockSpawn.mock.calls[0]!;
      const prompt = String((args as string[])[(args as string[]).indexOf('-p') + 1]);
      // The note tells the agent prior commits are present so it doesn't restart —
      // the core symptom of the re-fork bug (docs/projects/bugs.md).
      expect(prompt).toContain('RESUMED');
      expect(prompt).toMatch(/do NOT restart from Phase 1/i);
    });

    it('does NOT add the resume note on a fresh (non-resumed) run', async () => {
      setupValidProject('06-webview');
      // Default createWorktree mock returns a spec with no `resumed` flag.
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-fresh', kind: 'work-run', payload: { projectSlug: '06-webview' }, status: 'running',
      } as any;
      for await (const _ of workRunApplier.apply(descriptor, { bus: null as any, cancel: () => false })) {
        // consume
      }

      const [, args] = mockSpawn.mock.calls[0]!;
      const prompt = String((args as string[])[(args as string[]).indexOf('-p') + 1]);
      expect(prompt).not.toContain('RESUMED');
    });

    it('honors payload.product when present (not hardcoded to jarvis)', async () => {
      // The cockpit knows each project's product from the registry; once
      // wired through, work-run for an aura project must create the
      // worktree against aura's repo, not jarvis.
      setupValidProject('02-growth');
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-aura',
        kind: 'work-run',
        payload: { projectSlug: '02-growth', product: 'aura' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      for await (const _ of workRunApplier.apply(descriptor, ctx)) {
        // consume
      }

      const callArgs = mockCreateWorktree.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs.product).toBe('aura');
    });

    it('calls destroyWorktree in finally on successful completion', async () => {
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-cleanup-ok',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      for await (const _ of workRunApplier.apply(descriptor, ctx)) {
        // consume
      }

      expect(mockDestroyWorktree).toHaveBeenCalledOnce();
      const [sandboxArg] = mockDestroyWorktree.mock.calls[0]!;
      expect((sandboxArg as { worktree: string }).worktree).toBe(FAKE_WORKTREE);
    });

    it('calls destroyWorktree in finally on cancelled run', async () => {
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 143, exitSignal: 'SIGTERM' });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-cancel',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      // Always-cancelled context — applier sends SIGTERM at the top of
      // its event loop and the fake child reports a SIGTERM exit.
      const ctx = { bus: null as any, cancel: () => true };

      for await (const _ of workRunApplier.apply(descriptor, ctx)) {
        // consume
      }

      expect(mockDestroyWorktree).toHaveBeenCalledOnce();
    });

    it('calls destroyWorktree in finally when streamProcess throws mid-run', async () => {
      // Pathological case: spawn throws (e.g., binary not found, EACCES).
      // The worktree was already created — finally must still tear it down
      // so the next run doesn't collide on the deterministic path.
      setupValidProject('06-webview');
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn ENOENT — claude binary missing');
      });

      const descriptor = {
        id: 'mut-spawn-throw',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      // Consume — the generator surfaces the throw via the finally chain.
      try {
        for await (const _ of workRunApplier.apply(descriptor, ctx)) {
          // consume
        }
      } catch {
        // Expected — spawn ENOENT propagates as a generator error.
      }

      expect(mockDestroyWorktree).toHaveBeenCalledOnce();
    });

    it('yields a failed event and does NOT spawn when createWorktree throws', async () => {
      // The opposite case from the spawn-throw test: createWorktree itself
      // fails (e.g., the deterministic path already exists from an orphan
      // run, or git is in a bad state). No worktree was created, so
      // destroyWorktree must NOT be called (would point at a path that
      // never existed), and spawn must NOT run.
      setupValidProject('06-webview');
      mockCreateWorktree.mockImplementation(async () => {
        throw new Error('createWorktree: target path already exists');
      });

      const descriptor = {
        id: 'mut-worktree-fail',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptor, ctx)) {
        events.push(event);
      }

      const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal).toBeDefined();
      expect(terminal.kind).toBe('failed');
      expect(String(terminal.data?.reason ?? '')).toMatch(/worktree/i);

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockDestroyWorktree).not.toHaveBeenCalled();
    });

    it('registers and unregisters the child process', async () => {
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-reg',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      for await (const _ of workRunApplier.apply(descriptor, ctx)) {
        // consume
      }

      expect(mockRegisterActiveProcess).toHaveBeenCalledWith(fakeChild);
      expect(mockUnregisterActiveProcess).toHaveBeenCalledWith(fakeChild);
    });
  });

  describe('apply — stream-json consumption', () => {
    it('emits exactly ONE terminal event (streamProcess returns exit facts; apply emits the terminal)', async () => {
      // test-plan §2 handoff contract: after the streamProcess refactor (it
      // RETURNS exit facts instead of yielding the terminal), apply() must emit
      // exactly one terminal event — no double-terminal, no skipped terminal —
      // across a run that also produces output + stderr.
      setupValidProject('06-webview');
      const envelope = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
      const fakeChild = makeFakeChild({ exitCode: 0, stdoutLines: [envelope], stderrLines: ['a warning'] });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-one-terminal',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptor, ctx)) {
        events.push(event);
      }

      const terminals = events.filter(e => e.kind === 'completed' || e.kind === 'failed');
      expect(terminals).toHaveLength(1);
      expect(terminals[0].kind).toBe('completed');
      // The single terminal carries the exit facts (incl. durationMs) — the
      // classified terminal nests the full ExitFacts blob under data.exit.
      expect(typeof terminals[0].data.exit.durationMs).toBe('number');
    });

    it('spawns claude with --output-format stream-json --verbose', async () => {
      // Requirement 10: pass stream-json so every assistant turn and tool call
      // lands on stdout as a parseable envelope.
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-sj-args',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      for await (const _ of workRunApplier.apply(descriptor, ctx)) {
        // consume
      }

      const [, args] = mockSpawn.mock.calls[0]!;
      expect(args).toContain('--output-format');
      expect(args[(args as string[]).indexOf('--output-format') + 1]).toBe('stream-json');
      expect(args).toContain('--verbose');
    });

    it('renders a tool_use envelope as a readable activity line (not raw JSON)', async () => {
      setupValidProject('06-webview');
      const envelope = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] },
      });
      const fakeChild = makeFakeChild({ exitCode: 0, stdoutLines: [envelope] });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-sj-tool',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptor, ctx)) {
        events.push(event);
      }

      const lines = events.filter(e => e.kind === 'output').map(e => e.data.line as string);
      expect(lines.some(l => l.includes('Bash'))).toBe(true);
      expect(lines.some(l => l.includes('"tool_use"'))).toBe(false);
    });

    it('does not crash on a malformed stream-json line; the run still terminates cleanly', async () => {
      // Requirement: a malformed/partial JSON line must not crash the run — it
      // is tolerated (routed off the readable-output path) and the run reaches
      // its terminal event normally.
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({
        exitCode: 0,
        stdoutLines: ['{ this is not valid json', JSON.stringify({ type: 'result', result: 'ok' })],
      });
      mockSpawn.mockReturnValue(fakeChild);

      const descriptor = {
        id: 'mut-sj-malformed',
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
      const ctx = { bus: null as any, cancel: () => false };

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptor, ctx)) {
        events.push(event);
      }

      const terminal = events.find(e => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal).toBeDefined();
      expect(terminal.kind).toBe('completed');
      // The malformed line must NOT surface as a readable output line.
      const lines = events.filter(e => e.kind === 'output').map(e => e.data.line as string);
      expect(lines.some(l => l.includes('this is not valid json'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2 line 51: classification + flush transcript + write summary.json
  // before the terminal event (test-plan §2; spec requirements 8, 13).
  // -------------------------------------------------------------------------
  describe('apply — classification + persistence (Phase 2)', () => {
    function descriptorFor(id: string) {
      return {
        id,
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
    }

    it('the single terminal event carries a typed outcome on data', async () => {
      // The terminal is now produced by the work-product classifier, not the
      // bare exit code — so it must carry `data.outcome` (here `noop`, since the
      // git stub reports zero commits + a clean tree).
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptorFor('mut-outcome'), { bus: null as any, cancel: () => false })) {
        events.push(event);
      }

      const terminals = events.filter(e => e.kind === 'completed' || e.kind === 'failed');
      expect(terminals).toHaveLength(1);
      expect(terminals[0].kind).toBe('completed');
      expect(terminals[0].data.outcome).toBe('noop');
    });

    it('classifies dirty-uncommitted when the tree is dirty with zero commits', async () => {
      // git status --porcelain reports a modified file → dirty tree, no commits
      // → dirty-uncommitted (the outcome that flags work left behind on the
      // worktree). Proves the classifier reads the injected git, not exit code.
      setupValidProject('06-webview');
      gitStub.stub.mockImplementation(async (args: string[]) => {
        if (args.includes('status') && args.includes('--porcelain')) {
          return { stdout: ' M src/foo.ts\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptorFor('mut-dirty'), { bus: null as any, cancel: () => false })) {
        events.push(event);
      }

      const terminal = events.find(e => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal.data.outcome).toBe('dirty-uncommitted');
    });

    it('writes summary.json (atomic store) before emitting the terminal event', async () => {
      // Requirement 8/13: the transcript is flushed and summary.json is written
      // BEFORE the terminal event fires. startApply persists + tears down on the
      // terminal, so the artifacts must exist first.
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      let summaryWrittenAtTerminal: boolean | undefined;
      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptorFor('mut-summary'), { bus: null as any, cancel: () => false })) {
        if (event.kind === 'completed' || event.kind === 'failed') {
          // Capture whether writeSummary had already been called by the moment
          // the consumer receives the terminal event.
          summaryWrittenAtTerminal = writeSummarySpy.mock.calls.length > 0;
        }
        events.push(event);
      }

      expect(writeSummarySpy).toHaveBeenCalledOnce();
      expect(summaryWrittenAtTerminal).toBe(true);

      // The summary carries the run identity + classified outcome.
      const [dirArg, summaryArg] = writeSummarySpy.mock.calls[0]!;
      expect(String(dirArg)).toContain('mut-summary');
      expect(summaryArg.id).toBe('mut-summary');
      expect(summaryArg.outcome).toBe('noop');
      expect(summaryArg.project).toBe('06-webview');
      expect(summaryArg.exit).toBeDefined();
      expect(summaryArg.workProduct).toBeDefined();
    });

    it('flushes (awaits finish on) the transcript sink before the terminal event', async () => {
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      let finishedAtTerminal: boolean | undefined;
      for await (const event of workRunApplier.apply(descriptorFor('mut-flush'), { bus: null as any, cancel: () => false })) {
        if (event.kind === 'completed' || event.kind === 'failed') {
          finishedAtTerminal = currentSink.finish.mock.calls.length > 0;
        }
      }

      expect(currentSink.finish).toHaveBeenCalledOnce();
      expect(finishedAtTerminal).toBe(true);
    });

    it('tees parsed stream-json envelopes to the durable transcript sink', async () => {
      // Requirement 11: every stream event is appended to the per-run transcript
      // independent of drawer state. The raw parsed envelope is teed (not the
      // human-readable display line).
      setupValidProject('06-webview');
      const envelope = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
      const fakeChild = makeFakeChild({ exitCode: 0, stdoutLines: [envelope] });
      mockSpawn.mockReturnValue(fakeChild);

      for await (const _ of workRunApplier.apply(descriptorFor('mut-tee'), { bus: null as any, cancel: () => false })) {
        // consume
      }

      expect(currentSink.sink.append).toHaveBeenCalled();
      // The teed value is the parsed envelope object (type assistant), not a
      // display string.
      const firstAppend = currentSink.appended[0] as any;
      expect(firstAppend.type).toBe('assistant');
    });

    it('appends a torn-line-tolerant index row carrying the outcome after the run', async () => {
      // Requirement 15: a summary row (id, project, outcome, duration, started,
      // ended) is appended to logs/work-runs/index.jsonl on termination.
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      for await (const _ of workRunApplier.apply(descriptorFor('mut-index'), { bus: null as any, cancel: () => false })) {
        // consume
      }

      expect(indexRows).toHaveLength(1);
      expect(indexRows[0]!.filePath).toBe('/tmp/test-work-runs/index.jsonl');
      const row = indexRows[0]!.row;
      expect(row.id).toBe('mut-index');
      expect(row.project).toBe('06-webview');
      expect(row.outcome).toBe('noop');
      expect(typeof row.durationMs).toBe('number');
      expect(typeof row.startedAt).toBe('string');
      expect(typeof row.endedAt).toBe('string');
    });

    it('augments the terminal event data with projectSlug so downstream surfaces can name the run', async () => {
      // The classified terminal event from finalizeWorkRun carries
      // outcome/reason/workProduct/exit but not the project slug; work-runner
      // augments it so TelegramSender / the bus can label the run by project.
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptorFor('mut-slug'), { bus: null as any, cancel: () => false })) {
        events.push(event);
      }

      const terminal = events.find(e => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal.data.projectSlug).toBe('06-webview');
      expect(terminal.data.product).toBe('jarvis');
    });

    it('emits a throttled progress event when the parent-side poll detects a new commit', async () => {
      // Requirement 22: a parent-side poll of the run branch fires a throttled
      // progress ping carrying the latest commit subject + task tally.
      vi.useFakeTimers();
      try {
        setupValidProject('06-webview');
        // The poll's `git log baseSha..branch` returns one commit; everything
        // else (computeWorkProduct's rev-list/diff/status) stays empty → noop.
        gitStub.stub.mockImplementation(async (args: string[]) =>
          args.includes('log')
            ? { stdout: 'abc1234 add the widget', stderr: '' }
            : { stdout: '', stderr: '' },
        );

        // A child that does NOT auto-close, so the poll ticker has time to fire.
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        const child = new EventEmitter() as any;
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = vi.fn();
        child.pid = 999;
        mockSpawn.mockReturnValue(child);

        const events: any[] = [];
        const consume = (async () => {
          for await (const e of workRunApplier.apply(descriptorFor('mut-poll'), { bus: null as any, cancel: () => false })) {
            events.push(e);
          }
        })();

        // Advance past one poll interval in a single step — robust to the exact
        // microtask moment the ticker is installed during apply()'s startup.
        await vi.advanceTimersByTimeAsync(10_100);

        const progress = events.filter(e => e.kind === 'progress');
        expect(progress.length).toBeGreaterThanOrEqual(1);
        expect(String(progress[0].data.line)).toContain('add the widget');
        // Task tally from the fixture tasks.md (1 of 2 checked).
        expect(String(progress[0].data.line)).toMatch(/1\s*\/\s*2/);

        child.emit('close', 0, null);
        await vi.advanceTimersByTimeAsync(0);
        await consume;
      } finally {
        vi.useRealTimers();
      }
    });

    it('exports forensics before the terminal event, into the per-run dir', async () => {
      // Requirement 16: forensics are exported (while the worktree still exists)
      // before apply() yields the terminal event — startApply tears the worktree
      // down on the terminal, so the bundle/diff/status reads must run first.
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      let forensicsCalledAtTerminal: boolean | undefined;
      for await (const event of workRunApplier.apply(descriptorFor('mut-forensics'), { bus: null as any, cancel: () => false })) {
        if (event.kind === 'completed' || event.kind === 'failed') {
          forensicsCalledAtTerminal = runForensicsSpy.mock.calls.length > 0;
        }
      }

      expect(runForensicsSpy).toHaveBeenCalledOnce();
      expect(forensicsCalledAtTerminal).toBe(true);
      const opts = runForensicsSpy.mock.calls[0]![0] as any;
      expect(opts.worktree).toBe(FAKE_WORKTREE);
      expect(opts.branch).toBe('jarvis-work/06-webview'); // stable per-project branch
      expect(opts.outDir).toBe('/tmp/test-work-runs/mut-forensics');
      // The default git stub reports a clean tree → noop → nonClean false.
      expect(opts.nonClean).toBe(false);
    });

    it('destroys the worktree only AFTER forensics export (finally runs after the body)', async () => {
      // Requirement 17: the worktree is torn down in the generator finally,
      // which runs after the body — so forensics (exported inside
      // finalizeWorkRun, before the terminal yields) always completes while the
      // worktree still exists.
      setupValidProject('06-webview');
      const order: string[] = [];
      runForensicsSpy.mockImplementation(async () => { order.push('forensics'); return { forensicsPath: 'x', files: [] }; });
      mockDestroyWorktree.mockImplementation(async () => { order.push('destroy'); });
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      for await (const _ of workRunApplier.apply(descriptorFor('mut-order'), { bus: null as any, cancel: () => false })) {
        // consume
      }

      expect(order).toEqual(['forensics', 'destroy']);
    });

    it('still destroys the worktree when forensics export throws (failure cannot wedge teardown)', async () => {
      setupValidProject('06-webview');
      runForensicsSpy.mockImplementation(async () => { throw new Error('forensics boom'); });
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptorFor('mut-fore-throw'), { bus: null as any, cancel: () => false })) {
        events.push(event);
      }

      // The deterministic worktree path is always freed for the next run…
      expect(mockDestroyWorktree).toHaveBeenCalledOnce();
      // …and a forensics failure never denies the terminal event.
      const terminals = events.filter(e => e.kind === 'completed' || e.kind === 'failed');
      expect(terminals).toHaveLength(1);
    });

    it('still emits ONE terminal event when summary.json write throws (persist is best-effort)', async () => {
      // Edge case: a disk failure on writeSummary must not deny the terminal
      // event — the classification is the source of truth and must always reach
      // the consumer.
      setupValidProject('06-webview');
      writeSummarySpy.mockImplementation(() => { throw new Error('ENOSPC: disk full'); });
      const fakeChild = makeFakeChild({ exitCode: 0 });
      mockSpawn.mockReturnValue(fakeChild);

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptorFor('mut-summary-throw'), { bus: null as any, cancel: () => false })) {
        events.push(event);
      }

      const terminals = events.filter(e => e.kind === 'completed' || e.kind === 'failed');
      expect(terminals).toHaveLength(1);
      expect(terminals[0].data.outcome).toBe('noop');
    });
  });

  // -------------------------------------------------------------------------
  // P1.6 — the live failure/partial/cancelled terminal path flows through the
  // shared finalizer (`runFinalizer` in `hold` mode). These are §7 guards at
  // the LIVE surface (test-plan.md §7): a run that classifies `failed` always
  // reaches a single terminal event (never left `running`), always flushes the
  // transcript + writes summary + index (forensics durable on the failure
  // path), never merges/pushes/deletes, and tears down the worktree while
  // RETAINING the branch (no `git branch -d/-D`). The finalizer-module-level
  // guarantees are pinned in work-run-finalizer.test.ts §7; these prove the
  // live apply() path is actually wired through that machine.
  // -------------------------------------------------------------------------
  describe('apply — failure path routed through the finalizer (P1.6)', () => {
    function descriptorFor(id: string) {
      return {
        id,
        kind: 'work-run',
        payload: { projectSlug: '06-webview' },
        status: 'running',
      } as any;
    }

    /** Force a `failed` classification: computeWorkProduct's git throws, so
     *  finalizeWorkRun takes the classification-error → `failed` branch.
     *  Returns the recorded git-arg list — the replaced mockImplementation
     *  bypasses makeGitStub's own `calls` array, so the branch-retention test
     *  asserts against THIS list instead (otherwise the merge/push check would
     *  be vacuous against an always-empty `gitStub.calls`). */
    function makeFailingGit(): string[][] {
      const calls: string[][] = [];
      gitStub.stub.mockImplementation(async (args: string[]) => {
        calls.push([...args]);
        // The commit-poll's `git log` is best-effort (its own try/catch); the
        // classifier's rev-list/diff/status throwing is what drives the failed
        // outcome. Throw for everything so computeWorkProduct rejects.
        throw new Error(`git unavailable: ${args.join(' ')}`);
      });
      return calls;
    }

    it('a failed run yields exactly ONE terminal `failed` event — never left running', async () => {
      setupValidProject('06-webview');
      makeFailingGit();
      mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0 }));

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptorFor('mut-p16-failed'), { bus: null as any, cancel: () => false })) {
        events.push(event);
      }

      const terminals = events.filter(e => e.kind === 'completed' || e.kind === 'failed');
      expect(terminals).toHaveLength(1);
      expect(terminals[0].kind).toBe('failed');
      expect(terminals[0].data.outcome).toBe('failed');
      // The run identity still rides the terminal (finalizer's classify effect
      // augments it) so downstream surfaces can label the run.
      expect(terminals[0].data.projectSlug).toBe('06-webview');
    });

    it('the failure path still flushes the transcript, writes summary.json + the index row', async () => {
      setupValidProject('06-webview');
      makeFailingGit();
      mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0 }));

      for await (const _ of workRunApplier.apply(descriptorFor('mut-p16-durable'), { bus: null as any, cancel: () => false })) {
        // consume
      }

      // Forensics durable on the failure path: transcript flushed, summary +
      // index written with the failed outcome.
      expect(currentSink.finish).toHaveBeenCalledOnce();
      expect(writeSummarySpy).toHaveBeenCalledOnce();
      expect(writeSummarySpy.mock.calls[0]![1].outcome).toBe('failed');
      expect(indexRows).toHaveLength(1);
      expect(indexRows[0]!.row.outcome).toBe('failed');
    });

    it('the failure path tears down the worktree but RETAINS the branch (never merges/deletes)', async () => {
      setupValidProject('06-webview');
      const gitCalls = makeFailingGit();
      mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0 }));

      for await (const _ of workRunApplier.apply(descriptorFor('mut-p16-branch'), { bus: null as any, cancel: () => false })) {
        // consume
      }

      // Worktree torn down (the outer finally owns teardown).
      expect(mockDestroyWorktree).toHaveBeenCalledOnce();
      // git WAS invoked (the classifier's rev-list/diff/status) — but `hold`
      // mode never merges, pushes, or deletes the branch, so none of those args
      // ever reached the runner. Asserting against the recorded calls (not the
      // bypassed gitStub.calls) makes this a real check, not a vacuous one.
      expect(gitCalls.length).toBeGreaterThan(0);
      const branchMutations = gitCalls.filter(args =>
        args.includes('merge') ||
        args.includes('push') ||
        (args.includes('branch') && (args.includes('-d') || args.includes('-D'))),
      );
      expect(branchMutations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 3.5 — live gated-merge activation (test-plan.md §6/§8).
  //
  // These are WRITE-FIRST tests for the gated-merge wiring (tasks.md Phase 3.5
  // "Wiring"). They are RED against the current `hold`-mode live path and turn
  // GREEN once apply() routes a branch-complete terminal through
  // `runFinalizer({ mode: 'gated-merge', baseBranch })` with the real injected
  // effects. The finalizer-module-level gated-merge behavior is already pinned
  // in work-run-finalizer.test.ts; these prove the LIVE work-runner surface is
  // actually wired through that machine.
  //
  // Contract the wiring tasks implement (so these tests author the seam):
  //   - baseBranch is read from `getProductConfig(product, …).baseBranch`.
  //   - mode is `gated-merge` for a branch-complete outcome (runGatedMerge holds
  //     every other outcome, so non-branch-complete runs never merge).
  //   - gate effect = `() => withBaseBranchLock(product, baseBranch, () =>
  //     runGate({…}))` — the lock wraps the gate (req 14).
  //   - merge/push/delete effects = decomposed `realMergeBranch` git steps run
  //     through `deps.runGit` (so they are observable here), push BEFORE delete.
  //   - removeWorktree (real) owns teardown and sets a `finalizerOwnedTeardown`
  //     flag so the outer `finally` does NOT double-destroy the worktree.
  //   - recordPhase/readLastPhase are backed by the durable per-run phase store
  //     seam (`deps.recordWorkRunPhase` / `deps.readLastWorkRunPhase`) that P0.4
  //     recovery reads to resume mid-gated-merge.
  // -------------------------------------------------------------------------
  describe('apply — branch-complete routed through the gated-merge finalizer (Phase 3.5)', () => {
    function descriptorFor(id: string, product?: string) {
      return {
        id,
        kind: 'work-run',
        payload: { projectSlug: '06-webview', ...(product ? { product } : {}) },
        status: 'running',
      } as any;
    }

    /** Set up a `branch-complete` classification: a commit on the branch
     *  (rev-list returns a sha), a clean tree (status empty), and all baseline
     *  tasks checked (tasksRemaining 0). Returns a fresh RECORDING git stub
     *  injected as the runtime `runGit` — the gated-merge wiring routes
     *  merge/push/delete through `deps.runGit`, so those land in `gitCalls`
     *  here — plus phase-store spies injected through the seam.
     *
     *  Layering note: must be called AFTER `beforeEach` has injected the base
     *  runtime deps — it overlays only `runGit` + the phase-store spies onto the
     *  beforeEach-injected object (the merge-partial seam), leaving
     *  writeSummary/appendIndexRow/createSink/runForensics in place. */
    function setupBranchComplete() {
      setupValidProject('06-webview');
      // Override tasks.md (baseline read at spawn AND final read post-run) to
      // all-checked so `tasksRemaining` is 0 → with a commit → branch-complete.
      const liveTasks = join(PROJECTS_DIR, '06-webview', 'tasks.md');
      const wtTasks = join(FAKE_WORKTREE, 'docs', 'projects', '06-webview', 'tasks.md');
      mockReadFileSync.mockImplementation((p: string) => {
        if (p.endsWith('spec.md')) return '# Spec\n\nDo something.';
        if (p === liveTasks || p === wtTasks) return '## Phase A\n\n- [x] Task 1\n- [x] Task 2\n';
        return '';
      });
      const gitCalls: string[][] = [];
      const stub = vi.fn(async (args: string[]) => {
        gitCalls.push([...args]);
        // A commit on the branch for the classifier; every other git arg
        // (status/diff/merge/push/branch -d) returns success and is recorded.
        if (args.some(a => a.includes('rev-list'))) return { stdout: 'abc123def456\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const recordWorkRunPhase = vi.fn();
      const readLastWorkRunPhase = vi.fn(() => null);
      __setWorkRunRuntimeForTest({
        runGit: stub as never,
        recordWorkRunPhase: recordWorkRunPhase as never,
        readLastWorkRunPhase: readLastWorkRunPhase as never,
      });
      return { gitCalls, stub, recordWorkRunPhase, readLastWorkRunPhase };
    }

    it('routes a branch-complete terminal through runFinalizer({ mode: "gated-merge", baseBranch }) (RED until wiring)', async () => {
      setupBranchComplete();
      mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0 }));

      for await (const _ of workRunApplier.apply(descriptorFor('mut-gm-mode'), { bus: null as any, cancel: () => false })) {
        // consume
      }

      expect(finalizerHarness.runFinalizerSpy).toHaveBeenCalled();
      const input = finalizerHarness.runFinalizerSpy.mock.calls.at(-1)![0];
      // Currently `hold` → RED; the wiring flips a branch-complete run to gated-merge.
      expect(input.mode).toBe('gated-merge');
      // baseBranch sourced from getProductConfig(product).baseBranch.
      expect(input.baseBranch).toBe('main');
    });

    it('tears the worktree down exactly once — the finalizer owns teardown, the outer finally does not double-destroy', async () => {
      setupBranchComplete();
      mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0 }));

      for await (const _ of workRunApplier.apply(descriptorFor('mut-gm-teardown'), { bus: null as any, cancel: () => false })) {
        // consume
      }

      // A single teardown via the `finalizerOwnedTeardown` guard: green now (hold
      // mode: outer-finally-only) and must STAY a single destroy after the wiring
      // moves teardown ownership into the finalizer's removeWorktree effect.
      expect(mockDestroyWorktree).toHaveBeenCalledTimes(1);
    });

    it('constructs the gate effect as runGate wrapped in withBaseBranchLock(product, baseBranch) (RED until wiring)', async () => {
      setupBranchComplete();
      mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0 }));

      for await (const _ of workRunApplier.apply(descriptorFor('mut-gm-gate'), { bus: null as any, cancel: () => false })) {
        // consume
      }

      const effects = finalizerHarness.runFinalizerSpy.mock.calls.at(-1)![1];
      // Hold mode leaves the gated-merge effects undefined → RED.
      expect(typeof effects.gate).toBe('function');
      // The real gated-merge finalizer the wiring routes through invokes the gate
      // effect, which acquires the per-product/per-base-branch lock and runs the
      // gate inside it.
      expect(mockWithBaseBranchLock).toHaveBeenCalledWith('jarvis', 'main', expect.any(Function));
      expect(mockRunGate).toHaveBeenCalled();
    });

    it('merges, pushes, then deletes the branch — push BEFORE delete (decomposed realMergeBranch git steps) (RED until wiring)', async () => {
      const { gitCalls } = setupBranchComplete();
      mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0 }));

      for await (const _ of workRunApplier.apply(descriptorFor('mut-gm-merge'), { bus: null as any, cancel: () => false })) {
        // consume
      }

      // Decomposed effects: merge/push/delete are SEPARATE FinalizerEffects
      // functions (not one combined step), so push-before-delete crash-resume
      // holds. Hold mode leaves them undefined → RED.
      const effects = finalizerHarness.runFinalizerSpy.mock.calls.at(-1)![1];
      expect(typeof effects.mergeBranch).toBe('function');
      expect(typeof effects.pushBranch).toBe('function');
      expect(typeof effects.deleteBranch).toBe('function');

      const mergeIdx = gitCalls.findIndex(a => a.includes('merge'));
      const pushIdx = gitCalls.findIndex(a => a.includes('push'));
      const deleteIdx = gitCalls.findIndex(
        a => a.includes('branch') && (a.includes('-d') || a.includes('-D')),
      );
      // Hold mode never merges/pushes/deletes → all -1 → RED.
      expect(mergeIdx).toBeGreaterThanOrEqual(0);
      expect(pushIdx).toBeGreaterThanOrEqual(0);
      expect(deleteIdx).toBeGreaterThanOrEqual(0);
      // Ordering: merge → push → delete (push before delete: origin is the
      // durable backup before the local branch ref is removed).
      expect(mergeIdx).toBeLessThan(pushIdx);
      expect(pushIdx).toBeLessThan(deleteIdx);
    });

    it('stamps the merged disposition onto the terminal event + re-writes summary.json (Phase 3.5 notification)', async () => {
      setupBranchComplete();
      mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0 }));

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptorFor('mut-gm-notify'), { bus: null as any, cancel: () => false })) {
        events.push(event);
      }

      const terminal = events.find(e => e.kind === 'completed' || e.kind === 'failed');
      // The disposition reaches the operator notification surface.
      expect(terminal.data.outcome).toBe('branch-complete');
      expect(terminal.data.merged).toBe(true);
      expect(terminal.data.branchDeleted).toBe(true);
      // summary.json was re-written post-finalize with the resolved disposition
      // (the LAST writeSummary call carries merged/branchDeleted).
      const lastSummary = writeSummarySpy.mock.calls.at(-1)![1];
      expect(lastSummary.merged).toBe(true);
      expect(lastSummary.branchDeleted).toBe(true);
    });

    it('surfaces the gate-held reason on the terminal event when the gate refuses (never a silent drop)', async () => {
      setupBranchComplete();
      // Gate refuses → run holds at branch-complete, never merges.
      mockRunGate.mockResolvedValueOnce({ ok: false, reason: 'tests-red' });
      mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0 }));

      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptorFor('mut-gm-held'), { bus: null as any, cancel: () => false })) {
        events.push(event);
      }

      const terminal = events.find(e => e.kind === 'completed' || e.kind === 'failed');
      expect(terminal.data.outcome).toBe('branch-complete');
      expect(terminal.data.merged).toBe(false);
      expect(terminal.data.gateHeldReason).toBe('tests-red');
    });

    it('records finalizer phases to the durable per-run phase store and reads the last phase from it (RED until wiring)', async () => {
      const { recordWorkRunPhase, readLastWorkRunPhase } = setupBranchComplete();
      mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0 }));

      for await (const _ of workRunApplier.apply(descriptorFor('mut-gm-phases'), { bus: null as any, cancel: () => false })) {
        // consume
      }

      // Live hold path passes a no-op recordPhase/readLastPhase → the durable
      // store is never touched → RED. After wiring, the effects are backed by the
      // per-run phase store seam, keyed by the run id so recovery reads the same
      // run's phases for a mid-gated-merge resume.
      expect(recordWorkRunPhase).toHaveBeenCalled();
      expect(recordWorkRunPhase.mock.calls.every(c => c[0] === 'mut-gm-phases')).toBe(true);
      // The right phases reach the store, not just "something" — `classified`
      // (prologue) and `merged-not-pushed` (the push-before-delete checkpoint a
      // mid-merge crash resumes from).
      const phases = recordWorkRunPhase.mock.calls.map(c => c[1]);
      expect(phases).toEqual(expect.arrayContaining(['classified', 'merged-not-pushed']));
      expect(readLastWorkRunPhase).toHaveBeenCalledWith('mut-gm-phases');
    });

    // -----------------------------------------------------------------------
    // Phase 4 (P2.8) — full incident replay for d0679453 (test-plan §8): the
    // 2026-06-06 wedge, now self-healing end-to-end. The agent emits a terminal
    // `result: success` and then NEVER exits (the hung background-vitest tasks);
    // the watchdog drains, group-reaps (SIGTERM), stamps
    // `reaped-after-terminal-result`; the classifier reads the clean+complete
    // branch as branch-complete (NOT failed-on-signal, the original mis-class);
    // the gate passes; the run merges to main and reaches a `merged` terminal —
    // with no human in the loop. A standing guard against the whole six-defect
    // chain regressing.
    // -----------------------------------------------------------------------
    it('d0679453 replay: result → child never exits → reap → branch-complete → gate green → merged, no human', async () => {
      vi.useFakeTimers();
      let child: any;
      let consume: Promise<void> | undefined;
      try {
        const { gitCalls } = setupBranchComplete();
        // Manual child: emits the terminal `result` then NEVER exits/closes
        // (the incident's hung background tasks held the stdio pipes open).
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        child = new EventEmitter() as any;
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = vi.fn();
        child.pid = 12345;
        const killSpy = vi.fn();
        __setKillProcessTreeForTest(killSpy);
        mockSpawn.mockReturnValue(child);

        const events: any[] = [];
        let finished = false;
        consume = (async () => {
          for await (const e of workRunApplier.apply(descriptorFor('mut-incident-d0679453'), { bus: null as any, cancel: () => false })) {
            events.push(e);
          }
          finished = true;
        })().catch(() => { /* should not reject; finished stays false if it does */ });

        await vi.advanceTimersByTimeAsync(0);
        // Agent declares success — then the process wedges (no exit/close).
        stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\n'));
        // Advance past the drain window + SIGKILL grace + force-done ceiling so
        // the watchdog reaps and the finalize chain runs to completion.
        await vi.advanceTimersByTimeAsync(60_000);

        // No human acted: the run self-completed.
        expect(finished).toBe(true);
        expect(killSpy).toHaveBeenCalledWith(child, 'SIGTERM');

        const terminal = events.find((e) => e.kind === 'completed' || e.kind === 'failed');
        expect(terminal).toBeDefined();
        // The reap is stamped as an internal post-result reap, NOT an external
        // kill — the original incident's mis-classification fix.
        expect(terminal!.data.exit?.exitFact).toBe('reaped-after-terminal-result');
        // Classified on work product as branch-complete (NOT failed exit-143),
        // and the gate-passing run LANDED on main with no human merge.
        expect(terminal!.kind).toBe('completed');
        expect(terminal!.data.outcome).toBe('branch-complete');
        expect(terminal!.data.merged).toBe(true);
        // The merge actually ran (merge → push → delete via the product repo).
        expect(gitCalls.some(a => a.includes('merge') && !a.includes('merge-base'))).toBe(true);
        expect(gitCalls.some(a => a.includes('push'))).toBe(true);
      } finally {
        try { child?.emit('close', null, 'SIGKILL'); } catch { /* already closed */ }
        await consume;
        vi.useRealTimers();
        __resetKillProcessTreeForTest();
      }
    });
  });
});
