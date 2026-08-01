import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { startVitest } from 'vitest/node';

const MAX_EXTRACTED_CONFIG_BYTES = 64 * 1024;
const SAFE_TEST_KEYS = new Set([
  'include',
  'exclude',
  'setupFiles',
  'testTimeout',
  'hookTimeout',
  'teardownTimeout',
  'maxWorkers',
  'minWorkers',
  'fileParallelism',
  'isolate',
  'environment',
  'passWithNoTests',
  'tags',
  'strictTags',
]);
const IGNORED_TEST_KEYS = new Set(['reporters', 'coverage']);
const trustedInput = __RUNE_TRUSTED_INPUT__;

function fail(message) {
  process.stderr.write(`trusted Vitest observer: ${message}\n`);
  process.exitCode = 1;
}

function safeRelativePath(root, value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || isAbsolute(value)) {
    throw new Error(`${label} must be a bounded relative path`);
  }
  const target = resolve(root, value);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('/') || rel.includes('\\')) {
    throw new Error(`${label} escaped the validation cwd`);
  }
  const real = realpathSync(target);
  const realRel = relative(root, real);
  if (
    realRel === '..' ||
    realRel.startsWith(`..${sep}`) ||
    realRel.startsWith('/') ||
    realRel.includes('\\') ||
    !statSync(real).isFile()
  ) {
    throw new Error(`${label} escaped the validation cwd`);
  }
  return value;
}

function stringList(value, label, root, paths = false) {
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || values.length > 256) {
    throw new Error(`${label} must be a bounded string list`);
  }
  return values.map((entry) => {
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > 1024) {
      throw new Error(`${label} contains an invalid entry`);
    }
    if (
      paths &&
      (
        isAbsolute(entry) ||
        entry.includes('\\') ||
        entry.split('/').includes('..') ||
        /^[A-Za-z]:/.test(entry)
      )
    ) {
      throw new Error(`${label} contains an escaping pattern`);
    }
    return entry;
  });
}

function sanitizeTestConfig(root, value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('test config must be a plain object');
  }
  const source = value;
  const safe = {};
  for (const key of Object.keys(source)) {
    if (IGNORED_TEST_KEYS.has(key)) continue;
    if (!SAFE_TEST_KEYS.has(key)) {
      throw new Error(`unsupported Vitest config key: test.${key}`);
    }
    const candidate = source[key];
    if (key === 'include' || key === 'exclude') {
      safe[key] = stringList(candidate, `test.${key}`, root, true);
    } else if (key === 'setupFiles') {
      safe[key] = stringList(candidate, 'test.setupFiles', root)
        .map((entry) => safeRelativePath(root, entry, 'test.setupFiles'));
    } else if (key.endsWith('Timeout')) {
      if (!Number.isInteger(candidate) || candidate < 1 || candidate > 3_600_000) {
        throw new Error(`test.${key} must be a bounded integer`);
      }
      safe[key] = candidate;
    } else if (key === 'maxWorkers' || key === 'minWorkers') {
      if (
        !(
          Number.isInteger(candidate) &&
          candidate >= 1 &&
          candidate <= 64
        ) &&
        !(
          typeof candidate === 'string' &&
          /^(?:\d+(?:\.\d+)?)%$/.test(candidate) &&
          Number.parseFloat(candidate) > 0 &&
          Number.parseFloat(candidate) <= 100
        )
      ) {
        throw new Error(`test.${key} is invalid`);
      }
      safe[key] = candidate;
    } else if (key === 'tags') {
      if (!Array.isArray(candidate) || candidate.length !== 2) {
        throw new Error('test.tags must declare the two validation capability tags');
      }
      const names = candidate.map((tag) => tag?.name).sort();
      if (JSON.stringify(names) !== JSON.stringify([
        'validation-loopback',
        'validation-sandbox-integration',
      ])) {
        throw new Error('test.tags contains an unsupported capability tag');
      }
      safe[key] = candidate.map((tag) => ({ name: tag.name }));
    } else if (key === 'environment') {
      if (!['node', 'jsdom', 'happy-dom', 'edge-runtime'].includes(candidate)) {
        throw new Error(`test.${key} is invalid`);
      }
      safe[key] = candidate;
    } else if (typeof candidate === 'boolean') {
      safe[key] = candidate;
    } else {
      throw new Error(`test.${key} is invalid`);
    }
  }
  return safe;
}

function extractSafeConfig(root) {
  const raw = execFileSync(process.execPath, ['--input-type=module', '-', root], {
    cwd: root,
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: MAX_EXTRACTED_CONFIG_BYTES,
    input: trustedInput.extractorSource,
    env: {
      PATH: process.env.PATH,
      RUNE_VITEST_CACHE_DIR: process.env.RUNE_VITEST_CACHE_DIR,
    },
  });
  if (raw.length < 2 || raw.length > MAX_EXTRACTED_CONFIG_BYTES) {
    throw new Error('extracted Vitest config is missing or oversized');
  }
  const config = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Vitest config did not export a plain object');
  }
  const unknown = Object.keys(config).filter((key) => key !== 'test' && key !== 'cacheDir');
  if (unknown.length > 0) {
    throw new Error(`unsupported top-level Vitest config key: ${unknown[0]}`);
  }
  return sanitizeTestConfig(root, config.test);
}

async function main() {
  if (
    !trustedInput ||
    typeof trustedInput.output !== 'string' ||
    !/^[0-9a-f]{64}$/.test(trustedInput.capability) ||
    typeof trustedInput.reporterSource !== 'string' ||
    typeof trustedInput.extractorSource !== 'string'
  ) {
    throw new Error('missing reporter-only attestation material');
  }
  const requestedRoot = process.argv[2];
  if (!requestedRoot) throw new Error('missing validation cwd');
  const root = realpathSync(requestedRoot);
  const safeConfig = extractSafeConfig(root);
  if (
    trustedInput.selector !== undefined &&
    (
      typeof trustedInput.selector !== 'string' ||
      trustedInput.selector.length > 128 ||
      !/^[a-z!&| -]+$/.test(trustedInput.selector)
    )
  ) throw new Error('invalid validation profile selector');
  const reporterUrl =
    `data:text/javascript;base64,${Buffer.from(trustedInput.reporterSource).toString('base64')}`;
  const { default: RuneVitestAttestationReporter } = await import(reporterUrl);
  const reporter = new RuneVitestAttestationReporter({
    output: trustedInput.output,
    capability: trustedInput.capability,
    root,
  });
  const vitest = await startVitest('test', [], {
    ...safeConfig,
    root,
    cacheDir: process.env.RUNE_VITEST_CACHE_DIR,
    config: false,
    pool: 'forks',
    run: true,
    watch: false,
    reporters: [reporter],
    ...(trustedInput.selector === undefined
      ? {}
      : { tagsFilter: [trustedInput.selector] }),
  });
  if (!vitest) throw new Error('Vitest observer failed to initialize');
  await vitest.close();
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : 'observer failed');
});
