/**
 * Phase 8 (live execution binding) — execution-agent diff-capture tests.
 *
 * The execution-agent primitive is the production artifact-role session
 * (coder, QA test authoring): a tool-using, worktree-scoped run that takes a
 * task prompt plus the resolved model and returns the captured `git diff`.
 * These tests drive it against a controlled temp git worktree with an
 * INJECTED agent spawn — no live model call:
 *
 *   - an agent that edits the worktree → the exact `git diff` comes back
 *     (including NEW files, which requires the stage-then-diff capture)
 *   - a no-op agent → empty diff
 *   - a spawn/tool error → structured `{ok:false}` failure, never an
 *     unhandled throw
 *
 * See tasks.md Phase 8 "Execution-agent diff-capture test".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runExecutionAgent,
  type ExecutionAgentIO,
  type ExecutionAgentOpts,
} from './execution-agent.js';
import type { RoleModelBinding } from './team-task-deps.js';
import type { SandboxSpec } from '../intent/sandbox.js';

const {
  mockSpawn,
  mockRegisterActiveProcess,
  mockUnregisterActiveProcess,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockRegisterActiveProcess: vi.fn(),
  mockUnregisterActiveProcess: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: mockSpawn,
  };
});

vi.mock('../ai/claude.js', () => ({
  CLAUDE_BIN: '/usr/local/bin/claude',
  getProjectMcpArgs: () => [
    '--strict-mcp-config',
    '--mcp-config',
    '/tmp/test-project/.claude/settings.json',
  ],
  registerActiveProcess: mockRegisterActiveProcess,
  unregisterActiveProcess: mockUnregisterActiveProcess,
}));

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/test-jarvis',
  default: {
    CLAUDE_TIMEOUT_MS: 5_000,
    WORK_RUN_REAP_GRACE_MS: 100,
  },
}));

// ---------------------------------------------------------------------------
// Temp git worktree fixture
// ---------------------------------------------------------------------------

let repoDir: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeEach(() => {
  mockSpawn.mockReset();
  mockRegisterActiveProcess.mockReset();
  mockUnregisterActiveProcess.mockReset();
  repoDir = mkdtempSync(join(tmpdir(), 'exec-agent-'));
  git(['init', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'test@test.local'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  writeFileSync(join(repoDir, 'README.md'), '# fixture\n', 'utf8');
  git(['add', '-A'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

function makeSandbox(): SandboxSpec {
  return {
    product: 'jarvis',
    project: 'demo',
    worktree: repoDir,
    egressAllowlist: [],
    resumed: false,
  } as SandboxSpec;
}

const coderModel: RoleModelBinding = { alias: 'gpt-5.5', provider: 'openai', format: 'codex' };
const claudeModel: RoleModelBinding = { alias: 'opus', provider: 'anthropic', format: 'claude' };

function makeOpts(overrides: Partial<ExecutionAgentOpts> = {}): ExecutionAgentOpts {
  return {
    prompt: 'implement the selected task',
    sandbox: makeSandbox(),
    model: coderModel,
    productsConfigPath: '/nonexistent/products.json',
    timeoutMs: 5_000,
    ...overrides,
  };
}

/** Injected IO: fake agent spawn + fake env builder; real git via the default
 *  runGit (the primitive's own git capture is what's under test). */
function makeIo(
  spawnAgent: ExecutionAgentIO['spawnAgent'],
): Partial<ExecutionAgentIO> {
  return {
    spawnAgent,
    buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
  };
}

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

  setTimeout(() => {
    for (const line of stdoutLines) {
      stdout.emit('data', Buffer.from(`${line}\n`, 'utf8'));
    }
    for (const line of stderrLines) {
      stderr.emit('data', Buffer.from(`${line}\n`, 'utf8'));
    }
    child.emit('close', exitCode, exitSignal);
  }, 0);

  return child;
}

function makeControlledChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as any;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

// ---------------------------------------------------------------------------
// Diff capture
// ---------------------------------------------------------------------------

