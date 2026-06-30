import { describe, expect, it } from 'vitest';

import * as protectedLocalServices from './protected-local-services.js';
import {
  PROTECTED_LOCAL_SERVICES,
  formatProtectedLocalServicesWarning,
  getProtectedLocalServiceByAddress,
  getProtectedLocalServiceByLaunchdLabel,
  isProtectedLocalServiceAddress,
  isProtectedLocalServiceLaunchdLabel,
} from './protected-local-services.js';

type ProtectedLocalServiceRecord = (typeof PROTECTED_LOCAL_SERVICES)[number];
type ProtectedLocalServiceFormatter = (service: ProtectedLocalServiceRecord) => string;

function expectExportedFormatter(name: string): ProtectedLocalServiceFormatter {
  const value = (protectedLocalServices as Record<string, unknown>)[name];
  expect(value, `missing ${name} formatter export`).toBeTypeOf('function');
  return value as ProtectedLocalServiceFormatter;
}

describe('protected-local-services-contract (project 19 / Phase 5A)', () => {
  it('exposes Rune web and Rune MCP as the canonical protected localhost services', () => {
    expect(PROTECTED_LOCAL_SERVICES).toEqual([
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
    ]);
  });

  it('classifies protected service addresses without treating neighboring ports as protected', () => {
    expect(isProtectedLocalServiceAddress('127.0.0.1', 3847)).toBe(true);
    expect(isProtectedLocalServiceAddress('127.0.0.1', 3848)).toBe(true);

    expect(isProtectedLocalServiceAddress('127.0.0.1', 3849)).toBe(false);
    expect(isProtectedLocalServiceAddress('localhost', 3847)).toBe(false);
    expect(isProtectedLocalServiceAddress('0.0.0.0', 3848)).toBe(false);
  });

  it('looks up the protected service record from an occupied address', () => {
    expect(getProtectedLocalServiceByAddress('127.0.0.1', 3847)).toMatchObject({
      id: 'rune-web',
      launchdLabel: 'com.jarvis.daemon',
    });
    expect(getProtectedLocalServiceByAddress('127.0.0.1', 3848)).toMatchObject({
      id: 'rune-mcp',
      launchdLabel: 'com.jarvis.rune-mcp',
    });
    expect(getProtectedLocalServiceByAddress('127.0.0.1', 0)).toBeNull();
  });

  it('classifies protected launchd service identities', () => {
    expect(isProtectedLocalServiceLaunchdLabel('com.jarvis.daemon')).toBe(true);
    expect(isProtectedLocalServiceLaunchdLabel('com.jarvis.rune-mcp')).toBe(true);

    expect(isProtectedLocalServiceLaunchdLabel('com.example.test-server')).toBe(false);
    expect(isProtectedLocalServiceLaunchdLabel('com.jarvis.daemon.test')).toBe(false);
  });

  it('looks up the protected service record from a launchd label', () => {
    expect(getProtectedLocalServiceByLaunchdLabel('com.jarvis.daemon')).toMatchObject({
      id: 'rune-web',
      host: '127.0.0.1',
      port: 3847,
    });
    expect(getProtectedLocalServiceByLaunchdLabel('com.jarvis.rune-mcp')).toMatchObject({
      id: 'rune-mcp',
      host: '127.0.0.1',
      port: 3848,
    });
    expect(getProtectedLocalServiceByLaunchdLabel('com.example.test-server')).toBeNull();
  });

  it('generates warning text from the shared contract so prompts and guards do not drift', () => {
    const warning = formatProtectedLocalServicesWarning();

    for (const service of PROTECTED_LOCAL_SERVICES) {
      expect(warning).toContain(service.name);
      expect(warning).toContain(`${service.host}:${service.port}`);
      expect(warning).toContain(service.launchdLabel);
    }
    expect(warning).toMatch(/never kill|never stop|never interrupt|never reuse/i);
    expect(warning).toMatch(/explicit human approval/i);
  });

  it('formats protected service identities from canonical records instead of ad hoc strings', () => {
    const formatProtectedLocalServiceAddress = expectExportedFormatter(
      'formatProtectedLocalServiceAddress',
    );
    const formatProtectedLocalServiceSummary = expectExportedFormatter(
      'formatProtectedLocalServiceSummary',
    );
    const [web, mcp] = PROTECTED_LOCAL_SERVICES;

    expect(formatProtectedLocalServiceAddress(web)).toBe('127.0.0.1:3847');
    expect(formatProtectedLocalServiceAddress(mcp)).toBe('127.0.0.1:3848');
    expect(formatProtectedLocalServiceSummary(web)).toBe(
      'Rune web / cockpit at 127.0.0.1:3847 (launchd label com.jarvis.daemon)',
    );
    expect(formatProtectedLocalServiceSummary(mcp)).toBe(
      'Rune MCP daemon at 127.0.0.1:3848 (launchd label com.jarvis.rune-mcp)',
    );

    const warning = formatProtectedLocalServicesWarning();
    for (const service of PROTECTED_LOCAL_SERVICES) {
      expect(warning).toContain(formatProtectedLocalServiceSummary(service));
    }
  });
});
