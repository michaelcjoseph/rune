import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { scrubAbsolutePaths, scrubGenericAbsolutePaths } from './sanitize-paths.js';

describe('scrubAbsolutePaths host-home fallback', () => {
  it('scrubs absolute home paths outside the configured Rune roots', () => {
    const input = `${homedir()}/.local/share/node/native-module.node`;
    const result = scrubAbsolutePaths(input);
    expect(result).toBe('<home>/.local/share/node/native-module.node');
    expect(result).not.toContain(homedir());
  });
});

describe('scrubGenericAbsolutePaths', () => {
  it('scrubs model-authored host paths outside configured roots', () => {
    const result = scrubGenericAbsolutePaths(
      'reviewed /Users/another-user/work/project/src/index.ts and C:\\repo\\secret.txt',
    );
    expect(result).toBe('reviewed <path> and <path>');
  });

  it('preserves web URLs while scrubbing filesystem paths', () => {
    const result = scrubGenericAbsolutePaths(
      'See https://example.com/docs/setup and /Users/another-user/private/setup.md',
    );
    expect(result).toBe('See https://example.com/docs/setup and <path>');
  });

  it('scrubs file URIs and paths after punctuation boundaries', () => {
    const result = scrubGenericAbsolutePaths(
      'file:///private/tmp/secret x,/Users/name/private x;/opt/rune/private',
    );
    expect(result).toBe('<path> x,<path> x;<path>');
  });

  it('preserves root-relative product routes', () => {
    const result = scrubGenericAbsolutePaths(
      'Check /api/users, POST /v1/items, and the /health endpoint.',
    );
    expect(result).toBe('Check /api/users, POST /v1/items, and the /health endpoint.');
  });
});
