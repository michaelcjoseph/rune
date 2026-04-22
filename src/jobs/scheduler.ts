import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import cron, { type ScheduledTask } from 'node-cron';
import type TelegramBot from 'node-telegram-bot-api';
import config, { PROJECT_ROOT } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { clearAgentDefCache, loadAgentDef, runAgent } from '../ai/claude.js';
import { sendLongMessage } from '../integrations/telegram/client.js';
import { runMorningPrep } from './morning-prep.js';
import { runNightly } from './nightly.js';
import { runWeeklyNudge, runReviewNudge } from './nudges.js';
import { runWhoopSleepSync } from './whoop-sync.js';

const log = createLogger('scheduler');

const tasks: ScheduledTask[] = [];
const running = new Set<string>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastHeartbeat = Date.now();

const STATE_FILE = join(config.LOGS_DIR, 'scheduler-state.json');
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SLEEP_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes — if heartbeat gap exceeds this, assume sleep

interface JobDefinition {
  name: string;
  schedule: string;
  handler: () => void;
  run: () => Promise<void>;
}

type SchedulerState = Record<string, number>; // job name → last successful run (epoch ms)

function loadState(): SchedulerState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as SchedulerState;
  } catch {
    return {};
  }
}

function saveState(state: SchedulerState): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log.error('Failed to save scheduler state', { error: String(err) });
  }
}

export function recordJobRun(name: string): void {
  const state = loadState();
  state[name] = Date.now();
  saveState(state);
}

function guarded(name: string, fn: () => Promise<void>): () => void {
  return () => {
    if (running.has(name)) {
      log.warn(`Skipping ${name}: previous run still in progress`);
      return;
    }
    running.add(name);
    void fn()
      .then(() => recordJobRun(name))
      .finally(() => running.delete(name));
  };
}

/**
 * Parse a cron expression and determine the most recent time it should have fired
 * before `now`, looking back up to `maxLookbackMs`.
 */
function getLastScheduledTime(cronExpr: string, now: Date, maxLookbackMs: number): Date | null {
  // Parse cron fields: minute hour day-of-month month day-of-week
  const parts = cronExpr.split(/\s+/);
  if (parts.length !== 5) return null;

  const [minuteField, hourField, domField, monthField, dowField] = parts as [string, string, string, string, string];

  const parseField = (field: string, max: number): number[] => {
    if (field === '*') return Array.from({ length: max + 1 }, (_, i) => i);
    const values: number[] = [];
    for (const part of field.split(',')) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(Number) as [number, number];
        for (let i = start; i <= end; i++) values.push(i);
      } else {
        values.push(Number(part));
      }
    }
    return values;
  };

  const minutes = parseField(minuteField, 59);
  const hours = parseField(hourField, 23);
  const doms = parseField(domField, 31);
  const months = parseField(monthField, 12);
  const dows = parseField(dowField, 7).map(d => d % 7); // normalize 7 → 0

  const earliest = now.getTime() - maxLookbackMs;

  // Walk backwards from now, minute by minute would be too slow.
  // Instead, check each candidate day going back, then match hour/minute.
  const tzDate = (d: Date) => new Date(d.toLocaleString('en-US', { timeZone: config.TIMEZONE }));

  for (let dayOffset = 0; dayOffset <= Math.ceil(maxLookbackMs / 86_400_000) + 1; dayOffset++) {
    const candidate = new Date(now.getTime() - dayOffset * 86_400_000);
    const local = tzDate(candidate);
    const localMonth = local.getMonth() + 1;
    const localDom = local.getDate();
    const localDow = local.getDay();

    if (!months.includes(localMonth)) continue;

    // Cron uses OR logic for dom/dow when both are specified (non-*)
    const domMatch = domField === '*' || doms.includes(localDom);
    const dowMatch = dowField === '*' || dows.includes(localDow);
    if (domField !== '*' && dowField !== '*') {
      if (!domMatch && !dowMatch) continue;
    } else {
      if (!domMatch || !dowMatch) continue;
    }

    // Check hours (descending) and minutes (descending) for latest match
    const sortedHours = [...hours].sort((a, b) => b - a);
    const sortedMinutes = [...minutes].sort((a, b) => b - a);

    for (const h of sortedHours) {
      for (const m of sortedMinutes) {
        // Build a Date in the target timezone
        const dateStr = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
        // Parse in Chicago timezone by computing offset
        const scheduled = cronToDate(dateStr, config.TIMEZONE);

        if (scheduled.getTime() > now.getTime()) continue;
        if (scheduled.getTime() < earliest) return null;

        return scheduled;
      }
    }
  }

  return null;
}

