/**
 * Scaffold-approval runtime (09-expand-cockpit, Phase 4).
 *
 * The shared engine behind both approval surfaces — `/approve` (`src/bot/commands/approve.ts`) and
 * the webview approve route (`handleApiPlanningApprove`). It turns an APPROVED planning session into
 * scaffolded project files and, when the session was opened from a backlog Plan click (it carries a
 * `promotionId`), drives the durable promotion job through `scaffolded → marked-source`.
 *
 * The flow (all effects injected via {@link ScaffoldApprovalDeps} so the unit test never touches
 * real git/fs/agent):
 *  1. Resolve the session's product to a target repo via `resolveScaffoldTarget` (products.json) —
 *     rune is just another product, never a hard-coded default. Reject unknown/not-repo-backed.
 *  2. Canonicalize the repo path (realpath) and require it under `$WORKSPACE_ROOT` — the security
 *     containment the scaffold-target module deferred to this wiring task.
 *  3. Snapshot the target repo's `docs/projects/`, spawn `project-setup-writer` with a write-scope
 *     into that repo and a brief naming it, re-snapshot.
 *  4. Cross-check the agent's `scaffold-result` block (PRIMARY) against the directory diff
 *     (FALLBACK) and confirm the three project files landed on disk — the silent-agent-failure
 *     backstop that motivated this whole project.
 *  5. If linked to a promotion: advance it to `scaffolded(slug)`, rewrite the source backlog bullet
 *     by snapshot match, and advance to `marked-source` (or `mark-source-error` / `scaffold-error`
 *     on the respective failures). A promotion record is the restart-replay source of truth, so its
 *     append failures propagate.
 *
 * The outcome is a discriminated union the thin call sites map to a chat reply / HTTP response and
 * a session delete-vs-keep decision (success deletes; any failure leaves the session approved for
 * retry — never lose the spec).
 *
 * See docs/projects/09-expand-cockpit/spec.md §"Promotion lifecycle" / §"Scaffold contract change".
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runAgent as realRunAgent } from '../ai/claude.js';
import config from '../config.js';
import { isContainedIn } from '../intent/sandbox.js';
import { buildSetupWriterBrief, type SpecArtifact } from '../intent/planner.js';
import { resolveScaffoldTarget, scaffoldWriteScope } from '../intent/scaffold-target.js';
import { parseScaffoldResult, crossCheckScaffold } from '../intent/scaffold-result.js';
import { markBacklogItemDone } from '../intent/backlog-mark-done.js';
import type { BacklogKind } from '../intent/backlog-id.js';
import {
  appendPromotion,
  canRetryMarkSource,
  loadPromotions,
  transitionPromotion,
  type Promotion,
} from '../intent/promotions.js';
import {
  appendBacklogMutationLog,
  assertBacklogWriteAllowed,
  withFileLock,
  writeFileAtomic,
} from '../intent/backlog-write-lock.js';
import { readRegistry, type Registry } from '../intent/registry.js';
import { readProductsConfig, defaultRunGit, type GitRunner } from './sandbox-runtime.js';
import { ROLE_NAMES } from '../roles/loader.js';
import type { StoredPlanningSession } from '../reviews/planning.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('scaffold-approval');

/** The three files a scaffolded project must contain. */
const REQUIRED_FILES = ['spec.md', 'tasks.md', 'test-plan.md'] as const;
const PROJECT_DIR_PATTERN = /^\d+-/;

/** Outcome of an approval scaffold run. `ok` deletes the session; any failure leaves it approved
 *  for retry. `promotion` reports how the linked promotion ended (absent when the session carried
 *  no `promotionId`). */
export type ScaffoldApprovalOutcome =
  | {
      ok: true;
      slug: string;
      /** Raw agent reply text to surface to the user. */
      agentText: string;
      /** Linked-promotion result, if any. `mark-source-error` means the project scaffolded but the
       *  source bullet rewrite failed — retryable via the promotions retry endpoint. */
      promotion?: 'marked-source' | 'mark-source-error' | 'none';
    }
  | {
      ok: false;
      /** Coarse failure stage for the caller's message wording. */
      reason: 'target' | 'agent' | 'verify';
      /** Human-readable, UNSANITIZED message — the caller scrubs absolute paths before display. */
      message: string;
      /** Agent reply text when the failure is post-agent (verify), so the caller can echo it. */
      agentText?: string;
    };

