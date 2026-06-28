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

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('../config.js', () => ({
  default: {
    LOGS_DIR: '/test/logs',
    WORK_RUNS_DIR: '/test/work-runs',
  },
}));

// --- Dynamic imports after mocks ---

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const { appendMutationLine, readRecentMutations, reconcileOrphans } = await import('./mutations-log.js');

// --- Helpers ---

function makeDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-id-1',
    kind: 'work-run',
    source: 'webview',
    target: { type: 'work-run', ref: 'my-project' },
    preview: { summary: 'work-run on my-project' },
    payload: { projectSlug: 'my-project' },
    createdAt: '2026-05-05T12:00:00.000Z',
    status: 'pending',
    ...overrides,
  } as any;
}

// --- Tests ---

describe('mutations-log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('appendMutationLine', () => {
    it('writes a JSON line to the mutations log file', () => {
      const descriptor = makeDescriptor();
      appendMutationLine(descriptor);

      expect(appendFileSync).toHaveBeenCalledOnce();
      const [path, content, encoding] = (appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(path).toContain('mutations.jsonl');
      expect(path).toContain('/test/logs');
      expect(content).toBe(JSON.stringify(descriptor) + '\n');
      expect(encoding).toBe('utf8');
    });

    it('does not throw when appendFileSync throws (swallows error)', () => {
      (appendFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('disk full');
      });
      const descriptor = makeDescriptor();
      expect(() => appendMutationLine(descriptor)).not.toThrow();
    });
  });

  describe('readRecentMutations', () => {
    it('returns empty array when the file does not exist', () => {
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const result = readRecentMutations(10);
      expect(result).toEqual([]);
    });

    it('returns only terminal entries (completed, failed, rejected)', () => {
      const completed = makeDescriptor({ id: '1', status: 'completed' });
      const failed = makeDescriptor({ id: '2', status: 'failed' });
      const rejected = makeDescriptor({ id: '3', status: 'rejected' });
      const pending = makeDescriptor({ id: '4', status: 'pending' });
      const running = makeDescriptor({ id: '5', status: 'running' });

      const lines = [completed, failed, rejected, pending, running]
        .map(d => JSON.stringify(d))
        .join('\n') + '\n';

      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(lines);

      const result = readRecentMutations(10);
      const ids = result.map(d => d.id);
      expect(ids).toContain('1');
      expect(ids).toContain('2');
      expect(ids).toContain('3');
      expect(ids).not.toContain('4');
      expect(ids).not.toContain('5');
    });

    it('returns entries in newest-first order (last written = first returned)', () => {
      const older = makeDescriptor({ id: 'older', status: 'completed', createdAt: '2026-05-01T00:00:00.000Z' });
      const newer = makeDescriptor({ id: 'newer', status: 'completed', createdAt: '2026-05-05T00:00:00.000Z' });

      // older is written first (line 1), newer second (line 2)
      const lines = [older, newer].map(d => JSON.stringify(d)).join('\n') + '\n';
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(lines);

      const result = readRecentMutations(10);
      // reverse() means the last written entry comes first
      expect(result[0]!.id).toBe('newer');
      expect(result[1]!.id).toBe('older');
    });

    it('respects the n limit — returns at most n terminal entries', () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeDescriptor({ id: `e${i}`, status: 'completed' }),
      );
      const lines = entries.map(d => JSON.stringify(d)).join('\n') + '\n';
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(lines);

      const result = readRecentMutations(3);
      expect(result).toHaveLength(3);
    });

    it('skips malformed lines without throwing', () => {
      const good = makeDescriptor({ id: 'good', status: 'completed' });
      const lines = [
        JSON.stringify(good),
        'not-json{{{',
        JSON.stringify(makeDescriptor({ id: 'good2', status: 'completed' })),
      ].join('\n') + '\n';

      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(lines);

      let result: ReturnType<typeof readRecentMutations>;
      expect(() => {
        result = readRecentMutations(10);
      }).not.toThrow();
      expect(result!.length).toBe(2);
    });

    it('returns empty array when file has only non-terminal entries', () => {
      const running = makeDescriptor({ id: 'r', status: 'running' });
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(running) + '\n');

      const result = readRecentMutations(10);
      expect(result).toEqual([]);
    });
  });

  describe('reconcileOrphans', () => {
    it('is a no-op when the file does not exist', () => {
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(() => reconcileOrphans()).not.toThrow();
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('rewrites running entries to failed with error "orphaned"', () => {
      const running = makeDescriptor({ id: 'run1', status: 'running' });
      const completed = makeDescriptor({ id: 'comp1', status: 'completed' });

      const raw = [running, completed].map(d => JSON.stringify(d)).join('\n') + '\n';
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(raw);

      reconcileOrphans();

      expect(writeFileSync).toHaveBeenCalledOnce();
      const [, writtenContent] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const lines = writtenContent.split('\n').filter(Boolean);
      const updatedRunning = JSON.parse(lines[0]!);
      const untouchedCompleted = JSON.parse(lines[1]!);

      expect(updatedRunning.id).toBe('run1');
      expect(updatedRunning.status).toBe('failed');
      expect(updatedRunning.error).toBe('orphaned');

      expect(untouchedCompleted.id).toBe('comp1');
      expect(untouchedCompleted.status).toBe('completed');
    });

    it('reconciles running orchestrated-work entries instead of exempting them', () => {
      const terminalOrchestrated = makeDescriptor({
        id: 'orch-terminal-1',
        kind: 'orchestrated-work',
        status: 'running',
        payload: { projectSlug: '14-product-team-agents', product: 'rune' },
      });
      const staleOrchestrated = makeDescriptor({
        id: 'orch-stale-1',
        kind: 'orchestrated-work',
        status: 'running',
        payload: { projectSlug: 'stale-run', product: 'rune' },
      });
      const legacyRunning = makeDescriptor({ id: 'legacy-run-1', status: 'running' });

      const raw = [terminalOrchestrated, staleOrchestrated, legacyRunning].map(d => JSON.stringify(d)).join('\n') + '\n';
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (path.includes('mutations.jsonl')) return raw;
        if (path.includes('/test/work-runs/orch-terminal-1/summary.json')) {
          return JSON.stringify({
            id: 'orch-terminal-1',
            outcome: 'noop',
            reason: 'terminal work product already persisted',
            workProduct: {
              commitCount: 0,
              commitShas: [],
              filesChanged: [],
              diffstat: '',
              dirty: false,
              untracked: false,
              transitions: {
                tasksNewlyChecked: 0,
                tasksRemaining: 0,
                tasksAdded: 0,
                tasksRemoved: 0,
              },
            },
          });
        }
        throw new Error('ENOENT');
      });

      reconcileOrphans();

      expect(writeFileSync).toHaveBeenCalledOnce();
      const [, writtenContent] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const lines = writtenContent.split('\n').filter(Boolean);
      const terminalizedOrchestrated = JSON.parse(lines[0]!);
      const orphanedOrchestrated = JSON.parse(lines[1]!);
      const terminalizedLegacy = JSON.parse(lines[2]!);

      expect(terminalizedOrchestrated.id).toBe('orch-terminal-1');
      expect(terminalizedOrchestrated.kind).toBe('orchestrated-work');
      expect(terminalizedOrchestrated.status).toBe('completed');
      expect(terminalizedOrchestrated.outcome).toBe('noop');
      expect(terminalizedOrchestrated.workProduct).toMatchObject({ commitCount: 0 });
      expect(terminalizedOrchestrated.error).toBeUndefined();

      expect(orphanedOrchestrated.id).toBe('orch-stale-1');
      expect(orphanedOrchestrated.kind).toBe('orchestrated-work');
      expect(orphanedOrchestrated.status).toBe('failed');
      expect(orphanedOrchestrated.error).toBe('orphaned');

      expect(terminalizedLegacy.id).toBe('legacy-run-1');
      expect(terminalizedLegacy.status).toBe('failed');
      expect(terminalizedLegacy.error).toBe('orphaned');
    });

    it('does not rewrite a mutation whose latest persisted state is already terminal', () => {
      const historicalRunning = makeDescriptor({ id: 'already-terminal', status: 'running' });
      const terminal = makeDescriptor({ id: 'already-terminal', status: 'completed' });

      const raw = [historicalRunning, terminal].map(d => JSON.stringify(d)).join('\n') + '\n';
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(raw);

      reconcileOrphans();

      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('only terminalizes latest-state running mutations and preserves historical running lines', () => {
      const historicalRunning = makeDescriptor({ id: 'eventually-completed', status: 'running' });
      const terminal = makeDescriptor({ id: 'eventually-completed', status: 'completed' });
      const stillRunning = makeDescriptor({ id: 'actual-orphan', status: 'running' });

      const raw = [historicalRunning, terminal, stillRunning].map(d => JSON.stringify(d)).join('\n') + '\n';
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(raw);

      reconcileOrphans();

      expect(writeFileSync).toHaveBeenCalledOnce();
      const [, writtenContent] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const lines = writtenContent.split('\n').filter(Boolean).map((line: string) => JSON.parse(line));

      expect(lines[0]).toMatchObject({ id: 'eventually-completed', status: 'running' });
      expect(lines[0].error).toBeUndefined();
      expect(lines[1]).toMatchObject({ id: 'eventually-completed', status: 'completed' });
      expect(lines[2]).toMatchObject({ id: 'actual-orphan', status: 'failed', error: 'orphaned' });
    });

    it('does not rewrite when no running entries exist', () => {
      const completed = makeDescriptor({ id: 'c1', status: 'completed' });
      const failed = makeDescriptor({ id: 'f1', status: 'failed' });

      const raw = [completed, failed].map(d => JSON.stringify(d)).join('\n') + '\n';
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(raw);

      reconcileOrphans();

      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('preserves malformed lines unchanged in the rewrite', () => {
      const running = makeDescriptor({ id: 'run1', status: 'running' });
      const raw = [JSON.stringify(running), 'malformed-line'].join('\n') + '\n';
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(raw);

      reconcileOrphans();

      expect(writeFileSync).toHaveBeenCalledOnce();
      const [, writtenContent] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(writtenContent).toContain('malformed-line');
    });
  });
});
