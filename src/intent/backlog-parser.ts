/**
 * Strict backlog parser (09-expand-cockpit, Phase 1).
 *
 * Parses a product repo's `docs/projects/bugs.md` and `docs/projects/ideas.md` into
 * structured `BacklogItem`s plus file-level format warnings. The parser is STRICT: only the
 * accepted forms in spec.md "Parser contract" become items; everything else warns and is
 * skipped. A warning is either attached to the FILE (a `FileWarning` with a line number +
 * code, rendered as a drawer banner) or to an ITEM (a code string in `BacklogItem.warnings`,
 * rendered as a `⚠` chip).
 *
 * Pure: no I/O, no clock. The filesystem + security layer is `backlog-reader.ts`; action
 * computation (which needs runtime planning state) is the reader/API layer's job, so parser
 * items carry no `actions` field. The contract is pinned by `backlog-parser.test.ts`.
 */

import { computeBacklogId, type BacklogKind } from './backlog-id.js';

export type { BacklogKind };
export type BacklogStatus = 'open' | 'done';
export type BacklogSection = 'user-authored' | 'loop-filed';

/** A single parsed backlog item (parser layer — no `actions`). */
export interface BacklogItem {
  id: string;
  kind: BacklogKind;
  text: string;
  status: BacklogStatus;
  /** Sub-bullets, ideas only; always `[]` for bugs. */
  body: string[];
  /** Project slug a valid promotion suffix points at. */
  promotedTo?: string;
  /** Which ideas section the item sits under; undefined for bugs. */
  section?: BacklogSection;
  /**
   * Provenance of the item. `raw` is the source line in its id-normalized form — a trailing
   * carriage return and trailing whitespace are stripped (matching `normalizeBacklogRaw`), so
   * `id` and `source.raw` are internally consistent. The mark-source snapshot-match step must
   * apply the same normalization when reading lines off disk for comparison.
   */
  source: { file: string; lineNumber: number; raw: string };
  /** Per-item warning codes (e.g. `bad-promotion-marker`). */
  warnings: string[];
}

/** A file-level format warning — attached to the file, not an item. */
export interface FileWarning {
  /** Repo-relative file path, never absolute. */
  file: string;
  /** 1-based line number the warning points at. */
  lineNumber: number;
  /** Stable warning code, e.g. `tab-indented`, `over-indented`, `code-fence`. */
  code: string;
  /** Human-readable description for the drawer banner. */
  message: string;
}

export interface ParsedBacklog {
  items: BacklogItem[];
  fileWarnings: FileWarning[];
}

// A valid promotion slug: two digits, a dash, then lowercase alphanumerics/hyphens.
const SLUG_RE = /^\d{2}-[a-z0-9-]+$/;
// A trailing promotion marker: ` → <single-token>` anchored at end of line. Requiring a
// single whitespace-free trailing token is what prevents a mid-sentence "A → B correctly"
// from being misread as a marker.
const MARKER_RE = / → (\S+)$/;

function stripCr(line: string): string {
  return line.replace(/\r$/, '');
}

function warn(
  fileWarnings: FileWarning[],
  file: string,
  lineNumber: number,
  code: string,
  message: string,
): void {
  fileWarnings.push({ file, lineNumber, code, message });
}

/**
 * Shared rejection policy for unindented non-dash bullet forms (`*`, `1.`, `>`). Both parsers
 * reject these identically, so the policy lives in one place — adding a new rejected glyph is
 * a single edit. Returns true (and emits a file warning) when the line was such a form.
 */
function warnIfRejectedTopLevelForm(
  cr: string,
  fileWarnings: FileWarning[],
  file: string,
  lineNumber: number,
): boolean {
  if (/^\*\s/.test(cr)) {
    warn(fileWarnings, file, lineNumber, 'star-bullet', 'non-dash (*) bullet');
    return true;
  }
  if (/^\d+\.\s/.test(cr)) {
    warn(fileWarnings, file, lineNumber, 'numbered-list', 'numbered-list line');
    return true;
  }
  if (/^>/.test(cr)) {
    warn(fileWarnings, file, lineNumber, 'blockquote', 'blockquote line');
    return true;
  }
  return false;
}

/**
 * Split a top-level item's text into its display text and a promotion slug. A trailing
 * ` → <token>` whose token matches the strict slug regex is a promotion (text stripped);
 * a single trailing token that is NOT a valid slug flags `bad-promotion-marker` and the
 * full text is preserved; anything else is plain text.
 */
function extractMarker(body: string): {
  text: string;
  promotedTo?: string;
  badMarker?: boolean;
} {
  const m = MARKER_RE.exec(body);
  if (!m) return { text: body };
  const token = m[1]!;
  if (SLUG_RE.test(token)) {
    return { text: body.slice(0, m.index).trimEnd(), promotedTo: token };
  }
  return { text: body, badMarker: true };
}

