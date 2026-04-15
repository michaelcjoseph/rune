import type TelegramBot from 'node-telegram-bot-api';
import { getAccessToken, fetchSleep, fetchRecovery, fetchCycles, fetchWorkouts, isConfigured } from '../integrations/whoop/client.js';
import { readVaultFile, writeVaultFile } from '../vault/files.js';
import { gitCommitAndPush } from '../vault/git.js';
import { getYesterdayDate, getTodayDate } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';
import config from '../config.js';
import type { WhoopDailyData, WhoopSleep, WhoopRecoveryRecord, WhoopCycle, WhoopWorkout } from '../integrations/whoop/types.js';

const log = createLogger('whoop-sync');

function dataFilePath(date: string): string {
  return `health/whoop/${date}.json`;
}

function readDailyData(date: string): WhoopDailyData {
  const content = readVaultFile(dataFilePath(date));
  if (content) {
    try {
      return JSON.parse(content) as WhoopDailyData;
    } catch {
      // Corrupt file — start fresh
    }
  }
  return { date };
}

function writeDailyData(data: WhoopDailyData): void {
  writeVaultFile(dataFilePath(data.date), JSON.stringify(data, null, 2));
}

function transformSleep(sleep: WhoopSleep): WhoopDailyData['sleep'] {
  const s = sleep.score.stage_summary;
  const totalSleepMs = s.total_in_bed_time_milli - s.total_awake_time_milli;
  const totalSleepHours = totalSleepMs / 3_600_000;
  return {
    duration_hours: Math.round(totalSleepHours * 100) / 100,
    performance: sleep.score.sleep_performance_percentage,
    efficiency: sleep.score.sleep_efficiency_percentage,
    rem_pct: totalSleepMs > 0 ? Math.round((s.total_rem_sleep_time_milli / totalSleepMs) * 100) : 0,
    deep_pct: totalSleepMs > 0 ? Math.round((s.total_slow_wave_sleep_time_milli / totalSleepMs) * 100) : 0,
    respiratory_rate: sleep.score.respiratory_rate,
    disturbances: s.disturbance_count,
  };
}

function transformRecovery(rec: WhoopRecoveryRecord): WhoopDailyData['recovery'] {
  return {
    score: rec.score.recovery_score,
    hrv: Math.round(rec.score.hrv_rmssd_milli * 100) / 100,
    resting_hr: rec.score.resting_heart_rate,
    spo2: rec.score.spo2_percentage,
  };
}

function transformStrain(cycle: WhoopCycle): WhoopDailyData['strain'] {
  return {
    score: Math.round(cycle.score.strain * 10) / 10,
    calories: Math.round(cycle.score.kilojoule / 4.184),
    avg_hr: cycle.score.average_heart_rate,
    max_hr: cycle.score.max_heart_rate,
  };
}

function transformWorkout(w: WhoopWorkout): NonNullable<WhoopDailyData['workouts']>[number] {
  const durationMs = new Date(w.end).getTime() - new Date(w.start).getTime();
  return {
    sport_id: w.sport_id,
    duration_min: Math.round(durationMs / 60_000),
    strain: Math.round(w.score.strain * 10) / 10,
    calories: Math.round(w.score.kilojoule / 4.184),
    avg_hr: w.score.average_heart_rate,
    max_hr: w.score.max_heart_rate,
  };
}

// --- Sleep Sync (8am) ---

interface WhoopSyncResult {
  status: 'synced' | 'skipped' | 'error';
  date?: string;
  detail?: string;
}

export async function executeSleepSync(): Promise<WhoopSyncResult> {
  if (!isConfigured()) {
    return { status: 'skipped', detail: 'Whoop not configured' };
  }

  const token = await getAccessToken();
  if (!token) {
    return { status: 'error', detail: 'No valid access token' };
  }

  const date = getYesterdayDate();
  log.info('Syncing sleep data', { date });

  const [sleepRecords, recoveryRecords] = await Promise.all([
    fetchSleep(token, date, date),
    fetchRecovery(token, date, date),
  ]);

  const sleep = sleepRecords[0];
  const recovery = recoveryRecords[0];

  if (!sleep && !recovery) {
    return { status: 'skipped', date, detail: 'No sleep/recovery data available' };
  }

  const data = readDailyData(date);
  if (sleep) data.sleep = transformSleep(sleep);
  if (recovery) data.recovery = transformRecovery(recovery);
  writeDailyData(data);

  try { generateTrends(); } catch (err) { log.error('Trends generation failed', { error: String(err) }); }
  await gitCommitAndPush(`Whoop sleep sync: ${date}`);

  const parts: string[] = [];
  if (data.sleep) parts.push(`Sleep: ${data.sleep.duration_hours}h (${data.sleep.performance}%)`);
  if (data.recovery) parts.push(`Recovery: ${data.recovery.score}% | HRV: ${data.recovery.hrv}ms`);

  return { status: 'synced', date, detail: parts.join(' | ') };
}

