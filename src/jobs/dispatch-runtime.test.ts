/**
 * Failing tests for src/intent/dispatch-runtime.ts — project 08-intent-layer Phase 6 A5.2.
 *
 * The module does not exist yet. Every test in this file must fail with a
 * missing-module / missing-export error (the right kind of red).
 *
 * Scope: dispatchToExecutor(handoff, opts) — compile the agent per target,
 * spawn the executor (runAgent for claude / runCodex for codex), call
 * recordDispatch, append to logs/dispatch-log.jsonl.
 *
 * See docs/projects/08-intent-layer/test-plan.md §A5.2.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted above all imports that touch these modules.
// ---------------------------------------------------------------------------

vi.mock('../config.js', () => ({
  default: { DISPATCH_LOG_FILE: '/test/default-dispatch-log.jsonl' },
  PROJECT_ROOT: '/test/project',
}));

vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn() }));
vi.mock('../ai/codex.js', () => ({
  runCodex: vi.fn(),
  probeCodexProvider: vi.fn(async () => ({ available: true })),
}));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks have resolved).
// ---------------------------------------------------------------------------

const { runAgent } = await import('../ai/claude.js');
const { runCodex, probeCodexProvider } = await import('../ai/codex.js');

const runAgentMock = runAgent as unknown as ReturnType<typeof vi.fn>;
const runCodexMock = runCodex as unknown as ReturnType<typeof vi.fn>;
const probeCodexProviderMock = probeCodexProvider as unknown as ReturnType<typeof vi.fn>;

// Module under test.
const { dispatchToExecutor } = await import('./dispatch-runtime.js');

// Types imported from existing stable modules (these already exist).
import type { DispatchHandoff } from '../intent/dispatch.js';
import type { NeutralAgentDef } from '../intent/agent-def.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fixture neutral agent definition. */
const FIXTURE_AGENT: NeutralAgentDef = {
  name: 'sample-agent',
  role: 'A test agent',
  capabilities: ['coding'],
  tools: ['Read', 'Write'],
  constraints: [],
  instructions: 'Be helpful.',
};

