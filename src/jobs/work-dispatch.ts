/**
 * Work-run dispatch seam (project 14, Phase 5).
 *
 * The cockpit per-project Start action (and any other surface that starts a
 * project run) goes through this seam to decide WHICH applier handles the run:
 * the Rune-owned orchestrated loop (`orchestrated-work`) or the legacy
 * long-process `/work --auto` runner (`work-run`). The legacy path stays
 * reachable as a recorded fallback while the orchestrated path is proven —
 * and a fallback ALWAYS carries a reason so a run can never silently
 * masquerade as orchestrated execution (spec §"Fallback").
 *
 * The mode DECISION is the pure `resolveDispatchMode` (src/intent/orch-config.ts);
 * this module maps that decision to a concrete mutation kind and reads the
 * runtime toggle (global default + per-product override + operator force).
 */

import { resolveDispatchMode, type DispatchMode, type DispatchModeInput } from '../intent/orch-config.js';
import { getProductConfig } from './sandbox-runtime.js';
import type { MutationKind } from '../transport/mutations.js';
import type { DispatchMode as CockpitDispatchMode } from '../intent/cockpit.js';

// Compile-time drift guard: `cockpit.ts` keeps a LOCAL `DispatchMode` mirror to
// avoid an intent→orch-config import (same rationale as its WorkRunOutcome
// mirror). This bridge imports both, so it is the natural home to assert they
// stay structurally equal — if either union gains/loses a member, this fails to
// compile. Mirrors the `_AssertOutcomesEqual` pattern in work-run-projection.ts.
type _AssertDispatchModesEqual = [DispatchMode] extends [CockpitDispatchMode]
  ? ([CockpitDispatchMode] extends [DispatchMode] ? true : never)
  : never;
const _dispatchModeDriftCheck: _AssertDispatchModesEqual = true;
void _dispatchModeDriftCheck;

/** The applier kind dispatched when orchestrated mode is selected. */
export const ORCHESTRATED_WORK_KIND: MutationKind = 'orchestrated-work';
/** The legacy `/work --auto` applier kind — the recorded fallback. */
export const LEGACY_WORK_KIND: MutationKind = 'work-run';

export interface WorkDispatchResolution {
  /** The mutation kind to dispatch — selects the applier. */
  kind: MutationKind;
  /** The resolved mode. */
  mode: DispatchMode;
  /** Present (and truthy) only on a legacy fallback — the recorded reason. */
  fallbackReason?: string;
}

/**
 * Resolve which applier kind a work-run dispatch should use from the mode
 * decision. `orchestrated` → the orchestrated applier; every `legacy` path
 * (toggle disabled or operator-forced) → the legacy applier, carrying the
 * `fallbackReason` through so the run record / Start surface can expose it.
 */
export function resolveWorkDispatch(input: DispatchModeInput): WorkDispatchResolution {
  const res = resolveDispatchMode(input);
  return {
    kind: res.mode === 'orchestrated' ? ORCHESTRATED_WORK_KIND : LEGACY_WORK_KIND,
    mode: res.mode,
    ...(res.fallbackReason !== undefined ? { fallbackReason: res.fallbackReason } : {}),
  };
}

export interface ReadDispatchToggleOpts {
  /** Product whose run is being dispatched — its per-product override wins. */
  product: string;
  /** Path to `policies/products.json` (config.PRODUCTS_CONFIG_FILE). */
  productsConfigPath: string;
  /** Global default when a product doesn't set its own `orchestratedMode`. */
  globalEnabled: boolean;
  /** Operator/runtime override forcing legacy even when orchestrated is enabled. */
  forceLegacy?: boolean;
  /** Reason recorded when `forceLegacy` is set. */
  forceLegacyReason?: string;
}

/**
 * Build the `DispatchModeInput` for `resolveWorkDispatch` by reading the toggle.
 *
 * Precedence: a per-product `orchestratedMode` boolean in products.json OVERRIDES
 * the global default; anything else (absent key, unknown/unreadable product)
 * falls back to `globalEnabled` rather than crashing dispatch — a config read
 * problem must not block starting a run, only steer which applier handles it.
 */
export function readDispatchModeInput(opts: ReadDispatchToggleOpts): DispatchModeInput {
  let orchestratedEnabled = opts.globalEnabled;
  try {
    const cfg = getProductConfig(opts.product, opts.productsConfigPath);
    if (typeof cfg.orchestratedMode === 'boolean') {
      orchestratedEnabled = cfg.orchestratedMode;
    }
  } catch {
    // Unknown or unreadable product → keep the global default. The applier's
    // own validate() surfaces a genuinely bad product/slug as a clean rejection.
  }
  return {
    orchestratedEnabled,
    ...(opts.forceLegacy !== undefined ? { forceLegacy: opts.forceLegacy } : {}),
    ...(opts.forceLegacyReason !== undefined ? { forceLegacyReason: opts.forceLegacyReason } : {}),
  };
}
