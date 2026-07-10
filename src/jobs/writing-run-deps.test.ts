/**
 * Production writing-engine deps (src/jobs/writing-run-deps.ts) — the seam
 * that made /blog and /writing-critique no-ops (docs/projects/bugs.md).
 *
 * Unit layer: MCP dispatch routing + input translation, writer-model calls
 * (SOUL/memory/voice wiring, fence unwrap, failure recording), artifact
 * containment, cancel polling, and the deps-level adapter's failed→throw
 * contract — all against mocked handler/model modules.
 *
 * Integration layer: ONE real temp-git test proving the worktree
 * create-or-resume + branch-consistent commit against actual git
 * (precedent: work-run-gc.test.ts, team-task-deps.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../ai/claude.js', () => ({
  askClaudeOneShot: vi.fn(async () => ({ text: 'model output', error: null })),
}));
vi.mock('../writer/memory.js', () => ({
  composeWriterContext: vi.fn((base: string) => ({
    systemInstructions: `WRITER SOUL\n\n${base}`,
    referenceContext: '<writer-memory>\nlesson one\n</writer-memory>',
  })),
}));
vi.mock('../intent/model-policy.js', () => ({
  loadModelPolicy: vi.fn(() => null),
  resolveModel: vi.fn(),
}));
vi.mock('../mcp/tools/read-tools.js', () => ({
  vaultSearch: vi.fn(async () => ({ content: [{ type: 'text', text: 'vault hits' }] })),
}));
vi.mock('../mcp/tools/read-tools-deps.js', () => ({
  buildProductionVaultSearchDeps: vi.fn(() => ({})),
}));
vi.mock('../mcp/tools/journal-range.js', () => ({
  journalRange: vi.fn(async () => ({ content: [{ type: 'text', text: 'journal entries' }] })),
}));
vi.mock('../mcp/tools/journal-range-deps.js', () => ({
  buildProductionJournalRangeDeps: vi.fn(() => ({})),
}));
vi.mock('../mcp/tools/follow-wikilinks.js', () => ({
  followWikilinks: vi.fn(async () => ({ content: [{ type: 'text', text: 'linked pages' }] })),
}));
vi.mock('../mcp/tools/follow-wikilinks-deps.js', () => ({
  buildProductionFollowWikilinksDeps: vi.fn(() => ({})),
}));

import { askClaudeOneShot } from '../ai/claude.js';
import { loadModelPolicy, resolveModel } from '../intent/model-policy.js';
import { vaultSearch } from '../mcp/tools/read-tools.js';
import { journalRange } from '../mcp/tools/journal-range.js';
import { followWikilinks } from '../mcp/tools/follow-wikilinks.js';
import { defaultRunGit } from './sandbox-runtime.js';
import { getTodayDate } from '../utils/time.js';
import {
  buildWritingPipelineDeps,
  buildProductionStartWritingDeps,
  createProductionWritingWorktree,
  journalRangeWindow,
  stripCodeFence,
  resolveWriterModel,
  writingRepoPresent,
  type WritingRunFailure,
} from './writing-run-deps.js';

const askOneShotMock = askClaudeOneShot as unknown as ReturnType<typeof vi.fn>;
const vaultSearchMock = vaultSearch as unknown as ReturnType<typeof vi.fn>;
const journalRangeMock = journalRange as unknown as ReturnType<typeof vi.fn>;
const followWikilinksMock = followWikilinks as unknown as ReturnType<typeof vi.fn>;
const loadModelPolicyMock = loadModelPolicy as unknown as ReturnType<typeof vi.fn>;
const resolveModelMock = resolveModel as unknown as ReturnType<typeof vi.fn>;

function makeHarness(overrides: { worktree?: string; cancelRequested?: () => boolean } = {}) {
  const failures: WritingRunFailure[] = [];
  const events: unknown[] = [];
  const deps = buildWritingPipelineDeps({
    worktree: overrides.worktree ?? '/tmp/writing-worktree-unit',
    emitRunState: (e) => events.push(e),
    recordFailure: (f) => failures.push(f),
    ...(overrides.cancelRequested ? { cancelRequested: overrides.cancelRequested } : {}),
  });
  return { deps, failures, events };
}

beforeEach(() => {
  askOneShotMock.mockClear();
  askOneShotMock.mockImplementation(async () => ({ text: 'model output', error: null }));
  vaultSearchMock.mockClear();
  journalRangeMock.mockClear();
  followWikilinksMock.mockClear();
  loadModelPolicyMock.mockReset();
  loadModelPolicyMock.mockReturnValue(null);
  resolveModelMock.mockReset();
});

describe('writing-run-deps — MCP dispatch', () => {
  it('routes vault_search with query/maxResults passthrough', async () => {
    const { deps } = makeHarness();
    const result = await deps.mcp.callTool('vault_search', { query: 'operating from memory', maxResults: 12 });
    expect(vaultSearchMock).toHaveBeenCalledWith(
      { query: 'operating from memory', maxResults: 12 },
      expect.anything(),
    );
    expect(result).toEqual({ content: [{ type: 'text', text: 'vault hits' }] });
  });

  it('translates journal_range {maxDays} into the handler\'s inclusive {startDate, endDate} window', async () => {
    const { deps } = makeHarness();
    await deps.mcp.callTool('journal_range', { query: 'topic', maxDays: 31 });
    expect(journalRangeMock).toHaveBeenCalledWith(journalRangeWindow(31), expect.anything());
    const window = journalRangeWindow(31);
    expect(window.endDate).toBe(getTodayDate());
    // Inclusive 31-day span: start + 30 days = end.
    const span = (new Date(`${window.endDate}T00:00:00Z`).getTime()
      - new Date(`${window.startDate}T00:00:00Z`).getTime()) / 86_400_000;
    expect(span).toBe(30);
    expect(window.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('journalRangeWindow clamps garbage and out-of-range maxDays to the handler cap', () => {
    expect(journalRangeWindow(1).startDate).toBe(journalRangeWindow(1).endDate);
    expect(journalRangeWindow('nonsense')).toEqual(journalRangeWindow(31));
    expect(journalRangeWindow(999)).toEqual(journalRangeWindow(31));
    expect(journalRangeWindow(0)).toEqual(journalRangeWindow(31));
  });

  it('translates follow_wikilinks {query} into the handler\'s {text, maxDepth}', async () => {
    const { deps } = makeHarness();
    await deps.mcp.callTool('follow_wikilinks', { query: 'topic', maxDepth: 2 });
    expect(followWikilinksMock).toHaveBeenCalledWith({ text: 'topic', maxDepth: 2 }, expect.anything());
  });

  it('throws on an unknown tool and records the research stage', async () => {
    const { deps, failures } = makeHarness();
    await expect(deps.mcp.callTool('kb_query', {})).rejects.toThrow(/unknown MCP tool 'kb_query'/);
    expect(failures[0]).toMatchObject({ stage: 'research' });
  });

  it('throws when a handler returns isError, surfacing the error text', async () => {
    vaultSearchMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'index rebuilding' }],
      isError: true,
    });
    const { deps, failures } = makeHarness();
    await expect(deps.mcp.callTool('vault_search', { query: 'x' })).rejects.toThrow(
      /vault_search failed: index rebuilding/,
    );
    expect(failures[0]).toMatchObject({ stage: 'research', message: expect.stringContaining('index rebuilding') });
  });

  it('checks the cancel poll before dispatch (cooperative stage-boundary cancel)', async () => {
    const { deps, failures } = makeHarness({ cancelRequested: () => true });
    await expect(deps.mcp.callTool('vault_search', { query: 'x' })).rejects.toThrow(/cancelled by user/);
    expect(vaultSearchMock).not.toHaveBeenCalled();
    expect(failures[0]).toMatchObject({ stage: 'research', message: expect.stringContaining('cancelled') });
  });
});

describe('writing-run-deps — writer model calls', () => {
  it('plan carries the writer SOUL on the system channel, memory fence + payload on the user turn, voice on', async () => {
    const { deps } = makeHarness();
    const result = await deps.model.plan({
      topic: 'Operating from memory',
      routePath: '/rune/operating-from-memory',
      research: { vaultSearch: { content: [{ type: 'text', text: 'vault hits' }] } },
    });
    expect(result).toEqual({ outline: 'model output' });
    const [message, timeoutMs, opLabel, voice, opts] = askOneShotMock.mock.calls[0]!;
    expect(message).toContain('<writer-memory>');
    expect(message).toContain('## Topic\nOperating from memory');
    expect(message).toContain('PRIVATE source material');
    expect(message).toContain('vault hits');
    expect(timeoutMs).toBe(1_800_000);
    expect(opLabel).toBeUndefined();
    expect(voice).toBe(true);
    expect(opts.systemPrompt).toContain('WRITER SOUL');
    expect(opts.systemPrompt).toContain('Stage: PLAN');
    expect(opts.model).toBeUndefined(); // no policy → ONESHOT_MODEL fallback
  });

  it('unwraps one accidental full-body code fence from the model output', async () => {
    askOneShotMock.mockResolvedValueOnce({ text: '```markdown\n# Doc\n\nBody.\n```', error: null });
    const { deps } = makeHarness();
    const result = await deps.model.draft({ topic: 't', outline: 'o' });
    expect(result).toEqual({ markdown: '# Doc\n\nBody.' });
  });

  it('throws and records the stage on a model error or empty output', async () => {
    askOneShotMock.mockResolvedValueOnce({ text: null, error: 'Claude timed out after 1800s' });
    const { deps, failures } = makeHarness();
    await expect(deps.model.draft({ topic: 't' })).rejects.toThrow(/draft model call failed/);
    expect(failures[0]).toMatchObject({ stage: 'draft' });

    askOneShotMock.mockResolvedValueOnce({ text: '   ', error: null });
    await expect(deps.model.critique({ topic: 't' })).rejects.toThrow(/returned empty output/);
  });

  it('resolveWriterModel returns a claude-format policy resolution and falls back otherwise', () => {
    // No policy → undefined.
    expect(resolveWriterModel()).toBeUndefined();

    // Claude-format writer default → that alias.
    loadModelPolicyMock.mockReturnValue({
      models: [{ alias: 'opus', provider: 'anthropic', format: 'claude' }],
    });
    resolveModelMock.mockReturnValue({ model: 'opus', provider: 'anthropic', rule: 'role-default' });
    expect(resolveWriterModel()).toBe('opus');
    expect(resolveModelMock).toHaveBeenCalledWith({ role: 'writer', capabilities: [] }, expect.anything());

    // Codex-format resolution → fallback (these calls run the Claude CLI).
    loadModelPolicyMock.mockReturnValue({
      models: [{ alias: 'gpt-5.6-sol', provider: 'openai', format: 'codex' }],
    });
    resolveModelMock.mockReturnValue({ model: 'gpt-5.6-sol', provider: 'openai', rule: 'role-default' });
    expect(resolveWriterModel()).toBeUndefined();

    // A throwing resolver degrades to the fallback, never breaks the run.
    resolveModelMock.mockImplementation(() => {
      throw new Error('policy exploded');
    });
    expect(resolveWriterModel()).toBeUndefined();
  });

  it('stripCodeFence leaves unfenced text and inner fences alone', () => {
    expect(stripCodeFence('# Plain doc')).toBe('# Plain doc');
    const withInner = '# Doc\n\n```ts\ncode();\n```\n\nMore.';
    expect(stripCodeFence(withInner)).toBe(withInner);
  });
});

describe('writing-run-deps — artifacts', () => {
  it('refuses a path that escapes the worktree (containment)', async () => {
    const { deps, failures } = makeHarness({ worktree: '/tmp/writing-worktree-unit' });
    await expect(deps.writeArtifact('../escape.md', 'x')).rejects.toThrow(/escapes the worktree/);
    expect(failures[0]).toMatchObject({ stage: 'write-artifact' });
    await expect(deps.readArtifact!('/etc/passwd')).rejects.toThrow(/escapes the worktree/);
  });

  it('writes nested artifact paths (mkdir -p) and reads them back', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'writing-artifacts-'));
    try {
      const { deps } = makeHarness({ worktree });
      await deps.writeArtifact('docs/rune/critiques/x.md', '# Notes\n');
      expect(await deps.readArtifact!('docs/rune/critiques/x.md')).toBe('# Notes\n');
      expect(await readFile(join(worktree, 'docs/rune/critiques/x.md'), 'utf8')).toBe('# Notes\n');
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});

describe('writing-run-deps — orchestration adapter', () => {
  it('omits deployExternal entirely (V1 must never deploy)', () => {
    const { deps } = buildProductionStartWritingDeps({ emitRunState: () => {} });
    expect('deployExternal' in deps).toBe(false);
  });

  it('throws the RECORDED stage failure when the core pipeline swallows an error into failed', async () => {
    vaultSearchMock.mockRejectedValueOnce(new Error('ripgrep exploded'));
    const worktree = mkdtempSync(join(tmpdir(), 'writing-adapter-'));
    try {
      const { deps, getFailure } = buildProductionStartWritingDeps({ emitRunState: () => {} });
      await expect(
        deps.runWritingPipeline({
          topic: 'Operating from memory',
          requestedBy: 'blog',
          branch: 'rune-writing/operating-from-memory',
          worktree,
        }),
      ).rejects.toThrow(/writing pipeline failed at research: ripgrep exploded/);
      expect(getFailure()).toMatchObject({ stage: 'research', message: 'ripgrep exploded' });
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('refuses a critique run whose branch is not a rune-writing/ ref', async () => {
    const { deps } = buildProductionStartWritingDeps({ emitRunState: () => {} });
    await expect(
      deps.runWritingPipeline({
        topic: 'x',
        requestedBy: 'writing-critique',
        branch: 'rune-work/09-expand-cockpit',
        worktree: '/tmp/nowhere',
        critiqueOutputPath: 'docs/rune/critiques/x.md',
      }),
    ).rejects.toThrow(/not a rune-writing\/ branch/);
  });

  it('writingRepoPresent reflects repo existence (the applier preflight)', () => {
    expect(writingRepoPresent('/nonexistent/michaelcjoseph.com')).toBe(false);
    expect(writingRepoPresent(tmpdir())).toBe(true);
  });
});

describe('writing-run-deps — REAL git integration', () => {
  it('creates rune-writing/{slug} fresh, commits branch-consistently, and resumes with prior commits', async () => {
    const base = mkdtempSync(join(tmpdir(), 'writing-real-git-'));
    const repo = join(base, 'repo');
    const worktreeRoot = join(base, 'worktrees');
    const productsConfigPath = join(base, 'products.json');
    try {
      mkdirSync(repo, { recursive: true });
      const git = (args: string[], cwd = repo) => defaultRunGit(args, { cwd });
      await git(['init', '--initial-branch', 'main']);
      await git(['config', 'user.email', 'writing-test@rune.local']);
      await git(['config', 'user.name', 'writing-test']);
      writeFileSync(join(repo, 'README.md'), 'site\n');
      await git(['add', '-A']);
      await git(['commit', '-m', 'baseline']);
      writeFileSync(
        productsConfigPath,
        JSON.stringify({
          writing: { class: 'external', repoPath: repo, baseBranch: 'main', validationCommands: [] },
        }),
      );
      const io = { worktreeRoot, productsConfigPath };
      const BRANCH = 'rune-writing/test-topic';

      // FRESH: worktree exists on the writing branch.
      const spec = await createProductionWritingWorktree(
        { product: 'writing', project: 'test-topic', branch: BRANCH },
        io,
      );
      expect(existsSync(spec.worktree)).toBe(true);
      expect(spec.resumed ?? false).toBe(false);
      const { stdout: branchOut } = await defaultRunGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: spec.worktree,
      });
      expect(branchOut.trim()).toBe(BRANCH);

      // Branch-consistent commit returns a real sha on the writing branch.
      const failures: WritingRunFailure[] = [];
      const deps = buildWritingPipelineDeps({
        worktree: spec.worktree,
        emitRunState: () => {},
        recordFailure: (f) => failures.push(f),
      });
      await deps.writeArtifact('docs/rune/test-topic.md', '# Test Topic\n\nBody.\n');
      // A mismatched branch is refused before anything is staged.
      await expect(
        deps.commitArtifact({ branch: 'rune-writing/other', paths: ['docs/rune/test-topic.md'], message: 'x' }),
      ).rejects.toThrow(/worktree is on 'rune-writing\/test-topic'/);
      const commit = await deps.commitArtifact({
        branch: BRANCH,
        paths: ['docs/rune/test-topic.md'],
        message: 'Publish writing page: test-topic',
      });
      expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
      const { stdout: tip } = await git(['rev-parse', BRANCH]);
      expect(tip.trim()).toBe(commit.sha);

      // RESUME: a later run gets the committed artifact back.
      await git(['worktree', 'remove', '--force', spec.worktree]);
      const resumedSpec = await createProductionWritingWorktree(
        { product: 'writing', project: 'test-topic', branch: BRANCH },
        io,
      );
      expect(resumedSpec.resumed).toBe(true);
      expect(await readFile(join(resumedSpec.worktree, 'docs/rune/test-topic.md'), 'utf8')).toContain(
        '# Test Topic',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);
});
