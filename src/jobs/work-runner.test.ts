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
    WORKSPACE_DIR: undefined,
    TELEGRAM_USER_ID: 42,
    // Used by productionRuntimeDeps() (the seam __resetWorkRunRuntimeForTest
    // restores between tests) so the restored object has a defined dir even
    // though every test re-injects its own via __setWorkRunRuntimeForTest.
    WORK_RUNS_DIR: '/tmp/test-work-runs',
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

// Mock sandbox-runtime: createWorktree/destroyWorktree return controllable
// stubs. Tests assert on call args; production wires the real git worktree
// lifecycle (`src/jobs/sandbox-runtime.ts`). `defaultRunGit` is exported by the
// real module and reused by work-runner's production deps — the mock provides a
// no-op stand-in so a missing export can't crash module-eval (tests inject
// their own git runner via the runtime seam regardless).
const mockCreateWorktree = vi.fn();
const mockDestroyWorktree = vi.fn();
vi.mock('./sandbox-runtime.js', () => ({
  createWorktree: mockCreateWorktree,
  destroyWorktree: mockDestroyWorktree,
  defaultRunGit: vi.fn(async () => ({ stdout: '', stderr: '' })),
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
  });

  afterEach(() => {
    __resetWorkRunRuntimeForTest();
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

    it('calls createWorktree with product=jarvis, project=slug, branch=jarvis-work/<short-id>', async () => {
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
      // Deterministic per-mutation branch — `jarvis-work/<first 8 of id>`.
      // Parallels gen-eval-loop's `jarvis-gen-eval/<short-id>` convention.
      expect(callArgs.branch).toBe('jarvis-work/abcdef12');
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
      expect(opts.branch).toBe('jarvis-work/mut-fore'); // first 8 of 'mut-forensics'
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
});
