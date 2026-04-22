import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago' },
}));

vi.mock('../ai/claude.js', () => ({
  askClaudeOneShot: vi.fn(),
}));

vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
  writeVaultFile: vi.fn(),
}));

const { askClaudeOneShot } = await import('../ai/claude.js');
const { readVaultFile, writeVaultFile } = await import('../vault/files.js');
const { extractMeetings, appendProjectDecisions } = await import('./meeting-extract.js');

const askMock = askClaudeOneShot as unknown as ReturnType<typeof vi.fn>;
const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;
const writeMock = writeVaultFile as unknown as ReturnType<typeof vi.fn>;

describe('jobs/meeting-extract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('short-circuits without an LLM call when the journal has no #meeting tag', async () => {
    const result = await extractMeetings('# Journal\n- 10:00 read a paper\n- 14:00 coded', '2026-04-21');
    expect(result).toEqual([]);
    expect(askMock).not.toHaveBeenCalled();
  });

  it('returns a single structured meeting from a well-formed block', async () => {
    askMock.mockResolvedValue({
      text: JSON.stringify([
        { attendees: ['alice-advisor'], project: 'project-alpha', decisions: ['advisor terms finalized at 0.5%'] },
      ]),
      error: null,
    });
    const journal = '10:00 #meeting [[project-alpha]] kickoff. Attendees: [[alice-advisor]]. Decision: advisor terms finalized at 0.5%.';
    const result = await extractMeetings(journal, '2026-04-21');
    expect(result).toEqual([
      { attendees: ['alice-advisor'], project: 'project-alpha', decisions: ['advisor terms finalized at 0.5%'] },
    ]);
    expect(askMock).toHaveBeenCalledTimes(1);
  });

  it('returns multiple meetings when the journal has several #meeting blocks', async () => {
    askMock.mockResolvedValue({
      text: JSON.stringify([
        { attendees: ['alice'], project: 'relay', decisions: ['ship X by Q2'] },
        { attendees: ['bob', 'carol'], project: null, decisions: ['switch to monthly billing'] },
      ]),
      error: null,
    });
    const result = await extractMeetings('#meeting block 1 ... #meeting block 2 ...', '2026-04-21');
    expect(result).toHaveLength(2);
    expect(result[0]?.project).toBe('relay');
    expect(result[1]?.attendees).toEqual(['bob', 'carol']);
    expect(result[1]?.project).toBeNull();
  });

  it('strips markdown code fences from the LLM response', async () => {
    askMock.mockResolvedValue({
      text: '```json\n[{"attendees":["alice"],"project":null,"decisions":["ship X"]}]\n```',
      error: null,
    });
    const result = await extractMeetings('#meeting test', '2026-04-21');
    expect(result).toEqual([{ attendees: ['alice'], project: null, decisions: ['ship X'] }]);
  });

  it('drops entries with zero attendees AND zero decisions (belt-and-suspenders skip rule)', async () => {
    askMock.mockResolvedValue({
      text: JSON.stringify([
        { attendees: [], project: 'relay', decisions: [] }, // empty — should drop
        { attendees: ['alice'], project: null, decisions: [] }, // has attendees — keep
        { attendees: [], project: null, decisions: ['ship X'] }, // has decisions — keep
      ]),
      error: null,
    });
    const result = await extractMeetings('#meeting', '2026-04-21');
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.attendees.length + m.decisions.length > 0)).toBe(true);
  });

  it('returns [] and logs when the LLM returns an error', async () => {
    askMock.mockResolvedValue({ text: null, error: 'timeout' });
    const result = await extractMeetings('#meeting something', '2026-04-21');
    expect(result).toEqual([]);
  });

  it('returns [] when the LLM response is empty', async () => {
    askMock.mockResolvedValue({ text: '', error: null });
    const result = await extractMeetings('#meeting something', '2026-04-21');
    expect(result).toEqual([]);
  });

  it('returns [] when the LLM response is not valid JSON', async () => {
    askMock.mockResolvedValue({ text: 'sorry, I could not parse that', error: null });
    const result = await extractMeetings('#meeting something', '2026-04-21');
    expect(result).toEqual([]);
  });

  it('returns [] when the LLM returns JSON that is not an array', async () => {
    askMock.mockResolvedValue({ text: '{"attendees": ["alice"]}', error: null });
    const result = await extractMeetings('#meeting something', '2026-04-21');
    expect(result).toEqual([]);
  });

  it('filters out malformed entries inside an otherwise valid array', async () => {
    askMock.mockResolvedValue({
      text: JSON.stringify([
        'not an object',
        null,
        { attendees: ['alice'], project: null, decisions: ['ship X'] }, // valid
        { attendees: 'not-an-array', project: null, decisions: ['ship Y'] }, // attendees invalid but decisions valid → kept
      ]),
      error: null,
    });
    const result = await extractMeetings('#meeting', '2026-04-21');
    expect(result).toHaveLength(2);
    expect(result[0]?.attendees).toEqual(['alice']);
    expect(result[1]?.attendees).toEqual([]);
    expect(result[1]?.decisions).toEqual(['ship Y']);
  });

  it('includes the journal date in the LLM prompt', async () => {
    askMock.mockResolvedValue({ text: '[]', error: null });
    await extractMeetings('#meeting', '2026-04-21');
    expect(askMock).toHaveBeenCalledWith(expect.stringContaining('Journal date: 2026-04-21'));
  });

  it('instructs the LLM to prefer the wikilink slug form for attendees', async () => {
    askMock.mockResolvedValue({ text: '[]', error: null });
    await extractMeetings('#meeting [[alice]]', '2026-04-21');
    const prompt = askMock.mock.calls[0]![0] as string;
    expect(prompt).toContain('wikilink slug');
  });

  it('instructs the LLM to identify block boundaries holistically', async () => {
    askMock.mockResolvedValue({ text: '[]', error: null });
    await extractMeetings('#meeting', '2026-04-21');
    const prompt = askMock.mock.calls[0]![0] as string;
    expect(prompt).toContain('block boundaries');
    expect(prompt.toLowerCase()).toContain('holistically');
  });

  describe('appendProjectDecisions', () => {
    it('returns skipped (no write) when decisions array is empty', () => {
      const result = appendProjectDecisions('relay', '2026-04-21', []);
      expect(result.status).toBe('skipped');
      expect(result.appended).toBe(0);
      expect(writeMock).not.toHaveBeenCalled();
    });

    it('returns skipped when the project file does not exist', () => {
      readMock.mockReturnValue(null);
      const result = appendProjectDecisions('nonexistent', '2026-04-21', ['ship X']);
      expect(result.status).toBe('skipped');
      expect(result.detail).toContain('not found');
      expect(writeMock).not.toHaveBeenCalled();
    });

    it('returns skipped when the project has no Decisions Log section', () => {
      readMock.mockReturnValue('# project-alpha\n\n## Overview\nText.\n\n## Weekly Summaries\n');
      const result = appendProjectDecisions('project-alpha', '2026-04-21', ['ship X']);
      expect(result.status).toBe('skipped');
      expect(result.detail).toContain('no Decisions Log section');
      expect(writeMock).not.toHaveBeenCalled();
    });

    it('inserts a single decision after the Decisions Log heading', () => {
      readMock.mockReturnValue([
        '# project-alpha',
        '',
        '## Decisions Log',
        '',
        '### 2026-03-22: Old decision',
        '- context',
        '',
        '## Weekly Summaries',
      ].join('\n'));

      const result = appendProjectDecisions('project-alpha', '2026-04-21', ['ship X by Q2']);
      expect(result.status).toBe('success');
      expect(result.appended).toBe(1);

      const writtenPath = writeMock.mock.calls[0]![0];
      const writtenContent = writeMock.mock.calls[0]![1] as string;
      expect(writtenPath).toBe('projects/project-alpha.md');
      // New entry should appear before the old one
      const newIdx = writtenContent.indexOf('### [[2026_04_21]]: ship X by Q2');
      const oldIdx = writtenContent.indexOf('### 2026-03-22: Old decision');
      expect(newIdx).toBeGreaterThan(-1);
      expect(oldIdx).toBeGreaterThan(newIdx);
    });

    it('inserts multiple decisions, each as its own ### entry', () => {
      readMock.mockReturnValue('## Decisions Log\n\n');
      appendProjectDecisions('project-alpha', '2026-04-21', ['decide A', 'decide B', 'decide C']);

      const written = writeMock.mock.calls[0]![1] as string;
      expect(written).toContain('### [[2026_04_21]]: decide A');
      expect(written).toContain('### [[2026_04_21]]: decide B');
      expect(written).toContain('### [[2026_04_21]]: decide C');
    });

    it('inserts after italic intro lines (preserves the section preamble)', () => {
      readMock.mockReturnValue([
        '## Decisions Log',
        '*Key decisions with context. Don\'t delete—this is your record.*',
        '',
        '---',
      ].join('\n'));

      appendProjectDecisions('project-alpha', '2026-04-21', ['ship X']);

      const written = writeMock.mock.calls[0]![1] as string;
      const lines = written.split('\n');
      const headingIdx = lines.findIndex((l) => l === '## Decisions Log');
      const introIdx = lines.findIndex((l) => l.startsWith('*Key decisions'));
      const newEntryIdx = lines.findIndex((l) => l === '### [[2026_04_21]]: ship X');
      // Intro line is preserved and appears before the new entry
      expect(introIdx).toBeGreaterThan(headingIdx);
      expect(newEntryIdx).toBeGreaterThan(introIdx);
    });

    it('returns error when writeVaultFile throws', () => {
      readMock.mockReturnValue('## Decisions Log\n');
      writeMock.mockImplementationOnce(() => { throw new Error('disk full'); });

      const result = appendProjectDecisions('project-alpha', '2026-04-21', ['ship X']);
      expect(result.status).toBe('error');
      expect(result.detail).toContain('disk full');
    });

    it('matches the Decisions Log heading case-insensitively', () => {
      readMock.mockReturnValue('## decisions log\n\n');
      const result = appendProjectDecisions('project-alpha', '2026-04-21', ['ship X']);
      expect(result.status).toBe('success');
    });
  });
});
