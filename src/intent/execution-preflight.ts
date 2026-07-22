import type { RoleName } from '../roles/loader.js';
import type { DispatchProvider } from './dispatch.js';

export type ExecutionPreflightRole = RoleName;
export type ExecutionPreflightFormat = 'claude' | 'codex';
export type ExecutionPreflightPrerequisite =
  | 'binary'
  | 'authentication'
  | 'model-call'
  | 'artifact-mcp';

export interface ExecutionPreflightBindingEvidence {
  roles: ExecutionPreflightRole[];
  provider: DispatchProvider;
  format: ExecutionPreflightFormat;
  model: string;
}

export interface ExecutionPreflightSuccess {
  status: 'success';
  bindings: ExecutionPreflightBindingEvidence[];
  artifactMcp: 'not-required' | 'validated';
  artifactFormats: ExecutionPreflightFormat[];
}

/** Durable, bounded prerequisite evidence emitted only when automated role
 * execution is blocked before the first product-team role is invoked. */
export interface ExecutionPreflightFailure {
  status: 'failed';
  roles: ExecutionPreflightRole[];
  provider: DispatchProvider;
  format: ExecutionPreflightFormat;
  model: string;
  prerequisite: ExecutionPreflightPrerequisite;
  diagnostic: string;
  remediation: string;
}

export type ExecutionPreflightResult = ExecutionPreflightSuccess | ExecutionPreflightFailure;
