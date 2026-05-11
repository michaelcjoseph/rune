import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Tests for the `withNoSleep` wrapper introduced in the diff.
 *
 * `withNoSleep` is a private function but its effects are observable through
 * `runNightly`: on darwin it spawns `caffeinate -is` before the body runs and
 * kills it after (even on error); on non-darwin it is a no-op pass-through.
 *
 * Because the module-level `platform()` call happens at call-time (not import
 * time), we can control the platform by mocking `node:os` before the module
 * loads. The `spawn` mock lets us assert on caffeinate lifecycle.
 */

// ── Mock node:os to control platform detection ────────────────────────────────
const mockPlatform = vi.fn<() => NodeJS.Platform>(() => 'darwin');
vi.mock('node:os', () => ({ platform: mockPlatform }));

// ── Mock node:child_process so caffeinate is never actually spawned ───────────
const mockKill = vi.fn();
function makeFakeCaffeinate() {
  const child = new EventEmitter() as any;
  child.kill = mockKill;
  child.pid = 99999;
  child.stdout = null;
  child.stderr = null;
  return child;
}

const mockSpawn = vi.fn(() => makeFakeCaffeinate());
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

// ── Shared module mocks (mirrors nightly.test.ts) ────────────────────────────
vi.mock('../config.js', () => ({
  default: { VAULT_DIR: '/test/vault', TIMEZONE: 'America/Chicago', TELEGRAM_USER_ID: 12345 },
}));
vi.mock('./capture.js', () => ({ captureSessions: vi.fn() }));
vi.mock('./whoop-sync.js', () => ({ executeActivitySync: vi.fn() }));
vi.mock('./playbook-extract.js', () => ({ extractPlaybookDrafts: vi.fn() }));
vi.mock('./meeting-extract.js', () => ({
  extractMeetings: vi.fn(),
  appendProjectDecisions: vi.fn(),
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
  getTodayDate: vi.fn(),
  getTodayFilename: vi.fn(),
  getDayOfWeek: vi.fn(),
}));

// ── Dynamic import after all mocks ───────────────────────────────────────────
const { runNightly } = await import('./nightly.js');
const { gitCommitAndPush } = await import('../vault/git.js');
const { captureSessions } = await import('./capture.js');
const { executeActivitySync } = await import('./whoop-sync.js');
const { extractPlaybookDrafts } = await import('./playbook-extract.js');
const { extractMeetings, appendProjectDecisions } = await import('./meeting-extract.js');
const { processIngestionQueue, lintKB } = await import('../kb/engine.js');
const { askClaudeOneShot, runAgent } = await import('../ai/claude.js');
const { readVaultFile } = await import('../vault/files.js');
const { getTodayDate, getTodayFilename, getDayOfWeek } = await import('../utils/time.js');

const gitMock = gitCommitAndPush as unknown as ReturnType<typeof vi.fn>;
const captureMock = captureSessions as unknown as ReturnType<typeof vi.fn>;
const activityMock = executeActivitySync as unknown as ReturnType<typeof vi.fn>;
const playbookMock = extractPlaybookDrafts as unknown as ReturnType<typeof vi.fn>;
const meetingsMock = extractMeetings as unknown as ReturnType<typeof vi.fn>;
const decisionsMock = appendProjectDecisions as unknown as ReturnType<typeof vi.fn>;
const queueMock = processIngestionQueue as unknown as ReturnType<typeof vi.fn>;
const lintMock = lintKB as unknown as ReturnType<typeof vi.fn>;
const askMock = askClaudeOneShot as unknown as ReturnType<typeof vi.fn>;
const agentMock = runAgent as unknown as ReturnType<typeof vi.fn>;
const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;
const dayMock = getDayOfWeek as unknown as ReturnType<typeof vi.fn>;
const todayDateMock = getTodayDate as unknown as ReturnType<typeof vi.fn>;
const todayFilenameMock = getTodayFilename as unknown as ReturnType<typeof vi.fn>;

function makeBus() {
  return { publish: vi.fn() } as any;
}

