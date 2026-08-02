// @module-tag validation-sandbox-integration
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  captureCanonicalChangedPaths,
  captureCanonicalReviewState,
  captureCleanTaskBaseTree,
  defaultRunCanonicalGit,
  isGitObjectId,
  treeForCommit,
  verifyTaskBaseTree,
} from './canonical-git.js';
import { defaultRunGit } from './sandbox-runtime.js';
import {
  VALIDATION_CONFINEMENT_ATTESTATION_ENV,
  VALIDATION_SANDBOX_BROKER_SOCKET_ENV,
} from '../utils/validation-confinement.js';
import * as validationSandboxBroker from './validation-sandbox-broker.js';
import { withValidationBroker } from './validation-broker-test-stub.js';

const roots: string[] = [];
const originalToken = process.env['TELEGRAM_BOT_TOKEN'];
const originalBrokerSocket = process.env[VALIDATION_SANDBOX_BROKER_SOCKET_ENV];
const originalAttestation = process.env[VALIDATION_CONFINEMENT_ATTESTATION_ENV];

afterEach(() => {
  if (originalToken === undefined) delete process.env['TELEGRAM_BOT_TOKEN'];
  else process.env['TELEGRAM_BOT_TOKEN'] = originalToken;
  if (originalBrokerSocket === undefined) {
    delete process.env[VALIDATION_SANDBOX_BROKER_SOCKET_ENV];
  } else {
    process.env[VALIDATION_SANDBOX_BROKER_SOCKET_ENV] = originalBrokerSocket;
  }
  if (originalAttestation === undefined) {
    delete process.env[VALIDATION_CONFINEMENT_ATTESTATION_ENV];
  } else {
    process.env[VALIDATION_CONFINEMENT_ATTESTATION_ENV] = originalAttestation;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical Git security boundary', () => {
  it.each(['--local', '--worktree'])(
    'refuses a product-controlled %s clean filter before staging can execute it',
    async (scope) => {
      const repo = mkdtempSync(join(tmpdir(), 'canonical-git-filter-'));
      roots.push(repo);
      const leak = join(repo, 'leak.txt');
      const filter = join(repo, 'filter.sh');
      writeFileSync(
        filter,
        '#!/bin/sh\nprintf "%s" "${TELEGRAM_BOT_TOKEN-}" > "$1"\ncat\n',
      );
      chmodSync(filter, 0o755);
      writeFileSync(join(repo, '.gitattributes'), 'payload.txt filter=probe\n');
      writeFileSync(join(repo, 'payload.txt'), 'payload\n');
      await defaultRunGit(['init', '--initial-branch', 'main'], { cwd: repo });
      if (scope === '--worktree') {
        await defaultRunGit(['config', 'extensions.worktreeConfig', 'true'], { cwd: repo });
      }
      await defaultRunGit(['config', scope, 'filter.probe.clean', `${filter} ${leak}`], { cwd: repo });
      process.env['TELEGRAM_BOT_TOKEN'] = 'rune-parent-secret';

      await expect(defaultRunCanonicalGit(['add', '-A'], { cwd: repo })).rejects.toThrow(
        /refuses external repository drivers.*filter\.probe\.clean/i,
      );
      expect(existsSync(leak)).toBe(false);
    },
  );

  it('reuses live broker-attested validation confinement while retaining Git-driver rejection', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'canonical-git-inherited-'));
    roots.push(repo);
    await defaultRunGit(['init', '--initial-branch', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'payload.txt'), 'payload\n');
    await defaultRunGit(
      ['config', '--local', 'diff.probe.textconv', '/usr/bin/false'],
      { cwd: repo },
    );
    await withValidationBroker(async ({ socketPath, attestationNonce }) => {
      process.env[VALIDATION_SANDBOX_BROKER_SOCKET_ENV] = socketPath;
      process.env[VALIDATION_CONFINEMENT_ATTESTATION_ENV] = attestationNonce;
      await expect(
        defaultRunCanonicalGit(['add', '-A'], { cwd: repo }),
      ).rejects.toThrow(/refuses external repository drivers.*diff\.probe\.textconv/i);
    });
  });

  // The test above configures an external Git driver so `rejectExternalGitDrivers`
  // always throws BEFORE the confinement-reuse decision is ever reached — it
  // proves driver rejection survives the refactor, but not that the new
  // `verifyInheritedValidationConfinement` call is actually wired in. This uses
  // a driver-free repo so the call is genuinely reached, and honors whatever the
  // live broker answers (both "yes, reuse" and "no, apply Rune's own Seatbelt").
  it.each([true, false])(
    "asks the live broker to verify sandbox-integration confinement before every non-rejected call, and honors a %s answer",
    async (confinementAnswer) => {
      const repo = mkdtempSync(join(tmpdir(), 'canonical-git-confinement-check-'));
      roots.push(repo);
      await defaultRunGit(['init', '--initial-branch', 'main'], { cwd: repo });
      writeFileSync(join(repo, 'payload.txt'), 'payload\n');

      const spy = vi
        .spyOn(validationSandboxBroker, 'verifyInheritedValidationConfinement')
        .mockResolvedValue(confinementAnswer);
      try {
        await expect(
          defaultRunCanonicalGit(['add', '-A'], { cwd: repo }),
        ).resolves.toBeDefined();

        if (process.platform === 'darwin') {
          expect(spy).toHaveBeenCalledWith('sandbox-integration');
        } else {
          // Confinement reuse is a macOS-only concept; on other platforms the
          // check must never even run.
          expect(spy).not.toHaveBeenCalled();
        }
      } finally {
        // `mockRestore()` clears recorded calls, so it must run only after
        // every assertion against `spy` above has already been made.
        spy.mockRestore();
      }
    },
  );
});

