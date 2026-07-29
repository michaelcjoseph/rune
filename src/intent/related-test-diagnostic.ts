/** Durable, provider-neutral diagnostic contract for `vitest related` closeout. */

export type RelatedTestDiagnosticState =
  | 'related-test-failure'
  | 'related-validation-host-conflict'
  | 'related-fallback-passed'
  | 'related-fallback-failed';

export type RelatedValidationConflictKind =
  | 'nested-seatbelt-sandbox-apply'
  | 'loopback-listen-denied';

export interface RelatedTestStructuredError {
  source: 'vitest-json';
  scope: 'assertion' | 'suite';
  file: string;
  testName?: string;
  message: string;
}

export interface RelatedValidationConflictEvidence {
  kind: RelatedValidationConflictKind;
  source: 'vitest-json';
  scope: RelatedTestStructuredError['scope'];
  file: string;
  testName?: string;
  message: string;
  code?: 'EPERM' | 'EACCES';
  syscall?: 'listen' | 'sandbox_apply';
  address?: string;
}

export interface RelatedTestCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  outputHead?: string;
  outputTail: string;
  diagnosticArtifacts: string[];
  structuredErrors?: RelatedTestStructuredError[];
  /** Total structured errors in the report, including entries not retained. */
  structuredErrorsTotal?: number;
  /** True only when every error and field was retained without truncation. */
  structuredErrorsComplete?: boolean;
}

export interface RelatedTestInvocation {
  selectedPaths: string[];
  /** Original counts before durable selection bounds were applied. */
  selectedPathsTotal?: number;
  argv: string[];
  argvTotal?: number;
  /** False means the invocation was bounded and is ineligible for fallback. */
  selectionComplete?: boolean;
  command: string;
  /** Scrubbed worktree-relative command directory. */
  validationCwd: string;
  result: RelatedTestCommandResult;
  compatibleMode: boolean;
}

interface RelatedTestDiagnosticBase {
  initial: RelatedTestInvocation;
  conflictEvidence: RelatedValidationConflictEvidence[];
}

export type RelatedTestDiagnostic =
  | (RelatedTestDiagnosticBase & {
      state: 'related-test-failure';
      fallback?: never;
    })
  | (RelatedTestDiagnosticBase & {
      state: 'related-validation-host-conflict';
      fallback?: never;
    })
  | (RelatedTestDiagnosticBase & {
      state: 'related-fallback-passed';
      fallback: RelatedTestInvocation;
    })
  | (RelatedTestDiagnosticBase & {
      state: 'related-fallback-failed';
      fallback: RelatedTestInvocation;
    });

export interface RelatedTestTaskDiagnostic {
  taskId: string;
  diagnostic: RelatedTestDiagnostic;
}

export const RELATED_TEST_TASK_DIAGNOSTICS_MAX = 20;
export const RELATED_TEST_TASK_DIAGNOSTICS_MAX_BYTES = 2_000_000;
export const RELATED_TEST_TASK_ID_MAX_CHARS = 200;
export const RELATED_TEST_SELECTED_PATHS_MAX = 250;
export const RELATED_TEST_ARGV_MAX = 260;
export const RELATED_TEST_ARGUMENT_MAX_CHARS = 1_000;
export const RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS = 60_000;
export const RELATED_TEST_COMMAND_MAX_CHARS = 64_000;
export const RELATED_TEST_VALIDATION_CWD_MAX_CHARS = 1_000;
export const RELATED_TEST_OUTPUT_MAX_CHARS = 20_000;
export const RELATED_TEST_DIAGNOSTIC_ARTIFACTS_MAX = 50;
export const RELATED_TEST_STRUCTURED_ERRORS_MAX = 25;
export const RELATED_TEST_ERROR_FILE_MAX_CHARS = 1_000;
export const RELATED_TEST_ERROR_TEST_NAME_MAX_CHARS = 1_000;
export const RELATED_TEST_ERROR_MESSAGE_MAX_CHARS = 2_000;

