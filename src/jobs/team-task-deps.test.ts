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
 *   - `policies/model-policy.json` carries the Phase 8 model map:
 *     pm/tech-lead/reviewer/designer → `opus` (anthropic), qa/coder →
 *     `gpt-5.5` (openai)
 *   - the orchestrated applier's production `runTaskWorkflow` calls through
 *     to `runTeamTaskWorkflow` — the "orchestrated role execution not yet
 *     wired" blocked path is gone and cannot reappear without failing here
 *
 * Model calls are injected throughout; these tests assert wiring, not live
 * output. See tasks.md Phase 8.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildProductionTeamTaskDeps,
  createProductionTaskWorkflowRunner,
  resolveTeamRoleModels,
  type JudgmentModelCall,
  type TeamRoleModels,
  type TeamTaskSeams,
} from './team-task-deps.js';
import {
  __getRuntimeDepsForTest,
  __resetOrchestratedRuntimeForTest,
} from './orchestrated-work-runner.js';
import { parsePolicy, type ModelPolicy } from '../intent/model-policy.js';
import { runTeamTaskWorkflow, type TeamTaskDeps } from '../intent/team-task-workflow.js';
import type { SizedTask } from '../intent/planning-roles.js';
import type { SelectedTask } from '../intent/orch-task-select.js';
import type { SandboxSpec } from '../intent/sandbox.js';
import type { ExecutionAgentResult } from './execution-agent.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Repo root derived from this file's location (src/jobs/ → ../..) — avoids a
// direct config.js import (and its required-env-var reads) for a path constant.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REAL_POLICY_PATH = join(REPO_ROOT, 'policies', 'model-policy.json');

function loadRealPolicy(): ModelPolicy {
  return parsePolicy(readFileSync(REAL_POLICY_PATH, 'utf8'));
}

