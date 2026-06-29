/**
 * Project 19 / Phase 5A test-plan §5A:
 * protected-service-outage-detection.
 *
 * Test-first suite: after a work run or cleanup attempt, a down protected Rune
 * service must be surfaced as degraded/outage state. It must not be "fixed" by
 * killing an unknown process, reusing the protected listener, or silently
 * restarting the service. The implementation should live beside the canonical
 * protected-service contract so guard decisions, prompts, and status reporting
 * share one source of truth.
 */

import { describe, expect, it } from 'vitest';
import {
  PROTECTED_LOCAL_SERVICES,
  evaluateProcessCleanupKill,
  type ProtectedLocalService,
} from './protected-local-services.js';

type ProtectedServiceEvent =
  | { kind: 'work-run-finished'; runId: string; product: string; project: string; at: string }
  | { kind: 'cleanup-attempted'; cleanupId: string; source: string; at: string };

type ServiceObservation = {
  serviceId: ProtectedLocalService['id'];
  reachable: boolean;
  error?: string;
};

type RecoveryAction = {
  type: string;
  serviceId?: string;
  port?: number;
};

type OutageReport = {
  state: 'ok' | 'degraded' | 'outage';
  event: ProtectedServiceEvent;
  services: Array<{
    id: ProtectedLocalService['id'];
    name: string;
    host: string;
    port: number;
    launchdLabel: string;
    status: 'ok' | 'down';
    severity?: 'degraded' | 'outage';
    error?: string;
  }>;
  recoveryActions: RecoveryAction[];
  message: string;
};

async function loadClassifier(): Promise<{
  classifyProtectedServiceOutages?: (input: {
    event: ProtectedServiceEvent;
    observations: ServiceObservation[];
  }) => OutageReport;
}> {
  return import('./protected-local-services.js') as Promise<{
    classifyProtectedServiceOutages?: (input: {
      event: ProtectedServiceEvent;
      observations: ServiceObservation[];
    }) => OutageReport;
  }>;
}

function unsafeRecoveryActions(report: OutageReport): RecoveryAction[] {
  const unsafe = new Set(['kill-process', 'kill-listener', 'reuse-listener', 'restart-service']);
  return report.recoveryActions.filter((action) => unsafe.has(action.type));
}

