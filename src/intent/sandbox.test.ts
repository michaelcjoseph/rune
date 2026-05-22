import { describe, it, expect } from 'vitest';

/*
 * Test-first suite for test-plan.md §11 — sandboxing and security, Layer 4 (08-intent-layer,
 * Phase 3).
 *
 * Written BEFORE the implementation. `src/intent/sandbox.ts` ships as a contract stub whose
 * functions throw 'not implemented', so every test here is RED. That is the intended,
 * correct state: this is a "Tests (write first)" task — the suite goes green when a Phase 3
 * sandboxing implementation task lands. Do not implement the sandbox to make these pass.
 *
 * Scope note: the system-level enforcement (creating/removing the git worktree, injecting
 * scoped credentials, blocking egress at the network layer) and the §11 items "one project
 * per product" (§15) and prompt-injection defense are integration concerns. This suite
 * pins the deterministic boundary-policy core — the pure checks a caller consults.
 */

import {
  worktreePathFor,
  isWriteAllowed,
  isEgressAllowed,
  canReachCredential,
  type SandboxSpec,
} from './sandbox.js';

// --- Fixtures ---

const WORKTREE_ROOT = '/tmp/jarvis-worktrees';

/** A sandbox for an Aura project; override any field per test. */
function sandbox(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    product: 'aura',
    project: '02-growth',
    worktree: '/tmp/jarvis-worktrees/aura/02-growth',
    egressAllowlist: ['github.com', 'registry.npmjs.org'],
    ...overrides,
  };
}

describe('sandbox — worktree isolation (test-plan §11)', () => {
  it('gives distinct projects distinct worktree paths so two runs never share a tree', () => {
    const a = worktreePathFor('aura', '02-growth', WORKTREE_ROOT);
    const b = worktreePathFor('relay', '01-relay-core', WORKTREE_ROOT);
    const c = worktreePathFor('aura', '03-pricing', WORKTREE_ROOT);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('is deterministic — the same product and project always yield the same path', () => {
    expect(worktreePathFor('aura', '02-growth', WORKTREE_ROOT)).toBe(
      worktreePathFor('aura', '02-growth', WORKTREE_ROOT),
    );
  });

  it('gives two projects under the same product distinct worktree paths', () => {
    // A broken impl that keyed only on `product` would collide here.
    expect(worktreePathFor('aura', '02-growth', WORKTREE_ROOT)).not.toBe(
      worktreePathFor('aura', '03-pricing', WORKTREE_ROOT),
    );
  });

  it('rejects a path-traversal slug rather than letting the worktree path escape the root', () => {
    // A separator- or dot-bearing slug is rejected outright — no path is produced.
    expect(() => worktreePathFor('../evil', 'x', WORKTREE_ROOT)).toThrow(/invalid|slug|separator/i);
    expect(() => worktreePathFor('aura', 'a/b', WORKTREE_ROOT)).toThrow(/invalid|slug|separator/i);
  });

  it('rejects an empty product or project slug', () => {
    expect(() => worktreePathFor('', 'x', WORKTREE_ROOT)).toThrow(/invalid|slug/i);
    expect(() => worktreePathFor('aura', '', WORKTREE_ROOT)).toThrow(/invalid|slug/i);
  });
});

describe('sandbox — write boundary (test-plan §11)', () => {
  it('allows a write inside the run\'s own worktree', () => {
    expect(isWriteAllowed('/tmp/jarvis-worktrees/aura/02-growth/src/app.ts', sandbox())).toBe(true);
  });

  it('denies a write to the vault — Regime B never writes the vault', () => {
    expect(isWriteAllowed('/Users/anyone/vault/journals/2026_01_15.md', sandbox())).toBe(false);
  });

  it('denies a write outside the worktree entirely', () => {
    expect(isWriteAllowed('/etc/passwd', sandbox())).toBe(false);
  });

  it('denies a `..` traversal that escapes the worktree', () => {
    const escaping = '/tmp/jarvis-worktrees/aura/02-growth/../../../../etc/passwd';
    expect(isWriteAllowed(escaping, sandbox())).toBe(false);
  });

  it('denies a sibling path that merely shares the worktree name as a prefix', () => {
    // `/tmp/jarvis-worktrees/aura/02-growth-evil` must not pass as inside `.../02-growth`.
    expect(isWriteAllowed('/tmp/jarvis-worktrees/aura/02-growth-evil/x.ts', sandbox())).toBe(false);
  });

  it('does not let one run write into another run\'s worktree', () => {
    const relayPath = '/tmp/jarvis-worktrees/relay/01-relay-core/src/index.ts';
    expect(isWriteAllowed(relayPath, sandbox())).toBe(false);
  });
});

describe('sandbox — egress allowlist (test-plan §11)', () => {
  it('allows egress to an allowlisted host', () => {
    expect(isEgressAllowed('github.com', sandbox())).toBe(true);
  });

  it('denies egress to a host not on the allowlist', () => {
    expect(isEgressAllowed('evil.example.com', sandbox())).toBe(false);
  });

  it('denies all egress when the allowlist is empty', () => {
    expect(isEgressAllowed('github.com', sandbox({ egressAllowlist: [] }))).toBe(false);
  });

  it('denies a subdomain of an allowlisted host', () => {
    // A naive endsWith match would wrongly allow this.
    expect(isEgressAllowed('evil.github.com', sandbox())).toBe(false);
  });

  it('denies a host that merely ends with an allowlisted name', () => {
    expect(isEgressAllowed('github.com.evil.example.com', sandbox())).toBe(false);
  });

  it('denies a host that has an allowlisted name as a bare substring', () => {
    // A naive includes() match would wrongly allow this.
    expect(isEgressAllowed('evil-github.com', sandbox())).toBe(false);
  });

  it('normalizes case and a trailing FQDN dot before matching', () => {
    // DNS host names are case-insensitive and a trailing dot denotes the same host.
    expect(isEgressAllowed('GitHub.COM', sandbox())).toBe(true);
    expect(isEgressAllowed('github.com.', sandbox())).toBe(true);
  });
});

describe('sandbox — credential scoping (test-plan §11)', () => {
  it('lets a run reach its own product\'s credentials', () => {
    expect(canReachCredential(sandbox({ product: 'aura' }), 'aura')).toBe(true);
  });

  it('never lets a run reach another product\'s credentials', () => {
    expect(canReachCredential(sandbox({ product: 'aura' }), 'relay')).toBe(false);
  });

  it('does not grant access when the credential product is a prefix of the run product', () => {
    expect(canReachCredential(sandbox({ product: 'aura' }), 'aura-staging')).toBe(false);
  });

  it('matches the product name exactly — it is case-sensitive', () => {
    expect(canReachCredential(sandbox({ product: 'aura' }), 'Aura')).toBe(false);
  });

  it("never lets a run reach Jarvis's own credentials", () => {
    expect(canReachCredential(sandbox({ product: 'aura' }), 'jarvis')).toBe(false);
  });
});
