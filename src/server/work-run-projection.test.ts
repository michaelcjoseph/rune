/**
 * Unit suite for `readWorkRunProjections` active-run merge (project 11, Phase 6
 * follow-on Fix #2 — see phase-6-diagnosis.md "Gap #2").
 *
 * Test-first: these tests are RED until `readWorkRunProjections` gains a 4th
 * `activeRuns` parameter that layers in-flight runs (present in the supervision
 * store, absent from `index.jsonl` until termination) over the terminal index
 * rows, so a live run's card shows last-N output + elapsed without waiting for
 * the run to end. Satisfies spec req 24.
 *
 * `streamJsonToDisplay` (used by the transcript-tail reader) transitively imports
 * `../config.js`, which throws on missing env at import time — mock it (mirrors
 * work-run-transcript.test.ts) so this pure suite loads without a real env.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', WORKSPACE_DIR: '/test/workspace' },
  PROJECT_ROOT: '/test/project',
}));

import { readWorkRunProjections } from './work-run-projection.js';
import type { SupervisedRun } from '../intent/supervision.js';

const gateReceiptIdentity = {
  version: 1,
  treeOid: 'a'.repeat(40),
  fullTaskReviewHash: 'b'.repeat(64),
  completedAt: '2026-07-30T12:00:00.000Z',
  commandFingerprint: 'c'.repeat(64),
  configurationFingerprint: 'd'.repeat(64),
  dependencyFingerprint: 'e'.repeat(64),
};

let dir: string;
let indexFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'work-run-projection-'));
  indexFile = join(dir, 'index.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Seed a per-run transcript.jsonl under <dir>/<id>/ with the given stream-json
 *  lines (objects, one per line). No summary.json, no index row — mirrors an
 *  in-flight run whose terminal artifacts haven't been written yet. */
