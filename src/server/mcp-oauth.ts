/**
 * Single-user OAuth 2.1 for the /mcp endpoint — project 16, Phase 2
 * (spec R4 req 15, test-plan §7).
 *
 * Minimal authorization server for ONE user: Dynamic Client Registration,
 * an authorization-code + PKCE (S256-only) flow whose human-approval gate is
 * the JARVIS_HTTP_SECRET, and bearer verification consumed by the /mcp
 * transport (src/server/mcp-transport.ts) on every request.
 *
 * SECURITY PROPERTIES (pinned by mcp-oauth.test.ts):
 * - The gate secret travels ONLY in the consent-form POST body — never a URL
 *   (query strings land in tunnel logs and browser history). GET /authorize
 *   renders the consent form; POST /authorize with the correct secret
 *   redirects with the code. The redirect Location never echoes the secret.
 * - PKCE is S256-only ('plain' and absent methods are rejected): with
 *   'plain', whoever sees the authorize request already holds the verifier.
 * - Authorization codes are single-use, short-lived, and bound to both the
 *   client and the redirect_uri presented at issuance.
 * - Every issued access token records the ONE configured userId; verifyBearer
 *   re-checks that binding (and expiry) on every call and never throws.
 * - All state is in-memory and instance-scoped: a daemon restart revokes all
 *   sessions (the App simply re-runs the OAuth handshake).
 */

import { randomBytes, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { safeCompare } from './auth.js';
import { readBody } from './read-body.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcp-oauth');

export interface McpOAuthDeps {
  /** The human-approval gate: authorization requires this secret (JARVIS_HTTP_SECRET). */
  gateSecret: string;
  /** The ONE known user id every issued token binds to. */
  userId: string;
  /** Injectable clock (ms epoch). */
  now?: () => number;
  /** Access-token lifetime: `null` = never expire (authenticate once, revoke
   *  by clearing the store); `undefined` = default 1h; a positive number =
   *  that TTL in ms (floored at 1ms). */
  tokenTtlMs?: number | null;
  /** Pinned issuer base URL (e.g. the public tunnel hostname). When absent,
   *  metadata falls back to the request Host header — fine locally, but a
   *  public deployment should pin it (the Host header is caller-controlled). */
  issuerBaseUrl?: string;
  /** Persistence seam — loaded once at construction, saved on every state
   *  mutation (client registered / token issued). Bound to a 0600 file in
   *  production so clients + tokens survive a daemon restart. Omitted = the
   *  legacy in-memory-only behavior (a restart revokes everything). */
  loadState?: () => PersistedOAuthState | null;
  saveState?: (state: PersistedOAuthState) => void;
}

/** Serializable snapshot of the OAuth state worth persisting. Authorization
 *  codes are deliberately NOT included — they are short-lived and mid-flow, so
 *  a restart simply re-runs the handshake. */
export interface PersistedOAuthState {
  clients: ClientRecord[];
  tokens: Array<{ token: string; userId: string; expiresAt: number | null }>;
}

export interface McpOAuth {
  /** OAuth endpoints handler — returns true when it handled the request. */
  handleOAuthRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** The verifyBearer seam mountMcpRoute consumes. Never throws. */
  verifyBearer(req: IncomingMessage): Promise<boolean>;
}

const REGISTER_PATH = '/mcp/oauth/register';
const AUTHORIZE_PATH = '/mcp/oauth/authorize';
const TOKEN_PATH = '/mcp/oauth/token';
const METADATA_PATH = '/.well-known/oauth-authorization-server';
/** RFC 8414 path-aware variant the MCP SDK client tries first for /mcp. */
const METADATA_PATH_MCP = '/.well-known/oauth-authorization-server/mcp';
/** RFC 9728 protected-resource metadata — the document the /mcp 401
 *  WWW-Authenticate challenge points at. */
const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
const RESOURCE_METADATA_PATH_MCP = '/.well-known/oauth-protected-resource/mcp';

