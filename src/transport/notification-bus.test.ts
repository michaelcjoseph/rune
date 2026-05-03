import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger so bus errors don't pollute test output
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { NotificationBus } = await import('./notification-bus.js');

describe('NotificationBus', () => {
  let bus: InstanceType<typeof NotificationBus>;

  beforeEach(() => {
    bus = new NotificationBus();
  });

  describe('fan-out to multiple subscribers', () => {
    it('delivers the event to all registered handlers for the same kind', () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();

      bus.on('message', handlerA);
      bus.on('message', handlerB);

      const event = { kind: 'message' as const, userId: 1, text: 'hello' };
      bus.publish(event);

      expect(handlerA).toHaveBeenCalledOnce();
      expect(handlerA).toHaveBeenCalledWith(event);
      expect(handlerB).toHaveBeenCalledOnce();
      expect(handlerB).toHaveBeenCalledWith(event);
    });

    // Phase D/E will add a second BusEvent kind; at that point verify cross-kind isolation.
    it.todo('does not deliver to handlers registered for a different kind — requires a second BusEvent member; revisit in Phase D');

    it('publish is a no-op when no handlers are registered', () => {
      // Should not throw
      expect(() => {
        bus.publish({ kind: 'message', userId: 1, text: 'hi' });
      }).not.toThrow();
    });
  });

  describe('fault isolation — one failing subscriber does not block the others', () => {
    it('calls the remaining handler after a throwing handler', () => {
      const bad = vi.fn().mockImplementation(() => {
        throw new Error('boom');
      });
      const good = vi.fn();

      bus.on('message', bad);
      bus.on('message', good);

      const event = { kind: 'message' as const, userId: 2, text: 'test' };

      expect(() => bus.publish(event)).not.toThrow();
      expect(bad).toHaveBeenCalledOnce();
      expect(good).toHaveBeenCalledOnce();
      expect(good).toHaveBeenCalledWith(event);
    });

    it('delivers to all surviving handlers when multiple throw', () => {
      const bad1 = vi.fn().mockImplementation(() => { throw new Error('err1'); });
      const bad2 = vi.fn().mockImplementation(() => { throw new Error('err2'); });
      const good = vi.fn();

      bus.on('message', bad1);
      bus.on('message', bad2);
      bus.on('message', good);

      bus.publish({ kind: 'message', userId: 3, text: 'multi' });

      expect(bad1).toHaveBeenCalledOnce();
      expect(bad2).toHaveBeenCalledOnce();
      expect(good).toHaveBeenCalledOnce();
    });
  });

  describe('on / off lifecycle', () => {
    it('off removes a handler so it no longer receives events', () => {
      const handler = vi.fn();
      bus.on('message', handler);
      bus.off('message', handler);

      bus.publish({ kind: 'message', userId: 4, text: 'gone' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('off on an unregistered handler is a no-op', () => {
      const handler = vi.fn();
      expect(() => bus.off('message', handler)).not.toThrow();
    });

    it('adding the same handler twice still delivers only once', () => {
      const handler = vi.fn();
      bus.on('message', handler);
      bus.on('message', handler); // Set deduplication

      bus.publish({ kind: 'message', userId: 5, text: 'dedup' });

      expect(handler).toHaveBeenCalledOnce();
    });
  });
});
