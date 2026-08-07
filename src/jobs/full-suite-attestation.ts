/**
 * Trusted runtime boundary for canonical full-suite evidence.
 *
 * The provider-neutral schemas remain in intent/. This module owns the
 * security-sensitive host operations: adapter/config/dependency fingerprints,
 * per-run reporter capabilities, authenticated manifest admission, and compact
 * integration-gate receipt construction.
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from '../config.js';
import {
  canonicalGateValidationReceiptId,
  parseGateValidationReceipt,
  parseVitestManifest,
  type CompactValidationReceipt,
  type FullSuiteAttestation,
  type GateValidationReceipt,
  type ValidationAdapter,
  type ValidationBatchReceipt,
  type VitestLifecycleManifest,
} from '../intent/full-suite-attestation.js';
import type { ValidationProfilePlan } from '../intent/validation-profiles.js';
import { readBoundedRegularFileNoFollow } from '../utils/bounded-file.js';
import { parseValidationCommand } from './task-validation.js';
import type { ValidationCommandResult } from './work-run-gate-runtime.js';
import { DEFAULT_BASE_ENV_KEYS, getBaseEnv } from './credential-injector.js';

export * from '../intent/full-suite-attestation.js';

const MAX_VITEST_ATTESTATION_BYTES = 64 * 1024;
const VALIDATION_FINGERPRINT_FILE_MAX_BYTES = 8 * 1024 * 1024;
const AUTHENTICATION = /^[0-9a-f]{64}$/;
const CONFIG_FINGERPRINT_FILES = [
  'package.json',
  'tsconfig.json',
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
] as const;
const DEPENDENCY_FINGERPRINT_FILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const;

export interface ValidationFingerprints {
  commandFingerprint: string;
  configurationFingerprint: string;
  dependencyFingerprint: string;
  environmentFingerprint: string;
  toolchainFingerprint: string;
}

export interface TrustedVitestImplementation {
  reporterSource: string;
  observerSource: string;
  extractorSource: string;
  runtimeFingerprint: string;
}

// Resolve the validation TCB from this module's installed location, not the
// configurable/mocked product root. Use a native require so broad Vitest
// `node:fs` mocks cannot replace boot-time trust capture.
const nativeFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const TRUSTED_CODE_ROOT = nativeFs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const TRUSTED_VITEST_RUNTIME_ROOTS = [
  join(TRUSTED_CODE_ROOT, 'node_modules', 'vitest'),
  join(TRUSTED_CODE_ROOT, 'node_modules', '@vitest'),
  join(TRUSTED_CODE_ROOT, 'node_modules', 'vite'),
] as const;

function fingerprintTrustedVitestRuntime(): string {
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  const visit = (root: string, path: string): void => {
    const stats = nativeFs.lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw new Error('trusted Vitest runtime contains a symbolic link');
    }
    if (stats.isDirectory()) {
      for (const name of nativeFs.readdirSync(path).sort()) visit(root, join(path, name));
      return;
    }
    if (!stats.isFile()) return;
    files += 1;
    bytes += stats.size;
    if (files > 10_000 || bytes > 64 * 1024 * 1024) {
      throw new Error('trusted Vitest runtime exceeded its fingerprint bound');
    }
    hash.update(`${relative(root, path).replaceAll('\\', '/')}\0${stats.size}\0`);
    hash.update(nativeFs.readFileSync(path));
    hash.update('\0');
  };
  for (const root of TRUSTED_VITEST_RUNTIME_ROOTS) {
    const real = nativeFs.realpathSync(root);
    hash.update(`${relative(TRUSTED_CODE_ROOT, real)}\0`);
    visit(real, real);
  }
  return hash.digest('hex');
}

// Module initialization occurs when Rune boots, before product-role execution.
// Later validation must match this known-good installed runtime exactly.
const BOOT_TRUSTED_VITEST_RUNTIME_FINGERPRINT = fingerprintTrustedVitestRuntime();

function readTrustedImplementationFile(path: string): string {
  const real = nativeFs.realpathSync(path);
  const stats = nativeFs.statSync(real);
  if (
    !stats.isFile() ||
    stats.size < 1 ||
    stats.size > VALIDATION_FINGERPRINT_FILE_MAX_BYTES
  ) {
    throw new Error('trusted validation adapter implementation is unavailable or oversized');
  }
  return nativeFs.readFileSync(real, 'utf8');
}

export function captureTrustedVitestImplementation(paths: {
  reporterPath: string;
  observerPath: string;
  extractorPath: string;
}): TrustedVitestImplementation {
  const runtimeFingerprint = fingerprintTrustedVitestRuntime();
  if (runtimeFingerprint !== BOOT_TRUSTED_VITEST_RUNTIME_FINGERPRINT) {
    throw new Error('trusted Vitest runtime changed after Rune startup');
  }
  return {
    reporterSource: readTrustedImplementationFile(paths.reporterPath),
    observerSource: readTrustedImplementationFile(paths.observerPath),
    extractorSource: readTrustedImplementationFile(paths.extractorPath),
    runtimeFingerprint,
  };
}

export interface FullSuiteValidationEvidence {
  attestations: FullSuiteAttestation[];
  receipts: CompactValidationReceipt[];
  coverageComplete: boolean;
  validationReceipt: ValidationBatchReceipt;
  gateValidationReceipt?: GateValidationReceipt;
}

export type FullSuiteValidationResult =
  | ({ ok: true } & FullSuiteValidationEvidence)
  | ({
      ok: false;
      command: string;
      argv?: readonly string[];
      result: ValidationCommandResult;
    } & Omit<FullSuiteValidationEvidence, 'coverageComplete'> & {
      coverageComplete: false;
    });

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprintFiles(cwd: string, names: readonly string[]): string {
  const root = realpathSync(cwd);
  const hash = createHash('sha256');
  for (const name of names) {
    const candidate = resolve(cwd, name);
    if (!existsSync(candidate)) {
      hash.update(`${name}\0missing\0`);
      continue;
    }
    const real = realpathSync(candidate);
    const rel = relative(root, real);
    if (
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      rel.startsWith('/') ||
      rel.includes('\\')
    ) {
      throw new Error(`validation fingerprint path escaped cwd: ${name}`);
    }
    const stats = statSync(real);
    if (!stats.isFile() || stats.size > VALIDATION_FINGERPRINT_FILE_MAX_BYTES) {
      throw new Error(`validation fingerprint file is unavailable or oversized: ${name}`);
    }
    hash.update(`${name}\0${stats.size}\0`);
    hash.update(readFileSync(real));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function fingerprintTrustedAdapter(
  implementationSources: readonly string[],
): string {
  const hash = createHash('sha256');
  for (const source of implementationSources) {
    hash.update(source);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function fingerprintValidationEnvironment(
  env: Readonly<Record<string, string | undefined>> = getBaseEnv(DEFAULT_BASE_ENV_KEYS),
): string {
  const entries = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return sha256(JSON.stringify({ version: 1, entries }));
}

function resolveTool(pathEnv: string, command: string): string | undefined {
  const candidates = isAbsolute(command) || command.includes('/')
    ? [command]
    : pathEnv.split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export function fingerprintValidationToolchain(
  commands: readonly string[],
  env: Readonly<Record<string, string | undefined>> = getBaseEnv(DEFAULT_BASE_ENV_KEYS),
): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    version: 1,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  }));
  // Configured commands overwhelmingly share one executable (`npm run build` + `npm run
  // test`, four `uv` commands), and the PATH walk plus bounded binary read is the dominant
  // synchronous cost of a capture. Resolve each distinct tool once per call so the hash
  // input is unchanged while the fs work scales with distinct tools, not command count.
  // The cache is per-call only, so drift between two captures stays fully visible.
  const resolved = new Map<string, { size: number; mtimeMs: number; bytes?: Buffer }>();
  const missing = new Set<string>();
  for (const command of commands) {
    const parsed = parseValidationCommand(command);
    if (!parsed.ok) throw new Error(`malformed validation command: ${command}`);
    const tool = parsed.argv[0]!;
    if (!resolved.has(tool) && !missing.has(tool)) {
      const executable = resolveTool(env.PATH ?? '', tool);
      if (executable === undefined) {
        missing.add(tool);
      } else {
        const real = realpathSync(executable);
        const stats = statSync(real);
        resolved.set(tool, {
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          ...(stats.size <= VALIDATION_FINGERPRINT_FILE_MAX_BYTES
            ? { bytes: readFileSync(real) }
            : {}),
        });
      }
    }
    const entry = resolved.get(tool);
    if (entry === undefined) {
      hash.update(`\0${tool}\0missing`);
      continue;
    }
    hash.update(`\0${tool}\0${entry.size}\0${entry.mtimeMs}`);
    if (entry.bytes !== undefined) hash.update(entry.bytes);
  }
  return hash.digest('hex');
}

export function captureValidationFingerprints(
  cwd: string,
  commands: readonly string[],
  adapters: readonly ValidationAdapter[],
  trustedVitestImplementation: TrustedVitestImplementation,
  profilePlan?: ValidationProfilePlan,
): ValidationFingerprints {
  const validationEnv = getBaseEnv(DEFAULT_BASE_ENV_KEYS);
  const configuredArgv = commands.map((command) => {
    const parsed = parseValidationCommand(command);
    if (!parsed.ok) throw new Error(`malformed validation command: ${command}`);
    return parsed.argv;
  });
  const implementationFingerprint = fingerprintTrustedAdapter([
    trustedVitestImplementation.reporterSource,
    trustedVitestImplementation.observerSource,
    trustedVitestImplementation.extractorSource,
    trustedVitestImplementation.runtimeFingerprint,
  ]);
  return {
    commandFingerprint: sha256(JSON.stringify({
      configuredArgv,
      adapters: adapters.map(({ command, runner, profileSelection }) => ({
        command,
        runner,
        version: 1,
        profileSelection,
        implementationFingerprint,
      })),
      profilePlan,
    })),
    configurationFingerprint: fingerprintFiles(cwd, CONFIG_FINGERPRINT_FILES),
    dependencyFingerprint: fingerprintFiles(cwd, DEPENDENCY_FINGERPRINT_FILES),
    environmentFingerprint: fingerprintValidationEnvironment(validationEnv),
    toolchainFingerprint: fingerprintValidationToolchain(commands, validationEnv),
  };
}

export function createVitestAttestationCapability(): string {
  return randomBytes(32).toString('hex');
}

function manifestAuthentication(
  manifest: VitestLifecycleManifest,
  capability: string,
): string {
  return createHmac('sha256', capability)
    .update(JSON.stringify(manifest))
    .digest('hex');
}

export function readAuthenticatedVitestManifest(
  path: string,
  capability: string,
): VitestLifecycleManifest | undefined {
  if (!AUTHENTICATION.test(capability)) return undefined;
  const buffer = readBoundedRegularFileNoFollow(path, {
    minBytes: 2,
    maxBytes: MAX_VITEST_ATTESTATION_BYTES,
  });
  if (buffer === undefined) return undefined;
  try {
    const envelope = JSON.parse(buffer.toString('utf8')) as unknown;
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      Object.keys(envelope).some((key) => key !== 'manifest' && key !== 'authentication')
    ) return undefined;
    const record = envelope as Record<string, unknown>;
    const manifest = parseVitestManifest(record['manifest']);
    const authentication = record['authentication'];
    if (
      manifest === undefined ||
      typeof authentication !== 'string' ||
      !AUTHENTICATION.test(authentication)
    ) return undefined;
    const expected = Buffer.from(manifestAuthentication(manifest, capability), 'hex');
    const actual = Buffer.from(authentication, 'hex');
    return timingSafeEqual(actual, expected) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

export function buildGateValidationReceipt(input: {
  treeOid: string;
  fullTaskReviewHash: string;
  completedAt: string;
  fingerprints: ValidationFingerprints;
  batch: ValidationBatchReceipt;
}): GateValidationReceipt | undefined {
  const {
    environmentFingerprint,
    toolchainFingerprint,
    ...legacyFingerprints
  } = input.fingerprints;
  const base = {
    treeOid: input.treeOid,
    fullTaskReviewHash: input.fullTaskReviewHash,
    completedAt: input.completedAt,
    ...legacyFingerprints,
    ...input.batch,
  };
  // A batch with no profile plan predates profiled validation and must round-trip as a
  // version-1 receipt. The strict parser fail-closes on any non-V3 receipt carrying a
  // V3-only field, so the environment/toolchain fingerprints belong to the V3 branch only.
  if (input.batch.profilePlan === undefined) {
    return parseGateValidationReceipt({ version: 1 as const, ...base });
  }
  const candidate = {
    version: 3 as const,
    ...base,
    environmentFingerprint,
    toolchainFingerprint,
  };
  return parseGateValidationReceipt({
    ...candidate,
    receiptId: canonicalGateValidationReceiptId(candidate),
  });
}
