/**
 * Bounded durable evidence for one Rune-owned configured validation suite.
 *
 * This module is deliberately pure. The trusted launcher owns Git capture,
 * fingerprinting, process confinement, and reporter injection; persistence and
 * user surfaces admit only values that pass these guards.
 */

import { isAbsolute, normalize } from 'node:path';
import { isGitObjectId } from './git-object-id.js';

export const FULL_SUITE_ATTESTATION_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_COMMANDS = 32;
const MAX_ARGV = 64;
const MAX_ARG_CHARS = 1_000;
const MAX_COUNT = 10_000_000;

export interface ValidationAdapter {
  command: string;
  runner: 'vitest';
}

export interface VitestLifecycleManifest {
  version: 1;
  runner: 'vitest';
  completedNormally: boolean;
  collectionErrors: number;
  discovered: {
    suites: number;
    tests: number;
  };
  completed: {
    suites: number;
    tests: number;
    passed: number;
    failed: number;
    skipped: number;
    todo: number;
    cancelled: number;
  };
}

export interface FullSuiteAttestation {
  version: 1;
  treeOid: string;
  fullTaskReviewHash: string;
  /** Worktree-relative label only; never an absolute host path. */
  validationCwd: string;
  /** Configured argv, before Rune's private reporter injection. */
  configuredArgv: string[][];
  adapter:
    | { runner: 'vitest'; version: 1 }
    | { runner: 'unsupported'; version: 1 };
  commandFingerprint: string;
  configurationFingerprint: string;
  dependencyFingerprint: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  execution: {
    outcome: 'passed' | 'failed' | 'cancelled';
    exitCode: number | null;
    timedOut: boolean;
    cancelled: boolean;
  };
  coverage:
    | { status: 'complete'; manifest: VitestLifecycleManifest }
    | { status: 'unsupported' };
}

export interface FullSuiteAttestationIdentity {
  treeOid: string;
  fullTaskReviewHash: string;
  validationCwd: string;
  configuredArgv: string[][];
  commandFingerprint: string;
  configurationFingerprint: string;
  dependencyFingerprint: string;
}

export type FullSuiteAttestationValidation =
  | { ok: true; attestation: FullSuiteAttestation }
  | { ok: false; reason: string };

export interface CompactValidationReceipt {
  version: 1;
  command: string;
  treeOid: string;
  fullTaskReviewHash: string;
  outcome: FullSuiteAttestation['execution']['outcome'];
  coverage: FullSuiteAttestation['coverage']['status'];
  completedAt: string;
  discovered?: VitestLifecycleManifest['discovered'];
  completed?: VitestLifecycleManifest['completed'];
}

export type ValidationReceiptProvenance =
  | 'full-suite-ran'
  | 'full-suite-reused'
  | 'related-ran';

export type ValidationCoverageStatus = 'complete' | 'unsupported' | 'invalid';

export interface ValidationBatchReceipt {
  outcome: 'passed' | 'failed' | 'timed-out' | 'cancelled' | 'drifted';
  commands: Array<{
    command: string;
    outcome: 'passed' | 'failed' | 'timed-out' | 'cancelled';
    coverage: ValidationCoverageStatus;
    discovered?: VitestLifecycleManifest['discovered'];
    completed?: VitestLifecycleManifest['completed'];
  }>;
}

/** Compact, restart-safe merge-gate proof bound to one integration tree. */
export interface GateValidationReceipt extends ValidationBatchReceipt {
  version: 1;
  treeOid: string;
  fullTaskReviewHash: string;
  completedAt: string;
  commandFingerprint: string;
  configurationFingerprint: string;
  dependencyFingerprint: string;
}

export interface DurableValidationReceipt {
  provenance: ValidationReceiptProvenance;
  command: string;
  treeOid: string;
  outcome: FullSuiteAttestation['execution']['outcome'];
  coverage: FullSuiteAttestation['coverage']['status'];
  discovered?: VitestLifecycleManifest['discovered'];
  completed?: VitestLifecycleManifest['completed'];
}

