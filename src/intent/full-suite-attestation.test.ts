/**
 * Coverage for the V2 profile-plan/profile-outcomes evidence added to
 * `full-suite-attestation.ts` (deterministic capability profiles —
 * `src/intent/validation-profiles.ts`). V1 evidence has no dedicated test
 * file at HEAD; these tests focus on the new profiled surface: batch/gate
 * receipts, the durable receipt, and the full attestation identity check.
 */

import { describe, expect, it } from 'vitest';

import {
  FULL_SUITE_ATTESTATION_VERSION,
  compactValidationReceipt,
  durableValidationReceipt,
  parseDurableValidationReceipt,
  parseFullSuiteAttestation,
  parseGateValidationReceipt,
  parseValidationBatchReceipt,
  validateFullSuiteAttestation,
  type FullSuiteAttestation,
  type ValidationProfileOutcome,
} from './full-suite-attestation.js';
import type { ValidationProfilePlan } from './validation-profiles.js';

const TREE = 'a'.repeat(40);
const REVIEW_HASH = 'b'.repeat(64);
const COMMAND_FP = 'c'.repeat(64);
const CONFIGURATION_FP = 'd'.repeat(64);
const DEPENDENCY_FP = 'e'.repeat(64);
const PLAN_FP = '1'.repeat(64);
const PROBE_FP = 'f'.repeat(64);

const PROFILE_PLAN: ValidationProfilePlan = {
  version: 1,
  shards: [
    { command: 'npm test', argv: ['npm', 'test'], profile: 'isolated' },
  ],
  definitionFingerprint: PLAN_FP,
};

function passedProbe(overrides: Partial<ValidationProfileOutcome['probe']> = {}) {
  return {
    profile: 'isolated' as const,
    definitionFingerprint: PROBE_FP,
    confinementOwner: 'validation-launcher' as const,
    outcome: 'passed' as const,
    startedAt: '2026-07-30T12:00:00.000Z',
    completedAt: '2026-07-30T12:00:01.000Z',
    ...overrides,
  };
}

const PROFILE_OUTCOMES: ValidationProfileOutcome[] = [
  { profile: 'isolated', outcome: 'passed', probe: passedProbe() },
];

describe('parseValidationBatchReceipt — profiled evidence (V2)', () => {
  it('round-trips a passed batch receipt carrying a matching profile plan/outcomes', () => {
    const receipt = {
      outcome: 'passed' as const,
      commands: [{ command: 'npm test', outcome: 'passed' as const, coverage: 'unsupported' as const }],
      profilePlan: PROFILE_PLAN,
      profileOutcomes: PROFILE_OUTCOMES,
    };
    expect(parseValidationBatchReceipt(receipt)).toEqual(receipt);
  });

  it('accepts outcome profile-unavailable only when a profile outcome reports it', () => {
    const unavailableOutcomes: ValidationProfileOutcome[] = [
      {
        profile: 'isolated',
        outcome: 'profile-unavailable',
        probe: passedProbe({ outcome: 'unavailable', failureClass: 'profile-unavailable' }),
      },
    ];
    expect(parseValidationBatchReceipt({
      outcome: 'profile-unavailable',
      commands: [{ command: 'npm test', outcome: 'failed', coverage: 'unsupported' }],
      profilePlan: PROFILE_PLAN,
      profileOutcomes: unavailableOutcomes,
    })).toEqual({
      outcome: 'profile-unavailable',
      commands: [{ command: 'npm test', outcome: 'failed', coverage: 'unsupported' }],
      profilePlan: PROFILE_PLAN,
      profileOutcomes: unavailableOutcomes,
    });

    // The same profileOutcomes claimed under outcome 'passed' (no shard actually
    // unavailable per the batch outcome contract) is rejected.
    expect(parseValidationBatchReceipt({
      outcome: 'profile-unavailable',
      commands: [{ command: 'npm test', outcome: 'passed', coverage: 'unsupported' }],
      profilePlan: PROFILE_PLAN,
      profileOutcomes: PROFILE_OUTCOMES, // every shard actually reports 'passed'
    })).toBeUndefined();
  });

  it('rejects profileOutcomes that do not line up 1:1 with the plan shards', () => {
    const base = {
      outcome: 'passed' as const,
      commands: [{ command: 'npm test', outcome: 'passed' as const, coverage: 'unsupported' as const }],
    };
    // profilePlan present without profileOutcomes (and vice versa).
    expect(parseValidationBatchReceipt({ ...base, profilePlan: PROFILE_PLAN })).toBeUndefined();
    expect(parseValidationBatchReceipt({ ...base, profileOutcomes: PROFILE_OUTCOMES })).toBeUndefined();
    // Wrong shard count.
    expect(parseValidationBatchReceipt({
      ...base,
      profilePlan: PROFILE_PLAN,
      profileOutcomes: [...PROFILE_OUTCOMES, ...PROFILE_OUTCOMES],
    })).toBeUndefined();
    // Outcome entry claims a profile the plan never assigned to that shard index.
    expect(parseValidationBatchReceipt({
      ...base,
      profilePlan: PROFILE_PLAN,
      profileOutcomes: [{ ...PROFILE_OUTCOMES[0], profile: 'loopback' }],
    })).toBeUndefined();
    // Malformed probe fingerprint.
    expect(parseValidationBatchReceipt({
      ...base,
      profilePlan: PROFILE_PLAN,
      profileOutcomes: [{
        profile: 'isolated',
        outcome: 'passed',
        probe: passedProbe({ definitionFingerprint: 'not-a-sha256' }),
      }],
    })).toBeUndefined();
  });
});

