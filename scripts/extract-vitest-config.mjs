import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import vm from 'node:vm';

const MAX_CONFIG_BYTES = 1024 * 1024;
const CONFIG_NAMES = [
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
];

function evaluateConfig(path) {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size < 1 || stats.size > MAX_CONFIG_BYTES) {
    throw new Error('Vitest config is unavailable or oversized');
  }
  let source = readFileSync(path, 'utf8');
  if (/\bimport\s*(?:\(|['"]|[^;]*\bfrom\b)/.test(source)) {
    source = source.replace(
      /^\s*import\s*\{\s*defineConfig\s*\}\s*from\s*['"]vitest\/config['"]\s*;?\s*$/m,
      "const { defineConfig } = require('vitest/config');",
    );
  }
  source = source.replace(/\bexport\s+default\b/, 'module.exports =');
  const module = { exports: {} };
  const restrictedRequire = (specifier) => {
    if (specifier === 'vitest/config') return Object.freeze({ defineConfig: (config) => config });
    throw new Error(`unsupported Vitest config import: ${specifier}`);
  };
  const restrictedProcess = Object.freeze({
    env: Object.freeze({
      RUNE_VITEST_CACHE_DIR: process.env.RUNE_VITEST_CACHE_DIR,
    }),
  });
  const context = vm.createContext({
    module,
    exports: module.exports,
    process: restrictedProcess,
    require: restrictedRequire,
  }, {
    codeGeneration: { strings: false, wasm: false },
  });
  new vm.Script(`(function(module,exports,require,process){"use strict";\n${source}\n})`, {
    filename: basename(path),
  }).runInContext(context, { timeout: 250 })(
    module,
    module.exports,
    restrictedRequire,
    restrictedProcess,
  );
  return module.exports?.default ?? module.exports;
}

const requestedRoot = process.argv[2];
if (!requestedRoot) throw new Error('missing validation cwd');
const root = realpathSync(requestedRoot);
const configPath = CONFIG_NAMES
  .map((name) => join(root, name))
  .find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
const config = configPath === undefined ? {} : evaluateConfig(configPath);
process.stdout.write(`${JSON.stringify(config)}\n`);
