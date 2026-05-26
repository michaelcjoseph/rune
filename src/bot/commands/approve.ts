/**
 * `/approve` — approve a planning session's proposed spec and scaffold the
 * project. Project 08-intent-layer Phase 6 A4.4.
 *
 * Two entry conditions:
 * 1. Session in `spec-proposed` — normal path. Transitions `spec-proposed →
 *    approved` via the pure state machine (`approveActivePlanningSession`),
 *    then scaffolds via the `project-setup-writer` agent.
 * 2. Session already in `approved` — retry path. The previous /approve
 *    transitioned the lifecycle but the agent failed (network, CLI crash,
 *    etc.) leaving the session approved-but-unscaffolded. Pick it up from
 *    `getPlanningSession` (which doesn't filter terminal states like the
 *    routing-priority probe does) and re-run the scaffolding.
 *
 * The session is deleted on agent success; on agent failure the session
 * stays in `approved` so /approve can pick it up again without re-scoping.
 *
 * Inline-keyboard approval (Track C6) lands later. Until then, `/approve`
 * is the explicit slash gate the spec-proposed reply tells the user to use.
 * The command is intentionally not resolver-routable — approval is an
 * explicit gate, never inferred from free-form text.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageSender } from '../../transport/sender.js';
import { runAgent } from '../../ai/claude.js';
import config, { PROJECT_ROOT } from '../../config.js';
import { buildSetupWriterBrief } from '../../intent/planner.js';
import {
  approveActivePlanningSession,
  deletePlanningSession,
  getPlanningSession,
  type StoredPlanningSession,
} from '../../reviews/planning.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cmd-approve');

export async function handleApprove(sender: MessageSender, userId: number): Promise<void> {
  // Retry path first — if a previous /approve left the session in `approved`
  // (scaffold failed mid-run), pick it up directly. getActivePlanningSession
  // filters terminal states, so we use the unfiltered getPlanningSession.
  const existing = getPlanningSession(userId);
  if (existing?.planning.status === 'approved') {
    log.info('Approve retry path — re-scaffolding already-approved session', { userId });
    await scaffoldAndDelete(sender, userId, existing);
    return;
  }

  // Normal path — transition spec-proposed → approved via the state machine.
  const result = approveActivePlanningSession(userId);
  if (!result.ok) {
    // The only status that reaches `wrong-status` is `'scoping'`: terminal
    // states (`approved` / `abandoned`) are filtered by
    // `getActivePlanningSession` inside `approveActivePlanningSession`, and
    // the `approved` retry path was handled above. The exhaustive switch
    // documents the invariant.
    switch (result.reason) {
      case 'no-session':
        await sender.send(userId, 'Nothing to approve — no active planning session.');
        return;
      case 'wrong-status':
        await sender.send(
          userId,
          'No spec proposed yet — keep scoping until Jarvis proposes one.',
        );
        return;
    }
  }

  // spec-proposed → approved transition succeeded.
  await scaffoldAndDelete(sender, userId, result.session);
}

/** Invoke project-setup-writer for an `approved` session and delete the
 *  session on success. On agent failure (or scaffold-verification failure)
 *  the session is left intact so the retry path in `handleApprove` can
 *  pick it up.
 *
 *  Scaffold verification (the off-process backstop against agents that
 *  return success text but write no files — see
 *  docs/projects/08-intent-layer/agent-lessons.md): snapshot the project
 *  directories on disk before runAgent, re-list after, demand exactly one
 *  new `NN-<slug>` directory containing spec.md, tasks.md, and
 *  test-plan.md. Without this check, an agent that hallucinates "I
 *  scaffolded it" reaches the delete-session line and the spec is lost. */
