import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { SandboxSpec } from '../intent/sandbox.js';
import type { SelectedTask } from '../intent/orch-task-select.js';
import type { ExecutionAgentResult } from './execution-agent.js';
import type { JudgmentModelCall, TeamTaskSeams } from './team-task-deps.js';

vi.mock('../roles/loader.js', () => ({
  composeRoleContext: (role: string, baseInstructions: string) => ({
    systemInstructions: [
      `Mock ${role} SOUL: static role charter with no localhost listener safety rules.`,
      baseInstructions,
    ].join('\n\n'),
    referenceContext: `Mock ${role} memory: intentionally omits service addresses and launchd labels.`,
  }),
}));

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REAL_POLICY_PATH = join(REPO_ROOT, 'policies', 'model-policy.json');

const PROTECTED_SERVICES = [
  {
    name: 'Rune web / cockpit',
    address: '127.0.0.1:3847',
    launchdLabel: 'com.jarvis.daemon',
  },
  {
    name: 'Rune MCP daemon',
    address: '127.0.0.1:3848',
    launchdLabel: 'com.jarvis.rune-mcp',
  },
] as const;

const GREEN_JUDGMENT_REPLY = [
  '```tl-test-review',
  '{"approved": true}',
  '```',
  '```reviewer-verdict',
  '{"outcome": "pass", "findings": []}',
  '```',
  '```tl-diff-review',
  '{"outcome": "pass", "findings": []}',
  '```',
].join('\n');

// Project 20 added a cold coder self-review that routes through judgmentCall
// with role 'coder'. It expects the corrected-or-confirmed coder artifact
// echoed back in a `self-review-artifact` fence; echoing the artifact unchanged
// yields revised=false, so the run proceeds exactly as it did before the
// self-review step existed.
function confirmCoderSelfReview(message: string): string {
  const fence = message.match(/```self-review-artifact[\s\S]*?```/);
  if (fence === null) {
    throw new Error('coder self-review prompt missing self-review-artifact fence');
  }
  return fence[0];
}

function makeSandbox(): SandboxSpec {
  return {
    product: 'rune',
    project: '19-rune-product-os',
    worktree: '/tmp/fake-worktree',
    egressAllowlist: [],
    resumed: false,
  } as SandboxSpec;
}

function expectProtectedServiceInvariant(systemPrompt: string, label: string): void {
  for (const service of PROTECTED_SERVICES) {
    expect(systemPrompt, `${label} prompt must name ${service.name}`).toContain(service.name);
    expect(systemPrompt, `${label} prompt must name ${service.address}`).toContain(service.address);
    expect(systemPrompt, `${label} prompt must name ${service.launchdLabel}`).toContain(
      service.launchdLabel,
    );
  }

  for (const action of ['kill', 'stop', 'interrupt', 'reuse']) {
    expect(systemPrompt, `${label} prompt must forbid ${action} of protected listeners`).toMatch(
      new RegExp(`\\bnever\\b[\\s\\S]*\\b${action}\\w*\\b`, 'i'),
    );
  }

  expect(systemPrompt, `${label} prompt must require explicit human approval`).toMatch(
    /explicit human approval/i,
  );
  expect(systemPrompt, `${label} prompt must require process ownership verification`).toMatch(
    /verify[\s\S]*(PID|process)[\s\S]*spawned by the current (task|worktree|test command)|spawned by the current (task|worktree|test command)[\s\S]*before killing/i,
  );
}

describe('orchestration-protected-service-prompt (project 19 / test-plan §5A)', () => {
  it('injects the protected-service invariant into runtime team-task prompts independent of static role files', async () => {
    const { createProductionTaskWorkflowRunner } = await import('./team-task-deps.js');
    const artifactPrompts: Array<{ role: string; format: string; systemPrompt: string; prompt: string }> = [];
    const judgmentPrompts: Array<{ role: string; model: string; systemPrompt: string; message: string }> = [];

    const judgmentCall: JudgmentModelCall = async ({ role, model, systemPrompt, message }) => {
      // The coder self-review reviews an artifact in fresh context and does no
      // operational work, so it is outside the runtime protected-service
      // invariant this test guards. Echo the artifact unchanged and keep it out
      // of the operational judgment-prompt accounting.
      if (role === 'coder') {
        return confirmCoderSelfReview(message);
      }
      judgmentPrompts.push({ role, model, systemPrompt, message });
      return GREEN_JUDGMENT_REPLY;
    };
    const runExecution: TeamTaskSeams['runExecution'] = async (opts): Promise<ExecutionAgentResult> => {
      const role = artifactPrompts.length === 0 ? 'qa' : 'coder';
      artifactPrompts.push({
        role,
        format: opts.model.format,
        systemPrompt: opts.systemPrompt ?? '',
        prompt: opts.prompt,
      });
      return {
        ok: true,
        diff: [
          `diff --git a/src/${artifactPrompts.length}.test.ts b/src/${artifactPrompts.length}.test.ts`,
          `+++ b/src/${artifactPrompts.length}.test.ts`,
          '+expect(true).toBe(true)',
          '',
        ].join('\n'),
        output: `artifact role ${artifactPrompts.length} done`,
      };
    };

    const run = createProductionTaskWorkflowRunner(
      {
        sandbox: makeSandbox(),
        productsConfigPath: '/nonexistent/products.json',
        modelPolicyPath: REAL_POLICY_PATH,
        cap: 1,
      },
      { judgmentCall, runExecution },
    );
    const task: SelectedTask = {
      id: 'orchestration-protected-service-prompt',
      text: 'Runtime team-task prompts include the protected-service invariant.',
      section: 'Phase 5A',
    };

    const evidence = await run(task, {
      handoff: 'Spec requires protected localhost service invariants in runtime prompts.',
      contextMd: 'Context intentionally contains no protected-service warning text.',
    });

    expect(evidence.outcome).toBe('ready-for-closeout');
    expect(artifactPrompts.map((call) => call.format)).toEqual(['codex', 'codex']);
    expect(judgmentPrompts.map((call) => call.role)).toEqual(
      expect.arrayContaining(['tech-lead', 'reviewer']),
    );
    expect(judgmentPrompts.every((call) => call.model === 'opus')).toBe(true);

    for (const call of artifactPrompts) {
      expect(call.systemPrompt).toContain('static role charter with no localhost listener safety rules');
      expect(call.prompt).toContain('intentionally omits service addresses and launchd labels');
      expectProtectedServiceInvariant(call.systemPrompt, `${call.role} Codex artifact`);
    }

    for (const call of judgmentPrompts) {
      expect(call.systemPrompt).toContain('static role charter with no localhost listener safety rules');
      expect(call.message).toContain('intentionally omits service addresses and launchd labels');
      expectProtectedServiceInvariant(call.systemPrompt, `${call.role} Claude judgment`);
    }
  });
});
