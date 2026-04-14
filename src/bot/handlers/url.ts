import type TelegramBot from 'node-telegram-bot-api';
import { runAgent } from '../../ai/claude.js';
import { writeVaultFile } from '../../vault/files.js';
import { appendToJournal } from '../../vault/journal.js';
import { enqueue } from '../../kb/queue.js';
import { getTimestamp } from '../../utils/time.js';
import { sendLongMessage, startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { saveToReadwise } from '../../integrations/readwise/client.js';
import { createLogger } from '../../utils/logger.js';
import config from '../../config.js';

const log = createLogger('url-handler');

const URL_REGEX = /https?:\/\/[^\s)>\]]+/g;
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
  return [...text.matchAll(new RegExp(URL_REGEX))].map((m) => m[0]);
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
      headers: { 'User-Agent': 'Jarvis/1.0 (Personal Knowledge Bot)' },
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

export function parseTriageResult(text: string): TriageResult | null {
  const lines = text.split('\n');
  const get = (prefix: string): string | undefined =>
    lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim();

  const classification = get('CLASSIFICATION:');
  const title = get('TITLE:');
  const reasoning = get('REASONING:');
  const guidance = get('GUIDANCE:');

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

async function routeKBIngest(url: string, title: string, content: string, guidance: string | undefined, bot: TelegramBot, chatId: number): Promise<void> {
  const filename = `${sanitizeFilename(title)}.md`;
  const vaultPath = `knowledge/raw/articles/${filename}`;
  writeVaultFile(vaultPath, formatAsMarkdown(url, title, content));
  enqueue(vaultPath, guidance);
  await bot.sendMessage(chatId, `Queued for KB: ${title}\n\nRun /ingest to process now.`);
}

async function routeReadwise(url: string, title: string, content: string, bot: TelegramBot, chatId: number): Promise<void> {
  const filename = `${sanitizeFilename(title)}.md`;
  const vaultPath = `Readwise/Articles/${filename}`;
  writeVaultFile(vaultPath, formatAsMarkdown(url, title, content));

  const apiResult = await saveToReadwise(url, title);
  const apiNote = apiResult.success ? ' + Readwise API' : '';
  await bot.sendMessage(chatId, `Saved to Readwise${apiNote}: ${title}`);
}

async function routeJournal(url: string, title: string, reasoning: string, bot: TelegramBot, chatId: number): Promise<void> {
  const ts = getTimestamp();
  appendToJournal(`- ${ts} [${title}](${url})\n\t- ${reasoning}`);
  await bot.sendMessage(chatId, `Logged to journal: ${title}`);
}

export async function handleURLMessage(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  const urls = extractURLs(text);
  const url = urls[0];
  if (!url) return;

  const userContext = text.replace(url, '').trim();

  const typing = startTyping(bot, chatId);
  try {
    const content = await fetchContent(url);

    const contextNote = userContext ? `\n\nUser context: "${userContext}"` : '';
    const prompt = `Classify this shared URL content and recommend how to route it.

URL: ${url}
${contextNote}

Fetched content:
---
${content}
---`;

    const result = await runAgent('content-triager', prompt);
    stopTyping(typing);

    if (result.error || !result.text) {
      log.error('Triage agent failed', { url, error: result.error });
      await bot.sendMessage(chatId, `Triage failed: ${result.error || 'empty response'}`);
      return;
    }

    const triage = parseTriageResult(result.text);
    if (!triage) {
      log.error('Failed to parse triage result', { url, raw: result.text });
      await sendLongMessage(bot, chatId, `Triage result (unparsed):\n\n${result.text}`);
      return;
    }

    log.info('URL triaged', { url, classification: triage.classification, title: triage.title });

    switch (triage.classification) {
      case 'kb-ingest':
        await routeKBIngest(url, triage.title, content, triage.guidance, bot, chatId);
        break;
      case 'readwise':
        await routeReadwise(url, triage.title, content, bot, chatId);
        break;
      case 'journal':
        await routeJournal(url, triage.title, triage.reasoning, bot, chatId);
        break;
      case 'skip':
        await bot.sendMessage(chatId, `Skipped: ${triage.reasoning}`);
        break;
    }
  } catch (err) {
    stopTyping(typing);
    log.error('URL handler error', { url, error: (err as Error).message });
    await bot.sendMessage(chatId, `Error processing URL: ${(err as Error).message}`);
  }
}
