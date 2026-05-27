import { describe, it, expect, vi, beforeEach } from 'vitest';
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
// lifecycle (`src/jobs/sandbox-runtime.ts`).
const mockCreateWorktree = vi.fn();
const mockDestroyWorktree = vi.fn();
vi.mock('./sandbox-runtime.js', () => ({
  createWorktree: mockCreateWorktree,
  destroyWorktree: mockDestroyWorktree,
}));

const FAKE_WORKTREE = '/test/worktrees/jarvis/06-webview';
function fakeSandboxSpec(overrides: Record<string, unknown> = {}) {
  return {
    product: 'jarvis',
    project: '06-webview',
    worktree: FAKE_WORKTREE,
    egressAllowlist: [],
    ...overrides,
  };
}

// --- Dynamic imports after mocks ---

const { workRunApplier } = await import('./work-runner.js');

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

    it('buffers stdout lines into output events', async () => {
      setupValidProject('06-webview');
      const fakeChild = makeFakeChild({ exitCode: 0, stdoutLines: ['line one', 'line two'] });
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

      const outputEvents = events.filter(e => e.kind === 'output');
      const lines = outputEvents.map(e => e.data.line);
      expect(lines).toContain('line one');
      expect(lines).toContain('line two');
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
});
