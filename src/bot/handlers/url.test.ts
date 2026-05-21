import { describe, it, expect, vi } from 'vitest';

// url.ts pulls in config + integrations at module load — stub them so importing
// the pure parser under test doesn't drag in real I/O.
vi.mock('../../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', LOGS_DIR: '/test/logs' },
}));
vi.mock('../../ai/claude.js', () => ({ runAgent: vi.fn() }));
vi.mock('../../vault/files.js', () => ({ writeVaultFile: vi.fn() }));
vi.mock('../../vault/journal.js', () => ({ appendToJournal: vi.fn() }));
vi.mock('../../kb/queue.js', () => ({ enqueue: vi.fn() }));
vi.mock('../../utils/time.js', () => ({ getTimestamp: vi.fn(() => '09:00') }));
vi.mock('../../integrations/readwise/client.js', () => ({ saveToReadwise: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { parseTriageResult } from './url.js';

describe('parseTriageResult', () => {
  it('parses the canonical four-field format', () => {
    const r = parseTriageResult(
      'CLASSIFICATION: kb-ingest\nTITLE: Transformer Architecture\nREASONING: Foundational ML paper.\nGUIDANCE: Focus on attention.',
    );
    expect(r).toEqual({
      classification: 'kb-ingest',
      title: 'Transformer Architecture',
      reasoning: 'Foundational ML paper.',
      guidance: 'Focus on attention.',
    });
  });

  it('omits guidance when absent', () => {
    const r = parseTriageResult(
      'CLASSIFICATION: readwise\nTITLE: A News Article\nREASONING: Interesting but not KB-worthy.',
    );
    expect(r?.classification).toBe('readwise');
    expect(r?.guidance).toBeUndefined();
  });

  it('tolerates markdown bold around labels and values', () => {
    const r = parseTriageResult(
      '**CLASSIFICATION:** **skip**\n**TITLE:** Some Thread\n**REASONING:** Low value.',
    );
    expect(r?.classification).toBe('skip');
    expect(r?.title).toBe('Some Thread');
  });

  it('tolerates list markers and mixed-case labels', () => {
    const r = parseTriageResult(
      '- Classification: journal\n- Title: A Restaurant\n- Reasoning: Personal reference.',
    );
    expect(r?.classification).toBe('journal');
    expect(r?.title).toBe('A Restaurant');
  });

  it('recovers the category when trailing commentary follows it', () => {
    const r = parseTriageResult(
      'CLASSIFICATION: kb-ingest — high value\nTITLE: OpenClaw\nREASONING: Novel framework.',
    );
    expect(r?.classification).toBe('kb-ingest');
  });

  it('returns null when the agent replies in prose with no fields', () => {
    expect(
      parseTriageResult('OpenClaw is a personal AI OS. Both are directly relevant to you...'),
    ).toBeNull();
  });

  it('returns null when classification is not one of the four categories', () => {
    expect(
      parseTriageResult(
        '**Classification:** AI tool discovery\nTITLE: OpenClaw\nREASONING: Relevant.',
      ),
    ).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    expect(parseTriageResult('CLASSIFICATION: skip\nTITLE: No reasoning here')).toBeNull();
  });
});
