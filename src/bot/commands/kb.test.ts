import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../kb/engine.js', () => ({
  queryKB: vi.fn(),
  getKBStats: vi.fn(),
}));

const { queryKB, getKBStats } = await import('../../kb/engine.js');
const { handleKB } = await import('./kb.js');

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

const USER_ID = 42;

describe('handleKB', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('query subcommand', () => {
    it('calls startTyping with "Querying knowledge base" when /kb query is invoked', async () => {
      vi.mocked(queryKB).mockResolvedValue({ answer: 'wiki answer' });
      const sender = makeSender();

      await handleKB(sender, USER_ID, 'query what is attention');

      expect(sender.startTyping).toHaveBeenCalledWith(USER_ID, 'Querying knowledge base');
    });

    it('calls startTyping with "Querying knowledge base" when /kb q is used', async () => {
      vi.mocked(queryKB).mockResolvedValue({ answer: 'result' });
      const sender = makeSender();

      await handleKB(sender, USER_ID, 'q transformer architecture');

      expect(sender.startTyping).toHaveBeenCalledWith(USER_ID, 'Querying knowledge base');
    });

    it('calls startTyping with "Querying knowledge base" for bare /kb <question> shorthand', async () => {
      vi.mocked(queryKB).mockResolvedValue({ answer: 'inline answer' });
      const sender = makeSender();

      await handleKB(sender, USER_ID, 'reinforcement learning');

      expect(sender.startTyping).toHaveBeenCalledWith(USER_ID, 'Querying knowledge base');
    });

    it('calls stopTyping after queryKB resolves', async () => {
      vi.mocked(queryKB).mockResolvedValue({ answer: 'ok' });
      const sender = makeSender();

      await handleKB(sender, USER_ID, 'query something');

      expect(sender.stopTyping).toHaveBeenCalledWith(USER_ID);
    });

    it('sends the answer returned by queryKB', async () => {
      vi.mocked(queryKB).mockResolvedValue({ answer: 'The answer is 42.' });
      const sender = makeSender();

      await handleKB(sender, USER_ID, 'query ultimate question');

      expect(sender.send).toHaveBeenCalledWith(USER_ID, 'The answer is 42.');
    });

    it('sends a usage hint when /kb query is called without a question', async () => {
      const sender = makeSender();

      await handleKB(sender, USER_ID, 'query');

      expect(sender.send).toHaveBeenCalledWith(USER_ID, 'Usage: /kb query <question>');
      expect(queryKB).not.toHaveBeenCalled();
    });

    it('calls stopTyping and sends error when queryKB throws', async () => {
      vi.mocked(queryKB).mockRejectedValue(new Error('engine unavailable'));
      const sender = makeSender();

      await handleKB(sender, USER_ID, 'query what is entropy');

      expect(sender.stopTyping).toHaveBeenCalledWith(USER_ID);
      expect(sender.send).toHaveBeenCalledWith(USER_ID, 'KB query error: engine unavailable');
    });
  });

  describe('stats subcommand', () => {
    it('sends formatted stats when /kb stats is invoked', async () => {
      vi.mocked(getKBStats).mockReturnValue({
        totalPages: 120,
        entities: 40,
        concepts: 50,
        topics: 20,
        comparisons: 10,
        recentLog: [],
      });
      const sender = makeSender();

      await handleKB(sender, USER_ID, 'stats');

      const message = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(message).toContain('Total pages: 120');
      expect(message).toContain('Entities: 40');
    });
  });

  describe('recent subcommand', () => {
    it('sends "No recent KB activity" when log is empty', async () => {
      vi.mocked(getKBStats).mockReturnValue({
        totalPages: 0, entities: 0, concepts: 0, topics: 0, comparisons: 0,
        recentLog: [],
      });
      const sender = makeSender();

      await handleKB(sender, USER_ID, 'recent');

      expect(sender.send).toHaveBeenCalledWith(USER_ID, 'No recent KB activity.');
    });

    it('sends recent log entries when they exist', async () => {
      vi.mocked(getKBStats).mockReturnValue({
        totalPages: 1, entities: 0, concepts: 0, topics: 0, comparisons: 0,
        recentLog: ['2026-05-14 INGEST knowledge/wiki/foo.md'],
      });
      const sender = makeSender();

      await handleKB(sender, USER_ID, 'recent');

      const message = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(message).toContain('Recent KB Activity');
      expect(message).toContain('INGEST knowledge/wiki/foo.md');
    });
  });

  describe('unknown subcommand / no args', () => {
    it('sends help text when no subcommand is provided', async () => {
      const sender = makeSender();

      await handleKB(sender, USER_ID, '');

      const message = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(message).toContain('/kb query');
      expect(message).toContain('/kb stats');
    });
  });
});
