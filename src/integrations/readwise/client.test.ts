import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../config.js', () => ({
  default: {
    TIMEZONE: 'America/Chicago',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 123,
    READWISE_TOKEN: '',
  },
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

// Import config mock so we can override READWISE_TOKEN per test
import config from '../../config.js';

const { saveToReadwise } = await import('./client.js');

describe('saveToReadwise', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    // Reset token to empty before each test
    (config as Record<string, unknown>)['READWISE_TOKEN'] = '';
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  it('returns failure without calling fetch when no token is configured', async () => {
    fetchSpy = vi.spyOn(global, 'fetch');
    (config as Record<string, unknown>)['READWISE_TOKEN'] = '';

    const result = await saveToReadwise('https://example.com/article');

    expect(result.success).toBe(false);
    expect(result.error).toContain('READWISE_TOKEN');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns success on HTTP 200', async () => {
    (config as Record<string, unknown>)['READWISE_TOKEN'] = 'test-token-abc';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    );

    const result = await saveToReadwise('https://example.com/article');

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns success on HTTP 201 (created)', async () => {
    (config as Record<string, unknown>)['READWISE_TOKEN'] = 'test-token-abc';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 201 }),
    );

    const result = await saveToReadwise('https://example.com/article', 'My Title');
    expect(result.success).toBe(true);
  });

  it('returns failure with HTTP status on 4xx response', async () => {
    (config as Record<string, unknown>)['READWISE_TOKEN'] = 'test-token-abc';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('Bad request', { status: 400 }),
    );

    const result = await saveToReadwise('https://example.com/article');

    expect(result.success).toBe(false);
    expect(result.error).toContain('400');
  });

  it('returns failure on 401 unauthorized', async () => {
    (config as Record<string, unknown>)['READWISE_TOKEN'] = 'bad-token';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    const result = await saveToReadwise('https://example.com/article');

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
  });

  it('returns failure when fetch throws a network error', async () => {
    (config as Record<string, unknown>)['READWISE_TOKEN'] = 'test-token-abc';
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValueOnce(
      new Error('Network unreachable'),
    );

    const result = await saveToReadwise('https://example.com/article');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network unreachable');
  });

  it('passes title in request body when provided', async () => {
    (config as Record<string, unknown>)['READWISE_TOKEN'] = 'test-token-abc';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    );

    await saveToReadwise('https://example.com', 'Custom Title');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const callArgs = fetchSpy.mock.calls[0];
    const body = JSON.parse((callArgs![1] as RequestInit).body as string);
    expect(body.title).toBe('Custom Title');
    expect(body.url).toBe('https://example.com');
  });
});
