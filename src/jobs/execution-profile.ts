import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, posix, win32 } from 'node:path';

export type NetworkMode = 'offline' | 'local-fake' | 'approved-egress' | 'manual-live';
export type ExecutionTier = 'fast' | 'native-compile' | 'simulator' | 'manual-live';
export type ProfileResourceType =
  | 'simulator'
  | 'emulator'
  | 'cache-dir'
  | 'port-range'
  | 'build-capacity'
  | 'device';
export type ResourceLeaseScope = 'step' | 'run';

export interface ResourceRequirement {
  type: ProfileResourceType;
  key: string;
  capacity?: number;
  scope: ResourceLeaseScope;
}

export interface ArtifactSpec {
  id: string;
  path: string;
}

export interface CommandSpec {
  id: string;
  argv: [string, ...string[]];
  cwd?: string;
  env?: Record<string, string>;
  network: NetworkMode;
  timeoutMs?: number;
  resources?: ResourceRequirement[];
}

export interface ToolchainRequirement {
  kind: string;
  version: string;
  versionProbe: [string, ...string[]];
  packageManager?: {
    name: string;
    version?: string;
  };
}

export interface ProvisionStep {
  id: string;
  provisioner: string;
  config?: unknown;
  network: Exclude<NetworkMode, 'manual-live'>;
  resources?: ResourceRequirement[];
}

export interface ValidationCheck extends CommandSpec {
  required: boolean;
  tier: ExecutionTier;
  artifacts?: ArtifactSpec[];
  retry?: {
    attempts: 1 | 2;
    reasons: Array<'timeout' | 'known-flake'>;
  };
}

export interface TierSelector {
  tier: ExecutionTier;
  changedPathGlobs?: string[];
  flowTags?: string[];
  always?: boolean;
}

export interface ExecutionProfile {
  profileVersion: 1;
  toolchains: ToolchainRequirement[];
  env?: {
    required: string[];
    optional?: string[];
  };
  provisioning: {
    steps: ProvisionStep[];
  };
  setup?: CommandSpec[];
  validation: {
    selectors: TierSelector[];
    checks: ValidationCheck[];
  };
}

export interface ResolvedProfileSnapshot {
  profile: ExecutionProfile;
  profileHash: string;
  productId: string;
  resolvedAt: string;
}

const NETWORK_MODES = new Set<NetworkMode>([
  'offline',
  'local-fake',
  'approved-egress',
  'manual-live',
]);
const TIERS = new Set<ExecutionTier>([
  'fast',
  'native-compile',
  'simulator',
  'manual-live',
]);
const RESOURCE_TYPES = new Set<ProfileResourceType>([
  'simulator',
  'emulator',
  'cache-dir',
  'port-range',
  'build-capacity',
  'device',
]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function objectAt(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find(key => !allowedKeys.has(key));
  if (unknown !== undefined) throw new Error(`${location} has unknown field '${unknown}'`);
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${location} must be a non-empty trimmed string`);
  }
  return value;
}

function arrayAt(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  return value;
}

function assertUnique(values: readonly string[], location: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${location} contains a duplicate value or id`);
  }
}

function assertArgv(value: unknown, location: string): asserts value is [string, ...string[]] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${location}.argv must be a non-empty argv command array`);
  }
  for (const [index, arg] of value.entries()) {
    if (typeof arg !== 'string' || (index === 0 && arg.trim() === '')) {
      throw new Error(`${location}.argv[${index}] must be ${index === 0 ? 'a non-empty' : 'a'} string`);
    }
  }
}

function assertContainedRelativePath(value: unknown, location: string): asserts value is string {
  const path = nonEmptyString(value, location);
  const segments = path.split(/[\\/]+/);
  if (
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.includes('\0') ||
    segments.includes('..') ||
    posix.normalize(path.replaceAll('\\', '/')).startsWith('../')
  ) {
    throw new Error(`${location} must be a contained relative path and cannot escape its root`);
  }
}

function assertPositiveInteger(value: unknown, location: string): void {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${location} must be a positive integer`);
  }
}

function parseResource(value: unknown, location: string): ResourceRequirement {
  const resource = objectAt(value, location);
  assertOnlyKeys(resource, ['type', 'key', 'capacity', 'scope'], location);
  if (!RESOURCE_TYPES.has(resource['type'] as ProfileResourceType)) {
    throw new Error(`${location}.type is not a supported resource type`);
  }
  nonEmptyString(resource['key'], `${location}.key`);
  if (resource['capacity'] !== undefined) {
    assertPositiveInteger(resource['capacity'], `${location}.capacity`);
  }
  if (resource['scope'] !== 'step' && resource['scope'] !== 'run') {
    throw new Error(`${location}.scope must be 'step' or 'run'`);
  }
  return resource as unknown as ResourceRequirement;
}

