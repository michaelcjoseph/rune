import { existsSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const JS_TO_TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

function isInsideProject(path) {
  const rel = relative(PROJECT_ROOT, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function candidateForJsSpecifier(specifier, parentURL) {
  if (!specifier.endsWith('.js')) return null;
  if (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('file:')
  ) {
    return null;
  }

  const basePath =
    specifier.startsWith('file:')
      ? fileURLToPath(specifier)
      : isAbsolute(specifier)
        ? specifier
        : join(dirname(fileURLToPath(parentURL ?? pathToFileURL(join(PROJECT_ROOT, 'index.js')))), specifier);

  if (!isInsideProject(basePath) || existsSync(basePath)) return null;

  const withoutJs = basePath.slice(0, -'.js'.length);
  for (const ext of JS_TO_TS_EXTENSIONS) {
    const candidate = `${withoutJs}${ext}`;
    if (isInsideProject(candidate) && isFile(candidate)) {
      return pathToFileURL(candidate).href;
    }
  }
  return null;
}

function loaderFor(path) {
  return extname(path) === '.tsx' ? 'tsx' : 'ts';
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const candidate = candidateForJsSpecifier(specifier, context.parentURL);
    if (candidate) {
      return { url: candidate, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },

  load(url, context, nextLoad) {
    if (!url.startsWith('file:')) return nextLoad(url, context);

    const path = fileURLToPath(url);
    const ext = extname(path);
    if (!TS_EXTENSIONS.has(ext) || !isInsideProject(path)) {
      return nextLoad(url, context);
    }

    const result = transformSync(readFileSync(path, 'utf8'), {
      format: ext === '.cts' ? 'cjs' : 'esm',
      loader: loaderFor(path),
      sourcefile: path,
      sourcemap: 'inline',
      target: 'node22',
    });

    return {
      format: ext === '.cts' ? 'commonjs' : 'module',
      shortCircuit: true,
      source: result.code,
    };
  },
});
