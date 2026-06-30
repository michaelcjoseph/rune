import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { askClaudeOneShot } from '../ai/claude.js';
import {
  runKnowledgeSupersessionReconciliation,
  type SupersessionCandidate,
  type SupersessionDecision,
} from './knowledge-supersession.js';

vi.mock('../ai/claude.js', () => ({
  askClaudeOneShot: vi.fn(),
}));

const vaultRoot = mkdtempSync(join(tmpdir(), 'rune-supersession-adjudicator-'));
const askMock = askClaudeOneShot as unknown as ReturnType<typeof vi.fn>;

interface SupersessionAdjudicatorModule {
  conservativeSupersessionAdjudicator: (candidate: SupersessionCandidate) => Promise<SupersessionDecision>;
}

async function requireSupersessionAdjudicator(): Promise<SupersessionAdjudicatorModule> {
  const specifier = './supersession-adjudicator' + '.js';
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
    if (typeof mod.conservativeSupersessionAdjudicator === 'function') {
      return mod as unknown as SupersessionAdjudicatorModule;
    }
    expect.fail('src/kb/supersession-adjudicator.ts must export conservativeSupersessionAdjudicator(candidate)');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect.fail(`src/kb/supersession-adjudicator.ts implementation pending: ${message}`);
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

function jarvisRuneCandidate(overrides: Partial<SupersessionCandidate> = {}): SupersessionCandidate {
  return {
    file: 'knowledge/runtime-identity.md',
    line: 6,
    text: 'Jarvis is the always-on personal second brain server.',
    supersession: { from: 'Jarvis', to: 'Rune' },
    newerSources: [
      {
        file: 'journals/2026_06_20.md',
        line: 3,
        content: 'The current product identity is Rune now, not Jarvis.',
      },
    ],
    ...overrides,
  };
}

async function runJarvisRuneReconciliation() {
  const { conservativeSupersessionAdjudicator } = await requireSupersessionAdjudicator();
  return runKnowledgeSupersessionReconciliation({
    vaultDir: vaultRoot,
    now: '2026-06-30T05:00:00.000Z',
    supersessions: [{ from: 'Jarvis', to: 'Rune', aliases: ['jarvis'] }],
    adjudicateCandidate: conservativeSupersessionAdjudicator,
  });
}

describe('kb/supersession-adjudicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rmSync(vaultRoot, { recursive: true, force: true });
    mkdirSync(vaultRoot, { recursive: true });
  });

  afterAll(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('accepts only a clear current-state supersession already surfaced by the deterministic finder', async () => {
    const { conservativeSupersessionAdjudicator } = await requireSupersessionAdjudicator();
    askMock.mockResolvedValueOnce({
      text: JSON.stringify({
        status: 'accepted',
        replacement: 'Rune is the always-on personal second brain server.',
        rationale: 'The candidate states current identity and newer evidence says Rune is current, not Jarvis.',
      }),
      error: null,
    });

    const decision = await conservativeSupersessionAdjudicator(jarvisRuneCandidate());

    expect(decision).toEqual({
      status: 'accepted',
      replacement: 'Rune is the always-on personal second brain server.',
      rationale: 'The candidate states current identity and newer evidence says Rune is current, not Jarvis.',
    });
    expect(askMock).toHaveBeenCalledTimes(1);
    const prompt = String(askMock.mock.calls[0]![0]);
    expect(prompt).toContain('already surfaced by the deterministic finder');
    expect(prompt).toContain('Do not search');
    expect(prompt).toContain('Jarvis is the always-on personal second brain server.');
    expect(prompt).toContain('The current product identity is Rune now, not Jarvis.');
  });

  it('falls back to ambiguous when the model output is malformed or not a conservative decision', async () => {
    const { conservativeSupersessionAdjudicator } = await requireSupersessionAdjudicator();
    askMock.mockResolvedValueOnce({
      text: JSON.stringify({
        status: 'accepted',
        rationale: 'missing replacement for accepted edit',
      }),
      error: null,
    });

    const decision = await conservativeSupersessionAdjudicator(jarvisRuneCandidate());

    expect(decision.status).toBe('ambiguous');
    expect(decision.rationale).toMatch(/invalid|malformed|conservative/i);
  });

  it('leaves a historical near-miss unchanged through the real reconciliation pipeline', async () => {
    const currentFact = [
      '# Runtime identity',
      '',
      'Jarvis owns the product-team orchestration loop.',
      '',
    ].join('\n');
    const historicalNearMiss = [
      '# Agent lineage',
      '',
      'The agent was named Jarvis in 2025 before the Rune rename.',
      '',
    ].join('\n');
    writeVaultFile('knowledge/runtime-identity.md', currentFact);
    writeVaultFile('knowledge/agent-lineage.md', historicalNearMiss);
    writeVaultFile('knowledge/semantic-drift.md', [
      '# Runtime shape',
      '',
      'The assistant is only a Telegram bot connected to a vault.',
      '',
    ].join('\n'));
    writeVaultFile('journals/2026_06_22.md', [
      '# 2026-06-22',
      '',
      'Use Rune as the current product name; Jarvis is only the previous name.',
      'Rune is now a product operating system, not only a Telegram bot.',
      '',
    ].join('\n'));

    askMock.mockImplementation(async (prompt: string) => {
      if (prompt.includes('The agent was named Jarvis in 2025 before the Rune rename.')) {
        return {
          text: JSON.stringify({
            status: 'ambiguous',
            rationale: 'This names a prior identity as historical context, not a stale current-state fact.',
          }),
          error: null,
        };
      }

      return {
        text: JSON.stringify({
          status: 'accepted',
          replacement: 'Rune owns the product-team orchestration loop.',
          rationale: 'This is a current-state identity claim superseded by newer evidence.',
        }),
        error: null,
      };
    });

    const result = await runJarvisRuneReconciliation();

    expect(askMock).toHaveBeenCalledTimes(2);
    expect(readVaultFile('knowledge/runtime-identity.md')).toContain(
      'Rune owns the product-team orchestration loop.',
    );
    expect(readVaultFile('knowledge/agent-lineage.md')).toBe(historicalNearMiss);
    expect(readVaultFile('knowledge/semantic-drift.md')).toContain(
      'The assistant is only a Telegram bot connected to a vault.',
    );
    expect(result.accepted).toBe(1);
    expect(result.ambiguous).toBe(1);
    expect(result.editedFiles).toContain('knowledge/runtime-identity.md');
    expect(result.editedFiles).not.toContain('knowledge/agent-lineage.md');
    expect(result.editedFiles).not.toContain('knowledge/semantic-drift.md');
    expect(result.unchangedFiles).toContain('knowledge/agent-lineage.md');

    const records = readSupersessionAuditRecords();
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        timestamp: '2026-06-30T05:00:00.000Z',
        status: 'ambiguous',
        file: 'knowledge/agent-lineage.md',
        line: 3,
        supersession: { from: 'Jarvis', to: 'Rune' },
        text: 'The agent was named Jarvis in 2025 before the Rune rename.',
        rationale: 'This names a prior identity as historical context, not a stale current-state fact.',
      }),
    ]));
  });
});
