/** Rune-owned broker for fixed, top-level Seatbelt validation probes. */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, createConnection, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerActiveProcess, unregisterActiveProcess } from '../ai/claude.js';
import {
  createConfinementCapability,
  type ConfinementCapability,
} from '../utils/validation-confinement.js';
import {
  isValidationProfile,
  type ValidationProfile,
} from '../intent/validation-profiles.js';

const MAX_REQUEST_BYTES = 20_000;
const MAX_PROFILE_BYTES = 16_000;
const REQUEST_TIMEOUT_MS = 3_000;

export type SandboxProbeScenario =
  | 'profile-compiles'
  | 'loopback-bind-denied'
  | 'loopback-allowed-external-denied'
  | 'private-write-allowed'
  | 'private-write-denied';

const PROBE_SCENARIOS: readonly string[] = [
  'profile-compiles',
  'loopback-bind-denied',
  'loopback-allowed-external-denied',
  'private-write-allowed',
  'private-write-denied',
];

/**
 * Any Seatbelt file operation (`file*`, `file-read*`, `file-write-data`,
 * `file-read-metadata`, …) granting an absolute-rooted path through a
 * `literal`, `subpath`, or `regex` filter. Matching the operation token by
 * prefix — rather than the two names the first draft enumerated — keeps the
 * filter aligned with its stated purpose as Seatbelt's vocabulary grows.
 *
 * This is a best-effort shape check on a request field, NOT the containment
 * boundary: probe programs are fixed (`fixedProbe`) and run in the broker's own
 * private root, so a permissive candidate profile has nothing to reach.
 */
const HOST_PATH_GRANT =
  /\(\s*allow\s+file[\w*-]*\s+\(\s*(?:literal|subpath|regex)\s+#?"\^?\//;

export interface ValidationSandboxProbeRequest {
  version: 1;
  scenario: SandboxProbeScenario;
  candidateProfile: string;
}

/**
 * Cross-process proof that a caller is genuinely enclosed by this broker's
 * launcher. The nonce is minted per broker and handed only to that broker's
 * own children, so a stale environment variable cannot authorize a bypass.
 */
export interface ValidationConfinementAttestationRequest {
  version: 1;
  scenario: 'confinement-attestation';
  nonce: string;
  profile: ValidationProfile;
}

export type ValidationSandboxRequest =
  | ValidationSandboxProbeRequest
  | ValidationConfinementAttestationRequest;

export interface ValidationSandboxProbeResponse {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  failure?: 'invalid-request' | 'probe-failed' | 'broker-unavailable';
}

export interface ValidationSandboxBroker {
  socketPath: string;
  /** In-memory grant for the in-process owner that started this broker. */
  capability: ConfinementCapability;
  /** Handed to this broker's own children for the cross-process bypass proof. */
  attestationNonce: string;
  profile: ValidationProfile;
  stop: () => Promise<void>;
}

function validateRequest(value: unknown): ValidationSandboxRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record['version'] !== 1) return undefined;
  if (record['scenario'] === 'confinement-attestation') {
    if (!Object.keys(record).every((key) =>
      key === 'version' || key === 'scenario' || key === 'nonce' || key === 'profile')) {
      return undefined;
    }
    if (
      typeof record['nonce'] !== 'string' ||
      record['nonce'].length < 1 ||
      record['nonce'].length > 200 ||
      !isValidationProfile(record['profile'])
    ) return undefined;
    return record as unknown as ValidationConfinementAttestationRequest;
  }
  if (!Object.keys(record).every((key) =>
    key === 'version' || key === 'scenario' || key === 'candidateProfile')) return undefined;
  if (
    !PROBE_SCENARIOS.includes(String(record['scenario'])) ||
    typeof record['candidateProfile'] !== 'string' ||
    record['candidateProfile'].length < 1 ||
    record['candidateProfile'].length > MAX_PROFILE_BYTES ||
    record['candidateProfile'].includes('\0') ||
    HOST_PATH_GRANT.test(record['candidateProfile'])
  ) return undefined;
  return record as unknown as ValidationSandboxProbeRequest;
}

