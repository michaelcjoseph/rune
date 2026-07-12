import { describe, expect, it, vi } from 'vitest';
import { redactSecrets } from './redact-secrets.js';

describe('redactSecrets exact environment values', () => {
  it('redacts arbitrary non-token-shaped secret environment values', () => {
    vi.stubEnv('RUNE_HTTP_SECRET', 'plain words secret 7491');
    try {
      const result = redactSecrets('failure printed plain words secret 7491');
      expect(result).not.toContain('plain words secret 7491');
      expect(result).toContain('<secret-redacted-');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not redact ordinary non-secret environment values', () => {
    vi.stubEnv('LANG', 'ordinary-language-value');
    try {
      expect(redactSecrets('ordinary-language-value')).toBe('ordinary-language-value');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