function parseLifecycleCounts(
  discoveredValue: unknown,
  completedValue: unknown,
  requireDiscoveryReconciliation: boolean,
): {
  discovered: VitestLifecycleManifest['discovered'];
  completed: VitestLifecycleManifest['completed'];
} | undefined {
  if (
    !isRecord(discoveredValue) ||
    !hasOnlyKeys(discoveredValue, ['suites', 'tests']) ||
    !count(discoveredValue['suites']) ||
    !count(discoveredValue['tests']) ||
    !isRecord(completedValue) ||
    !hasOnlyKeys(completedValue, [
      'suites', 'tests', 'passed', 'failed', 'skipped', 'todo', 'cancelled',
    ]) ||
    !Object.values(completedValue).every(count)
  ) return undefined;
  const discovered = {
    suites: Number(discoveredValue['suites']),
    tests: Number(discoveredValue['tests']),
  };
  const completed = {
    suites: Number(completedValue['suites']),
    tests: Number(completedValue['tests']),
    passed: Number(completedValue['passed']),
    failed: Number(completedValue['failed']),
    skipped: Number(completedValue['skipped']),
    todo: Number(completedValue['todo']),
    cancelled: Number(completedValue['cancelled']),
  };
  const bucketTotal = completed.passed + completed.failed + completed.skipped +
    completed.todo + completed.cancelled;
  if (
    bucketTotal !== completed.tests ||
    (requireDiscoveryReconciliation && !vitestCountsReconcile(discovered, completed))
  ) return undefined;
  return { discovered, completed };
}

function parseReceiptCounts(
  discoveredValue: unknown,
  completedValue: unknown,
) {
  return parseLifecycleCounts(discoveredValue, completedValue, true);
}

export function vitestCountsReconcile(
  discovered: VitestLifecycleManifest['discovered'],
  completed: VitestLifecycleManifest['completed'],
): boolean {
  return discovered.suites === completed.suites &&
    discovered.tests === completed.tests &&
    completed.tests === completed.passed + completed.failed +
      completed.skipped + completed.todo + completed.cancelled;
}

/** Structurally complete lifecycle evidence, including complete red runs. */
export function vitestLifecycleReconciles(
  manifest: VitestLifecycleManifest,
): boolean {
  return manifest.completedNormally &&
    manifest.collectionErrors === 0 &&
    vitestCountsReconcile(manifest.discovered, manifest.completed) &&
    manifest.completed.cancelled === 0;
}

/** Reusable green coverage is the strict subset with no failed tests. */
export function vitestLifecycleIsGreen(
  manifest: VitestLifecycleManifest,
): boolean {
  return vitestLifecycleReconciles(manifest) &&
    manifest.completed.failed === 0;
}

export function parseValidationBatchReceipt(
  value: unknown,
): ValidationBatchReceipt | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['outcome', 'commands'])) return undefined;
  const outcome = value['outcome'];
  if (
    outcome !== 'passed' &&
    outcome !== 'failed' &&
    outcome !== 'timed-out' &&
    outcome !== 'cancelled' &&
    outcome !== 'drifted'
  ) return undefined;
  if (
    !Array.isArray(value['commands']) ||
    value['commands'].length > MAX_COMMANDS ||
    (value['commands'].length === 0 && outcome !== 'drifted')
  ) return undefined;
  const commands: ValidationBatchReceipt['commands'] = [];
  for (const entry of value['commands']) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, [
      'command', 'outcome', 'coverage', 'discovered', 'completed',
    ])) return undefined;
    if (
      !boundedString(entry['command']) ||
      containsAbsoluteHostPath(entry['command']) ||
      secretShapedArg(entry['command']) ||
      (entry['outcome'] !== 'passed' &&
        entry['outcome'] !== 'failed' &&
        entry['outcome'] !== 'timed-out' &&
        entry['outcome'] !== 'cancelled') ||
      (entry['coverage'] !== 'complete' &&
        entry['coverage'] !== 'unsupported' &&
        entry['coverage'] !== 'invalid')
    ) return undefined;
    const counts = entry['coverage'] === 'complete'
      ? parseReceiptCounts(entry['discovered'], entry['completed'])
      : undefined;
    if (
      (entry['coverage'] === 'complete' && counts === undefined) ||
      (entry['coverage'] !== 'complete' &&
        (entry['discovered'] !== undefined || entry['completed'] !== undefined))
    ) return undefined;
    if (
      entry['outcome'] === 'passed' &&
      counts !== undefined &&
      (counts.completed.failed !== 0 || counts.completed.cancelled !== 0)
    ) return undefined;
    commands.push({
      command: entry['command'],
      outcome: entry['outcome'],
      coverage: entry['coverage'],
      ...(counts !== undefined ? counts : {}),
    });
  }
  const derived = commands.some((entry) => entry.outcome === 'cancelled')
    ? 'cancelled'
    : commands.some((entry) => entry.outcome === 'timed-out')
      ? 'timed-out'
      : commands.some((entry) =>
        entry.outcome === 'failed' || entry.coverage === 'invalid')
        ? 'failed'
        : 'passed';
  if (outcome !== 'drifted' && outcome !== derived) return undefined;
  return { outcome, commands };
}

