/**
 * Production dependency bindings for the writing engine — the seam that made
 * `/blog` and `/writing-critique` no-ops (docs/projects/bugs.md): the commands
 * called `startWritingProductRun` without deps, so the tested pipeline never
 * ran. This module builds the real `StartWritingProductRunDeps`:
 *
 *  - worktree: `createWorktree` (sandbox-runtime) on the `writing` product's
 *    repo, branch `rune-writing/{slug}` (create-or-resume);
 *  - pkms research: IN-PROCESS dispatch to the same MCP tool handlers the
 *    daemon serves (`vault_search` / `journal_range` / `follow_wikilinks`) —
 *    the pipeline's mcp-only vault boundary without an HTTP round-trip to our
 *    own daemon. The pipeline's call shapes predate the real handlers, so the
 *    dispatcher translates (`{maxDays}` → `{startDate,endDate}`, `{query}` →
 *    `{text}`);
 *  - model: one-shot Claude calls carrying the writer SOUL (system channel) +
 *    memory fence (user turn) + the user's voice — reconnecting the project-12
 *    writer machinery orphaned when `src/reviews/blog.ts` retired;
 *  - artifacts: containment-asserted fs in the worktree; commits via raw git
 *    in the worktree (the vault/writer commit helpers are main-only and must
 *    not be used for a product feature branch).
 *
 * The core pipeline swallows stage errors into a bare `failed` result, so
 * every dep here records `{stage, message}` through `recordFailure` before
 * rethrowing — that recorded failure is what the applier surfaces as the
 * run's terminal reason.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import config from '../config.js';
import { createWorktree, defaultRunGit, type GitRunner } from './sandbox-runtime.js';
import { isContainedIn, writingSlugFromBranch, type SandboxSpec } from '../intent/sandbox.js';
import { askClaudeOneShot } from '../ai/claude.js';
import { composeWriterContext } from '../writer/memory.js';
import { loadModelPolicy, resolveModel } from '../intent/model-policy.js';
import { getTodayDate } from '../utils/time.js';
import {
  runWritingPipeline,
  type WritingPipelineDeps,
  type WritingPipelineEvent,
} from './writing-pipeline.js';
import type { StartWritingProductRunDeps } from './writing-product-orchestration.js';
import { vaultSearch } from '../mcp/tools/read-tools.js';
import { buildProductionVaultSearchDeps } from '../mcp/tools/read-tools-deps.js';
import { journalRange } from '../mcp/tools/journal-range.js';
import { buildProductionJournalRangeDeps } from '../mcp/tools/journal-range-deps.js';
import { followWikilinks } from '../mcp/tools/follow-wikilinks.js';
import { buildProductionFollowWikilinksDeps } from '../mcp/tools/follow-wikilinks-deps.js';

/** First failure a dep hit — the applier's terminal reason. The core pipeline
 *  swallows errors, so this side-channel is the only honest record. */
export interface WritingRunFailure {
  stage: string;
  message: string;
}

/** Injectable io/config seams — production callers omit everything; tests
 *  point the worktree machinery at temp paths. */
export interface WritingDepsIo {
  worktreeRoot?: string;
  productsConfigPath?: string;
  runGit?: GitRunner;
}

export interface BuildWritingPipelineDepsInput {
  worktree: string;
  emitRunState: (event: WritingPipelineEvent) => void;
  recordFailure: (f: WritingRunFailure) => void;
  /** Polled before each stage dep runs — cooperative cancel at stage
   *  boundaries (an in-flight model call runs to completion). */
  cancelRequested?: () => boolean;
}

/** Per-source char cap when research payloads are serialized into prompts —
 *  `journal_range` returns a whole month regardless of topic. */
export const MAX_RESEARCH_SOURCE_CHARS = 10_000;

const RESEARCH_TRUNCATION_MARKER = '\n…(truncated: research source exceeds prompt budget)';

// ---------------------------------------------------------------------------
// Worktree
// ---------------------------------------------------------------------------

/** Real create-or-resume worktree for `rune-writing/{slug}` on the `writing`
 *  product's repo. Returns the full SandboxSpec (structurally satisfies the
 *  deps field's `{worktree, resumed?}`); the applier keeps it for teardown. */
export async function createProductionWritingWorktree(
  input: { product: 'writing'; project: string; branch: string },
  io: WritingDepsIo = {},
): Promise<SandboxSpec> {
  return createWorktree({
    product: input.product,
    project: input.project,
    branch: input.branch,
    worktreeRoot: io.worktreeRoot ?? config.WORKTREE_ROOT,
    productsConfigPath: io.productsConfigPath ?? config.PRODUCTS_CONFIG_FILE,
    ...(io.runGit ? { runGit: io.runGit } : {}),
  });
}

