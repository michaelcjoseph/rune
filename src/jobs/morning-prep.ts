import type TelegramBot from 'node-telegram-bot-api';
import { readVaultFile } from '../vault/files.js';
import { parseTag, writeMorningPrep } from '../vault/journal.js';
import { askClaudeOneShot } from '../ai/claude.js';
import { gitCommitAndPush } from '../vault/git.js';
import { getYesterdayFilename, getDayOfWeek } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';
import config from '../config.js';

const log = createLogger('morning-prep');

export interface MorningData {
  priorities: string;
  workout: string;
  study: string;
  writing: string;
  yesterdayFile: string;
  dayOfWeek: string;
}

function gatherPriorities(yesterdayFile: string): string {
  const content = readVaultFile(`journals/${yesterdayFile}`);
  if (!content?.trim()) return 'No priorities logged yesterday.';
  const parsed = parseTag(content, 'priorities');
  return parsed?.trim() || 'No priorities logged yesterday.';
}

function gatherWorkout(): string {
  const content = readVaultFile('health/plan.md');
  return content?.trim() || 'No workout plan found.';
}

function gatherStudy(): string {
  const syllabus = readVaultFile('study/syllabus.md')?.trim();
  const progress = readVaultFile('study/progress.json')?.trim();
  if (!syllabus && !progress) return 'No active study assignments.';
  const parts: string[] = [];
  if (syllabus) parts.push(syllabus);
  if (progress) parts.push(progress);
  return parts.join('\n\n');
}

function gatherWriting(): string {
  const content = readVaultFile('writing/topics.md');
  return content?.trim() || 'No writing topic set.';
}

export function formatMorningPrepFallback(data: MorningData): string {
  return `### Priorities Recap\n${data.priorities}\n\n### Workout\n${data.workout}\n\n### Study\n${data.study}\n\n### Writing Focus\n${data.writing}`;
}

// Uses askClaudeOneShot instead of the morning-prep agent because the data is
// already gathered in TypeScript — the agent's tool access (Read, Glob, etc.)
// would be redundant. The prompt mirrors the agent's output format.
export async function synthesizeMorningPrep(data: MorningData): Promise<string> {
  const prompt = `You are preparing a morning journal section. Today is ${data.dayOfWeek}. Yesterday's journal: ${data.yesterdayFile}.

Here is the gathered data:

**Yesterday's Priorities:**
${data.priorities}

**Today's Workout (${data.dayOfWeek}):**
${data.workout}

**Study Assignments:**
${data.study}

**Writing Focus:**
${data.writing}

Synthesize this into a concise morning prep section using exactly this format (no markdown fences, no extra commentary):

### Priorities Recap
<bullet list of yesterday's priorities with brief status if inferable>

### Workout
<today's workout prescription — exercises, sets, reps, or rest day>

### Study
<current assignments, progress, overdue items>

### Writing Focus
<current topic and any relevant context>

Be concise — this is a morning glance, not a report. Use bullet points, not paragraphs. Never invent data — only report what was provided. Keep total output under 500 words.`;

  let result: { text: string | null; error: string | null };
  try {
    result = await askClaudeOneShot(prompt);
  } catch (err) {
    log.error('Claude synthesis threw', { error: String(err) });
    return formatMorningPrepFallback(data);
  }

  if (result.error || !result.text) {
    log.error('Claude synthesis failed, using fallback', { error: result.error });
    return formatMorningPrepFallback(data);
  }

  return result.text;
}

export interface MorningPrepResult {
  status: 'written' | 'skipped' | 'error';
  filepath?: string;
  error?: string;
}

export async function executeMorningPrep(): Promise<MorningPrepResult> {
  const data = gatherMorningData();
  const sections = await synthesizeMorningPrep(data);
  const { written, filepath } = writeMorningPrep(sections);

  if (!written) {
    log.info('Morning prep already written, skipping', { filepath });
    return { status: 'skipped', filepath };
  }

  gitCommitAndPush('Morning prep');
  log.info('Morning prep complete', { filepath });
  return { status: 'written', filepath };
}

export async function runMorningPrep(bot: TelegramBot): Promise<void> {
  try {
    const result = await executeMorningPrep();
    if (result.status === 'written') {
      await bot.sendMessage(config.TELEGRAM_USER_ID, 'Your journal is ready.');
    }
  } catch (err) {
    log.error('Morning prep failed', { error: String(err) });
  }
}

export function gatherMorningData(): MorningData {
  const yesterdayFile = getYesterdayFilename();
  const dayOfWeek = getDayOfWeek();

  log.info('Gathering morning prep data', { yesterdayFile, dayOfWeek });

  return {
    priorities: gatherPriorities(yesterdayFile),
    workout: gatherWorkout(),
    study: gatherStudy(),
    writing: gatherWriting(),
    yesterdayFile,
    dayOfWeek,
  };
}