function parseResources(value: unknown, location: string): ResourceRequirement[] | undefined {
  if (value === undefined) return undefined;
  const raw = arrayAt(value, location);
  const resources = raw.map((resource, index) => parseResource(resource, `${location}[${index}]`));
  assertUnique(resources.map(resource => `${resource.type}:${resource.key}`), location);
  return resources;
}

function parseEnvMap(value: unknown, location: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const env = objectAt(value, location);
  for (const [name, envValue] of Object.entries(env)) {
    if (!ENV_NAME.test(name) || typeof envValue !== 'string') {
      throw new Error(`${location} must map valid environment-variable names to string values`);
    }
  }
  return env as Record<string, string>;
}

function parseNetwork(value: unknown, location: string): NetworkMode {
  if (!NETWORK_MODES.has(value as NetworkMode)) {
    throw new Error(`${location} is not a supported network policy`);
  }
  return value as NetworkMode;
}

function parseCommand(value: unknown, location: string): CommandSpec {
  const command = objectAt(value, location);
  assertOnlyKeys(command, ['id', 'argv', 'cwd', 'env', 'network', 'timeoutMs', 'resources'], location);
  nonEmptyString(command['id'], `${location}.id`);
  assertArgv(command['argv'], location);
  if (command['cwd'] !== undefined) assertContainedRelativePath(command['cwd'], `${location}.cwd`);
  parseEnvMap(command['env'], `${location}.env`);
  const network = parseNetwork(command['network'], `${location}.network`);
  if (network === 'manual-live') {
    throw new Error(`${location}.network cannot be manual-live for an automatic setup command`);
  }
  if (command['timeoutMs'] !== undefined) {
    assertPositiveInteger(command['timeoutMs'], `${location}.timeoutMs`);
  }
  parseResources(command['resources'], `${location}.resources`);
  return command as unknown as CommandSpec;
}

function parseToolchain(value: unknown, location: string): ToolchainRequirement {
  const toolchain = objectAt(value, location);
  assertOnlyKeys(toolchain, ['kind', 'version', 'versionProbe', 'packageManager'], location);
  nonEmptyString(toolchain['kind'], `${location}.kind`);
  nonEmptyString(toolchain['version'], `${location}.version`);
  assertArgv(toolchain['versionProbe'], `${location}.versionProbe`);
  if (toolchain['packageManager'] !== undefined) {
    const manager = objectAt(toolchain['packageManager'], `${location}.packageManager`);
    assertOnlyKeys(manager, ['name', 'version'], `${location}.packageManager`);
    nonEmptyString(manager['name'], `${location}.packageManager.name`);
    if (manager['version'] !== undefined) {
      nonEmptyString(manager['version'], `${location}.packageManager.version`);
    }
  }
  return toolchain as unknown as ToolchainRequirement;
}

function parseProvisionStep(value: unknown, location: string): ProvisionStep {
  const step = objectAt(value, location);
  assertOnlyKeys(step, ['id', 'provisioner', 'config', 'network', 'resources'], location);
  nonEmptyString(step['id'], `${location}.id`);
  nonEmptyString(step['provisioner'], `${location}.provisioner`);
  const network = parseNetwork(step['network'], `${location}.network`);
  if (network === 'manual-live') {
    throw new Error(`${location}.network cannot be manual-live for automatic provisioning`);
  }
  parseResources(step['resources'], `${location}.resources`);
  return step as unknown as ProvisionStep;
}

function parseArtifact(value: unknown, location: string): ArtifactSpec {
  const artifact = objectAt(value, location);
  assertOnlyKeys(artifact, ['id', 'path'], location);
  nonEmptyString(artifact['id'], `${location}.id`);
  assertContainedRelativePath(artifact['path'], `${location}.path`);
  return artifact as unknown as ArtifactSpec;
}

