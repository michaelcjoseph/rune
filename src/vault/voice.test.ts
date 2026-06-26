import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// Isolated temp vault — created before mocking so readVaultFile resolves into it.
const tmpDir = join(tmpdir(), `rune-voice-test-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: tmpDir, TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
}));

const { buildVoicePromptSection, VOICE_FILENAME } = await import('./voice.js');

const voicePath = join(tmpDir, VOICE_FILENAME);

function writeVoice(content: string) {
  mkdirSync(dirname(voicePath), { recursive: true });
  writeFileSync(voicePath, content);
}

function clearVoice() {
  if (existsSync(voicePath)) unlinkSync(voicePath);
}

describe('buildVoicePromptSection', () => {
  beforeEach(() => clearVoice());

  it('returns empty string when writing/voice.md is missing', () => {
    expect(buildVoicePromptSection()).toBe('');
  });

  it('returns empty string when writing/voice.md is whitespace-only', () => {
    writeVoice('   \n\n   ');
    expect(buildVoicePromptSection()).toBe('');
  });

  it('wraps the file content in a Writing Voice section', () => {
    writeVoice('Use plain English. Avoid jargon.');
    const block = buildVoicePromptSection();
    expect(block).toContain('## Writing Voice');
    expect(block).toContain('Use plain English. Avoid jargon.');
    expect(block.endsWith('---\n\n')).toBe(true);
  });

  it('re-reads on every call so edits take effect without a restart', () => {
    writeVoice('First version.');
    const first = buildVoicePromptSection();
    expect(first).toContain('First version.');

    writeVoice('Second version with new rules.');
    const second = buildVoicePromptSection();
    expect(second).toContain('Second version with new rules.');
    expect(second).not.toContain('First version.');
  });

  it('starts with the Writing Voice header and instruction paragraph', () => {
    writeVoice('Plain English.');
    const block = buildVoicePromptSection();
    expect(block.startsWith('## Writing Voice\n')).toBe(true);
    expect(block).toContain("match the voice described below");
  });

  it('truncates with a trailing marker when content exceeds the budget', () => {
    writeVoice('x'.repeat(200));
    const block = buildVoicePromptSection(50);
    expect(block).toContain('…(truncated — voice.md exceeds 50-char prompt budget)');
    // Body should not contain the full 200-char run since 50 < 200.
    expect(block).not.toContain('x'.repeat(60));
  });
});
