/**
 * Test suite for `src/server/mcp-oauth.ts` — project 16-claude-app-connector,
 * Phase 2, test-plan.md §7 "MCP single-user OAuth".
 *
 * Written TEST-FIRST: the implementation module does not exist yet.
 * ALL tests in this file are expected to be RED until the implementation lands.
 *
 * Contract under test (future src/server/mcp-oauth.ts):
 *
 *   export interface McpOAuthDeps {
 *     gateSecret: string;       // RUNE_HTTP_SECRET — the human-approval gate
 *     userId: string;           // the ONE known user id every token binds to
 *     now?: () => number;       // injectable clock (expiry tests)
 *     tokenTtlMs?: number;      // access-token TTL (default 1h)
 *   }
 *   export interface McpOAuth {
 *     handleOAuthRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
 *     verifyBearer(req: IncomingMessage): Promise<boolean>;
 *   }
 *   export function createMcpOAuth(deps: McpOAuthDeps): McpOAuth;
 *
 * AUTHORIZE GATE DESIGN (security-reviewed): the gate secret is NEVER carried
 * in a URL. GET /mcp/oauth/authorize?<oauth params> renders a consent page
 * (200) — no code is issued. The human then POSTs the form
 * (application/x-www-form-urlencoded: the oauth params + `secret`) to the
 * same path; only a correct secret yields the 302 redirect carrying the
 * code. Query strings land in tunnel/server logs and browser history — a
 * GET-with-secret contract would bake the RUNE_HTTP_SECRET into all of
 * them. The 302 Location must never echo the secret.
 *
 * Mechanics:
 *   - Dynamic import via a computed specifier defeats tsc static resolution so
 *     this file is tsc-clean before the module exists.
 *   - Every test calls requireMcpOAuth() first; when the module is absent the
 *     test fails with a clean "implementation pending" message rather than an
 *     import crash.
 *   - Tests spin up a bare node:http server whose handler routes through
 *     oauth.handleOAuthRoute and falls back to 404 for unrecognised paths.
 *     This is intentionally NOT startHttpServer — daemon-wiring is the impl
 *     task's job; these tests focus on the OAuth module contract only.
 *   - PKCE S256: code_challenge = base64url(sha256(code_verifier)) computed in
 *     test helpers with node:crypto.
 *   - NOTE for the implementer: createMcpOAuth must return INSTANCE-scoped
 *     state (clients/codes/tokens). Module-level singleton stores would leak
 *     across tests (the dynamic import is cached) and break this suite.
 *   - The fixture userId is 'alice' — a deliberately fictional placeholder
 *     (production binds the real operator id from config).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';

// ---------------------------------------------------------------------------
// Config mock — vi.hoisted() so the factory sees it before any import is run.
// Mirrors mcp-transport.test.ts; only fields the OAuth module might import
// transitively need to be present.
// ---------------------------------------------------------------------------

const mockConfig = vi.hoisted(() => ({
  HTTP_PORT: 0,
  HTTP_HOST: '127.0.0.1',
  TIMEZONE: 'America/Chicago',
  VAULT_DIR: '/test/vault',
  RUNE_HTTP_SECRET: 'test-secret',
  RUNE_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),
  TELEGRAM_USER_ID: 0,
}));

vi.mock('../config.js', () => ({
  default: mockConfig,
}));

// ---------------------------------------------------------------------------
// Dynamic import guard — computed specifier bypasses tsc static resolution.
// ---------------------------------------------------------------------------

const IMPL_PENDING =
  'src/server/mcp-oauth.ts not implemented yet — implementation pending';

// ---------------------------------------------------------------------------
// Local type declarations — shadow the future module's public surface so
// this file is tsc-clean today while the implementation module does not exist.
// ---------------------------------------------------------------------------

interface McpOAuthDeps {
  gateSecret: string;
  userId: string;
  now?: () => number;
  /** null = never-expire; undefined = default 1h; else the given ms. */
  tokenTtlMs?: number | null;
  /** Persistence seam: load on create, save on every state mutation. */
  loadState?: () => unknown;
  saveState?: (state: unknown) => void;
}

