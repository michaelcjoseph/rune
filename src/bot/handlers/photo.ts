import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type TelegramBot from 'node-telegram-bot-api';
import { runAgent } from '../../ai/claude.js';
import { writeVaultFile } from '../../vault/files.js';
import { appendToJournal } from '../../vault/journal.js';
import { enqueue } from '../../kb/queue.js';
import { getTimestamp } from '../../utils/time.js';
import { startTyping, stopTyping } from '../../integrations/telegram/client.js';
import { createLogger } from '../../utils/logger.js';
import config from '../../config.js';

const log = createLogger('photo-handler');

const PHOTOS_DIR = join(config.LOGS_DIR, 'photos');

interface ClassifyResult {
  classification: string;
  route: 'journal' | 'kb-ingest' | 'data-update' | 'skip';
  title: string;
  details: string;
}

function parseClassifyResult(text: string): ClassifyResult | null {
  const lines = text.split('\n');
  const get = (prefix: string): string | undefined =>
    lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim();

  const classification = get('CLASSIFICATION:');
  const route = get('ROUTE:');
  const title = get('TITLE:');
  const details = get('DETAILS:');

  if (!classification || !route || !title || !details) return null;
  if (!['journal', 'kb-ingest', 'data-update', 'skip'].includes(route)) return null;

  return {
    classification,
    route: route as ClassifyResult['route'],
    title,
    details,
  };
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

export async function handlePhotoMessage(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  if (msg.from?.id !== config.TELEGRAM_USER_ID) return;
  if (!msg.photo || msg.photo.length === 0) return;

  const chatId = msg.chat.id;
  const caption = msg.caption?.trim() || '';
  // Last element is the highest resolution
  const photo = msg.photo[msg.photo.length - 1];
  if (!photo) return;

  const typing = startTyping(bot, chatId);
  let filepath = '';

  try {
    filepath = await downloadPhoto(bot, photo.file_id);

    const captionNote = caption ? `\n\nUser caption: "${caption}"` : '';
    const prompt = `Classify this photo and recommend how to route it.

Photo file: ${filepath}

Read the image file above to see the photo.${captionNote}`;

    const result = await runAgent('photo-classifier', prompt);
    stopTyping(typing);

    if (result.error || !result.text) {
      log.error('Photo classifier failed', { error: result.error });
      await bot.sendMessage(chatId, `Classification failed: ${result.error || 'empty response'}`);
      return;
    }

    const classified = parseClassifyResult(result.text);
    if (!classified) {
      log.error('Failed to parse classification', { raw: result.text });
      await bot.sendMessage(chatId, `Photo classified but couldn't parse result:\n\n${result.text}`);
      return;
    }

    log.info('Photo classified', { classification: classified.classification, route: classified.route, title: classified.title });

    const ts = getTimestamp();

    switch (classified.route) {
      case 'journal':
        appendToJournal(`- ${ts} ${classified.title}\n\t- ${classified.details}`);
        await bot.sendMessage(chatId, `Logged to journal: ${classified.title}`);
        break;

      case 'kb-ingest': {
        const filename = `photo-${photo.file_id.slice(0, 12)}.md`;
        const vaultPath = `knowledge/raw/notes/${filename}`;
        writeVaultFile(vaultPath, `# ${classified.title}\n\n${classified.details}\n\nClassification: ${classified.classification}`);
        enqueue(vaultPath);
        await bot.sendMessage(chatId, `Queued for KB: ${classified.title}\n\nRun /ingest to process now.`);
        break;
      }

      case 'data-update': {
        const tag = classified.classification === 'book' ? '#books'
          : classified.classification === 'receipt' ? '#receipt'
          : `#${classified.classification}`;
        appendToJournal(`- ${ts} ${tag} ${classified.title}\n\t- ${classified.details}`);
        await bot.sendMessage(chatId, `Logged to journal with ${tag}: ${classified.title}\n\nWill be processed in nightly tag review.`);
        break;
      }

      case 'skip':
        await bot.sendMessage(chatId, `Skipped: ${classified.details}`);
        break;
    }
  } catch (err) {
    stopTyping(typing);
    log.error('Photo handler error', { error: (err as Error).message });
    await bot.sendMessage(chatId, `Error processing photo: ${(err as Error).message}`);
  } finally {
    if (filepath) cleanupPhoto(filepath);
  }
}
