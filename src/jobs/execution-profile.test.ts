import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createResolvedProfileSnapshot,
  parseExecutionProfile,
  parseResolvedProfileSnapshot,
} from './execution-profile.js';
import { readProductsConfig } from './sandbox-runtime.js';

/**
 * Contract tests for Phase 2's versioned execution-profile schema.
 *
 * These tests deliberately exercise the parser rather than constructing the
 * exported TypeScript types directly: execution profiles originate in
 * products.json and therefore must be rejected at the runtime boundary.
 *
 * Serialized resource/artifact shapes, pinned here per the tech-lead
 * test-intent review (tech-spec.md "Core data contracts" is updated to match):
 * - ResourceRequirement: { type: 'simulator' | 'emulator' | 'cache-dir' |
 *   'port-range' | 'build-capacity' | 'device', key: string,
 *   capacity?: number (default 1), scope: 'step' | 'run' } — every provision
 *   step and validation check declares the resources it acquires and their
 *   lease scope; a resource without a scope is rejected.
 * - ArtifactSpec: { id: string, path: string } — path is relative to the
 *   run's artifact root; absolute or escaping paths are rejected.
 */
const completeProfile = {
  profileVersion: 1,
  toolchains: [
    {
      kind: 'node',
      version: '>=22.15.0',
      versionProbe: ['node', '--version'],
      packageManager: { name: 'npm', version: '>=10' },
    },
  ],
  env: {
    required: ['BRAND_API_URL'],
    optional: ['BRAND_DEBUG'],
  },
  provisioning: {
    steps: [
      {
        id: 'install-dependencies',
        provisioner: 'node',
        config: { mode: 'copy' },
        network: 'offline',
        resources: [{ type: 'cache-dir', key: 'brand-node-modules', scope: 'step' }],
      },
    ],
  },
  setup: [
    {
      id: 'generate-client',
      argv: ['node', 'scripts/generate-client.mjs'],
      cwd: 'apps/brand',
      env: { NODE_ENV: 'test' },
      network: 'local-fake',
      timeoutMs: 15_000,
    },
  ],
  validation: {
    selectors: [
      { tier: 'fast', always: true },
      { tier: 'native-compile', changedPathGlobs: ['ios/**', 'android/**'] },
      { tier: 'simulator', flowTags: ['user-visible'] },
      { tier: 'manual-live', flowTags: ['release'] },
    ],
    checks: [
      {
        id: 'unit',
        argv: ['npm', 'test', '--', '--runInBand'],
        cwd: 'apps/brand',
        network: 'offline',
        required: true,
        tier: 'fast',
      },
      {
        id: 'ios-compile',
        argv: ['xcodebuild', '-scheme', 'Brand', 'build'],
        network: 'offline',
        required: true,
        tier: 'native-compile',
        resources: [{ type: 'build-capacity', key: 'xcode-build', capacity: 1, scope: 'step' }],
        artifacts: [{ id: 'ios-build-log', path: 'ios/xcodebuild.log' }],
      },
      {
        id: 'simulator-smoke',
        argv: ['npx', 'detox', 'test', '--configuration', 'ios.sim.release'],
        network: 'local-fake',
        required: false,
        tier: 'simulator',
        resources: [{ type: 'simulator', key: 'iphone-16-pro', scope: 'run' }],
      },
      {
        id: 'release-smoke',
        argv: ['npm', 'run', 'release-smoke'],
        network: 'manual-live',
        required: false,
        tier: 'manual-live',
      },
    ],
  },
} as const;