interface McpOAuth {
  handleOAuthRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  verifyBearer(req: IncomingMessage): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// PKCE S256 helpers (node:crypto — no import of the impl module needed)
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

function randomVerifier(): string {
  return base64url(randomBytes(32));
}

// ---------------------------------------------------------------------------
// Raw HTTP helpers
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function rawReq(
  opts: http.RequestOptions & { body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode!,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body,
        }),
      );
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function urlEncoded(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

const REDIRECT_URI = 'http://localhost:9999/cb';

/** Parse a Location header value, tolerating a relative path. */
function parseLocation(loc: string): URL {
  return new URL(loc.startsWith('http') ? loc : `http://127.0.0.1${loc}`);
}

/** POST the consent form to /mcp/oauth/authorize (the human gate). The
 *  secret travels in the form BODY, never a URL. Pass secret: undefined to
 *  omit the field entirely (the missing-secret case). */
async function postAuthorize(
  port: number,
  params: Record<string, string>,
  secret: string | undefined,
): Promise<RawResponse> {
  const body = urlEncoded({ ...params, ...(secret !== undefined ? { secret } : {}) });
  return rawReq({
    host: '127.0.0.1',
    port,
    path: '/mcp/oauth/authorize',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body).toString(),
    },
    body,
  });
}

/** DCR helper — registers the test client, returns client_id. */
async function registerClient(port: number): Promise<string> {
  const dcrBody = JSON.stringify({
    redirect_uris: [REDIRECT_URI],
    client_name: 'claude-app',
  });
  const dcrRes = await rawReq({
    host: '127.0.0.1',
    port,
    path: '/mcp/oauth/register',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(dcrBody).toString(),
    },
    body: dcrBody,
  });
  if (dcrRes.status !== 201) {
    throw new Error(`DCR failed: status=${dcrRes.status} body=${dcrRes.body}`);
  }
  return (JSON.parse(dcrRes.body) as { client_id: string }).client_id;
}

/** Extract the authorization code from a 302 authorize response, asserting
 *  the redirect preserves state and NEVER echoes the gate secret. */
function codeFromRedirect(authRes: RawResponse, expectedState: string, gateSecret: string): string {
  if (authRes.status !== 302) {
    throw new Error(`authorize failed: status=${authRes.status} body=${authRes.body}`);
  }
  const location = authRes.headers['location'] as string;
  if (!location) throw new Error('authorize did not return a Location header');
  if (location.includes(gateSecret)) {
    throw new Error('SECURITY: the gate secret leaked into the redirect Location');
  }
  const locationUrl = parseLocation(location);
  if (locationUrl.searchParams.has('secret')) {
    throw new Error('SECURITY: a secret parameter leaked into the redirect Location');
  }
  const code = locationUrl.searchParams.get('code');
  if (!code) throw new Error(`No code in Location: ${location}`);
  const returnedState = locationUrl.searchParams.get('state');
  if (returnedState !== expectedState) {
    throw new Error(`State mismatch: expected=${expectedState} got=${returnedState}`);
  }
  return code;
}

/** Exchange an authorization code at the token endpoint. */
async function exchangeToken(
  port: number,
  fields: Record<string, string>,
): Promise<RawResponse> {
  const tokenBody = urlEncoded(fields);
  return rawReq({
    host: '127.0.0.1',
    port,
    path: '/mcp/oauth/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(tokenBody).toString(),
    },
    body: tokenBody,
  });
}

// ---------------------------------------------------------------------------
// Test-server factory — bare node:http, NOT startHttpServer.
// ---------------------------------------------------------------------------

