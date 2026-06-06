/**
 * Writer-role memory loader (project 12, Phase 1).
 *
 * The writer role lives at `PROJECT_ROOT/agents/writer/`:
 *   - `SOUL.md`   — the charter. System-prompt authority (goes into
 *                   `--append-system-prompt` via the blog flow).
 *   - `memory.md` — accumulating craft lessons. LOW authority: it loads as
 *                   reference in the first USER message, never as a system
 *                   prompt, so accumulated content can never silently become
 *                   rules. On any SOUL ↔ memory contradiction, SOUL wins.
 *
 * Both files are read directly from disk (node:fs), NOT via `readVaultFile`
 * — they live in the jarvis repo, not the Obsidian vault.
 *
 * SCAFFOLD: bodies throw `notImplemented(...)` so the Phase 1 test suite is
 * RED until the loader implementation task lands.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root derived locally (src/writer/ → ../.. ) so this path-only module does
// NOT pull in the env-heavy config.ts (which calls required('TELEGRAM_BOT_TOKEN')
// at load). Mirrors the same import.meta.url derivation config.ts uses for
// PROJECT_ROOT, one directory level deeper. Keeps src/writer/ self-contained and
// its tests runnable without the app's env vars.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Directory holding the writer role's charter + memory, in the jarvis repo. */
export const WRITER_DIR = join(REPO_ROOT, 'agents', 'writer');

export const SOUL_FILENAME = 'SOUL.md';
export const MEMORY_FILENAME = 'memory.md';

/** The only two files the loader ever reads — a closed set so the read API can
 *  never be steered outside WRITER_DIR via a `../`-laden filename. */
export type WriterFilename = typeof SOUL_FILENAME | typeof MEMORY_FILENAME;

/** Load-time char budget for the memory reference block. Past this, the loaded
 *  `referenceContext` is truncated with a visible marker — the on-disk
 *  `memory.md` is never modified to enforce the read budget. */
export const WRITER_MEMORY_CHAR_BUDGET = 14000;

/** Visible marker appended when memory is truncated to fit the budget. */
export const MEMORY_TRUNCATION_MARKER =
  '\n\n…(truncated — writer memory exceeds the load-time char budget)';

/** The two prompt fragments the blog flow needs, kept on separate authority
 *  channels: `systemInstructions` → `--append-system-prompt`; `referenceContext`
 *  → the first user turn. */
export interface WriterContext {
  /** SOUL charter + the caller's base blog instructions. System-prompt authority. */
  systemInstructions: string;
  /** Fenced, budget-trimmed `memory.md`. Goes in the user turn; '' when memory
   *  is empty/missing (cold start). */
  referenceContext: string;
}

export interface ComposeWriterContextOpts {
  /** Override the writer directory (tests point this at a temp dir). */
  dir?: string;
  /** Override the load-time char budget. */
  charBudget?: number;
}

function notImplemented(fn: string): never {
  throw new Error(`writer/memory: ${fn} not implemented (project 12 Phase 1 pending)`);
}

/** Read a writer-role file from `dir` directly via node:fs. Missing file → ''.
 *  `filename` is a closed union (SOUL/memory only), so the read is structurally
 *  confined to WRITER_DIR — no `../` traversal is expressible. */
export function readWriterFile(_filename: WriterFilename, _dir: string = WRITER_DIR): string {
  return notImplemented('readWriterFile');
}

/** Raw `memory.md` contents (trimmed), or '' when missing/empty. */
export function loadWriterMemory(_opts: ComposeWriterContextOpts = {}): string {
  return notImplemented('loadWriterMemory');
}

/** Wrap raw memory in a delimited reference block, truncating to `charBudget`
 *  with a visible marker. Empty memory → ''. */
export function buildReferenceContext(
  _memory: string,
  _charBudget: number = WRITER_MEMORY_CHAR_BUDGET,
): string {
  return notImplemented('buildReferenceContext');
}

/** Compose the writer prompt: SOUL (+ base instructions) as system authority,
 *  fenced memory as user-turn reference. Cold start (missing/empty memory)
 *  degrades to SOUL + base, referenceContext ''. */
export function composeWriterContext(
  _baseInstructions: string,
  _opts: ComposeWriterContextOpts = {},
): WriterContext {
  return notImplemented('composeWriterContext');
}
