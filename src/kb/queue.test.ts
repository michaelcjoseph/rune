import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `jarvis-test-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });
const queueFile = join(tmpDir, 'kb-ingestion-queue.json');

vi.mock('../config.js', () => ({
  default: {
    INGESTION_QUEUE_FILE: queueFile,
    LOGS_DIR: tmpDir,
    TIMEZONE: 'America/Chicago',
  },
}));

const { enqueue, getQueue, dequeue, clearQueue } = await import('./queue.js');

describe('kb queue', () => {
  beforeEach(() => {
    // Reset queue file
    writeFileSync(queueFile, '[]');
  });

  it('starts with empty queue', () => {
    expect(getQueue()).toEqual([]);
  });

  it('enqueue adds a source', () => {
    enqueue('raw/test.md');
    const q = getQueue();
    expect(q).toHaveLength(1);
    expect(q[0]!.source).toBe('raw/test.md');
    expect(q[0]!.addedAt).toBeDefined();
  });

  it('enqueue prevents duplicates', () => {
    enqueue('raw/test.md');
    enqueue('raw/test.md');
    expect(getQueue()).toHaveLength(1);
  });

  it('enqueue stores guidance when provided', () => {
    enqueue('raw/test.md', 'focus on API details');
    expect(getQueue()[0]!.guidance).toBe('focus on API details');
  });

  it('dequeue removes a specific source', () => {
    enqueue('raw/a.md');
    enqueue('raw/b.md');
    dequeue('raw/a.md');
    const q = getQueue();
    expect(q).toHaveLength(1);
    expect(q[0]!.source).toBe('raw/b.md');
  });

  it('clearQueue empties everything', () => {
    enqueue('raw/a.md');
    enqueue('raw/b.md');
    clearQueue();
    expect(getQueue()).toEqual([]);
  });
});
