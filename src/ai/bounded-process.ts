import { spawn, type ChildProcess } from 'node:child_process';

export type BoundedProcessResult =
  | { status: 'completed'; exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
  | { status: 'timed-out'; stdout: string; stderr: string }
  | { status: 'spawn-error'; code?: string };

export type AiExecutorProbeFailureCode =
  | 'not-authenticated'
  | 'timeout'
  | 'spawn-failed'
  | 'nonzero-exit'
  | 'invalid-response'
  | 'tool-attempt'
  | 'sandbox-unavailable'
  | 'sandbox-setup-failed'
  | 'cleanup-failed';

export type AiExecutorProbeResult =
  | { ok: true }
  | { ok: false; code: AiExecutorProbeFailureCode; diagnostic?: string };

export interface BoundedProcessOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  reapGraceMs?: number;
  outputLimitBytes?: number;
  detached?: boolean;
  register?: (child: ChildProcess) => void;
  unregister?: (child: ChildProcess) => void;
}

/** Hardened bounded child runtime for AI adapters. Output is retained only for
 * adapter-local parsing; callers must translate it into stable diagnostics. */
export function runBoundedProcess(
  command: string,
  args: readonly string[],
  opts: BoundedProcessOpts,
): Promise<BoundedProcessResult> {
  const outputLimit = opts.outputLimitBytes ?? 16_384;
  const reapGraceMs = opts.reapGraceMs ?? 1_000;
  const detached = opts.detached ?? process.platform !== 'win32';

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        detached,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ status: 'spawn-error', code: (err as NodeJS.ErrnoException).code });
      return;
    }

    opts.register?.(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const appendTail = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString('utf8')}`.slice(-outputLimit);
    child.stdout?.on('data', (chunk: Buffer) => { stdout = appendTail(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendTail(stderr, chunk); });

    const signalTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (detached && process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process tree already exited.
      }
    };

    const finish = (result: BoundedProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      opts.unregister?.(child);
      resolve(result);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalTree('SIGTERM');
      // Always send the group-level SIGKILL after the grace period, even if
      // the leader exits first; otherwise a detached grandchild can escape.
      killTimer = setTimeout(() => signalTree('SIGKILL'), reapGraceMs);
      killTimer.unref();
    }, opts.timeoutMs);

    child.once('error', (err: NodeJS.ErrnoException) => {
      if (timedOut) return;
      finish({ status: 'spawn-error', ...(err.code ? { code: err.code } : {}) });
    });
    child.once('close', (exitCode, signal) => {
      if (!timedOut) {
        finish({ status: 'completed', exitCode, signal, stdout, stderr });
        return;
      }
      const waitForGroupKill = killTimer === undefined
        ? Promise.resolve()
        : new Promise<void>((done) => setTimeout(done, reapGraceMs));
      void waitForGroupKill.then(() => finish({ status: 'timed-out', stdout, stderr }));
    });
  });
}
