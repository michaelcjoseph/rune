/**
 * Production deps binding for the health read tools — Wave 0 typed stub.
 *
 * The registry calls buildDeps() BEFORE the handler runs, so this must return
 * an object rather than throw; the Wave 0 stub handlers never touch deps, so
 * the empty typed stub is safe. Wave 1 replaces this with the real bindings
 * (whoop sync + vault readers via src/vault/files.ts, sanitizeMcpError).
 */

import type { HealthReadDeps } from './health-read.js';

export function buildProductionHealthReadDeps(): HealthReadDeps {
  // Wave 1 replaces this typed stub with the real production bindings.
  return {} as unknown as HealthReadDeps;
}
