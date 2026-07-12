import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupCodexThread } from './codex-sessions.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('cleanupCodexThread', () => {
  it('removes only rollout files belonging to the forgotten thread', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-session-cleanup-'));
    dirs.push(home);
    const month = join(home, 'sessions', '2026', '07', '12');
    mkdirSync(month, { recursive: true });
    const target = join(month, 'rollout-2026-thread-aaaa-1111.jsonl');
    const other = join(month, 'rollout-2026-thread-bbbb-2222.jsonl');
    writeFileSync(target, 'target');
    writeFileSync(other, 'other');
    expect(cleanupCodexThread('thread-aaaa-1111', home)).toBe(1);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('rejects unsafe thread identifiers without scanning or deleting', () => {
    expect(cleanupCodexThread('../sessions', '/tmp/unused')).toBe(0);
  });
});