function seedTranscript(id: string, events: object[]): void {
  mkdirSync(join(dir, id), { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(dir, id, 'transcript.jsonl'), body);
}

/** Build a minimal in-flight SupervisedRun. */
function activeRun(
  id: string,
  project: string,
  startedAt: string,
  status: SupervisedRun['status'] = 'running',
): SupervisedRun {
  return {
    id,
    product: 'aura',
    project,
    status,
    startedAt,
    lastHeartbeatAt: startedAt,
  };
}

describe('readWorkRunProjections — active-run merge (Fix #2)', () => {
  it('projects a persisted lease wait as a safe minimal waiting indicator', () => {
    const id = 'lease-waiting-001';
    const waitingRun = {
      ...activeRun(id, '24-execution-profiles', '2026-08-05T12:00:00.000Z'),
      waitingOn: {
        resource: { type: 'base-branch', key: '/private/operator/repositories/aura:main' },
        operationId: 'integration-finalize',
        waitingSince: '2026-08-05T12:01:00.000Z',
      },
    };

    const projection = readWorkRunProjections(dir, indexFile, undefined, [waitingRun as SupervisedRun]);
    expect(projection['24-execution-profiles']).toMatchObject({
      mutationId: id,
      outcome: null,
      waitingOn: 'base branch',
    });
    // The run record may retain an opaque diagnostic key, but the operator
    // projection must never turn it into a host-path disclosure.
    expect(JSON.stringify(projection['24-execution-profiles'])).not.toContain('/private/operator');
  });

  it('projects structured terminal trigger and parked disposition', () => {
    const id = 'terminal-trigger-001';
    mkdirSync(join(dir, id), { recursive: true });
    const trigger = { kind: 'failure', reason: 'coder failed at provider' };
    const disposition = { kind: 'parked', reason: 'WIP preserved', wipSha: 'deadbeef' };
    writeFileSync(join(dir, id, 'summary.json'), JSON.stringify({
      id, project: '02-growth', product: 'aura', outcome: 'failed',
      reason: trigger.reason,
      exit: { exitCode: 1, signal: null, cancelled: false, durationMs: 10, exitFact: 'clean-exit' },
      workProduct: { commitCount: 0, commitShas: [], filesChanged: [], diffstat: '', dirty: false,
        untracked: false, transitions: { tasksNewlyChecked: 0, tasksRemaining: 1, tasksAdded: 0, tasksRemoved: 0 } },
      baseSha: 'base', branch: 'rune-work/demo', startedAt: '2026-07-22T00:00:00.000Z',
      endedAt: '2026-07-22T00:00:01.000Z', transcriptPath: '', forensicsPath: '',
      trigger, disposition,
    }));
    writeFileSync(indexFile, `${JSON.stringify({
      id, project: '02-growth', outcome: 'failed', durationMs: 10,
      startedAt: '2026-07-22T00:00:00.000Z', endedAt: '2026-07-22T00:00:01.000Z',
    })}\n`);

    expect(readWorkRunProjections(dir, indexFile)['02-growth']).toMatchObject({
      outcome: 'failed', trigger, disposition,
    });
  });

  it('projects the bounded merge-gate validation receipt after restart', () => {
    const id = 'terminal-gate-receipt-001';
    const gateValidationReceipt = {
      ...gateReceiptIdentity,
      outcome: 'passed',
      commands: [
        { command: 'npm run build', outcome: 'passed', coverage: 'unsupported' },
        {
          command: 'npm test',
          outcome: 'passed',
          coverage: 'complete',
          discovered: { suites: 1, tests: 2 },
          completed: {
            suites: 1, tests: 2, passed: 2, failed: 0,
            skipped: 0, todo: 0, cancelled: 0,
          },
        },
      ],
    };
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'summary.json'), JSON.stringify({
      id, project: '02-growth', product: 'aura', outcome: 'branch-complete',
      reason: 'merged',
      exit: { exitCode: 0, signal: null, cancelled: false, durationMs: 10, exitFact: 'clean-exit' },
      workProduct: { commitCount: 1, commitShas: ['deadbeef'], filesChanged: ['src/a.ts'],
        diffstat: '', dirty: false, untracked: false,
        transitions: { tasksNewlyChecked: 1, tasksRemaining: 0, tasksAdded: 0, tasksRemoved: 0 } },
      baseSha: 'base', branch: 'rune-work/demo', startedAt: '2026-07-30T00:00:00.000Z',
      endedAt: '2026-07-30T00:00:01.000Z', transcriptPath: '', forensicsPath: '',
      gateValidationReceipt,
    }));
    writeFileSync(indexFile, `${JSON.stringify({
      id, project: '02-growth', outcome: 'branch-complete', durationMs: 10,
      startedAt: '2026-07-30T00:00:00.000Z', endedAt: '2026-07-30T00:00:01.000Z',
    })}\n`);

    expect(readWorkRunProjections(dir, indexFile)['02-growth']).toMatchObject({
      gateValidationReceipt,
    });
  });

  it('projects actionable context-closeout failure evidence for the Cockpit list', () => {
    const id = 'context-closeout-failure-001';
    mkdirSync(join(dir, id), { recursive: true });
    const contextFailure = {
      reason: 'managed-heading-collision',
      file: 'docs/projects/resolved-assay/context.md',
      canonicalHeading: '## Interfaces & Contracts',
      conflictingHeadings: ['## Interfaces & Contracts', '## Canonical Interfaces'],
      proposedRepair: 'Merge the bodies and remove the legacy heading.',
      checkpoint: { kind: 'committed', sha: 'abcdef1234567' },
    };
    writeFileSync(join(dir, id, 'summary.json'), JSON.stringify({
      id, project: '02-growth', product: 'aura', outcome: 'failed',
      reason: 'context update rejected',
      exit: { exitCode: 1, signal: null, cancelled: false, durationMs: 10, exitFact: 'execution-failure' },
      workProduct: { commitCount: 1, commitShas: ['abcdef1234567'], filesChanged: ['src/a.ts'],
        diffstat: '', dirty: false, untracked: false,
        transitions: { tasksNewlyChecked: 0, tasksRemaining: 1, tasksAdded: 0, tasksRemoved: 0 } },
      baseSha: 'base', branch: 'rune-work/demo', startedAt: '2026-07-22T00:00:00.000Z',
      endedAt: '2026-07-22T00:00:01.000Z', transcriptPath: '', forensicsPath: '',
      trigger: { kind: 'failure', reason: 'context update rejected' },
      disposition: { kind: 'preserved', reason: 'worktree preserved', wipSha: 'abcdef1234567' },
      contextFailure,
    }));
    writeFileSync(indexFile, `${JSON.stringify({
      id, project: '02-growth', outcome: 'failed', durationMs: 10,
      startedAt: '2026-07-22T00:00:00.000Z', endedAt: '2026-07-22T00:00:01.000Z',
    })}\n`);

    expect(readWorkRunProjections(dir, indexFile)['02-growth']).toMatchObject({
      outcome: 'failed',
      disposition: { kind: 'preserved', wipSha: 'abcdef1234567' },
      contextFailure,
    });
  });

  it('projects an active run that is absent from index.jsonl, with live lastOutput + startedAt', () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    seedTranscript(id, [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading tasks.md' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/x.ts' } }] } },
    ]);
    // index.jsonl does not exist (no terminal runs yet).
    const out = readWorkRunProjections(dir, indexFile, undefined, [
      activeRun(id, '02-growth', '2026-06-01T12:00:00.000Z'),
    ]);

    expect(out['02-growth']).toBeDefined();
    const proj = out['02-growth']!;
    expect(proj.mutationId).toBe(id);
    // In-flight → no terminal verdict yet.
    expect(proj.outcome).toBeNull();
    expect(proj.reason).toBeNull();
    // Live last-N output from the transcript tail (rendered via the adapter).
    expect(proj.lastOutput.length).toBeGreaterThan(0);
    expect(proj.lastOutput.some((l) => l.includes('Reading tasks.md'))).toBe(true);
    // startedAt drives the card's elapsed; must be the run's start.
    expect(proj.startedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(proj.transcriptUrl).toBe(`/api/work-runs/${id}/transcript`);
  });

  it('projects an active run with no transcript yet (lastOutput empty, transcriptUrl null, still present)', () => {
    const id = 'bbbbbbbb-1111-2222-3333-444444444444';
    // No transcript file seeded for this id.
    const out = readWorkRunProjections(dir, indexFile, undefined, [
      activeRun(id, '02-growth', '2026-06-01T12:00:00.000Z'),
    ]);

    expect(out['02-growth']).toBeDefined();
    expect(out['02-growth']!.lastOutput).toEqual([]);
    expect(out['02-growth']!.transcriptUrl).toBeNull();
    expect(out['02-growth']!.outcome).toBeNull();
  });

  it('an active run wins over an OLDER terminal index row for the same slug (newest activity)', () => {
    const oldId = 'cccccccc-0000-0000-0000-000000000000';
    const liveId = 'dddddddd-1111-1111-1111-111111111111';
    // Terminal index row + summary for an older run.
    mkdirSync(join(dir, oldId), { recursive: true });
    writeFileSync(
      join(dir, oldId, 'summary.json'),
      JSON.stringify({ id: oldId, project: '02-growth', outcome: 'noop', reason: 'nothing', startedAt: '2026-06-01T10:00:00.000Z' }),
    );
    writeFileSync(
      indexFile,
      JSON.stringify({ id: oldId, project: '02-growth', outcome: 'noop', startedAt: '2026-06-01T10:00:00.000Z' }) + '\n',
    );
    // A newer in-flight run for the same project.
    seedTranscript(liveId, [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Live work in progress' }] } },
    ]);

    const out = readWorkRunProjections(dir, indexFile, undefined, [
      activeRun(liveId, '02-growth', '2026-06-01T12:00:00.000Z'),
    ]);

    // The live run wins — its id, null outcome, and live output, not the old noop.
    expect(out['02-growth']!.mutationId).toBe(liveId);
    expect(out['02-growth']!.outcome).toBeNull();
    expect(out['02-growth']!.lastOutput.some((l) => l.includes('Live work in progress'))).toBe(true);
  });

  it('keeps a STRICTLY-NEWER terminal index row over an older active run (defensive recency)', () => {
    const staleActiveId = 'eeeeeeee-0000-0000-0000-000000000000';
    const newerTermId = 'ffffffff-1111-1111-1111-111111111111';
    mkdirSync(join(dir, newerTermId), { recursive: true });
    writeFileSync(
      join(dir, newerTermId, 'summary.json'),
      JSON.stringify({ id: newerTermId, project: '02-growth', outcome: 'branch-complete', reason: 'done', startedAt: '2026-06-01T14:00:00.000Z' }),
    );
    writeFileSync(
      indexFile,
      JSON.stringify({ id: newerTermId, project: '02-growth', outcome: 'branch-complete', startedAt: '2026-06-01T14:00:00.000Z' }) + '\n',
    );
    // An active run with an EARLIER startedAt than the terminal row.
    seedTranscript(staleActiveId, [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'stale' }] } },
    ]);

    const out = readWorkRunProjections(dir, indexFile, undefined, [
      activeRun(staleActiveId, '02-growth', '2026-06-01T11:00:00.000Z'),
    ]);

    // Newer terminal row wins.
    expect(out['02-growth']!.mutationId).toBe(newerTermId);
    expect(out['02-growth']!.outcome).toBe('branch-complete');
  });

  it('projects a blocked-on-human run with its live transcript tail', () => {
    const id = '99999999-1111-2222-3333-444444444444';
    seedTranscript(id, [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Waiting on approval' }] } },
    ]);
    const out = readWorkRunProjections(dir, indexFile, undefined, [
      activeRun(id, '02-growth', '2026-06-01T12:00:00.000Z', 'blocked-on-human'),
    ]);

    expect(out['02-growth']).toBeDefined();
    expect(out['02-growth']!.mutationId).toBe(id);
    expect(out['02-growth']!.outcome).toBeNull();
    expect(out['02-growth']!.lastOutput.some((l) => l.includes('Waiting on approval'))).toBe(true);
  });

  it('projects orchestrated activity/output transcript events as role-attributed lastOutput lines', () => {
    const id = 'orch-run-active-001';
    seedTranscript(id, [
      {
        mutationId: id,
        ts: '2026-06-17T10:00:05.000Z',
        kind: 'activity',
        data: {
          role: 'qa',
          provider: 'openai',
          model: 'gpt-5.6-terra',
          line: 'qa | openai | gpt-5.6-terra | writing tests from the spec',
        },
      },
      {
        mutationId: id,
        ts: '2026-06-17T10:00:10.000Z',
        kind: 'output',
        data: {
          role: 'coder',
          provider: 'openai',
          model: 'gpt-5.6-sol',
          line: 'coder | openai | gpt-5.6-sol | wiring cockpit projection',
        },
      },
    ]);

    const out = readWorkRunProjections(dir, indexFile, undefined, [
      activeRun(id, '02-growth', '2026-06-17T10:00:00.000Z'),
    ]);

    expect(out['02-growth']).toBeDefined();
    expect(out['02-growth']!.mutationId).toBe(id);
    expect(out['02-growth']!.outcome).toBeNull();
    expect(out['02-growth']!.transcriptUrl).toBe(`/api/work-runs/${id}/transcript`);
    expect(out['02-growth']!.lastOutput).toEqual([
      'qa | openai | gpt-5.6-terra | writing tests from the spec',
      'coder | openai | gpt-5.6-sol | wiring cockpit projection',
    ]);
  });

  it('rejects an active run with a non-slug (path-traversal) id without projecting it', () => {
    const out = readWorkRunProjections(dir, indexFile, undefined, [
      activeRun('../escape', '02-growth', '2026-06-01T12:00:00.000Z'),
    ]);
    expect(out['02-growth'] ?? null).toBeNull();
  });

  it('active runs for different slugs are merged alongside terminal index rows', () => {
    const termId = '11111111-0000-0000-0000-000000000000';
    const liveId = '22222222-1111-1111-1111-111111111111';
    mkdirSync(join(dir, termId), { recursive: true });
    writeFileSync(
      join(dir, termId, 'summary.json'),
      JSON.stringify({ id: termId, project: '02-growth', outcome: 'partial', reason: 'x', startedAt: '2026-06-01T10:00:00.000Z' }),
    );
    writeFileSync(
      indexFile,
      JSON.stringify({ id: termId, project: '02-growth', outcome: 'partial', startedAt: '2026-06-01T10:00:00.000Z' }) + '\n',
    );
    seedTranscript(liveId, [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'other project live' }] } },
    ]);

    const out = readWorkRunProjections(dir, indexFile, undefined, [
      activeRun(liveId, '03-other', '2026-06-01T12:00:00.000Z'),
    ]);

    expect(out['02-growth']!.outcome).toBe('partial');
    expect(out['03-other']!.mutationId).toBe(liveId);
    expect(out['03-other']!.outcome).toBeNull();
  });
});
