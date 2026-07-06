/**
 * Failing tests for `src/intent/observation-ideas-io.ts` — project
 * 08-intent-layer Phase 6 B4.2 + B4.3.
 *
 * `readFiledIdeas` parses the `## Loop-filed` section of
 * `docs/projects/ideas.md` into `ProjectIdea[]` with deterministic ids
 * so the loop's dedupe holds across passes. `appendFiledIdeas` appends
 * `formatIdeasMarkdown`'s output to the same section.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { readFiledIdeas, appendFiledIdeas, deriveIdeaId } = await import('./observation-ideas-io.js');

let tmpDir: string;
let ideasPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rune-ideas-io-test-'));
  ideasPath = join(tmpDir, 'ideas.md');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

import { afterEach } from 'vitest';

describe('deriveIdeaId — same rule as the observation-triage agent', () => {
  it('lowercases, replaces non-alphanumeric runs with single hyphen, trims, caps at 60', () => {
    expect(deriveIdeaId('Resolver mis-routes /weekly when user asks for /daily')).toBe(
      'resolver-mis-routes-weekly-when-user-asks-for-daily',
    );
  });

  it('trailing punctuation collapses (same friction → same id)', () => {
    expect(deriveIdeaId('Resolver mis-routes /weekly when user asks for /daily.')).toBe(
      'resolver-mis-routes-weekly-when-user-asks-for-daily',
    );
  });

  it('truncates at 60 characters', () => {
    const long = 'a'.repeat(100);
    expect(deriveIdeaId(long)).toBe('a'.repeat(60));
  });

  it('empty input → empty string', () => {
    expect(deriveIdeaId('')).toBe('');
  });
});

describe('readFiledIdeas', () => {
  it('returns [] when the file is missing', () => {
    const ideas = readFiledIdeas(join(tmpDir, 'missing.md'));
    expect(ideas).toEqual([]);
  });

  it('returns [] when there is no Loop-filed section', () => {
    writeFileSync(ideasPath, '# Project Ideas\n\n## User-authored\n\n- one\n- two\n');
    expect(readFiledIdeas(ideasPath)).toEqual([]);
  });

  it('returns [] when the Loop-filed section is empty (no bullets after the header)', () => {
    writeFileSync(ideasPath, '# Project Ideas\n\n## Loop-filed\n\n');
    expect(readFiledIdeas(ideasPath)).toEqual([]);
  });

  it('parses bullets shaped like `- **Title** — friction` under Loop-filed', () => {
    writeFileSync(ideasPath, [
      '# Project Ideas',
      '',
      '## User-authored',
      '',
      '- some user idea (no structured shape)',
      '',
      '## Loop-filed',
      '',
      '- **Fix resolver routing** — resolver mis-routes /weekly when user asks for /daily',
      '- **Make wiki-compiler robust** — wiki-compiler times out on large ingests',
      '',
    ].join('\n'));

    const ideas = readFiledIdeas(ideasPath);
    expect(ideas).toHaveLength(2);
    expect(ideas[0]!.title).toBe('Fix resolver routing');
    expect(ideas[0]!.friction).toBe('resolver mis-routes /weekly when user asks for /daily');
    expect(ideas[1]!.title).toBe('Make wiki-compiler robust');
  });

  it('derives id via deriveIdeaId so dedupe matches the triage agent', () => {
    writeFileSync(ideasPath, [
      '## Loop-filed',
      '',
      '- **Fix resolver** — Resolver mis-routes /weekly when user asks for /daily',
    ].join('\n'));

    const ideas = readFiledIdeas(ideasPath);
    expect(ideas[0]!.id).toBe('resolver-mis-routes-weekly-when-user-asks-for-daily');
  });

  it('ignores bullets above the Loop-filed section (user-authored ideas are not loop-tracked)', () => {
    writeFileSync(ideasPath, [
      '# Project Ideas',
      '',
      '## User-authored',
      '',
      '- **Title-shaped** — would parse if it weren\'t above the marker',
      '',
      '## Loop-filed',
      '',
      '- **Actual loop entry** — loop-filed friction',
    ].join('\n'));

    const ideas = readFiledIdeas(ideasPath);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.title).toBe('Actual loop entry');
  });

  it('skips malformed bullets under Loop-filed (no bold title) without crashing', () => {
    writeFileSync(ideasPath, [
      '## Loop-filed',
      '',
      '- just a plain bullet, no structured shape',
      '- **Valid one** — valid friction',
      '- **No-friction-marker bullet without em-dash',
    ].join('\n'));

    const ideas = readFiledIdeas(ideasPath);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.title).toBe('Valid one');
  });
});

describe('appendFiledIdeas', () => {
  it('appends the markdown below the Loop-filed section marker', () => {
    writeFileSync(ideasPath, [
      '# Project Ideas',
      '',
      '## User-authored',
      '',
      '- user idea',
      '',
      '## Loop-filed',
      '',
      '<!-- observation-loop appends here -->',
      '',
    ].join('\n'));

    appendFiledIdeas(ideasPath, '- **New idea** — recurring friction X\n');

    const content = readFileSync(ideasPath, 'utf8');
    expect(content).toContain('## User-authored');
    expect(content).toContain('- user idea');
    expect(content).toContain('## Loop-filed');
    expect(content).toContain('- **New idea** — recurring friction X');
    // User section is untouched (and still above loop-filed).
    expect(content.indexOf('- user idea')).toBeLessThan(content.indexOf('- **New idea**'));
  });

  it('is idempotent on empty markdown — no-op append', () => {
    const original = [
      '# Project Ideas',
      '',
      '## Loop-filed',
      '',
    ].join('\n');
    writeFileSync(ideasPath, original);
    appendFiledIdeas(ideasPath, '');
    expect(readFileSync(ideasPath, 'utf8')).toBe(original);
  });

  it('appends after existing loop-filed bullets (preserves prior entries)', () => {
    writeFileSync(ideasPath, [
      '## Loop-filed',
      '',
      '- **First entry** — friction A',
      '',
    ].join('\n'));

    appendFiledIdeas(ideasPath, '- **Second entry** — friction B\n');

    const content = readFileSync(ideasPath, 'utf8');
    expect(content).toContain('- **First entry**');
    expect(content).toContain('- **Second entry**');
    expect(content.indexOf('First entry')).toBeLessThan(content.indexOf('Second entry'));
  });

  it('throws when the file does not have a Loop-filed section', () => {
    writeFileSync(ideasPath, '# Project Ideas\n\n## User-authored\n\n- only this\n');
    expect(() => appendFiledIdeas(ideasPath, '- **X** — y\n')).toThrow(/loop-filed/i);
  });

  it('does not append a bullet whose derived friction id already exists', () => {
    writeFileSync(ideasPath, [
      '## Loop-filed',
      '',
      '- **First title** — Resolver mis-routes /weekly when user asks for /daily',
      '',
    ].join('\n'));

    appendFiledIdeas(ideasPath, '- **Different title** — resolver mis routes weekly when user asks for daily!\n');

    const content = readFileSync(ideasPath, 'utf8');
    expect(content).toContain('- **First title**');
    expect(content).not.toContain('- **Different title**');
  });

  it('does not append a bullet whose normalized title already exists in Loop-filed', () => {
    writeFileSync(ideasPath, [
      '## Loop-filed',
      '',
      '- **Fix Resolver Routing** — first friction',
      '',
    ].join('\n'));

    appendFiledIdeas(ideasPath, '- **fix resolver routing** — slightly different friction\n');

    const content = readFileSync(ideasPath, 'utf8');
    expect(content.match(/fix resolver routing/gi)).toHaveLength(1);
    expect(content).not.toContain('slightly different friction');
  });

  it('deduplicates duplicate bullets within the same append batch', () => {
    writeFileSync(ideasPath, ['## Loop-filed', ''].join('\n'));

    appendFiledIdeas(ideasPath, [
      '- **First title** — repeated friction',
      '- **Second title** — repeated friction',
      '- **Unique title** — different friction',
      '',
    ].join('\n'));

    const content = readFileSync(ideasPath, 'utf8');
    expect(content).toContain('- **First title** — repeated friction');
    expect(content).not.toContain('- **Second title** — repeated friction');
    expect(content).toContain('- **Unique title** — different friction');
  });

  it('does not use user-authored bullets above Loop-filed for append-time dedupe', () => {
    writeFileSync(ideasPath, [
      '# Project Ideas',
      '',
      '## User-authored',
      '',
      '- **Fix Resolver Routing** — first friction',
      '',
      '## Loop-filed',
      '',
    ].join('\n'));

    appendFiledIdeas(ideasPath, '- **Fix Resolver Routing** — first friction\n');

    const content = readFileSync(ideasPath, 'utf8');
    expect(content.match(/\*\*Fix Resolver Routing\*\*/g)).toHaveLength(2);
  });
});