describe('execution-profile schema', () => {
  it('parses a complete version-1 profile without converting argv commands to shell strings', () => {
    expect(parseExecutionProfile(completeProfile)).toEqual(completeProfile);
  });

  it.each([
    {
      label: 'a setup shell string',
      profile: {
        ...completeProfile,
        setup: [{ ...completeProfile.setup[0], argv: 'node scripts/generate-client.mjs' }],
      },
    },
    {
      label: 'a validation shell string',
      profile: {
        ...completeProfile,
        validation: {
          ...completeProfile.validation,
          checks: completeProfile.validation.checks.map((check) =>
            check.id === 'unit' ? { ...check, argv: 'npm test -- --runInBand' } : check,
          ),
        },
      },
    },
    {
      label: 'an empty argv',
      profile: {
        ...completeProfile,
        setup: [{ ...completeProfile.setup[0], argv: [] }],
      },
    },
  ])('rejects $label at parse time', ({ profile }) => {
    expect(() => parseExecutionProfile(profile)).toThrow(/argv|command/i);
  });

  it('rejects an unknown profile version', () => {
    expect(() => parseExecutionProfile({ ...completeProfile, profileVersion: 2 }))
      .toThrow(/profileVersion|version/i);
  });

  it.each([
    {
      label: 'an absolute command cwd',
      profile: {
        ...completeProfile,
        setup: [{ ...completeProfile.setup[0], cwd: '/tmp/outside-worktree' }],
      },
    },
    {
      label: 'an escaping command cwd',
      profile: {
        ...completeProfile,
        setup: [{ ...completeProfile.setup[0], cwd: '../outside-worktree' }],
      },
    },
    {
      label: 'approved egress on an autonomous validation check',
      profile: {
        ...completeProfile,
        validation: {
          ...completeProfile.validation,
          checks: completeProfile.validation.checks.map((check) =>
            check.id === 'unit' ? { ...check, network: 'approved-egress' } : check,
          ),
        },
      },
    },
  ])('rejects $label', ({ profile }) => {
    expect(() => parseExecutionProfile(profile)).toThrow(/cwd|network|egress|relative/i);
  });

  it.each([
    {
      label: 'a selector that names no declared check tier',
      profile: {
        ...completeProfile,
        validation: {
          ...completeProfile.validation,
          selectors: [{ tier: 'simulator', always: true }],
          checks: [completeProfile.validation.checks[0]],
        },
      },
    },
    {
      label: 'a check with an unknown tier',
      profile: {
        ...completeProfile,
        validation: {
          ...completeProfile.validation,
          checks: completeProfile.validation.checks.map((check) =>
            check.id === 'unit' ? { ...check, tier: 'browser' } : check,
          ),
        },
      },
    },
  ])('rejects $label', ({ profile }) => {
    expect(() => parseExecutionProfile(profile)).toThrow(/tier|selector|check/i);
  });

  it.each([
    {
      label: 'an unknown resource type',
      pattern: /resource|type/i,
      profile: {
        ...completeProfile,
        provisioning: {
          steps: [{
            ...completeProfile.provisioning.steps[0],
            resources: [{ type: 'gpu', key: 'metal-farm', scope: 'step' }],
          }],
        },
      },
    },
    {
      label: 'an invalid lease scope',
      pattern: /scope/i,
      profile: {
        ...completeProfile,
        provisioning: {
          steps: [{
            ...completeProfile.provisioning.steps[0],
            resources: [{ type: 'cache-dir', key: 'brand-node-modules', scope: 'global' }],
          }],
        },
      },
    },
    {
      label: 'a resource that declares no lease scope',
      pattern: /scope/i,
      profile: {
        ...completeProfile,
        validation: {
          ...completeProfile.validation,
          checks: completeProfile.validation.checks.map((check) =>
            check.id === 'simulator-smoke'
              ? { ...check, resources: [{ type: 'simulator', key: 'iphone-16-pro' }] }
              : check,
          ),
        },
      },
    },
    {
      label: 'duplicate validation check ids',
      pattern: /duplicate|id/i,
      profile: {
        ...completeProfile,
        validation: {
          ...completeProfile.validation,
          checks: [...completeProfile.validation.checks, { ...completeProfile.validation.checks[0] }],
        },
      },
    },
    {
      label: 'duplicate setup step ids',
      pattern: /duplicate|id/i,
      profile: {
        ...completeProfile,
        setup: [...completeProfile.setup, { ...completeProfile.setup[0] }],
      },
    },
    {
      label: 'duplicate provisioning step ids',
      pattern: /duplicate|id/i,
      profile: {
        ...completeProfile,
        provisioning: {
          steps: [
            ...completeProfile.provisioning.steps,
            { ...completeProfile.provisioning.steps[0] },
          ],
        },
      },
    },
    {
      label: 'an absolute artifact path',
      pattern: /artifact|absolute|relative|path/i,
      profile: {
        ...completeProfile,
        validation: {
          ...completeProfile.validation,
          checks: completeProfile.validation.checks.map((check) =>
            check.id === 'ios-compile'
              ? { ...check, artifacts: [{ id: 'ios-build-log', path: '/tmp/xcodebuild.log' }] }
              : check,
          ),
        },
      },
    },
    {
      label: 'an artifact path that escapes the artifact root',
      pattern: /artifact|escape|relative|path/i,
      profile: {
        ...completeProfile,
        validation: {
          ...completeProfile.validation,
          checks: completeProfile.validation.checks.map((check) =>
            check.id === 'ios-compile'
              ? { ...check, artifacts: [{ id: 'ios-build-log', path: '../outside/xcodebuild.log' }] }
              : check,
          ),
        },
      },
    },
  ])('rejects $label', ({ profile, pattern }) => {
    expect(() => parseExecutionProfile(profile)).toThrow(pattern);
  });

  it('rejects a required manual-live check because it is a release item, not autonomous acceptance', () => {
    const profile = {
      ...completeProfile,
      validation: {
        ...completeProfile.validation,
        checks: completeProfile.validation.checks.map((check) =>
          check.id === 'release-smoke' ? { ...check, required: true } : check,
        ),
      },
    };

    expect(() => parseExecutionProfile(profile)).toThrow(/required.*manual-live|manual-live.*required/i);
  });

  it('creates an immutable, stable-hash snapshot so later configuration mutation cannot alter a run', () => {
    const mutableInput = structuredClone(completeProfile) as any;
    const first = createResolvedProfileSnapshot({
      productId: 'brand',
      profile: mutableInput,
      resolvedAt: '2026-08-05T17:00:00.000Z',
    });
    const sameConfiguration = createResolvedProfileSnapshot({
      productId: 'brand',
      profile: structuredClone(completeProfile),
      resolvedAt: '2026-08-05T17:01:00.000Z',
    });

    expect(first).toMatchObject({
      productId: 'brand',
      resolvedAt: '2026-08-05T17:00:00.000Z',
      profile: completeProfile,
    });
    expect(first.profileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sameConfiguration.profileHash).toBe(first.profileHash);

    // Mutate the exact object the snapshot was resolved from, the way a
    // configuration reload after run start would if the snapshot aliased it.
    mutableInput.validation.checks[0].argv.push('--changed-after-run-start');
    mutableInput.validation.checks[0].required = false;
    mutableInput.validation.selectors.pop();

    expect(first.profile).toEqual(completeProfile);
    expect(first.profile.validation.checks[0]!.argv).toEqual(['npm', 'test', '--', '--runInBand']);
    expect(createResolvedProfileSnapshot({
      productId: 'brand',
      profile: mutableInput,
      resolvedAt: '2026-08-05T17:02:00.000Z',
    })!.profileHash).not.toBe(first.profileHash);
  });

  it('round-trips a persisted resolved snapshot without profile or hash drift', () => {
    const snapshot = createResolvedProfileSnapshot({
      productId: 'brand',
      profile: completeProfile,
      resolvedAt: '2026-08-05T17:00:00.000Z',
    });

    const recovered = JSON.parse(JSON.stringify(snapshot));

    expect(parseResolvedProfileSnapshot(recovered)).toEqual(snapshot);
  });

  it('rejects a persisted snapshot whose profile no longer matches its hash', () => {
    const snapshot = structuredClone(createResolvedProfileSnapshot({
      productId: 'brand',
      profile: completeProfile,
      resolvedAt: '2026-08-05T17:00:00.000Z',
    })) as any;
    snapshot.profile.validation.checks[0].argv.push('--tampered');

    expect(() => parseResolvedProfileSnapshot(snapshot)).toThrow(/hash|match/i);
  });

  it('rejects unknown persisted snapshot fields', () => {
    const snapshot = {
      ...createResolvedProfileSnapshot({
        productId: 'brand',
        profile: completeProfile,
        resolvedAt: '2026-08-05T17:00:00.000Z',
      }),
      futureField: true,
    };

    expect(() => parseResolvedProfileSnapshot(snapshot)).toThrow(/unknown field/i);
  });

  it('returns no snapshot for an unprofiled product, preserving the legacy runner path', () => {
    expect(createResolvedProfileSnapshot({
      productId: 'legacy-node-product',
      profile: undefined,
      resolvedAt: '2026-08-05T17:00:00.000Z',
    })).toBeUndefined();
  });

  it('uses the parsed profile from products.json while an unprofiled product remains on the legacy path', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'rune-execution-profile-'));
    const configPath = join(fixtureRoot, 'products.json');
    try {
      writeFileSync(configPath, JSON.stringify({
        profiled: {
          repoPath: '/fixture/profiled',
          executionProfile: completeProfile,
        },
        legacy: {
          repoPath: '/fixture/legacy',
        },
      }));

      const products = readProductsConfig(configPath);

      expect(products.profiled!.executionProfile).toEqual(completeProfile);
      expect(products.legacy!.executionProfile).toBeUndefined();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
