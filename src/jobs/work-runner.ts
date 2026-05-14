import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import { CLAUDE_BIN, registerActiveProcess, unregisterActiveProcess, getProjectMcpArgs } from '../ai/claude.js';
import { activeRuns } from '../transport/mutations.js';
import { createLogger } from '../utils/logger.js';
import type { MutationApplier, MutationDescriptor, MutationEvent, ApplyContext } from '../transport/mutations.js';

const log = createLogger('work-runner');

const PROJECTS_DIR = join(PROJECT_ROOT, 'docs', 'projects');

/** Find the absolute path for a project slug by scanning docs/projects/. */
function findProjectDir(slug: string): string | null {
  let names: string[];
  try {
    names = readdirSync(PROJECTS_DIR) as string[];
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      if (!statSync(join(PROJECTS_DIR, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (name === slug || name.endsWith(`-${slug}`)) {
      return join(PROJECTS_DIR, name);
    }
  }
  return null;
}

type WorkRunPayload = { projectSlug: string };

export const workRunApplier: MutationApplier<WorkRunPayload> = {
  kind: 'work-run',
  autoApprove: true,

  validate(payload: WorkRunPayload): { ok: true } | { ok: false; reason: string } {
    const { projectSlug } = payload;
    if (!projectSlug || typeof projectSlug !== 'string') {
      return { ok: false, reason: 'projectSlug is required' };
    }
    // Reject slugs that contain path separators — prevents directory traversal
    if (projectSlug.includes('/') || projectSlug.includes('\\') || projectSlug.includes('..')) {
      return { ok: false, reason: `invalid projectSlug: ${projectSlug}` };
    }

    const dir = findProjectDir(projectSlug);
    if (!dir) {
      return { ok: false, reason: `project not found: ${projectSlug}` };
    }
    if (!existsSync(join(dir, 'spec.md'))) {
      return { ok: false, reason: `spec.md missing for project: ${projectSlug}` };
    }

    // Per-project concurrency cap
    const runningForSlug = [...activeRuns.values()].filter(
      h =>
        h.descriptor.kind === 'work-run' &&
        (h.descriptor.payload as WorkRunPayload).projectSlug === projectSlug &&
        h.descriptor.status === 'running',
    );
    if (runningForSlug.length >= config.WORK_RUN_PER_PROJECT_CAP) {
      return { ok: false, reason: `already running for ${projectSlug}` };
    }

    // Global cap
    const globalRunning = [...activeRuns.values()].filter(h => h.descriptor.kind === 'work-run');
    if (globalRunning.length >= config.WORK_RUN_GLOBAL_CAP) {
      return { ok: false, reason: 'global work-run cap reached' };
    }

    return { ok: true };
  },

  async *apply(descriptor: MutationDescriptor<WorkRunPayload>, ctx: ApplyContext): AsyncIterable<MutationEvent> {
    const { projectSlug } = descriptor.payload;
    const dir = findProjectDir(projectSlug);
    if (!dir) {
      yield term(descriptor.id, 'failed', { reason: `project not found: ${projectSlug}` });
      return;
    }

    const specPath = join(dir, 'spec.md');
    const tasksPath = join(dir, 'tasks.md');
    const dirName = dir.split('/').pop() ?? projectSlug;

    let specContent: string;
    try {
      specContent = readFileSync(specPath, 'utf8');
    } catch {
      yield term(descriptor.id, 'failed', { reason: `could not read spec.md for ${projectSlug}` });
      return;
    }

    let tasksContent = '';
    try {
      if (existsSync(tasksPath)) tasksContent = readFileSync(tasksPath, 'utf8');
    } catch {
      // tasks.md is optional
    }

    const prompt = `${specContent}${tasksContent ? `\n\n${tasksContent}` : ''}\n\n/work --auto`;
    const t0 = Date.now();

    const child = spawn(CLAUDE_BIN, [
      // Match execClaude's MCP isolation — keep user-global MCP servers
      // (claude.ai KB, Linear, Gmail, …) out of /work runs too.
      ...getProjectMcpArgs(),
      '--add-dir', join('docs', 'projects', dirName),
      '-p', prompt,
    ], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        JARVIS_PROJECT_ROOT: PROJECT_ROOT,
        ...(config.WORKSPACE_DIR ? { JARVIS_WORKSPACE_DIR: config.WORKSPACE_DIR } : {}),
      },
    });

    registerActiveProcess(child);
    try {
      yield* streamProcess(child, descriptor.id, ctx, t0);
    } finally {
      unregisterActiveProcess(child);
      log.info('work-run finished', { projectSlug, durationMs: Date.now() - t0 });
    }
  },
};

async function* streamProcess(
  child: ReturnType<typeof spawn>,
  mutationId: string,
  ctx: ApplyContext,
  t0: number,
): AsyncIterable<MutationEvent> {
  const queue: MutationEvent[] = [];
  let done = false;
  let resolveWaiter: (() => void) | null = null;
  let cancelSent = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  function enqueue(event: MutationEvent) {
    queue.push(event);
    const r = resolveWaiter;
    resolveWaiter = null;
    r?.();
  }

  function evt(kind: MutationEvent['kind'], data: Record<string, unknown>): MutationEvent {
    return { mutationId, ts: new Date().toISOString(), kind, data };
  }

  function waitForNext(): Promise<void> {
    if (queue.length > 0 || done) return Promise.resolve();
    return new Promise(r => { resolveWaiter = r; });
  }

  let stdoutBuf = '';
  let stderrBuf = '';

  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) enqueue(evt('output', { line }));
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) enqueue(evt('log', { line, stream: 'stderr' }));
  });

  child.on('close', (code, signal) => {
    if (stdoutBuf) enqueue(evt('output', { line: stdoutBuf }));
    if (stderrBuf) enqueue(evt('log', { line: stderrBuf, stream: 'stderr' }));
    exitCode = code;
    exitSignal = signal;
    done = true;
    resolveWaiter?.();
    resolveWaiter = null;
  });

  child.on('error', (err) => {
    enqueue(evt('log', { line: err.message, stream: 'stderr' }));
    done = true;
    resolveWaiter?.();
    resolveWaiter = null;
  });

  while (!done || queue.length > 0) {
    if (ctx.cancel() && !cancelSent) {
      cancelSent = true;
      child.kill('SIGTERM');
    }
    await waitForNext();
    while (queue.length > 0) yield queue.shift()!;
  }

  const durationMs = Date.now() - t0;
  const isSignalKill = exitSignal === 'SIGTERM' || exitCode === 143;

  if (exitCode === 0) {
    yield term(mutationId, 'completed', { exitCode: 0, durationMs });
  } else if (isSignalKill && cancelSent) {
    yield term(mutationId, 'failed', { exitCode, durationMs, reason: 'cancelled' });
  } else if (isSignalKill) {
    yield term(mutationId, 'failed', { exitCode, durationMs, reason: 'killed' });
  } else {
    yield term(mutationId, 'failed', { exitCode, durationMs, reason: `exited with code ${String(exitCode)}` });
  }
}

function term(
  mutationId: string,
  kind: 'completed' | 'failed',
  data: Record<string, unknown>,
): MutationEvent {
  return { mutationId, ts: new Date().toISOString(), kind, data };
}
