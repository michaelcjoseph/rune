import { describe, it, expect } from 'vitest';

/*
 * Test suite for the backlog parser (09-expand-cockpit, Phase 1, written test-first).
 *
 * `backlog-parser.ts` owns the strict, pure line-parsing of a product repo's
 * `docs/projects/bugs.md` and `docs/projects/ideas.md` into structured
 * `BacklogItem`s plus file-level format warnings. The parser is STRICT: only the
 * accepted forms in spec.md "Parser contract" become items; everything else warns
 * and is skipped. A warning is either attached to the FILE (rendered as a drawer
 * banner — carries a line number + code) or to an ITEM (a `⚠` chip — a code string
 * in the item's `warnings[]`).
 *
 * Scope here is parsing forms + warning taxonomy + promotion-marker discrimination.
 * The deterministic id formula is covered separately in backlog-id.test.ts; here we
 * assert only that ids are present, well-shaped, and distinct. Action computation
 * (which needs runtime planning state) belongs to the reader/API layer, not the
 * pure parser — so parser items carry no `actions` field.
 *
 * This is the "test suite as deliverable" task: it is expected to stay RED (the
 * module does not exist yet) until the Phase 1 build task lands.
 */

import {
  parseBugs,
  parseIdeas,
  type BacklogItem,
  type ParsedBacklog,
} from './backlog-parser.js';

const BUGS_FILE = 'docs/projects/bugs.md';
const IDEAS_FILE = 'docs/projects/ideas.md';

