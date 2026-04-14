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

export function isConfigured(): boolean {
  return !!(config.WHOOP_CLIENT_ID && config.WHOOP_CLIENT_SECRET);
}

export function getAuthorizationURL(redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: config.WHOOP_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'read:recovery read:cycles read:sleep read:workout read:body_measurement read:profile',
  });
  return `${AUTH_URL}?${params.toString()}`;
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

export async function getAccessToken(): Promise<string | null> {
  if (!isConfigured()) {
    log.info('Whoop not configured, skipping');
    return null;
  }

  const { accessToken, refreshToken, expiresAt } = getStoredTokens();

  if (accessToken && expiresAt > Date.now() + TOKEN_BUFFER_MS) {
    return accessToken;
  }

  if (!refreshToken) {
    log.error('No refresh token available — re-authentication required');
    return null;
  }

  log.info('Access token expired, refreshing');
  const refreshed = await refreshAccessToken(refreshToken);
  return refreshed;
}

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
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

    if (!response.ok) {
      log.error('Token refresh failed', { status: response.status });
      return null;
    }

    const data = await response.json() as WhoopTokenResponse;
    const expiresAt = Date.now() + data.expires_in * 1000;
    storeTokens(data.access_token, data.refresh_token, expiresAt);
    return data.access_token;
  } catch (err) {
    log.error('Token refresh error', { error: (err as Error).message });
    return null;
  }
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