export function relatedTestInvocationSelectionFits(
  selectedPaths: readonly string[],
  argv: readonly string[],
): boolean {
  return selectedPaths.length <= RELATED_TEST_SELECTED_PATHS_MAX &&
    argv.length <= RELATED_TEST_ARGV_MAX &&
    selectedPaths.every((value) => value.length <= RELATED_TEST_ARGUMENT_MAX_CHARS) &&
    argv.every((value) => value.length <= RELATED_TEST_ARGUMENT_MAX_CHARS) &&
    selectedPaths.reduce((total, value) => total + value.length, 0) <=
      RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS &&
    argv.reduce((total, value) => total + value.length, 0) <=
      RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS &&
    argv.map((arg) => JSON.stringify(arg)).join(' ').length <=
      RELATED_TEST_COMMAND_MAX_CHARS;
}

export function collectRelatedTestTaskDiagnostics(
  records: readonly {
    taskId: string;
    relatedTestDiagnostic?: RelatedTestDiagnostic;
  }[],
): RelatedTestTaskDiagnostic[] {
  const selected = records
    .filter((record) => record.relatedTestDiagnostic !== undefined)
    .slice(-RELATED_TEST_TASK_DIAGNOSTICS_MAX);
  const retained: RelatedTestTaskDiagnostic[] = [];
  let retainedBytes = 0;
  for (const record of [...selected].reverse()) {
    const candidate = {
      taskId: record.taskId.slice(0, RELATED_TEST_TASK_ID_MAX_CHARS),
      diagnostic: record.relatedTestDiagnostic!,
    };
    const bytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
    if (bytes > RELATED_TEST_TASK_DIAGNOSTICS_MAX_BYTES - retainedBytes) continue;
    retained.unshift(structuredClone(candidate));
    retainedBytes += bytes;
  }
  return retained;
}

export function isRelatedTestDiagnostic(value: unknown): value is RelatedTestDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const state = candidate['state'];
  if (
    state !== 'related-test-failure' &&
    state !== 'related-validation-host-conflict' &&
    state !== 'related-fallback-passed' &&
    state !== 'related-fallback-failed'
  ) return false;
  if (!isInvocation(candidate['initial'])) return false;
  const initial = candidate['initial'];
  if (initial.compatibleMode || isSuccessfulInvocation(initial)) return false;
  if (
    !Array.isArray(candidate['conflictEvidence']) ||
    candidate['conflictEvidence'].length > RELATED_TEST_STRUCTURED_ERRORS_MAX ||
    !candidate['conflictEvidence'].every(isConflictEvidence)
  ) return false;
  const conflictEvidence = candidate['conflictEvidence'];
  const fallback = candidate['fallback'];
  if (state === 'related-test-failure') return fallback === undefined;
  if (
    conflictEvidence.length === 0 ||
    initial.selectionComplete === false ||
    !isConfirmedConflictInvocation(initial) ||
    conflictEvidence.length !== initial.result.structuredErrors?.length
  ) return false;
  if (state === 'related-validation-host-conflict') return fallback === undefined;
  if (!isInvocation(fallback) || !fallback.compatibleMode) return false;
  if (!sameSelection(initial, fallback)) return false;
  return state === 'related-fallback-passed'
    ? isSuccessfulInvocation(fallback)
    : !isSuccessfulInvocation(fallback);
}

export function isRelatedTestTaskDiagnostic(
  value: unknown,
): value is RelatedTestTaskDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return isBoundedString(candidate['taskId'], RELATED_TEST_TASK_ID_MAX_CHARS) &&
    candidate['taskId'].trim() !== '' &&
    isRelatedTestDiagnostic(candidate['diagnostic']);
}