function makeSandbox(): SandboxSpec {
  return {
    product: 'jarvis',
    project: 'demo',
    worktree: '/tmp/fake-worktree',
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

const selectedTask: SelectedTask = { id: 'demo-task', text: 'demo task', section: 'Phase 1' };

/** A green judgment reply: contains every fenced verdict block, so each
 *  seam's parser finds its own tag regardless of which role is asked. */
const GREEN_JUDGMENT_REPLY = [
  '```tl-test-review',
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

const GATE_VERDICT_OUTCOMES = ['pass', 'pass-with-warnings', 'fail'] as const;

function makeSeams(overrides: Partial<TeamTaskSeams> = {}): Partial<TeamTaskSeams> {
  return { judgmentCall: greenJudgment, runExecution: greenExecution, ...overrides };
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
  it('registers both Phase 8 aliases: opus (anthropic/claude) and gpt-5.5 (openai/codex)', () => {
    const policy = loadRealPolicy();
    const opus = policy.models.find((m) => m.alias === 'opus');
    const gpt = policy.models.find((m) => m.alias === 'gpt-5.5');

    expect(opus).toBeDefined();
    expect(opus?.provider).toBe('anthropic');
    expect(opus?.format).toBe('claude');

    expect(gpt).toBeDefined();
    expect(gpt?.provider).toBe('openai');
    expect(gpt?.format).toBe('codex');
  });

  it('resolves pm/tech-lead/reviewer/designer → opus and qa/coder → gpt-5.5 via roleDefaults', () => {
    const models = resolveTeamRoleModels(loadRealPolicy());

    expect(models.pm).toMatchObject({ alias: 'opus', provider: 'anthropic' });
    expect(models.techLead).toMatchObject({ alias: 'opus', provider: 'anthropic' });
    expect(models.designer).toMatchObject({ alias: 'opus', provider: 'anthropic' });
    expect(models.reviewer).toMatchObject({ alias: 'opus', provider: 'anthropic' });

    expect(models.qa).toMatchObject({ alias: 'gpt-5.5', provider: 'openai' });
    expect(models.coder).toMatchObject({ alias: 'gpt-5.5', provider: 'openai' });
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
  it('binds all eight role seams as functions', () => {
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()));

    const seamNames: Array<keyof TeamTaskDeps> = [
      'qaWriteTests',
      'techLeadReviewTests',
      'coder',
      'reviewer',
      'techLeadReviewDiff',
      'designer',
      'pmWrapup',
      'resolveReviewerProvider',
    ];
    for (const name of seamNames) {
      expect(typeof deps[name], `seam ${String(name)}`).toBe('function');
    }
  });

  it('resolveReviewerProvider returns the distinct provider from the resolved bindings', () => {
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()));
    expect(deps.resolveReviewerProvider('openai')).toBe('anthropic');
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

  it('judgment seams parse fenced verdicts from the injected model call (no live call), passing the resolved model', async () => {
    const calls: Array<{ role: string; model: string }> = [];
    const judgment: JudgmentModelCall = async ({ role, model }) => {
      calls.push({ role, model });
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
    // Judgment roles run on the policy-resolved opus binding.
    expect(calls.every((c) => c.model === 'opus')).toBe(true);
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

  it('judgment seams fail closed on an unparseable reply', async () => {
    const deps = buildDeps(
      resolveTeamRoleModels(loadRealPolicy()),
      makeSeams({ judgmentCall: async () => 'no fenced block here' }),
    );

    const verdict = await deps.reviewer({
      diff: 'd',
      spec: 's',
      tests: 't',
      task: sizedTask,
      context: 'c',
      reviewerProvider: 'anthropic',
    });
    const structured = verdict as unknown as Record<string, unknown>;
    expect(structured['outcome']).toBe('fail');
    expect(structured).not.toHaveProperty('pass');

    const tl = await deps.techLeadReviewTests({ task: sizedTask, qa: { kind: 'tests-written', testIds: [] } });
    expect(tl.approved).toBe(false);

    const pm = await deps.pmWrapup({ task: sizedTask, reason: 'cap' });
    expect(pm.resolved).toBe(false);
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
      makeSeams({ runExecution: async () => ({ ok: false, error: 'codex unavailable' }) }),
    );

    const evidence = await runTeamTaskWorkflow(
      sizedTask,
      { spec: 's', contextMd: 'c', coderProvider: 'openai', cap: 2 },
      deps,
    );
    expect(evidence.outcome).toBe('failed');
    expect(evidence.failureReason).toContain('codex unavailable');
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
    const lines = events.filter((event) => typeof event.data?.['line'] === 'string');
    expect(lines.length).toBeGreaterThan(0);
    const expectedByRole = new Map([
      ['qa', { role: 'qa', provider: 'openai', model: 'gpt-5.5' }],
      ['tech-lead', { role: 'tech-lead', provider: 'anthropic', model: 'opus' }],
      ['coder', { role: 'coder', provider: 'openai', model: 'gpt-5.5' }],
      ['reviewer', { role: 'reviewer', provider: 'anthropic', model: 'opus' }],
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
    expect(executorLines).toHaveLength(2);
    expectAttributedLine(executorLines[0]!, {
      role: 'qa',
      provider: 'openai',
      model: 'gpt-5.5',
    });
    expectAttributedLine(executorLines[1]!, {
      role: 'coder',
      provider: 'openai',
      model: 'gpt-5.5',
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
    expect(executorLines).toHaveLength(2);
    for (const line of executorLines) {
      expectAttributedLine(line, {
        role: String(line.data?.['role']),
        provider: 'openai',
        model: 'gpt-5.5',
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
  it('the orchestrated applier production runtime binds createProductionTaskWorkflowRunner', () => {
    __resetOrchestratedRuntimeForTest();
    const runtime = __getRuntimeDepsForTest();
    expect(runtime.createTaskWorkflowRunner).toBe(createProductionTaskWorkflowRunner);
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
});
