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
import {
  runTeamTaskWorkflow,
  type FindingsLedgerEntry,
  type TeamTaskDeps,
} from '../intent/team-task-workflow.js';
import type { SizedTask } from '../intent/planning-roles.js';
import type { SelectedTask } from '../intent/orch-task-select.js';
import { MANUAL_LIVE_GATE_MARKER } from '../intent/planning-artifact.js';
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
    product: 'rune',
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

function echoSelfReviewArtifact(message: string): string | undefined {
  const match = /```self-review-artifact\s*\n[\s\S]*?\n```/.exec(message);
  return match?.[0];
}

const greenJudgment: JudgmentModelCall = async ({ message }) =>
  echoSelfReviewArtifact(message) ?? GREEN_JUDGMENT_REPLY;

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
    // Judgment roles run on the policy-resolved opus binding.
    expect(calls.every((c) => c.model === 'opus')).toBe(true);
    expect(calls.every((c) => c.provider === 'anthropic')).toBe(true);
    expect(calls.every((c) => c.format === 'claude')).toBe(true);
  });

  it('routes coder self-review through the coder model binding, not the judgment-role binding', async () => {
    const calls: Array<{ role: string; model: string; provider?: string; format?: string; selfReview: boolean }> = [];
    const judgment: JudgmentModelCall = async ({ role, model, provider, format, message }) => {
      const selfReviewEcho = echoSelfReviewArtifact(message);
      calls.push({ role, model, provider, format, selfReview: selfReviewEcho !== undefined });
      if (selfReviewEcho !== undefined) return selfReviewEcho;
      return GREEN_JUDGMENT_REPLY;
    };
    const deps = buildDeps(resolveTeamRoleModels(loadRealPolicy()), makeSeams({ judgmentCall: judgment }));

    const evidence = await runTeamTaskWorkflow(
      sizedTask,
      { spec: 'spec', contextMd: 'ctx', coderProvider: 'openai', cap: 1 },
      deps,
    );

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(calls).toContainEqual({
      role: 'coder',
      model: 'gpt-5.5',
      provider: 'openai',
      format: 'codex',
      selfReview: true,
    });
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

  it('instructs the reviewer it has no repo access and must not object to absence inferred from a partial diff', async () => {
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
    // No objection-class finding from mere absence in a partial diff.
    expect(lower).toContain('partial view');
    expect(lower).toContain('exported nowhere');
    expect(lower).toContain('never as an objection-class finding');
    // Diff-vs-tree dead-loop fix: the reviewer (the historical primary trigger)
    // must treat the now-provided branch tree-state evidence as positive proof a
    // deliverable already landed out-of-sequence, not only suppress absence
    // objections. Mirrors the tech-lead diff gate.
    expect(lower).toContain('whole branch');
    expect(lower).toContain('earlier commit on this branch');
    expect(lower).toContain('tree-state evidence');
    // Test-deletion guardrail: an unjustified deleted/weakened test is an
    // ordinary fail, judged against the coder's handoff-note justification.
    expect(lower).toContain('test-deletion guardrail');
    expect(lower).toContain('deletes or weakens a test');
    expect(lower).toContain('coder handoff notes');
    expect(lower).toContain('fail outcome');
    expect(lower).toContain('not an objection class');
  });

  it('instructs the tech-lead diff gate to judge provided tree state, not only absence from a partial diff', async () => {
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
    expect(lowerPrompt).toContain('partial view');
    expect(lowerPrompt).toContain('missing-from-this-diff');
    expect(lowerPrompt).toContain('tree-state/context evidence');
    expect(lowerPrompt).toContain('diff regresses it');
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

  it('defaults the production workflow runner to four feedback rounds when no cap override is provided', async () => {
    let executionCalls = 0;
    let techLeadTestReviews = 0;
    const judgment: JudgmentModelCall = async ({ role, message }) => {
      const selfReviewEcho = echoSelfReviewArtifact(message);
      if (selfReviewEcho !== undefined) return selfReviewEcho;
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
        runExecution: async () => {
          executionCalls += 1;
          return {
            ok: true,
            diff: [
              `diff --git a/src/round-${executionCalls}.test.ts b/src/round-${executionCalls}.test.ts`,
              `+++ b/src/round-${executionCalls}.test.ts`,
              `+expect(${executionCalls}).toBe(${executionCalls})`,
              '',
            ].join('\n'),
            output: `execution ${executionCalls}`,
          };
        },
      }),
    );

    const evidence = await run(selectedTask, { handoff: 'bounded handoff', contextMd: 'ctx' });

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(techLeadTestReviews).toBe(4);
    expect(executionCalls).toBe(5);
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
    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: '/nonexistent/model-policy.json',
      },
      makeSeams({
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
  });
});
