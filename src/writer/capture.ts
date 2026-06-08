/**
 * Lesson capture (project 12, Phase 2).
 *
 * Capture is TypeScript-owned, NOT model-owned. `askClaudeWithContext` only
 * returns text, so the writer *proposes* candidate lessons in a fenced
 * ```writer-memory-candidates JSON block; this module does the rest
 * deterministically: parse the block, gate on feedback, privacy-filter, dedupe
 * against existing entries, provenance-stamp, append to `memory.md`, and make
 * one atomic commit via the memory-scoped helper (`./commit.ts`).
 *
 * `feedbackSeen: false`, a missing block, an empty `lessons` array, or a lesson
 * that fails the privacy filter means NO memory write and NO commit.
 *
 * The privacy filter is deterministic: reject a lesson containing a configured
 * private name, a markdown link, a wikilink, an email/phone pattern, or a
 * quoted/raw-excerpt span longer than a small threshold.
 *
 * SCAFFOLD: bodies throw `notImplemented(...)` so the Phase 2 capture/parse/
 * dedup/privacy tests are RED until the implementation lands.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WRITER_DIR, MEMORY_FILENAME } from './memory.js';
import { stampSeedLesson, PROVENANCE_RE, extractLessonBody } from './seed.js';
import { commitWriterMemory, type CommitWriterMemoryResult } from './commit.js';

/** The fence language tag for the writer's candidate block. */
export const CANDIDATE_FENCE = 'writer-memory-candidates';

/** Valid `sourceSlug` shape — opaque, lowercase, no leading hyphen. Mirrors the
 *  seed slug contract so seed and captured provenance stamps share one format. */
export const SOURCE_SLUG_RE = /^[a-z0-9][a-z0-9-]{2,80}$/;

/** The parsed candidate block the writer proposes. */
export interface WriterMemoryCandidates {
  /** Opaque source slug, ideally matching SOURCE_SLUG_RE; the handler may
   *  substitute a derived fallback slug when this is invalid. */
  sourceSlug: string;
  /** Must be true for any capture to occur — the no-phantom-write gate. */
  feedbackSeen: boolean;
  /** Candidate abstract-craft lessons. */
  lessons: string[];
}

/** Why a capture produced no write. `parseCandidateBlock` returns null for both
 *  an absent and a malformed block, so both collapse to `no-block` here. */
export type CaptureSkipReason =
  | 'no-block' // no parseable writer-memory-candidates block (absent or malformed)
  | 'no-feedback' // feedbackSeen !== true
  | 'empty' // lessons array empty
  | 'all-filtered'; // every candidate deduped or privacy-rejected

export interface CaptureLessonsInput {
  /** The writer's assistant text carrying the candidate block. */
  assistantText: string;
  /** Session topic/date, used to derive a fallback opaque slug when the
   *  candidate slug is missing/invalid. */
  fallbackTopic?: string;
  /** Private names to reject (defaults to config.FAMILY_NAMES). */
  privateNames?: string[];
  /** Provenance date `YYYY-MM-DD` (defaults to today, America/Chicago). */
  date?: string;
  /** Read current `memory.md` for dedup. Default: real read from WRITER_DIR. */
  readMemory?: () => string;
  /** Append one provenance line to `memory.md`. Default: real append. */
  appendLine?: (line: string) => void;
  /** Memory-scoped commit. Default: real `commitWriterMemory`. Async to match
   *  the git-helper convention (see `./commit.ts`). */
  commit?: (message: string) => Promise<CommitWriterMemoryResult>;
}

export interface CaptureResult {
  /** Provenance-stamped lines appended this capture (empty when nothing written). */
  captured: string[];
  /** Set when nothing was captured. */
  skipReason?: CaptureSkipReason;
  /** True when a commit was made. */
  committed: boolean;
}

/** Max characters allowed inside a quoted span before it's treated as a raw
 *  excerpt (copyright/leak risk) rather than incidental short quoting. */
const QUOTE_EXCERPT_MAX = 40;
/** Abstract craft lessons are concise; anything longer is likely a paraphrase or
 *  raw excerpt of source material — a backstop for the unquoted-excerpt gap. */
const MAX_LESSON_LEN = 300;

// Deterministic privacy-leak patterns. Kept module-level so they compile once.
const MARKDOWN_LINK_RE = /\[[^\]]*\]\([^)]*\)/; // [text](url)
const REFERENCE_LINK_RE = /\[[^\]]*\]\[[^\]]*\]/; // [text][ref]
const WIKILINK_RE = /\[\[[^\]]*\]\]/; // [[wikilink]]
const BARE_URL_RE = /https?:\/\/[^\s)]+/; // bare http(s) URL, no markdown syntax
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
// Conservative phone match: a US-style grouped number, not any run of digits
// (so "10,000 subscribers" is not flagged).
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
// A quoted span longer than QUOTE_EXCERPT_MAX. Delimiters cover straight + curly
// double AND single quotes (backtick-delimited so both quote glyphs sit inline).
const QUOTE_DELIMS = `"“”'‘’`;
const LONG_QUOTE_RE = new RegExp(
  `[${QUOTE_DELIMS}]([^${QUOTE_DELIMS}]{${QUOTE_EXCERPT_MAX},})[${QUOTE_DELIMS}]`,
);
// The candidate block: compiled once. Lazy `[\s\S]*?` matches the FIRST block.
const CANDIDATE_BLOCK_RE = new RegExp('```' + CANDIDATE_FENCE + '[^\\n]*\\n([\\s\\S]*?)\\n```');

/** Parse the fenced ```writer-memory-candidates JSON block. Returns null when the
 *  block is absent or not a valid {sourceSlug, feedbackSeen, lessons} object. */
