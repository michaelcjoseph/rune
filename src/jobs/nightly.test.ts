import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/test/vault',
    TIMEZONE: 'America/Chicago',
    TELEGRAM_USER_ID: 12345,
    IMPLICIT_CRM_NAMES: ['alice', 'bob'],
    ESCALATION_POLICY_FILE: '/test/escalation-policy.json',
    LOGS_DIR: '/test/logs',
  },
  PROJECT_ROOT: '/test/project',
}));

// Phase 6 B5 — observation step pulls in these modules; mock at the surface
// so the test doesn't need real disk/LLM. The step's pure behavior is
// covered by observation-nightly.test.ts / observation-sensor-readers.test.ts
// / observation-callbacks.test.ts / observation-ideas-io.test.ts.
vi.mock('../intent/observation-nightly.js', () => ({
  runNightlyObservation: vi.fn(async () => ({
    outcomes: [], dispatchPlans: [], ideasMarkdown: '',
  })),
}));
vi.mock('../intent/observation-sensor-readers.js', () => ({
  readVaultSignals: vi.fn(() => []),
  readTelemetrySignals: vi.fn(() => []),
  readInteractionSignals: vi.fn(() => []),
}));
vi.mock('../intent/observation-callbacks.js', () => ({
  diarize: vi.fn(async (s: unknown[]) => s),
  triage: vi.fn(async () => ({ file: false, reason: 'mocked' })),
}));
vi.mock('../intent/observation-ideas-io.js', () => ({
  readFiledIdeas: vi.fn(() => []),
  appendFiledIdeas: vi.fn(),
}));
vi.mock('../intent/escalation.js', () => ({
  decideFailClosed: vi.fn(() => ({ verdict: 'proceed', reason: '', failClosed: false })),
}));
vi.mock('../transport/mutations.js', () => ({
  createMutation: vi.fn(async () => ({ ok: true, descriptor: { id: 'm1' } })),
}));

vi.mock('./capture.js', () => ({ captureSessions: vi.fn() }));
vi.mock('./whoop-sync.js', () => ({ executeActivitySync: vi.fn(() => ({ status: 'skipped', detail: 'Whoop not configured' })) }));
vi.mock('./playbook-extract.js', () => ({
  extractPlaybookDrafts: vi.fn(() => ({ status: 'skipped', detail: 'No #playbook tag' })),
}));
// Phase 6 C7 — journal-intent producer step. Mock the producer to return
// "no new proposals" so the step status is consistent ('skipped'). The
// pipeline-level test only checks that the step runs in the expected
// position; the producer's own behavior is covered by the e2e suite.
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
  rebuildRegistry: vi.fn(() => ({ products: 4, projects: 23 })),
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
  registerActiveProcess: vi.fn(),
  unregisterActiveProcess: vi.fn(),
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
  agentMock.mockResolvedValue({ text: null, error: null });
  readMock.mockReturnValue(null);
  dayMock.mockReturnValue('Saturday');
  // vi.clearAllMocks() clears call history but NOT implementations, so a test
  // that points gitMock at a thrower would leak into the next test and add a
  // spurious 'Final commit' error step to its result. Reset to a no-op here.
  gitMock.mockReturnValue(undefined);
}