describe('runExecutionAgent — diff capture (Phase 8)', () => {
  it('applies the agent edits and returns the exact git diff, including new files', async () => {
    const seen: Array<{ alias: string; format: string; cwd: string }> = [];
    const io = makeIo(async ({ model, cwd }) => {
      seen.push({ alias: model.alias, format: model.format, cwd });
      // The "agent" creates a NEW file (untracked) and edits a tracked one —
      // both must appear in the captured diff.
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src', 'new-file.ts'), 'export const ANSWER = 42;\n', 'utf8');
      writeFileSync(join(cwd, 'README.md'), '# fixture\n\nedited by agent\n', 'utf8');
      return { output: 'task implemented', error: null };
    });

    const result = await runExecutionAgent(makeOpts(), io);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // New file is in the diff (requires stage-then-diff, not bare `git diff`).
    expect(result.diff).toContain('src/new-file.ts');
    expect(result.diff).toContain('export const ANSWER = 42;');
    // Tracked-file edit is in the diff too.
    expect(result.diff).toContain('edited by agent');
    // The agent's textual output rides along for the QA-result parse.
    expect(result.output).toBe('task implemented');
    // The spawn received the resolved model + the worktree as cwd.
    expect(seen).toEqual([{ alias: 'gpt-5.5', format: 'codex', cwd: repoDir }]);
  });

  it('returns an empty diff for a no-op task', async () => {
    const io = makeIo(async () => ({ output: 'nothing to do', error: null }));

    const result = await runExecutionAgent(makeOpts(), io);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diff).toBe('');
    expect(result.output).toBe('nothing to do');
  });

  it('maps a rejected agent spawn to structured failed evidence, never an unhandled throw', async () => {
    const io = makeIo(async () => {
      throw new Error('spawn ENOENT: codex binary missing');
    });

    const result = await runExecutionAgent(makeOpts(), io);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('spawn ENOENT');
  });

  it('maps an agent-reported error to structured failed evidence', async () => {
    const io = makeIo(async () => ({ output: 'partial output', error: 'agent exited with code 1' }));

    const result = await runExecutionAgent(makeOpts(), io);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('agent exited with code 1');
  });

  it('surfaces a git-capture failure as structured failure (worktree is not a repo)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-agent-norepo-'));
    try {
      const io = makeIo(async () => ({ output: 'done', error: null }));
      const opts = makeOpts({
        sandbox: { ...makeSandbox(), worktree: dir } as SandboxSpec,
      });

      const result = await runExecutionAgent(opts, io);

      expect(result.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Per-session incremental activity callback
// ---------------------------------------------------------------------------

describe('runExecutionAgent — IO activity callback (Phase 10)', () => {
  it('wires ExecutionAgentIO.onActivity into the live per-session emit callback', async () => {
    const events: Array<{ kind: 'activity' | 'output'; data?: { line?: string } }> = [];
    let sawLiveEmitBeforeReturn = false;
    const io = {
      ...makeIo(async ({ emit }) => {
        emit?.({ kind: 'output', data: { line: 'qa test authoring started' } });
        emit?.({ kind: 'activity' });
        sawLiveEmitBeforeReturn = events.length === 2;
        return { output: 'tests authored', error: null };
      }),
      onActivity: (event: { kind: 'activity' | 'output'; data?: { line?: string } }) => {
        events.push(event);
      },
    } as Partial<ExecutionAgentIO> & {
      onActivity: (event: { kind: 'activity' | 'output'; data?: { line?: string } }) => void;
    };

    const result = await runExecutionAgent(makeOpts(), io);

    expect(result.ok).toBe(true);
    expect(sawLiveEmitBeforeReturn).toBe(true);
    expect(events).toEqual([
      { kind: 'output', data: { line: 'qa test authoring started' } },
      { kind: 'activity' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Claude artifact stream forwarding
// ---------------------------------------------------------------------------

describe('runExecutionAgent — Claude stream-json forwarding (Phase 10)', () => {
  it('spawns Claude in stream-json mode and forwards envelopes as output/activity events', async () => {
    const envelopes = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'visible progress' }] },
      }),
      JSON.stringify({ type: 'system', subtype: 'task_progress', parent_tool_use_id: 'toolu_sub' }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'ok', tool_use_id: 'toolu_x' }],
        },
      }),
      JSON.stringify({ type: 'result', result: 'finished cleanly' }),
    ];
    mockSpawn.mockReturnValue(makeFakeChild({ exitCode: 0, stdoutLines: envelopes }));

    const events: Array<{ kind: 'activity' | 'output'; data?: { line?: string } }> = [];
    const opts = {
      ...makeOpts({ model: claudeModel }),
      emit: (event: { kind: 'activity' | 'output'; data?: { line?: string } }) => {
        events.push(event);
      },
    };

    const result = await runExecutionAgent(opts, {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
    });

    expect(result.ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, spawnArgs] = mockSpawn.mock.calls[0]!;
    expect(spawnArgs).toContain('--output-format');
    expect(spawnArgs[(spawnArgs as string[]).indexOf('--output-format') + 1]).toBe('stream-json');
    expect(spawnArgs).toContain('--verbose');

    expect(events).toEqual([
      { kind: 'output', data: { line: 'visible progress' } },
      { kind: 'activity' },
      { kind: 'activity' },
      { kind: 'output', data: { line: 'finished cleanly' } },
    ]);
    expect(events.some((event) => event.data?.line?.includes('"type":"assistant"'))).toBe(false);
  });

  it('streams Claude display events before close and flushes a trailing partial envelope on close', async () => {
    const child = makeControlledChild();
    mockSpawn.mockReturnValue(child);

    const events: Array<{ kind: 'activity' | 'output'; data?: { line?: string } }> = [];
    const pending = runExecutionAgent({
      ...makeOpts({ model: claudeModel }),
      emit: (event) => events.push(event),
    }, {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
    });

    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'first live line' }] },
    })}\n`, 'utf8'));

    expect(events).toEqual([
      { kind: 'output', data: { line: 'first live line' } },
    ]);

    child.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'result',
      result: 'final line without newline',
    }), 'utf8'));
    expect(events).toHaveLength(1);

    child.emit('close', 0, null);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(events).toEqual([
      { kind: 'output', data: { line: 'first live line' } },
      { kind: 'output', data: { line: 'final line without newline' } },
    ]);
  });
});