describe('clean task-base capture', () => {
  it('returns the verified committed tree for a clean worktree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'canonical-task-base-clean-'));
    roots.push(repo);
    await defaultRunGit(['init', '--initial-branch', 'main'], { cwd: repo });
    await defaultRunGit(['config', 'user.email', 'rune@example.test'], { cwd: repo });
    await defaultRunGit(['config', 'user.name', 'Rune Test'], { cwd: repo });
    writeFileSync(join(repo, 'payload.txt'), 'payload\n');
    await defaultRunGit(['add', '-A'], { cwd: repo });
    await defaultRunGit(['commit', '-m', 'base'], { cwd: repo });
    const expected = (
      await defaultRunGit(['rev-parse', '--verify', 'HEAD^{tree}'], { cwd: repo })
    ).stdout.trim();

    await expect(captureCleanTaskBaseTree(defaultRunGit, repo)).resolves.toBe(expected);
  });

  it('fails closed when tracked or untracked pre-task changes exist', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'canonical-task-base-dirty-'));
    roots.push(repo);
    await defaultRunGit(['init', '--initial-branch', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'unexpected.txt'), 'not part of a task base\n');

    await expect(captureCleanTaskBaseTree(defaultRunGit, repo)).rejects.toThrow(
      /requires a clean worktree/i,
    );
  });
});

describe('isGitObjectId', () => {
  it('accepts full sha1 and sha256 object ids and rejects everything else', () => {
    expect(isGitObjectId('a'.repeat(40))).toBe(true);
    expect(isGitObjectId('a'.repeat(64))).toBe(true);
    expect(isGitObjectId('A'.repeat(40))).toBe(false);
    expect(isGitObjectId('a'.repeat(39))).toBe(false);
    expect(isGitObjectId('HEAD')).toBe(false);
    expect(isGitObjectId('--upload-pack=evil')).toBe(false);
    expect(isGitObjectId('')).toBe(false);
  });
});

function initBaseRepo(dir: string): Promise<void> {
  return (async () => {
    await defaultRunGit(['init', '--initial-branch', 'main'], { cwd: dir });
    await defaultRunGit(['config', 'user.email', 'rune@example.test'], { cwd: dir });
    await defaultRunGit(['config', 'user.name', 'Rune Test'], { cwd: dir });
  })();
}

