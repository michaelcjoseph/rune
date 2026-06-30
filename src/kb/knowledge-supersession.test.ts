import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const vaultRoot = mkdtempSync(join(tmpdir(), 'rune-knowledge-supersession-'));

interface SupersessionEvidence {
  file: string;
  line: number;
  content: string;
}

interface SupersessionCandidate {
  file: string;
  line: number;
  text: string;
  supersession: {
    from: string;
    to: string;
  };
  newerSources: SupersessionEvidence[];
}

interface SupersessionDecision {
  status: 'accepted' | 'rejected' | 'ambiguous';
  replacement?: string;
  rationale: string;
}

interface SupersessionResult {
  scannedFiles: number;
  candidates: number;
  accepted: number;
  rejected: number;
  ambiguous: number;
  editedFiles: string[];
  unchangedFiles: string[];
  detail: string;
}

interface KnowledgeSupersessionModule {
  runKnowledgeSupersessionReconciliation: (opts: {
    vaultDir: string;
    now: string;
    supersessions: Array<{
      from: string;
      to: string;
      aliases?: string[];
    }>;
    adjudicateCandidate: (candidate: SupersessionCandidate) => Promise<SupersessionDecision>;
  }) => Promise<SupersessionResult>;
}

interface KnowledgeSupersessionCandidateFinderModule {
  findSupersessionCandidates: (opts: {
    vaultDir: string;
    now: string;
    supersessions: Array<{
      from: string;
      to: string;
      aliases?: string[];
    }>;
  }) => SupersessionCandidate[];
}

async function requireKnowledgeSupersessionModule(): Promise<KnowledgeSupersessionModule> {
  const specifier = './knowledge-supersession' + '.js';
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    if (typeof mod.runKnowledgeSupersessionReconciliation === 'function') {
      return mod as unknown as KnowledgeSupersessionModule;
    }
    expect.fail('src/kb/knowledge-supersession.ts must export runKnowledgeSupersessionReconciliation(opts)');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect.fail(`src/kb/knowledge-supersession.ts implementation pending: ${message}`);
  }
}

async function requireKnowledgeSupersessionCandidateFinder(): Promise<KnowledgeSupersessionCandidateFinderModule> {
  const specifier = './knowledge-supersession' + '.js';
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    if (typeof mod.findSupersessionCandidates === 'function') {
      return mod as unknown as KnowledgeSupersessionCandidateFinderModule;
    }
    expect.fail('src/kb/knowledge-supersession.ts must export findSupersessionCandidates(opts)');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect.fail(`src/kb/knowledge-supersession.ts candidate finder implementation pending: ${message}`);
  }
}