/** Build a minimal valid DispatchHandoff. Override any field per-test. */
function makeHandoff(overrides: Partial<DispatchHandoff> = {}): DispatchHandoff {
  return {
    target: 'claude',
    agent: 'sample-agent',
    product: 'acme',
    project: '01-alpha',
    objective: 'Implement the feature described in spec.md.',
    context: 'The feature lives in src/feature/; see spec.md for details.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Per-test temp directory (used for JSONL-append tests).
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-runtime-test-'));
  vi.clearAllMocks();
  // Re-prime after clearAllMocks so existing codex tests keep working.
  probeCodexProviderMock.mockResolvedValue({ available: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Claude target — happy path
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — claude target, happy path', () => {
  it('returns completed result with provider anthropic and text from runAgent', async () => {
    runAgentMock.mockResolvedValue({ text: 'success', error: null });

    const outcome = await dispatchToExecutor(makeHandoff({ target: 'claude' }), {
      logFile: join(tmpDir, 'dispatch.jsonl'),
    });

    expect(outcome.result).toMatchObject({
      model: 'sonnet',
      provider: 'anthropic',
      status: 'completed',
    });
    expect(outcome.logEntry).toMatchObject({
      target: 'claude',
      model: 'sonnet',
      provider: 'anthropic',
      status: 'completed',
    });
    expect(outcome.text).toBe('success');
    expect(outcome.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Claude target — runAgent called with the right args
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — claude target, runAgent args', () => {
  it('calls runAgent with handoff.agent as the first arg and a prompt containing objective+context', async () => {
    runAgentMock.mockResolvedValue({ text: 'ok', error: null });
    const handoff = makeHandoff({
      target: 'claude',
      agent: 'kb-query',
      objective: 'Query the knowledge base for recent activity.',
      context: 'The KB lives in knowledge/; index is at knowledge/index.md.',
    });

    await dispatchToExecutor(handoff, { logFile: join(tmpDir, 'dispatch.jsonl') });

    expect(runAgentMock).toHaveBeenCalledOnce();
    const [agentArg, promptArg] = runAgentMock.mock.calls[0] as [string, string, ...unknown[]];
    expect(agentArg).toBe('kb-query');
    expect(promptArg).toContain(handoff.objective);
    expect(promptArg).toContain(handoff.context);
  });
});

// ---------------------------------------------------------------------------
// 3. Claude target — failure
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — claude target, failure', () => {
  it('maps a runAgent error to a failed DispatchResult with failureReason', async () => {
    runAgentMock.mockResolvedValue({ text: null, error: 'agent crashed' });

    const outcome = await dispatchToExecutor(makeHandoff({ target: 'claude' }), {
      logFile: join(tmpDir, 'dispatch.jsonl'),
    });

    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status === 'failed') {
      expect(outcome.result.failureReason).toBe('agent crashed');
    }
    expect(outcome.logEntry).toMatchObject({
      status: 'failed',
      failureReason: 'agent crashed',
    });
    expect(outcome.text).toBeNull();
    expect(outcome.error).toBe('agent crashed');
  });
});

// ---------------------------------------------------------------------------
// 4. Codex target — happy path
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — codex target, happy path', () => {
  it('returns completed result with provider openai and text from runCodex', async () => {
    runCodexMock.mockResolvedValue({ text: 'codex output', error: null, exitCode: 0 });

    const outcome = await dispatchToExecutor(
      makeHandoff({ target: 'codex' }),
      {
        logFile: join(tmpDir, 'dispatch.jsonl'),
        loadNeutralAgent: () => FIXTURE_AGENT,
      },
    );

    expect(outcome.result).toMatchObject({
      provider: 'openai',
      status: 'completed',
    });
    // Default model for codex is 'codex'
    expect(outcome.result.model).toBe('codex');
    expect(outcome.logEntry).toMatchObject({
      target: 'codex',
      provider: 'openai',
      status: 'completed',
    });
    expect(outcome.text).toBe('codex output');
    expect(outcome.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Codex target — runCodex prompt contains compiled agent doc + handoff fields
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — codex target, prompt shape', () => {
  it('passes runCodex a prompt that includes the compiled agent header and handoff objective+context', async () => {
    runCodexMock.mockResolvedValue({ text: 'done', error: null, exitCode: 0 });
    const handoff = makeHandoff({
      target: 'codex',
      objective: 'Implement seat-based pricing.',
      context: 'Pricing module lives in src/pricing/.',
    });

    await dispatchToExecutor(handoff, {
      logFile: join(tmpDir, 'dispatch.jsonl'),
      loadNeutralAgent: () => FIXTURE_AGENT,
    });

    expect(runCodexMock).toHaveBeenCalledOnce();
    const [promptArg] = runCodexMock.mock.calls[0] as [string, ...unknown[]];
    // compileToCodex always emits a line starting with "# Agent:"
    expect(promptArg).toMatch(/^# Agent:/m);
    expect(promptArg).toContain(handoff.objective);
    expect(promptArg).toContain(handoff.context);
  });
});

// ---------------------------------------------------------------------------
// 6. Codex target — opts pass-through
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — codex target, opts pass-through', () => {
  it('forwards cwd, env, sandboxMode, and timeoutMs to runCodex', async () => {
    runCodexMock.mockResolvedValue({ text: 'ok', error: null, exitCode: 0 });
    const env = { OPENAI_API_KEY: 'test-key' };
    const opts = {
      logFile: join(tmpDir, 'dispatch.jsonl'),
      loadNeutralAgent: () => FIXTURE_AGENT,
      cwd: '/tmp/some-worktree',
      env,
      sandboxMode: 'workspace-write' as const,
      timeoutMs: 30_000,
    };

    await dispatchToExecutor(makeHandoff({ target: 'codex' }), opts);

    expect(runCodexMock).toHaveBeenCalledOnce();
    const [, runCodexOpts] = runCodexMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(runCodexOpts).toMatchObject({
      cwd: '/tmp/some-worktree',
      env,
      sandboxMode: 'workspace-write',
      timeoutMs: 30_000,
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Codex target — failure
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — codex target, failure', () => {
  it('maps a runCodex error to a failed DispatchResult with failureReason', async () => {
    runCodexMock.mockResolvedValue({ text: null, error: 'codex timed out', exitCode: undefined });

    const outcome = await dispatchToExecutor(
      makeHandoff({ target: 'codex' }),
      {
        logFile: join(tmpDir, 'dispatch.jsonl'),
        loadNeutralAgent: () => FIXTURE_AGENT,
      },
    );

    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status === 'failed') {
      expect(outcome.result.failureReason).toBe('codex timed out');
    }
    expect(outcome.logEntry).toMatchObject({
      status: 'failed',
      failureReason: 'codex timed out',
    });
    expect(outcome.error).toBe('codex timed out');
  });
});

// ---------------------------------------------------------------------------
// 8. opts.model override
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — opts.model override', () => {
  it('uses opts.model in result.model and logEntry.model for the claude target', async () => {
    runAgentMock.mockResolvedValue({ text: 'done', error: null });

    const outcome = await dispatchToExecutor(
      makeHandoff({ target: 'claude' }),
      { logFile: join(tmpDir, 'dispatch.jsonl'), model: 'opus' },
    );

    expect(outcome.result.model).toBe('opus');
    expect(outcome.logEntry.model).toBe('opus');
  });

  it('uses opts.model in result.model and logEntry.model for the codex target', async () => {
    runCodexMock.mockResolvedValue({ text: 'done', error: null, exitCode: 0 });

    const outcome = await dispatchToExecutor(
      makeHandoff({ target: 'codex' }),
      {
        logFile: join(tmpDir, 'dispatch.jsonl'),
        loadNeutralAgent: () => FIXTURE_AGENT,
        model: 'o4-mini',
      },
    );

    expect(outcome.result.model).toBe('o4-mini');
    expect(outcome.logEntry.model).toBe('o4-mini');
  });
});

// ---------------------------------------------------------------------------
// 9. JSONL append — single dispatch
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — JSONL append', () => {
  it('appends a JSONL line to logFile that parses to the logEntry', async () => {
    runAgentMock.mockResolvedValue({ text: 'ok', error: null });
    const logFile = join(tmpDir, 'dispatch.jsonl');

    const outcome = await dispatchToExecutor(makeHandoff({ target: 'claude' }), { logFile });

    const raw = readFileSync(logFile, 'utf8').trim();
    expect(raw).not.toBe('');
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject(outcome.logEntry);
  });
});

// ---------------------------------------------------------------------------
// 10. JSONL append — multiple dispatches accumulate
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — JSONL append multiple', () => {
  it('produces two JSONL lines after two dispatch calls', async () => {
    runAgentMock.mockResolvedValue({ text: 'ok', error: null });
    const logFile = join(tmpDir, 'dispatch.jsonl');

    await dispatchToExecutor(makeHandoff({ target: 'claude' }), { logFile });
    await dispatchToExecutor(makeHandoff({ target: 'claude' }), { logFile });

    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 11. JSONL append — mkdir on first write
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — JSONL append, mkdir on first write', () => {
  it('creates the log directory when it does not exist', async () => {
    runAgentMock.mockResolvedValue({ text: 'ok', error: null });
    // Use a nested path that does not exist yet.
    const logFile = join(tmpDir, 'nested', 'deep', 'dispatch.jsonl');

    await dispatchToExecutor(makeHandoff({ target: 'claude' }), { logFile });

    const raw = readFileSync(logFile, 'utf8').trim();
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 12. opts.loadNeutralAgent is preferred over the default file-system path
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — loadNeutralAgent injection', () => {
  it('calls the injected loadNeutralAgent with handoff.agent and uses the returned def', async () => {
    runCodexMock.mockResolvedValue({ text: 'done', error: null, exitCode: 0 });
    const loader = vi.fn(() => FIXTURE_AGENT);

    await dispatchToExecutor(
      makeHandoff({ target: 'codex', agent: 'code-reviewer' }),
      {
        logFile: join(tmpDir, 'dispatch.jsonl'),
        loadNeutralAgent: loader,
      },
    );

    expect(loader).toHaveBeenCalledOnce();
    expect(loader).toHaveBeenCalledWith('code-reviewer');
    // The compiled Codex prompt uses the fixture agent's name.
    const [promptArg] = runCodexMock.mock.calls[0] as [string, ...unknown[]];
    expect(promptArg).toContain(FIXTURE_AGENT.name);
  });
});

// ---------------------------------------------------------------------------
// 13. Codex partial-stdout invariant — text is null iff failed
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — codex partial-stdout invariant', () => {
  it('nulls outcome.text when runCodex returns partial stdout alongside an error', async () => {
    // Codex timeout path returns { text: 'partial', error: 'codex exec timed out…' }.
    // Downstream callers should rely on "text is null iff failed" without
    // re-checking result.status.
    runCodexMock.mockResolvedValue({
      text: 'partial output before timeout',
      error: 'codex exec timed out after 30000ms',
      exitCode: undefined,
    });

    const outcome = await dispatchToExecutor(
      makeHandoff({ target: 'codex' }),
      {
        logFile: join(tmpDir, 'dispatch.jsonl'),
        loadNeutralAgent: () => FIXTURE_AGENT,
      },
    );

    expect(outcome.result.status).toBe('failed');
    expect(outcome.text).toBeNull();
    expect(outcome.error).toBe('codex exec timed out after 30000ms');
  });
});

// ---------------------------------------------------------------------------
// 14. failureReason truncation — bound JSONL line size
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — failureReason truncation', () => {
  it('caps failureReason at FAILURE_REASON_MAX with a truncation marker', async () => {
    const longError = 'x'.repeat(1500);
    runAgentMock.mockResolvedValue({ text: null, error: longError });

    const outcome = await dispatchToExecutor(makeHandoff({ target: 'claude' }), {
      logFile: join(tmpDir, 'dispatch.jsonl'),
    });

    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status === 'failed') {
      // 500-char cap + the truncation marker — under 520.
      expect(outcome.result.failureReason.length).toBeLessThanOrEqual(520);
      expect(outcome.result.failureReason).toMatch(/truncated/);
    }
  });
});

