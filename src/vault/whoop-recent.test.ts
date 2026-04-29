import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = join(tmpdir(), `jarvis-whoop-recent-test-${Date.now()}`);
const WHOOP_DIR = join(tmpDir, 'health/whoop');
mkdirSync(WHOOP_DIR, { recursive: true });

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

vi.mock('../config.js', () => ({
  default: { VAULT_DIR: tmpDir },
}));

const { readRecentWhoopDays } = await import('./whoop-recent.js');

function resetWhoopDir() {
  rmSync(WHOOP_DIR, { recursive: true, force: true });
  mkdirSync(WHOOP_DIR, { recursive: true });
}

function writeDay(filename: string, data: object) {
  writeFileSync(join(WHOOP_DIR, filename), JSON.stringify(data), 'utf8');
}

function writeRaw(filename: string, content: string) {
  writeFileSync(join(WHOOP_DIR, filename), content, 'utf8');
}

const DAY_2026_04_25 = {
  date: '2026-04-25',
  sleep: { duration_hours: 7.5, performance: 85, efficiency: 92, rem_pct: 20, deep_pct: 18, respiratory_rate: 15.2, disturbances: 4 },
  recovery: { score: 68, hrv: 48, resting_hr: 58, spo2: 97 },
};

const DAY_2026_04_26 = {
  date: '2026-04-26',
  sleep: { duration_hours: 6.8, performance: 72, efficiency: 88, rem_pct: 18, deep_pct: 15, respiratory_rate: 14.9, disturbances: 6 },
  recovery: { score: 55, hrv: 40, resting_hr: 62, spo2: 96 },
};

const DAY_2026_04_27 = {
  date: '2026-04-27',
  sleep: { duration_hours: 8.1, performance: 90, efficiency: 95, rem_pct: 22, deep_pct: 20, respiratory_rate: 14.5, disturbances: 2 },
  recovery: { score: 82, hrv: 60, resting_hr: 55, spo2: 98 },
};

describe('vault/whoop-recent', () => {
  beforeEach(() => {
    resetWhoopDir();
  });

  describe('happy path', () => {
    it('returns the 3 most recent days in descending order', () => {
      writeDay('2026-04-25.json', DAY_2026_04_25);
      writeDay('2026-04-26.json', DAY_2026_04_26);
      writeDay('2026-04-27.json', DAY_2026_04_27);

      const result = readRecentWhoopDays(3);

      expect(result).toHaveLength(3);
      expect(result[0]!.date).toBe('2026-04-27');
      expect(result[1]!.date).toBe('2026-04-26');
      expect(result[2]!.date).toBe('2026-04-25');
    });

    it('returns full parsed objects matching WhoopDailyData shape', () => {
      writeDay('2026-04-27.json', DAY_2026_04_27);

      const result = readRecentWhoopDays(1);

      expect(result[0]).toMatchObject({ date: '2026-04-27' });
      expect(result[0]!.sleep?.performance).toBe(90);
      expect(result[0]!.recovery?.score).toBe(82);
    });
  });

  describe('missing directory', () => {
    it('returns [] when health/whoop directory does not exist', () => {
      rmSync(WHOOP_DIR, { recursive: true, force: true });
      expect(readRecentWhoopDays(3)).toEqual([]);
    });
  });

  describe('empty directory', () => {
    it('returns [] when directory exists but contains no files', () => {
      expect(readRecentWhoopDays(3)).toEqual([]);
    });
  });

  describe('fewer than n available', () => {
    it('returns all available days without padding when n > file count', () => {
      writeDay('2026-04-25.json', DAY_2026_04_25);
      writeDay('2026-04-26.json', DAY_2026_04_26);
      writeDay('2026-04-27.json', DAY_2026_04_27);

      const result = readRecentWhoopDays(10);

      expect(result).toHaveLength(3);
      expect(result[0]!.date).toBe('2026-04-27');
    });
  });

  describe('filename filtering', () => {
    it('excludes files that do not match YYYY-MM-DD.json pattern', () => {
      writeDay('2026-04-25.json', DAY_2026_04_25);
      writeDay('2026-04-26.json', DAY_2026_04_26);
      writeDay('2026-04-27.json', DAY_2026_04_27);
      writeRaw('trends.md', '# Trends');
      writeRaw('random.json', '{"not":"a day"}');
      writeRaw('2026-01.json', '{"date":"2026-01"}');

      const result = readRecentWhoopDays(10);

      expect(result).toHaveLength(3);
      expect(result.map((d) => d.date)).toEqual(['2026-04-27', '2026-04-26', '2026-04-25']);
    });
  });

  describe('unparseable JSON', () => {
    it('skips corrupt files without throwing, returning valid neighbors', () => {
      writeDay('2026-04-25.json', DAY_2026_04_25);
      writeDay('2026-04-26.json', DAY_2026_04_26);
      writeDay('2026-04-27.json', DAY_2026_04_27);
      writeRaw('2026-04-28.json', '{this is not valid json');

      const result = readRecentWhoopDays(10);

      expect(result).toHaveLength(3);
      expect(result.map((d) => d.date)).toEqual(['2026-04-27', '2026-04-26', '2026-04-25']);
    });

    it('does not throw even when all files are corrupt', () => {
      writeRaw('2026-04-25.json', 'not json');
      writeRaw('2026-04-26.json', 'not json');
      writeRaw('2026-04-27.json', 'not json');

      expect(() => readRecentWhoopDays(3)).not.toThrow();
      expect(readRecentWhoopDays(3)).toEqual([]);
    });
  });

  describe('missing date field', () => {
    it('skips files that parse but lack a string date field', () => {
      writeDay('2026-04-25.json', DAY_2026_04_25);
      writeDay('2026-04-26.json', { sleep: DAY_2026_04_26.sleep });

      const result = readRecentWhoopDays(10);

      expect(result).toHaveLength(1);
      expect(result[0]!.date).toBe('2026-04-25');
    });
  });

  describe('n=0 edge case', () => {
    it('returns [] immediately when n=0', () => {
      writeDay('2026-04-25.json', DAY_2026_04_25);
      expect(readRecentWhoopDays(0)).toEqual([]);
    });

    it('returns [] for negative n', () => {
      expect(readRecentWhoopDays(-5)).toEqual([]);
    });
  });
});
