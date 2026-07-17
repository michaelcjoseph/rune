import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BacklogItem } from '../../intent/backlog-parser.js';
import type { ProductConfig } from '../../jobs/sandbox-runtime.js';
import type { MutationDescriptor } from '../../transport/mutations.js';

/**
 * Acceptance coverage deliberately uses the production guard, git scaffold,
 * mutation pipeline, durable run records, and reconciler. The only lifecycle
 * control is disabling auto-approval on the production applier clone: this
 * proves dispatch without launching real model work from a test process.
 */

const facts = {
  itemEligible: true,
  fieldsComplete: true,
  pmAssessed: true,
  pmWellScoped: true,
  techLeadReviewed: true,
};

function bug(id: string): BacklogItem {
  return {
    id,
    kind: 'bugs',
    text: `Fix the ${id} regression`,
    status: 'open',
    body: [`Reproduction and acceptance facts for ${id}.`],
    source: { file: 'docs/projects/bugs.md', lineNumber: 1, raw: `- [ ] ${id}` },
    warnings: [],
  };
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

describe('fix-run handoff stub-free acceptance', () => {
  let root: string;
  let repo: string;
  let logsDir: string;
  let productsFile: string;
  let product: ProductConfig;
  let startFixRun: typeof import('../../jobs/fix-run-handoff.js').startFixRun;
  let appendFixAttempt: typeof import('../../jobs/fix-attempt-store.js').appendFixAttempt;
  let getLatestFixAttempt: typeof import('../../jobs/fix-attempt-store.js').getLatestFixAttempt;
  let readLatestFixAttempts: typeof import('../../jobs/fix-attempt-store.js').readLatestFixAttempts;
  let readRecordedFixRun: typeof import('../../jobs/fix-attempt-reconciler.js').readRecordedFixRun;
  let reconcileProceedingFixAttempts: typeof import('../../jobs/fix-attempt-reconciler.js').reconcileProceedingFixAttempts;
  let writeRecoveredTerminalMutation: typeof import('../../transport/mutations.js').writeRecoveredTerminalMutation;
  let registerApplier: typeof import('../../transport/mutations.js').registerApplier;
  let orchestratedWorkApplier: typeof import('../../jobs/orchestrated-work-runner.js').orchestratedWorkApplier;
  let flushLogger: typeof import('../../utils/logger.js').flushLogger;
  let config: typeof import('../../config.js').default;
  const previousEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'rune-fix-run-acceptance-'));
    repo = join(root, 'repo');
    logsDir = join(root, 'logs');
    productsFile = join(root, 'products.json');
    mkdirSync(repo);
    mkdirSync(logsDir);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, ['config', 'user.email', 'rune-acceptance@example.com']);
    git(repo, ['config', 'user.name', 'Rune Acceptance']);
    writeFileSync(join(repo, 'README.md'), '# temporary acceptance repository\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-qm', 'initial']);

    product = {
      repoPath: repo,
      baseBranch: 'main',
      credentialsFile: '',
      egressAllowlist: [],
      validationCommands: ['node --version'],
    };
    writeFileSync(productsFile, JSON.stringify({ rune: product }));

    for (const [name, value] of Object.entries({
      PRODUCTS_CONFIG_FILE: productsFile,
      RUNE_LOGS_DIR: logsDir,
      WORKTREE_ROOT: join(root, 'worktrees'),
    })) {
      previousEnv.set(name, process.env[name]);
      process.env[name] = value;
    }

    // vitest exports VITEST=true, which hard-disables the logger's durable
    // rune.log file sink (src/utils/logger.ts) to keep unit tests out of the
    // real logs dir. This suite asserts on that sink and already points
    // RUNE_LOGS_DIR at a temp dir, so clear the flag before the dynamic
    // imports below evaluate the logger module.
    previousEnv.set('VITEST', process.env.VITEST);
    delete process.env.VITEST;

    ({ default: config } = await import('../../config.js'));
    ({ startFixRun } = await import('../../jobs/fix-run-handoff.js'));
    ({ appendFixAttempt, getLatestFixAttempt, readLatestFixAttempts } = await import('../../jobs/fix-attempt-store.js'));
    ({ readRecordedFixRun, reconcileProceedingFixAttempts } = await import('../../jobs/fix-attempt-reconciler.js'));
    ({ writeRecoveredTerminalMutation, registerApplier } = await import('../../transport/mutations.js'));
    ({ orchestratedWorkApplier } = await import('../../jobs/orchestrated-work-runner.js'));
    ({ flushLogger } = await import('../../utils/logger.js'));

    // Preserve the production validator and apply implementation. A pending
    // descriptor is the real dispatch result, while no model-runner starts.
    registerApplier({ ...orchestratedWorkApplier, autoApprove: false });
  });

  afterAll(() => {
    for (const [name, value] of previousEnv) restoreEnv(name, value);
    rmSync(root, { recursive: true, force: true });
  });

  it('dispatches through the real guard/scaffold/mutation path and reconciles durable outcomes', async () => {
    const attemptsFile = join(logsDir, 'fix-attempts.jsonl');
    const dispatched: Array<{ bugId: string; runId: string }> = [];

    for (const bugId of ['BUG-merged', 'BUG-failed', 'BUG-held']) {
      const result = await startFixRun({
        product: 'rune',
        bugId,
        scope: { bug: bug(bugId), facts },
      });

      expect(result).toMatchObject({ accepted: true });
      if (!result.accepted) throw new Error(`expected ${bugId} to dispatch`);
      dispatched.push({ bugId, runId: result.runId });
      appendFixAttempt(attemptsFile, {
        attemptId: `attempt-${bugId}`,
        product: 'rune',
        bugId,
        state: 'proceeding',
        runId: result.runId,
        updatedAt: '2026-07-17T12:00:00.000Z',
      });
    }

    const mutationLines = readFileSync(join(logsDir, 'mutations.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const descriptors = new Map(
      mutationLines.map((line) => [String(line.id), line as unknown as MutationDescriptor]),
    );
    for (const { runId } of dispatched) {
      expect(mutationLines).toContainEqual(expect.objectContaining({
        id: runId,
        kind: 'orchestrated-work',
        source: 'webview',
        status: 'pending',
      }));
    }

    const terminalFacts = [
      { run: dispatched[0]!, status: 'completed' as const, outcome: 'branch-complete', merged: true },
      { run: dispatched[1]!, status: 'failed' as const, outcome: 'failed', merged: undefined },
      { run: dispatched[2]!, status: 'completed' as const, outcome: 'held', merged: false },
    ];
    for (const terminal of terminalFacts) {
      const descriptor = descriptors.get(terminal.run.runId);
      if (!descriptor) throw new Error(`missing persisted descriptor for ${terminal.run.runId}`);
      const runDir = join(config.WORK_RUNS_DIR, terminal.run.runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'summary.json'), JSON.stringify({
        id: terminal.run.runId,
        product: 'rune',
        project: 'fix acceptance',
        outcome: terminal.outcome,
        reason: `recorded ${terminal.outcome} terminal`,
        merged: terminal.merged,
      }));
      writeRecoveredTerminalMutation(descriptor, {
        mutationId: terminal.run.runId,
        ts: '2026-07-17T12:05:00.000Z',
        kind: terminal.status,
        data: { outcome: terminal.outcome, reason: `recorded ${terminal.outcome} terminal` },
      });
    }

    const reconciled = reconcileProceedingFixAttempts(attemptsFile, {
      readRun: (runId) => readRecordedFixRun(runId, {
        supervisedRunsFile: config.SUPERVISED_RUNS_FILE,
        workRunsDir: config.WORK_RUNS_DIR,
      }),
      now: () => '2026-07-17T12:06:00.000Z',
    });
    expect(reconciled.map((attempt) => attempt.state).sort()).toEqual([
      'failed',
      'fixed',
      'parked-on-human',
    ]);

    const latest = readLatestFixAttempts(attemptsFile);
    expect(getLatestFixAttempt(latest, 'rune', 'BUG-merged')).toMatchObject({ state: 'fixed' });
    expect(getLatestFixAttempt(latest, 'rune', 'BUG-failed')).toMatchObject({ state: 'failed' });
    expect(getLatestFixAttempt(latest, 'rune', 'BUG-held')).toMatchObject({ state: 'parked-on-human' });
    expect(git(repo, ['log', '--format=%s', '-3'])).toContain('scaffold fix project');

    // Required start + terminal logs: every dispatched run must be diagnosable
    // from the durable log alone — a dispatch decision naming the runId and
    // dispatch kind, and a reconciler line correlating the runId to its mapped
    // terminal and the underlying run outcome. flushLogger() closes the sink
    // (one-shot), so both phases are asserted from a single read here.
    await flushLogger();
    const logEntries = readFileSync(join(logsDir, 'rune.log'), 'utf8')
      .trim().split('\n')
      .map((line) => JSON.parse(line) as {
        component: string;
        message: string;
        data?: Record<string, unknown>;
      });
    const expectedTerminalLogs = [
      { run: dispatched[0]!, state: 'fixed', outcome: 'branch-complete' },
      { run: dispatched[1]!, state: 'failed', outcome: 'failed' },
      { run: dispatched[2]!, state: 'parked-on-human', outcome: 'held' },
    ];
    for (const { run, state, outcome } of expectedTerminalLogs) {
      expect(logEntries.filter((entry) => entry.component === 'fix-run-handoff'))
        .toContainEqual(expect.objectContaining({
          data: expect.objectContaining({
            runId: run.runId,
            dispatchKind: 'orchestrated-work',
          }),
        }));
      expect(logEntries.filter((entry) => entry.component === 'fix-attempt-reconciler'))
        .toContainEqual(expect.objectContaining({
          data: expect.objectContaining({
            runId: run.runId,
            terminal: state,
            outcome,
          }),
        }));
    }
  });

  it('keeps a divergent deliverable repo as a policy decline, never a handoff failure', async () => {
    const attemptsFile = join(logsDir, 'fix-attempts-decline.jsonl');
    const bugId = 'BUG-cross-product';
    const result = await startFixRun({
      product: 'rune',
      bugId,
      scope: { bug: bug(bugId), facts },
    }, {
      products: { rune: product },
      resolveDeliverableRepo: () => join(root, 'other-product'),
      scaffoldAndCommitFixProject: (await import('../../jobs/fix-project-scaffold.js')).scaffoldAndCommitFixProject,
      createMutation: (await import('../../transport/mutations.js')).createMutation,
    });

    expect(result).toEqual({ accepted: false, reason: 'not-single-product' });
    appendFixAttempt(attemptsFile, {
      attemptId: 'attempt-cross-product',
      product: 'rune',
      bugId,
      state: result.accepted ? 'proceeding' : 'declined',
      reason: result.accepted ? undefined : result.reason,
      updatedAt: '2026-07-17T12:10:00.000Z',
    });
    expect(getLatestFixAttempt(readLatestFixAttempts(attemptsFile), 'rune', bugId)).toMatchObject({
      state: 'declined',
      reason: 'not-single-product',
    });
  });
});
