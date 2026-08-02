/**
 * Static guard against tests that only pass in the live worktree.
 *
 * Rune's closeout runs this suite twice: the configured command in the real
 * worktree, and the trusted Vitest observer against a `checkout-index`
 * materialization of the reviewed tree. The observer's manifest is the
 * AUTHORITATIVE evidence, and that tree has no `.git`, a different
 * `PROJECT_ROOT`, no gitignored files, and is read-only under Seatbelt.
 *
 * A test that assumes otherwise is green locally and red in the manifest, which
 * blocks every full-suite receipt while `npm test` looks fine — a divergence
 * that cost a full investigation to find, because the observer's reporter
 * records counts only and can never name the offender.
 *
 * These rules are cheap and static. They cannot see indirection through a
 * helper; `npm run diagnose:reviewed-tree` remains the real check, and
 * `npm run verify:closeout-confinement` the acceptance gate.
 *
 * To exempt a line, put `reviewed-tree-exempt: <reason>` in a comment on it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from './config.js';
import { repoRelativeFiles } from './test/repo-files.js';

interface Offender {
  file: string;
  line: number;
  text: string;
}

const EXEMPT = /reviewed-tree-exempt:/;

function testFiles(): string[] {
  return repoRelativeFiles(['src', 'scripts', 'cli'])
    .filter((file) => file.endsWith('.test.ts'))
    // This file's own rule sources would match every pattern it defines.
    .filter((file) => file !== 'src/reviewed-tree-hygiene.test.ts');
}

function scan(match: (line: string) => boolean): Offender[] {
  const offenders: Offender[] = [];
  for (const file of testFiles()) {
    const lines = readFileSync(join(PROJECT_ROOT, file), 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (EXEMPT.test(text)) return;
      if (match(text)) offenders.push({ file, line: index + 1, text: text.trim() });
    });
  }
  return offenders;
}

describe('materialized reviewed-tree hygiene', () => {
  it('runs git only against a repository the test created itself', () => {
    // The materialized tree has no `.git` and no repository ancestor, so a git
    // call in the ambient cwd throws there and passes here. A call that names
    // its own repo (`-C <dir>` or `cwd:`) is fine. The argument list is often
    // wrapped across lines, so look at the whole call, not just its first line.
    const CALL_WINDOW_LINES = 8;
    const offenders: Offender[] = [];
    for (const file of testFiles()) {
      const lines = readFileSync(join(PROJECT_ROOT, file), 'utf8').split('\n');
      lines.forEach((text, index) => {
        if (EXEMPT.test(text)) return;
        if (!/\b(?:execFileSync|execSync|spawnSync|spawn|execFile)\s*\(\s*['"`]git['"`]/
          .test(text)) return;
        const call = lines.slice(index, index + CALL_WINDOW_LINES).join('\n');
        if (call.includes('cwd') || / -C |'-C'|"-C"/.test(call)) return;
        // `git init` is the one subcommand that does not need an existing
        // repository, so it cannot fail from the missing-`.git` cause this rule
        // guards — and these calls name their target directory as an argument.
        if (/['"`]init['"`]/.test(call)) return;
        offenders.push({ file, line: index + 1, text: text.trim() });
      });
    }

    expect(offenders).toEqual([]);
  });

  it('never hardcodes this checkout path in a test fixture', () => {
    // `scrubAbsolutePaths` replaces the live `PROJECT_ROOT` with `<project>`.
    // In the materialized tree that root is a temp directory, so a fixture that
    // spells out this checkout's path stops being recognized and falls through
    // to the `<home>` rule — flipping any assertion built on it. Derive such
    // fixtures from `PROJECT_ROOT` instead.
    //
    // Matching the real root exactly, rather than any `/Users/<name>/` path,
    // keeps this precise: a deliberately foreign path in a fixture is stable in
    // both trees and is not what this rule is about. The tradeoff is that it
    // only catches a path hardcoded on the machine that runs it — enough,
    // because that is the machine where it gets written.
    const offenders = scan((line) => line.includes(PROJECT_ROOT));

    expect(offenders).toEqual([]);
  });
});
