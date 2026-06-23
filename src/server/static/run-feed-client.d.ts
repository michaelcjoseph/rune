export type RunFeedTarget = { kind: string; slug: string };
export type RunFeedTasks = { done: number; total: number };
export type RunFeedAgent = { role: string; active: boolean; model?: string };
export type RunFeedOutcome = 'completed' | 'no-op' | 'partial' | 'failed';
export type RunFeedStateName = 'running' | 'parked' | RunFeedOutcome;

export type RunFeedEvent =
  | {
      kind: 'run-event';
      subKind: 'progress';
      runId: string;
      product: string;
      target: RunFeedTarget;
      tasks: RunFeedTasks;
      ts: string;
    }
  | {
      kind: 'run-event';
      subKind: 'agents';
      runId: string;
      product: string;
      target: RunFeedTarget;
      agents: RunFeedAgent[];
      ts: string;
    }
  | {
      kind: 'run-event';
      subKind: 'log';
      runId: string;
      product: string;
      target: RunFeedTarget;
      lines: string[];
      ts: string;
    }
  | {
      kind: 'run-event';
      subKind: 'state';
      runId: string;
      product: string;
      target: RunFeedTarget;
      state: RunFeedStateName;
      elapsedMs: number;
      outcome?: RunFeedOutcome;
      ts: string;
    };

export interface LiveRunSnapshot {
  runId: string;
  product: string;
  target: RunFeedTarget;
  state: string;
  tasks: RunFeedTasks;
  elapsedMs: number;
  worktreePath: string;
  agents: RunFeedAgent[];
  lastLogLines: string[];
  outcome?: string;
  ts: string;
}

export interface RunFeedRunState extends Partial<LiveRunSnapshot> {
  runId: string;
  product?: string;
  target?: RunFeedTarget;
}

export function parseRunFeedFrame(raw: string): RunFeedEvent | null;

export function createRunFeedState(opts?: { maxLogLines?: number }): {
  applySnapshot(snapshot: LiveRunSnapshot): RunFeedRunState;
  applyEvent(event: RunFeedEvent): RunFeedRunState | null;
  getRun(runId: string): RunFeedRunState | null;
};

export function createRunFeedSubscription(opts: {
  runId: string;
  fetchLive?: (runId: string) => Promise<LiveRunSnapshot>;
  openStream?: (opts: { runId: string; onFrame: (raw: string) => void }) => { close?: () => void };
  socket?: {
    addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
    removeEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  };
  fetchJson?: (url: string) => Promise<LiveRunSnapshot>;
  onState?: (state: RunFeedRunState | null) => void;
  maxLogLines?: number;
}): {
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  applyEvent(event: RunFeedEvent): void;
  getState(): RunFeedRunState | null;
  close(): void;
};
