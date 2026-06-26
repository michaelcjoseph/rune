import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { execFileSync } = await import('node:child_process');
const { getKeychainValue, setKeychainValue, deleteKeychainValue, getStoredTokens, storeTokens } = await import('./keychain.js');

const execMock = execFileSync as unknown as ReturnType<typeof vi.fn>;

describe('whoop/keychain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getKeychainValue', () => {
    it('returns trimmed value on success', () => {
      execMock.mockReturnValue('  my-secret-value  \n');
      const result = getKeychainValue('access-token');
      expect(result).toBe('my-secret-value');
      expect(execMock).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', 'rune-whoop', '-a', 'access-token', '-w'],
        { encoding: 'utf8', timeout: 5000 },
      );
    });

    it('returns null when security CLI fails', () => {
      execMock.mockImplementation(() => { throw new Error('security: SecKeychainSearchCopyNext'); });
      const result = getKeychainValue('access-token');
      expect(result).toBeNull();
    });
  });

  describe('setKeychainValue', () => {
    it('deletes then adds (calls security twice)', () => {
      execMock.mockReturnValue('');
      setKeychainValue('access-token', 'new-value');

      expect(execMock).toHaveBeenCalledTimes(2);
      // First call: delete
      expect(execMock).toHaveBeenNthCalledWith(1, 'security', [
        'delete-generic-password', '-s', 'rune-whoop', '-a', 'access-token',
      ], { timeout: 5000 });
      // Second call: add
      expect(execMock).toHaveBeenNthCalledWith(2, 'security', [
        'add-generic-password', '-s', 'rune-whoop', '-a', 'access-token', '-w', 'new-value',
      ], { timeout: 5000 });
    });

    it('still adds when delete fails (entry did not exist)', () => {
      execMock
        .mockImplementationOnce(() => { throw new Error('not found'); })
        .mockReturnValueOnce('');

      setKeychainValue('access-token', 'val');
      expect(execMock).toHaveBeenCalledTimes(2);
      // Add was still called
      expect(execMock).toHaveBeenNthCalledWith(2, 'security', expect.arrayContaining(['add-generic-password']), expect.any(Object));
    });

    it('does not throw when add also fails', () => {
      execMock
        .mockImplementationOnce(() => { throw new Error('delete fail'); })
        .mockImplementationOnce(() => { throw new Error('add fail'); });

      expect(() => setKeychainValue('key', 'val')).not.toThrow();
    });

    it('refuses to store empty string (would corrupt keychain)', () => {
      expect(() => setKeychainValue('refresh-token', '')).toThrow(/refused/);
      expect(execMock).not.toHaveBeenCalled();
    });

    it('refuses to store the literal "undefined" string', () => {
      expect(() => setKeychainValue('refresh-token', 'undefined')).toThrow(/refused/);
      expect(execMock).not.toHaveBeenCalled();
    });

    it('refuses to store the literal "null" string', () => {
      expect(() => setKeychainValue('refresh-token', 'null')).toThrow(/refused/);
      expect(execMock).not.toHaveBeenCalled();
    });
  });

  describe('deleteKeychainValue', () => {
    it('calls security delete-generic-password', () => {
      execMock.mockReturnValue('');
      deleteKeychainValue('access-token');
      expect(execMock).toHaveBeenCalledWith(
        'security',
        ['delete-generic-password', '-s', 'rune-whoop', '-a', 'access-token'],
        { timeout: 5000 },
      );
    });

    it('does not throw when entry does not exist', () => {
      execMock.mockImplementation(() => { throw new Error('not found'); });
      expect(() => deleteKeychainValue('access-token')).not.toThrow();
    });
  });

  describe('getStoredTokens', () => {
    it('returns combined access/refresh/expiry from keychain', () => {
      execMock
        .mockReturnValueOnce('my-access-token\n')
        .mockReturnValueOnce('my-refresh-token\n')
        .mockReturnValueOnce('1700000000000\n');

      const tokens = getStoredTokens();
      expect(tokens).toEqual({
        accessToken: 'my-access-token',
        refreshToken: 'my-refresh-token',
        expiresAt: 1700000000000,
      });
    });

    it('returns nulls and 0 when no tokens stored', () => {
      execMock.mockImplementation(() => { throw new Error('not found'); });

      const tokens = getStoredTokens();
      expect(tokens).toEqual({
        accessToken: null,
        refreshToken: null,
        expiresAt: 0,
      });
    });

    it('treats legacy "undefined" string values as missing', () => {
      execMock
        .mockReturnValueOnce('good-access\n')
        .mockReturnValueOnce('undefined\n')
        .mockReturnValueOnce('1700000000000\n');

      const tokens = getStoredTokens();
      expect(tokens).toEqual({
        accessToken: 'good-access',
        refreshToken: null,
        expiresAt: 1700000000000,
      });
    });
  });

  describe('storeTokens', () => {
    it('throws when refresh token is empty (prevents silent corruption)', () => {
      expect(() => storeTokens('at-123', '', 1700000000000)).toThrow(/refused/);
      expect(execMock).not.toHaveBeenCalled();
    });

    it('throws when access token is empty', () => {
      expect(() => storeTokens('', 'rt-456', 1700000000000)).toThrow(/refused/);
      expect(execMock).not.toHaveBeenCalled();
    });

    it('writes all three values to keychain', () => {
      execMock.mockReturnValue('');
      storeTokens('at-123', 'rt-456', 1700000000000);

      // 3 keys × 2 calls each (delete + add) = 6 calls
      expect(execMock).toHaveBeenCalledTimes(6);

      // Verify add calls include the correct values
      const addCalls = execMock.mock.calls.filter(
        (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes('add-generic-password'),
      );
      expect(addCalls).toHaveLength(3);

      const addedValues = addCalls.map((c: unknown[]) => {
        const args = c[1] as string[];
        return { key: args[args.indexOf('-a') + 1], value: args[args.indexOf('-w') + 1] };
      });
      expect(addedValues).toContainEqual({ key: 'access-token', value: 'at-123' });
      expect(addedValues).toContainEqual({ key: 'refresh-token', value: 'rt-456' });
      expect(addedValues).toContainEqual({ key: 'token-expiry', value: '1700000000000' });
    });
  });
});