function parseValidationCheck(value: unknown, location: string): ValidationCheck {
  const check = objectAt(value, location);
  assertOnlyKeys(
    check,
    ['id', 'argv', 'cwd', 'env', 'network', 'timeoutMs', 'resources', 'required', 'tier', 'artifacts', 'retry'],
    location,
  );
  nonEmptyString(check['id'], `${location}.id`);
  assertArgv(check['argv'], location);
  if (check['cwd'] !== undefined) assertContainedRelativePath(check['cwd'], `${location}.cwd`);
  parseEnvMap(check['env'], `${location}.env`);
  const network = parseNetwork(check['network'], `${location}.network`);
  if (network === 'approved-egress') {
    throw new Error(`${location}.network cannot use approved-egress for a validation check`);
  }
  if (check['timeoutMs'] !== undefined) assertPositiveInteger(check['timeoutMs'], `${location}.timeoutMs`);
  parseResources(check['resources'], `${location}.resources`);
  if (typeof check['required'] !== 'boolean') throw new Error(`${location}.required must be boolean`);
  if (!TIERS.has(check['tier'] as ExecutionTier)) throw new Error(`${location}.tier is not a supported check tier`);
  const tier = check['tier'] as ExecutionTier;
  if ((network === 'manual-live') !== (tier === 'manual-live')) {
    throw new Error(`${location} must pair the manual-live tier with the manual-live network policy`);
  }
  if (tier === 'manual-live' && check['required'] === true) {
    throw new Error(`${location}: required checks cannot use the manual-live tier`);
  }
  if (check['artifacts'] !== undefined) {
    const artifacts = arrayAt(check['artifacts'], `${location}.artifacts`)
      .map((artifact, index) => parseArtifact(artifact, `${location}.artifacts[${index}]`));
    assertUnique(artifacts.map(artifact => artifact.id), `${location}.artifacts`);
  }
  if (check['retry'] !== undefined) {
    const retry = objectAt(check['retry'], `${location}.retry`);
    assertOnlyKeys(retry, ['attempts', 'reasons'], `${location}.retry`);
    if (retry['attempts'] !== 1 && retry['attempts'] !== 2) {
      throw new Error(`${location}.retry.attempts must be 1 or 2`);
    }
    const reasons = arrayAt(retry['reasons'], `${location}.retry.reasons`);
    if (reasons.length === 0 || reasons.some(reason => reason !== 'timeout' && reason !== 'known-flake')) {
      throw new Error(`${location}.retry.reasons contains an unsupported retry reason`);
    }
    assertUnique(reasons as string[], `${location}.retry.reasons`);
  }
  return check as unknown as ValidationCheck;
}

function parseStringList(value: unknown, location: string, validate?: (value: string) => boolean): string[] {
  const values = arrayAt(value, location).map((entry, index) => {
    const string = nonEmptyString(entry, `${location}[${index}]`);
    if (validate && !validate(string)) throw new Error(`${location}[${index}] is invalid`);
    return string;
  });
  assertUnique(values, location);
  return values;
}

function parseSelector(value: unknown, location: string): TierSelector {
  const selector = objectAt(value, location);
  assertOnlyKeys(selector, ['tier', 'changedPathGlobs', 'flowTags', 'always'], location);
  if (!TIERS.has(selector['tier'] as ExecutionTier)) {
    throw new Error(`${location}.tier is not a supported selector tier`);
  }
  if (selector['changedPathGlobs'] !== undefined) {
    parseStringList(selector['changedPathGlobs'], `${location}.changedPathGlobs`, glob => {
      const segments = glob.split(/[\\/]+/);
      return !isAbsolute(glob) && !win32.isAbsolute(glob) && !segments.includes('..');
    });
  }
  if (selector['flowTags'] !== undefined) {
    parseStringList(selector['flowTags'], `${location}.flowTags`);
  }
  if (selector['always'] !== undefined && typeof selector['always'] !== 'boolean') {
    throw new Error(`${location}.always must be boolean`);
  }
  if (
    selector['always'] !== true &&
    selector['changedPathGlobs'] === undefined &&
    selector['flowTags'] === undefined
  ) {
    throw new Error(`${location} must declare always, changedPathGlobs, or flowTags`);
  }
  return selector as unknown as TierSelector;
}

