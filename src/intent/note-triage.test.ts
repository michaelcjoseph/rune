import { describe, it, expect } from 'vitest';

/*
 * Pure-core tests for the nightly note-triage step (project 23): agent-output validation,
 * item→file-plan routing (with resolveProductTarget re-validation), project-page hint
 * extraction, and the append/dedupe helpers. No I/O, no mocks — the filesystem composition is
 * covered by src/jobs/note-triage.test.ts.
 */

import {
  MAX_ITEMS_PER_PASS,
  parseNoteTriageOutput,
  routeNoteItems,
  extractProjectPageHints,
  normalizeNoteTitle,
  containsNoteTitle,
  appendVaultIdeaBlocks,
  appendTopicLines,
  type NoteTriageItem,
  type NoteTriageProductConfig,
} from './note-triage.js';
import { parseIdeas } from './backlog-parser.js';

const DATE = '2026-07-08';

function item(overrides: Partial<NoteTriageItem>): NoteTriageItem {
  return { type: 'idea', product: null, title: 'A title', detail: 'A detail.', ...overrides };
}

const PRODUCTS: Record<string, NoteTriageProductConfig> = {
  aura: { repoPath: '/ws/aura', containerCapabilities: { bugs: true, ideas: true } },
  rune: { repoPath: '/ws/rune', containerCapabilities: { bugs: true, ideas: true } },
  writing: {
    repoPath: '/ws/michaelcjoseph.com',
    scopePath: 'docs/rune',
    containerCapabilities: { bugs: false, ideas: true },
  },
  brand: { repoPath: '/ws/michaelcjoseph.com', containerCapabilities: { bugs: true, ideas: true } },
};

describe('parseNoteTriageOutput', () => {
  it('parses a bare JSON array', () => {
    const result = parseNoteTriageOutput('[{"type":"idea","product":"aura","title":"T","detail":"D"}]');
    expect(result).toEqual({ ok: true, items: [{ type: 'idea', product: 'aura', title: 'T', detail: 'D' }] });
  });

  it('strips ```json fences', () => {
    const result = parseNoteTriageOutput('```json\n[{"type":"bug","product":null,"title":"T","detail":"D"}]\n```');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]!.type).toBe('bug');
  });

  it('rejects invalid JSON and non-array JSON with a typed failure', () => {
    expect(parseNoteTriageOutput('not json').ok).toBe(false);
    expect(parseNoteTriageOutput('{"type":"idea"}').ok).toBe(false);
  });

  it('drops malformed elements instead of failing the pass', () => {
    const result = parseNoteTriageOutput(JSON.stringify([
      { type: 'idea', product: null, title: 'Good', detail: 'Kept.' },
      { type: 'unknown-type', product: null, title: 'X', detail: 'Y' },
      { type: 'idea', product: null, title: '', detail: 'Empty title' },
      { type: 'idea', product: null, title: 'No detail', detail: '   ' },
      'not-an-object',
      null,
      { type: 'idea', title: 'Missing detail field' },
    ]));
    expect(result).toEqual({ ok: true, items: [{ type: 'idea', product: null, title: 'Good', detail: 'Kept.' }] });
  });

  it('collapses internal whitespace/newlines to single spaces (single-line discipline)', () => {
    const result = parseNoteTriageOutput(JSON.stringify([
      { type: 'idea', product: '  aura  ', title: 'Multi\n line\ttitle', detail: 'a\nb' },
    ]));
    expect(result).toEqual({
      ok: true,
      items: [{ type: 'idea', product: 'aura', title: 'Multi line title', detail: 'a b' }],
    });
  });

  it('normalizes blank product to null and drops oversized fields', () => {
    const result = parseNoteTriageOutput(JSON.stringify([
      { type: 'idea', product: '  ', title: 'T', detail: 'D' },
      { type: 'idea', product: null, title: 'x'.repeat(201), detail: 'D' },
      { type: 'idea', product: null, title: 'T2', detail: 'x'.repeat(1001) },
    ]));
    expect(result).toEqual({ ok: true, items: [{ type: 'idea', product: null, title: 'T', detail: 'D' }] });
  });

  it(`caps the batch at ${MAX_ITEMS_PER_PASS} items`, () => {
    const many = Array.from({ length: MAX_ITEMS_PER_PASS + 10 }, (_, i) => (
      { type: 'idea', product: null, title: `T${i}`, detail: 'D' }
    ));
    const result = parseNoteTriageOutput(JSON.stringify(many));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toHaveLength(MAX_ITEMS_PER_PASS);
  });
});