// ---------------------------------------------------------------------------
// Model calls — writer SOUL + memory + voice, one shot per stage
// ---------------------------------------------------------------------------

/** Resolve the writer model from policy; undefined (→ ONESHOT_MODEL) when the
 *  policy is absent/unresolvable or resolves to a non-claude-format alias —
 *  these calls go through the Claude CLI, a codex binding cannot run them. */
export function resolveWriterModel(policyPath: string = config.MODEL_POLICY_FILE): string | undefined {
  try {
    const policy = loadModelPolicy(policyPath);
    if (!policy) return undefined;
    const resolution = resolveModel({ role: 'writer', capabilities: [] }, policy);
    const entry = policy.models.find((m) => m.alias === resolution.model);
    return entry?.format === 'claude' ? resolution.model : undefined;
  } catch {
    return undefined;
  }
}

/** Unwrap one accidental full-body ``` fence — models sometimes wrap "return
 *  only the markdown document" answers. Inner fences are content, not
 *  wrapping, and are left alone. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z-]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match?.[1] !== undefined ? match[1].trim() : trimmed;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Serialize one research payload (an McpTextResult or arbitrary shape) into
 *  bounded prompt text. */
function serializeResearchSource(value: unknown): string {
  let text = '';
  const content = (value as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    text = content
      .map((c) => asText((c as { text?: unknown })?.text))
      .filter(Boolean)
      .join('\n');
  }
  if (!text) {
    try {
      // JSON.stringify(undefined) is the VALUE undefined, not a string.
      text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
    } catch {
      text = String(value);
    }
  }
  if (text.length > MAX_RESEARCH_SOURCE_CHARS) {
    return text.slice(0, MAX_RESEARCH_SOURCE_CHARS) + RESEARCH_TRUNCATION_MARKER;
  }
  return text;
}

function researchBlock(research: unknown): string {
  const r = (research ?? {}) as Record<string, unknown>;
  const sources: Array<[string, unknown]> = [
    ['vault_search', r['vaultSearch']],
    ['journal_range', r['journalRange']],
    ['follow_wikilinks', r['wikilinks']],
  ];
  const fenced = sources
    .map(([name, value]) => `### ${name}\n\`\`\`\n${serializeResearchSource(value)}\n\`\`\``)
    .join('\n\n');
  return [
    '## Research (PRIVATE source material)',
    'This is private vault material provided for SYNTHESIS ONLY — never copy it',
    'verbatim. The published piece must not contain private identifiers, raw',
    'journal excerpts, health or psychology specifics, or third-party personal',
    'names drawn from these sources.',
    '',
    fenced,
  ].join('\n');
}

type WritingStage = 'plan' | 'draft' | 'critique' | 'revise';

const STAGE_INSTRUCTIONS: Record<WritingStage, string> = {
  plan: [
    'Stage: PLAN. Produce the outline for a public writing piece on the given topic.',
    'Return ONLY a markdown outline (nested list) — no preamble, no commentary, no code fences.',
  ].join('\n'),
  draft: [
    'Stage: DRAFT. Write the complete piece in markdown, following the outline.',
    'Return ONLY the finished document, starting with an H1 title — no preamble, no code fences.',
  ].join('\n'),
  critique: [
    'Stage: CRITIQUE. Critique the draft against your standards — argument, structure, voice, evidence.',
    'Return ONLY the critique notes as markdown — concrete, actionable, no preamble, no code fences.',
  ].join('\n'),
  revise: [
    'Stage: REVISE. Revise the draft, resolving every critique note that improves the piece.',
    'Return ONLY the complete revised markdown document, starting with an H1 title — no preamble, no code fences.',
  ].join('\n'),
};

function stagePromptBody(stage: WritingStage, input: Record<string, unknown>): string {
  const parts: string[] = [`## Topic\n${asText(input['topic'])}`];
  const routePath = asText(input['routePath']);
  if (routePath) parts.push(`Published route: ${routePath}`);
  if (asText(input['outline'])) parts.push(`## Outline\n${asText(input['outline'])}`);
  if (asText(input['markdown'])) parts.push(`## Draft\n${asText(input['markdown'])}`);
  if (asText(input['critique'])) parts.push(`## Critique notes\n${asText(input['critique'])}`);
  if ('research' in input) parts.push(researchBlock(input['research']));
  return parts.join('\n\n');
}

