import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/test/vault',
    TIMEZONE: 'America/Chicago',
    FAMILY_NAMES: ['Alice', 'Bob'],
  },
}));

vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
  vaultFileExists: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const {
  slugify,
  loadAliasMap,
  linkEntities,
  extractExistingRelated,
  applyRelatedFrontmatter,
  findReferenceRanges,
  matchAlias,
} = await import('./entity-extract.js');
const { readVaultFile, vaultFileExists } = await import('../vault/files.js');

function setExistingPages(slugs: string[]): void {
  const set = new Set(slugs);
  vi.mocked(vaultFileExists).mockImplementation((path: string) => {
    const m = path.match(/knowledge\/wiki\/(?:entities|books|places)\/(.+)\.md$/);
    return m !== null && set.has(m[1]!);
  });
}

describe('slugify', () => {
  it('lowercases and hyphenates multi-word names', () => {
    expect(slugify('Patrick Collison')).toBe('patrick-collison');
  });

  it('strips accents', () => {
    expect(slugify('Lucía Martínez')).toBe('lucia-martinez');
  });

  it('collapses multiple spaces', () => {
    expect(slugify('  John    Doe  ')).toBe('john-doe');
  });

  it('strips non-alphanumerics except dash/space', () => {
    expect(slugify("O'Reilly, Inc.")).toBe('oreilly-inc');
  });
});

describe('loadAliasMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readVaultFile).mockImplementation(() => null);
  });

  it('includes FAMILY_NAMES as person entries', () => {
    const map = loadAliasMap();
    const slugs = map.map(e => e.canonicalSlug);
    expect(slugs).toContain('alice');
    expect(slugs).toContain('bob');
    expect(map.find(e => e.canonicalSlug === 'alice')!.kind).toBe('person');
  });

  it('includes crm.json name field as person entries', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) => {
      if (path === 'pages/crm.json') return JSON.stringify([{ name: 'Patrick Collison' }]);
      return null;
    });
    const map = loadAliasMap();
    const patrick = map.find(e => e.canonicalSlug === 'patrick-collison')!;
    expect(patrick).toBeDefined();
    expect(patrick.kind).toBe('person');
  });

  it('includes books.json title field as book entries', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) => {
      if (path === 'pages/books.json') return JSON.stringify([{ title: 'Thinking Fast and Slow' }]);
      return null;
    });
    const map = loadAliasMap();
    const book = map.find(e => e.canonicalSlug === 'thinking-fast-and-slow')!;
    expect(book).toBeDefined();
    expect(book.kind).toBe('book');
  });

  it('includes places.json name field as place entries', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) => {
      if (path === 'pages/places.json') return JSON.stringify([{ name: 'Kyoto' }]);
      return null;
    });
    const map = loadAliasMap();
    const place = map.find(e => e.canonicalSlug === 'kyoto')!;
    expect(place).toBeDefined();
    expect(place.kind).toBe('place');
  });

  it('tolerates malformed JSON without throwing', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) => {
      if (path === 'pages/crm.json') return '{not json';
      return null;
    });
    expect(() => loadAliasMap()).not.toThrow();
  });

  it('skips entries with missing or empty name field', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) => {
      if (path === 'pages/crm.json') return JSON.stringify([
        { name: 'Valid Name' },
        { name: '' },
        { other: 'no name field' },
        null,
      ]);
      return null;
    });
    const map = loadAliasMap();
    const personEntries = map.filter(e => e.kind === 'person' && !['alice', 'bob'].includes(e.canonicalSlug));
    expect(personEntries).toHaveLength(1);
    expect(personEntries[0]!.canonicalSlug).toBe('valid-name');
  });

  it('merges duplicate canonical slugs across sources (family + crm)', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) => {
      if (path === 'pages/crm.json') return JSON.stringify([{ name: 'Alice' }]);
      return null;
    });
    const map = loadAliasMap();
    const alice = map.filter(e => e.canonicalSlug === 'alice');
    expect(alice).toHaveLength(1);
    expect(alice[0]!.aliases).toEqual(['Alice']);
  });
});