function writeVaultFile(relativePath: string, content: string): void {
  const fullPath = join(vaultRoot, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function readVaultFile(relativePath: string): string {
  return readFileSync(join(vaultRoot, relativePath), 'utf8');
}

function readSupersessionAuditRecords(): Array<Record<string, unknown>> {
  const auditPath = join(vaultRoot, 'knowledge/supersessions.jsonl');
  expect(existsSync(auditPath)).toBe(true);
  const raw = readFileSync(auditPath, 'utf8').trim();
  expect(raw.length).toBeGreaterThan(0);
  return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function runJarvisRuneReconciliation(
  adjudicateCandidate: (candidate: SupersessionCandidate) => Promise<SupersessionDecision>,
): Promise<SupersessionResult> {
  const { runKnowledgeSupersessionReconciliation } = await requireKnowledgeSupersessionModule();
  return runKnowledgeSupersessionReconciliation({
    vaultDir: vaultRoot,
    now: '2026-06-30T05:00:00.000Z',
    supersessions: [{ from: 'Jarvis', to: 'Rune', aliases: ['jarvis'] }],
    adjudicateCandidate,
  });
}

async function findJarvisRuneCandidates(): Promise<SupersessionCandidate[]> {
  const { findSupersessionCandidates } = await requireKnowledgeSupersessionCandidateFinder();
  return findSupersessionCandidates({
    vaultDir: vaultRoot,
    now: '2026-06-30T05:00:00.000Z',
    supersessions: [{ from: 'Jarvis', to: 'Rune', aliases: ['jrv'] }],
  });
}

describe('kb/knowledge-supersession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rmSync(vaultRoot, { recursive: true, force: true });
    mkdirSync(vaultRoot, { recursive: true });
  });

  afterAll(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  describe('deterministic candidate finder', () => {
    it('finds token and alias matches in curated pages while leaving raw journals as evidence only', async () => {
      writeVaultFile('knowledge/runtime-identity.md', [
        '---',
        'last-verified: 2026-05-15',
        '---',
        '# Runtime identity',
        '',
        'Jarvis owns the product-team orchestration loop.',
        '',
      ].join('\n'));
      writeVaultFile('pages/psychology.md', [
        '# Psychology',
        '',
        'The operator still refers to jrv in a current setup note.',
        '',
      ].join('\n'));
      writeVaultFile('journals/2026_06_20.md', [
        '# 2026-06-20',
        '',
        'The product identity is Rune now, not Jarvis.',
        'Raw journal note: Jarvis appeared in old scratch text.',
        '',
      ].join('\n'));

      const candidates = await findJarvisRuneCandidates();

      expect(candidates.map((candidate) => `${candidate.file}:${candidate.line}`)).toEqual([
        'knowledge/runtime-identity.md:6',
        'pages/psychology.md:3',
      ]);
      expect(candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'knowledge/runtime-identity.md',
          line: 6,
          text: 'Jarvis owns the product-team orchestration loop.',
          supersession: { from: 'Jarvis', to: 'Rune' },
          newerSources: expect.arrayContaining([
            expect.objectContaining({
              file: 'journals/2026_06_20.md',
              content: expect.stringContaining('Rune now, not Jarvis'),
            }),
          ]),
        }),
        expect.objectContaining({
          file: 'pages/psychology.md',
          line: 3,
          text: 'The operator still refers to jrv in a current setup note.',
          supersession: { from: 'Jarvis', to: 'Rune' },
          newerSources: expect.arrayContaining([
            expect.objectContaining({
              file: 'journals/2026_06_20.md',
              content: expect.stringContaining('Rune now, not Jarvis'),
            }),
          ]),
        }),
      ]));
      expect(candidates.some((candidate) => candidate.file.startsWith('journals/'))).toBe(false);
    });

    it('does not surface free-prose semantic contradictions when the superseded identity token is absent', async () => {
      writeVaultFile('knowledge/current-status.md', [
        '# Current status',
        '',
        'The assistant is still a Telegram-only personal helper.',
        '',
      ].join('\n'));
      writeVaultFile('journals/2026_06_21.md', [
        '# 2026-06-21',
        '',
        'Rune is now a product operating system rather than only a Telegram helper.',
        '',
      ].join('\n'));

      const candidates = await findJarvisRuneCandidates();

      expect(candidates).toEqual([]);
    });

    it('requires token boundaries so partial words and unrelated substrings are not rename candidates', async () => {
      writeVaultFile('knowledge/integration-notes.md', [
        '# Integration notes',
        '',
        'The marjarvis-plugin fixture is unrelated.',
        'A jarvisian naming style in a historical joke is unrelated.',
        '',
      ].join('\n'));
      writeVaultFile('journals/2026_06_22.md', [
        '# 2026-06-22',
        '',
        'Rune replaced Jarvis as the current system identity.',
        '',
      ].join('\n'));

      const candidates = await findJarvisRuneCandidates();

      expect(candidates).toEqual([]);
    });
  });

  it('supersedes a stale curated current-state fact when a newer journal names the new identity', async () => {
    writeVaultFile('knowledge/rune.md', [
      '---',
      'last-verified: 2026-05-15',
      '---',
      '# Rune',
      '',
      'Jarvis is the always-on personal second brain server connected to Telegram and the vault.',
      '',
    ].join('\n'));
    writeVaultFile('journals/2026_06_20.md', [
      '# 2026-06-20',
      '',
      'The product identity is settled: the assistant is now called Rune, not Jarvis.',
      '',
    ].join('\n'));

    const adjudicator = vi.fn(async (candidate: SupersessionCandidate): Promise<SupersessionDecision> => {
      expect(candidate).toMatchObject({
        file: 'knowledge/rune.md',
        text: expect.stringContaining('Jarvis is the always-on personal second brain server'),
        supersession: { from: 'Jarvis', to: 'Rune' },
      });
      expect(candidate.newerSources).toEqual(expect.arrayContaining([
        expect.objectContaining({
          file: 'journals/2026_06_20.md',
          content: expect.stringContaining('now called Rune, not Jarvis'),
        }),
      ]));
      return {
        status: 'accepted',
        replacement: candidate.text.replace(/\bJarvis\b/g, 'Rune'),
        rationale: 'newer journal states the current identity',
      };
    });

    const result = await runJarvisRuneReconciliation(adjudicator);

    expect(adjudicator).toHaveBeenCalledTimes(1);
    expect(readVaultFile('knowledge/rune.md')).toContain(
      'Rune is the always-on personal second brain server connected to Telegram and the vault.',
    );
    expect(readVaultFile('knowledge/rune.md')).not.toContain('Jarvis is the always-on personal second brain server');
    expect(result).toMatchObject({
      candidates: 1,
      accepted: 1,
      rejected: 0,
      ambiguous: 0,
      editedFiles: ['knowledge/rune.md'],
    });
    expect(result.detail).toMatch(/Jarvis|Rune|knowledge\/rune\.md/i);
  });

  it('does not treat older or future journal entries as newer evidence for a curated fact', async () => {
    writeVaultFile('knowledge/current-identity.md', [
      '---',
      'last-verified: 2026-06-22',
      '---',
      '# Current identity',
      '',
      'Jarvis is the current product-team orchestrator.',
      '',
    ].join('\n'));
    writeVaultFile('journals/2026_06_21.md', [
      '# 2026-06-21',
      '',
      'Going forward the orchestrator should be called Rune rather than Jarvis.',
      '',
    ].join('\n'));
    writeVaultFile('journals/2026_07_01.md', [
      '# 2026-07-01',
      '',
      'Future-dated fixture: Rune replaced Jarvis as the current orchestrator.',
      '',
    ].join('\n'));

    const adjudicator = vi.fn(async (): Promise<SupersessionDecision> => ({
      status: 'accepted',
      rationale: 'should not be called for older evidence',
    }));

    const result = await runJarvisRuneReconciliation(adjudicator);

    expect(adjudicator).not.toHaveBeenCalled();
    expect(readVaultFile('knowledge/current-identity.md')).toContain(
      'Jarvis is the current product-team orchestrator.',
    );
    expect(result).toMatchObject({
      candidates: 0,
      accepted: 0,
      editedFiles: [],
    });
  });

  it('uses alias-aware fallback replacement when the adjudicator accepts without a replacement', async () => {
    writeVaultFile('knowledge/runtime-alias.md', [
      '---',
      'last-verified: 2026-05-15',
      '---',
      '# Runtime alias',
      '',
      'jarvis owns the product-team orchestration loop.',
      '',
    ].join('\n'));
    writeVaultFile('journals/2026_06_23.md', [
      '# 2026-06-23',
      '',
      'The runtime identity is Rune now; jarvis is only the old alias.',
      '',
    ].join('\n'));

    const adjudicator = vi.fn(async (): Promise<SupersessionDecision> => ({
      status: 'accepted',
      rationale: 'alias-only current-state drift',
    }));

    const result = await runJarvisRuneReconciliation(adjudicator);

    expect(adjudicator).toHaveBeenCalledTimes(1);
    expect(readVaultFile('knowledge/runtime-alias.md')).toContain(
      'Rune owns the product-team orchestration loop.',
    );
    expect(readVaultFile('knowledge/runtime-alias.md')).not.toContain('jarvis owns');
    expect(result).toMatchObject({
      accepted: 1,
      editedFiles: ['knowledge/runtime-alias.md'],
    });
  });

  it('reconciles the canonical Jarvis to Rune drift while leaving historical near-misses unchanged', async () => {
    const historicalReference = [
      '# Rename history',
      '',
      'Rune was formerly known as Jarvis during the first implementation cycle.',
      '',
    ].join('\n');
    writeVaultFile('knowledge/runtime-identity.md', [
      '# Runtime identity',
      '',
      'Jarvis owns the product-team orchestration loop and writes work-run status to the cockpit.',
      '',
    ].join('\n'));
    writeVaultFile('knowledge/rename-history.md', historicalReference);
    writeVaultFile('journals/2026_06_21.md', [
      '# 2026-06-21',
      '',
      'The Jarvis to Rune rename is current. Going forward the orchestrator should be called Rune.',
      '',
    ].join('\n'));

    const adjudicator = vi.fn(async (candidate: SupersessionCandidate): Promise<SupersessionDecision> => {
      if (candidate.file === 'knowledge/rename-history.md') {
        return {
          status: 'rejected',
          rationale: 'historical reference to the prior identity remains true',
        };
      }
      return {
        status: 'accepted',
        replacement: candidate.text.replace(/\bJarvis\b/g, 'Rune'),
        rationale: 'current-state identity drift',
      };
    });

    const result = await runJarvisRuneReconciliation(adjudicator);

    expect(readVaultFile('knowledge/runtime-identity.md')).toContain(
      'Rune owns the product-team orchestration loop and writes work-run status to the cockpit.',
    );
    expect(readVaultFile('knowledge/runtime-identity.md')).not.toContain('Jarvis owns the product-team orchestration loop');
    expect(readVaultFile('knowledge/rename-history.md')).toBe(historicalReference);
    expect(result.accepted).toBe(1);
    expect(result.editedFiles).toContain('knowledge/runtime-identity.md');
    expect(result.editedFiles).not.toContain('knowledge/rename-history.md');
    expect(result.unchangedFiles).toContain('knowledge/rename-history.md');
  });

  it('does not rewrite a still-valid curated historical fact even when it resembles a supersession candidate', async () => {
    const nearMiss = [
      '# Agent lineage',
      '',
      'The agent was named Jarvis in 2025 before the Rune rename.',
      '',
    ].join('\n');
    writeVaultFile('knowledge/agent-lineage.md', nearMiss);
    writeVaultFile('journals/2026_06_22.md', [
      '# 2026-06-22',
      '',
      'Use Rune as the current product name; Jarvis is only the previous name.',
      '',
    ].join('\n'));

    const adjudicator = vi.fn(async (): Promise<SupersessionDecision> => ({
      status: 'rejected',
      rationale: 'the statement is explicitly historical, not stale current state',
    }));

    const result = await runJarvisRuneReconciliation(adjudicator);

    expect(readVaultFile('knowledge/agent-lineage.md')).toBe(nearMiss);
    expect(result.accepted).toBe(0);
    expect(result.editedFiles).not.toContain('knowledge/agent-lineage.md');
    expect(result.unchangedFiles).toContain('knowledge/agent-lineage.md');
  });

  it('adds an inline changelog entry and JSONL audit record for every accepted auto-edit', async () => {
    writeVaultFile('knowledge/runtime-identity.md', [
      '---',
      'last-verified: 2026-05-15',
      '---',
      '# Runtime identity',
      '',
      'Jarvis owns the product-team orchestration loop.',
      '',
    ].join('\n'));
    writeVaultFile('knowledge/cockpit-agent.md', [
      '# Cockpit agent',
      '',
      'Jarvis reports work-run state in the cockpit.',
      '',
    ].join('\n'));
    writeVaultFile('journals/2026_06_23.md', [
      '# 2026-06-23',
      '',
      'The current assistant identity is Rune, not Jarvis.',
      '',
    ].join('\n'));
    const rawJournalBefore = readVaultFile('journals/2026_06_23.md');

    const adjudicator = vi.fn(async (candidate: SupersessionCandidate): Promise<SupersessionDecision> => ({
      status: 'accepted',
      replacement: candidate.text.replace(/\bJarvis\b/g, 'Rune'),
      rationale: `accepted current-state drift in ${candidate.file}`,
    }));

    const result = await runJarvisRuneReconciliation(adjudicator);

    expect(result.accepted).toBe(2);
    expect(result.editedFiles).toEqual(['knowledge/cockpit-agent.md', 'knowledge/runtime-identity.md']);
    expect(readVaultFile('journals/2026_06_23.md')).toBe(rawJournalBefore);

    for (const file of result.editedFiles) {
      const updated = readVaultFile(file);
      expect(updated).toMatch(/2026-06-30/);
      expect(updated).toMatch(/changelog|supersession|audit/i);
      expect(updated).toMatch(/Jarvis\s*(?:->|to)\s*Rune/i);
    }

    const records = readSupersessionAuditRecords();
    expect(records).toHaveLength(2);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        timestamp: '2026-06-30T05:00:00.000Z',
        status: 'accepted',
        file: 'knowledge/runtime-identity.md',
        line: 6,
        supersession: { from: 'Jarvis', to: 'Rune' },
        before: 'Jarvis owns the product-team orchestration loop.',
        after: 'Rune owns the product-team orchestration loop.',
        rationale: 'accepted current-state drift in knowledge/runtime-identity.md',
        evidence: expect.arrayContaining([
          expect.objectContaining({
            file: 'journals/2026_06_23.md',
            content: expect.stringContaining('Rune, not Jarvis'),
          }),
        ]),
      }),
      expect.objectContaining({
        timestamp: '2026-06-30T05:00:00.000Z',
        status: 'accepted',
        file: 'knowledge/cockpit-agent.md',
        line: 3,
        supersession: { from: 'Jarvis', to: 'Rune' },
        before: 'Jarvis reports work-run state in the cockpit.',
        after: 'Rune reports work-run state in the cockpit.',
        rationale: 'accepted current-state drift in knowledge/cockpit-agent.md',
        evidence: expect.arrayContaining([
          expect.objectContaining({
            file: 'journals/2026_06_23.md',
            content: expect.stringContaining('Rune, not Jarvis'),
          }),
        ]),
      }),
    ]));
  });

  it('uses the existing world-view changelog format when an accepted auto-edit touches a world-view page', async () => {
    writeVaultFile('world-view/ai.md', [
      '# AI beliefs',
      '',
      'Jarvis frames my AI operating model.',
      '',
      '## Changelog',
      '',
      '### [[2026_05_01]]',
      '- Initial thesis.',
      '',
    ].join('\n'));
    writeVaultFile('journals/2026_06_25.md', [
      '# 2026-06-25',
      '',
      'The current assistant identity is Rune, not Jarvis.',
      '',
    ].join('\n'));

    const adjudicator = vi.fn(async (candidate: SupersessionCandidate): Promise<SupersessionDecision> => ({
      status: 'accepted',
      replacement: candidate.text.replace(/\bJarvis\b/g, 'Rune'),
      rationale: 'current-state identity drift in worldview page',
    }));

    const result = await runJarvisRuneReconciliation(adjudicator);
    const updated = readVaultFile('world-view/ai.md');
    const lines = updated.split('\n');
    const changelogIndex = lines.findIndex((line) => line === '## Changelog');
    const supersessionEntryIndex = lines.findIndex((line) => line === '### [[2026_06_30]]');
    const olderEntryIndex = lines.findIndex((line) => line === '### [[2026_05_01]]');

    expect(result).toMatchObject({
      accepted: 1,
      editedFiles: ['world-view/ai.md'],
    });
    expect(updated).toContain('Rune frames my AI operating model.');
    expect(updated).not.toContain('Jarvis frames my AI operating model.');
    expect(changelogIndex).toBeGreaterThanOrEqual(0);
    expect(supersessionEntryIndex).toBeGreaterThan(changelogIndex);
    expect(supersessionEntryIndex).toBeLessThan(olderEntryIndex);
    expect(lines[supersessionEntryIndex + 1]).toMatch(/Jarvis\s*(?:->|to)\s*Rune/i);
    expect(lines[supersessionEntryIndex + 1]).toMatch(/supersession/i);
    expect(updated).not.toContain('## Supersession audit');

    const records = readSupersessionAuditRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(expect.objectContaining({
      timestamp: '2026-06-30T05:00:00.000Z',
      status: 'accepted',
      file: 'world-view/ai.md',
      line: 3,
      supersession: { from: 'Jarvis', to: 'Rune' },
      before: 'Jarvis frames my AI operating model.',
      after: 'Rune frames my AI operating model.',
      rationale: 'current-state identity drift in worldview page',
    }));
  });

  it('logs ambiguous supersession candidates without editing the curated page or raw journal evidence', async () => {
    const ambiguousPage = [
      '# Runtime nickname',
      '',
      'Jarvis remains a visible nickname in some operator-facing copy.',
      '',
    ].join('\n');
    const rawJournal = [
      '# 2026-06-24',
      '',
      'Rune replaced Jarvis as the current system name, but some copy may still mention Jarvis historically.',
      '',
    ].join('\n');
    writeVaultFile('knowledge/runtime-nickname.md', ambiguousPage);
    writeVaultFile('journals/2026_06_24.md', rawJournal);

    const adjudicator = vi.fn(async (): Promise<SupersessionDecision> => ({
      status: 'ambiguous',
      rationale: 'could be current drift or intentionally historical copy',
    }));

    const result = await runJarvisRuneReconciliation(adjudicator);

    expect(result).toMatchObject({
      candidates: 1,
      accepted: 0,
      ambiguous: 1,
      editedFiles: [],
      unchangedFiles: ['knowledge/runtime-nickname.md'],
    });
    expect(readVaultFile('knowledge/runtime-nickname.md')).toBe(ambiguousPage);
    expect(readVaultFile('journals/2026_06_24.md')).toBe(rawJournal);

    const records = readSupersessionAuditRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(expect.objectContaining({
      timestamp: '2026-06-30T05:00:00.000Z',
      status: 'ambiguous',
      file: 'knowledge/runtime-nickname.md',
      line: 3,
      supersession: { from: 'Jarvis', to: 'Rune' },
      text: 'Jarvis remains a visible nickname in some operator-facing copy.',
      rationale: 'could be current drift or intentionally historical copy',
      evidence: expect.arrayContaining([
        expect.objectContaining({
          file: 'journals/2026_06_24.md',
          content: expect.stringContaining('Rune replaced Jarvis'),
        }),
      ]),
    }));
    expect(readVaultFile('knowledge/runtime-nickname.md')).not.toMatch(/2026-06-30|changelog|supersession audit/i);
  });
});