async function scaffoldAndDelete(
  sender: MessageSender,
  userId: number,
  session: StoredPlanningSession,
): Promise<void> {
  const brief = buildSetupWriterBrief(session.planning);
  log.info('Dispatching project-setup-writer', {
    userId,
    product: session.planning.product,
  });

  const projectsDir = join(PROJECT_ROOT, 'docs', 'projects');
  const beforeDirs = listProjectDirs(projectsDir);

  // The op-tracker registered inside runAgent is the canonical progress
  // surface for agent ops on Telegram — no extra startTyping needed here.
  const agentResult = await runAgent('project-setup-writer', brief);
  if (agentResult.error || !agentResult.text) {
    log.error('project-setup-writer failed; session left approved for retry', {
      userId,
      error: agentResult.error ?? 'empty output',
    });
    await sender.send(
      userId,
      `Scaffolding failed: ${sanitizeAgentError(agentResult.error ?? 'empty output')}\n\n` +
        `Planning session is still approved — run /approve again to retry.`,
    );
    return;
  }

  // Verify the agent actually wrote files. The setup-writer prompt
  // tightening (Fix 3) reduces the chance of this firing in practice, but
  // it's the load-bearing backstop — without it, the agent's mere text
  // reply is enough to delete the session and lose the spec.
  const verification = verifyScaffoldLanded(projectsDir, beforeDirs);
  if (!verification.ok) {
    log.error(
      'project-setup-writer ran but no project scaffolded; session left approved for retry',
      {
        userId,
        verification,
        agentTextHead: agentResult.text.slice(0, 500),
      },
    );
    await sender.send(
      userId,
      `Scaffold verification failed: ${describeVerificationFailure(verification)}\n\n` +
        `Agent reply:\n${agentResult.text}\n\n` +
        `Planning session is still approved — run /approve again to retry.`,
    );
    return;
  }

  await sender.send(userId, agentResult.text);
  deletePlanningSession(userId);
  log.info('Project scaffolded; planning session deleted', {
    userId,
    slug: verification.slug,
  });
}

const PROJECT_DIR_PATTERN = /^\d+-/;

/** Returns the set of `NN-slug` project directories currently under
 *  `projectsDir`. Errors (missing directory, permission, etc.) collapse
 *  to an empty set — verification still works because "no new dir" is
 *  the failure mode we care about. */
function listProjectDirs(projectsDir: string): Set<string> {
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

type ScaffoldVerification =
  | { ok: true; slug: string }
  | { ok: false; reason: 'no-new-dir' }
  | { ok: false; reason: 'missing-files'; slug: string; missing: string[] };

/** Verify the project-setup-writer agent actually wrote files. Demand
 *  exactly one new `NN-slug` directory under `projectsDir` that contains
 *  spec.md, tasks.md, and test-plan.md. */
function verifyScaffoldLanded(
  projectsDir: string,
  beforeDirs: Set<string>,
): ScaffoldVerification {
  const afterDirs = listProjectDirs(projectsDir);
  const newDirs = [...afterDirs].filter((d) => !beforeDirs.has(d)).sort();
  if (newDirs.length === 0) return { ok: false, reason: 'no-new-dir' };
  // If the agent somehow created multiple new dirs, the canonical "new
  // project" is the highest-numbered one (matching project-setup-writer's
  // index-bump logic). Verify against that.
  const slug = newDirs[newDirs.length - 1]!;
  const required = ['spec.md', 'tasks.md', 'test-plan.md'];
  const missing = required.filter((f) => !existsSync(join(projectsDir, slug, f)));
  if (missing.length > 0) return { ok: false, reason: 'missing-files', slug, missing };
  return { ok: true, slug };
}

function describeVerificationFailure(v: ScaffoldVerification & { ok: false }): string {
  if (v.reason === 'no-new-dir') {
    return 'agent did not create a new docs/projects/NN-slug/ directory';
  }
  return `new project ${v.slug} is missing required files: ${v.missing.join(', ')}`;
}

/** Strip absolute paths the user shouldn't see (vault, project root,
 *  workspace) from raw agent error text before surfacing it in the chat
 *  reply. The full message is preserved in the structured log via
 *  `log.error`. */
function sanitizeAgentError(raw: string): string {
  let sanitized = raw;
  if (config.VAULT_DIR) sanitized = sanitized.split(config.VAULT_DIR).join('<vault>');
  if (PROJECT_ROOT) sanitized = sanitized.split(PROJECT_ROOT).join('<project>');
  if (config.WORKSPACE_DIR) sanitized = sanitized.split(config.WORKSPACE_DIR).join('<workspace>');
  return sanitized;
}