/** Injectable effects — production wires {@link defaultScaffoldApprovalDeps}; the test injects fakes. */
export interface ScaffoldApprovalDeps {
  runAgent: typeof realRunAgent;
  readRegistry: () => Registry;
  readProductsConfig: (path: string) => ReturnType<typeof readProductsConfig>;
  productsConfigPath: string;
  /** `$WORKSPACE_ROOT` for the repo-containment guard; when undefined the guard is skipped (the
   *  same fail-open posture as a workspace-less config — resolveScaffoldTarget already gated the
   *  product). */
  workspaceRoot?: string;
  promotionsFile: string;
  loadPromotions: typeof loadPromotions;
  appendPromotion: typeof appendPromotion;
  /** Canonicalize a path (realpath). Injected so the test can model symlinks deterministically. */
  realpath: (p: string) => string;
  /** List `NN-slug` project directory names under a `docs/projects/` dir. */
  listProjectDirs: (projectsDir: string) => Set<string>;
  /** Whether a scaffolded project file exists on disk. */
  fileExists: (p: string) => boolean;
  /** Read a backlog file's content. */
  readBacklogFile: (p: string) => string;
  /** Atomically write a backlog file (temp-then-rename), after the allow-list guard. */
  writeBacklogFile: (repoPath: string, absPath: string, content: string) => void;
  /** Atomically write a project artifact file (tech-spec.md / context.md) into the
   *  freshly-scaffolded slug dir. The path is deterministically constructed from the
   *  verified slug dir, so no allow-list guard is needed (project 14). */
  writeProjectFile: (absPath: string, content: string) => void;
  /** Append a backlog-mutation audit entry (best-effort). */
  auditBacklogWrite: (entry: {
    product: string;
    file: string;
    branch: string;
    dirty: boolean;
    before: string;
    after: string;
  }) => void;
  git: GitRunner;
  now: () => string;
}

/** List the `NN-slug` project dirs under `projectsDir`; errors collapse to empty (the "no new dir"
 *  failure mode is what verification keys on). Mirrors the helper that lived in approve.ts. */
function defaultListProjectDirs(projectsDir: string): Set<string> {
  try {
    return new Set(
      readdirSync(projectsDir)
        .filter((name) => PROJECT_DIR_PATTERN.test(name))
        .filter((name) => {
          try {
            return statSync(join(projectsDir, name)).isDirectory();
          } catch {
            return false;
          }
        }),
    );
  } catch {
    return new Set();
  }
}

/** Production deps — real agent spawn, fs, git, and promotion log. A FACTORY (not a module-level
 *  const) so the imported bindings (`defaultRunGit`, config getters, …) are only dereferenced when
 *  the real flow runs, not at module-load. That keeps `webview.ts`/`approve.ts` importable in tests
 *  that partially mock `sandbox-runtime` etc. without the literal eagerly touching every export. */
export function defaultScaffoldApprovalDeps(): ScaffoldApprovalDeps {
  return {
    runAgent: realRunAgent,
    readRegistry,
    readProductsConfig,
    productsConfigPath: config.PRODUCTS_CONFIG_FILE,
    workspaceRoot: config.WORKSPACE_DIR,
    promotionsFile: config.PROMOTIONS_FILE,
    loadPromotions,
    appendPromotion,
    realpath: (p) => realpathSync(p),
    listProjectDirs: defaultListProjectDirs,
    fileExists: (p) => existsSync(p),
    readBacklogFile: (p) => readFileSync(p, 'utf8'),
    writeBacklogFile: (repoPath, absPath, content) => {
      assertBacklogWriteAllowed(repoPath, absPath);
      mkdirSync(join(repoPath, 'docs', 'projects'), { recursive: true });
      writeFileAtomic(absPath, content);
    },
    writeProjectFile: (absPath, content) => {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileAtomic(absPath, content);
    },
    auditBacklogWrite: (entry) => {
      try {
        appendBacklogMutationLog(config.BACKLOG_MUTATIONS_FILE, entry);
      } catch {
        // best-effort audit — never block the promotion on an audit-log failure
      }
    },
    git: defaultRunGit,
    now: () => new Date().toISOString(),
  };
}

