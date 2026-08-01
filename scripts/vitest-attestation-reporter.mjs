import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { dirname, relative, sep } from 'node:path';

/**
 * The reserved capability tags, mirroring `VALIDATION_LOOPBACK_TAG` and
 * `VALIDATION_SANDBOX_INTEGRATION_TAG` in `src/intent/validation-profiles.ts`.
 * This reporter is loaded into product-controlled Vitest and cannot import
 * Rune's TypeScript, so the names are duplicated here;
 * `scripts/vitest-attestation-reporter.test.ts` fails on any drift.
 */
export const RESERVED_CAPABILITY_TAGS = [
  'validation-loopback',
  'validation-sandbox-integration',
];

/**
 * A test carrying BOTH reserved tags matches none of the three mutually
 * exclusive profile selectors, so Vitest skips it in every shard while the
 * counts still reconcile — silent zero coverage under a green attestation.
 * Counting each such test as a collection error makes
 * `vitestLifecycleReconciles` false, so the shard fails closed instead.
 */
function conflictingCapabilityTags(module) {
  let conflicts = 0;
  for (const test of module.children.allTests()) {
    const tags = test.tags ?? test.options?.tags ?? [];
    if (RESERVED_CAPABILITY_TAGS.every((tag) => tags.includes(tag))) conflicts += 1;
  }
  return conflicts;
}

/**
 * Rune's private Vitest reporter. It records counts only: no test names, file
 * paths, output, errors, environment, or other unbounded runner data.
 */
export default class RuneVitestAttestationReporter {
  #collected = new Map();
  #output;
  #capability;
  #root;

  constructor(options = {}) {
    this.#output = options.output;
    this.#capability = options.capability;
    this.#root = options.root === undefined ? undefined : realpathSync(options.root);
  }

  onTestModuleCollected(module) {
    if (this.#root !== undefined) {
      const realModule = realpathSync(module.moduleId);
      const rel = relative(this.#root, realModule);
      if (
        rel === '..' ||
        rel.startsWith(`..${sep}`) ||
        rel.startsWith('/') ||
        rel.includes('\\')
      ) {
        throw new Error('collected Vitest module escaped the validation cwd');
      }
    }
    const nestedSuites = typeof module.children.allSuites === 'function'
      ? [...module.children.allSuites()].length
      : 0;
    this.#collected.set(module.moduleId, {
      suites: 1 + nestedSuites,
      tests: [...module.children.allTests()].length,
      conflictingTags: conflictingCapabilityTags(module),
    });
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    if (!this.#output || !this.#capability) return;

    const totals = {
      suites: 0,
      tests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      todo: 0,
      cancelled: 0,
    };
    const conflictingTags = [...this.#collected.values()]
      .reduce((sum, entry) => sum + (entry.conflictingTags ?? 0), 0);
    if (conflictingTags > 0) {
      process.stderr.write(
        `${conflictingTags} test(s) carry conflicting validation capability tags ` +
        `(${RESERVED_CAPABILITY_TAGS.join(' + ')}); they run in no profile\n`,
      );
    }
    let collectionErrors =
      (Array.isArray(unhandledErrors) ? unhandledErrors.length : 0) + conflictingTags;
    for (const module of modules) {
      collectionErrors += module.errors().length;
      const state = module.state();
      if (state !== 'pending' && state !== 'queued') totals.suites += 1;
      if (typeof module.children.allSuites === 'function') {
        for (const suite of module.children.allSuites()) {
          if (suite.state() !== 'pending') totals.suites += 1;
        }
      }
      for (const test of module.children.allTests()) {
        const result = test.result();
        if (result.state === 'pending') {
          totals.cancelled += 1;
        } else if (result.state === 'passed') {
          totals.passed += 1;
        } else if (result.state === 'failed') {
          totals.failed += 1;
        } else if (test.options.mode === 'todo') {
          totals.todo += 1;
        } else {
          totals.skipped += 1;
        }
        totals.tests += 1;
      }
    }

    const manifest = {
      version: 1,
      runner: 'vitest',
      completedNormally: reason !== 'interrupted',
      collectionErrors,
      discovered: {
        suites: [...this.#collected.values()].reduce((sum, entry) => sum + entry.suites, 0),
        tests: [...this.#collected.values()].reduce((sum, entry) => sum + entry.tests, 0),
      },
      completed: totals,
    };
    const authentication = createHmac('sha256', this.#capability)
      .update(JSON.stringify(manifest))
      .digest('hex');
    const envelope = { manifest, authentication };
    const temporary = `${this.#output}.tmp-${process.pid}`;
    mkdirSync(dirname(this.#output), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, this.#output);
  }
}