const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
/** OAuth bodies are tiny (form fields / client metadata) — cap them hard. */
const MAX_BODY_BYTES = 64 * 1024;
/** Hard cap on dynamic client registrations — DCR is unauthenticated by
 *  spec, so an uncapped map is a flooding target on a public tunnel. One
 *  legitimate App install registers once. */
const MAX_CLIENTS = 20;

export interface ClientRecord {
  clientId: string;
  redirectUris: string[];
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
  used: boolean;
}

interface TokenRecord {
  userId: string;
  /** ms epoch, or null = never expires. */
  expiresAt: number | null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function oauthError(res: ServerResponse, status: number, error: string, description: string): void {
  sendJson(res, status, { error, error_description: description });
}

/** Minimal HTML escape for values echoed into the consent form. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function createMcpOAuth(deps: McpOAuthDeps): McpOAuth {
  const now = deps.now ?? Date.now;
  // null = never expire; undefined = default 1h; positive = that TTL.
  const tokenTtlMs: number | null =
    deps.tokenTtlMs === null ? null : Math.max(1, deps.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS);

  // Instance-scoped maps; seeded from the persistence seam (if any) so a
  // restart keeps clients + still-valid tokens. Codes are never persisted.
  const clients = new Map<string, ClientRecord>();
  const codes = new Map<string, CodeRecord>();
  const tokens = new Map<string, TokenRecord>();

  const loaded = deps.loadState?.() ?? null;
  if (loaded) {
    for (const c of loaded.clients) clients.set(c.clientId, c);
    for (const t of loaded.tokens) {
      // Drop already-expired tokens at load so the store self-prunes.
      if (t.expiresAt !== null && t.expiresAt <= now()) continue;
      tokens.set(t.token, { userId: t.userId, expiresAt: t.expiresAt });
    }
  }

  /** Persist the current clients + tokens. Best-effort: the saveState binding
   *  swallows disk errors, so a write failure degrades to in-memory-only
   *  (works until the next restart) rather than breaking the request. */
  function persist(): void {
    deps.saveState?.({
      clients: [...clients.values()],
      tokens: [...tokens.entries()].map(([token, rec]) => ({
        token,
        userId: rec.userId,
        expiresAt: rec.expiresAt,
      })),
    });
  }

  function issuerFor(req: IncomingMessage): string {
    // Prefer the pinned issuer; the Host header is caller-controlled and only
    // acceptable as a local fallback (documented on McpOAuthDeps).
    return deps.issuerBaseUrl ?? `http://${req.headers.host ?? 'localhost'}`;
  }

