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

/** Set up the fs mocks so findProjectDir("06-webview") succeeds */
function setupValidProject(slug: string = '06-webview') {
  const dirName = slug;
  const dir = join(PROJECTS_DIR, dirName);

  mockReaddirSync.mockReturnValue([dirName]);
  mockStatSync.mockImplementation((p: string) => {
    if (p === join(PROJECTS_DIR, dirName)) {
      return { isDirectory: () => true };
    }
    return { isDirectory: () => false, mtimeMs: Date.now() };
  });
  mockExistsSync.mockImplementation((p: string) => {
    return p === join(dir, 'spec.md') || p === join(dir, 'tasks.md');
  });
  mockReadFileSync.mockImplementation((p: string) => {
    if (p === join(dir, 'spec.md')) return '# Spec\n\nDo something.';
    if (p === join(dir, 'tasks.md')) return '## Phase A\n\n- [x] Task 1\n- [ ] Task 2\n';
    return '';
  });

  return { dir, dirName };
}

// --- Tests ---

describe('workRunApplier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveRuns.clear();
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
    it('spawns claude with --add-dir containing the project dir name suffix', async () => {
      const { dirName } = setupValidProject('06-webview');
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

      // Consume all events from the generator
      const events: any[] = [];
      for await (const event of workRunApplier.apply(descriptor, ctx)) {
        events.push(event);
      }

      expect(mockSpawn).toHaveBeenCalledOnce();
      const [bin, args, spawnOpts] = mockSpawn.mock.calls[0]!;

      // claude binary was resolved
      expect(typeof bin).toBe('string');

      // --add-dir arg present and points into docs/projects/<dirName>
      const addDirIdx = args.indexOf('--add-dir');
      expect(addDirIdx).toBeGreaterThanOrEqual(0);
      const addDirValue: string = args[addDirIdx + 1];
      expect(addDirValue).toContain(dirName);

      // cwd is PROJECT_ROOT
      expect(spawnOpts.cwd).toBe(TEST_PROJECT_ROOT);
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