describe('matchAlias', () => {
  it('matches person name with word boundary', () => {
    expect(matchAlias('I met Patrick yesterday', 'Patrick', 'person')).not.toBeNull();
  });

  it('does NOT match "Stripe" inside "stripes" — \\b prevents intra-word match', () => {
    // `\b` asserts a boundary between a word char and a non-word char. Between
    // "Stripe" and "s" in "stripes" both are word chars, so no boundary
    // exists and the regex fails to match. Case-sensitivity is additionally
    // enforced for personal names; here lowercase "stripes" also differs in
    // casing from "Stripe".
    expect(matchAlias('she wore stripes today', 'Stripe', 'person')).toBeNull();
  });

  it('matches case-sensitively for person names', () => {
    expect(matchAlias('patrick lowercase', 'Patrick', 'person')).toBeNull();
    expect(matchAlias('Patrick titlecase', 'Patrick', 'person')).not.toBeNull();
  });

  it('matches case-insensitively for books/places', () => {
    expect(matchAlias('reading THINKING FAST AND SLOW', 'Thinking Fast and Slow', 'book')).not.toBeNull();
    expect(matchAlias('visited kyoto', 'Kyoto', 'place')).not.toBeNull();
  });

  it('respects word boundary even for book titles', () => {
    expect(matchAlias('kyototropolis', 'Kyoto', 'place')).toBeNull();
  });
});

describe('findReferenceRanges', () => {
  it('returns [] when no references section present', () => {
    expect(findReferenceRanges('# Title\n\nSome prose.')).toEqual([]);
  });

  it('detects a `## References` section', () => {
    const content = '# Title\n\nProse.\n\n## References\n- [[foo]]\n- bar\n';
    const ranges = findReferenceRanges(content);
    expect(ranges).toHaveLength(1);
    expect(content.slice(ranges[0]!.start, ranges[0]!.end)).toContain('foo');
  });

  it('detects a `## See also` section (case-insensitive)', () => {
    const content = '# Title\n\n## see also\n- entity\n';
    expect(findReferenceRanges(content)).toHaveLength(1);
  });

  it('bounds a section at the next `##` heading', () => {
    const content = '# Title\n\n## References\n- foo\n\n## Notes\nprose with Patrick.\n';
    const ranges = findReferenceRanges(content);
    expect(ranges).toHaveLength(1);
    const region = content.slice(ranges[0]!.start, ranges[0]!.end);
    expect(region).toContain('foo');
    expect(region).not.toContain('Patrick');
  });
});

describe('extractExistingRelated', () => {
  it('returns [] when frontmatter is absent', () => {
    expect(extractExistingRelated('# Just prose, no frontmatter.')).toEqual([]);
  });

  it('parses an inline list', () => {
    const content = '---\ntype: entity\nrelated: [foo, bar, baz]\n---\n# Title';
    expect(extractExistingRelated(content)).toEqual(['foo', 'bar', 'baz']);
  });

  it('parses a block list', () => {
    const content = '---\ntype: entity\nrelated:\n  - foo\n  - bar\n---\n# Title';
    expect(extractExistingRelated(content)).toEqual(['foo', 'bar']);
  });

  it('strips surrounding quotes from inline entries', () => {
    const content = '---\nrelated: ["foo", \'bar\']\n---\n';
    expect(extractExistingRelated(content)).toEqual(['foo', 'bar']);
  });

  it('returns [] when related: field is absent', () => {
    expect(extractExistingRelated('---\ntype: entity\n---\n')).toEqual([]);
  });
});

