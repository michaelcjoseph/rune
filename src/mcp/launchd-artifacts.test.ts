/**
 * Test-first suite for project 19 / W1 Phase 1 task
 * "launchd-plist-and-install".
 *
 * Contract under test:
 * - The repo delivers a second launchd job plist for the standalone MCP daemon.
 * - The plist runs `npm run mcp:start` from the repo, with daemon-specific label,
 *   env/log expectations, and no coupling to the cockpit daemon.
 * - The install script is lint-checkable and contains the launchctl
 *   bootstrap/kickstart/bootout lifecycle, but tests do not bootstrap a live job.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const plistUrl = new URL('../../launchd/com.jarvis.rune-mcp.plist', import.meta.url);
const installScriptUrl = new URL('../../scripts/install-rune-mcp-launchd.sh', import.meta.url);

function readRequired(url: URL, label: string): string {
  expect(existsSync(url), `${label} must exist`).toBe(true);
  return readFileSync(url, 'utf8');
}

function plistString(source: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`<key>${escapedKey}</key>\\s*<string>([^<]+)</string>`))?.[1];
}

function plistBoolean(source: string, key: string): boolean | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`<key>${escapedKey}</key>\\s*<(true|false)\\s*/>`));
  if (!match) return undefined;
  return match[1] === 'true';
}

function plistArray(source: string, key: string): string[] {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`<key>${escapedKey}</key>\\s*<array>([\\s\\S]*?)</array>`))?.[1] ?? '';
  return [...body.matchAll(/<string>([^<]+)<\/string>/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

function plistDict(source: string, key: string): Record<string, string> {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.match(new RegExp(`<key>${escapedKey}</key>\\s*<dict>([\\s\\S]*?)</dict>`))?.[1] ?? '';
  const pairs = [...body.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)];
  return Object.fromEntries(pairs.map((match) => [match[1], match[2]]));
}

describe('launchd-plist-and-install (project 19 / W1 Phase 1)', () => {
  it('delivers a separate MCP launchd plist with the daemon label', () => {
    const source = readRequired(plistUrl, 'launchd/com.jarvis.rune-mcp.plist');

    expect(source).toContain('<plist version="1.0">');
    expect(plistString(source, 'Label')).toBe('com.jarvis.rune-mcp');
    expect(plistString(source, 'Label')).not.toBe('com.jarvis.daemon');
    expect(plistBoolean(source, 'RunAtLoad')).toBe(true);
    expect(plistBoolean(source, 'KeepAlive')).toBe(true);
  });

  it('runs npm run mcp:start from an explicit working directory', () => {
    const source = readRequired(plistUrl, 'launchd/com.jarvis.rune-mcp.plist');

    const workingDirectory = plistString(source, 'WorkingDirectory');
    expect(workingDirectory, 'WorkingDirectory must be declared').toEqual(expect.any(String));
    expect(workingDirectory).toMatch(/^\//);
    expect(workingDirectory).not.toMatch(/^~/);
    expect(workingDirectory).not.toContain('${');
    expect(workingDirectory).not.toContain('/.worktrees/');

    const args = plistArray(source, 'ProgramArguments');
    const command = args.join(' ');
    expect(args.length, 'ProgramArguments must not be empty').toBeGreaterThan(0);
    expect(command).toMatch(/\bnpm\s+run\s+mcp:start\b/);
    expect(command).not.toMatch(/\bnpm\s+run\s+start\b/);
    expect(command).not.toContain('src/index.ts');
  });

  it('declares launchd-safe environment and MCP log paths without web secrets', () => {
    const source = readRequired(plistUrl, 'launchd/com.jarvis.rune-mcp.plist');

    const env = plistDict(source, 'EnvironmentVariables');
    expect(env.PATH, 'launchd needs an explicit PATH that can find node/npm').toEqual(expect.any(String));
    expect(env.PATH).toMatch(/npm|node|local|opt|homebrew/);

    expect(source).not.toContain('RUNE_HTTP_SECRET');
    expect(source).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(source).not.toContain('TELEGRAM_USER_ID');

    const stdout = plistString(source, 'StandardOutPath');
    const stderr = plistString(source, 'StandardErrorPath');
    expect(stdout).toMatch(/^\/.*rune-mcp.*out.*\.log$/);
    expect(stderr).toMatch(/^\/.*rune-mcp.*err.*\.log$/);
    expect(stdout).not.toBe(stderr);
  });

  it('delivers a syntax-valid install script with bootstrap, kickstart, bootout, and lint checks', () => {
    const source = readRequired(installScriptUrl, 'scripts/install-rune-mcp-launchd.sh');
    const scriptPath = fileURLToPath(installScriptUrl);

    expect(() => execFileSync('bash', ['-n', scriptPath])).not.toThrow();
    expect(source).toContain('set -euo pipefail');
    expect(source).toContain('com.jarvis.rune-mcp');
    expect(source).toContain('launchd/com.jarvis.rune-mcp.plist');
    expect(source).toMatch(/plutil\s+-lint/);
    expect(source).toMatch(/launchctl\s+bootstrap\s+gui\//);
    expect(source).toMatch(/launchctl\s+kickstart\s+-k\s+gui\/.*com\.jarvis\.rune-mcp/);
    expect(source).toMatch(/launchctl\s+bootout\s+gui\/.*com\.jarvis\.rune-mcp/);
  });

  it('makes MCP daemon env prerequisites explicit without requiring a live bootstrap', () => {
    const source = readRequired(installScriptUrl, 'scripts/install-rune-mcp-launchd.sh');

    expect(source).toContain('.env.local');
    expect(source).toContain('RUNE_MCP_SECRET');
    expect(source).toContain('RUNE_MCP_ISSUER_URL');
    expect(source).toContain('RUNE_MCP_OAUTH_STORE_FILE');
    expect(source).toContain('RUNE_MCP_HOST');
    expect(source).toContain('RUNE_MCP_PORT');
    expect(source).not.toMatch(/launchctl\s+bootstrap[\s\S]*--test-only/);
  });
});
