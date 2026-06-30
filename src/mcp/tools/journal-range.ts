import { errText, err, ok, type McpTextResult } from './types.js';

export interface IndexedLine {
  file: string;
  line: number;
  content: string;
}

export interface JournalRangeInput {
  startDate: string;
  endDate: string;
}

export interface JournalRangeDeps {
  getVaultIndexStatus: () => { ready: boolean; status: string };
  queryVaultIndex: (
    query: string,
    options?: { directory?: string; maxResults?: number },
  ) => IndexedLine[];
  searchVault: (
    query: string,
    options?: { directory?: string; maxResults?: number },
  ) => IndexedLine[];
  sanitizeError?: (message: string) => string;
}

interface JournalEntry {
  date: string;
  file: string;
  content: string;
}

const MAX_RANGE_DAYS = 31;
const JOURNAL_SCAN_LINE_CAP = 250_000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const JOURNAL_FILE_RE = /^journals\/(\d{4})_(\d{2})_(\d{2})\.md$/;
const WARMING_STATUSES = new Set(['building', 'not-ready']);

function parseIsoDate(value: string): Date | null {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function formatIsoDate(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function dateFromJournalFile(file: string): string | null {
  const match = JOURNAL_FILE_RE.exec(file);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function enumerateDates(start: Date, end: Date): string[] {
  const dates: string[] = [];
  for (
    let cursor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    cursor <= end.getTime();
    cursor += 24 * 60 * 60 * 1000
  ) {
    dates.push(formatIsoDate(new Date(cursor)));
  }
  return dates;
}

function validateRange(input: JournalRangeInput): { dates: string[] } | { error: string } {
  const start = parseIsoDate(input.startDate);
  const end = parseIsoDate(input.endDate);
  if (!start || !end) {
    return { error: 'startDate and endDate must be valid ISO dates in YYYY-MM-DD format.' };
  }

  if (start.getTime() > end.getTime()) {
    return { error: 'startDate must be on or before endDate.' };
  }

  const dates = enumerateDates(start, end);
  if (dates.length > MAX_RANGE_DAYS) {
    return { error: `journal_range supports at most ${MAX_RANGE_DAYS} days per request.` };
  }

  return { dates };
}

function buildPayload(
  input: JournalRangeInput,
  source: 'warm' | 'cold',
  dates: string[],
  lines: IndexedLine[],
): string {
  const requested = new Set(dates);
  const byDate = new Map<string, IndexedLine[]>();

  for (const line of lines) {
    const date = dateFromJournalFile(line.file);
    if (!date || !requested.has(date)) continue;
    const group = byDate.get(date) ?? [];
    group.push(line);
    byDate.set(date, group);
  }

  const entries: JournalEntry[] = [];
  const missingDates: string[] = [];
  for (const date of dates) {
    const dateLines = byDate.get(date);
    if (!dateLines?.length) {
      missingDates.push(date);
      continue;
    }

    dateLines.sort((a, b) => a.line - b.line);
    entries.push({
      date,
      file: dateLines[0]!.file,
      content: dateLines.map((line) => line.content).join('\n'),
    });
  }

  return JSON.stringify({
    startDate: input.startDate,
    endDate: input.endDate,
    source,
    maxRangeDays: MAX_RANGE_DAYS,
    entries,
    missingDates,
  }, null, 2);
}

export async function journalRange(
  input: JournalRangeInput,
  deps: JournalRangeDeps,
): Promise<McpTextResult> {
  const clean = deps.sanitizeError ?? ((s: string) => s);
  const validated = validateRange(input);
  if ('error' in validated) return err(validated.error);

  const status = deps.getVaultIndexStatus();
  if (!status.ready && !WARMING_STATUSES.has(status.status)) {
    return err(`vault index is not ready for journal_range (status: ${status.status}).`);
  }

  try {
    const source = status.ready ? 'warm' : 'cold';
    const reader = status.ready ? deps.queryVaultIndex : deps.searchVault;
    const lines = reader('', {
      directory: 'journals',
      maxResults: JOURNAL_SCAN_LINE_CAP,
    });

    return ok(buildPayload(input, source, validated.dates, lines));
  } catch (unexpected) {
    return err(`journal_range failed: ${clean(errText(unexpected))}`);
  }
}
