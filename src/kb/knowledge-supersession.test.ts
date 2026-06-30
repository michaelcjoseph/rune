import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function writeVaultFile(relativePath: string, content: string): void {
  const fullPath = join(vaultRoot, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function readVaultFile(relativePath: string): string {
  return readFileSync(join(vaultRoot, relativePath), 'utf8');
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

describe('kb/knowledge-supersession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rmSync(vaultRoot, { recursive: true, force: true });
    mkdirSync(vaultRoot, { recursive: true });
  });

  afterAll(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
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
});
