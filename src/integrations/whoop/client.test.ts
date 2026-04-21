import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  default: {
    WHOOP_CLIENT_ID: 'test-client-id',
    WHOOP_CLIENT_SECRET: 'test-client-secret',
  },
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('./keychain.js', () => ({
  getStoredTokens: vi.fn(),
  storeTokens: vi.fn(),
}));

const { getStoredTokens, storeTokens } = await import('./keychain.js');
const configModule = await import('../../config.js');
const { isConfigured, getAccessToken, fetchSleep, fetchRecovery, fetchCycles, fetchWorkouts, exchangeCode } = await import('./client.js');

const getTokensMock = getStoredTokens as unknown as ReturnType<typeof vi.fn>;
const storeTokensMock = storeTokens as unknown as ReturnType<typeof vi.fn>;
const config = configModule.default as Record<string, unknown>;

describe('whoop/client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    config.WHOOP_CLIENT_ID = 'test-client-id';
    config.WHOOP_CLIENT_SECRET = 'test-client-secret';
  });

  describe('isConfigured', () => {
    it('returns true when both client ID and secret are set', () => {
      expect(isConfigured()).toBe(true);
    });

    it('returns false when WHOOP_CLIENT_ID is empty', () => {
      config.WHOOP_CLIENT_ID = '';
      expect(isConfigured()).toBe(false);
    });

    it('returns false when WHOOP_CLIENT_SECRET is empty', () => {
      config.WHOOP_CLIENT_SECRET = '';
      expect(isConfigured()).toBe(false);
    });
  });

  describe('getAccessToken', () => {
    it('returns not_configured when client id is empty', async () => {
      config.WHOOP_CLIENT_ID = '';
      const result = await getAccessToken();
      expect(result).toEqual({ ok: false, reason: 'not_configured' });
    });

    it('returns cached token when not expired', async () => {
      getTokensMock.mockReturnValue({
        accessToken: 'valid-token',
        refreshToken: 'rt',
        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
      });

      const result = await getAccessToken();
      expect(result).toEqual({ ok: true, token: 'valid-token' });
    });

    it('returns no_refres_token when refresh token is missing', async () => {
      getTokensMock.mockReturnValue({
        accessToken: 'expired-token',
        refreshToken: null,
        expiresAt: Date.now() - 1000, // expired
      });

      const result = await getAccessToken();
      expect(result).toEqual({ ok: false, reason: 'no_refresh_token' });
    });

    it('refreshes token when expired', async () => {
      getTokensMock.mockReturnValue({
        accessToken: 'expired-token',
        refreshToken: 'valid-refresh',
        expiresAt: Date.now() - 1000, // expired
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'read:recovery',
        }), { status: 200 }),
      );

      const result = await getAccessToken();
      expect(result).toEqual({ ok: true, token: 'new-access' });
      expect(storeTokensMock).toHaveBeenCalledWith('new-access', 'new-refresh', expect.any(Number));
      fetchSpy.mockRestore();
    });

    it('returns refresh_rejected with status on 4xx (no retry)', async () => {
      getTokensMock.mockReturnValue({
        accessToken: 'expired',
        refreshToken: 'bad-refresh',
        expiresAt: Date.now() - 1000,
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Unauthorized', { status: 401 }),
      );

      const result = await getAccessToken();
      expect(result).toEqual({ ok: false, reason: 'refresh_rejected', status: 401 });
      expect(fetchSpy).toHaveBeenCalledTimes(1); // no retries on 4xx
      fetchSpy.mockRestore();
    });

    it('returns network_error and retries when fetch throws', async () => {
      getTokensMock.mockReturnValue({
        accessToken: 'expired',
        refreshToken: 'rt',
        expiresAt: Date.now() - 1000,
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await getAccessToken();
      expect(result).toEqual({ ok: false, reason: 'network_error', detail: 'Network error' });
      expect(fetchSpy).toHaveBeenCalledTimes(3); // initial + 2 retries
      fetchSpy.mockRestore();
    }, 10_000);

    it('preserves existing refresh token when Whoop omits it from response', async () => {
      getTokensMock.mockReturnValue({
        accessToken: 'expired',
        refreshToken: 'existing-refresh',
        expiresAt: Date.now() - 1000,
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          access_token: 'new-access',
          // NOTE: no refresh_token field
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'read:recovery',
        }), { status: 200 }),
      );

      const result = await getAccessToken();
      expect(result).toEqual({ ok: true, token: 'new-access' });
      expect(storeTokensMock).toHaveBeenCalledWith('new-access', 'existing-refresh', expect.any(Number));
      fetchSpy.mockRestore();
    });

    it('retries on 5xx then succeeds', async () => {
      getTokensMock.mockReturnValue({
        accessToken: 'expired',
        refreshToken: 'rt',
        expiresAt: Date.now() - 1000,
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('boom', { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'read:recovery',
        }), { status: 200 }));

      const result = await getAccessToken();
      expect(result).toEqual({ ok: true, token: 'new-access' });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      fetchSpy.mockRestore();
    }, 10_000);
  });

  describe('fetchSleep', () => {
    it('makes correct API call and filters scored non-nap records', async () => {
      const mockRecords = [
        { id: 1, score_state: 'SCORED', nap: false, score: { stage_summary: {} } },
        { id: 2, score_state: 'SCORED', nap: true, score: { stage_summary: {} } },
        { id: 3, score_state: 'PENDING_STRAIN', nap: false, score: { stage_summary: {} } },
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ records: mockRecords }), { status: 200 }),
      );

      const result = await fetchSleep('tok', '2026-04-10', '2026-04-10');
      expect(result.records).toHaveLength(1);
      expect(result.records[0]!.id).toBe(1);
      expect(result.error).toBeNull();

      const url = fetchSpy.mock.calls[0]![0] as string;
      expect(url).toContain('/v1/activity/sleep');
      expect(url).toContain('start=2026-04-10T00%3A00%3A00.000Z');
      expect(url).toContain('end=2026-04-10T23%3A59%3A59.999Z');

      const opts = fetchSpy.mock.calls[0]![1] as RequestInit;
      expect(opts.headers).toEqual({ Authorization: 'Bearer tok' });
      fetchSpy.mockRestore();
    });

    it('returns empty records and surfaces an error detail on API HTTP error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Server Error', { status: 500 }),
      );

      const result = await fetchSleep('tok', '2026-04-10', '2026-04-10');
      expect(result.records).toEqual([]);
      expect(result.error).toContain('HTTP 500');
      expect(result.error).toContain('/v1/activity/sleep');
      fetchSpy.mockRestore();
    });

    it('returns empty records and surfaces an error detail on network error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('timeout'));

      const result = await fetchSleep('tok', '2026-04-10', '2026-04-10');
      expect(result.records).toEqual([]);
      expect(result.error).toContain('timeout');
      fetchSpy.mockRestore();
    });
  });

  describe('fetchRecovery', () => {
    it('filters scored records', async () => {
      const mockRecords = [
        { cycle_id: 1, score_state: 'SCORED', score: { recovery_score: 80 } },
        { cycle_id: 2, score_state: 'PENDING_STRAIN', score: {} },
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ records: mockRecords }), { status: 200 }),
      );

      const result = await fetchRecovery('tok', '2026-04-10', '2026-04-10');
      expect(result.records).toHaveLength(1);
      expect(result.records[0]!.cycle_id).toBe(1);
      expect(result.error).toBeNull();
      fetchSpy.mockRestore();
    });

    it('surfaces error detail on HTTP error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('', { status: 500 }),
      );
      const result = await fetchRecovery('tok', '2026-04-10', '2026-04-10');
      expect(result.records).toEqual([]);
      expect(result.error).toContain('HTTP 500');
      fetchSpy.mockRestore();
    });
  });

  describe('fetchCycles', () => {
    it('filters scored records', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          records: [
            { id: 1, score_state: 'SCORED', score: { strain: 10 } },
            { id: 2, score_state: 'PENDING', score: {} },
          ],
        }), { status: 200 }),
      );

      const result = await fetchCycles('tok', '2026-04-10', '2026-04-10');
      expect(result.records).toHaveLength(1);
      expect(result.error).toBeNull();

      const url = fetchSpy.mock.calls[0]![0] as string;
      expect(url).toContain('/v1/cycle');
      fetchSpy.mockRestore();
    });
  });

  describe('fetchWorkouts', () => {
    it('filters scored records and uses correct endpoint', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          records: [
            { id: 1, score_state: 'SCORED', sport_id: 44, score: { strain: 12 } },
          ],
        }), { status: 200 }),
      );

      const result = await fetchWorkouts('tok', '2026-04-10', '2026-04-10');
      expect(result.records).toHaveLength(1);
      expect(result.error).toBeNull();

      const url = fetchSpy.mock.calls[0]![0] as string;
      expect(url).toContain('/v1/activity/workout');
      fetchSpy.mockRestore();
    });

    it('returns empty records with error=null when API returns zero records', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ records: [] }), { status: 200 }),
      );

      const result = await fetchWorkouts('tok', '2026-04-10', '2026-04-10');
      expect(result.records).toEqual([]);
      expect(result.error).toBeNull();
      fetchSpy.mockRestore();
    });
  });

  describe('exchangeCode', () => {
    it('stores tokens on successful exchange', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          access_token: 'new-at',
          refresh_token: 'new-rt',
          expires_in: 7200,
          token_type: 'Bearer',
          scope: 'read:recovery',
        }), { status: 200 }),
      );

      const result = await exchangeCode('auth-code', 'http://localhost:3847/whoop/callback');
      expect(result).toBe(true);
      expect(storeTokensMock).toHaveBeenCalledWith('new-at', 'new-rt', expect.any(Number));
      fetchSpy.mockRestore();
    });

    it('returns false on non-OK response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Bad Request', { status: 400 }),
      );

      const result = await exchangeCode('bad-code', 'http://localhost:3847/whoop/callback');
      expect(result).toBe(false);
      expect(storeTokensMock).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('returns false on network error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

      const result = await exchangeCode('code', 'http://localhost:3847/whoop/callback');
      expect(result).toBe(false);
      fetchSpy.mockRestore();
    });
  });
});
