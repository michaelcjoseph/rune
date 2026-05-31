import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import { CLAUDE_BIN, registerActiveProcess, unregisterActiveProcess, getProjectMcpArgs } from '../ai/claude.js';
import { activeRuns } from '../transport/mutations.js';
import { createWorktree, destroyWorktree } from './sandbox-runtime.js';
import { parseStreamJsonLine, streamJsonToDisplay, createRingBuffer } from './work-run-transcript.js';
import type { ExitFacts } from './work-run-classify.js';
import type { SandboxSpec } from '../intent/sandbox.js';
import { createLogger } from '../utils/logger.js';
import type { MutationApplier, MutationDescriptor, MutationEvent, ApplyContext } from '../transport/mutations.js';

const log = createLogger('work-runner');

const PROJECTS_SUBDIR = join('docs', 'projects');

/** Find the absolute path for a project slug by scanning `<base>/docs/projects`.
 *  Used both during validate (against the live tree at PROJECT_ROOT) and during
 *  apply (against the run's worktree). Slug match is exact, or
 *  `<numeric-prefix>-<slug>` so "06-webview" can be referenced as "webview". */
function findProjectDir(slug: string, base: string): string | null {
  const projectsDir = join(base, PROJECTS_SUBDIR);
  let names: string[];
  try {
    names = readdirSync(projectsDir) as string[];
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      if (!statSync(join(projectsDir, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (name === slug || name.endsWith(`-${slug}`)) {
      return join(projectsDir, name);
    }
  }
  return null;
}

type WorkRunPayload = {
  projectSlug: string;
  /**
   * Product key (matches an entry in `policies/products.json`). Defaults to
   * `'jarvis'` for back-compat with existing cockpit start paths that didn't
   * yet wire the product through. Cockpit's `handleApiMutations` should pass
   * the registry's product for the project so a future aura/assay work-run
   * targets the right repo.
   */
  product?: string;
};

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

    // Pre-flight against the live tree. The actual run reads from the
    // worktree, but the worktree is created off the repo's HEAD which (for
    // jarvis-on-jarvis) is the same commit the live tree is on.
    const dir = findProjectDir(projectSlug, PROJECT_ROOT);
    if (!dir) {
      return { ok: false, reason: `project not found: ${projectSlug}` };
    }
    if (!existsSync(join(dir, 'spec.md'))) {
      return { ok: false, reason: `spec.md missing for project: ${projectSlug}` };
    }

    // Per-project concurrency cap. The deterministic worktree path
    // (`<WORKTREE_ROOT>/<product>/<projectSlug>`) is single-occupant, so
    // cap=1 also keeps two runs from colliding on the same on-disk path.
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
    const product = descriptor.payload.product ?? 'jarvis';
    // Deterministic per-mutation branch name, mirroring gen-eval-loop's
    // `jarvis-gen-eval/<short-id>` so the two run kinds are visually
    // distinguishable in `git branch` output.
    const branch = `jarvis-work/${descriptor.id.slice(0, 8)}`;

    let sandbox: SandboxSpec | null = null;
    try {
      try {
        // createWorktree resolves HEAD atomically and returns it on
        // sandbox.baseSha — the stable diff base (baseSha..branch) the Phase 2
        // classifier will compute work product against. Captured here; consumed
        // once the work-product/classify step lands.
        sandbox = await createWorktree({
          product,
          project: projectSlug,
          branch,
          worktreeRoot: config.WORKTREE_ROOT,
          productsConfigPath: config.PRODUCTS_CONFIG_FILE,
        });
      } catch (err) {
        // No worktree was created, so the outer finally's destroy is a
        // no-op (sandbox stays null). Surface the failure as a terminal
        // event so the mutation reaches a clean failed state.
        yield term(descriptor.id, 'failed', {
          reason: `worktree create failed: ${(err as Error).message}`,
        });
        return;
      }

      const dir = findProjectDir(projectSlug, sandbox.worktree);
      if (!dir) {
        yield term(descriptor.id, 'failed', { reason: `project not found in worktree: ${projectSlug}` });
        return;
      }

      const specPath = join(dir, 'spec.md');
      const tasksPath = join(dir, 'tasks.md');

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

      // cwd = sandbox.worktree (NOT PROJECT_ROOT) — the whole point of
      // Fix 1. Spawning into the live tree triggers tsx watch to SIGTERM
      // the parent when the agent edits Jarvis's own source files. The
      // worktree lives under `<WORKTREE_ROOT>/<product>/<project>`, outside
      // PROJECT_ROOT/src, so tsx watch ignores it.
      //
      // The pre-worktree version passed `--add-dir docs/projects/<dirName>`
      // as a relative path; that worked because cwd was PROJECT_ROOT. The
      // worktree's HEAD already contains the project dir, so the flag is
      // redundant — dropped here.
      const child = spawn(CLAUDE_BIN, [
        ...getProjectMcpArgs(),
        // stream-json so every assistant turn and tool call lands on stdout as
        // a parseable envelope (requirement 10). The consumer below converts
        // each envelope to a human-readable `output` event via the adapter.
        '--output-format', 'stream-json', '--verbose',
        '-p', prompt,
      ], {
        cwd: sandbox.worktree,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          JARVIS_PROJECT_ROOT: PROJECT_ROOT,
          ...(config.WORKSPACE_DIR ? { JARVIS_WORKSPACE_DIR: config.WORKSPACE_DIR } : {}),
        },
      });

      registerActiveProcess(child);
      try {
        // Drive streamProcess manually so we capture its RETURN value (exit
        // facts + ring buffer + stderr tail) — `for await` / `yield*` discard a
        // generator's return. streamProcess now yields only non-terminal events
        // (output/log/keep-alive) and hands back the facts; apply() owns the
        // single terminal event. `it.return()` in finally propagates an early
        // consumer-abort into streamProcess's cleanup, matching `yield*`.
        const it = streamProcess(child, descriptor.id, ctx, t0);
        let step = await it.next();
        try {
          while (!step.done) {
            yield step.value;
            step = await it.next();
          }
        } finally {
          // `step.done` is true only on normal completion; if the loop exited
          // via an early consumer-abort it is still false. Propagate that abort
          // into streamProcess's cleanup (clearInterval keep-alive ticker),
          // matching `yield*` — but not on normal completion, which would
          // needlessly re-enter its finally and add a microtask tick.
          if (!step.done) await it.return?.(undefined as never);
        }
        // Only reached on normal completion (an abort propagates out through
        // the finally above); the guard also narrows step.value to StreamResult.
        if (!step.done) throw new Error('work-runner: stream ended without exit facts');
        const streamResult = step.value;
        // Phase 2 (next tasks) classifies on work product HERE — and MUST await
        // finalizeWorkRun BEFORE this yield: startApply persists on the terminal
        // event and the outer finally destroys the worktree immediately after,
        // so the git reads must finish first. The stderr tail
        // (streamResult.stderrTail) must be run through redactSecrets at the
        // forensics-persistence boundary. Until then the terminal mirrors the
        // prior exit-code behavior.
        yield terminalFromExit(descriptor.id, streamResult.exit);
      } finally {
        unregisterActiveProcess(child);
        log.info('work-run finished', { projectSlug, durationMs: Date.now() - t0 });
      }
    } finally {
      // Always tear down the worktree if we created one — success, failure,
      // cancel, generator-consumer-abort all flow through here. Mirrors
      // gen-eval-loop-runner's finally cleanup at the same spot in the
      // generator body.
      if (sandbox) {
        try {
          await destroyWorktree(sandbox, {
            productsConfigPath: config.PRODUCTS_CONFIG_FILE,
            worktreeRoot: config.WORKTREE_ROOT,
          });
        } catch (err) {
          log.warn('work-runner: destroyWorktree failed', {
            sandbox: sandbox.worktree,
            error: (err as Error).message,
          });
        }
      }
    }
  },
};

