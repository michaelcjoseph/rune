/**
 * Typed diagnostics for the task-scoped `vitest related` closeout gate.
 *
 * Classification is intentionally limited to errors admitted by Vitest's JSON
 * reporter. Console output is retained for diagnosis, but never promotes a
 * failing test to a host-capability conflict.
 */

import { scrubPathsInText } from '../ai/tool-labels.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import { redactSecrets } from './work-run-transcript.js';
import type { ValidationCommandResult } from './work-run-gate-runtime.js';
import {
  RELATED_TEST_ARGUMENT_MAX_CHARS,
  RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS,
  RELATED_TEST_ARGV_MAX,
  RELATED_TEST_COMMAND_MAX_CHARS,
  RELATED_TEST_DIAGNOSTIC_ARTIFACTS_MAX,
  RELATED_TEST_ERROR_FILE_MAX_CHARS,
  RELATED_TEST_ERROR_MESSAGE_MAX_CHARS,
  RELATED_TEST_ERROR_TEST_NAME_MAX_CHARS,
  RELATED_TEST_OUTPUT_MAX_CHARS,
  RELATED_TEST_SELECTED_PATHS_MAX,
  RELATED_TEST_STRUCTURED_ERRORS_MAX,
  RELATED_TEST_VALIDATION_CWD_MAX_CHARS,
  relatedTestInvocationSelectionFits,
  type RelatedTestDiagnostic,
  type RelatedTestInvocation,
  type RelatedTestStructuredError,
  type RelatedValidationConflictEvidence,
} from '../intent/related-test-diagnostic.js';
/* Re-export the durable contract from its provider-neutral home. */
export type {
  RelatedTestDiagnostic,
  RelatedTestInvocation,
  RelatedTestStructuredError,
  RelatedValidationConflictEvidence,
  RelatedTestCommandResult,
  RelatedTestDiagnosticState,
  RelatedValidationConflictKind,
} from '../intent/related-test-diagnostic.js';

export interface DiagnoseRelatedTestInput {
  selectedPaths: readonly string[];
  argv: readonly string[];
  validationCwd: string;
  result: ValidationCommandResult;
}

function scrub(text: string): string {
  return redactSecrets(scrubAbsolutePaths(scrubPathsInText(text)));
}

function scrubBounded(text: string, maxChars: number): string {
  return scrub(text).slice(0, maxChars);
}

function safeStructuredError(error: RelatedTestStructuredError): RelatedTestStructuredError {
  return {
    source: 'vitest-json',
    scope: error.scope,
    file: scrubBounded(error.file, RELATED_TEST_ERROR_FILE_MAX_CHARS),
    ...(error.testName !== undefined
      ? {
          testName: scrubBounded(
            error.testName,
            RELATED_TEST_ERROR_TEST_NAME_MAX_CHARS,
          ),
        }
      : {}),
    message: scrubBounded(error.message, RELATED_TEST_ERROR_MESSAGE_MAX_CHARS),
  };
}

function boundedArray(
  values: readonly string[],
  maxItems: number,
): string[] {
  const retained: string[] = [];
  let retainedChars = 0;
  for (const value of values.slice(0, maxItems)) {
    const bounded = scrubBounded(value, RELATED_TEST_ARGUMENT_MAX_CHARS);
    if (
      retainedChars + bounded.length >
      RELATED_TEST_ARGUMENTS_TOTAL_MAX_CHARS
    ) break;
    retained.push(bounded);
    retainedChars += bounded.length;
  }
  return retained;
}

export function relatedTestInvocation(
  input: DiagnoseRelatedTestInput,
  compatibleMode: boolean,
): RelatedTestInvocation {
  const selectedPaths = boundedArray(
    input.selectedPaths,
    RELATED_TEST_SELECTED_PATHS_MAX,
  );
  const argv = boundedArray(input.argv, RELATED_TEST_ARGV_MAX);
  const command = argv.map((arg) => JSON.stringify(arg)).join(' ');
  const validationCwd = scrubBounded(
    input.validationCwd,
    RELATED_TEST_VALIDATION_CWD_MAX_CHARS,
  );
  const selectionComplete =
    relatedTestInvocationSelectionFits(input.selectedPaths, input.argv) &&
    input.validationCwd.length <= RELATED_TEST_VALIDATION_CWD_MAX_CHARS;
  const rawStructuredErrors = input.result.structuredErrors;
  const structuredErrors = rawStructuredErrors
    ?.slice(0, RELATED_TEST_STRUCTURED_ERRORS_MAX)
    .map(safeStructuredError);
  const structuredErrorsTotal = rawStructuredErrors === undefined
    ? undefined
    : input.result.structuredErrorsTotal ?? rawStructuredErrors.length;
  const structuredFieldsComplete = rawStructuredErrors === undefined
    ? undefined
    : rawStructuredErrors.length <= RELATED_TEST_STRUCTURED_ERRORS_MAX &&
      rawStructuredErrors.every((error) =>
        error.file.length <= RELATED_TEST_ERROR_FILE_MAX_CHARS &&
        (error.testName?.length ?? 0) <= RELATED_TEST_ERROR_TEST_NAME_MAX_CHARS &&
        error.message.length <= RELATED_TEST_ERROR_MESSAGE_MAX_CHARS);
  const structuredErrorsComplete = rawStructuredErrors === undefined
    ? undefined
    : (input.result.structuredErrorsComplete ?? true) &&
      structuredFieldsComplete &&
      structuredErrorsTotal === rawStructuredErrors.length;
  return {
    selectedPaths,
    selectedPathsTotal: input.selectedPaths.length,
    argv,
    argvTotal: input.argv.length,
    selectionComplete,
    command: command.slice(0, RELATED_TEST_COMMAND_MAX_CHARS),
    validationCwd,
    result: {
      exitCode: input.result.exitCode,
      timedOut: input.result.timedOut,
      ...(input.result.outputHead !== undefined
        ? {
            outputHead: scrubBounded(
              input.result.outputHead,
              RELATED_TEST_OUTPUT_MAX_CHARS,
            ),
          }
        : {}),
      outputTail: scrubBounded(
        input.result.outputTail,
        RELATED_TEST_OUTPUT_MAX_CHARS,
      ),
      diagnosticArtifacts: (input.result.diagnosticArtifacts ?? [])
        .slice(0, RELATED_TEST_DIAGNOSTIC_ARTIFACTS_MAX)
        .map((artifact) => scrubBounded(artifact, RELATED_TEST_ARGUMENT_MAX_CHARS)),
      ...(structuredErrors !== undefined ? { structuredErrors } : {}),
      ...(structuredErrorsTotal !== undefined
        ? { structuredErrorsTotal }
        : {}),
      ...(structuredErrorsComplete !== undefined
        ? { structuredErrorsComplete }
        : {}),
    },
    compatibleMode,
  };
}