/** Convert a "YYYY-MM-DDTHH:mm:ss" string in the given timezone to a UTC Date. */
function cronToDate(localStr: string, tz: string): Date {
  // Use a formatter to find the UTC offset for this local time
  const naive = new Date(localStr + 'Z'); // treat as UTC temporarily
  // Binary-search approach: find the Date whose tz representation matches localStr
  // Simple approach: use Intl to get the offset
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  // Try naive ± 24h to find the right offset
  for (const offset of [0, -3600000, 3600000, -7200000, 7200000]) {
    const test = new Date(naive.getTime() + offset);
    const parts = formatter.formatToParts(test);
    const get = (type: string) => parts.find(p => p.type === type)!.value;
    const formatted = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
    if (formatted === localStr) return test;
  }

  return naive; // fallback
}

const MAX_CATCHUP_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

function checkMissedJobs(jobs: JobDefinition[]): void {
  const state = loadState();
  const now = new Date();

  for (const job of jobs) {
    const lastRun = state[job.name] ?? 0;
    const lastScheduled = getLastScheduledTime(job.schedule, now, MAX_CATCHUP_LOOKBACK_MS);

    if (!lastScheduled) continue;

    // If the last scheduled time is after the last run, the job was missed
    if (lastScheduled.getTime() > lastRun) {
      const missedAgo = Math.round((now.getTime() - lastScheduled.getTime()) / 60_000);
      log.info(`Catching up missed job: ${job.name}`, {
        scheduledAt: lastScheduled.toISOString(),
        missedMinutesAgo: missedAgo,
        lastRun: lastRun ? new Date(lastRun).toISOString() : 'never',
      });
      job.handler();
    }
  }
}

/** Scan `.claude/agents/` (Jarvis first, vault fallback) for agent files that
 *  declare a `cron:` frontmatter field. Returns a JobDefinition per agent whose
 *  handler calls runAgent(name, cron_args) and routes output per cron_chat.
 *  Invalid cron expressions are logged and skipped (no crash). */