export function parseBugs(content: string, file: string): ParsedBacklog {
  const items: BacklogItem[] = [];
  const fileWarnings: FileWarning[] = [];
  let inFence = false;

  const allLines = content.split('\n');
  for (let i = 0; i < allLines.length; i++) {
    const lineNumber = i + 1;
    const cr = stripCr(allLines[i]!);

    if (/^\s*```/.test(cr)) {
      if (!inFence) {
        warn(fileWarnings, file, lineNumber, 'code-fence', 'code fence inside the backlog');
        inFence = true;
      } else {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    if (cr.trim() === '') continue;

    const indent = cr.match(/^[ \t]*/)?.[0] ?? '';
    if (indent.includes('\t')) {
      warn(fileWarnings, file, lineNumber, 'tab-indented', 'tab-indented bullet');
      continue;
    }
    if (indent.length > 0) {
      // Bugs allow no nesting — an indented bullet is over-indented; indented prose is skipped.
      const trimmed = cr.trimStart();
      if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
        warn(fileWarnings, file, lineNumber, 'over-indented', 'indented bullet (bugs allow no nesting)');
      }
      continue;
    }

    if (warnIfRejectedTopLevelForm(cr, fileWarnings, file, lineNumber)) continue;

    const cb = /^- \[([ xX])\](?: (.*))?$/.exec(cr);
    if (cb) {
      const status: BacklogStatus = cb[1] === ' ' ? 'open' : 'done';
      const body0 = (cb[2] ?? '').trimEnd();
      const { text, promotedTo, badMarker } = extractMarker(body0);
      items.push({
        id: computeBacklogId({ kind: 'bugs', file, lineNumber, raw: cr }),
        kind: 'bugs',
        text,
        status,
        body: [],
        ...(promotedTo ? { promotedTo } : {}),
        source: { file, lineNumber, raw: cr },
        warnings: badMarker ? ['bad-promotion-marker'] : [],
      });
      continue;
    }

    if (/^-\s/.test(cr)) {
      warn(fileWarnings, file, lineNumber, 'non-checkbox-bullet', 'non-checkbox dash bullet');
      continue;
    }
    // Headings / prose — skipped silently.
  }

  return { items, fileWarnings };
}

export function parseIdeas(content: string, file: string): ParsedBacklog {
  const items: BacklogItem[] = [];
  const fileWarnings: FileWarning[] = [];
  let section: BacklogSection = 'user-authored';
  let inComment = false;
  let commentOpenLine = 0;
  let inFence = false;
  // Most recent top-level item, for sub-bullet attachment. Reset to null on a blank line,
  // heading, or non-bullet line so a sub-bullet across any of those does NOT attach.
  let currentTopLevel: BacklogItem | null = null;

  const allLines = content.split('\n');
  for (let i = 0; i < allLines.length; i++) {
    const lineNumber = i + 1;
    const cr = stripCr(allLines[i]!);

    // Fence state takes priority over comment state: a `<!--` inside a code fence is fenced
    // content, not a real comment opener, so the fence guard must run first — otherwise an
    // unclosed `<!--` in a fence would hijack the comment-drainer and swallow the rest of the
    // file (including the fence's own closing ```).
    if (/^\s*```/.test(cr)) {
      if (!inFence) {
        warn(fileWarnings, file, lineNumber, 'code-fence', 'code fence inside the backlog');
        inFence = true;
      } else {
        inFence = false;
      }
      currentTopLevel = null;
      continue;
    }
    if (inFence) continue;

    if (inComment) {
      if (cr.includes('-->')) inComment = false;
      continue;
    }
    if (cr.trimStart().startsWith('<!--')) {
      if (!cr.includes('-->')) {
        inComment = true;
        commentOpenLine = lineNumber;
      }
      continue;
    }

    if (cr.trim() === '') {
      currentTopLevel = null;
      continue;
    }

    const heading = /^##\s+(.+)$/.exec(cr);
    if (heading) {
      const h = heading[1]!.trim().toLowerCase();
      if (h === 'user-authored') section = 'user-authored';
      else if (h === 'loop-filed') section = 'loop-filed';
      currentTopLevel = null;
      continue;
    }
    if (/^#/.test(cr)) {
      currentTopLevel = null;
      continue;
    }

    const indent = cr.match(/^[ \t]*/)?.[0] ?? '';
    if (indent.includes('\t')) {
      warn(fileWarnings, file, lineNumber, 'tab-indented', 'tab-indented bullet');
      continue;
    }

    if (indent.length === 0) {
      if (warnIfRejectedTopLevelForm(cr, fileWarnings, file, lineNumber)) continue;
      const tl = /^- (.*)$/.exec(cr);
      if (tl) {
        const body0 = (tl[1] ?? '').trimEnd();
        const { text, promotedTo, badMarker } = extractMarker(body0);
        const item: BacklogItem = {
          id: computeBacklogId({ kind: 'ideas', file, lineNumber, raw: cr }),
          kind: 'ideas',
          text,
          status: promotedTo ? 'done' : 'open',
          body: [],
          ...(promotedTo ? { promotedTo } : {}),
          section,
          source: { file, lineNumber, raw: cr },
          warnings: badMarker ? ['bad-promotion-marker'] : [],
        };
        items.push(item);
        currentTopLevel = item;
        continue;
      }
      // Unindented prose — skipped; breaks sub-bullet attachment.
      currentTopLevel = null;
      continue;
    }

    // Indented line.
    const trimmed = cr.trimStart();
    if (indent.length === 2 && /^- /.test(trimmed)) {
      if (currentTopLevel) {
        currentTopLevel.body.push(trimmed.replace(/^- /, '').trimEnd());
      } else {
        warn(
          fileWarnings,
          file,
          lineNumber,
          'orphan-subbullet',
          'sub-bullet detached from its top-level item',
        );
      }
      continue;
    }
    if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      warn(fileWarnings, file, lineNumber, 'over-indented', 'indentation deeper than two spaces');
    }
    // Indented prose — skipped.
  }

  // An HTML comment that opens but never closes suppresses every line after it. Surface that
  // as a warning rather than letting the file's tail silently vanish from the cockpit.
  if (inComment) {
    warn(
      fileWarnings,
      file,
      commentOpenLine,
      'unclosed-comment',
      'HTML comment opened but never closed — content below it was skipped',
    );
  }

  return { items, fileWarnings };
}
