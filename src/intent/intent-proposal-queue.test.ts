import { describe, it, expect, beforeEach, vi } from 'vitest';

/*
 * Tests for the journal-to-intent proposal queue (08-intent-layer, Phase 2, test-plan §8 —
 * "intake proposals and carried-over roadmap items surface for approval"). The queue
 * persists IntentProposals so they surface in the cockpit's Pending Approvals panel and in
 * review prep. `node:fs` is mocked with an in-memory store; `config` supplies the path.
 */

const { store } = vi.hoisted(() => ({ store: { value: null as string | null } }));
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => {
    if (store.value === null) {
      const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return store.value;
  }),
  writeFileSync: vi.fn((_path: string, data: string) => {
    store.value = data;
  }),
  mkdirSync: vi.fn(),
}));
vi.mock('../config.js', () => ({
  default: { INTENT_PROPOSAL_QUEUE_FILE: '/tmp/jarvis-test-intent-proposal-queue.json' },
}));

import {
  readIntentProposalQueue,
  writeIntentProposalQueue,
  getPendingIntentProposals,
  appendIntentProposals,
  clearApprovedIntentProposals,
  type QueuedIntentProposal,
} from './intent-proposal-queue.js';

/** A pending queue entry wrapping a vault-intake proposal. */
function pendingEntry(product: string): QueuedIntentProposal {
  return {
    queuedAt: '2026-01-15T00:00:00.000Z',
    proposal: { kind: 'vault-intake', product, note: `a note about ${product}` },
    status: 'pending',
  };
}

beforeEach(() => {
  store.value = null;
});

describe('intent proposal queue', () => {
  it('returns an empty queue when the file does not exist yet', () => {
    expect(readIntentProposalQueue()).toEqual([]);
  });

  it('returns an empty queue when the file holds malformed or non-array JSON', () => {
    store.value = '{ not json';
    expect(readIntentProposalQueue()).toEqual([]);
    store.value = '{"not":"an array"}';
    expect(readIntentProposalQueue()).toEqual([]);
  });

  it('round-trips entries through write and read', () => {
    const entries = [pendingEntry('aura'), pendingEntry('relay')];
    writeIntentProposalQueue(entries);
    expect(readIntentProposalQueue()).toEqual(entries);
  });

  it('appends entries without dropping existing ones', () => {
    writeIntentProposalQueue([pendingEntry('aura')]);
    appendIntentProposals([pendingEntry('relay')]);
    expect(readIntentProposalQueue().map((e) => e.proposal)).toEqual([
      { kind: 'vault-intake', product: 'aura', note: 'a note about aura' },
      { kind: 'vault-intake', product: 'relay', note: 'a note about relay' },
    ]);
  });

  it('appending an empty list is a no-op', () => {
    writeIntentProposalQueue([pendingEntry('aura')]);
    appendIntentProposals([]);
    expect(readIntentProposalQueue()).toHaveLength(1);
  });

  it('getPendingIntentProposals returns only pending entries', () => {
    writeIntentProposalQueue([
      pendingEntry('aura'),
      { ...pendingEntry('relay'), status: 'approved' },
      { ...pendingEntry('watt-data'), status: 'rejected' },
    ]);
    const pending = getPendingIntentProposals();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.proposal).toMatchObject({ product: 'aura' });
  });

  it('clearApprovedIntentProposals drops approved entries but keeps pending and rejected', () => {
    writeIntentProposalQueue([
      pendingEntry('aura'),
      { ...pendingEntry('relay'), status: 'approved' },
      { ...pendingEntry('watt-data'), status: 'rejected' },
    ]);
    clearApprovedIntentProposals();
    const remaining = readIntentProposalQueue();
    expect(remaining.map((e) => e.status).sort()).toEqual(['pending', 'rejected']);
  });
});
