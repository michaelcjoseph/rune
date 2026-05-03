import { describe, it, expect } from 'vitest';

const { WebviewSender } = await import('./webview-sender.js');

describe('WebviewSender', () => {
  describe('send() — Phase A no-op', () => {
    it('returns a resolved Promise without throwing', async () => {
      const sender = new WebviewSender();
      await expect(sender.send(1, 'hello')).resolves.toBeUndefined();
    });

    it('returns a resolved Promise for any userId', async () => {
      const sender = new WebviewSender();
      await expect(sender.send(999, 'nobody home')).resolves.toBeUndefined();
    });
  });

  describe('name property', () => {
    it('has name "webview"', () => {
      const sender = new WebviewSender();
      expect(sender.name).toBe('webview');
    });
  });

  describe('startTyping / stopTyping — no-ops', () => {
    it('startTyping does not throw', () => {
      const sender = new WebviewSender();
      expect(() => sender.startTyping(1)).not.toThrow();
    });

    it('stopTyping does not throw', () => {
      const sender = new WebviewSender();
      expect(() => sender.stopTyping(1)).not.toThrow();
    });
  });

  describe('shutdown — no-op', () => {
    it('does not throw', () => {
      const sender = new WebviewSender();
      expect(() => sender.shutdown()).not.toThrow();
    });
  });
});
