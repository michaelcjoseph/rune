import type TelegramBot from 'node-telegram-bot-api';
import { captureSessions } from './capture.js';
import { executeActivitySync } from './whoop-sync.js';
import { processIngestionQueue, lintKB, enqueue } from '../kb/engine.js';
import { extractPlaybookDrafts } from './playbook-extract.js';
import { extractMeetings, appendProjectDecisions } from './meeting-extract.js';
import { askClaudeOneShot, runAgent } from '../ai/claude.js';
import { readVaultFile, writeVaultFile } from '../vault/files.js';
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
  const { processed, errors, created, updated } = await processIngestionQueue();
  if (processed === 0 && errors === 0) {
    return { step: 'KB queue', status: 'skipped', detail: 'Queue empty' };
  }
  if (errors > 0) {
    return { step: 'KB queue', status: 'error', detail: `${processed} processed, ${errors} failed` };
  }
  return {
    step: 'KB queue',
    status: 'success',
    detail: `${processed} source(s) ingested, ${created} created, ${updated} updated`,
  };
}

async function stepDailyTags(date: string, content: string | null): Promise<NightlyStepResult> {
  const KNOWN_JSON_FILES = [
    'pages/books.json — book log',
    'pages/crm.json — contact interactions',
    'pages/places.json — places visited',
    'health/workouts.json — workout log',
    'study/progress.json — study progress',
    'career/applications.json — job applications',
    'investments/investments.json — investment tracking',
  ];

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

async function stepPlaybookExtract(): Promise<NightlyStepResult> {
  const result = await extractPlaybookDrafts();
  return { step: 'Playbook extract', status: result.status, detail: result.detail };
}

function stepJournalIngest(filename: string, content: string | null): NightlyStepResult {
  if (!content || content.trim().length === 0) {
    return { step: 'Journal ingest', status: 'skipped', detail: 'No journal content today' };
  }
  const source = `journals/${filename}`;
  enqueue(source);
  return { step: 'Journal ingest', status: 'success', detail: source };
}

async function stepMeetingExtract(content: string | null, date: string): Promise<NightlyStepResult> {
  if (!content || content.trim().length === 0) {
    return { step: 'Meeting extract', status: 'skipped', detail: 'No journal content today' };
  }
  const meetings = await extractMeetings(content, date);
  if (meetings.length === 0) {
    return { step: 'Meeting extract', status: 'skipped', detail: 'No #meeting blocks to transcribe' };
  }

  // Append decisions to project Decisions Logs first — runs independently of
  // attendees so meetings with decisions but no attendees are still captured.
  let decisionsAppended = 0;
  for (const m of meetings) {
    if (!m.project || m.decisions.length === 0) continue;
    const r = appendProjectDecisions(m.project, date, m.decisions);
    if (r.status === 'success') {
      decisionsAppended += r.appended;
      enqueue(`projects/${m.project}.md`);
    } else if (r.status === 'error') {
      log.error('Decision append failed', { project: m.project, detail: r.detail });
    }
  }
  const decisionsSuffix = decisionsAppended > 0 ? `, ${decisionsAppended} decision(s) → projects/` : '';

  // Aggregate unique attendees across all meetings to a single CRM update.
  const attendees = Array.from(new Set(meetings.flatMap((m) => m.attendees)));
  if (attendees.length === 0) {
    return { step: 'Meeting extract', status: 'success', detail: `${meetings.length} meeting(s) found, skipped CRM (no attendees)${decisionsSuffix}` };
  }

  // CRM journal_refs use underscore date form (matches journal filenames sans `.md`).
  const journalRef = date.replace(/-/g, '_');

  const crmPrompt = `Update pages/crm.json: append "${journalRef}" to the journal_refs of each attendee from today's meeting(s).

Attendees:
${attendees.map((a) => `- ${a}`).join('\n')}

Process this as a **single read-modify-write pass**:
1. Read pages/crm.json once.
2. For each attendee in the list above:
   a. Find the entry whose \`id\` matches the slug. If no id matches, fall back to a case-insensitive name match. If still no match, create a new entry: \`{id: <slug>, name: <derived>, journal_refs: ["${journalRef}"]}\`. For \`name\`, replace hyphens with spaces and title-case as a best-effort fallback.
   b. **Dedup**: only append "${journalRef}" if it's NOT already in the entry's \`journal_refs\`. If today's ref is already present, leave the entry unchanged.
   c. Preserve all other fields on existing entries.
3. Write the updated array back to pages/crm.json once at the end.

Report a one-line summary per attendee: "<id>: appended" / "<id>: already present" / "<id>: created new entry". Flag any uncertain name derivation explicitly (e.g. "<id>: created new entry (name uncertain — review)").`;

  const result = await runAgent('json-updater', crmPrompt);
  if (result.error) {
    log.error('CRM update via json-updater failed', { error: result.error, attendees });
    return { step: 'Meeting extract', status: 'error', detail: `${meetings.length} meeting(s) extracted, CRM update failed: ${result.error}` };
  }

  // Enqueue the freshly updated CRM file so the next KB queue pass picks up the new
  // contacts and journal_refs (mirrors the post-review enqueue pattern).
  enqueue('pages/crm.json');

  return { step: 'Meeting extract', status: 'success', detail: `${meetings.length} meeting(s), ${attendees.length} attendee(s) → CRM${decisionsSuffix}` };
}

async function stepWhoopActivity(): Promise<NightlyStepResult> {
  const result = await executeActivitySync();
  return { step: 'Whoop activity', status: result.status === 'synced' ? 'success' : result.status, detail: result.detail };
}

function stepMarkProcessed(filename: string, content: string | null, date: string): NightlyStepResult {
  if (!content) {
    return { step: 'Mark processed', status: 'skipped', detail: 'No journal content today' };
  }
  const path = `journals/${filename}`;
  const marker = `<!-- daily-processed: ${date} -->`;
  if (content.includes(marker)) {
    return { step: 'Mark processed', status: 'skipped', detail: 'Marker already present' };
  }
  // Append marker with a single blank line separator. Preserve existing trailing newline.
  const sep = content.endsWith('\n') ? '\n' : '\n\n';
  writeVaultFile(path, `${content}${sep}${marker}\n`);
  return { step: 'Mark processed', status: 'success', detail: marker };
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

  const run = async (name: string, fn: () => NightlyStepResult | Promise<NightlyStepResult>) => {
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

  const todayDate = getTodayDate();
  const todayFilename = getTodayFilename();
  let todayJournal: string | null = null;
  try {
    todayJournal = readVaultFile(`journals/${todayFilename}`);
  } catch (err) {
    log.error('Failed to read today\'s journal', { error: String(err) });
  }

  await run('Session capture', stepCaptureSession);
  await run('Daily tags', () => stepDailyTags(todayDate, todayJournal));
  await run('Playbook extract', stepPlaybookExtract);
  await run('Journal ingest', () => stepJournalIngest(todayFilename, todayJournal));
  await run('Meeting extract', () => stepMeetingExtract(todayJournal, todayDate));
  await run('KB queue', stepKBQueue);
  await run('Whoop activity', stepWhoopActivity);
  await run('KB lint', stepLint);
  await run('Mark processed', () => stepMarkProcessed(todayFilename, todayJournal, todayDate));

  // Final commit for any residual uncommitted changes
  await gitCommitAndPush('Nightly processing');

  log.info('Nightly processing complete', { steps: steps.length });
  return { steps };
}

export function formatSummary(result: NightlyResult): string {
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
