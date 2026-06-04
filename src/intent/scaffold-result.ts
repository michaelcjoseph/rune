/**
 * Scaffold-result parser + repo-diff cross-check (09-expand-cockpit, Phase 4).
 *
 * The `project-setup-writer` agent ends its reply with a fenced ```scaffold-result JSON block
 * `{ slug, filesCreated[] }`. This module reconciles that PRIMARY structured signal against the
 * FALLBACK directory diff of the target repo's `docs/projects/`:
 *
 * - `parseScaffoldResult(message)` extracts and strictly validates the block (absent/malformed/
 *   wrong-shape → undefined).
 * - `crossCheckScaffold(parsed, newProjectDirs)` returns the captured slug or a distinct error.
 *   When the agent emitted a block, the diff must CONFIRM it (spec: "both must agree on the slug").
 *   When it didn't, the diff alone must name exactly one new project dir. Every `filesCreated`
 *   path must be repo-relative — absolute or `..`-escaping paths reject.
 *
 * Pure — no I/O. The caller supplies the pre-computed list of new `NN-slug` directory names that
 * appeared under `docs/projects/` between the pre- and post-scaffold snapshots.
 *
 * Contract pinned by `scaffold-result.test.ts`.
 */

import { posix as posixPath } from 'node:path';
import { VALID_SLUG } from './sandbox.js';

/** The structured result the setup-writer agent emits in its `scaffold-result` block. */
export interface ScaffoldResult {
  /** The new project slug, e.g. `09-expand-cockpit`. */
  slug: string;
  /** Repo-relative paths the agent created (no leading `/`, no `..`). */
  filesCreated: string[];
}

/** Outcome of cross-checking the parsed block against the repo diff. */
export type ScaffoldCheck =
  | { ok: true; slug: string }
  | {
      ok: false;
      error: 'slug-mismatch' | 'no-new-project-dir' | 'ambiguous-project-dirs' | 'non-relative-path';
    };

/** Matches the fenced ```scaffold-result block and captures its JSON body. `[^\n]*\n` consumes the
 *  rest of the opening fence line (a stray `\r` or trailing space), and the closing fence needs no
 *  preceding newline — so a block whose JSON has no trailing newline before ``` still matches (a
 *  common LLM output shape). Non-greedy so trailing prose after the fence is excluded; the captured
 *  body is trimmed before parsing to tolerate CRLF and surrounding whitespace. */
const BLOCK_RE = /```scaffold-result[^\n]*\n([\s\S]*?)```/;

/**
 * Extract and validate the `scaffold-result` block from an agent message. Returns the parsed
 * `ScaffoldResult` only when the block exists, parses as JSON, and has a string `slug` plus a
 * `filesCreated` array of strings (EVERY element validated — a single non-string rejects the
 * whole block). Anything else → undefined.
 */
export function parseScaffoldResult(message: string): ScaffoldResult | undefined {
  const match = message.match(BLOCK_RE);
  if (!match) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!.trim());
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const obj = parsed as Record<string, unknown>;
  const { slug, filesCreated } = obj;
  // The slug feeds downstream path/registry operations — gate it at the boundary against the same
  // VALID_SLUG every other slug entry point uses, rather than trusting raw agent output.
  if (typeof slug !== 'string' || !VALID_SLUG.test(slug)) return undefined;
  if (!Array.isArray(filesCreated)) return undefined;
  if (!filesCreated.every((f) => typeof f === 'string')) return undefined;

  return { slug, filesCreated: filesCreated as string[] };
}

/** A path is repo-relative iff it is a non-empty forward-slash path that is not absolute, carries
 *  no Windows drive letter or backslash, and does not normalize out of the repo root (no leading
 *  `..`, and not the repo root `.` itself). Uses posix semantics throughout — `filesCreated` paths
 *  are repo-relative forward-slash paths, and `posixPath.isAbsolute` (not the platform-native one)
 *  is the one that treats only `/`-prefixed strings as absolute. */
function isRepoRelative(p: string): boolean {
  if (p.length === 0) return false;
  if (posixPath.isAbsolute(p)) return false;
  // Reject Windows-isms that posix normalization would silently pass through (`C:\…`, `C:/…`).
  if (p.includes('\\') || /^[a-zA-Z]:/.test(p)) return false;
  const normalized = posixPath.normalize(p);
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../');
}

/**
 * Cross-check the parsed `scaffold-result` block (PRIMARY) against the repo diff (FALLBACK).
 *
 * `newProjectDirs` is the set of new `NN-slug` directory names that appeared under the target
 * repo's `docs/projects/` after the scaffold run.
 *
 * - Block parsed → every `filesCreated` path must be repo-relative (`non-relative-path` otherwise),
 *   AND the diff must contain the block's slug (`slug-mismatch` otherwise — an empty diff is an
 *   unconfirmed block, which counts as disagreement).
 * - No block → fall back to the diff: exactly one new dir is the slug; zero → `no-new-project-dir`;
 *   more than one → `ambiguous-project-dirs`.
 */
export function crossCheckScaffold(
  parsed: ScaffoldResult | undefined,
  newProjectDirs: string[],
): ScaffoldCheck {
  if (parsed) {
    if (!parsed.filesCreated.every(isRepoRelative)) {
      return { ok: false, error: 'non-relative-path' };
    }
    // The block is the primary signal, but the diff must confirm the claimed dir is on disk.
    if (!newProjectDirs.includes(parsed.slug)) {
      return { ok: false, error: 'slug-mismatch' };
    }
    return { ok: true, slug: parsed.slug };
  }

  // No block — the directory diff is the only signal.
  if (newProjectDirs.length === 0) return { ok: false, error: 'no-new-project-dir' };
  if (newProjectDirs.length > 1) return { ok: false, error: 'ambiguous-project-dirs' };
  return { ok: true, slug: newProjectDirs[0]! };
}
