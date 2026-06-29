import { describe, expect, it } from 'vitest';

import {
  evaluateProcessCleanupKill,
  type ProcessCleanupKillCandidate,
  type ProcessCleanupKillDecision,
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

type ProcessCleanupPortKillCandidate = {
  source: string;
  port: number;
  host?: string;
  ownedByCurrentTask: boolean;
  humanApproval?: { approved: boolean; approvalId: string };
};

type ProcessCleanupGuardModule = {
  evaluateProcessCleanupPortKill?: (
    candidate: ProcessCleanupPortKillCandidate,
  ) => ProcessCleanupKillDecision;
  evaluateProcessCleanupOccupiedPortReport?: (candidate: {
    source: string;
    report: string;
    humanApproval?: { approved: boolean; approvalId: string };
  }) => ProcessCleanupKillDecision;
};

async function loadPortKillGuard(): Promise<
  NonNullable<ProcessCleanupGuardModule['evaluateProcessCleanupPortKill']>
> {
  const mod = (await import('./protected-local-services.js')) as ProcessCleanupGuardModule;
  expect(
    mod.evaluateProcessCleanupPortKill,
    'missing evaluateProcessCleanupPortKill guard for kill-by-port cleanup helpers',
  ).toBeTypeOf('function');
  return mod.evaluateProcessCleanupPortKill!;
}

async function loadOccupiedPortReportGuard(): Promise<
  NonNullable<ProcessCleanupGuardModule['evaluateProcessCleanupOccupiedPortReport']>
> {
  const mod = (await import('./protected-local-services.js')) as ProcessCleanupGuardModule;
  expect(
    mod.evaluateProcessCleanupOccupiedPortReport,
    'missing evaluateProcessCleanupOccupiedPortReport guard for stuck-test occupied-port reports',
  ).toBeTypeOf('function');
  return mod.evaluateProcessCleanupOccupiedPortReport!;
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

  it('refuses port-only cleanup of protected Rune service ports without human approval', async () => {
    const evaluateProcessCleanupPortKill = await loadPortKillGuard();

    const runeWeb = evaluateProcessCleanupPortKill({
      source: 'kill-process-by-port',
      port: 3847,
      ownedByCurrentTask: true,
    });
    const runeMcp = evaluateProcessCleanupPortKill({
      source: 'kill-process-by-port',
      port: 3848,
      ownedByCurrentTask: true,
    });

    expect(runeWeb).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/Rune web|3847|protected|approval/i),
      protectedService: { id: 'rune-web', launchdLabel: 'com.jarvis.daemon' },
    });
    expect(runeMcp).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/Rune MCP|3848|protected|approval/i),
      protectedService: { id: 'rune-mcp', launchdLabel: 'com.jarvis.rune-mcp' },
    });
  });

  it('requires a real approval id before a protected port cleanup can proceed', async () => {
    const evaluateProcessCleanupPortKill = await loadPortKillGuard();

    const missingApprovalId = evaluateProcessCleanupPortKill({
      source: 'kill-process-by-port',
      host: '127.0.0.1',
      port: 3847,
      ownedByCurrentTask: true,
      humanApproval: { approved: true, approvalId: '' },
    });
    const approved = evaluateProcessCleanupPortKill({
      source: 'kill-process-by-port',
      host: '127.0.0.1',
      port: 3847,
      ownedByCurrentTask: true,
      humanApproval: { approved: true, approvalId: 'protected-service-kill:port-3847' },
    });

    expect(missingApprovalId).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/Rune web|3847|protected|approval/i),
      protectedService: { id: 'rune-web', port: 3847 },
    });
    expect(approved).toMatchObject({
      allowed: true,
      approvalId: 'protected-service-kill:port-3847',
      protectedService: { id: 'rune-web', port: 3847 },
    });
  });

  it('still applies current-task ownership checks for non-protected port cleanup', async () => {
    const evaluateProcessCleanupPortKill = await loadPortKillGuard();

    expect(
      evaluateProcessCleanupPortKill({
        source: 'kill-process-by-port',
        port: 49152,
        ownedByCurrentTask: false,
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/spawned by the current task|ownership/i),
    });
    expect(
      evaluateProcessCleanupPortKill({
        source: 'kill-process-by-port',
        port: 49152,
        ownedByCurrentTask: true,
      }),
    ).toMatchObject({ allowed: true });
  });

  it('classifies a stuck test report for occupied 127.0.0.1:3847 as protected Rune web and refuses cleanup without approval', async () => {
    const evaluateProcessCleanupOccupiedPortReport = await loadOccupiedPortReportGuard();

    const decision = evaluateProcessCleanupOccupiedPortReport({
      source: 'vitest-stuck-test-cleanup',
      report: [
        'Error: listen EADDRINUSE: address already in use 127.0.0.1:3847',
        'test helper reported the previous listener as stuck and requested cleanup',
      ].join('\n'),
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/Rune web|127\.0\.0\.1:3847|protected|approval/i),
      protectedService: {
        id: 'rune-web',
        name: 'Rune web / cockpit',
        host: '127.0.0.1',
        port: 3847,
        launchdLabel: 'com.jarvis.daemon',
      },
    });
  });

  it('classifies a stuck test report for occupied 127.0.0.1:3848 as protected Rune MCP and refuses cleanup without approval', async () => {
    const evaluateProcessCleanupOccupiedPortReport = await loadOccupiedPortReportGuard();

    const decision = evaluateProcessCleanupOccupiedPortReport({
      source: 'vitest-stuck-test-cleanup',
      report: [
        'Error: listen EADDRINUSE: address already in use 127.0.0.1:3848',
        'cleanup would normally kill the process that owns the stuck listener',
      ].join('\n'),
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/Rune MCP|127\.0\.0\.1:3848|protected|approval/i),
      protectedService: {
        id: 'rune-mcp',
        name: 'Rune MCP daemon',
        host: '127.0.0.1',
        port: 3848,
        launchdLabel: 'com.jarvis.rune-mcp',
      },
    });
  });
});
