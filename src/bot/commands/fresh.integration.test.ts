import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageSender } from '../../transport/sender.js';

const tmpDir = join(tmpdir(), `jarvis-fresh-int-${Date.now()}`);
const logsDir = join(tmpDir, 'logs');
mkdirSync(logsDir, { recursive: true });

vi.mock('../../config.js', () => ({
  default: {
    VAULT_DIR: tmpDir,
    LOGS_DIR: logsDir,
    TIMEZONE: 'America/Chicago',
    CLAUDE_TIMEOUT_MS: 5000,
    CLAUDE_INGEST_TIMEOUT_MS: 5000,
    ONESHOT_MODEL: 'opus',
    DEFAULT_CHAT_MODEL: 'opus',
    INGESTION_QUEUE_FILE: join(logsDir, 'kb-ingestion-queue.json'),
  },
}));

vi.mock('../../utils/time.js', () => ({
  getTimestamp: vi.fn(() => '14:30'),
  getTodayDate: vi.fn(() => '2026-04-14'),
  getTodayFilename: vi.fn(() => '2026_04_14.md'),
  getDateContext: () =>
    "Today is Monday, April 14, 2026 (America/Chicago). Today's journal file: 2026_04_14.md",
}));

const mockSummarizeSession = vi.fn<(...args: unknown[]) => Promise<{ text: string | null; error: string | null }>>();
const mockRunAgent = vi.fn<(...args: unknown[]) => Promise<{ text: string | null; error: string | null }>>();
vi.mock('../../ai/claude.js', () => ({
  summarizeSession: (...args: unknown[]) => mockSummarizeSession(...args),
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

vi.mock('../../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));
vi.mock('../../vault/sessions.js', () => ({
  getSession: vi.fn(() => ({ sessionId: 'test-session-1', messageCount: 5, firstMessage: 'hello' })),
  deleteSession: vi.fn(),
}));
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const { handleFresh } = await import('./fresh.js');
const { getQueue } = await import('../../kb/queue.js');
const { processIngestionQueue } = await import('../../kb/engine.js');

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  const conversationsDir = join(tmpDir, 'knowledge', 'raw', 'conversations');
  if (existsSync(conversationsDir)) rmSync(conversationsDir, { recursive: true });

  const queueFile = join(logsDir, 'kb-ingestion-queue.json');
  if (existsSync(queueFile)) rmSync(queueFile);

  const journalsDir = join(tmpDir, 'journals');
  if (existsSync(journalsDir)) rmSync(journalsDir, { recursive: true });
  mkdirSync(journalsDir, { recursive: true });

  // Set up knowledge base structure so log.md verification works
  const kbDir = join(tmpDir, 'knowledge');
  mkdirSync(kbDir, { recursive: true });
  writeFileSync(join(kbDir, 'log.md'), '# Knowledge Base Log\n');
});

describe('conversation-to-KB pipeline (e2e)', () => {
  it('KB-worthy conversation: /fresh → raw file → queue → nightly ingest', async () => {
    const summaryText = [
      'Topic: Transformer architecture deep dive',
      'Prompt: Explain attention mechanisms',
      'Discussion: Covered self-attention, multi-head attention, and positional encoding in detail.',
      'Conclusion: Built mental model of how transformers process sequences.',
      'KB-worthy: yes',
    ].join('\n');

    mockSummarizeSession.mockResolvedValue({ text: summaryText, error: null });
    mockRunAgent.mockImplementation(async () => {
      // Simulate wiki-compiler writing to log.md (verifies ingestion actually happened)
      const logPath = join(tmpDir, 'knowledge', 'log.md');
      const existing = readFileSync(logPath, 'utf8');
      writeFileSync(logPath, existing + '[2026-04-14] Ingested conversation\n');
      return { text: 'Ingested successfully. Created 2 wiki pages.', error: null };
    });

    const sender = makeSender();
    await handleFresh(sender, 123);

    // 1. File saved to knowledge/raw/conversations/
    const conversationsDir = join(tmpDir, 'knowledge', 'raw', 'conversations');
    expect(existsSync(conversationsDir)).toBe(true);
    const files = readdirSync(conversationsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^conversation-2026-04-14-1430\d{2}\.md$/);

    // 2. File content is the summary (without KB-worthy line)
    const content = readFileSync(join(conversationsDir, files[0]!), 'utf8');
    expect(content).toContain('Topic: Transformer architecture deep dive');
    expect(content).toContain('Discussion: Covered self-attention');
    expect(content).not.toContain('KB-worthy');

    // 3. File is in the ingestion queue
    const queue = getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.source).toContain('knowledge/raw/conversations/');

    // 4. Nightly processing picks up the queued file
    const result = await processIngestionQueue();
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);

    // 5. wiki-compiler agent was called with the source path
    expect(mockRunAgent).toHaveBeenCalledWith(
      'wiki-compiler',
      expect.stringContaining('knowledge/raw/conversations/'),
      expect.any(Number),
      false,
    );

    // 6. Queue is now empty after processing
    const queueAfter = getQueue();
    expect(queueAfter).toHaveLength(0);

    // 7. User message indicates KB save
    const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(msg).toContain('Saved to KB sources');
  });

  it('non-KB-worthy conversation: no file saved, no queue entry', async () => {
    const summaryText = [
      'Topic: Quick status check',
      'Prompt: How are things going?',
      'Discussion: Brief chat about current status.',
      'Conclusion: All good.',
      'KB-worthy: no',
    ].join('\n');

    mockSummarizeSession.mockResolvedValue({ text: summaryText, error: null });

    const sender = makeSender();
    await handleFresh(sender, 123);

    // No file saved
    const conversationsDir = join(tmpDir, 'knowledge', 'raw', 'conversations');
    if (existsSync(conversationsDir)) {
      expect(readdirSync(conversationsDir)).toHaveLength(0);
    }

    // Queue is empty
    const queue = getQueue();
    expect(queue).toHaveLength(0);

    // No KB label in message
    const msg = vi.mocked(sender.send).mock.calls[0]![1] as string;
    expect(msg).not.toContain('KB sources');
  });

  it('journal entry is written regardless of KB-worthiness', async () => {
    const summaryText = [
      'Topic: Transformer deep dive',
      'Prompt: Explain attention',
      'Discussion: Covered attention in detail.',
      'Conclusion: Good discussion.',
      'KB-worthy: yes',
    ].join('\n');

    mockSummarizeSession.mockResolvedValue({ text: summaryText, error: null });

    const sender = makeSender();
    await handleFresh(sender, 123);

    const journalFile = join(tmpDir, 'journals', '2026_04_14.md');
    expect(existsSync(journalFile)).toBe(true);
    const journalContent = readFileSync(journalFile, 'utf8');
    expect(journalContent).toContain('[[jarvis]] telegram chat');
    expect(journalContent).toContain('Transformer deep dive');
    expect(journalContent).not.toContain('KB-worthy');
  });
});
