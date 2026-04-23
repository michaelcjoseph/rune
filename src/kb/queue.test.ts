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

const { enqueue, getQueue, dequeue, clearQueue, getPriority } = await import('./queue.js');

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

describe('getPriority', () => {
  it('gives world-view/* top priority', () => {
    expect(getPriority('world-view/ai.md')).toBe(100);
    expect(getPriority('world-view/crypto.md')).toBe(100);
  });

  it('gives journals/* top priority alongside world-view', () => {
    expect(getPriority('journals/2026_04_22.md')).toBe(100);
  });

  it('gives pages/playbook.md the second tier', () => {
    expect(getPriority('pages/playbook.md')).toBe(80);
  });

  it('gives projects/* the third tier (excluding archive)', () => {
    expect(getPriority('projects/my-project.md')).toBe(60);
  });

  it('excludes archived projects from the projects tier', () => {
    expect(getPriority('projects/archive/old.md')).toBe(0);
  });

  it('gives Readwise a mid-low tier', () => {
    expect(getPriority('Readwise/article.md')).toBe(40);
  });

  it('matches conversation anywhere in path at lowest non-fallback tier', () => {
    expect(getPriority('captures/2026-04-22-conversation.md')).toBe(20);
    expect(getPriority('knowledge/raw/conversations/foo.md')).toBe(20);
  });

  it('falls back to 0 for unrecognized paths', () => {
    expect(getPriority('notes/scratch.md')).toBe(0);
    expect(getPriority('anything-else.md')).toBe(0);
  });
});

describe('enqueue: priority', () => {
  beforeEach(() => {
    writeFileSync(queueFile, '[]');
  });

  it('stores derived priority on new entries', () => {
    enqueue('world-view/ai.md');
    enqueue('Readwise/article.md');
    enqueue('notes/scratch.md');
    const q = getQueue();
    expect(q.find(e => e.source === 'world-view/ai.md')!.priority).toBe(100);
    expect(q.find(e => e.source === 'Readwise/article.md')!.priority).toBe(40);
    expect(q.find(e => e.source === 'notes/scratch.md')!.priority).toBe(0);
  });
});
