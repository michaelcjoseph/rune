import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger to suppress output
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import module under test — note: in-flight uses module-level state (the `ops`
// Map and `_bus`/`_ticker` refs).  We re-import in each test by resetting state
// through the public API (unregisterOp + setting bus to null).
const {
  registerOp,
  unregisterOp,
  cancelOp,
  cancelMostRecentForUser,
  cancelByPrefix,
  listOps,
  isCancelled,
  setInFlightBus,
} = await import('./in-flight.js');

// Helpers
function makeChildProcess() {
  return {
    kill: vi.fn(),
    pid: Math.floor(Math.random() * 10000),
  } as any;
}

function makeOp(overrides: { userId?: number; kind?: any; label?: string } = {}) {
  return {
    kind: overrides.kind ?? ('agent' as const),
    label: overrides.label ?? 'test-agent',
    userId: overrides.userId ?? 42,
    child: makeChildProcess(),
  };
}

// Clean up any registered ops between tests
function drainOps() {
  for (const op of listOps()) {
    unregisterOp(op.opId, 'success');
  }
}

describe('in-flight op registry', () => {
  beforeEach(() => {
    drainOps();
    vi.clearAllMocks();
    // Detach bus so publish calls don't throw
    setInFlightBus(null as any);
  });

  afterEach(() => {
    drainOps();
  });

  describe('registerOp', () => {
    it('returns an InFlightOp with a generated opId', () => {
      const op = registerOp(makeOp());
      expect(op.opId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('adds the op to the registry (visible via listOps) with friendly label', () => {
      // Use an agent name that has no entry in the friendly map so the
      // result is just titleCased — keeps the test independent of the table.
      registerOp({ kind: 'agent', label: 'one-of-a-kind', agentName: 'one-of-a-kind', userId: 42, child: makeChildProcess() });
      const list = listOps();
      expect(list).toHaveLength(1);
      expect(list[0]!.label).toBe('One Of A Kind');
    });

    it('stores kind, label (friendly), userId, startedAt correctly', () => {
      const before = Date.now();
      // raw label 'ask' maps to 'Asking Claude' in the friendly table
      const op = registerOp(makeOp({ userId: 99, kind: 'one-shot', label: 'ask' }));
      const pub = listOps().find(o => o.opId === op.opId)!;
      expect(pub.kind).toBe('one-shot');
      expect(pub.label).toBe('Asking Claude');
      expect(pub.userId).toBe(99);
      expect(new Date(pub.startedAt).getTime()).toBeGreaterThanOrEqual(before);
    });

    it('stores agentName in public shape when provided', () => {
      registerOp({ ...makeOp(), agentName: 'wiki-compiler', kind: 'agent', label: 'wiki-compiler', userId: 42 });
      const pub = listOps()[0]!;
      expect(pub.agentName).toBe('wiki-compiler');
    });

    it('omits agentName from public shape when not provided', () => {
      registerOp(makeOp({ kind: 'one-shot' }));
      const pub = listOps()[0]!;
      expect('agentName' in pub).toBe(false);
    });

    it('registers multiple ops independently', () => {
      registerOp(makeOp({ label: 'op-A' }));
      registerOp(makeOp({ label: 'op-B' }));
      expect(listOps()).toHaveLength(2);
    });
  });

  describe('unregisterOp', () => {
    it('removes the op from the registry', () => {
      const op = registerOp(makeOp());
      unregisterOp(op.opId, 'success');
      expect(listOps()).toHaveLength(0);
    });

    it('is a no-op for an unknown opId', () => {
      expect(() => unregisterOp('nonexistent-id', 'success')).not.toThrow();
    });

    it('keeps other ops in registry after removing one', () => {
      const a = registerOp(makeOp({ label: 'A' }));
      registerOp(makeOp({ label: 'B' }));
      unregisterOp(a.opId, 'success');
      const list = listOps();
      expect(list).toHaveLength(1);
      // Single-char labels pass through titleCase unchanged.
      expect(list[0]!.label).toBe('B');
    });

    it('when op was cancelled, publishes "cancelled" status regardless of passed status', () => {
      // We can verify the behaviour via the bus — but since bus is null here,
      // at least ensure the call doesn't throw.
      const child = makeChildProcess();
      const op = registerOp({ kind: 'agent', label: 'x', userId: 42, child });
      cancelOp(op.opId); // marks as cancelled
      expect(() => unregisterOp(op.opId, 'success')).not.toThrow();
    });
  });

  describe('isCancelled', () => {
    it('returns false for an active, non-cancelled op', () => {
      const op = registerOp(makeOp());
      expect(isCancelled(op.opId)).toBe(false);
    });

    it('returns true after cancelOp has been called', () => {
      const op = registerOp(makeOp());
      cancelOp(op.opId);
      expect(isCancelled(op.opId)).toBe(true);
    });

    it('returns false for an unknown opId', () => {
      expect(isCancelled('unknown-op')).toBe(false);
    });
  });

  describe('cancelOp', () => {
    it('returns true and sends SIGTERM to the child process', () => {
      const child = makeChildProcess();
      const op = registerOp({ kind: 'agent', label: 'y', userId: 42, child });
      const result = cancelOp(op.opId);
      expect(result).toBe(true);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('returns false for a nonexistent opId', () => {
      expect(cancelOp('does-not-exist')).toBe(false);
    });

    it('is idempotent — second cancelOp returns true without re-killing', () => {
      const child = makeChildProcess();
      const op = registerOp({ kind: 'agent', label: 'z', userId: 42, child });
      cancelOp(op.opId);
      cancelOp(op.opId);
      // kill should only have been called once
      expect(child.kill).toHaveBeenCalledOnce();
    });

    it('does not throw when child.kill throws', () => {
      const child = makeChildProcess();
      child.kill.mockImplementation(() => { throw new Error('process already dead'); });
      const op = registerOp({ kind: 'agent', label: 'fragile', userId: 42, child });
      expect(() => cancelOp(op.opId)).not.toThrow();
    });
  });

  describe('cancelMostRecentForUser', () => {
    it('returns null when no ops are registered', () => {
      expect(cancelMostRecentForUser(42)).toBeNull();
    });

    it('returns null when the user has no ops', () => {
      registerOp(makeOp({ userId: 99 }));
      expect(cancelMostRecentForUser(42)).toBeNull();
    });

    it('cancels and returns the most recently started op for the user', async () => {
      // Register two ops with different timestamps — ensure ordering
      const child1 = makeChildProcess();
      const op1 = registerOp({ kind: 'agent', label: 'first', userId: 42, child: child1 });
      // Small gap so startedAt differs
      await new Promise(r => setTimeout(r, 2));
      const child2 = makeChildProcess();
      registerOp({ kind: 'agent', label: 'second', userId: 42, child: child2 });

      const cancelled = cancelMostRecentForUser(42);
      expect(cancelled).not.toBeNull();
      // 'second' has no friendly mapping, falls through to titleCase.
      expect(cancelled!.label).toBe('Second');
      expect(child2.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child1.kill).not.toHaveBeenCalled();
      // op1 is still active
      expect(isCancelled(op1.opId)).toBe(false);
    });

    it('ignores already-cancelled ops when choosing the most recent', () => {
      const child1 = makeChildProcess();
      const op1 = registerOp({ kind: 'agent', label: 'older-active', userId: 42, child: child1 });
      const child2 = makeChildProcess();
      const op2 = registerOp({ kind: 'agent', label: 'newer-cancelled', userId: 42, child: child2 });
      cancelOp(op2.opId); // pre-cancel the newer one

      const cancelled = cancelMostRecentForUser(42);
      expect(cancelled!.opId).toBe(op1.opId);
    });

    it('does not affect ops for other users', () => {
      const child1 = makeChildProcess();
      registerOp({ kind: 'agent', label: 'user-99-op', userId: 99, child: child1 });
      cancelMostRecentForUser(42);
      expect(child1.kill).not.toHaveBeenCalled();
    });

    it('returns public shape without child process', () => {
      const child = makeChildProcess();
      registerOp({ kind: 'agent', label: 'pub-test', userId: 42, child });
      const pub = cancelMostRecentForUser(42);
      expect(pub).not.toBeNull();
      expect('child' in pub!).toBe(false);
      expect(typeof pub!.elapsedMs).toBe('number');
    });
  });

  describe('cancelByPrefix', () => {
    it('returns null when prefix is too short (< 4 chars)', () => {
      expect(cancelByPrefix('ab')).toBeNull();
    });

    it('returns null when no op matches the prefix', () => {
      registerOp(makeOp());
      expect(cancelByPrefix('zzzz-0000')).toBeNull();
    });

    it('finds and cancels an op by id prefix', () => {
      const child = makeChildProcess();
      const op = registerOp({ kind: 'agent', label: 'prefix-test', userId: 42, child });
      const prefix = op.opId.slice(0, 8);
      const pub = cancelByPrefix(prefix);
      expect(pub).not.toBeNull();
      expect(pub!.opId).toBe(op.opId);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('returns public shape with correct fields', () => {
      const child = makeChildProcess();
      const op = registerOp({ kind: 'one-shot', label: 'prefix-pub', userId: 55, child });
      const pub = cancelByPrefix(op.opId.slice(0, 4));
      // 'prefix-pub' has no friendly mapping → titleCase.
      expect(pub!.label).toBe('Prefix Pub');
      expect(pub!.userId).toBe(55);
      expect('child' in pub!).toBe(false);
    });
  });

  describe('listOps', () => {
    it('returns empty array when no ops are registered', () => {
      expect(listOps()).toEqual([]);
    });

    it('returns all registered ops as public shapes', () => {
      registerOp(makeOp({ label: 'alpha', userId: 1 }));
      registerOp(makeOp({ label: 'beta', userId: 2 }));
      const list = listOps();
      expect(list).toHaveLength(2);
      // Labels are formatted (titleCased for unknown raw labels).
      expect(list.map(o => o.label).sort()).toEqual(['Alpha', 'Beta']);
      // Each entry should have elapsedMs (numeric)
      for (const o of list) {
        expect(typeof o.elapsedMs).toBe('number');
      }
    });

    it('does not expose the child ChildProcess in public shape', () => {
      registerOp(makeOp());
      const pub = listOps()[0]!;
      expect('child' in pub).toBe(false);
    });
  });

  describe('bus integration', () => {
    it('publishes a start op-event on registerOp when bus is set', () => {
      const publishMock = vi.fn();
      setInFlightBus({ publish: publishMock, on: vi.fn(), off: vi.fn() } as any);

      registerOp(makeOp({ kind: 'agent', label: 'bus-test' }));

      expect(publishMock).toHaveBeenCalledOnce();
      const event = publishMock.mock.calls[0]![0];
      expect(event.kind).toBe('op-event');
      expect(event.subKind).toBe('start');
      // Bus events carry the friendly label.
      expect(event.label).toBe('Bus Test');
      expect(event.elapsedMs).toBe(0);

      // clean up
      setInFlightBus(null as any);
    });

    it('publishes an end op-event on unregisterOp when bus is set', () => {
      const publishMock = vi.fn();
      setInFlightBus({ publish: publishMock, on: vi.fn(), off: vi.fn() } as any);

      const op = registerOp(makeOp({ kind: 'agent', label: 'end-test' }));
      publishMock.mockClear(); // ignore start event
      unregisterOp(op.opId, 'success');

      expect(publishMock).toHaveBeenCalledOnce();
      const event = publishMock.mock.calls[0]![0];
      expect(event.kind).toBe('op-event');
      expect(event.subKind).toBe('end');
      expect(event.status).toBe('success');

      setInFlightBus(null as any);
    });

    it('publishes end event with "cancelled" status when op was cancelled', () => {
      const publishMock = vi.fn();
      setInFlightBus({ publish: publishMock, on: vi.fn(), off: vi.fn() } as any);

      const child = makeChildProcess();
      const op = registerOp({ kind: 'agent', label: 'cancel-end', userId: 42, child });
      cancelOp(op.opId);
      publishMock.mockClear();
      unregisterOp(op.opId, 'success'); // caller says success, but op.cancelled wins

      const event = publishMock.mock.calls[0]![0];
      expect(event.subKind).toBe('end');
      expect(event.status).toBe('cancelled');

      setInFlightBus(null as any);
    });

    it('does not throw when bus is null and registerOp is called', () => {
      setInFlightBus(null as any);
      expect(() => registerOp(makeOp())).not.toThrow();
    });
  });
});