/** Find the single item whose text matches exactly; fail loudly if absent/ambiguous. */
function byText(parsed: ParsedBacklog, text: string): BacklogItem {
  const matches = parsed.items.filter((i) => i.text === text);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one item with text ${JSON.stringify(text)}, found ${matches.length}`,
    );
  }
  return matches[0]!;
}

/** True if any file warning carries the given code (optionally at the given 1-based line). */
function hasFileWarning(parsed: ParsedBacklog, code: string, lineNumber?: number): boolean {
  return parsed.fileWarnings.some(
    (w) => w.code === code && (lineNumber === undefined || w.lineNumber === lineNumber),
  );
}

function lines(...l: string[]): string {
  return l.join('\n');
}

describe('backlog-parser — parseBugs accepted forms', () => {
  it('parses an open checkbox bug', () => {
    const parsed = parseBugs('- [ ] Cockpit shows wrong status', BUGS_FILE);
    expect(parsed.items).toHaveLength(1);
    const item = parsed.items[0]!;
    expect(item.kind).toBe('bugs');
    expect(item.text).toBe('Cockpit shows wrong status');
    expect(item.status).toBe('open');
    expect(item.body).toEqual([]);
    expect(item.promotedTo).toBeUndefined();
    expect(item.source.file).toBe(BUGS_FILE);
    expect(item.source.lineNumber).toBe(1);
    expect(item.warnings).toEqual([]);
  });

  it('parses a done checkbox with lowercase x', () => {
    const item = byText(parseBugs('- [x] Whoop date mismatch', BUGS_FILE), 'Whoop date mismatch');
    expect(item.status).toBe('done');
  });

  it('parses a done checkbox with uppercase X', () => {
    const item = byText(parseBugs('- [X] Whoop date mismatch', BUGS_FILE), 'Whoop date mismatch');
    expect(item.status).toBe('done');
  });

  it('parses an open bug with a valid promotion suffix', () => {
    const item = byText(
      parseBugs('- [ ] Cockpit status bug → 04-whoop-fix', BUGS_FILE),
      'Cockpit status bug',
    );
    expect(item.status).toBe('open');
    expect(item.promotedTo).toBe('04-whoop-fix');
    expect(item.warnings).toEqual([]);
  });

  it('parses a done bug with a valid promotion suffix', () => {
    const item = byText(
      parseBugs('- [x] Whoop date mismatch → 04-whoop-fix', BUGS_FILE),
      'Whoop date mismatch',
    );
    expect(item.status).toBe('done');
    expect(item.promotedTo).toBe('04-whoop-fix');
  });

  it('assigns each top-level bug a 1-based line number', () => {
    const parsed = parseBugs(lines('- [ ] First', '- [ ] Second', '- [ ] Third'), BUGS_FILE);
    expect(parsed.items.map((i) => i.source.lineNumber)).toEqual([1, 2, 3]);
  });
});

describe('backlog-parser — parseBugs rejected forms (file warnings)', () => {
  it('warns on a non-checkbox dash bullet and does not emit an item', () => {
    const parsed = parseBugs('- just a plain bullet, no checkbox', BUGS_FILE);
    expect(parsed.items).toHaveLength(0);
    expect(hasFileWarning(parsed, 'non-checkbox-bullet', 1)).toBe(true);
  });

  it('warns on a tab-indented bullet', () => {
    const parsed = parseBugs('\t- [ ] tabbed bug', BUGS_FILE);
    expect(parsed.items).toHaveLength(0);
    expect(hasFileWarning(parsed, 'tab-indented', 1)).toBe(true);
  });

  it('warns on a star bullet', () => {
    const parsed = parseBugs('* [ ] star bug', BUGS_FILE);
    expect(parsed.items).toHaveLength(0);
    expect(hasFileWarning(parsed, 'star-bullet', 1)).toBe(true);
  });

  it('warns on a numbered-list line', () => {
    const parsed = parseBugs('1. numbered bug', BUGS_FILE);
    expect(parsed.items).toHaveLength(0);
    expect(hasFileWarning(parsed, 'numbered-list', 1)).toBe(true);
  });

  it('warns on a blockquote line', () => {
    const parsed = parseBugs('> quoted bug', BUGS_FILE);
    expect(parsed.items).toHaveLength(0);
    expect(hasFileWarning(parsed, 'blockquote', 1)).toBe(true);
  });

  it('warns on a code fence inside the backlog', () => {
    const parsed = parseBugs(lines('- [ ] real bug', '```', 'code', '```'), BUGS_FILE);
    expect(byText(parsed, 'real bug')).toBeTruthy();
    expect(hasFileWarning(parsed, 'code-fence')).toBe(true);
  });

  it('warns on an indented checkbox (bugs allow no nesting)', () => {
    const parsed = parseBugs(lines('- [ ] top bug', '  - [ ] nested checkbox'), BUGS_FILE);
    expect(parsed.items).toHaveLength(1);
    expect(hasFileWarning(parsed, 'over-indented', 2)).toBe(true);
  });
});

describe('backlog-parser — promotion marker discrimination (strict slug regex)', () => {
  it('accepts a two-digit-dash-slug suffix as a promotion', () => {
    const item = byText(parseBugs('- [ ] x → 09-expand-cockpit', BUGS_FILE), 'x');
    expect(item.promotedTo).toBe('09-expand-cockpit');
    expect(item.warnings).toEqual([]);
  });

  it('rejects a single-digit prefix and flags bad-promotion-marker', () => {
    const item = byText(parseBugs('- [ ] x → 4-foo', BUGS_FILE), 'x → 4-foo');
    expect(item.promotedTo).toBeUndefined();
    expect(item.warnings).toContain('bad-promotion-marker');
  });

  it('rejects an uppercase slug and flags bad-promotion-marker', () => {
    const item = byText(parseBugs('- [ ] x → 04-Whoop', BUGS_FILE), 'x → 04-Whoop');
    expect(item.promotedTo).toBeUndefined();
    expect(item.warnings).toContain('bad-promotion-marker');
  });

  it('rejects a slug missing its dash and flags bad-promotion-marker', () => {
    const item = byText(parseBugs('- [ ] x → 04whoop', BUGS_FILE), 'x → 04whoop');
    expect(item.promotedTo).toBeUndefined();
    expect(item.warnings).toContain('bad-promotion-marker');
  });

  it('rejects a three-digit prefix and flags bad-promotion-marker', () => {
    const item = byText(parseBugs('- [ ] x → 123-foo', BUGS_FILE), 'x → 123-foo');
    expect(item.promotedTo).toBeUndefined();
    expect(item.warnings).toContain('bad-promotion-marker');
  });

  it('rejects an all-letter slug with no leading digits and flags bad-promotion-marker', () => {
    const item = byText(parseBugs('- [ ] x → foo-bar', BUGS_FILE), 'x → foo-bar');
    expect(item.promotedTo).toBeUndefined();
    expect(item.warnings).toContain('bad-promotion-marker');
  });

  it('does NOT misread a mid-sentence arrow with trailing words as a marker', () => {
    // "Map A → B correctly" ends in multiple tokens after the arrow, so it is not a
    // promotion marker at all — no promotion, no warning, full text preserved.
    const item = byText(parseBugs('- [ ] Map A → B correctly', BUGS_FILE), 'Map A → B correctly');
    expect(item.promotedTo).toBeUndefined();
    expect(item.warnings).toEqual([]);
  });
});

describe('backlog-parser — parseIdeas accepted forms', () => {
  it('parses a top-level idea under a User-authored heading', () => {
    const parsed = parseIdeas(lines('## User-authored', '- Some idea'), IDEAS_FILE);
    const item = byText(parsed, 'Some idea');
    expect(item.kind).toBe('ideas');
    expect(item.status).toBe('open');
    expect(item.section).toBe('user-authored');
    expect(item.body).toEqual([]);
    expect(item.source.lineNumber).toBe(2);
  });

  it('attaches exactly-two-space sub-bullets as the idea body', () => {
    const parsed = parseIdeas(
      lines('## User-authored', '- Top idea', '  - first sub', '  - second sub'),
      IDEAS_FILE,
    );
    expect(byText(parsed, 'Top idea').body).toEqual(['first sub', 'second sub']);
  });

  it('marks an idea done only when it carries a valid promotion suffix', () => {
    const parsed = parseIdeas(
      lines('## User-authored', '- Promoted idea → 09-expand-cockpit', '- Plain idea'),
      IDEAS_FILE,
    );
    const promoted = byText(parsed, 'Promoted idea');
    expect(promoted.status).toBe('done');
    expect(promoted.promotedTo).toBe('09-expand-cockpit');
    expect(byText(parsed, 'Plain idea').status).toBe('open');
  });

  it('assigns loop-filed section under the Loop-filed heading', () => {
    const parsed = parseIdeas(lines('## Loop-filed', '- Filed idea'), IDEAS_FILE);
    expect(byText(parsed, 'Filed idea').section).toBe('loop-filed');
  });

  it('defaults top-level bullets before any heading to user-authored', () => {
    const parsed = parseIdeas(
      lines('- Early idea', '## User-authored', '- Mid idea', '## Loop-filed', '- Filed idea'),
      IDEAS_FILE,
    );
    expect(byText(parsed, 'Early idea').section).toBe('user-authored');
    expect(byText(parsed, 'Mid idea').section).toBe('user-authored');
    expect(byText(parsed, 'Filed idea').section).toBe('loop-filed');
  });

  it('preserves a single-line loop-filed sentinel comment without warning or item', () => {
    const parsed = parseIdeas(
      lines('## Loop-filed', '<!-- observation-loop appends bullets below -->', '- Filed idea'),
      IDEAS_FILE,
    );
    expect(parsed.fileWarnings).toEqual([]);
    expect(byText(parsed, 'Filed idea').section).toBe('loop-filed');
  });

  it('ignores a multi-line HTML comment block entirely', () => {
    const parsed = parseIdeas(
      lines('## Loop-filed', '<!-- line one', 'line two', 'line three -->', '- Filed idea'),
      IDEAS_FILE,
    );
    expect(parsed.fileWarnings).toEqual([]);
    expect(parsed.items).toHaveLength(1);
    expect(byText(parsed, 'Filed idea').section).toBe('loop-filed');
  });

  it('warns (not silently) when an HTML comment is opened but never closed', () => {
    const parsed = parseIdeas(
      lines('## User-authored', '- Visible idea', '<!-- never closed', '- Hidden idea'),
      IDEAS_FILE,
    );
    // The idea above the open comment is parsed; the one below is suppressed — but the
    // suppression is surfaced, never silent.
    expect(parsed.items.map((i) => i.text)).toEqual(['Visible idea']);
    expect(hasFileWarning(parsed, 'unclosed-comment', 3)).toBe(true);
  });

  it('does not let an unclosed comment inside a code fence corrupt fence state', () => {
    // The `<!--` sits inside a fenced block, so it must be treated as fenced content, not a
    // comment opener. The fence closes normally and the item after it still parses.
    const parsed = parseIdeas(
      lines('## User-authored', '```', '<!-- unclosed in fence', 'code', '```', '- Real idea'),
      IDEAS_FILE,
    );
    expect(byText(parsed, 'Real idea').section).toBe('user-authored');
    expect(hasFileWarning(parsed, 'unclosed-comment')).toBe(false);
  });
});

describe('backlog-parser — parseIdeas sub-bullet attachment rules', () => {
  it('does NOT attach a sub-bullet separated from its top-level by a blank line', () => {
    const parsed = parseIdeas(
      lines('## User-authored', '- Top idea', '', '  - orphan sub'),
      IDEAS_FILE,
    );
    expect(byText(parsed, 'Top idea').body).toEqual([]);
    expect(hasFileWarning(parsed, 'orphan-subbullet', 4)).toBe(true);
  });

  it('warns on indentation deeper than two spaces', () => {
    const parsed = parseIdeas(
      lines('## User-authored', '- Top idea', '    - too deep'),
      IDEAS_FILE,
    );
    expect(byText(parsed, 'Top idea').body).toEqual([]);
    expect(hasFileWarning(parsed, 'over-indented', 3)).toBe(true);
  });
});

describe('backlog-parser — parseIdeas rejected forms (file warnings)', () => {
  it('warns on a tab-indented idea bullet', () => {
    const parsed = parseIdeas(lines('## User-authored', '\t- tabbed idea'), IDEAS_FILE);
    expect(parsed.items).toHaveLength(0);
    expect(hasFileWarning(parsed, 'tab-indented', 2)).toBe(true);
  });

  it('warns on a star bullet', () => {
    const parsed = parseIdeas(lines('## User-authored', '* star idea'), IDEAS_FILE);
    expect(parsed.items).toHaveLength(0);
    expect(hasFileWarning(parsed, 'star-bullet', 2)).toBe(true);
  });

  it('warns on a numbered-list line', () => {
    const parsed = parseIdeas(lines('## User-authored', '1. numbered idea'), IDEAS_FILE);
    expect(parsed.items).toHaveLength(0);
    expect(hasFileWarning(parsed, 'numbered-list', 2)).toBe(true);
  });

  it('warns on a blockquote line', () => {
    const parsed = parseIdeas(lines('## User-authored', '> quoted idea'), IDEAS_FILE);
    expect(parsed.items).toHaveLength(0);
    expect(hasFileWarning(parsed, 'blockquote', 2)).toBe(true);
  });
});

describe('backlog-parser — line-ending and whitespace handling', () => {
  it('parses CRLF files, stripping the carriage return from text', () => {
    const parsed = parseBugs('- [ ] First bug\r\n- [x] Second bug\r\n', BUGS_FILE);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]!.text).toBe('First bug');
    expect(parsed.items[1]!.text).toBe('Second bug');
    expect(parsed.items[1]!.status).toBe('done');
  });

  it('parses a file with no final newline', () => {
    const parsed = parseBugs('- [ ] Only bug', BUGS_FILE);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]!.text).toBe('Only bug');
  });

  it('preserves Unicode in bullet text', () => {
    const parsed = parseBugs('- [ ] Fix café 日本語 ½ rendering', BUGS_FILE);
    expect(parsed.items[0]!.text).toBe('Fix café 日本語 ½ rendering');
  });

  it('returns empty items and no error for an empty file', () => {
    const parsed = parseBugs('', BUGS_FILE);
    expect(parsed.items).toEqual([]);
    expect(parsed.fileWarnings).toEqual([]);
  });
});

describe('backlog-parser — item ids', () => {
  it('gives every item a 12-char hex id', () => {
    const parsed = parseBugs(lines('- [ ] First', '- [ ] Second'), BUGS_FILE);
    for (const item of parsed.items) {
      expect(item.id).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it('gives distinct items distinct ids', () => {
    const parsed = parseBugs(lines('- [ ] First', '- [ ] Second'), BUGS_FILE);
    expect(parsed.items[0]!.id).not.toBe(parsed.items[1]!.id);
  });

  it('is deterministic: re-parsing identical content yields identical ids', () => {
    const content = lines('- [ ] First', '- [ ] Second');
    const a = parseBugs(content, BUGS_FILE);
    const b = parseBugs(content, BUGS_FILE);
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
  });
});
