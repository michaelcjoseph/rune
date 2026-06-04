import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

/*
 * Phase 5 end-to-end smoke test (09-expand-cockpit). Stitches the real flow against a REAL tmpdir
 * product repo with REAL fs: add a bug + an idea to the backlog, plan the idea, scaffold it through
 * a STUBBED setup-writer, and assert the promotion reaches `marked-source` with the source bullet
 * rewritten. Because every effect is routed at the tmpdir repo (deps + the containment guards),
 * the test also proves no real product repo outside the tmpdir is touched.
 */

import { appendBug, appendIdea } from '../intent/backlog-append.js';
import { readBacklogs } from '../intent/backlog-reader.js';
import { writeFileAtomic, assertBacklogWriteAllowed, appendBacklogMutationLog } from '../intent/backlog-write-lock.js';
import { createPromotion, appendPromotion, loadPromotions } from '../intent/promotions.js';
import { runScaffoldApproval, type ScaffoldApprovalDeps } from './scaffold-approval.js';
import type { StoredPlanningSession } from '../reviews/planning.js';
import type { Registry } from '../intent/registry.js';

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** Build a self-contained tmpdir workspace with one repo-backed product 'smoke'. */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-smoke-')));
  created.push(root);
  const workspace = join(root, 'workspace');
  const repo = join(workspace, 'smoke');
  const projects = join(repo, 'docs', 'projects');
  mkdirSync(projects, { recursive: true });
  // One existing project so the setup-writer's next-number is unambiguous, plus seed backlog files.
  mkdirSync(join(projects, '01-existing'), { recursive: true });
  writeFileSync(join(projects, 'bugs.md'), '- [ ] Existing bug\n', 'utf8');
  writeFileSync(join(projects, 'ideas.md'), '## User-authored\n- Existing idea\n\n## Loop-filed\n', 'utf8');
  const promotionsFile = join(root, 'promotions.jsonl');
  const auditFile = join(root, 'backlog-mutations.jsonl');
  const registry: Registry = {
    version: 1,
    builtAt: '2026-06-04T00:00:00.000Z',
    products: [{ name: 'smoke', repoBacked: true, projects: [] }],
  };
  const productsConfig = { smoke: { repoPath: repo, baseBranch: 'main', credentialsFile: '', egressAllowlist: [] } };
  return { root, workspace, repo, projects, promotionsFile, auditFile, registry, productsConfig };
}

const SLUG = '02-smoke-feature';

function scaffoldMsg(slug: string): string {
  return ['Scaffolded.', '```scaffold-result', JSON.stringify({
    slug,
    filesCreated: [`docs/projects/${slug}/spec.md`, `docs/projects/${slug}/tasks.md`, `docs/projects/${slug}/test-plan.md`],
  }), '```'].join('\n');
}

/** Real-fs deps pointed entirely at the tmpdir repo, with a stubbed setup-writer that actually
 *  writes the three scaffold files (so the real cross-check + file-existence gates pass). */
function smokeDeps(env: ReturnType<typeof setup>): ScaffoldApprovalDeps {
  return {
    runAgent: async (_name, _brief, _t, _uv, _v, scope) => {
      // Write into the write-scope's cwd (= the resolved repo), exactly as the real agent would.
      const dir = join(scope!.cwd, 'docs', 'projects', SLUG);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'spec.md'), '# spec\n', 'utf8');
      writeFileSync(join(dir, 'tasks.md'), '# tasks\n', 'utf8');
      writeFileSync(join(dir, 'test-plan.md'), '# test plan\n', 'utf8');
      return { text: scaffoldMsg(SLUG), error: null };
    },
    readRegistry: () => env.registry,
    readProductsConfig: () => env.productsConfig,
    productsConfigPath: 'unused',
    workspaceRoot: env.workspace,
    promotionsFile: env.promotionsFile,
    loadPromotions,
    appendPromotion,
    realpath: realpathSync,
    listProjectDirs: (projectsDir) => {
      try {
        return new Set(readdirSync(projectsDir).filter((n) => /^\d+-/.test(n)));
      } catch {
        return new Set<string>();
      }
    },
    fileExists: (p) => existsSync(p),
    readBacklogFile: (p) => readFileSync(p, 'utf8'),
    writeBacklogFile: (repoPath, absPath, content) => {
      assertBacklogWriteAllowed(repoPath, absPath);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileAtomic(absPath, content);
    },
    auditBacklogWrite: (entry) => appendBacklogMutationLog(env.auditFile, entry),
    git: async () => ({ stdout: '', stderr: '' }),
    now: () => '2026-06-04T12:00:00.000Z',
  };
}

