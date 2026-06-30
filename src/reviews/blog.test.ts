import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string | null {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

describe('legacy blog review retirement', () => {
  it('does not keep blog in the review-session type registry', () => {
    const source = readSource('./session.ts');

    expect(source).not.toBeNull();
    expect(source).not.toMatch(/ReviewType\s*=[^;]*['"]blog['"]/s);
  });

  it('removes or redirects the old blog review handler instead of registering a review flow', () => {
    const source = readSource('./blog.ts');

    if (source === null) return;

    expect(source).not.toMatch(/registerReviewHandler\s*\(\s*['"]blog['"]/);
    expect(source).not.toContain("'.claude/skills/blog/SKILL.md'");
    expect(source).not.toContain("'writing/topics.md'");
    expect(source).not.toMatch(/\bcomposeWriterContext\b|\bcaptureLessons\b|\bdetectCompletionSentinel\b/);
    expect(source).not.toContain("opLabel: 'review:blog'");
  });
});
