/**
 * Fail-closed admission and evidence for one orchestrated task's mechanical
 * validation contract. This is intentionally separate from
 * `runValidationCommands`: legacy callers may still treat `[]` as an
 * intentional pass, while product-team admission must prove that a required
 * task has a usable command list, working directory, and executables.
 */

import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path';

import type { ValidationPolicy } from '../intent/planning-roles.js';
import type {
  TaskValidationFailure,
  TaskValidationFailureKind,
} from '../intent/task-validation.js';
import { DEFAULT_BASE_ENV_KEYS, getBaseEnv } from './credential-injector.js';
import type { ValidationCommandResult } from './work-run-gate-runtime.js';

export type { TaskValidationFailure, TaskValidationFailureKind } from '../intent/task-validation.js';

export type TaskValidationAdmission =
  | { ok: true; cwd: string }
  | { ok: false; failure: TaskValidationFailure };

export interface TaskValidationAdmissionInput {
  policy?: ValidationPolicy;
  commands: readonly string[];
  worktree: string;
  validationCwd?: string;
  pathEnv?: string;
  isExecutable?: (path: string) => boolean;
}

const SHELL_SYNTAX = /[;&|<>`]|\$\(/;

/** Parse the legacy string command exactly as the argv-only runtime does.
 * Admission additionally rejects shell syntax so a malformed policy cannot be
 * mistaken for a usable command whose metacharacters would merely be literals. */
export function parseValidationCommand(command: string):
  | { ok: true; argv: string[] }
  | { ok: false } {
  const trimmed = command.trim();
  if (trimmed === '' || /[\0\r\n"']/.test(trimmed) || SHELL_SYNTAX.test(trimmed)) {
    return { ok: false };
  }
  const argv = trimmed.split(/\s+/);
  return argv[0] ? { ok: true, argv } : { ok: false };
}

/** Resolve the configured validation directory to a real directory contained
 * by this worktree. Symlink escapes fail closed. */
export function resolveValidationCwd(
  worktree: string,
  configured?: string,
): TaskValidationAdmission {
  const command = '';
  const prerequisite = configured?.trim() || '.';
  try {
    const root = realpathSync(worktree);
    if (configured !== undefined && (
      configured.trim() === '' ||
      isAbsolute(configured) ||
      configured.split(/[\\/]+/).includes('..')
    )) {
      return invalidDirectory(command, prerequisite);
    }
    const requested = resolve(worktree, configured ?? '.');
    const candidate = realpathSync(requested);
    const rel = relative(root, candidate);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(candidate).isDirectory()) {
      return invalidDirectory(command, prerequisite);
    }
    return { ok: true, cwd: requested };
  } catch {
    return invalidDirectory(command, prerequisite);
  }
}

/** Prove a required validation contract before QA or coder dispatch. */
export function validateTaskValidationAdmission(
  input: TaskValidationAdmissionInput,
): TaskValidationAdmission {
  if (input.policy === 'reviewed-no-validation') {
    return { ok: true, cwd: input.worktree };
  }
  if (input.commands.length === 0) {
    return {
      ok: false,
      failure: failure('missing-commands', '', 'validationCommands'),
    };
  }

  const parsedCommands: Array<{ command: string; argv: string[] }> = [];
  for (const command of input.commands) {
    const parsed = parseValidationCommand(command);
    if (!parsed.ok) {
      return {
        ok: false,
        failure: failure('malformed-command', command, 'validationCommands'),
      };
    }
    parsedCommands.push({ command, argv: parsed.argv });
  }

  const cwd = resolveValidationCwd(input.worktree, input.validationCwd);
  if (!cwd.ok) return cwd;
  const pathEnv = input.pathEnv ?? getBaseEnv(DEFAULT_BASE_ENV_KEYS).PATH ?? '';
  const executable = input.isExecutable ?? defaultIsExecutable;
  for (const { command, argv } of parsedCommands) {
    const prerequisite = argv[0]!;
    if (!findExecutable(prerequisite, cwd.cwd, pathEnv, executable)) {
      const missing = failure('missing-executable', command, 'executable');
      missing.executable = prerequisite;
      return {
        ok: false,
        failure: missing,
      };
    }
  }
  return cwd;
}

export function taskValidationCommandFailure(
  command: string,
  result: ValidationCommandResult,
  diagnostics: string,
  argv?: readonly string[],
): TaskValidationFailure {
  const parsedArgv = argv ?? (() => {
    const parsed = parseValidationCommand(command);
    return parsed.ok ? parsed.argv : undefined;
  })();
  const executable = parsedArgv?.[0];
  const profileUnavailable = result.failureClass === 'profile-unavailable';
  const prerequisite = profileUnavailable
    ? result.profile ?? 'validation profile'
    : parsedArgv !== undefined && isDependencyInstallCommand(parsedArgv)
      ? 'dependency-install'
      : executable === undefined
        ? 'validationCommands'
        : 'executable';
  return {
    ...failure(
      profileUnavailable
        ? 'profile-unavailable'
        : result.timedOut ? 'timeout' : 'command-failed',
      command,
      prerequisite,
    ),
    ...(!profileUnavailable && executable !== undefined ? { executable } : {}),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    diagnostics,
  };
}

function isDependencyInstallCommand(argv: readonly string[]): boolean {
  const [bin, action] = argv;
  return (
    (bin === 'uv' && action === 'sync') ||
    (bin === 'pip' && action === 'install') ||
    (bin === 'npm' && (action === 'install' || action === 'ci')) ||
    ((bin === 'pnpm' || bin === 'yarn' || bin === 'bun') && action === 'install')
  );
}

function failure(
  kind: TaskValidationFailureKind,
  command: string,
  prerequisite: string,
): TaskValidationFailure {
  return {
    kind,
    command,
    prerequisite,
    exitCode: null,
    timedOut: false,
    diagnostics: '',
  };
}

function invalidDirectory(command: string, prerequisite: string): TaskValidationAdmission {
  const failureRecord = failure('invalid-validation-cwd', command, 'validationCwd');
  failureRecord.validationCwd = prerequisite;
  return {
    ok: false,
    failure: failureRecord,
  };
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findExecutable(
  executable: string,
  cwd: string,
  pathEnv: string,
  isExecutableFn: (path: string) => boolean,
): string | null {
  if (executable.includes('/') || executable.includes('\\')) {
    const candidate = isAbsolute(executable) ? executable : resolve(cwd, executable);
    return isExecutableFn(candidate) ? candidate : null;
  }
  for (const entry of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = resolve(entry, executable);
    if (isExecutableFn(candidate)) return candidate;
  }
  return null;
}
