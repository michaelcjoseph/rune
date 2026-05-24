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
