import cron, { type ScheduledTask } from 'node-cron';
import type TelegramBot from 'node-telegram-bot-api';
import config from '../config.js';
import { createLogger } from '../utils/logger.js';
import { runMorningPrep } from './morning-prep.js';
import { runNightly } from './nightly.js';
import { runWeeklyNudge, runReviewNudge } from './nudges.js';
import { runWhoopSleepSync } from './whoop-sync.js';

const log = createLogger('scheduler');

const tasks: ScheduledTask[] = [];

interface JobDefinition {
  name: string;
  schedule: string;
  handler: (now: Date | 'manual' | 'init') => void;
}

function registerJobs(bot: TelegramBot): JobDefinition[] {
  return [
    {
      name: 'morning-prep',
      schedule: '30 5 * * *', // 5:30 AM daily
      handler: () => { void runMorningPrep(bot); },
    },
    {
      name: 'nightly',
      schedule: '30 23 * * *', // 11:30 PM daily
      handler: () => { void runNightly(bot); },
    },
    {
      name: 'whoop-sleep',
      schedule: '0 8 * * *', // 8:00 AM daily
      handler: () => { void runWhoopSleepSync(bot); },
    },
    {
      name: 'weekly-nudge',
      schedule: '0 15 * * 5', // Friday 3 PM
      handler: () => { void runWeeklyNudge(bot); },
    },
    {
      name: 'review-nudge',
      schedule: '0 15 28-31 * *', // Last days of month, 3 PM — Phase 7 adds last-day check
      handler: () => { void runReviewNudge(bot); },
    },
  ];
}

export function startScheduler(bot: TelegramBot): void {
  if (tasks.length > 0) {
    stopScheduler();
  }

  const jobs = registerJobs(bot);

  for (const job of jobs) {
    const task = cron.schedule(job.schedule, job.handler, {
      timezone: config.TIMEZONE,
    });
    tasks.push(task);
    log.info(`Registered cron job: ${job.name}`, { schedule: job.schedule, timezone: config.TIMEZONE });
  }

  log.info(`Scheduler started with ${jobs.length} job(s)`);
}

export function stopScheduler(): void {
  for (const task of tasks) {
    task.stop();
  }
  log.info(`Scheduler stopped (${tasks.length} job(s))`);
  tasks.length = 0;
}
