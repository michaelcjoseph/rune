/**
 * Test suite for `src/jobs/sandbox-fs.ts` — in-process fs wrappers that
 * enforce sandbox write boundaries before delegating to the real fs syscall.
 *
 * Written test-first (task A1.4 of docs/projects/08-intent-layer/tasks.md).
 * `src/jobs/sandbox-fs.ts` does not exist yet — every test must fail with a
 * missing-module / missing-export error, confirming "the right kind of red"
 * before implementation begins.
 *
 * Contract tested:
 *   assertWritable(sandbox, target)  — core guard (lexical + symlink resolution)
 *   writeFileInSandbox(...)          — delegates to fs.writeFileSync after guard
 *   appendFileInSandbox(...)         — delegates to fs.appendFileSync after guard
 *   mkdirInSandbox(...)              — delegates to fs.mkdirSync after guard
 *   rmInSandbox(...)                 — delegates to fs.rmSync after guard
 *
 * See docs/projects/08-intent-layer/{spec.md (§"Layer 4"), test-plan.md §11}.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SandboxSpec } from '../intent/sandbox.js';

// ---------------------------------------------------------------------------
// Module under test — does not exist yet; every test must fail at this import.
// ---------------------------------------------------------------------------

import {
  assertWritable,
  writeFileInSandbox,
  appendFileInSandbox,
  mkdirInSandbox,
  rmInSandbox,
} from './sandbox-fs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SandboxSpec whose worktree is `worktree`. */
function sandboxFor(worktree: string): SandboxSpec {
  return { product: 'test', project: '01-test', worktree, egressAllowlist: [] };
}

/**
 * Probe symlink support once at suite load. macOS and Linux always support
 * it for unprivileged users; the probe exists only to gate the symlink
 * describe block via `describe.runIf` so a host that disallows them
 * (Windows without SeCreateSymbolicLinkPrivilege, locked-down CI runners)
 * skips the cases loudly rather than silently passing.
 */
