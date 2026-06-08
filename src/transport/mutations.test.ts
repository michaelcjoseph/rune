import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks before any dynamic imports ---

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock appendMutationLine so we don't touch the filesystem
const mockAppendMutationLine = vi.fn();
vi.mock('../jobs/mutations-log.js', () => ({
  appendMutationLine: mockAppendMutationLine,
}));

vi.mock('../config.js', () => ({
  default: {
    TELEGRAM_USER_ID: 42,
    LOGS_DIR: '/test/logs',
    SUPERVISED_RUNS_FILE: '/test/logs/supervised-runs.json',
  },
}));

// Mock supervision-store so the hook tests can assert call shape without
// touching the filesystem.
const mockUpsertRun = vi.fn();
vi.mock('../jobs/supervision-store.js', () => ({
  upsertRun: mockUpsertRun,
}));

// --- Dynamic imports after mocks ---

const {
  registerApplier,
  getApplier,
  createMutation,
  cancelMutation,
  activeRuns,
} = await import('./mutations.ts' as string);

// --- Helpers ---

function makeApplier(overrides: Partial<{
  kind: string;
  autoApprove: boolean;
  validateResult: { ok: true } | { ok: false; reason: string };
  applyGen: AsyncIterable<any>;
}> = {}) {
  const {
    kind = 'work-run',
    autoApprove = false,
    validateResult = { ok: true },
    applyGen,
  } = overrides;

  return {
    kind,
    autoApprove,
    validate: vi.fn(() => validateResult),
    apply: vi.fn(applyGen !== undefined ? () => applyGen : async function* () {
      // default: no-op async generator
    }),
  } as any;
}

// An async generator that yields a completed terminal event
async function* completedGen(id: string): AsyncIterable<any> {
  yield { mutationId: id, ts: new Date().toISOString(), kind: 'completed', data: { exitCode: 0 } };
}

// An async generator that yields a failed terminal event
async function* failedGen(id: string): AsyncIterable<any> {
  yield {
    mutationId: id,
    ts: new Date().toISOString(),
    kind: 'failed',
    data: { reason: 'something went wrong' },
  };
}

// --- Tests ---