describe('parseGateValidationReceipt — version 2', () => {
  const identity = {
    version: 2 as const,
    treeOid: TREE,
    fullTaskReviewHash: REVIEW_HASH,
    completedAt: '2026-07-30T12:00:05.000Z',
    commandFingerprint: COMMAND_FP,
    configurationFingerprint: CONFIGURATION_FP,
    dependencyFingerprint: DEPENDENCY_FP,
  };

  it('admits a version-2 receipt with a matching profile plan', () => {
    const receipt = {
      ...identity,
      outcome: 'passed',
      commands: [{ command: 'npm test', outcome: 'passed', coverage: 'unsupported' }],
      profilePlan: PROFILE_PLAN,
      profileOutcomes: PROFILE_OUTCOMES,
    };
    expect(parseGateValidationReceipt(receipt)).toEqual(receipt);
  });

  it('rejects a version-2 receipt whose profileOutcomes were tampered with', () => {
    const receipt = {
      ...identity,
      outcome: 'passed',
      commands: [{ command: 'npm test', outcome: 'passed', coverage: 'unsupported' }],
      profilePlan: PROFILE_PLAN,
      profileOutcomes: [{ ...PROFILE_OUTCOMES[0], outcome: 'failed' }],
    };
    expect(parseGateValidationReceipt(receipt)).toBeUndefined();
  });

  it('still accepts a legacy version-1 receipt with no profile fields', () => {
    const receipt = {
      ...identity,
      version: 1 as const,
      outcome: 'passed',
      commands: [{ command: 'npm test', outcome: 'passed', coverage: 'unsupported' }],
    };
    expect(parseGateValidationReceipt(receipt)).toEqual(receipt);
  });
});

function fullAttestation(overrides: Partial<FullSuiteAttestation> = {}): FullSuiteAttestation {
  return {
    version: FULL_SUITE_ATTESTATION_VERSION,
    treeOid: TREE,
    fullTaskReviewHash: REVIEW_HASH,
    validationCwd: '.',
    configuredArgv: [['npm', 'test']],
    adapter: { runner: 'unsupported', version: 1 },
    commandFingerprint: COMMAND_FP,
    configurationFingerprint: CONFIGURATION_FP,
    dependencyFingerprint: DEPENDENCY_FP,
    startedAt: '2026-07-30T12:00:00.000Z',
    completedAt: '2026-07-30T12:00:01.000Z',
    durationMs: 1_000,
    execution: { outcome: 'passed', exitCode: 0, timedOut: false, cancelled: false },
    coverage: { status: 'unsupported' },
    profilePlan: PROFILE_PLAN,
    profileOutcomes: PROFILE_OUTCOMES,
    ...overrides,
  };
}

