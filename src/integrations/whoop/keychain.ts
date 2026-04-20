import { execFileSync } from 'node:child_process';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('whoop-keychain');

const SERVICE = 'jarvis-whoop';

export function getKeychainValue(key: string): string | null {
  try {
    const result = execFileSync('security', [
      'find-generic-password',
      '-s', SERVICE,
      '-a', key,
      '-w',
    ], { encoding: 'utf8', timeout: 5000 });
    return result.trim();
  } catch {
    return null;
  }
}

export function setKeychainValue(key: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value === 'undefined' || value === 'null') {
    throw new Error(`setKeychainValue refused: empty/invalid value for key "${key}"`);
  }

  // Delete existing entry first (update not supported directly)
  try {
    execFileSync('security', [
      'delete-generic-password',
      '-s', SERVICE,
      '-a', key,
    ], { timeout: 5000 });
  } catch {
    // Entry didn't exist — fine
  }

  try {
    execFileSync('security', [
      'add-generic-password',
      '-s', SERVICE,
      '-a', key,
      '-w', value,
    ], { timeout: 5000 });
  } catch (err) {
    log.error('Failed to set keychain value', { key, error: (err as Error).message });
  }
}

export function deleteKeychainValue(key: string): void {
  try {
    execFileSync('security', [
      'delete-generic-password',
      '-s', SERVICE,
      '-a', key,
    ], { timeout: 5000 });
  } catch {
    // Entry didn't exist — fine
  }
}

function sanitize(v: string | null): string | null {
  // Guard against previously-corrupted entries that stored literal "undefined"/"null"
  if (v === null || v === 'undefined' || v === 'null' || v === '') return null;
  return v;
}

export function getStoredTokens(): { accessToken: string | null; refreshToken: string | null; expiresAt: number } {
  const accessToken = sanitize(getKeychainValue('access-token'));
  const refreshToken = sanitize(getKeychainValue('refresh-token'));
  const expiresAtStr = sanitize(getKeychainValue('token-expiry'));
  const expiresAt = expiresAtStr ? Number(expiresAtStr) : 0;
  return { accessToken, refreshToken, expiresAt };
}

export function storeTokens(accessToken: string, refreshToken: string, expiresAt: number): void {
  if (!accessToken || !refreshToken) {
    throw new Error(`storeTokens refused: missing accessToken=${!!accessToken} refreshToken=${!!refreshToken}`);
  }
  setKeychainValue('access-token', accessToken);
  setKeychainValue('refresh-token', refreshToken);
  setKeychainValue('token-expiry', String(expiresAt));
  log.info('Tokens stored in keychain');
}
