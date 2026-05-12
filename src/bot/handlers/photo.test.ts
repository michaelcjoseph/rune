import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

// --- mocks declared before any imports that trigger module evaluation ---

vi.mock('../../config.js', () => ({
  default: {
    TELEGRAM_USER_ID: 42,
    VAULT_DIR: '/test/vault',
    LOGS_DIR: '/test/logs',
    TIMEZONE: 'America/Chicago',
  },
}));

vi.mock('../../ai/claude.js', () => ({ runAgent: vi.fn() }));
vi.mock('../../vault/files.js', () => ({ writeVaultFile: vi.fn() }));
vi.mock('../../vault/journal.js', () => ({ appendToJournal: vi.fn() }));
vi.mock('../../kb/queue.js', () => ({ enqueue: vi.fn() }));
vi.mock('../../utils/time.js', () => ({ getTimestamp: vi.fn(() => '09:00') }));
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, writeFileSync: vi.fn(), mkdirSync: vi.fn(), unlinkSync: vi.fn() };
});

// Stub fetch globally so downloadPhoto doesn't hit the network
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// --- dynamic imports after mocks are registered ---

const { runAgent } = await import('../../ai/claude.js');
const { appendToJournal } = await import('../../vault/journal.js');
const { writeVaultFile } = await import('../../vault/files.js');
const { enqueue } = await import('../../kb/queue.js');
const { handlePhotoMessage } = await import('./photo.js');

// ── helpers ────────────────────────────────────────────────────────────────

function mockSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

function mockBot(fileLink = 'https://cdn.tg/photo.jpg'): any {
  return { getFileLink: vi.fn().mockResolvedValue(fileLink) };
}

/** Build a minimal Telegram message with a photo array. */
function photoMsg(overrides: { caption?: string; userId?: number; fileId?: string } = {}): any {
  const { caption, userId = 42, fileId = 'file_abc123' } = overrides;
  return {
    chat: { id: 100 },
    from: { id: userId },
    photo: [{ file_id: fileId, width: 100, height: 100 }],
    ...(caption !== undefined ? { caption } : {}),
  };
}

/** Make fetch return a successful binary response. */
function stubFetchOk(): void {
  fetchMock.mockResolvedValue({
    ok: true,
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
  });
}

/** Canonical clean agent output with no markdown noise. */
function cleanOutput({
  classification = 'food',
  route = 'journal',
  title = 'Chocolate chip cookie',
  details = 'Cookie on marble countertop.',
} = {}): string {
  return `CLASSIFICATION: ${classification}\nROUTE: ${route}\nTITLE: ${title}\nDETAILS: ${details}`;
}

// ── parseClassifyResult — pure function behaviour ──────────────────────────

