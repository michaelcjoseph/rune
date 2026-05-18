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

  it('falls back to synthesis (no silent drop) when ROUTE value is unknown', async () => {
    // An unknown route used to surface as "couldn't parse" and drop the photo.
    // Synthesis fallback now journals it instead — the prose still carries the
    // category signal ("food") and route defaults to journal. Recovery is
    // logged at warn level so prompt drift remains visible.
    const output = 'CLASSIFICATION: food\nROUTE: unknown-route\nTITLE: Foo\nDETAILS: Bar';
    vi.mocked(runAgent).mockResolvedValue({ text: output, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    expect(vi.mocked(appendToJournal)).toHaveBeenCalled();
    const replies = vi.mocked(sender.send).mock.calls.map(c => c[1] as string);
    expect(replies.some(r => r.includes("couldn't parse"))).toBe(false);
  });
});

// ── parseClassifyResult — real-world Sonnet outputs (regression fixtures) ──
//
// Verbatim agent payloads captured from a production photo-classification
// failure: Sonnet emitted markdown-wrapped prose instead of the strict
// `CLASSIFICATION:/ROUTE:/TITLE:/DETAILS:` line format the agent prompt
// teaches. The parser must recover these specific shapes (relaxed extractor
// + synthesis fallback). Don't paraphrase — any rewrite that loses the
// bytes loses the regression coverage.

const COOKIE_FIXTURE =
  '## Classification\n\n' +
  '**Type:** Food (chocolate chip cookie on a marble countertop)\n\n' +
  '**Caption tag:** `#diet`\n\n' +
  '## Recommended Routing\n\n' +
  'Append a `#diet` entry to `health/nutrition.md` for today (2026-05-12) noting a chocolate chip cookie. ' +
  'No JSON store update needed — `#diet` routes to the nutrition markdown log per CLAUDE.md.\n\n' +
  'Suggested log line:\n```\n- 2026-05-12 — chocolate chip cookie #diet\n```';

const CURRY_FIXTURE =
  '**Classification:** Food/meal photo — Panang curry with chicken, rice, carrots, broccoli, and yellow squash in a black bowl.\n\n' +
  '**Routing recommendation:** `#diet` tag → append to `health/nutrition.md` as a meal log entry for 2026-05-12. ' +
  'No JSON store update needed (diet entries are markdown, not structured).\n\n' +
  '**Suggested entry:**\n```\n- 2026-05-12: Panang curry — chicken, jasmine rice, carrots, broccoli, yellow squash\n```';

const BREAKFAST_FIXTURE =
  '**Classification: `#diet` — meal log**\n\n' +
  'Breakfast plate: egg omelet, turkey/beef sausage, sliced avocado, blackberries, whole grain toast.\n\n' +
  '**Route:** Append to `health/nutrition.md` as a diet entry.\n\n' +
  'Suggested log entry:\n```\n- 2026-05-18 breakfast: egg omelet, beef/turkey sausage, avocado, blackberries, whole grain toast\n```\n\n' +
  'Solid, protein-heavy breakfast. Healthy fats from the avocado, antioxidants from the blackberries.';

describe('parseClassifyResult — real-world Sonnet failures (recovered via synthesis)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubFetchOk();
  });

  it('recovers the chocolate-cookie failure (markdown-headered prose, no labeled fields)', async () => {
    vi.mocked(runAgent).mockResolvedValue({ text: COOKIE_FIXTURE, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg({ caption: '#diet' }));

    expect(vi.mocked(appendToJournal)).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendToJournal).mock.calls[0]![0] as string;
    expect(entry).toMatch(/chocolate chip cookie/i);
    // Caption tag must survive so nightly daily-tags routes the entry into
    // health/nutrition.md per the #diet rule.
    expect(entry).toContain('#diet');

    // No "couldn't parse" reply to user — the photo IS logged.
    const replies = vi.mocked(sender.send).mock.calls.map(c => c[1] as string);
    expect(replies.some(r => r.includes("couldn't parse"))).toBe(false);
  });

  it('recovers the Panang-curry failure (inline bold Classification label, no other labeled fields)', async () => {
    vi.mocked(runAgent).mockResolvedValue({ text: CURRY_FIXTURE, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg({ caption: '#diet' }));

    expect(vi.mocked(appendToJournal)).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendToJournal).mock.calls[0]![0] as string;
    expect(entry).toMatch(/Panang curry/i);
    expect(entry).toContain('#diet');

    const replies = vi.mocked(sender.send).mock.calls.map(c => c[1] as string);
    expect(replies.some(r => r.includes("couldn't parse"))).toBe(false);
  });

  it('recovers the breakfast-plate failure (caption tag in category slot, must map #diet → food)', async () => {
    // This one is the worst: Sonnet wrote `Classification: #diet` — the
    // caption tag in the *category* slot. The recovery must map #diet → food
    // and not treat "#diet" as the literal category, because `food` is what
    // the data-update tag mapping (or in this case the synthesizer)
    // understands.
    vi.mocked(runAgent).mockResolvedValue({ text: BREAKFAST_FIXTURE, error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg({ caption: '#diet' }));

    expect(vi.mocked(appendToJournal)).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendToJournal).mock.calls[0]![0] as string;
    expect(entry).toMatch(/breakfast|egg omelet|sausage/i);
    expect(entry).toContain('#diet');

    const replies = vi.mocked(sender.send).mock.calls.map(c => c[1] as string);
    expect(replies.some(r => r.includes("couldn't parse"))).toBe(false);
  });

  it('does not silently drop when the agent response has no extractable category signal', async () => {
    // The input contains no category keyword (no `food`/`book`/`other`/etc.)
    // and no `#tag` mention, so `synthesizeClassifyResult` returns null and
    // the handler sends the unparseable-reply path. The OR-assertion below
    // covers both behaviors so this test stays valid if synthesis later
    // learns to recover a wider set of inputs — but the contract that
    // matters today is: no silent drop. Either the photo gets journaled,
    // or the user is told the result couldn't be parsed.
    vi.mocked(runAgent).mockResolvedValue({ text: 'I cannot determine what this photo shows.', error: null });
    const sender = mockSender();
    await handlePhotoMessage(mockBot(), sender, photoMsg());
    const journaled = vi.mocked(appendToJournal).mock.calls.length > 0;
    const replies = vi.mocked(sender.send).mock.calls.map(c => c[1] as string);
    const unparseable = replies.some(r => r.includes("couldn't parse"));
    expect(journaled || unparseable).toBe(true);
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