describe('applyRelatedFrontmatter', () => {
  it('appends related: when frontmatter exists but field is absent', () => {
    const input = '---\ntype: entity\ncreated: 2025-01-01\n---\n# Title';
    const output = applyRelatedFrontmatter(input, ['foo', 'bar']);
    expect(output).toContain('related: [foo, bar]');
  });

  it('replaces an existing inline related: line', () => {
    const input = '---\nrelated: [old-entry]\n---\n# Title';
    const output = applyRelatedFrontmatter(input, ['foo', 'bar']);
    expect(output).toContain('related: [foo, bar]');
    expect(output).not.toContain('old-entry');
  });

  it('replaces an existing block related: list', () => {
    const input = '---\nrelated:\n  - old\n  - stale\n---\n# Title';
    const output = applyRelatedFrontmatter(input, ['foo']);
    expect(output).toContain('related: [foo]');
    expect(output).not.toContain('old');
  });

  it('returns content unchanged when no frontmatter present', () => {
    const input = '# No frontmatter here';
    expect(applyRelatedFrontmatter(input, ['foo'])).toBe(input);
  });

  it('uses empty list syntax when related array is empty', () => {
    const input = '---\ntype: entity\n---\n# Title';
    const output = applyRelatedFrontmatter(input, []);
    expect(output).toContain('related: []');
  });

  it('replaces a bare `related:` key with no value (does not duplicate the key)', () => {
    // Wiki-compiler and hand-authored pages commonly emit `related:` with
    // no inline value and no block-list items. Without explicit handling
    // the append branch would produce two `related:` keys.
    const input = '---\ntype: entity\nrelated:\ncreated: 2025-01-01\n---\n# Title';
    const output = applyRelatedFrontmatter(input, ['foo', 'bar']);
    expect(output).toContain('related: [foo, bar]');
    // Exactly one occurrence of `related:` in the frontmatter.
    const frontmatter = output.match(/^---\n([\s\S]*?)\n---/)![1]!;
    const matches = frontmatter.match(/^related:/gm) || [];
    expect(matches).toHaveLength(1);
  });
});