async function startTestServer(oauth: McpOAuth): Promise<{ server: Server; port: number }> {
  const server = http.createServer(async (req, res) => {
    try {
      const handled = await oauth.handleOAuthRoute(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
  return { server, port };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Red guard + factory — dynamic import via computed specifier (bypasses tsc
// static resolution); fails THIS test with the pending message while the
// module is absent, otherwise returns the typed createMcpOAuth factory.
// ---------------------------------------------------------------------------

async function requireMcpOAuth(): Promise<(deps: McpOAuthDeps) => McpOAuth> {
  const specifier = './mcp-oauth' + '.js';
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    if (typeof mod.createMcpOAuth === 'function') {
      return mod.createMcpOAuth as (deps: McpOAuthDeps) => McpOAuth;
    }
  } catch {
    // fall through to the pending failure
  }
  expect.fail(IMPL_PENDING);
}

// ---------------------------------------------------------------------------
// Full happy-path flow helper: DCR → consent POST (secret in body) → token.
// ---------------------------------------------------------------------------

async function happyFlow(
  port: number,
  gateSecret: string,
): Promise<{ access_token: string; token_type: string; expires_in: number }> {
  const client_id = await registerClient(port);

  const codeVerifier = randomVerifier();
  const codeChallenge = pkceChallenge(codeVerifier);
  const state = 'test-state-xyz';

  const authRes = await postAuthorize(
    port,
    {
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT_URI,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    },
    gateSecret,
  );
  const code = codeFromRedirect(authRes, state, gateSecret);

  const tokenRes = await exchangeToken(port, {
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id,
    redirect_uri: REDIRECT_URI,
  });
  if (tokenRes.status !== 200) {
    throw new Error(`token exchange failed: status=${tokenRes.status} body=${tokenRes.body}`);
  }
  const tokenJson = JSON.parse(tokenRes.body) as {
    access_token: string;
    token_type: string;
    expires_in: number;
  };
  return tokenJson;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('server/mcp-oauth (§7 MCP single-user OAuth)', () => {
  const openServers: Server[] = [];

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map(closeServer));
  });

  // -------------------------------------------------------------------------
  // Test 1 🔴 — verifyBearer rejects without a valid token
  // -------------------------------------------------------------------------
  it('1: verifyBearer rejects missing token and garbage token — never throws', async () => {
    const factory = await requireMcpOAuth(); // red guard
    const oauth = factory({ gateSecret: 'gate-secret', userId: 'alice' });

    // (a) No Authorization header at all
    const reqNoAuth = { headers: {} } as unknown as IncomingMessage;
    await expect(oauth.verifyBearer(reqNoAuth)).resolves.toBe(false);

    // (b) Bearer garbage — malformed / unknown token
    const reqGarbage = {
      headers: { authorization: 'Bearer garbage-not-a-real-token' },
    } as unknown as IncomingMessage;
    await expect(oauth.verifyBearer(reqGarbage)).resolves.toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 2 🔴 — Happy path: consent flow issues a usable Bearer token
  //
  // Pins: DCR 201 + client_id; GET /mcp/oauth/authorize renders the consent
  // page (200, no code issued); the consent POST (secret in the form body)
  // 302-redirects with code + preserved state and never echoes the secret;
  // token endpoint returns access_token + token_type 'Bearer' + positive
  // expires_in; verifyBearer accepts the issued token.
  // -------------------------------------------------------------------------
  it('2: full DCR→consent→token flow issues a Bearer access_token that verifyBearer accepts', async () => {
    const factory = await requireMcpOAuth(); // red guard
    const gateSecret = 'super-secret-gate';
    const oauth = factory({ gateSecret, userId: 'alice' });
    const { server, port } = await startTestServer(oauth);
    openServers.push(server);

    // The GET form render: no secret anywhere, no code issued.
    const client_id = await registerClient(port);
    const getParams = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT_URI,
      state: 'get-state',
      code_challenge: pkceChallenge(randomVerifier()),
      code_challenge_method: 'S256',
    });
    const formRes = await rawReq({
      host: '127.0.0.1',
      port,
      path: `/mcp/oauth/authorize?${getParams.toString()}`,
      method: 'GET',
      headers: {},
    });
    expect(formRes.status).toBe(200); // consent page, NOT a redirect
    expect(formRes.headers['location']).toBeUndefined();

    // Full flow
    const { access_token, token_type, expires_in } = await happyFlow(port, gateSecret);

    expect(typeof access_token).toBe('string');
    expect(access_token.length).toBeGreaterThan(0);
    expect(token_type).toBe('Bearer');
    expect(expires_in).toBeGreaterThan(0);

    const reqWithToken = {
      headers: { authorization: `Bearer ${access_token}` },
    } as unknown as IncomingMessage;
    await expect(oauth.verifyBearer(reqWithToken)).resolves.toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3 🔴 — Gate on RUNE_HTTP_SECRET (the consent POST)
  //
  // Wrong or missing secret in the consent POST → 401-403, NO code in any
  // Location header; a fabricated code must not exchange.
  // -------------------------------------------------------------------------
  it('3: consent POST with wrong/missing secret → 401-403, no code, no usable token', async () => {
    const factory = await requireMcpOAuth(); // red guard
    const gateSecret = 'correct-secret';
    const oauth = factory({ gateSecret, userId: 'alice' });
    const { server, port } = await startTestServer(oauth);
    openServers.push(server);

    const client_id = await registerClient(port);
    const codeVerifier = randomVerifier();
    const codeChallenge = pkceChallenge(codeVerifier);
    const baseParams = {
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    };

    // (a) Wrong secret
    const wrongRes = await postAuthorize(port, { ...baseParams, state: 'st1' }, 'wrong-secret');
    expect(wrongRes.status).toBeGreaterThanOrEqual(401);
    expect(wrongRes.status).toBeLessThanOrEqual(403);
    const loc = wrongRes.headers['location'] as string | undefined;
    if (loc) {
      expect(parseLocation(loc).searchParams.has('code')).toBe(false);
    }

    // (b) Missing secret
    const missingRes = await postAuthorize(port, { ...baseParams, state: 'st2' }, undefined);
    expect(missingRes.status).toBeGreaterThanOrEqual(401);
    expect(missingRes.status).toBeLessThanOrEqual(403);
    const loc2 = missingRes.headers['location'] as string | undefined;
    if (loc2) {
      expect(parseLocation(loc2).searchParams.has('code')).toBe(false);
    }

    // (c) A fabricated code (no gate passed) must not exchange
    const fabricated = await exchangeToken(port, {
      grant_type: 'authorization_code',
      code: 'made-up-code-12345',
      code_verifier: codeVerifier,
      client_id,
      redirect_uri: REDIRECT_URI,
    });
    expect(fabricated.status).not.toBe(200);
  });

  // -------------------------------------------------------------------------
  // Test 4 🔴 — Single-user binding
  //
  // A token issued by an instance with userId 'alice' must verify on that
  // instance and be rejected by a fresh instance configured with userId
  // 'mallory'. LIMITATION (documented for the implementer): the fresh
  // instance has a fresh store, so this test cannot distinguish
  // "token unknown" from "userId mismatch" — the implementation must ALSO
  // store the bound userId on each token record and compare it against
  // deps.userId in verifyBearer; that requirement is part of the contract
  // (spec R4 req 15) even though only the observable half is pinned here.
  // -------------------------------------------------------------------------
  it('4: tokens bind to the configured userId — rejected by a different userId instance', async () => {
    const factory = await requireMcpOAuth(); // red guard
    const gateSecret = 'gate';

    const aliceOauth = factory({ gateSecret, userId: 'alice' });
    const { server, port } = await startTestServer(aliceOauth);
    openServers.push(server);

    const { access_token } = await happyFlow(port, gateSecret);

    // (a) alice's instance accepts the token
    const reqAlice = {
      headers: { authorization: `Bearer ${access_token}` },
    } as unknown as IncomingMessage;
    await expect(aliceOauth.verifyBearer(reqAlice)).resolves.toBe(true);

    // (b) a fresh mallory instance must reject the same token
    const malloryOauth = factory({ gateSecret, userId: 'mallory' });
    const reqMallory = {
      headers: { authorization: `Bearer ${access_token}` },
    } as unknown as IncomingMessage;
    await expect(malloryOauth.verifyBearer(reqMallory)).resolves.toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 5 🟡 — Expired token (injectable clock)
  // -------------------------------------------------------------------------
  it('5: expired token → verifyBearer returns false', async () => {
    const factory = await requireMcpOAuth(); // red guard
    let clock = 1_000_000; // arbitrary start epoch in ms
    const gateSecret = 'gate';
    const ttlMs = 1000;
    const oauth = factory({
      gateSecret,
      userId: 'alice',
      now: () => clock,
      tokenTtlMs: ttlMs,
    });
    const { server, port } = await startTestServer(oauth);
    openServers.push(server);

    const { access_token } = await happyFlow(port, gateSecret);

    const req = {
      headers: { authorization: `Bearer ${access_token}` },
    } as unknown as IncomingMessage;
    await expect(oauth.verifyBearer(req)).resolves.toBe(true);

    clock += ttlMs + 1;
    await expect(oauth.verifyBearer(req)).resolves.toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 6 🟡 — Replayed authorization code → 400 on the second exchange
  // -------------------------------------------------------------------------
  it('6: replayed authorization code → 400 on second exchange', async () => {
    const factory = await requireMcpOAuth(); // red guard
    const gateSecret = 'gate';
    const oauth = factory({ gateSecret, userId: 'alice' });
    const { server, port } = await startTestServer(oauth);
    openServers.push(server);

    const client_id = await registerClient(port);
    const codeVerifier = randomVerifier();
    const authRes = await postAuthorize(
      port,
      {
        response_type: 'code',
        client_id,
        redirect_uri: REDIRECT_URI,
        state: 'st',
        code_challenge: pkceChallenge(codeVerifier),
        code_challenge_method: 'S256',
      },
      gateSecret,
    );
    const code = codeFromRedirect(authRes, 'st', gateSecret);

    const fields = {
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id,
      redirect_uri: REDIRECT_URI,
    };

    const firstToken = await exchangeToken(port, fields);
    expect(firstToken.status).toBe(200);

    // Second exchange with the SAME code — must be rejected
    const secondToken = await exchangeToken(port, fields);
    expect(secondToken.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Test 7 🟡 — Bad PKCE verifier → 400
  // -------------------------------------------------------------------------
  it('7: wrong PKCE code_verifier → 400, no token', async () => {
    const factory = await requireMcpOAuth(); // red guard
    const gateSecret = 'gate';
    const oauth = factory({ gateSecret, userId: 'alice' });
    const { server, port } = await startTestServer(oauth);
    openServers.push(server);

    const client_id = await registerClient(port);
    const realVerifier = randomVerifier();
    const authRes = await postAuthorize(
      port,
      {
        response_type: 'code',
        client_id,
        redirect_uri: REDIRECT_URI,
        state: 'st',
        code_challenge: pkceChallenge(realVerifier),
        code_challenge_method: 'S256',
      },
      gateSecret,
    );
    const code = codeFromRedirect(authRes, 'st', gateSecret);

    const tokenRes = await exchangeToken(port, {
      grant_type: 'authorization_code',
      code,
      code_verifier: randomVerifier(), // intentionally wrong
      client_id,
      redirect_uri: REDIRECT_URI,
    });
    expect(tokenRes.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Test 8 🟡 — PKCE 'plain' (and absent method) rejected — OAuth 2.1 is
  // S256-only. With 'plain', anyone who sees the authorize request already
  // holds the verifier, so intercepting the code suffices to exchange it.
  // -------------------------------------------------------------------------
  it('8: code_challenge_method plain (or missing) → 4xx, no code issued', async () => {
    const factory = await requireMcpOAuth(); // red guard
    const gateSecret = 'gate';
    const oauth = factory({ gateSecret, userId: 'alice' });
    const { server, port } = await startTestServer(oauth);
    openServers.push(server);

    const client_id = await registerClient(port);

    for (const method of ['plain', undefined] as const) {
      const params: Record<string, string> = {
        response_type: 'code',
        client_id,
        redirect_uri: REDIRECT_URI,
        state: 'st',
        code_challenge: 'raw-plain-challenge-value',
      };
      if (method !== undefined) params.code_challenge_method = method;

      const res = await postAuthorize(port, params, gateSecret);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const loc = res.headers['location'] as string | undefined;
      if (loc) {
        const locUrl = new URL(loc.startsWith('http') ? loc : `http://x${loc}`);
        expect(locUrl.searchParams.has('code')).toBe(false);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Test 9 🟡 — redirect_uri mismatch at token exchange → 400 (RFC 6749
  // §4.1.3 binding: the token request must present the same redirect_uri the
  // code was issued against).
  // -------------------------------------------------------------------------
  it('9: redirect_uri mismatch between authorize and token exchange → 400', async () => {
    const factory = await requireMcpOAuth(); // red guard
    const gateSecret = 'gate';
    const oauth = factory({ gateSecret, userId: 'alice' });
    const { server, port } = await startTestServer(oauth);
    openServers.push(server);

    const client_id = await registerClient(port);
    const codeVerifier = randomVerifier();
    const authRes = await postAuthorize(
      port,
      {
        response_type: 'code',
        client_id,
        redirect_uri: REDIRECT_URI,
        state: 'st',
        code_challenge: pkceChallenge(codeVerifier),
        code_challenge_method: 'S256',
      },
      gateSecret,
    );
    const code = codeFromRedirect(authRes, 'st', gateSecret);

    const tokenRes = await exchangeToken(port, {
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id,
      redirect_uri: 'http://attacker.example/cb', // mismatched on purpose
    });
    expect(tokenRes.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Test 10 🟢 — verifyBearer is a pure boolean — never throws
  // -------------------------------------------------------------------------
  it('10: verifyBearer never throws — resolves to false for any garbage input', async () => {
    const factory = await requireMcpOAuth(); // red guard
    const oauth = factory({ gateSecret: 'gate', userId: 'alice' });

    const garbageRequests = [
      { headers: {} },
      { headers: { 'content-type': 'application/json' } },
      { headers: { authorization: 'Basic dXNlcjpwYXNz' } },
      { headers: { authorization: 'Bearer ' } },
      { headers: { authorization: 'Bearer   ' } },
      { headers: { authorization: 'not-a-valid-auth-header' } },
      { headers: { authorization: undefined } },
    ] as unknown as IncomingMessage[];

    for (const req of garbageRequests) {
      await expect(oauth.verifyBearer(req)).resolves.toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // Test 11 🟢 — OAuth metadata endpoint (RFC 8414)
  //
  // The root path is intentional: the daemon mounts at origin-root, and the
  // MCP SDK client falls back to root discovery when the path-aware
  // /.well-known/oauth-authorization-server/mcp variant 404s.
  // `issuer` is REQUIRED by RFC 8414 §2 and by the SDK's OAuthMetadataSchema;
  // S256 must be advertised so the client knows PKCE is supported.
  // -------------------------------------------------------------------------
  it('11: GET /.well-known/oauth-authorization-server → 200 JSON with issuer + endpoints + S256', async () => {
    const factory = await requireMcpOAuth(); // red guard
    const oauth = factory({ gateSecret: 'gate', userId: 'alice' });
    const { server, port } = await startTestServer(oauth);
    openServers.push(server);

    const res = await rawReq({
      host: '127.0.0.1',
      port,
      path: '/.well-known/oauth-authorization-server',
      method: 'GET',
      headers: {},
    });

    expect(res.status).toBe(200);

    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      expect.fail('OAuth metadata response body is not valid JSON');
    }

    expect(typeof metadata['issuer']).toBe('string');
    expect((metadata['issuer'] as string).length).toBeGreaterThan(0);

    expect(typeof metadata['authorization_endpoint']).toBe('string');
    expect((metadata['authorization_endpoint'] as string).length).toBeGreaterThan(0);

    expect(typeof metadata['token_endpoint']).toBe('string');
    expect((metadata['token_endpoint'] as string).length).toBeGreaterThan(0);

    expect(metadata['code_challenge_methods_supported']).toContain('S256');
  });

  // -------------------------------------------------------------------------
  // Test 12 🔴 — persisted tokens survive a "restart"
  //
  // saveState captures the store; a SECOND instance loading it (the restart)
  // must verify a token the FIRST instance issued. Round-tripped through JSON
  // to pin serializability (no Map/Infinity leaking into the store).
  // -------------------------------------------------------------------------
  it('12: a token issued before a restart verifies after, via the persistence seam', async () => {
    const factory = await requireMcpOAuth();
    const gateSecret = 'gate';
    let saved: unknown = null;

    const before = factory({
      gateSecret,
      userId: 'alice',
      tokenTtlMs: null,
      saveState: (s) => { saved = JSON.parse(JSON.stringify(s)); },
      loadState: () => saved,
    });
    const { server, port } = await startTestServer(before);
    openServers.push(server);

    const { access_token } = await happyFlow(port, gateSecret);
    expect(saved, 'saveState must be called when a token is issued').not.toBeNull();

    // "Restart": a fresh instance loads the persisted store (no server needed).
    const after = factory({ gateSecret, userId: 'alice', tokenTtlMs: null, loadState: () => saved });
    const req = { headers: { authorization: `Bearer ${access_token}` } } as unknown as IncomingMessage;
    await expect(after.verifyBearer(req)).resolves.toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 13 🔴 — tokenTtlMs:null tokens never expire
  // -------------------------------------------------------------------------
  it('13: tokenTtlMs:null → token stays valid arbitrarily far in the future', async () => {
    const factory = await requireMcpOAuth();
    let clock = 1_000_000;
    const gateSecret = 'gate';
    const oauth = factory({ gateSecret, userId: 'alice', now: () => clock, tokenTtlMs: null });
    const { server, port } = await startTestServer(oauth);
    openServers.push(server);

    const { access_token } = await happyFlow(port, gateSecret);
    const req = { headers: { authorization: `Bearer ${access_token}` } } as unknown as IncomingMessage;
    await expect(oauth.verifyBearer(req)).resolves.toBe(true);

    clock += 1000 * 60 * 60 * 24 * 365 * 5; // +5 years
    await expect(oauth.verifyBearer(req)).resolves.toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 14 🟢 — revocation: a restart with a wiped store rejects the old token
  //
  // "Delete the store file + restart" → loadState returns null → the token
  // is unknown to the new instance.
  // -------------------------------------------------------------------------
  it('14: a restart with an empty store (revoked) rejects the previously-issued token', async () => {
    const factory = await requireMcpOAuth();
    const gateSecret = 'gate';
    let saved: unknown = null;

    const before = factory({
      gateSecret,
      userId: 'alice',
      tokenTtlMs: null,
      saveState: (s) => { saved = JSON.parse(JSON.stringify(s)); },
      loadState: () => saved,
    });
    const { server, port } = await startTestServer(before);
    openServers.push(server);
    const { access_token } = await happyFlow(port, gateSecret);

    // Store wiped (revocation): the post-restart instance loads nothing.
    const after = factory({ gateSecret, userId: 'alice', tokenTtlMs: null, loadState: () => null });
    const req = { headers: { authorization: `Bearer ${access_token}` } } as unknown as IncomingMessage;
    await expect(after.verifyBearer(req)).resolves.toBe(false);
  });
});
