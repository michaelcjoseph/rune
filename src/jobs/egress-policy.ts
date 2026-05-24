/**
 * Egress policy — the runtime wrapper around `isEgressAllowed` for sandboxed
 * Regime B runs, plus an audit-log writer for denied egress attempts.
 *
 * ## Why "documented-gap" today
 *
 * Layer 4's egress enforcement (`docs/projects/08-intent-layer/tasks.md` A1.3)
 * has two halves: the **policy** (which hosts a run may reach) and the
 * **enforcement mechanism** (how a denied attempt is actually blocked at the
 * network layer). The policy half is complete — `src/intent/sandbox.ts`'s
 * `isEgressAllowed` is tested, and per-product allowlists live in
 * `policies/products.json`. The enforcement mechanism is **deliberately
 * deferred**: building a real per-run HTTP/HTTPS proxy with CONNECT-tunneling,
 * port allocation, and child-spawn lifecycle hooks is substantial new
 * infrastructure with no caller today (the gen-eval-loop runner — A3 — is not
 * yet implemented).
 *
 * The deferral rationale lives in `docs/projects/08-intent-layer/egress-deferral.md`.
 * In short: the immediate safety nets are real (worktree isolation from A1.1,
 * credential scoping from A1.2, the dashboard cost cap from the User-side
 * prerequisites), and the eventual proxy can be built when A3 ships and we
 * see what egress patterns Claude CLI + Codex actually need.
 *
 * What this module ships today:
 *
 * 1. **An audit hook.** `checkEgress` is the call site every future enforcer
 *    will consult. It runs `isEgressAllowed` and — on a deny — appends a
 *    JSONL record so the operator has telemetry about how often the gap
 *    would have mattered. That telemetry is the trigger for promoting to
 *    `proxy-enforced`.
 *
 * 2. **An explicit mode constant.** `EGRESS_ENFORCEMENT_MODE` lets a caller
 *    branch: today's mode is `'documented-gap'` and `checkEgress`'s
 *    `allowed: false` does not actually block a connection. When the proxy
 *    lands the mode flips to `'proxy-enforced'` and the same return value
 *    becomes the network-level gate.
 *
 * See: spec.md §"Layer 4", tasks.md Phase 6 A1.3, egress-deferral.md.
 */

import { appendFileSync } from 'node:fs';
import { isEgressAllowed, type SandboxSpec } from '../intent/sandbox.js';
import { getProductConfig } from './sandbox-runtime.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('egress-policy');

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/** Enforcement modes the runtime can be in. `'documented-gap'` is today —
 *  policy is decided and logged, but a denied call is not actually blocked.
 *  `'proxy-enforced'` is what `'documented-gap'` flips to when the per-run
 *  proxy ships. */
export type EgressEnforcementMode = 'documented-gap' | 'proxy-enforced';

/** Current enforcement mode. Hardcoded today — the value will change in
 *  the same commit that ships the per-run proxy, so a grep for this name
 *  surfaces every call site that needs to be reconsidered then. */
export const EGRESS_ENFORCEMENT_MODE: EgressEnforcementMode = 'documented-gap';

// ---------------------------------------------------------------------------
// checkEgress — the runtime hook future enforcers consult
// ---------------------------------------------------------------------------

export interface CheckEgressOpts {
  /** Path to `policies/products.json` (the per-product allowlist source). */
  productsConfigPath: string;
  /** Where to append denial records. Injectable for tests; production
   *  callers pass `config.EGRESS_DENIAL_LOG`. */
  denialLogPath: string;
}

/**
 * Check whether `sandbox` may reach `host`. The allowlist is re-read from
 * `policies/products.json` on every call rather than trusting
 * `sandbox.egressAllowlist`, so a long-running run picks up an
 * out-of-band allowlist edit (e.g. an operator adding a missing host
 * after a deny surfaces). The `isEgressAllowed` matching rule itself
 * (exact match, case-fold, trailing-dot tolerant) is reused.
 *
 * On a deny, appends a JSONL record to `denialLogPath` so the operator has
 * telemetry about the deferred gap.
 *
 * The return shape includes `mode` deliberately — a caller wired to enforce
 * (the future proxy) can branch on it; an advisory caller (today) can ignore
 * it. The pair `(allowed, mode)` is enough for any caller to know whether to
 * block the connection itself.
 *
 * **Throws** when `sandbox.product` is not in `policies/products.json` — a
 * config gap, not a runtime egress event. The future proxy caller (A3) is
 * expected to fail-closed on this: catch and treat as a denied egress so a
 * misconfigured product cannot bypass the gate.
 */
export function checkEgress(
  sandbox: SandboxSpec,
  host: string,
  opts: CheckEgressOpts,
): { allowed: boolean; mode: EgressEnforcementMode } {
  // Re-read the allowlist from products.json each call so an out-of-band
  // edit takes effect immediately. Synthesize a fresh-allowlist sandbox so
  // `isEgressAllowed` stays the single source of the matching rule (exact
  // match, case-fold, trailing-dot tolerant).
  const egressAllowlist = getProductConfig(sandbox.product, opts.productsConfigPath).egressAllowlist;
  const allowed = isEgressAllowed(host, { ...sandbox, egressAllowlist });
  if (!allowed) {
    appendEgressDenialLog(sandbox, host, opts.denialLogPath);
  }
  return { allowed, mode: EGRESS_ENFORCEMENT_MODE };
}

// ---------------------------------------------------------------------------
// appendEgressDenialLog
// ---------------------------------------------------------------------------

/** One row in `logs/egress-denials.jsonl`. The `mode` field makes the log
 *  self-describing across the eventual `documented-gap` → `proxy-enforced`
 *  flip — a monitoring query can distinguish entries written before the
 *  proxy went live (where the deny was advisory) from entries written
 *  after (where the connection was actually blocked). */
interface EgressDenialRecord {
  ts: string;
  product: string;
  project: string;
  host: string;
  mode: EgressEnforcementMode;
}

/**
 * Append a single JSON line to `logPath` recording a denied egress attempt.
 * Synchronous because callers (the future proxy) make this decision on the
 * connection path and need a sync answer before letting the socket through.
 *
 * Concurrency: `appendFileSync` opens with `O_APPEND | O_CREAT`, so concurrent
 * denials from two sandboxed runs append cleanly without truncating each
 * other (POSIX guarantees the open call atomically creates-if-missing). No
 * existsSync pre-check is used — that would introduce a TOCTOU window where a
 * racing creator would have already-written lines truncated.
 *
 * Best-effort: a write failure is logged but does not throw — losing one
 * audit record is preferable to crashing the run on a disk-full error.
 * The directory is assumed to exist; the production path is `logs/` which
 * `src/index.ts` ensures at startup.
 */
export function appendEgressDenialLog(
  sandbox: SandboxSpec,
  host: string,
  logPath: string,
): void {
  const record: EgressDenialRecord = {
    ts: new Date().toISOString(),
    product: sandbox.product,
    project: sandbox.project,
    host,
    mode: EGRESS_ENFORCEMENT_MODE,
  };
  try {
    appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch (err) {
    log.warn('appendEgressDenialLog: failed to write denial record', {
      path: logPath,
      host,
      error: (err as Error).message,
    });
  }
}