describe('routeNoteItems', () => {
  it('routes an idea with a registered product to that repo backlog', () => {
    const { plans, skipped } = routeNoteItems([item({ product: 'aura', title: 'Dark mode', detail: 'Add a toggle.' })], PRODUCTS, DATE);
    expect(skipped).toEqual([]);
    expect(plans).toEqual([{
      kind: 'product-idea',
      product: 'aura',
      repoPath: '/ws/aura',
      relPath: 'docs/projects/ideas.md',
      text: 'Dark mode — Add a toggle. (journal 2026-07-08)',
    }]);
  });

  it('matches product names case-insensitively', () => {
    const { plans } = routeNoteItems([item({ product: 'Aura' })], PRODUCTS, DATE);
    expect(plans[0]).toMatchObject({ kind: 'product-idea', product: 'aura' });
  });

  it('routes an idea with a null or unregistered product to the vault (new-product path)', () => {
    const { plans } = routeNoteItems([
      item({ product: null, title: 'New venture' }),
      item({ product: 'not-a-product', title: 'Invented' }),
    ], PRODUCTS, DATE);
    expect(plans.map((p) => p.kind)).toEqual(['vault-idea', 'vault-idea']);
    expect(plans[0]).toMatchObject({ title: 'New venture', sourceDate: '2026_07_08' });
  });

  it('coerces an idea claimed for the writing product into a writing topic', () => {
    const { plans } = routeNoteItems([item({ product: 'writing', title: 'Essay on taste' })], PRODUCTS, DATE);
    expect(plans).toEqual([expect.objectContaining({
      kind: 'topic',
      topic: 'writing',
      relPath: 'docs/rune/writing-ideas.md',
      title: 'Essay on taste',
    })]);
  });

  it('routes a bug with a bugs-capable product to that repo bugs.md', () => {
    const { plans } = routeNoteItems([item({ type: 'bug', product: 'rune', title: 'Crash', detail: 'On boot.' })], PRODUCTS, DATE);
    expect(plans).toEqual([{
      kind: 'product-bug',
      product: 'rune',
      repoPath: '/ws/rune',
      relPath: 'docs/projects/bugs.md',
      text: 'Crash — On boot. (journal 2026-07-08)',
    }]);
  });

  it('fails a bug closed to the vault when the product is unknown or bugs-disabled', () => {
    const { plans } = routeNoteItems([
      item({ type: 'bug', product: null, title: 'Mystery crash' }),
      item({ type: 'bug', product: 'writing', title: 'Typo engine' }),
    ], PRODUCTS, DATE);
    expect(plans.map((p) => p.kind)).toEqual(['vault-idea', 'vault-idea']);
    expect(plans[0]).toMatchObject({ title: '[Bug — unrouted] Mystery crash' });
    expect(plans[1]).toMatchObject({ title: '[Bug — unrouted] Typo engine' });
  });

  it('routes writing and research topics to the writing product scoped files', () => {
    const { plans } = routeNoteItems([
      item({ type: 'writing-topic', title: 'On agents' }),
      item({ type: 'research-topic', title: 'Quantum papers' }),
    ], PRODUCTS, DATE);
    expect(plans).toEqual([
      expect.objectContaining({ kind: 'topic', topic: 'writing', relPath: 'docs/rune/writing-ideas.md', repoPath: '/ws/michaelcjoseph.com', scopePath: 'docs/rune' }),
      expect.objectContaining({ kind: 'topic', topic: 'research', relPath: 'docs/rune/research-topics.md' }),
    ]);
  });

  it('skips topics when no writing product (or no scopePath) is registered', () => {
    const noWriting: Record<string, NoteTriageProductConfig> = { aura: PRODUCTS.aura! };
    const noScope: Record<string, NoteTriageProductConfig> = { writing: { repoPath: '/ws/x' } };
    for (const products of [noWriting, noScope]) {
      const { plans, skipped } = routeNoteItems([item({ type: 'writing-topic' })], products, DATE);
      expect(plans).toEqual([]);
      expect(skipped).toEqual([{ item: expect.objectContaining({ type: 'writing-topic' }), reason: 'no-writing-product' }]);
    }
  });

  it('fails an idea closed to the vault when the product has ideas disabled', () => {
    const products: Record<string, NoteTriageProductConfig> = {
      locked: { repoPath: '/ws/locked', containerCapabilities: { bugs: true, ideas: false } },
    };
    const { plans } = routeNoteItems([item({ product: 'locked' })], products, DATE);
    expect(plans.map((p) => p.kind)).toEqual(['vault-idea']);
  });
});

