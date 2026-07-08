import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Test-suite-as-deliverable for the backlog write security guards (09-expand-cockpit, Phase 3,
 * written test-first). Exercises the two write-safety primitives in `backlog-write-lock.ts`:
 *
 *   - `assertBacklogWriteAllowed(repoPath, absPath)` — a write target must be EXACTLY one of the
 *     two allowed files (`docs/projects/{bugs,ideas}.md`) under the repo, and its realpath must
 *     not escape the repo (symlink guard). Anything else throws.
 *   - `appendBacklogMutationLog(filePath, entry)` — every successful write is audit-logged as a
 *     JSONL line carrying { product, file, branch, dirty, before, after }.
 *
 * Real tmpdir repos + real symlinks (the only honest way to exercise the realpath escape).
 * Stays RED until the Phase 3 build lands `backlog-write-lock.ts`.
 */

import {
  assertBacklogWriteAllowed,
  assertScopedTopicWriteAllowed,
  appendBacklogMutationLog,
} from './backlog-write-lock.js';

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'backlog-sec-')));
  created.push(repo);
  mkdirSync(join(repo, 'docs', 'projects'), { recursive: true });
  return repo;
}

describe('backlog-security — assertBacklogWriteAllowed', () => {
  it('allows the two canonical backlog files', () => {
    // bugs.md / ideas.md are intentionally ABSENT here (a fresh repo may not have them yet). The
    // guard must therefore realpath the closest EXISTING ancestor (docs/projects/) for the
    // symlink check, not realpath the target file directly — else it would ENOENT on the happy
    // path. (Mirrors `assertWritable` in src/jobs/sandbox-fs.ts.)
    const repo = makeRepo();
    expect(() => assertBacklogWriteAllowed(repo, join(repo, 'docs/projects/bugs.md'))).not.toThrow();
    expect(() => assertBacklogWriteAllowed(repo, join(repo, 'docs/projects/ideas.md'))).not.toThrow();
  });

  it('rejects any other file under docs/projects', () => {
    const repo = makeRepo();
    expect(() => assertBacklogWriteAllowed(repo, join(repo, 'docs/projects/secrets.md'))).toThrow();
    expect(() => assertBacklogWriteAllowed(repo, join(repo, 'docs/projects/index.md'))).toThrow();
  });

  it('rejects a file outside docs/projects', () => {
    const repo = makeRepo();
    expect(() => assertBacklogWriteAllowed(repo, join(repo, 'README.md'))).toThrow();
    expect(() => assertBacklogWriteAllowed(repo, join(repo, '.env'))).toThrow();
  });

  it('rejects a path-traversal target that escapes the repo', () => {
    // `join` normalizes the `../` sequence to `/tmp/etc/passwd` before the guard sees it, so the
    // filename-allowlist (`passwd` ≠ bugs/ideas.md) already rejects it; the containment check is
    // belt-and-suspenders. Either guard firing is acceptable — the point is it throws.
    const repo = makeRepo();
    expect(() => assertBacklogWriteAllowed(repo, join(repo, 'docs/projects/../../../etc/passwd'))).toThrow();
  });

  it('rejects an allowed-named file whose realpath symlinks outside the repo', () => {
    const repo = makeRepo();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'backlog-sec-out-')));
    created.push(outside);
    const secret = join(outside, 'secret.md');
    writeFileSync(secret, 'sensitive');
    // bugs.md is the allowed RELATIVE path, but it's a symlink whose target escapes the repo.
    symlinkSync(secret, join(repo, 'docs/projects/bugs.md'));
    expect(() => assertBacklogWriteAllowed(repo, join(repo, 'docs/projects/bugs.md'))).toThrow();
  });

  it('rejects an allowed-named file inside a symlinked docs dir that escapes the repo', () => {
    const repo = makeRepo();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'backlog-sec-dir-')));
    created.push(outside);
    mkdirSync(join(outside, 'projects'), { recursive: true });
    writeFileSync(join(outside, 'projects', 'bugs.md'), 'x');
    // Replace docs/ with a symlink to an out-of-repo dir.
    rmSync(join(repo, 'docs'), { recursive: true, force: true });
    symlinkSync(outside, join(repo, 'docs'));
    expect(() => assertBacklogWriteAllowed(repo, join(repo, 'docs/projects/bugs.md'))).toThrow();
  });
});

