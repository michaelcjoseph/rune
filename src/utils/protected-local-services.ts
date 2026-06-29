export interface ProtectedLocalService {
  id: string;
  name: string;
  host: string;
  port: number;
  launchdLabel: string;
}

export interface ProcessCleanupAddress {
  host: string;
  port: number;
}

export interface ProcessCleanupHumanApproval {
  approved: boolean;
  approvalId: string;
}

export interface ProcessCleanupKillCandidate {
  pid: number;
  source: string;
  ownedByCurrentTask: boolean;
  listeningOn?: ProcessCleanupAddress[];
  launchdLabel?: string;
  humanApproval?: ProcessCleanupHumanApproval;
}

export type ProcessCleanupKillDecision =
  | {
      allowed: true;
      approvalId?: string;
      protectedService?: ProtectedLocalService;
    }
  | {
      allowed: false;
      reason: string;
      protectedService?: ProtectedLocalService;
    };

export const PROTECTED_LOCAL_SERVICES: readonly ProtectedLocalService[] = [
  {
    id: 'rune-web',
    name: 'Rune web / cockpit',
    host: '127.0.0.1',
    port: 3847,
    launchdLabel: 'com.jarvis.daemon',
  },
  {
    id: 'rune-mcp',
    name: 'Rune MCP daemon',
    host: '127.0.0.1',
    port: 3848,
    launchdLabel: 'com.jarvis.rune-mcp',
  },
] as const;

export function isProtectedLocalServiceAddress(host: string, port: number): boolean {
  return getProtectedLocalServiceByAddress(host, port) !== null;
}

export function getProtectedLocalServiceByAddress(
  host: string,
  port: number,
): ProtectedLocalService | null {
  return PROTECTED_LOCAL_SERVICES.find((service) => service.host === host && service.port === port) ??
    null;
}

export function isProtectedLocalServiceLaunchdLabel(label: string): boolean {
  return getProtectedLocalServiceByLaunchdLabel(label) !== null;
}

export function getProtectedLocalServiceByLaunchdLabel(
  label: string,
): ProtectedLocalService | null {
  return PROTECTED_LOCAL_SERVICES.find((service) => service.launchdLabel === label) ?? null;
}

export function formatProtectedLocalServicesWarning(): string {
  return [
    '## Protected Localhost Services',
    '',
    'These long-lived Rune services are not disposable test listeners:',
    '',
    ...PROTECTED_LOCAL_SERVICES.map(
      (service) =>
        `- ${service.name}: ${service.host}:${service.port} (` +
        `launchd label ${service.launchdLabel})`,
    ),
    '',
    'Never kill, never stop, never interrupt, and never reuse either protected listener without explicit human approval.',
    'If a test collides with one of these ports, use a dynamic port (`0`) or a task-local injected port.',
    'Before killing any process, verify the PID was spawned by the current task/worktree/test command.',
  ].join('\n');
}

export function evaluateProcessCleanupKill(
  candidate: ProcessCleanupKillCandidate,
): ProcessCleanupKillDecision {
  const protectedService = getProcessCleanupProtectedService(candidate);
  const approval = candidate.humanApproval;
  const hasHumanApproval = approval?.approved === true && approval.approvalId.length > 0;

  if (protectedService && !hasHumanApproval) {
    return {
      allowed: false,
      protectedService,
      reason:
        `${protectedService.name} (${protectedService.host}:${protectedService.port}, ` +
        `${protectedService.launchdLabel}) is a protected Rune service; ` +
        `refusing to kill pid ${candidate.pid} without explicit human approval.`,
    };
  }

  if (protectedService && hasHumanApproval) {
    return {
      allowed: true,
      approvalId: approval.approvalId,
      protectedService,
    };
  }

  if (!candidate.ownedByCurrentTask) {
    return {
      allowed: false,
      protectedService,
      reason:
        `Refusing to kill pid ${candidate.pid} from ${candidate.source}: ` +
        'the process was not verified as spawned by the current task/worktree/test command.',
    };
  }

  return { allowed: true };
}

function getProcessCleanupProtectedService(
  candidate: ProcessCleanupKillCandidate,
): ProtectedLocalService | undefined {
  for (const address of candidate.listeningOn ?? []) {
    const service = getProtectedLocalServiceByAddress(address.host, address.port);
    if (service) return service;
  }

  if (candidate.launchdLabel) {
    const service = getProtectedLocalServiceByLaunchdLabel(candidate.launchdLabel);
    if (service) return service;
  }

  return undefined;
}
