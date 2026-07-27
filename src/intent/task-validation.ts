/** Durable, provider-neutral evidence for orchestrated task validation. */

export type TaskValidationFailureKind =
  | 'missing-commands'
  | 'malformed-command'
  | 'invalid-validation-cwd'
  | 'missing-executable'
  | 'command-failed'
  | 'timeout';

/** Raw command output is bounded and scrubbed before this record is created. */
export interface TaskValidationFailure {
  kind: TaskValidationFailureKind;
  command: string;
  prerequisite: string;
  executable?: string;
  validationCwd?: string;
  exitCode: number | null;
  timedOut: boolean;
  diagnostics: string;
}