/** Restore all defaults so each test starts clean without bleed-through. */
function setDefaults() {
  mockPlatform.mockReturnValue('darwin');
  mockSpawn.mockImplementation(() => makeFakeCaffeinate());
  gitMock.mockResolvedValue(undefined);
  captureMock.mockResolvedValue({ captured: 0 });
  activityMock.mockReturnValue({ status: 'skipped', detail: 'Whoop not configured' });
  playbookMock.mockReturnValue({ status: 'skipped', detail: 'No #playbook tag' });
  meetingsMock.mockResolvedValue([]);
  decisionsMock.mockReturnValue({ status: 'skipped', appended: 0, detail: 'no decisions' });
  queueMock.mockResolvedValue({ processed: 0, errors: 0, created: 0, updated: 0 });
  lintMock.mockResolvedValue({ success: true, report: 'ok' });
  askMock.mockResolvedValue({ text: 'No updates needed.', error: null });
  agentMock.mockResolvedValue({ text: null, error: null });
  readMock.mockReturnValue(null);
  dayMock.mockReturnValue('Monday');
  todayDateMock.mockReturnValue('2026-05-11');
  todayFilenameMock.mockReturnValue('2026_05_11.md');
}

describe('jobs/nightly — withNoSleep wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaults();
  });

  describe('on darwin (caffeinate path)', () => {
    it('spawns caffeinate with -is flags before the nightly body runs', async () => {
      const bus = makeBus();
      await runNightly(bus);

      expect(mockSpawn).toHaveBeenCalledOnce();
      const [bin, args] = mockSpawn.mock.calls[0]!;
      expect(bin).toBe('caffeinate');
      expect(args).toContain('-is');
    });

    it('passes stdio: ignore to caffeinate so it does not interfere with output', async () => {
      const bus = makeBus();
      await runNightly(bus);

      const [, , spawnOpts] = mockSpawn.mock.calls[0]!;
      expect(spawnOpts.stdio).toBe('ignore');
    });

    it('kills caffeinate after successful completion', async () => {
      const bus = makeBus();
      await runNightly(bus);

      expect(mockKill).toHaveBeenCalledOnce();
    });

    it('kills caffeinate even when executeNightly throws (finally guard)', async () => {
      // Force executeNightly to throw by making the final gitCommitAndPush fail
      gitMock.mockImplementation(() => { throw new Error('git exploded'); });

      const bus = makeBus();
      await runNightly(bus);

      // caffeinate was still killed despite the error
      expect(mockKill).toHaveBeenCalledOnce();
      // bus received the error message, not a success message
      const { text } = bus.publish.mock.calls[0][0] as { text: string };
      expect(text).toContain('failed');
    });

    it('publishes the nightly summary on success (wrapper is transparent)', async () => {
      const bus = makeBus();
      await runNightly(bus);

      expect(bus.publish).toHaveBeenCalledOnce();
      const { text } = bus.publish.mock.calls[0][0] as { text: string };
      expect(text).toContain('Nightly complete');
    });

    it('propagates spawn errors — caffeinate spawn is outside the inner try/catch', async () => {
      // spawn() is called in withNoSleep BEFORE the try block that wraps fn().
      // If spawn itself throws (e.g. ENOENT), the error propagates up through
      // withNoSleep and is NOT caught by the inner try/catch in runNightly's
      // callback — so runNightly will reject. This is acceptable: caffeinate
      // ENOENT would be a config/environment error, not a runtime pipeline error.
      mockSpawn.mockImplementation(() => { throw new Error('spawn ENOENT'); });

      const bus = makeBus();
      await expect(runNightly(bus)).rejects.toThrow('spawn ENOENT');
    });
  });

  describe('on non-darwin (no-op path)', () => {
    beforeEach(() => {
      mockPlatform.mockReturnValue('linux');
    });

    it('does NOT spawn caffeinate on non-darwin', async () => {
      const bus = makeBus();
      await runNightly(bus);

      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('still executes the nightly pipeline and publishes summary', async () => {
      const bus = makeBus();
      await runNightly(bus);

      expect(bus.publish).toHaveBeenCalledOnce();
      const { text } = bus.publish.mock.calls[0][0] as { text: string };
      expect(text).toContain('Nightly complete');
    });

    it('still publishes error when pipeline throws on non-darwin', async () => {
      gitMock.mockImplementation(() => { throw new Error('git broke'); });

      const bus = makeBus();
      await runNightly(bus);

      expect(bus.publish).toHaveBeenCalledOnce();
      const { text } = bus.publish.mock.calls[0][0] as { text: string };
      expect(text).toContain('failed');
    });

    it('does not call kill (no caffeinate process was created)', async () => {
      const bus = makeBus();
      await runNightly(bus);

      expect(mockKill).not.toHaveBeenCalled();
    });
  });
});