export async function runWhoopSleepSync(bot: TelegramBot): Promise<void> {
  try {
    const result = await executeSleepSync();
    if (result.status === 'synced' && result.detail) {
      await bot.sendMessage(config.TELEGRAM_USER_ID, `Whoop: ${result.detail}`);
    }
  } catch (err) {
    log.error('Sleep sync failed', { error: String(err) });
  }
}

// --- Activity Sync (nightly) ---

export async function executeActivitySync(): Promise<WhoopSyncResult> {
  if (!isConfigured()) {
    return { status: 'skipped', detail: 'Whoop not configured' };
  }

  const token = await getAccessToken();
  if (!token) {
    return { status: 'error', detail: 'No valid access token' };
  }

  const date = getTodayDate();
  log.info('Syncing activity data', { date });

  const [cycles, workouts] = await Promise.all([
    fetchCycles(token, date, date),
    fetchWorkouts(token, date, date),
  ]);

  const cycle = cycles[0];

  if (!cycle && workouts.length === 0) {
    return { status: 'skipped', detail: 'No strain/workout data available' };
  }

  const data = readDailyData(date);
  if (cycle) data.strain = transformStrain(cycle);
  if (workouts.length > 0) data.workouts = workouts.map(transformWorkout);
  writeDailyData(data);

  try { generateTrends(); } catch (err) { log.error('Trends generation failed', { error: String(err) }); }

  return { status: 'synced', detail: `Strain: ${data.strain?.score ?? 'N/A'}` };
}

// --- Trends Generation ---

function generateTrends(): void {
  const todayStr = getTodayDate();
  const [y, m, d] = todayStr.split('-').map(Number);
  const days: WhoopDailyData[] = [];

  for (let i = 0; i < 30; i++) {
    const date = new Date(y, m - 1, d - i);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const content = readVaultFile(dataFilePath(dateStr));
    if (content) {
      try {
        days.push(JSON.parse(content) as WhoopDailyData);
      } catch {
        // Skip corrupt files
      }
    }
  }

  if (days.length === 0) {
    log.info('No Whoop data for trends');
    return;
  }

  const avg = (values: number[]): string => {
    if (values.length === 0) return 'N/A';
    return (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
  };

  const compute = (window: number) => {
    const subset = days.slice(0, window);
    return {
      sleepHours: avg(subset.filter((d) => d.sleep).map((d) => d.sleep!.duration_hours)),
      sleepPerf: avg(subset.filter((d) => d.sleep).map((d) => d.sleep!.performance)),
      recovery: avg(subset.filter((d) => d.recovery).map((d) => d.recovery!.score)),
      hrv: avg(subset.filter((d) => d.recovery).map((d) => d.recovery!.hrv)),
      strain: avg(subset.filter((d) => d.strain).map((d) => d.strain!.score)),
    };
  };

  const week = compute(7);
  const month = compute(30);

  const lines = [
    '# Whoop Trends',
    '',
    `Updated: ${todayStr}`,
    `Data points: ${days.length} days`,
    '',
    '## 7-Day Averages',
    '',
    `| Metric | Average |`,
    `|---|---|`,
    `| Sleep | ${week.sleepHours}h |`,
    `| Sleep Performance | ${week.sleepPerf}% |`,
    `| Recovery | ${week.recovery}% |`,
    `| HRV | ${week.hrv}ms |`,
    `| Strain | ${week.strain} |`,
    '',
    '## 30-Day Averages',
    '',
    `| Metric | Average |`,
    `|---|---|`,
    `| Sleep | ${month.sleepHours}h |`,
    `| Sleep Performance | ${month.sleepPerf}% |`,
    `| Recovery | ${month.recovery}% |`,
    `| HRV | ${month.hrv}ms |`,
    `| Strain | ${month.strain} |`,
  ];

  writeVaultFile('health/whoop/trends.md', lines.join('\n'));
  log.info('Trends updated', { dataPoints: days.length });
}