export function parseCandidateBlock(text: string): WriterMemoryCandidates | null {
  const match = text.match(CANDIDATE_BLOCK_RE);
  if (!match) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(match[1]!);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const o = obj as Record<string, unknown>;
  if (typeof o['sourceSlug'] !== 'string') return null;
  if (typeof o['feedbackSeen'] !== 'boolean') return null;
  if (!Array.isArray(o['lessons']) || !o['lessons'].every((l) => typeof l === 'string')) return null;

  return {
    sourceSlug: o['sourceSlug'],
    feedbackSeen: o['feedbackSeen'],
    lessons: o['lessons'] as string[],
  };
}

/** Deterministic privacy gate: false when the lesson carries a private name, a
 *  markdown link, a wikilink, an email/phone pattern, or a long raw-excerpt span. */
export function isLessonPrivacySafe(lesson: string, privateNames: string[]): boolean {
  if (lesson.length > MAX_LESSON_LEN) return false;
  if (MARKDOWN_LINK_RE.test(lesson)) return false;
  if (REFERENCE_LINK_RE.test(lesson)) return false;
  if (WIKILINK_RE.test(lesson)) return false;
  if (BARE_URL_RE.test(lesson)) return false;
  if (EMAIL_RE.test(lesson)) return false;
  if (PHONE_RE.test(lesson)) return false;
  if (LONG_QUOTE_RE.test(lesson)) return false;

  for (const name of privateNames) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    // Whole-word, case-insensitive match. Unicode-aware boundaries (NOT `\b`,
    // which is ASCII-only and silently fails on accented names like "Ángel").
    const nameRe = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}])`,
      'iu',
    );
    if (nameRe.test(lesson)) return false;
  }
  return true;
}

// Per-process serialization so two near-simultaneous session closures can't
// interleave the read-dedupe → append → commit sequence on memory.md (which would
// risk duplicate lessons or `.git/index.lock` contention). Only one Jarvis runs at
// a time, so a single promise chain is sufficient; a rejected run never poisons it.
let captureChain: Promise<unknown> = Promise.resolve();

/** Parse → gate on feedback → privacy-filter → dedupe → stamp → append → commit.
 *  No feedback / no block / empty / all-filtered → no write and no commit. Async
 *  because it awaits the memory-scoped commit (`./commit.ts`). Serialized against
 *  itself so concurrent closures don't interleave the read-modify-commit sequence. */
export function captureLessons(input: CaptureLessonsInput): Promise<CaptureResult> {
  const run = captureChain.then(
    () => captureLessonsUnlocked(input),
    () => captureLessonsUnlocked(input),
  );
  captureChain = run.catch(() => {});
  return run;
}

async function captureLessonsUnlocked(input: CaptureLessonsInput): Promise<CaptureResult> {
  const parsed = parseCandidateBlock(input.assistantText);
  if (!parsed) return { captured: [], committed: false, skipReason: 'no-block' };
  if (parsed.feedbackSeen !== true) return { captured: [], committed: false, skipReason: 'no-feedback' };
  if (parsed.lessons.length === 0) return { captured: [], committed: false, skipReason: 'empty' };

  const privateNames = input.privateNames ?? defaultPrivateNames();
  const date = input.date ?? todayChicago();
  const readMemory = input.readMemory ?? defaultReadMemory;
  const appendLine = input.appendLine ?? defaultAppendLine;
  const commit = input.commit ?? ((message: string) => commitWriterMemory({ message }));
  const slug = SOURCE_SLUG_RE.test(parsed.sourceSlug)
    ? parsed.sourceSlug
    : deriveFallbackSlug(input.fallbackTopic, date);

  // Dedup against existing lesson bodies AND ones captured earlier this round.
  const seen = existingLessonBodies(readMemory());
  const captured: string[] = [];
  for (const raw of parsed.lessons) {
    const lesson = raw.trim();
    if (!lesson) continue;
    if (!isLessonPrivacySafe(lesson, privateNames)) continue;
    const key = lesson.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    captured.push(stampSeedLesson(lesson, slug, date));
  }

  if (captured.length === 0) return { captured: [], committed: false, skipReason: 'all-filtered' };

  for (const line of captured) appendLine(line);
  const result = await commit(`writer-memory: capture ${captured.length} lesson(s) [${slug}]`);
  return { captured, committed: result.committed };
}

// --- internal helpers ---

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** FAMILY_NAMES read directly from the env (NOT config.ts, which throws at load
 *  without the app's required vars and would break this module's unit tests).
 *  Mirrors config.ts's parse. */
function defaultPrivateNames(): string[] {
  return (process.env['FAMILY_NAMES'] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Today as `YYYY-MM-DD` in America/Chicago (en-CA yields ISO order). Inlined to
 *  keep this module free of the config-importing time util. */
function todayChicago(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function defaultReadMemory(): string {
  try {
    return readFileSync(join(WRITER_DIR, MEMORY_FILENAME), 'utf8');
  } catch {
    return '';
  }
}

function defaultAppendLine(line: string): void {
  const path = join(WRITER_DIR, MEMORY_FILENAME);
  // memory.md normally ends with a newline, but guard against a hand-edit or
  // truncation that dropped it so the new bullet never runs onto the last line.
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

/** Opaque fallback slug from the session topic + date when the candidate slug is
 *  invalid: `blog-<date>-<slugified-topic>`, clamped to SOURCE_SLUG_RE's 81-char
 *  max and guaranteed to satisfy the pattern. */
function deriveFallbackSlug(topic: string | undefined, date: string): string {
  const base = `blog-${date}`;
  const topicSlug = (topic ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const full = topicSlug ? `${base}-${topicSlug}` : base;
  return full.slice(0, 81).replace(/-+$/, '');
}