function conflictFromError(
  error: RelatedTestStructuredError,
): RelatedValidationConflictEvidence | null {
  const nestedSeatbelt =
    /\bsandbox_apply(?:\([^)]*\))?:\s*(?:operation not permitted|permission denied)\b/i
      .exec(error.message);
  if (nestedSeatbelt) {
    return {
      kind: 'nested-seatbelt-sandbox-apply',
      source: 'vitest-json',
      scope: error.scope,
      file: error.file,
      ...(error.testName !== undefined ? { testName: error.testName } : {}),
      message: error.message,
      syscall: 'sandbox_apply',
    };
  }

  const loopback = /\blisten\s+(EPERM|EACCES):\s*(?:operation not permitted|permission denied)\s+(\[?::1\]?|127(?:\.\d{1,3}){3}|localhost)(?::(\d+))?/i
    .exec(error.message);
  if (loopback) {
    return {
      kind: 'loopback-listen-denied',
      source: 'vitest-json',
      scope: error.scope,
      file: error.file,
      ...(error.testName !== undefined ? { testName: error.testName } : {}),
      message: error.message,
      code: loopback[1]!.toUpperCase() as 'EPERM' | 'EACCES',
      syscall: 'listen',
      address: loopback[2]!,
    };
  }
  return null;
}

/**
 * A conflict is confirmed only when every failed structured error is one of the
 * narrowly supported host-capability errors. Missing evidence and mixed
 * assertion/infrastructure failures remain ordinary related-test failures.
 */
export function diagnoseRelatedTestResult(
  input: DiagnoseRelatedTestInput,
): RelatedTestDiagnostic {
  const initial = relatedTestInvocation(input, false);
  const errors = initial.result.structuredErrors;
  if (
    initial.selectionComplete === false ||
    initial.result.timedOut ||
    initial.result.exitCode === 0 ||
    errors === undefined ||
    errors.length === 0 ||
    initial.result.structuredErrorsComplete !== true ||
    initial.result.structuredErrorsTotal !== errors.length
  ) {
    return {
      state: 'related-test-failure',
      initial,
      conflictEvidence: [],
    };
  }
  const classified = errors.map(conflictFromError);
  if (classified.some((entry) => entry === null)) {
    return {
      state: 'related-test-failure',
      initial,
      conflictEvidence: classified.filter(
        (entry): entry is RelatedValidationConflictEvidence => entry !== null,
      ),
    };
  }
  return {
    state: 'related-validation-host-conflict',
    initial,
    conflictEvidence: classified as RelatedValidationConflictEvidence[],
  };
}

export function diagnoseRelatedTestFallback(
  conflict: RelatedTestDiagnostic,
  input: DiagnoseRelatedTestInput,
): Extract<RelatedTestDiagnostic, {
  state: 'related-fallback-passed' | 'related-fallback-failed';
}> {
  if (conflict.state !== 'related-validation-host-conflict') {
    throw new Error('related-test fallback requires a confirmed validation host conflict');
  }
  const fallback = relatedTestInvocation(input, true);
  return {
    state: !fallback.result.timedOut &&
        fallback.result.exitCode === 0 &&
        fallback.result.structuredErrors !== undefined &&
        fallback.result.structuredErrors.length === 0 &&
        fallback.result.structuredErrorsTotal === 0 &&
        fallback.result.structuredErrorsComplete === true
      ? 'related-fallback-passed'
      : 'related-fallback-failed',
    initial: conflict.initial,
    conflictEvidence: conflict.conflictEvidence.map((evidence) => ({ ...evidence })),
    fallback,
  };
}

/** Bounded, already-scrubbed assertion/suite details for coder repair feedback. */
export function formatRelatedTestStructuredErrors(
  result: ValidationCommandResult,
  maxChars = 8_000,
): string {
  const errors = result.structuredErrors;
  if (errors === undefined || errors.length === 0) return '';
  const lines = errors.map((error) => {
    const label = [
      error.file,
      error.testName,
      error.scope === 'suite' ? 'suite failure' : undefined,
    ].filter(Boolean).join(' · ');
    return `${label}: ${error.message}`;
  });
  if (result.structuredErrorsComplete === false) {
    lines.push(
      `Structured Vitest errors truncated: retained ${errors.length} of ` +
      `${result.structuredErrorsTotal ?? errors.length}`,
    );
  }
  return scrub(lines.join('\n')).slice(-maxChars);
}
