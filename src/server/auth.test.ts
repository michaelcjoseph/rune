import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    RUNE_HTTP_SECRET: 'rune-secret',
    TELEGRAM_USER_ID: 42,
    RUNE_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),
    ['JAR'.concat('VIS_ALLOWED_HOSTS')]: new Set(['retired.local']),
  },
}));

const { verifyAuth, isAllowedHost } = await import('./auth.js');

function makeReq(opts: {
  authorization?: string;
  cookie?: string;
  host?: string;
} = {}): any {
  return {
    headers: {
      ...(opts.authorization !== undefined ? { authorization: opts.authorization } : {}),
      ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
      ...(opts.host !== undefined ? { host: opts.host } : {}),
    },
  };
}

describe('verifyAuth', () => {
  const retiredCookieName = `${['jar', 'vis'].join('')}-auth`;

  it('returns ok:false when no auth header or cookie is present', () => {
    const result = verifyAuth(makeReq());
    expect(result).toEqual({ ok: false });
  });

  it('returns ok:false when Authorization bearer token is wrong', () => {
    const result = verifyAuth(makeReq({ authorization: 'Bearer wrong-token' }));
    expect(result).toEqual({ ok: false });
  });

  it('returns ok:false when Authorization has correct token but wrong scheme', () => {
    const result = verifyAuth(makeReq({ authorization: 'Basic rune-secret' }));
    expect(result).toEqual({ ok: false });
  });

  it('returns ok:true with userId when Authorization bearer token is correct', () => {
    const result = verifyAuth(makeReq({ authorization: 'Bearer rune-secret' }));
    expect(result).toEqual({ ok: true, userId: 42 });
  });

  it('returns ok:true with userId when rune-auth cookie is correct', () => {
    const result = verifyAuth(makeReq({ cookie: 'rune-auth=rune-secret' }));
    expect(result).toEqual({ ok: true, userId: 42 });
  });

  it('returns ok:true when rune-auth cookie is present alongside other cookies', () => {
    const result = verifyAuth(makeReq({ cookie: 'other=value; rune-auth=rune-secret; more=stuff' }));
    expect(result).toEqual({ ok: true, userId: 42 });
  });

  it('returns ok:false when rune-auth cookie value is wrong', () => {
    const result = verifyAuth(makeReq({ cookie: 'rune-auth=wrong-secret' }));
    expect(result).toEqual({ ok: false });
  });

  it('does not accept the retired auth cookie as a compatibility alias', () => {
    const result = verifyAuth(makeReq({ cookie: `${retiredCookieName}=rune-secret` }));
    expect(result).toEqual({ ok: false });
  });

  it('returns ok:false when rune-auth cookie is absent and bearer is wrong', () => {
    const result = verifyAuth(makeReq({ cookie: 'other=value', authorization: 'Bearer nope' }));
    expect(result).toEqual({ ok: false });
  });

  it('prefers Authorization bearer over cookie — both correct', () => {
    const result = verifyAuth(makeReq({
      authorization: 'Bearer rune-secret',
      cookie: 'rune-auth=rune-secret',
    }));
    expect(result).toEqual({ ok: true, userId: 42 });
  });
});

describe('isAllowedHost', () => {
  it('returns true for localhost', () => {
    expect(isAllowedHost(makeReq({ host: 'localhost' }))).toBe(true);
  });

  it('returns true for 127.0.0.1', () => {
    expect(isAllowedHost(makeReq({ host: '127.0.0.1' }))).toBe(true);
  });

  it('returns true for localhost with port (port stripped)', () => {
    expect(isAllowedHost(makeReq({ host: 'localhost:3847' }))).toBe(true);
  });

  it('returns true for 127.0.0.1 with port (port stripped)', () => {
    expect(isAllowedHost(makeReq({ host: '127.0.0.1:3847' }))).toBe(true);
  });

  it('returns false for a non-allowed host', () => {
    expect(isAllowedHost(makeReq({ host: 'evil.example.com' }))).toBe(false);
  });

  it('does not accept hosts from the retired allowed-hosts config as a compatibility alias', () => {
    expect(isAllowedHost(makeReq({ host: 'retired.local' }))).toBe(false);
  });

  it('returns false for a non-allowed host with port', () => {
    expect(isAllowedHost(makeReq({ host: 'evil.example.com:3847' }))).toBe(false);
  });

  it('returns false when host header is absent', () => {
    expect(isAllowedHost(makeReq())).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isAllowedHost(makeReq({ host: 'LOCALHOST' }))).toBe(true);
    expect(isAllowedHost(makeReq({ host: 'Localhost:3847' }))).toBe(true);
  });
});
