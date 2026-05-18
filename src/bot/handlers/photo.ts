import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type TelegramBot from 'node-telegram-bot-api';
import type { MessageSender } from '../../transport/sender.js';
import { runAgent } from '../../ai/claude.js';
import { writeVaultFile } from '../../vault/files.js';
import { appendToJournal } from '../../vault/journal.js';
import { enqueue } from '../../kb/queue.js';
import { getTimestamp } from '../../utils/time.js';
import { createLogger } from '../../utils/logger.js';
import config from '../../config.js';

const log = createLogger('photo-handler');

const PHOTOS_DIR = join(config.LOGS_DIR, 'photos');

type Route = 'journal' | 'kb-ingest' | 'data-update' | 'skip';

interface ClassifyResult {
  classification: string;
  route: Route;
  title: string;
  details: string;
  /** True when the classifier returned prose instead of the strict format and
   *  the synthesis fallback had to reconstruct fields. Surfaced so the caller
   *  can log at warn level — the photo is still routed, but the agent prompt
   *  is drifting. */
  recovered?: boolean;
}

const ROUTES: readonly Route[] = ['journal', 'kb-ingest', 'data-update', 'skip'];
const CATEGORIES = [
  'book', 'receipt', 'whiteboard', 'screenshot', 'document',
  'food', 'place', 'person', 'other',
] as const;
type Category = typeof CATEGORIES[number];

/** Sonnet sometimes writes a caption tag in the classification slot
 *  (e.g. `Classification: #diet`) instead of the category. Map known
 *  *non-category* tags back to the category the agent prompt enumerates.
 *  Self-mappings (`food → food`, `book → book`, etc.) are intentionally
 *  omitted — the `CATEGORIES` loop in `normalizeCategory` handles those
 *  directly, so duplicating them here is dead. */
const TAG_TO_CATEGORY: Record<string, Category> = {
  diet: 'food',
  meal: 'food',
  books: 'book',
};

/** Strip markdown formatting characters that wrap a field value without
 *  dropping the value itself. Bold markers (`**`) are removed globally —
 *  Sonnet sometimes inlines `**Route:** Append to…`, and the `**` after the
 *  colon needs to go too. */