describe('extractProjectPageHints', () => {
  const PAGES = ['aura', 'rune', 'watt-data', 'health'];
  const PRODUCT_NAMES = ['aura', 'rune', 'writing'];

  it('maps a registered-page wikilink to its product and a non-product page to null', () => {
    const hints = extractProjectPageHints(
      'Worked on [[aura]] today; also thought about [[watt-data]].',
      PAGES,
      PRODUCT_NAMES,
    );
    expect(hints).toEqual([
      { page: 'aura', product: 'aura' },
      { page: 'watt-data', product: null },
    ]);
  });

  it('matches case-insensitively and handles alias/heading wikilink forms', () => {
    const hints = extractProjectPageHints(
      'See [[Aura|the app]] and [[rune#Nightly]] notes.',
      PAGES,
      PRODUCT_NAMES,
    );
    expect(hints).toEqual([
      { page: 'aura', product: 'aura' },
      { page: 'rune', product: 'rune' },
    ]);
  });

  it('dedupes repeated mentions and ignores plain-text (non-wikilink) matches', () => {
    const hints = extractProjectPageHints(
      'aura aura aura. [[aura]] again [[aura]]. And [[unrelated-page]].',
      PAGES,
      PRODUCT_NAMES,
    );
    expect(hints).toEqual([{ page: 'aura', product: 'aura' }]);
  });
});

describe('normalizeNoteTitle / containsNoteTitle', () => {
  it('normalizes punctuation and unicode dashes to spaces', () => {
    expect(normalizeNoteTitle('Agent-Led Growth (ALG) — vs PLG!')).toBe('agent led growth alg vs plg');
  });

  it('finds a title across bullet/checkbox/heading formats', () => {
    const content = '- [ ] Crash on boot — details\n- **On taste** — an essay\n### Pastor AI\n';
    expect(containsNoteTitle(content, 'Crash on boot')).toBe(true);
    expect(containsNoteTitle(content, 'On Taste')).toBe(true);
    expect(containsNoteTitle(content, 'Pastor AI')).toBe(true);
    expect(containsNoteTitle(content, 'Absent title')).toBe(false);
    expect(containsNoteTitle(content, '—')).toBe(false); // normalizes to empty — never matches
  });
});

