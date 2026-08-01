/** Deterministic capability profiles for product-controlled validation. */

import { createHash } from 'node:crypto';

export const VALIDATION_PROFILES = [
  'isolated',
  'loopback',
  'sandbox-integration',
] as const;

export type ValidationProfile = typeof VALIDATION_PROFILES[number];
export type ValidationProfileSelection = 'strict-tags-v1';

export interface ValidationCommandProfile {
  command: string;
  profile: ValidationProfile;
}

export const VALIDATION_LOOPBACK_TAG = 'validation-loopback';
export const VALIDATION_SANDBOX_INTEGRATION_TAG = 'validation-sandbox-integration';

/** The reserved capability vocabulary, in selector order. */
export const VALIDATION_CAPABILITY_TAGS = [
  VALIDATION_LOOPBACK_TAG,
  VALIDATION_SANDBOX_INTEGRATION_TAG,
] as const;

export interface ValidationProfileShard {
  command: string;
  argv: string[];
  profile: ValidationProfile;
  selector?: string;
}

export interface ValidationProfilePlan {
  version: 1;
  shards: ValidationProfileShard[];
  definitionFingerprint: string;
}

export type ProfiledValidationAdapter = {
  command: string;
  runner: 'vitest';
  profileSelection?: ValidationProfileSelection;
};

export function isValidationProfile(value: unknown): value is ValidationProfile {
  return typeof value === 'string' &&
    (VALIDATION_PROFILES as readonly string[]).includes(value);
}

/**
 * Validate a live command/profile contract. Historical evidence parsers do not
 * call this function, so old durable records remain readable but cannot create
 * a current executable plan.
 */
export function validateValidationCommandProfiles(
  commands: readonly string[],
  assignments: readonly ValidationCommandProfile[],
): ValidationCommandProfile[] {
  const declared = new Set(commands);
  const seen = new Set<string>();
  const normalized: ValidationCommandProfile[] = [];
  for (const assignment of assignments) {
    if (!declared.has(assignment.command)) {
      throw new Error(`validationCommandProfiles assigns unknown command: ${assignment.command}`);
    }
    if (!isValidationProfile(assignment.profile)) {
      throw new Error(`validationCommandProfiles assigns unknown profile to: ${assignment.command}`);
    }
    if (seen.has(assignment.command)) {
      throw new Error(`validationCommandProfiles contains duplicate assignment: ${assignment.command}`);
    }
    seen.add(assignment.command);
    normalized.push({ command: assignment.command, profile: assignment.profile });
  }
  const missing = commands.find((command) => !seen.has(command));
  if (missing !== undefined) {
    throw new Error(`validationCommandProfiles is missing assignment for: ${missing}`);
  }
  return normalized;
}

export function validationSelectorFor(profile: ValidationProfile): string {
  if (profile === 'isolated') {
    return `!${VALIDATION_LOOPBACK_TAG} && !${VALIDATION_SANDBOX_INTEGRATION_TAG}`;
  }
  if (profile === 'loopback') {
    return `${VALIDATION_LOOPBACK_TAG} && !${VALIDATION_SANDBOX_INTEGRATION_TAG}`;
  }
  return `${VALIDATION_SANDBOX_INTEGRATION_TAG} && !${VALIDATION_LOOPBACK_TAG}`;
}

/**
 * A test carrying both reserved tags matches NONE of the three mutually
 * exclusive selectors above, so Vitest skips it in every shard while the
 * lifecycle counts still reconcile — zero coverage under a green attestation.
 *
 * This is the canonical rule. Per-test tags are only visible inside the runner,
 * so enforcement lives in `scripts/vitest-attestation-reporter.mjs`, which
 * counts each conflicting test as a collection error (making
 * `vitestLifecycleReconciles` false). `scripts/vitest-attestation-reporter.test.ts`
 * holds the reporter to exactly this predicate.
 */
export function hasConflictingValidationTags(tags: readonly string[]): boolean {
  return VALIDATION_CAPABILITY_TAGS.every((tag) => tags.includes(tag));
}

export function assertUnambiguousValidationTags(tags: readonly string[]): void {
  if (hasConflictingValidationTags(tags)) {
    throw new Error('validation test carries conflicting capability tags');
  }
}

function appendTagsFilter(argv: readonly string[], selector: string): string[] {
  if (argv.some((arg) => arg === '--tags-filter' || arg.startsWith('--tags-filter='))) {
    throw new Error('configured Vitest command must not supply its own tags filter');
  }
  const separatorNeeded = argv[0] === 'npm' && (
    argv[1] === 'test' || (argv[1] === 'run' && argv[2] === 'test')
  );
  return [...argv, ...(separatorNeeded ? ['--'] : []), `--tags-filter=${selector}`];
}

/** Expand a live validation contract into stable, pre-execution shards. */
export function planValidationProfiles(args: {
  commands: readonly string[];
  commandProfiles: readonly ValidationCommandProfile[];
  adapters: readonly ProfiledValidationAdapter[];
  parseCommand: (command: string) => { ok: true; argv: string[] } | { ok: false };
}): ValidationProfilePlan {
  const profiles = validateValidationCommandProfiles(args.commands, args.commandProfiles);
  const byCommand = new Map(profiles.map((entry) => [entry.command, entry.profile]));
  const adapters = new Map(args.adapters.map((entry) => [entry.command, entry]));
  const shards: ValidationProfileShard[] = [];
  for (const command of args.commands) {
    const parsed = args.parseCommand(command);
    if (!parsed.ok) throw new Error(`malformed configured validation command: ${command}`);
    const adapter = adapters.get(command);
    if (adapter?.profileSelection === 'strict-tags-v1') {
      for (const profile of VALIDATION_PROFILES) {
        const selector = validationSelectorFor(profile);
        shards.push({
          command,
          argv: appendTagsFilter(parsed.argv, selector),
          profile,
          selector,
        });
      }
    } else {
      shards.push({ command, argv: [...parsed.argv], profile: byCommand.get(command)! });
    }
  }
  const definitionFingerprint = createHash('sha256').update(JSON.stringify({
    version: 1,
    profiles: VALIDATION_PROFILES,
    tags: [VALIDATION_LOOPBACK_TAG, VALIDATION_SANDBOX_INTEGRATION_TAG],
    assignments: profiles,
    adapters: args.adapters,
    shards: shards.map(({ command, profile, selector }) => ({ command, profile, selector })),
  })).digest('hex');
  return { version: 1, shards, definitionFingerprint };
}
