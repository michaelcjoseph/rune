import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  writeRecoveredTerminalMutation,
  setMutationShutdownInProgress,
  setMutationBus,
} = await import('./mutations.ts' as string);

// --- Helpers ---

function makeApplier(overrides: Partial<{
  kind: string;
  autoApprove: boolean;
  supervised: boolean;
  validateResult: { ok: true } | { ok: false; reason: string };
  applyGen: AsyncIterable<any>;
}> = {}) {
  const {
    kind = 'work-run',
    autoApprove = false,
    supervised,
    validateResult = { ok: true },
    applyGen,
  } = overrides;

  return {
    kind,
    autoApprove,
    ...(supervised !== undefined ? { supervised } : {}),
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

    it("forwards a 'writing' applier's events to the run feed (state + log frames)", async () => {
      // publishDerivedRunEvent is kind-gated; the writing engine's cockpit
      // visibility depends on 'writing' passing that gate like work-run does.
      const published: any[] = [];
      setMutationBus({ publish: (e: any) => published.push(e) } as any);
      try {
        async function* writingGen(): AsyncIterable<any> {
          const ts = new Date().toISOString();
          yield { mutationId: 'w', ts, kind: 'start', data: { slug: 't' } };
          yield { mutationId: 'w', ts, kind: 'output', data: { line: 'writing: drafting' } };
          yield { mutationId: 'w', ts, kind: 'completed', data: { outcome: 'branch-complete' } };
        }
        registerApplier(makeApplier({
          kind: 'writing',
          autoApprove: true,
          validateResult: { ok: true },
          applyGen: writingGen(),
        }));

        await createMutation('writing', { product: 'writing', projectSlug: 't' }, 'cli');
        await new Promise((r) => setTimeout(r, 20));

        const runEvents = published.filter((e) => e.kind === 'run-event');
        expect(runEvents.some((e) => e.subKind === 'state' && e.state === 'running')).toBe(true);
        expect(runEvents.some((e) => e.subKind === 'log' && e.lines?.[0] === 'writing: drafting')).toBe(true);
        expect(runEvents.some((e) => e.subKind === 'state' && e.state === 'completed' && e.outcome === 'completed')).toBe(true);
        const anyRunEvent = runEvents[0];
        expect(anyRunEvent.product).toBe('writing');
        expect(anyRunEvent.target).toEqual({ kind: 'project', slug: 't' });
      } finally {
        setMutationBus(null);
      }
    });
  });

  describe('cancelMutation', () => {
    async function waitFor(condition: () => boolean): Promise<void> {
      for (let i = 0; i < 20 && !condition(); i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(condition()).toBe(true);
    }

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

    it('invokes registered cancel listeners exactly once per cancel call', async () => {
      const listener = vi.fn();
      let listenerRegistered = false;
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const applier = {
        kind: 'work-run',
        autoApprove: true,
        validate: vi.fn(() => ({ ok: true })),
        apply: vi.fn(async function* (descriptor: any, ctx: any) {
          ctx.onCancel(listener);
          listenerRegistered = true;
          await finished;
          yield { mutationId: descriptor.id, ts: new Date().toISOString(), kind: 'completed', data: {} };
        }),
      } as any;
      registerApplier(applier);

      const created = await createMutation('work-run', { projectSlug: 'demo' }, 'webview');
      expect(created.ok).toBe(true);
      const id = (created as any).descriptor.id;
      await waitFor(() => listenerRegistered && activeRuns.has(id));

      expect(cancelMutation(id, 'system')).toEqual({ ok: true });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenLastCalledWith('system');

      expect(cancelMutation(id, 'user')).toEqual({ ok: true });
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenLastCalledWith('user');

      finish();
      await waitFor(() => !activeRuns.has(id));
    });

    it('does not call unsubscribed cancel listeners', async () => {
      const listener = vi.fn();
      let listenerRegistered = false;
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const applier = {
        kind: 'work-run',
        autoApprove: true,
        validate: vi.fn(() => ({ ok: true })),
        apply: vi.fn(async function* (descriptor: any, ctx: any) {
          const unsubscribe = ctx.onCancel(listener);
          unsubscribe();
          listenerRegistered = true;
          await finished;
          yield { mutationId: descriptor.id, ts: new Date().toISOString(), kind: 'completed', data: {} };
        }),
      } as any;
      registerApplier(applier);

      const created = await createMutation('work-run', { projectSlug: 'demo' }, 'webview');
      expect(created.ok).toBe(true);
      const id = (created as any).descriptor.id;
      await waitFor(() => listenerRegistered && activeRuns.has(id));

      expect(cancelMutation(id)).toEqual({ ok: true });
      expect(listener).not.toHaveBeenCalled();

      finish();
      await waitFor(() => !activeRuns.has(id));
    });

    it('does not delete a newer active handle when an older apply finally exits', async () => {
      let finish!: () => void;
      let runId = '';
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const applier = {
        kind: 'work-run',
        autoApprove: true,
        validate: vi.fn(() => ({ ok: true })),
        apply: vi.fn(async function* (descriptor: any) {
          runId = descriptor.id;
          await finished;
          yield { mutationId: descriptor.id, ts: new Date().toISOString(), kind: 'completed', data: {} };
        }),
      } as any;
      registerApplier(applier);

      const created = await createMutation('work-run', { projectSlug: 'demo' }, 'webview');
      expect(created.ok).toBe(true);
      const id = (created as any).descriptor.id;
      await waitFor(() => runId === id && activeRuns.has(id));

      const newerHandle = {
        descriptor: { id, kind: 'work-run', status: 'running', payload: { projectSlug: 'demo' } } as any,
        cancel: vi.fn(),
      };
      activeRuns.set(id, newerHandle);
      finish();
      await new Promise((r) => setTimeout(r, 10));

      expect(activeRuns.get(id)).toBe(newerHandle);
      activeRuns.delete(id);
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

    it('a supervised:false applier (e.g. work-run-release) seeds NO supervised record', async () => {
      // A control mutation that acts ON another run opts out of supervision
      // tracking — the pipeline must not seed a redundant bare-UUID record (which
      // would trip the stall nudge on a slow finalize or a spurious recovery warn).
      const applier = makeApplier({
        kind: 'work-run-release',
        autoApprove: true,
        supervised: false,
        validateResult: { ok: true },
        applyGen: completedGen('parked-run-1'),
      });
      registerApplier(applier);

      const result = await createMutation('work-run-release', { runId: 'parked-run-1' }, 'webview');
      expect(result.ok).toBe(true);

      // Give startApply a tick to run to terminal; assert ZERO supervision writes.
      await new Promise((r) => setTimeout(r, 30));
      expect(mockUpsertRun).not.toHaveBeenCalled();
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
            operatorWorktreePath: '/tmp/worktrees/rune/demo',
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

    it('an activity event past the throttle window advances lastOutputAt (subagent/tool-liveness fix)', async () => {
      // Bug fix: a parsed stream-json envelope that renders nothing (a subagent/
      // Task `system` frame or a successful tool_result) is emitted as a
      // non-rendered `activity` event. It must advance the same activity
      // heartbeat as `output` (lastHeartbeatAt + lastOutputAt) so a run busy in
      // a long tool call or subagent isn't seen as quiet. Mirrors the `output`
      // test above.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        let release: () => void = () => {};
        const gate = new Promise<void>((r) => { release = r; });

        async function* gen(): AsyncIterable<any> {
          await gate;
          yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'activity', data: {} };
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

        const activityCall = mockUpsertRun.mock.calls.find((c) => {
          const run = c[0] as { lastOutputAt?: string };
          return run.lastOutputAt === '2026-01-01T00:00:31.000Z';
        });
        expect(activityCall, 'expected an activity upsert carrying lastOutputAt at t=31s').toBeDefined();
        const run = activityCall![0] as { lastOutputAt?: string; lastHeartbeatAt: string; status: string };
        expect(run.lastOutputAt).toBe('2026-01-01T00:00:31.000Z');
        expect(run.lastHeartbeatAt).toBe('2026-01-01T00:00:31.000Z');
        expect(run.status).toBe('running');
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

    it('copies outcome + workProduct from an orchestrated-work terminal event onto the descriptor before persist', async () => {
      // Phase 10 parity: orchestrated-work computes the same work-product
      // classification over its branch. The mutation pipeline must persist that
      // verdict exactly like the legacy work-run path, otherwise the cockpit,
      // Telegram, mutations.jsonl, and GC lose the orchestrated result.
      const workProduct = {
        commitCount: 2,
        commitShas: ['abc1111', 'def2222'],
        filesChanged: ['src/jobs/orchestrated-work-runner.ts'],
        diffstat: ' src/jobs/orchestrated-work-runner.ts | 8 ++++++++\n 1 file changed, 8 insertions(+)',
        dirty: false,
        untracked: false,
        transitions: { tasksNewlyChecked: 1, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 },
      };
      async function* outcomeGen(): AsyncIterable<any> {
        yield {
          mutationId: 'x',
          ts: new Date().toISOString(),
          kind: 'completed',
          data: { outcome: 'branch-complete', reason: '2 commits, all original tasks checked', workProduct },
        };
      }
      const applier = makeApplier({
        kind: 'orchestrated-work',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: outcomeGen(),
      });
      registerApplier(applier);

      const result = await createMutation('orchestrated-work', { projectSlug: 'demo' }, 'webview');
      const descriptor = (result as any).descriptor;

      await waitForUpserts(3);

      expect(descriptor.outcome).toBe('branch-complete');
      expect(descriptor.workProduct).toEqual(workProduct);
      expect(descriptor.status).toBe('completed');

      const terminalCall = mockAppendMutationLine.mock.calls.find(
        (c) => (c[0] as { status: string }).status === 'completed',
      );
      expect(terminalCall).toBeDefined();
      expect((terminalCall![0] as { outcome?: string; workProduct?: unknown }).outcome).toBe('branch-complete');
      expect((terminalCall![0] as { outcome?: string; workProduct?: unknown }).workProduct).toEqual(workProduct);
    });

    it('does not append a stale second terminal after recovered orchestrated-work already completed the run', async () => {
      // Phase 11B restart acceptance: during an injected restart, recovery may
      // re-dispatch and complete the persisted running mutation while the old
      // applier is still draining. The mutation log must keep one latest
      // terminal state for the logical run, not a recovered terminal followed by
      // a stale second terminal from the pre-restart applier.
      let releaseOriginal: () => void = () => {};
      const originalMayFinish = new Promise<void>((resolve) => {
        releaseOriginal = resolve;
      });

      async function* staleOriginalGen(): AsyncIterable<any> {
        await originalMayFinish;
        yield {
          mutationId: 'stale-original-terminal',
          ts: new Date().toISOString(),
          kind: 'completed',
          data: { outcome: 'branch-complete', reason: 'stale original drain' },
        };
      }

      const applier = makeApplier({
        kind: 'orchestrated-work',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: staleOriginalGen(),
      });
      registerApplier(applier);

      const result = await createMutation('orchestrated-work', { projectSlug: 'demo' }, 'webview');
      expect(result.ok).toBe(true);
      const descriptor = (result as any).descriptor;

      await waitForUpserts(2);
      expect(activeRuns.has(descriptor.id)).toBe(true);
      mockAppendMutationLine.mockClear();
      mockUpsertRun.mockClear();

      writeRecoveredTerminalMutation(descriptor, {
        mutationId: descriptor.id,
        ts: new Date().toISOString(),
        kind: 'completed',
        data: { outcome: 'branch-complete', reason: 'recovered run completed' },
      });

      releaseOriginal();
      const inactiveDeadline = Date.now() + 500;
      while (activeRuns.has(descriptor.id) && Date.now() < inactiveDeadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(activeRuns.has(descriptor.id)).toBe(false);

      const completedAppends = mockAppendMutationLine.mock.calls.filter(
        ([entry]) => entry.id === descriptor.id && entry.kind === 'orchestrated-work' && entry.status === 'completed',
      );
      expect(completedAppends).toHaveLength(1);
      expect((completedAppends[0]![0] as { error?: string }).error).toBeUndefined();

      const postRecoverySupervisionWrites = mockUpsertRun.mock.calls.filter(
        ([run]) => run.id === descriptor.id && run.kind === 'orchestrated-work',
      );
      expect(postRecoverySupervisionWrites).toHaveLength(1);
      expect(postRecoverySupervisionWrites[0]![0]).toMatchObject({
        id: descriptor.id,
        kind: 'orchestrated-work',
        status: 'completed',
      });
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

  describe('shutdown suppression (setMutationShutdownInProgress)', () => {
    // shutdown() arms the flag before killActiveProcesses(); the SIGTERM'd
    // child then surfaces in the applier as a terminal/throw the run never
    // earned. startApply must NOT persist it for orchestrated-work — the
    // on-disk `running` state is owned by the shutdown parker
    // (parkInFlightOrchestratedRuns) and next-boot recovery.
    afterEach(() => {
      setMutationShutdownInProgress(false);
    });

    async function settle(ms = 30): Promise<void> {
      await new Promise((r) => setTimeout(r, ms));
    }

    function persistedStatuses(): { snapshots: string[]; supervision: string[] } {
      return {
        snapshots: (mockAppendMutationLine.mock.calls as unknown[][]).map(
          (c) => (c[0] as { status: string }).status,
        ),
        supervision: (mockUpsertRun.mock.calls as unknown[][]).map(
          (c) => (c[0] as { status: string }).status,
        ),
      };
    }

    it('suppresses an orchestrated-work terminal during shutdown — mutation stays running for boot recovery', async () => {
      const applier = makeApplier({
        kind: 'orchestrated-work',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: failedGen('x'),
      });
      registerApplier(applier);

      setMutationShutdownInProgress(true);
      const result = await createMutation('orchestrated-work', { projectSlug: 'demo' }, 'webview');
      expect(result.ok).toBe(true);
      const descriptor = (result as any).descriptor;
      await settle();

      // The descriptor never flips terminal, and neither writer persists one.
      expect(descriptor.status).toBe('running');
      const { snapshots, supervision } = persistedStatuses();
      expect(snapshots).not.toContain('failed');
      expect(snapshots).not.toContain('completed');
      expect(supervision).not.toContain('failed');
      expect(supervision).not.toContain('completed');
      // The handle stays DISCOVERABLE: the shutdown parker snapshots
      // activeRuns after the children are dead, and a suppressed unwind that
      // deleted its handle would hide the run from the parker (left running
      // with no cursor → orphaned at next boot).
      expect(activeRuns.has(descriptor.id)).toBe(true);
    });

    it('suppresses an orchestrated-work applier crash during shutdown', async () => {
      async function* throwingGen(): AsyncIterable<any> {
        yield { mutationId: 'x', ts: new Date().toISOString(), kind: 'output', data: { line: 'starting' } };
        throw new Error('child SIGTERM surfaced as applier throw');
      }
      const applier = makeApplier({
        kind: 'orchestrated-work',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: throwingGen(),
      });
      registerApplier(applier);

      setMutationShutdownInProgress(true);
      const result = await createMutation('orchestrated-work', { projectSlug: 'demo' }, 'webview');
      const descriptor = (result as any).descriptor;
      await settle();

      expect(descriptor.status).toBe('running');
      const { snapshots, supervision } = persistedStatuses();
      expect(snapshots).not.toContain('failed');
      expect(supervision).not.toContain('failed');
      // Crash unwind also keeps the handle discoverable for the parker.
      expect(activeRuns.has(descriptor.id)).toBe(true);
    });

    it('a non-orchestrated kind still persists its terminal during shutdown', async () => {
      // Legacy work runs keep their existing crash semantics — boot-side
      // recovery-finalize is designed for their stale rows.
      const applier = makeApplier({
        kind: 'work-run',
        autoApprove: true,
        validateResult: { ok: true },
        applyGen: completedGen('x'),
      });
      registerApplier(applier);

      setMutationShutdownInProgress(true);
      const result = await createMutation('work-run', { projectSlug: 'demo' }, 'webview');
      const descriptor = (result as any).descriptor;
      await settle();

      expect(descriptor.status).toBe('completed');
      const { snapshots, supervision } = persistedStatuses();
      expect(snapshots).toContain('completed');
      expect(supervision).toContain('completed');
      // Non-orchestrated kinds also keep normal activeRuns cleanup.
      expect(activeRuns.size).toBe(0);
    });
  });
});
