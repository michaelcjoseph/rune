import { registerReviewHandler } from './orchestrator.js';
import { updateReviewSession } from './session.js';
import type { ReviewSession } from './session.js';
import type { MessageSender } from '../transport/sender.js';
import { askClaudeOneShot, runAgent } from '../ai/claude.js';
import { readVaultFile } from '../vault/files.js';
import { gitCommitAndPush } from '../vault/git.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('daily-review');

/** Convert YYYY-MM-DD to YYYY_MM_DD.md journal filename */
function toJournalFilename(date: string): string {
  return date.replace(/-/g, '_') + '.md';
}

const KNOWN_JSON_FILES = [
  'pages/books.json — book log',
  'pages/crm.json — contact interactions',
  'pages/places.json — places visited',
  'health/workouts.json — workout log',
  'study/progress.json — study progress',
  'career/applications.json — job applications',
  'investments/investments.json — investment tracking',
];

async function start(session: ReviewSession, sender: MessageSender): Promise<void> {
  const filename = toJournalFilename(session.targetDate);
  const content = readVaultFile(`journals/${filename}`);

  if (!content?.trim()) {
    await sender.send(session.chatId, `No journal found for ${session.targetDate}. Nothing to process.`);
    updateReviewSession(session.chatId, { phase: 'done' });
    return;
  }

  await sender.send(session.chatId, `Reading journal for ${session.targetDate}...`);
  sender.startTyping(session.chatId);

  try {
    const prompt = `Analyze this journal entry and identify all inline tags (words prefixed with #, like #workout, #crm, #place, #books, #priorities, etc.). For each tagged item, extract the relevant data from the surrounding text and propose a JSON update.

Known JSON data files:
${KNOWN_JSON_FILES.map(f => `- ${f}`).join('\n')}

Journal entry for ${session.targetDate}:
---
${content}
---

For each tag found, output a proposed update in this format:

**#tagname** → target file
- Data to add/update: [extracted details]

If no actionable tags are found (i.e., nothing that maps to a JSON data file), say "No JSON updates needed." and briefly summarize what was in the journal.

Be concise. Only propose updates for tags that clearly map to a data file.`;

    const result = await askClaudeOneShot(prompt, undefined, 'review:daily');
    sender.stopTyping(session.chatId);

    if (result.error || !result.text) {
      log.error('Failed to analyze journal', { error: result.error, date: session.targetDate });
      await sender.send(session.chatId, `Failed to analyze journal: ${result.error || 'empty response'}`);
      updateReviewSession(session.chatId, { phase: 'done' });
      return;
    }

    if (result.text.includes('No JSON updates needed')) {
      await sender.send(session.chatId, result.text);
      updateReviewSession(session.chatId, { phase: 'done' });
      return;
    }

    updateReviewSession(session.chatId, { prepContext: result.text, phase: 'approval' });
    await sender.send(session.chatId, result.text + '\n\nReply *yes* to apply these updates or *cancel* to skip.');
  } catch (err) {
    sender.stopTyping(session.chatId);
    throw err;
  }
}

async function handleMessage(session: ReviewSession, text: string, sender: MessageSender): Promise<void> {
  if (session.phase === 'approval') {
    return handleApproval(session, text, sender);
  }

  log.warn('Unexpected message in daily review', { phase: session.phase, chatId: session.chatId });
}

async function handleApproval(session: ReviewSession, text: string, sender: MessageSender): Promise<void> {
  const lower = text.toLowerCase().trim();

  if (['yes', 'y', 'approve', 'confirm', 'ok'].includes(lower)) {
    await sender.send(session.chatId, 'Applying updates...');
    sender.startTyping(session.chatId);

    try {
      updateReviewSession(session.chatId, { phase: 'updates' });

      const agentPrompt = `Apply the following proposed JSON updates to the vault data files. Read each target file first to understand its structure, then add the new entries.

Proposed updates:
${session.prepContext}

Date context: ${session.targetDate}`;

      const result = await runAgent('json-updater', agentPrompt);
      sender.stopTyping(session.chatId);

      if (result.error) {
        log.error('json-updater agent failed', { error: result.error });
        await sender.send(session.chatId, `JSON update failed: ${result.error}`);
        updateReviewSession(session.chatId, { phase: 'done' });
        return;
      }

      await gitCommitAndPush(`Daily review: ${session.targetDate}`);
      updateReviewSession(session.chatId, { phase: 'done' });
      await sender.send(session.chatId, `Daily review complete.\n\n${result.text || 'Updates applied.'}`);
    } catch (err) {
      sender.stopTyping(session.chatId);
      throw err;
    }
  } else if (['no', 'n', 'cancel', 'skip'].includes(lower)) {
    updateReviewSession(session.chatId, { phase: 'done' });
    await sender.send(session.chatId, 'Daily review cancelled.');
  } else {
    await sender.send(session.chatId, 'Reply *yes* to apply updates or *cancel* to skip.');
  }
}

export const dailyHandler = { start, handleMessage };

registerReviewHandler('daily', dailyHandler);
