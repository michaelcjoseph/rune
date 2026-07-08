import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/*
 * I/O composition tests for the nightly note-triage step (project 23): real tmpdir product
 * repos + vault, real readProductsConfig over a fixture products.json, mocked agent, injected
 * fake git runner. The pure routing/append logic is covered by src/intent/note-triage.test.ts.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'note-triage-io-')));
const vaultDir = join(root, 'vault');
const auraRepo = join(root, 'ws', 'aura');
const runeRepo = join(root, 'ws', 'rune');
const mcjRepo = join(root, 'ws', 'michaelcjoseph.com');
const logsDir = join(root, 'logs');
const productsFile = join(root, 'products.json');
const mutationsFile = join(logsDir, 'backlog-mutations.jsonl');

// Mutable so individual tests can point at a missing products file.
const cfg = {
  VAULT_DIR: vaultDir,
  LOGS_DIR: logsDir,
  WORKSPACE_DIR: join(root, 'ws'),
  PRODUCTS_CONFIG_FILE: productsFile,
  BACKLOG_MUTATIONS_FILE: mutationsFile,
};

vi.mock('../config.js', () => ({ default: cfg, PROJECT_ROOT: join(root, 'rune-project') }));
vi.mock('../ai/claude.js', () => ({ runAgent: vi.fn() }));
vi.mock('../vault/files.js', () => ({
  readVaultFile: (rel: string) => {
    try { return readFileSync(join(vaultDir, rel), 'utf8'); } catch { return null; }
  },
  writeVaultFile: (rel: string, content: string) => {
    mkdirSync(dirname(join(vaultDir, rel)), { recursive: true });
    writeFileSync(join(vaultDir, rel), content);
  },
}));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

const { runAgent } = await import('../ai/claude.js');
const { runNoteTriage } = await import('./note-triage.js');

const agentMock = runAgent as unknown as ReturnType<typeof vi.fn>;
const fakeGit = vi.fn(async (args: string[]) => ({
  stdout: args[0] === 'rev-parse' ? 'main\n' : '',
  stderr: '',
}));

const DATE = '2026-07-08';
const JOURNAL = 'Worked on [[aura]] today. Thought about a pet translator app. #idea\nAlso [[watt-data]] stuff.';

const CAPS = { projects: true, bugs: true, ideas: true, runs: true, chat: true, monitoring: 'stubbed' };

function writeProductsFixture(overrides: Record<string, unknown> = {}) {
  writeFileSync(productsFile, JSON.stringify({
    aura: { class: 'external', repoPath: auraRepo, containerCapabilities: CAPS },
    rune: { class: 'internal', repoPath: runeRepo, containerCapabilities: CAPS },
    writing: {
      class: 'external', repoPath: mcjRepo, scopePath: 'docs/rune',
      containerCapabilities: { ...CAPS, projects: false, bugs: false },
    },
    ...overrides,
  }, null, 2));
}

const AGENT_ITEMS = [
  { type: 'idea', product: 'aura', title: 'Dark mode', detail: 'Add a dark theme toggle.' },
  { type: 'bug', product: 'rune', title: 'Nightly crash', detail: 'The 3am run crashes.' },
  { type: 'idea', product: null, title: 'Pet translator', detail: 'An app that translates barks.' },
  { type: 'writing-topic', product: null, title: 'On taste', detail: 'How taste develops over time' },
  { type: 'research-topic', product: null, title: 'Quantum error correction', detail: 'Track the recent results' },
];

const VAULT_IDEAS = `# Project Ideas

## Ideas

### Existing Idea
Old detail.
*Source: [[2026_01_01]]*

## Supersession audit

- audit line.
`;

beforeEach(() => {
  vi.clearAllMocks();
  cfg.PRODUCTS_CONFIG_FILE = productsFile;
  rmSync(join(root, 'ws'), { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
  rmSync(logsDir, { recursive: true, force: true });
  for (const repo of [auraRepo, runeRepo]) mkdirSync(join(repo, 'docs', 'projects'), { recursive: true });
  mkdirSync(mcjRepo, { recursive: true }); // docs/rune deliberately absent — seeded on first write
  mkdirSync(join(vaultDir, 'projects'), { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(vaultDir, 'projects', 'ideas.md'), VAULT_IDEAS);
  writeFileSync(join(vaultDir, 'projects', 'aura.md'), '# aura\n');
  writeFileSync(join(vaultDir, 'projects', 'watt-data.md'), '# watt-data\n');
  writeProductsFixture();
  agentMock.mockResolvedValue({ text: JSON.stringify(AGENT_ITEMS) });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runNoteTriage — happy path', () => {
  it('files every item kind to its target and audit-logs the repo writes', async () => {
    const result = await runNoteTriage(DATE, JOURNAL, { runGit: fakeGit });

    expect(result.status).toBe('success');
    expect(result.detail).toContain('ideas=1 (aura)');
    expect(result.detail).toContain('bugs=1 (rune)');
    expect(result.detail).toContain('new-product=1');
    expect(result.detail).toContain('writing=1');
    expect(result.detail).toContain('research=1');

    expect(readFileSync(join(auraRepo, 'docs/projects/ideas.md'), 'utf8'))
      .toContain('- Dark mode — Add a dark theme toggle. (journal 2026-07-08)');
    expect(readFileSync(join(runeRepo, 'docs/projects/bugs.md'), 'utf8'))
      .toContain('- [ ] Nightly crash — The 3am run crashes. (journal 2026-07-08)');

    const writingIdeas = readFileSync(join(mcjRepo, 'docs/rune/writing-ideas.md'), 'utf8');
    expect(writingIdeas).toContain('# Writing ideas');
    expect(writingIdeas).toContain('- **On taste** — How taste develops over time. Source: [[2026_07_08]]');
    const research = readFileSync(join(mcjRepo, 'docs/rune/research-topics.md'), 'utf8');
    expect(research).toContain('# Research topics');
    expect(research).toContain('- **Quantum error correction** — Track the recent results. Source: [[2026_07_08]]');

    const vaultIdeas = readFileSync(join(vaultDir, 'projects', 'ideas.md'), 'utf8');
    expect(vaultIdeas).toContain('### Pet translator');
    expect(vaultIdeas.indexOf('### Pet translator')).toBeLessThan(vaultIdeas.indexOf('## Supersession audit'));

    // Four audited repo writes (vault writes are not backlog-audit-logged).
    const auditRows = readFileSync(mutationsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(auditRows).toHaveLength(4);
    expect(auditRows.map((r) => r.file).sort()).toEqual([
      'docs/projects/bugs.md',
      'docs/projects/ideas.md',
      'docs/rune/research-topics.md',
      'docs/rune/writing-ideas.md',
    ]);
    for (const row of auditRows) expect(row.branch).toBe('main');

    // No git mutations — only rev-parse/status reads (machine filings never commit).
    for (const call of fakeGit.mock.calls) {
      expect(['rev-parse', 'status']).toContain((call[0] as string[])[0]);
    }
  });

  it('injects product table, project-page hints, and delimited journal into the agent prompt', async () => {
    await runNoteTriage(DATE, JOURNAL, { runGit: fakeGit });
    const prompt = agentMock.mock.calls[0]![1] as string;
    expect(agentMock.mock.calls[0]![0]).toBe('note-triage');
    expect(prompt).toContain('- aura (external; bugs: yes)');
    expect(prompt).toContain('- writing (external; bugs: no)');
    expect(prompt).toContain('[[aura]] → registered product `aura`');
    expect(prompt).toContain('[[watt-data]] — vault project with NO registered product');
    expect(prompt).toContain('<<<JOURNAL');
    expect(prompt).toContain('JOURNAL>>>');
  });
});

describe('runNoteTriage — dedupe and idempotency', () => {
  it('second identical run appends nothing anywhere', async () => {
    await runNoteTriage(DATE, JOURNAL, { runGit: fakeGit });
    const snapshot = {
      aura: readFileSync(join(auraRepo, 'docs/projects/ideas.md'), 'utf8'),
      rune: readFileSync(join(runeRepo, 'docs/projects/bugs.md'), 'utf8'),
      writing: readFileSync(join(mcjRepo, 'docs/rune/writing-ideas.md'), 'utf8'),
      research: readFileSync(join(mcjRepo, 'docs/rune/research-topics.md'), 'utf8'),
      vault: readFileSync(join(vaultDir, 'projects', 'ideas.md'), 'utf8'),
    };

    const second = await runNoteTriage(DATE, JOURNAL, { runGit: fakeGit });
    expect(second.status).toBe('skipped');
    expect(second.detail).toContain('duplicates=5');
    expect(readFileSync(join(auraRepo, 'docs/projects/ideas.md'), 'utf8')).toBe(snapshot.aura);
    expect(readFileSync(join(runeRepo, 'docs/projects/bugs.md'), 'utf8')).toBe(snapshot.rune);
    expect(readFileSync(join(mcjRepo, 'docs/rune/writing-ideas.md'), 'utf8')).toBe(snapshot.writing);
    expect(readFileSync(join(mcjRepo, 'docs/rune/research-topics.md'), 'utf8')).toBe(snapshot.research);
    expect(readFileSync(join(vaultDir, 'projects', 'ideas.md'), 'utf8')).toBe(snapshot.vault);
    // No new audit rows on the all-duplicate pass.
    expect(readFileSync(mutationsFile, 'utf8').trim().split('\n')).toHaveLength(4);
  });
});

describe('runNoteTriage — fail-closed paths', () => {
  it('skips before any config/LLM work when the journal is empty', async () => {
    for (const journal of [null, '', '   \n']) {
      const result = await runNoteTriage(DATE, journal, { runGit: fakeGit });
      expect(result.status).toBe('skipped');
    }
    expect(agentMock).not.toHaveBeenCalled();
  });

  it('errors without calling the agent when products config is unreadable', async () => {
    cfg.PRODUCTS_CONFIG_FILE = join(root, 'missing-products.json');
    const result = await runNoteTriage(DATE, JOURNAL, { runGit: fakeGit });
    expect(result.status).toBe('error');
    expect(result.detail).toContain('products config unreadable');
    expect(agentMock).not.toHaveBeenCalled();
  });

  it('retries once on agent error, then errors with zero writes', async () => {
    agentMock.mockResolvedValue({ text: '', error: 'boom' });
    const result = await runNoteTriage(DATE, JOURNAL, { runGit: fakeGit });
    expect(result.status).toBe('error');
    expect(agentMock).toHaveBeenCalledTimes(2);
    expect(existsSync(join(mcjRepo, 'docs/rune'))).toBe(false);
    expect(readFileSync(join(vaultDir, 'projects', 'ideas.md'), 'utf8')).toBe(VAULT_IDEAS);
  });

  it('recovers when the retry returns valid JSON after an invalid first response', async () => {
    agentMock
      .mockResolvedValueOnce({ text: 'sorry, no JSON here' })
      .mockResolvedValueOnce({ text: JSON.stringify(AGENT_ITEMS) });
    const result = await runNoteTriage(DATE, JOURNAL, { runGit: fakeGit });
    expect(result.status).toBe('success');
    expect(agentMock).toHaveBeenCalledTimes(2);
  });

  it('skips when the agent returns an empty array', async () => {
    agentMock.mockResolvedValue({ text: '[]' });
    const result = await runNoteTriage(DATE, JOURNAL, { runGit: fakeGit });
    expect(result).toEqual({ status: 'skipped', detail: 'No filable notes' });
  });

  it('files an unroutable bug into the vault with the unrouted marker', async () => {
    agentMock.mockResolvedValue({
      text: JSON.stringify([{ type: 'bug', product: null, title: 'Mystery crash', detail: 'Something broke.' }]),
    });
    const result = await runNoteTriage(DATE, JOURNAL, { runGit: fakeGit });
    expect(result.status).toBe('success');
    expect(readFileSync(join(vaultDir, 'projects', 'ideas.md'), 'utf8'))
      .toContain('### [Bug — unrouted] Mystery crash');
  });

  it('isolates a failing target: missing repo fails, other targets still land', async () => {
    writeProductsFixture({
      aura: { class: 'external', repoPath: join(root, 'ws', 'gone'), containerCapabilities: CAPS },
    });
    const result = await runNoteTriage(DATE, JOURNAL, { runGit: fakeGit });
    expect(result.status).toBe('error');
    expect(result.detail).toContain('failed=1');
    expect(result.detail).toContain('aura ideas:');
    // The failure detail is path-scrubbed — no absolute host paths leak to the step summary.
    expect(result.detail).not.toContain(root);
    // Everything else still landed.
    expect(readFileSync(join(runeRepo, 'docs/projects/bugs.md'), 'utf8')).toContain('- [ ] Nightly crash');
    expect(existsSync(join(mcjRepo, 'docs/rune/writing-ideas.md'))).toBe(true);
    expect(readFileSync(join(vaultDir, 'projects', 'ideas.md'), 'utf8')).toContain('### Pet translator');
  });

  it('skips topics (with a skip note) when no writing product is registered', async () => {
    writeFileSync(productsFile, JSON.stringify({
      aura: { class: 'external', repoPath: auraRepo, containerCapabilities: CAPS },
    }));
    agentMock.mockResolvedValue({
      text: JSON.stringify([{ type: 'writing-topic', product: null, title: 'On taste', detail: 'x' }]),
    });
    const result = await runNoteTriage(DATE, JOURNAL, { runGit: fakeGit });
    expect(result.status).toBe('skipped');
    expect(result.detail).toContain('skipped=1 (no-writing-product)');
  });
});
