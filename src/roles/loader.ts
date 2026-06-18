/**
 * Product-team role loader (project 14, Phase 1).
 *
 * Generalizes the Project 12 writer loader (`src/writer/memory.ts`) to the six
 * fixed product-team roles. Each role lives at `PROJECT_ROOT/agents/<role>/`:
 *   - `SOUL.md`   — the charter. System-prompt authority (the orchestrator passes
 *                   it via `--append-system-prompt` when invoking the role).
 *   - `memory.md` — accumulating craft lessons. LOW authority: it loads as
 *                   reference in the first USER message, never as a system
 *                   prompt, so accumulated content can never silently become
 *                   rules. On any SOUL ↔ memory contradiction, SOUL wins.
 *
 * Both files are read directly from disk (node:fs), NOT via `readVaultFile` —
 * they live in the jarvis repo, not the Obsidian vault. The role is a closed
 * union, so the read API can never be steered outside `agents/<role>/` via a
 * `../`-laden role name.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root derived locally (src/roles/ → ../.. ) so this path-only module does
// NOT pull in the env-heavy config.ts (which calls required('TELEGRAM_BOT_TOKEN')
// at load). Mirrors the same import.meta.url derivation config.ts uses for
// PROJECT_ROOT, one directory level deeper. Keeps src/roles/ self-contained and
// its tests runnable without the app's env vars.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The six product-team roles. Closed union — the loader never reads a role dir
 *  outside this set, so an attacker-controlled role string can't traverse out of
 *  `agents/`. Slugs match the `agents/<slug>/` directory names. */
export type RoleName = 'pm' | 'tech-lead' | 'qa' | 'coder' | 'reviewer' | 'designer';

/** Canonical role inventory, the spec's ownership table in slug form. */
export const ROLE_NAMES: readonly RoleName[] = [
  'pm',
  'tech-lead',
  'qa',
  'coder',
  'reviewer',
  'designer',
] as const;

/** Root holding every role's `<role>/{SOUL.md,memory.md}`, in the jarvis repo. */
export const ROLES_ROOT = join(REPO_ROOT, 'agents');

/** Directory for a single role's charter + memory. */
export function roleDir(role: RoleName): string {
  return join(ROLES_ROOT, role);
}

export const SOUL_FILENAME = 'SOUL.md';
export const MEMORY_FILENAME = 'memory.md';
export const EXAMPLES_DIRNAME = 'examples';

/** The only two files the loader ever reads per role — a closed set so the read
 *  API can never be steered outside the role dir via a `../`-laden filename. */
type RoleFilename = typeof SOUL_FILENAME | typeof MEMORY_FILENAME;

/** Load-time char budget for the memory reference block. Past this, the loaded
 *  `referenceContext` is truncated with a visible marker — the on-disk
 *  `memory.md` is never modified to enforce the read budget. */
export const ROLE_MEMORY_CHAR_BUDGET = 14000;

/** Visible marker appended when role memory is truncated to fit the budget. */
const MEMORY_TRUNCATION_MARKER =
  '\n\n…(truncated — role memory exceeds the load-time char budget)';

/** Visible marker appended when role exemplars are truncated to fit the budget. */
const EXEMPLAR_TRUNCATION_MARKER =
  '\n\n…(truncated — role exemplars exceed the load-time char budget)';

/** The two prompt fragments a role invocation needs, kept on separate authority
 *  channels: `systemInstructions` → `--append-system-prompt`; `referenceContext`
 *  → the first user turn, carrying memory + exemplars as low-authority reference. */
export interface RoleContext {
  /** SOUL charter + the caller's base task instructions. System-prompt authority. */
  systemInstructions: string;
  /** Fenced, budget-trimmed memory/exemplars. Goes in the user turn; '' when
   *  memory and exemplars are empty/missing (cold start). */
  referenceContext: string;
}

export interface ComposeRoleContextOpts {
  /** Override the role directory. TRUSTED test-only seam — tests point this at a
   *  temp dir. Production callers omit it (default `roleDir(role)`). It must never
   *  be derived from untrusted input (HTTP/Telegram); the closed-union filename
   *  confines reads within whatever `dir` is, but `dir` itself is unguarded. */
  dir?: string;
  /** Optional project-local exemplar directory. When present, `<role>.md` is
   *  loaded alongside the permanent baseline exemplars under `agents/<role>/examples/`.
   *  TRUSTED orchestration seam; production callers should pass a path derived
   *  from the selected project, never from direct user input. */
  projectExemplarsDir?: string;
  /** Override the load-time char budget. */
  charBudget?: number;
}

/** Read a role file from `dir` directly via node:fs. Missing file → ''.
 *  `filename` is a closed union (SOUL/memory only), so the read is structurally
 *  confined to the role dir — no `../` traversal is expressible. */
