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
  mockRunCodex,
  mockRegisterActiveProcess,
  mockUnregisterActiveProcess,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockRunCodex: vi.fn(),
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

vi.mock('../ai/codex.js', () => ({
  runCodex: mockRunCodex,
}));

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/test-rune',
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
  mockRunCodex.mockReset();
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
    product: 'rune',
    project: 'demo',
    worktree: repoDir,
    egressAllowlist: [],
    resumed: false,
  } as SandboxSpec;
}

const coderModel: RoleModelBinding = { alias: 'gpt-5.6-sol', provider: 'openai', format: 'codex' };
const claudeModel: RoleModelBinding = { alias: 'opus', provider: 'anthropic', format: 'claude' };
const protectedServiceRuntimePrompt = [
  '## Protected Localhost Services',
  '',
  'Never kill, never stop, never interrupt, and never reuse either protected listener without explicit human approval.',
  '- Rune web / cockpit at 127.0.0.1:3847 (launchd label com.jarvis.daemon)',
  '- Rune MCP daemon at 127.0.0.1:3848 (launchd label com.jarvis.rune-mcp)',
  'Before killing any process, verify the PID was spawned by the current task/worktree/test command.',
].join('\n');

function makeOpts(overrides: Partial<ExecutionAgentOpts> = {}): ExecutionAgentOpts {
  return {
    prompt: 'implement the selected task',
    sandbox: makeSandbox(),
    model: coderModel,
    role: 'tech-lead',
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
    buildArtifactMcp: () => null,
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
// Codex JSON event forwarding
// ---------------------------------------------------------------------------

describe('runExecutionAgent — Codex JSON event forwarding', () => {
  it('surfaces item.completed agent_message text as output and keeps lifecycle events as activity', async () => {
    mockRunCodex.mockImplementation(async (
      _prompt: string,
      opts: { onEvent: (event: Record<string, unknown>) => void },
    ) => {
      opts.onEvent({ type: 'thread.started' });
      opts.onEvent({ type: 'turn.started' });
      opts.onEvent({
        type: 'item.completed',
        item: { type: 'reasoning', text: 'hidden chain of thought' },
      });
      opts.onEvent({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'No code changes were needed; tests already cover it.',
        },
      });
      opts.onEvent({ type: 'turn.completed', delta: 'hidden lifecycle marker' });
      return { text: 'raw json stdout fallback', error: null, exitCode: 0 };
    });

    const events: Array<{ kind: 'activity' | 'output'; data?: { line?: string } }> = [];
    const result = await runExecutionAgent({
      ...makeOpts(),
      emit: (event) => events.push(event),
    }, {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diff).toBe('');
    expect(result.output).toBe('No code changes were needed; tests already cover it.');

    const outputLines = events
      .filter((event) => event.kind === 'output')
      .map((event) => event.data?.line ?? '');
    const transcript = outputLines.join('\n');
    expect(outputLines).toEqual(['No code changes were needed; tests already cover it.']);
    expect(transcript).not.toContain('codex thread.started');
    expect(transcript).not.toContain('codex turn.started');
    expect(transcript).not.toContain('codex item.completed');
    expect(transcript).not.toContain('hidden chain of thought');
    expect(transcript).not.toContain('hidden lifecycle marker');
    expect(events.filter((event) => event.kind === 'activity')).toHaveLength(4);
  });

  it('keeps malformed Codex raw stdout reviewable as output', async () => {
    mockRunCodex.mockImplementation(async (
      _prompt: string,
      opts: { onEvent: (event: Record<string, unknown>) => void },
    ) => {
      opts.onEvent({ type: 'raw', line: 'not-json private/file.md' });
      return { text: 'not-json private/file.md', error: null, exitCode: 0 };
    });

    const events: Array<{ kind: 'activity' | 'output'; data?: { line?: string } }> = [];
    const result = await runExecutionAgent({
      ...makeOpts(),
      emit: (event) => events.push(event),
    }, {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toBe('not-json private/file.md');
    expect(events).toEqual([
      { kind: 'output', data: { line: 'not-json private/file.md' } },
    ]);
  });

  it('treats unknown Codex envelopes without display text as activity only', async () => {
    mockRunCodex.mockImplementation(async (
      _prompt: string,
      opts: { onEvent: (event: Record<string, unknown>) => void },
    ) => {
      opts.onEvent({ type: 'experimental.metric', count: 1 });
      return { text: '{"type":"experimental.metric","count":1}', error: null, exitCode: 0 };
    });

    const events: Array<{ kind: 'activity' | 'output'; data?: { line?: string } }> = [];
    const result = await runExecutionAgent({
      ...makeOpts(),
      emit: (event) => events.push(event),
    }, {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toBe('');
    expect(events).toEqual([{ kind: 'activity' }]);
    expect(events.some((event) => event.data?.line?.includes('codex experimental.metric'))).toBe(false);
  });

  it('does not fall back to raw JSON stdout when structured events have no displayable prose', async () => {
    mockRunCodex.mockImplementation(async (
      _prompt: string,
      opts: { onEvent: (event: Record<string, unknown>) => void },
    ) => {
      opts.onEvent({ type: 'thread.started' });
      opts.onEvent({
        type: 'item.completed',
        item: { type: 'reasoning', text: 'hidden chain of thought /tmp/secret' },
      });
      return {
        text: [
          '{"type":"thread.started"}',
          '{"type":"item.completed","item":{"type":"reasoning","text":"hidden chain of thought /tmp/secret"}}',
        ].join('\n'),
        error: null,
        exitCode: 0,
      };
    });

    const events: Array<{ kind: 'activity' | 'output'; data?: { line?: string } }> = [];
    const result = await runExecutionAgent({
      ...makeOpts(),
      emit: (event) => events.push(event),
    }, {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toBe('');
    expect(events).toEqual([
      { kind: 'activity' },
      { kind: 'activity' },
    ]);
  });

  it('sanitizes the no-event Codex text fallback', async () => {
    mockRunCodex.mockResolvedValue({
      text: 'legacy stdout from /tmp/test-rune/private/file.md',
      error: null,
      exitCode: 0,
    });

    const result = await runExecutionAgent(makeOpts(), {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toBe('legacy stdout from private/file.md');
  });
});

// ---------------------------------------------------------------------------
// Protected-service runtime prompt transport
// ---------------------------------------------------------------------------

describe('runExecutionAgent — protected-service runtime prompt transport', () => {
  it('carries the protected-service invariant into Codex executor prompts by prepending the system prompt', async () => {
    let capturedPrompt = '';
    mockRunCodex.mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return { text: 'no changes needed', error: null, exitCode: 0 };
    });

    const result = await runExecutionAgent({
      ...makeOpts({
        prompt: '## Task\n\nWrite only the tests for the selected task.',
        systemPrompt: protectedServiceRuntimePrompt,
        model: coderModel,
      }),
    }, {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
    });

    expect(result.ok).toBe(true);
    expect(capturedPrompt).toContain('Rune web / cockpit at 127.0.0.1:3847');
    expect(capturedPrompt).toContain('com.jarvis.daemon');
    expect(capturedPrompt).toContain('Rune MCP daemon at 127.0.0.1:3848');
    expect(capturedPrompt).toContain('com.jarvis.rune-mcp');
    expect(capturedPrompt).toMatch(/Never kill[\s\S]*never stop[\s\S]*never interrupt[\s\S]*never reuse/i);
    expect(capturedPrompt).toContain('explicit human approval');
    expect(capturedPrompt).toContain('spawned by the current task/worktree/test command');
    expect(capturedPrompt.startsWith(`${protectedServiceRuntimePrompt}\n\n## Task`)).toBe(true);
  });

  it('carries the protected-service invariant into Claude executor prompts via append-system-prompt', async () => {
    mockSpawn.mockReturnValue(makeFakeChild({
      stdoutLines: [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'No implementation changes.' }] },
        }),
      ],
    }));

    const result = await runExecutionAgent({
      ...makeOpts({
        prompt: '## Task\n\nImplement the selected task.',
        systemPrompt: protectedServiceRuntimePrompt,
        model: claudeModel,
      }),
    }, {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
    });

    expect(result.ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const systemPromptIndex = args.indexOf('--append-system-prompt');
    const userPromptIndex = args.indexOf('-p');

    expect(systemPromptIndex).toBeGreaterThan(-1);
    expect(args[systemPromptIndex + 1]).toContain('Rune web / cockpit at 127.0.0.1:3847');
    expect(args[systemPromptIndex + 1]).toContain('com.jarvis.daemon');
    expect(args[systemPromptIndex + 1]).toContain('Rune MCP daemon at 127.0.0.1:3848');
    expect(args[systemPromptIndex + 1]).toContain('com.jarvis.rune-mcp');
    expect(args[systemPromptIndex + 1]).toMatch(
      /Never kill[\s\S]*never stop[\s\S]*never interrupt[\s\S]*never reuse/i,
    );
    expect(args[systemPromptIndex + 1]).toContain('explicit human approval');
    expect(args[systemPromptIndex + 1]).toContain(
      'spawned by the current task/worktree/test command',
    );
    expect(userPromptIndex).toBeGreaterThan(-1);
    expect(args[userPromptIndex + 1]).toBe('## Task\n\nImplement the selected task.');
    expect(args[userPromptIndex + 1]).not.toContain('127.0.0.1:3847');
    expect(args[userPromptIndex + 1]).not.toContain('127.0.0.1:3848');
  });
});

describe('runExecutionAgent — artifact MCP boundary', () => {
  const artifactMcp = {
    claudeArgs: ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{"rune-kb":{}}}'],
    codexConfigOverrides: ['mcp_servers={"rune-kb"={command="/usr/bin/node"}}'],
    sandboxProfilePath: '/tmp/artifact.sb',
    stop: vi.fn(async () => {}),
  };

  it('passes the complete MCP override to Codex without adding vault paths to the prompt', async () => {
    let capturedPrompt = '';
    mockRunCodex.mockImplementation(async (prompt: string) => {
      capturedPrompt = prompt;
      return { text: 'done', error: null, exitCode: 0 };
    });
    const result = await runExecutionAgent(makeOpts({ role: 'coder' }), {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
      buildArtifactMcp: () => artifactMcp,
    });

    expect(result.ok).toBe(true);
    expect(mockRunCodex.mock.calls[0]![1]).toMatchObject({
      configOverrides: artifactMcp.codexConfigOverrides,
      ignoreUserConfig: true,
      sandboxProfilePath: artifactMcp.sandboxProfilePath,
    });
    expect(capturedPrompt).toBe('implement the selected task');
    expect(capturedPrompt).not.toContain('pkms');
  });

  it('replaces Claude project MCP args with the strict artifact config', async () => {
    mockSpawn.mockReturnValue(makeFakeChild());
    const result = await runExecutionAgent(makeOpts({ model: claudeModel, role: 'coder' }), {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
      buildArtifactMcp: () => artifactMcp,
    });

    expect(result.ok).toBe(true);
    const [command, args] = mockSpawn.mock.calls[0]! as [string, string[]];
    expect(command).toBe('/usr/bin/sandbox-exec');
    expect(args.slice(0, 3)).toEqual(['-f', artifactMcp.sandboxProfilePath, '/usr/local/bin/claude']);
    expect(args.slice(3, 6)).toEqual(artifactMcp.claudeArgs);
    expect(args).not.toContain('/tmp/test-project/.claude/settings.json');
  });

  it('fails before model spawn when required MCP setup fails', async () => {
    const result = await runExecutionAgent(makeOpts({ role: 'coder' }), {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
      buildArtifactMcp: () => { throw new Error('read-only MCP entrypoint is missing'); },
    });

    expect(result).toEqual({
      ok: false,
      error: 'rune-kb not registered: read-only MCP entrypoint is missing',
    });
    expect(mockRunCodex).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('returns the MCP registration contract for an invalid artifact policy before env setup', async () => {
    const products = join(repoDir, 'invalid-products.json');
    writeFileSync(products, JSON.stringify({
      rune: { repoPath: repoDir, artifactMcp: 'rune-kb-admin' },
    }));
    const buildEnv = vi.fn(() => ({ PATH: process.env['PATH'] ?? '' }));
    const result = await runExecutionAgent(makeOpts({
      role: 'coder',
      productsConfigPath: products,
    }), { buildEnv });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^rune-kb not registered: .*invalid artifactMcp/);
    expect(buildEnv).not.toHaveBeenCalled();
    expect(mockRunCodex).not.toHaveBeenCalled();
  });

  it('preserves the no-added-Codex-MCP behavior for unconfigured products', async () => {
    mockRunCodex.mockResolvedValue({ text: 'done', error: null, exitCode: 0 });
    const result = await runExecutionAgent(makeOpts({ role: 'coder' }), {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
      buildArtifactMcp: () => null,
    });

    expect(result.ok).toBe(true);
    expect(mockRunCodex.mock.calls[0]![1]).not.toHaveProperty('configOverrides');
  });

  it('does not grant artifact MCP to tech-lead repair sessions', async () => {
    mockRunCodex.mockResolvedValue({ text: 'done', error: null, exitCode: 0 });
    const buildArtifactMcp = vi.fn(() => artifactMcp);
    const result = await runExecutionAgent(makeOpts({ role: 'tech-lead' }), {
      buildEnv: () => ({ PATH: process.env['PATH'] ?? '' }),
      buildArtifactMcp,
    });

    expect(result.ok).toBe(true);
    expect(buildArtifactMcp).not.toHaveBeenCalled();
    expect(mockRunCodex.mock.calls[0]![1]).not.toHaveProperty('configOverrides');
  });
});

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
    expect(seen).toEqual([{ alias: 'gpt-5.6-sol', format: 'codex', cwd: repoDir }]);
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