export function scanAgentCronJobs(bot: TelegramBot): JobDefinition[] {
  // Evict cached defs so frontmatter edits (cron, cron_args, cron_chat,
  // triggers) take effect on a scheduler stop/start cycle. Agent files are
  // re-read on the next loadAgentDef call below.
  clearAgentDefCache();

  const seen = new Set<string>();
  const agentNames: string[] = [];

  // Jarvis-first precedence matches loadAgentDef: project dir wins over vault.
  for (const dir of [join(PROJECT_ROOT, '.claude', 'agents'), join(config.VAULT_DIR, '.claude', 'agents')]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Failed to scan agents dir ${dir}`, { error: (err as Error).message });
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const name = entry.slice(0, -'.md'.length);
      if (seen.has(name)) continue;
      seen.add(name);
      agentNames.push(name);
    }
  }

  const jobs: JobDefinition[] = [];
  for (const name of agentNames) {
    let def;
    try {
      def = loadAgentDef(name);
    } catch (err) {
      log.warn(`Could not load agent def for cron scan: ${name}`, { error: (err as Error).message });
      continue;
    }
    if (!def.cron) continue;
    if (!cron.validate(def.cron)) {
      log.error(`Invalid cron expression for agent ${name}; skipping registration`, {
        expression: def.cron,
      });
      continue;
    }
    // Enforce 5-field cron — node-cron's validate also accepts 6-field (seconds)
    // expressions, but getLastScheduledTime only supports 5-field, so 6-field
    // jobs would silently miss catchup on restart/wake.
    if (def.cron.trim().split(/\s+/).length !== 5) {
      log.error(
        `Agent ${name} cron must be a 5-field expression (seconds precision not supported); skipping`,
        { expression: def.cron },
      );
      continue;
    }

    const jobName = `agent:${name}`;
    const cronArgs = def.cronArgs ?? '';
    const cronChat = def.cronChat === true;
    const run = async () => {
      const result = await runAgent(name, cronArgs);
      if (result.error) {
        log.error(`Scheduled agent ${name} failed`, { error: result.error });
        return;
      }
      const text = result.text?.trim() ?? '';
      if (text.length === 0) {
        // Successful run with empty output. For cronChat agents this is
        // surprising (user expects a post); warn so silent runs are auditable.
        const level = cronChat ? 'warn' : 'info';
        log[level](`Scheduled agent ${name} completed with empty output`, { cronChat });
        return;
      }
      if (cronChat) {
        try {
          await sendLongMessage(bot, config.TELEGRAM_USER_ID, text);
        } catch (err) {
          log.error(`Failed to post ${name} output to Telegram`, { error: (err as Error).message });
        }
      } else {
        log.info(`Scheduled agent ${name} completed`, { chars: text.length });
      }
    };
    jobs.push({
      name: jobName,
      schedule: def.cron,
      run,
      handler: guarded(jobName, run),
    });
  }
  return jobs;
}

function registerJobs(bot: TelegramBot): JobDefinition[] {
  return [
    {
      name: 'morning-prep',
      schedule: '30 5 * * *', // 5:30 AM daily
      run: () => runMorningPrep(bot),
      handler: guarded('morning-prep', () => runMorningPrep(bot)),
    },
    {
      name: 'nightly',
      schedule: '30 23 * * *', // 11:30 PM daily
      run: () => runNightly(bot),
      handler: guarded('nightly', () => runNightly(bot)),
    },
    {
      name: 'whoop-sleep',
      schedule: '0 8 * * *', // 8:00 AM daily
      run: () => runWhoopSleepSync(bot),
      handler: guarded('whoop-sleep', () => runWhoopSleepSync(bot)),
    },
    {
      name: 'weekly-nudge',
      schedule: '0 15 * * 5', // Friday 3 PM
      run: () => runWeeklyNudge(bot),
      handler: guarded('weekly-nudge', () => runWeeklyNudge(bot)),
    },
    {
      name: 'review-nudge',
      schedule: '0 15 28-31 * *', // Last days of month, 3 PM — Phase 7 adds last-day check
      run: () => runReviewNudge(bot),
      handler: guarded('review-nudge', () => runReviewNudge(bot)),
    },
  ];
}

// Keep a reference to the registered jobs so the heartbeat can access them
let registeredJobs: JobDefinition[] = [];

export function startScheduler(bot: TelegramBot): void {
  if (tasks.length > 0) {
    stopScheduler();
  }

  const jobs = [...registerJobs(bot), ...scanAgentCronJobs(bot)];
  registeredJobs = jobs;

  for (const job of jobs) {
    const task = cron.schedule(job.schedule, job.handler, {
      timezone: config.TIMEZONE,
    });
    tasks.push(task);
    log.info(`Registered cron job: ${job.name}`, { schedule: job.schedule, timezone: config.TIMEZONE });
  }

  // Check for missed jobs on startup
  checkMissedJobs(jobs);

  // Start heartbeat to detect sleep/wake
  lastHeartbeat = Date.now();
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const gap = now - lastHeartbeat;
    lastHeartbeat = now;

    if (gap > SLEEP_THRESHOLD_MS) {
      const gapMinutes = Math.round(gap / 60_000);
      log.info(`Detected system wake after ~${gapMinutes}min sleep, checking for missed jobs`);
      checkMissedJobs(registeredJobs);
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref(); // don't prevent process exit

  log.info(`Scheduler started with ${jobs.length} job(s)`);
}

export function stopScheduler(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const task of tasks) {
    task.stop();
  }
  log.info(`Scheduler stopped (${tasks.length} job(s))`);
  tasks.length = 0;
  registeredJobs = [];
}
