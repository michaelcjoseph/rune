import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSender } from '../../transport/sender.js';

vi.mock('../../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
  PROJECT_ROOT: '/tmp/test-project',
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../intent/registry.js', () => ({
  readRegistry: vi.fn(),
}));

vi.mock('../../reviews/planning.js', () => ({
  createPlanningSession: vi.fn(),
  getActivePlanningSession: vi.fn(() => null),
  deletePlanningSession: vi.fn(),
}));

const { readRegistry } = await import('../../intent/registry.js');
const { createPlanningSession, getActivePlanningSession } = await import('../../reviews/planning.js');
const { handlePlan } = await import('./plan.js');

const readRegistryMock = readRegistry as unknown as ReturnType<typeof vi.fn>;
const createPlanningSessionMock = createPlanningSession as unknown as ReturnType<typeof vi.fn>;
const getActivePlanningSessionMock = getActivePlanningSession as unknown as ReturnType<typeof vi.fn>;

function makeSender(): MessageSender {
  return {
    name: 'telegram' as const,
    send: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

/** A minimal registry with one product "aura". */
function makeRegistry() {
  return {
    version: 1,
    builtAt: '2026-05-24T00:00:00.000Z',
    products: [
      {
        name: 'aura',
        repoBacked: true,
        projects: [{ slug: '01-mvp', status: 'active' }],
      },
      {
        name: 'jarvis',
        repoBacked: true,
        projects: [{ slug: '08-intent-layer', status: 'active' }],
      },
    ],
  };
}

/** A minimal StoredPlanningSession stub. */
function makePlanningSession(product = 'aura') {
  return {
    id: 'sess-plan-001',
    chatId: 100,
    claudeSessionId: 'claude-sess-001',
    planning: {
      status: 'scoping',
      product,
      idea: '',
      surface: 'chat',
      history: [],
      createdAt: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
  };
}

describe('handlePlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivePlanningSessionMock.mockReturnValue(null);
  });

  describe('with a known product arg', () => {
    it('calls createPlanningSession with userId, empty idea, chat surface, and the product name', async () => {
      readRegistryMock.mockReturnValue(makeRegistry());
      createPlanningSessionMock.mockReturnValue(makePlanningSession('aura'));

      await handlePlan(makeSender(), 100, 'aura');

      expect(createPlanningSessionMock).toHaveBeenCalledWith(100, '', 'chat', 'aura');
    });

    it('sends a reply that mentions "Planning" and the product name', async () => {
      readRegistryMock.mockReturnValue(makeRegistry());
      createPlanningSessionMock.mockReturnValue(makePlanningSession('aura'));

      const sender = makeSender();
      await handlePlan(sender, 100, 'aura');

      const reply = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(reply).toMatch(/planning/i);
      expect(reply).toContain('aura');
    });

    it('sends a reply that asks the first scoping question', async () => {
      readRegistryMock.mockReturnValue(makeRegistry());
      createPlanningSessionMock.mockReturnValue(makePlanningSession('aura'));

      const sender = makeSender();
      await handlePlan(sender, 100, 'aura');

      const reply = vi.mocked(sender.send).mock.calls[0]![1] as string;
      // The reply must contain a question mark (the first scoping question).
      expect(reply).toContain('?');
    });
  });

  describe('with an unknown product arg', () => {
    it('does NOT call createPlanningSession', async () => {
      readRegistryMock.mockReturnValue(makeRegistry());

      await handlePlan(makeSender(), 100, 'unknown-product');

      expect(createPlanningSessionMock).not.toHaveBeenCalled();
    });

    it('sends a reply that lists the registered products', async () => {
      readRegistryMock.mockReturnValue(makeRegistry());

      const sender = makeSender();
      await handlePlan(sender, 100, 'unknown-product');

      const reply = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(reply).toContain('aura');
      expect(reply).toContain('jarvis');
    });
  });

  describe('with no args', () => {
    it('does NOT call createPlanningSession', async () => {
      readRegistryMock.mockReturnValue(makeRegistry());

      await handlePlan(makeSender(), 100, '');

      expect(createPlanningSessionMock).not.toHaveBeenCalled();
    });

    it('sends a reply that lists registered products and the usage hint', async () => {
      readRegistryMock.mockReturnValue(makeRegistry());

      const sender = makeSender();
      await handlePlan(sender, 100, '');

      const reply = vi.mocked(sender.send).mock.calls[0]![1] as string;
      expect(reply).toContain('aura');
      expect(reply).toContain('jarvis');
      // Usage hint should mention /plan
      expect(reply).toContain('/plan');
    });
  });

  describe('when the registry is unavailable', () => {
    it('sends a clear error reply when readRegistry throws', async () => {
      readRegistryMock.mockImplementation(() => {
        throw new Error('registry file not found');
      });

      const sender = makeSender();
      await handlePlan(sender, 100, 'aura');

      expect(sender.send).toHaveBeenCalledTimes(1);
      const reply = vi.mocked(sender.send).mock.calls[0]![1] as string;
      // Must communicate that something went wrong
      expect(reply.length).toBeGreaterThan(0);
      // Must NOT have started a session — guard rejects any registry error
      // shape, not just "file not found".
      expect(createPlanningSessionMock).not.toHaveBeenCalled();
    });
  });
});
