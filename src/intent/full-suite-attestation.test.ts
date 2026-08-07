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
  canonicalGateValidationReceiptId,
  canonicalValidationReceiptId,
  compactValidationReceipt,
  durableValidationReceipt,
  parseDurableValidationReceipt,
  parseFullSuiteAttestation,
  parseGateValidationReceipt,
  parseValidationBatchReceipt,
  validateFullSuiteAttestation,
  validatePreCloseoutAttestation,
  type FullSuiteAttestation,
  type ValidationProfileOutcome,
} from './full-suite-attestation.js';
import type { ValidationProfilePlan } from './validation-profiles.js';

const TREE = 'a'.repeat(40);
const REVIEW_HASH = 'b'.repeat(64);
const COMMAND_FP = 'c'.repeat(64);
const CONFIGURATION_FP = 'd'.repeat(64);
const DEPENDENCY_FP = 'e'.repeat(64);
const ENVIRONMENT_FP = '8'.repeat(64);
const TOOLCHAIN_FP = '9'.repeat(64);
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

describe('parseGateValidationReceipt — version 3 canonical receipt identity', () => {
  const v3Fields = {
    version: 3 as const,
    treeOid: TREE,
    fullTaskReviewHash: REVIEW_HASH,
    completedAt: '2026-07-30T12:00:05.000Z',
    commandFingerprint: COMMAND_FP,
    configurationFingerprint: CONFIGURATION_FP,
    dependencyFingerprint: DEPENDENCY_FP,
    environmentFingerprint: ENVIRONMENT_FP,
    toolchainFingerprint: TOOLCHAIN_FP,
    outcome: 'passed' as const,
    commands: [{ command: 'npm test', outcome: 'passed' as const, coverage: 'unsupported' as const }],
    profilePlan: PROFILE_PLAN,
    profileOutcomes: PROFILE_OUTCOMES,
  };

  it('admits a version-3 receipt only when the receiptId matches its own canonical identity', () => {
    const receiptId = canonicalGateValidationReceiptId(v3Fields);
    const receipt = { ...v3Fields, receiptId };
    expect(parseGateValidationReceipt(receipt)).toEqual(receipt);
  });

  it('rejects a version-3 receipt whose receiptId was tampered with', () => {
    const receipt = { ...v3Fields, receiptId: '1'.repeat(64) };
    expect(parseGateValidationReceipt(receipt)).toBeUndefined();
  });

  it('rejects a version-3 receipt missing the environment or toolchain fingerprint', () => {
    const receiptId = canonicalGateValidationReceiptId(v3Fields);
    const { environmentFingerprint: _env, ...withoutEnv } = v3Fields;
    expect(parseGateValidationReceipt({ ...withoutEnv, receiptId })).toBeUndefined();
    const { toolchainFingerprint: _toolchain, ...withoutToolchain } = v3Fields;
    expect(parseGateValidationReceipt({ ...withoutToolchain, receiptId })).toBeUndefined();
  });

  it('rejects a version-1/2 receipt carrying V3-only receiptId or fingerprint fields', () => {
    const receiptId = canonicalGateValidationReceiptId(v3Fields);
    expect(parseGateValidationReceipt({ ...v3Fields, version: 1 as const, receiptId }))
      .toBeUndefined();
    expect(parseGateValidationReceipt({ ...v3Fields, version: 2 as const, receiptId }))
      .toBeUndefined();
  });
});

function fullAttestation(overrides: Partial<FullSuiteAttestation> = {}): FullSuiteAttestation {
  const base: FullSuiteAttestation = {
    version: FULL_SUITE_ATTESTATION_VERSION,
    treeOid: TREE,
    fullTaskReviewHash: REVIEW_HASH,
    validationCwd: '.',
    configuredArgv: [['npm', 'test']],
    adapter: { runner: 'unsupported', version: 1 },
    commandFingerprint: COMMAND_FP,
    configurationFingerprint: CONFIGURATION_FP,
    dependencyFingerprint: DEPENDENCY_FP,
    environmentFingerprint: ENVIRONMENT_FP,
    toolchainFingerprint: TOOLCHAIN_FP,
    startedAt: '2026-07-30T12:00:00.000Z',
    completedAt: '2026-07-30T12:00:01.000Z',
    durationMs: 1_000,
    execution: { outcome: 'passed', exitCode: 0, timedOut: false, cancelled: false },
    coverage: { status: 'unsupported' },
    profilePlan: PROFILE_PLAN,
    profileOutcomes: PROFILE_OUTCOMES,
    ...overrides,
  };
  return base.version === 3
    ? { ...base, receiptId: canonicalValidationReceiptId(base) }
    : base;
}

