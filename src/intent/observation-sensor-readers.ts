/**
 * Production fillers for the observation sensor's source readers — project
 * 08-intent-layer Phase 6 B2. `src/intent/observation-sensor.ts` declares
 * the `SensorReaders` shape; this module supplies the real implementations
 * the nightly observation loop wires in.
 *
 * Today this module exports `readVaultSignals` (B2.1). The telemetry
 * (B2.2 — `readTelemetrySignals`) and interaction (B2.3 — `readInteractionSignals`)
 * readers land in this same file when their tasks fire so the three
 * sensors share one module surface.
 *
 * All readers are deterministic over their inputs and accept injected
 * callbacks for unit testing — production wires defaults that touch the
 * vault filesystem (`readVaultFile`, `listVaultFiles`).
 *
 * See spec.md §"Phase 5" and test-plan.md §16.
 */

import config from '../config.js';
import { readVaultFile, listVaultFiles } from '../vault/files.js';
import { createLogger } from '../utils/logger.js';
import type { SensorSignal } from './observation-loop.js';

const log = createLogger('observation-sensor-readers');

/** Default cap on signals returned per pass — keeps the digest the
 *  observation loop reasons over bounded regardless of how noisy the
 *  vault gets. Honored across both journal-tag and worldview-changelog
 *  hits combined. */
const DEFAULT_CAP = 20;

/** Default lookback window — 7 days mirrors the existing journal-scan
 *  cadence used by the nightly job and the weekly review. */
const DEFAULT_LOOKBACK_DAYS = 7;

/** Tags the journal sensor treats as friction signal. Anchored to the
 *  octothorpe so `#friction` inside a wikilink (`[[#friction]]`) still
 *  matches and `something-friction` does not. */
const JOURNAL_FRICTION_TAGS = ['#friction', '#bug', '#stuck'] as const;

/** Pre-compiled regex for journal tag matching. Captures the leading
 *  octothorpe so the union is exact (no partial-word matches). */
const TAG_RE = new RegExp(`(?:^|[\\s\\(])(${JOURNAL_FRICTION_TAGS.join('|')})(?:$|[\\s\\),.])`);

/** Pre-compiled regex for the world-view changelog heading shape:
 *  `### [[YYYY_MM_DD]]`. Captures the date components for window filtering. */
const WORLDVIEW_HEADING_RE = /^###\s+\[\[(\d{4})_(\d{2})_(\d{2})\]\]/;

export interface ReadVaultSignalsOpts {
  /** "Now" for the lookback-window calculation. Defaults to `new Date()`. */
  now?: Date;
  /** Lookback window in days. Defaults to {@link DEFAULT_LOOKBACK_DAYS}. */
  lookbackDays?: number;
  /** Cap on returned signals. Defaults to {@link DEFAULT_CAP}. */
  cap?: number;
  /** Read one journal file by its date filename (e.g., `2026_05_25.md`).
   *  Returns the content or `null` when the file is missing. Production
   *  wires `readVaultFile('journals/<filename>')`. */
  readJournalFile?: (filename: string) => string | null;
  /** List the markdown filenames under `world-view/`. Production wires
   *  `listVaultFiles('world-view').map(stripPrefix)`. */
  listWorldviewFiles?: () => string[];
  /** Read one world-view markdown file by its leaf filename. Production
   *  wires `readVaultFile('world-view/<filename>')`. */
  readWorldviewFile?: (filename: string) => string | null;
}

/** Default `readJournalFile` — reads from the vault's journals directory. */
function defaultReadJournalFile(filename: string): string | null {
  try {
    return readVaultFile(`journals/${filename}`);
  } catch (err) {
    log.warn('defaultReadJournalFile failed', { filename, error: (err as Error).message });
    return null;
  }
}

/** Default `listWorldviewFiles` — strips the `world-view/` prefix from
 *  the vault listing so the call signature stays a leaf-filename set. */