describe('backlog-security — assertScopedTopicWriteAllowed', () => {
  const SCOPE = 'docs/rune';

  it('allows the two topic files under the scope path, even when neither file nor dir exists yet', () => {
    // docs/rune/ intentionally ABSENT — note-triage seeds it on first write, so the guard must
    // realpath the closest EXISTING ancestor (the repo root here), not the target.
    const repo = makeRepo();
    expect(() => assertScopedTopicWriteAllowed(repo, SCOPE, join(repo, 'docs/rune/writing-ideas.md'))).not.toThrow();
    expect(() => assertScopedTopicWriteAllowed(repo, SCOPE, join(repo, 'docs/rune/research-topics.md'))).not.toThrow();
  });

  it('rejects other basenames under the scope path', () => {
    const repo = makeRepo();
    expect(() => assertScopedTopicWriteAllowed(repo, SCOPE, join(repo, 'docs/rune/notes.md'))).toThrow();
    expect(() => assertScopedTopicWriteAllowed(repo, SCOPE, join(repo, 'docs/rune/index.md'))).toThrow();
  });

  it('rejects an allowed basename outside the scope path', () => {
    const repo = makeRepo();
    expect(() => assertScopedTopicWriteAllowed(repo, SCOPE, join(repo, 'writing-ideas.md'))).toThrow();
    expect(() => assertScopedTopicWriteAllowed(repo, SCOPE, join(repo, 'docs/projects/writing-ideas.md'))).toThrow();
  });

  it('rejects a path-traversal target that escapes the repo', () => {
    const repo = makeRepo();
    expect(() => assertScopedTopicWriteAllowed(repo, SCOPE, join(repo, 'docs/rune/../../../etc/writing-ideas.md'))).toThrow();
  });

  it('rejects a non-repo-relative or traversing scope path', () => {
    const repo = makeRepo();
    expect(() => assertScopedTopicWriteAllowed(repo, '', join(repo, 'writing-ideas.md'))).toThrow();
    expect(() => assertScopedTopicWriteAllowed(repo, '/etc', '/etc/writing-ideas.md')).toThrow();
    expect(() => assertScopedTopicWriteAllowed(repo, '../outside', join(repo, '../outside/writing-ideas.md'))).toThrow();
  });

  it('rejects an allowed-named file inside a symlinked scope dir that escapes the repo', () => {
    const repo = makeRepo();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'topic-sec-dir-')));
    created.push(outside);
    writeFileSync(join(outside, 'writing-ideas.md'), 'x');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    symlinkSync(outside, join(repo, 'docs', 'rune'));
    expect(() => assertScopedTopicWriteAllowed(repo, SCOPE, join(repo, 'docs/rune/writing-ideas.md'))).toThrow();
  });
});

describe('backlog-security — appendBacklogMutationLog', () => {
  it('appends a JSONL audit line carrying product/file/branch/dirty/before/after', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'backlog-sec-log-')));
    created.push(dir);
    const logFile = join(dir, 'backlog-mutations.jsonl');
    const entry = {
      product: 'aura',
      file: 'docs/projects/bugs.md',
      branch: 'main',
      dirty: true,
      before: '- [ ] One\n',
      after: '- [ ] One\n- [ ] Two\n',
    };
    appendBacklogMutationLog(logFile, entry);
    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({
      product: 'aura',
      file: 'docs/projects/bugs.md',
      branch: 'main',
      dirty: true,
      before: '- [ ] One\n',
      after: '- [ ] One\n- [ ] Two\n',
    });
  });

  it('is append-only across calls (each write adds one line)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'backlog-sec-log2-')));
    created.push(dir);
    const logFile = join(dir, 'backlog-mutations.jsonl');
    const base = { product: 'aura', file: 'docs/projects/bugs.md', branch: 'main', dirty: false, before: '', after: '- [ ] x\n' };
    appendBacklogMutationLog(logFile, base);
    appendBacklogMutationLog(logFile, { ...base, after: '- [ ] y\n' });
    expect(readFileSync(logFile, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('records the file field verbatim (caller passes a repo-relative path, never absolute)', () => {
    // The audit log's repo-relative invariant is a CALLER contract: the write endpoint derives
    // `file` from the kind (`docs/projects/{bugs,ideas}.md`) and never passes an absolute host
    // path. This pins that the function preserves that relative value exactly (no rewriting that
    // could leak or mangle it).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'backlog-sec-log3-')));
    created.push(dir);
    const logFile = join(dir, 'backlog-mutations.jsonl');
    appendBacklogMutationLog(logFile, {
      product: 'aura', file: 'docs/projects/ideas.md', branch: 'main', dirty: false, before: '', after: '- z\n',
    });
    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.file).toBe('docs/projects/ideas.md');
    expect(parsed.file.startsWith('/')).toBe(false);
  });
});