describe('protected-service-outage-detection (project 19 / test-plan §5A)', () => {
  it('surfaces a down Rune web service after a work run as degraded without unsafe recovery actions', async () => {
    const { classifyProtectedServiceOutages } = await loadClassifier();
    expect(classifyProtectedServiceOutages, 'missing protected-service outage classifier').toBeTypeOf('function');

    const report = classifyProtectedServiceOutages!({
      event: {
        kind: 'work-run-finished',
        runId: 'run-web-outage-001',
        product: 'rune',
        project: '19-rune-product-os',
        at: '2026-06-29T12:00:00.000Z',
      },
      observations: [
        { serviceId: 'rune-web', reachable: false, error: 'ECONNREFUSED 127.0.0.1:3847' },
        { serviceId: 'rune-mcp', reachable: true },
      ],
    });

    expect(report.state).toBe('degraded');
    expect(report.event.kind).toBe('work-run-finished');
    expect(report.services).toContainEqual(expect.objectContaining({
      id: 'rune-web',
      host: '127.0.0.1',
      port: 3847,
      launchdLabel: 'com.jarvis.daemon',
      status: 'down',
      severity: 'degraded',
      error: expect.stringMatching(/ECONNREFUSED|3847/i),
    }));
    expect(report.services).toContainEqual(expect.objectContaining({
      id: 'rune-mcp',
      port: 3848,
      status: 'ok',
    }));
    expect(report.message).toMatch(/Rune web|3847|degraded|approval|manual/i);
    expect(unsafeRecoveryActions(report)).toEqual([]);
  });

  it('surfaces a down Rune MCP service after a cleanup attempt as degraded instead of reusing port 3848', async () => {
    const { classifyProtectedServiceOutages } = await loadClassifier();
    expect(classifyProtectedServiceOutages, 'missing protected-service outage classifier').toBeTypeOf('function');

    const report = classifyProtectedServiceOutages!({
      event: {
        kind: 'cleanup-attempted',
        cleanupId: 'sweep-mcp-outage-001',
        source: 'worktree-sweep',
        at: '2026-06-29T12:05:00.000Z',
      },
      observations: [
        { serviceId: 'rune-web', reachable: true },
        { serviceId: 'rune-mcp', reachable: false, error: 'health check failed for 127.0.0.1:3848' },
      ],
    });

    expect(report.state).toBe('degraded');
    expect(report.event.kind).toBe('cleanup-attempted');
    expect(report.services).toContainEqual(expect.objectContaining({
      id: 'rune-mcp',
      name: 'Rune MCP daemon',
      host: '127.0.0.1',
      port: 3848,
      launchdLabel: 'com.jarvis.rune-mcp',
      status: 'down',
      severity: 'degraded',
      error: expect.stringMatching(/health check|3848/i),
    }));
    expect(report.message).toMatch(/Rune MCP|3848|degraded|approval|manual/i);
    expect(unsafeRecoveryActions(report)).toEqual([]);
  });

  it('classifies both protected services down as outage, still with no auto-kill or implicit restart plan', async () => {
    const { classifyProtectedServiceOutages } = await loadClassifier();
    expect(classifyProtectedServiceOutages, 'missing protected-service outage classifier').toBeTypeOf('function');

    const report = classifyProtectedServiceOutages!({
      event: {
        kind: 'work-run-finished',
        runId: 'run-full-outage-001',
        product: 'rune',
        project: '19-rune-product-os',
        at: '2026-06-29T12:10:00.000Z',
      },
      observations: [
        { serviceId: 'rune-web', reachable: false, error: 'ECONNREFUSED 127.0.0.1:3847' },
        { serviceId: 'rune-mcp', reachable: false, error: 'ECONNREFUSED 127.0.0.1:3848' },
      ],
    });

    expect(report.state).toBe('outage');
    expect(report.services.filter((service) => service.status === 'down')).toEqual([
      expect.objectContaining({ id: 'rune-web', severity: 'outage' }),
      expect.objectContaining({ id: 'rune-mcp', severity: 'outage' }),
    ]);
    expect(report.message).toMatch(/outage|manual|approval/i);
    expect(unsafeRecoveryActions(report)).toEqual([]);
  });

  it('keeps cleanup kill/refusal behavior and outage reporting as separate contracts', async () => {
    const { classifyProtectedServiceOutages } = await loadClassifier();
    expect(classifyProtectedServiceOutages, 'missing protected-service outage classifier').toBeTypeOf('function');

    const runeWeb = PROTECTED_LOCAL_SERVICES.find((service) => service.id === 'rune-web')!;
    const killDecision = evaluateProcessCleanupKill({
      pid: 384700,
      source: 'worktree-sweep',
      ownedByCurrentTask: false,
      listeningOn: [{ host: runeWeb.host, port: runeWeb.port }],
    });

    expect(killDecision).toEqual(expect.objectContaining({
      allowed: false,
      protectedService: expect.objectContaining({ id: 'rune-web', port: 3847 }),
      reason: expect.stringMatching(/protected|approval/i),
    }));

    const report = classifyProtectedServiceOutages!({
      event: {
        kind: 'cleanup-attempted',
        cleanupId: 'sweep-web-outage-001',
        source: 'worktree-sweep',
        at: '2026-06-29T12:15:00.000Z',
      },
      observations: [
        { serviceId: 'rune-web', reachable: false, error: 'post-cleanup health check failed' },
        { serviceId: 'rune-mcp', reachable: true },
      ],
    });

    expect(report.state).toBe('degraded');
    expect(report.services).toContainEqual(expect.objectContaining({
      id: 'rune-web',
      status: 'down',
      severity: 'degraded',
    }));
    expect(unsafeRecoveryActions(report)).toEqual([]);
  });
});
