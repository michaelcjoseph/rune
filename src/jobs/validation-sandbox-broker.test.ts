// @module-tag validation-sandbox-integration
import { describe, expect, it } from 'vitest';

import {
  requestValidationSandboxProbe,
  startValidationSandboxBroker,
} from './validation-sandbox-broker.js';

describe.runIf(process.platform === 'darwin')('validation sandbox broker', () => {
  it('runs only a fixed top-level Seatbelt probe', async () => {
    const inherited = process.env['RUNE_VALIDATION_SANDBOX_BROKER_SOCKET'];
    const broker = inherited === undefined ? await startValidationSandboxBroker() : undefined;
    const socketPath = inherited ?? broker!.socketPath;
    try {
      await expect(requestValidationSandboxProbe(socketPath, {
        version: 1,
        scenario: 'profile-compiles',
        candidateProfile: '(version 1)(allow default)',
      })).resolves.toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    } finally {
      await broker?.stop();
    }
  });

  it('rejects arbitrary request fields and host-path profile grants', async () => {
    const inherited = process.env['RUNE_VALIDATION_SANDBOX_BROKER_SOCKET'];
    const broker = inherited === undefined ? await startValidationSandboxBroker() : undefined;
    const socketPath = inherited ?? broker!.socketPath;
    try {
      const arbitrary = await requestValidationSandboxProbe(
        socketPath,
        {
          version: 1,
          scenario: 'profile-compiles',
          candidateProfile: '(version 1)(allow file-read* (subpath "/Users"))',
          command: '/bin/sh',
        } as never,
      );
      expect(arbitrary).toMatchObject({ ok: false, failure: 'invalid-request' });
    } finally {
      await broker?.stop();
    }
  });

  it('runs bounded loopback and private-write capability scenarios', async () => {
    const inherited = process.env['RUNE_VALIDATION_SANDBOX_BROKER_SOCKET'];
    const broker = inherited === undefined ? await startValidationSandboxBroker() : undefined;
    const socketPath = inherited ?? broker!.socketPath;
    try {
      await expect(requestValidationSandboxProbe(socketPath, {
        version: 1,
        scenario: 'loopback-allowed-external-denied',
        candidateProfile: [
          '(version 1)',
          '(allow default)',
          '(deny network-outbound)',
          '(deny network-inbound)',
          '(allow network-inbound (local ip "localhost:*"))',
          '(allow network-outbound (remote ip "localhost:*"))',
        ].join(''),
      })).resolves.toMatchObject({ ok: true, exitCode: 0, timedOut: false });
      await expect(requestValidationSandboxProbe(socketPath, {
        version: 1,
        scenario: 'private-write-denied',
        candidateProfile: '(version 1)(allow default)(deny file-write*)',
      })).resolves.toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    } finally {
      await broker?.stop();
    }
  });
});
