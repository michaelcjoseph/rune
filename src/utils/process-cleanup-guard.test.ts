import { describe, expect, it } from 'vitest';

import {
  evaluateProcessCleanupKill,
  type ProcessCleanupKillCandidate,
} from './protected-local-services.js';

function candidate(overrides: Partial<ProcessCleanupKillCandidate>): ProcessCleanupKillCandidate {
  return {
    pid: 5001,
    source: 'test-cleanup-helper',
    ownedByCurrentTask: false,
    listeningOn: [],
    ...overrides,
  };
}

describe('process-cleanup-protected-port-guard (project 19 / test-plan §5A)', () => {
  it('refuses to kill a PID that owns the Rune web protected port without human approval', () => {
    const decision = evaluateProcessCleanupKill(
      candidate({
        pid: 384700,
        ownedByCurrentTask: true,
        listeningOn: [{ host: '127.0.0.1', port: 3847 }],
      }),
    );

    expect(decision).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/Rune web|3847|protected|approval/i),
      protectedService: { id: 'rune-web', launchdLabel: 'com.jarvis.daemon' },
    });
  });

  it('refuses to kill a PID that owns the Rune MCP protected port without human approval', () => {
    const decision = evaluateProcessCleanupKill(
      candidate({
        pid: 384800,
        ownedByCurrentTask: true,
        listeningOn: [{ host: '127.0.0.1', port: 3848 }],
      }),
    );

    expect(decision).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/Rune MCP|3848|protected|approval/i),
      protectedService: { id: 'rune-mcp', launchdLabel: 'com.jarvis.rune-mcp' },
    });
  });

  it('refuses to kill a process matching a protected launchd label without human approval', () => {
    const decision = evaluateProcessCleanupKill(
      candidate({
        pid: 7102,
        ownedByCurrentTask: true,
        launchdLabel: 'com.jarvis.rune-mcp',
      }),
    );

    expect(decision).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/com\.jarvis\.rune-mcp|protected|approval/i),
      protectedService: { id: 'rune-mcp', port: 3848 },
    });
  });

  it('allows a protected-service kill only when the explicit human approval path is present', () => {
    const decision = evaluateProcessCleanupKill(
      candidate({
        pid: 7103,
        ownedByCurrentTask: true,
        launchdLabel: 'com.jarvis.daemon',
        humanApproval: { approved: true, approvalId: 'protected-service-kill:7103' },
      }),
    );

    expect(decision).toMatchObject({
      allowed: true,
      approvalId: 'protected-service-kill:7103',
      protectedService: { id: 'rune-web', port: 3847 },
    });
  });

  it('still refuses non-protected PIDs that were not spawned by the current task', () => {
    const decision = evaluateProcessCleanupKill(
      candidate({
        pid: 9100,
        listeningOn: [{ host: '127.0.0.1', port: 49152 }],
      }),
    );

    expect(decision).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/spawned by the current task|ownership/i),
    });
  });

  it('allows a non-protected PID only after ownership is verified', () => {
    const decision = evaluateProcessCleanupKill(
      candidate({
        pid: 9101,
        ownedByCurrentTask: true,
        listeningOn: [{ host: '127.0.0.1', port: 49153 }],
      }),
    );

    expect(decision).toMatchObject({ allowed: true });
    expect(decision.protectedService).toBeUndefined();
  });
});