describe('jobs/nightly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaults();
  });

  describe('executeNightly', () => {
    it('runs all 14 steps and returns results', async () => {
      const result = await executeNightly();
      expect(result.steps).toHaveLength(14);
      expect(result.steps.map((s) => s.step)).toEqual([
        'Session capture',
        'Daily tags',
        'Birthday alerts',
        'Playbook extract',
        'Registry rebuild',
        'Journal-intent producer',
        'Journal ingest',
        'Meeting extract',
        'Library sync',
        'KB queue',
        'Whoop activity',
        'Observation loop',
        'KB lint',
        'Mark processed',
      ]);
    });

    it('uses the provided targetDate (for backfill) instead of getTodayDate', async () => {
      readMock.mockReturnValue('# Journal for 2026-04-17\n- some content');
      askMock.mockResolvedValue({ text: 'No updates needed.', error: null });

      await executeNightly('2026-04-17');

      // Journal read uses the target filename, not today's
      expect(readMock).toHaveBeenCalledWith('journals/2026_04_17.md');
    });

    it('defaults to today when no targetDate is provided', async () => {
      readMock.mockReturnValue(null);
      await executeNightly();
      expect(readMock).toHaveBeenCalledWith('journals/2026_04_11.md');
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
      expect(agentMock).not.toHaveBeenCalledWith('json-updater', expect.any(String));
      expect(agentMock).not.toHaveBeenCalledWith('daily-content-updater', expect.any(String));
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
      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('#workout'), undefined, false);
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
      readMock.mockReturnValue('# Journal\n- 10:00 #books read Dune');
      askMock.mockResolvedValue({ text: '**#books** -> books.json', error: null });
      agentMock.mockResolvedValue({ text: null, error: 'Agent crashed' });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('error');
      expect(step.detail).toContain('Agent crashed');
    });

    // -- Daily-tags abort gate --
    it('aborts the nightly pipeline when Daily tags fails (json-updater error)', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 #books read Dune');
      askMock.mockResolvedValue({ text: '**#books** -> books.json', error: null });
      agentMock.mockResolvedValue({ text: null, error: 'Agent crashed' });

      const result = await executeNightly();

      // Session capture + Daily tags + Aborted sentinel — nothing else
      expect(result.steps.map((s) => s.step)).toEqual([
        'Session capture',
        'Daily tags',
        'Aborted',
      ]);
      expect(result.steps[2]!.status).toBe('error');
      expect(result.steps[2]!.detail).toContain('processed marker not written');

      // Downstream steps did NOT run
      expect(extractMeetingsMock).not.toHaveBeenCalled();
      expect(queueMock).not.toHaveBeenCalled();

      // Marker was NOT appended to the journal
      const markerWrites = writeMock.mock.calls.filter(
        (c) => typeof c[1] === 'string' && c[1].includes('<!-- daily-processed:'),
      );
      expect(markerWrites).toHaveLength(0);

      // Final commit still ran, with the aborted label
      expect(gitMock).toHaveBeenCalledWith('Nightly processing (aborted after Daily tags)');
      // Normal final commit was NOT called (early return prevents double commit)
      expect(gitMock).not.toHaveBeenCalledWith('Nightly processing');
    });

    it('aborts the nightly pipeline when daily-content-updater errors', async () => {
      readMock.mockReturnValue('# Journal\n- 11:30 #idea cool product concept');
      askMock.mockResolvedValue({ text: '**#idea** → projects/ideas.md\n- Cool concept', error: null });
      agentMock.mockResolvedValue({ text: null, error: 'content-updater crashed' });

      const result = await executeNightly();

      expect(result.steps.map((s) => s.step)).toEqual([
        'Session capture',
        'Daily tags',
        'Aborted',
      ]);
      expect(result.steps[2]!.status).toBe('error');
      expect(result.steps[2]!.detail).toContain('processed marker not written');
      expect(gitMock).toHaveBeenCalledWith('Nightly processing (aborted after Daily tags)');
      expect(gitMock).not.toHaveBeenCalledWith('Nightly processing');
    });

    it('aborts the nightly pipeline when Daily tags analysis errors', async () => {
      readMock.mockReturnValue('# Journal\n- stuff');
      askMock.mockResolvedValue({ text: null, error: 'Claude timed out' });

      const result = await executeNightly();

      expect(result.steps.map((s) => s.step)).toEqual([
        'Session capture',
        'Daily tags',
        'Aborted',
      ]);
      expect(gitMock).toHaveBeenCalledWith('Nightly processing (aborted after Daily tags)');
    });

    it('does NOT abort when Daily tags is skipped (no actionable tags)', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 light reading');
      askMock.mockResolvedValue({ text: 'No updates needed. Light day.', error: null });

      const result = await executeNightly();

      const markStep = result.steps.find((s) => s.step === 'Mark processed')!;
      expect(markStep.status).toBe('success');
    });

    it('preserves the structured abort summary when the abort-path git commit fails', async () => {
      // Regression guard for the original motivation behind safeFinalCommit:
      // a failing vault push during the abort path must not swallow the
      // Aborted step or escape executeNightly.
      readMock.mockReturnValue('# Journal\n- 10:00 #books read Dune');
      askMock.mockResolvedValue({ text: '**#books** -> books.json', error: null });
      agentMock.mockResolvedValue({ text: null, error: 'Agent crashed' });
      gitMock.mockImplementation(() => { throw new Error('push refused'); });

      const result = await executeNightly();

      expect(result.steps.map((s) => s.step)).toEqual([
        'Session capture',
        'Daily tags',
        'Aborted',
        'Final commit',
      ]);
      expect(result.steps[3]!.status).toBe('error');
      expect(result.steps[3]!.detail).toContain('push refused');
    });

    it('includes special rules (implicit CRM, study status, #health flags) in the daily-tags analysis prompt', async () => {
      readMock.mockReturnValue('# Journal\n- something');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });

      await executeNightly();

      const prompt = askMock.mock.calls[0]![0] as string;
      // Implicit CRM names come from config.IMPLICIT_CRM_NAMES (mocked to ['alice', 'bob']).
      expect(prompt).toContain('[[alice]]');
      expect(prompt).toContain('[[bob]]');
      expect(prompt).toContain('Implicit CRM');
      expect(prompt).toMatch(/status:\s*"in_progress"/);
      expect(prompt).toMatch(/status:\s*"completed"/);
      expect(prompt).toContain('#health');
      expect(prompt).toContain('Health flags:');
    });

    it('surfaces health flags in the Daily tags step detail on the skip path', async () => {
      readMock.mockReturnValue('# Journal\n- #health sore shoulder from yesterday');
      askMock.mockResolvedValue({
        text: 'No JSON updates needed. Nothing tagged for JSON stores.\n\nHealth flags: sore shoulder from yesterday',
        error: null,
      });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('skipped');
      expect(step.detail).toContain('sore shoulder');
    });

    it('routes to daily-content-updater when analysis targets a markdown content file', async () => {
      readMock.mockReturnValue('# Journal\n- 11:30 #idea AI estate planning service');
      askMock.mockResolvedValue({
        text: '**#idea** → projects/ideas.md\n- Title: AI Estate Planning Service\n- Description: AI generates estate plans, $50-100 per plan.\n- Source: [[2026_04_11]]',
        error: null,
      });
      agentMock.mockResolvedValue({ text: 'Appended', error: null });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('success');
      // daily-content-updater was invoked; json-updater was NOT
      expect(agentMock).toHaveBeenCalledWith('daily-content-updater', expect.stringContaining('#idea'), undefined, false);
      const jsonCalls = agentMock.mock.calls.filter((c) => c[0] === 'json-updater');
      expect(jsonCalls).toHaveLength(0);
      expect(step.detail).toContain('daily-content-updater');
    });

    it('routes to both json-updater and daily-content-updater when analysis mentions both target types', async () => {
      readMock.mockReturnValue('# Journal\n- 08:00 #workout 5k\n- 11:30 #idea estate planning\n- 13:00 #diet eggs');
      askMock.mockResolvedValue({
        text: '**#workout** → workouts.json\n- 5k run\n\n**#idea** → projects/ideas.md\n- Title: AI Estate Planning\n- Source: [[2026_04_11]]\n\n**#diet** → health/nutrition.md\n- Breakfast 8am: 2 eggs',
        error: null,
      });
      agentMock.mockResolvedValue({ text: 'ok', error: null });

      await executeNightly();

      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.any(String), undefined, false);
      expect(agentMock).toHaveBeenCalledWith('daily-content-updater', expect.any(String), undefined, false);
    });

    it('accepts the new "No updates needed" phrasing as well as legacy "No JSON updates needed"', async () => {
      readMock.mockReturnValue('# Journal\n- nothing tagged');
      askMock.mockResolvedValue({ text: 'No updates needed. Light day.', error: null });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('skipped');
      expect(agentMock).not.toHaveBeenCalledWith('json-updater', expect.any(String));
      expect(agentMock).not.toHaveBeenCalledWith('daily-content-updater', expect.any(String));
    });

    it('surfaces health flags in the Daily tags step detail on the success path', async () => {
      readMock.mockReturnValue('# Journal\n- #workout 5k\n- #health dull knee pain');
      askMock.mockResolvedValue({
        text: '**#workout** → health/workouts.json\n- 5k run\n\nHealth flags: dull knee pain',
        error: null,
      });
      agentMock.mockResolvedValue({ text: 'Updated', error: null });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Daily tags')!;
      expect(step.status).toBe('success');
      expect(step.detail).toContain('dull knee pain');
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
      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('pages/crm.json'), undefined, false);
      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('2026_04_11'), undefined, false);
      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('alice'), undefined, false);
      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('bob'), undefined, false);
      expect(agentMock).toHaveBeenCalledWith('json-updater', expect.stringContaining('dedup'), undefined, false);
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

    it('surfaces FUZZY match count in the step detail when json-updater flags uncertain attendees', async () => {
      readMock.mockReturnValue('# Journal\n#meeting');
      askMock.mockResolvedValue({ text: 'No updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: ['alice', 'bob'], project: null, decisions: [] },
      ]);
      // Agent reports one fuzzy match needing review
      agentMock.mockResolvedValue({
        text: 'alice: appended\nFUZZY: bob may match existing entry bob-smith ("Bob Smith") — human review needed',
        error: null,
      });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Meeting extract')!;
      expect(step.status).toBe('success');
      expect(step.detail).toContain('1 FUZZY match(es) need review');
    });

    it('includes the fuzzy-name guard rules in the CRM update prompt', async () => {
      readMock.mockReturnValue('# Journal\n#meeting');
      askMock.mockResolvedValue({ text: 'No updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: ['alice'], project: null, decisions: [] },
      ]);
      agentMock.mockResolvedValue({ text: 'alice: appended', error: null });

      await executeNightly();

      const crmCall = agentMock.mock.calls.find(
        (c) => c[0] === 'json-updater' && typeof c[1] === 'string' && c[1].includes('pages/crm.json'),
      )!;
      const prompt = crmCall[1] as string;
      expect(prompt).toContain('FUZZY:');
      expect(prompt).toContain('human review needed');
      expect(prompt).toContain('Fuzzy name match');
    });

    it('aggregates decisions from multiple meetings tagged to the same project into ONE helper call', async () => {
      // Regression guard: when N meetings share one project, the prior implementation
      // wrote N separate dated headings to the Decisions Log; they should now
      // collapse into one heading per project per day.
      readMock.mockReturnValue('# Journal\n#meeting');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });
      extractMeetingsMock.mockResolvedValue([
        { attendees: ['a'], project: 'project-x', decisions: ['d1'] },
        { attendees: ['b'], project: 'project-x', decisions: ['d2', 'd3'] },
        { attendees: ['c'], project: 'project-x', decisions: ['d4'] },
        { attendees: ['d'], project: 'project-x', decisions: ['d5', 'd6', 'd7'] },
        { attendees: ['e'], project: 'project-x', decisions: ['d8'] },
      ]);
      agentMock.mockResolvedValue({ text: 'updated', error: null });
      appendDecisionsMock.mockReturnValue({ status: 'success', appended: 8, detail: 'ok' });

      await executeNightly();

      // ONE call to the helper, not five — all decisions combined
      expect(appendDecisionsMock).toHaveBeenCalledTimes(1);
      expect(appendDecisionsMock).toHaveBeenCalledWith(
        'project-x',
        '2026-04-11',
        ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'],
      );
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

    // -- Birthday alerts step --
    it('surfaces upcoming birthdays occurring on the day AFTER today', async () => {
      // Today is 2026-04-11 (Saturday per the mocked date). Tomorrow is 04-12.
      readMock.mockImplementation((path: string) => {
        if (path === 'pages/crm.json') {
          return JSON.stringify([
            { id: 'alice', name: 'Alice', birthday: '04-12' },
            { id: 'bob', name: 'Bob', birthday: '06-01' },
            { id: 'carol', name: 'Carol', birthday: '04-12' },
          ]);
        }
        return null;
      });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Birthday alerts')!;
      expect(step.status).toBe('success');
      expect(step.detail).toContain('Alice');
      expect(step.detail).toContain('Carol');
      expect(step.detail).not.toContain('Bob');
    });

    it('skips when no birthdays match tomorrow', async () => {
      readMock.mockImplementation((path: string) => {
        if (path === 'pages/crm.json') {
          return JSON.stringify([{ id: 'alice', name: 'Alice', birthday: '09-09' }]);
        }
        return null;
      });

      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Birthday alerts')!;
      expect(step.status).toBe('skipped');
      expect(step.detail).toContain('No birthdays');
    });

    it('skips when pages/crm.json does not exist', async () => {
      readMock.mockReturnValue(null);
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Birthday alerts')!;
      expect(step.status).toBe('skipped');
      expect(step.detail).toContain('not found');
    });

    it('errors when pages/crm.json is malformed JSON', async () => {
      readMock.mockImplementation((path: string) => {
        if (path === 'pages/crm.json') return 'not valid json {';
        return null;
      });
      const result = await executeNightly();
      const step = result.steps.find((s) => s.step === 'Birthday alerts')!;
      expect(step.status).toBe('error');
      expect(step.detail).toContain('not valid JSON');
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

    it('bails out early with a single skipped step when today\'s marker is already present', async () => {
      // Early-exit gate: if the target journal already has the daily-processed marker
      // for the same date, skip the whole pipeline to avoid re-appending decisions,
      // re-running the LLM, etc. stepMarkProcessed is never reached in this path.
      readMock.mockReturnValue('# Journal\n- 10:00 entry\n\n<!-- daily-processed: 2026-04-11 -->\n');

      const result = await executeNightly();

      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]!.step).toBe('Already processed');
      expect(result.steps[0]!.status).toBe('skipped');
      expect(result.steps[0]!.detail).toContain('<!-- daily-processed: 2026-04-11 -->');
      expect(result.steps[0]!.detail).toContain('--force');
      // No downstream work done
      expect(captureMock).not.toHaveBeenCalled();
      expect(askMock).not.toHaveBeenCalled();
      expect(agentMock).not.toHaveBeenCalled();
      expect(extractMeetingsMock).not.toHaveBeenCalled();
      expect(queueMock).not.toHaveBeenCalled();
      expect(enqueueMock).not.toHaveBeenCalled();
      expect(writeMock).not.toHaveBeenCalled();
      expect(gitMock).not.toHaveBeenCalled();
    });

    it('honors options.force to re-run a date whose marker is already present', async () => {
      readMock.mockReturnValue('# Journal\n- 10:00 entry\n\n<!-- daily-processed: 2026-04-11 -->\n');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });

      const result = await executeNightly(undefined, { force: true });

      // Full pipeline ran
      expect(result.steps).toHaveLength(14);
      expect(result.steps[0]!.step).toBe('Session capture');
      expect(captureMock).toHaveBeenCalled();
      // Mark processed still skips its own append because the marker is already in the file
      const markStep = result.steps.find((s) => s.step === 'Mark processed')!;
      expect(markStep.status).toBe('skipped');
      expect(markStep.detail).toContain('already present');
    });

    it('applies the early-exit gate to backfill runs too (targetDate matches marker)', async () => {
      readMock.mockReturnValue('# Journal for 2026-04-17\n\n<!-- daily-processed: 2026-04-17 -->\n');

      const result = await executeNightly('2026-04-17');

      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]!.step).toBe('Already processed');
      expect(result.steps[0]!.detail).toContain('2026-04-17');
      expect(captureMock).not.toHaveBeenCalled();
    });

    it('does NOT early-exit when the marker belongs to a different date', async () => {
      // Journal carries yesterday's marker (e.g. a backfill scenario where the writer
      // previously processed the file under the wrong date). Today's marker is absent,
      // so the gate doesn't fire and the pipeline runs normally.
      readMock.mockReturnValue('# Journal\n- 10:00 entry\n\n<!-- daily-processed: 2026-04-10 -->\n');
      askMock.mockResolvedValue({ text: 'No JSON updates needed.', error: null });

      const result = await executeNightly();

      expect(result.steps).toHaveLength(14);
      expect(captureMock).toHaveBeenCalled();
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
      expect(result.steps).toHaveLength(14);
      expect(result.steps[0]!.status).toBe('error');
      // Remaining steps still ran
      expect(result.steps[1]!.step).toBe('Daily tags');
      expect(queueMock).toHaveBeenCalled();
    });

    it('continues when KB queue throws', async () => {
      queueMock.mockRejectedValue(new Error('queue exploded'));

      const result = await executeNightly();
      expect(result.steps).toHaveLength(14);
      // Registry rebuild (inserted between Playbook extract and Journal-intent
      // producer) shifts KB queue from index 8 → 9. Order ahead of it: Session
      // capture, Daily tags, Birthday alerts, Playbook extract, Registry rebuild,
      // Journal-intent producer, Journal ingest, Meeting extract, Library sync.
      expect(result.steps[9]!.step).toBe('KB queue');
      expect(result.steps[9]!.status).toBe('error');
      // Whoop activity still ran after it
      expect(result.steps[10]!.step).toBe('Whoop activity');
    });

    it('continues when journal read throws', async () => {
      readMock.mockImplementation(() => { throw new Error('fs error'); });

      const result = await executeNightly();
      expect(result.steps).toHaveLength(14);
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
      // Mark processed is last (index 13 after the Registry rebuild step was
      // inserted; it shifts the tail down by one more).
      expect(result.steps[13]!.step).toBe('Mark processed');
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
    function mockBus() { return { publish: vi.fn() } as any; }

    it('publishes summary message on success', async () => {
      const bus = mockBus();

      await runNightly(bus);

      expect(bus.publish).toHaveBeenCalledTimes(1);
      const { text } = bus.publish.mock.calls[0][0] as { kind: string; userId: number; text: string };
      expect(text).toContain('Nightly complete');
    });

    it('publishes summary with Final commit error step when final git commit fails', async () => {
      // Git failure is captured as a step by safeFinalCommit, not thrown out
      // of executeNightly. The structured summary is still delivered.
      gitMock.mockImplementation(() => { throw new Error('total failure'); });

      const bus = mockBus();
      await runNightly(bus);

      expect(bus.publish).toHaveBeenCalledOnce();
      const { text } = bus.publish.mock.calls[0][0] as { kind: string; userId: number; text: string };
      expect(text).toContain('Nightly complete');
      expect(text).toContain('Final commit');
      expect(text).toContain('total failure');
    });

    it('does not throw when final git commit fails', async () => {
      gitMock.mockImplementation(() => { throw new Error('git broke'); });
      const bus = mockBus();

      await expect(runNightly(bus)).resolves.toBeUndefined();
    });

    it('includes step status icons in summary message', async () => {
      captureMock.mockResolvedValue({ captured: 1 });
      gitMock.mockReturnValue(undefined);
      const bus = mockBus();

      await runNightly(bus);

      const { text } = bus.publish.mock.calls[0][0] as { kind: string; userId: number; text: string };
      expect(text).toContain('[+]'); // success icon
      expect(text).toContain('[-]'); // skipped icon
    });
  });
});
