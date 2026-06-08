/**
 * Role-memory lesson writer (project 14, Phase 6).
 *
 * The learning loop's write boundary. Generalizes the Project 12 writer-capture
 * pipeline (`src/writer/capture.ts`) to the six product-team roles: privacy-filter
 * → dedupe → provenance-stamp → append → ONE atomic commit. The lesson text reaching
 * here is the post-mortem's distilled craft lesson; this module is the deterministic,
 * TypeScript-owned gate that decides whether it is safe to persist and writes it.
 *
 * A whitespace-only lesson, a privacy-rejected lesson, or a duplicate is a no-write,
 * no-commit skip with a durable reason — never a phantom write (spec req 31: ONE
 * atomic, provenance-stamped lesson). The privacy filter and provenance stamp are
 * reused from the writer pipeline (already-exported, security-sensitive helpers) so
 * the two learning loops can never drift apart on what is safe to persist.
 *
 * Every effect is injected (readMemory / appendLine / commit) so tests exercise the
 * full gate against fakes, never the real `agents/<role>/memory.md` or git.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isLessonPrivacySafe, SOURCE_SLUG_RE } from '../writer/capture.js';
import { stampSeedLesson, PROVENANCE_RE, extractLessonBody } from '../writer/seed.js';
import { roleDir, MEMORY_FILENAME, type RoleName } from './loader.js';
import { commitRoleMemory, type CommitRoleMemoryResult } from './commit.js';

export interface WriteRoleLessonInput {
  /** The role whose `memory.md` receives the lesson. */
  role: RoleName;
  /** The distilled craft lesson (privacy-filtered again here before any write). */
  lesson: string;
  /** Provenance slug; a fallback is derived when it fails `SOURCE_SLUG_RE`. */
  sourceSlug: string;
  /** Topic used to derive a fallback slug when `sourceSlug` is invalid. */
  fallbackTopic?: string;
  /** Provenance date `YYYY-MM-DD` (defaults to today, America/Chicago). */
  date?: string;
  /** Private names to reject (defaults to `process.env.FAMILY_NAMES`, read
   *  directly rather than via config.ts so this module runs without the app's
   *  required env vars — same exception as src/writer/capture.ts). */
  privateNames?: string[];
  /** Read current `memory.md` for dedup. Default: real read from the role dir. */
  readMemory?: () => string;
  /** Append one provenance line to `memory.md`. Default: real append to the role dir. */
  appendLine?: (line: string) => void;
  /** Memory-scoped commit. Default: real `commitRoleMemory` for the role. */
  commit?: (message: string) => Promise<CommitRoleMemoryResult>;
}

/** Why a write produced nothing — each a durable, no-commit skip. */
export type RoleLessonSkipReason =
  | 'empty' // lesson was whitespace-only
  | 'filtered' // lesson failed the privacy filter
  | 'duplicate'; // lesson body already present in memory.md

export interface WriteRoleLessonResult {
  /** The provenance-stamped line appended, when a write occurred. */
  captured?: string;
  /** True when a commit was made. */
  committed: boolean;
  /** Set when nothing was written. */
  skipReason?: RoleLessonSkipReason;
}

// Per-role serialization so two concurrent writes to the SAME role's memory.md
// can't interleave the read-dedupe → append → commit sequence (which would risk a
// duplicate lesson or `.git/index.lock` contention). Keyed per-role so writes to
// distinct roles never block each other; a rejected run never poisons the chain.
// Mirrors `captureChain` in src/writer/capture.ts — the write boundary is
// self-protecting regardless of how the caller drives it.
const writeChains: Map<RoleName, Promise<unknown>> = new Map();

/** Privacy-filter → dedupe → stamp → append → commit one lesson into a role's
 *  `memory.md`. Empty / privacy-rejected / duplicate → no write, no commit, durable
 *  reason. Async because it awaits the memory-scoped commit. Serialized per-role so
 *  concurrent writes to one role's memory can't interleave the read-modify-commit. */