describe('verifyTaskBaseTree', () => {
  it('resolves an already-durable task base without mutating the worktree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'canonical-verify-task-base-'));
    roots.push(repo);
    await initBaseRepo(repo);
    writeFileSync(join(repo, 'payload.txt'), 'payload\n');
    await defaultRunGit(['add', '-A'], { cwd: repo });
    await defaultRunGit(['commit', '-m', 'base'], { cwd: repo });
    const treeOid = (
      await defaultRunGit(['rev-parse', '--verify', 'HEAD^{tree}'], { cwd: repo })
    ).stdout.trim();

    await expect(verifyTaskBaseTree(defaultRunGit, repo, treeOid)).resolves.toBe(treeOid);
  });

  it('rejects a malformed tree OID before it ever reaches Git', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'canonical-verify-task-base-malformed-'));
    roots.push(repo);
    await initBaseRepo(repo);

    await expect(
      verifyTaskBaseTree(defaultRunGit, repo, '--upload-pack=evil'),
    ).rejects.toThrow(/malformed tree OID/i);
  });

  it('rejects an object id that Git cannot verify as a tree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'canonical-verify-task-base-unknown-'));
    roots.push(repo);
    await initBaseRepo(repo);
    writeFileSync(join(repo, 'payload.txt'), 'payload\n');
    await defaultRunGit(['add', '-A'], { cwd: repo });
    await defaultRunGit(['commit', '-m', 'base'], { cwd: repo });

    await expect(
      verifyTaskBaseTree(defaultRunGit, repo, 'a'.repeat(40)),
    ).rejects.toThrow();
  });
});

describe('treeForCommit', () => {
  it('resolves a closeout commit to its authoritative tree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'canonical-tree-for-commit-'));
    roots.push(repo);
    await initBaseRepo(repo);
    writeFileSync(join(repo, 'payload.txt'), 'payload\n');
    await defaultRunGit(['add', '-A'], { cwd: repo });
    await defaultRunGit(['commit', '-m', 'closeout'], { cwd: repo });
    const commitOid = (await defaultRunGit(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    const expectedTree = (
      await defaultRunGit(['rev-parse', '--verify', 'HEAD^{tree}'], { cwd: repo })
    ).stdout.trim();

    await expect(treeForCommit(defaultRunGit, repo, commitOid)).resolves.toBe(expectedTree);
  });

  it('rejects a malformed commit OID before it ever reaches Git', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'canonical-tree-for-commit-malformed-'));
    roots.push(repo);
    await initBaseRepo(repo);

    await expect(
      treeForCommit(defaultRunGit, repo, 'not-a-commit'),
    ).rejects.toThrow(/malformed commit OID/i);
  });
});

describe('full-task changed paths and malformed task-base rejection', () => {
  it('captures only the full-task changed paths relative to the task base', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'canonical-changed-paths-'));
    roots.push(repo);
    await initBaseRepo(repo);
    writeFileSync(join(repo, 'untouched.ts'), 'export const untouched = true;\n');
    await defaultRunGit(['add', '-A'], { cwd: repo });
    await defaultRunGit(['commit', '-m', 'base'], { cwd: repo });
    const taskBaseTree = (
      await defaultRunGit(['rev-parse', '--verify', 'HEAD^{tree}'], { cwd: repo })
    ).stdout.trim();
    writeFileSync(join(repo, 'touched.ts'), 'export const touched = true;\n');

    const paths = await captureCanonicalChangedPaths(defaultRunGit, repo, taskBaseTree);

    expect(paths).toEqual(['touched.ts']);
  });

  it('rejects capturing a review surface against a malformed task-base tree', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'canonical-review-malformed-base-'));
    roots.push(repo);
    await initBaseRepo(repo);
    writeFileSync(join(repo, 'payload.txt'), 'payload\n');
    await defaultRunGit(['add', '-A'], { cwd: repo });
    await defaultRunGit(['commit', '-m', 'base'], { cwd: repo });

    await expect(
      captureCanonicalReviewState(defaultRunGit, repo, '--upload-pack=evil'),
    ).rejects.toThrow(/malformed tree OID/i);
    await expect(
      captureCanonicalChangedPaths(defaultRunGit, repo, '--upload-pack=evil'),
    ).rejects.toThrow(/malformed tree OID/i);
  });
});
