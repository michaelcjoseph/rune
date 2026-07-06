import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import config, { PROJECT_ROOT } from '../config.js';
import { CLAUDE_BIN, getProjectMcpArgs, registerActiveProcess, unregisterActiveProcess } from '../ai/claude.js';
import { VALID_SLUG, worktreePathFor } from '../intent/sandbox.js';
import type { SupervisedRun } from '../intent/supervision.js';
import {
  createMutation,
  type ApplyContext,
  type MutationApplier,
  type MutationDescriptor,
  type MutationEvent,
} from '../transport/mutations.js';
import { createLogger } from '../utils/logger.js';
import { readAllRuns, upsertRun } from './supervision-store.js';
import { defaultReleaseRuntimeDeps } from './work-run-release.js';
import { parseStreamJsonLine, streamJsonToDisplay, createTranscriptSink, redactSecrets } from './work-run-transcript.js';
import { parseAskUserQuestionEnvelope, pendingCheckForQuestion, type WorkRunParkedQuestion } from './work-run-question.js';

const log = createLogger('work-run-answer');

export interface WorkRunAnswerPayload {
  runId: string;
  optionId: string;
}

export type AnswerRequestOutcome =
  | { kind: 'created'; runId: string; mutationId: string }
  | { kind: 'not-found'; runId: string; reason: string }
  | { kind: 'error'; runId: string; reason: string };

export interface AnswerRequestDeps {
  readParkedRun: (runId: string) => SupervisedRun | null;
  worktreeFor: (product: string, project: string) => string;
  worktreeExists: (path: string) => boolean;
  createAnswerMutation: (payload: WorkRunAnswerPayload) => Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
}

function readParkedRunProd(runId: string): SupervisedRun | null {
  try {
    return readAllRuns(config.SUPERVISED_RUNS_FILE).find((r) => r.id === runId && r.status === 'blocked-on-human') ?? null;
  } catch (err) {
    log.warn('readParkedRun failed', { runId, error: (err as Error).message });
    return null;
  }
}

export function defaultAnswerRequestDeps(): AnswerRequestDeps {
  return {
    readParkedRun: readParkedRunProd,
    worktreeFor: (product, project) => worktreePathFor(product, project, config.WORKTREE_ROOT),
    worktreeExists: (path) => existsSync(path),
    createAnswerMutation: async (payload) => {
      const result = await createMutation('work-run-answer', { ...payload }, 'webview');
      return result.ok ? { ok: true, id: result.descriptor.id } : { ok: false, reason: result.reason };
    },
  };
}

export async function requestWorkRunAnswer(
  runId: string,
  optionId: string,
  deps: AnswerRequestDeps = defaultAnswerRequestDeps(),
): Promise<AnswerRequestOutcome> {
  if (!VALID_SLUG.test(runId)) return { kind: 'not-found', runId, reason: 'invalid run id' };
  const run = deps.readParkedRun(runId);
  if (!run) return { kind: 'not-found', runId, reason: 'run is not parked' };
  if (!run.parkedQuestion) return { kind: 'not-found', runId, reason: 'parked run is not waiting on a question' };
  if (!run.parkedQuestion.options.some((o) => o.id === optionId)) {
    return { kind: 'not-found', runId, reason: 'unknown answer option' };
  }
  const worktree = deps.worktreeFor(run.product, run.project);
  if (!deps.worktreeExists(worktree)) return { kind: 'not-found', runId, reason: 'parked worktree is gone' };
  const created = await deps.createAnswerMutation({ runId, optionId });
  return created.ok ? { kind: 'created', runId, mutationId: created.id } : { kind: 'error', runId, reason: created.reason };
}

function terminal(runId: string, kind: 'completed' | 'failed', data: Record<string, unknown>): MutationEvent {
  return { mutationId: runId, ts: new Date().toISOString(), kind, data };
}

function markRun(run: SupervisedRun, status: SupervisedRun['status'], extra: Partial<SupervisedRun> = {}): void {
  try {
    upsertRun({ ...run, status, lastHeartbeatAt: new Date().toISOString(), ...extra }, config.SUPERVISED_RUNS_FILE);
  } catch (err) {
    log.warn('answer supervision write failed', { id: run.id, error: (err as Error).message });
  }
}

