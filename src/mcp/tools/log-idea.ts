/**
 * `log_idea` MCP tool handler — project 16-claude-app-connector, Phase 1
 * (spec R3, tech-spec tool table).
 *
 * Captures an idea or bug from a Claude App thread, routes it to a product
 * target via `resolveProductTarget` (explicit inbox fallback — never dropped,
 * never guessed), dedupes by `deriveIdeaId`, appends the attributed bullet to
 * the ideas file, and commits.
 *
 * PURE MODULE: every effect (file read/append, products.json read, git
 * commit+push) is injected via {@link LogIdeaDeps}. The production binding
 * lives in ./log-idea-deps.ts — kept separate because it pulls src/config.ts
 * (which requires env vars at import); this module must stay importable in
 * any environment so its unit suite runs config-free.
 */

import { resolveProductTarget } from '../../intent/product-routing.js';
import { deriveIdeaId } from '../../intent/observation-ideas-io.js';
import { formatIdeasMarkdown } from '../../intent/observation-triage.js';
import type { ProjectIdea } from '../../intent/observation-loop.js';

export interface LogIdeaInput {
  /** Item kind; omitted defaults to 'idea' (tech-spec: `kind?: 'idea'|'bug'`). */
  kind?: 'idea' | 'bug';
  title: string;
  /** The friction or description the item addresses. */
  friction: string;
  /** Candidate product target (the App Claude's inference); optional. */
  product?: string;
}

export interface LogIdeaDeps {
  /** Ideas inbox file the bullet is appended to. */
  ideasPath: string;
  /** Known-product loader (products.json reader in production). */
  loadKnownProducts: () => string[];
  /** Existing-ideas reader for dedupe. */
  readFiledIdeas: (ideasPath: string) => ProjectIdea[];
  /** Bullet appender (observation-ideas-io's appendFiledIdeas in production,
   *  wrapped in a per-file lock; may be async). */
  appendFiledIdeas: (ideasPath: string, markdown: string) => void | Promise<void>;
  /** Commit + push the write; MUST throw/reject on git failure. */
  commitAndPush: (message: string) => Promise<void>;
  /** Optional error-text sanitizer applied before a failure message is
   *  surfaced to the caller (production binds path-scrub + secret-redaction —
   *  this tool's results eventually reach a remote App thread). */
  sanitizeError?: (message: string) => string;
}

import { errText, type McpTextResult } from './types.js';

function ok(text: string): McpTextResult {
  return { content: [{ type: 'text', text }] };
}

function err(text: string): McpTextResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Trust-boundary length caps on LLM-supplied free text (mirrors the
 *  feedback-record convention). Exceeding input is rejected, not truncated —
 *  silent truncation would change the dedupe id between retries. */
export const TITLE_MAX_CHARS = 200;
export const FRICTION_MAX_CHARS = 2000;

/** Collapse embedded newlines — the bullet format and the git commit
 *  subject are single-line surfaces. */
function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * File an idea or bug. Never throws — every failure path resolves to an
 * `isError` result with a clear message (a phantom success is the one
 * unacceptable outcome).
 */
export async function logIdea(input: LogIdeaInput, deps: LogIdeaDeps): Promise<McpTextResult> {
  const clean = deps.sanitizeError ?? ((s: string) => s);

  // ---- validation (before any write) ----
  const kind = input.kind ?? 'idea';
  if (kind !== 'idea' && kind !== 'bug') {
    return err(`Invalid kind ${JSON.stringify(input.kind)} — must be 'idea' or 'bug'. Nothing was written.`);
  }
  const title = typeof input.title === 'string' ? singleLine(input.title) : '';
  if (!title) {
    return err('Missing or empty title — nothing was written.');
  }
  if (title.length > TITLE_MAX_CHARS) {
    return err(`Title exceeds ${TITLE_MAX_CHARS} characters — nothing was written.`);
  }
  const friction = typeof input.friction === 'string' ? singleLine(input.friction) : '';
  if (!friction) {
    return err('Missing or empty friction — nothing was written.');
  }
  if (friction.length > FRICTION_MAX_CHARS) {
    return err(`Friction exceeds ${FRICTION_MAX_CHARS} characters — nothing was written.`);
  }

  try {
    // ---- routing (never throws; falls back to the inbox target) ----
    const route = resolveProductTarget(input.product, deps.loadKnownProducts);

    // ---- dedupe ----
    const id = deriveIdeaId(friction);
    const existing = deps.readFiledIdeas(deps.ideasPath);
    if (existing.some((idea) => idea.id === id)) {
      return ok(`Already filed — duplicate of an existing item (id: ${id}). Nothing new was written.`);
    }

    // ---- write ----
    const bulletTitle = kind === 'bug' ? `[bug] ${title}` : title;
    const idea: ProjectIdea = { title: bulletTitle, friction, id, product: route.product };
    const markdown = formatIdeasMarkdown([{ kind: 'filed', idea }]);
    await deps.appendFiledIdeas(deps.ideasPath, markdown);

    const bullet = markdown.trimEnd();

    // ---- commit (failure must surface — never a phantom filed bullet) ----
    try {
      await deps.commitAndPush(`log_idea: ${bulletTitle} → ${route.product}`);
    } catch (commitErr) {
      return err(
        `Bullet was written to the ideas file but the git commit/push FAILED — the capture is NOT durable yet: ${clean(errText(commitErr))}`,
      );
    }

    return ok(`Filed ${kind} to ${route.product}:\n${bullet}`);
  } catch (unexpected) {
    return err(`log_idea failed: ${clean(errText(unexpected))}`);
  }
}
