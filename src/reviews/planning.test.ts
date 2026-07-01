/**
 * Test suite for `src/reviews/planning.ts` — the per-user planning-session
 * store (Phase 6 A4.1). Mirrors `src/reviews/session.ts` for review
 * sessions; wraps the pure `PlanningSession` lifecycle from
 * `src/intent/planner.ts` with chatId-keyed state and JSON persistence.
 *
 * Written test-first; the implementation file does not exist yet.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Mocks (hoisted) ---

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { mockConfig, mockCleanupSession } = vi.hoisted(() => ({
  mockConfig: {
    PLANNING_SESSIONS_FILE: '/test/planning-sessions.json',
    PLANNING_ARTIFACTS_DIR: '/test/planning-artifacts',
    PROMOTIONS_FILE: '/test/promotions.jsonl',
  },
  mockCleanupSession: vi.fn(),
}));
vi.mock('../config.js', () => ({ default: mockConfig }));
vi.mock('../ai/claude.js', () => ({
  cleanupSession: mockCleanupSession,
}));

// --- Imports under test (after mocks) ---

import {
  abandonActivePlanningSession,
  createPlanningSession,
  deletePlanningSession,
  getActivePlanningSession,
  getAllPlanningSessions,
  getPlanningSession,
  persistPlanningSessions,
  restorePlanningSessions,
  updatePlanningSession,
} from './planning.js';
// Real promotions module (uses real fs against the per-test tmpdir log) — verifies the
// abandonment hook in deletePlanningSession against the actual state machine.
import { createPromotion, appendPromotion, loadPromotions, transitionPromotion } from '../intent/promotions.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rune-planning-store-test-'));
  mockConfig.PLANNING_SESSIONS_FILE = join(tmpDir, 'planning-sessions.json');
  mockConfig.PLANNING_ARTIFACTS_DIR = join(tmpDir, 'planning-artifacts');
  mockConfig.PROMOTIONS_FILE = join(tmpDir, 'promotions.jsonl');
  mockCleanupSession.mockReset();
  // Ensure no leftover sessions from previous test runs (in-memory state
  // is module-scoped; the persist file is per-test so a fresh restore
  // brings the in-memory state in sync with the empty file).
  restorePlanningSessions();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createPlanningSession', () => {
  it('creates a session keyed by chatId with the pure PlanningSession embedded', () => {
    const s = createPlanningSession(42, 'build a thing', 'chat', 'aura');
    expect(s.chatId).toBe(42);
    expect(s.planning.idea).toBe('build a thing');
    expect(s.planning.surface).toBe('chat');
    expect(s.planning.product).toBe('aura');
    expect(s.planning.status).toBe('scoping');
    expect(typeof s.id).toBe('string');
    expect(typeof s.claudeSessionId).toBe('string');
    expect(typeof s.createdAt).toBe('string');
    expect(s.lastActivity).toBe(s.createdAt);
  });

  it('cancels an active planning session when a new one starts for the same chatId', () => {
    const first = createPlanningSession(42, 'idea one', 'chat', 'aura');
    const second = createPlanningSession(42, 'idea two', 'chat', 'aura');
    expect(getPlanningSession(42)?.id).toBe(second.id);
    expect(getPlanningSession(42)?.id).not.toBe(first.id);
  });
});

describe('getPlanningSession / getActivePlanningSession', () => {
  it('getPlanningSession returns the session for a chatId, null if absent', () => {
    expect(getPlanningSession(99)).toBeNull();
    const s = createPlanningSession(99, 'x', 'chat', 'aura');
    expect(getPlanningSession(99)).toEqual(s);
  });

  it('getActivePlanningSession returns the session for an in-flight conversation', () => {
    createPlanningSession(99, 'x', 'chat', 'aura');
    const active = getActivePlanningSession(99);
    expect(active).not.toBeNull();
  });

  it('getActivePlanningSession returns null for an abandoned session', () => {
    createPlanningSession(99, 'x', 'chat', 'aura');
    updatePlanningSession(99, (sess) => ({
      ...sess,
      planning: { ...sess.planning, status: 'abandoned' },
    }));
    expect(getActivePlanningSession(99)).toBeNull();
  });

  it('getActivePlanningSession returns null for an approved session', () => {
    // Approved sessions are terminal — the next stage is scaffolding via
    // project-setup-writer, which the bot handler triggers separately;
    // getActive should not return them as in-flight.
    createPlanningSession(99, 'x', 'chat', 'aura');
    updatePlanningSession(99, (sess) => ({
      ...sess,
      planning: { ...sess.planning, status: 'approved' },
    }));
    expect(getActivePlanningSession(99)).toBeNull();
  });
});

describe('updatePlanningSession', () => {
  it('applies the updater function and refreshes lastActivity', async () => {
    const created = createPlanningSession(7, 'a', 'chat', 'aura');
    // Sleep one ms so the lastActivity timestamp advances.
    await new Promise((r) => setTimeout(r, 5));
    updatePlanningSession(7, (sess) => ({
      ...sess,
      planning: {
        ...sess.planning,
        status: 'spec-proposed',
        artifact: { product: 'aura', title: 't', spec: 's', tasks: 'ts', testPlan: 'tp' },
      },
    }));
    const after = getPlanningSession(7)!;
    expect(after.planning.status).toBe('spec-proposed');
    expect(after.planning.artifact?.title).toBe('t');
    expect(after.lastActivity).not.toBe(created.lastActivity);
  });

  it('is a no-op when the chatId has no session', () => {
    expect(() =>
      updatePlanningSession(999, (sess) => sess),
    ).not.toThrow();
    expect(getPlanningSession(999)).toBeNull();
  });
});

describe('deletePlanningSession', () => {
  it('removes the session and calls cleanupSession with the claudeSessionId', () => {
    const s = createPlanningSession(8, 'a', 'chat', 'aura');
    deletePlanningSession(8);
    expect(getPlanningSession(8)).toBeNull();
    expect(mockCleanupSession).toHaveBeenCalledWith(s.claudeSessionId);
  });

  it('is a no-op when the chatId has no session', () => {
    expect(() => deletePlanningSession(999)).not.toThrow();
    expect(mockCleanupSession).not.toHaveBeenCalled();
  });
});

describe('persistPlanningSessions / restorePlanningSessions', () => {
  it('round-trips a single session through disk', () => {
    const original = createPlanningSession(12, 'an idea', 'cockpit', 'assay');
    // Force a persist (createPlanningSession already persists; this is
    // belt-and-suspenders for the round-trip assertion).
    persistPlanningSessions();
    // Wipe in-memory state by restoring from an empty file would be racy;
    // instead, re-read from the same file.
    restorePlanningSessions();
    const restored = getPlanningSession(12);
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(original.id);
    expect(restored!.planning.idea).toBe('an idea');
    expect(restored!.planning.surface).toBe('cockpit');
    expect(restored!.planning.product).toBe('assay');
  });

  it('round-trips approved PM-spec state and persisted downstream artifact for restart resume', () => {
    const approvedSpec = {
      version: 2,
      kind: 'pm-spec',
      product: 'aura',
      title: 'PM-owned spec',
      spec: 'The approved PM spec.',
      assumptions: ['The user approved this exact artifact.'],
      selfReview: { revised: true, summary: 'Clarified the acceptance boundary.' },
    };
    const downstreamArtifact = {
      product: 'aura',
      title: 'PM-owned spec',
      spec: 'The approved PM spec.',
      techSpec: 'Tech lead breakdown.',
      tasks: '## Phase 1\n### Tests (write first)\n- [ ] contract test',
      testPlan: '## 1. Contract\n- [ ] approval resumes',
      context: '# Context',
    };
    const original = createPlanningSession(13, 'an idea', 'chat', 'aura');
    updatePlanningSession(13, (sess) => ({
      ...sess,
      planning: {
        ...sess.planning,
        status: 'approved',
        approvedSpec,
        downstreamArtifact,
      } as any,
    }));

    restorePlanningSessions();

    const restored = getPlanningSession(13) as any;
    expect(restored).not.toBeNull();
    expect(restored.id).toBe(original.id);
    expect(restored.planning.status).toBe('approved');
    expect(restored.planning.approvedSpec).toEqual(approvedSpec);
    expect(restored.planning.downstreamArtifact).toEqual(downstreamArtifact);
  });

  it('keeps approved PM-spec state separate for concurrent same-product sessions', () => {
    const firstSpec = {
      version: 2,
      kind: 'pm-spec',
      product: 'aura',
      title: 'First PM spec',
      spec: 'First approved scope.',
      assumptions: ['first assumption'],
      selfReview: { revised: false, summary: 'First clean review.' },
    };
    const secondSpec = {
      version: 2,
      kind: 'pm-spec',
      product: 'aura',
      title: 'Second PM spec',
      spec: 'Second approved scope.',
      assumptions: ['second assumption'],
      selfReview: { revised: true, summary: 'Second revised review.' },
    };

    createPlanningSession(21, 'first idea', 'chat', 'aura');
    createPlanningSession(22, 'second idea', 'cockpit', 'aura');
    updatePlanningSession(21, (sess) => ({
      ...sess,
      planning: { ...sess.planning, status: 'approved', approvedSpec: firstSpec } as any,
    }));
    updatePlanningSession(22, (sess) => ({
      ...sess,
      planning: { ...sess.planning, status: 'approved', approvedSpec: secondSpec } as any,
    }));

    restorePlanningSessions();

    expect((getPlanningSession(21) as any)?.planning.approvedSpec).toEqual(firstSpec);
    expect((getPlanningSession(22) as any)?.planning.approvedSpec).toEqual(secondSpec);
    expect(getPlanningSession(21)?.planning.product).toBe('aura');
    expect(getPlanningSession(22)?.planning.product).toBe('aura');
  });

  it('restorePlanningSessions returns silently on a missing file (no throw)', () => {
    // Use a path that doesn't exist.
    mockConfig.PLANNING_SESSIONS_FILE = join(tmpDir, 'no-such-file.json');
    expect(() => restorePlanningSessions()).not.toThrow();
  });
});

describe('getAllPlanningSessions', () => {
  it('returns every session keyed by chatId', () => {
    createPlanningSession(1, 'idea-a', 'chat', 'aura');
    createPlanningSession(2, 'idea-b', 'chat', 'assay');
    const all = getAllPlanningSessions();
    const chatIds = all.map(([chatId]) => chatId);
    expect(chatIds).toContain(1);
    expect(chatIds).toContain(2);
  });
});

// ---------------------------------------------------------------------------
// SpecArtifact snapshots — the off-process recovery trail. Every distinct
// artifact revision lands as its own JSON file under PLANNING_ARTIFACTS_DIR
// so a spec is recoverable even if /approve later deletes the session
// before the scaffolder writes the project files. See
// docs/projects/08-intent-layer/agent-lessons.md for the motivating incident.
// ---------------------------------------------------------------------------

function listArtifactFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

describe('spec-artifact snapshots', () => {
  const artifact1 = {
    product: 'aura',
    title: 'first revision',
    spec: 's1',
    tasks: 't1',
    testPlan: 'tp1',
  };
  const artifact2 = {
    product: 'aura',
    title: 'second revision',
    spec: 's2',
    tasks: 't2',
    testPlan: 'tp2',
  };

  it('writes a snapshot when an artifact first appears (undefined → defined)', () => {
    createPlanningSession(11, 'idea', 'chat', 'aura');
    updatePlanningSession(11, (sess) => ({
      ...sess,
      planning: { ...sess.planning, status: 'spec-proposed', artifact: artifact1 },
    }));
    expect(listArtifactFiles(mockConfig.PLANNING_ARTIFACTS_DIR).length).toBe(1);
  });

  it('writes a new snapshot when the artifact content changes', async () => {
    createPlanningSession(11, 'idea', 'chat', 'aura');
    updatePlanningSession(11, (sess) => ({
      ...sess,
      planning: { ...sess.planning, status: 'spec-proposed', artifact: artifact1 },
    }));
    // Bump clock so ISO timestamp in filename differs.
    await new Promise((r) => setTimeout(r, 5));
    updatePlanningSession(11, (sess) => ({
      ...sess,
      planning: { ...sess.planning, artifact: artifact2 },
    }));
    expect(listArtifactFiles(mockConfig.PLANNING_ARTIFACTS_DIR).length).toBe(2);
  });

  it('does not snapshot when the artifact is unchanged', () => {
    createPlanningSession(11, 'idea', 'chat', 'aura');
    updatePlanningSession(11, (sess) => ({
      ...sess,
      planning: { ...sess.planning, status: 'spec-proposed', artifact: artifact1 },
    }));
    // Same content, fresh object — content-equality not reference-equality.
    updatePlanningSession(11, (sess) => ({
      ...sess,
      planning: { ...sess.planning, artifact: { ...artifact1 } },
    }));
    expect(listArtifactFiles(mockConfig.PLANNING_ARTIFACTS_DIR).length).toBe(1);
  });

  it('does not snapshot for scoping-only updates (no artifact)', () => {
    createPlanningSession(11, 'idea', 'chat', 'aura');
    updatePlanningSession(11, (sess) => sess);
    expect(listArtifactFiles(mockConfig.PLANNING_ARTIFACTS_DIR).length).toBe(0);
  });

  it('snapshot file content carries sessionId, chatId, status, artifact, timestamp', () => {
    const created = createPlanningSession(11, 'idea', 'chat', 'aura');
    updatePlanningSession(11, (sess) => ({
      ...sess,
      planning: { ...sess.planning, status: 'spec-proposed', artifact: artifact1 },
    }));
    const files = listArtifactFiles(mockConfig.PLANNING_ARTIFACTS_DIR);
    expect(files.length).toBe(1);
    const parsed = JSON.parse(
      readFileSync(join(mockConfig.PLANNING_ARTIFACTS_DIR, files[0]!), 'utf8'),
    );
    expect(parsed.sessionId).toBe(created.id);
    expect(parsed.chatId).toBe(11);
    expect(parsed.status).toBe('spec-proposed');
    expect(parsed.artifact).toEqual(artifact1);
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('snapshot survives deletePlanningSession (independent recovery trail)', () => {
    createPlanningSession(11, 'idea', 'chat', 'aura');
    updatePlanningSession(11, (sess) => ({
      ...sess,
      planning: { ...sess.planning, status: 'spec-proposed', artifact: artifact1 },
    }));
    deletePlanningSession(11);
    expect(getPlanningSession(11)).toBeNull();
    expect(listArtifactFiles(mockConfig.PLANNING_ARTIFACTS_DIR).length).toBe(1);
  });

  it('filename is prefixed with the session id and ends in .json', () => {
    const created = createPlanningSession(11, 'idea', 'chat', 'aura');
    updatePlanningSession(11, (sess) => ({
      ...sess,
      planning: { ...sess.planning, status: 'spec-proposed', artifact: artifact1 },
    }));
    const f = listArtifactFiles(mockConfig.PLANNING_ARTIFACTS_DIR)[0]!;
    expect(f.startsWith(created.id)).toBe(true);
    expect(f.endsWith('.json')).toBe(true);
  });
});

describe('deletePlanningSession — linked promotion abandonment (09-expand-cockpit)', () => {
  function seedPromotion(id: string) {
    return createPromotion({
      id, product: 'rune', backlogItemId: 'b1',
      snapshotRaw: '- some idea', planningSessionId: 's', now: 'T0',
    });
  }

  it('advances a linked planning-started promotion to planning-abandoned on delete', () => {
    appendPromotion(mockConfig.PROMOTIONS_FILE, seedPromotion('p1'));
    createPlanningSession(7, 'idea', 'cockpit', 'rune');
    updatePlanningSession(7, (s) => ({ ...s, promotionId: 'p1' }));

    deletePlanningSession(7);

    expect(loadPromotions(mockConfig.PROMOTIONS_FILE).get('p1')?.state).toBe('planning-abandoned');
  });

  it('also fires through /clear-style abandonment (abandonActivePlanningSession → delete)', () => {
    appendPromotion(mockConfig.PROMOTIONS_FILE, seedPromotion('p2'));
    createPlanningSession(8, 'idea', 'cockpit', 'rune');
    updatePlanningSession(8, (s) => ({ ...s, promotionId: 'p2' }));

    abandonActivePlanningSession(8);

    expect(loadPromotions(mockConfig.PROMOTIONS_FILE).get('p2')?.state).toBe('planning-abandoned');
  });

  it('approval-success delete leaves a marked-source promotion untouched (terminal, not abandoned)', () => {
    // After a successful /approve, scaffoldAndDelete drives the promotion to marked-source then
    // deletes the session via this same chokepoint — the terminal-state guard must no-op.
    const sc = transitionPromotion(seedPromotion('p-done'), 'scaffolded', { slug: '09-x', now: 'T1' });
    if (!sc.ok) throw new Error('setup');
    const done = transitionPromotion(sc.promotion, 'marked-source', { now: 'T2' });
    if (!done.ok) throw new Error('setup');
    appendPromotion(mockConfig.PROMOTIONS_FILE, done.promotion);
    createPlanningSession(11, 'idea', 'cockpit', 'rune');
    updatePlanningSession(11, (s) => ({ ...s, promotionId: 'p-done' }));

    deletePlanningSession(11);

    expect(loadPromotions(mockConfig.PROMOTIONS_FILE).get('p-done')?.state).toBe('marked-source');
  });

  it('leaves a scaffolded promotion untouched (resumable, not abandoned)', () => {
    const sc = transitionPromotion(seedPromotion('p3'), 'scaffolded', { slug: '09-x', now: 'T1' });
    if (!sc.ok) throw new Error('setup');
    appendPromotion(mockConfig.PROMOTIONS_FILE, sc.promotion);
    createPlanningSession(9, 'idea', 'cockpit', 'rune');
    updatePlanningSession(9, (s) => ({ ...s, promotionId: 'p3' }));

    deletePlanningSession(9);

    expect(loadPromotions(mockConfig.PROMOTIONS_FILE).get('p3')?.state).toBe('scaffolded');
  });

  it('a plain session with no promotionId writes nothing to the promotions log', () => {
    createPlanningSession(10, 'idea', 'cockpit', 'rune');
    deletePlanningSession(10);
    expect(loadPromotions(mockConfig.PROMOTIONS_FILE).size).toBe(0);
  });
});
