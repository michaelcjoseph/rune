import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `rune-watcher-test-${Date.now()}`);

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
// Map from watched dir path to captured callback, so tests can fire events for specific dirs
const capturedWatchCallbacks = new Map<string, WatchCallback>();
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
    watch: vi.fn().mockImplementation((dir: string, cb: WatchCallback) => {
      capturedWatchCallbacks.set(dir, cb);
      return { close: mockWatcherClose };
    }),
  };
});

// Helper: fire a watch event as if it came from the given Readwise sub-directory.
// tmpDir is defined below; we reference it here via closure.
function fireEvent(subDir: string, event: string, filename: string | null) {
  const dir = join(tmpDir, subDir);
  const cb = capturedWatchCallbacks.get(dir);
  if (!cb) throw new Error(`No watch callback registered for ${dir}`);
  cb(event, filename);
}

// All module imports at the top level (ESM top-level await)
const { extractTitle, startWatcher, stopWatcher } = await import('./watcher.js');
const fs = await import('node:fs');

function makeFakeBus() {
  return { publish: vi.fn() };
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
    capturedWatchCallbacks.clear();
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
    const bus = makeFakeBus();
    startWatcher(bus as never);

    // Fire event for a file that was already present when the watcher started
    fireEvent('Readwise/Articles', 'rename', 'existing.md');

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('calls enqueue with the correct relative path for a new file in Articles', () => {
    mockedReaddirContents = [];
    const bus = makeFakeBus();
    startWatcher(bus as never);

    fireEvent('Readwise/Articles', 'rename', 'new-article.md');

    expect(mockEnqueue).toHaveBeenCalledWith('Readwise/Articles/new-article.md');
  });

  it('publishes a notification when a new article is detected', () => {
    mockedReaddirContents = [];
    const bus = makeFakeBus();
    startWatcher(bus as never);

    fireEvent('Readwise/Articles', 'rename', 'cool-article.md');

    expect(bus.publish).toHaveBeenCalledOnce();
    const { userId, text } = bus.publish.mock.calls[0]![0] as { kind: string; userId: number; text: string };
    expect(userId).toBe(42);
    expect(text).toContain('Article Title');
    expect(text).toContain('/ingest');
  });

  it('deduplicates: same filename only triggers enqueue once', () => {
    mockedReaddirContents = [];
    const bus = makeFakeBus();
    startWatcher(bus as never);

    fireEvent('Readwise/Articles', 'rename', 'dup.md');
    fireEvent('Readwise/Articles', 'rename', 'dup.md');

    expect(mockEnqueue).toHaveBeenCalledOnce();
    expect(bus.publish).toHaveBeenCalledOnce();
  });

  it('ignores non-.md filenames', () => {
    mockedReaddirContents = [];
    const bus = makeFakeBus();
    startWatcher(bus as never);

    fireEvent('Readwise/Articles', 'rename', 'image.png');
    fireEvent('Readwise/Articles', 'rename', 'document.pdf');

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('ignores events that are not rename', () => {
    mockedReaddirContents = [];
    const bus = makeFakeBus();
    startWatcher(bus as never);

    fireEvent('Readwise/Articles', 'change', 'article.md');

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('ignores null filename events', () => {
    mockedReaddirContents = [];
    const bus = makeFakeBus();
    startWatcher(bus as never);

    fireEvent('Readwise/Articles', 'rename', null as unknown as string);

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('skips file if statSync throws (file was deleted, not created)', () => {
    mockedReaddirContents = [];
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const bus = makeFakeBus();
    startWatcher(bus as never);

    fireEvent('Readwise/Articles', 'rename', 'deleted.md');

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('falls back to filename (without .md) as title when file has no h1 heading', () => {
    mockedReaddirContents = [];
    vi.mocked(fs.readFileSync).mockReturnValue('## Section\n\nNo title here.');
    const bus = makeFakeBus();
    startWatcher(bus as never);

    fireEvent('Readwise/Articles', 'rename', 'my-article.md');

    expect(bus.publish).toHaveBeenCalledOnce();
    const { text } = bus.publish.mock.calls[0]![0] as { kind: string; userId: number; text: string };
    expect(text).toContain('my-article');
  });

  it('does not start any watcher when all Readwise directories do not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.watch).mockClear();
    capturedWatchCallbacks.clear();
    const bus = makeFakeBus();

    startWatcher(bus as never);

    expect(fs.watch).not.toHaveBeenCalled();
    expect(capturedWatchCallbacks.size).toBe(0);
  });
});

describe('multi-directory watching', () => {
  beforeEach(() => {
    capturedWatchCallbacks.clear();
    mockedReaddirContents = [];
    mockEnqueue.mockReset();
    mockWatcherClose.mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ size: 100 } as ReturnType<typeof fs.statSync>);
    vi.mocked(fs.readFileSync).mockReturnValue('# Title\n\nContent.');
    vi.mocked(fs.readdirSync).mockImplementation(() => mockedReaddirContents as unknown as ReturnType<typeof fs.readdirSync>);
  });

  afterEach(() => {
    stopWatcher();
  });

  it('registers watch callbacks for all three Readwise directories', () => {
    const bus = makeFakeBus();
    startWatcher(bus as never);
    expect(capturedWatchCallbacks.size).toBe(3);
    expect(capturedWatchCallbacks.has(join(tmpDir, 'Readwise/Articles'))).toBe(true);
    expect(capturedWatchCallbacks.has(join(tmpDir, 'Readwise/Tweets'))).toBe(true);
    expect(capturedWatchCallbacks.has(join(tmpDir, 'Readwise/Books'))).toBe(true);
  });

  it('enqueues with Readwise/Tweets prefix for a new tweet file', () => {
    const bus = makeFakeBus();
    startWatcher(bus as never);

    fireEvent('Readwise/Tweets', 'rename', 'my-tweet.md');

    expect(mockEnqueue).toHaveBeenCalledWith('Readwise/Tweets/my-tweet.md');
  });

  it('enqueues with Readwise/Books prefix for a new book file', () => {
    const bus = makeFakeBus();
    startWatcher(bus as never);

    fireEvent('Readwise/Books', 'rename', 'my-book.md');

    expect(mockEnqueue).toHaveBeenCalledWith('Readwise/Books/my-book.md');
  });

  it('same filename in different directories are tracked independently (no cross-dir dedup)', () => {
    const bus = makeFakeBus();
    startWatcher(bus as never);

    fireEvent('Readwise/Articles', 'rename', 'note.md');
    fireEvent('Readwise/Tweets', 'rename', 'note.md');
    fireEvent('Readwise/Books', 'rename', 'note.md');

    expect(mockEnqueue).toHaveBeenCalledTimes(3);
    expect(mockEnqueue).toHaveBeenCalledWith('Readwise/Articles/note.md');
    expect(mockEnqueue).toHaveBeenCalledWith('Readwise/Tweets/note.md');
    expect(mockEnqueue).toHaveBeenCalledWith('Readwise/Books/note.md');
  });

  it('seeds seen-set with full relative path so Tweets pre-existing file is not re-notified', () => {
    mockedReaddirContents = ['preexisting.md'];
    const bus = makeFakeBus();
    startWatcher(bus as never);

    fireEvent('Readwise/Tweets', 'rename', 'preexisting.md');

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('starts only available directories when some do not exist', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      // Only Articles exists
      return String(p).endsWith('Readwise/Articles');
    });
    vi.mocked(fs.watch).mockClear();
    capturedWatchCallbacks.clear();
    const bus = makeFakeBus();
    startWatcher(bus as never);

    expect(capturedWatchCallbacks.size).toBe(1);
    expect(capturedWatchCallbacks.has(join(tmpDir, 'Readwise/Articles'))).toBe(true);
  });

  it('notification text says "New Readwise content" (updated message)', () => {
    const bus = makeFakeBus();
    startWatcher(bus as never);

    fireEvent('Readwise/Tweets', 'rename', 'tweet.md');

    const { text } = bus.publish.mock.calls[0]![0] as { text: string };
    expect(text).toContain('New Readwise content:');
  });
});

describe('stopWatcher', () => {
  beforeEach(() => {
    capturedWatchCallbacks.clear();
    mockWatcherClose.mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockImplementation(() => [] as unknown as ReturnType<typeof fs.readdirSync>);
  });

  it('closes all fs.watch handles (one per watched directory) when called after startWatcher', () => {
    const bus = makeFakeBus();
    startWatcher(bus as never);
    stopWatcher();
    // Three dirs: Articles, Tweets, Books
    expect(mockWatcherClose).toHaveBeenCalledTimes(3);
  });

  it('is safe to call stopWatcher when watcher was never started', () => {
    // watcher state was cleaned by previous stopWatcher in afterEach — calling again should not throw
    expect(() => stopWatcher()).not.toThrow();
  });
});
