import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
}));

vi.mock('./capture.js', () => ({ captureSessions: vi.fn() }));
vi.mock('./whoop-sync.js', () => ({ executeActivitySync: vi.fn(() => ({ status: 'skipped', detail: 'Whoop not configured' })) }));
vi.mock('./playbook-extract.js', () => ({
  extractPlaybookDrafts: vi.fn(() => ({ status: 'skipped', detail: 'No #playbook tag' })),
}));
vi.mock('./meeting-extract.js', () => ({
  extractMeetings: vi.fn(() => Promise.resolve([])),
  appendProjectDecisions: vi.fn(() => ({ status: 'skipped', appended: 0, detail: 'no decisions to append' })),
}));
vi.mock('../kb/engine.js', () => ({
  processIngestionQueue: vi.fn(),
  lintKB: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('../ai/claude.js', () => ({
  askClaudeOneShot: vi.fn(),
  runAgent: vi.fn(),
}));
vi.mock('../vault/files.js', () => ({ readVaultFile: vi.fn(), writeVaultFile: vi.fn() }));
vi.mock('../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));
vi.mock('../utils/time.js', () => ({
  getTodayDate: vi.fn(() => '2026-04-11'),
  getTodayFilename: vi.fn(() => '2026_04_11.md'),
  getDayOfWeek: vi.fn(() => 'Saturday'),
}));

const { captureSessions } = await import('./capture.js');
const { processIngestionQueue, lintKB, enqueue } = await import('../kb/engine.js');
const { askClaudeOneShot, runAgent } = await import('../ai/claude.js');
const { readVaultFile, writeVaultFile } = await import('../vault/files.js');
const { gitCommitAndPush } = await import('../vault/git.js');
const { getDayOfWeek } = await import('../utils/time.js');
const { extractMeetings, appendProjectDecisions } = await import('./meeting-extract.js');
const { executeNightly, runNightly } = await import('./nightly.js');

const captureMock = captureSessions as unknown as ReturnType<typeof vi.fn>;
const queueMock = processIngestionQueue as unknown as ReturnType<typeof vi.fn>;
const enqueueMock = enqueue as unknown as ReturnType<typeof vi.fn>;
const lintMock = lintKB as unknown as ReturnType<typeof vi.fn>;
const askMock = askClaudeOneShot as unknown as ReturnType<typeof vi.fn>;
const agentMock = runAgent as unknown as ReturnType<typeof vi.fn>;
const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;
const writeMock = writeVaultFile as unknown as ReturnType<typeof vi.fn>;
const gitMock = gitCommitAndPush as unknown as ReturnType<typeof vi.fn>;
const dayMock = getDayOfWeek as unknown as ReturnType<typeof vi.fn>;
const extractMeetingsMock = extractMeetings as unknown as ReturnType<typeof vi.fn>;
const appendDecisionsMock = appendProjectDecisions as unknown as ReturnType<typeof vi.fn>;

function setDefaults() {
  captureMock.mockResolvedValue({ captured: 0 });
  queueMock.mockResolvedValue({ processed: 0, errors: 0, created: 0, updated: 0 });
  readMock.mockReturnValue(null);
  dayMock.mockReturnValue('Saturday');
}

describe('jobs/nightly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaults();
  });

  describe('executeNightly', () => {
    it('runs all 9 steps and returns results', async () => {
      const result = await executeNightly();
      expect(result.steps).toHaveLength(9);
      expect(result.steps.map((s) => s.step)).toEqual([
        'Session capture',
        'Daily tags',
        'Playbook extract',
        'Journal ingest',
        'Meeting extract',
        'KB queue',
        'Whoop activity',
        'KB lint',
        'Mark processed',
      ]);
    });

    it('always runs final git commit', async () => {
      await executeNightly();
      // Last call to gitCommitAndPush should be the final "Nightly processing" commit
      expect(gitMock).toHaveBeenCalledWith('Nightly processing');
    });

    // -- Session capture step --
    it('reports session capture success', async () => {
      captureMock.mockResolvedValue({ captured: 3 });
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Session capture')!;
      expect(step.status).toBe('success');
      expect(step.detail).toContain('3');
    });

    it('reports session capture skipped when none active', async () => {
      captureMock.mockResolvedValue({ captured: 0 });
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Session capture')!;
      expect(step.status).toBe('skipped');
    });

    // -- KB queue step --
    it('reports KB queue success with source + counts detail', async () => {
      queueMock.mockResolvedValue({ processed: 2, errors: 0, created: 3, updated: 1 });
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'KB queue')!;
      expect(step.status).toBe('success');
      expect(step.detail).toBe('2 source(s) ingested, 3 created, 1 updated');
    });

    it('reports 0 created / 0 updated when all queued sources skipped as duplicates', async () => {
      queueMock.mockResolvedValue({ processed: 1, errors: 0, created: 0, updated: 0 });
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'KB queue')!;
      expect(step.status).toBe('success');
      expect(step.detail).toBe('1 source(s) ingested, 0 created, 0 updated');
    });

    it('reports KB queue error when some items fail', async () => {
      queueMock.mockResolvedValue({ processed: 1, errors: 1, created: 0, updated: 0 });
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'KB queue')!;
      expect(step.status).toBe('error');
    });

    it('reports KB queue skipped when empty', async () => {
      queueMock.mockResolvedValue({ processed: 0, errors: 0, created: 0, updated: 0 });
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'KB queue')!;
      expect(step.status).toBe('skipped');
    });

    // -- Daily tags step --
    it('skips daily tags when no journal content', async () => {
      readMock.mockReturnValue(null);
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('skipped');
      expect(step.detail).toContain('No journal');
      expect(askMock).not.toHaveBeenCalled();
    });

    it('skips daily tags when journal is empty whitespace', async () => {
      readMock.mockReturnValue('   \n  ');
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('skipped');
    });

    it('skips daily tags when analysis says "No JSON updates needed"', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 Did some reading');
      askMock.mockResolvedValue({ text: 'No JSON updates needed. Light day.', error: null });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('skipped');
      expect(step.detail).toContain('No actionable tags');
      expect(agentMock).not.toHaveBeenCalled();
    });

    it('runs json-updater agent when tags found', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 #workout ran 5k');
      askMock.mockResolvedValue({
        text: '**#workout** -> health/workouts.json\n- 5k run',
        error: null,
      });
      agentMock.mockResolvedValue({ text: 'Updated', error: null });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('success');
      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('#workout'));
      expect(gitMock).toHaveBeenCalledWith(expect.stringContaining('Daily tag processing'));
    });

    it('reports error when analysis returns an error', async () => {
      readMock.mockReturnValue('# Journal\n- stuff');
      askMock.mockResolvedValue({ text: null, error: 'Claude timed out' });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('error');
      expect(step.detail).toContain('Claude timed out');
    });

    it('reports error when json-updater agent fails', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 #book read Dune');
      askMock.mockResolvedValue({ text: '**#book** -> books.json', error: null });
      agentMock.mockResolvedValue({ text: null, error: 'Agent crashed' });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('error');
      expect(step.detail).toContain('Agent crashed');
    });

    // -- Journal ingest step --
    it('enqueues today\'s journal when content exists', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 meeting with #alice about project');
      // Prevent Daily tags from calling the json-updater agent during this test
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Journal ingest')!;
      expect(step.status).toBe('success');
      expect(step.detail).toContain('journals/');
      expect(enqueueMock).toHaveBeenCalledWith('journals/2026_04_11.md');
    });

    it('skips journal ingest when journal is empty', async () => {
      readMock.mockReturnValue('   \n  ');
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Journal ingest')!;
      expect(step.status).toBe('skipped');
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('skips journal ingest when journal does not exist', async () => {
      readMock.mockReturnValue(null);
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Journal ingest')!;
      expect(step.status).toBe('skipped');
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it('enqueues today\'s journal BEFORE processIngestionQueue runs', async () => {
      // Invariant: stepJournalIngest must enqueue before stepKBQueue processes,
      // so today's journal is ingested in the same nightly pass.
      readMock.mockReturnValue('# Journal\n- 10:00 meeting with team');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });

      await executeNightly();

      expect(enqueueMock).toHaveBeenCalledWith('journals/2026_04_11.md');
      expect(queueMock).toHaveBeenCalled();
      const enqueueOrder = enqueueMock.mock.invocationCallOrder[0]!;
      const queueOrder = queueMock.mock.invocationCallOrder[0]!;
      expect(enqueueOrder).toBeLessThan(queueOrder);
    });

    // -- Meeting extract step --
    it('skips meeting extract when journal has no content', async () => {
      readMock.mockReturnValue(null);
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Meeting extract')!;
      expect(step.status).toBe('skipped');
      expect(extractMeetingsMock).not.toHaveBeenCalled();
    });

    it('skips meeting extract when extractMeetings returns no meetings', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 no meetings today');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([]);

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Meeting extract')!;
      expect(step.status).toBe('skipped');
      expect(step.detail).toContain('No #meeting');
    });

    it('invokes json-updater for CRM with attendees + dedup-aware prompt when meetings have attendees', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 #meeting [[project-alpha]]');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: ['alice'], project: 'project-alpha', decisions: ['ship by Q2'] },
        { attendees: ['bob'], project: null, decisions: [] },
      ]);
      agentMock.mockResolvedValue({ text: 'alice: appended\nbob: created new entry', error: null });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Meeting extract')!;
      expect(step.status).toBe('success');
      expect(step.detail).toBe('2 meeting(s), 2 attendee(s) → CRM');
      expect(extractMeetingsMock).toHaveBeenCalledWith(
        expect.stringContaining('#meeting'),
        '2026-04-11',
      );
      // json-updater was invoked with a CRM-update prompt referencing attendees, today's journal_ref, and dedup
      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('pages/crm.json'));
      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('2026_04_11'));
      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('alice'));
      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('bob'));
      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('Dedup'));
    });

    it('skips json-updater call when meetings have no attendees (decisions-only)', async () => {
      readMock.mockReturnValue('# Journal\n#meeting');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: [], project: 'project-alpha', decisions: ['decide X'] },
      ]);

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Meeting extract')!;
      expect(step.status).toBe('success');
      expect(step.detail).toContain('no attendees');
      expect(step.detail).toContain('skipped CRM');
      // json-updater was NOT called for CRM (it's still called for daily-tags possibly, so check specifically)
      const crmCalls = agentMock.mock.calls.filter(
        (c) => c[0] === 'json-updater' && typeof c[1] === 'string' && c[1].includes('pages/crm.json'),
      );
      expect(crmCalls).toHaveLength(0);
    });

    it('deduplicates attendees across multiple meetings before invoking json-updater', async () => {
      readMock.mockReturnValue('# Journal\n#meeting');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: ['alice', 'bob'], project: 'project-alpha', decisions: [] },
        { attendees: ['bob', 'carol'], project: 'project-beta', decisions: [] },
      ]);
      agentMock.mockResolvedValue({ text: 'updated', error: null });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Meeting extract')!;
      // alice + bob + carol = 3 unique (bob would be 2 if not deduped)
      expect(step.detail).toBe('2 meeting(s), 3 attendee(s) → CRM');
      const crmCall = agentMock.mock.calls.find(
        (c) => c[0] === 'json-updater' && typeof c[1] === 'string' && c[1].includes('pages/crm.json'),
      )!;
      // bob should appear exactly once in the prompt's attendee list (not twice)
      const bobLines = (crmCall[1] as string).split('\n').filter((l) => l === '- bob');
      expect(bobLines).toHaveLength(1);
    });

    it('enqueues pages/crm.json for KB ingestion after a successful CRM update', async () => {
      readMock.mockReturnValue('# Journal\n#meeting');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: ['alice'], project: null, decisions: [] },
      ]);
      agentMock.mockResolvedValue({ text: 'alice: appended', error: null });

      await executeNightly();

      expect(enqueueMock).toHaveBeenCalledWith('pages/crm.json');
    });

    it('does NOT enqueue pages/crm.json when CRM update fails', async () => {
      readMock.mockReturnValue('# Journal\n#meeting');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: ['alice'], project: null, decisions: [] },
      ]);
      agentMock.mockResolvedValue({ text: null, error: 'agent crashed' });

      await executeNightly();

      expect(enqueueMock).not.toHaveBeenCalledWith('pages/crm.json');
    });

    it('routes decisions to the correct project per meeting (multi-project dispatch)', async () => {
      readMock.mockReturnValue('# Journal\n#meeting #meeting');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: ['alice'], project: 'project-alpha', decisions: ['decide alpha'] },
        { attendees: ['bob'], project: 'project-beta', decisions: ['decide beta-1', 'decide beta-2'] },
      ]);
      agentMock.mockResolvedValue({ text: 'updated', error: null });
      appendDecisionsMock.mockReturnValue({ status: 'success', appended: 1, detail: 'ok' });

      await executeNightly();

      // Each project gets its own decisions list — alpha gets 1, beta gets 2
      expect(appendDecisionsMock).toHaveBeenCalledWith('project-alpha', '2026-04-11', ['decide alpha']);
      expect(appendDecisionsMock).toHaveBeenCalledWith('project-beta', '2026-04-11', ['decide beta-1', 'decide beta-2']);
    });

    it('appends decisions even when meetings have no attendees (decisions-only path)', async () => {
      readMock.mockReturnValue('# Journal\n#meeting');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: [], project: 'project-alpha', decisions: ['ship X by Q2'] },
      ]);
      appendDecisionsMock.mockReturnValue({ status: 'success', appended: 1, detail: 'ok' });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Meeting extract')!;
      expect(step.status).toBe('success');
      expect(step.detail).toContain('skipped CRM (no attendees)');
      expect(step.detail).toContain('1 decision(s) → projects/');
      // Decision was still appended despite no CRM call
      expect(appendDecisionsMock).toHaveBeenCalledWith('project-alpha', '2026-04-11', ['ship X by Q2']);
      expect(enqueueMock).toHaveBeenCalledWith('projects/project-alpha.md');
      // CRM agent NOT called
      const crmCalls = agentMock.mock.calls.filter(
        (c) => c[0] === 'json-updater' && typeof c[1] === 'string' && c[1].includes('pages/crm.json'),
      );
      expect(crmCalls).toHaveLength(0);
    });

    it('appends decisions to project Decisions Logs and enqueues touched project files', async () => {
      readMock.mockReturnValue('# Journal\n#meeting');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: ['alice'], project: 'project-alpha', decisions: ['ship X by Q2'] },
        { attendees: ['bob'], project: 'project-beta', decisions: ['decide A', 'decide B'] },
        { attendees: ['carol'], project: null, decisions: ['orphan decision'] }, // no project → no append
        { attendees: ['dave'], project: 'project-gamma', decisions: [] }, // no decisions → no append
      ]);
      agentMock.mockResolvedValue({ text: 'updated', error: null });
      appendDecisionsMock.mockReturnValue({ status: 'success', appended: 1, detail: 'ok' });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Meeting extract')!;
      expect(step.status).toBe('success');
      // Helper called for project-alpha (1 decision) + project-beta (2 decisions); skipped for null/empty
      expect(appendDecisionsMock).toHaveBeenCalledTimes(2);
      expect(appendDecisionsMock).toHaveBeenCalledWith('project-alpha', '2026-04-11', ['ship X by Q2']);
      expect(appendDecisionsMock).toHaveBeenCalledWith('project-beta', '2026-04-11', ['decide A', 'decide B']);
      // Both touched project files enqueued for KB ingestion
      expect(enqueueMock).toHaveBeenCalledWith('projects/project-alpha.md');
      expect(enqueueMock).toHaveBeenCalledWith('projects/project-beta.md');
    });

    it('does not enqueue project files when appendProjectDecisions skips or errors', async () => {
      readMock.mockReturnValue('# Journal\n#meeting');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: ['alice'], project: 'project-missing', decisions: ['ship X'] },
      ]);
      agentMock.mockResolvedValue({ text: 'updated', error: null });
      appendDecisionsMock.mockReturnValue({ status: 'skipped', appended: 0, detail: 'projects/project-missing.md not found' });

      await executeNightly();

      expect(enqueueMock).not.toHaveBeenCalledWith('projects/project-missing.md');
    });

    it('includes the decisions count in the success step detail when any are appended', async () => {
      readMock.mockReturnValue('# Journal\n#meeting');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: ['alice'], project: 'project-alpha', decisions: ['decide A', 'decide B'] },
      ]);
      agentMock.mockResolvedValue({ text: 'updated', error: null });
      appendDecisionsMock.mockReturnValue({ status: 'success', appended: 2, detail: 'ok' });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Meeting extract')!;
      expect(step.detail).toContain('2 decision(s) → projects/');
    });

    it('reports error when json-updater CRM update fails', async () => {
      readMock.mockReturnValue('# Journal\n#meeting');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: ['alice'], project: null, decisions: [] },
      ]);
      agentMock.mockResolvedValue({ text: null, error: 'agent crashed' });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Meeting extract')!;
      expect(step.status).toBe('error');
      expect(step.detail).toContain('CRM update failed');
      expect(step.detail).toContain('agent crashed');
    });

    // -- Lint step --
    it('skips lint when not Sunday', async () => {
      dayMock.mockReturnValue('Wednesday');
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'KB lint')!;
      expect(step.status).toBe('skipped');
      expect(step.detail).toContain('Not Sunday');
      expect(lintMock).not.toHaveBeenCalled();
    });

    it('runs lint on Sunday and reports success', async () => {
      dayMock.mockReturnValue('Sunday');
      lintMock.mockResolvedValue({ success: true, report: 'All good, 0 issues' });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'KB lint')!;
      expect(step.status).toBe('success');
      expect(step.detail).toContain('All good');
    });

    it('reports lint error when agent fails on Sunday', async () => {
      dayMock.mockReturnValue('Sunday');
      lintMock.mockResolvedValue({ success: false, report: 'Lint error: Claude timed out after 300s' });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'KB lint')!;
      expect(step.status).toBe('error');
      expect(step.detail).toContain('timed out');
    });

    // -- Mark processed step --
    it('appends the daily-processed marker to today\'s journal when not already present', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 entry\n');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Mark processed')!;
      expect(step.status).toBe('success');
      expect(step.detail).toBe('<!-- daily-processed: 2026-04-11 -->');
      expect(writeMock).toHaveBeenCalledWith(
        'journals/2026_04_11.md',
        expect.stringContaining('<!-- daily-processed: 2026-04-11 -->'),
      );
    });

    it('skips the marker append when today\'s marker is already present (idempotent)', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 entry\n\n<!-- daily-processed: 2026-04-11 -->\n');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Mark processed')!;
      expect(step.status).toBe('skipped');
      expect(step.detail).toContain('already present');
      // No write call for the journal — but other steps may have written elsewhere
      const journalWrites = writeMock.mock.calls.filter((c) => c[0] === 'journals/2026_04_11.md');
      expect(journalWrites).toHaveLength(0);
    });

    it('skips the marker step when no journal content exists', async () => {
      readMock.mockReturnValue(null);

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Mark processed')!;
      expect(step.status).toBe('skipped');
      expect(step.detail).toContain('No journal content');
    });

    it('appends the marker even when the file already has a marker for a different date', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 entry\n\n<!-- daily-processed: 2026-04-10 -->\n');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });

      await executeNightly();

      const writeCall = writeMock.mock.calls.find((c) => c[0] === 'journals/2026_04_11.md')!;
      const written = writeCall[1] as string;
      // Both markers are now present (don't strip prior — keep audit trail)
      expect(written).toContain('<!-- daily-processed: 2026-04-10 -->');
      expect(written).toContain('<!-- daily-processed: 2026-04-11 -->');
    });

    // -- Error isolation --
    it('continues when session capture throws', async () => {
      captureMock.mockRejectedValue(new Error('crash'));

      const result = await executeNightly();
      expect(result.steps).toHaveLength(9);
      expect(result.steps[0]!.status).toBe('error');
      // Remaining steps still ran
      expect(result.steps[1]!.step).toBe('Daily tags');
      expect(queueMock).toHaveBeenCalled();
    });

    it('continues when KB queue throws', async () => {
      queueMock.mockRejectedValue(new Error('queue exploded'));

      const result = await executeNightly();
      expect(result.steps).toHaveLength(9);
      // KB queue is at index 5 (after Session capture, Daily tags, Playbook extract, Journal ingest, Meeting extract)
      expect(result.steps[5]!.step).toBe('KB queue');
      expect(result.steps[5]!.status).toBe('error');
      // Whoop activity still ran after it
      expect(result.steps[6]!.step).toBe('Whoop activity');
    });

    it('continues when journal read throws', async () => {
      readMock.mockImplementation(() => { throw new Error('fs error'); });

      const result = await executeNightly();
      expect(result.steps).toHaveLength(9);
      // Journal read is centralized; journal-dependent steps skip gracefully
      const dailyTags = result.steps.find((s) => s.step === 'Daily tags')!;
      const journalIngest = result.steps.find((s) => s.step === 'Journal ingest')!;
      const meetingExtract = result.steps.find((s) => s.step === 'Meeting extract')!;
      const markProcessed = result.steps.find((s) => s.step === 'Mark processed')!;
      expect(dailyTags.status).toBe('skipped');
      expect(journalIngest.status).toBe('skipped');
      expect(meetingExtract.status).toBe('skipped');
      expect(markProcessed.status).toBe('skipped');
      expect(enqueueMock).not.toHaveBeenCalled();
      // Mark processed is now last
      expect(result.steps[8]!.step).toBe('Mark processed');
    });

    it('reads today journal only once across steps', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 #workout ran 5k');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });

      await executeNightly();

      const journalReads = readMock.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].startsWith('journals/'),
      );
      expect(journalReads).toHaveLength(1);
      expect(journalReads[0]![0]).toBe('journals/2026_04_11.md');
    });
  });

  describe('runNightly', () => {
    it('sends summary message to Telegram on success', async () => {
      const bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;

      await runNightly(bot);

      expect(bot.sendMessage).toHaveBeenCalledTimes(1);
      expect(bot.sendMessage).toHaveBeenCalledWith(12345, expect.stringContaining('Nightly complete'));
    });

    it('sends error message when executeNightly throws', async () => {
      captureMock.mockImplementation(() => { throw new Error('total failure'); });
      // Make all steps throw so the error propagates through run() — but run() catches.
      // Actually executeNightly wraps each step, so it won't throw from step errors.
      // We need to make something outside the steps throw.
      // gitCommitAndPush at the end will throw:
      gitMock.mockImplementation(() => { throw new Error('total failure'); });

      const bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
      await runNightly(bot);

      expect(bot.sendMessage).toHaveBeenCalledWith(12345, expect.stringContaining('failed'));
    });

    it('does not throw when both nightly and TG message fail', async () => {
      gitMock.mockImplementation(() => { throw new Error('git broke'); });
      const bot = {
        sendMessage: vi.fn()
          .mockRejectedValueOnce(new Error('TG down'))   // error message send fails
          .mockRejectedValueOnce(new Error('TG down')),  // in case called again
      } as any;

      // Should not throw
      await expect(runNightly(bot)).resolves.toBeUndefined();
    });

    it('includes step status icons in summary message', async () => {
      captureMock.mockResolvedValue({ captured: 1 });
      gitMock.mockReturnValue(undefined); // ensure no leftover throw from prior test
      const bot = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;

      await runNightly(bot);

      const msg = bot.sendMessage.mock.calls[0][1] as string;
      expect(msg).toContain('[+]'); // success icon
      expect(msg).toContain('[-]'); // skipped icon
    });
  });
});