/** Exit facts plus the last-N stdout ring buffer and stderr tail, returned by
 *  streamProcess for the (Phase 2) classifier and forensics. */
interface StreamResult {
  exit: ExitFacts;
  ringBuffer: string[];
  stderrTail: string[];
}

/** Bound on the retained last-N stdout display lines and stderr tail. */
const RING_CAPACITY = 50;

async function* streamProcess(
  child: ReturnType<typeof spawn>,
  mutationId: string,
  ctx: ApplyContext,
  t0: number,
): AsyncGenerator<MutationEvent, StreamResult> {
  const queue: MutationEvent[] = [];
  let done = false;
  let resolveWaiter: (() => void) | null = null;
  let cancelSent = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;

  // Last-N stdout display lines + stderr tail, retained for the terminal
  // classification/forensics (independent of what the drawer consumed).
  const stdoutRing = createRingBuffer<string>(RING_CAPACITY);
  const stderrTail = createRingBuffer<string>(RING_CAPACITY);

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

  // Child-process liveness ticker. Emits a `keep-alive` MutationEvent every
  // 30s so the supervision store's `lastChildAliveAt` stays fresh even when
  // Claude is mid-LLM-call with no stdout for minutes. See
  // src/transport/mutations.ts for the matching throttle gate; see
  // src/intent/supervision.ts (isStalled) for why this distinct signal
  // exists. `.unref()` so the timer can't hold the process open past
  // shutdown if the close handler somehow doesn't fire.
  const keepAliveTicker = setInterval(() => {
    enqueue(evt('keep-alive', {}));
  }, 30_000);
  keepAliveTicker.unref();

  let stdoutBuf = '';
  let stderrBuf = '';

  // Convert one newline-delimited stream-json line to events. A parseable
  // envelope becomes a human-readable `output` event (drawer back-compat); a
  // blank line is ignored; a malformed/partial line is routed to the `log`
  // (stderr-tail) path so it never crashes the run and never reads as agent
  // output. Phase 2 tees the raw envelope to the durable transcript here too.
  function emitStdoutLine(line: string) {
    if (!line.trim()) return; // blank separator line between envelopes — drop silently
    const envelope = parseStreamJsonLine(line);
    if (!envelope) {
      // Malformed/partial JSON or a non-envelope banner — route to the log
      // (stderr-tail) path tagged 'stdout' to preserve provenance, so it never
      // crashes the run and never reads as agent output.
      enqueue(evt('log', { line, stream: 'stdout' }));
      return;
    }
    const display = streamJsonToDisplay(envelope);
    if (display === null) return;
    // A single envelope may render multiple lines (mixed text + tool_use
    // blocks); emit one `output` event per line so downstream surfaces never
    // receive an embedded newline in a single line field.
    for (const displayLine of display.split('\n')) {
      if (displayLine) {
        stdoutRing.push(displayLine);
        enqueue(evt('output', { line: displayLine }));
      }
    }
  }

  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) emitStdoutLine(line);
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) {
      stderrTail.push(line);
      enqueue(evt('log', { line, stream: 'stderr' }));
    }
  });

  child.on('close', (code, signal) => {
    clearInterval(keepAliveTicker);
    if (stdoutBuf) emitStdoutLine(stdoutBuf);
    if (stderrBuf) {
      stderrTail.push(stderrBuf);
      enqueue(evt('log', { line: stderrBuf, stream: 'stderr' }));
    }
    exitCode = code;
    exitSignal = signal;
    done = true;
    resolveWaiter?.();
    resolveWaiter = null;
  });

  child.on('error', (err) => {
    clearInterval(keepAliveTicker);
    stderrTail.push(err.message);
    enqueue(evt('log', { line: err.message, stream: 'stderr' }));
    done = true;
    resolveWaiter?.();
    resolveWaiter = null;
  });

  try {
    while (!done || queue.length > 0) {
      if (ctx.cancel() && !cancelSent) {
        cancelSent = true;
        child.kill('SIGTERM');
      }
      await waitForNext();
      while (queue.length > 0) yield queue.shift()!;
    }

    // Return exit facts instead of yielding a terminal event — apply() owns
    // the single terminal (and, in a later Phase 2 task, classification).
    return {
      exit: {
        exitCode,
        signal: exitSignal,
        cancelled: cancelSent,
        durationMs: Date.now() - t0,
      },
      ringBuffer: stdoutRing.items(),
      stderrTail: stderrTail.items(),
    };
  } finally {
    // Belt-and-suspenders: the close/error handlers above also clear the
    // timer, but a consumer that aborts the iteration before the child
    // exits would otherwise leak it.
    clearInterval(keepAliveTicker);
  }
}

/** Map exit facts to the single terminal MutationEvent. Mirrors the prior
 *  exit-code behavior; the Phase 2 classifier will supersede this with a
 *  work-product-based outcome. */
function terminalFromExit(mutationId: string, exit: ExitFacts): MutationEvent {
  const { exitCode, signal, cancelled, durationMs } = exit;
  const isSignalKill = signal === 'SIGTERM' || exitCode === 143;
  if (exitCode === 0) {
    return term(mutationId, 'completed', { exitCode: 0, durationMs });
  }
  if (isSignalKill && cancelled) {
    return term(mutationId, 'failed', { exitCode, durationMs, reason: 'cancelled' });
  }
  if (isSignalKill) {
    return term(mutationId, 'failed', { exitCode, durationMs, reason: 'killed' });
  }
  return term(mutationId, 'failed', { exitCode, durationMs, reason: `exited with code ${String(exitCode)}` });
}

function term(
  mutationId: string,
  kind: 'completed' | 'failed',
  data: Record<string, unknown>,
): MutationEvent {
  return { mutationId, ts: new Date().toISOString(), kind, data };
}