export function isRelatedTestTaskDiagnosticList(
  value: unknown,
): value is RelatedTestTaskDiagnostic[] {
  if (
    !Array.isArray(value) ||
    value.length > RELATED_TEST_TASK_DIAGNOSTICS_MAX ||
    !value.every(isRelatedTestTaskDiagnostic)
  ) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <=
      RELATED_TEST_TASK_DIAGNOSTICS_MAX_BYTES;
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isStructuredError(value: unknown): value is RelatedTestStructuredError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const error = value as Record<string, unknown>;
  return error['source'] === 'vitest-json' &&
    (error['scope'] === 'assertion' || error['scope'] === 'suite') &&
    isBoundedString(error['file'], RELATED_TEST_ERROR_FILE_MAX_CHARS) &&
    (error['testName'] === undefined ||
      isBoundedString(error['testName'], RELATED_TEST_ERROR_TEST_NAME_MAX_CHARS)) &&
    isBoundedString(error['message'], RELATED_TEST_ERROR_MESSAGE_MAX_CHARS);
}

function isInvocation(value: unknown): value is RelatedTestInvocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const invocation = value as Record<string, unknown>;
  const result = invocation['result'];
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const commandResult = result as Record<string, unknown>;
  return isBoundedStringArray(
      invocation['selectedPaths'],
      RELATED_TEST_SELECTED_PATHS_MAX,
      RELATED_TEST_ARGUMENT_MAX_CHARS,
      RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS,
    ) &&
    isBoundedStringArray(
      invocation['argv'],
      RELATED_TEST_ARGV_MAX,
      RELATED_TEST_ARGUMENT_MAX_CHARS,
      RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS,
    ) &&
    isBoundedString(invocation['command'], RELATED_TEST_COMMAND_MAX_CHARS) &&
    isBoundedString(invocation['validationCwd'], RELATED_TEST_VALIDATION_CWD_MAX_CHARS) &&
    invocationSelectionMetadataConsistent(invocation) &&
    typeof invocation['compatibleMode'] === 'boolean' &&
    (commandResult['exitCode'] === null || typeof commandResult['exitCode'] === 'number') &&
    typeof commandResult['timedOut'] === 'boolean' &&
    isBoundedString(commandResult['outputTail'], RELATED_TEST_OUTPUT_MAX_CHARS) &&
    (commandResult['outputHead'] === undefined ||
      isBoundedString(commandResult['outputHead'], RELATED_TEST_OUTPUT_MAX_CHARS)) &&
    isBoundedStringArray(
      commandResult['diagnosticArtifacts'],
      RELATED_TEST_DIAGNOSTIC_ARTIFACTS_MAX,
      RELATED_TEST_ARGUMENT_MAX_CHARS,
    ) &&
    (commandResult['structuredErrors'] === undefined ||
      (Array.isArray(commandResult['structuredErrors']) &&
        commandResult['structuredErrors'].length <= RELATED_TEST_STRUCTURED_ERRORS_MAX &&
        commandResult['structuredErrors'].every(isStructuredError))) &&
    (commandResult['structuredErrorsTotal'] === undefined ||
      (Number.isInteger(commandResult['structuredErrorsTotal']) &&
        (commandResult['structuredErrorsTotal'] as number) >= 0)) &&
    (commandResult['structuredErrorsComplete'] === undefined ||
      typeof commandResult['structuredErrorsComplete'] === 'boolean') &&
    structuredMetadataConsistent(commandResult);
}

function invocationSelectionMetadataConsistent(
  invocation: Record<string, unknown>,
): boolean {
  const selectedPaths = invocation['selectedPaths'] as string[];
  const argv = invocation['argv'] as string[];
  const selectedPathsTotal = invocation['selectedPathsTotal'];
  const argvTotal = invocation['argvTotal'];
  const complete = invocation['selectionComplete'];
  if (
    selectedPathsTotal === undefined &&
    argvTotal === undefined &&
    complete === undefined
  ) return true;
  if (
    !Number.isInteger(selectedPathsTotal) ||
    !Number.isInteger(argvTotal) ||
    typeof complete !== 'boolean'
  ) return false;
  if (
    (selectedPathsTotal as number) < selectedPaths.length ||
    (argvTotal as number) < argv.length
  ) return false;
  return !complete ||
    ((selectedPathsTotal as number) === selectedPaths.length &&
      (argvTotal as number) === argv.length);
}

