import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = process.cwd();

function readProjectFile(path: string): string {
  return readFileSync(join(projectRoot, path), 'utf8');
}

describe('confirm-no-topics-voice-commands', () => {
  const absentCommands = ['topics', 'voice'] as const;

  it('has no /topics or /voice command module', () => {
    const commandFiles = new Set(readdirSync(join(projectRoot, 'src/bot/commands')));

    for (const name of absentCommands) {
      expect(commandFiles.has(`${name}.ts`), `/${name} must not be added as a command`).toBe(false);
      expect(commandFiles.has(`${name}.test.ts`), `/${name} should have no command test module`).toBe(false);
    }
  });

  it('has no hardcoded slash dispatch or resolver destination for /topics or /voice', () => {
    const textHandler = readProjectFile('src/bot/handlers/text.ts');
    const skillRegistry = readProjectFile('src/bot/skill-registry.ts');

    for (const name of absentCommands) {
      expect(textHandler).not.toMatch(new RegExp(`text\\.(?:startsWith|===)\\('/${name}(?:'|\\s)`));
      expect(textHandler).not.toMatch(new RegExp(`case ['"]${name}['"]`));
      expect(skillRegistry).not.toMatch(new RegExp(`name:\\s*['"]${name}['"]`));
    }
  });

  it('does not list topics or voice as review-session types', () => {
    const reviewSession = readProjectFile('src/reviews/session.ts');

    for (const name of absentCommands) {
      expect(reviewSession).not.toMatch(new RegExp(`ReviewType\\s*=\\s*[^;]*['"]${name}['"]`, 's'));
      expect(reviewSession).not.toMatch(new RegExp(`SUPPORTED_REVIEW_TYPES[\\s\\S]*['"]${name}['"]`));
    }
  });

  it('keeps pkms topics and voice content covered by the writing migration tasks', () => {
    const tasks = readProjectFile('docs/projects/19-rune-product-os/tasks.md');
    const writingPlan = readProjectFile('src/jobs/writing-product-orchestration.ts');

    expect(tasks).toMatch(/\*\*writing-ideas-migration\*\*[\s\S]*writing\/topics\.md/);
    expect(tasks).toMatch(/\*\*voice-guidelines-copy\*\*[\s\S]*writing\/voice\.md/);

    expect(writingPlan).toContain("sourceVaultPath: 'writing/topics.md'");
    expect(writingPlan).toContain("destinationRepoPath: 'docs/rune/writing-ideas.md'");
    expect(writingPlan).toContain("sourceVaultPath: 'writing/voice.md'");
    expect(writingPlan).toContain("destinationRepoPath: WRITING_VOICE_GUIDELINES_REPO_PATH");
  });
});