describe('full-suite attestation — version 3 profile identity', () => {
  it('round-trips a self-consistent version-3 attestation', () => {
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
      environmentFingerprint: ENVIRONMENT_FP,
      toolchainFingerprint: TOOLCHAIN_FP,
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
      environmentFingerprint: attestation.environmentFingerprint,
      toolchainFingerprint: attestation.toolchainFingerprint,
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
      environmentFingerprint: attestation.environmentFingerprint,
      toolchainFingerprint: attestation.toolchainFingerprint,
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
      version: 3,
      receiptId: attestation.receiptId,
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

describe('pre-closeout V3 reuse admission', () => {
  const identity = () => {
    const attestation = fullAttestation();
    return {
      treeOid: attestation.treeOid,
      fullTaskReviewHash: attestation.fullTaskReviewHash,
      validationCwd: attestation.validationCwd,
      configuredArgv: attestation.configuredArgv,
      commandFingerprint: attestation.commandFingerprint,
      configurationFingerprint: attestation.configurationFingerprint,
      dependencyFingerprint: attestation.dependencyFingerprint,
      environmentFingerprint: attestation.environmentFingerprint,
      toolchainFingerprint: attestation.toolchainFingerprint,
      profilePlan: attestation.profilePlan,
    };
  };

  it('reuses an exact green product-command V3 receipt with unsupported lifecycle coverage', () => {
    expect(validatePreCloseoutAttestation(
      fullAttestation(),
      identity(),
      'product-commands',
    )).toMatchObject({ ok: true });
  });

  it.each([
    ['tree-drift', { treeOid: '2'.repeat(40) }],
    ['review-hash-drift', { fullTaskReviewHash: '2'.repeat(64) }],
    ['cwd-drift', { validationCwd: 'packages/rune' }],
    ['argv-drift', { configuredArgv: [['npm', 'run', 'build']] as string[][] }],
    ['profile-drift', { profilePlan: { ...PROFILE_PLAN, definitionFingerprint: '2'.repeat(64) } }],
    ['configuration-drift', { configurationFingerprint: '2'.repeat(64) }],
    ['dependency-drift', { dependencyFingerprint: '2'.repeat(64) }],
    ['environment-drift', { environmentFingerprint: '2'.repeat(64) }],
    ['toolchain-drift', { toolchainFingerprint: '2'.repeat(64) }],
  ] as const)('reports %s precisely', (reason, override) => {
    expect(validatePreCloseoutAttestation(
      fullAttestation(),
      { ...identity(), ...override },
      'product-commands',
    )).toEqual({ ok: false, reason });
  });

  it('keeps V2 evidence readable for history but ineligible for stage reuse', () => {
    const current = fullAttestation();
    const {
      receiptId: _receiptId,
      environmentFingerprint: _environmentFingerprint,
      toolchainFingerprint: _toolchainFingerprint,
      ...historical
    } = current;
    const v2 = { ...historical, version: 2 as const };
    expect(parseFullSuiteAttestation(v2)).toEqual(v2);
    expect(validatePreCloseoutAttestation(v2, identity(), 'product-commands'))
      .toEqual({ ok: false, reason: 'incomplete-execution' });
  });

  it.each([
    ['failed execution', {
      execution: { outcome: 'failed' as const, exitCode: 1, timedOut: false, cancelled: false },
    }, 'incomplete-execution'],
    ['timed-out execution', {
      execution: { outcome: 'failed' as const, exitCode: null, timedOut: true, cancelled: false },
    }, 'incomplete-execution'],
    ['cancelled execution', {
      execution: { outcome: 'failed' as const, exitCode: null, timedOut: false, cancelled: true },
    }, 'cancelled'],
  ] as const)('rejects %s as non-green stage evidence', (_label, override, reason) => {
    expect(validatePreCloseoutAttestation(
      fullAttestation(override),
      identity(),
      'product-commands',
    )).toEqual({ ok: false, reason });
  });

  it.each([
    ['partial profile execution', {
      ...fullAttestation(),
      profileOutcomes: [],
    }],
    ['tampered canonical receipt identity', {
      ...fullAttestation(),
      receiptId: '2'.repeat(64),
    }],
    ['unbounded extra output', {
      ...fullAttestation(),
      rawOutput: 'must never persist',
    }],
  ])('rejects %s as corrupt stage evidence', (_label, candidate) => {
    expect(validatePreCloseoutAttestation(
      candidate,
      identity(),
      'product-commands',
    )).toEqual({ ok: false, reason: 'corrupt-evidence' });
  });

  it('requires complete trusted Vitest lifecycle coverage for vitest-related reuse', () => {
    expect(validatePreCloseoutAttestation(
      fullAttestation(),
      identity(),
      'vitest-related',
    )).toEqual({ ok: false, reason: 'incomplete-execution' });
  });
});
