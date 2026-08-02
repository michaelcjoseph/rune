/**
 * Shared broker bootstrap for `validation-sandbox-integration`-tagged tests.
 *
 * Every suite that asserts on real Seatbelt behaviour faces the same problem:
 * when Rune's own suite runs under the profiled closeout launcher, the shard
 * ALREADY has a Rune-owned broker enclosing it, and starting a second one would
 * be exactly the nested-ownership mistake these tests exist to catch. When the
 * suite runs bare (`npx vitest run`), no broker exists and the test must start
 * and stop its own.
 *
 * `withValidationBroker` resolves that fork once so each suite stops hand-rolling
 * it — reuse the inherited socket/nonce when present, otherwise own the
 * lifecycle. It never starts a broker alongside an inherited one.
 *
 * Test-only; nothing in the runtime path imports this.
 */

import {
  startValidationSandboxBroker,
  type ValidationSandboxBroker,
} from './validation-sandbox-broker.js';
import {
  VALIDATION_CONFINEMENT_ATTESTATION_ENV,
  VALIDATION_SANDBOX_BROKER_SOCKET_ENV,
} from '../utils/validation-confinement.js';

export interface InheritedValidationBroker {
  socketPath: string;
  attestationNonce: string;
  /** True when an enclosing shard already owned this broker. */
  inherited: boolean;
}

/**
 * Run `body` against a live `sandbox-integration` broker, reusing the enclosing
 * shard's broker when this process is already inside one. A broker this helper
 * started is always stopped; an inherited one is never touched.
 */
export async function withValidationBroker<T>(
  body: (broker: InheritedValidationBroker) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const socketPath = env[VALIDATION_SANDBOX_BROKER_SOCKET_ENV];
  const attestationNonce = env[VALIDATION_CONFINEMENT_ATTESTATION_ENV];
  if (socketPath !== undefined && attestationNonce !== undefined) {
    return await body({ socketPath, attestationNonce, inherited: true });
  }
  let owned: ValidationSandboxBroker | undefined;
  try {
    owned = await startValidationSandboxBroker();
    return await body({
      socketPath: owned.socketPath,
      attestationNonce: owned.attestationNonce,
      inherited: false,
    });
  } finally {
    await owned?.stop();
  }
}
