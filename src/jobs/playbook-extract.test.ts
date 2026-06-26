import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `rune-playbook-test-${Date.now()}`);
const queueFile = join(tmpDir, 'playbook-queue.json');
mkdirSync(tmpDir, { recursive: true });

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/test/vault',
    TIMEZONE: 'America/Chicago',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 123,
    LOGS_DIR: tmpDir,
    get PLAYBOOK_QUEUE_FILE() { return queueFile; },
  },
}));

vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn() }));
vi.mock('../vault/files.js', () => ({ readVaultFile: vi.fn() }));
vi.mock('../utils/time.js', () => ({
  getTodayFilename: () => '2026_04_21.md',
  getTodayDate: () => '2026-04-21',
}));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

const { runAgent } = await import('../ai/claude.js');
const { readVaultFile } = await import('../vault/files.js');
const {
  getPendingPlaybookDrafts,
  clearApprovedPlaybookDrafts,
  extractPlaybookDrafts,
} = await import('./playbook-extract.js');

const agentMock = runAgent as unknown as ReturnType<typeof vi.fn>;
const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;

function writeQueueFile(entries: unknown[]) {
  writeFileSync(queueFile, JSON.stringify(entries, null, 2));
}

beforeEach(() => {
  vi.clearAllMocks();
  if (existsSync(queueFile)) unlinkSync(queueFile);
});

describe('getPendingPlaybookDrafts', () => {
  it('returns empty array when queue file does not exist', () => {
    expect(getPendingPlaybookDrafts()).toEqual([]);
  });

  it('returns only pending entries', () => {
    writeQueueFile([
      { slug: 'a', date: '2026-04-20', status: 'pending', domain: 'Health', entryMarkdown: '- A', draftedAt: '', sourceJournal: '' },
      { slug: 'b', date: '2026-04-20', status: 'approved', domain: 'Work', entryMarkdown: '- B', draftedAt: '', sourceJournal: '' },
      { slug: 'c', date: '2026-04-20', status: 'rejected', domain: 'Work', entryMarkdown: '- C', draftedAt: '', sourceJournal: '' },
    ]);
    const drafts = getPendingPlaybookDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.slug).toBe('a');
  });

  it('returns all entries when all are pending', () => {
    writeQueueFile([
      { slug: 'x', date: '2026-04-20', status: 'pending', domain: 'D', entryMarkdown: '- X', draftedAt: '', sourceJournal: '' },
      { slug: 'y', date: '2026-04-20', status: 'pending', domain: 'D', entryMarkdown: '- Y', draftedAt: '', sourceJournal: '' },
    ]);
    expect(getPendingPlaybookDrafts()).toHaveLength(2);
  });
});

describe('clearApprovedPlaybookDrafts', () => {
  it('removes approved and rejected entries, keeps pending', () => {
    writeQueueFile([
      { slug: 'a', date: '2026-04-20', status: 'pending', domain: 'D', entryMarkdown: '- A', draftedAt: '', sourceJournal: '' },
      { slug: 'b', date: '2026-04-20', status: 'approved', domain: 'D', entryMarkdown: '- B', draftedAt: '', sourceJournal: '' },
      { slug: 'c', date: '2026-04-20', status: 'rejected', domain: 'D', entryMarkdown: '- C', draftedAt: '', sourceJournal: '' },
    ]);
    clearApprovedPlaybookDrafts();
    const remaining = JSON.parse(readFileSync(queueFile, 'utf8'));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].slug).toBe('a');
    expect(remaining[0].status).toBe('pending');
  });

  it('writes an empty array when all entries are approved/rejected', () => {
    writeQueueFile([
      { slug: 'a', date: '2026-04-20', status: 'approved', domain: 'D', entryMarkdown: '', draftedAt: '', sourceJournal: '' },
    ]);
    clearApprovedPlaybookDrafts();
    const remaining = JSON.parse(readFileSync(queueFile, 'utf8'));
    expect(remaining).toEqual([]);
  });

  it('leaves queue unchanged when all entries are already pending', () => {
    writeQueueFile([
      { slug: 'a', date: '2026-04-20', status: 'pending', domain: 'D', entryMarkdown: '- A', draftedAt: '', sourceJournal: '' },
    ]);
    clearApprovedPlaybookDrafts();
    const remaining = JSON.parse(readFileSync(queueFile, 'utf8'));
    expect(remaining).toHaveLength(1);
  });
});

