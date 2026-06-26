import type { MessageSender } from '../../transport/sender.js';
import { runAgent } from '../../ai/claude.js';
import { writeVaultFile } from '../../vault/files.js';
import { appendToJournal } from '../../vault/journal.js';
import { enqueue } from '../../kb/queue.js';
import { getTimestamp } from '../../utils/time.js';
import { saveToReadwise } from '../../integrations/readwise/client.js';
import { createLogger } from '../../utils/logger.js';
import config from '../../config.js';

const log = createLogger('url-handler');

const URL_REGEX = /https?:\/\/[^\s)>\]]+/;
const MAX_CONTENT_LENGTH = 10_000;
const FETCH_TIMEOUT_MS = 15_000;

interface TriageResult {
  classification: 'kb-ingest' | 'readwise' | 'journal' | 'skip';
  title: string;
  reasoning: string;
  guidance?: string;
}

export function containsURL(text: string): boolean {
  return URL_REGEX.test(text);
}

export function extractURLs(text: string): string[] {
  return [...text.matchAll(new RegExp(URL_REGEX, 'g'))].map((m) => m[0]);
}

function sanitizeFilename(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/-$/, '');
}

function stripHTML(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchContent(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Rune/1.0 (Personal Knowledge Bot)' },
      redirect: 'follow',
    });

    if (!response.ok) {
      return `[Failed to fetch: HTTP ${response.status}]`;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/') && !contentType.includes('application/json')) {
      return `[Non-text content: ${contentType}]`;
    }

    const raw = await response.text();
    const text = contentType.includes('html') ? stripHTML(raw) : raw;

    if (text.length > MAX_CONTENT_LENGTH) {
      return text.slice(0, MAX_CONTENT_LENGTH) + '\n\n[truncated]';
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse the content-triager agent's structured output. The agent occasionally
 * dresses fields in markdown — `**CLASSIFICATION:**`, list markers, headings —
 * or varies case, so field matching tolerates that noise. Returns null when the
 * required fields are absent entirely (agent answered in free-form prose), which
 * the caller surfaces as an unparsed result rather than guessing.
 */
export function parseTriageResult(text: string): TriageResult | null {
  const lines = text.split('\n');

  // Match `FIELD: value`, allowing leading list/quote/heading markers and
  // `**bold**` around either the label or the value, case-insensitively.
  const fieldValue = (field: string): string | undefined => {
    // Hyphen escaped (not relying on end-of-class position) so the marker set
    // stays a literal list — `\s` whitespace, `>` quote, `#` heading, `*`/`+`/`-`
    // list bullets — and can't silently become a range under future edits.
    const re = new RegExp(`^[\\s>#*+\\-]*${field}\\s*\\**\\s*:\\s*\\**\\s*(.*)$`, 'i');
    for (const line of lines) {
      const m = line.match(re);
      if (m) return (m[1] ?? '').replace(/^\*+|\*+$/g, '').trim();
    }
    return undefined;
  };

  // Take the first token so trailing commentary ("kb-ingest — high value")
  // still resolves to a category.
  const classification = fieldValue('CLASSIFICATION')?.toLowerCase().split(/[\s,]+/)[0];
  const title = fieldValue('TITLE');
  const reasoning = fieldValue('REASONING');
  const guidance = fieldValue('GUIDANCE');

  if (!classification || !title || !reasoning) return null;
  if (!['kb-ingest', 'readwise', 'journal', 'skip'].includes(classification)) return null;

  return {
    classification: classification as TriageResult['classification'],
    title,
    reasoning,
    guidance: guidance || undefined,
  };
}

function formatAsMarkdown(url: string, title: string, content: string): string {
  return `# ${title}\n\nSource: ${url}\n\n${content}`;
}

/**
 * Run a vault-mutating operation for a triage route. On failure, logs the raw
 * error — which may include the absolute vault path (e.g. an `assertWithinVault`
 * rejection) — and sends the user only a sanitized message; the raw error is
 * never forwarded to Telegram. Returns false when it threw so the caller aborts
 * before sending a success confirmation.
 */
async function persistOrNotify(
  mutate: () => void,
  userMessage: string,
  logContext: Record<string, unknown>,
  sender: MessageSender,
  userId: number,
): Promise<boolean> {
  try {
    mutate();
    return true;
  } catch (err) {
    log.error('Triage route vault mutation failed', {
      ...logContext,
      error: (err as Error).message,
    });
    await sender.send(userId, userMessage);
    return false;
  }
}

async function routeKBIngest(url: string, title: string, content: string, guidance: string | undefined, sender: MessageSender, userId: number): Promise<void> {
  const filename = `${sanitizeFilename(title)}.md`;
  const vaultPath = `knowledge/raw/articles/${filename}`;
  const ok = await persistOrNotify(
    () => {
      writeVaultFile(vaultPath, formatAsMarkdown(url, title, content));
      enqueue(vaultPath, guidance);
    },
    `Couldn't queue "${title}" for the knowledge base — vault write failed.`,
    { url, vaultPath },
    sender,
    userId,
  );
  if (!ok) return;
  await sender.send(userId, `Queued for KB: ${title}\n\nRun /ingest to process now.`);
}

async function routeReadwise(url: string, title: string, content: string, sender: MessageSender, userId: number): Promise<void> {
  const filename = `${sanitizeFilename(title)}.md`;
  const vaultPath = `Readwise/Articles/${filename}`;
  const ok = await persistOrNotify(
    () => writeVaultFile(vaultPath, formatAsMarkdown(url, title, content)),
    `Couldn't save "${title}" to Readwise — vault write failed.`,
    { url, vaultPath },
    sender,
    userId,
  );
  if (!ok) return;

  const apiResult = await saveToReadwise(url, title);
  const apiNote = apiResult.success ? ' + Readwise API' : '';
  await sender.send(userId, `Saved to Readwise${apiNote}: ${title}`);
}

async function routeJournal(url: string, title: string, reasoning: string, sender: MessageSender, userId: number): Promise<void> {
  const ts = getTimestamp();
  const ok = await persistOrNotify(
    () => appendToJournal(`- ${ts} [${title}](${url})\n\t- ${reasoning}`),
    `Couldn't log "${title}" to the journal — write failed.`,
    { url },
    sender,
    userId,
  );
  if (!ok) return;
  await sender.send(userId, `Logged to journal: ${title}`);
}

export async function handleURLMessage(sender: MessageSender, userId: number, text: string): Promise<void> {
  const urls = extractURLs(text);
  const url = urls[0];
  if (!url) return;

  const userContext = text.replace(url, '').trim();

  sender.startTyping(userId);
  try {
    const content = await fetchContent(url);

    // The user's note is a classification hint only — framed so the agent does
    // not slip into answering it conversationally and abandon the output format.
    const contextNote = userContext
      ? `\n\nNote the user typed alongside the link (use it only as a classification hint — do not answer or reply to it): "${userContext}"`
      : '';
    const prompt = `Classify the following shared URL for routing into the knowledge base.

URL: ${url}${contextNote}

Fetched content:
---
${content}
---

Respond with ONLY the structured triage format below — no preamble, no markdown, no prose, no conversational reply, nothing before or after these lines:

CLASSIFICATION: <kb-ingest|readwise|journal|skip>
TITLE: <extracted or inferred title>
REASONING: <1-2 sentences explaining the classification>
GUIDANCE: <kb-ingest only — what the wiki-compiler should focus on; omit otherwise>`;

    const result = await runAgent('content-triager', prompt);
    sender.stopTyping(userId);

    if (result.error || !result.text) {
      log.error('Triage agent failed', { url, error: result.error });
      await sender.send(userId, `Triage failed: ${result.error || 'empty response'}`);
      return;
    }

    const triage = parseTriageResult(result.text);
    if (!triage) {
      log.error('Failed to parse triage result', { url, raw: result.text });
      await sender.send(userId, `Triage result (unparsed):\n\n${result.text}`);
      return;
    }

    log.info('URL triaged', { url, classification: triage.classification, title: triage.title });

    switch (triage.classification) {
      case 'kb-ingest':
        await routeKBIngest(url, triage.title, content, triage.guidance, sender, userId);
        break;
      case 'readwise':
        await routeReadwise(url, triage.title, content, sender, userId);
        break;
      case 'journal':
        await routeJournal(url, triage.title, triage.reasoning, sender, userId);
        break;
      case 'skip':
        await sender.send(userId, `Skipped: ${triage.reasoning}`);
        break;
    }
  } catch (err) {
    sender.stopTyping(userId);
    log.error('URL handler error', { url, error: (err as Error).message });
    await sender.send(userId, `Error processing URL: ${(err as Error).message}`);
  }
}
