import { describe, it, expect, vi, afterEach } from 'vitest';
import { dirname } from 'node:path';

import { buildToolchainPath } from './toolchain-path.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildToolchainPath', () => {
  it('keeps the inherited PATH while adding the Node runtime bin directory', () => {
    const result = buildToolchainPath('/custom/tools');

    expect(result.split(':')).toContain('/custom/tools');
    expect(result.split(':')).toContain(dirname(process.execPath));
  });

  it('puts the preferred toolchain dirs before the inherited PATH entries', () => {
    const result = buildToolchainPath('/custom/tools');
    const entries = result.split(':');

    expect(entries.indexOf(dirname(process.execPath))).toBeLessThan(entries.indexOf('/custom/tools'));
  });

  it('deduplicates when a preferred dir is already present in the inherited PATH', () => {
    const nodeBin = dirname(process.execPath);
    const result = buildToolchainPath(`/custom/tools:${nodeBin}`);
    const entries = result.split(':');

    expect(entries.filter((e) => e === nodeBin)).toHaveLength(1);
  });

  it('drops empty segments from the inherited PATH', () => {
    const result = buildToolchainPath('/custom/tools::/another/tool:');

    expect(result.split(':')).not.toContain('');
  });

  it('defaults to process.env.PATH when called with no argument', () => {
    vi.stubEnv('PATH', '/stubbed/only/path');

    const result = buildToolchainPath();

    expect(result.split(':')).toContain('/stubbed/only/path');
  });

  it('includes /bin, a preferred dir that exists on every macOS/Linux box this test runs on', () => {
    const result = buildToolchainPath('');
    expect(result.split(':')).toContain('/bin');
  });
});
