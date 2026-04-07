type Level = 'info' | 'warn' | 'error' | 'debug';

function log(level: Level, component: string, message: string, data?: Record<string, unknown>) {
  const entry = {
    time: new Date().toISOString(),
    level,
    component,
    message,
    ...(data ? { data } : {}),
  };
  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(component: string) {
  return {
    info: (message: string, data?: Record<string, unknown>) => log('info', component, message, data),
    warn: (message: string, data?: Record<string, unknown>) => log('warn', component, message, data),
    error: (message: string, data?: Record<string, unknown>) => log('error', component, message, data),
    debug: (message: string, data?: Record<string, unknown>) => log('debug', component, message, data),
  };
}