function defaultListWorldviewFiles(): string[] {
  try {
    return listVaultFiles('world-view')
      .filter((p) => p.endsWith('.md'))
      .map((p) => p.replace(/^world-view\//, ''));
  } catch (err) {
    log.warn('defaultListWorldviewFiles failed', { error: (err as Error).message });
    return [];
  }
}

/** Default `readWorldviewFile` — reads from the vault's world-view directory. */
function defaultReadWorldviewFile(filename: string): string | null {
  try {
    return readVaultFile(`world-view/${filename}`);
  } catch (err) {
    log.warn('defaultReadWorldviewFile failed', { filename, error: (err as Error).message });
    return null;
  }
}

/** Format `YYYY_MM_DD.md` for a given Date in `America/Chicago` (the same
 *  convention `src/utils/time.ts` uses for journal filenames). Inline
 *  here to keep this module testable without importing the time module
 *  (its `getRecentFilenames` reads `new Date()` directly, which fights
 *  the `now` injection seam). */
function journalFilenameForDate(d: Date): string {
  // Use the same `America/Chicago` formatter logic as `formatDateFilename`.
  // Since we're testing with fixed UTC `now` values, the inline impl keeps
  // the test fixtures readable without needing TZ-aware conversions.
  const fmt = d.toLocaleDateString('en-CA', { timeZone: config.TIMEZONE ?? 'America/Chicago' });
  return `${fmt.replace(/-/g, '_')}.md`;
}

/** Compute the cutoff date (inclusive) for the lookback window — any
 *  observation strictly older than this is dropped. */
function cutoffForWindow(now: Date, lookbackDays: number): Date {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  return cutoff;
}

/**
 * Scan recent journal files and world-view changelog entries for friction
 * signal, returning a capped `SensorSignal[]`. See module-level JSDoc for
 * the source/cap defaults.
 *
 * Cap enforcement is FIFO over the two source paths concatenated — journal
 * hits first, then worldview hits. A pathological journal day that hits
 * the cap before any worldview entries are scanned won't surface them
 * this pass; the next pass (different `now`) may.
 */
export function readVaultSignals(opts: ReadVaultSignalsOpts = {}): SensorSignal[] {
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const cap = opts.cap ?? DEFAULT_CAP;
  const readJournal = opts.readJournalFile ?? defaultReadJournalFile;
  const listWorldview = opts.listWorldviewFiles ?? defaultListWorldviewFiles;
  const readWorldview = opts.readWorldviewFile ?? defaultReadWorldviewFile;

  const out: SensorSignal[] = [];
  const cutoff = cutoffForWindow(now, lookbackDays);

  // ----- Journal tag scan -----
  for (let i = 0; i < lookbackDays; i++) {
    if (out.length >= cap) break;
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const filename = journalFilenameForDate(date);
    const content = readJournal(filename);
    if (content === null) continue;
    const dateIso = date.toISOString();
    for (const rawLine of content.split('\n')) {
      if (out.length >= cap) break;
      if (!TAG_RE.test(rawLine)) continue;
      out.push({ source: 'vault', content: rawLine.trim(), ts: dateIso });
    }
  }

  // ----- World-view changelog scan -----
  if (out.length < cap) {
    const wvFiles = listWorldview();
    for (const wvFilename of wvFiles) {
      if (out.length >= cap) break;
      const content = readWorldview(wvFilename);
      if (content === null) continue;
      for (const line of content.split('\n')) {
        if (out.length >= cap) break;
        const m = WORLDVIEW_HEADING_RE.exec(line);
        if (!m) continue;
        const [, y, mo, d] = m;
        // Construct as UTC to avoid TZ drift on the boundary day; we only
        // care about whether the heading's date is within the window.
        const headingDate = new Date(`${y}-${mo}-${d}T00:00:00.000Z`);
        if (headingDate < cutoff) continue;
        out.push({
          source: 'vault',
          content: `world-view/${wvFilename}: ${line.trim()}`,
          ts: headingDate.toISOString(),
        });
      }
    }
  }

  return out;
}