describe('appendVaultIdeaBlocks', () => {
  const VAULT_IDEAS = `# Project Ideas

Intro text.

## Ideas

### Existing Idea
Detail.
*Source: [[2026_01_01]]*

## Supersession audit

- 2026-06-29: audit line.
`;

  it('inserts new blocks at the end of ## Ideas, before ## Supersession audit', () => {
    const { content, appended } = appendVaultIdeaBlocks(VAULT_IDEAS, [
      { title: 'New Thing', detail: 'A new idea.', sourceDate: '2026_07_08' },
    ]);
    expect(appended).toBe(1);
    const ideasIdx = content.indexOf('### New Thing');
    const auditIdx = content.indexOf('## Supersession audit');
    expect(ideasIdx).toBeGreaterThan(content.indexOf('## Ideas'));
    expect(ideasIdx).toBeLessThan(auditIdx);
    expect(content).toContain('### New Thing\nA new idea.\n*Source: [[2026_07_08]]*');
    // The existing content is untouched.
    expect(content).toContain('### Existing Idea');
    expect(content).toContain('- 2026-06-29: audit line.');
  });

  it('creates the ## Ideas heading at EOF when absent', () => {
    const { content, appended } = appendVaultIdeaBlocks('# Project Ideas\n', [
      { title: 'First', detail: 'D.', sourceDate: '2026_07_08' },
    ]);
    expect(appended).toBe(1);
    expect(content).toContain('## Ideas\n\n### First');
  });

  it('dedupes against existing ### headings and within the batch', () => {
    const { content, appended } = appendVaultIdeaBlocks(VAULT_IDEAS, [
      { title: 'Existing Idea', detail: 'Dupe.', sourceDate: '2026_07_08' },
      { title: 'Fresh', detail: 'Kept.', sourceDate: '2026_07_08' },
      { title: 'fresh!', detail: 'Batch dupe.', sourceDate: '2026_07_08' },
    ]);
    expect(appended).toBe(1);
    expect(content).toContain('### Fresh');
    expect(content).not.toContain('Batch dupe');
    expect(content.match(/### Existing Idea/g)).toHaveLength(1);
  });

  it('returns content unchanged when everything is a dupe', () => {
    const { content, appended } = appendVaultIdeaBlocks(VAULT_IDEAS, [
      { title: 'Existing Idea', detail: 'Dupe.', sourceDate: '2026_07_08' },
    ]);
    expect(appended).toBe(0);
    expect(content).toBe(VAULT_IDEAS);
  });
});

describe('appendTopicLines', () => {
  it('seeds the header when the file is missing (null content)', () => {
    const { content, appended } = appendTopicLines(null, 'Writing ideas', [
      { title: 'On taste', detail: 'How taste develops', sourceDate: '2026_07_08' },
    ]);
    expect(appended).toBe(1);
    expect(content).toBe('# Writing ideas\n- **On taste** — How taste develops. Source: [[2026_07_08]]\n');
  });

  it('appends at EOF and dedupes on-disk + in-batch', () => {
    const existing = '# Writing ideas\n- **On taste** — old entry. Source: [[2026_06_01]]\n';
    const { content, appended } = appendTopicLines(existing, 'Writing ideas', [
      { title: 'On Taste', detail: 'dupe', sourceDate: '2026_07_08' },
      { title: 'Second brain', detail: 'New topic.', sourceDate: '2026_07_08' },
      { title: 'second-brain', detail: 'batch dupe', sourceDate: '2026_07_08' },
    ]);
    expect(appended).toBe(1);
    expect(content).toContain('- **Second brain** — New topic. Source: [[2026_07_08]]');
    expect(content).not.toContain('batch dupe');
  });

  it('emits lines that round-trip through parseIdeas as open user-authored ideas (cockpit visibility)', () => {
    const { content } = appendTopicLines(null, 'Writing ideas', [
      { title: 'Agent-led growth', detail: 'ALG vs PLG.', sourceDate: '2026_07_08' },
      { title: 'Develop taste', detail: 'A follow-up piece', sourceDate: '2026_07_08' },
    ]);
    const parsed = parseIdeas(content, 'docs/rune/writing-ideas.md');
    expect(parsed.items).toHaveLength(2);
    for (const parsedItem of parsed.items) {
      expect(parsedItem.status).toBe('open');
      expect(parsedItem.section).toBe('user-authored');
      expect(parsedItem.warnings).toEqual([]);
    }
    expect(parsed.fileWarnings).toEqual([]);
  });
});
