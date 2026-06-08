/**
 * Orchestrated-vs-legacy dispatch mode resolution (project 14, Phase 3).
 *
 * v1 keeps the legacy long-process `/work --auto` applier reachable as a
 * recorded fallback while the orchestrated path is proven. `resolveDispatchMode`
 * is the pure decision that picks which applier a project run uses, and — when it
 * falls back — carries the reason so a fallback run can NEVER silently masquerade
 * as orchestrated execution (the start surface and run record expose it).
 *
 * Pure — no I/O. The runtime reads the toggle (env/config/per-product policy)
 * and passes it in.
 */

export type DispatchMode = 'orchestrated' | 'legacy';

export interface DispatchModeInput {
  /** Whether orchestrated mode is enabled (the rollout toggle). */
  orchestratedEnabled: boolean;
  /** Operator/runtime override forcing the legacy applier even when enabled. */
  forceLegacy?: boolean;
  /** The reason to record when `forceLegacy` is set. */
  forceLegacyReason?: string;
}

export interface DispatchModeResolution {
  mode: DispatchMode;
  /** Present (and truthy) only on a legacy fallback — the recorded reason. */
  fallbackReason?: string;
}

/**
 * Resolve the dispatch mode. An explicit `forceLegacy` wins (with its reason);
 * otherwise a disabled toggle falls back to legacy with a default reason; else
 * the run dispatches orchestrated. Every legacy path carries a `fallbackReason`.
 */
export function resolveDispatchMode(input: DispatchModeInput): DispatchModeResolution {
  if (input.forceLegacy) {
    return { mode: 'legacy', fallbackReason: input.forceLegacyReason ?? 'forced to legacy' };
  }
  if (!input.orchestratedEnabled) {
    return { mode: 'legacy', fallbackReason: 'orchestrated mode disabled' };
  }
  return { mode: 'orchestrated' };
}
