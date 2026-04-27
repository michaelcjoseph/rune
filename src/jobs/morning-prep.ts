import type TelegramBot from 'node-telegram-bot-api';
import { readVaultFile } from '../vault/files.js';
import { parseTag, parseWeeklyGoals, writeMorningPrep } from '../vault/journal.js';
import { askClaudeOneShot } from '../ai/claude.js';
import { gitCommitAndPush } from '../vault/git.js';
import { getYesterdayFilename, getDayOfWeek, getMostRecentFridayFilename } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';
import config from '../config.js';

const log = createLogger('morning-prep');

export interface MorningData {
  weeklyGoals: string;
  weeklyGoalsSource: string | null;
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

// Strict single-Friday read: a missed weekly review surfaces as
// 'No weekly goals set.' rather than quietly resurfacing older goals.
function gatherWeeklyGoals(fridayFile: string): { goals: string; sourceFile: string | null } {
  const content = readVaultFile(`journals/${fridayFile}`);
  if (!content?.trim()) return { goals: 'No weekly goals set.', sourceFile: null };
  const parsed = parseWeeklyGoals(content);
  if (!parsed?.trim()) return { goals: 'No weekly goals set.', sourceFile: null };
  return { goals: parsed.trim(), sourceFile: fridayFile };
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

// Claude synthesis sees full content; only the fallback path truncates.
function truncateForFallback(content: string, sourceHint: string, maxLines: number): string {
  const trimmed = content.trim();
  const lines = trimmed.split('\n');
  if (lines.length <= maxLines) return trimmed;
  return `${lines.slice(0, maxLines).join('\n')}\n\n_… truncated — see \`${sourceHint}\`_`;
}

function buildGoalsSourceLabel(source: string | null): string {
  return source ? ` (from ${formatSourceDate(source)})` : '';
}

export function formatMorningPrepFallback(data: MorningData): string {
  const goalsSourceHint = data.weeklyGoalsSource
    ? `journals/${data.weeklyGoalsSource} **Next Week's Goals:**`
    : "journals/<friday>.md **Next Week's Goals:**";
  const weeklyGoals = truncateForFallback(data.weeklyGoals, goalsSourceHint, 10);
  const goalsHeader = `### Weekly Goals${buildGoalsSourceLabel(data.weeklyGoalsSource)}`;
  const priorities = truncateForFallback(data.priorities, 'journals/<yesterday>.md #priorities', 15);
  const workout = truncateForFallback(data.workout, 'health/plan.md', 10);
  const study = truncateForFallback(data.study, 'study/syllabus.md, study/progress.json', 10);
  const writing = truncateForFallback(data.writing, 'writing/topics.md', 10);
  return `${goalsHeader}\n${weeklyGoals}\n\n### Priorities Recap\n${priorities}\n\n### Workout\n${workout}\n\n### Study\n${study}\n\n### Writing Focus\n${writing}`;
}

function formatSourceDate(filename: string): string {
  const match = filename.match(/^(\d{4})_(\d{2})_(\d{2})\.md$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : filename;
}

export interface SynthesisResult {
  text: string;
  synthFailed: boolean;
  synthError: string | null;
}

// Uses askClaudeOneShot instead of the morning-prep agent because the data is
// already gathered in TypeScript — the agent's tool access (Read, Glob, etc.)
// would be redundant. The prompt mirrors the agent's output format.
export async function synthesizeMorningPrep(data: MorningData): Promise<SynthesisResult> {
  const goalsSourceLabel = buildGoalsSourceLabel(data.weeklyGoalsSource);
  const goalsHeaderTemplate = `### Weekly Goals${goalsSourceLabel}`;
  const prompt = `You are preparing a morning journal section. Today is ${data.dayOfWeek}. Yesterday's journal: ${data.yesterdayFile}.

Here is the gathered data:

**This Week's Goals${goalsSourceLabel}:**
${data.weeklyGoals}

**Yesterday's Priorities:**
${data.priorities}

**Today's Workout (${data.dayOfWeek}):**
${data.workout}

**Study Assignments:**
${data.study}

**Writing Focus:**
${data.writing}

Synthesize this into a concise morning prep section using exactly this format (no markdown fences, no extra commentary):

${goalsHeaderTemplate}
<numbered list of this week's goals, preserved verbatim from input — or "No weekly goals set." if none>

### Priorities Recap
<bullet list of yesterday's priorities with brief status if inferable>

### Workout
<today's workout prescription — exercises, sets, reps, or rest day>

### Study
<current assignments, progress, overdue items>

### Writing Focus
<current topic and any relevant context>

Be concise — this is a morning glance, not a report. Use bullet points (or numbered for goals), not paragraphs. Never invent data — only report what was provided. The "(from YYYY-MM-DD)" parenthetical appears only on the "### Weekly Goals" header — do not add it to any other section. Keep total output under 500 words.`;

  let result: { text: string | null; error: string | null };
  try {
    result = await askClaudeOneShot(prompt);
  } catch (err) {
    const errMsg = String(err);
    log.error('Claude synthesis threw', { error: errMsg });
    return { text: formatMorningPrepFallback(data), synthFailed: true, synthError: errMsg };
  }

  if (result.error || !result.text) {
    const errMsg = result.error ?? 'empty response';
    log.error('Claude synthesis failed, using fallback', { error: errMsg });
    return { text: formatMorningPrepFallback(data), synthFailed: true, synthError: errMsg };
  }

  return { text: result.text, synthFailed: false, synthError: null };
}

export type MorningPrepResult =
  | { status: 'written'; filepath: string }
  | { status: 'fallback'; filepath: string; synthError: string }
  | { status: 'skipped'; filepath: string };

export async function executeMorningPrep(): Promise<MorningPrepResult> {
  const data = gatherMorningData();
  const synthesis = await synthesizeMorningPrep(data);
  const { written, filepath } = writeMorningPrep(synthesis.text);

  if (!written) {
    log.info('Morning prep already written, skipping', { filepath });
    return { status: 'skipped', filepath };
  }

  await gitCommitAndPush('Morning prep');
  if (synthesis.synthFailed) {
    log.warn('Morning prep written with fallback', { filepath, synthError: synthesis.synthError });
    return { status: 'fallback', filepath, synthError: synthesis.synthError ?? 'unknown' };
  }
  log.info('Morning prep complete', { filepath });
  return { status: 'written', filepath };
}

// Absolute paths can appear in errors like `spawn ENOENT /Users/.../claude` and
// would leak the vault location over Telegram; cap length as a belt-and-braces.
function sanitizeErrorForTelegram(msg: string): string {
  return msg.replace(/\/(?:Users|home|var|tmp|opt|private)\/\S+/g, '[path]').slice(0, 200);
}

export async function runMorningPrep(bot: TelegramBot): Promise<void> {
  try {
    const result = await executeMorningPrep();
    if (result.status === 'written') {
      await bot.sendMessage(config.TELEGRAM_USER_ID, 'Your journal is ready.');
    } else if (result.status === 'fallback') {
      const safeError = sanitizeErrorForTelegram(result.synthError);
      await bot.sendMessage(
        config.TELEGRAM_USER_ID,
        `Morning prep wrote a fallback — Claude synth failed: ${safeError}. Review and edit.`
      );
    }
  } catch (err) {
    log.error('Morning prep failed', { error: String(err) });
  }
}

export function gatherMorningData(): MorningData {
  const yesterdayFile = getYesterdayFilename();
  const dayOfWeek = getDayOfWeek();
  const fridayFile = getMostRecentFridayFilename();
  const { goals, sourceFile } = gatherWeeklyGoals(fridayFile);

  log.info('Gathering morning prep data', {
    yesterdayFile,
    dayOfWeek,
    weeklyGoalsSource: sourceFile,
  });

  return {
    weeklyGoals: goals,
    weeklyGoalsSource: sourceFile,
    priorities: gatherPriorities(yesterdayFile),
    workout: gatherWorkout(),
    study: gatherStudy(),
    writing: gatherWriting(),
    yesterdayFile,
    dayOfWeek,
  };
}
