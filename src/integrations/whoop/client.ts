import { randomBytes } from 'node:crypto';
import config from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { getStoredTokens, storeTokens } from './keychain.js';
import type {
  WhoopTokenResponse,
  WhoopSleep, WhoopSleepResponse,
  WhoopRecoveryRecord, WhoopRecoveryResponse,
  WhoopCycle, WhoopCycleResponse,
  WhoopWorkout, WhoopWorkoutResponse,
} from './types.js';

const log = createLogger('whoop-client');

const API_BASE = 'https://api.prod.whoop.com/developer';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TIMEOUT_MS = 15_000;
const TOKEN_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry
const REFRESH_RETRY_DELAYS_MS = [1000, 3000]; // Retry transient refresh failures only

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'no_refresh_token' }
  | { ok: false; reason: 'refresh_rejected'; status: number }
  | { ok: false; reason: 'network_error'; detail: string };

export function describeTokenError(result: Extract<TokenResult, { ok: false }>): string {
  switch (result.reason) {
    case 'not_configured':
      return 'Whoop not configured';
    case 'no_refresh_token':
      return 'Whoop: re-auth required (no stored token). Run /whoop';
    case 'refresh_rejected':
      return `Whoop: re-auth required (refresh rejected: HTTP ${result.status}). Run /whoop`;
    case 'network_error':
      return `Whoop: transient failure (${result.detail}). Will retry next cycle.`;
  }
}

let pendingOAuthState: string | null = null;

export function isConfigured(): boolean {
  return !!(config.WHOOP_CLIENT_ID && config.WHOOP_CLIENT_SECRET);
}

export function getAuthorizationURL(redirectUri: string): string {
  pendingOAuthState = randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: config.WHOOP_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: pendingOAuthState,
    scope: 'offline read:recovery read:cycles read:sleep read:workout read:body_measurement read:profile',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export function verifyOAuthState(state: string): boolean {
  if (!pendingOAuthState || state !== pendingOAuthState) return false;
  pendingOAuthState = null;
  return true;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: config.WHOOP_CLIENT_ID,
        client_secret: config.WHOOP_CLIENT_SECRET,
      }).toString(),
    });

    if (!response.ok) {
      log.error('Token exchange failed', { status: response.status });
      return false;
    }

    const data = await response.json() as WhoopTokenResponse;
    const expiresAt = Date.now() + data.expires_in * 1000;
    storeTokens(data.access_token, data.refresh_token, expiresAt);
    return true;
  } catch (err) {
    log.error('Token exchange error', { error: (err as Error).message });
    return false;
  }
}

export async function getAccessToken(): Promise<TokenResult> {
  if (!isConfigured()) {
    log.info('Whoop not configured, skipping');
    return { ok: false, reason: 'not_configured' };
  }

  const { accessToken, refreshToken, expiresAt } = getStoredTokens();

  if (accessToken && expiresAt > Date.now() + TOKEN_BUFFER_MS) {
    return { ok: true, token: accessToken };
  }

  if (!refreshToken) {
    log.error('No refresh token available — re-authentication required');
    return { ok: false, reason: 'no_refresh_token' };
  }

  log.info('Access token expired, refreshing');
  return refreshAccessToken(refreshToken);
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  let lastNetworkError: TokenResult & { ok: false; reason: 'network_error' } = {
    ok: false,
    reason: 'network_error',
    detail: 'unknown',
  };

  for (let attempt = 0; attempt <= REFRESH_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetchWithTimeout(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: config.WHOOP_CLIENT_ID,
          client_secret: config.WHOOP_CLIENT_SECRET,
        }).toString(),
      });

      if (response.ok) {
        const data = await response.json() as WhoopTokenResponse;
        const expiresAt = Date.now() + data.expires_in * 1000;
        // Whoop may omit refresh_token when it doesn't rotate — keep the existing one
        const nextRefreshToken = data.refresh_token || refreshToken;
        storeTokens(data.access_token, nextRefreshToken, expiresAt);
        return { ok: true, token: data.access_token };
      }

      // 4xx means the refresh token is truly dead — no point retrying
      if (response.status >= 400 && response.status < 500) {
        log.error('Token refresh rejected', { status: response.status });
        return { ok: false, reason: 'refresh_rejected', status: response.status };
      }

      // 5xx — treat as transient
      log.error('Token refresh failed (5xx)', { status: response.status, attempt });
      lastNetworkError = { ok: false, reason: 'network_error', detail: `HTTP ${response.status}` };
    } catch (err) {
      const detail = (err as Error).message;
      log.error('Token refresh error', { error: detail, attempt });
      lastNetworkError = { ok: false, reason: 'network_error', detail };
    }

    const delay = REFRESH_RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return lastNetworkError;
}

// --- API Fetch Helpers ---

async function apiGet<T>(path: string, token: string, params?: Record<string, string>): Promise<T | null> {
  const url = new URL(`${API_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  try {
    const response = await fetchWithTimeout(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!response.ok) {
      log.error('Whoop API error', { path, status: response.status });
      return null;
    }

    return await response.json() as T;
  } catch (err) {
    log.error('Whoop API request failed', { path, error: (err as Error).message });
    return null;
  }
}

export async function fetchSleep(token: string, startDate: string, endDate: string): Promise<WhoopSleep[]> {
  const data = await apiGet<WhoopSleepResponse>('/v1/activity/sleep', token, {
    start: `${startDate}T00:00:00.000Z`,
    end: `${endDate}T23:59:59.999Z`,
  });
  return data?.records?.filter((r) => r.score_state === 'SCORED' && !r.nap) ?? [];
}

export async function fetchRecovery(token: string, startDate: string, endDate: string): Promise<WhoopRecoveryRecord[]> {
  const data = await apiGet<WhoopRecoveryResponse>('/v1/recovery', token, {
    start: `${startDate}T00:00:00.000Z`,
    end: `${endDate}T23:59:59.999Z`,
  });
  return data?.records?.filter((r) => r.score_state === 'SCORED') ?? [];
}

export async function fetchCycles(token: string, startDate: string, endDate: string): Promise<WhoopCycle[]> {
  const data = await apiGet<WhoopCycleResponse>('/v1/cycle', token, {
    start: `${startDate}T00:00:00.000Z`,
    end: `${endDate}T23:59:59.999Z`,
  });
  return data?.records?.filter((r) => r.score_state === 'SCORED') ?? [];
}

export async function fetchWorkouts(token: string, startDate: string, endDate: string): Promise<WhoopWorkout[]> {
  const data = await apiGet<WhoopWorkoutResponse>('/v1/activity/workout', token, {
    start: `${startDate}T00:00:00.000Z`,
    end: `${endDate}T23:59:59.999Z`,
  });
  return data?.records?.filter((r) => r.score_state === 'SCORED') ?? [];
}

// --- Utilities ---

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
