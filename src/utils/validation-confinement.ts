/**
 * Private marker used only by the closeout validation launcher when it reruns a
 * confirmed host-capability conflict. The rerun is already inside Rune's outer
 * validation Seatbelt, so Rune-owned helpers may reuse that inherited boundary
 * instead of attempting an unsupported nested Seatbelt.
 *
 * This is deliberately not a product/operator configuration knob. The main
 * Rune process rejects it at startup; product validation receives it only
 * through the credential-stripped launcher environment.
 */
export const VALIDATION_COMPATIBLE_MODE_ENV =
  'RUNE_INTERNAL_VALIDATION_COMPATIBLE_MODE' as const;
export const VALIDATION_COMPATIBLE_MODE_VALUE = 'related-fallback-v1' as const;

/**
 * Returns only whether the private marker has the expected value. This is not
 * proof of confinement: callers may reuse an outer boundary only when their
 * own launch contract already guarantees that boundary was applied.
 */
export function hasValidationCompatibleModeMarker(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[VALIDATION_COMPATIBLE_MODE_ENV] === VALIDATION_COMPATIBLE_MODE_VALUE;
}