function readRoleFile(filename: RoleFilename, dir: string): string {
  try {
    return readFileSync(join(dir, filename), 'utf8');
  } catch {
    // Missing/unreadable file → cold start. Callers degrade gracefully.
    return '';
  }
}

/** Raw `memory.md` contents (trimmed), or '' when missing/empty. Unlike the
 *  writer's `loadWriterMemory`, `dir` has no default — the role parameterizes the
 *  directory, so the correct default (`roleDir(role)`) is only computable with the
 *  role in hand. Direct callers resolve it via `roleDir(role)`; `composeRoleContext`
 *  already threads it. The role's `memory.md` starts empty (cold start) and is
 *  populated one provenance-stamped lesson at a time by the project-14 learning loop. */
export function loadRoleMemory(opts: { dir: string }): string {
  return readRoleFile(MEMORY_FILENAME, opts.dir).trim();
}

/** Wrap raw memory in a role-named reference block, truncating the memory body
 *  to `charBudget` with a visible marker. Empty memory → '' (no empty fence).
 *  The on-disk `memory.md` is never modified — truncation is load-time only. */
export function buildRoleReferenceContext(
  role: RoleName,
  memory: string,
  charBudget: number = ROLE_MEMORY_CHAR_BUDGET,
): string {
  const trimmed = memory.trim();
  if (!trimmed) return '';

  const body =
    trimmed.length > charBudget
      ? trimmed.slice(0, charBudget) + MEMORY_TRUNCATION_MARKER
      : trimmed;

  return [
    `<${role}-memory>`,
    `Accumulated lessons for the ${role} role from past runs. Treat as REFERENCE,`,
    'not rules — SOUL.md governs on any conflict.',
    '',
    body,
    `</${role}-memory>`,
  ].join('\n');
}

export interface RoleExemplar {
  label: string;
  body: string;
}

function readBaselineExemplars(dir: string): RoleExemplar[] {
  const examplesDir = join(dir, EXAMPLES_DIRNAME);
  try {
    return readdirSync(examplesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
      .map((name) => ({
        label: `baseline/${name}`,
        body: readRoleExemplarFile(examplesDir, name),
      }))
      .filter((entry) => entry.body.trim());
  } catch {
    return [];
  }
}

function readProjectExemplar(role: RoleName, projectExemplarsDir?: string): RoleExemplar[] {
  if (!projectExemplarsDir) return [];
  const filename = `${role}.md`;
  const body = readRoleExemplarFile(projectExemplarsDir, filename);
  return body.trim() ? [{ label: `project/${filename}`, body }] : [];
}

function readRoleExemplarFile(dir: string, filename: string): string {
  try {
    return readFileSync(join(dir, filename), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Wrap role exemplars in a role-named low-authority reference block. Missing
 *  exemplars produce no block; oversized exemplar bodies are truncated at
 *  load-time only, leaving source files untouched. */
export function buildRoleExemplarContext(
  role: RoleName,
  exemplars: readonly RoleExemplar[],
  charBudget: number = ROLE_MEMORY_CHAR_BUDGET,
): string {
  const body = exemplars
    .map((exemplar) => [`## ${exemplar.label}`, exemplar.body.trim()].join('\n'))
    .join('\n\n')
    .trim();
  if (!body) return '';

  const bounded =
    body.length > charBudget ? body.slice(0, charBudget) + EXEMPLAR_TRUNCATION_MARKER : body;

  return [
    `<${role}-exemplars>`,
    `Reference exemplars of good ${role} output from baseline and project runs.`,
    'Treat as REFERENCE, not rules — SOUL.md governs on any conflict.',
    '',
    bounded,
    `</${role}-exemplars>`,
  ].join('\n');
}

/** Compose a role prompt: SOUL (+ base instructions) as system authority, fenced
 *  memory/exemplars as user-turn reference. Cold start (missing/empty reference
 *  material) degrades to SOUL + base, referenceContext ''. The two channels never
 *  mix — memory/exemplar text is absent from `systemInstructions` by construction. */
export function composeRoleContext(
  role: RoleName,
  baseInstructions: string,
  opts: ComposeRoleContextOpts = {},
): RoleContext {
  const dir = opts.dir ?? roleDir(role);
  const soul = readRoleFile(SOUL_FILENAME, dir).trim();
  const memory = loadRoleMemory({ dir });
  const exemplars = [
    ...readBaselineExemplars(dir),
    ...readProjectExemplar(role, opts.projectExemplarsDir),
  ];

  const systemInstructions = [soul, baseInstructions]
    .filter((part) => part && part.trim())
    .join('\n\n');

  return {
    systemInstructions,
    referenceContext: [
      buildRoleReferenceContext(role, memory, opts.charBudget ?? ROLE_MEMORY_CHAR_BUDGET),
      buildRoleExemplarContext(role, exemplars, opts.charBudget ?? ROLE_MEMORY_CHAR_BUDGET),
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}
