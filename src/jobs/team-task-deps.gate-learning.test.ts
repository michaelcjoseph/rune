/**
 * Phase 12 gate-time compounding regression.
 *
 * A tech-lead rejection of QA's test intent should synchronously write a neutral
 * validated lesson to QA memory, and the corrective QA retry should be a fresh
 * role invocation that loads that new lesson in its reference context.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateLearningDeps, GateLearningResult, GateLessonCandidate } from '../intent/gate-learning.js';
import type { GateRejectionFeedback } from '../intent/team-task-workflow.js';

const h = vi.hoisted(() => {
  const lesson =
    'When redaction tests guard a secret boundary, use a raw secret-shaped fixture and assert the raw value is absent.';
  const qaExemplar =
    'QA exemplar: use rawSecret = "sk-liveRawToken0123456789", then expect(output).not.toContain(rawSecret).';
  const roleMemory = new Map<string, string>();
  const gateLearning = vi.fn<
    (rejection: GateRejectionFeedback, deps: GateLearningDeps) => Promise<GateLearningResult>
  >(async (rejection) => {
    roleMemory.set(rejection.counterpartRole, `- [2026-06-17 source: gate-test] ${lesson}`);
    return { kind: 'written', role: rejection.counterpartRole, lesson };
  });
  const writeGateLearningLesson = vi.fn(async (input: { role: string; lesson: string }) => ({
    committed: true,
    captured: `- [2026-06-17 · source: gate-test] ${input.lesson}`,
  }));
  return { lesson, qaExemplar, roleMemory, gateLearning, writeGateLearningLesson };
});

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/test/project',
  default: {
    WORKSPACE_DIR: '/test/workspace',
    LOGS_DIR: '/test/logs',
  },
}));

vi.mock('../roles/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../roles/loader.js')>();
  return {
    ...actual,
    composeRoleContext: vi.fn((role: string, baseInstructions: string) => {
      const memory = h.roleMemory.get(role) ?? '';
      return {
        systemInstructions: [`SOUL ${role}`, baseInstructions].join('\n\n'),
        referenceContext: memory
          ? [
              `<${role}-memory>`,
              `Accumulated lessons for the ${role} role from past runs. Treat as REFERENCE, not rules.`,
              '',
              memory,
              `</${role}-memory>`,
              ...(role === 'qa'
                ? [
                    '',
                    '<qa-exemplars>',
                    'Reference exemplars of good qa output from baseline and project runs.',
                    '',
                    h.qaExemplar,
                    '</qa-exemplars>',
                  ]
                : []),
            ].join('\n')
          : role === 'qa'
            ? [
                '<qa-exemplars>',
                'Reference exemplars of good qa output from baseline and project runs.',
                '',
                h.qaExemplar,
                '</qa-exemplars>',
              ].join('\n')
            : '',
      };
    }),
  };
});

vi.mock('../intent/gate-learning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../intent/gate-learning.js')>();
  return {
    ...actual,
    runGateTriggeredLearning: h.gateLearning,
  };
});

vi.mock('../intent/learning-write-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../intent/learning-write-path.js')>();
  return {
    ...actual,
    writeGateLearningLesson: h.writeGateLearningLesson,
  };
});

vi.mock('../ai/claude.js', () => ({
  CLAUDE_BIN: '/bin/claude',
  askClaudeWithContext: vi.fn(),
  cleanupSession: vi.fn(),
  getProjectMcpArgs: vi.fn(() => []),
  registerActiveProcess: vi.fn(),
  unregisterActiveProcess: vi.fn(),
}));

vi.mock('../ai/codex.js', () => ({
  runCodex: vi.fn(),
}));

vi.mock('../ai/tool-labels.js', () => ({
  scrubPathsInText: (text: string) => text,
}));

vi.mock('./execution-agent.js', () => ({
  runExecutionAgent: vi.fn(),
}));

import {
  buildProductionTeamTaskDeps,
  type JudgmentModelCall,
  type RoleModelBinding,
  type TeamRoleModels,
  type TeamTaskSeams,
} from './team-task-deps.js';
import { askClaudeWithContext } from '../ai/claude.js';
import { composeRoleContext } from '../roles/loader.js';
import { runTeamTaskWorkflow } from '../intent/team-task-workflow.js';
import type { SizedTask } from '../intent/planning-roles.js';
import type { SandboxSpec } from '../intent/sandbox.js';

const task: SizedTask = {
  id: 'qa-redaction-retry',
  text: 'Write tests for redaction of token-shaped secrets',
  testStrategy: 'code-tests-required',
  designerNeeded: false,
  roles: ['qa', 'tech-lead', 'coder', 'reviewer'],
};

const openai: RoleModelBinding = { alias: 'gpt-5.6-sol', provider: 'openai', format: 'codex' };
const anthropic: RoleModelBinding = { alias: 'opus', provider: 'anthropic', format: 'claude' };

const models: TeamRoleModels = {
  pm: anthropic,
  techLead: anthropic,
  qa: openai,
  coder: openai,
  reviewer: anthropic,
  designer: anthropic,
};

function sandbox(): SandboxSpec {
  return {
    product: 'rune',
    project: 'demo',
    worktree: '/tmp/fake-worktree',
    egressAllowlist: [],
    resumed: false,
  } as SandboxSpec;
}

// Project 20 added a cold coder self-review that routes through judgmentCall
// with role 'coder' and expects the corrected-or-confirmed coder artifact
// echoed back in a `self-review-artifact` fence. Echoing the artifact unchanged
// yields revised=false, so the run proceeds as it did before the step existed.
function confirmCoderSelfReview(message: string): string {
  const fence = message.match(/```self-review-artifact[\s\S]*?```/);
  if (fence === null) {
    throw new Error('coder self-review prompt missing self-review-artifact fence');
  }
  return fence[0];
}

describe('buildProductionTeamTaskDeps - gate-time learning compounding', () => {
  beforeEach(() => {
    h.roleMemory.clear();
    h.gateLearning.mockClear();
    h.writeGateLearningLesson.mockClear();
    vi.mocked(composeRoleContext).mockClear();
    vi.mocked(askClaudeWithContext).mockReset();
    vi.mocked(askClaudeWithContext).mockResolvedValue({
      text: [
        '```postmortem',
        JSON.stringify({
          kind: 'lesson',
          stage: 'test',
          role: 'qa',
          lesson: h.lesson,
        }),
        '```',
      ].join('\n'),
      error: null,
    });
  });

  it('passes the full structured rejection notes into the rejecting-role draft prompt', async () => {
    const record: GateRejectionFeedback = {
      rejectingRole: 'reviewer',
      counterpartRole: 'coder',
      rejectedRole: 'coder',
      artifact: 'reviewer-verdict',
      rejectedArtifact: 'reviewer-verdict',
      reason: 'implementation missed the required empty-state behavior',
      whatFailed: 'the diff omitted the empty-state branch that the task required',
      notes: [
        'Reviewer note: the handler still returns the happy-path payload for empty input.',
        'Reviewer note: the regression test proves the missing branch.',
      ],
      actionableNotes: ['Add an explicit empty-state branch and keep the regression test.'],
    };
    const draftMessages: string[] = [];

    h.gateLearning.mockImplementationOnce(async (rejection, deps) => {
      await deps.draftLesson({ rejection });
      return { kind: 'no-lesson', rationale: 'draft prompt inspected' };
    });

    const judgmentCall: JudgmentModelCall = async (call) => {
      if (call.role === 'reviewer' && call.message.includes('<gate-rejection>')) {
        draftMessages.push(call.message);
      }
      return [
        '```gate-lesson-candidate',
        JSON.stringify({
          kind: 'candidate-lesson',
          draftedBy: 'reviewer',
          targetRole: 'coder',
          lesson: 'When a review rejection cites missing behavior, map each note to a concrete diff change before resubmitting.',
        }),
        '```',
      ].join('\n');
    };

    const deps = buildProductionTeamTaskDeps(
      { sandbox: sandbox(), productsConfigPath: '/nonexistent/products.json', models },
      { judgmentCall },
    );

    await deps.onGateRejection?.(record);

    expect(h.gateLearning).toHaveBeenCalledTimes(1);
    expect(draftMessages).toHaveLength(1);
    expect(draftMessages[0]).toContain('rejectingRole: reviewer');
    expect(draftMessages[0]).toContain('counterpartRole: coder');
    expect(draftMessages[0]).toContain('whatFailed: the diff omitted the empty-state branch');
    expect(draftMessages[0]).toContain('Reviewer note: the handler still returns the happy-path payload for empty input.');
    expect(draftMessages[0]).toContain('Reviewer note: the regression test proves the missing branch.');
    expect(draftMessages[0]).toContain('actionableNotes: Add an explicit empty-state branch');
  });

  it("loads a gate-time QA lesson into QA's corrective retry prompt", async () => {
    const qaPrompts: string[] = [];
    let executionCalls = 0;
    let techLeadTestReviews = 0;

    const judgmentCall: JudgmentModelCall = async ({ role, message }) => {
      if (role === 'coder') {
        return confirmCoderSelfReview(message);
      }
      if (role === 'tech-lead') {
        techLeadTestReviews += 1;
        if (techLeadTestReviews === 1) {
          return [
            '```tl-test-review',
            JSON.stringify({
              approved: false,
              notes: 'tests assert the redacted placeholder instead of proving the raw token is absent',
            }),
            '```',
          ].join('\n');
        }
        if (techLeadTestReviews === 2) {
          return ['```tl-test-review', '{"approved": true}', '```'].join('\n');
        }
        return ['```tl-diff-review', '{"pass": true}', '```'].join('\n');
      }
      if (role === 'reviewer') {
        return ['```reviewer-verdict', '{"pass": true, "objections": []}', '```'].join('\n');
      }
      return ['```pm-wrapup', '{"resolved": true}', '```'].join('\n');
    };

    const seams: Partial<TeamTaskSeams> = {
      judgmentCall,
      runExecution: async (opts) => {
        executionCalls += 1;
        if (executionCalls <= 2) {
          qaPrompts.push(opts.prompt);
          return {
            ok: true,
            diff: `diff --git a/src/redaction-${executionCalls}.test.ts b/src/redaction-${executionCalls}.test.ts\n+++ b/src/redaction-${executionCalls}.test.ts\n+expect(output).not.toContain(rawSecret)\n`,
            output: `qa attempt ${executionCalls}`,
          };
        }
        return {
          ok: true,
          diff: 'diff --git a/src/redaction.ts b/src/redaction.ts\n+++ b/src/redaction.ts\n+export const redaction = true\n',
          output: 'coder done',
        };
      },
    };

    const deps = buildProductionTeamTaskDeps(
      { sandbox: sandbox(), productsConfigPath: '/nonexistent/products.json', models },
      seams,
    );

    const evidence = await runTeamTaskWorkflow(
      task,
      { spec: 'Redact token-shaped secrets.', contextMd: 'ctx', coderProvider: 'openai', cap: 2 },
      deps,
    );

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(h.gateLearning).toHaveBeenCalledTimes(1);
    expect(h.gateLearning).toHaveBeenCalledWith(
      expect.objectContaining({
        rejectingRole: 'tech-lead',
        counterpartRole: 'qa',
        rejectedRole: 'qa',
        rejectedArtifact: 'test-intent',
      }),
      expect.anything(),
    );
    expect(qaPrompts).toHaveLength(2);
    expect(qaPrompts[0]).not.toContain(h.lesson);
    expect(qaPrompts[1]).toContain('<qa-memory>');
    expect(qaPrompts[1]).toContain(h.lesson);
  });

  it('passes the persisted project exemplar directory into QA role context loading', async () => {
    const deps = buildProductionTeamTaskDeps(
      { sandbox: sandbox(), productsConfigPath: '/nonexistent/products.json', models },
      {
        judgmentCall: async (call) => {
          if (call.role === 'tech-lead' && call.message.includes('## QA tests')) {
            return ['```tl-test-review', '{"approved": true}', '```'].join('\n');
          }
          if (call.role === 'tech-lead') {
            return ['```tl-diff-review', '{"pass": true}', '```'].join('\n');
          }
          if (call.role === 'reviewer') {
            return ['```reviewer-verdict', '{"pass": true, "objections": []}', '```'].join('\n');
          }
          return ['```pm-wrapup', '{"resolved": true}', '```'].join('\n');
        },
        runExecution: async () => ({
          ok: true,
          diff: 'diff --git a/src/redaction.test.ts b/src/redaction.test.ts\n+++ b/src/redaction.test.ts\n+expect(output).not.toContain(rawSecret)\n',
          output: 'ok',
        }),
      },
    );

    await runTeamTaskWorkflow(
      task,
      { spec: 'Redact token-shaped secrets.', contextMd: 'ctx', coderProvider: 'openai', cap: 1 },
      deps,
    );

    expect(composeRoleContext).toHaveBeenCalledWith(
      'qa',
      expect.any(String),
      expect.objectContaining({
        projectExemplarsDir: '/test/project/docs/projects/demo/examples',
      }),
    );
  });

  it('live acceptance: forced QA redaction rejection writes a validated QA lesson and the retry passes with lesson plus exemplar loaded', async () => {
    const qaPrompts: string[] = [];
    const qaDiffs: string[] = [];
    const draftInputs: GateRejectionFeedback[] = [];
    let executionCalls = 0;
    let techLeadTestReviews = 0;

    h.gateLearning.mockImplementationOnce(async (rejection, deps) => {
      draftInputs.push(rejection);
      const candidate = await deps.draftLesson({ rejection });
      expect(candidate).toMatchObject({
        kind: 'candidate-lesson',
        draftedBy: 'tech-lead',
        targetRole: 'qa',
      });
      const validation = await deps.validateLesson({ rejection, candidate: candidate as GateLessonCandidate });
      expect(validation).toEqual({
        kind: 'lesson',
        stage: 'test',
        role: 'qa',
        lesson: h.lesson,
      });
      const write = await deps.writeLesson('qa', h.lesson, rejection);
      expect(write).toMatchObject({ committed: true });
      h.roleMemory.set('qa', write.captured ?? `- [2026-06-17 source: gate-test] ${h.lesson}`);
      return { kind: 'written', role: 'qa', lesson: h.lesson };
    });

    const judgmentCall: JudgmentModelCall = async (call) => {
      if (call.role === 'coder') {
        return confirmCoderSelfReview(call.message);
      }
      if (call.role === 'tech-lead' && call.message.includes('<gate-rejection>')) {
        return [
          '```gate-lesson-candidate',
          JSON.stringify({
            kind: 'candidate-lesson',
            draftedBy: 'tech-lead',
            targetRole: 'qa',
            lesson:
              'When redaction tests guard a secret boundary, use raw secret-shaped fixtures and assert they are absent from output.',
          }),
          '```',
        ].join('\n');
      }

      if (call.role === 'tech-lead' && call.message.includes('## QA tests')) {
        techLeadTestReviews += 1;
        if (techLeadTestReviews === 1) {
          expect(call.message).toContain('expect(output).toContain("[REDACTED_TOKEN]")');
          expect(call.message).not.toContain('expect(output).not.toContain(rawSecret)');
          return [
            '```tl-test-review',
            JSON.stringify({
              approved: false,
              notes:
                'QA used an already-redacted placeholder fixture; use a raw token-shaped fixture and assert the raw value is absent.',
            }),
            '```',
          ].join('\n');
        }

        expect(call.message).toContain('const rawSecret =');
        expect(call.message).toContain('expect(output).not.toContain(rawSecret)');
        return ['```tl-test-review', '{"approved": true}', '```'].join('\n');
      }

      if (call.role === 'tech-lead') {
        return ['```tl-diff-review', '{"pass": true}', '```'].join('\n');
      }

      if (call.role === 'reviewer') {
        return ['```reviewer-verdict', '{"pass": true, "objections": []}', '```'].join('\n');
      }

      return ['```pm-wrapup', '{"resolved": true}', '```'].join('\n');
    };

    const seams: Partial<TeamTaskSeams> = {
      judgmentCall,
      runExecution: async (opts) => {
        executionCalls += 1;
        if (executionCalls <= 2) {
          qaPrompts.push(opts.prompt);
          const diff =
            executionCalls === 1
              ? [
                  'diff --git a/src/redaction.test.ts b/src/redaction.test.ts',
                  '+++ b/src/redaction.test.ts',
                  '+const output = redact("[REDACTED_TOKEN]");',
                  '+expect(output).toContain("[REDACTED_TOKEN]");',
                ].join('\n')
              : [
                  'diff --git a/src/redaction.test.ts b/src/redaction.test.ts',
                  '+++ b/src/redaction.test.ts',
                  '+const rawSecret = "sk-liveRawToken0123456789";',
                  '+const output = redact(rawSecret);',
                  '+expect(output).not.toContain(rawSecret);',
                  '+expect(output).toMatch(/redacted/i);',
                ].join('\n');
          qaDiffs.push(diff);
          return { ok: true, diff, output: `qa redaction attempt ${executionCalls}` };
        }
        return {
          ok: true,
          diff: 'diff --git a/src/redaction.ts b/src/redaction.ts\n+++ b/src/redaction.ts\n+export const redact = true\n',
          output: 'coder done',
        };
      },
    };

    const deps = buildProductionTeamTaskDeps(
      { sandbox: sandbox(), productsConfigPath: '/nonexistent/products.json', models },
      seams,
    );

    const evidence = await runTeamTaskWorkflow(
      task,
      { spec: 'Redact token-shaped secrets without leaking raw tokens.', contextMd: 'ctx', coderProvider: 'openai', cap: 2 },
      deps,
    );

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(draftInputs).toEqual([
      expect.objectContaining({
        rejectingRole: 'tech-lead',
        counterpartRole: 'qa',
        rejectedRole: 'qa',
        rejectedArtifact: 'test-intent',
        whatFailed: expect.stringContaining('raw token-shaped fixture'),
      }),
    ]);
    expect(h.gateLearning).toHaveBeenCalledTimes(1);
    expect(h.writeGateLearningLesson).toHaveBeenCalledWith({
      role: 'qa',
      lesson: h.lesson,
      projectSlug: 'demo',
      rejection: expect.objectContaining({
        rejectingRole: 'tech-lead',
        counterpartRole: 'qa',
        rejectedArtifact: 'test-intent',
      }),
    });
    expect(qaPrompts).toHaveLength(2);
    expect(qaPrompts[0]).toContain('<qa-exemplars>');
    expect(qaPrompts[0]).toContain(h.qaExemplar);
    expect(qaPrompts[0]).not.toContain(h.lesson);
    expect(qaPrompts[1]).toContain('<qa-memory>');
    expect(qaPrompts[1]).toContain(h.lesson);
    expect(qaPrompts[1]).toContain('<qa-exemplars>');
    expect(qaPrompts[1]).toContain(h.qaExemplar);
    expect(qaDiffs[0]).toContain('[REDACTED_TOKEN]');
    expect(qaDiffs[0]).not.toContain('not.toContain(rawSecret)');
    expect(qaDiffs[1]).toContain('const rawSecret =');
    expect(qaDiffs[1]).toContain('not.toContain(rawSecret)');
  });
});