export function parseGateValidationReceipt(
  value: unknown,
): GateValidationReceipt | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'version',
    'treeOid',
    'fullTaskReviewHash',
    'completedAt',
    'commandFingerprint',
    'configurationFingerprint',
    'dependencyFingerprint',
    'outcome',
    'commands',
  ])) return undefined;
  if (
    value['version'] !== 1 ||
    typeof value['treeOid'] !== 'string' ||
    !isGitObjectId(value['treeOid']) ||
    typeof value['fullTaskReviewHash'] !== 'string' ||
    !SHA256.test(value['fullTaskReviewHash']) ||
    !boundedString(value['completedAt'], 64) ||
    !Number.isFinite(Date.parse(value['completedAt'])) ||
    !SHA256.test(String(value['commandFingerprint'])) ||
    !SHA256.test(String(value['configurationFingerprint'])) ||
    !SHA256.test(String(value['dependencyFingerprint']))
  ) return undefined;
  const batch = parseValidationBatchReceipt({
    outcome: value['outcome'],
    commands: value['commands'],
  });
  if (batch === undefined) return undefined;
  return {
    version: 1,
    treeOid: value['treeOid'],
    fullTaskReviewHash: value['fullTaskReviewHash'],
    completedAt: value['completedAt'],
    commandFingerprint: value['commandFingerprint'] as string,
    configurationFingerprint: value['configurationFingerprint'] as string,
    dependencyFingerprint: value['dependencyFingerprint'] as string,
    ...batch,
  };
}

export function isGateValidationReceipt(
  value: unknown,
): value is GateValidationReceipt {
  return parseGateValidationReceipt(value) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_COUNT;
}

function boundedString(value: unknown, max = MAX_ARG_CHARS): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !value.includes('\0');
}

function safeRelativeLabel(value: unknown): value is string {
  if (!boundedString(value, 1_000) || isAbsolute(value) || value.includes('\\')) return false;
  const normalized = normalize(value).replaceAll('\\', '/');
  return normalized === '.' || (
    normalized !== '..' &&
    !normalized.startsWith('../') &&
    !normalized.startsWith('/')
  );
}

function containsAbsoluteHostPath(arg: string): boolean {
  return isAbsolute(arg) ||
    /file:(?:\/|\/\/(?:localhost)?\/)/i.test(arg) ||
    /^[A-Za-z]:\\/.test(arg) ||
    /(?:^|[\s=])\/(?!\/)/.test(arg) ||
    /(?:^|[\s=])[A-Za-z]:\\/.test(arg);
}

function secretShapedArg(arg: string): boolean {
  return /(?:^|[-_])(?:api[-_]?key|auth(?:orization)?|credential|key|password|secret|token)(?:$|[-_=])/i
    .test(arg);
}

export function containsCredentialMaterial(value: string): boolean {
  return /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value) ||
    /[?&](?:api[-_]?key|auth|credential|key|password|secret|token)=/i.test(value) ||
    /(?:proxy-)?authorization\s*:/i.test(value) ||
    /(?:^|\s)--?[^\s=]*(?:key|auth|credential|password|secret|token)(?:=|\s+\S)/i
      .test(value);
}