export function writeRoleLesson(input: WriteRoleLessonInput): Promise<WriteRoleLessonResult> {
  const prior = writeChains.get(input.role) ?? Promise.resolve();
  const run = prior.then(
    () => writeRoleLessonUnlocked(input),
    () => writeRoleLessonUnlocked(input),
  );
  writeChains.set(input.role, run.catch(() => {}));
  return run;
}

async function writeRoleLessonUnlocked(input: WriteRoleLessonInput): Promise<WriteRoleLessonResult> {
  const lesson = input.lesson.trim();
  if (!lesson) return { committed: false, skipReason: 'empty' };

  const privateNames = input.privateNames ?? defaultPrivateNames();
  const date = input.date ?? todayChicago();
  const readMemory = input.readMemory ?? (() => defaultReadMemory(input.role));
  const appendLine = input.appendLine ?? ((line: string) => defaultAppendLine(input.role, line));
  const commit =
    input.commit ?? ((message: string) => commitRoleMemory({ role: input.role, message }));

  if (!isLessonPrivacySafe(lesson, privateNames)) return { committed: false, skipReason: 'filtered' };

  // Dedup against existing provenance-stamped lesson bodies.
  const seen = existingLessonBodies(readMemory());
  if (seen.has(lesson.toLowerCase())) return { committed: false, skipReason: 'duplicate' };

  const slug = SOURCE_SLUG_RE.test(input.sourceSlug)
    ? input.sourceSlug
    : deriveFallbackSlug(input.role, input.fallbackTopic, date);

  const captured = stampSeedLesson(lesson, slug, date);
  appendLine(captured);
  const result = await commit(`role-memory: capture lesson for ${input.role} [${slug}]`);
  return { captured, committed: result.committed };
}

// --- internal helpers (mirror src/writer/capture.ts) ---

/** FAMILY_NAMES read directly from the env (NOT config.ts, which throws at load
 *  without the app's required vars and would break this module's unit tests). */
function defaultPrivateNames(): string[] {
  return (process.env['FAMILY_NAMES'] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Today as `YYYY-MM-DD` in America/Chicago (en-CA yields ISO order). */
function todayChicago(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function defaultReadMemory(role: RoleName): string {
  try {
    return readFileSync(join(roleDir(role), MEMORY_FILENAME), 'utf8');
  } catch {
    return '';
  }
}

function defaultAppendLine(role: RoleName, line: string): void {
  const path = join(roleDir(role), MEMORY_FILENAME);
  // memory.md normally ends with a newline, but guard against a hand-edit that
  // dropped it so the new bullet never runs onto the last line.
  let prefix = '';
  try {
    const current = readFileSync(path, 'utf8');
    if (current.length > 0 && !current.endsWith('\n')) prefix = '\n';
  } catch {
    // Missing file → append creates it; no separator needed.
  }
  appendFileSync(path, `${prefix}${line}\n`);
}

/** Lowercased lesson bodies of every provenance-stamped line in `memory`. */
function existingLessonBodies(memory: string): Set<string> {
  const bodies = new Set<string>();
  for (const line of memory.split('\n')) {
    if (!PROVENANCE_RE.test(line)) continue;
    const body = extractLessonBody(line);
    if (body) bodies.add(body.toLowerCase());
  }
  return bodies;
}

/** Opaque fallback slug from the role + topic + date when the supplied slug is
 *  invalid: `<role>-<date>-<slugified-topic>`, clamped to SOURCE_SLUG_RE's 81-char
 *  max and guaranteed to satisfy the pattern. */
function deriveFallbackSlug(role: RoleName, topic: string | undefined, date: string): string {
  const base = `${role}-${date}`;
  const topicSlug = (topic ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const full = topicSlug ? `${base}-${topicSlug}` : base;
  return full.slice(0, 81).replace(/-+$/, '');
}
