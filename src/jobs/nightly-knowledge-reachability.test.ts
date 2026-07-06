import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const testState = vi.hoisted(() => ({
  vaultDir: `/tmp/rune-nightly-knowledge-reachability-${process.pid}`,
  projectRoot: `/tmp/rune-nightly-knowledge-reachability-project-${process.pid}`,
}));

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: testState.vaultDir,
    TIMEZONE: 'America/Chicago',
    TELEGRAM_USER_ID: 12345,
    IMPLICIT_CRM_NAMES: [],
    ESCALATION_POLICY_FILE: join(testState.projectRoot, 'policies/escalation.json'),
    LOGS_DIR: join(testState.projectRoot, 'logs'),
    FEEDBACK_FILE: join(testState.projectRoot, 'logs/feedback.jsonl'),
    FEEDBACK_PROCESSED_FILE: join(testState.projectRoot, 'logs/feedback-processed.json'),
  },
  PROJECT_ROOT: testState.projectRoot,
}));

vi.mock('./capture.js', () => ({ captureSessions: vi.fn(async () => ({ captured: 0 })) }));
vi.mock('./whoop-sync.js', () => ({
  executeActivitySync: vi.fn(() => ({ status: 'skipped', detail: 'Whoop not configured' })),
}));
vi.mock('./lenny-sync.js', () => ({
  runLibrarySync: vi.fn(async () => ({ status: 'skipped', detail: 'No library sync fixture' })),
}));
vi.mock('./playbook-extract.js', () => ({
  extractPlaybookDrafts: vi.fn(() => ({ status: 'skipped', detail: 'No #playbook tag' })),
}));
vi.mock('../intent/journal-intent-producer.js', () => ({
  runJournalIntentProducer: vi.fn(() => ({ toEnqueue: [] })),
}));
vi.mock('../intent/intent-proposal-queue.js', () => ({
  readIntentProposalQueue: vi.fn(() => []),
  appendIntentProposals: vi.fn(),
}));
vi.mock('../intent/registry.js', () => ({
  readRegistry: vi.fn(() => ({ products: [] })),
}));
vi.mock('./registry-rebuild.js', () => ({
  rebuildRegistry: vi.fn(() => ({ products: 0, projects: 0 })),
}));
vi.mock('./meeting-extract.js', () => ({
  extractMeetings: vi.fn(async () => []),
  appendProjectDecisions: vi.fn(() => ({ status: 'skipped', appended: 0, detail: 'no decisions' })),
}));
vi.mock('../kb/engine.js', () => ({
  processIngestionQueue: vi.fn(async () => ({ processed: 1, errors: 0, created: 0, updated: 1 })),
  lintKB: vi.fn(async () => ({ success: true, report: 'ok' })),
  enqueue: vi.fn(),
}));
vi.mock('../kb/supersession-adjudicator.js', () => ({
  conservativeSupersessionAdjudicator: vi.fn(async (candidate: { file: string; text: string }) => {
    if (candidate.file === 'knowledge/rename-history.md') {
      return {
        status: 'rejected',
        rationale: 'historical rename reference remains true',
      };
    }
    return {
      status: 'accepted',
      replacement: candidate.text.replace(/\bJarvis\b/g, 'Rune'),
      rationale: 'fixture contradiction supersedes current-state identity',
    };
  }),
}));
vi.mock('../ai/claude.js', () => ({
  askClaudeOneShot: vi.fn(async () => ({ text: 'No updates needed.', error: null })),
  runAgent: vi.fn(async () => ({ text: 'ok', error: null })),
  registerActiveProcess: vi.fn(),
  unregisterActiveProcess: vi.fn(),
}));
vi.mock('../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));
vi.mock('../utils/time.js', () => ({
  getTodayDate: vi.fn(() => '2026-06-30'),
  getTodayFilename: vi.fn(() => '2026_06_30.md'),
  getDayOfWeek: vi.fn(() => 'Tuesday'),
}));
vi.mock('../intent/observation-nightly.js', () => ({
  runNightlyObservation: vi.fn(async () => ({ outcomes: [], dispatchPlans: [], ideasMarkdown: '' })),
}));
vi.mock('../intent/observation-sensor-readers.js', () => ({
  readVaultSignals: vi.fn(() => []),
  readTelemetrySignals: vi.fn(() => []),
  readInteractionSignals: vi.fn(() => []),
}));
vi.mock('../intent/observation-callbacks.js', () => ({
  diarize: vi.fn(async (signals: unknown[]) => signals),
  triage: vi.fn(async () => ({ file: false, reason: 'fixture' })),
}));
vi.mock('../intent/observation-ideas-io.js', () => ({
  readFiledIdeas: vi.fn(() => []),
  appendFiledIdeas: vi.fn(),
}));
vi.mock('../intent/escalation.js', () => ({
  decideFailClosed: vi.fn(() => ({ verdict: 'proceed', reason: '', failClosed: false })),
}));
vi.mock('../transport/mutations.js', () => ({
  createMutation: vi.fn(async () => ({ ok: true, descriptor: { id: 'fixture-mutation' } })),
}));
vi.mock('../intent/feedback-reader.js', () => ({
  readFeedbackRecords: vi.fn(() => []),
  feedbackRecordId: vi.fn((record: unknown) => JSON.stringify(record)),
  readProcessedFeedbackIds: vi.fn(() => new Set<string>()),
  writeProcessedFeedbackIds: vi.fn(),
}));
vi.mock('../intent/postmortem.js', () => ({
  runPostMortem: vi.fn(async () => ({ kind: 'no-lesson', rationale: 'fixture' })),
}));
vi.mock('../intent/learning-write-path.js', () => ({
  writeNightlyLearningLesson: vi.fn(async () => ({ committed: false })),
}));
vi.mock('../roles/memory-writer.js', () => ({
  writeRoleLesson: vi.fn(async () => ({ committed: false })),
}));

const { executeNightly, formatSummary } = await import('./nightly.js');

function writeVaultFile(relativePath: string, content: string): void {
  const fullPath = join(testState.vaultDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function readVaultFile(relativePath: string): string {
  return readFileSync(join(testState.vaultDir, relativePath), 'utf8');
}

function resetFixture(): void {
  rmSync(testState.vaultDir, { recursive: true, force: true });
  rmSync(testState.projectRoot, { recursive: true, force: true });
  mkdirSync(testState.vaultDir, { recursive: true });
  mkdirSync(join(testState.projectRoot, 'policies'), { recursive: true });
  mkdirSync(join(testState.projectRoot, 'logs'), { recursive: true });
  writeFileSync(join(testState.projectRoot, 'policies/escalation.json'), '{}');

  writeVaultFile('journals/2026_06_29.md', [
    '# 2026-06-29',
    '',
    'The current assistant identity is Rune, not Jarvis.',
    '',
  ].join('\n'));
  writeVaultFile('journals/2026_06_30.md', [
    '# 2026-06-30',
    '',
    '- Nightly fixture run.',
    '',
  ].join('\n'));
  writeVaultFile('knowledge/runtime-identity.md', [
    '---',
    'last-verified: 2026-05-15',
    '---',
    '# Runtime identity',
    '',
    'Jarvis owns the product-team orchestration loop.',
    '',
  ].join('\n'));
  writeVaultFile('knowledge/rename-history.md', [
    '# Rename history',
    '',
    'Rune was formerly known as Jarvis during the first implementation cycle.',
    '',
  ].join('\n'));
}

describe('nightly knowledge reconciliation user reachability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFixture();
  });

  afterAll(() => {
    rmSync(testState.vaultDir, { recursive: true, force: true });
    rmSync(testState.projectRoot, { recursive: true, force: true });
  });

  it('surfaces the edited page, inline changelog, and supersession audit path in the nightly summary', async () => {
    const result = await executeNightly('2026-06-30');
    const summary = formatSummary(result);
    const step = result.steps.find((s) => s.step === 'Knowledge reconciliation');

    expect(step).toMatchObject({
      status: 'success',
      detail: expect.stringContaining('knowledge/runtime-identity.md'),
    });
    expect(summary).toContain('[+] Knowledge reconciliation');
    expect(summary).toContain('knowledge/runtime-identity.md');
    expect(summary).toMatch(/inline changelog|supersession audit/i);
    expect(summary).toContain('knowledge/supersessions.jsonl');

    const editedPage = readVaultFile('knowledge/runtime-identity.md');
    expect(editedPage).toContain('Rune owns the product-team orchestration loop.');
    expect(editedPage).not.toContain('Jarvis owns the product-team orchestration loop.');
    expect(editedPage).toMatch(/## Supersession audit/);
    expect(editedPage).toMatch(/Jarvis\s*->\s*Rune/);

    expect(readVaultFile('knowledge/rename-history.md')).toContain(
      'Rune was formerly known as Jarvis during the first implementation cycle.',
    );

    const auditPath = join(testState.vaultDir, 'knowledge/supersessions.jsonl');
    expect(existsSync(auditPath)).toBe(true);
    const records = readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'accepted',
        file: 'knowledge/runtime-identity.md',
        before: 'Jarvis owns the product-team orchestration loop.',
        after: 'Rune owns the product-team orchestration loop.',
      }),
      expect.objectContaining({
        status: 'rejected',
        file: 'knowledge/rename-history.md',
      }),
    ]));
  });

  it('surfaces deterministic KB index repair when wiki pages are missing from knowledge/index.md', async () => {
    writeVaultFile('knowledge/index.md', ['# Knowledge Index', '', '## Entities', ''].join('\n'));
    writeVaultFile('knowledge/wiki/entities/alice.md', [
      '# Alice',
      '',
      'Alice is a fixture entity for index repair.',
      '',
    ].join('\n'));

    const result = await executeNightly('2026-06-30');
    const step = result.steps.find((s) => s.step === 'KB index repair');

    expect(step).toMatchObject({
      status: 'success',
      detail: expect.stringContaining('added=1'),
    });
    expect(readVaultFile('knowledge/index.md')).toContain('- [[alice]] — Alice');
    expect(formatSummary(result)).toContain('[+] KB index repair');
  });
});