const symlinksSupported = (() => {
  const probeDir = mkdtempSync(join(tmpdir(), 'rune-sandbox-fs-probe-'));
  try {
    symlinkSync('/tmp', join(probeDir, 'probe-link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

// ---------------------------------------------------------------------------
// Temp dir management — each test gets its own dir created in beforeEach.
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rune-sandbox-fs-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// assertWritable — the core guard
// ---------------------------------------------------------------------------

describe('assertWritable — happy path', () => {
  it('does not throw for a new path inside the real worktree dir', () => {
    // tmpDir is the worktree; targeting a not-yet-existing file inside it is fine.
    const sandbox = sandboxFor(tmpDir);
    const target = join(tmpDir, 'src', 'new-file.ts');
    expect(() => assertWritable(sandbox, target)).not.toThrow();
  });

  it('does not throw for the worktree root itself', () => {
    const sandbox = sandboxFor(tmpDir);
    expect(() => assertWritable(sandbox, tmpDir)).not.toThrow();
  });

  it('does not throw for a deeply nested path inside the worktree', () => {
    const sandbox = sandboxFor(tmpDir);
    const target = join(tmpDir, 'a', 'b', 'c', 'd', 'file.txt');
    expect(() => assertWritable(sandbox, target)).not.toThrow();
  });
});

describe('assertWritable — lexical denial', () => {
  it('throws for /etc/passwd against a worktree wholly outside /etc', () => {
    const sandbox = sandboxFor(join('/tmp', 'rune-worktrees', 'aura', '01-growth'));
    expect(() => assertWritable(sandbox, '/etc/passwd')).toThrow();
  });

  it('thrown error mentions the original target path', () => {
    const sandbox = sandboxFor(join('/tmp', 'rune-worktrees', 'aura', '01-growth'));
    let message = '';
    try {
      assertWritable(sandbox, '/etc/passwd');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/\/etc\/passwd/);
  });

  it('throws for a path in another product\'s worktree', () => {
    const sandbox = sandboxFor(join(tmpDir, 'aura', '01-growth'));
    const otherWorktree = join(tmpDir, 'relay', '01-core', 'src', 'index.ts');
    expect(() => assertWritable(sandbox, otherWorktree)).toThrow();
  });

  it('throws for a sibling path that shares the worktree name as a prefix', () => {
    // /tmp/work/aura/01-growth-evil must not pass as inside /tmp/work/aura/01-growth
    const worktree = join(tmpDir, 'aura', '01-growth');
    const sandbox = sandboxFor(worktree);
    const sibling = join(tmpDir, 'aura', '01-growth-evil', 'file.ts');
    expect(() => assertWritable(sandbox, sibling)).toThrow();
  });
});

describe.runIf(symlinksSupported)('assertWritable — symlink resolution catches escapes', () => {
  it('throws when target is an existing symlink pointing outside the worktree', () => {
    // Lexical check passes (link is inside tmpDir which is the worktree root),
    // but realpathSync resolves to /etc/passwd which is outside.
    const sandbox = sandboxFor(tmpDir);
    const linkPath = join(tmpDir, 'dangerous-link');
    symlinkSync('/etc/passwd', linkPath);

    expect(() => assertWritable(sandbox, linkPath)).toThrow(/symlink escape/i);
  });

  it('throws when the closest existing ancestor is a symlink pointing outside the worktree', () => {
    // target doesn't exist yet, but its parent 'escape' is a symlink pointing to
    // a real dir outside the worktree — resolution must catch this.
    const sandbox = sandboxFor(tmpDir);
    const outside = mkdtempSync(join(tmpdir(), 'rune-outside-'));
    try {
      const escapeLink = join(tmpDir, 'escape');
      symlinkSync(outside, escapeLink);
      const target = join(tmpDir, 'escape', 'new-file.txt');
      expect(() => assertWritable(sandbox, target)).toThrow(/symlink escape/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does NOT throw when a symlink inside the worktree resolves back inside the worktree', () => {
    // <worktree>/a/link -> <worktree>/b/file.txt — stays inside, must be allowed.
    const sandbox = sandboxFor(tmpDir);
    const dirA = join(tmpDir, 'a');
    const dirB = join(tmpDir, 'b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const targetFile = join(dirB, 'file.txt');
    writeFileSync(targetFile, 'hello');
    const linkPath = join(dirA, 'link');
    symlinkSync(targetFile, linkPath);

    expect(() => assertWritable(sandbox, linkPath)).not.toThrow();
  });

  it('error message mentions the resolved real path when it differs from the original target', () => {
    const sandbox = sandboxFor(tmpDir);
    const linkPath = join(tmpDir, 'escape-link');
    symlinkSync('/etc/passwd', linkPath);

    let message = '';
    try {
      assertWritable(sandbox, linkPath);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/escape-link/);
    expect(message).toMatch(/\/etc\/passwd/);
  });

  it('catches a relative symlink that escapes the worktree', () => {
    // <worktree>/sub/link -> ../../../etc/passwd — the lexical check on the
    // symlink's stored target wouldn't fire (the link itself is inside the
    // worktree); the realpath resolution catches the resolved escape.
    const sandbox = sandboxFor(tmpDir);
    const sub = join(tmpDir, 'sub');
    mkdirSync(sub, { recursive: true });
    const linkPath = join(sub, 'link');
    symlinkSync('../../../../../../../../etc/passwd', linkPath);

    expect(() => assertWritable(sandbox, linkPath)).toThrow(/symlink escape/i);
  });

  it('catches a multi-hop symlink chain that ends outside the worktree', () => {
    // <worktree>/link1 -> <worktree>/link2 -> /etc/passwd.
    const sandbox = sandboxFor(tmpDir);
    const link1 = join(tmpDir, 'link1');
    const link2 = join(tmpDir, 'link2');
    symlinkSync(link2, link1);
    symlinkSync('/etc/passwd', link2);

    expect(() => assertWritable(sandbox, link1)).toThrow(/symlink escape/i);
  });

  // Note on cyclic symlinks: `existsSync` follows links and returns false on
  // a cyclic chain, so the walk-up phase finds a non-cyclic ancestor and
  // realpathSync never sees the cycle. The try/catch around realpathSync
  // remains as defense-in-depth for any future code path that bypasses the
  // walk-up. Not tested here because it isn't reachable through the public
  // API.
});

// ---------------------------------------------------------------------------
// writeFileInSandbox
// ---------------------------------------------------------------------------

describe('writeFileInSandbox', () => {
  it('writes the file content inside the worktree', () => {
    const sandbox = sandboxFor(tmpDir);
    const target = join(tmpDir, 'hello.txt');
    writeFileInSandbox(sandbox, target, 'hello world');
    expect(readFileSync(target, 'utf8')).toBe('hello world');
  });

  it('accepts a Uint8Array payload', () => {
    const sandbox = sandboxFor(tmpDir);
    const target = join(tmpDir, 'bytes.bin');
    const data = new Uint8Array([0x68, 0x69]); // "hi"
    writeFileInSandbox(sandbox, target, data);
    const result = readFileSync(target);
    expect(result[0]).toBe(0x68);
    expect(result[1]).toBe(0x69);
  });

  it('throws when targetPath is outside the worktree', () => {
    const sandbox = sandboxFor(tmpDir);
    expect(() => writeFileInSandbox(sandbox, '/etc/passwd', 'evil')).toThrow();
  });

  it('does not write when targetPath is outside the worktree', () => {
    // The denial must fire BEFORE any fs syscall.
    const sandbox = sandboxFor(tmpDir);
    // We use a non-existent path well outside the worktree and verify no file
    // materializes (we cannot check /etc/passwd directly since we lack write
    // permission, but we confirm the throw and that the guard fired first).
    const targetOutside = '/etc/__rune_test_should_not_exist__';
    try {
      writeFileInSandbox(sandbox, targetOutside, 'data');
    } catch {
      // expected
    }
    expect(existsSync(targetOutside)).toBe(false);
  });

  it('respects the optional encoding argument', () => {
    const sandbox = sandboxFor(tmpDir);
    const target = join(tmpDir, 'utf8.txt');
    writeFileInSandbox(sandbox, target, 'content', 'utf8');
    expect(readFileSync(target, 'utf8')).toBe('content');
  });
});

// ---------------------------------------------------------------------------
// appendFileInSandbox
// ---------------------------------------------------------------------------

describe('appendFileInSandbox', () => {
  it('appends content to an existing file inside the worktree', () => {
    const sandbox = sandboxFor(tmpDir);
    const target = join(tmpDir, 'log.txt');
    writeFileSync(target, 'line1\n');
    appendFileInSandbox(sandbox, target, 'line2\n');
    expect(readFileSync(target, 'utf8')).toBe('line1\nline2\n');
  });

  it('creates the file if it does not exist yet', () => {
    const sandbox = sandboxFor(tmpDir);
    const target = join(tmpDir, 'new-log.txt');
    appendFileInSandbox(sandbox, target, 'first');
    expect(readFileSync(target, 'utf8')).toBe('first');
  });

  it('accepts a Uint8Array payload', () => {
    const sandbox = sandboxFor(tmpDir);
    const target = join(tmpDir, 'bytes.bin');
    appendFileInSandbox(sandbox, target, new Uint8Array([0x41])); // 'A'
    const result = readFileSync(target);
    expect(result[0]).toBe(0x41);
  });

  it('throws when targetPath is outside the worktree', () => {
    const sandbox = sandboxFor(tmpDir);
    expect(() => appendFileInSandbox(sandbox, '/etc/passwd', 'evil')).toThrow();
  });

  it('does not append when targetPath is outside the worktree', () => {
    // Guard must fire before any fs syscall — use a path we control so we can
    // verify nothing was written.
    const outside = mkdtempSync(join(tmpdir(), 'rune-outside-'));
    const outsideFile = join(outside, 'victim.txt');
    writeFileSync(outsideFile, 'original');
    const sandbox = sandboxFor(tmpDir);
    try {
      appendFileInSandbox(sandbox, outsideFile, 'evil-append');
    } catch {
      // expected
    }
    // Content must be unchanged — append did not happen.
    expect(readFileSync(outsideFile, 'utf8')).toBe('original');
    rmSync(outside, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// mkdirInSandbox
// ---------------------------------------------------------------------------

describe('mkdirInSandbox', () => {
  it('creates a directory inside the worktree', () => {
    const sandbox = sandboxFor(tmpDir);
    const target = join(tmpDir, 'new-dir');
    mkdirInSandbox(sandbox, target);
    expect(existsSync(target)).toBe(true);
  });

  it('creates nested directories when { recursive: true }', () => {
    const sandbox = sandboxFor(tmpDir);
    const target = join(tmpDir, 'a', 'b', 'c');
    mkdirInSandbox(sandbox, target, { recursive: true });
    expect(existsSync(target)).toBe(true);
  });

  it('throws when targetPath is outside the worktree', () => {
    const sandbox = sandboxFor(tmpDir);
    expect(() => mkdirInSandbox(sandbox, '/etc/evil-dir')).toThrow();
  });

  it('does not create the directory when targetPath is outside the worktree', () => {
    // Guard fires before fs.mkdirSync — use a path inside a controlled outside
    // temp dir and verify the subdir was not created.
    const outside = mkdtempSync(join(tmpdir(), 'rune-outside-'));
    const targetSubdir = join(outside, 'should-not-exist');
    const sandbox = sandboxFor(tmpDir);
    try {
      mkdirInSandbox(sandbox, targetSubdir);
    } catch {
      // expected
    }
    expect(existsSync(targetSubdir)).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// rmInSandbox
// ---------------------------------------------------------------------------

describe('rmInSandbox', () => {
  it('removes a file inside the worktree', () => {
    const sandbox = sandboxFor(tmpDir);
    const target = join(tmpDir, 'to-delete.txt');
    writeFileSync(target, 'bye');
    rmInSandbox(sandbox, target);
    expect(existsSync(target)).toBe(false);
  });

  it('removes a directory tree with { recursive: true }', () => {
    const sandbox = sandboxFor(tmpDir);
    const dir = join(tmpDir, 'tree');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'file.txt'), 'data');
    rmInSandbox(sandbox, dir, { recursive: true });
    expect(existsSync(dir)).toBe(false);
  });

  it('throws when targetPath is outside the worktree', () => {
    const sandbox = sandboxFor(tmpDir);
    expect(() => rmInSandbox(sandbox, '/etc/passwd')).toThrow();
  });

  it('does not remove the file when targetPath is outside the worktree', () => {
    // Verify the guard fires BEFORE fs.rmSync — create a file in a controlled
    // location outside the worktree and confirm it survives the denied call.
    const outside = mkdtempSync(join(tmpdir(), 'rune-outside-'));
    const outsideFile = join(outside, 'precious.txt');
    writeFileSync(outsideFile, 'keep me');
    const sandbox = sandboxFor(tmpDir);
    try {
      rmInSandbox(sandbox, outsideFile);
    } catch {
      // expected
    }
    expect(existsSync(outsideFile)).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it('accepts { force: true } without throwing on a non-existent path inside the worktree', () => {
    const sandbox = sandboxFor(tmpDir);
    const nonExistent = join(tmpDir, 'ghost.txt');
    // With force: true, the underlying fs.rmSync does not throw on missing paths.
    expect(() => rmInSandbox(sandbox, nonExistent, { force: true })).not.toThrow();
  });
});