function credentialBearingArg(
  arg: string,
  index: number,
  argv: readonly unknown[],
): boolean {
  if (containsCredentialMaterial(arg)) return true;
  const previous = index > 0 ? String(argv[index - 1]) : '';
  if (/^(?:-H|--header)$/i.test(previous) && /authorization\s*:/i.test(arg)) return true;
  return secretShapedArg(arg) &&
    (arg.includes('=') || (index + 1 < argv.length && !String(argv[index + 1]).startsWith('-')));
}

function parseArgv(value: unknown): string[][] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_COMMANDS) return undefined;
  const parsed: string[][] = [];
  for (const argv of value) {
    if (
      !Array.isArray(argv) ||
      argv.length < 1 ||
      argv.length > MAX_ARGV ||
      !argv.every((arg) =>
        boundedString(arg) &&
        !containsAbsoluteHostPath(arg)) ||
      argv.some((arg, index) => credentialBearingArg(String(arg), index, argv))
    ) {
      return undefined;
    }
    parsed.push([...argv] as string[]);
  }
  return parsed;
}

export function parseVitestManifest(value: unknown): VitestLifecycleManifest | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'version',
    'runner',
    'completedNormally',
    'collectionErrors',
    'discovered',
    'completed',
  ])) return undefined;
  const counts = parseLifecycleCounts(value['discovered'], value['completed'], false);
  if (
    value['version'] !== 1 ||
    value['runner'] !== 'vitest' ||
    typeof value['completedNormally'] !== 'boolean' ||
    !count(value['collectionErrors']) ||
    counts === undefined
  ) {
    return undefined;
  }
  return {
    version: 1,
    runner: 'vitest',
    completedNormally: value['completedNormally'],
    collectionErrors: value['collectionErrors'],
    discovered: counts.discovered,
    completed: counts.completed,
  };
}

function parseAttestation(value: unknown): FullSuiteAttestation | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'version',
    'treeOid',
    'fullTaskReviewHash',
    'validationCwd',
    'configuredArgv',
    'adapter',
    'commandFingerprint',
    'configurationFingerprint',
    'dependencyFingerprint',
    'startedAt',
    'completedAt',
    'durationMs',
    'execution',
    'coverage',
  ])) return undefined;
  const argv = parseArgv(value['configuredArgv']);
  const adapter = value['adapter'];
  const execution = value['execution'];
  const coverage = value['coverage'];
  if (
    value['version'] !== FULL_SUITE_ATTESTATION_VERSION ||
    typeof value['treeOid'] !== 'string' ||
    !isGitObjectId(value['treeOid']) ||
    typeof value['fullTaskReviewHash'] !== 'string' ||
    !SHA256.test(value['fullTaskReviewHash']) ||
    !safeRelativeLabel(value['validationCwd']) ||
    argv === undefined ||
    !isRecord(adapter) ||
    !hasOnlyKeys(adapter, ['runner', 'version']) ||
    (adapter['runner'] !== 'vitest' && adapter['runner'] !== 'unsupported') ||
    adapter['version'] !== 1 ||
    typeof value['commandFingerprint'] !== 'string' ||
    !SHA256.test(value['commandFingerprint']) ||
    typeof value['configurationFingerprint'] !== 'string' ||
    !SHA256.test(value['configurationFingerprint']) ||
    typeof value['dependencyFingerprint'] !== 'string' ||
    !SHA256.test(value['dependencyFingerprint']) ||
    !boundedString(value['startedAt'], 64) ||
    !boundedString(value['completedAt'], 64) ||
    !Number.isFinite(Date.parse(value['startedAt'])) ||
    !Number.isFinite(Date.parse(value['completedAt'])) ||
    !count(value['durationMs']) ||
    !isRecord(execution) ||
    !hasOnlyKeys(execution, ['outcome', 'exitCode', 'timedOut', 'cancelled']) ||
    (execution['outcome'] !== 'passed' &&
      execution['outcome'] !== 'failed' &&
      execution['outcome'] !== 'cancelled') ||
    (execution['exitCode'] !== null &&
      (!Number.isSafeInteger(execution['exitCode']) || Number(execution['exitCode']) < 0)) ||
    typeof execution['timedOut'] !== 'boolean' ||
    typeof execution['cancelled'] !== 'boolean' ||
    !isRecord(coverage) ||
    !hasOnlyKeys(coverage, ['status', 'manifest'])
  ) {
    return undefined;
  }
  let parsedCoverage: FullSuiteAttestation['coverage'];
  if (coverage['status'] === 'complete') {
    const manifest = parseVitestManifest(coverage['manifest']);
    if (adapter['runner'] !== 'vitest' || manifest === undefined) return undefined;
    parsedCoverage = { status: 'complete', manifest };
  } else if (
    coverage['status'] === 'unsupported' &&
    coverage['manifest'] === undefined &&
    adapter['runner'] === 'unsupported'
  ) {
    parsedCoverage = { status: 'unsupported' };
  } else {
    return undefined;
  }
  return {
    version: 1,
    treeOid: value['treeOid'],
    fullTaskReviewHash: value['fullTaskReviewHash'],
    validationCwd: value['validationCwd'],
    configuredArgv: argv,
    adapter: adapter['runner'] === 'vitest'
      ? { runner: 'vitest', version: 1 }
      : { runner: 'unsupported', version: 1 },
    commandFingerprint: value['commandFingerprint'],
    configurationFingerprint: value['configurationFingerprint'],
    dependencyFingerprint: value['dependencyFingerprint'],
    startedAt: value['startedAt'],
    completedAt: value['completedAt'],
    durationMs: value['durationMs'],
    execution: {
      outcome: execution['outcome'],
      exitCode: execution['exitCode'] as number | null,
      timedOut: execution['timedOut'],
      cancelled: execution['cancelled'],
    },
    coverage: parsedCoverage,
  };
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Admit a historical durable attestation without trusting caller-supplied
 * expected identity. Exact reuse still requires validateFullSuiteAttestation
 * against a freshly recaptured identity. */
