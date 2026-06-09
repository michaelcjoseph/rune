import { describe, it, expect } from 'vitest';
import {
  runScaffoldApproval,
  retryPromotionMarkSource,
  type ScaffoldApprovalDeps,
} from './scaffold-approval.js';
import { createPromotion, type Promotion } from '../intent/promotions.js';
import type { StoredPlanningSession } from '../reviews/planning.js';
import type { Registry } from '../intent/registry.js';

/*
 * Unit suite for the scaffold-approval runtime (09-expand-cockpit, Phase 4). Exercises the REAL
 * pure modules (resolveScaffoldTarget / scaffold-result / markBacklogItemDone / promotions /
 * withFileLock) with faked I/O (agent, fs, git, registry, products, promotion log), so it pins the
 * orchestration without touching disk or spawning Claude.
 */

const SLUG = '09-x';

function scaffoldMsg(slug: string): string {
  return ['Scaffolded.', '```scaffold-result', JSON.stringify({ slug, filesCreated: [`docs/projects/${slug}/spec.md`] }), '```'].join('\n');
}

function makeSession(over: Partial<StoredPlanningSession> = {}): StoredPlanningSession {
  return {
    id: 's1',
    chatId: 1,
    claudeSessionId: 'c1',
    planning: {
      status: 'approved',
      product: 'jarvis',
      idea: 'idea',
      surface: 'chat',
      artifact: { product: 'jarvis', title: 'T', spec: 'spec', tasks: 'Tests (write first)', testPlan: 'tp' },
    },
    createdAt: '',
    lastActivity: '',
    ...over,
  };
}

interface Harness {
  deps: ScaffoldApprovalDeps;
  promotions: Map<string, Promotion>;
  appended: Promotion[];
  writes: Array<{ path: string; content: string }>;
  projectWrites: Array<{ path: string; content: string }>;
}

function makeHarness(over: Partial<ScaffoldApprovalDeps> = {}, backlogContent = '- idea\n'): Harness {
  const promotions = new Map<string, Promotion>();
  const appended: Promotion[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const projectWrites: Array<{ path: string; content: string }> = [];
  let scaffolded = false;
  const registry: Registry = {
    version: 1,
    builtAt: '',
    products: [{ name: 'jarvis', repoBacked: true, projects: [] }],
  };
  const deps: ScaffoldApprovalDeps = {
    runAgent: async () => {
      scaffolded = true;
      return { text: scaffoldMsg(SLUG), error: null };
    },
    readRegistry: () => registry,
    readProductsConfig: () => ({
      jarvis: { repoPath: '/ws/jarvis', baseBranch: 'main', credentialsFile: '', egressAllowlist: [] },
    }),
    productsConfigPath: '/cfg/products.json',
    workspaceRoot: '/ws',
    promotionsFile: '/log/promotions.jsonl',
    loadPromotions: () => promotions,
    appendPromotion: (_f, p) => { promotions.set(p.id, p); appended.push(p); },
    realpath: (p) => p,
    listProjectDirs: () => (scaffolded ? new Set([SLUG]) : new Set<string>()),
    fileExists: () => true,
    readBacklogFile: () => backlogContent,
    writeBacklogFile: (_repo, abs, content) => { writes.push({ path: abs, content }); },
    writeProjectFile: (abs, content) => { projectWrites.push({ path: abs, content }); },
    auditBacklogWrite: () => {},
    git: async () => ({ stdout: '', stderr: '' }),
    now: () => 'NOW',
    ...over,
  };
  return { deps, promotions, appended, writes, projectWrites };
}

describe('runScaffoldApproval — plain session (no promotion)', () => {
  it('scaffolds into the resolved repo and returns ok with the captured slug', async () => {
    const h = makeHarness();
    const out = await runScaffoldApproval(makeSession(), h.deps);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.slug).toBe(SLUG);
      expect(out.promotion).toBe('none');
    }
    expect(h.writes).toHaveLength(0);
  });

  it('writes tech-spec.md and context.md when the artifact carries them (role flow)', async () => {
    const h = makeHarness();
    const session = makeSession();
    session.planning.artifact = {
      ...session.planning.artifact!,
      techSpec: 'The tech spec body.',
      context: '# Project Context\n\n## Current State\n\nSeeded.',
    };
    const out = await runScaffoldApproval(session, h.deps);
    expect(out.ok).toBe(true);
    const paths = h.projectWrites.map((w) => w.path);
    expect(paths).toContain(`/ws/jarvis/docs/projects/${SLUG}/tech-spec.md`);
    expect(paths).toContain(`/ws/jarvis/docs/projects/${SLUG}/context.md`);
    expect(h.projectWrites.find((w) => w.path.endsWith('tech-spec.md'))?.content).toBe('The tech spec body.');
  });

  it('writes no role artifacts for a legacy artifact carrying neither', async () => {
    const h = makeHarness();
    const out = await runScaffoldApproval(makeSession(), h.deps);
    expect(out.ok).toBe(true);
    expect(h.projectWrites).toHaveLength(0);
  });
});