async function runContinuation(run: SupervisedRun, optionId: string, ctx: ApplyContext): Promise<MutationEvent> {
  const question = run.parkedQuestion;
  if (!question) return terminal(run.id, 'failed', { reason: 'parked run is not waiting on a question', projectSlug: run.project, product: run.product });
  const option = question.options.find((o) => o.id === optionId);
  if (!option) return terminal(run.id, 'failed', { reason: 'unknown answer option', projectSlug: run.project, product: run.product });
  const worktree = worktreePathFor(run.product, run.project, config.WORKTREE_ROOT);
  if (!existsSync(worktree)) return terminal(run.id, 'failed', { reason: 'parked worktree is gone', projectSlug: run.project, product: run.product });

  markRun(run, 'running', { parkedQuestion: undefined });
  const sink = createTranscriptSink({ runId: run.id, baseDir: config.WORK_RUNS_DIR });
  const prompt = [
    'Continue the existing /work --auto run from the current worktree. Do not restart the project or recreate the worktree.',
    'The operator answered your previous AskUserQuestion.',
    `Question: ${question.question}`,
    `Selected answer: ${option.label}`,
    option.description ? `Answer description: ${option.description}` : '',
    `Answer value: ${option.value}`,
    'Apply that answer and continue from the current repository state.',
  ].filter(Boolean).join('\n\n');

  let nextQuestion: WorkRunParkedQuestion | null = null;
  const child = spawn(CLAUDE_BIN, [
    '--dangerously-skip-permissions',
    ...getProjectMcpArgs(),
    '--output-format', 'stream-json', '--verbose',
    '-p', prompt,
  ], {
    cwd: worktree,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      RUNE_PROJECT_ROOT: PROJECT_ROOT,
      ...(config.WORKSPACE_DIR ? { RUNE_WORKSPACE_DIR: config.WORKSPACE_DIR } : {}),
    },
  });
  registerActiveProcess(child);

  try {
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        const envelope = parseStreamJsonLine(line);
        if (!envelope) continue;
        void sink.append(envelope).catch((err) => log.warn('answer transcript append failed', { id: run.id, error: err.message }));
        const parsedQuestion = parseAskUserQuestionEnvelope(envelope);
        if (parsedQuestion) {
          nextQuestion = {
            source: 'ask-user-question',
            question: parsedQuestion.question,
            options: parsedQuestion.options,
            ...(parsedQuestion.toolUseId ? { toolUseId: parsedQuestion.toolUseId } : {}),
            askedAt: new Date().toISOString(),
          };
        }
        const display = streamJsonToDisplay(envelope);
        if (display) {
          for (const displayLine of redactSecrets(display).split('\n')) {
            if (displayLine.trim()) ctx.bus.publish({
              kind: 'mutation-event',
              mutationId: run.id,
              mutationKind: 'work-run-answer',
              subKind: 'output',
              ts: new Date().toISOString(),
              data: { line: displayLine },
              userId: config.TELEGRAM_USER_ID,
            });
          }
        }
      }
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
      child.on('error', () => resolve({ code: null, signal: 'SIGTERM' }));
      const unsub = ctx.onCancel?.(() => {
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        } else {
          child.kill('SIGTERM');
        }
      });
      child.once('close', () => unsub?.());
    });

    await sink.finish().catch((err) => log.warn('answer transcript flush failed', { id: run.id, error: err.message }));
    if (ctx.cancel()) {
      const ev = terminal(run.id, 'failed', { reason: 'cancelled while resuming answer', projectSlug: run.project, product: run.product });
      markRun(run, 'failed');
      return ev;
    }
    const parkedAgain = nextQuestion as WorkRunParkedQuestion | null;
    if (parkedAgain) {
      markRun(run, 'blocked-on-human', { parkedQuestion: parkedAgain, operatorWorktreePath: worktree });
      return terminal(run.id, 'completed', {
        parked: true,
        operatorWorktreePath: worktree,
        pendingCheck: pendingCheckForQuestion(parkedAgain),
        parkedQuestion: parkedAgain,
        projectSlug: run.project,
        product: run.product,
      });
    }
    if (exit.code !== 0 && exit.signal) {
      const ev = terminal(run.id, 'failed', { reason: `continuation exited by ${exit.signal}`, projectSlug: run.project, product: run.product });
      markRun(run, 'failed');
      return ev;
    }

    const releaseDeps = defaultReleaseRuntimeDeps();
    const ev = await releaseDeps.coldFinalizeGatedMerge(run, worktree);
    markRun(run, ev.kind === 'failed' ? 'failed' : 'completed');
    return ev;
  } finally {
    sink.destroy();
    unregisterActiveProcess(child);
  }
}

export const workRunAnswerApplier: MutationApplier<WorkRunAnswerPayload> = {
  kind: 'work-run-answer',
  autoApprove: true,
  supervised: false,
  validate(payload: WorkRunAnswerPayload): { ok: true } | { ok: false; reason: string } {
    if (!payload.runId || typeof payload.runId !== 'string') return { ok: false, reason: 'runId is required' };
    if (!VALID_SLUG.test(payload.runId)) return { ok: false, reason: `invalid runId: ${payload.runId}` };
    if (!payload.optionId || typeof payload.optionId !== 'string') return { ok: false, reason: 'optionId is required' };
    if (!/^\d+$/.test(payload.optionId)) return { ok: false, reason: `invalid optionId: ${payload.optionId}` };
    return { ok: true };
  },
  async *apply(descriptor: MutationDescriptor<WorkRunAnswerPayload>, ctx: ApplyContext): AsyncIterable<MutationEvent> {
    const run = readParkedRunProd(descriptor.payload.runId);
    if (!run) {
      yield terminal(descriptor.payload.runId, 'failed', { reason: 'run is not parked' });
      return;
    }
    yield await runContinuation(run, descriptor.payload.optionId, ctx);
  },
};
