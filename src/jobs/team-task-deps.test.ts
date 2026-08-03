/**
 * Phase 8 (live execution binding) — production TeamTaskDeps factory,
 * model-map, and no-stub regression tests.
 *
 * Pins the production binding the original closeout left stubbed:
 *
 *   - the factory binds ALL EIGHT role seams (none the hardcoded `blocked`
 *     stub), with coder/reviewer resolving to DIFFERENT providers through the
 *     model-policy resolver — fail-closed to a block when only a
 *     same-provider model is available
 *   - `policies/model-policy.json` carries the Phase 8 model map: the judgment
 *     roles (pm/tech-lead/reviewer/designer) on anthropic via the Claude CLI,
 *     the artifact roles (qa/coder) on openai via the Codex CLI. These tests
 *     assert that shape, not the specific aliases filling each slot — swapping
 *     a model is a policy-file edit, not a test change.
 *   - the orchestrated applier's production `runTaskWorkflow` calls through
 *     to `runTeamTaskWorkflow` — the "orchestrated role execution not yet
 *     wired" blocked path is gone and cannot reappear without failing here
 *
 * Model calls are injected throughout; these tests assert wiring, not live
 * output. See tasks.md Phase 8.
 */

import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  buildProductionTeamTaskDeps as buildProductionTeamTaskDepsRaw,
  createProductionTaskWorkflowRunner as createProductionTaskWorkflowRunnerRaw,
  parseCoderSelfReviewResult,
  resolveTeamRoleModels,
  type JudgmentModelCall,
  type TeamRoleModels,
  type TeamTaskSeams,
} from './team-task-deps.js';
import {
  __getRuntimeDepsForTest,
  __resetOrchestratedRuntimeForTest,
} from './orchestrated-work-runner.js';
import { PROJECT_ROOT } from '../config.js';
import { parsePolicy, type ModelEntry, type ModelPolicy } from '../intent/model-policy.js';
import {
  ExecutionFailureError,
  RoleCancellationError,
  runTeamTaskWorkflow,
  type FindingsLedgerEntry,
  type TeamTaskDeps,
  type WorkflowActivityEvent,
} from '../intent/team-task-workflow.js';
import type { SizedTask } from '../intent/planning-roles.js';
import type { SelectedTask } from '../intent/orch-task-select.js';
import { MANUAL_LIVE_GATE_MARKER } from '../intent/planning-artifact.js';
import type { SandboxSpec } from '../intent/sandbox.js';
import type { ExecutionAgentResult } from './execution-agent.js';
import type {
  ExecutionCheckpoint,
  ExecutionFailure,
} from '../intent/execution-failure.js';
import { defaultRunGit } from './sandbox-runtime.js';
import { captureCanonicalReviewState, defaultRunCanonicalGit } from './canonical-git.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Repo root derived from this file's location (src/jobs/ → ../..) — avoids a
// direct config.js import (and its required-env-var reads) for a path constant.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REAL_POLICY_PATH = join(REPO_ROOT, 'policies', 'model-policy.json');
const FIXTURE_TASK_BASE_TREE = '1111111111111111111111111111111111111111';