export function parseFullSuiteAttestation(value: unknown): FullSuiteAttestation | undefined {
  const parsed = parseAttestation(value);
  if (parsed === undefined) return undefined;
  const validated = validateFullSuiteAttestation(parsed, {
    treeOid: parsed.treeOid,
    fullTaskReviewHash: parsed.fullTaskReviewHash,
    validationCwd: parsed.validationCwd,
    configuredArgv: parsed.configuredArgv,
    commandFingerprint: parsed.commandFingerprint,
    configurationFingerprint: parsed.configurationFingerprint,
    dependencyFingerprint: parsed.dependencyFingerprint,
  });
  return validated.ok ? validated.attestation : undefined;
}

export function parseDurableValidationReceipt(
  value: unknown,
): DurableValidationReceipt | undefined {
  if (!isRecord(value)) return undefined;
  const provenance = value['provenance'];
  if (
    provenance !== 'full-suite-ran' &&
    provenance !== 'full-suite-reused' &&
    provenance !== 'related-ran'
  ) return undefined;
  const { provenance: _provenance, ...candidate } = value;
  if (!hasOnlyKeys(candidate, [
    'command',
    'treeOid',
    'outcome',
    'coverage',
    'discovered',
    'completed',
  ])) return undefined;
  if (
    !boundedString(candidate['command']) ||
    containsAbsoluteHostPath(candidate['command']) ||
    typeof candidate['treeOid'] !== 'string' ||
    !isGitObjectId(candidate['treeOid']) ||
    (candidate['outcome'] !== 'passed' &&
      candidate['outcome'] !== 'failed' &&
      candidate['outcome'] !== 'cancelled') ||
    (candidate['coverage'] !== 'complete' && candidate['coverage'] !== 'unsupported')
  ) return undefined;
  const discovered = candidate['discovered'];
  const completed = candidate['completed'];
  let parsedCounts: ReturnType<typeof parseReceiptCounts>;
  if (candidate['coverage'] === 'complete') {
    const counts = parseReceiptCounts(discovered, completed);
    if (
      counts === undefined ||
      candidate['outcome'] !== 'passed' ||
      counts.completed.failed !== 0 ||
      counts.completed.cancelled !== 0 ||
      provenance === 'related-ran'
    ) return undefined;
    parsedCounts = counts;
  } else if (discovered !== undefined || completed !== undefined) {
    return undefined;
  }
  if (
    provenance === 'full-suite-reused' &&
    (candidate['coverage'] !== 'complete' || candidate['outcome'] !== 'passed')
  ) return undefined;
  if (provenance === 'related-ran' && candidate['coverage'] !== 'unsupported') {
    return undefined;
  }
  return {
    provenance,
    command: candidate['command'] as string,
    treeOid: candidate['treeOid'] as string,
    outcome: candidate['outcome'] as DurableValidationReceipt['outcome'],
    coverage: candidate['coverage'] as DurableValidationReceipt['coverage'],
    ...(parsedCounts !== undefined
      ? {
          discovered: { ...parsedCounts.discovered },
          completed: { ...parsedCounts.completed },
        }
      : {}),
  };
}

