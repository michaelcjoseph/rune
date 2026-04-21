import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `jarvis-watcher-test-${Date.now()}`);

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: tmpDir,
    TIMEZONE: 'America/Chicago',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 42,
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

const mockEnqueue = vi.fn();
vi.mock('../kb/queue.js', () => ({
  enqueue: mockEnqueue,
}));

type WatchCallback = (event: string, filename: string | null) => void;
let capturedWatchCallback: WatchCallback | null = null;
const mockWatcherClose = vi.fn();
let mockedReaddirContents: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: vi.fn().mockReturnValue(true),
    readdirSync: vi.fn().mockImplementation(() => mockedReaddirContents),
    statSync: vi.fn().mockReturnValue({ size: 100 }),
    readFileSync: vi.fn().mockReturnValue(''),
    watch: vi.fn().mockImplementation((_dir: string, cb: WatchCallback) => {
      capturedWatchCallback = cb;
      return { close: mockWatcherClose };
    }),
  };
});

// All module imports at the top level (ESM top-level await)
const { extractTitle, startWatcher, stopWatcher } = await import('./watcher.js');
const fs = await import('node:fs');

function makeFakeBot() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('extractTitle', () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReset();
  });

  it('returns the first h1 heading text', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('# My Article Title\n\nSome content here.');
    expect(extractTitle('/fake/path.md')).toBe('My Article Title');
  });

  it('returns null when there is no h1 heading', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('## Section\n\nNo top-level heading.');
    expect(extractTitle('/fake/path.md')).toBeNull();
  });

  it('returns null when file content is empty', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('');
    expect(extractTitle('/fake/path.md')).toBeNull();
  });

  it('returns null when readFileSync throws (file unreadable)', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(extractTitle('/nonexistent.md')).toBeNull();
  });

  it('trims whitespace from the heading', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('#   Padded Heading   \n\nBody.');
    expect(extractTitle('/fake/path.md')).toBe('Padded Heading');
  });

  it('matches h1 heading even when it is not the first line', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('Some frontmatter\n\n# Real Title\n\nBody.');
    expect(extractTitle('/fake/path.md')).toBe('Real Title');
  });

  it('does not match h2 or deeper headings as title', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('## Section Heading\n### Subsection\n\nBody.');
    expect(extractTitle('/fake/path.md')).toBeNull();
  });
});

describe('startWatcher + event handling', () => {
  beforeEach(() => {
    capturedWatchCallback = null;
    mockedReaddirContents = [];
    mockEnqueue.mockReset();
    mockWatcherClose.mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ size: 100 } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.readFileSync).mockReturnValue('# Article Title\n\nContent.');
    vi.mocked(fs.readdirSync).mockImplementation(() => mockedReaddirContents as unknown as ReturnType<typeof fs.readdirSync>);
  });

  afterEach(() => {
    stopWatcher();
  });

  it('seeds the seen-set with existing files and does not notify for them on startup', () => {
    mockedReaddirContents = ['existing.md', 'also-existing.md'];
    const bot = makeFakeBot();
    startWatcher(bot as never);

    capturedWatchCallback?.('rename', 'existing.md');

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('calls enqueue with the correct relative path for a new file', () => {
    mockedReaddirContents = [];
    const bot = makeFakeBot();
    startWatcher(bot as never);

    capturedWatchCallback?.('rename', 'new-article.md');

    expect(mockEnqueue).toHaveBeenCalledWith('Readwise/Articles/new-article.md');
  });

  it('sends a Telegram notification when a new article is detected', () => {
    mockedReaddirContents = [];
    const bot = makeFakeBot();
    startWatcher(bot as never);

    capturedWatchCallback?.('rename', 'cool-article.md');

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const [userId, message] = bot.sendMessage.mock.calls[0]!;
    expect(userId).toBe(42);
    expect(message as string).toContain('Article Title');
    expect(message as string).toContain('/ingest');
  });

  it('deduplicates: same filename only triggers enqueue once', () => {
    mockedReaddirContents = [];
    const bot = makeFakeBot();
    startWatcher(bot as never);

    capturedWatchCallback?.('rename', 'dup.md');
    capturedWatchCallback?.('rename', 'dup.md');

    expect(mockEnqueue).toHaveBeenCalledOnce();
    expect(bot.sendMessage).toHaveBeenCalledOnce();
  });

  it('ignores non-.md filenames', () => {
    mockedReaddirContents = [];
    const bot = makeFakeBot();
    startWatcher(bot as never);

    capturedWatchCallback?.('rename', 'image.png');
    capturedWatchCallback?.('rename', 'document.pdf');

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores events that are not rename', () => {
    mockedReaddirContents = [];
    const bot = makeFakeBot();
    startWatcher(bot as never);

    capturedWatchCallback?.('change', 'article.md');

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores null filename events', () => {
    mockedReaddirContents = [];
    const bot = makeFakeBot();
    startWatcher(bot as never);

    capturedWatchCallback?.('rename', null);

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('skips file if statSync throws (file was deleted, not created)', () => {
    mockedReaddirContents = [];
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const bot = makeFakeBot();
    startWatcher(bot as never);

    capturedWatchCallback?.('rename', 'deleted.md');

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to filename (without .md) as title when file has no h1 heading', () => {
    mockedReaddirContents = [];
    vi.mocked(fs.readFileSync).mockReturnValue('## Section\n\nNo title here.');
    const bot = makeFakeBot();
    startWatcher(bot as never);

    capturedWatchCallback?.('rename', 'my-article.md');

    expect(bot.sendMessage).toHaveBeenCalledOnce();
    const message = bot.sendMessage.mock.calls[0]![1] as string;
    expect(message).toContain('my-article');
  });

  it('does not start watcher when Readwise directory does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.watch).mockClear();
    const bot = makeFakeBot();

    startWatcher(bot as never);

    expect(fs.watch).not.toHaveBeenCalled();
    expect(capturedWatchCallback).toBeNull();
  });
});

describe('stopWatcher', () => {
  beforeEach(() => {
    mockWatcherClose.mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockImplementation(() => [] as unknown as ReturnType<typeof fs.readdirSync>);
  });

  it('closes the fs.watch handle when called after startWatcher', () => {
    const bot = makeFakeBot();
    startWatcher(bot as never);
    stopWatcher();
    expect(mockWatcherClose).toHaveBeenCalledOnce();
  });

  it('is safe to call stopWatcher when watcher was never started', () => {
    // watcher state was cleaned by previous stopWatcher in afterEach — calling again should not throw
    expect(() => stopWatcher()).not.toThrow();
  });
});