function fixtureTreeOid(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function buildProductionTeamTaskDeps(
  args: Omit<
    Parameters<typeof buildProductionTeamTaskDepsRaw>[0],
    'taskBaseTree'
  > & { taskBaseTree?: string },
  seams?: Parameters<typeof buildProductionTeamTaskDepsRaw>[1],
) {
  return buildProductionTeamTaskDepsRaw(
    { taskBaseTree: FIXTURE_TASK_BASE_TREE, ...args },
    seams,
  );
}

function createProductionTaskWorkflowRunner(
  ...args: Parameters<typeof createProductionTaskWorkflowRunnerRaw>
) {
  const run = createProductionTaskWorkflowRunnerRaw(...args);
  return (
    task: Parameters<typeof run>[0],
    ctx: Omit<Parameters<typeof run>[1], 'taskBase' | 'workflowAttempt'> &
      Partial<Pick<Parameters<typeof run>[1], 'taskBase' | 'workflowAttempt'>>,
  ) => run(task, {
    taskBase: { taskId: task.id, treeOid: FIXTURE_TASK_BASE_TREE },
    workflowAttempt: 1,
    ...ctx,
  });
}

function loadRealPolicy(): ModelPolicy {
  return parsePolicy(readFileSync(REAL_POLICY_PATH, 'utf8'));
}

/** The registry entry a role's declared default points at. Keeps these tests
 *  pinned to the shape of the model map (provider, executor, capabilities)
 *  rather than to whichever alias currently fills each slot — swapping a model
 *  in the policy is data, not a test change. */
function registryEntryForRole(policy: ModelPolicy, role: string): ModelEntry {
  const alias = policy.roleDefaults[role];
  expect(alias, `roleDefaults must declare a model for '${role}'`).toBeDefined();
  const entry = policy.models.find((m) => m.alias === alias);
  expect(entry, `roleDefaults['${role}'] = '${alias}' must be a registered model`).toBeDefined();
  return entry!;
}

function makeSandbox(): SandboxSpec {
  return {
    product: 'rune',
    project: 'demo',
    worktree: tmpdir(),
    egressAllowlist: [],
    resumed: false,
  } as SandboxSpec;
}

const sizedTask: SizedTask = {
  id: 'demo-task',
  text: 'demo task',
  testStrategy: 'code-tests-required',
  designerNeeded: false,
  roles: ['qa', 'coder', 'reviewer', 'tech-lead'],
};

const selectedTask: SelectedTask = {
  id: 'demo-task',
  text: 'demo task',
  section: 'Phase 1',
  // Most pre-existing factory tests isolate role wiring, not product
  // validation admission. New admission tests override this to `required`.
  validationPolicy: 'reviewed-no-validation',
};

/** A green judgment reply: contains every fenced verdict block, so each
 *  seam's parser finds its own tag regardless of which role is asked. */
const GREEN_JUDGMENT_REPLY = [
  '```tl-test-review',
  '{"approved": true}',
  '```',
  '```qa-diff-revalidation',
  '{"approved": true}',
  '```',
  '```reviewer-verdict',
  '{"pass": true, "objections": []}',
  '```',
  '```tl-diff-review',
  '{"pass": true}',
  '```',
  '```designer-review',
  '{"pass": true}',
  '```',
  '```pm-wrapup',
  '{"resolved": true}',
  '```',
].join('\n');

const greenJudgment: JudgmentModelCall = async () => GREEN_JUDGMENT_REPLY;

const greenExecution = async (): Promise<ExecutionAgentResult> => ({
  ok: true,
  diff: 'diff --git a/src/x.test.ts b/src/x.test.ts\n+++ b/src/x.test.ts\n+expect(1).toBe(1)\n',
  output: 'wrote tests',
});

function failedExecution(
  diagnostic: string,
  cancellation?: ExecutionFailure['cancellation'],
): ExecutionAgentResult {
  const failure: ExecutionFailure = {
    taskId: 'task-one',
    role: 'coder',
    provider: 'openai',
    format: 'codex',
    model: 'test-model',
    workflowStage: 'coder-implementation',
    checkpointedAt: '2026-07-22T00:00:00.000Z',
    failureStage: cancellation ? 'cancellation' : 'provider',
    diagnostic,
    retryable: false,
    attempts: [{
      attempt: 1,
      startedAt: '2026-07-22T00:00:00.000Z',
      endedAt: '2026-07-22T00:00:01.000Z',
      failureStage: cancellation ? 'cancellation' : 'provider',
      diagnostic,
      retryable: false,
    }],
    retryDisposition: cancellation ? 'cancelled' : 'not-eligible',
    ...(cancellation ? { cancellation } : {}),
  };
  return { ok: false, failure, ...(cancellation ? { cancellation } : {}) };
}

const GATE_VERDICT_OUTCOMES = ['pass', 'pass-with-warnings', 'fail'] as const;

function makeSeams(overrides: Partial<TeamTaskSeams> = {}): Partial<TeamTaskSeams> {
  let latestDiff = greenExecution().then((result) => result.ok ? result.diff : '');
  const runExecution = overrides.runExecution ?? greenExecution;
  const runGit = overrides.runGit ?? (async (args: string[]) => {
    if (args[0] === 'add') return { stdout: '', stderr: '' };
    if (args[0] === 'diff' && args[1] === 'HEAD') {
      return { stdout: await latestDiff, stderr: '' };
    }
    if (args[0] === 'diff' && args[1] === '--name-only' && args[2] === 'HEAD') {
      return { stdout: 'src/x.test.ts\n', stderr: '' };
    }
    throw new Error('runGit not injected in this fixture');
  });
  const runCanonicalGit = overrides.runCanonicalGit ?? overrides.runGit ?? (async (args: string[]) => {
    if (args.includes('add')) return { stdout: '', stderr: '' };
    if (args.includes('write-tree')) {
      return { stdout: `${fixtureTreeOid(await latestDiff)}\n`, stderr: '' };
    }
    if (args.includes('diff') && args.includes('--name-only')) {
      return { stdout: 'src/x.test.ts\n', stderr: '' };
    }
    if (args.includes('diff')) return { stdout: await latestDiff, stderr: '' };
    throw new Error('runCanonicalGit not injected in this fixture');
  });
  return {
    preflightExecution: async () => ({
      status: 'success',
      bindings: [],
      artifactMcp: 'not-required',
      artifactFormats: [],
    }),
    judgmentCall: greenJudgment,
    ...overrides,
    runExecution: async (opts) => {
      const result = await runExecution(opts);
      if (
        opts.workflowStage === 'coder-self-review' &&
        result.ok &&
        result.terminalArtifact === undefined &&
        !result.output.includes('```coder-self-review')
      ) {
        return {
          ok: true,
          diff: await latestDiff,
          output: [
            '```coder-self-review',
            '{"outcome":"confirmed","notes":"The staged worktree is consistent."}',
            '```',
          ].join('\n'),
        };
      }
      if (result.ok) latestDiff = Promise.resolve(result.diff);
      return result;
    },
    // Fail-deterministic: a fixture that doesn't inject runGit must never
    // reach the real git CLI — the test-intent repair path degrades to
    // not-repaired (the legacy QA bounce) instead of touching the host.
    runGit,
    runCanonicalGit,
  };
}

function buildDeps(
  models: TeamRoleModels,
  seams: Partial<TeamTaskSeams> = makeSeams(),
): TeamTaskDeps {
  return buildProductionTeamTaskDeps(
    { sandbox: makeSandbox(), productsConfigPath: '/nonexistent/products.json', models },
    seams,
  );
}

// ---------------------------------------------------------------------------
// Model map (Phase 8 table) — real policies/model-policy.json
// ---------------------------------------------------------------------------

describe('model map — policies/model-policy.json (Phase 8)', () => {
  it('backs every product-team role with a registered model of the right provider and executor', () => {
    const policy = loadRealPolicy();

    // Judgment roles adjudicate on anthropic, through the Claude CLI.
    for (const role of ['pm', 'tech-lead', 'reviewer', 'designer']) {
      const entry = registryEntryForRole(policy, role);
      expect(entry.provider, role).toBe('anthropic');
      expect(entry.format, role).toBe('claude');
    }

    // Artifact roles produce code on openai, through the Codex CLI, and so must
    // be coding-capable or the resolver's hard capability filter drops them.
    for (const role of ['qa', 'coder']) {
      const entry = registryEntryForRole(policy, role);
      expect(entry.provider, role).toBe('openai');
      expect(entry.format, role).toBe('codex');
      expect(entry.capabilities, role).toContain('coding');
    }
  });

  it('resolves every role to the alias its roleDefaults entry declares', () => {
    const policy = loadRealPolicy();
    const models = resolveTeamRoleModels(policy);
    const declared = policy.roleDefaults;

    expect(models.pm).toMatchObject({ alias: declared['pm'], provider: 'anthropic' });
    expect(models.techLead).toMatchObject({ alias: declared['tech-lead'], provider: 'anthropic' });
    expect(models.designer).toMatchObject({ alias: declared['designer'], provider: 'anthropic' });
    // The reviewer resolves to its declared default even under the
    // distinct-from-coder-provider filter — it is not downgraded to a fallback.
    expect(models.reviewer).toMatchObject({ alias: declared['reviewer'], provider: 'anthropic' });

    expect(models.qa).toMatchObject({ alias: declared['qa'], provider: 'openai' });
    expect(models.coder).toMatchObject({ alias: declared['coder'], provider: 'openai' });
  });

  it('coder and reviewer resolve to different providers (independence by construction)', () => {
    const models = resolveTeamRoleModels(loadRealPolicy());
    expect(models.reviewer).not.toBeNull();
    expect(models.coder.provider).not.toBe(models.reviewer?.provider);
  });
});

// ---------------------------------------------------------------------------
// Production factory — all eight seams, none the stub
// ---------------------------------------------------------------------------

describe('buildProductionTeamTaskDeps (Phase 8)', () => {
  it('binds all role seams as functions, including the test-intent repair seam', () => {
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()));

    const seamNames: Array<keyof TeamTaskDeps> = [
      'qaWriteTests',
      'techLeadReviewTests',
      'techLeadRepairTests',
      'coder',
      'reviewer',
      'techLeadReviewDiff',
      'designer',
      'acceptWithRationale',
      'resolveReviewerProvider',
    ];
    for (const name of seamNames) {
      expect(typeof deps[name], `seam ${String(name)}`).toBe('function');
    }
  });

  describe('coder-self-review result contract', () => {
    it('accepts exactly one strict confirmed or revised record', () => {
      expect(parseCoderSelfReviewResult([
        '```coder-self-review',
        '{"outcome":"confirmed","notes":"Validation is green and the change is coherent."}',
        '```',
      ].join('\n'))).toEqual({
        outcome: 'confirmed',
        notes: 'Validation is green and the change is coherent.',
      });
      expect(parseCoderSelfReviewResult([
        '```coder-self-review',
        '{"outcome":"revised","notes":"Corrected the retry guard."}',
        '```',
      ].join('\n')).outcome).toBe('revised');
    });

    it.each([
      ['missing fence', '{"outcome":"confirmed","notes":"ok"}'],
      ['duplicate fence', [
        '```coder-self-review',
        '{"outcome":"confirmed","notes":"ok"}',
        '```',
        '```coder-self-review',
        '{"outcome":"confirmed","notes":"again"}',
        '```',
      ].join('\n')],
      ['unknown outcome', [
        '```coder-self-review',
        '{"outcome":"fixed","notes":"ok"}',
        '```',
      ].join('\n')],
      ['extra diff field', [
        '```coder-self-review',
        '{"outcome":"revised","notes":"ok","diff":"invented"}',
        '```',
      ].join('\n')],
      ['empty notes', [
        '```coder-self-review',
        '{"outcome":"confirmed","notes":"  "}',
        '```',
      ].join('\n')],
      ['oversized notes', [
        '```coder-self-review',
        JSON.stringify({ outcome: 'confirmed', notes: 'x'.repeat(2_001) }),
        '```',
      ].join('\n')],
      ['patch content in notes', [
        '```coder-self-review',
        JSON.stringify({ outcome: 'revised', notes: 'diff --git a/x b/x\n+change' }),
        '```',
      ].join('\n')],
    ])('rejects %s', (_label, reply) => {
      expect(() => parseCoderSelfReviewResult(reply)).toThrow(/coder.self.review/i);
    });

    // The notes are the one free-form field the model controls, and they reach
    // the transcript, durable task records, and the reviewer's handoff notes.
    // The scrub chain has to fire on THIS field, not just be available.
    it('scrubs host paths and secrets out of accepted notes', () => {
      const parsed = parseCoderSelfReviewResult([
        '```coder-self-review',
        JSON.stringify({
          outcome: 'revised',
          notes:
            `Rewrote the guard in ${PROJECT_ROOT}/src/jobs/team-task-deps.ts ` +
            'after the probe token sk-liveSelfReviewNoteFixture0123456789abcdef leaked into the log.',
        }),
        '```',
      ].join('\n'));
      expect(parsed.outcome).toBe('revised');
      expect(parsed.notes).not.toContain(PROJECT_ROOT);
      expect(parsed.notes).not.toContain('sk-liveSelfReviewNoteFixture0123456789abcdef');
      // Still legible — scrubbing must not gut the operator's diagnostic.
      expect(parsed.notes).toContain('team-task-deps.ts');
    });
  });

  // The self-review pass has the same worktree-edit authority as the
  // implementation pass, so it needs the same test-deletion guardrail. It
  // emits no free-form output, so `notes` is its only justification channel.
  it('gives the self-review pass the coder test-deletion guardrail and a notes justification channel', async () => {
    // The static role instruction rides the executor's system channel
    // (`composeRoleContext`), so that is where the guardrail has to land.
    const systemPrompts = new Map<string, string>();
    let currentDiff = '';
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      runExecution: async (opts) => {
        systemPrompts.set(opts.workflowStage ?? 'unknown', opts.systemPrompt ?? '');
        if (opts.workflowStage === 'coder-self-review') {
          return {
            ok: true,
            diff: currentDiff,
            output: [
              '```coder-self-review',
              '{"outcome":"confirmed","notes":"The worktree is ready."}',
              '```',
            ].join('\n'),
          };
        }
        currentDiff =
          'diff --git a/src/x.test.ts b/src/x.test.ts\n+++ b/src/x.test.ts\n+expect(1).toBe(1)\n';
        return { ok: true, diff: currentDiff, output: 'artifact work complete' };
      },
    }));

    await runTeamTaskWorkflow(
      sizedTask,
      { spec: 'spec', contextMd: 'ctx', coderProvider: 'openai', cap: 1 },
      deps,
    );

    const selfReviewInstruction = systemPrompts.get('coder-self-review');
    expect(selfReviewInstruction).toBeDefined();
    expect(selfReviewInstruction).toMatch(/NEVER remove or weaken a test/i);
    expect(selfReviewInstruction).toContain('TEST-REMOVED: <path> — <reason>');
    expect(selfReviewInstruction).toMatch(/inside `notes`/);
  });

  it('resolveReviewerProvider returns the distinct provider from the resolved bindings', () => {
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()));
    expect(deps.resolveReviewerProvider('openai')).toBe('anthropic');
  });

  it('renders suggested changes under actionable retry notes', async () => {
    const prompts: string[] = [];
    const deps = buildDeps(
      resolveTeamRoleModels(loadRealPolicy()),
      makeSeams({
        runExecution: async (opts) => {
          prompts.push(opts.prompt);
          return {
            ok: true,
            diff: 'diff --git a/src/x.test.ts b/src/x.test.ts\n+++ b/src/x.test.ts\n+expect(1).toBe(1)\n',
            output: 'wrote tests',
          };
        },
      }),
    );

    await deps.qaWriteTests({
      task: sizedTask,
      spec: 'spec',
      rejectionFeedback: {
        rejectingRole: 'tech-lead',
        counterpartRole: 'qa',
        rejectedRole: 'qa',
        artifact: 'test-intent',
        rejectedArtifact: 'test-intent',
        reason: 'tests miss retry rejection',
        whatFailed: 'tests miss retry rejection',
        notes: ['tests miss retry rejection'],
        actionableNotes: ['Add a retry-rejection assertion.'],
      },
    });

    expect(prompts[0]).toContain('What failed: tests miss retry rejection');
    expect(prompts[0]).toContain('Actionable notes: Add a retry-rejection assertion.');
  });

  it('renders suggested changes in the open findings ledger', async () => {
    const prompts: string[] = [];
    const deps = buildDeps(
      resolveTeamRoleModels(loadRealPolicy()),
      makeSeams({
        runExecution: async (opts) => {
          prompts.push(opts.prompt);
          return {
            ok: true,
            diff: 'diff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n+export const x = 1\n',
            output: 'implemented',
          };
        },
      }),
    );
    const findingsLedger: FindingsLedgerEntry[] = [{
      id: 'finding-lock',
      sourceGate: 'tech-lead',
      class: 'concurrency',
      severity: 'high',
      location: 'src/jobs/runner.ts:88',
      rationale: 'status update is outside the lock',
      suggestedChange: 'Move the status update inside the lock.',
      reversible: true,
      raisedRound: 1,
      status: 'open',
    }];

    await deps.coder({
      task: sizedTask,
      spec: 'spec',
      context: 'context',
      tests: ['src/x.test.ts'],
      findingsLedger,
    });

    expect(prompts[0]).toContain('Suggested change: Move the status update inside the lock.');
  });

  it('asks reviewer and tech-lead review prompts for suggested changes', async () => {
    const systemPrompts: Array<{ role: string; systemPrompt: string }> = [];
    const deps = buildDeps(
      resolveTeamRoleModels(loadRealPolicy()),
      makeSeams({
        judgmentCall: async ({ role, systemPrompt }) => {
          systemPrompts.push({ role, systemPrompt });
          if (role === 'tech-lead') {
            return [
              '```tl-test-review',
              '{"approved": true, "notes": "ok"}',
              '```',
              '```tl-diff-review',
              '{"outcome": "pass", "findings": []}',
              '```',
            ].join('\n');
          }
          return ['```reviewer-verdict', '{"outcome": "pass", "findings": []}', '```'].join('\n');
        },
      }),
    );

    await deps.techLeadReviewTests({
      task: sizedTask,
      qa: { kind: 'tests-written', testIds: ['src/x.test.ts'] },
    });
    await deps.reviewer({
      diff: 'diff',
      spec: 'spec',
      tests: ['src/x.test.ts'],
      task: sizedTask,
      context: 'context',
      reviewerProvider: 'anthropic',
    });
    await deps.techLeadReviewDiff({
      task: sizedTask,
      diff: 'diff',
      spec: 'spec',
      context: 'context',
    });

    const techLeadPrompts = systemPrompts
      .filter((prompt) => prompt.role === 'tech-lead')
      .map((prompt) => prompt.systemPrompt)
      .join('\n');
    const reviewerPrompt = systemPrompts.find((prompt) => prompt.role === 'reviewer')?.systemPrompt;
    expect(techLeadPrompts).toContain('suggestedChange');
    expect(techLeadPrompts).toContain('concrete change');
    expect(reviewerPrompt).toContain('suggestedChange');
    expect(reviewerPrompt).toContain('concrete change');
  });

  it('fails closed when only a same-provider reviewer is available: reviewer binding is null and the workflow blocks', async () => {
    // A policy with ONLY anthropic models: the reviewer cannot resolve distinct
    // from an anthropic coder. `evaluatorDistinctFromGenerator: false` is
    // irrelevant here — that flag only forces `distinctFromProvider` on the
    // 'evaluator' role; the contract under test is that resolveTeamRoleModels
    // passes `distinctFromProvider: coder.provider` for the REVIEWER role
    // unconditionally, and maps the resolver's cannot-satisfy throw to a null
    // reviewer binding (fail-closed) rather than a same-provider review.
    const anthropicOnly = parsePolicy(
      JSON.stringify({
        models: [
          {
            alias: 'sonnet',
            provider: 'anthropic',
            format: 'claude',
            capabilities: ['coding'],
            costTier: 'medium',
            status: 'active',
          },
        ],
        globalFallback: 'sonnet',
        roleDefaults: {},
        evaluatorDistinctFromGenerator: false,
      }),
    );

    const models = resolveTeamRoleModels(anthropicOnly);
    expect(models.reviewer).toBeNull();

    const deps = buildDeps(models);
    expect(deps.resolveReviewerProvider(models.coder.provider)).toBeNull();

    // Fail-closed end to end: the workflow blocks on independence, it never
    // downgrades to a same-provider review.
    const evidence = await runTeamTaskWorkflow(
      sizedTask,
      { spec: 'spec', contextMd: 'ctx', coderProvider: models.coder.provider, cap: 2 },
      deps,
    );
    expect(evidence.outcome).toBe('blocked');
    expect(evidence.blockedReason).toContain('reviewer independence');
  });

  it('judgment seams parse fenced verdicts from the injected model call (no live call), passing the resolved binding', async () => {
    const calls: Array<{ role: string; model: string; provider?: string; format?: string }> = [];
    const judgment: JudgmentModelCall = async ({ role, model, provider, format }) => {
      calls.push({ role, model, provider, format });
      return GREEN_JUDGMENT_REPLY;
    };
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({ judgmentCall: judgment }));

    const verdict = await deps.reviewer({
      diff: 'diff',
      spec: 'spec',
      tests: ['src/x.test.ts'],
      task: sizedTask,
      context: 'ctx',
      reviewerProvider: 'anthropic',
    });
    expect(verdict).toEqual({ pass: true, objections: [] });

    const tl = await deps.techLeadReviewTests({ task: sizedTask, qa: { kind: 'tests-written', testIds: ['t'] } });
    expect(tl.approved).toBe(true);

    expect(calls.map((c) => c.role)).toEqual(['reviewer', 'tech-lead']);
    // Judgment roles run on their policy-resolved anthropic bindings: reviewer → opus,
    // tech-lead → fable. Both are anthropic/claude.
    const byRole = new Map(calls.map((c) => [c.role, c]));
    expect(byRole.get('reviewer')?.model).toBe('opus');
    expect(byRole.get('tech-lead')?.model).toBe('fable');
    expect(calls.every((c) => c.provider === 'anthropic')).toBe(true);
    expect(calls.every((c) => c.format === 'claude')).toBe(true);
  });

  it('routes coder self-review through the worktree execution agent with the coder binding', async () => {
    const executionCalls: Array<{ role: string; model: string; provider: string; format: string; stage?: string }> = [];
    let currentDiff = '';
    const policy = loadRealPolicy();
    const deps = buildDeps(resolveTeamRoleModels(policy), makeSeams({
      runExecution: async (opts) => {
        executionCalls.push({
          role: opts.role,
          model: opts.model.alias,
          provider: opts.model.provider,
          format: opts.model.format,
          stage: opts.workflowStage,
        });
        if (opts.workflowStage === 'coder-self-review') {
          return {
            ok: true,
            diff: currentDiff,
            output: [
              '```coder-self-review',
              '{"outcome":"confirmed","notes":"The worktree is ready."}',
              '```',
            ].join('\n'),
          };
        }
        currentDiff =
          'diff --git a/src/x.test.ts b/src/x.test.ts\n+++ b/src/x.test.ts\n+expect(1).toBe(1)\n';
        return { ok: true, diff: currentDiff, output: 'artifact work complete' };
      },
    }));

    const evidence = await runTeamTaskWorkflow(
      sizedTask,
      { spec: 'spec', contextMd: 'ctx', coderProvider: 'openai', cap: 1 },
      deps,
    );

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(executionCalls).toContainEqual({
      role: 'coder',
      model: policy.roleDefaults['coder'],
      provider: 'openai',
      format: 'codex',
      stage: 'coder-self-review',
    });
    expect(executionCalls.filter((call) => call.role === 'coder')).toHaveLength(2);
  });

  it.each([
    {
      outcome: 'confirmed' as const,
      beforeTree: 'tree-before',
      afterTree: 'tree-before',
      canonicalDiff: 'diff --git a/src/x.ts b/src/x.ts\n+confirmed\n',
    },
    {
      outcome: 'revised' as const,
      beforeTree: 'tree-before',
      afterTree: 'tree-after',
      canonicalDiff: 'diff --git a/src/x.ts b/src/x.ts\n+revised\n',
    },
  ])(
    'runs a fresh worktree coder self-review and returns canonical state for $outcome',
    async ({ outcome, beforeTree, afterTree, canonicalDiff }) => {
      let tree = beforeTree;
      const execution = vi.fn(async (opts): Promise<ExecutionAgentResult> => {
        expect(opts).toMatchObject({
          role: 'coder',
          workflowStage: 'coder-self-review',
          model: resolveTeamRoleModels(loadRealPolicy()).coder,
        });
        expect(opts.prompt).toContain('## Task');
        expect(opts.prompt).toContain('## Spec');
        expect(opts.prompt).toContain('## Project context');
        expect(opts.prompt).toContain('## QA intent');
        expect(opts.prompt).toContain('## QA tests or rationale');
        tree = afterTree;
        return {
          ok: true,
          diff: canonicalDiff,
          output: [
            '```coder-self-review',
            JSON.stringify({ outcome, notes: `${outcome} after inspecting the worktree.` }),
            '```',
          ].join('\n'),
        };
      });
      const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
        runExecution: execution,
        runCanonicalGit: async (args) => {
          if (args.includes('write-tree')) {
            return { stdout: `${fixtureTreeOid(tree)}\n`, stderr: '' };
          }
          if (args.includes('--name-only')) return { stdout: 'src/x.ts\n', stderr: '' };
          if (args.includes('diff')) return { stdout: canonicalDiff, stderr: '' };
          return { stdout: '', stderr: '' };
        },
      }));

      const result = await deps.coderSelfReview({
        task: sizedTask,
        artifact: { diff: 'candidate text is non-authoritative', handoffNotes: ['implemented'] },
        spec: 'spec',
        context: 'context',
        tests: ['src/x.test.ts'],
        qa: { kind: 'tests-written', testIds: ['src/x.test.ts'] },
        rejectionFeedback: [{
          rejectingRole: 'reviewer',
          counterpartRole: 'coder',
          rejectedRole: 'coder',
          artifact: 'implementation-diff',
          rejectedArtifact: 'implementation-diff',
          reason: 'fix retry guard',
          whatFailed: 'fix retry guard',
          notes: ['fix retry guard'],
          actionableNotes: ['add the missing guard'],
        }],
        findingsLedger: [{
          id: 'finding-guard',
          sourceGate: 'reviewer',
          class: 'data-integrity',
          severity: 'high',
          location: 'src/x.ts:1',
          rationale: 'guard is missing',
          reversible: true,
          raisedRound: 1,
          status: 'open',
        }],
      });

      expect(execution).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        outcome,
        reviewState: {
          diff: canonicalDiff,
          changedPaths: ['src/x.ts'],
        },
      });
      expect(result.reviewState.hash).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it('preserves edits made by the self-review execution in the real worktree', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'coder-self-review-edit-'));
    try {
      const git = (args: string[]) => defaultRunGit(args, { cwd: worktree });
      await git(['init', '--initial-branch', 'main']);
      await git(['config', 'user.email', 'test@example.com']);
      await git(['config', 'user.name', 'Test']);
      await writeFile(join(worktree, 'src.ts'), 'export const ready = false;\n');
      await git(['add', '-A']);
      await git(['commit', '-m', 'baseline']);
      const taskBaseTree = (await git(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
      await writeFile(join(worktree, 'src.ts'), 'export const ready = false; // implementation\n');

      const deps = buildProductionTeamTaskDeps({
        sandbox: { ...makeSandbox(), worktree },
        productsConfigPath: '/nonexistent/products.json',
        models: resolveTeamRoleModels(loadRealPolicy()),
        taskBaseTree,
        validationCommands: ['npm test'],
      }, makeSeams({
        runCanonicalGit: defaultRunGit,
        runExecution: async (opts) => {
          expect(opts.prompt).toContain('## Validation commands');
          expect(opts.prompt).toContain('npm test');
          await writeFile(join(worktree, 'src.ts'), 'export const ready = true;\n');
          return {
            ok: true,
            diff: 'executor diff is ignored',
            output: [
              '```coder-self-review',
              '{"outcome":"revised","notes":"Corrected the readiness value."}',
              '```',
            ].join('\n'),
          };
        },
      }));

      const result = await deps.coderSelfReview({
        task: sizedTask,
        artifact: { diff: 'candidate', handoffNotes: [] },
        spec: 'spec',
        context: 'context',
        tests: ['src.test.ts'],
        qa: { kind: 'tests-written', testIds: ['src.test.ts'] },
      });

      expect(result.outcome).toBe('revised');
      expect(result.reviewState.diff).toContain('export const ready = true;');
      expect(await readFile(join(worktree, 'src.ts'), 'utf8')).toBe(
        'export const ready = true;\n',
      );
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  // The post-pass snapshot is what stops edits from a failed self-review being
  // quietly reviewed, so it must run for EVERY throw out of the executor — not
  // just the cancellation the seam knows how to name.
  it('snapshots the worktree even when the self-review executor throws an unexpected error', async () => {
    const canonicalCalls: string[][] = [];
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      runExecution: async () => {
        throw new Error('sandbox runtime exploded');
      },
      runCanonicalGit: async (args) => {
        canonicalCalls.push(args);
        if (args.includes('write-tree')) return { stdout: 'tree-x\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
    }));

    await expect(deps.coderSelfReview({
      task: sizedTask,
      artifact: { diff: 'candidate', handoffNotes: [] },
      spec: 'spec',
      context: 'context',
      tests: ['src/x.test.ts'],
      qa: { kind: 'tests-written', testIds: ['src/x.test.ts'] },
    })).rejects.toThrow(/coder self-review failed: sandbox runtime exploded/);

    // Twice: the pre-pass baseline and the post-pass snapshot taken after the
    // throw was caught and held.
    expect(canonicalCalls.filter((args) => args.includes('write-tree'))).toHaveLength(2);
    expect(canonicalCalls.filter((args) => args.includes('add'))).toHaveLength(2);
  });

  it.each([
    ['confirmed', 'tree-after'],
    ['revised', 'tree-before'],
  ] as const)('fails closed when reported %s disagrees with canonical Git', async (outcome, afterTree) => {
    let writeTreeCalls = 0;
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      runExecution: async () => ({
        ok: true,
        diff: 'diff',
        output: [
          '```coder-self-review',
          JSON.stringify({ outcome, notes: 'Reported result.' }),
          '```',
        ].join('\n'),
      }),
      runCanonicalGit: async (args) => {
        if (args.includes('write-tree')) {
          writeTreeCalls += 1;
          return {
            stdout: `${writeTreeCalls === 1 ? 'tree-before' : afterTree}\n`,
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      },
    }));

    await expect(deps.coderSelfReview({
      task: sizedTask,
      artifact: { diff: 'candidate', handoffNotes: [] },
      spec: 'spec',
      context: 'context',
      tests: ['test'],
      qa: { kind: 'tests-written', testIds: ['test'] },
    })).rejects.toThrow(/reported .* canonical Git/i);
  });

  it('fails operationally when the self-review executor fails after editing', async () => {
    let tree = 'tree-before';
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      runExecution: async () => {
        tree = 'tree-after-edit';
        return failedExecution('provider failed after editing');
      },
      runCanonicalGit: async (args) => {
        if (args.includes('write-tree')) return { stdout: `${tree}\n`, stderr: '' };
        return { stdout: '', stderr: '' };
      },
    }));

    await expect(deps.coderSelfReview({
      task: sizedTask,
      artifact: { diff: 'candidate', handoffNotes: [] },
      spec: 'spec',
      context: 'context',
      tests: ['test'],
      qa: { kind: 'tests-written', testIds: ['test'] },
    })).rejects.toThrow(/provider failed after editing/i);
    expect(tree).toBe('tree-after-edit');
  });

  it('returns typed artifact-contract cancellation evidence from the self-review executor', async () => {
    const cancellation = {
      operationId: '12345678-1234-1234-1234-123456789abc',
      source: 'cockpit' as const,
      requestedAt: '2026-07-28T12:00:00.000Z',
    };
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      runExecution: async () => failedExecution('cancelled by operator', cancellation),
      runCanonicalGit: async (args) => {
        if (args.includes('write-tree')) return { stdout: 'tree-before\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
    }));

    await expect(deps.coderSelfReview({
      task: sizedTask,
      artifact: { diff: 'candidate', handoffNotes: [] },
      spec: 'spec',
      context: 'context',
      tests: ['test'],
      qa: { kind: 'tests-written', testIds: ['test'] },
    })).rejects.toMatchObject({
      failure: {
        failureStage: 'artifact-contract',
        retryDisposition: 'cancelled',
        cancellation,
        artifactAttempts: [
          expect.objectContaining({ attempt: 1, status: 'rejected' }),
        ],
      },
    });
  });

  it('fails closed when canonical Git cannot snapshot the self-review state', async () => {
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      runCanonicalGit: async (args) => {
        if (args.includes('write-tree')) throw new Error('canonical Git unavailable');
        return { stdout: '', stderr: '' };
      },
    }));

    await expect(deps.coderSelfReview({
      task: sizedTask,
      artifact: { diff: 'candidate', handoffNotes: [] },
      spec: 'spec',
      context: 'context',
      tests: ['test'],
      qa: { kind: 'tests-written', testIds: ['test'] },
    })).rejects.toThrow(/canonical Git unavailable/i);
  });

  it('fails closed through the strict parser when the self-review executor returns malformed coder-self-review JSON', async () => {
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      runExecution: async () => ({
        ok: true,
        diff: 'diff',
        output: [
          '```coder-self-review',
          // Missing the required `notes` field — the executor output must be
          // rejected by the same strict parser `parseCoderSelfReviewResult`
          // enforces standalone, proving the production seam actually wires
          // it in rather than trusting the model-returned text.
          '{"outcome":"confirmed"}',
          '```',
        ].join('\n'),
      }),
    }));

    await expect(deps.coderSelfReview({
      task: sizedTask,
      artifact: { diff: 'candidate', handoffNotes: [] },
      spec: 'spec',
      context: 'context',
      tests: ['test'],
      qa: { kind: 'tests-written', testIds: ['test'] },
    })).rejects.toThrow(/artifact-contract:.*outcome and notes/i);
  });

  it('retries only self-review once on an unchanged tree and persists a fresh evidence-bearing checkpoint', async () => {
    const persisted: ExecutionCheckpoint[] = [];
    const activities: WorkflowActivityEvent[] = [];
    let calls = 0;
    const stableDiff =
      'diff --git a/src/x.test.ts b/src/x.test.ts\n+++ b/src/x.test.ts\n+expect(1).toBe(1)\n';
    const deps = buildProductionTeamTaskDeps({
      sandbox: makeSandbox(),
      productsConfigPath: '/nonexistent/products.json',
      models: resolveTeamRoleModels(loadRealPolicy()),
      emit: (event) => activities.push(event),
      persistExecutionCheckpoint: async (checkpoint) => {
        if (checkpoint.workflowStage === 'coder-self-review') persisted.push(checkpoint);
      },
    }, makeSeams({
      runExecution: async (opts) => {
        if (opts.workflowStage !== 'coder-self-review') return greenExecution();
        calls += 1;
        if (calls === 1) {
          return {
            ok: true,
            diff: stableDiff,
            output: 'progress remains separate',
            terminalArtifact: {
              provider: 'openai',
              artifactKind: 'coder-self-review',
              status: 'malformed',
              progressCount: 1,
              candidateCount: 1,
              diagnostic:
                'terminal message at /Users/operator/private had trailing prose sk-supersecret123',
            },
          };
        }
        return {
          ok: true,
          diff: stableDiff,
          output: 'second pass progress',
          terminalArtifact: {
            provider: 'openai',
            artifactKind: 'coder-self-review',
            status: 'captured',
            progressCount: 1,
            candidateCount: 1,
            diagnostic: 'captured final completed Codex agent message',
            artifact: [
              '```coder-self-review',
              '{"outcome":"confirmed","notes":"The unchanged worktree is correct."}',
              '```',
            ].join('\n'),
          },
        };
      },
    }));

    const result = await deps.coderSelfReview({
      task: sizedTask,
      artifact: { diff: 'candidate', handoffNotes: [] },
      spec: 'spec',
      context: 'context',
      tests: ['test'],
      qa: { kind: 'tests-written', testIds: ['test'] },
    });

    expect(calls).toBe(2);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.artifactAttempts).toBeUndefined();
    expect(persisted[1]?.artifactAttempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: 'malformed',
        progressCount: 1,
        candidateCount: 1,
      }),
    ]);
    expect(result.artifactAttempts).toEqual([
      expect.objectContaining({ attempt: 1, status: 'malformed' }),
      expect.objectContaining({ attempt: 2, status: 'parsed' }),
    ]);
    expect(JSON.stringify(result.artifactAttempts)).not.toContain('/Users/operator');
    expect(JSON.stringify(result.artifactAttempts)).not.toContain('sk-supersecret123');
    expect(activities.filter((event) =>
      event.kind === 'activity' && event.data?.['event'] === 'terminal-artifact')
      .map((event) => event.data?.['status'])).toEqual(['malformed', 'parsed']);
    expect(activities).toContainEqual(expect.objectContaining({
      kind: 'activity',
      data: expect.objectContaining({ event: 'artifact-retry', nextAttempt: 2 }),
    }));
  });

  it('fails with typed exhausted evidence after exactly two invalid unchanged-tree artifacts', async () => {
    let calls = 0;
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      runExecution: async () => {
        calls += 1;
        const stable = await greenExecution();
        if (!stable.ok) throw new Error('green execution fixture unexpectedly failed');
        return {
          ok: true,
          diff: stable.diff,
          output: 'bounded progress',
          terminalArtifact: {
            provider: 'openai',
            artifactKind: 'coder-self-review',
            status: 'missing',
            progressCount: 1,
            candidateCount: 0,
            diagnostic: `attempt ${calls} had no terminal artifact`,
          },
        };
      },
    }));

    let caught: unknown;
    try {
      await deps.coderSelfReview({
        task: sizedTask,
        artifact: { diff: 'candidate', handoffNotes: [] },
        spec: 'spec',
        context: 'context',
        tests: ['test'],
        qa: { kind: 'tests-written', testIds: ['test'] },
      });
    } catch (err) {
      caught = err;
    }

    expect(calls).toBe(2);
    expect(caught).toBeInstanceOf(ExecutionFailureError);
    expect((caught as ExecutionFailureError).failure).toMatchObject({
      failureStage: 'artifact-contract',
      retryDisposition: 'exhausted',
      artifactAttempts: [
        expect.objectContaining({ attempt: 1, status: 'missing' }),
        expect.objectContaining({ attempt: 2, status: 'missing' }),
      ],
      attempts: [
        expect.objectContaining({ attempt: 1, retryable: true }),
        expect.objectContaining({ attempt: 2, retryable: false }),
      ],
    });
  });

  it('keeps the artifact-contract failure when the self-review-only retry hits a provider failure', async () => {
    let calls = 0;
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      runExecution: async () => {
        calls += 1;
        if (calls === 2) return failedExecution('retry provider failed at /Users/operator/private');
        const stable = await greenExecution();
        if (!stable.ok) throw new Error('green execution fixture unexpectedly failed');
        return {
          ...stable,
          terminalArtifact: {
            provider: 'openai',
            artifactKind: 'coder-self-review',
            status: 'missing',
            progressCount: 1,
            candidateCount: 0,
            diagnostic: 'first attempt had no terminal artifact',
          },
        };
      },
    }));

    let caught: unknown;
    try {
      await deps.coderSelfReview({
        task: sizedTask,
        artifact: { diff: 'candidate', handoffNotes: [] },
        spec: 'spec',
        context: 'context',
        tests: ['test'],
        qa: { kind: 'tests-written', testIds: ['test'] },
      });
    } catch (err) {
      caught = err;
    }

    expect(calls).toBe(2);
    expect(caught).toBeInstanceOf(ExecutionFailureError);
    expect((caught as ExecutionFailureError).failure).toMatchObject({
      failureStage: 'artifact-contract',
      retryDisposition: 'exhausted',
      artifactAttempts: [
        expect.objectContaining({ attempt: 1, status: 'missing' }),
        expect.objectContaining({
          attempt: 2,
          status: 'rejected',
          diagnostic: expect.stringContaining('retry provider failed'),
        }),
      ],
      attempts: [
        expect.objectContaining({ attempt: 1, retryable: true }),
        expect.objectContaining({ attempt: 2, retryable: false }),
      ],
    });
    expect(JSON.stringify((caught as ExecutionFailureError).failure))
      .not.toContain('/Users/operator');
  });

  it('keeps the artifact-contract failure when the retry checkpoint cannot be persisted', async () => {
    let executions = 0;
    let checkpoints = 0;
    const deps = buildProductionTeamTaskDeps({
      sandbox: makeSandbox(),
      productsConfigPath: '/nonexistent/products.json',
      models: resolveTeamRoleModels(loadRealPolicy()),
      persistExecutionCheckpoint: async (checkpoint) => {
        if (checkpoint.workflowStage !== 'coder-self-review') return;
        checkpoints += 1;
        if (checkpoints === 2) throw new Error('checkpoint storage unavailable');
      },
    }, makeSeams({
      runExecution: async () => {
        executions += 1;
        const stable = await greenExecution();
        if (!stable.ok) throw new Error('green execution fixture unexpectedly failed');
        return {
          ...stable,
          terminalArtifact: {
            provider: 'openai',
            artifactKind: 'coder-self-review',
            status: 'missing',
            progressCount: 0,
            candidateCount: 0,
            diagnostic: 'first attempt had no terminal artifact',
          },
        };
      },
    }));

    let caught: unknown;
    try {
      await deps.coderSelfReview({
        task: sizedTask,
        artifact: { diff: 'candidate', handoffNotes: [] },
        spec: 'spec',
        context: 'context',
        tests: ['test'],
        qa: { kind: 'tests-written', testIds: ['test'] },
      });
    } catch (err) {
      caught = err;
    }

    expect(checkpoints).toBe(2);
    expect(executions).toBe(1);
    expect(caught).toBeInstanceOf(ExecutionFailureError);
    expect((caught as ExecutionFailureError).failure).toMatchObject({
      failureStage: 'artifact-contract',
      retryDisposition: 'exhausted',
      artifactAttempts: [
        expect.objectContaining({ attempt: 1, status: 'missing' }),
        expect.objectContaining({
          attempt: 2,
          status: 'rejected',
          diagnostic: expect.stringContaining('checkpoint write failed'),
        }),
      ],
    });
  });

  it('records each artifact attempt with its own timing and actual retry decision', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-30T10:00:00.000Z'));
      let calls = 0;
      const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
        runExecution: async () => {
          calls += 1;
          vi.setSystemTime(new Date(
            calls === 1
              ? '2026-07-30T10:00:01.000Z'
              : '2026-07-30T10:00:03.000Z',
          ));
          const stable = await greenExecution();
          if (!stable.ok) throw new Error('green execution fixture unexpectedly failed');
          return {
            ...stable,
            terminalArtifact: {
              provider: 'openai',
              artifactKind: 'coder-self-review',
              status: 'missing',
              progressCount: 0,
              candidateCount: 0,
              diagnostic: `attempt ${calls} missing`,
            },
          };
        },
      }));

      let caught: unknown;
      try {
        await deps.coderSelfReview({
          task: sizedTask,
          artifact: { diff: 'candidate', handoffNotes: [] },
          spec: 'spec',
          context: 'context',
          tests: ['test'],
          qa: { kind: 'tests-written', testIds: ['test'] },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ExecutionFailureError);
      expect((caught as ExecutionFailureError).failure.attempts).toEqual([
        expect.objectContaining({
          attempt: 1,
          startedAt: '2026-07-30T10:00:00.000Z',
          endedAt: '2026-07-30T10:00:01.000Z',
          retryable: true,
        }),
        expect.objectContaining({
          attempt: 2,
          startedAt: '2026-07-30T10:00:01.000Z',
          endedAt: '2026-07-30T10:00:03.000Z',
          retryable: false,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats artifact activity emission as non-fatal observability', async () => {
    const deps = buildProductionTeamTaskDeps({
      sandbox: makeSandbox(),
      productsConfigPath: '/nonexistent/products.json',
      models: resolveTeamRoleModels(loadRealPolicy()),
      emit: (event) => {
        if (event.kind === 'activity' && event.data?.['event'] === 'terminal-artifact') {
          throw new Error('transcript sink unavailable');
        }
      },
    }, makeSeams());

    await expect(deps.coderSelfReview({
      task: sizedTask,
      artifact: { diff: 'candidate', handoffNotes: [] },
      spec: 'spec',
      context: 'context',
      tests: ['test'],
      qa: { kind: 'tests-written', testIds: ['test'] },
    })).resolves.toMatchObject({ outcome: 'confirmed' });
  });

  it('does not retry a malformed artifact after the self-review changed the canonical tree', async () => {
    let tree = 'before';
    let calls = 0;
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      runExecution: async () => {
        calls += 1;
        tree = 'after';
        return {
          ok: true,
          diff: '',
          output: [
            '```coder-self-review',
            '{"outcome":"confirmed","notes":"Tree review complete."}',
            '```',
            'trailing prose',
          ].join('\n'),
        };
      },
      runCanonicalGit: async (args) => {
        if (args.includes('write-tree')) {
          return { stdout: `${fixtureTreeOid(tree)}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    }));

    let caught: unknown;
    try {
      await deps.coderSelfReview({
        task: sizedTask,
        artifact: { diff: 'candidate', handoffNotes: [] },
        spec: 'spec',
        context: 'context',
        tests: ['test'],
        qa: { kind: 'tests-written', testIds: ['test'] },
      });
    } catch (err) {
      caught = err;
    }

    expect(calls).toBe(1);
    expect(caught).toBeInstanceOf(ExecutionFailureError);
    expect((caught as ExecutionFailureError).failure).toMatchObject({
      failureStage: 'artifact-contract',
      retryDisposition: 'worktree-changed',
      artifactAttempts: [expect.objectContaining({ attempt: 1 })],
    });
  });

  it('persists a coder-self-review-scoped checkpoint and passes it verbatim to the self-review executor', async () => {
    let persisted: unknown;
    let invoked: unknown;
    const deps = buildProductionTeamTaskDeps({
      sandbox: makeSandbox(),
      productsConfigPath: '/nonexistent/products.json',
      models: resolveTeamRoleModels(loadRealPolicy()),
      persistExecutionCheckpoint: async (checkpoint) => {
        if (checkpoint.workflowStage === 'coder-self-review') persisted = checkpoint;
      },
    }, makeSeams({
      runExecution: async (opts) => {
        if (opts.workflowStage === 'coder-self-review') invoked = opts.checkpoint;
        return greenExecution();
      },
    }));

    const result = await deps.coderSelfReview({
      task: sizedTask,
      artifact: { diff: 'candidate', handoffNotes: [] },
      spec: 'spec',
      context: 'context',
      tests: ['test'],
      qa: { kind: 'tests-written', testIds: ['test'] },
    });

    expect(result.outcome).toBe('confirmed');
    expect(persisted).toBeDefined();
    expect(invoked).toBe(persisted);
    expect(invoked).toMatchObject({
      taskId: sizedTask.id,
      role: 'coder',
      workflowStage: 'coder-self-review',
    });
  });

  it('blocks the self-review executor and fails closed when checkpoint persistence fails for the coder-self-review stage', async () => {
    let selfReviewExecutorCalled = false;
    const runExecution = vi.fn(async (opts) => {
      if (opts.workflowStage === 'coder-self-review') selfReviewExecutorCalled = true;
      return greenExecution();
    });
    const deps = buildProductionTeamTaskDeps({
      sandbox: makeSandbox(),
      productsConfigPath: '/nonexistent/products.json',
      models: resolveTeamRoleModels(loadRealPolicy()),
      persistExecutionCheckpoint: async (checkpoint) => {
        if (checkpoint.workflowStage === 'coder-self-review') {
          throw new Error('/Users/private/operator/cursor write failed');
        }
      },
    }, makeSeams({ runExecution }));

    let caught: unknown;
    try {
      await deps.coderSelfReview({
        task: sizedTask,
        artifact: { diff: 'candidate', handoffNotes: [] },
        spec: 'spec',
        context: 'context',
        tests: ['test'],
        qa: { kind: 'tests-written', testIds: ['test'] },
      });
    } catch (err) {
      caught = err;
    }

    expect(selfReviewExecutorCalled).toBe(false);
    expect(caught).toBeInstanceOf(ExecutionFailureError);
    expect((caught as ExecutionFailureError).failure).toMatchObject({
      role: 'coder',
      workflowStage: 'coder-self-review',
      failureStage: 'orchestration-adjacent',
    });
    expect((caught as ExecutionFailureError).failure.diagnostic).not.toContain('/Users/private/operator');
  });

  it('prompts reviewer re-review to verify prior findings before discovery and return cited verification statuses', async () => {
    const reviewerPrompts: Array<{ systemPrompt: string; message: string }> = [];
    const priorFinding: FindingsLedgerEntry = {
      id: 'finding-reviewer-security-auth-42',
      sourceGate: 'reviewer',
      class: 'security',
      severity: 'high',
      location: 'src/auth.ts:42',
      rationale: 'token comparison leaks timing information',
      reversible: true,
      raisedRound: 1,
      status: 'open',
    };
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role, systemPrompt, message }) => {
        if (role !== 'reviewer') return GREEN_JUDGMENT_REPLY;
        reviewerPrompts.push({ systemPrompt, message });
        return [
          '```reviewer-verdict',
          JSON.stringify({
            outcome: 'pass',
            findings: [],
            verifiedFindings: [
              {
                id: priorFinding.id,
                status: 'resolved',
                notes: 'verified the timing-safe comparison now covers this finding',
              },
            ],
          }),
          '```',
        ].join('\n');
      },
    }));

    const verdictPromise = deps.reviewer({
      diff: 'diff --git a/src/auth.ts b/src/auth.ts\n+++ b/src/auth.ts\n+timingSafeEqual(a, b)\n',
      spec: 'Auth comparisons must not leak timing information.',
      tests: ['src/auth.test.ts'],
      task: sizedTask,
      context: 'ctx',
      reviewerProvider: 'anthropic',
      findingsLedger: [priorFinding],
    });

    const verdict = await verdictPromise;
    expect(reviewerPrompts).toHaveLength(1);
    const prompt = `${reviewerPrompts[0]?.systemPrompt ?? ''}\n\n${reviewerPrompts[0]?.message ?? ''}`;
    const lowerPrompt = prompt.toLowerCase();
    const regressionIndex = lowerPrompt.indexOf('regression pass');
    const discoveryIndex = lowerPrompt.indexOf('discovery pass');

    expect(regressionIndex).toBeGreaterThanOrEqual(0);
    expect(discoveryIndex).toBeGreaterThanOrEqual(0);
    expect(regressionIndex).toBeLessThan(discoveryIndex);
    expect(prompt).toContain('verifiedFindings');
    expect(prompt).toContain('resolved');
    expect(prompt).toContain('open');
    expect(prompt).toContain('regressed');
    expect(prompt).toContain(priorFinding.id);
    expect(prompt).toContain(priorFinding.location);
    expect(prompt).toContain(priorFinding.rationale);
    expect(verdict).toMatchObject({
      outcome: 'pass',
      verifiedFindings: [
        {
          id: priorFinding.id,
          status: 'resolved',
          notes: expect.stringContaining('timing-safe'),
        },
      ],
    });
  });

  it('instructs the reviewer that the full-task diff makes absence meaningful without claiming repo access', async () => {
    // Regression: the reviewer is a text-only judge with no tools, yet it raised
    // a critical objection claiming a symbol was "exported nowhere (verified via
    // grep over src/)" — a fabricated verification against a partial diff that
    // did not match the committed tree. The instruction must forbid both.
    let reviewerSystemPrompt = '';
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role, systemPrompt }) => {
        if (role !== 'reviewer') return GREEN_JUDGMENT_REPLY;
        reviewerSystemPrompt = systemPrompt;
        return ['```reviewer-verdict', JSON.stringify({ outcome: 'pass', findings: [] }), '```'].join('\n');
      },
    }));

    await deps.reviewer({
      diff: 'diff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n+export const x = 1;\n',
      spec: 'spec',
      tests: ['src/x.test.ts'],
      task: sizedTask,
      context: 'ctx',
      reviewerProvider: 'anthropic',
      findingsLedger: [],
    });

    const lower = reviewerSystemPrompt.toLowerCase();
    // No fabricated verification — the reviewer has no tools.
    expect(lower).toContain('no tools');
    expect(lower).toContain('no repository access');
    expect(lower).toContain('fabrication');
    expect(lower).toContain('complete implementation for this task');
    expect(lower).toContain('durable');
    expect(lower).toContain('absence from this');
    expect(lower).toContain('artifact is therefore');
    expect(lower).toContain('genuine signal');
    // Test-deletion guardrail: an unjustified deleted/weakened test is an
    // ordinary fail, judged against the coder's handoff-note justification.
    expect(lower).toContain('test-deletion guardrail');
    expect(lower).toContain('deletes or weakens a test');
    expect(lower).toContain('coder handoff notes');
    expect(lower).toContain('fail outcome');
    expect(lower).toContain('not an objection class');
  });

  it('instructs the tech-lead diff gate to judge the complete task artifact', async () => {
    // Regression: a task deliverable already present on the branch was absent
    // from the current task diff, so the tech-lead diff gate kept treating the
    // task as incomplete and the workflow exhausted the round cap.
    let techLeadSystemPrompt = '';
    let techLeadMessage = '';
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role, systemPrompt, message }) => {
        if (role !== 'tech-lead') return GREEN_JUDGMENT_REPLY;
        techLeadSystemPrompt = systemPrompt;
        techLeadMessage = message;
        return [
          '```tl-diff-review',
          JSON.stringify({ outcome: 'pass', findings: [] }),
          '```',
        ].join('\n');
      },
    }));

    await deps.techLeadReviewDiff({
      task: sizedTask,
      diff: 'diff --git a/src/other.ts b/src/other.ts\n+++ b/src/other.ts\n+export const touched = true;\n',
      spec: 'The task requires BusRunEvent typing.',
      context: 'Tree-state evidence: BusRunEvent typing already exists in src/transport/notification-bus.ts.',
    });

    const lowerPrompt = techLeadSystemPrompt.toLowerCase();
    expect(lowerPrompt).toContain('no tools');
    expect(lowerPrompt).toContain('no repository access');
    expect(lowerPrompt).toContain('complete implementation for this task');
    expect(lowerPrompt).toContain('durable');
    expect(lowerPrompt).toContain('earlier coder');
    expect(lowerPrompt).toContain('absent from this full-task artifact');
    expect(lowerPrompt).toContain('test-deletion guardrail');
    expect(lowerPrompt).toContain('deletes or weakens a test');
    expect(lowerPrompt).toContain('coder handoff notes');
    expect(lowerPrompt).toContain('fail outcome');

    expect(techLeadMessage).toContain('## Spec');
    expect(techLeadMessage).toContain('BusRunEvent typing');
    expect(techLeadMessage).toContain('## Project context / tree-state evidence');
    expect(techLeadMessage).toContain('already exists in src/transport/notification-bus.ts');
  });

  it('renders the product validation commands in the coder prompt with the drive-green directive', async () => {
    const captured: Array<{ systemPrompt: string; prompt: string }> = [];
    const deps = buildProductionTeamTaskDeps(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        models: resolveTeamRoleModels(loadRealPolicy()),
        validationCommands: ['npm run build', 'npm test'],
        validationCommandCwd: '/validated/worktree/harness',
        validationCwdLabel: 'harness/',
      },
      makeSeams({
        runExecution: async (opts) => {
          captured.push({ systemPrompt: opts.systemPrompt ?? '', prompt: opts.prompt });
          return greenExecution();
        },
      }),
    );

    await deps.coder({ task: sizedTask, spec: 'spec', context: 'ctx', tests: ['src/x.test.ts'] });

    expect(captured).toHaveLength(1);
    const { systemPrompt, prompt } = captured[0]!;
    expect(prompt).toContain('## Validation commands');
    expect(prompt).toContain('run all from `harness/` relative to the worktree');
    expect(prompt).toContain('npm run build');
    expect(prompt).toContain('npm test');
    const lower = systemPrompt.toLowerCase();
    expect(lower).toContain('exit 0');
    expect(lower).toContain('fix → re-run');
    expect(lower).toContain('definition of done');
  });

  it('omits the validation-commands section when the product has none, keeping the skip clause', async () => {
    const captured: Array<{ systemPrompt: string; prompt: string }> = [];
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      runExecution: async (opts) => {
        captured.push({ systemPrompt: opts.systemPrompt ?? '', prompt: opts.prompt });
        return greenExecution();
      },
    }));

    await deps.coder({ task: sizedTask, spec: 'spec', context: 'ctx', tests: ['src/x.test.ts'] });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.prompt).not.toContain('## Validation commands');
    expect(captured[0]!.systemPrompt.toLowerCase()).toContain('if no validation commands are listed');
  });

  it('forbids the coder from removing a test its implementation fails and requires TEST-REMOVED records', async () => {
    const systemPrompts: string[] = [];
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      runExecution: async (opts) => {
        systemPrompts.push(opts.systemPrompt ?? '');
        return greenExecution();
      },
    }));

    await deps.coder({ task: sizedTask, spec: 'spec', context: 'ctx', tests: ['src/x.test.ts'] });

    const systemPrompt = systemPrompts[0] ?? '';
    expect(systemPrompt).toContain('TEST-REMOVED:');
    const lower = systemPrompt.toLowerCase();
    expect(lower).toContain('never remove or weaken a test');
    expect(lower).toContain('manual-live-gate');
  });

  it('carries the coder handoff notes into the reviewer and tech-lead diff bodies', async () => {
    const messages: Array<{ role: string; message: string }> = [];
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role, message }) => {
        messages.push({ role, message });
        return GREEN_JUDGMENT_REPLY;
      },
    }));
    const note = 'TEST-REMOVED: src/live.test.ts — hits live Stripe API; converted to manual-live-gate';

    await deps.reviewer({
      diff: 'diff',
      spec: 'spec',
      tests: ['src/x.test.ts'],
      task: sizedTask,
      context: 'ctx',
      reviewerProvider: 'anthropic',
      coderHandoffNotes: [note],
    });
    await deps.techLeadReviewDiff({ task: sizedTask, diff: 'diff', coderHandoffNotes: [note] });

    const reviewerMessage = messages.find((entry) => entry.role === 'reviewer')?.message ?? '';
    const techLeadMessage = messages.find((entry) => entry.role === 'tech-lead')?.message ?? '';
    expect(reviewerMessage).toContain('## Coder handoff notes');
    expect(reviewerMessage).toContain(note);
    expect(techLeadMessage).toContain('## Coder handoff notes');
    expect(techLeadMessage).toContain(note);

    // Omitted notes ⇒ no section.
    messages.length = 0;
    await deps.reviewer({
      diff: 'diff',
      spec: 'spec',
      tests: ['src/x.test.ts'],
      task: sizedTask,
      context: 'ctx',
      reviewerProvider: 'anthropic',
    });
    expect(messages.find((entry) => entry.role === 'reviewer')?.message ?? '').not.toContain('## Coder handoff notes');
  });

  it('labels reviewer, tech-lead, and designer bodies with the full-task base/current tree and hash identities', async () => {
    const messages: Array<{ role: string; message: string }> = [];
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role, message }) => {
        messages.push({ role, message });
        return GREEN_JUDGMENT_REPLY;
      },
    }));
    const reviewState = {
      hash: 'full-task-hash-abc',
      baseTree: '1111111111111111111111111111111111111111',
      currentTree: '2222222222222222222222222222222222222222',
      changedPaths: ['src/x.ts'],
    };

    await deps.reviewer({
      diff: 'diff --git a/src/x.ts',
      spec: 'spec',
      tests: ['src/x.test.ts'],
      task: sizedTask,
      context: 'ctx',
      reviewerProvider: 'anthropic',
      reviewState,
    });
    await deps.techLeadReviewDiff({ task: sizedTask, diff: 'diff --git a/src/x.ts', reviewState });
    await deps.designer({ task: sizedTask, diff: 'diff --git a/src/x.ts', reviewState });

    for (const role of ['reviewer', 'tech-lead', 'designer']) {
      const message = messages.find((entry) => entry.role === role)?.message ?? '';
      expect(message).toContain('## Complete task implementation relative to durable task base');
      expect(message).toContain(`task-base-tree: ${reviewState.baseTree}`);
      expect(message).toContain(`current-review-tree: ${reviewState.currentTree}`);
      expect(message).toContain(`full-task-review-hash: ${reviewState.hash}`);
    }
  });

  it('falls back to explicit "unavailable" review-state labels when no reviewState is supplied', async () => {
    const messages: Array<{ role: string; message: string }> = [];
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role, message }) => {
        messages.push({ role, message });
        return GREEN_JUDGMENT_REPLY;
      },
    }));

    await deps.techLeadReviewDiff({ task: sizedTask, diff: 'diff' });
    await deps.designer({ task: sizedTask, diff: 'diff' });

    for (const role of ['tech-lead', 'designer']) {
      const message = messages.find((entry) => entry.role === role)?.message ?? '';
      expect(message).toContain('task-base-tree: unavailable');
      expect(message).toContain('current-review-tree: unavailable');
      expect(message).toContain('full-task-review-hash: unavailable');
    }
  });

  it('labels the diff-review artifact with the artifact pass kind and full-task review-state identities', async () => {
    const techLeadMessages: string[] = [];
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role, message }) => {
        if (role === 'tech-lead') techLeadMessages.push(message);
        return GREEN_JUDGMENT_REPLY;
      },
    }));
    const reviewState = {
      hash: 'full-task-hash-xyz',
      baseTree: '1111111111111111111111111111111111111111',
      currentTree: '3333333333333333333333333333333333333333',
      changedPaths: ['src/y.ts'],
    };

    await deps.techLeadReviewDiff({
      task: sizedTask,
      diff: 'diff --git a/src/y.ts',
      spec: 'spec',
      context: 'ctx',
      reviewState,
      judgmentContext: { artifactPass: 'closeout-retry' } as never,
    });

    expect(techLeadMessages).toHaveLength(1);
    expect(techLeadMessages[0]).toContain('## Complete task implementation relative to durable task base');
    expect(techLeadMessages[0]).toContain('pass: closeout-retry');
    expect(techLeadMessages[0]).toContain(`task-base-tree: ${reviewState.baseTree}`);
    expect(techLeadMessages[0]).toContain(`current-review-tree: ${reviewState.currentTree}`);
    expect(techLeadMessages[0]).toContain(`full-task-review-hash: ${reviewState.hash}`);
  });

  it('omits the artifact pass label when no judgment context carries one', async () => {
    const techLeadMessages: string[] = [];
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role, message }) => {
        if (role === 'tech-lead') techLeadMessages.push(message);
        return GREEN_JUDGMENT_REPLY;
      },
    }));

    await deps.techLeadReviewDiff({
      task: sizedTask,
      diff: 'diff --git a/src/y.ts',
      spec: 'spec',
      context: 'ctx',
    });

    expect(techLeadMessages[0]).not.toContain('pass: ');
    expect(techLeadMessages[0]).toContain('task-base-tree: unavailable');
  });

  it('renders the coder findings ledger severity-sorted with a highest-severity-first fix instruction', async () => {
    const coderPrompts: string[] = [];
    const unorderedLedger: FindingsLedgerEntry[] = [
      {
        id: 'finding-low-cache',
        sourceGate: 'designer',
        class: 'cost-perf',
        severity: 'low',
        location: 'src/cache.ts:12',
        rationale: 'extra repaint remains but correctness is unaffected',
        reversible: true,
        raisedRound: 1,
        status: 'open',
      },
      {
        id: 'finding-high-auth',
        sourceGate: 'reviewer',
        class: 'security',
        severity: 'high',
        location: 'src/auth.ts:42',
        rationale: 'authorization bypass remains possible after retry',
        reversible: true,
        raisedRound: 2,
        status: 'open',
      },
      {
        id: 'finding-critical-data',
        sourceGate: 'tech-lead',
        class: 'data-integrity',
        severity: 'critical',
        location: 'src/store.ts:7',
        rationale: 'accepted writes can corrupt project state',
        reversible: true,
        raisedRound: 3,
        status: 'open',
      },
      {
        id: 'finding-medium-egress',
        sourceGate: 'reviewer',
        class: 'outbound',
        severity: 'medium',
        location: 'src/egress.ts:27',
        rationale: 'egress allow-list still misses one provider endpoint',
        reversible: true,
        raisedRound: 1,
        status: 'open',
      },
    ];
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      runExecution: async (opts) => {
        coderPrompts.push(opts.prompt);
        return {
          ok: true,
          diff: 'diff --git a/src/auth.ts b/src/auth.ts\n+++ b/src/auth.ts\n+fixed\n',
          output: 'fixed highest severity finding first',
        };
      },
    }));

    await deps.coder({
      task: sizedTask,
      spec: 'Fix the task without leaving objection-class residue.',
      context: 'ctx',
      tests: ['src/auth.test.ts'],
      findingsLedger: unorderedLedger,
    });

    expect(coderPrompts).toHaveLength(1);
    const prompt = coderPrompts[0] ?? '';
    const criticalIndex = prompt.indexOf('finding-critical-data');
    const highIndex = prompt.indexOf('finding-high-auth');
    const mediumIndex = prompt.indexOf('finding-medium-egress');
    const lowIndex = prompt.indexOf('finding-low-cache');

    expect(prompt).toMatch(/highest[- ]severity[- ]first|fix .*highest severity/i);
    expect(criticalIndex).toBeGreaterThanOrEqual(0);
    expect(highIndex).toBeGreaterThan(criticalIndex);
    expect(mediumIndex).toBeGreaterThan(highIndex);
    expect(lowIndex).toBeGreaterThan(mediumIndex);
  });

  it('normalizes a legacy reviewer boolean verdict to the shared outcome enum at the role boundary', async () => {
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role }) => {
        if (role !== 'reviewer') return GREEN_JUDGMENT_REPLY;
        return [
          '```reviewer-verdict',
          '{"pass": true, "objections": []}',
          '```',
        ].join('\n');
      },
    }));

    const verdict = await deps.reviewer({
      diff: 'diff',
      spec: 'spec',
      tests: ['src/x.test.ts'],
      task: sizedTask,
      context: 'ctx',
      reviewerProvider: 'anthropic',
    });
    const structured = verdict as unknown as Record<string, unknown>;

    expect(structured).toHaveProperty('outcome');
    expect(GATE_VERDICT_OUTCOMES).toContain(
      structured['outcome'] as (typeof GATE_VERDICT_OUTCOMES)[number],
    );
    expect(structured['outcome']).toBe('pass');
    expect(structured).not.toHaveProperty('pass');
  });

  it('parses reviewer verdicts as shared GateVerdict records with findings, not objections', async () => {
    const finding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/cache.ts:44',
      rationale: 'duplicate reads are harmless but should be tracked',
    };
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role }) => {
        if (role !== 'reviewer') return GREEN_JUDGMENT_REPLY;
        return [
          '```reviewer-verdict',
          JSON.stringify({
            outcome: 'pass-with-warnings',
            findings: [finding],
            notes: 'ship with a recorded performance caveat',
          }),
          '```',
        ].join('\n');
      },
    }));

    const verdict = await deps.reviewer({
      diff: 'diff',
      spec: 'spec',
      tests: ['src/x.test.ts'],
      task: sizedTask,
      context: 'ctx',
      reviewerProvider: 'anthropic',
    });
    const structured = verdict as unknown as Record<string, unknown>;

    expect(structured).toMatchObject({
      outcome: 'pass-with-warnings',
      findings: [finding],
      notes: 'ship with a recorded performance caveat',
    });
    expect(structured).not.toHaveProperty('pass');
    expect(structured).not.toHaveProperty('objections');
  });

  it('parses Phase 14 review-gate findings with outbound class and reversible preserved', async () => {
    const reviewerFinding = {
      class: 'outbound',
      severity: 'high',
      location: 'src/egress.ts:27',
      rationale: 'unapproved network egress can leave the sandbox',
      reversible: false,
    };
    const techLeadFinding = {
      class: 'data-integrity',
      severity: 'medium',
      location: 'src/store.ts:19',
      rationale: 'stale writes can corrupt the task ledger',
      reversible: true,
    };
    const designerFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/server/static/app.js:114',
      rationale: 'extra repaint is visible on slow devices',
      reversible: true,
    };
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role }) => {
        if (role === 'reviewer') {
          return [
            '```reviewer-verdict',
            JSON.stringify({ outcome: 'fail', findings: [reviewerFinding] }),
            '```',
          ].join('\n');
        }
        if (role === 'tech-lead') {
          return [
            '```tl-diff-review',
            JSON.stringify({ outcome: 'fail', findings: [techLeadFinding] }),
            '```',
          ].join('\n');
        }
        if (role === 'designer') {
          return [
            '```designer-review',
            JSON.stringify({ outcome: 'pass-with-warnings', findings: [designerFinding] }),
            '```',
          ].join('\n');
        }
        return GREEN_JUDGMENT_REPLY;
      },
    }));

    const reviewer = await deps.reviewer({
      diff: 'diff',
      spec: 'spec',
      tests: ['src/x.test.ts'],
      task: sizedTask,
      context: 'ctx',
      reviewerProvider: 'anthropic',
    });
    const techLead = await deps.techLeadReviewDiff({ task: sizedTask, diff: 'diff' });
    const designer = await deps.designer({ task: sizedTask, diff: 'diff' });

    expect(reviewer).toMatchObject({ outcome: 'fail', findings: [reviewerFinding] });
    expect(techLead).toMatchObject({ outcome: 'fail', findings: [techLeadFinding] });
    expect(designer).toMatchObject({ outcome: 'pass-with-warnings', findings: [designerFinding] });
  });

  it('parses tech-lead diff and designer reviews as shared GateVerdict records', async () => {
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role }) => {
        if (role === 'tech-lead') {
          return [
            '```tl-diff-review',
            '{"outcome":"pass-with-warnings","findings":[],"notes":"acceptable with a follow-up caveat"}',
            '```',
          ].join('\n');
        }
        if (role === 'designer') {
          return [
            '```designer-review',
            '{"outcome":"pass","findings":[],"notes":"UI is consistent"}',
            '```',
          ].join('\n');
        }
        return GREEN_JUDGMENT_REPLY;
      },
    }));

    const techLead = await deps.techLeadReviewDiff({ task: sizedTask, diff: 'diff' });
    const designer = await deps.designer({ task: sizedTask, diff: 'diff' });

    expect(techLead as unknown as Record<string, unknown>).toMatchObject({
      outcome: 'pass-with-warnings',
      findings: [],
      notes: 'acceptable with a follow-up caveat',
    });
    expect(designer as unknown as Record<string, unknown>).toMatchObject({
      outcome: 'pass',
      findings: [],
      notes: 'UI is consistent',
    });
    expect(techLead).not.toHaveProperty('pass');
    expect(designer).not.toHaveProperty('pass');
  });

  it('normalizes omitted tech-lead and designer reversible flags to false at the production role boundary', async () => {
    const techLeadFinding = {
      class: 'data-integrity',
      severity: 'medium',
      location: 'src/store.ts:19',
      rationale: 'partial writes can corrupt the task ledger',
    };
    const designerFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/server/static/app.js:114',
      rationale: 'extra repaint is visible on slow devices',
    };
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role }) => {
        if (role === 'tech-lead') {
          return [
            '```tl-diff-review',
            JSON.stringify({ outcome: 'fail', findings: [techLeadFinding] }),
            '```',
          ].join('\n');
        }
        if (role === 'designer') {
          return [
            '```designer-review',
            JSON.stringify({ outcome: 'pass-with-warnings', findings: [designerFinding] }),
            '```',
          ].join('\n');
        }
        return GREEN_JUDGMENT_REPLY;
      },
    }));

    const techLead = await deps.techLeadReviewDiff({ task: sizedTask, diff: 'diff' });
    const designer = await deps.designer({ task: sizedTask, diff: 'diff' });

    expect(techLead).toMatchObject({
      outcome: 'fail',
      findings: [{ ...techLeadFinding, reversible: false }],
    });
    expect(designer).toMatchObject({
      outcome: 'pass-with-warnings',
      findings: [{ ...designerFinding, reversible: false }],
    });
  });

  it('treats GateVerdict.outcome as exactly pass/pass-with-warnings/fail, never block', async () => {
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role }) => {
        if (role === 'reviewer') {
          return [
            '```reviewer-verdict',
            '{"outcome":"block","findings":[],"notes":"legacy hard block"}',
            '```',
          ].join('\n');
        }
        if (role === 'tech-lead') {
          return [
            '```tl-diff-review',
            '{"outcome":"block","findings":[],"notes":"legacy hard block"}',
            '```',
          ].join('\n');
        }
        if (role === 'designer') {
          return [
            '```designer-review',
            '{"outcome":"block","findings":[],"notes":"legacy hard block"}',
            '```',
          ].join('\n');
        }
        return GREEN_JUDGMENT_REPLY;
      },
    }));

    const reviewer = await deps.reviewer({
      diff: 'diff',
      spec: 'spec',
      tests: ['src/x.test.ts'],
      task: sizedTask,
      context: 'ctx',
      reviewerProvider: 'anthropic',
    });
    const techLead = await deps.techLeadReviewDiff({ task: sizedTask, diff: 'diff' });
    const designer = await deps.designer({ task: sizedTask, diff: 'diff' });

    for (const verdict of [reviewer, techLead, designer]) {
      const structured = verdict as unknown as Record<string, unknown>;
      expect(verdict).toHaveProperty('outcome');
      expect(GATE_VERDICT_OUTCOMES).toContain(
        structured['outcome'] as (typeof GATE_VERDICT_OUTCOMES)[number],
      );
      expect(structured['outcome']).toBe('fail');
      expect(structured['outcome']).not.toBe('block');
    }
  });

  it('ignores legacy block labels and derives production gate outcomes from finding severity', async () => {
    const lowFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/cache.ts:8',
      rationale: 'duplicate read is a follow-up, not a task-stopping objection',
    };
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role }) => {
        if (role === 'reviewer') {
          return [
            '```reviewer-verdict',
            JSON.stringify({ outcome: 'block', findings: [lowFinding] }),
            '```',
          ].join('\n');
        }
        if (role === 'tech-lead') {
          return [
            '```tl-diff-review',
            JSON.stringify({ outcome: 'block', findings: [lowFinding] }),
            '```',
          ].join('\n');
        }
        if (role === 'designer') {
          return [
            '```designer-review',
            JSON.stringify({ outcome: 'block', findings: [lowFinding] }),
            '```',
          ].join('\n');
        }
        return GREEN_JUDGMENT_REPLY;
      },
    }));

    const reviewer = await deps.reviewer({
      diff: 'diff',
      spec: 'spec',
      tests: ['src/x.test.ts'],
      task: sizedTask,
      context: 'ctx',
      reviewerProvider: 'anthropic',
    });
    const techLead = await deps.techLeadReviewDiff({ task: sizedTask, diff: 'diff' });
    const designer = await deps.designer({ task: sizedTask, diff: 'diff' });

    for (const verdict of [reviewer, techLead, designer]) {
      const structured = verdict as unknown as Record<string, unknown>;
      expect(structured['outcome']).toBe('pass-with-warnings');
      expect(structured['outcome']).not.toBe('block');
      expect(structured['findings']).toEqual([lowFinding]);
    }
  });

  it('routes severity-derived outcomes through every production review gate parser', async () => {
    const criticalFinding = {
      class: 'privacy',
      severity: 'critical',
      location: 'src/profile.ts:7',
      rationale: 'private notes can be exposed to another user',
    };
    const highFinding = {
      class: 'security',
      severity: 'high',
      location: 'src/auth.ts:42',
      rationale: 'token comparison leaks timing information',
    };
    const mediumFinding = {
      class: 'data-integrity',
      severity: 'medium',
      location: 'src/store.ts:19',
      rationale: 'stale rows can be reported until the next refresh',
    };
    const lowFinding = {
      class: 'cost-perf',
      severity: 'low',
      location: 'src/cache.ts:8',
      rationale: 'duplicate read is non-blocking but worth tracking',
    };
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role }) => {
        if (role === 'reviewer') {
          return [
            '```reviewer-verdict',
            JSON.stringify({ pass: true, findings: [criticalFinding, highFinding] }),
            '```',
          ].join('\n');
        }
        if (role === 'tech-lead') {
          return [
            '```tl-diff-review',
            JSON.stringify({ pass: true, findings: [mediumFinding] }),
            '```',
          ].join('\n');
        }
        if (role === 'designer') {
          return [
            '```designer-review',
            JSON.stringify({ pass: true, findings: [lowFinding] }),
            '```',
          ].join('\n');
        }
        return GREEN_JUDGMENT_REPLY;
      },
    }));

    const reviewer = await deps.reviewer({
      diff: 'diff',
      spec: 'spec',
      tests: ['src/x.test.ts'],
      task: sizedTask,
      context: 'ctx',
      reviewerProvider: 'anthropic',
    });
    const techLead = await deps.techLeadReviewDiff({ task: sizedTask, diff: 'diff' });
    const designer = await deps.designer({ task: sizedTask, diff: 'diff' });

    expect(reviewer).toMatchObject({ outcome: 'fail', findings: [criticalFinding, highFinding] });
    expect(techLead).toMatchObject({ outcome: 'fail', findings: [mediumFinding] });
    expect(designer).toMatchObject({ outcome: 'pass-with-warnings', findings: [lowFinding] });
  });

  it('maps high and critical review findings to fail, never block', async () => {
    const highFinding = {
      class: 'security',
      severity: 'high',
      location: 'src/auth.ts:42',
      rationale: 'token comparison leaks timing information',
    };
    const criticalFinding = {
      class: 'privacy',
      severity: 'critical',
      location: 'src/profile.ts:7',
      rationale: 'private notes can be exposed to another user',
    };
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({
      judgmentCall: async ({ role }) => {
        if (role === 'reviewer') {
          return [
            '```reviewer-verdict',
            JSON.stringify({ outcome: 'pass', findings: [highFinding] }),
            '```',
          ].join('\n');
        }
        if (role === 'tech-lead') {
          return [
            '```tl-diff-review',
            JSON.stringify({ outcome: 'pass', findings: [criticalFinding] }),
            '```',
          ].join('\n');
        }
        return GREEN_JUDGMENT_REPLY;
      },
    }));

    const reviewer = await deps.reviewer({
      diff: 'diff',
      spec: 'spec',
      tests: ['src/x.test.ts'],
      task: sizedTask,
      context: 'ctx',
      reviewerProvider: 'anthropic',
    });
    const techLead = await deps.techLeadReviewDiff({ task: sizedTask, diff: 'diff' });

    expect(reviewer).toMatchObject({ outcome: 'fail', findings: [highFinding] });
    expect(techLead).toMatchObject({ outcome: 'fail', findings: [criticalFinding] });
    expect((reviewer as unknown as Record<string, unknown>)['outcome']).not.toBe('block');
    expect((techLead as unknown as Record<string, unknown>)['outcome']).not.toBe('block');
  });

  it('judgment seams fail closed on an unparseable reply', async () => {
    const deps = buildDeps(
      resolveTeamRoleModels(loadRealPolicy()),
      makeSeams({ judgmentCall: async () => 'no fenced block here' }),
    );

    await expect(deps.reviewer({
      diff: 'd',
      spec: 's',
      tests: 't',
      task: sizedTask,
      context: 'c',
      reviewerProvider: 'anthropic',
    })).rejects.toMatchObject({
      name: 'ExecutionFailureError',
      failure: expect.objectContaining({
        role: 'reviewer',
        workflowStage: 'reviewer-review',
        failureStage: 'orchestration-adjacent',
      }),
    });

    const tl = await deps.techLeadReviewTests({ task: sizedTask, qa: { kind: 'tests-written', testIds: [] } });
    expect(tl.approved).toBe(false);

    const pm = await deps.acceptWithRationale!({
      task: sizedTask,
      reason: 'cap',
      reviewerVerdict: { outcome: 'fail', findings: [] },
      rejectionFeedback: {
        rejectingRole: 'reviewer',
        counterpartRole: 'coder',
        rejectedRole: 'coder',
        artifact: 'implementation-diff',
        rejectedArtifact: 'implementation-diff',
        reason: 'cap',
        whatFailed: 'cap',
        notes: [],
        actionableNotes: [],
      },
    });
    expect(pm.accepted).toBe(false);
  });

  it('coder seam returns the execution-agent diff; qa seam maps diff/no-diff to tests-written/rationale', async () => {
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()));

    const coder = await deps.coder({ task: sizedTask, spec: 's', context: 'c', tests: ['t'] });
    expect(coder.diff).toContain('src/x.test.ts');

    const qaWithTests = await deps.qaWriteTests({ task: sizedTask, spec: 's' });
    expect(qaWithTests.kind).toBe('tests-written');

    const noopDeps = buildDeps(
      resolveTeamRoleModels(loadRealPolicy()),
      makeSeams({ runExecution: async () => ({ ok: true, diff: '', output: 'docs-only task, no tests needed' }) }),
    );
    const qaNoTests = await noopDeps.qaWriteTests({ task: sizedTask, spec: 's' });
    expect(qaNoTests.kind).toBe('no-code-test-rationale');
  });

  it('a failed execution agent surfaces as a seam rejection → structured failed evidence, not a fake diff', async () => {
    const deps = buildDeps(
      resolveTeamRoleModels(loadRealPolicy()),
      makeSeams({ runExecution: async () => failedExecution('codex unavailable') }),
    );

    const evidence = await runTeamTaskWorkflow(
      sizedTask,
      { spec: 's', contextMd: 'c', coderProvider: 'openai', cap: 2 },
      deps,
    );
    expect(evidence.outcome).toBe('failed');
    expect(evidence.failureReason).toContain('codex unavailable');
  });

  it('persists the role checkpoint before spawn and blocks when that write fails', async () => {
    const order: string[] = [];
    const runExecution = vi.fn(async () => {
      order.push('spawn');
      return greenExecution();
    });
    const deps = buildProductionTeamTaskDeps({
      sandbox: makeSandbox(),
      productsConfigPath: '/nonexistent/products.json',
      models: resolveTeamRoleModels(loadRealPolicy()),
      persistExecutionCheckpoint: async (checkpoint) => {
        order.push(`checkpoint:${checkpoint.workflowStage}`);
        throw new Error('/Users/private/operator/cursor write failed');
      },
    }, makeSeams({ runExecution }));

    const evidence = await runTeamTaskWorkflow(
      sizedTask,
      { spec: 's', contextMd: 'c', coderProvider: 'openai', cap: 2 },
      deps,
    );

    expect(order).toEqual(['checkpoint:qa-tests']);
    expect(runExecution).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      outcome: 'failed',
      executionFailure: {
        role: 'qa',
        workflowStage: 'qa-tests',
        failureStage: 'orchestration-adjacent',
      },
    });
    expect(evidence.failureReason).not.toContain('/Users/private/operator');
  });

  it('passes the exact persisted checkpoint into the execution agent call', async () => {
    let persisted: unknown;
    let invoked: unknown;
    const deps = buildProductionTeamTaskDeps({
      sandbox: makeSandbox(),
      productsConfigPath: '/nonexistent/products.json',
      models: resolveTeamRoleModels(loadRealPolicy()),
      persistExecutionCheckpoint: async (checkpoint) => {
        persisted = checkpoint;
      },
    }, makeSeams({
      runExecution: async (opts) => {
        invoked = opts.checkpoint;
        return greenExecution();
      },
    }));

    await deps.qaWriteTests({ task: sizedTask, spec: 's' });

    expect(persisted).toBeDefined();
    expect(invoked).toBe(persisted);
    expect(invoked).toMatchObject({
      taskId: sizedTask.id,
      role: 'qa',
      workflowStage: 'qa-tests',
    });
  });

  it('persists one bounded judgment-batch checkpoint before concurrent judgments spawn', async () => {
    const persisted: ExecutionCheckpoint[] = [];
    const spawnedJudgments: string[] = [];
    const deps = buildProductionTeamTaskDeps({
      sandbox: makeSandbox(),
      productsConfigPath: '/nonexistent/products.json',
      models: resolveTeamRoleModels(loadRealPolicy()),
      persistExecutionCheckpoint: async (checkpoint) => {
        persisted.push(checkpoint);
      },
    }, makeSeams({
      judgmentCall: async ({ role }) => {
        spawnedJudgments.push(role);
        return GREEN_JUDGMENT_REPLY;
      },
    }));

    const evidence = await runTeamTaskWorkflow(
      sizedTask,
      { spec: 's', contextMd: 'c', coderProvider: 'openai', cap: 1 },
      deps,
    );

    expect(evidence.outcome).toBe('ready-for-closeout');
    const batches = persisted.filter((checkpoint) => checkpoint.judgmentBatch !== undefined);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      taskId: sizedTask.id,
      role: 'judgment-batch',
      workflowStage: 'post-coder-judgments',
      judgmentBatch: {
        members: [
          { role: 'qa', workflowStage: 'qa-diff-revalidation' },
          { role: 'reviewer', workflowStage: 'reviewer-review' },
          { role: 'tech-lead', workflowStage: 'tech-lead-diff-review' },
        ],
      },
    });
    expect(persisted.at(-1)).toMatchObject({
      taskId: sizedTask.id,
      role: 'orchestrator',
      workflowStage: 'post-coder-judgments-complete',
    });
    expect(persisted.at(-1)?.judgmentBatch).toBeUndefined();
    expect(spawnedJudgments).toEqual(expect.arrayContaining([
      'reviewer',
      'tech-lead',
    ]));
    expect(spawnedJudgments).not.toContain('qa');
  });
});