describe('runScaffoldApproval — promotion drive (success)', () => {
  it('marks an idea source bullet and drives the promotion to marked-source', async () => {
    const h = makeHarness({}, '- Expand the cockpit\n');
    h.promotions.set('p1', createPromotion({
      id: 'p1', product: 'jarvis', backlogItemId: 'b1',
      snapshotRaw: '- Expand the cockpit', planningSessionId: 's1', now: 'T0',
    }));
    const out = await runScaffoldApproval(makeSession({ promotionId: 'p1' }), h.deps);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.promotion).toBe('marked-source');
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.content).toBe(`- Expand the cockpit → ${SLUG}\n`);
    expect(h.writes[0]!.path).toBe('/ws/jarvis/docs/projects/ideas.md');
    // scaffolded then marked-source appended
    expect(h.appended.map((p) => p.state)).toEqual(['scaffolded', 'marked-source']);
  });

  it('flips a bug checkbox and writes bugs.md', async () => {
    const h = makeHarness({}, '- [ ] A bug\n');
    h.promotions.set('p1', createPromotion({
      id: 'p1', product: 'jarvis', backlogItemId: 'b1',
      snapshotRaw: '- [ ] A bug', planningSessionId: 's1', now: 'T0',
    }));
    const out = await runScaffoldApproval(makeSession({ promotionId: 'p1' }), h.deps);
    expect(out.ok).toBe(true);
    expect(h.writes[0]!.path).toBe('/ws/jarvis/docs/projects/bugs.md');
    expect(h.writes[0]!.content).toBe(`- [x] A bug → ${SLUG}\n`);
  });

  it('idempotent retry: already-promoted content writes nothing but still reaches marked-source', async () => {
    const h = makeHarness({}, `- Expand the cockpit → ${SLUG}\n`);
    h.promotions.set('p1', createPromotion({
      id: 'p1', product: 'jarvis', backlogItemId: 'b1',
      snapshotRaw: '- Expand the cockpit', planningSessionId: 's1', now: 'T0',
    }));
    const out = await runScaffoldApproval(makeSession({ promotionId: 'p1' }), h.deps);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.promotion).toBe('marked-source');
    expect(h.writes).toHaveLength(0); // byte-equal no-op
  });

  it('retries a mark-source-error promotion straight to marked-source (skips the illegal re-advance)', async () => {
    const h = makeHarness({}, '- Expand the cockpit\n');
    // A promotion that scaffolded, then failed mark-source on a prior attempt.
    const base = createPromotion({
      id: 'p1', product: 'jarvis', backlogItemId: 'b1',
      snapshotRaw: '- Expand the cockpit', planningSessionId: 's1', now: 'T0',
    });
    h.promotions.set('p1', { ...base, state: 'mark-source-error', slug: SLUG, attempts: 1 });
    const out = await runScaffoldApproval(makeSession({ promotionId: 'p1' }), h.deps);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.promotion).toBe('marked-source');
    // No re-advance to scaffolded — only the marked-source transition is appended.
    expect(h.appended.map((p) => p.state)).toEqual(['marked-source']);
    expect(h.writes).toHaveLength(1);
  });

  it('snapshot no-match → mark-source-error (scaffold still succeeded)', async () => {
    const h = makeHarness({}, '- A different idea\n');
    h.promotions.set('p1', createPromotion({
      id: 'p1', product: 'jarvis', backlogItemId: 'b1',
      snapshotRaw: '- Expand the cockpit', planningSessionId: 's1', now: 'T0',
    }));
    const out = await runScaffoldApproval(makeSession({ promotionId: 'p1' }), h.deps);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.promotion).toBe('mark-source-error');
    expect(h.writes).toHaveLength(0);
    expect(h.appended.map((p) => p.state)).toEqual(['scaffolded', 'mark-source-error']);
  });
});