/**
 * Write the role-flow artifacts (tech spec + seeded context + per-project
 * exemplars) into the scaffolded
 * project dir (project 14). Each is optional — legacy single-shot proposals carry
 * none, so this is a no-op for them. `context.md` is Rune-owned orchestration
 * state seeded at planning time, and exemplars are tech-lead planning output;
 * writing both here (not via the setup-writer agent) keeps those artifacts
 * deterministic once the project slug is verified.
 */
function writeRoleArtifacts(
  artifact: SpecArtifact | undefined,
  projectDir: string,
  deps: ScaffoldApprovalDeps,
): void {
  if (!artifact) return;
  if (artifact.techSpec) {
    deps.writeProjectFile(join(projectDir, 'tech-spec.md'), artifact.techSpec);
  }
  if (artifact.context) {
    deps.writeProjectFile(join(projectDir, 'context.md'), artifact.context);
  }
  if (artifact.perProjectExemplars) {
    for (const role of ROLE_NAMES) {
      const body = artifact.perProjectExemplars[role];
      if (typeof body === 'string' && body.trim()) {
        deps.writeProjectFile(join(projectDir, 'examples', `${role}.md`), body);
      }
    }
  }
}

/** Infer the backlog kind from a snapshot line: a leading `- [ ]`/`- [x]` checkbox is a bug;
 *  anything else is an idea. Matches `backlog-parser`'s own bug/idea distinction — the `Promotion`
 *  record intentionally stores no `kind`, so it is recovered here at mark-source time. */
function inferKind(snapshotRaw: string): BacklogKind {
  return /^- \[[ xX]\] /.test(snapshotRaw) ? 'bugs' : 'ideas';
}

/** Resolve and security-check the target repo for a product. */
function resolveTargetRepo(
  product: string,
  deps: ScaffoldApprovalDeps,
): { ok: true; repoPath: string } | { ok: false; message: string } {
  let registry: Registry;
  try {
    registry = deps.readRegistry();
  } catch (err) {
    return { ok: false, message: `registry unavailable: ${(err as Error).message}` };
  }
  let productsConfig: ReturnType<typeof readProductsConfig>;
  try {
    productsConfig = deps.readProductsConfig(deps.productsConfigPath);
  } catch (err) {
    return { ok: false, message: `products config unreadable: ${(err as Error).message}` };
  }

  const target = resolveScaffoldTarget(product, registry, productsConfig);
  if (!target.ok) {
    return { ok: false, message: `product '${product}' is ${target.error}` };
  }

  // Canonicalize and require containment under $WORKSPACE_ROOT — the deferred security guard.
  let real: string;
  try {
    real = deps.realpath(target.repoPath);
  } catch (err) {
    return { ok: false, message: `target repo path unresolvable: ${(err as Error).message}` };
  }
  if (deps.workspaceRoot && !isContainedIn(deps.realpath(deps.workspaceRoot), real)) {
    return {
      ok: false,
      message: `target repo ${product} escapes the workspace root — refusing to scaffold`,
    };
  }
  return { ok: true, repoPath: real };
}

/**
 * Run the scaffold-approval flow for an APPROVED session. Pure of decision-making; all I/O is via
 * `deps`. Never throws for an expected failure (returns `{ ok: false }`). The `appendPromotion`
 * calls inside `drivePromotion` (the happy-path transitions) are allowed to propagate — the
 * promotion log is the restart-replay source of truth — whereas the terminal `scaffold-error`
 * append in `failPromotion` is best-effort (wrapped), so a log issue can't mask a scaffold failure.
 */
