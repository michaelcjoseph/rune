import type TelegramBot from 'node-telegram-bot-api';
import { captureSessions } from './capture.js';
import { executeActivitySync } from './whoop-sync.js';
import { processIngestionQueue, lintKB } from '../kb/engine.js';
import { askClaudeOneShot, runAgent } from '../ai/claude.js';
import { readVaultFile } from '../vault/files.js';
import { gitCommitAndPush } from '../vault/git.js';
import { getTodayDate, getTodayFilename, getDayOfWeek } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';
import config from '../config.js';

const log = createLogger('nightly');

interface NightlyStepResult {
  step: string;
  status: 'success' | 'skipped' | 'error';
  detail?: string;
}

export interface NightlyResult {
  steps: NightlyStepResult[];
}

async function stepCaptureSession(): Promise<NightlyStepResult> {
  const { captured } = await captureSessions();
  if (captured === 0) {
    return { step: 'Session capture', status: 'skipped', detail: 'No active sessions' };
  }
  return { step: 'Session capture', status: 'success', detail: `${captured} session(s) captured` };
}

async function stepKBQueue(): Promise<NightlyStepResult> {
  const { processed, errors } = await processIngestionQueue();
  if (processed === 0 && errors === 0) {
    return { step: 'KB queue', status: 'skipped', detail: 'Queue empty' };
  }
  if (errors > 0) {
    return { step: 'KB queue', status: 'error', detail: `${processed} processed, ${errors} failed` };
  }
  return { step: 'KB queue', status: 'success', detail: `${processed} source(s) ingested` };
}

async function stepDailyTags(): Promise<NightlyStepResult> {
  const KNOWN_JSON_FILES = [
    'pages/books.json — book log',
    'pages/crm.json — contact interactions',
    'pages/places.json — places visited',
    'health/workouts.json — workout log',
    'study/progress.json — study progress',
    'career/applications.json — job applications',
    'investments/investments.json — investment tracking',
  ];

  const date = getTodayDate();
  const filename = getTodayFilename();
  const content = readVaultFile(`journals/${filename}`);

  if (!content?.trim()) {
    return { step: 'Daily tags', status: 'skipped', detail: 'No journal for today' };
  }

  // Guard against very large journals overwhelming the prompt
  const MAX_JOURNAL_CHARS = 50_000;
  const truncatedContent = content.length > MAX_JOURNAL_CHARS
    ? content.slice(0, MAX_JOURNAL_CHARS) + '\n\n[truncated]'
    : content;

  const analysisPrompt = `Analyze this journal entry and identify all inline tags (words prefixed with #, like #workout, #crm, #place, #book, #priorities, etc.). For each tagged item, extract the relevant data from the surrounding text and propose a JSON update.

Known JSON data files:
${KNOWN_JSON_FILES.map((f) => `- ${f}`).join('\n')}

Journal entry for ${date}:
---
${truncatedContent}
---

For each tag found, output a proposed update in this format:

**#tagname** → target file
- Data to add/update: [extracted details]

If no actionable tags are found (i.e., nothing that maps to a JSON data file), say "No JSON updates needed." and briefly summarize what was in the journal.

Be concise. Only propose updates for tags that clearly map to a data file.`;

  const analysis = await askClaudeOneShot(analysisPrompt);

  if (analysis.error || !analysis.text) {
    return { step: 'Daily tags', status: 'error', detail: analysis.error || 'Empty response' };
  }

  if (analysis.text.includes('No JSON updates needed')) {
    return { step: 'Daily tags', status: 'skipped', detail: 'No actionable tags' };
  }

  const agentPrompt = `Apply the following proposed JSON updates to the vault data files. Read each target file first to understand its structure, then add the new entries.

Only modify files listed in the proposed updates. Do not create new files or modify files outside the proposed scope.

Proposed updates:
${analysis.text}

Date context: ${date}`;

  const result = await runAgent('json-updater', agentPrompt);

  if (result.error) {
    return { step: 'Daily tags', status: 'error', detail: result.error };
  }

  await gitCommitAndPush(`Daily tag processing: ${date}`);
  return { step: 'Daily tags', status: 'success', detail: 'Tags processed and applied' };
}

async function stepWhoopActivity(): Promise<NightlyStepResult> {
  const result = await executeActivitySync();
  return { step: 'Whoop activity', status: result.status === 'synced' ? 'success' : result.status, detail: result.detail };
}

async function stepLint(): Promise<NightlyStepResult> {
  if (getDayOfWeek() !== 'Sunday') {
    return { step: 'KB lint', status: 'skipped', detail: 'Not Sunday' };
  }

  const { success, report } = await lintKB();

  if (!success) {
    return { step: 'KB lint', status: 'error', detail: report.slice(0, 250) };
  }

  return { step: 'KB lint', status: 'success', detail: report.slice(0, 200) };
}

export async function executeNightly(): Promise<NightlyResult> {
  log.info('Nightly processing started');
  const steps: NightlyStepResult[] = [];

  const run = async (name: string, fn: () => Promise<NightlyStepResult>) => {
    try {
      const result = await fn();
      steps.push(result);
      log.info(`Step complete: ${result.step}`, { status: result.status, detail: result.detail });
    } catch (err) {
      const result: NightlyStepResult = { step: name, status: 'error', detail: String(err) };
      steps.push(result);
      log.error(`Step failed: ${name}`, { error: String(err) });
    }
  };

  await run('Session capture', stepCaptureSession);
  await run('KB queue', stepKBQueue);
  await run('Daily tags', stepDailyTags);
  await run('Whoop activity', stepWhoopActivity);
  await run('KB lint', stepLint);

  // Final commit for any residual uncommitted changes
  await gitCommitAndPush('Nightly processing');

  log.info('Nightly processing complete', { steps: steps.length });
  return { steps };
}

function formatSummary(result: NightlyResult): string {
  const icons: Record<string, string> = { success: '+', skipped: '-', error: 'x' };
  const lines = result.steps.map((s) => {
    const icon = icons[s.status] || '?';
    const detail = s.detail ? ` — ${s.detail}` : '';
    return `[${icon}] ${s.step}${detail}`;
  });
  return `Nightly complete:\n${lines.join('\n')}`;
}

export async function runNightly(bot: TelegramBot): Promise<void> {
  try {
    const result = await executeNightly();
    const summary = formatSummary(result);
    await bot.sendMessage(config.TELEGRAM_USER_ID, summary);
  } catch (err) {
    log.error('Nightly processing failed', { error: String(err) });
    try {
      await bot.sendMessage(config.TELEGRAM_USER_ID, `Nightly processing failed: ${String(err)}`);
    } catch {
      // TG send failed too — just log
    }
  }
}
