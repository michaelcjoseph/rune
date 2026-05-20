import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
  vaultFileExists: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { readVaultFile, vaultFileExists } = await import('../vault/files.js');
const { readPool, SR_SEED_PATH } = await import('./sr-pool.js');

const readMock = vi.mocked(readVaultFile);
const existsMock = vi.mocked(vaultFileExists);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('SR_SEED_PATH', () => {
  it('is the expected vault-relative path', () => {
    expect(SR_SEED_PATH).toBe('study/sr-seed.json');
  });
});

describe('readPool', () => {
  describe('happy path — all concepts exist on disk', () => {
    it('reads sr-seed.json and returns paths that exist on disk', () => {
      const concepts = [
        'knowledge/wiki/concepts/neural-networks.md',
        'knowledge/wiki/concepts/gradient-descent.md',
      ];
      readMock.mockReturnValue(JSON.stringify({ concepts }));
      existsMock.mockReturnValue(true);

      const result = readPool();

      expect(readMock).toHaveBeenCalledWith(SR_SEED_PATH);
      expect(result).toEqual(concepts);
    });

    it('passes options without throwing (statusFilter is accepted but inert in Phase 1)', () => {
      readMock.mockReturnValue(JSON.stringify({ concepts: ['knowledge/wiki/concepts/foo.md'] }));
      existsMock.mockReturnValue(true);

      expect(() => readPool({ statusFilter: ['evergreen', 'active'] })).not.toThrow();
    });
  });

  describe('missing concepts on disk', () => {
    it('excludes a path whose file is missing from disk and does not throw', () => {
      const present = 'knowledge/wiki/concepts/neural-networks.md';
      const missing = 'knowledge/wiki/concepts/does-not-exist.md';
      readMock.mockReturnValue(JSON.stringify({ concepts: [present, missing] }));
      existsMock.mockImplementation((path: string) => path === present);

      const result = readPool();

      expect(result).toEqual([present]);
      expect(result).not.toContain(missing);
    });

    it('returns [] when every concept in the seed is missing from disk', () => {
      readMock.mockReturnValue(
        JSON.stringify({ concepts: ['knowledge/wiki/concepts/ghost.md'] }),
      );
      existsMock.mockReturnValue(false);

      expect(readPool()).toEqual([]);
    });
  });

  describe('empty or missing seed file', () => {
    it('returns [] when readVaultFile returns null (file absent)', () => {
      readMock.mockReturnValue(null);

      expect(readPool()).toEqual([]);
    });

    it('returns [] when readVaultFile returns an empty string', () => {
      readMock.mockReturnValue('');

      expect(readPool()).toEqual([]);
    });

    it('returns [] when readVaultFile returns only whitespace', () => {
      readMock.mockReturnValue('   \n  ');

      expect(readPool()).toEqual([]);
    });
  });

  describe('corrupt / non-JSON seed file', () => {
    it('returns [] without throwing on malformed JSON', () => {
      readMock.mockReturnValue('{not valid json');

      const result = readPool();
      expect(result).toEqual([]);
    });

    it('returns [] without throwing on plain text content', () => {
      readMock.mockReturnValue('this is not json at all');

      const result = readPool();
      expect(result).toEqual([]);
    });
  });

  describe('seed JSON with no concepts array', () => {
    it('returns [] when the parsed object has no concepts key', () => {
      readMock.mockReturnValue(JSON.stringify({ other: 'data' }));

      expect(readPool()).toEqual([]);
    });

    it('returns [] when concepts is null', () => {
      readMock.mockReturnValue(JSON.stringify({ concepts: null }));

      expect(readPool()).toEqual([]);
    });

    it('returns [] when the seed is a JSON array (not an object)', () => {
      readMock.mockReturnValue(JSON.stringify(['foo', 'bar']));

      expect(readPool()).toEqual([]);
    });

    it('returns [] when the seed is a JSON string', () => {
      readMock.mockReturnValue(JSON.stringify('just a string'));

      expect(readPool()).toEqual([]);
    });
  });

  describe('non-string entries in the concepts array', () => {
    it('skips numeric entries', () => {
      const valid = 'knowledge/wiki/concepts/valid.md';
      readMock.mockReturnValue(JSON.stringify({ concepts: [42, valid, 99] }));
      existsMock.mockReturnValue(true);

      expect(readPool()).toEqual([valid]);
    });

    it('skips null entries', () => {
      const valid = 'knowledge/wiki/concepts/valid.md';
      readMock.mockReturnValue(JSON.stringify({ concepts: [null, valid] }));
      existsMock.mockReturnValue(true);

      expect(readPool()).toEqual([valid]);
    });

    it('skips object entries', () => {
      const valid = 'knowledge/wiki/concepts/valid.md';
      readMock.mockReturnValue(JSON.stringify({ concepts: [{ path: valid }, valid] }));
      existsMock.mockReturnValue(true);

      expect(readPool()).toEqual([valid]);
    });

    it('returns [] when all entries are non-string', () => {
      readMock.mockReturnValue(JSON.stringify({ concepts: [1, null, false, {}] }));

      expect(readPool()).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('returns [] for an empty concepts array', () => {
      readMock.mockReturnValue(JSON.stringify({ concepts: [] }));

      expect(readPool()).toEqual([]);
    });

    it('does not call vaultFileExists for non-string entries', () => {
      readMock.mockReturnValue(JSON.stringify({ concepts: [42, null] }));

      readPool();

      expect(existsMock).not.toHaveBeenCalled();
    });
  });
});
