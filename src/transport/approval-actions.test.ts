/**
 * Project 13 Phase 1c — the EXISTING `blocked-on-human` cockpit inbox row made
 * actionable (test-plan §3). Before Project 13 the row returned `not-found`
 * (non-actionable) for approve/reject; now Approve/Release routes to the shared
 * release runtime (`requestWorkRunRelease`), while Reject/dismiss clears the
 * parked supervision row.
 *
 * Regression coverage keeps inbox actions aligned with the parked-run release
 * runtime and the supervision row cleanup behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The release runtime is the surface dispatchApprovalStatus delegates to for a
// `blocked-on-human` approval. Mock it so the test asserts delegation without a
// real supervision store / mutation pipeline.
const mockRequestWorkRunRelease = vi.fn();
vi.mock('../jobs/work-run-release.js', () => ({
  requestWorkRunRelease: mockRequestWorkRunRelease,
  defaultReleaseRequestDeps: vi.fn(() => ({})),
}));
const mockRemoveRun = vi.fn();
vi.mock('../jobs/supervision-store.js', () => ({
  removeRun: mockRemoveRun,
}));

// The queue modules are pulled in by the other dispatch branches; stub them so
// the module imports cleanly and the queue branches are inert here.
vi.mock('../intent/intent-proposal-queue.js', () => ({
  readIntentProposalQueue: vi.fn(() => []),
  writeIntentProposalQueue: vi.fn(),
  clearApprovedIntentProposals: vi.fn(),
}));
vi.mock('../jobs/proposal-queue.js', () => ({
  readProposalQueue: vi.fn(() => []),
  writeProposalQueue: vi.fn(),
}));
vi.mock('../jobs/playbook-extract.js', () => ({
  readPlaybookQueue: vi.fn(() => []),
  writePlaybookQueue: vi.fn(),
}));
vi.mock('../intent/journal-intent-consumer.js', () => ({
  actionApprovedIntentProposal: vi.fn(async () => {}),
}));
vi.mock('../intent/journal-intent-actions.js', () => ({
  realConsumerDeps: {},
}));

const { dispatchApprovalStatus } = await import('./approval-actions.js');

describe('dispatchApprovalStatus — blocked-on-human inbox row (Phase 1c)', () => {
  beforeEach(() => {
    mockRequestWorkRunRelease.mockReset();
    mockRemoveRun.mockReset();
  });

  it('Approve on a clean parked run routes to the release runtime and returns ok', async () => {
    mockRequestWorkRunRelease.mockResolvedValue({ kind: 'created', runId: 'run-1', mutationId: 'rel-1' });
    const result = await dispatchApprovalStatus('blocked-on-human:run-1', 'approved');
    expect(mockRequestWorkRunRelease).toHaveBeenCalledOnce();
    // The released run id is the composite-id payload.
    expect(mockRequestWorkRunRelease.mock.calls[0]![0]).toBe('run-1');
    expect(mockRemoveRun).not.toHaveBeenCalled();
    expect(result).toBe('ok');
  });

  it('Reject clears the parked supervision row and never calls the release runtime', async () => {
    const result = await dispatchApprovalStatus('blocked-on-human:run-1', 'rejected');
    expect(mockRequestWorkRunRelease).not.toHaveBeenCalled();
    expect(mockRemoveRun).toHaveBeenCalledOnce();
    expect(mockRemoveRun.mock.calls[0]![0]).toBe('run-1');
    expect(result).toBe('ok');
  });

  it('Approve on a not-parked / already-released run clears stale supervision and returns ok', async () => {
    mockRequestWorkRunRelease.mockResolvedValue({ kind: 'not-parked', runId: 'gone-1' });
    const result = await dispatchApprovalStatus('blocked-on-human:gone-1', 'approved');
    expect(mockRemoveRun).toHaveBeenCalledOnce();
    expect(mockRemoveRun.mock.calls[0]![0]).toBe('gone-1');
    expect(result).toBe('ok');
  });

  it('Approve on a DIRTY parked run does NOT confirm-discard from the inbox (returns not-found)', async () => {
    // The inbox Approve is a clean-release quick-action; a dirty worktree must
    // go through the explicit release endpoint/callback with confirmDirty=true,
    // never an implicit inbox approve.
    mockRequestWorkRunRelease.mockResolvedValue({ kind: 'dirty-confirm', runId: 'run-1', files: ['M a'] });
    const result = await dispatchApprovalStatus('blocked-on-human:run-1', 'approved');
    expect(mockRemoveRun).not.toHaveBeenCalled();
    expect(result).toBe('not-found');
  });

  it('Approve release errors remain errors and do not clear supervision', async () => {
    mockRequestWorkRunRelease.mockResolvedValue({ kind: 'error', runId: 'run-1', error: 'release failed' });
    const result = await dispatchApprovalStatus('blocked-on-human:run-1', 'approved');
    expect(mockRemoveRun).not.toHaveBeenCalled();
    expect(result).toBe('error');
  });
});