// ---------------------------------------------------------------------------
// Execution observability attribution (Phase 10)
// ---------------------------------------------------------------------------

describe('createProductionTaskWorkflowRunner — activity attribution (Phase 10)', () => {
  type AttributedActivityEvent = {
    kind: 'activity' | 'output';
    data?: Record<string, unknown>;
  };

  function expectAttributedLine(
    event: AttributedActivityEvent,
    expected: { role: string; provider: string; model: string },
  ): void {
    expect(event.data?.['role']).toBe(expected.role);
    expect(event.data?.['provider']).toBe(expected.provider);
    expect(event.data?.['model']).toBe(expected.model);
    expect(String(event.data?.['line'])).toContain(expected.role);
    expect(String(event.data?.['line'])).toContain(expected.provider);
    expect(String(event.data?.['line'])).toContain(expected.model);
  }

  it('attributes every emitted role-stage activity line with role, provider, and model', async () => {
    const events: AttributedActivityEvent[] = [];
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: REAL_POLICY_PATH,
        emit: (event) => events.push(event),
        cap: 1,
      },
      makeSeams(),
    );

    const evidence = await run(selectedTask, { handoff: 'bounded handoff', contextMd: 'ctx' });

    expect(evidence.outcome).toBe('ready-for-closeout');
    const lines = events.filter((event) =>
      typeof event.data?.['line'] === 'string' && typeof event.data?.['role'] === 'string',
    );
    expect(lines.length).toBeGreaterThan(0);
    const declared = loadRealPolicy().roleDefaults;
    const expectedByRole = new Map([
      ['qa', { role: 'qa', provider: 'openai', model: declared['qa']! }],
      ['tech-lead', { role: 'tech-lead', provider: 'anthropic', model: declared['tech-lead']! }],
      ['coder', { role: 'coder', provider: 'openai', model: declared['coder']! }],
      ['reviewer', { role: 'reviewer', provider: 'anthropic', model: declared['reviewer']! }],
    ]);

    for (const line of lines) {
      const role = String(line.data?.['role']);
      const expected = expectedByRole.get(role);
      expect(expected, `unexpected emitted role activity line: ${JSON.stringify(line.data)}`).toBeDefined();
      expectAttributedLine(line, expected!);
    }
  });

  it('forwards artifact executor output lines with the invoking role provider and model', async () => {
    const events: AttributedActivityEvent[] = [];
    let executionCalls = 0;
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: REAL_POLICY_PATH,
        emit: (event) => events.push(event),
        cap: 1,
      },
      makeSeams({
        runExecution: async (opts) => {
          executionCalls += 1;
          opts.emit?.({
            kind: 'output',
            data: { line: `executor progress ${executionCalls}` },
          });
          return {
            ok: true,
            diff: `diff --git a/src/${executionCalls}.test.ts b/src/${executionCalls}.test.ts\n+++ b/src/${executionCalls}.test.ts\n+expect(${executionCalls}).toBe(${executionCalls})\n`,
            output: `executor ${executionCalls} done`,
          };
        },
      }),
    );

    const evidence = await run(selectedTask, { handoff: 'bounded handoff', contextMd: 'ctx' });

    expect(evidence.outcome).toBe('ready-for-closeout');
    const executorLines = events.filter((event) =>
      String(event.data?.['line'] ?? '').includes('executor progress'),
    );
    expect(executorLines).toHaveLength(3);
    const declared = loadRealPolicy().roleDefaults;
    expectAttributedLine(executorLines[0]!, {
      role: 'qa',
      provider: 'openai',
      model: declared['qa']!,
    });
    expectAttributedLine(executorLines[1]!, {
      role: 'coder',
      provider: 'openai',
      model: declared['coder']!,
    });
    expectAttributedLine(executorLines[2]!, {
      role: 'coder',
      provider: 'openai',
      model: declared['coder']!,
    });
  });

  it('scrubs artifact executor output before adding role provider and model attribution', async () => {
    const events: AttributedActivityEvent[] = [];
    const rawSecret = 'sk-qaStreamFixture1234567890';
    const rawPath = join(REPO_ROOT, 'src/private/fixture.ts');
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: REAL_POLICY_PATH,
        emit: (event) => events.push(event),
        cap: 1,
      },
      makeSeams({
        runExecution: async (opts) => {
          opts.emit?.({
            kind: 'output',
            data: { line: `executor saw ${rawSecret} at ${rawPath}` },
          });
          return {
            ok: true,
            diff: 'diff --git a/src/x.test.ts b/src/x.test.ts\n+++ b/src/x.test.ts\n+expect(1).toBe(1)\n',
            output: 'executor done',
          };
        },
      }),
    );

    const evidence = await run(selectedTask, { handoff: 'bounded handoff', contextMd: 'ctx' });

    expect(evidence.outcome).toBe('ready-for-closeout');
    const executorLines = events.filter((event) =>
      String(event.data?.['line'] ?? '').includes('executor saw'),
    );
    expect(executorLines).toHaveLength(3);
    const declared = loadRealPolicy().roleDefaults;
    for (const line of executorLines) {
      const role = String(line.data?.['role']);
      expectAttributedLine(line, {
        role,
        provider: 'openai',
        model: declared[role]!,
      });
      const displayLine = String(line.data?.['line']);
      expect(displayLine).not.toContain(rawSecret);
      expect(displayLine).toMatch(/sk-<redacted-[a-f0-9]{6}>/);
      expect(displayLine).not.toContain(REPO_ROOT);
      expect(displayLine).toContain('src/private/fixture.ts');
    }
  });
});

