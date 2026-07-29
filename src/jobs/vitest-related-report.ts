/**
 * Bounded parser for the private Vitest JSON report used by `vitest related`.
 *
 * Product tests control this file's contents, so the parser treats it like any
 * other untrusted validation artifact: byte, entry, and field bounds are
 * enforced before the result can enter Rune's durable or user-facing records.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { basename, relative } from 'node:path';
import { scrubPathsInText } from '../ai/tool-labels.js';
import {
  RELATED_TEST_ERROR_FILE_MAX_CHARS,
  RELATED_TEST_ERROR_MESSAGE_MAX_CHARS,
  RELATED_TEST_ERROR_TEST_NAME_MAX_CHARS,
  RELATED_TEST_STRUCTURED_ERRORS_MAX,
  type RelatedTestStructuredError,
} from '../intent/related-test-diagnostic.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';
import { redactSecrets } from './work-run-transcript.js';

export const MAX_VITEST_RELATED_REPORT_BYTES = 2_000_000;
export const MAX_VITEST_STRUCTURED_ERRORS = RELATED_TEST_STRUCTURED_ERRORS_MAX;
export const MAX_VITEST_ERROR_FILE_CHARS = RELATED_TEST_ERROR_FILE_MAX_CHARS;
export const MAX_VITEST_ERROR_TEST_NAME_CHARS =
  RELATED_TEST_ERROR_TEST_NAME_MAX_CHARS;
export const MAX_VITEST_ERROR_MESSAGE_CHARS = RELATED_TEST_ERROR_MESSAGE_MAX_CHARS;

export interface VitestRelatedReport {
  errors: RelatedTestStructuredError[];
  total: number;
  /** False when any error or field had to be truncated. */
  complete: boolean;
}

interface VitestJsonAssertion {
  fullName?: unknown;
  status?: unknown;
  failureMessages?: unknown;
}

interface VitestJsonTestResult {
  name?: unknown;
  status?: unknown;
  message?: unknown;
  assertionResults?: unknown;
}

function scrubBounded(
  raw: string,
  maxChars: number,
): { value: string; complete: boolean } {
  // Scrub the complete bounded-report field before truncating. Slicing first
  // could split a secret/path so the remaining prefix no longer matches the
  // redactor.
  const scrubbed = redactSecrets(scrubAbsolutePaths(scrubPathsInText(raw)));
  return {
    value: scrubbed.slice(0, maxChars),
    complete: raw.length <= maxChars && scrubbed.length <= maxChars,
  };
}

export function parseVitestRelatedReport(
  reportPath: string,
  cwd: string,
): VitestRelatedReport | undefined {
  let parsed: unknown;
  let fd: number | undefined;
  try {
    fd = openSync(
      reportPath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > MAX_VITEST_RELATED_REPORT_BYTES) {
      return undefined;
    }
    const buffer = Buffer.alloc(MAX_VITEST_RELATED_REPORT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(
        fd,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_VITEST_RELATED_REPORT_BYTES) return undefined;
    parsed = JSON.parse(buffer.toString('utf8', 0, bytesRead));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Parsing already fails closed; cleanup failure must not surface a
        // product-controlled report path or overturn that result.
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const testResults = (parsed as Record<string, unknown>)['testResults'];
  if (!Array.isArray(testResults)) return undefined;

  const errors: RelatedTestStructuredError[] = [];
  let total = 0;
  let complete = true;

  const retain = (error: RelatedTestStructuredError, fieldsComplete: boolean): void => {
    total++;
    if (!fieldsComplete) complete = false;
    if (errors.length < MAX_VITEST_STRUCTURED_ERRORS) {
      errors.push(error);
    } else {
      complete = false;
    }
  };

  const safeFile = (value: string): { value: string; complete: boolean } => {
    const rel = relative(cwd, value).replaceAll('\\', '/');
    const label = rel === '' ? basename(value) : rel;
    return scrubBounded(
      label.startsWith('../') ? basename(value) : label,
      MAX_VITEST_ERROR_FILE_CHARS,
    );
  };

  for (const rawResult of testResults) {
    if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
      complete = false;
      continue;
    }
    const result = rawResult as VitestJsonTestResult;
    if (result.status !== 'failed') {
      if (result.status !== 'passed' && result.status !== 'pending') complete = false;
      continue;
    }
    if (typeof result.name !== 'string') complete = false;
    const file = safeFile(typeof result.name === 'string' ? result.name : 'unknown-test-file');
    let assertionFailureCount = 0;
    if (Array.isArray(result.assertionResults)) {
      for (const rawAssertion of result.assertionResults) {
        if (!rawAssertion || typeof rawAssertion !== 'object' || Array.isArray(rawAssertion)) {
          complete = false;
          continue;
        }
        const assertion = rawAssertion as VitestJsonAssertion;
        if (assertion.status !== 'failed') {
          if (
            assertion.status !== 'passed' &&
            assertion.status !== 'pending' &&
            assertion.status !== 'skipped' &&
            assertion.status !== 'todo'
          ) complete = false;
          continue;
        }
        assertionFailureCount++;
        if (assertion.fullName !== undefined && typeof assertion.fullName !== 'string') {
          complete = false;
        }
        const testName = typeof assertion.fullName === 'string'
          ? scrubBounded(assertion.fullName, MAX_VITEST_ERROR_TEST_NAME_CHARS)
          : undefined;
        if (!Array.isArray(assertion.failureMessages)) complete = false;
        const rawMessages = Array.isArray(assertion.failureMessages)
          ? assertion.failureMessages
          : [];
        if (rawMessages.some((message) => typeof message !== 'string')) {
          complete = false;
        }
        const messages = rawMessages.filter(
          (message): message is string => typeof message === 'string',
        );
        if (messages.length === 0) {
          retain({
            source: 'vitest-json',
            scope: 'assertion',
            file: file.value,
            ...(testName !== undefined ? { testName: testName.value } : {}),
            message: 'Vitest reported a failed assertion without structured failure details',
          }, file.complete && (testName?.complete ?? true));
          continue;
        }
        for (const rawMessage of messages) {
          const message = scrubBounded(rawMessage, MAX_VITEST_ERROR_MESSAGE_CHARS);
          retain({
            source: 'vitest-json',
            scope: 'assertion',
            file: file.value,
            ...(testName !== undefined ? { testName: testName.value } : {}),
            message: message.value,
          }, file.complete && (testName?.complete ?? true) && message.complete);
        }
      }
    } else if (result.assertionResults !== undefined) {
      complete = false;
    }
    if (assertionFailureCount === 0) {
      if (result.message !== undefined && typeof result.message !== 'string') {
        complete = false;
      }
      const message = typeof result.message === 'string' && result.message.trim() !== ''
        ? scrubBounded(result.message, MAX_VITEST_ERROR_MESSAGE_CHARS)
        : {
            value: 'Vitest reported a failed suite without structured failure details',
            complete: true,
          };
      retain({
        source: 'vitest-json',
        scope: 'suite',
        file: file.value,
        message: message.value,
      }, file.complete && message.complete);
    }
  }

  return { errors, total, complete };
}