function structuredMetadataConsistent(result: Record<string, unknown>): boolean {
  const errors = result['structuredErrors'];
  const total = result['structuredErrorsTotal'];
  const complete = result['structuredErrorsComplete'];
  if (errors === undefined) {
    return total === undefined && complete === undefined;
  }
  if (!Array.isArray(errors) || typeof total !== 'number' || typeof complete !== 'boolean') {
    return false;
  }
  return total >= errors.length && (!complete || total === errors.length);
}

function isSuccessfulInvocation(invocation: RelatedTestInvocation): boolean {
  return !invocation.result.timedOut &&
    invocation.result.exitCode === 0 &&
    invocation.result.structuredErrors !== undefined &&
    invocation.result.structuredErrors.length === 0 &&
    invocation.result.structuredErrorsTotal === 0 &&
    invocation.result.structuredErrorsComplete === true;
}

function isConfirmedConflictInvocation(invocation: RelatedTestInvocation): boolean {
  return !invocation.result.timedOut &&
    invocation.result.exitCode !== null &&
    invocation.result.exitCode !== 0 &&
    invocation.result.structuredErrors !== undefined &&
    invocation.result.structuredErrors.length > 0 &&
    invocation.result.structuredErrorsTotal === invocation.result.structuredErrors.length &&
    invocation.result.structuredErrorsComplete === true;
}

function sameSelection(
  initial: RelatedTestInvocation,
  fallback: RelatedTestInvocation,
): boolean {
  return initial.validationCwd === fallback.validationCwd &&
    initial.selectionComplete === fallback.selectionComplete &&
    initial.selectedPathsTotal === fallback.selectedPathsTotal &&
    initial.argvTotal === fallback.argvTotal &&
    initial.command === fallback.command &&
    initial.argv.length === fallback.argv.length &&
    initial.argv.every((value, index) => value === fallback.argv[index]) &&
    initial.selectedPaths.length === fallback.selectedPaths.length &&
    initial.selectedPaths.every((value, index) => value === fallback.selectedPaths[index]);
}

function isConflictEvidence(value: unknown): value is RelatedValidationConflictEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return (evidence['kind'] === 'nested-seatbelt-sandbox-apply' ||
      evidence['kind'] === 'loopback-listen-denied') &&
    evidence['source'] === 'vitest-json' &&
    (evidence['scope'] === 'assertion' || evidence['scope'] === 'suite') &&
    isBoundedString(evidence['file'], RELATED_TEST_ERROR_FILE_MAX_CHARS) &&
    (evidence['testName'] === undefined ||
      isBoundedString(evidence['testName'], RELATED_TEST_ERROR_TEST_NAME_MAX_CHARS)) &&
    isBoundedString(evidence['message'], RELATED_TEST_ERROR_MESSAGE_MAX_CHARS) &&
    (evidence['code'] === undefined || evidence['code'] === 'EPERM' || evidence['code'] === 'EACCES') &&
    (evidence['syscall'] === undefined ||
      evidence['syscall'] === 'listen' ||
      evidence['syscall'] === 'sandbox_apply') &&
    (evidence['address'] === undefined ||
      isBoundedString(evidence['address'], RELATED_TEST_ARGUMENT_MAX_CHARS));
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length <= maxChars;
}

function isBoundedStringArray(
  value: unknown,
  maxItems: number,
  maxChars: number,
  maxTotalChars = Number.POSITIVE_INFINITY,
): value is string[] {
  return isStringArray(value) &&
    value.length <= maxItems &&
    value.every((entry) => entry.length <= maxChars) &&
    value.reduce((total, entry) => total + entry.length, 0) <= maxTotalChars;
}
