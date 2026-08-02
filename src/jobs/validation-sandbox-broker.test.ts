// @module-tag validation-sandbox-integration
import { describe, expect, it } from 'vitest';

import {
  requestValidationSandboxProbe,
  startValidationSandboxBroker,
  verifyInheritedValidationConfinement,
} from './validation-sandbox-broker.js';
import { withValidationBroker } from './validation-broker-test-stub.js';

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

  /**
   * The grant filter first matched only the literal operations `file-read` and
   * `file-write`, so `file-write-data`, `file-read-metadata`, and `regex`-based
   * grants passed straight through a check whose stated purpose is rejecting
   * absolute host-path grants. This socket is reachable by product-authored
   * code (a sandbox-integration shard gets the socket path in its environment),
   * so the filter must cover Seatbelt's file-operation vocabulary, not two
   * names of it.
   */
  it.each([
    '(version 1)(allow file-read* (subpath "/Users"))',
    '(version 1)(allow file-write* (literal "/etc/passwd"))',
    '(version 1)(allow file-write-data (literal "/Users/operator/.env"))',
    '(version 1)(allow file-write-create (subpath "/private/tmp"))',
    '(version 1)(allow file-write-unlink (subpath "/Users"))',
    '(version 1)(allow file-read-metadata (literal "/Users/operator"))',
    '(version 1)(allow file-read-xattr (subpath "/Users"))',
    '(version 1)(allow file* (subpath "/"))',
    '(version 1)(allow file-read* (regex #"^/Users/operator"))',
    '(version 1)(allow file-read*\n  (subpath "/Users"))',
    '(version 1)( allow  file-write-data  ( literal  "/Users" ))',
  ])('rejects the host-path grant %#', async (candidateProfile) => {
    const inherited = process.env['RUNE_VALIDATION_SANDBOX_BROKER_SOCKET'];
    const broker = inherited === undefined ? await startValidationSandboxBroker() : undefined;
    const socketPath = inherited ?? broker!.socketPath;
    try {
      await expect(requestValidationSandboxProbe(socketPath, {
        version: 1,
        scenario: 'profile-compiles',
        candidateProfile,
      })).resolves.toMatchObject({ ok: false, failure: 'invalid-request' });
    } finally {
      await broker?.stop();
    }
  });

  it('still admits relative and non-file grants the fixed probes rely on', async () => {
    const inherited = process.env['RUNE_VALIDATION_SANDBOX_BROKER_SOCKET'];
    const broker = inherited === undefined ? await startValidationSandboxBroker() : undefined;
    const socketPath = inherited ?? broker!.socketPath;
    try {
      await expect(requestValidationSandboxProbe(socketPath, {
        version: 1,
        scenario: 'profile-compiles',
        candidateProfile: '(version 1)(allow default)(deny file-write*)(allow network-outbound)',
      })).resolves.toMatchObject({ ok: true, exitCode: 0 });
    } finally {
      await broker?.stop();
    }
  });

  /**
   * A child's cross-process bypass of the inner Seatbelt used to be authorized
   * by two bare environment variables. It now requires the LIVE broker that
   * encloses the child to confirm the nonce it minted, for the profile it owns.
  */
  describe('confinement attestation', () => {
    // Several tests below need the raw inherited pair to assert on staleness
    // and per-instance uniqueness directly; `withBroker` covers the common
    // "just give me a live broker" case.
    const inheritedSocket = process.env['RUNE_VALIDATION_SANDBOX_BROKER_SOCKET'];
    const inheritedNonce = process.env['RUNE_VALIDATION_CONFINEMENT_ATTESTATION'];
    const withBroker = <T>(
      body: (socketPath: string, nonce: string) => Promise<T>,
    ): Promise<T> =>
      withValidationBroker((broker) => body(broker.socketPath, broker.attestationNonce));

    it('verifies only a live socket, nonce, and expected profile tuple', async () => {
      await withBroker(async (socketPath, nonce) => {
        await expect(verifyInheritedValidationConfinement('sandbox-integration', {
          RUNE_VALIDATION_SANDBOX_BROKER_SOCKET: socketPath,
          RUNE_VALIDATION_CONFINEMENT_ATTESTATION: nonce,
        })).resolves.toBe(true);
        await expect(verifyInheritedValidationConfinement('sandbox-integration', {
          RUNE_VALIDATION_SANDBOX_BROKER_SOCKET: socketPath,
          RUNE_VALIDATION_CONFINEMENT_ATTESTATION: 'forged',
        })).resolves.toBe(false);
        await expect(verifyInheritedValidationConfinement('isolated', {
          RUNE_VALIDATION_SANDBOX_BROKER_SOCKET: socketPath,
          RUNE_VALIDATION_CONFINEMENT_ATTESTATION: nonce,
        })).resolves.toBe(false);
      });
    });

    it('rejects a stale inherited attestation after its broker stops', async () => {
      let staleSocket: string;
      let staleNonce: string;
      if (inheritedSocket !== undefined && inheritedNonce !== undefined) {
        staleSocket = `${inheritedSocket}.stale`;
        staleNonce = inheritedNonce;
      } else {
        const broker = await startValidationSandboxBroker();
        staleSocket = broker.socketPath;
        staleNonce = broker.attestationNonce;
        await broker.stop();
      }

      await expect(
        verifyInheritedValidationConfinement('sandbox-integration', {
          RUNE_VALIDATION_SANDBOX_BROKER_SOCKET: staleSocket,
          RUNE_VALIDATION_CONFINEMENT_ATTESTATION: staleNonce,
        }),
      ).resolves.toBe(false);
    });

    it('confirms only the nonce it minted, for the profile it owns', async () => {
      await withBroker(async (socketPath, nonce) => {
        await expect(requestValidationSandboxProbe(socketPath, {
          version: 1,
          scenario: 'confinement-attestation',
          nonce,
          profile: 'sandbox-integration',
        })).resolves.toMatchObject({ ok: true, exitCode: 0, timedOut: false });

        await expect(requestValidationSandboxProbe(socketPath, {
          version: 1,
          scenario: 'confinement-attestation',
          nonce: 'forged-nonce',
          profile: 'sandbox-integration',
        })).resolves.toMatchObject({ ok: false, failure: 'invalid-request' });

        await expect(requestValidationSandboxProbe(socketPath, {
          version: 1,
          scenario: 'confinement-attestation',
          nonce,
          profile: 'isolated',
        })).resolves.toMatchObject({ ok: false, failure: 'invalid-request' });
      });
    });

    it('mints a distinct nonce per broker instance', async () => {
      if (inheritedSocket !== undefined) {
        // Starting another listener would violate the shard's single-owner
        // contract. The broker-free focused suite exercises the two-instance
        // mint below; the profiled shard proves its inherited nonce is present.
        expect(inheritedNonce).toBeTruthy();
        return;
      }
      const first = await startValidationSandboxBroker();
      const second = await startValidationSandboxBroker();
      try {
        expect(first.attestationNonce).not.toBe(second.attestationNonce);
        // A nonce from another live broker is still not proof for this one.
        await expect(requestValidationSandboxProbe(first.socketPath, {
          version: 1,
          scenario: 'confinement-attestation',
          nonce: second.attestationNonce,
          profile: 'sandbox-integration',
        })).resolves.toMatchObject({ ok: false, failure: 'invalid-request' });
      } finally {
        await first.stop();
        await second.stop();
      }
    });

    it('authorizes nothing once the broker is gone', async () => {
      let socketPath: string;
      let attestationNonce: string;
      if (inheritedSocket !== undefined && inheritedNonce !== undefined) {
        socketPath = `${inheritedSocket}.gone`;
        attestationNonce = inheritedNonce;
      } else {
        const broker = await startValidationSandboxBroker();
        socketPath = broker.socketPath;
        attestationNonce = broker.attestationNonce;
        await broker.stop();
      }

      // Exactly the stale-environment case: both values look right, but the
      // enclosing broker no longer exists to vouch for them.
      await expect(requestValidationSandboxProbe(socketPath, {
        version: 1,
        scenario: 'confinement-attestation',
        nonce: attestationNonce,
        profile: 'sandbox-integration',
      })).resolves.toMatchObject({ ok: false, failure: 'broker-unavailable' });
    });

    it('rejects a malformed attestation request', async () => {
      await withBroker(async (socketPath, nonce) => {
        for (const request of [
          { version: 1, scenario: 'confinement-attestation', profile: 'sandbox-integration' },
          { version: 1, scenario: 'confinement-attestation', nonce: '', profile: 'sandbox-integration' },
          { version: 1, scenario: 'confinement-attestation', nonce, profile: 'made-up' },
          {
            version: 1,
            scenario: 'confinement-attestation',
            nonce,
            profile: 'sandbox-integration',
            command: '/bin/sh',
          },
        ]) {
          await expect(requestValidationSandboxProbe(socketPath, request as never))
            .resolves.toMatchObject({ ok: false, failure: 'invalid-request' });
        }
      });
    });
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