describe('parseClassifyResult — markdown noise stripping', () => {
  // parseClassifyResult is private; we exercise it end-to-end via handlePhotoMessage
  // so that mocking stays at the boundary (runAgent output).

  beforeEach(() => {
    vi.clearAllMocks();
    stubFetchOk();
  });

  it('parses clean structured output', async () => {
    vi.mocked(runAgent).mockResolvedValue({ text: cleanOutput(), error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(appendToJournal)).toHaveBeenCalledWith(
      expect.stringContaining('Chocolate chip cookie'),
    );
  });

  it('strips code-fence lines (``` delimiters) before matching', async () => {
    const noisyOutput = [
      '```',
      'CLASSIFICATION: food',
      'ROUTE: journal',
      'TITLE: Cookie',
      'DETAILS: Cookie on countertop.',
      '```',
    ].join('\n');
    vi.mocked(runAgent).mockResolvedValue({ text: noisyOutput, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(appendToJournal)).toHaveBeenCalledWith(expect.stringContaining('Cookie'));
  });

  it('strips markdown header lines (## Classification) before matching', async () => {
    const noisyOutput = [
      '## Classification',
      'CLASSIFICATION: food',
      '## Recommended Routing',
      'ROUTE: journal',
      'TITLE: Cookie',
      'DETAILS: Cookie on countertop.',
    ].join('\n');
    vi.mocked(runAgent).mockResolvedValue({ text: noisyOutput, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(appendToJournal)).toHaveBeenCalledWith(expect.stringContaining('Cookie'));
  });

  it('strips bold-label lines (**Type:** …) before matching', async () => {
    const noisyOutput = [
      '**Type:** Food',
      'CLASSIFICATION: food',
      '**Route:**',
      'ROUTE: journal',
      'TITLE: Cookie',
      'DETAILS: Cookie on countertop.',
    ].join('\n');
    vi.mocked(runAgent).mockResolvedValue({ text: noisyOutput, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(appendToJournal)).toHaveBeenCalledWith(expect.stringContaining('Cookie'));
  });

  it('strips combined markdown noise (headers + fences + bold) before matching', async () => {
    const noisyOutput = [
      '## Classification',
      '```',
      '**Type:** food',
      'CLASSIFICATION: receipt',
      'ROUTE: data-update',
      'TITLE: Grocery run',
      'DETAILS: Whole Foods receipt.',
      '```',
    ].join('\n');
    vi.mocked(runAgent).mockResolvedValue({ text: noisyOutput, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    // data-update route — should journal with #receipt tag
    expect(vi.mocked(appendToJournal)).toHaveBeenCalledWith(
      expect.stringContaining('#receipt'),
    );
  });

  it('returns null (unparseable reply sent to user) when all four fields are missing', async () => {
    vi.mocked(runAgent).mockResolvedValue({ text: 'Sorry, I cannot classify this.', error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(sender.send)).toHaveBeenCalledWith(
      100,
      expect.stringContaining("couldn't parse result"),
    );
    expect(vi.mocked(appendToJournal)).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from field values', async () => {
    const output = 'CLASSIFICATION:  food  \nROUTE:  journal  \nTITLE:  My Food  \nDETAILS:  Some details  ';
    vi.mocked(runAgent).mockResolvedValue({ text: output, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(appendToJournal)).toHaveBeenCalledWith(expect.stringContaining('My Food'));
  });

  it('rejects an unknown route value', async () => {
    const output = 'CLASSIFICATION: food\nROUTE: unknown-route\nTITLE: Foo\nDETAILS: Bar';
    vi.mocked(runAgent).mockResolvedValue({ text: output, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(sender.send)).toHaveBeenCalledWith(
      100,
      expect.stringContaining("couldn't parse result"),
    );
  });
});

// ── extractCaptionTag — caption tag extraction ─────────────────────────────

describe('extractCaptionTag — caption #tag parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubFetchOk();
    vi.mocked(runAgent).mockResolvedValue({ text: cleanOutput(), error: null });
  });

  it('extracts the first hashtag from the caption', async () => {
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg({ caption: 'Lunch #diet today' }));
    expect(vi.mocked(appendToJournal)).toHaveBeenCalledWith(
      expect.stringContaining('#diet'),
    );
  });

  it('returns null (no prefix) when caption has no hashtag', async () => {
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg({ caption: 'Just a plain caption' }));
    const journalArg: string = vi.mocked(appendToJournal).mock.calls[0]![0];
    // Should NOT contain a hashtag prefix before the title
    expect(journalArg).not.toMatch(/#\w+ Chocolate chip cookie/);
  });

  it('returns null when caption is empty', async () => {
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg({ caption: '' }));
    const journalArg: string = vi.mocked(appendToJournal).mock.calls[0]![0];
    expect(journalArg).not.toMatch(/#\w+ Chocolate chip cookie/);
  });

  it('handles caption with no photo message (no caption property)', async () => {
    // photoMsg() with no caption key — caption defaults to ''
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    const journalArg: string = vi.mocked(appendToJournal).mock.calls[0]![0];
    expect(journalArg).toContain('Chocolate chip cookie');
  });
});

// ── route: journal ─────────────────────────────────────────────────────────

describe('route: journal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubFetchOk();
  });

  it('appends to journal with timestamp and title', async () => {
    vi.mocked(runAgent).mockResolvedValue({ text: cleanOutput(), error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(appendToJournal)).toHaveBeenCalledWith(
      expect.stringMatching(/^- 09:00 Chocolate chip cookie/),
    );
  });

  it('prepends caption tag to title when caption has a hashtag', async () => {
    vi.mocked(runAgent).mockResolvedValue({ text: cleanOutput(), error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg({ caption: 'Dinner #diet' }));
    const journalArg: string = vi.mocked(appendToJournal).mock.calls[0]![0];
    expect(journalArg).toContain('#diet Chocolate chip cookie');
  });

  it('includes caption tag in the confirmation message', async () => {
    vi.mocked(runAgent).mockResolvedValue({ text: cleanOutput(), error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg({ caption: 'Food #diet' }));
    expect(vi.mocked(sender.send)).toHaveBeenCalledWith(
      100,
      expect.stringContaining('with #diet'),
    );
  });

  it('omits "with #tag" from confirmation when no caption tag', async () => {
    vi.mocked(runAgent).mockResolvedValue({ text: cleanOutput(), error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    const msg: string = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(msg).toContain('Logged to journal:');
    expect(msg).not.toContain('with #');
  });

  it('does not call enqueue or writeVaultFile for journal route', async () => {
    vi.mocked(runAgent).mockResolvedValue({ text: cleanOutput(), error: null });
    await handlePhotoMessage(mockBot(), mockSender(), photoMsg());
    expect(vi.mocked(enqueue)).not.toHaveBeenCalled();
    expect(vi.mocked(writeVaultFile)).not.toHaveBeenCalled();
  });
});

// ── route: data-update ─────────────────────────────────────────────────────

describe('route: data-update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubFetchOk();
  });

  it('uses #books tag for book classification', async () => {
    const output = cleanOutput({ classification: 'book', route: 'data-update', title: 'Atomic Habits', details: 'Book cover.' });
    vi.mocked(runAgent).mockResolvedValue({ text: output, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(appendToJournal)).toHaveBeenCalledWith(
      expect.stringContaining('#books Atomic Habits'),
    );
  });

  it('uses #receipt tag for receipt classification', async () => {
    const output = cleanOutput({ classification: 'receipt', route: 'data-update', title: 'Whole Foods', details: '$42.10.' });
    vi.mocked(runAgent).mockResolvedValue({ text: output, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(appendToJournal)).toHaveBeenCalledWith(
      expect.stringContaining('#receipt Whole Foods'),
    );
  });

  it('uses #<classification> as fallback tag for unknown classifications', async () => {
    const output = cleanOutput({ classification: 'workout', route: 'data-update', title: 'Gym session', details: 'Bench press.' });
    vi.mocked(runAgent).mockResolvedValue({ text: output, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(appendToJournal)).toHaveBeenCalledWith(
      expect.stringContaining('#workout Gym session'),
    );
  });

  it('caption tag supplements the classification-derived tag without replacing it', async () => {
    const output = cleanOutput({ classification: 'book', route: 'data-update', title: 'Some Book', details: 'Cover.' });
    vi.mocked(runAgent).mockResolvedValue({ text: output, error: null });
    const sender = mockSender();
    // Caption supplies #reading; #books must be preserved for nightly routing, #reading is appended.
    await handlePhotoMessage(mockBot(), sender, photoMsg({ caption: '#reading' }));
    const journalArg: string = vi.mocked(appendToJournal).mock.calls[0]![0];
    expect(journalArg).toContain('#books');
    expect(journalArg).toContain('#reading');
  });

  it('sends confirmation mentioning the nightly tag review', async () => {
    const output = cleanOutput({ classification: 'receipt', route: 'data-update', title: 'Frontera', details: '$47.50.' });
    vi.mocked(runAgent).mockResolvedValue({ text: output, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(sender.send)).toHaveBeenCalledWith(
      100,
      expect.stringContaining('nightly tag review'),
    );
  });
});

// ── route: kb-ingest ───────────────────────────────────────────────────────

describe('route: kb-ingest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubFetchOk();
  });

  it('writes a vault file and enqueues it', async () => {
    const output = cleanOutput({ classification: 'whiteboard', route: 'kb-ingest', title: 'Architecture diagram', details: 'Boxes and arrows.' });
    vi.mocked(runAgent).mockResolvedValue({ text: output, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg({ fileId: 'FILEID_999' }));
    expect(vi.mocked(writeVaultFile)).toHaveBeenCalledWith(
      expect.stringContaining('knowledge/raw/notes/'),
      expect.stringContaining('Architecture diagram'),
    );
    expect(vi.mocked(enqueue)).toHaveBeenCalled();
  });

  it('sends confirmation with /ingest hint', async () => {
    const output = cleanOutput({ classification: 'whiteboard', route: 'kb-ingest', title: 'Diagram', details: 'Details.' });
    vi.mocked(runAgent).mockResolvedValue({ text: output, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(sender.send)).toHaveBeenCalledWith(
      100,
      expect.stringContaining('/ingest'),
    );
  });
});

// ── route: skip ────────────────────────────────────────────────────────────

describe('route: skip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubFetchOk();
  });

  it('sends skip message and does not write to journal or vault', async () => {
    const output = cleanOutput({ classification: 'blurry', route: 'skip', title: 'Unknown', details: 'Photo is too blurry.' });
    vi.mocked(runAgent).mockResolvedValue({ text: output, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(sender.send)).toHaveBeenCalledWith(
      100,
      expect.stringContaining('Skipped'),
    );
    expect(vi.mocked(appendToJournal)).not.toHaveBeenCalled();
    expect(vi.mocked(writeVaultFile)).not.toHaveBeenCalled();
  });
});

// ── auth guard ─────────────────────────────────────────────────────────────

describe('auth guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignores messages from unauthorized users', async () => {
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg({ userId: 999 }));
    expect(vi.mocked(sender.send)).not.toHaveBeenCalled();
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });
});

// ── error handling ─────────────────────────────────────────────────────────

describe('error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubFetchOk();
  });

  it('reports classifier agent error to user', async () => {
    vi.mocked(runAgent).mockResolvedValue({ text: null, error: 'timeout' });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(sender.send)).toHaveBeenCalledWith(
      100,
      expect.stringContaining('Classification failed'),
    );
  });

  it('reports download failure to user', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(sender.send)).toHaveBeenCalledWith(
      100,
      expect.stringContaining('Error processing photo'),
    );
  });

  it('calls stopTyping even when an error is thrown', async () => {
    fetchMock.mockRejectedValue(new Error('network error'));
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(sender.stopTyping)).toHaveBeenCalledWith(100);
  });
});
