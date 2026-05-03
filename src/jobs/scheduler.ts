import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import cron, { type ScheduledTask } from 'node-cron';
import config, { PROJECT_ROOT } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { loadAgentDef, runAgent } from '../ai/claude.js';
import { reloadSkillRegistry } from '../bot/skill-registry.js';
import type { NotificationBus } from '../transport/notification-bus.js';
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
 * Parse a cron expression (interpreted as UTC) and determine the most recent
 * time it should have fired before `now`, looking back up to `maxLookbackMs`.
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

  for (let dayOffset = 0; dayOffset <= Math.ceil(maxLookbackMs / 86_400_000) + 1; dayOffset++) {
    const candidate = new Date(now.getTime() - dayOffset * 86_400_000);
    const utcMonth = candidate.getUTCMonth() + 1;
    const utcDom = candidate.getUTCDate();
    const utcDow = candidate.getUTCDay();

    if (!months.includes(utcMonth)) continue;

    // Cron uses OR logic for dom/dow when both are specified (non-*)
    const domMatch = domField === '*' || doms.includes(utcDom);
    const dowMatch = dowField === '*' || dows.includes(utcDow);
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
        const scheduled = new Date(Date.UTC(
          candidate.getUTCFullYear(),
          candidate.getUTCMonth(),
          candidate.getUTCDate(),
          h,
          m,
          0,
        ));

        if (scheduled.getTime() > now.getTime()) continue;
        if (scheduled.getTime() < earliest) return null;

        return scheduled;
      }
    }
  }

  return null;
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
export function scanAgentCronJobs(bus: NotificationBus): JobDefinition[] {
  // Evict cached agent defs AND the skill-registry cache so frontmatter edits
  // (cron, cron_args, cron_chat, triggers, description) take effect on a
  // scheduler stop/start cycle. Both caches derive from the same source and
  // must be refreshed together; reloadSkillRegistry() handles both.
  reloadSkillRegistry();

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
        bus.publish({ kind: 'message', userId: config.TELEGRAM_USER_ID, text });
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

// Cron schedules are in UTC. Local times (America/Chicago) are given for
// reference and assume CDT (UTC-5); in CST (UTC-6) they fire one hour earlier.
function registerJobs(bus: NotificationBus): JobDefinition[] {
  return [
    {
      name: 'morning-prep',
      schedule: '30 10 * * *', // 10:30 UTC → 5:30 AM CDT / 4:30 AM CST
      run: () => runMorningPrep(bus),
      handler: guarded('morning-prep', () => runMorningPrep(bus)),
    },
    {
      name: 'nightly',
      schedule: '30 4 * * *', // 04:30 UTC → 11:30 PM CDT / 10:30 PM CST (prev day local)
      run: () => runNightly(bus),
      handler: guarded('nightly', () => runNightly(bus)),
    },
    {
      name: 'whoop-sleep',
      schedule: '0 13 * * *', // 13:00 UTC → 8:00 AM CDT / 7:00 AM CST
      run: () => runWhoopSleepSync(bus),
      handler: guarded('whoop-sleep', () => runWhoopSleepSync(bus)),
    },
    {
      name: 'weekly-nudge',
      schedule: '0 20 * * 5', // 20:00 UTC Friday → 3 PM CDT / 2 PM CST
      run: () => runWeeklyNudge(bus),
      handler: guarded('weekly-nudge', () => runWeeklyNudge(bus)),
    },
    {
      name: 'review-nudge',
      schedule: '0 20 28-31 * *', // 20:00 UTC last days of month → 3 PM CDT / 2 PM CST
      run: () => runReviewNudge(bus),
      handler: guarded('review-nudge', () => runReviewNudge(bus)),
    },
  ];
}

// Keep a reference to the registered jobs so the heartbeat can access them
let registeredJobs: JobDefinition[] = [];

export function startScheduler({ bus }: { bus: NotificationBus }): void {
  if (tasks.length > 0) {
    stopScheduler();
  }

  const jobs = [...registerJobs(bus), ...scanAgentCronJobs(bus)];
  registeredJobs = jobs;

  for (const job of jobs) {
    const task = cron.schedule(job.schedule, job.handler, {
      timezone: 'UTC',
    });
    tasks.push(task);
    log.info(`Registered cron job: ${job.name}`, { schedule: job.schedule, timezone: 'UTC' });
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