async function runWriterStage(stage: WritingStage, input: Record<string, unknown>): Promise<string> {
  const writer = composeWriterContext(STAGE_INSTRUCTIONS[stage]);
  const message = [writer.referenceContext, stagePromptBody(stage, input)]
    .filter(Boolean)
    .join('\n\n');
  // No opLabel: these are background calls inside a supervised mutation — an
  // in-flight-op tracker per stage would spam Telegram four times per run.
  const model = resolveWriterModel();
  const result = await askClaudeOneShot(message, config.CLAUDE_TIMEOUT_MS, undefined, true, {
    systemPrompt: writer.systemInstructions,
    ...(model ? { model } : {}),
  });
  if (result.error) throw new Error(`writer ${stage} model call failed: ${result.error}`);
  const text = stripCodeFence(result.text ?? '');
  if (!text) throw new Error(`writer ${stage} model call returned empty output`);
  return text;
}

// ---------------------------------------------------------------------------
// MCP dispatch — in-process, with input translation
// ---------------------------------------------------------------------------

function clampMaxDays(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 31;
  return Math.min(Math.floor(n), 31);
}

/** Translate the pipeline's `{query, maxDays}` into the handler's inclusive
 *  `{startDate, endDate}` window ending today (America/Chicago). */
export function journalRangeWindow(maxDays: unknown, todayIso: string = getTodayDate()): {
  startDate: string;
  endDate: string;
} {
  const days = clampMaxDays(maxDays);
  const end = new Date(`${todayIso}T00:00:00.000Z`);
  const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const iso = (d: Date) =>
    [
      String(d.getUTCFullYear()).padStart(4, '0'),
      String(d.getUTCMonth() + 1).padStart(2, '0'),
      String(d.getUTCDate()).padStart(2, '0'),
    ].join('-');
  return { startDate: iso(start), endDate: todayIso };
}

