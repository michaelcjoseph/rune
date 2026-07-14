import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const recoverOrchestratedWorkRuns = vi.hoisted(() =>
  vi.fn(async () => {
    calls.push('recover-orchestrated-work');
    return { resumed: ['mut-orch-resume'], orphaned: [], skipped: [] };
  }),
);
const parkInFlightOrchestratedRuns = vi.hoisted(() =>
  vi.fn(async () => {
    calls.push('park-orchestrated-runs');
    return { parked: [], resumable: [], skipped: [] };
  }),
);

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
}));

vi.mock('./config.js', () => ({
  PROJECT_ROOT: '/tmp/rune',
  assertOperatorConfig: vi.fn(() => calls.push('assert-operator-config')),
  default: {
    LOGS_DIR: '/tmp/rune/logs',
    WORKTREE_ROOT: '/tmp/rune/worktrees',
    PRODUCTS_CONFIG_FILE: '/tmp/rune/products.json',
    WORK_RUNS_DIR: '/tmp/rune/work-runs',
    SUPERVISED_RUNS_FILE: '/tmp/rune/supervised-runs.json',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: 3847,
    VAULT_DIR: '/tmp/vault',
    TELEGRAM_USER_ID: 12345,
    RUNE_HTTP_SECRET: '',
    MCP_ISSUER_URL: '',
  },
}));

vi.mock('./kb/init.js', () => ({
  initKB: vi.fn(() => calls.push('init-kb')),
}));

vi.mock('./vault/sessions.js', () => ({
  restoreSessions: vi.fn(() => calls.push('restore-sessions')),
  persistSessions: vi.fn(),
  getAllSessions: vi.fn(() => []),
}));

vi.mock('./ai/claude.js', () => ({
  markSessionCreated: vi.fn(),
  killActiveProcesses: vi.fn(() => calls.push('kill-active-processes')),
  waitForActiveProcesses: vi.fn(async () => {
    calls.push('wait-active-processes');
  }),
  setBus: vi.fn(() => calls.push('set-claude-bus')),
  rotateStreamLogIfLarge: vi.fn(() => calls.push('rotate-stream-log')),
  assertProjectMcpConfig: vi.fn(() => calls.push('assert-mcp-config')),
}));

vi.mock('./transport/mutations.js', () => ({
  setMutationBus: vi.fn(() => calls.push('set-mutation-bus')),
  registerApplier: vi.fn((applier: { kind: string }) => calls.push(`register-applier:${applier.kind}`)),
  setMutationShutdownInProgress: vi.fn(() => calls.push('arm-shutdown-suppression')),
}));

vi.mock('./transport/in-flight.js', () => ({
  setInFlightBus: vi.fn(() => calls.push('set-in-flight-bus')),
  stopInFlightTicker: vi.fn(),
}));

vi.mock('./jobs/mutations-log.js', () => ({
  reconcileOrphans: vi.fn(() => calls.push('reconcile-orphans')),
}));

vi.mock('./jobs/sandbox-runtime.js', () => ({
  cleanupOrphanWorktrees: vi.fn(async () => {
    calls.push('cleanup-worktrees');
    return [];
  }),
}));

vi.mock('./jobs/work-run-gc-runner.js', () => ({
  runWorkRunGc: vi.fn(() => {
    calls.push('work-run-gc');
    return Promise.resolve();
  }),
}));

vi.mock('./jobs/registry-rebuild.js', () => ({
  rebuildRegistry: vi.fn(() => {
    calls.push('rebuild-registry');
    return { products: 0, projects: 0 };
  }),
}));

vi.mock('./jobs/supervision-recovery.js', () => ({
  recoverSupervisedRuns: vi.fn(() => calls.push('recover-supervised-runs')),
}));

vi.mock('./jobs/recovery-finalize-runner.js', () => ({
  runRecoveryFinalize: vi.fn(async () => calls.push('recovery-finalize')),
}));

vi.mock('./jobs/work-runner.js', () => ({
  workRunApplier: { kind: 'work-run' },
}));

vi.mock('./jobs/gen-eval-loop-runner.js', () => ({
  genEvalLoopApplier: { kind: 'gen-eval-loop' },
}));

vi.mock('./jobs/orchestrated-work-runner.js', () => ({
  orchestratedWorkApplier: { kind: 'orchestrated-work' },
  recoverOrchestratedWorkRuns,
  parkInFlightOrchestratedRuns,
  readTasksMdForRecoveredCursor: vi.fn(async () => ''),
  redispatchRecoveredOrchestratedMutation: vi.fn(() => ({ ok: true })),
}));

vi.mock('./jobs/work-run-release.js', () => ({
  workRunReleaseApplier: { kind: 'work-run-release' },
}));

vi.mock('./reviews/session.js', () => ({
  restoreReviewSessions: vi.fn(() => calls.push('restore-review-sessions')),
  persistReviewSessions: vi.fn(),
  getAllReviewSessions: vi.fn(() => []),
}));

vi.mock('./reviews/planning.js', () => ({
  restorePlanningSessions: vi.fn(() => calls.push('restore-planning-sessions')),
  persistPlanningSessions: vi.fn(),
  getAllPlanningSessions: vi.fn(() => []),
}));

vi.mock('./bot/telegram.js', () => ({
  createBot: vi.fn(() => ({
    stopPolling: vi.fn(),
  })),
  wireHandlers: vi.fn(() => calls.push('wire-telegram')),
}));

vi.mock('./server/http.js', () => ({
  startHttpServer: vi.fn(() => ({
    close: vi.fn(),
  })),
  closeMcpSessions: vi.fn(async () => undefined),
}));

vi.mock('./server/mcp-oauth.js', () => ({
  createMcpOAuth: vi.fn(),
}));

