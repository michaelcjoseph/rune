/**
 * Phase 2 test suite for `src/jobs/work-run-classify.ts` — terminal
 * classification + run store (test-plan §2, project 11 work-run-observability).
 *
 * Written TEST-FIRST. Every body in the scaffold throws `notImplemented(...)`,
 * so all tests here must be RED until the Phase 2 implementation tasks complete.
 *
 * Expected failure mode: assertion failure or "work-run-classify: <fn> not
 * implemented (project 11 Phase 2 pending)" throw. NEVER a module-resolution
 * error, syntax error, or "Missing env var" crash.
 *
 * See: docs/projects/11-work-run-observability/test-plan.md §2
 */

import { describe, it, expect, vi } from 'vitest';

// `work-run-classify.ts` imports types from `../transport/mutations.js` and
// `./sandbox-runtime.js`, which transitively import `../config.js`.
// config.ts calls `required()` at import time and throws on missing env vars.
// Mock it out so this pure suite loads cleanly with no real environment.
vi.mock('../config.js', () => ({
  default: {
    LOGS_DIR: '/tmp',
    VAULT_DIR: '/test/vault',
    WORKSPACE_DIR: '/test/workspace',
    PROJECT_ROOT: '/test/project',
    SUPERVISED_RUNS_FILE: '/tmp/supervised-runs.json',
    MUTATIONS_LOG_FILE: '/tmp/mutations.jsonl',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 42,
  },
  PROJECT_ROOT: '/test/project',
}));

import type { GitRunner } from './sandbox-runtime.js';
import {
  parseTasks,
  computeTaskTransitions,
  computeWorkProduct,
  classifyOutcome,
  finalizeWorkRun,
  applyOutcomeToDescriptor,
} from './work-run-classify.js';
import type {
  ExitFacts,
  WorkProductFacts,
  ClassifyFacts,
  TaskTransitions,
  WorkOutcome,
} from './work-run-classify.js';
import type { MutationDescriptor, MutationEvent } from '../transport/mutations.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** A terminal event's `data` is typed `unknown`; read it as a record once. */
function eventData(event: MutationEvent): Record<string, unknown> {
  return (event.data ?? {}) as Record<string, unknown>;
}

/** Healthy clean exit with no work done — the noop case. */
function cleanExit(): ExitFacts {
  return { exitCode: 0, signal: null, cancelled: false, durationMs: 1200 };
}

/** Healthy exit with one commit and no remaining tasks — branch-complete. */
function successExit(): ExitFacts {
  return { exitCode: 0, signal: null, cancelled: false, durationMs: 5000 };
}

/** Zero-commit, zero-transition, clean-tree facts — the pure noop. */
function noopProduct(): WorkProductFacts {
  return {
    commitCount: 0,
    commitShas: [],
    filesChanged: [],
    diffstat: '',
    dirty: false,
    untracked: false,
    transitions: { tasksNewlyChecked: 0, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 },
  };
}

/** Product facts with one commit, all tasks done. */
function branchCompleteProduct(): WorkProductFacts {
  return {
    commitCount: 1,
    commitShas: ['abc1234'],
    filesChanged: ['src/foo.ts'],
    diffstat: '1 file changed, 10 insertions(+)',
    dirty: false,
    untracked: false,
    transitions: { tasksNewlyChecked: 1, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 },
  };
}

/** Product facts with one commit but remaining tasks. */
function partialProduct(): WorkProductFacts {
  return {
    commitCount: 1,
    commitShas: ['abc1234'],
    filesChanged: ['src/foo.ts'],
    diffstat: '1 file changed, 10 insertions(+)',
    dirty: false,
    untracked: false,
    transitions: { tasksNewlyChecked: 1, tasksRemaining: 2, tasksAdded: 0, tasksRemoved: 0 },
  };
}