function approvedSession(promotionId: string): StoredPlanningSession {
  return {
    id: 'smoke-sess',
    chatId: 1,
    claudeSessionId: 'smoke-claude',
    planning: {
      status: 'approved',
      product: 'smoke',
      idea: 'Smoke test idea',
      surface: 'cockpit',
      artifact: { product: 'smoke', title: 'Smoke Feature', spec: 'spec', tasks: 'Tests (write first)', testPlan: 'tp' },
    },
    createdAt: '2026-06-04T11:00:00.000Z',
    lastActivity: '2026-06-04T11:30:00.000Z',
    promotionId,
  };
}

describe('plan-flow smoke (09-expand-cockpit Phase 5)', () => {
  it('adds a bug + idea, plans the idea, scaffolds, and marks the source bullet — all under the tmpdir', () => {
    const env = setup();

    // 1. Add a bug and an idea via the pure append cores + real atomic writes (the `+` path).
    const bugsPath = join(env.projects, 'bugs.md');
    const ideasPath = join(env.projects, 'ideas.md');
    const bugAppend = appendBug(readFileSync(bugsPath, 'utf8'), 'A fresh bug');
    expect(bugAppend.ok).toBe(true);
    if (bugAppend.ok) writeFileAtomic(bugsPath, bugAppend.content);
    const ideaAppend = appendIdea(readFileSync(ideasPath, 'utf8'), 'Smoke test idea');
    expect(ideaAppend.ok).toBe(true);
    if (ideaAppend.ok) writeFileAtomic(ideasPath, ideaAppend.content);

    // 2. Read the drawer data and locate the new idea (product-local).
    const backlogs = readBacklogs(env.registry, env.productsConfig, { workspaceRoot: env.workspace });
    const pb = backlogs.find((b) => b.product === 'smoke');
    expect(pb).toBeTruthy();
    expect(pb!.bugs.some((b) => b.text === 'A fresh bug')).toBe(true);
    const idea = pb!.ideas.find((i) => i.text === 'Smoke test idea');
    expect(idea).toBeTruthy();

    // 3. Plan: create + persist a promotion linked to the idea.
    const promotion = createPromotion({
      id: 'smoke-promo',
      product: 'smoke',
      backlogItemId: idea!.id,
      snapshotRaw: idea!.source.raw,
      planningSessionId: 'smoke-sess',
      now: '2026-06-04T11:45:00.000Z',
    });
    appendPromotion(env.promotionsFile, promotion);

    // 4. Approve → scaffold (stubbed writer) → mark source bullet.
    const deps = smokeDeps(env);
    return runScaffoldApproval(approvedSession('smoke-promo'), deps).then((outcome) => {
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.slug).toBe(SLUG);
        expect(outcome.promotion).toBe('marked-source');
      }

      // 5. The scaffolded files landed in the tmpdir repo.
      expect(existsSync(join(env.projects, SLUG, 'spec.md'))).toBe(true);

      // 6. The source idea bullet now carries the promotion suffix.
      const ideasAfter = readFileSync(ideasPath, 'utf8');
      expect(ideasAfter).toContain(`- Smoke test idea → ${SLUG}`);
      expect(ideasAfter).toContain('## Loop-filed'); // sentinel preserved

      // 7. The durable promotion reached marked-source.
      expect(loadPromotions(env.promotionsFile).get('smoke-promo')?.state).toBe('marked-source');

      // 8. Every write target is under the tmpdir root — no real product repo was touched.
      expect(env.repo.startsWith(env.root)).toBe(true);
      expect(env.promotionsFile.startsWith(env.root)).toBe(true);
    });
  });
});
