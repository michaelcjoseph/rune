export interface ProtectedLocalService {
  id: string;
  name: string;
  host: string;
  port: number;
  launchdLabel: string;
}

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