export async function runScaffoldApproval(
  session: StoredPlanningSession,
  deps: ScaffoldApprovalDeps = defaultScaffoldApprovalDeps(),
): Promise<ScaffoldApprovalOutcome> {
  const target = resolveTargetRepo(session.planning.product, deps);
  if (!target.ok) {
    failPromotion(session, deps, target.message);
    return { ok: false, reason: 'target', message: target.message };
  }
  const repoPath = target.repoPath;
  const projectsDir = join(repoPath, 'docs', 'projects');

  const before = deps.listProjectDirs(projectsDir);
  const brief = buildSetupWriterBrief(session.planning, repoPath);
  const scope = scaffoldWriteScope(repoPath);

  const agent = await deps.runAgent('project-setup-writer', brief, undefined, true, false, scope);
  if (agent.error || !agent.text) {
    const message = `scaffolding failed: ${agent.error ?? 'empty output'}`;
    failPromotion(session, deps, message);
    return { ok: false, reason: 'agent', message };
  }

  // Cross-check the structured block (PRIMARY) against the dir diff (FALLBACK).
  const after = deps.listProjectDirs(projectsDir);
  const newDirs = [...after].filter((d) => !before.has(d));
  const parsed = parseScaffoldResult(agent.text);
  const check = crossCheckScaffold(parsed, newDirs);
  if (!check.ok) {
    const message = `scaffold verification failed: ${check.error}`;
    failPromotion(session, deps, message);
    return { ok: false, reason: 'verify', message, agentText: agent.text };
  }
  const slug = check.slug;

  // The three project files must actually be on disk — the load-bearing silent-failure backstop.
  const missing = REQUIRED_FILES.filter((f) => !deps.fileExists(join(projectsDir, slug, f)));
  if (missing.length > 0) {
    const message = `scaffold verification failed: new project ${slug} is missing required files: ${missing.join(', ')}`;
    failPromotion(session, deps, message);
    return { ok: false, reason: 'verify', message, agentText: agent.text };
  }

  // Project 14: when planning ran the PM/tech-lead role flow, the artifact carries
  // a tech spec, a Rune-seeded context.md, and possibly per-project role
  // exemplars. Write them DETERMINISTICALLY here — never via the setup-writer
  // agent — so role/context artifacts do not depend on agent formatting.
  writeRoleArtifacts(session.planning.artifact, join(projectsDir, slug), deps);

  // No linked promotion — a plain /plan session. Scaffold succeeded; nothing else to drive.
  if (!session.promotionId) {
    return { ok: true, slug, agentText: agent.text, promotion: 'none' };
  }

  const promotionResult = await drivePromotion(session.promotionId, repoPath, slug, deps);
  return { ok: true, slug, agentText: agent.text, promotion: promotionResult };
}

/** Result of an explicit mark-source retry (POST /api/promotions/:id/retry). On success the final
 *  promotion fields are carried so the caller needn't re-read the log. (`drivePromotion`'s `'none'`
 *  can't occur here — the promotion is fetched and guarded before the drive.) */
export type RetryOutcome =
  | { ok: true; state: 'marked-source' | 'mark-source-error'; slug?: string; errors: string[] }
  | { ok: false; error: 'unknown-promotion' | 'not-retryable' | 'target'; message?: string };

/**
 * Re-attempt the source-bullet marking for a `mark-source-error` promotion (the explicit retry
 * endpoint / cockpit button). Idempotent: `markBacklogItemDone` is a byte-equal no-op against
 * already-promoted content. Refuses anything that isn't a retryable `mark-source-error` under the
 * attempt cap. Does NOT re-scaffold — the project files already exist; only the source mark is retried.
 */
export async function retryPromotionMarkSource(
  promotionId: string,
  deps: ScaffoldApprovalDeps = defaultScaffoldApprovalDeps(),
): Promise<RetryOutcome> {
  const promotion = deps.loadPromotions(deps.promotionsFile).get(promotionId);
  if (!promotion) return { ok: false, error: 'unknown-promotion' };
  if (!canRetryMarkSource(promotion) || !promotion.slug) {
    return { ok: false, error: 'not-retryable' };
  }
  const target = resolveTargetRepo(promotion.product, deps);
  if (!target.ok) return { ok: false, error: 'target', message: target.message };
  const state = await drivePromotion(promotionId, target.repoPath, promotion.slug, deps);
  // `state` is the drive result; re-read once for the final slug/errors the caller surfaces.
  const after = deps.loadPromotions(deps.promotionsFile).get(promotionId);
  return {
    ok: true,
    state: state === 'none' ? 'mark-source-error' : state,
    slug: after?.slug ?? promotion.slug,
    errors: after?.errors ?? promotion.errors,
  };
}

/** Capture the target repo's branch + dirty flag for the audit log (best-effort — failure yields a
 *  placeholder rather than blocking the write). Mirrors the webview append path's getBacklogGitState. */
async function captureGitState(
  repoPath: string,
  git: GitRunner,
): Promise<{ branch: string; dirty: boolean }> {
  try {
    const [b, s] = await Promise.all([
      git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath }),
      git(['status', '--porcelain'], { cwd: repoPath }),
    ]);
    return { branch: b.stdout.trim() || 'unknown', dirty: s.stdout.trim() !== '' };
  } catch {
    return { branch: 'unknown', dirty: false };
  }
}

