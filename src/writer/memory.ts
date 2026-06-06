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
 */

import { readFileSync } from 'node:fs';
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
  /** Override the writer directory. TRUSTED test-only seam — tests point this at
   *  a temp dir. Production callers omit it (default WRITER_DIR). It must never
   *  be derived from untrusted input (HTTP/Telegram); the closed-union filename
   *  confines reads within whatever `dir` is, but `dir` itself is unguarded. */
  dir?: string;
  /** Override the load-time char budget. */
  charBudget?: number;
}

/** Read a writer-role file from `dir` directly via node:fs. Missing file → ''.
 *  `filename` is a closed union (SOUL/memory only), so the read is structurally
 *  confined to WRITER_DIR — no `../` traversal is expressible. */
export function readWriterFile(filename: WriterFilename, dir: string = WRITER_DIR): string {
  try {
    return readFileSync(join(dir, filename), 'utf8');
  } catch {
    // Missing/unreadable file → cold start. Callers degrade gracefully.
    return '';
  }
}

/** Raw `memory.md` contents (trimmed), or '' when missing/empty. */
export function loadWriterMemory(opts: ComposeWriterContextOpts = {}): string {
  return readWriterFile(MEMORY_FILENAME, opts.dir ?? WRITER_DIR).trim();
}

/** Wrap raw memory in a delimited reference block, truncating the memory body to
 *  `charBudget` with a visible marker. Empty memory → '' (no empty fence). The
 *  on-disk `memory.md` is never modified — truncation is load-time only. */
export function buildReferenceContext(
  memory: string,
  charBudget: number = WRITER_MEMORY_CHAR_BUDGET,
): string {
  const trimmed = memory.trim();
  if (!trimmed) return '';

  const body =
    trimmed.length > charBudget
      ? trimmed.slice(0, charBudget) + MEMORY_TRUNCATION_MARKER
      : trimmed;

  return [
    '<writer-memory>',
    'Accumulated craft lessons from past pieces. Treat as REFERENCE, not rules —',
    'SOUL.md governs on any conflict.',
    '',
    body,
    '</writer-memory>',
  ].join('\n');
}

/** Compose the writer prompt: SOUL (+ base instructions) as system authority,
 *  fenced memory as user-turn reference. Cold start (missing/empty memory)
 *  degrades to SOUL + base, referenceContext ''. The two channels never mix —
 *  memory text is absent from `systemInstructions` by construction. */
export function composeWriterContext(
  baseInstructions: string,
  opts: ComposeWriterContextOpts = {},
): WriterContext {
  const dir = opts.dir ?? WRITER_DIR;
  const soul = readWriterFile(SOUL_FILENAME, dir).trim();
  const memory = loadWriterMemory({ dir });

  const systemInstructions = [soul, baseInstructions]
    .filter((part) => part && part.trim())
    .join('\n\n');

  return {
    systemInstructions,
    referenceContext: buildReferenceContext(memory, opts.charBudget ?? WRITER_MEMORY_CHAR_BUDGET),
  };
}