describe('linkEntities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readVaultFile).mockImplementation(() => null);
    vi.mocked(vaultFileExists).mockReturnValue(false);
  });

  it('returns unchanged content when no aliases match', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) =>
      path === 'pages/crm.json' ? JSON.stringify([{ name: 'Patrick Collison' }]) : null,
    );
    setExistingPages(['patrick-collison']);
    const content = '---\ntype: entity\n---\n# Topic\n\nProse about something else entirely.\n';
    const result = linkEntities('knowledge/wiki/topics/foo.md', content);
    expect(result.updatedContent).toBe(content);
    expect(result.related).toEqual([]);
  });

  it('skips aliases whose canonical wiki page does not yet exist', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) =>
      path === 'pages/crm.json' ? JSON.stringify([{ name: 'Patrick Collison' }]) : null,
    );
    // No existing pages
    setExistingPages([]);
    const content = '---\ntype: entity\n---\n# Topic\n\nPatrick Collison is notable.\n';
    const result = linkEntities('knowledge/wiki/topics/foo.md', content);
    expect(result.related).toEqual([]);
    expect(result.updatedContent).toBe(content);
  });

  it('appends matched canonical slugs to `related:` frontmatter (deduped)', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) =>
      path === 'pages/crm.json' ? JSON.stringify([{ name: 'Patrick Collison' }]) : null,
    );
    setExistingPages(['patrick-collison']);
    const content = '---\ntype: entity\nrelated: [existing]\n---\n# Topic\n\nPatrick Collison runs Stripe.\n';
    const result = linkEntities('knowledge/wiki/topics/foo.md', content);
    expect(result.related).toEqual(['existing', 'patrick-collison']);
    expect(result.updatedContent).toContain('related: [existing, patrick-collison]');
  });

  it('does not duplicate a canonical that was already in existing `related:`', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) =>
      path === 'pages/crm.json' ? JSON.stringify([{ name: 'Patrick Collison' }]) : null,
    );
    setExistingPages(['patrick-collison']);
    const content = '---\ntype: entity\nrelated: [patrick-collison]\n---\n# Topic\n\nPatrick Collison.\n';
    const result = linkEntities('knowledge/wiki/topics/foo.md', content);
    expect(result.related).toEqual(['patrick-collison']);
    // The related list should not grow just because the entity was mentioned
    // again in prose.
    expect(result.updatedContent).toContain('related: [patrick-collison]');
    expect(result.updatedContent).not.toContain('related: [patrick-collison, patrick-collison]');
  });

  it('rewrites bare mentions inside a References section to [[wikilinks]]', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) =>
      path === 'pages/crm.json' ? JSON.stringify([{ name: 'Patrick Collison' }]) : null,
    );
    setExistingPages(['patrick-collison']);
    const content = '---\ntype: entity\n---\n# Topic\n\nPatrick Collison is notable in prose.\n\n## References\n- Patrick Collison\n- Something else\n';
    const result = linkEntities('knowledge/wiki/topics/foo.md', content);
    // Prose mention unchanged, References mention becomes a wikilink.
    expect(result.updatedContent).toMatch(/is notable in prose\.\n/);
    expect(result.updatedContent).toMatch(/## References\n- \[\[patrick-collison\]\]/);
  });

  it('does NOT rewrite prose mentions (References-only policy)', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) =>
      path === 'pages/crm.json' ? JSON.stringify([{ name: 'Patrick Collison' }]) : null,
    );
    setExistingPages(['patrick-collison']);
    const content = '---\ntype: entity\n---\n# Topic\n\nPatrick Collison in prose only, no references section.\n';
    const result = linkEntities('knowledge/wiki/topics/foo.md', content);
    expect(result.updatedContent).not.toContain('[[patrick-collison]]');
    expect(result.related).toEqual(['patrick-collison']);
  });

  it('picks the longest alias when multiple aliases of one entity match', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) =>
      path === 'pages/crm.json'
        ? JSON.stringify([{ name: 'Patrick Collison' }, { name: 'Patrick' }])
        : null,
    );
    setExistingPages(['patrick-collison', 'patrick']);
    const content = '---\ntype: entity\n---\n# Topic\n\n## See also\n- Patrick Collison of Stripe\n';
    const result = linkEntities('knowledge/wiki/topics/foo.md', content);
    // Longest-first substitution: "Patrick Collison" gets the wikilink, not the shorter "Patrick".
    expect(result.updatedContent).toContain('[[patrick-collison]]');
    expect(result.updatedContent).not.toContain('[[patrick]] Collison');
  });

  it('does not re-wrap mentions already inside [[...]]', () => {
    vi.mocked(readVaultFile).mockImplementation((path: string) =>
      path === 'pages/crm.json' ? JSON.stringify([{ name: 'Patrick' }]) : null,
    );
    setExistingPages(['patrick']);
    const content = '---\ntype: entity\n---\n# Topic\n\n## References\n- [[patrick]] again\n';
    const result = linkEntities('knowledge/wiki/topics/foo.md', content);
    // Should NOT produce [[[[patrick]]]]
    expect(result.updatedContent).not.toContain('[[[[');
    expect(result.updatedContent).not.toContain(']]]]');
  });

  it('matches FAMILY_NAMES (no JSON source) against content', () => {
    // FAMILY_NAMES contains 'Alice' per mock
    setExistingPages(['alice']);
    const content = '---\ntype: entity\n---\n# Topic\n\nSpoke with Alice today.\n\n## References\n- Alice from the meeting\n';
    const result = linkEntities('knowledge/wiki/topics/foo.md', content);
    expect(result.related).toContain('alice');
    expect(result.updatedContent).toContain('[[alice]]');
  });

  it('preserves prose with Stripe vs stripes (case-sensitive person guard)', () => {
    // Simulate that "Stripe" is a person entry (strange but tests the case-sensitivity guard)
    vi.mocked(readVaultFile).mockImplementation((path: string) =>
      path === 'pages/crm.json' ? JSON.stringify([{ name: 'Stripe' }]) : null,
    );
    setExistingPages(['stripe']);
    const content = '---\ntype: entity\n---\n# Topic\n\nShe wore stripes of color today.\n';
    const result = linkEntities('knowledge/wiki/topics/foo.md', content);
    expect(result.related).toEqual([]);
    expect(result.updatedContent).toBe(content);
  });
});
