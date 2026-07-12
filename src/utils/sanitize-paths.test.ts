import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { scrubAbsolutePaths } from './sanitize-paths.js';

describe('scrubAbsolutePaths host-home fallback', () => {
  it('scrubs absolute home paths outside the configured Rune roots', () => {
    const input = `${homedir()}/.local/share/node/native-module.node`;
    const result = scrubAbsolutePaths(input);
    expect(result).toBe('<home>/.local/share/node/native-module.node');
    expect(result).not.toContain(homedir());
  });
});