/** Validate one products.json executionProfile and return an independent value-identical copy. */
export function parseExecutionProfile(value: unknown): ExecutionProfile {
  const profile = objectAt(value, 'executionProfile');
  assertOnlyKeys(profile, ['profileVersion', 'toolchains', 'env', 'provisioning', 'setup', 'validation'], 'executionProfile');
  if (profile['profileVersion'] !== 1) {
    throw new Error(`executionProfile.profileVersion must be the supported version 1`);
  }

  const toolchains = arrayAt(profile['toolchains'], 'executionProfile.toolchains')
    .map((toolchain, index) => parseToolchain(toolchain, `executionProfile.toolchains[${index}]`));
  assertUnique(toolchains.map(toolchain => toolchain.kind), 'executionProfile.toolchains');

  if (profile['env'] !== undefined) {
    const env = objectAt(profile['env'], 'executionProfile.env');
    assertOnlyKeys(env, ['required', 'optional'], 'executionProfile.env');
    const required = parseStringList(env['required'], 'executionProfile.env.required', name => ENV_NAME.test(name));
    const optional = env['optional'] === undefined
      ? []
      : parseStringList(env['optional'], 'executionProfile.env.optional', name => ENV_NAME.test(name));
    const overlap = required.find(name => optional.includes(name));
    if (overlap !== undefined) {
      throw new Error(`executionProfile.env repeats '${overlap}' across required and optional names`);
    }
  }

  const provisioning = objectAt(profile['provisioning'], 'executionProfile.provisioning');
  assertOnlyKeys(provisioning, ['steps'], 'executionProfile.provisioning');
  const provisionSteps = arrayAt(provisioning['steps'], 'executionProfile.provisioning.steps')
    .map((step, index) => parseProvisionStep(step, `executionProfile.provisioning.steps[${index}]`));
  assertUnique(provisionSteps.map(step => step.id), 'executionProfile.provisioning.steps');

  if (profile['setup'] !== undefined) {
    const setup = arrayAt(profile['setup'], 'executionProfile.setup')
      .map((command, index) => parseCommand(command, `executionProfile.setup[${index}]`));
    assertUnique(setup.map(command => command.id), 'executionProfile.setup');
  }

  const validation = objectAt(profile['validation'], 'executionProfile.validation');
  assertOnlyKeys(validation, ['selectors', 'checks'], 'executionProfile.validation');
  const checks = arrayAt(validation['checks'], 'executionProfile.validation.checks')
    .map((check, index) => parseValidationCheck(check, `executionProfile.validation.checks[${index}]`));
  assertUnique(checks.map(check => check.id), 'executionProfile.validation.checks');
  const artifactIds = checks.flatMap(check => check.artifacts?.map(artifact => artifact.id) ?? []);
  assertUnique(artifactIds, 'executionProfile.validation artifact ids');

  const selectors = arrayAt(validation['selectors'], 'executionProfile.validation.selectors')
    .map((selector, index) => parseSelector(selector, `executionProfile.validation.selectors[${index}]`));
  const checkTiers = new Set(checks.map(check => check.tier));
  for (const selector of selectors) {
    if (!checkTiers.has(selector.tier)) {
      throw new Error(`executionProfile selector tier '${selector.tier}' references no declared check tier`);
    }
  }
  if (!selectors.some(selector => selector.tier === 'fast' && selector.always === true)) {
    throw new Error(`executionProfile selectors must always select the mandatory fast tier`);
  }

  return structuredClone(profile) as unknown as ExecutionProfile;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('executionProfile contains a value that cannot be persisted as JSON');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** Resolve an optional profile into the immutable, hash-pinned form persisted by a run. */
export function createResolvedProfileSnapshot(input: {
  productId: string;
  profile: object;
  resolvedAt: string;
}): ResolvedProfileSnapshot;
export function createResolvedProfileSnapshot(input: {
  productId: string;
  profile: undefined;
  resolvedAt: string;
}): undefined;
export function createResolvedProfileSnapshot(input: {
  productId: string;
  profile: unknown | undefined;
  resolvedAt: string;
}): ResolvedProfileSnapshot | undefined {
  if (input.profile === undefined) return undefined;
  const productId = nonEmptyString(input.productId, 'resolved profile productId');
  const resolvedAt = nonEmptyString(input.resolvedAt, 'resolved profile resolvedAt');
  const profile = parseExecutionProfile(input.profile);
  const profileHash = createHash('sha256').update(canonicalJson(profile)).digest('hex');
  return deepFreeze({ profile, profileHash, productId, resolvedAt });
}

/** Parse a persisted snapshot and verify that its profile still matches its recorded hash. */
export function parseResolvedProfileSnapshot(value: unknown): ResolvedProfileSnapshot {
  const snapshot = objectAt(value, 'resolvedProfileSnapshot');
  assertOnlyKeys(snapshot, ['profile', 'profileHash', 'productId', 'resolvedAt'], 'resolvedProfileSnapshot');
  const productId = nonEmptyString(snapshot['productId'], 'resolvedProfileSnapshot.productId');
  const resolvedAt = nonEmptyString(snapshot['resolvedAt'], 'resolvedProfileSnapshot.resolvedAt');
  const profileHash = nonEmptyString(snapshot['profileHash'], 'resolvedProfileSnapshot.profileHash');
  if (!/^[a-f0-9]{64}$/.test(profileHash)) {
    throw new Error('resolvedProfileSnapshot.profileHash must be a SHA-256 digest');
  }
  const resolved = createResolvedProfileSnapshot({
    productId,
    profile: objectAt(snapshot['profile'], 'resolvedProfileSnapshot.profile'),
    resolvedAt,
  });
  if (resolved.profileHash !== profileHash) {
    throw new Error('resolvedProfileSnapshot.profileHash does not match its persisted profile');
  }
  return resolved;
}

/**
 * Lightweight profile-only products.json reader for mutation seeding. Keeping
 * this here avoids pulling sandbox-runtime's child-process graph into nightly.
 */
export function readProductExecutionProfile(
  configPath: string,
  productId: string,
): ExecutionProfile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`could not read executionProfile from ${configPath}: ${(error as Error).message}`);
  }
  const products = objectAt(parsed, 'products config');
  const product = objectAt(products[productId], `products config product '${productId}'`);
  return product['executionProfile'] === undefined
    ? undefined
    : parseExecutionProfile(product['executionProfile']);
}
