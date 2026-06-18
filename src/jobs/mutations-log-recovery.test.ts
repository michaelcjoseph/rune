import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MutationDescriptor } from '../transport/mutations.js';

const logsDir = vi.hoisted(() => `/tmp/mutations-log-recovery-${process.pid}-${Date.now()}`);

vi.mock('../config.js', () => ({
  default: {
    LOGS_DIR: logsDir,
  },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { readRunningOrchestratedMutations, reconcileOrphans } = await import('./mutations-log.js');

function descriptor(overrides: Partial<MutationDescriptor> = {}): MutationDescriptor {
  return {
    id: 'mut-1',
    kind: 'work-run',
    source: 'webview',
    target: { type: 'work-run', ref: 'demo' },
    preview: { summary: 'work-run on demo' },
    payload: { projectSlug: 'demo', product: 'jarvis' },
    createdAt: '2026-06-17T12:00:00.000Z',
    status: 'running',
    ...overrides,
  };
}

function writeLog(entries: MutationDescriptor[]): void {
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    join(logsDir, 'mutations.jsonl'),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );
}

afterAll(() => {
  rmSync(logsDir, { recursive: true, force: true });
});

describe('mutations-log orchestrated recovery interaction', () => {
  it('keeps running orchestrated-work discoverable after generic orphan reconciliation', () => {
    const orchestrated = descriptor({
      id: 'mut-orchestrated-running',
      kind: 'orchestrated-work',
      target: { type: 'orchestrated-work', ref: '14-product-team-agents' },
      preview: { summary: 'orchestrated-work on 14-product-team-agents' },
      payload: { projectSlug: '14-product-team-agents', product: 'jarvis' },
    });
    const legacy = descriptor({ id: 'mut-legacy-running' });

    writeLog([orchestrated, legacy]);

    reconcileOrphans();

    const raw = readFileSync(join(logsDir, 'mutations.jsonl'), 'utf8');
    const persisted = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as MutationDescriptor);
    expect(persisted.find((entry) => entry.id === orchestrated.id)?.status).toBe('running');
    expect(persisted.find((entry) => entry.id === legacy.id)?.status).toBe('failed');

    expect(readRunningOrchestratedMutations().map((entry) => entry.id)).toEqual([
      'mut-orchestrated-running',
    ]);
  });
});