function stripMarkdown(s: string): string {
  return s
    .replace(/^\s*(?:#{1,6}\s+|>\s+|-\s+)/, '') // leading header/quote/bullet
    .replace(/\*\*/g, '')                       // any **bold** markers, anywhere
    .replace(/^`+|`+$/g, '')                    // surrounding backticks
    .replace(/`([^`]+)`/g, '$1')                // inline backticks
    .trim();
}

/** Extract the value of a labeled field anywhere in the text. Tolerates:
 *  - any case (`Classification:`, `CLASSIFICATION:`, `classification:`)
 *  - markdown wrapping (`**Classification:**`, `## Classification`)
 *  - inline-only labels (`**Classification: food**` — all on one line) */
function extractField(text: string, field: string): string | undefined {
  // Match `<optional formatting><field><optional formatting>:<value>`. The
  // value runs to end of line OR to a closing `**` if the whole label+value
  // was wrapped in bold. Case-insensitive on the field name.
  const pattern = new RegExp(
    `(?:^|\\n)\\s*[*#>\\s-]*\\*{0,2}\\s*${field}\\s*\\*{0,2}\\s*:\\s*([^\\n]+)`,
    'i',
  );
  const m = text.match(pattern);
  if (!m || !m[1]) return undefined;
  // The captured value may still have trailing `**` from a fully-bold label
  // (`**Classification: food**` → value = `food**`). Strip residual markers.
  return stripMarkdown(m[1]);
}

/** Normalize a raw classification string. Maps the enumerated categories,
 *  maps known tags (`#diet` → `food`), and otherwise returns the raw value
 *  as-is — the downstream switch on `data-update` route uses any non-empty
 *  classification verbatim as a `#<tag>`. Returns `undefined` only when the
 *  input itself is empty. */
function normalizeCategory(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();

  // Enumerated category match (`food`, `Food`, `food/meal photo` → starts with `food`).
  for (const cat of CATEGORIES) {
    if (lower === cat) return cat;
    if (lower.startsWith(cat) || lower.includes(` ${cat}`) || lower.includes(`/${cat}`)) return cat;
  }

  // Tag at start (`#diet`, `#diet — meal log`, etc.) — Sonnet sometimes writes
  // the user's caption tag in the category slot. Map known tags back to the
  // enumerated category they imply.
  const tagAtStart = lower.match(/^#?(\w+)/);
  if (tagAtStart && tagAtStart[1] && TAG_TO_CATEGORY[tagAtStart[1]]) {
    return TAG_TO_CATEGORY[tagAtStart[1]];
  }

  // Otherwise return the cleaned raw value. The data-update branch will use
  // it verbatim as a `#<value>` tag; the agent prompt enumerates the
  // expected categories but the handler has always accepted free-form
  // strings here so we don't tighten that contract.
  return raw;
}

/** Map a raw route string to one of the enumerated routes. Uses word-boundary
 *  matching — a value like `"journal-class only"` would not match `'journal'`
 *  because the route keyword must be followed by whitespace, punctuation, or
 *  end-of-string. */
function normalizeRoute(raw: string | undefined): Route | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase().trim();
  for (const r of ROUTES) {
    if (lower === r) return r;
    if (lower.startsWith(r) && /[\s.,;:!?]/.test(lower.charAt(r.length))) return r;
  }
  return undefined;
}

/** Best-effort reconstruction when the agent emitted prose and the labeled
 *  extractor couldn't find all four fields. Scans the response for category
 *  keywords, picks a sensible default route, and uses the response prose as
 *  title/details. The photo is logged rather than silently dropped.
 *
 *  `preserveRoute` carries forward a route value that Pass 1 successfully
 *  extracted — without this, a recovered route would be discarded and
 *  every fallback would default to `journal`. */
function synthesizeClassifyResult(text: string, preserveRoute?: Route): ClassifyResult | null {
  // Look anywhere in the text for a category keyword, with word-boundary
  // matching so `'other'` doesn't false-match "among other things" or
  // "no other information available".
  let category: Category | undefined;
  const lower = text.toLowerCase();
  for (const cat of CATEGORIES) {
    if (new RegExp(`\\b${cat}\\b`).test(lower)) { category = cat; break; }
  }
  // Tag mentions count too (`#diet` → food). These use the literal `#`
  // prefix so word-boundary isn't required.
  if (!category) {
    for (const [tag, cat] of Object.entries(TAG_TO_CATEGORY)) {
      if (lower.includes(`#${tag}`)) { category = cat; break; }
    }
  }
  if (!category) return null;

  // Title: first non-empty content line, with markdown stripped. Skip lines
  // that start with one of the known field/section keywords OR an ISO date
  // prefix (`2026-05-12: …`) — agent prose often includes a dated log-line
  // suggestion that would double-date the journal entry once `getTimestamp()`
  // prepends the time of day.
  const lines = text.split('\n').map(stripMarkdown).filter(Boolean);
  const isLabel = /^(classification|route|title|details|caption(?:\s+tag)?|routing(?:\s+recommendation)?|suggested|type|recommended)\b/i;
  const isDated = /^\d{4}-\d{2}-\d{2}\b/;
  const firstContentLine = lines.find((l) => !isLabel.test(l) && !isDated.test(l));
  const title = (firstContentLine ?? lines[0] ?? `Photo (${category})`).slice(0, 120);

  // Details: full cleaned text, truncated.
  const details = lines.join(' ').slice(0, 500);

  return {
    classification: category,
    route: preserveRoute ?? 'journal',
    title,
    details,
    recovered: true,
  };
}

function parseClassifyResult(text: string): ClassifyResult | null {
  // Pass 1: relaxed labeled extraction. Handles `CLASSIFICATION: food`,
  // `**Classification:** food`, `## Classification\nfood`, mixed case, etc.
  const rawCategory = extractField(text, 'classification');
  const rawRoute = extractField(text, 'route');
  const title = extractField(text, 'title');
  const details = extractField(text, 'details');

  const category = normalizeCategory(rawCategory);
  const route = normalizeRoute(rawRoute);

  // Happy path: all four fields recoverable.
  if (category && route && title && details) {
    return { classification: category, route, title, details };
  }

  // Pass 2: synthesis fallback. The agent emitted prose. Reconstruct.
  // Forward Pass-1's route if it was recovered, so a valid route survives
  // when only title/details were missing.
  return synthesizeClassifyResult(text, route);
}

// Returns the first #tag in the caption; first-wins is intentional (captions are short).
function extractCaptionTag(caption: string): string | null {
  const match = caption.match(/#(\w+)/);
  return match ? `#${match[1]}` : null;
}

async function downloadPhoto(bot: TelegramBot, fileId: string): Promise<string> {
  mkdirSync(PHOTOS_DIR, { recursive: true });
  const fileLink = await bot.getFileLink(fileId);
  const response = await fetch(fileLink);
  if (!response.ok) throw new Error(`Failed to download photo: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const filepath = join(PHOTOS_DIR, `${fileId}.jpg`);
  writeFileSync(filepath, buffer);
  return filepath;
}

function cleanupPhoto(filepath: string): void {
  try {
    unlinkSync(filepath);
  } catch {
    // Best effort cleanup
  }
}

export async function handlePhotoMessage(bot: TelegramBot, sender: MessageSender, msg: TelegramBot.Message): Promise<void> {
  if (msg.from?.id !== config.TELEGRAM_USER_ID) return;
  if (!msg.photo || msg.photo.length === 0) return;

  const userId = msg.chat.id;
  const caption = msg.caption?.trim() || '';
  // Last element is the highest resolution
  const photo = msg.photo[msg.photo.length - 1];
  if (!photo) return;

  sender.startTyping(userId);
  let filepath = '';

  try {
    filepath = await downloadPhoto(bot, photo.file_id);

    const captionNote = caption ? `\n\nUser caption: "${caption}"` : '';
    const prompt = `Classify this photo and recommend how to route it.

Photo file: ${filepath}

Read the image file above to see the photo.${captionNote}`;

    const result = await runAgent('photo-classifier', prompt);
    sender.stopTyping(userId);

    if (result.error || !result.text) {
      log.error('Photo classifier failed', { error: result.error });
      await sender.send(userId, `Classification failed: ${result.error || 'empty response'}`);
      return;
    }

    const classified = parseClassifyResult(result.text);
    if (!classified) {
      log.error('Failed to parse classification', { raw: result.text });
      await sender.send(userId, `Photo classified but couldn't parse result:\n\n${result.text}`);
      return;
    }

    if (classified.recovered) {
      // Agent emitted prose; the synthesis fallback reconstructed fields.
      // Warn (not error) — the photo is still routed, but the agent prompt
      // is drifting and worth surfacing for future tightening. Only
      // structural metadata is logged here — the raw agent response often
      // describes photo contents (meals, locations, people) which shouldn't
      // end up persisted in the structured log file.
      log.warn('Photo classification recovered via synthesis fallback', {
        classification: classified.classification,
        route: classified.route,
        rawLength: result.text.length,
      });
    } else {
      log.info('Photo classified', { classification: classified.classification, route: classified.route, title: classified.title });
    }

    const ts = getTimestamp();
    const captionTag = extractCaptionTag(caption);

    switch (classified.route) {
      case 'journal': {
        const prefix = captionTag ? `${captionTag} ` : '';
        appendToJournal(`- ${ts} ${prefix}${classified.title}\n\t- ${classified.details}`);
        await sender.send(userId, `Logged to journal${captionTag ? ` with ${captionTag}` : ''}: ${classified.title}`);
        break;
      }

      case 'kb-ingest': {
        const filename = `photo-${photo.file_id.slice(0, 12)}.md`;
        const vaultPath = `knowledge/raw/notes/${filename}`;
        writeVaultFile(vaultPath, `# ${classified.title}\n\n${classified.details}\n\nClassification: ${classified.classification}`);
        enqueue(vaultPath);
        await sender.send(userId, `Queued for KB: ${classified.title}\n\nRun /ingest to process now.`);
        break;
      }

      case 'data-update': {
        const classTag = classified.classification === 'book' ? '#books'
          : classified.classification === 'receipt' ? '#receipt'
          : `#${classified.classification}`;
        // Caption tag supplements the classification tag (e.g. #diet alongside #food),
        // but never replaces it — #books and #receipt are required for nightly routing.
        const tag = captionTag && captionTag !== classTag ? `${classTag} ${captionTag}` : classTag;
        appendToJournal(`- ${ts} ${tag} ${classified.title}\n\t- ${classified.details}`);
        await sender.send(userId, `Logged to journal with ${tag}: ${classified.title}\n\nWill be processed in nightly tag review.`);
        break;
      }

      case 'skip':
        await sender.send(userId, `Skipped: ${classified.details}`);
        break;
    }
  } catch (err) {
    sender.stopTyping(userId);
    log.error('Photo handler error', { error: (err as Error).message });
    await sender.send(userId, `Error processing photo: ${(err as Error).message}`);
  } finally {
    if (filepath) cleanupPhoto(filepath);
  }
}
