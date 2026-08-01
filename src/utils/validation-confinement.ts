/** Nominal proof that a Rune launcher owns an already-applied outer sandbox. */

import { randomUUID } from 'node:crypto';

export type ConfinementOwner = 'validation-launcher' | 'artifact-launcher' | 'sandbox-broker';

export interface ConfinementCapability {
  readonly owner: ConfinementOwner;
  readonly profilePath: string;
  readonly nonce: string;
}

const capabilities = new WeakSet<object>();

/** Trusted launchers call this immediately after creating their private profile. */
export function createConfinementCapability(
  owner: ConfinementOwner,
  profilePath: string,
): ConfinementCapability {
  if (!profilePath.startsWith('/')) throw new Error('confinement profile path must be absolute');
  const capability = Object.freeze({
    owner,
    profilePath,
    nonce: randomUUID(),
  });
  capabilities.add(capability);
  return capability;
}

export function verifyConfinementCapability(
  value: unknown,
  expected: { owner?: ConfinementOwner; profilePath?: string } = {},
): value is ConfinementCapability {
  if (!value || typeof value !== 'object' || !capabilities.has(value)) return false;
  const capability = value as ConfinementCapability;
  return (expected.owner === undefined || capability.owner === expected.owner) &&
    (expected.profilePath === undefined || capability.profilePath === expected.profilePath);
}

/** Legacy transition marker. It is never accepted as confinement proof. */
export const VALIDATION_COMPATIBLE_MODE_ENV =
  'RUNE_INTERNAL_VALIDATION_COMPATIBLE_MODE' as const;
export const VALIDATION_COMPATIBLE_MODE_VALUE = 'related-fallback-v1' as const;

/** Unix socket of the Rune-owned broker enclosing a sandbox-integration shard. */
export const VALIDATION_SANDBOX_BROKER_SOCKET_ENV =
  'RUNE_VALIDATION_SANDBOX_BROKER_SOCKET' as const;
/** Anonymous correlation id used only to reap escaped validation descendants. */
export const VALIDATION_PROCESS_NONCE_ENV = 'RUNE_VALIDATION_PROCESS_NONCE' as const;
/** Broker-issued nonce proving a child is genuinely inside that broker's
 *  already-applied outer Seatbelt. Verified live against the issuing broker —
 *  presence alone never authorizes a bypass. */
export const VALIDATION_CONFINEMENT_ATTESTATION_ENV =
  'RUNE_VALIDATION_CONFINEMENT_ATTESTATION' as const;

/**
 * Private launcher→child handoff variables. None is an operator or product
 * setting, so a real operator environment defining any of them means a stale
 * or forged value could reach a validation launch decision — startup rejects
 * the whole process rather than silently trusting it.
 */
export const VALIDATION_LAUNCHER_PRIVATE_ENV = [
  VALIDATION_COMPATIBLE_MODE_ENV,
  VALIDATION_SANDBOX_BROKER_SOCKET_ENV,
  VALIDATION_PROCESS_NONCE_ENV,
  VALIDATION_CONFINEMENT_ATTESTATION_ENV,
] as const;

export function hasValidationCompatibleModeMarker(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[VALIDATION_COMPATIBLE_MODE_ENV] === VALIDATION_COMPATIBLE_MODE_VALUE;
}
