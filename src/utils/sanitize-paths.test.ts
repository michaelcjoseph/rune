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

  // Regression: the reserved-word alternation had no segment boundary, so a
  // first segment that merely *started* with a reserved word matched the bare
  // prefix and the optional tail group succeeded empty — splicing `<path>`
  // mid-word and leaking the rest of the path while looking scrubbed.
  it('never splices the placeholder into the middle of a longer path segment', () => {
    for (const input of [
      'the /homelab/private-notes/secret.md file',
      'in /repository/acme-corp/billing-service/src/index.ts',
      'run it from /tmpfiles/build-cache/output',
      'see /etcd/config/cluster.yaml',
      'under /usrlocal/share/data',
    ]) {
      const result = scrubGenericAbsolutePaths(input);
      // Either fully scrubbed or untouched — never a partial splice.
      expect(result).toBe(input);
      expect(result).not.toContain('<path>');
    }
  });

  it('still scrubs a reserved word that is a complete segment', () => {
    expect(scrubGenericAbsolutePaths('check /repos/secret-project/file.ts')).toBe('check <path>');
    expect(scrubGenericAbsolutePaths('under /home/someone/x.ts')).toBe('under <path>');
    expect(scrubGenericAbsolutePaths('cleared /tmp')).toBe('cleared <path>');
    expect(scrubGenericAbsolutePaths('(/var/folders/zz/t.log)')).toBe('(<path>)');
  });
});