describe('extractPlaybookDrafts', () => {
  it('returns skipped when journal has no content', async () => {
    readMock.mockReturnValue(null);
    const result = await extractPlaybookDrafts();
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('No journal');
  });

  it('returns skipped when journal has no #playbook tag', async () => {
    readMock.mockReturnValue('Had a great day. No special tags.');
    const result = await extractPlaybookDrafts();
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('#playbook');
  });

  it('returns error when agent fails', async () => {
    readMock.mockReturnValue('Today I learned #playbook about error handling.');
    agentMock.mockResolvedValue({ text: null, error: 'agent crashed' });
    const result = await extractPlaybookDrafts();
    expect(result.status).toBe('error');
    expect(result.detail).toContain('agent crashed');
  });

  it('returns skipped when proposer returns empty array', async () => {
    readMock.mockReturnValue('Today I learned #playbook about something.');
    agentMock.mockResolvedValue({ text: '[]', error: null });
    const result = await extractPlaybookDrafts();
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('no drafts');
  });

  it('writes new drafts to queue and returns success', async () => {
    readMock.mockReturnValue('Today I learned #playbook about error handling.');
    const draft = {
      draftedAt: '2026-04-21T10:00:00Z',
      sourceJournal: '2026_04_21',
      domain: 'Engineering',
      slug: 'handle-errors-early',
      date: '2026-04-21',
      entryMarkdown: '- Always handle errors early.',
    };
    agentMock.mockResolvedValue({ text: JSON.stringify([draft]), error: null });

    const result = await extractPlaybookDrafts();
    expect(result.status).toBe('success');
    expect(result.detail).toContain('1');

    const queue = JSON.parse(readFileSync(queueFile, 'utf8'));
    expect(queue).toHaveLength(1);
    expect(queue[0].slug).toBe('handle-errors-early');
    expect(queue[0].status).toBe('pending');
  });

  it('deduplicates — does not re-add a draft with same slug+date already in queue', async () => {
    const existingDraft = {
      draftedAt: '2026-04-20T09:00:00Z',
      sourceJournal: '2026_04_20',
      domain: 'Engineering',
      slug: 'handle-errors-early',
      date: '2026-04-21',
      entryMarkdown: '- Existing entry.',
      status: 'pending',
    };
    writeQueueFile([existingDraft]);

    readMock.mockReturnValue('Today I learned #playbook about error handling.');
    const duplicateDraft = {
      draftedAt: '2026-04-21T10:00:00Z',
      sourceJournal: '2026_04_21',
      domain: 'Engineering',
      slug: 'handle-errors-early',
      date: '2026-04-21',
      entryMarkdown: '- Duplicate entry.',
    };
    agentMock.mockResolvedValue({ text: JSON.stringify([duplicateDraft]), error: null });

    const result = await extractPlaybookDrafts();
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('already in queue');

    const queue = JSON.parse(readFileSync(queueFile, 'utf8'));
    expect(queue).toHaveLength(1);
    expect(queue[0].entryMarkdown).toBe('- Existing entry.');
  });

  it('adds only new drafts when queue has one existing and one new slug', async () => {
    const existingDraft = {
      draftedAt: '2026-04-20T09:00:00Z',
      sourceJournal: '2026_04_20',
      domain: 'Engineering',
      slug: 'existing-slug',
      date: '2026-04-20',
      entryMarkdown: '- Old entry.',
      status: 'pending',
    };
    writeQueueFile([existingDraft]);

    readMock.mockReturnValue('Today I learned #playbook about two things.');
    const drafts = [
      {
        slug: 'existing-slug',
        date: '2026-04-20',
        domain: 'Engineering',
        entryMarkdown: '- Duplicate.',
        draftedAt: '',
        sourceJournal: '',
      },
      {
        slug: 'new-slug',
        date: '2026-04-21',
        domain: 'Engineering',
        entryMarkdown: '- New entry.',
        draftedAt: '',
        sourceJournal: '',
      },
    ];
    agentMock.mockResolvedValue({ text: JSON.stringify(drafts), error: null });

    const result = await extractPlaybookDrafts();
    expect(result.status).toBe('success');

    const queue = JSON.parse(readFileSync(queueFile, 'utf8'));
    expect(queue).toHaveLength(2);
    expect(queue.map((d: { slug: string }) => d.slug)).toContain('new-slug');
    expect(queue.map((d: { slug: string }) => d.slug)).toContain('existing-slug');
  });

  it('wraps agent output in code fences and still parses correctly', async () => {
    readMock.mockReturnValue('Today #playbook learning.');
    const draft = {
      slug: 'fenced-slug',
      date: '2026-04-21',
      domain: 'Other',
      entryMarkdown: '- Fenced.',
      draftedAt: '',
      sourceJournal: '',
    };
    agentMock.mockResolvedValue({ text: `\`\`\`json\n${JSON.stringify([draft])}\n\`\`\``, error: null });

    const result = await extractPlaybookDrafts();
    expect(result.status).toBe('success');
  });
});
