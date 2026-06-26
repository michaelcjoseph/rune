import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/test/vault',
    TIMEZONE: 'America/Chicago',
    TELEGRAM_USER_ID: 42,
  },
  PROJECT_ROOT: '/test/project',
}));

vi.mock('../ai/claude.js', () => ({
  loadAgentDef: vi.fn(() => ({ prompt: 'body', tools: [] })),
  clearAgentDefCache: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('node:fs', () => ({
  readdirSync: vi.fn(() => []),
}));

const {
  buildSkillRegistry,
  getSkillRegistry,
  reloadSkillRegistry,
  SLASH_COMMAND_METADATA,
} = await import('./skill-registry.js');
const { readdirSync } = await import('node:fs');
const { loadAgentDef, clearAgentDefCache } = await import('../ai/claude.js');

describe('buildSkillRegistry', () => {
  it('emits one entry per agent that has triggers', () => {
    const entries = buildSkillRegistry([
      { name: 'foo', description: 'Foo agent.', triggers: ['do foo'] },
      { name: 'bar', description: 'Bar agent.', triggers: ['do bar', 'bar please'] },
    ]);
    const agents = entries.filter(e => e.kind === 'agent');
    expect(agents).toHaveLength(2);
    expect(agents[0]!.name).toBe('foo');
    expect(agents[0]!.triggers).toEqual(['do foo']);
    expect(agents[1]!.name).toBe('bar');
  });

  it('skips agents with no triggers', () => {
    const entries = buildSkillRegistry([
      { name: 'has-triggers', triggers: ['go'] },
      { name: 'no-triggers' },
      { name: 'empty-triggers', triggers: [] },
    ]);
    const agents = entries.filter(e => e.kind === 'agent');
    expect(agents.map(a => a.name)).toEqual(['has-triggers']);
  });

  it('falls back to a synthesized description when agent description is missing', () => {
    const entries = buildSkillRegistry([{ name: 'nameless', triggers: ['go'] }]);
    const agent = entries.find(e => e.name === 'nameless')!;
    expect(agent.description).toBe('Agent: nameless');
  });

  it('includes every slash-command metadata entry as kind="slash"', () => {
    const entries = buildSkillRegistry([]);
    const slashes = entries.filter(e => e.kind === 'slash');
    expect(slashes).toHaveLength(SLASH_COMMAND_METADATA.length);
    for (const meta of SLASH_COMMAND_METADATA) {
      const match = slashes.find(s => s.name === meta.name);
      expect(match, `missing slash entry ${meta.name}`).toBeDefined();
      expect(match!.description).toBe(meta.description);
    }
  });

  it('produces only agent and slash entries (no synthetic intents)', () => {
    const entries = buildSkillRegistry([{ name: 'foo', triggers: ['do foo'] }]);
    for (const entry of entries) {
      expect(entry.kind).toMatch(/^(agent|slash)$/);
    }
    expect(entries.some(e => e.name === 'kb_query')).toBe(false);
  });
});

describe('SLASH_COMMAND_METADATA', () => {
  it('each entry has a non-empty name and description', () => {
    for (const meta of SLASH_COMMAND_METADATA) {
      expect(meta.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it('has unique names', () => {
    const names = SLASH_COMMAND_METADATA.map(m => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('covers the core review and content-capture commands', () => {
    const names = new Set(SLASH_COMMAND_METADATA.map(m => m.name));
    // Smoke-check: if these disappear from the table, the resolver loses
    // visibility into Rune's most commonly-used capabilities.
    for (const required of ['journal', 'weekly', 'family', 'learn', 'workout']) {
      expect(names.has(required), `missing slash metadata for /${required}`).toBe(true);
    }
  });

  it('does not advertise removed kb_query / think / kb / ask routes', () => {
    const names = new Set(SLASH_COMMAND_METADATA.map(m => m.name));
    for (const removed of ['kb_query', 'think', 'kb', 'ask']) {
      expect(names.has(removed), `${removed} should not be a resolver route`).toBe(false);
    }
  });

  it('includes both study and syllabus as distinct slash entries', () => {
    const names = new Set(SLASH_COMMAND_METADATA.map(m => m.name));
    expect(names.has('study'), 'missing slash metadata for /study').toBe(true);
    expect(names.has('syllabus'), 'missing slash metadata for /syllabus').toBe(true);
    // They must be separate entries — study is a quiz session, syllabus is progress view.
    const studyEntry = SLASH_COMMAND_METADATA.find(m => m.name === 'study')!;
    const syllabusEntry = SLASH_COMMAND_METADATA.find(m => m.name === 'syllabus')!;
    expect(studyEntry.description).not.toBe(syllabusEntry.description);
  });

  it('study entry has the expected trigger phrases', () => {
    const studyEntry = SLASH_COMMAND_METADATA.find(m => m.name === 'study')!;
    expect(studyEntry).toBeDefined();
    expect(studyEntry.triggers).toContain('quiz me');
    expect(studyEntry.triggers).toContain('spaced repetition');
  });
});

describe('getSkillRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Start each test with a clean cache.
    reloadSkillRegistry();
    vi.mocked(readdirSync).mockReturnValue([] as any);
    vi.mocked(loadAgentDef).mockReturnValue({ prompt: 'body', tools: [] });
  });

  it('returns only slash entries when no agents have triggers', () => {
    const entries = getSkillRegistry();
    const agents = entries.filter(e => e.kind === 'agent');
    expect(agents).toHaveLength(0);
    const slashes = entries.filter(e => e.kind === 'slash');
    expect(slashes.length).toBe(SLASH_COMMAND_METADATA.length);
    expect(entries.some(e => e.name === 'kb_query')).toBe(false);
  });

  it('includes agents whose frontmatter declares triggers', () => {
    vi.mocked(readdirSync).mockImplementation(((dir: string) => {
      if (dir.includes('/test/project/')) return ['with-triggers.md', 'no-triggers.md'];
      return [];
    }) as any);
    vi.mocked(loadAgentDef).mockImplementation((name: string) => {
      if (name === 'with-triggers') {
        return {
          prompt: 'body',
          tools: [],
          description: 'Does a thing.',
          triggers: ['do the thing'],
        };
      }
      return { prompt: 'body', tools: [] };
    });

    const entries = getSkillRegistry();
    const agents = entries.filter(e => e.kind === 'agent');
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe('with-triggers');
    expect(agents[0]!.description).toBe('Does a thing.');
    expect(agents[0]!.triggers).toEqual(['do the thing']);
  });

  it('dedupes agents by filename stem with Rune dir winning over vault', () => {
    vi.mocked(readdirSync).mockImplementation(((dir: string) => {
      if (dir.includes('/test/project/')) return ['dup.md'];
      if (dir.includes('/test/vault/')) return ['dup.md'];
      return [];
    }) as any);
    vi.mocked(loadAgentDef).mockReturnValue({
      prompt: 'body',
      tools: [],
      triggers: ['go'],
    });

    const entries = getSkillRegistry();
    const agents = entries.filter(e => e.kind === 'agent');
    expect(agents).toHaveLength(1);
    // loadAgentDef should only be called once — the second dir's dup is skipped
    expect(vi.mocked(loadAgentDef)).toHaveBeenCalledTimes(1);
  });

  it('skips non-.md files in the agents dir', () => {
    vi.mocked(readdirSync).mockImplementation(((dir: string) => {
      if (dir.includes('/test/project/')) return ['real.md', 'README.txt', '.DS_Store'];
      return [];
    }) as any);
    vi.mocked(loadAgentDef).mockReturnValue({
      prompt: 'body',
      tools: [],
      triggers: ['go'],
    });

    getSkillRegistry();
    expect(vi.mocked(loadAgentDef)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadAgentDef)).toHaveBeenCalledWith('real');
  });

  it('skips ENOENT on missing agent directories without warning', () => {
    vi.mocked(readdirSync).mockImplementation((() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }) as any);

    const entries = getSkillRegistry();
    // Still produces slash entries even with no agents on disk.
    expect(entries.some(e => e.kind === 'slash')).toBe(true);
    expect(entries.some(e => e.name === 'kb_query')).toBe(false);
  });

  it('caches the registry across repeat calls (no second fs scan)', () => {
    vi.mocked(readdirSync).mockImplementation(((dir: string) => {
      if (dir.includes('/test/project/')) return ['a.md'];
      return [];
    }) as any);
    vi.mocked(loadAgentDef).mockReturnValue({
      prompt: 'body',
      tools: [],
      triggers: ['go'],
    });

    getSkillRegistry();
    const firstCallCount = vi.mocked(readdirSync).mock.calls.length;
    getSkillRegistry();
    expect(vi.mocked(readdirSync).mock.calls.length).toBe(firstCallCount);
  });

  it('reloadSkillRegistry evicts the cache and the underlying agent-def cache', () => {
    vi.mocked(readdirSync).mockImplementation(((dir: string) => {
      if (dir.includes('/test/project/')) return ['a.md'];
      return [];
    }) as any);
    vi.mocked(loadAgentDef).mockReturnValue({
      prompt: 'body',
      tools: [],
      triggers: ['go'],
    });

    getSkillRegistry();
    const before = vi.mocked(readdirSync).mock.calls.length;

    reloadSkillRegistry();
    expect(vi.mocked(clearAgentDefCache)).toHaveBeenCalled();

    getSkillRegistry();
    expect(vi.mocked(readdirSync).mock.calls.length).toBeGreaterThan(before);
  });
});
