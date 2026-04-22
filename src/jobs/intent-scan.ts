import { readFileSync } from 'node:fs';
import type TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';
import config from '../config.js';
import { askHaikuOneShot } from '../ai/claude.js';
import { intentLogPath, type IntentLogEntry } from '../utils/intent-log.js';
// jobs-layer importing from bot-layer: accepted precedent — scheduler.ts
// already imports reloadSkillRegistry from here. The skill-registry is a
// data provider for several cross-cutting features (cron, resolver, scan).
import { getSkillRegistry } from '../bot/skill-registry.js';
import { appendProposals, readProposalQueue, type Proposal } from './proposal-queue.js';
import { sendLongMessage } from '../integrations/telegram/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('intent-scan');

export const INTENT_SCAN_WINDOW_DAYS = 30;
export const MAX_PROPOSALS_PER_SCAN = 3;
/** Minimum entries required before we bother calling Haiku. Scanning an
 *  almost-empty log is a waste — it will produce noise proposals. */
export const MIN_ENTRIES_FOR_SCAN = 5;

export interface IntentScanResult {
  status: 'skipped' | 'success' | 'error';
  detail: string;
  /** Proposals that landed in the queue (after cap + dedupe + validation). */
  queued: Proposal[];
}

/** Read the intent log (returns [] if missing or unreadable), parse each line,
 *  skip malformed rows. Same tolerant pattern used by readLearnings. */
export function readIntentLog(path: string = intentLogPath()): IntentLogEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const entries: IntentLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isIntentLogEntry(parsed)) entries.push(parsed);
    } catch {
      // skip malformed line
    }
  }
  return entries;
}

function isIntentLogEntry(v: unknown): v is IntentLogEntry {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['ts'] === 'string' &&
    typeof o['intent'] === 'string' &&
    typeof o['outcome'] === 'string' &&
    typeof o['confidence'] === 'number'
  );
}