// ---------------------------------------------------------------------------
// No-stub regression — the production runTaskWorkflow is the real workflow
// ---------------------------------------------------------------------------

describe('no-stub regression (Phase 8)', () => {
  it('blocks a required task with absent validation commands before preflight or any role dispatch', async () => {
    const preflightExecution = vi.fn(makeSeams().preflightExecution!);
    const judgmentCall = vi.fn(greenJudgment);
    const runExecution = vi.fn(greenExecution);
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: REAL_POLICY_PATH,
        validationCommands: [],
      },
      makeSeams({ preflightExecution, judgmentCall, runExecution }),
    );

    const evidence = await run(
      { ...selectedTask, validationPolicy: 'required' },
      { handoff: 'bounded handoff', contextMd: 'ctx' },
    );

    expect(preflightExecution).not.toHaveBeenCalled();
    expect(judgmentCall).not.toHaveBeenCalled();
    expect(runExecution).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      outcome: 'blocked',
      rolesInvoked: [],
      taskValidationFailure: {
        kind: 'missing-commands',
        prerequisite: 'validationCommands',
      },
    });
    expect(evidence.blockedReason).toMatch(/required validationCommands/i);
  });

  it('allows an explicit reviewed-no-validation task through empty-command admission', async () => {
    const runExecution = vi.fn(greenExecution);
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: REAL_POLICY_PATH,
        validationCommands: [],
        cap: 1,
      },
      makeSeams({
        runExecution,
      }),
    );

    const evidence = await run(
      { ...selectedTask, validationPolicy: 'reviewed-no-validation' },
      { handoff: 'bounded handoff', contextMd: 'ctx' },
    );

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(runExecution).toHaveBeenCalledTimes(3);
    expect(evidence).not.toHaveProperty('taskValidationFailure');
  });

  it('names the exact missing executable and command before dispatching a required task', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'validation-admission-binary-'));
    const runExecution = vi.fn(greenExecution);
    const judgmentCall = vi.fn(greenJudgment);
    try {
      const missingExecutable = 'rune-validator-that-does-not-exist-7491';
      const command = `${missingExecutable} --check`;
      const run = createProductionTaskWorkflowRunner(
        {
          sandbox: { ...makeSandbox(), worktree },
          productsConfigPath: '/nonexistent/products.json',
          modelPolicyPath: REAL_POLICY_PATH,
          validationCommands: [command],
        },
        makeSeams({ runExecution, judgmentCall }),
      );

      const evidence = await run(
        { ...selectedTask, validationPolicy: 'required' },
        { handoff: 'h', contextMd: 'c' },
      );

      expect(runExecution).not.toHaveBeenCalled();
      expect(judgmentCall).not.toHaveBeenCalled();
      expect(evidence).toMatchObject({
        outcome: 'blocked',
        rolesInvoked: [],
        taskValidationFailure: {
          kind: 'missing-executable',
          command,
          prerequisite: 'executable',
          executable: missingExecutable,
        },
      });
      expect(evidence.blockedReason).toContain(missingExecutable);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it.each([
    '   ',
    '"unterminated',
    'uv sync && uv run pytest',
  ])('rejects malformed required validation command %j before role dispatch', async (command) => {
    const runExecution = vi.fn(greenExecution);
    const judgmentCall = vi.fn(greenJudgment);
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: REAL_POLICY_PATH,
        validationCommands: [command],
      },
      makeSeams({ runExecution, judgmentCall }),
    );

    const evidence = await run(
      { ...selectedTask, validationPolicy: 'required' },
      { handoff: 'h', contextMd: 'c' },
    );

    expect(runExecution).not.toHaveBeenCalled();
    expect(judgmentCall).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      outcome: 'blocked',
      rolesInvoked: [],
      taskValidationFailure: {
        kind: 'malformed-command',
        command,
        prerequisite: 'validationCommands',
      },
    });
  });

  it('names validationCwd as the prerequisite when the configured directory is missing or escapes the worktree', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'validation-admission-cwd-'));
    try {
      for (const validationCwd of ['missing-harness', '../outside-worktree']) {
        const runExecution = vi.fn(greenExecution);
        const run = createProductionTaskWorkflowRunner(
          {
            sandbox: { ...makeSandbox(), worktree },
            productsConfigPath: '/nonexistent/products.json',
            modelPolicyPath: REAL_POLICY_PATH,
            validationCommands: ['node --version'],
            ...({ validationCwd } as Record<string, unknown>),
          },
          makeSeams({ runExecution }),
        );

        const evidence = await run(
          { ...selectedTask, validationPolicy: 'required' },
          { handoff: 'h', contextMd: 'c' },
        );

        expect(runExecution).not.toHaveBeenCalled();
        expect(evidence).toMatchObject({
          outcome: 'blocked',
          rolesInvoked: [],
          taskValidationFailure: {
            kind: 'invalid-validation-cwd',
            prerequisite: 'validationCwd',
            validationCwd,
          },
        });
        expect(evidence.blockedReason).toContain(validationCwd);
      }
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it.each(['qa', 'tech-lead', 'coder', 'reviewer'] as const)(
    'preserves structured %s cancellation across production role bindings',
    async (cancelledRole) => {
      const cancellation = {
        operationId: '12345678-1234-1234-1234-123456789abc',
        source: 'cockpit' as const,
        requestedAt: '2026-07-13T12:34:56.000Z',
      };
      const run = createProductionTaskWorkflowRunner(
        {
          sandbox: makeSandbox(),
          productsConfigPath: '/nonexistent/products.json',
          modelPolicyPath: REAL_POLICY_PATH,
        },
        makeSeams({
          judgmentCall: async (input) => {
            if (input.role === cancelledRole) {
              throw new RoleCancellationError(cancelledRole, cancellation);
            }
            return greenJudgment(input);
          },
          runExecution: async (opts) => opts.role === cancelledRole
            ? failedExecution('Cancelled by user', cancellation)
            : greenExecution(),
        }),
      );

      const evidence = await run(selectedTask, { handoff: 'bounded handoff', contextMd: 'ctx' });

      expect(evidence).toMatchObject({
        outcome: 'cancelled',
        cancellation: { role: cancelledRole, ...cancellation },
      });
    },
  );

  it('the orchestrated applier production runtime binds createProductionTaskWorkflowRunner', () => {
    __resetOrchestratedRuntimeForTest();
    const runtime = __getRuntimeDepsForTest();
    expect(runtime.createTaskWorkflowRunner).toBe(createProductionTaskWorkflowRunnerRaw);
  });

  it('defaults the production workflow runner to four feedback rounds when no cap override is provided', async () => {
    let executionCalls = 0;
    let techLeadTestReviews = 0;
    let currentDiff = '';
    const judgment: JudgmentModelCall = async ({ role, message }) => {
      if (message.includes('<gate-rejection>')) {
        return 'no reusable lesson for this fixture';
      }
      if (role === 'tech-lead' && message.includes('## QA tests')) {
        techLeadTestReviews += 1;
        return [
          '```tl-test-review',
          JSON.stringify({
            approved: techLeadTestReviews === 4,
            notes: techLeadTestReviews === 4
              ? 'fourth test intent covers the contract'
              : `revision ${techLeadTestReviews} still misses the contract`,
          }),
          '```',
        ].join('\n');
      }
      if (role === 'tech-lead' && message.includes('## Diff')) {
        return ['```tl-diff-review', '{"outcome":"pass","findings":[]}', '```'].join('\n');
      }
      if (role === 'reviewer') {
        return ['```reviewer-verdict', '{"outcome":"pass","findings":[]}', '```'].join('\n');
      }
      return GREEN_JUDGMENT_REPLY;
    };
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: REAL_POLICY_PATH,
      },
      makeSeams({
        judgmentCall: judgment,
        runExecution: async (opts) => {
          if (opts.workflowStage === 'coder-self-review') {
            return {
              ok: true,
              diff: currentDiff,
              output: [
                '```coder-self-review',
                '{"outcome":"confirmed","notes":"The worktree is ready."}',
                '```',
              ].join('\n'),
            };
          }
          executionCalls += 1;
          const result = {
            ok: true,
            diff: [
              `diff --git a/src/round-${executionCalls}.test.ts b/src/round-${executionCalls}.test.ts`,
              `+++ b/src/round-${executionCalls}.test.ts`,
              `+expect(${executionCalls}).toBe(${executionCalls})`,
              '',
            ].join('\n'),
            output: `execution ${executionCalls}`,
          } satisfies ExecutionAgentResult;
          currentDiff = result.diff;
          return result;
        },
      }),
    );

    const evidence = await run(selectedTask, { handoff: 'bounded handoff', contextMd: 'ctx' });

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(techLeadTestReviews).toBe(4);
    expect(executionCalls).toBe(6);
    expect(evidence.rolesInvoked).toEqual(
      expect.arrayContaining(['qa', 'tech-lead', 'coder', 'reviewer']),
    );
  });

  it('the production runner drives runTeamTaskWorkflow to ready-for-closeout — impossible for the old stub', async () => {
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: REAL_POLICY_PATH,
      },
      makeSeams(),
    );

    const evidence = await run(selectedTask, { handoff: 'bounded handoff', contextMd: 'ctx' });

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(evidence.rolesInvoked).toEqual(
      expect.arrayContaining(['qa', 'tech-lead', 'coder', 'reviewer']),
    );
    expect(evidence.blockedReason).toBeUndefined();
  });

  it('the hardcoded "not yet wired" stub reason can never come back', async () => {
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: REAL_POLICY_PATH,
      },
      makeSeams(),
    );
    const evidence = await run(selectedTask, { handoff: 'h', contextMd: 'c' });
    expect(evidence.blockedReason ?? '').not.toContain('not yet wired');
  });

  it('a missing model policy blocks durably with a truthful reason (never a fake run)', async () => {
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: '/nonexistent/model-policy.json',
      },
      makeSeams(),
    );

    const evidence = await run(selectedTask, { handoff: 'h', contextMd: 'c' });

    expect(evidence.outcome).toBe('blocked');
    expect(evidence.blockedReason ?? '').toMatch(/model policy/i);
  });

  it('manual/live gate tasks park for operator evidence without invoking the role workflow', async () => {
    const manualTask: SelectedTask = {
      id: 'live-release-gate',
      text: `**live-release-gate** — Operator verifies the live browser path ${MANUAL_LIVE_GATE_MARKER}`,
      section: 'Phase 3 - Release',
    };
    const preflightExecution = vi.fn(async () => {
      throw new Error('manual gates must not invoke executor preflight');
    });
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: '/nonexistent/model-policy.json',
      },
      makeSeams({
        preflightExecution,
        runExecution: async () => {
          throw new Error('manual gates must not invoke QA/coder execution');
        },
        judgmentCall: async () => {
          throw new Error('manual gates must not invoke judgment roles');
        },
      }),
    );

    const evidence = await run(manualTask, { handoff: 'h', contextMd: 'c' });

    expect(evidence.outcome).toBe('blocked');
    expect(evidence.rolesInvoked).toEqual([]);
    expect(evidence.blockedReason).toMatch(/manual\/live release gate/i);
    expect(evidence.blockedReason).toMatch(/operator evidence/i);
    expect(preflightExecution).not.toHaveBeenCalled();
  });

  it('blocks on typed preflight evidence before any judgment or execution role', async () => {
    const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const judgmentCall = vi.fn(greenJudgment);
    const runExecution = vi.fn(greenExecution);
    const rawSecret = 'sk-preflightRunnerSecret123456';
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: REAL_POLICY_PATH,
        emit: (event) => events.push(event),
      },
      makeSeams({
        judgmentCall,
        runExecution,
        preflightExecution: async () => ({
          status: 'failed',
          roles: ['qa', 'coder'],
          provider: 'openai',
          format: 'codex',
          model: 'gpt-coder',
          prerequisite: 'authentication',
          diagnostic: `${rawSecret} expired at ${REPO_ROOT}/private/auth.json`,
          remediation: 'run `codex login` and retry',
        }),
      }),
    );

    const evidence = await run(selectedTask, { handoff: 'h', contextMd: 'c' });

    expect(judgmentCall).not.toHaveBeenCalled();
    expect(runExecution).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      outcome: 'blocked',
      rolesInvoked: [],
      executionPreflight: {
        status: 'failed',
        roles: ['qa', 'coder'],
        prerequisite: 'authentication',
        provider: 'openai',
        format: 'codex',
        model: 'gpt-coder',
      },
    });
    expect(evidence.blockedReason).toMatch(/authentication.*qa, coder.*openai\/codex/i);
    expect(JSON.stringify(evidence)).not.toContain(rawSecret);
    expect(JSON.stringify(evidence)).not.toContain(REPO_ROOT);
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'activity',
        data: expect.objectContaining({
          event: 'executor-preflight',
          status: 'failed',
          prerequisite: 'authentication',
        }),
      }),
    ]);
  });

  it('caches a successful run-scoped preflight and emits its durable activity once', async () => {
    const preflightExecution = vi.fn(async () => ({
      status: 'success' as const,
      bindings: [
        { roles: ['qa', 'coder'] as Array<'qa' | 'coder'>, provider: 'openai' as const, format: 'codex' as const, model: 'gpt-coder' },
      ],
      artifactMcp: 'not-required' as const,
      artifactFormats: [],
    }));
    const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: REAL_POLICY_PATH,
        emit: (event) => events.push(event),
        cap: 1,
      },
      makeSeams({ preflightExecution }),
    );

    const [first, second] = await Promise.all([
      run(selectedTask, { handoff: 'h1', contextMd: 'c1' }),
      run(
        { ...selectedTask, id: 'demo-task-2', text: 'demo task two' },
        { handoff: 'h2', contextMd: 'c2' },
      ),
    ]);

    expect(first.outcome).toBe('ready-for-closeout');
    expect(second.outcome).toBe('ready-for-closeout');
    expect(preflightExecution).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.data?.['event'] === 'executor-preflight')).toEqual([
      expect.objectContaining({
        kind: 'activity',
        data: expect.objectContaining({ status: 'success', artifactMcp: 'not-required' }),
      }),
    ]);
  });

  it('never caches a failed preflight as success', async () => {
    const preflightExecution = vi.fn(async () => ({
      status: 'failed' as const,
      roles: ['qa'] as Array<'qa'>,
      provider: 'openai' as const,
      format: 'codex' as const,
      model: 'gpt-qa',
      prerequisite: 'model-call' as const,
      diagnostic: 'model temporarily unavailable',
      remediation: 'verify model access and retry',
    }));
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: REAL_POLICY_PATH,
      },
      makeSeams({ preflightExecution }),
    );

    await run(selectedTask, { handoff: 'h1', contextMd: 'c1' });
    await run(selectedTask, { handoff: 'h2', contextMd: 'c2' });

    expect(preflightExecution).toHaveBeenCalledTimes(2);
  });

  it('leaves tracked, staged, and untracked worktree state byte-for-byte unchanged on preflight failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'executor-preflight-worktree-'));
    try {
      const git = (gitArgs: string[]) => defaultRunGit(gitArgs, { cwd: dir });
      await git(['init', '--initial-branch', 'main']);
      await git(['config', 'user.email', 'test@example.com']);
      await git(['config', 'user.name', 'Test']);
      await writeFile(join(dir, 'tracked.ts'), 'baseline\n');
      await git(['add', '-A']);
      await git(['commit', '-m', 'baseline']);
      await writeFile(join(dir, 'tracked.ts'), 'unstaged change\n');
      await writeFile(join(dir, 'staged.ts'), 'staged change\n');
      await git(['add', 'staged.ts']);
      await writeFile(join(dir, 'untracked.ts'), 'untracked change\n');
      const before = await git(['status', '--porcelain=v1']);

      const run = createProductionTaskWorkflowRunner(
        {
          sandbox: { ...makeSandbox(), worktree: dir },
          productsConfigPath: '/nonexistent/products.json',
          modelPolicyPath: REAL_POLICY_PATH,
        },
        makeSeams({
          preflightExecution: async () => ({
            status: 'failed',
            roles: ['qa', 'coder'],
            provider: 'openai',
            format: 'codex',
            model: 'gpt-coder',
            prerequisite: 'binary',
            diagnostic: 'binary missing',
            remediation: 'install codex',
          }),
        }),
      );

      const evidence = await run(selectedTask, { handoff: 'h', contextMd: 'c' });
      const after = await git(['status', '--porcelain=v1']);

      expect(evidence.outcome).toBe('blocked');
      expect(after.stdout).toBe(before.stdout);
      expect(await readFile(join(dir, 'tracked.ts'), 'utf8')).toBe('unstaged change\n');
      expect(await readFile(join(dir, 'staged.ts'), 'utf8')).toBe('staged change\n');
      expect(await readFile(join(dir, 'untracked.ts'), 'utf8')).toBe('untracked change\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('canonical reviewer diff production seam', () => {
  it('stages tracked and untracked task changes and captures the deterministic full-task diff', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'canonical-review-diff-'));
    try {
      const git = (gitArgs: string[]) => defaultRunGit(gitArgs, { cwd: worktree });
      await git(['init', '--initial-branch', 'main']);
      await git(['config', 'user.email', 'test@example.com']);
      await git(['config', 'user.name', 'Test']);
      await writeFile(join(worktree, 'tracked.ts'), 'baseline\n');
      await writeFile(join(worktree, 'staged.ts'), 'baseline staged\n');
      await writeFile(join(worktree, 'deleted.ts'), 'delete me\n');
      await git(['add', '-A']);
      await git(['commit', '-m', 'baseline']);
      const taskBaseTree = (await git(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
      await writeFile(join(worktree, 'tracked.ts'), 'tracked change\n');
      await writeFile(join(worktree, 'staged.ts'), 'staged change\n');
      await git(['add', 'staged.ts']);
      await rm(join(worktree, 'deleted.ts'));
      await writeFile(join(worktree, 'new-untracked.ts'), 'untracked change\n');

      // Compute the exact artifact a truthful coder would return, then restore
      // the mixed tracked/untracked state so the production seam must stage it.
      await git(['add', '-A']);
      const expected = (await git(['diff', 'HEAD', '--'])).stdout;
      await git(['reset']);

      const result = await captureCanonicalReviewState(
        defaultRunGit,
        worktree,
        taskBaseTree,
      );

      expect(result).toMatchObject({ diff: expected, baseTree: taskBaseTree });
      expect(result.diff).toContain('tracked.ts');
      expect(result.diff).toContain('staged.ts');
      expect(result.diff).toContain('deleted.ts');
      expect(result.diff).toContain('deleted file mode');
      expect(result.diff).toContain('new-untracked.ts');
      expect(result.diff).toContain('new file mode');
      expect((await git(['status', '--porcelain'])).stdout).toContain('A  new-untracked.ts');
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it('keeps earlier task changes visible after a role-created commit advances HEAD', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'canonical-review-committed-round-'));
    try {
      const git = (gitArgs: string[]) => defaultRunGit(gitArgs, { cwd: worktree });
      await git(['init', '--initial-branch', 'main']);
      await git(['config', 'user.email', 'test@example.com']);
      await git(['config', 'user.name', 'Test']);
      await writeFile(join(worktree, 'src.ts'), 'export const baseline = true;\n');
      await git(['add', '-A']);
      await git(['commit', '-m', 'baseline']);
      const taskBaseTree = (await git(['rev-parse', 'HEAD^{tree}'])).stdout.trim();

      await writeFile(
        join(worktree, 'helper.ts'),
        'export const helperFromRoundOne = true;\n',
      );
      await git(['add', '-A']);
      await git(['commit', '-m', 'role-created round-one commit']);
      await writeFile(
        join(worktree, 'src.ts'),
        'import { helperFromRoundOne } from "./helper.js";\n' +
          'export const baseline = helperFromRoundOne;\n',
      );

      const result = await captureCanonicalReviewState(
        defaultRunGit,
        worktree,
        taskBaseTree,
      );

      expect(result.baseTree).toBe(taskBaseTree);
      expect(result.diff).toContain('helperFromRoundOne');
      expect(result.diff).toContain('new file mode');
      expect(result.diff).toContain('src.ts');
      expect(result.changedPaths).toEqual(['helper.ts', 'src.ts']);
      expect(result.currentTree).not.toBe(taskBaseTree);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test-intent repair — the production techLeadRepairTests seam
// ---------------------------------------------------------------------------

describe('techLeadRepairTests (production seam)', () => {
  const repairQa = { kind: 'tests-written' as const, testIds: ['src/x.test.ts'] };
  const repairRejection = {
    reason: 'tests miss the negative case',
    suggestedChange: 'assert no cue for the viewed product',
  };

  type GitFakeOpts = {
    preTree?: string;
    postTree?: string;
    delta?: Array<{ status: string; path: string }>;
    diffHead?: string;
  };

  /** Scripted git fake for the snapshot → delta → guard mechanics. Records
   *  every invocation so tests can assert exact revert/delete calls. */
  function makeRepairGitFake(opts: GitFakeOpts = {}) {
    const calls: string[][] = [];
    let writeTreeCalls = 0;
    const runGit = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      calls.push(args);
      if (args[0] === 'write-tree') {
        writeTreeCalls += 1;
        return {
          stdout: writeTreeCalls === 1 ? (opts.preTree ?? 'tree-pre') : (opts.postTree ?? 'tree-post'),
          stderr: '',
        };
      }
      if (args[0] === 'diff-tree') {
        const z = (opts.delta ?? []).map((e) => `${e.status}\0${e.path}`).join('\0');
        return { stdout: z === '' ? '' : `${z}\0`, stderr: '' };
      }
      if (args[0] === 'diff') {
        return { stdout: opts.diffHead ?? '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    return { runGit, calls };
  }

  const redValidation = async (): Promise<
    { ok: false; command: string; result: { exitCode: number; timedOut: boolean; outputTail: string } }
  > => ({
    ok: false,
    command: 'npm test',
    result: { exitCode: 1, timedOut: false, outputTail: 'FAIL src/x.test.ts — 1 failed' },
  });

  function buildRepairDeps(
    seams: Partial<TeamTaskSeams>,
    validationCommands?: string[],
  ): TeamTaskDeps {
    return buildProductionTeamTaskDeps(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        models: resolveTeamRoleModels(loadRealPolicy()),
        ...(validationCommands !== undefined ? { validationCommands } : {}),
      },
      makeSeams(seams),
    );
  }

  it('returns not-repaired without spawning the executor when the snapshot fails', async () => {
    let executorCalls = 0;
    const deps = buildRepairDeps({
      runGit: async () => {
        throw new Error('git exploded');
      },
      runExecution: async () => {
        executorCalls += 1;
        return { ok: true, diff: '', output: '' };
      },
    });

    const result = await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: repairQa,
      rejection: repairRejection,
    });

    expect(result).toEqual({
      kind: 'not-repaired',
      reason: 'tech-lead repair failed: git exploded',
    });
    expect(executorCalls).toBe(0);
  });

  it('runs the tech-lead executor with the rejection context and repairs on a red check', async () => {
    const executions: Array<{
      prompt: string;
      systemPrompt: string | undefined;
      model: unknown;
      role: string;
    }> = [];
    const git = makeRepairGitFake({
      delta: [{ status: 'M', path: 'src/x.test.ts' }],
      diffHead: 'diff --git a/src/x.test.ts b/src/x.test.ts\n+++ b/src/x.test.ts\n+patched assertion\n',
    });
    const deps = buildRepairDeps(
      {
        runGit: git.runGit,
        runExecution: async (opts) => {
          executions.push({
            prompt: opts.prompt,
            systemPrompt: opts.systemPrompt,
            model: opts.model,
            role: opts.role,
          });
          return { ok: true, diff: 'scrubbed-executor-diff', output: 'patched' };
        },
        runRepairValidation: redValidation,
      },
      ['npm test'],
    );

    const result = await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'the spec body',
      qa: repairQa,
      rejection: repairRejection,
    });

    expect(result).toMatchObject({
      kind: 'repaired',
      testIds: ['src/x.test.ts'],
      redCheck: {
        kind: 'red',
        command: 'npm test',
        exitCode: 1,
        outputTail: 'FAIL src/x.test.ts — 1 failed',
      },
    });
    expect(executions).toHaveLength(1);
    expect(executions[0]!.role).toBe('tech-lead');
    expect(executions[0]?.prompt).toContain('tests miss the negative case');
    expect(executions[0]?.prompt).toContain('assert no cue for the viewed product');
    expect(executions[0]?.prompt).toContain('the spec body');
    expect(executions[0]?.prompt).toContain('src/x.test.ts');
    expect(executions[0]?.systemPrompt).toContain('Edit ONLY test files');
    expect(executions[0]?.model).toMatchObject({ alias: 'fable', provider: 'anthropic' });
  });

  it('runs tech-lead confirm-red validation from the already-validated harness cwd', async () => {
    const validationCommandCwd = '/validated/worktree/harness';
    const validationCalls: Array<{
      commands: readonly string[];
      cwd: string;
      timeoutMs: number;
    }> = [];
    const git = makeRepairGitFake({
      delta: [{ status: 'M', path: 'src/x.test.ts' }],
      diffHead: '+++ b/src/x.test.ts\n+patched assertion\n',
    });
    const deps = buildProductionTeamTaskDeps(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        models: resolveTeamRoleModels(loadRealPolicy()),
        validationCommands: ['uv run pytest'],
        validationCommandCwd,
        validationCwdLabel: 'harness/',
      },
      makeSeams({
        runGit: git.runGit,
        resolveValidationCwd: () => ({ ok: true, cwd: validationCommandCwd }),
        runRepairValidation: async (commands, cwd, timeoutMs) => {
          validationCalls.push({ commands, cwd, timeoutMs });
          return {
            ok: false,
            command: 'uv run pytest',
            result: { exitCode: 1, timedOut: false, outputTail: 'expected red test' },
          };
        },
      }),
    );

    const result = await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: repairQa,
      rejection: repairRejection,
    });

    expect(result).toMatchObject({ kind: 'repaired' });
    expect(validationCalls).toEqual([{
      commands: ['uv run pytest'],
      cwd: validationCommandCwd,
      timeoutMs: 600_000,
    }]);
  });

  it('revalidates the harness cwd immediately before confirm-red and skips execution after a symlink escape', async () => {
    const runRepairValidation = vi.fn();
    const git = makeRepairGitFake({
      delta: [{ status: 'M', path: 'src/x.test.ts' }],
      diffHead: '+++ b/src/x.test.ts\n+patched assertion\n',
    });
    const deps = buildProductionTeamTaskDeps(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        models: resolveTeamRoleModels(loadRealPolicy()),
        validationCommands: ['uv run pytest'],
        validationCommandCwd: '/validated/worktree/harness',
        validationCwdLabel: 'harness/',
      },
      makeSeams({
        runGit: git.runGit,
        resolveValidationCwd: () => ({
          ok: false,
          failure: {
            kind: 'invalid-validation-cwd',
            command: '',
            prerequisite: 'validationCwd',
            validationCwd: 'harness/',
            exitCode: null,
            timedOut: false,
            diagnostics: '',
          },
        }),
        runRepairValidation,
      }),
    );

    const result = await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: repairQa,
      rejection: repairRejection,
    });

    expect(result).toMatchObject({
      kind: 'not-repaired',
      reason: expect.stringMatching(/validation directory became invalid/i),
    });
    expect(runRepairValidation).not.toHaveBeenCalled();
  });

  it('reverts a product-source write from the delta and proceeds with the surviving test patch', async () => {
    const git = makeRepairGitFake({
      delta: [
        { status: 'M', path: 'src/x.test.ts' },
        { status: 'M', path: 'src/prod.ts' },
        { status: 'A', path: 'src/new-helper.ts' },
      ],
      diffHead: '+++ b/src/x.test.ts\n+patched\n',
    });
    const deps = buildRepairDeps(
      { runGit: git.runGit, runRepairValidation: redValidation },
      ['npm test'],
    );

    const result = await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: repairQa,
      rejection: repairRejection,
    });

    expect(result).toMatchObject({ kind: 'repaired', testIds: ['src/x.test.ts'] });
    expect(git.calls).toContainEqual([
      'restore', '--source', 'tree-pre', '--staged', '--worktree', '--', 'src/prod.ts',
    ]);
    expect(git.calls).toContainEqual(['rm', '-f', '--', 'src/new-helper.ts']);
    // The surviving test patch must NOT be reverted.
    expect(git.calls).not.toContainEqual([
      'restore', '--source', 'tree-pre', '--staged', '--worktree', '--', 'src/x.test.ts',
    ]);
  });

  it('rolls back and returns not-repaired when the repair touched only non-test paths', async () => {
    const git = makeRepairGitFake({
      delta: [{ status: 'M', path: 'src/prod.ts' }],
    });
    const deps = buildRepairDeps(
      { runGit: git.runGit, runRepairValidation: redValidation },
      ['npm test'],
    );

    const result = await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: repairQa,
      rejection: repairRejection,
    });

    expect(result).toEqual({
      kind: 'not-repaired',
      reason: 'repair touched only non-test paths — reverted',
    });
    expect(git.calls).toContainEqual([
      'restore', '--source', 'tree-pre', '--staged', '--worktree', '--', 'src/prod.ts',
    ]);
  });

  it('never treats QA-touched product source as an allowed repair path (codex review finding)', async () => {
    // QA strayed into product source during test-writing, so its diff paths —
    // and therefore qa.testIds — include src/prod.ts. That must NOT license
    // the tech-lead repair to edit the same source file.
    const strayQa = {
      kind: 'tests-written' as const,
      testIds: ['src/x.test.ts', 'src/prod.ts'],
    };
    const git = makeRepairGitFake({
      delta: [
        { status: 'M', path: 'src/x.test.ts' },
        { status: 'M', path: 'src/prod.ts' },
      ],
      diffHead: '+++ b/src/x.test.ts\n+patched\n',
    });
    const deps = buildRepairDeps(
      { runGit: git.runGit, runRepairValidation: redValidation },
      ['npm test'],
    );

    const result = await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: strayQa,
      rejection: repairRejection,
    });

    expect(result).toMatchObject({ kind: 'repaired' });
    expect(git.calls).toContainEqual([
      'restore', '--source', 'tree-pre', '--staged', '--worktree', '--', 'src/prod.ts',
    ]);
    expect(git.calls).not.toContainEqual([
      'restore', '--source', 'tree-pre', '--staged', '--worktree', '--', 'src/x.test.ts',
    ]);
  });

  it('rolls back a QA-stray-path-only repair even when qa.testIds lists that path', async () => {
    const strayQa = {
      kind: 'tests-written' as const,
      testIds: ['src/x.test.ts', 'src/prod.ts'],
    };
    const git = makeRepairGitFake({
      delta: [{ status: 'M', path: 'src/prod.ts' }],
    });
    const deps = buildRepairDeps(
      { runGit: git.runGit, runRepairValidation: redValidation },
      ['npm test'],
    );

    const result = await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: strayQa,
      rejection: repairRejection,
    });

    expect(result).toEqual({
      kind: 'not-repaired',
      reason: 'repair touched only non-test paths — reverted',
    });
    expect(git.calls).toContainEqual([
      'restore', '--source', 'tree-pre', '--staged', '--worktree', '--', 'src/prod.ts',
    ]);
  });

  it('advertises only guard-editable test files in the repair prompt', async () => {
    const strayQa = {
      kind: 'tests-written' as const,
      testIds: ['src/x.test.ts', 'src/prod.ts'],
    };
    let repairPrompt = '';
    const git = makeRepairGitFake({
      delta: [{ status: 'M', path: 'src/x.test.ts' }],
    });
    const deps = buildRepairDeps(
      {
        runGit: git.runGit,
        runExecution: async (opts) => {
          repairPrompt = opts.prompt;
          return { ok: true, diff: 'ignored', output: 'patched' };
        },
        runRepairValidation: redValidation,
      },
      ['npm test'],
    );

    await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: strayQa,
      rejection: repairRejection,
    });

    const testFilesSection = /## QA test files\n\n([^#]*)/.exec(repairPrompt)?.[1] ?? '';
    expect(testFilesSection).toContain('src/x.test.ts');
    expect(testFilesSection).not.toContain('src/prod.ts');
  });

  it('returns not-repaired when the executor made no changes', async () => {
    const git = makeRepairGitFake({ preTree: 'tree-same', postTree: 'tree-same' });
    const deps = buildRepairDeps(
      { runGit: git.runGit, runRepairValidation: redValidation },
      ['npm test'],
    );

    const result = await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: repairQa,
      rejection: repairRejection,
    });

    expect(result).toEqual({ kind: 'not-repaired', reason: 'tech-lead made no changes' });
  });

  it('rolls the patch back and returns not-repaired when the suite is green pre-implementation', async () => {
    const git = makeRepairGitFake({
      delta: [{ status: 'M', path: 'src/x.test.ts' }],
    });
    const deps = buildRepairDeps(
      {
        runGit: git.runGit,
        runRepairValidation: async () => ({ ok: true }),
      },
      ['npm test'],
    );

    const result = await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: repairQa,
      rejection: repairRejection,
    });

    expect(result).toEqual({
      kind: 'not-repaired',
      reason:
        'patched tests pass with no implementation — vacuous or behavior-pinning; routing back to QA',
    });
    expect(git.calls).toContainEqual([
      'restore', '--source', 'tree-pre', '--staged', '--worktree', '--', 'src/x.test.ts',
    ]);
  });

  it('rolls the patch back and returns not-repaired when the confirm-red run times out', async () => {
    const git = makeRepairGitFake({
      delta: [{ status: 'M', path: 'src/x.test.ts' }],
    });
    const deps = buildRepairDeps(
      {
        runGit: git.runGit,
        runRepairValidation: async () => ({
          ok: false,
          command: 'npm test',
          result: { exitCode: null, timedOut: true, outputTail: '' },
        }),
      },
      ['npm test'],
    );

    const result = await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: repairQa,
      rejection: repairRejection,
    });

    expect(result).toEqual({
      kind: 'not-repaired',
      reason: 'confirm-red run timed out on: npm test',
    });
    expect(git.calls).toContainEqual([
      'restore', '--source', 'tree-pre', '--staged', '--worktree', '--', 'src/x.test.ts',
    ]);
  });

  it('skips the red check when no validation commands are configured', async () => {
    const git = makeRepairGitFake({
      delta: [{ status: 'M', path: 'src/x.test.ts' }],
    });
    let validationCalls = 0;
    const deps = buildRepairDeps({
      runGit: git.runGit,
      runRepairValidation: async () => {
        validationCalls += 1;
        return { ok: true };
      },
    });

    const result = await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: repairQa,
      rejection: repairRejection,
    });

    expect(result).toMatchObject({
      kind: 'repaired',
      redCheck: { kind: 'skipped', reason: 'no validation commands configured' },
    });
    expect(validationCalls).toBe(0);
  });

  it('merges new test files into testIds and drops nothing QA authored', async () => {
    const git = makeRepairGitFake({
      delta: [
        { status: 'M', path: 'src/x.test.ts' },
        { status: 'A', path: 'src/x-negative.test.ts' },
      ],
    });
    const deps = buildRepairDeps({ runGit: git.runGit });

    const result = await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: repairQa,
      rejection: repairRejection,
    });

    expect(result).toMatchObject({
      kind: 'repaired',
      testIds: ['src/x.test.ts', 'src/x-negative.test.ts'],
    });
  });

  it('feeds the patched diff and confirm-red evidence into the next tech-lead review', async () => {
    const reviewBodies: string[] = [];
    const git = makeRepairGitFake({
      delta: [{ status: 'M', path: 'src/x.test.ts' }],
      diffHead: '+++ b/src/x.test.ts\n+the patched negative assertion\n',
    });
    const deps = buildRepairDeps(
      {
        runGit: git.runGit,
        runRepairValidation: redValidation,
        judgmentCall: async ({ message }) => {
          reviewBodies.push(message);
          return GREEN_JUDGMENT_REPLY;
        },
      },
      ['npm test'],
    );

    await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: repairQa,
      rejection: repairRejection,
    });
    await deps.techLeadReviewTests({ task: sizedTask, qa: repairQa });

    expect(reviewBodies).toHaveLength(1);
    expect(reviewBodies[0]).toContain('the patched negative assertion');
    expect(reviewBodies[0]).toContain('Confirm-red evidence (post-repair)');
    expect(reviewBodies[0]).toContain('`npm test` exited 1');
    expect(reviewBodies[0]).toContain('FAIL src/x.test.ts — 1 failed');
  });

  it('clears stale confirm-red evidence when QA writes fresh tests', async () => {
    const reviewBodies: string[] = [];
    const git = makeRepairGitFake({
      delta: [{ status: 'M', path: 'src/x.test.ts' }],
    });
    const deps = buildRepairDeps(
      {
        runGit: git.runGit,
        runRepairValidation: redValidation,
        judgmentCall: async ({ message }) => {
          reviewBodies.push(message);
          return GREEN_JUDGMENT_REPLY;
        },
      },
      ['npm test'],
    );

    await deps.techLeadRepairTests!({
      task: sizedTask,
      spec: 'spec',
      qa: repairQa,
      rejection: repairRejection,
    });
    await deps.qaWriteTests({ task: sizedTask, spec: 'spec' });
    await deps.techLeadReviewTests({ task: sizedTask, qa: repairQa });

    expect(reviewBodies).toHaveLength(1);
    expect(reviewBodies[0]).not.toContain('Confirm-red evidence');
  });

  it('parses repairable out of the tl-test-review verdict and omits it when absent', async () => {
    const replies = [
      '```tl-test-review\n{"approved": false, "notes": "structural", "repairable": false}\n```',
      '```tl-test-review\n{"approved": false, "notes": "bounded gap", "repairable": true}\n```',
      '```tl-test-review\n{"approved": false, "notes": "no flag"}\n```',
    ];
    let call = 0;
    const deps = buildRepairDeps({
      judgmentCall: async () => replies[call++]!,
    });

    const first = await deps.techLeadReviewTests({ task: sizedTask, qa: repairQa });
    const second = await deps.techLeadReviewTests({ task: sizedTask, qa: repairQa });
    const third = await deps.techLeadReviewTests({ task: sizedTask, qa: repairQa });

    expect(first).toMatchObject({ approved: false, repairable: false });
    expect(second).toMatchObject({ approved: false, repairable: true });
    expect(third.repairable).toBeUndefined();
    expect(third.approved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test-intent repair — guard mechanics against a REAL temp git worktree
// ---------------------------------------------------------------------------

describe('techLeadRepairTests (real git integration)', () => {
  it('restores a product-source write on disk and keeps the test patch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'repair-guard-'));
    try {
      const git = (args: string[]) => defaultRunGit(args, { cwd: dir });
      await git(['init', '--initial-branch', 'main']);
      await git(['config', 'user.email', 'test@example.com']);
      await git(['config', 'user.name', 'Test']);
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'prod.ts'), 'export const original = true;\n');
      await git(['add', '-A']);
      await git(['commit', '-m', 'baseline']);
      // QA's earlier session left uncommitted test work in the worktree.
      await writeFile(join(dir, 'src', 'x.test.ts'), 'test("qa", () => {});\n');

      const deps = buildProductionTeamTaskDeps(
        {
          sandbox: { ...makeSandbox(), worktree: dir },
          productsConfigPath: '/nonexistent/products.json',
          models: resolveTeamRoleModels(loadRealPolicy()),
        },
        makeSeams({
          runGit: defaultRunGit,
          // The "tech-lead" patches the test file but ALSO rewrites product
          // source and drops a stray helper — both must be reverted on disk.
          runExecution: async () => {
            await writeFile(
              join(dir, 'src', 'x.test.ts'),
              'test("qa", () => {});\ntest("negative", () => {});\n',
            );
            await writeFile(join(dir, 'src', 'prod.ts'), 'export const hacked = true;\n');
            await writeFile(join(dir, 'src', 'new-helper.ts'), 'export const stray = 1;\n');
            return { ok: true, diff: 'ignored', output: 'patched' };
          },
        }),
      );

      const result = await deps.techLeadRepairTests!({
        task: sizedTask,
        spec: 'spec',
        qa: { kind: 'tests-written', testIds: ['src/x.test.ts'] },
        rejection: { reason: 'missing negative assertion' },
      });

      expect(result).toMatchObject({
        kind: 'repaired',
        testIds: ['src/x.test.ts'],
        redCheck: { kind: 'skipped' },
      });
      // Product source restored byte-for-byte; the stray helper is gone.
      expect(await readFile(join(dir, 'src', 'prod.ts'), 'utf8')).toBe(
        'export const original = true;\n',
      );
      expect(existsSync(join(dir, 'src', 'new-helper.ts'))).toBe(false);
      // The test patch survives — QA's line plus the tech-lead's addition.
      expect(await readFile(join(dir, 'src', 'x.test.ts'), 'utf8')).toBe(
        'test("qa", () => {});\ntest("negative", () => {});\n',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rolls the whole repair back on disk when it touched only product source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'repair-rollback-'));
    try {
      const git = (args: string[]) => defaultRunGit(args, { cwd: dir });
      await git(['init', '--initial-branch', 'main']);
      await git(['config', 'user.email', 'test@example.com']);
      await git(['config', 'user.name', 'Test']);
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'prod.ts'), 'export const original = true;\n');
      await git(['add', '-A']);
      await git(['commit', '-m', 'baseline']);

      const deps = buildProductionTeamTaskDeps(
        {
          sandbox: { ...makeSandbox(), worktree: dir },
          productsConfigPath: '/nonexistent/products.json',
          models: resolveTeamRoleModels(loadRealPolicy()),
        },
        makeSeams({
          runGit: defaultRunGit,
          runExecution: async () => {
            await writeFile(join(dir, 'src', 'prod.ts'), 'export const hacked = true;\n');
            return { ok: true, diff: 'ignored', output: 'patched' };
          },
        }),
      );

      const result = await deps.techLeadRepairTests!({
        task: sizedTask,
        spec: 'spec',
        qa: { kind: 'tests-written', testIds: ['src/x.test.ts'] },
        rejection: { reason: 'missing negative assertion' },
      });

      expect(result).toEqual({
        kind: 'not-repaired',
        reason: 'repair touched only non-test paths — reverted',
      });
      expect(await readFile(join(dir, 'src', 'prod.ts'), 'utf8')).toBe(
        'export const original = true;\n',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