async function dispatchMcpTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  let result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
  if (name === 'vault_search') {
    result = await vaultSearch(
      {
        query: asText(input['query']),
        ...(input['maxResults'] !== undefined ? { maxResults: Number(input['maxResults']) } : {}),
      },
      buildProductionVaultSearchDeps(),
    );
  } else if (name === 'journal_range') {
    result = await journalRange(journalRangeWindow(input['maxDays']), buildProductionJournalRangeDeps());
  } else if (name === 'follow_wikilinks') {
    result = await followWikilinks(
      {
        text: asText(input['query']),
        ...(input['maxDepth'] !== undefined ? { maxDepth: Number(input['maxDepth']) } : {}),
      },
      buildProductionFollowWikilinksDeps(),
    );
  } else {
    throw new Error(`writing research: unknown MCP tool '${name}'`);
  }
  if (result.isError) {
    const text = result.content.map((c) => c.text).join('\n');
    throw new Error(`writing research: ${name} failed: ${text}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pipeline deps
// ---------------------------------------------------------------------------

/** Core `WritingPipelineDeps` bound to a live worktree. Every dep records its
 *  first failure and checks the cancel poll before starting. */
export function buildWritingPipelineDeps(input: BuildWritingPipelineDepsInput): WritingPipelineDeps {
  const { worktree, emitRunState, recordFailure, cancelRequested } = input;

  const guard = <A extends unknown[], R>(stage: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (cancelRequested?.()) {
        const message = `cancelled by user before ${stage}`;
        recordFailure({ stage, message });
        throw new Error(message);
      }
      try {
        return await fn(...args);
      } catch (err) {
        recordFailure({ stage, message: (err as Error).message });
        throw err;
      }
    };

  const resolveInWorktree = (path: string): string => {
    const abs = resolve(worktree, path);
    if (!isContainedIn(worktree, abs)) {
      throw new Error(`writing artifact path escapes the worktree: ${path}`);
    }
    return abs;
  };

  return {
    mcp: {
      callTool: guard('research', (name: string, toolInput: Record<string, unknown>) =>
        dispatchMcpTool(name, toolInput)),
    },
    model: {
      plan: guard('plan', async (i: Record<string, unknown>) => ({ outline: await runWriterStage('plan', i) })),
      draft: guard('draft', async (i: Record<string, unknown>) => ({ markdown: await runWriterStage('draft', i) })),
      critique: guard('critique', async (i: Record<string, unknown>) => ({ notes: await runWriterStage('critique', i) })),
      revise: guard('revise', async (i: Record<string, unknown>) => ({ markdown: await runWriterStage('revise', i) })),
    },
    writeArtifact: guard('write-artifact', async (path: string, content: string) => {
      const abs = resolveInWorktree(path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }),
    readArtifact: guard('read-artifact', async (path: string) => {
      return readFile(resolveInWorktree(path), 'utf8');
    }),
    commitArtifact: guard('commit', async (commitInput: { branch: string; paths: string[]; message: string }) => {
      const runGit = defaultRunGit;
      const { stdout: branchOut } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree });
      const checkedOut = branchOut.trim();
      if (checkedOut !== commitInput.branch) {
        throw new Error(
          `writing commit refused: worktree is on '${checkedOut}', expected '${commitInput.branch}'`,
        );
      }
      await runGit(['add', '--', ...commitInput.paths], { cwd: worktree });
      await runGit(['commit', '-m', commitInput.message], { cwd: worktree });
      const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: worktree });
      return { sha: stdout.trim() };
    }),
    emitRunState,
  };
}

// ---------------------------------------------------------------------------
// Orchestration-level deps
// ---------------------------------------------------------------------------

export interface ProductionStartWritingDeps {
  deps: StartWritingProductRunDeps;
  /** The sandbox once the worktree exists — the applier's teardown handle. */
  getSandbox: () => SandboxSpec | null;
  /** First dep failure, if any — the applier's terminal reason. */
  getFailure: () => WritingRunFailure | null;
}

/**
 * The production `StartWritingProductRunDeps`. `deployExternal` is
 * deliberately ABSENT — V1 publish is branch-commit only, and the
 * orchestration tests pin that the dep, when present, must never be called.
 * The pipeline adapter bridges the deps-level shape (branch/worktree/critique
 * fields) to the core input and THROWS on a `failed` result so the
 * orchestrator's generic "did not commit" guard never masks the real reason.
 */
export function buildProductionStartWritingDeps(
  hooks: {
    emitRunState: (event: WritingPipelineEvent) => void;
    cancelRequested?: () => boolean;
  },
  io: WritingDepsIo = {},
): ProductionStartWritingDeps {
  let sandbox: SandboxSpec | null = null;
  let failure: WritingRunFailure | null = null;
  const recordFailure = (f: WritingRunFailure) => {
    if (!failure) failure = f;
  };

  const deps: StartWritingProductRunDeps = {
    createWritingWorktree: async (input) => {
      if (hooks.cancelRequested?.()) {
        const message = 'cancelled by user before worktree creation';
        recordFailure({ stage: 'worktree', message });
        throw new Error(message);
      }
      try {
        sandbox = await createProductionWritingWorktree(input, io);
        return sandbox;
      } catch (err) {
        recordFailure({ stage: 'worktree', message: (err as Error).message });
        throw err;
      }
    },
    runWritingPipeline: async (input) => {
      const pipelineDeps = buildWritingPipelineDeps({
        worktree: input.worktree,
        emitRunState: hooks.emitRunState,
        recordFailure,
        ...(hooks.cancelRequested ? { cancelRequested: hooks.cancelRequested } : {}),
      });
      let critique: { slug: string; outputPath: string; revisionRequested: boolean } | undefined;
      if (input.requestedBy === 'writing-critique') {
        const slug = writingSlugFromBranch(input.branch);
        if (!slug || !input.critiqueOutputPath) {
          const message = !slug
            ? `writing critique: '${input.branch}' is not a rune-writing/ branch`
            : 'writing critique: missing critiqueOutputPath';
          recordFailure({ stage: 'critique-setup', message });
          throw new Error(message);
        }
        critique = {
          slug,
          outputPath: input.critiqueOutputPath,
          revisionRequested: input.revisionRequested ?? false,
        };
      }
      const result = await runWritingPipeline(
        {
          topic: input.topic,
          requestedBy: input.requestedBy,
          ...(critique ? { critique } : {}),
        },
        pipelineDeps,
      );
      if (result.failed) {
        // The core swallows the stage error — resurface the recorded one so
        // the orchestrator's generic guards don't mask it.
        throw new Error(
          failure
            ? `writing pipeline failed at ${failure.stage}: ${failure.message}`
            : `writing pipeline failed in state ${result.state}`,
        );
      }
      return result;
    },
  };

  return { deps, getSandbox: () => sandbox, getFailure: () => failure };
}

/** Preflight the `writing` product's repo before any work — a missing
 *  michaelcjoseph.com checkout becomes a friendly terminal, not a git stack
 *  trace mid-run. */
export function writingRepoPresent(repoPath: string): boolean {
  return existsSync(repoPath);
}
