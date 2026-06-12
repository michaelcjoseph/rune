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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

// ---------------------------------------------------------------------------
// Temp git worktree fixture
// ---------------------------------------------------------------------------

let repoDir: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeEach(() => {
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