  function handleMetadata(req: IncomingMessage, res: ServerResponse): void {
    const issuer = issuerFor(req);
    sendJson(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
      token_endpoint: `${issuer}${TOKEN_PATH}`,
      registration_endpoint: `${issuer}${REGISTER_PATH}`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }

  /** RFC 9728 protected-resource metadata — the /mcp 401 challenge points
   *  here; it names the authorization server (this same daemon). */
  function handleResourceMetadata(req: IncomingMessage, res: ServerResponse): void {
    const issuer = issuerFor(req);
    sendJson(res, 200, {
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
    });
  }

  async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, MAX_BODY_BYTES));
    } catch {
      oauthError(res, 400, 'invalid_client_metadata', 'Body must be valid JSON');
      return;
    }
    const redirectUris = (body as { redirect_uris?: unknown }).redirect_uris;
    const isHttpUri = (u: unknown): boolean => {
      if (typeof u !== 'string' || u.length === 0) return false;
      try {
        const parsed = new URL(u);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    };
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(isHttpUri)) {
      oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be a non-empty array of http(s) URLs');
      return;
    }

    // DCR is unauthenticated by spec — cap registrations so the map can't be
    // flooded from a public tunnel.
    if (clients.size >= MAX_CLIENTS) {
      oauthError(res, 429, 'too_many_requests', 'Client registration limit reached');
      return;
    }

    const clientId = randomBytes(16).toString('base64url');
    clients.set(clientId, { clientId, redirectUris: redirectUris as string[] });
    persist();
    log.info('Registered OAuth client', { clientId });
    sendJson(res, 201, {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
  }

  interface AuthorizeParams {
    response_type?: string;
    client_id?: string;
    redirect_uri?: string;
    state?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    secret?: string;
  }

  /** Validate the OAuth half of an authorize request (everything except the
   *  secret). Returns an error message or null. */
  function validateAuthorizeParams(p: AuthorizeParams): string | null {
    if (p.response_type !== 'code') return "response_type must be 'code'";
    const client = p.client_id ? clients.get(p.client_id) : undefined;
    if (!client) return 'unknown client_id';
    if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri)) {
      return 'redirect_uri is not registered for this client';
    }
    if (!p.code_challenge) return 'code_challenge is required (PKCE)';
    if (p.code_challenge_method !== 'S256') {
      return "code_challenge_method must be 'S256' (PKCE plain is not allowed)";
    }
    return null;
  }

  function handleAuthorizeGet(req: IncomingMessage, res: ServerResponse): void {
    // Render the consent form. The OAuth params ride as hidden fields; the
    // human types the gate secret into the form — it never appears in a URL.
    const url = new URL(req.url ?? '', 'http://localhost');
    const fields = [
      'response_type',
      'client_id',
      'redirect_uri',
      'state',
      'code_challenge',
      'code_challenge_method',
    ]
      .map((name) => {
        const value = url.searchParams.get(name) ?? '';
        return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
      })
      .join('\n      ');
    // Anti-phishing: show the human WHERE the authorization code will be
    // sent. DCR is unauthenticated, so an attacker can register a client
    // with their own redirect_uri and send the owner a consent link — the
    // destination is the one signal that exposes that.
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    let destination = '(invalid redirect_uri)';
    try {
      destination = new URL(redirectUri).host;
    } catch {
      /* leave the invalid marker */
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // Anti-clickjacking: never allow this form to render in a frame.
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    });
    res.end(`<!doctype html>
<html>
  <head><title>Jarvis MCP — authorize</title></head>
  <body>
    <h1>Authorize Claude App access to Jarvis</h1>
    <p>The authorization code will be sent to: <strong>${escapeHtml(destination)}</strong></p>
    <p>Only approve if YOU initiated this connection. Enter the Jarvis HTTP secret to approve.</p>
    <form method="POST" action="${AUTHORIZE_PATH}">
      ${fields}
      <input type="password" name="secret" autocomplete="off" placeholder="JARVIS_HTTP_SECRET">
      <button type="submit">Approve</button>
    </form>
  </body>
</html>`);
  }

  async function handleAuthorizePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let params: AuthorizeParams;
    try {
      params = Object.fromEntries(new URLSearchParams(await readBody(req, MAX_BODY_BYTES))) as AuthorizeParams;
    } catch {
      oauthError(res, 400, 'invalid_request', 'Body must be application/x-www-form-urlencoded');
      return;
    }

    // The human gate first: without the secret nothing else is disclosed.
    if (!params.secret || !safeCompare(params.secret, deps.gateSecret)) {
      log.warn('OAuth authorize rejected: bad gate secret');
      oauthError(res, 401, 'access_denied', 'Invalid authorization secret');
      return;
    }

    const validationError = validateAuthorizeParams(params);
    if (validationError !== null) {
      oauthError(res, 400, 'invalid_request', validationError);
      return;
    }

    const code = randomBytes(32).toString('base64url');
    codes.set(code, {
      clientId: params.client_id!,
      redirectUri: params.redirect_uri!,
      codeChallenge: params.code_challenge!,
      expiresAt: now() + CODE_TTL_MS,
      used: false,
    });

    const redirect = new URL(params.redirect_uri!);
    redirect.searchParams.set('code', code);
    if (params.state) redirect.searchParams.set('state', params.state);
    log.info('OAuth authorization granted', { clientId: params.client_id });
    res.writeHead(302, { Location: redirect.toString() });
    res.end();
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let params: Record<string, string>;
    try {
      params = Object.fromEntries(new URLSearchParams(await readBody(req, MAX_BODY_BYTES)));
    } catch {
      oauthError(res, 400, 'invalid_request', 'Body must be application/x-www-form-urlencoded');
      return;
    }

    if (params.grant_type !== 'authorization_code') {
      oauthError(res, 400, 'unsupported_grant_type', "grant_type must be 'authorization_code'");
      return;
    }

    const record = params.code ? codes.get(params.code) : undefined;
    if (!record || record.used || record.expiresAt <= now()) {
      // Lazy reap: an expired code encountered here is gone for good.
      if (record && params.code) codes.delete(params.code);
      oauthError(res, 400, 'invalid_grant', 'Unknown, expired, or already-used authorization code');
      return;
    }
    if (params.client_id !== record.clientId) {
      oauthError(res, 400, 'invalid_grant', 'client_id does not match the authorization code');
      return;
    }
    if (params.redirect_uri !== record.redirectUri) {
      oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization code');
      return;
    }
    const verifier = params.code_verifier ?? '';
    const challenge = createHash('sha256').update(verifier).digest().toString('base64url');
    if (verifier === '' || challenge !== record.codeChallenge) {
      oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
      return;
    }

    // Single-use: burn the code before minting (deleted, not just flagged —
    // a used code has no further legitimate purpose).
    record.used = true;
    codes.delete(params.code!);

    // Opportunistic sweep so finite-TTL tokens never presented again don't
    // accumulate. Never-expire tokens (expiresAt null) are kept.
    for (const [t, rec] of tokens) {
      if (rec.expiresAt !== null && rec.expiresAt <= now()) tokens.delete(t);
    }

    const accessToken = randomBytes(32).toString('base64url');
    const expiresAt = tokenTtlMs === null ? null : now() + tokenTtlMs;
    tokens.set(accessToken, { userId: deps.userId, expiresAt });
    persist();
    log.info('OAuth access token issued', { userId: deps.userId, neverExpires: expiresAt === null });
    sendJson(res, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      // Omit expires_in for never-expire tokens (clients treat absent as
      // "no known expiry" and keep using the token).
      ...(tokenTtlMs === null ? {} : { expires_in: Math.floor(tokenTtlMs / 1000) }),
    });
  }

  return {
    async handleOAuthRoute(req, res) {
      const path = (req.url ?? '').split('?')[0];
      try {
        if ((path === METADATA_PATH || path === METADATA_PATH_MCP) && req.method === 'GET') {
          handleMetadata(req, res);
          return true;
        }
        if ((path === RESOURCE_METADATA_PATH || path === RESOURCE_METADATA_PATH_MCP) && req.method === 'GET') {
          handleResourceMetadata(req, res);
          return true;
        }
        if (path === REGISTER_PATH && req.method === 'POST') {
          await handleRegister(req, res);
          return true;
        }
        if (path === AUTHORIZE_PATH && req.method === 'GET') {
          handleAuthorizeGet(req, res);
          return true;
        }
        if (path === AUTHORIZE_PATH && req.method === 'POST') {
          await handleAuthorizePost(req, res);
          return true;
        }
        if (path === TOKEN_PATH && req.method === 'POST') {
          await handleToken(req, res);
          return true;
        }
        return false;
      } catch (err) {
        log.error('OAuth route error', { error: (err as Error).message });
        if (!res.headersSent) {
          oauthError(res, 500, 'server_error', 'Internal OAuth error');
        } else {
          res.end();
        }
        return true;
      }
    },

    async verifyBearer(req) {
      try {
        const header = req.headers?.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
        const token = header.slice('Bearer '.length).trim();
        if (token === '') return false;
        const record = tokens.get(token);
        if (!record) return false;
        if (record.expiresAt !== null && record.expiresAt <= now()) {
          tokens.delete(token);
          return false;
        }
        // Tokens bind to the ONE configured user id — re-checked every call.
        if (record.userId !== deps.userId) return false;
        return true;
      } catch {
        return false;
      }
    },
  };
}