describe('runScaffoldApproval — failures', () => {
  it('rejects a not-repo-backed product before scaffolding', async () => {
    const h = makeHarness({
      readRegistry: () => ({ version: 1, builtAt: '', products: [{ name: 'jarvis', repoBacked: false, projects: [] }] }),
    });
    const out = await runScaffoldApproval(makeSession(), h.deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('target');
  });

  it('records scaffold-error on a linked promotion when the agent fails', async () => {
    const h = makeHarness({ runAgent: async () => ({ text: null, error: 'boom' }) });
    h.promotions.set('p1', createPromotion({
      id: 'p1', product: 'jarvis', backlogItemId: 'b1',
      snapshotRaw: '- idea', planningSessionId: 's1', now: 'T0',
    }));
    const out = await runScaffoldApproval(makeSession({ promotionId: 'p1' }), h.deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('agent');
    expect(h.appended.map((p) => p.state)).toEqual(['scaffold-error']);
  });

  it('fails verification when no new project dir and no scaffold-result block', async () => {
    const h = makeHarness({
      runAgent: async () => ({ text: 'I have some questions first...', error: null }),
      listProjectDirs: () => new Set<string>(), // nothing landed
    });
    const out = await runScaffoldApproval(makeSession(), h.deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('verify');
      expect(out.agentText).toContain('questions');
    }
  });

  it('fails verification when the project dir lacks required files', async () => {
    const h = makeHarness({ fileExists: () => false });
    const out = await runScaffoldApproval(makeSession(), h.deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('verify');
  });

  it('rejects a repo path that escapes the workspace root', async () => {
    const h = makeHarness({
      readProductsConfig: () => ({
        jarvis: { repoPath: '/elsewhere/jarvis', baseBranch: 'main', credentialsFile: '', egressAllowlist: [] },
      }),
    });
    const out = await runScaffoldApproval(makeSession(), h.deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('target');
  });
});

describe('retryPromotionMarkSource', () => {
  it('returns unknown-promotion when the id is not in the log', async () => {
    const h = makeHarness();
    const out = await retryPromotionMarkSource('nope', h.deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('unknown-promotion');
  });

  it('returns not-retryable for a non-error promotion', async () => {
    const h = makeHarness();
    h.promotions.set('p1', createPromotion({
      id: 'p1', product: 'jarvis', backlogItemId: 'b1',
      snapshotRaw: '- idea', planningSessionId: 's1', now: 'T0',
    }));
    const out = await retryPromotionMarkSource('p1', h.deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('not-retryable');
  });

  it('re-marks a mark-source-error promotion and reaches marked-source (does not re-scaffold)', async () => {
    const h = makeHarness({}, '- Expand the cockpit\n');
    const base = createPromotion({
      id: 'p1', product: 'jarvis', backlogItemId: 'b1',
      snapshotRaw: '- Expand the cockpit', planningSessionId: 's1', now: 'T0',
    });
    h.promotions.set('p1', { ...base, state: 'mark-source-error', slug: SLUG, attempts: 1 });
    const out = await retryPromotionMarkSource('p1', h.deps);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.state).toBe('marked-source');
    expect(h.writes).toHaveLength(1);
    // No agent spawn on retry — only the source mark is re-attempted.
    expect(h.appended.map((p) => p.state)).toEqual(['marked-source']);
  });
});