/** Advance a linked promotion to `scaffolded` then rewrite the source bullet and advance to
 *  `marked-source`. Returns the terminal promotion disposition. */
async function drivePromotion(
  promotionId: string,
  repoPath: string,
  slug: string,
  deps: ScaffoldApprovalDeps,
): Promise<'marked-source' | 'mark-source-error' | 'none'> {
  const promotions = deps.loadPromotions(deps.promotionsFile);
  const existing = promotions.get(promotionId);
  if (!existing) {
    // The session referenced a promotion that isn't in the log — scaffold still succeeded, so this
    // is a soft inconsistency, not a scaffold failure. Log and move on.
    log.warn('drivePromotion: promotion not found in log; skipping source-marking', { promotionId });
    return 'none';
  }

  // Advance to scaffolded only from planning-started. A promotion already at `scaffolded` (restart
  // resume) or at `mark-source-error` (explicit retry) is past that edge and keeps its captured
  // slug — skip straight to the source-marking step rather than attempting an illegal re-advance.
  let promotion: Promotion = existing;
  if (promotion.state !== 'scaffolded' && promotion.state !== 'mark-source-error') {
    const sc = transitionPromotion(promotion, 'scaffolded', { slug, now: deps.now() });
    if (!sc.ok) {
      log.warn('drivePromotion: could not advance to scaffolded', { promotionId, reason: sc.reason });
      return 'none';
    }
    promotion = sc.promotion;
    deps.appendPromotion(deps.promotionsFile, promotion);
  }

  const kind = inferKind(promotion.snapshotRaw);
  const fileName = kind === 'bugs' ? 'bugs.md' : 'ideas.md';
  const absPath = join(repoPath, 'docs', 'projects', fileName);

  // Serialize the read→rewrite→write per file with the same mutex the `+` add path uses, so a
  // concurrent backlog write can't interleave with the snapshot-match rewrite.
  const result = await withFileLock(absPath, async () => {
    let content: string;
    try {
      content = deps.readBacklogFile(absPath);
    } catch (err) {
      return { kind: 'error' as const, reason: `backlog file unreadable: ${(err as Error).message}` };
    }
    const marked = markBacklogItemDone(content, kind, promotion.snapshotRaw, slug);
    if (!marked.matched) {
      return { kind: 'error' as const, reason: `source bullet ${marked.reason}` };
    }
    // Idempotent retry: already-promoted content is a byte-equal no-op — skip the write but still
    // advance to marked-source so the promotion completes.
    if (marked.newText !== content) {
      const git = await captureGitState(repoPath, deps.git);
      try {
        deps.writeBacklogFile(repoPath, absPath, marked.newText);
      } catch (err) {
        return { kind: 'error' as const, reason: `backlog write failed: ${(err as Error).message}` };
      }
      deps.auditBacklogWrite({
        product: promotion.product,
        file: join('docs', 'projects', fileName),
        branch: git.branch,
        dirty: git.dirty,
        before: content,
        after: marked.newText,
      });
    }
    return { kind: 'ok' as const };
  });

  if (result.kind === 'error') {
    const errored = transitionPromotion(promotion, 'mark-source-error', {
      error: result.reason,
      now: deps.now(),
    });
    if (errored.ok) deps.appendPromotion(deps.promotionsFile, errored.promotion);
    return 'mark-source-error';
  }

  const done = transitionPromotion(promotion, 'marked-source', { now: deps.now() });
  if (done.ok) deps.appendPromotion(deps.promotionsFile, done.promotion);
  return 'marked-source';
}

/** Append a terminal `scaffold-error` to a linked promotion (best-effort — a scaffold failure
 *  shouldn't be masked by a promotion-log issue). No-op when the session has no promotion. */
function failPromotion(
  session: StoredPlanningSession,
  deps: ScaffoldApprovalDeps,
  reason: string,
): void {
  if (!session.promotionId) return;
  try {
    const promotions = deps.loadPromotions(deps.promotionsFile);
    const promotion = promotions.get(session.promotionId);
    if (!promotion) return;
    const t = transitionPromotion(promotion, 'scaffold-error', { error: reason, now: deps.now() });
    if (t.ok) deps.appendPromotion(deps.promotionsFile, t.promotion);
  } catch (err) {
    log.warn('failPromotion: could not record scaffold-error', {
      promotionId: session.promotionId,
      error: (err as Error).message,
    });
  }
}