/** Filter entries to those within the last `windowDays` of `now`. */
export function filterRecent(
  entries: IntentLogEntry[],
  windowDays: number = INTENT_SCAN_WINDOW_DAYS,
  now: Date = new Date(),
): IntentLogEntry[] {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  return entries.filter(e => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/** Build the prompt shown to Haiku. The known-skill list is included so the
 *  model dedupes at generation time (the deterministic dedupe below is a
 *  safety net).
 *  PII NOTE: each entry's raw `intent` field (the verbatim user TG message)
 *  is embedded in the prompt and sent to the Anthropic API. This is consistent
 *  with how runAgent calls already transit vault content; the concentration
 *  of 30 days of messages in one request is more visible than any single
 *  agent call, but the data path and surface are the same. */
export function buildScanPrompt(entries: IntentLogEntry[], knownSkills: string[]): string {
  const messages = entries.map(e => `- [${e.ts}] (${e.outcome}) ${e.intent}`).join('\n');
  return [
    'You are the Ask-Twice intent-scan harness.',
    '',
    `Review the last ${INTENT_SCAN_WINDOW_DAYS} days of resolver intent log entries below.`,
    'Identify recurring intents worth proposing as new skills or crons.',
    '',
    'Rules:',
    `- Propose at most ${MAX_PROPOSALS_PER_SCAN} items. Pick only the strongest patterns.`,
    '- Distinguish "asked for the same kind of thing repeatedly" from "chatted a lot".',
    `- Skip any pattern that duplicates an existing skill: ${knownSkills.join(', ')}.`,
    '- If a pattern happens at a predictable cadence (e.g., every Monday morning), include a `suggested_cron` in 5-field cron syntax.',
    '- If the pattern is a new capability (not time-bound), include a `suggested_skill` description instead.',
    '- Include a `rationale` like "Asked 6 times in 3 weeks".',
    '',
    'Intent log entries:',
    messages,
    '',
    'Return JSON only. No prose, no code fences. An array of objects shaped:',
    '[',
    '  {',
    '    "title": "<short name>",',
    '    "rationale": "<why this pattern>",',
    '    "suggested_skill": "<description, or null>",',
    '    "suggested_cron": "<5-field cron, or null>"',
    '  }',
    ']',
    '',
    'Return [] (empty array) if no pattern is strong enough.',
  ].join('\n');
}

interface RawProposal {
  title?: unknown;
  rationale?: unknown;
  suggested_skill?: unknown;
  suggested_cron?: unknown;
}

/** Parse Haiku output into validated proposals. Strips code fences, validates
 *  cron expressions, drops malformed items. Returns at most
 *  MAX_PROPOSALS_PER_SCAN entries. */
export function parseScanResponse(raw: string): Omit<Proposal, 'draftedAt' | 'status' | 'type'>[] {
  const trimmed = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```\s*$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    log.warn('Scan response is not valid JSON', { preview: trimmed.slice(0, 200) });
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Omit<Proposal, 'draftedAt' | 'status' | 'type'>[] = [];
  for (const raw of parsed) {
    // Guard before the RawProposal cast: a literal `null` inside the array
    // would slip past the outer JSON.parse check and crash on item.title.
    if (raw === null || typeof raw !== 'object') continue;
    const item = raw as RawProposal;
    if (typeof item.title !== 'string' || item.title.length === 0) continue;
    if (typeof item.rationale !== 'string' || item.rationale.length === 0) continue;
    const suggested_skill =
      typeof item.suggested_skill === 'string' && item.suggested_skill.length > 0
        ? item.suggested_skill
        : undefined;
    const suggested_cron =
      typeof item.suggested_cron === 'string' && item.suggested_cron.length > 0
        ? item.suggested_cron
        : undefined;
    if (!suggested_skill && !suggested_cron) continue;
    if (suggested_cron && !cron.validate(suggested_cron)) {
      log.warn('Dropping proposal with invalid cron', { title: item.title, cron: suggested_cron });
      continue;
    }
    // Belt-and-braces 5-field enforcement — scheduler.ts requires 5-field and
    // node-cron.validate also accepts 6-field (with seconds), which the
    // scheduler refuses.
    if (suggested_cron && suggested_cron.trim().split(/\s+/).length !== 5) {
      log.warn('Dropping proposal with non-5-field cron', { title: item.title, cron: suggested_cron });
      continue;
    }
    out.push({
      title: item.title,
      rationale: item.rationale,
      ...(suggested_skill ? { suggested_skill } : {}),
      ...(suggested_cron ? { suggested_cron } : {}),
    });
  }
  return out.slice(0, MAX_PROPOSALS_PER_SCAN);
}

/** Drop proposals whose suggested_skill name (or title) duplicates an existing
 *  skill in the registry. Comparison is case-insensitive substring on skill
 *  name — a rough dedupe but sufficient for the MVP. Strict dedupe would
 *  require semantic match, which the classifier already attempts. The
 *  `length >= 2` guard keeps real two-char skills like `kb` and `pg` in play;
 *  single-char names (theoretical) would over-match and are excluded. */
export function dedupeAgainstRegistry(
  items: Omit<Proposal, 'draftedAt' | 'status' | 'type'>[],
  knownSkills: string[],
): Omit<Proposal, 'draftedAt' | 'status' | 'type'>[] {
  const lowerSkills = knownSkills.map(s => s.toLowerCase());
  return items.filter(item => {
    const haystack = [item.title, item.suggested_skill ?? ''].join(' ').toLowerCase();
    return !lowerSkills.some(s => s.length >= 2 && haystack.includes(s));
  });
}

/** Drop proposals whose title duplicates an existing pending proposal's title.
 *  Without this, a recurring pattern queued in week 1 gets queued again in
 *  week 2 (and 3, 4, ...) until the user actions it — cluttering the review
 *  prep context. Case-insensitive title equality is sufficient: the title is
 *  a short canonical label the Haiku model reproduces consistently. */
export function dedupeAgainstPending(
  items: Omit<Proposal, 'draftedAt' | 'status' | 'type'>[],
  existing: Proposal[],
): Omit<Proposal, 'draftedAt' | 'status' | 'type'>[] {
  const existingTitles = new Set(
    existing.filter(p => p.status === 'pending').map(p => p.title.toLowerCase()),
  );
  return items.filter(item => !existingTitles.has(item.title.toLowerCase()));
}

/** Run the Ask-Twice intent scan. Reads `logs/intent-log.jsonl` (last 30 days),
 *  groups via a single Haiku one-shot, validates and dedupes, appends up to 3
 *  proposals to `logs/proposal-queue.json`. When `bot` is provided and any
 *  proposals were drafted, posts a short summary to Telegram. Idempotent with
 *  respect to failure — partial writes never land. */
export async function runIntentScan(bot?: TelegramBot): Promise<IntentScanResult> {
  const entries = filterRecent(readIntentLog());
  if (entries.length < MIN_ENTRIES_FOR_SCAN) {
    const detail = `Skipping — only ${entries.length} entries in window (need ≥ ${MIN_ENTRIES_FOR_SCAN})`;
    log.info(detail);
    return { status: 'skipped', detail, queued: [] };
  }

  const knownSkills = getSkillRegistry().map(s => s.name);
  const prompt = buildScanPrompt(entries, knownSkills);
  const result = await askHaikuOneShot(prompt, config.HAIKU_SCAN_TIMEOUT_MS);
  if (result.error || !result.text) {
    const detail = `Haiku call failed: ${result.error ?? 'empty response'}`;
    log.error(detail);
    return { status: 'error', detail, queued: [] };
  }

  const parsed = parseScanResponse(result.text);
  const dedupedVsRegistry = dedupeAgainstRegistry(parsed, knownSkills);
  const deduped = dedupeAgainstPending(dedupedVsRegistry, readProposalQueue());
  if (deduped.length === 0) {
    return { status: 'skipped', detail: 'No new patterns found', queued: [] };
  }

  const now = new Date().toISOString();
  const proposals: Proposal[] = deduped.map(p => ({
    draftedAt: now,
    type: 'skill_or_cron',
    title: p.title,
    rationale: p.rationale,
    ...(p.suggested_skill ? { suggested_skill: p.suggested_skill } : {}),
    ...(p.suggested_cron ? { suggested_cron: p.suggested_cron } : {}),
    status: 'pending',
  }));

  appendProposals(proposals);
  log.info(`Queued ${proposals.length} proposal(s)`, { titles: proposals.map(p => p.title) });

  if (bot) {
    const summary = [
      `Ask-Twice scan drafted ${proposals.length} proposal(s):`,
      ...proposals.map(p => `• ${p.title} — ${p.rationale}`),
      '',
      'Review in your next /weekly.',
    ].join('\n');
    try {
      await sendLongMessage(bot, config.TELEGRAM_USER_ID, summary);
    } catch (err) {
      log.warn('Failed to post scan summary to Telegram', { error: (err as Error).message });
    }
  }

  return {
    status: 'success',
    detail: `${proposals.length} proposal(s) queued`,
    queued: proposals,
  };
}
