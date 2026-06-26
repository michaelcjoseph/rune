import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import config from '../config.js';

export function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const raw = part.slice(eqIdx + 1).trim();
    const val = (() => { try { return decodeURIComponent(raw); } catch { return raw; } })();
    if (key) out[key] = val;
  }
  return out;
}

/**
 * Validates the `rune-auth` cookie or `Authorization: Bearer` header against
 * `RUNE_HTTP_SECRET`. Returns `{ ok: true, userId }` on success.
 */
export function verifyAuth(req: IncomingMessage): { ok: true; userId: number } | { ok: false } {
  if (!config.RUNE_HTTP_SECRET) return { ok: false };

  const bearer = req.headers['authorization'];
  if (bearer !== undefined && safeCompare(bearer, `Bearer ${config.RUNE_HTTP_SECRET}`)) {
    return { ok: true, userId: config.TELEGRAM_USER_ID };
  }

  const cookies = parseCookies(req.headers['cookie']);
  const cookieVal = cookies['rune-auth'];
  if (cookieVal !== undefined && safeCompare(cookieVal, config.RUNE_HTTP_SECRET)) {
    return { ok: true, userId: config.TELEGRAM_USER_ID };
  }

  return { ok: false };
}

/**
 * Returns true when the request's Host header (port stripped, lower-cased) is
 * in the `RUNE_ALLOWED_HOSTS` set. Used as defense-in-depth on top of the
 * 127.0.0.1 listener binding.
 */
export function isAllowedHost(req: IncomingMessage): boolean {
  const host = (req.headers['host'] ?? '').toLowerCase().split(':')[0] ?? '';
  return config.RUNE_ALLOWED_HOSTS.has(host);
}
