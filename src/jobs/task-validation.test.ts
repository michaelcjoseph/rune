import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  taskValidationCommandFailure,
  validateTaskValidationAdmission,
} from './task-validation.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('task validation directory containment', () => {
  it('rejects a real validationCwd symlink that resolves outside the worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'task-validation-symlink-'));
    roots.push(root);
    const worktree = join(root, 'worktree');
    const outside = join(root, 'outside-harness');
    mkdirSync(worktree);
    mkdirSync(outside);
    symlinkSync(outside, join(worktree, 'harness'), 'dir');

    const admission = validateTaskValidationAdmission({
      policy: 'required',
      commands: ['node --version'],
      worktree,
      validationCwd: 'harness',
      pathEnv: dirname(process.execPath),
    });

    expect(admission).toMatchObject({
      ok: false,
      failure: {
        kind: 'invalid-validation-cwd',
        prerequisite: 'validationCwd',
        validationCwd: 'harness',
      },
    });
  });

  it('returns the contained harness directory used by downstream command runners', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'task-validation-contained-'));
    roots.push(worktree);
    const harness = join(worktree, 'harness');
    mkdirSync(harness);

    const admission = validateTaskValidationAdmission({
      policy: 'required',
      commands: ['node --version'],
      worktree,
      validationCwd: 'harness',
      pathEnv: dirname(process.execPath),
    });

    expect(admission).toEqual({ ok: true, cwd: harness });
  });

  it('does not treat a searchable directory in PATH as an executable', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'task-validation-directory-bin-'));
    roots.push(worktree);
    const bin = join(worktree, 'bin');
    mkdirSync(join(bin, 'uv'), { recursive: true });

    const admission = validateTaskValidationAdmission({
      policy: 'required',
      commands: ['uv sync'],
      worktree,
      pathEnv: bin,
    });

    expect(admission).toMatchObject({
      ok: false,
      failure: {
        kind: 'missing-executable',
        executable: 'uv',
      },
    });
  });
});

describe('task validation command admission', () => {
  it.each([
    'node --version;rm',
    'node --version&&echo',
    'node|cat',
    'node>result.txt',
  ])('rejects compact shell syntax in %j before role dispatch', (command) => {
    const worktree = mkdtempSync(join(tmpdir(), 'task-validation-command-'));
    roots.push(worktree);

    const admission = validateTaskValidationAdmission({
      policy: 'required',
      commands: [command],
      worktree,
      pathEnv: dirname(process.execPath),
    });

    expect(admission).toMatchObject({
      ok: false,
      failure: {
        kind: 'malformed-command',
        command,
        prerequisite: 'validationCommands',
      },
    });
  });

  it('preserves structured argv executable evidence for rendered commands', () => {
    const failure = taskValidationCommandFailure(
      '"npx" "vitest" "related" "--run"',
      {
        exitCode: 1,
        timedOut: false,
        outputHead: '',
        outputTail: 'suite failed',
        diagnosticArtifacts: [],
      },
      'suite failed',
      ['npx', 'vitest', 'related', '--run'],
    );

    expect(failure).toMatchObject({
      kind: 'command-failed',
      command: '"npx" "vitest" "related" "--run"',
      prerequisite: 'executable',
      executable: 'npx',
      exitCode: 1,
    });
  });
});
