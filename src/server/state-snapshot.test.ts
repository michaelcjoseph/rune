import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks must precede any imports that pull in the mocked modules ---

const mockConfig = {
  TELEGRAM_USER_ID: 42,
  LOGS_DIR: '/test/logs',
};

vi.mock('../config.js', () => ({ default: mockConfig }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetSession = vi.fn<() => any>(() => null);
vi.mock('../vault/sessions.js', () => ({ getSession: mockGetSession }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetActiveReviewSession = vi.fn<() => any>(() => null);
vi.mock('../reviews/session.js', () => ({ getActiveReviewSession: mockGetActiveReviewSession }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetQueue = vi.fn<() => any>(() => []);
vi.mock('../kb/queue.js', () => ({ getQueue: mockGetQueue }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetPendingPlaybookDrafts = vi.fn<() => any>(() => []);
vi.mock('../jobs/playbook-extract.js', () => ({ getPendingPlaybookDrafts: mockGetPendingPlaybookDrafts }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetPendingProposals = vi.fn<() => any>(() => []);
vi.mock('../jobs/proposal-queue.js', () => ({ getPendingProposals: mockGetPendingProposals }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockReadRecentMutations = vi.fn<() => any>(() => []);
vi.mock('../jobs/mutations-log.js', () => ({
  readRecentMutations: mockReadRecentMutations,
  appendMutationLine: vi.fn(),
}));

vi.mock('../transport/mutations.js', () => ({
  activeRuns: new Map(),
  registerApplier: vi.fn(),
  getApplier: vi.fn(),
  createMutation: vi.fn(),
  cancelMutation: vi.fn(),
  setMutationBus: vi.fn(),
}));

const mockListOps = vi.fn<() => any[]>(() => []);
vi.mock('../transport/in-flight.js', () => ({
  listOps: mockListOps,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetProjectSummaries = vi.fn<() => any>(() => []);
vi.mock('./projects-snapshot.js', () => ({ getProjectSummaries: mockGetProjectSummaries }));

// node:fs is mocked to control readFileSync responses
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockReadFileSync = vi.fn<(...args: any[]) => any>(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  appendFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

const { getStateSnapshot } = await import('./state-snapshot.js');

// ---- helpers ----

function makeSession(overrides = {}) {
  return { sessionId: 'sess-1', model: 'claude-opus-4-7', messageCount: 5, ...overrides };
}

function makeReview(overrides = {}) {
  return { type: 'weekly', phase: 'interview', targetDate: '2026-05-05', ...overrides };
}

function makeSchedulerState(overrides: Record<string, number> = {}) {
  return JSON.stringify({ 'morning-prep': 1746000000000, nightly: 1746003600000, ...overrides });
}

function makeAgentRunLines(n: number): string {
  return Array.from({ length: n }, (_, i) => JSON.stringify({
    agent: `agent-${i}`,
    startedAt: `2026-05-05T0${i}:00:00.000Z`,
    durationMs: 1000 + i * 100,
    status: i % 3 === 0 ? 'error' : 'success',
  })).join('\n') + '\n';
}

// ---- tests ----

describe('state-snapshot / getStateSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockReturnValue(null);
    mockGetActiveReviewSession.mockReturnValue(null);
    mockGetQueue.mockReturnValue([]);
    mockGetPendingPlaybookDrafts.mockReturnValue([]);
    mockGetPendingProposals.mockReturnValue([]);
    mockReadRecentMutations.mockReturnValue([]);
    mockGetProjectSummaries.mockReturnValue([]);
    mockListOps.mockReturnValue([]);
    // Default: no files exist
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  it('returns version 1 snapshot with ready: true', () => {
    const snap = getStateSnapshot();
    expect(snap.version).toBe(1);
    expect(snap.ready).toBe(true);
  });

  it('returns null activeSession when no session exists', () => {
    const snap = getStateSnapshot();
    expect(snap.activeSession).toBeNull();
  });

  it('maps active session to { sessionId, model, messageCount }', () => {
    mockGetSession.mockReturnValue(makeSession());
    const snap = getStateSnapshot();
    expect(snap.activeSession).toEqual({
      sessionId: 'sess-1',
      model: 'claude-opus-4-7',
      messageCount: 5,
    });
  });

  it('returns null activeReview when no review session exists', () => {
    expect(getStateSnapshot().activeReview).toBeNull();
  });

  it('maps active review to { type, phase, targetDate }', () => {
    mockGetActiveReviewSession.mockReturnValue(makeReview());
    const snap = getStateSnapshot();
    expect(snap.activeReview).toEqual({
      type: 'weekly',
      phase: 'interview',
      targetDate: '2026-05-05',
    });
  });

  it('returns 0 ingestionQueueDepth when queue is empty', () => {
    expect(getStateSnapshot().ingestionQueueDepth).toBe(0);
  });

  it('reflects ingestion queue depth from getQueue()', () => {
    mockGetQueue.mockReturnValue([
      { source: 'journals/a.md', addedAt: '' },
      { source: 'journals/b.md', addedAt: '' },
      { source: 'journals/c.md', addedAt: '' },
    ]);
    expect(getStateSnapshot().ingestionQueueDepth).toBe(3);
  });

  it('returns [] recentAgentRuns when agent-runs.jsonl is absent', () => {
    expect(getStateSnapshot().recentAgentRuns).toEqual([]);
  });

  it('parses agent-runs.jsonl and returns last 10 in reverse-chron order', () => {
    // Write 12 entries; only the last 10 should appear, newest first
    const lines = makeAgentRunLines(12);
    mockReadFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('agent-runs.jsonl')) return lines;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const snap = getStateSnapshot();
    expect(snap.recentAgentRuns).toHaveLength(10);
    // Newest first: the last written entry (index 11) should be first
    expect(snap.recentAgentRuns[0]!.agent).toBe('agent-11');
    expect(snap.recentAgentRuns[9]!.agent).toBe('agent-2');
  });

  it('skips malformed lines in agent-runs.jsonl and records a warning', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('agent-runs.jsonl')) {
        return '{"agent":"ok","startedAt":"2026-05-05T00:00:00.000Z","durationMs":100,"status":"success"}\nbad-json{\n';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const snap = getStateSnapshot();
    expect(snap.recentAgentRuns).toHaveLength(1);
    expect(snap.warnings.some(w => w.includes('agent-runs.jsonl'))).toBe(true);
  });

  it('returns null lastMorningPrepAt when scheduler-state.json is absent', () => {
    expect(getStateSnapshot().lastMorningPrepAt).toBeNull();
  });

  it('returns ISO timestamps from scheduler-state.json', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('scheduler-state.json')) return makeSchedulerState();
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const snap = getStateSnapshot();
    expect(snap.lastMorningPrepAt).toBe(new Date(1746000000000).toISOString());
    expect(snap.lastNightlyAt).toBe(new Date(1746003600000).toISOString());
  });

  it('returns { playbook: 0, proposal: 0 } when no pending approvals', () => {
    expect(getStateSnapshot().pendingApprovals).toEqual({ playbook: 0, proposal: 0 });
  });

  it('counts pending playbook drafts and proposals', () => {
    mockGetPendingPlaybookDrafts.mockReturnValue([{}, {}]);
    mockGetPendingProposals.mockReturnValue([{}]);
    const snap = getStateSnapshot();
    expect(snap.pendingApprovals).toEqual({ playbook: 2, proposal: 1 });
  });

  it('includes a warning when getPendingPlaybookDrafts throws', () => {
    mockGetPendingPlaybookDrafts.mockImplementation(() => { throw new Error('playbook boom'); });
    const snap = getStateSnapshot();
    expect(snap.pendingApprovals.playbook).toBe(0);
    expect(snap.warnings).toContain('playbook-queue: read error');
  });

  it('includes a warning when getPendingProposals throws', () => {
    mockGetPendingProposals.mockImplementation(() => { throw new Error('proposal boom'); });
    const snap = getStateSnapshot();
    expect(snap.pendingApprovals.proposal).toBe(0);
    expect(snap.warnings).toContain('proposal-queue: read error');
  });

  it('returns empty warnings array on a clean run', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (String(path).endsWith('scheduler-state.json')) return makeSchedulerState();
      if (String(path).endsWith('agent-runs.jsonl')) return makeAgentRunLines(3);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const snap = getStateSnapshot();
    expect(snap.warnings).toEqual([]);
  });

  describe('inFlight field', () => {
    it('returns an empty inFlight array when no ops are active', () => {
      mockListOps.mockReturnValue([]);
      const snap = getStateSnapshot();
      expect(snap.inFlight).toEqual([]);
    });

    it('returns in-flight ops from listOps()', () => {
      const ops = [
        {
          opId: 'aaa-111',
          kind: 'agent' as const,
          label: 'wiki-compiler',
          userId: 42,
          startedAt: '2026-05-14T12:00:00.000Z',
          elapsedMs: 3500,
        },
        {
          opId: 'bbb-222',
          kind: 'one-shot' as const,
          label: 'one-shot',
          userId: 42,
          startedAt: '2026-05-14T12:00:05.000Z',
          elapsedMs: 500,
        },
      ];
      mockListOps.mockReturnValue(ops);
      const snap = getStateSnapshot();
      expect(snap.inFlight).toHaveLength(2);
      expect(snap.inFlight[0]!.opId).toBe('aaa-111');
      expect(snap.inFlight[1]!.label).toBe('one-shot');
    });

    it('passes through all public fields from listOps', () => {
      const op = {
        opId: 'ccc-333',
        kind: 'chat' as const,
        label: 'chat',
        agentName: undefined,
        userId: 42,
        startedAt: '2026-05-14T12:01:00.000Z',
        elapsedMs: 1000,
      };
      mockListOps.mockReturnValue([op]);
      const snap = getStateSnapshot();
      expect(snap.inFlight[0]).toMatchObject({
        opId: 'ccc-333',
        kind: 'chat',
        label: 'chat',
        elapsedMs: 1000,
      });
    });
  });
});