function fixedProbe(
  scenario: SandboxProbeScenario,
): { bin: string; argv: string[] } {
  if (scenario === 'profile-compiles') return { bin: '/usr/bin/true', argv: [] };
  if (scenario === 'loopback-bind-denied') {
    return {
      bin: process.execPath,
      argv: ['-e', [
        "const net=require('node:net');",
        'const s=net.createServer();',
        "s.once('error',()=>process.exit(0));",
        "s.listen(0,'127.0.0.1',()=>{s.close();process.exit(31)});",
        'setTimeout(()=>process.exit(32),1000).unref();',
      ].join('')],
    };
  }
  if (scenario === 'loopback-allowed-external-denied') {
    return {
      bin: process.execPath,
      argv: ['-e', [
        "const net=require('node:net');",
        'const server=net.createServer();',
        'const fail=(code)=>{try{server.close()}catch{};process.exit(code)};',
        "server.once('error',()=>fail(31));",
        "server.listen(0,'127.0.0.1',()=>{",
        "const local=net.connect(server.address().port,'127.0.0.1');",
        "local.once('error',()=>fail(32));",
        "local.once('connect',()=>{local.destroy();server.close(()=>{",
        "const external=net.connect(80,'1.1.1.1');",
        "external.once('connect',()=>{external.destroy();process.exit(33)});",
        "external.once('error',(error)=>process.exit(error.code==='EPERM'||error.code==='EACCES'?0:34));",
        'setTimeout(()=>{external.destroy();process.exit(35)},1000).unref();',
        '})});',
        '});',
        'setTimeout(()=>fail(36),2000).unref();',
      ].join('')],
    };
  }
  if (scenario === 'private-write-denied') {
    return {
      bin: process.execPath,
      argv: ['-e', [
        "try{require('node:fs').writeFileSync('probe-output','ok');process.exit(31)}",
        "catch(error){process.exit(error.code==='EPERM'||error.code==='EACCES'?0:32)}",
      ].join('')],
    };
  }
  return {
    bin: process.execPath,
    argv: ['-e', "require('node:fs').writeFileSync('probe-output','ok')"],
  };
}

async function executeProbe(
  request: ValidationSandboxProbeRequest,
  privateRoot: string,
): Promise<ValidationSandboxProbeResponse> {
  const probe = fixedProbe(request.scenario);
  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = spawn('/usr/bin/sandbox-exec', [
      '-p', request.candidateProfile, probe.bin, ...probe.argv,
    ], {
      cwd: privateRoot,
      env: {},
      stdio: 'ignore',
      detached: true,
    });
    registerActiveProcess(child, true);
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregisterActiveProcess(child);
      resolve({
        ok: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        ...(exitCode === 0 && !timedOut ? {} : { failure: 'probe-failed' as const }),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
      }
    }, REQUEST_TIMEOUT_MS);
    timer.unref();
    child.once('close', finish);
    child.once('error', () => finish(null));
  });
}

export async function startValidationSandboxBroker(
  profile: ValidationProfile = 'sandbox-integration',
): Promise<ValidationSandboxBroker> {
  if (process.platform !== 'darwin') throw new Error('sandbox integration broker requires macOS');
  const privateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'rune-validation-broker-')));
  chmodSync(privateRoot, 0o700);
  const socketPath = join(privateRoot, 'broker.sock');
  const attestationNonce = randomUUID();
  let server: Server | undefined;
  try {
    server = createServer((socket) => {
      let raw = '';
      let handled = false;
      const respond = (response: ValidationSandboxProbeResponse): void => {
        if (handled) return;
        handled = true;
        socket.end(`${JSON.stringify(response)}\n`);
      };
      socket.setEncoding('utf8');
      socket.setTimeout(REQUEST_TIMEOUT_MS, () => respond({
        ok: false, exitCode: null, timedOut: true, failure: 'invalid-request',
      }));
      socket.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > MAX_REQUEST_BYTES) return respond({
          ok: false, exitCode: null, timedOut: false, failure: 'invalid-request',
        });
        const newline = raw.indexOf('\n');
        if (newline < 0) return;
        let request: ValidationSandboxRequest | undefined;
        try { request = validateRequest(JSON.parse(raw.slice(0, newline))); } catch { /* invalid */ }
        if (request === undefined) return respond({
          ok: false, exitCode: null, timedOut: false, failure: 'invalid-request',
        });
        if (request.scenario === 'confinement-attestation') {
          // Only this broker's own children hold the nonce, and it authorizes
          // exactly the profile this broker was started for.
          const proven = request.nonce === attestationNonce && request.profile === profile;
          return respond({
            ok: proven,
            exitCode: proven ? 0 : null,
            timedOut: false,
            ...(proven ? {} : { failure: 'invalid-request' as const }),
          });
        }
        void executeProbe(request, privateRoot).then(respond, () => respond({
          ok: false, exitCode: null, timedOut: false, failure: 'broker-unavailable',
        }));
      });
      socket.once('error', () => {});
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socketPath, () => resolve());
    });
    chmodSync(socketPath, 0o600);
    return {
      socketPath,
      capability: createConfinementCapability('sandbox-broker', socketPath),
      attestationNonce,
      profile,
      stop: async () => {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        rmSync(privateRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server?.close();
    rmSync(privateRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function requestValidationSandboxProbe(
  socketPath: string,
  request: ValidationSandboxRequest,
): Promise<ValidationSandboxProbeResponse> {
  return await new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let raw = '';
    let settled = false;
    const finish = (response: ValidationSandboxProbeResponse): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(response);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => finish({
      ok: false, exitCode: null, timedOut: true, failure: 'broker-unavailable',
    }));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      raw += chunk;
      const newline = raw.indexOf('\n');
      if (newline < 0) return;
      try { finish(JSON.parse(raw.slice(0, newline)) as ValidationSandboxProbeResponse); } catch {
        finish({ ok: false, exitCode: null, timedOut: false, failure: 'broker-unavailable' });
      }
    });
    socket.on('error', () => finish({
      ok: false, exitCode: null, timedOut: false, failure: 'broker-unavailable',
    }));
  });
}
