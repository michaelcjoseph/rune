import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ROLE_ARTIFACTS = [
  ['coder', 'SOUL.md'],
  ['coder', 'memory.md'],
  ['qa', 'SOUL.md'],
  ['qa', 'memory.md'],
  ['tech-lead', 'SOUL.md'],
  ['tech-lead', 'memory.md'],
  ['reviewer', 'SOUL.md'],
  ['reviewer', 'memory.md'],
] as const;

const protectedServices = [
  {
    name: 'Rune web / cockpit',
    address: '127.0.0.1:3847',
    launchdLabel: 'com.jarvis.daemon',
  },
  {
    name: 'Rune MCP daemon',
    address: '127.0.0.1:3848',
    launchdLabel: 'com.jarvis.rune-mcp',
  },
] as const;

function readRoleArtifact(role: string, filename: string): string {
  return readFileSync(join(REPO_ROOT, 'agents', role, filename), 'utf8');
}

function normalize(markdown: string): string {
  return markdown.replace(/\s+/g, ' ');
}

describe('agent-protected-service-invariant (project 19 / test-plan §5A)', () => {
  it.each(ROLE_ARTIFACTS)(
    '%s %s carries the protected-listener invariant',
    (role, filename) => {
      const pathForMessage = `agents/${role}/${filename}`;
      const body = normalize(readRoleArtifact(role, filename));

      for (const service of protectedServices) {
        expect(body, `${pathForMessage} must name ${service.name}`).toContain(service.name);
        expect(body, `${pathForMessage} must name ${service.address}`).toContain(service.address);
        expect(body, `${pathForMessage} must name ${service.launchdLabel}`).toContain(
          service.launchdLabel,
        );
      }

      for (const forbiddenAction of ['kill', 'stop', 'interrupt', 'reuse']) {
        expect(body, `${pathForMessage} must forbid ${forbiddenAction} of protected listeners`).toMatch(
          new RegExp(`\\bnever\\b.*\\b${forbiddenAction}\\w*\\b`, 'i'),
        );
      }

      expect(body, `${pathForMessage} must require explicit human approval`).toMatch(
        /explicit human approval/i,
      );
      expect(body, `${pathForMessage} must route test collisions to dynamic or task-local ports`).toMatch(
        /dynamic.*task-local.*port|task-local.*dynamic.*port/i,
      );
      expect(body, `${pathForMessage} must require process ownership verification before kills`).toMatch(
        /before killing any process.*verify.*(PID|process).*spawned by the current (task|worktree|test command)|verify.*(PID|process).*spawned by the current (task|worktree|test command).*before killing any process/i,
      );
    },
  );
});