describe('mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the module-level registry and active runs between tests
    activeRuns.clear();
    // Note: applierRegistry is module-level — we re-register per test as needed
  });

  describe('registerApplier / getApplier', () => {
    it('registers an applier and retrieves it by kind', () => {
      const applier = makeApplier({ kind: 'work-run' });
      registerApplier(applier);
      expect(getApplier('work-run')).toBe(applier);
    });

    it('returns undefined for an unregistered kind', () => {
      expect(getApplier('project-edit')).toBeUndefined();
    });

    it('overwrites a previously registered applier for the same kind', () => {
      const applier1 = makeApplier({ kind: 'work-run' });
      const applier2 = makeApplier({ kind: 'work-run' });
      registerApplier(applier1);
      registerApplier(applier2);
      expect(getApplier('work-run')).toBe(applier2);
    });
  });

  describe('createMutation', () => {
    it('returns ok: false with reason when kind is not registered', async () => {
      // Ensure 'cron-toggle' is not registered
      const result = await createMutation('cron-toggle', {}, 'webview');
      expect(result.ok).toBe(false);
      expect((result as any).reason).toContain('cron-toggle');
    });

    it('returns ok: false when validate fails', async () => {
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: false,
        validateResult: { ok: false, reason: 'projectSlug is required' },
      });
      registerApplier(applier);

      const result = await createMutation('work-run', {}, 'webview');
      expect(result.ok).toBe(false);
      expect((result as any).reason).toBe('projectSlug is required');
    });

    it('returns ok: true with descriptor containing correct fields when valid', async () => {
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: false,
        validateResult: { ok: true },
      });
      registerApplier(applier);

      const result = await createMutation('work-run', { projectSlug: 'my-project' }, 'webview');
      expect(result.ok).toBe(true);
      const { descriptor } = result as any;
      expect(typeof descriptor.id).toBe('string');
      expect(descriptor.id.length).toBeGreaterThan(0);
      expect(descriptor.kind).toBe('work-run');
      expect(descriptor.source).toBe('webview');
      expect(descriptor.status).toBe('pending');
      expect(descriptor.payload).toEqual({ projectSlug: 'my-project' });
      expect(typeof descriptor.createdAt).toBe('string');
    });

    it('calls appendMutationLine with pending status on successful creation', async () => {
      const applier = makeApplier({ kind: 'work-run', autoApprove: false, validateResult: { ok: true } });
      registerApplier(applier);

      await createMutation('work-run', { projectSlug: 'my-project' }, 'webview');

      expect(mockAppendMutationLine).toHaveBeenCalledOnce();
      const [firstArg] = mockAppendMutationLine.mock.calls[0]!;
      expect(firstArg.status).toBe('pending');
    });

    it('does NOT call applier.apply when autoApprove is false', async () => {
      const applier = makeApplier({ kind: 'work-run', autoApprove: false, validateResult: { ok: true } });
      registerApplier(applier);

      await createMutation('work-run', { projectSlug: 'my-project' }, 'webview');

      expect(applier.apply).not.toHaveBeenCalled();
    });

    it('starts apply immediately when autoApprove is true', async () => {
      let applyStarted = false;
      async function* lazyGen(): AsyncIterable<any> {
        applyStarted = true;
        // yield a completed event so startApply finishes cleanly
        yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'completed', data: {} };
      }

      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: lazyGen(),
      });
      registerApplier(applier);

      await createMutation('work-run', { projectSlug: 'my-project' }, 'webview');

      // Wait a tick for the void startApply promise to begin
      await new Promise(r => setTimeout(r, 10));
      expect(applyStarted).toBe(true);
    });

    it('sets descriptor target.ref from projectSlug', async () => {
      const applier = makeApplier({ kind: 'work-run', autoApprove: false, validateResult: { ok: true } });
      registerApplier(applier);

      const result = await createMutation('work-run', { projectSlug: '06-webview' }, 'webview');
      expect(result.ok).toBe(true);
      expect((result as any).descriptor.target.ref).toBe('06-webview');
    });
  });

  describe('cancelMutation', () => {
    it('returns ok: false when mutation is not in activeRuns', () => {
      const result = cancelMutation('nonexistent-id');
      expect(result.ok).toBe(false);
      expect((result as any).reason).toContain('not found');
    });

    it('calls handle.cancel() when the mutation is active', () => {
      const cancelFn = vi.fn();
      const handle = {
        descriptor: { id: 'active-id' } as any,
        cancel: cancelFn,
      };
      activeRuns.set('active-id', handle);

      const result = cancelMutation('active-id');
      expect(result.ok).toBe(true);
      expect(cancelFn).toHaveBeenCalledOnce();
    });

    it('does not remove the run from activeRuns on cancel (removal happens in startApply)', () => {
      const handle = {
        descriptor: { id: 'active-id' } as any,
        cancel: vi.fn(),
      };
      activeRuns.set('active-id', handle);

      cancelMutation('active-id');

      // cancelMutation itself doesn't remove — startApply does that on exit
      expect(activeRuns.has('active-id')).toBe(true);

      // Clean up
      activeRuns.delete('active-id');
    });
  });

  // -------------------------------------------------------------------------
  // Supervision-store hooks (project 08 Phase 6 A2.2)
  // -------------------------------------------------------------------------

  describe('supervision-store hooks', () => {
    /** Wait until upsertRun has been called at least `n` times, then return
     *  the recorded arguments. Asserts the count was actually reached so a
     *  hook regression (fewer upserts than expected) fails the test instead
     *  of silently passing on a partial array. Bounded timeout protects
     *  against a regression that produces zero upserts. */
    async function waitForUpserts(n: number, timeoutMs = 500): Promise<unknown[][]> {
      const deadline = Date.now() + timeoutMs;
      while (mockUpsertRun.mock.calls.length < n && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(mockUpsertRun.mock.calls.length).toBeGreaterThanOrEqual(n);
      return mockUpsertRun.mock.calls;
    }

    it('createMutation seeds a non-autoApprove mutation as "blocked-on-human"', async () => {
      // A non-autoApprove mutation is awaiting human approval — the cockpit
      // surfaces it via getVisibility's `blocked` bucket, not as actively
      // running. Seeding as 'running' would mis-classify it.
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: false,
        validateResult: { ok: true },
      });
      registerApplier(applier);

      const result = await createMutation('work-run', { projectSlug: 'demo' }, 'webview');
      expect(result.ok).toBe(true);

      const calls = await waitForUpserts(1);
      const [firstArg] = calls[0]!;
      const run = firstArg as { id: string; status: string; project: string };
      expect(run.status).toBe('blocked-on-human');
      expect(run.project).toBe('demo');
      expect(typeof run.id).toBe('string');
    });

    it('createMutation seeds an autoApprove mutation as "running"', async () => {
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: completedGen('x'),
      });
      registerApplier(applier);

      await createMutation('work-run', { projectSlug: 'demo' }, 'webview');

      const calls = await waitForUpserts(1);
      const [firstArg] = calls[0]!;
      const run = firstArg as { status: string };
      expect(run.status).toBe('running');
    });

    it('output events do NOT spam upsertRun — heartbeat is throttled at 30s', async () => {
      // A run that streams many output lines must not block the event loop
      // with per-line read-modify-write. The throttle skips heartbeat
      // upserts until at least HEARTBEAT_THROTTLE_MS (30s) has passed.
      // Within a fast test (sub-second) no heartbeat upsert fires.
      async function* outputGen(): AsyncIterable<any> {
        yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'output', data: { line: 'p1' } };
        yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'output', data: { line: 'p2' } };
        yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'output', data: { line: 'p3' } };
        yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'completed', data: {} };
      }
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: outputGen(),
      });
      registerApplier(applier);

      await createMutation('work-run', { projectSlug: 'demo' }, 'webview');

      // Expected: create-seed + startApply-running + completed = 3.
      // No heartbeat upserts because the 30s window did not elapse.
      const calls = await waitForUpserts(3);
      const statuses = calls.map((c) => (c[0] as { status: string }).status);
      expect(statuses).toEqual(['running', 'running', 'completed']);
    });

    it('a completed event flips the SupervisedRun status to "completed"', async () => {
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: completedGen('placeholder'),
      });
      registerApplier(applier);

      await createMutation('work-run', { projectSlug: 'demo' }, 'webview');

      // create-seed + startApply-running + completed = 3 upserts.
      const calls = await waitForUpserts(3);
      const final = calls[calls.length - 1]![0] as { status: string };
      expect(final.status).toBe('completed');
    });

    it('a PARKED terminal event does NOT clobber blocked-on-human (project 13, Background §7)', async () => {
      // A parked work-run terminates the MUTATION normally (the child exited),
      // but the SUPERVISED run must stay 'blocked-on-human' until a human
      // releases it. The parked terminal event carries explicit `parked: true`
      // metadata, and the terminal branch treats it as a supervision OVERRIDE:
      // persist the descriptor as terminal, but reassert supervision as
      // blocked-on-human rather than completed/failed (the second of the two
      // terminal supervision writers must not clobber the parked record).
      // RED until the mutations.ts parked-aware terminal branch lands.
      async function* parkedGen(): AsyncIterable<any> {
        yield {
          mutationId: 'x',
          ts: new Date().toISOString(),
          kind: 'completed',
          data: {
            parked: true,
            outcome: 'noop',
            operatorWorktreePath: '/tmp/worktrees/jarvis/demo',
            pendingCheck: 'Run the interactive check',
          },
        };
      }
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: parkedGen(),
      });
      registerApplier(applier);

      await createMutation('work-run', { projectSlug: 'demo' }, 'webview');

      // Expected upsert sequence: [running (seed), running (startApply),
      // blocked-on-human (terminal override)]. The parked override replaces the
      // terminal write IN PLACE — it must NOT first write completed/failed and
      // then re-override (that would make `calls[last]` a fragile proxy).
      const calls = await waitForUpserts(3);
      // Let any (incorrect) extra terminal upsert settle so the assertions below
      // would catch a completed/failed write rather than racing past it.
      await new Promise((r) => setTimeout(r, 20));
      const statuses = (mockUpsertRun.mock.calls as unknown[][]).map(
        (c) => (c[0] as { status: string }).status,
      );
      // The supervised run is NEVER written as completed/failed for a parked run.
      expect(statuses).not.toContain('completed');
      expect(statuses).not.toContain('failed');
      // The settled supervision state is blocked-on-human.
      expect(statuses[statuses.length - 1]).toBe('blocked-on-human');
    });

    it('a failed event flips the SupervisedRun status to "failed"', async () => {
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: failedGen('placeholder'),
      });
      registerApplier(applier);

      await createMutation('work-run', { projectSlug: 'demo' }, 'webview');

      // create-seed + startApply-running + failed = 3 upserts.
      const calls = await waitForUpserts(3);
      const final = calls[calls.length - 1]![0] as { status: string };
      expect(final.status).toBe('failed');
    });

    it('seed/running/terminal upserts do NOT write lastChildAliveAt — that field is keep-alive-only', async () => {
      // The three lifecycle upserts (create-seed → startApply-running →
      // completed) advance lastHeartbeatAt only. lastChildAliveAt is a
      // distinct signal owned by the keep-alive ticker; it must not be
      // synthesized by lifecycle writes (otherwise legacy on-disk entries
      // and fresh seeds would carry a fake liveness timestamp and the
      // distinction collapses).
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: completedGen('x'),
      });
      registerApplier(applier);

      await createMutation('work-run', { projectSlug: 'demo' }, 'webview');

      const calls = await waitForUpserts(3);
      for (const call of calls) {
        const run = call[0] as { lastChildAliveAt?: string };
        expect(run.lastChildAliveAt).toBeUndefined();
      }
    });

    it('keep-alive events within the 30s throttle window do NOT spam upsertRun', async () => {
      // Mirror of the existing "output events do NOT spam" test, but for
      // the new keep-alive event kind. Within a fast (<30s) test, three
      // keep-alive events produce zero extra upserts beyond the standard
      // seed/running/terminal trio.
      async function* keepAliveGen(): AsyncIterable<any> {
        yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'keep-alive', data: {} };
        yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'keep-alive', data: {} };
        yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'keep-alive', data: {} };
        yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'completed', data: {} };
      }
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: keepAliveGen(),
      });
      registerApplier(applier);

      await createMutation('work-run', { projectSlug: 'demo' }, 'webview');

      // Expected: seed + running + completed = 3. The three keep-alive
      // events are all within the 30s throttle window, so none of them
      // produce an extra upsert.
      const calls = await waitForUpserts(3);
      expect(calls.length).toBe(3);
      const statuses = calls.map((c) => (c[0] as { status: string }).status);
      expect(statuses).toEqual(['running', 'running', 'completed']);
    });

    it('a keep-alive event past the throttle window updates lastChildAliveAt without changing lastHeartbeatAt', async () => {
      // The whole point of the new event: when the throttle window has
      // elapsed, a keep-alive bumps lastChildAliveAt to "now" but leaves
      // lastHeartbeatAt at its prior value (it represents LLM activity,
      // not process aliveness). Fake timers let us cross the 30s window
      // without sleeping.
      vi.useFakeTimers();
      try {
        const t0 = new Date('2026-01-01T00:00:00.000Z');
        vi.setSystemTime(t0);

        let release: () => void = () => {};
        const gate = new Promise<void>((r) => { release = r; });

        async function* gen(): AsyncIterable<any> {
          await gate;
          yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'keep-alive', data: {} };
          yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'completed', data: {} };
        }

        const applier = makeApplier({
          kind: 'work-run',
          autoApprove: true,
          validateResult: { ok: true },
          applyGen: gen(),
        });
        registerApplier(applier);

        await createMutation('work-run', { projectSlug: 'demo' }, 'webview');

        // Let createMutation's seed + startApply's running upsert settle
        // (both happen synchronously at t=0).
        await vi.advanceTimersByTimeAsync(1);

        // Advance past the 30s throttle window.
        vi.setSystemTime(new Date('2026-01-01T00:00:31.000Z'));
        release();

        // Drain the generator + the loop's downstream handling.
        await vi.advanceTimersByTimeAsync(10);

        const calls = mockUpsertRun.mock.calls;
        // seed + running + keep-alive + completed = 4
        expect(calls.length).toBeGreaterThanOrEqual(4);

        const keepAliveCall = calls.find((c) => {
          const run = c[0] as { lastChildAliveAt?: string };
          return run.lastChildAliveAt === '2026-01-01T00:00:31.000Z';
        });
        expect(keepAliveCall, 'expected a keep-alive upsert at t=31s').toBeDefined();
        const keepAliveRun = keepAliveCall![0] as {
          lastHeartbeatAt: string;
          lastChildAliveAt?: string;
          status: string;
        };
        expect(keepAliveRun.lastChildAliveAt).toBe('2026-01-01T00:00:31.000Z');
        expect(keepAliveRun.lastHeartbeatAt).toBe('2026-01-01T00:00:00.000Z');
        expect(keepAliveRun.status).toBe('running');
      } finally {
        vi.useRealTimers();
      }
    });

    it('an output event past the throttle window sets lastOutputAt (the quiet-run signal)', async () => {
      // Project 11 Phase 4: lastOutputAt advances on output events, distinct
      // from lastChildAliveAt (keep-alive). It is what the quiet-run nudge keys
      // on. Throttled on the 30s heartbeat counter like lastHeartbeatAt.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        let release: () => void = () => {};
        const gate = new Promise<void>((r) => { release = r; });

        async function* gen(): AsyncIterable<any> {
          await gate;
          yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'output', data: { line: 'working' } };
          yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'completed', data: {} };
        }

        const applier = makeApplier({
          kind: 'work-run',
          autoApprove: true,
          validateResult: { ok: true },
          applyGen: gen(),
        });
        registerApplier(applier);

        await createMutation('work-run', { projectSlug: 'demo' }, 'webview');
        await vi.advanceTimersByTimeAsync(1); // settle seed + running upserts

        vi.setSystemTime(new Date('2026-01-01T00:00:31.000Z')); // past the 30s throttle
        release();
        await vi.advanceTimersByTimeAsync(10);

        const outputCall = mockUpsertRun.mock.calls.find((c) => {
          const run = c[0] as { lastOutputAt?: string };
          return run.lastOutputAt === '2026-01-01T00:00:31.000Z';
        });
        expect(outputCall, 'expected an output upsert carrying lastOutputAt at t=31s').toBeDefined();
        const run = outputCall![0] as { lastOutputAt?: string; lastChildAliveAt?: string; status: string };
        expect(run.lastOutputAt).toBe('2026-01-01T00:00:31.000Z');
        // No keep-alive fired → lastChildAliveAt stays unset on this write.
        expect(run.lastChildAliveAt).toBeUndefined();
        // The terminal upsert preserves the output timestamp.
        const terminalCall = mockUpsertRun.mock.calls.find((c) => (c[0] as { status: string }).status === 'completed');
        expect((terminalCall![0] as { lastOutputAt?: string }).lastOutputAt).toBe('2026-01-01T00:00:31.000Z');
      } finally {
        vi.useRealTimers();
      }
    });

    it('copies outcome + workProduct from a work-run terminal event onto the descriptor before persist', async () => {
      // Project 11 Phase 2: the work-product classification rides on the
      // terminal event's `data.outcome` / `data.workProduct`. startApply must
      // copy them onto the descriptor BEFORE appendMutationLine, or the verdict
      // is dropped on persist and never reaches mutations.jsonl / the cockpit.
      const workProduct = {
        commitCount: 0,
        commitShas: [],
        filesChanged: [],
        diffstat: '',
        dirty: false,
        untracked: false,
        transitions: { tasksNewlyChecked: 0, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 },
      };
      async function* outcomeGen(): AsyncIterable<any> {
        yield {
          mutationId: 'x',
          ts: new Date().toISOString(),
          kind: 'completed',
          data: { outcome: 'noop', reason: 'no commits, clean tree', workProduct },
        };
      }
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: outcomeGen(),
      });
      registerApplier(applier);

      const result = await createMutation('work-run', { projectSlug: 'demo' }, 'webview');
      const descriptor = (result as any).descriptor;

      await waitForUpserts(3);

      // The descriptor carries the verdict…
      expect(descriptor.outcome).toBe('noop');
      expect(descriptor.workProduct).toEqual(workProduct);
      // status stays within its enum (verdict rides on `outcome`, not status).
      expect(descriptor.status).toBe('completed');

      // …and the terminal appendMutationLine saw it (copied BEFORE persist).
      const terminalCall = mockAppendMutationLine.mock.calls.find(
        (c) => (c[0] as { status: string }).status === 'completed',
      );
      expect(terminalCall).toBeDefined();
      expect((terminalCall![0] as { outcome?: string }).outcome).toBe('noop');
    });

    it('copies outcome:failed off a failed terminal event onto the descriptor', async () => {
      async function* failedOutcomeGen(): AsyncIterable<any> {
        yield {
          mutationId: 'x',
          ts: new Date().toISOString(),
          kind: 'failed',
          data: { outcome: 'failed', reason: 'exited with code 1' },
        };
      }
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: failedOutcomeGen(),
      });
      registerApplier(applier);

      const result = await createMutation('work-run', { projectSlug: 'demo' }, 'webview');
      const descriptor = (result as any).descriptor;

      await waitForUpserts(3);
      expect(descriptor.outcome).toBe('failed');
      expect(descriptor.status).toBe('failed');
    });

    it('leaves descriptor.outcome undefined when the terminal event carries no outcome (non-work-run)', async () => {
      // A terminal event with no outcome (e.g. a gen-eval-loop or a legacy
      // applier) must not gain a spurious outcome field.
      const applier = makeApplier({
        kind: 'gen-eval-loop',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: completedGen('x'),
      });
      registerApplier(applier);

      const result = await createMutation('gen-eval-loop', { projectSlug: 'demo' }, 'webview');
      const descriptor = (result as any).descriptor;

      await waitForUpserts(3);
      expect(descriptor.outcome).toBeUndefined();
      expect(descriptor.workProduct).toBeUndefined();
    });

    it('an applier crash (thrown error) flips the SupervisedRun to "failed"', async () => {
      async function* throwingGen(): AsyncIterable<any> {
        yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'output', data: { line: 'starting' } };
        throw new Error('boom — applier crashed');
      }
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: throwingGen(),
      });
      registerApplier(applier);

      await createMutation('work-run', { projectSlug: 'demo' }, 'webview');

      // create-seed + startApply-running + catch(failed) = 3. The output
      // event's heartbeat is throttled within the fast-test window, so
      // there's no 4th upsert for it.
      const calls = await waitForUpserts(3);
      const final = calls[calls.length - 1]![0] as { status: string };
      expect(final.status).toBe('failed');
    });
  });
});
