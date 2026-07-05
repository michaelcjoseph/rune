/**
 * Project 20 acceptance: one /plan approval path plus execution of a scaffolded task.
 *
 * The only model-like seams faked here are the text transports:
 * - `askClaudeWithContext` for the PM interview, PM/tech-lead self-review, and planner roles.
 * - `TeamTaskSeams` execution/judgment transports for the production team-task deps.
 *
 * The state machine, persistence restore, `runSelfReview`, progress emission,
 * `runDownstreamPlan`, scaffold approval wiring, and `runTeamTaskWorkflow` all run real.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockConfig,
  mockAskClaudeWithContext,
  mockCleanupSession,
  mockProbeCodexProvider,
  mockRunCodex,
  mockRunScaffoldApproval,
} = vi.hoisted(() => ({
  mockConfig: {
    LOGS_DIR: '/test/logs',
    PLANNING_SESSIONS_FILE: '/test/logs/planning-sessions.json',
    PLANNING_ARTIFACTS_DIR: '/test/logs/planning-artifacts',
    PROMOTIONS_FILE: '/test/logs/promotions.jsonl',
    MODEL_POLICY_FILE: '/test/logs/model-policy.json',
  },
  mockAskClaudeWithContext: vi.fn(),
  mockCleanupSession: vi.fn(),
  mockProbeCodexProvider: vi.fn(),
  mockRunCodex: vi.fn(),
  mockRunScaffoldApproval: vi.fn(),
}));

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/rune-acceptance-project-root',
  default: mockConfig,
}));

vi.mock('../ai/claude.js', () => ({
  askClaudeWithContext: mockAskClaudeWithContext,
  cleanupSession: mockCleanupSession,
}));

vi.mock('../ai/codex.js', () => ({
  probeCodexProvider: mockProbeCodexProvider,
  runCodex: mockRunCodex,
}));

vi.mock('../jobs/scaffold-approval.js', () => ({
  runScaffoldApproval: mockRunScaffoldApproval,
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { handleApprove } from '../bot/commands/approve.js';
import { buildProductionTeamTaskDeps, type JudgmentModelCall } from '../jobs/team-task-deps.js';
import type { ExecutionAgentResult, RoleModelBinding } from '../jobs/execution-agent.js';
import {
  createPlanningSession,
  getPlanningSession,
  restorePlanningSessions,
} from '../reviews/planning.js';
import { defaultScopingTurn, handlePlanningTurn } from '../reviews/planning-handler.js';
import { runTeamTaskWorkflow } from './team-task-workflow.js';
import type { PmSpecApprovalArtifact } from './planner.js';
import type { SizedTask } from './planning-roles.js';
import type { SandboxSpec } from './sandbox.js';
import type { MessageSender } from '../transport/sender.js';

type AskOptions = { opLabel?: string };

const CHAT_ID = 4242;

const FLAWED_PM_SPEC: PmSpecApprovalArtifact = {
  version: 2,
  kind: 'pm-spec',
  product: 'rune',
  title: 'Acceptance proof',
  spec: [
    'Build an acceptance proof for planning.',
    '',
    '## Requirements',
    '',
    '- User approves the PM spec.',
    '- After that, ask the user to approve generated tasks before scaffold.',
  ].join('\n'),
  assumptions: ['Use Rune itself as the product.'],
  selfReview: 'Drafted.',
};

const REVIEWED_PM_SPEC: PmSpecApprovalArtifact = {
  ...FLAWED_PM_SPEC,
  spec: [
    'Build an acceptance proof for planning.',
    '',
    '## Requirements',
    '',
    '- User approves the PM spec exactly once.',
    '- After approval, downstream planning and scaffold run automatically with progress.',
  ].join('\n'),
  selfReview: {
    revised: true,
    summary: 'Removed the retired second approval gate from the PM spec.',
  },
};

const INITIAL_TECH_SPEC = 'Initial tech spec omits a usable scaffold acceptance check.';
const REVIEWED_TECH_SPEC =
  'Reviewed tech spec includes a usable scaffold acceptance check before downstream roles consume it.';

const PLANNED_TASK: SizedTask = {
  id: 'acceptance-core',
  text: 'Execute the acceptance task and prove the revised coder diff reaches review.',
  phase: 'Phase 1 - Acceptance',
  testStrategy: 'code-tests-required',
  designerNeeded: false,
  roles: ['qa', 'coder', 'reviewer', 'tech-lead'],
};

const REVIEWED_TASK: SizedTask = {
  ...PLANNED_TASK,
  text: 'Execute the acceptance task, including the usable scaffold acceptance check and revised coder diff proof.',
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rune-acceptance-four-behaviors-'));
  mockConfig.LOGS_DIR = tmpDir;
  mockConfig.PLANNING_SESSIONS_FILE = join(tmpDir, 'planning-sessions.json');
  mockConfig.PLANNING_ARTIFACTS_DIR = join(tmpDir, 'planning-artifacts');
  mockConfig.PROMOTIONS_FILE = join(tmpDir, 'promotions.jsonl');
  mockConfig.MODEL_POLICY_FILE = join(tmpDir, 'model-policy.json');
  writeFileSync(
    mockConfig.MODEL_POLICY_FILE,
    JSON.stringify({
      models: [
        {
          alias: 'opus',
          provider: 'anthropic',
          format: 'claude',
          capabilities: [],
          costTier: 'high',
          status: 'preferred',
        },
      ],
      globalFallback: 'opus',
      roleDefaults: { pm: 'opus' },
      evaluatorDistinctFromGenerator: true,
    }),
    'utf8',
  );

  mockAskClaudeWithContext.mockReset();
  mockCleanupSession.mockReset();
  mockProbeCodexProvider.mockReset();
  mockRunCodex.mockReset();
  mockRunScaffoldApproval.mockReset();

  mockProbeCodexProvider.mockResolvedValue({ available: false, reason: 'fixture unavailable' });
  mockRunCodex.mockResolvedValue({ error: 'should not be called when probe is unavailable' });
  mockRunScaffoldApproval.mockResolvedValue({
    ok: true,
    slug: '20-acceptance-proof',
    agentText: 'Scaffolded docs/projects/20-acceptance-proof for task acceptance-core.',
    promotion: undefined,
  });

  restorePlanningSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('e2e-acceptance-four-behaviors', () => {
  it('drives /plan through approval, scaffold, and one scaffolded task with real self-review ordering', async () => {
    const askCalls: Array<{ label?: string; sessionId: string; systemPrompt: string; message: string }> = [];
    mockAskClaudeWithContext.mockImplementation(
      async (message: string, sessionId: string, systemPrompt: string, opts?: AskOptions) => {
        askCalls.push({ label: opts?.opLabel, sessionId, systemPrompt, message });

        if (opts?.opLabel === 'chat') {
          expect(systemPrompt).toMatch(/product manager conducting the \/plan scoping interview/i);
          if (!message.toLowerCase().includes('ship it')) {
            return { text: 'What user-visible outcome should this prove?' };
          }
          return { text: pmSpecReply(FLAWED_PM_SPEC) };
        }

        if (opts?.opLabel === 'planning:pm-self-review') {
          expect(message).toContain(FLAWED_PM_SPEC.title);
          expect(message).toContain('ask the user to approve generated tasks before scaffold');
          expect(message).not.toContain('ship it');
          return { text: pmSpecReply(REVIEWED_PM_SPEC) };
        }

        if (opts?.opLabel === 'planner:tech-lead') {
          expect(message).toContain(REVIEWED_PM_SPEC.spec);
          return { text: techLeadBreakdownReply(INITIAL_TECH_SPEC, [PLANNED_TASK]) };
        }

        if (opts?.opLabel === 'planning:tech-lead-self-review') {
          expect(message).toContain(INITIAL_TECH_SPEC);
          return { text: techLeadSelfReviewReply(REVIEWED_TECH_SPEC, [REVIEWED_TASK]) };
        }

        if (opts?.opLabel === 'planner:pm') {
          if (message.includes(INITIAL_TECH_SPEC)) {
            return {
              text: [
                '```pm-review',
                '{"match": false, "mismatches": ["Tech spec missed the usable scaffold acceptance check."]}',
                '```',
              ].join('\n'),
            };
          }
          expect(message).toContain(REVIEWED_TECH_SPEC);
          return { text: ['```pm-review', '{"match": true, "mismatches": []}', '```'].join('\n') };
        }

        if (opts?.opLabel === 'planner:critique-claude') {
          return { text: critiqueReply(REVIEWED_PM_SPEC.spec, REVIEWED_TECH_SPEC, [REVIEWED_TASK]) };
        }

        throw new Error(`unexpected askClaudeWithContext call: ${opts?.opLabel ?? '<none>'}`);
      },
    );

    const messages: string[] = [];
    const sender: MessageSender = {
      name: 'telegram',
      send: vi.fn(async (_chatId: number, text: string) => {
        messages.push(text);
      }),
      startTyping: vi.fn(),
      stopTyping: vi.fn(),
    };

    const retiredGate = vi.fn(async () => {
      throw new Error('retired specified-enough gate must not run during /plan');
    });

    createPlanningSession(CHAT_ID, 'prove project 20 acceptance', 'chat', 'rune');
    const first = await handlePlanningTurn(
      { scopingTurn: defaultScopingTurn, runRoles: retiredGate },
      CHAT_ID,
      'I need an acceptance proof for the new planning flow.',
    );
    expect(first).toMatchObject({ status: 'scoping' });
    expect(first.reply).toMatch(/what user-visible outcome/i);

    const proposed = await handlePlanningTurn(
      { scopingTurn: defaultScopingTurn, runRoles: retiredGate },
      CHAT_ID,
      'It should prove approval, progress, self-review, and execution. Ship it.',
    );
    expect(proposed.status).toBe('spec-proposed');
    expect(proposed.reply).toContain('downstream planning and scaffold run automatically with progress');
    expect(proposed.reply).not.toContain('ask the user to approve generated tasks before scaffold');
    expect(retiredGate).not.toHaveBeenCalled();

    const storedBeforeRestart = getPlanningSession(CHAT_ID);
    expect(storedBeforeRestart?.planning.status).toBe('spec-proposed');
    expect(storedBeforeRestart?.planning.artifact).toEqual(REVIEWED_PM_SPEC);

    restorePlanningSessions();
    expect(getPlanningSession(CHAT_ID)?.planning.status).toBe('spec-proposed');

    await handleApprove(sender, CHAT_ID);

    const progressLines = messages.filter((message) => message.startsWith('Planning progress:'));
    expect(progressLines).toEqual([
      'Planning progress: tech-lead breakdown.',
      'Planning progress: PM review.',
      'Planning progress: Claude critique.',
      'Planning progress: Codex critique.',
      'Planning progress: context seed.',
      'Planning progress: scaffold.',
    ]);
    expect(messages).toContain(
      'Planning warning: Codex critique skipped; continuing with the last coherent plan.',
    );
    expect(messages.some((message) => /Planning succeeded: 20-acceptance-proof/.test(message))).toBe(true);
    expect(messages.join('\n')).not.toMatch(/approve generated tasks|second approval/i);
    expect(getPlanningSession(CHAT_ID)).toBeNull();

    const chatSessionIds = askCalls.filter((call) => call.label === 'chat').map((call) => call.sessionId);
    expect(new Set(chatSessionIds).size).toBe(1);
    expect(askCalls.filter((call) => call.label === 'planning:pm-self-review')).toHaveLength(1);
    expect(askCalls.filter((call) => call.label === 'planning:tech-lead-self-review')).toHaveLength(1);

    const downstreamSession = mockRunScaffoldApproval.mock.calls[0]?.[0];
    expect(downstreamSession?.planning.downstreamArtifact?.techSpec).toContain(REVIEWED_TECH_SPEC);
    expect(downstreamSession?.planning.downstreamArtifact?.techSpec).not.toContain(INITIAL_TECH_SPEC);
    expect(downstreamSession?.planning.downstreamArtifact?.tasks).toContain(REVIEWED_TASK.text);

    const execution = await runExecutedScaffoldTask(downstreamSession.planning.downstreamArtifact.spec);
    expect(execution.evidence.failureReason).toBeUndefined();
    expect(execution.evidence).toMatchObject({ outcome: 'ready-for-closeout' });
    expect(execution.order).toEqual([
      'qa-execution',
      'tech-lead-test-review',
      'coder-execution',
      'coder-self-review',
      'qa-diff-revalidation',
      'reviewer-review',
      'tech-lead-diff-review',
    ]);
    expect(execution.reviewerSawDiff).toContain('return true;');
    expect(execution.reviewerSawDiff).not.toContain('return false;');
    expect(execution.techLeadSawDiff).toContain('return true;');
    expect(execution.coderSelfReviewCalls).toBe(1);
  });

  it('surfaces terminal downstream failure without adding another planning approval gate', async () => {
    mockAskClaudeWithContext.mockImplementation(
      async (message: string, _sessionId: string, _systemPrompt: string, opts?: AskOptions) => {
        if (opts?.opLabel === 'chat') return { text: pmSpecReply(REVIEWED_PM_SPEC) };
        if (opts?.opLabel === 'planning:pm-self-review') return { text: pmSpecReply(REVIEWED_PM_SPEC) };
        if (opts?.opLabel === 'planner:tech-lead') {
          return { text: techLeadBreakdownReply(INITIAL_TECH_SPEC, [PLANNED_TASK]) };
        }
        if (opts?.opLabel === 'planning:tech-lead-self-review') {
          return { text: techLeadSelfReviewReply(INITIAL_TECH_SPEC, [PLANNED_TASK]) };
        }
        if (opts?.opLabel === 'planner:pm') {
          return {
            text: [
              '```pm-review',
              '{"match": false, "mismatches": ["Tech spec missed the usable scaffold acceptance check."]}',
              '```',
            ].join('\n'),
          };
        }
        throw new Error(`unexpected askClaudeWithContext call: ${opts?.opLabel ?? '<none>'}`);
      },
    );

    const messages: string[] = [];
    const sender: MessageSender = {
      name: 'telegram',
      send: vi.fn(async (_chatId: number, text: string) => {
        messages.push(text);
      }),
      startTyping: vi.fn(),
      stopTyping: vi.fn(),
    };

    createPlanningSession(CHAT_ID, 'prove terminal progress', 'chat', 'rune');
    await handlePlanningTurn({ scopingTurn: defaultScopingTurn }, CHAT_ID, 'ship it');
    restorePlanningSessions();

    await handleApprove(sender, CHAT_ID);

    expect(messages).toContain('Planning progress: tech-lead breakdown.');
    expect(messages).toContain('Planning progress: PM review.');
    expect(messages.some((message) => /Planning stopped: PM review mismatch/i.test(message))).toBe(true);
    expect(messages.some((message) => /still approved.*blind retry is unlikely/i.test(message))).toBe(true);
    expect(messages.some((message) => /amend the spec\/DoD|manual live release-gate task/i.test(message))).toBe(true);
    expect(messages.some((message) => /\/approve again to retry/i.test(message))).toBe(false);
    expect(messages.join('\n')).not.toMatch(/approve generated tasks|approve tech-spec|approve tasks/i);
    expect(getPlanningSession(CHAT_ID)?.planning.status).toBe('approved');
    expect(mockRunScaffoldApproval).not.toHaveBeenCalled();
  });
});

function pmSpecReply(artifact: PmSpecApprovalArtifact): string {
  return ['Spec ready for approval.', '```pm-spec', JSON.stringify(artifact, null, 2), '```'].join('\n');
}

function techLeadBreakdownReply(techSpec: string, tasks: SizedTask[]): string {
  return [
    '```tech-breakdown',
    JSON.stringify({ tasks }, null, 2),
    '```',
    '```tech-spec',
    techSpec,
    '```',
  ].join('\n');
}

function techLeadSelfReviewReply(techSpec: string, tasks: SizedTask[]): string {
  return [
    '```self-review-artifact',
    JSON.stringify({ tasks }, null, 2),
    '```',
    '```self-review-tech-spec',
    techSpec,
    '```',
  ].join('\n');
}

function critiqueReply(spec: string, techSpec: string, tasks: SizedTask[]): string {
  return [
    '```critique-tasks',
    JSON.stringify({ tasks }, null, 2),
    '```',
    '```critique-spec',
    spec,
    '```',
    '```critique-tech-spec',
    techSpec,
    '```',
  ].join('\n');
}

async function runExecutedScaffoldTask(spec: string): Promise<{
  evidence: Awaited<ReturnType<typeof runTeamTaskWorkflow>>;
  order: string[];
  reviewerSawDiff: string;
  techLeadSawDiff: string;
  coderSelfReviewCalls: number;
}> {
  const order: string[] = [];
  let executionCalls = 0;
  let reviewerSawDiff = '';
  let techLeadSawDiff = '';
  let coderSelfReviewCalls = 0;

  const flawedDiff = [
    'diff --git a/src/acceptance.ts b/src/acceptance.ts',
    '+++ b/src/acceptance.ts',
    '+export function acceptanceReady() {',
    '+  return false; // BUG: deliberate flaw for coder self-review',
    '+}',
  ].join('\n');
  const reviewedDiff = flawedDiff.replace('return false; // BUG: deliberate flaw for coder self-review', 'return true;');

  const judgmentCall: JudgmentModelCall = async ({ role, message }) => {
    if (role === 'tech-lead' && message.includes('## QA tests')) {
      order.push('tech-lead-test-review');
      return ['```tl-test-review', '{"approved": true}', '```'].join('\n');
    }

    if (role === 'coder') {
      coderSelfReviewCalls += 1;
      order.push('coder-self-review');
      expect(message).toContain('deliberate flaw for coder self-review');
      return [
        '```self-review-artifact',
        JSON.stringify({ diff: reviewedDiff, handoffNotes: ['self-review fixed the acceptance return value'] }, null, 2),
        '```',
      ].join('\n');
    }

    if (role === 'qa' && message.includes('## Self-reviewed coder diff')) {
      order.push('qa-diff-revalidation');
      expect(message).toContain(reviewedDiff);
      return ['```qa-diff-revalidation', '{"approved": true}', '```'].join('\n');
    }

    if (role === 'reviewer') {
      order.push('reviewer-review');
      reviewerSawDiff = message;
      return reviewerSawDiff.includes(reviewedDiff)
        ? ['```reviewer-verdict', '{"pass": true, "objections": []}', '```'].join('\n')
        : ['```reviewer-verdict', '{"pass": false, "objections": [{"class": "data-integrity", "severity": "high", "location": "src/acceptance.ts:2", "rationale": "Self-review did not fix the deliberately flawed return value."}]}', '```'].join('\n');
    }

    if (role === 'tech-lead' && message.includes('## Diff')) {
      order.push('tech-lead-diff-review');
      techLeadSawDiff = message;
      return techLeadSawDiff.includes(reviewedDiff)
        ? ['```tl-diff-review', '{"pass": true}', '```'].join('\n')
        : ['```tl-diff-review', '{"pass": false, "notes": "Tech lead saw the unrevised diff."}', '```'].join('\n');
    }

    throw new Error(`unexpected team-task judgment call for ${role}`);
  };

  const runExecution = async (): Promise<ExecutionAgentResult> => {
    executionCalls += 1;
    if (executionCalls === 1) {
      order.push('qa-execution');
      return {
        ok: true,
        diff: [
          'diff --git a/src/acceptance.test.ts b/src/acceptance.test.ts',
          '+++ b/src/acceptance.test.ts',
          '+expect(acceptanceReady()).toBe(true);',
        ].join('\n'),
        output: 'wrote acceptance test',
      };
    }
    order.push('coder-execution');
    return { ok: true, diff: flawedDiff, output: 'implemented acceptanceReady with a deliberate flaw' };
  };

  const models = {
    pm: binding('opus', 'anthropic', 'claude'),
    techLead: binding('opus', 'anthropic', 'claude'),
    qa: binding('gpt-5.5', 'openai', 'codex'),
    coder: binding('gpt-5.5', 'openai', 'codex'),
    reviewer: binding('opus', 'anthropic', 'claude'),
    designer: binding('opus', 'anthropic', 'claude'),
  };
  const deps = buildProductionTeamTaskDeps(
    {
      sandbox: {
        product: 'rune',
        project: '20-acceptance-proof',
        worktree: '/tmp/fake-acceptance-worktree',
        egressAllowlist: [],
        resumed: false,
      } as SandboxSpec,
      productsConfigPath: '/tmp/nonexistent-products.json',
      models,
    },
    { judgmentCall, runExecution },
  );

  const evidence = await runTeamTaskWorkflow(
    REVIEWED_TASK,
    {
      spec,
      contextMd: '## Current State\n\nAcceptance project has been scaffolded.',
      coderProvider: 'openai',
      cap: 1,
    },
    deps,
  );

  return { evidence, order, reviewerSawDiff, techLeadSawDiff, coderSelfReviewCalls };
}

function binding(
  alias: string,
  provider: RoleModelBinding['provider'],
  format: RoleModelBinding['format'],
): RoleModelBinding {
  return { alias, provider, format };
}