vi.mock('./server/mcp-oauth-store.js', () => ({
  readOAuthStore: vi.fn(),
  writeOAuthStore: vi.fn(),
}));

vi.mock('./jobs/scheduler.js', () => ({
  startScheduler: vi.fn(() => calls.push('start-scheduler')),
  stopScheduler: vi.fn(),
}));

vi.mock('./jobs/stall-check-runner.js', () => ({
  startStallCheck: vi.fn(() => calls.push('start-stall-check')),
  stopStallCheck: vi.fn(),
}));

vi.mock('./jobs/work-run-reconciler.js', () => ({
  defaultTerminalWorkRunReconcilerDeps: vi.fn(async () => {
    calls.push('default-terminal-work-run-reconciler-deps');
    return {
      supervisedRunsFile: '/tmp/rune/supervised-runs.json',
      workRunsDir: '/tmp/rune/work-runs',
      terminalizeMutation: vi.fn(),
      findRunningMutation: vi.fn(),
      now: () => '2026-06-19T12:00:00.000Z',
    };
  }),
  startTerminalWorkRunReconciler: vi.fn(() => calls.push('start-terminal-work-run-reconciler')),
  stopTerminalWorkRunReconciler: vi.fn(),
}));

vi.mock('./jobs/planning-expiry-runner.js', () => ({
  startPlanningExpiry: vi.fn(() => calls.push('start-planning-expiry')),
  stopPlanningExpiry: vi.fn(),
}));

vi.mock('./vault/watcher.js', () => ({
  startWatcher: vi.fn(() => calls.push('start-watcher')),
  stopWatcher: vi.fn(),
}));

vi.mock('./bot/skill-registry.js', () => ({
  getSkillRegistry: vi.fn(() => {
    calls.push('get-skill-registry');
    return {};
  }),
}));

vi.mock('./intent/model-policy.js', () => ({
  loadModelPolicy: vi.fn(() => calls.push('load-model-policy')),
}));

vi.mock('./utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  flushLogger: vi.fn(async () => undefined),
}));

vi.mock('./transport/notification-bus.js', () => ({
  NotificationBus: vi.fn(function NotificationBus() {
    return { publish: vi.fn(), on: vi.fn(), off: vi.fn() };
  }),
}));

vi.mock('./transport/sender.js', () => ({
  createSenders: vi.fn(() => ({
    tg: {},
    webview: {},
    destroy: vi.fn(),
  })),
}));

describe('index startup orchestrated-work recovery', () => {
  it('wires boot recovery so a still-running orchestrated mutation can be reconstructed and re-dispatched before worktree cleanup', async () => {
    await import('./index.js');

    expect(recoverOrchestratedWorkRuns).toHaveBeenCalledOnce();
    expect(recoverOrchestratedWorkRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        readRunningOrchestratedMutations: expect.any(Function),
        readRunCursor: expect.any(Function),
        readTaskRunRecords: expect.any(Function),
        readTasksMd: expect.any(Function),
        redispatchOrchestratedMutation: expect.any(Function),
        markOrphaned: expect.any(Function),
        writeTerminal: expect.any(Function),
      }),
    );

    expect(calls.indexOf('register-applier:orchestrated-work')).toBeLessThan(calls.indexOf('recover-orchestrated-work'));
    expect(calls.indexOf('recover-orchestrated-work')).toBeLessThan(calls.indexOf('cleanup-worktrees'));
    expect(calls.indexOf('recover-orchestrated-work')).toBeLessThan(calls.indexOf('reconcile-orphans'));
    expect(calls.indexOf('reconcile-orphans')).toBeLessThan(calls.indexOf('cleanup-worktrees'));
  });

  it('starts the terminal work-run reconciler on boot so stranded terminal artifacts self-heal without another restart', async () => {
    await import('./index.js');

    expect(calls).toContain('default-terminal-work-run-reconciler-deps');
    expect(calls).toContain('start-terminal-work-run-reconciler');
    expect(calls.indexOf('start-stall-check')).toBeLessThan(
      calls.indexOf('default-terminal-work-run-reconciler-deps'),
    );
    expect(calls.indexOf('default-terminal-work-run-reconciler-deps')).toBeLessThan(
      calls.indexOf('start-terminal-work-run-reconciler'),
    );
    expect(calls.indexOf('start-terminal-work-run-reconciler')).toBeLessThan(
      calls.indexOf('start-planning-expiry'),
    );
  });

  it('SIGTERM arms shutdown suppression before killing children, then parks unresumable orchestrated runs', async () => {
    // The shutdown parker (bugs.md — orchestrated-run restart safety 1/2):
    // suppression must be armed BEFORE the child SIGTERMs (so the dying
    // applier cannot persist a failed terminal or destroy the worktree), and
    // the park runs AFTER the wait (children dead → worktrees stable).
    await import('./index.js');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      // Invoke index.ts's own SIGTERM listener directly — process.emit would
      // also fire any harness-level signal listeners.
      const listeners = process.listeners('SIGTERM');
      expect(listeners.length).toBeGreaterThan(0);
      (listeners[listeners.length - 1] as () => void)();

      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
      expect(parkInFlightOrchestratedRuns).toHaveBeenCalledOnce();
      expect(calls.indexOf('arm-shutdown-suppression')).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf('arm-shutdown-suppression')).toBeLessThan(calls.indexOf('kill-active-processes'));
      expect(calls.indexOf('kill-active-processes')).toBeLessThan(calls.indexOf('wait-active-processes'));
      expect(calls.indexOf('wait-active-processes')).toBeLessThan(calls.indexOf('park-orchestrated-runs'));
    } finally {
      exitSpy.mockRestore();
    }
  });
});
