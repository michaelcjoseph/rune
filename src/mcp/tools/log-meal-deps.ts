/**
 * Production deps binding for the log_meal tool — Wave 0 typed stub.
 *
 * The registry calls buildDeps() BEFORE the handler runs, so this must return
 * an object rather than throw; the Wave 0 stub handler never touches deps.
 * Wave 1 replaces this with the real binding (vault nutrition.md appender via
 * src/vault/files.ts, America/Chicago clock, vault git commit).
 */

import type { LogMealDeps } from './log-meal.js';

export function buildProductionLogMealDeps(): LogMealDeps {
  // Wave 1 replaces this typed stub with the real production bindings.
  return {} as unknown as LogMealDeps;
}