describe('full-suite attestation — version 2 profile identity', () => {
  it('round-trips a self-consistent version-2 attestation', () => {
    const attestation = fullAttestation();
    expect(parseFullSuiteAttestation(attestation)).toEqual(attestation);
  });

  it('rejects a version-1 attestation that improperly carries profile fields', () => {
    const attestation = fullAttestation({ version: 1 });
    expect(parseFullSuiteAttestation(attestation)).toBeUndefined();
    expect(validateFullSuiteAttestation(attestation, {
      treeOid: TREE,
      fullTaskReviewHash: REVIEW_HASH,
      validationCwd: '.',
      configuredArgv: [['npm', 'test']],
      commandFingerprint: COMMAND_FP,
      configurationFingerprint: CONFIGURATION_FP,
      dependencyFingerprint: DEPENDENCY_FP,
    })).toEqual({ ok: false, reason: 'malformed-attestation' });
  });

  it('rejects a version-2 attestation missing its profile plan/outcomes', () => {
    const { profilePlan: _plan, profileOutcomes: _outcomes, ...rest } = fullAttestation();
    expect(parseFullSuiteAttestation(rest)).toBeUndefined();
  });

  it('treats a mismatched profile plan as an identity mismatch, not just malformed data', () => {
    const attestation = fullAttestation();
    const driftedPlan: ValidationProfilePlan = {
      ...PROFILE_PLAN,
      definitionFingerprint: '2'.repeat(64),
    };
    const result = validateFullSuiteAttestation(attestation, {
      treeOid: attestation.treeOid,
      fullTaskReviewHash: attestation.fullTaskReviewHash,
      validationCwd: attestation.validationCwd,
      configuredArgv: attestation.configuredArgv,
      commandFingerprint: attestation.commandFingerprint,
      configurationFingerprint: attestation.configurationFingerprint,
      dependencyFingerprint: attestation.dependencyFingerprint,
      profilePlan: driftedPlan,
    });
    expect(result).toEqual({ ok: false, reason: 'identity-mismatch' });
  });

  it('accepts when the expected identity profile plan matches exactly', () => {
    const attestation = fullAttestation();
    const result = validateFullSuiteAttestation(attestation, {
      treeOid: attestation.treeOid,
      fullTaskReviewHash: attestation.fullTaskReviewHash,
      validationCwd: attestation.validationCwd,
      configuredArgv: attestation.configuredArgv,
      commandFingerprint: attestation.commandFingerprint,
      configurationFingerprint: attestation.configurationFingerprint,
      dependencyFingerprint: attestation.dependencyFingerprint,
      profilePlan: PROFILE_PLAN,
    });
    expect(result).toEqual({ ok: true, attestation });
  });
});

describe('compact/durable validation receipts project profile evidence through', () => {
  it('compactValidationReceipt carries the version and profile fields from the attestation', () => {
    const attestation = fullAttestation();
    const compact = compactValidationReceipt(attestation);
    expect(compact).toMatchObject({
      version: 2,
      profilePlan: PROFILE_PLAN,
      profileOutcomes: PROFILE_OUTCOMES,
    });
  });

  it('durableValidationReceipt round-trips profile fields through parseDurableValidationReceipt', () => {
    const attestation = fullAttestation();
    const compact = compactValidationReceipt(attestation);
    const durable = durableValidationReceipt(compact, 'full-suite-ran');
    expect(durable).toMatchObject({
      profilePlan: PROFILE_PLAN,
      profileOutcomes: PROFILE_OUTCOMES,
    });
    expect(parseDurableValidationReceipt(durable)).toEqual(durable);
  });
});