export function validateFullSuiteAttestation(
  value: unknown,
  expected: FullSuiteAttestationIdentity,
): FullSuiteAttestationValidation {
  const attestation = parseAttestation(value);
  if (attestation === undefined) return { ok: false, reason: 'malformed-attestation' };
  if (
    attestation.treeOid !== expected.treeOid ||
    attestation.fullTaskReviewHash !== expected.fullTaskReviewHash ||
    attestation.validationCwd !== expected.validationCwd ||
    !exactJson(attestation.configuredArgv, expected.configuredArgv) ||
    attestation.commandFingerprint !== expected.commandFingerprint ||
    attestation.configurationFingerprint !== expected.configurationFingerprint ||
    attestation.dependencyFingerprint !== expected.dependencyFingerprint
  ) {
    return { ok: false, reason: 'identity-mismatch' };
  }
  if (
    attestation.execution.outcome !== 'passed' ||
    attestation.execution.exitCode !== 0 ||
    attestation.execution.timedOut ||
    attestation.execution.cancelled
  ) {
    return { ok: false, reason: 'execution-not-green' };
  }
  if (
    attestation.coverage.status === 'complete' &&
    !vitestLifecycleIsGreen(attestation.coverage.manifest)
  ) {
    return { ok: false, reason: 'coverage-incomplete' };
  }
  return { ok: true, attestation };
}

export function compactValidationReceipt(
  attestation: FullSuiteAttestation,
): CompactValidationReceipt {
  const manifest = attestation.coverage.status === 'complete'
    ? attestation.coverage.manifest
    : undefined;
  return {
    version: 1,
    command: attestation.configuredArgv
      .map((argv) => sanitizeValidationCommandIdentifier(argv))
      .join(' + ')
      .slice(0, 1_000),
    treeOid: attestation.treeOid,
    fullTaskReviewHash: attestation.fullTaskReviewHash,
    outcome: attestation.execution.outcome,
    coverage: attestation.coverage.status,
    completedAt: attestation.completedAt,
    ...(manifest !== undefined
      ? {
          discovered: { ...manifest.discovered },
          completed: { ...manifest.completed },
        }
      : {}),
  };
}

export function sanitizeValidationCommandIdentifier(argv: readonly string[]): string {
  return argv.map((arg, index) => {
    if (containsAbsoluteHostPath(arg)) return '<path>';
    if (credentialBearingArg(arg, index, argv)) {
      if (secretShapedArg(arg) && !arg.includes('=') && !containsCredentialMaterial(arg)) {
        return arg;
      }
      const equals = arg.indexOf('=');
      return equals >= 0 && !arg.includes('://')
        ? `${arg.slice(0, equals + 1)}<redacted>`
        : '<redacted>';
    }
    if (index > 0 && secretShapedArg(String(argv[index - 1]))) return '<redacted>';
    return arg;
  }).join(' ');
}

export function durableValidationReceipt(
  receipt: CompactValidationReceipt,
  provenance: ValidationReceiptProvenance,
): DurableValidationReceipt {
  return {
    provenance,
    command: receipt.command,
    treeOid: receipt.treeOid,
    outcome: receipt.outcome,
    coverage: receipt.coverage,
    ...(receipt.discovered !== undefined
      ? { discovered: { ...receipt.discovered } }
      : {}),
    ...(receipt.completed !== undefined
      ? { completed: { ...receipt.completed } }
      : {}),
  };
}