// ---------------------------------------------------------------------------
// 15. DispatchLogEntry carries an ISO-8601 timestamp
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — DispatchLogEntry timestamp', () => {
  it('writes an ISO-8601 ts field on every log entry', async () => {
    runAgentMock.mockResolvedValue({ text: 'ok', error: null });
    const logFile = join(tmpDir, 'dispatch.jsonl');

    await dispatchToExecutor(makeHandoff({ target: 'claude' }), { logFile });

    const raw = readFileSync(logFile, 'utf8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.ts).toEqual(expect.any(String));
    expect(Number.isFinite(Date.parse(parsed.ts))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A5.3: probeCodexProvider guard in dispatchToExecutor
// ---------------------------------------------------------------------------

describe('dispatchToExecutor — codex probe unavailable: returns failed DispatchResult', () => {
  it('returns a failed result with failureReason containing "codex executor unavailable" and the probe reason; does NOT call runCodex', async () => {
    probeCodexProviderMock.mockResolvedValue({
      available: false,
      reason: 'codex binary not found in PATH',
    });

    const outcome = await dispatchToExecutor(
      makeHandoff({ target: 'codex' }),
      {
        logFile: join(tmpDir, 'dispatch.jsonl'),
        loadNeutralAgent: () => FIXTURE_AGENT,
      },
    );

    expect(outcome.result.status).toBe('failed');
    if (outcome.result.status === 'failed') {
      expect(outcome.result.failureReason).toMatch(/codex executor unavailable/i);
      expect(outcome.result.failureReason).toContain('codex binary not found in PATH');
    }
    expect(runCodexMock).not.toHaveBeenCalled();
  });
});

describe('dispatchToExecutor — codex probe unavailable: appends failed log entry', () => {
  it('appends a failed JSONL entry even when the probe short-circuits the dispatch', async () => {
    probeCodexProviderMock.mockResolvedValue({
      available: false,
      reason: 'codex binary not found in PATH',
    });
    const logFile = join(tmpDir, 'dispatch.jsonl');

    const outcome = await dispatchToExecutor(
      makeHandoff({ target: 'codex' }),
      {
        logFile,
        loadNeutralAgent: () => FIXTURE_AGENT,
      },
    );

    const raw = readFileSync(logFile, 'utf8').trim();
    expect(raw).not.toBe('');
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({ status: 'failed' });
    expect(parsed).toMatchObject(outcome.logEntry);
  });
});

describe('dispatchToExecutor — codex probe unavailable: loadNeutralAgent NOT called', () => {
  it('does not invoke loadNeutralAgent when the probe returns unavailable', async () => {
    probeCodexProviderMock.mockResolvedValue({
      available: false,
      reason: 'codex binary not found in PATH',
    });
    const loader = vi.fn(() => FIXTURE_AGENT);

    await dispatchToExecutor(
      makeHandoff({ target: 'codex' }),
      {
        logFile: join(tmpDir, 'dispatch.jsonl'),
        loadNeutralAgent: loader,
      },
    );

    expect(loader).not.toHaveBeenCalled();
  });
});

describe('dispatchToExecutor — codex probe available: runCodex IS called (regression)', () => {
  it('still calls runCodex when the probe returns available:true', async () => {
    // probeCodexProviderMock already primed to { available: true } in beforeEach.
    runCodexMock.mockResolvedValue({ text: 'codex output', error: null, exitCode: 0 });

    const outcome = await dispatchToExecutor(
      makeHandoff({ target: 'codex' }),
      {
        logFile: join(tmpDir, 'dispatch.jsonl'),
        loadNeutralAgent: () => FIXTURE_AGENT,
      },
    );

    expect(runCodexMock).toHaveBeenCalledOnce();
    expect(outcome.result.status).toBe('completed');
  });
});

describe('dispatchToExecutor — claude target: probeCodexProvider NOT called', () => {
  it('does not invoke probeCodexProvider for target "claude"', async () => {
    runAgentMock.mockResolvedValue({ text: 'ok', error: null });

    await dispatchToExecutor(
      makeHandoff({ target: 'claude' }),
      { logFile: join(tmpDir, 'dispatch.jsonl') },
    );

    expect(probeCodexProviderMock).not.toHaveBeenCalled();
  });
});
