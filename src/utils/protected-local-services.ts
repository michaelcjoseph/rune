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

export interface ProcessCleanupPortKillCandidate {
  source: string;
  port: number;
  host?: string;
  ownedByCurrentTask: boolean;
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

export type ProtectedServiceEvent =
  | { kind: 'work-run-finished'; runId: string; product: string; project: string; at: string }
  | { kind: 'cleanup-attempted'; cleanupId: string; source: string; at: string }
  | { kind: 'monitoring-check'; product: string; surface: 'cockpit-monitoring'; at: string };

export interface ProtectedServiceObservation {
  serviceId: ProtectedLocalService['id'];
  reachable: boolean;
  error?: string;
}

export interface ProtectedServiceStatus {
  id: ProtectedLocalService['id'];
  name: string;
  host: string;
  port: number;
  launchdLabel: string;
  status: 'ok' | 'down';
  severity?: 'degraded' | 'outage';
  error?: string;
}

export interface ProtectedServiceOutageReport {
  state: 'ok' | 'degraded' | 'outage';
  event: ProtectedServiceEvent;
  services: ProtectedServiceStatus[];
  recoveryActions: Array<{ type: string; serviceId?: string; port?: number }>;
  telemetry?: ProtectedServiceOutageTelemetry;
  message: string;
}

export interface ProtectedServiceOutageTelemetry {
  kind: 'protected-service-outage';
  severity: 'degraded' | 'outage';
  trigger: ProtectedServiceEvent['kind'];
  affectedServices: Array<{
    id: ProtectedLocalService['id'];
    launchdLabel: string;
    host: string;
    port: number;
    error?: string;
  }>;
  safeRecovery: {
    autoKill: false;
    autoRestart: false;
    reuseListener: false;
    requiresHumanApproval: true;
  };
}

export const PROTECTED_LOCAL_SERVICES = [
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
] as const satisfies readonly ProtectedLocalService[];

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

export function formatProtectedLocalServiceAddress(service: ProtectedLocalService): string {
  return `${service.host}:${service.port}`;
}

export function formatProtectedLocalServiceSummary(service: ProtectedLocalService): string {
  return `${service.name} at ${formatProtectedLocalServiceAddress(service)} (launchd label ${service.launchdLabel})`;
}

export function formatProtectedLocalServicesWarning(): string {
  return [
    '## Protected Localhost Services',
    '',
    'These long-lived Rune services are not disposable test listeners:',
    '',
    ...PROTECTED_LOCAL_SERVICES.map((service) => `- ${formatProtectedLocalServiceSummary(service)}`),
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
  const hasHumanApproval = hasExplicitHumanApproval(approval);

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

export function evaluateProcessCleanupPortKill(
  candidate: ProcessCleanupPortKillCandidate,
): ProcessCleanupKillDecision {
  const protectedService = getProcessCleanupPortProtectedService(candidate);
  const approval = candidate.humanApproval;
  const hasHumanApproval = hasExplicitHumanApproval(approval);

  if (protectedService && !hasHumanApproval) {
    return {
      allowed: false,
      protectedService,
      reason:
        `${protectedService.name} (${protectedService.host}:${protectedService.port}, ` +
        `${protectedService.launchdLabel}) is a protected Rune service; ` +
        `refusing to kill processes on port ${candidate.port} from ${candidate.source} ` +
        'without explicit human approval.',
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
      reason:
        `Refusing to kill processes on port ${candidate.port} from ${candidate.source}: ` +
        'the process was not verified as spawned by the current task/worktree/test command.',
    };
  }

  return { allowed: true };
}

export function classifyProtectedServiceOutages(input: {
  event: ProtectedServiceEvent;
  observations: ProtectedServiceObservation[];
}): ProtectedServiceOutageReport {
  const observationsByService = new Map(input.observations.map((observation) => [
    observation.serviceId,
    observation,
  ]));
  const downCount = PROTECTED_LOCAL_SERVICES.reduce((count, service) => {
    const observation = observationsByService.get(service.id);
    return count + (observation?.reachable === false ? 1 : 0);
  }, 0);
  const state = downCount === 0
    ? 'ok'
    : downCount === PROTECTED_LOCAL_SERVICES.length
      ? 'outage'
      : 'degraded';

  const services: ProtectedServiceStatus[] = PROTECTED_LOCAL_SERVICES.map((service) => {
    const observation = observationsByService.get(service.id);
    const down = observation?.reachable === false;
    const status: ProtectedServiceStatus = {
      ...service,
      status: down ? 'down' : 'ok',
    };
    if (down) {
      status.severity = state === 'outage' ? 'outage' : 'degraded';
      if (observation.error) status.error = observation.error;
    }
    return status;
  });

  const report: ProtectedServiceOutageReport = {
    state,
    event: input.event,
    services,
    recoveryActions: [],
    message: formatProtectedServiceOutageMessage(state, services),
  };

  if (state !== 'ok') {
    report.telemetry = buildProtectedServiceOutageTelemetry(input.event, state, services);
  }

  return report;
}

function buildProtectedServiceOutageTelemetry(
  event: ProtectedServiceEvent,
  severity: ProtectedServiceOutageTelemetry['severity'],
  services: ProtectedServiceStatus[],
): ProtectedServiceOutageTelemetry {
  return {
    kind: 'protected-service-outage',
    severity,
    trigger: event.kind,
    affectedServices: services
      .filter((service) => service.status === 'down')
      .map((service) => {
        const affectedService: ProtectedServiceOutageTelemetry['affectedServices'][number] = {
          id: service.id,
          launchdLabel: service.launchdLabel,
          host: service.host,
          port: service.port,
        };
        if (service.error) affectedService.error = service.error;
        return affectedService;
      }),
    safeRecovery: {
      autoKill: false,
      autoRestart: false,
      reuseListener: false,
      requiresHumanApproval: true,
    },
  };
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

function getProcessCleanupPortProtectedService(
  candidate: ProcessCleanupPortKillCandidate,
): ProtectedLocalService | undefined {
  if (candidate.host) {
    const service = getProtectedLocalServiceByAddress(candidate.host, candidate.port);
    if (service) return service;
  }

  return PROTECTED_LOCAL_SERVICES.find((service) => service.port === candidate.port);
}

function hasExplicitHumanApproval(
  approval: ProcessCleanupHumanApproval | undefined,
): approval is ProcessCleanupHumanApproval {
  return approval?.approved === true && approval.approvalId.trim().length > 0;
}

function formatProtectedServiceOutageMessage(
  state: ProtectedServiceOutageReport['state'],
  services: ProtectedServiceStatus[],
): string {
  if (state === 'ok') {
    return 'Protected Rune services are reachable.';
  }

  const downServices = services
    .filter((service) => service.status === 'down')
    .map((service) => `${service.name} at ${service.host}:${service.port}`)
    .join(', ');
  const label = state === 'outage' ? 'outage' : 'degraded';
  return (
    `Protected Rune service ${label}: ${downServices}. ` +
    'Manual intervention and explicit approval are required before any kill, listener reuse, or restart action.'
  );
}