/** A GitRunner stub that records all calls and returns canned responses. */
function makeRunGitStub(responses: Record<string, { stdout: string; stderr: string }> = {}) {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const stub = vi.fn<GitRunner>().mockImplementation(async (args, opts) => {
    calls.push({ args: [...args], cwd: opts?.cwd });
    // Match by a key arg to identify the command type
    for (const [key, resp] of Object.entries(responses)) {
      if (args.some(a => a.includes(key))) {
        return resp;
      }
    }
    return { stdout: '', stderr: '' };
  });
  return { stub, calls };
}

/** Minimal MutationDescriptor factory. */
function makeDescriptor(overrides: Partial<MutationDescriptor> = {}): MutationDescriptor {
  return {
    id: 'mut-test-001',
    kind: 'work-run',
    source: 'webview',
    target: { type: 'project', ref: 'test-project' },
    preview: { summary: 'test run' },
    payload: {},
    createdAt: new Date().toISOString(),
    status: 'running',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §2 classifyOutcome — pure fixtures, test-plan lines 1-5
// ---------------------------------------------------------------------------

describe('classifyOutcome — pure rules (spec requirements 3-7)', () => {
  it(
    // test-plan §2: zero commits + zero task transitions + clean tree → noop
    // (the case that would have caught run 7828477a)
    'exit 0 + zero commits + zero transitions + clean tree → noop',
    () => {
      const facts: ClassifyFacts = { exit: cleanExit(), product: noopProduct() };
      const result = classifyOutcome(facts);
      expect(result.outcome).toBe('noop');
    },
  );

  it(
    // test-plan §2: zero commits + dirty tree → dirty-uncommitted (dirty=true)
    'exit 0 + zero commits + dirty:true → dirty-uncommitted',
    () => {
      const facts: ClassifyFacts = {
        exit: cleanExit(),
        product: { ...noopProduct(), dirty: true },
      };
      const result = classifyOutcome(facts);
      expect(result.outcome).toBe('dirty-uncommitted');
    },
  );

  it(
    // test-plan §2: zero commits + untracked files → dirty-uncommitted (untracked=true)
    'exit 0 + zero commits + untracked:true → dirty-uncommitted',
    () => {
      const facts: ClassifyFacts = {
        exit: cleanExit(),
        product: { ...noopProduct(), untracked: true },
      };
      const result = classifyOutcome(facts);
      expect(result.outcome).toBe('dirty-uncommitted');
    },
  );

  it(
    // test-plan §2: commits + unchecked tasks remain → partial
    'exit 0 + commits + tasksRemaining > 0 → partial',
    () => {
      const facts: ClassifyFacts = { exit: successExit(), product: partialProduct() };
      const result = classifyOutcome(facts);
      expect(result.outcome).toBe('partial');
    },
  );

  it(
    // test-plan §2: commits + all original tasks checked → branch-complete
    'exit 0 + commits + tasksRemaining:0 → branch-complete',
    () => {
      const facts: ClassifyFacts = { exit: successExit(), product: branchCompleteProduct() };
      const result = classifyOutcome(facts);
      expect(result.outcome).toBe('branch-complete');
    },
  );

  it(
    // test-plan §2: non-zero exit code → failed, reason mentions code
    'exitCode 1 → failed, reason matches /code 1/',
    () => {
      const facts: ClassifyFacts = {
        exit: { exitCode: 1, signal: null, cancelled: false, durationMs: 3000 },
        product: noopProduct(),
      };
      const result = classifyOutcome(facts);
      expect(result.outcome).toBe('failed');
      expect(result.reason).toMatch(/code 1/i);
    },
  );

  it(
    // test-plan §2: cancelled:true → failed, reason mentions cancel
    'cancelled:true → failed, reason matches /cancel/i',
    () => {
      const facts: ClassifyFacts = {
        exit: { exitCode: null, signal: 'SIGTERM', cancelled: true, durationMs: 500 },
        product: noopProduct(),
      };
      const result = classifyOutcome(facts);
      expect(result.outcome).toBe('failed');
      expect(result.reason).toMatch(/cancel/i);
    },
  );

  it(
    // test-plan §2: signal-killed (not cancelled) → failed, reason mentions kill
    'signal:SIGKILL + cancelled:false → failed, reason matches /kill/i',
    () => {
      const facts: ClassifyFacts = {
        exit: { exitCode: null, signal: 'SIGKILL', cancelled: false, durationMs: 800 },
        product: noopProduct(),
      };
      const result = classifyOutcome(facts);
      expect(result.outcome).toBe('failed');
      expect(result.reason).toMatch(/kill/i);
    },
  );
});

// ---------------------------------------------------------------------------
// P0.3 (project 15) — classifyOutcome exit-fact taxonomy. test-plan §2.
//
// WRITE-FIRST: the `reaped-after-terminal-result` cases are RED against the
// current classifier (which returns `failed` on ANY signal/cancel before it
// ever looks at work product — the incident's exact mis-classification). The
// user-cancel / external-kill / clean-exit cases are regression guards that a
// naive "check branch-complete first" reorder must NOT break.
//
// Intended taxonomy (settled here, implemented by the P0.3 impl task):
//   ExitFacts gains an `exitFact` discriminator:
//     'clean-exit' | 'clean-exit-wedged-stdio' | 'reaped-after-terminal-result'
//     | 'user-cancel' | 'external-kill'
//   classifyOutcome decides on (exitFact + work product) — spec req 6-8:
//     - user-cancel  → failed/cancelled ALWAYS, even if the branch looks
//       complete (req 8: a real cancel must never read as success).
//     - external-kill → failed (the agent never declared done; the truthful
//       work-product fields are still attached, NOT the null-field
//       classify-error path).
//     - clean-exit / clean-exit-wedged-stdio / reaped-after-terminal-result are
//       the "agent declared done" bucket → classify on WORK PRODUCT, ignoring
//       the reap's signal/exit code (req 7). A non-zero clean-exit is still
//       failed.
//   When `exitFact` is ABSENT (legacy on-disk facts / older callers), the
//   classifier falls back to the pre-P0.3 signal/cancel/exitCode rules, so the
//   existing suite above stays green.
// ---------------------------------------------------------------------------

type ExitFactTag =
  | 'clean-exit'
  | 'clean-exit-wedged-stdio'
  | 'reaped-after-terminal-result'
  | 'user-cancel'
  | 'system-cancel'
  | 'external-kill';

/**
 * Build ExitFacts carrying the P0.3 `exitFact` discriminator. The field is not
 * on the ExitFacts interface yet, so cast through — this keeps the suite
 * `tsc --noEmit` clean before the field lands and reads verbatim once it does.
 */
function exitWith(tag: ExitFactTag, over: Partial<ExitFacts> = {}): ExitFacts {
  return {
    exitCode: 0,
    signal: null,
    cancelled: false,
    durationMs: 1000,
    exitFact: tag,
    ...over,
  } as ExitFacts;
}

describe('classifyOutcome — exit-fact taxonomy (P0.3)', () => {
  // --- reaped-after-terminal-result: the incident's mis-classified case. ---

  it('reapedAfterTerminalResult + clean, complete branch → branch-complete (NOT failed)', () => {
    // Watchdog reaped a wedged-but-finished agent: SIGKILL, no exit code — yet
    // result:success was already emitted and the branch is complete.
    const facts: ClassifyFacts = {
      exit: exitWith('reaped-after-terminal-result', { signal: 'SIGKILL', exitCode: null }),
      product: branchCompleteProduct(),
    };
    expect(classifyOutcome(facts).outcome).toBe('branch-complete');
  });

  it('reapedAfterTerminalResult + incomplete branch → partial (classify on work product)', () => {
    const facts: ClassifyFacts = {
      exit: exitWith('reaped-after-terminal-result', { signal: 'SIGKILL', exitCode: null }),
      product: partialProduct(),
    };
    const result = classifyOutcome(facts);
    expect(result.outcome).toBe('partial');
    // The reaped signal must not leak into a work-product verdict's reason.
    expect(result.reason).not.toMatch(/signal|kill/i);
  });

  // --- user-cancel: stays failed even when the branch looks complete (req 8). ---

  it('user-cancel + complete-looking branch → failed/cancelled (must not read a real cancel as success)', () => {
    const facts: ClassifyFacts = {
      exit: exitWith('user-cancel', { cancelled: true, signal: 'SIGTERM', exitCode: null }),
      product: branchCompleteProduct(),
    };
    const result = classifyOutcome(facts);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/cancel/i);
  });

  it('user-cancel + incomplete branch → failed/cancelled', () => {
    const facts: ClassifyFacts = {
      exit: exitWith('user-cancel', { cancelled: true, signal: 'SIGTERM', exitCode: null }),
      product: partialProduct(),
    };
    expect(classifyOutcome(facts).outcome).toBe('failed');
  });

  // --- system-cancel: a Rune backstop reap (quiet→cancel / max-runtime) is
  //     NOT a user cancel — classify on work product, never as failed/cancelled. ---

  it('system-cancel + complete branch → branch-complete (a backstop reap must not read as a cancel)', () => {
    // The bug: quiet→cancel / max-runtime reaped via cancelMutation, which set
    // the same `cancelled` flag as /cancel, so a healthy complete branch was
    // mislabeled failed/cancelled. A system-cancel sets cancelled:false and
    // classifies on the work product.
    const facts: ClassifyFacts = {
      exit: exitWith('system-cancel', { signal: 'SIGTERM', exitCode: null }),
      product: branchCompleteProduct(),
    };
    const result = classifyOutcome(facts);
    expect(result.outcome).toBe('branch-complete');
    // Truthful: the manner of stop stays visible, but it is NOT a user cancel.
    expect(result.reason).toMatch(/system-cancel/i);
    expect(result.reason).not.toMatch(/^cancelled$/i);
  });

  it('system-cancel + partial branch → partial (work product, not failed)', () => {
    const facts: ClassifyFacts = {
      exit: exitWith('system-cancel', { signal: 'SIGTERM', exitCode: null }),
      product: partialProduct(),
    };
    expect(classifyOutcome(facts).outcome).toBe('partial');
  });

  it('system-cancel + no-progress run → noop (not failed)', () => {
    const facts: ClassifyFacts = {
      exit: exitWith('system-cancel', { signal: 'SIGTERM', exitCode: null }),
      product: noopProduct(),
    };
    expect(classifyOutcome(facts).outcome).toBe('noop');
  });

  it('system-cancel that ALSO set cancelled:true still fails (a real user cancel wins)', () => {
    // Defense-in-depth: if a caller wrongly stamps both, the cancelled
    // short-circuit (a real user cancel) takes precedence over the tag.
    const facts: ClassifyFacts = {
      exit: exitWith('system-cancel', { cancelled: true, signal: 'SIGTERM', exitCode: null }),
      product: branchCompleteProduct(),
    };
    expect(classifyOutcome(facts).outcome).toBe('failed');
  });

  // --- external-kill: operator SIGTERM, no terminal result seen → failed. ---

  it('external-kill (operator SIGTERM, exit 143) + incomplete branch → failed', () => {
    const facts: ClassifyFacts = {
      exit: exitWith('external-kill', { signal: 'SIGTERM', exitCode: 143 }),
      product: partialProduct(),
    };
    expect(classifyOutcome(facts).outcome).toBe('failed');
  });

  it('external-kill + complete-looking branch → failed (no terminal result was seen)', () => {
    const facts: ClassifyFacts = {
      exit: exitWith('external-kill', { signal: 'SIGTERM', exitCode: 143 }),
      product: branchCompleteProduct(),
    };
    expect(classifyOutcome(facts).outcome).toBe('failed');
  });

  // --- clean-exit-with-wedged-stdio: exited 0 → classify on product. ---

  it('clean-exit-with-wedged-stdio + complete branch → branch-complete', () => {
    const facts: ClassifyFacts = {
      exit: exitWith('clean-exit-wedged-stdio', { exitCode: 0 }),
      product: branchCompleteProduct(),
    };
    expect(classifyOutcome(facts).outcome).toBe('branch-complete');
  });

  it('clean-exit-with-wedged-stdio + incomplete branch → partial', () => {
    const facts: ClassifyFacts = {
      exit: exitWith('clean-exit-wedged-stdio', { exitCode: 0 }),
      product: partialProduct(),
    };
    expect(classifyOutcome(facts).outcome).toBe('partial');
  });

  // --- parked / blocked-on-human is supervision state, never a WorkOutcome. ---

  it('never emits parked/blocked-on-human as a WorkOutcome across the taxonomy', () => {
    // Typed as WorkOutcome[] so adding a new outcome to the union forces this
    // guard to be revisited at compile time — `parked`/`blocked-on-human` can
    // never be silently admitted.
    const VALID: ReadonlyArray<WorkOutcome> = [
      'branch-complete',
      'partial',
      'noop',
      'dirty-uncommitted',
      'failed',
    ];
    const fixtures: ClassifyFacts[] = [
      { exit: exitWith('reaped-after-terminal-result', { signal: 'SIGKILL', exitCode: null }), product: branchCompleteProduct() },
      { exit: exitWith('user-cancel', { cancelled: true, signal: 'SIGTERM', exitCode: null }), product: branchCompleteProduct() },
      { exit: exitWith('external-kill', { signal: 'SIGTERM', exitCode: 143 }), product: partialProduct() },
      { exit: exitWith('clean-exit-wedged-stdio'), product: noopProduct() },
    ];
    for (const f of fixtures) {
      expect(VALID).toContain(classifyOutcome(f).outcome);
    }
  });
});

describe('finalizeWorkRun — external-kill carries truthful work product (P0.3)', () => {
  it('a failed external-kill emits the real work-product facts, not the null-field classify-error path', async () => {
    const facts: ClassifyFacts = {
      exit: exitWith('external-kill', { signal: 'SIGTERM', exitCode: 143 }),
      product: partialProduct(),
    };
    const event = await finalizeWorkRun({
      mutationId: 'mut-extkill',
      computeFacts: async () => facts,
      exportForensics: async () => {},
    });
    expect(event.kind).toBe('failed');
    const data = eventData(event);
    expect(data['outcome']).toBe('failed');
    // Truthful product attached — NOT the catch-path (which omits workProduct).
    expect(data['workProduct']).toBeDefined();
    expect((data['workProduct'] as WorkProductFacts).commitCount).toBe(1);
    expect(String(data['reason'])).not.toMatch(/classification-error/);
    // The reason should name the external kill (signal/code), not be empty.
    expect(String(data['reason'])).toMatch(/143|signal|kill|external/i);
  });
});

// ---------------------------------------------------------------------------
// §2 parseTasks — task parsing
// ---------------------------------------------------------------------------

describe('parseTasks', () => {
  it(
    // test-plan §2: [x] and [X] both produce checked:true
    '- [x] and - [X] both produce checked:true',
    () => {
      const content = '- [x] lowercase checked\n- [X] uppercase checked\n';
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(2);
      expect(tasks[0]!.checked).toBe(true);
      expect(tasks[1]!.checked).toBe(true);
    },
  );

  it(
    // test-plan §2: [ ] produces checked:false
    '- [ ] produces checked:false',
    () => {
      const content = '- [ ] unchecked task\n';
      const tasks = parseTasks(content);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.checked).toBe(false);
    },
  );

  it('ignores non-checkbox lines', () => {
    const content = '# Heading\nsome prose\n- [x] checked task\nmore prose\n- [ ] unchecked\n';
    const tasks = parseTasks(content);
    // Only checkbox lines returned
    expect(tasks).toHaveLength(2);
  });

  it('empty string returns empty array', () => {
    const tasks = parseTasks('');
    expect(tasks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §2 computeTaskTransitions — task-delta computation
// ---------------------------------------------------------------------------

describe('computeTaskTransitions', () => {
  it(
    // test-plan §2 (a): one baseline unchecked task becomes checked
    // → tasksNewlyChecked:1, tasksRemaining:0
    'baseline unchecked → final checked: tasksNewlyChecked 1, tasksRemaining 0',
    () => {
      const baseline = '- [ ] implement foo\n';
      const final = '- [x] implement foo\n';
      const t: TaskTransitions = computeTaskTransitions(baseline, final);
      expect(t.tasksNewlyChecked).toBe(1);
      expect(t.tasksRemaining).toBe(0);
      expect(t.tasksAdded).toBe(0);
      expect(t.tasksRemoved).toBe(0);
    },
  );

  it(
    // test-plan §2 (b): a baseline task deleted → tasksRemoved 1, tasksNewlyChecked 0
    'baseline task absent in final → tasksRemoved 1 (not progress)',
    () => {
      const baseline = '- [ ] implement foo\n- [ ] implement bar\n';
      const final = '- [ ] implement bar\n';
      const t: TaskTransitions = computeTaskTransitions(baseline, final);
      expect(t.tasksRemoved).toBe(1);
      expect(t.tasksNewlyChecked).toBe(0);
    },
  );

  it(
    // test-plan §2 (b): a task only in final → tasksAdded 1
    'task only in final → tasksAdded 1',
    () => {
      const baseline = '- [ ] implement foo\n';
      const final = '- [ ] implement foo\n- [ ] brand new task\n';
      const t: TaskTransitions = computeTaskTransitions(baseline, final);
      expect(t.tasksAdded).toBe(1);
    },
  );

  it(
    // test-plan §2 (c): absent tasks.md (baseline='' AND final='') → all-zero transitions
    'absent tasks.md (baseline="" AND final="") → all-zero transitions',
    () => {
      const t: TaskTransitions = computeTaskTransitions('', '');
      expect(t.tasksNewlyChecked).toBe(0);
      expect(t.tasksRemaining).toBe(0);
      expect(t.tasksAdded).toBe(0);
      expect(t.tasksRemoved).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// §2 computeWorkProduct — diff base + GitRunner seam
// ---------------------------------------------------------------------------

describe('computeWorkProduct', () => {
  it(
    // test-plan §2: diff is computed against captured baseSha, not HEAD/main —
    // the range arg contains `${baseSha}..${branch}` exactly.
    'injects runGit with baseSha..branch range (not "main" or "HEAD")',
    async () => {
      const baseSha = 'deadbeef1234567890abcdef1234567890abcdef';
      const branch = 'rune-gen-eval/mut-abc';
      const rangePrefix = `${baseSha}..${branch}`;

      const { stub, calls } = makeRunGitStub({
        '--count': { stdout: '2\n', stderr: '' },
        'rev-list': { stdout: 'abc1234\ndef5678\n', stderr: '' },
        '--stat': { stdout: ' 2 files changed', stderr: '' },
        '--porcelain': { stdout: '', stderr: '' },
      });

      // No `.catch` — the scaffold rejects with notImplemented, so the await
      // itself is the clean RED today. After implementation the await resolves
      // and the positive assertions below pin the actual diff-base contract.
      await computeWorkProduct({
        runGit: stub,
        cwd: '/fake/worktree',
        baseSha,
        branch,
        baselineTasks: '',
        finalTasks: '',
      });

      // The diff base must be `baseSha..branch` (positive assertion — not just
      // "absence of main", which an empty call list would satisfy trivially).
      const rangeCallExists = calls.some(c => c.args.some(a => a.includes(rangePrefix)));
      expect(rangeCallExists).toBe(true);
      // …and never `main`/`HEAD` as the range base.
      const badBase = calls.some(c => c.args.some(a => /^(main|HEAD)\.\./.test(a)));
      expect(badBase).toBe(false);
    },
  );

  it(
    // test-plan §2: stable diff base — even if we call with the same baseSha
    // twice, the range base never changes to HEAD or main.
    'diff base is stable: same baseSha on two calls never becomes HEAD',
    async () => {
      const baseSha = 'cafebabe1234567890abcdef1234567890abcdef';
      const branch = 'rune-gen-eval/mut-xyz';
      const { stub, calls } = makeRunGitStub({
        '--count': { stdout: '1\n', stderr: '' },
        'rev-list': { stdout: 'abc1234\n', stderr: '' },
        '--stat': { stdout: '1 file changed', stderr: '' },
        '--porcelain': { stdout: '', stderr: '' },
      });

      const opts = {
        runGit: stub,
        cwd: '/fake/worktree',
        baseSha,
        branch,
        baselineTasks: '',
        finalTasks: '',
      };

      // Two calls with identical opts — both must use the captured baseSha
      // range, never HEAD/main. No `.catch`: red-now via notImplemented.
      await computeWorkProduct(opts);
      await computeWorkProduct(opts);

      const rangePrefix = `${baseSha}..${branch}`;
      expect(calls.some(c => c.args.some(a => a.includes(rangePrefix)))).toBe(true);
      const badCalls = calls.filter(c =>
        c.args.some(a => /^(HEAD|main)\.\./.test(a)),
      );
      expect(badCalls).toHaveLength(0);
    },
  );

  it(
    // test-plan §2: a status + porcelain call is made during computeWorkProduct
    'makes a git status --porcelain call to detect dirty/untracked state',
    async () => {
      const baseSha = 'abc123';
      const branch = 'test-branch';
      const { stub, calls } = makeRunGitStub({
        '--count': { stdout: '0\n', stderr: '' },
        '--porcelain': { stdout: '', stderr: '' },
      });

      // No `.catch`: red-now via notImplemented; pins the contract after impl.
      await computeWorkProduct({
        runGit: stub,
        cwd: '/fake/worktree',
        baseSha,
        branch,
        baselineTasks: '',
        finalTasks: '',
      });

      // `status` and `--porcelain` must appear in the SAME call — a bare
      // `git status` without --porcelain would not detect dirty state.
      const statusPorcelain = calls.some(
        c => c.args.includes('status') && c.args.includes('--porcelain'),
      );
      expect(statusPorcelain).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// §2 finalizeWorkRun — handoff + crash safety
// ---------------------------------------------------------------------------

describe('finalizeWorkRun', () => {
  it(
    // test-plan §2: given noop-facts, returns exactly ONE completed event
    // with data.outcome === 'noop'
    'noop facts → ONE completed event with outcome:noop',
    async () => {
      const noopFacts: ClassifyFacts = { exit: cleanExit(), product: noopProduct() };
      let exportForensicsCalled = 0;

      const result = await finalizeWorkRun({
        mutationId: 'mut-noop-001',
        computeFacts: async () => noopFacts,
        exportForensics: async () => { exportForensicsCalled++; },
      });

      // Single event (not an array)
      expect(Array.isArray(result)).toBe(false);
      expect(result.kind).toBe('completed');
      // outcome AND workProduct ride on data — workProduct must be carried so
      // applyOutcomeToDescriptor can copy it onto the descriptor for persist.
      expect(eventData(result)['outcome']).toBe('noop');
      expect(eventData(result)['workProduct']).toBeDefined();
      // exportForensics called exactly once
      expect(exportForensicsCalled).toBe(1);
    },
  );

  it(
    // test-plan §2: failed-exit facts → one failed event with outcome:'failed'
    'failed-exit facts → ONE failed event with outcome:failed',
    async () => {
      const failedFacts: ClassifyFacts = {
        exit: { exitCode: 1, signal: null, cancelled: false, durationMs: 2000 },
        product: noopProduct(),
      };
      let exportForensicsCalled = 0;

      const result = await finalizeWorkRun({
        mutationId: 'mut-fail-001',
        computeFacts: async () => failedFacts,
        exportForensics: async () => { exportForensicsCalled++; },
      });

      expect(Array.isArray(result)).toBe(false);
      expect(result.kind).toBe('failed');
      expect(eventData(result)['outcome']).toBe('failed');
      expect(exportForensicsCalled).toBe(1);
    },
  );

  it(
    // test-plan §2: branch-complete facts → ONE completed event (not failed)
    'branch-complete facts → ONE completed event with outcome:branch-complete',
    async () => {
      const facts: ClassifyFacts = { exit: successExit(), product: branchCompleteProduct() };

      const result = await finalizeWorkRun({
        mutationId: 'mut-bc-001',
        computeFacts: async () => facts,
        exportForensics: async () => {},
      });

      expect(result.kind).toBe('completed');
      expect(eventData(result)['outcome']).toBe('branch-complete');
    },
  );
});

// ---------------------------------------------------------------------------
// §2 finalizeWorkRun — crash-mid-classification safety
// ---------------------------------------------------------------------------

describe('finalizeWorkRun — crash safety', () => {
  it(
    // test-plan §2: computeFacts REJECTS → finalizeWorkRun RESOLVES to ONE
    // terminal failed event with reason matching /classification-error/;
    // exportForensics is called (best-effort, with null); does NOT reject/throw.
    'computeFacts throws → resolves to ONE failed event with reason /classification-error/; exportForensics called with null',
    async () => {
      let exportForensicsArg: unknown = 'NOT_CALLED';

      const result = await finalizeWorkRun({
        mutationId: 'mut-crash-001',
        computeFacts: async () => { throw new Error('git exploded'); },
        exportForensics: async (facts) => { exportForensicsArg = facts; },
      });

      // Must RESOLVE (not reject)
      expect(Array.isArray(result)).toBe(false);
      expect(result.kind).toBe('failed');
      const data = result.data as Record<string, unknown>;
      expect(String(data?.['reason'] ?? '')).toMatch(/classification-error/i);
      // exportForensics was called
      expect(exportForensicsArg).not.toBe('NOT_CALLED');
      // exportForensics received null (best-effort: facts unavailable)
      expect(exportForensicsArg).toBeNull();
    },
  );

  it(
    // Additional crash-path invariant: finalizeWorkRun must NOT re-throw when
    // both computeFacts AND exportForensics throw. The caller (apply()) must
    // always get exactly one terminal event.
    'computeFacts throws AND exportForensics throws → still resolves to ONE failed event',
    async () => {
      await expect(
        finalizeWorkRun({
          mutationId: 'mut-double-crash-001',
          computeFacts: async () => { throw new Error('git gone'); },
          exportForensics: async () => { throw new Error('disk full'); },
        }),
      ).resolves.toMatchObject({ kind: 'failed' });
    },
  );
});

// ---------------------------------------------------------------------------
// §2 applyOutcomeToDescriptor — verdict reaches descriptor
// ---------------------------------------------------------------------------

describe('applyOutcomeToDescriptor', () => {
  it(
    // test-plan §2: outcome + workProduct are copied onto the descriptor
    'copies outcome and workProduct from terminal event onto descriptor',
    () => {
      const descriptor = makeDescriptor();
      const workProduct: WorkProductFacts = branchCompleteProduct();

      const event: MutationEvent = {
        mutationId: descriptor.id,
        ts: new Date().toISOString(),
        kind: 'completed',
        data: { outcome: 'branch-complete', workProduct },
      };

      applyOutcomeToDescriptor(descriptor, event);

      expect(descriptor['outcome']).toBe('branch-complete');
      expect(descriptor['workProduct']).toEqual(workProduct);
    },
  );

  it(
    // test-plan §2: descriptor.status is untouched — the verdict rides on
    // outcome, status stays in its enum
    'does not mutate descriptor.status (verdict rides on outcome, not status)',
    () => {
      const descriptor = makeDescriptor({ status: 'running' });
      const event: MutationEvent = {
        mutationId: descriptor.id,
        ts: new Date().toISOString(),
        kind: 'completed',
        data: { outcome: 'noop', workProduct: noopProduct() },
      };

      applyOutcomeToDescriptor(descriptor, event);

      // status must remain 'running' — the caller (startApply) sets status
      expect(descriptor.status).toBe('running');
    },
  );

  it(
    // Verify a failed event with outcome:failed also copies correctly
    'failed event with outcome:failed also copies outcome onto descriptor',
    () => {
      const descriptor = makeDescriptor();
      const event: MutationEvent = {
        mutationId: descriptor.id,
        ts: new Date().toISOString(),
        kind: 'failed',
        data: { outcome: 'failed', reason: 'exited with code 1', workProduct: noopProduct() },
      };

      applyOutcomeToDescriptor(descriptor, event);

      expect(descriptor['outcome']).toBe('failed');
    },
  );
});
