import TelegramBot from 'node-telegram-bot-api';
import { registerReviewHandler } from './orchestrator.js';
import { updateReviewSession } from './session.js';
import type { ReviewSession } from './session.js';
import { askClaudeWithContext, askClaudeOneShot, runAgent } from '../ai/claude.js';
import { readVaultFile } from '../vault/files.js';
import { gitCommitAndPush } from '../vault/git.js';
import { sendLongMessage, startTyping, stopTyping } from '../integrations/telegram/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('weekly-review');

const OUTLINE_MARKER = 'week in review outline:';
const SKILL_PATH = '.claude/skills/weekly/SKILL.md';

/** Convert YYYY-MM-DD to YYYY_MM_DD for scanner agent prompts */
function toScannerDate(isoDate: string): string {
  return isoDate.replace(/-/g, '_');
}

/** Get Saturday (start of review week) from Friday target date */
function getWeekSaturday(fridayDate: string): string {
  const parts = fridayDate.split('-').map(Number) as [number, number, number];
  const friday = new Date(parts[0], parts[1] - 1, parts[2]);
  const saturday = new Date(friday);
  saturday.setDate(friday.getDate() - 6);
  const year = saturday.getFullYear();
  const month = String(saturday.getMonth() + 1).padStart(2, '0');
  const day = String(saturday.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Extract interview instructions (Steps 2-3) from the full SKILL.md */
function extractInterviewInstructions(skillContent: string): string {
  const step2Start = skillContent.indexOf('## Step 2: Interview');
  const step4Start = skillContent.indexOf('## Step 4:');
  if (step2Start === -1) return skillContent;
  const end = step4Start !== -1 ? step4Start : skillContent.length;
  return skillContent.slice(step2Start, end).trim();
}

/** Detect outline in Claude's response */
export function detectOutline(response: string): string | null {
  const lower = response.toLowerCase();
  const idx = lower.indexOf(OUTLINE_MARKER);
  if (idx === -1) return null;
  return response.slice(idx).trim();
}

/** Build system prompt for the interview session */
function buildSystemPrompt(session: ReviewSession, prepContext: string, skillInstructions: string): string {
  const saturday = getWeekSaturday(session.targetDate);
  return `You are conducting a weekly review interview. This review covers the week of ${saturday} to ${session.targetDate}.

## Context from Prep Agents

${prepContext}

## Interview Instructions

${skillInstructions}`;
}

// Store the system prompt per session so we can reuse it across handleMessage calls
const sessionPrompts = new Map<string, string>();

async function start(session: ReviewSession, bot: TelegramBot): Promise<void> {
  const friday = session.targetDate;
  const saturday = getWeekSaturday(friday);

  await bot.sendMessage(session.chatId, `Starting weekly review for ${saturday} to ${friday}. Running prep agents...`);
  const typing = startTyping(bot, session.chatId);

  try {
    // Spawn scanner agents in parallel
    const [journalResult, systemResult] = await Promise.all([
      runAgent('journal-scanner', `start_date: ${toScannerDate(saturday)}, end_date: ${toScannerDate(friday)}, focus_areas: [family, projects, tags, emotions, study, health, ideas, playbook, psychology, reading, unresolved]`),
      runAgent('system-scanner', `systems: [health, study, psychology]`),
    ]);

    if (journalResult.error && systemResult.error) {
      stopTyping(typing);
      log.error('Both prep agents failed', { journalError: journalResult.error, systemError: systemResult.error });
      await bot.sendMessage(session.chatId, 'Prep agents failed. Cannot start review.');
      updateReviewSession(session.chatId, { phase: 'done' });
      return;
    }

    const prepContext = [
      '# Journal Scanner Results',
      journalResult.text || `(journal-scanner failed: ${journalResult.error})`,
      '',
      '# System Scanner Results',
      systemResult.text || `(system-scanner failed: ${systemResult.error})`,
    ].join('\n');

    updateReviewSession(session.chatId, { prepContext });

    // Load interview instructions from vault skill
    const skillContent = readVaultFile(SKILL_PATH);
    const skillInstructions = skillContent
      ? extractInterviewInstructions(skillContent)
      : 'Conduct a weekly review interview covering: last week\'s goals, project updates, study, memories, reflection, health, and next week\'s priorities. End by presenting a "Week in Review outline:" with key points for each section.';

    const systemPrompt = buildSystemPrompt(session, prepContext, skillInstructions);
    sessionPrompts.set(session.claudeSessionId, systemPrompt);

    // Start the interview with Claude
    const result = await askClaudeWithContext(
      'Let\'s begin the weekly review.',
      session.claudeSessionId,
      systemPrompt,
    );
    stopTyping(typing);

    if (result.error) {
      log.error('Interview start failed', { error: result.error });
      await bot.sendMessage(session.chatId, `Failed to start interview: ${result.error}`);
      updateReviewSession(session.chatId, { phase: 'done' });
      return;
    }

    updateReviewSession(session.chatId, { phase: 'interview' });
    await sendLongMessage(bot, session.chatId, result.text || 'Interview started.');
  } catch (err) {
    stopTyping(typing);
    throw err;
  }
}

async function handleMessage(session: ReviewSession, text: string, bot: TelegramBot): Promise<void> {
  switch (session.phase) {
    case 'interview':
      return handleInterview(session, text, bot);
    case 'approval':
      return handleApproval(session, text, bot);
    case 'writeup':
    case 'updates':
      await bot.sendMessage(session.chatId, 'Still processing... please wait.');
      return;
    default:
      log.warn('Unexpected message in weekly review', { phase: session.phase, chatId: session.chatId });
  }
}

async function handleInterview(session: ReviewSession, text: string, bot: TelegramBot): Promise<void> {
  let systemPrompt = sessionPrompts.get(session.claudeSessionId);
  if (!systemPrompt) {
    // Reconstruct from persisted prepContext (e.g., after process restart)
    if (session.prepContext) {
      log.info('Reconstructing system prompt from persisted prepContext', { sessionId: session.claudeSessionId });
      const skillContent = readVaultFile(SKILL_PATH);
      const skillInstructions = skillContent
        ? extractInterviewInstructions(skillContent)
        : 'Conduct a weekly review interview covering: last week\'s goals, project updates, study, memories, reflection, health, and next week\'s priorities. End by presenting a "Week in Review outline:" with key points for each section.';
      systemPrompt = buildSystemPrompt(session, session.prepContext, skillInstructions);
      sessionPrompts.set(session.claudeSessionId, systemPrompt);
    } else {
      log.error('Missing system prompt and prepContext for session', { sessionId: session.claudeSessionId });
      await bot.sendMessage(session.chatId, 'Session error — review context lost. Try starting a new review with /weekly.');
      updateReviewSession(session.chatId, { phase: 'done' });
      return;
    }
  }

  const typing = startTyping(bot, session.chatId);
  try {
    const result = await askClaudeWithContext(text, session.claudeSessionId, systemPrompt);
    stopTyping(typing);

    if (result.error) {
      log.error('Interview message failed', { error: result.error });
      await bot.sendMessage(session.chatId, `Error: ${result.error}`);
      return;
    }

    const responseText = result.text || '';
    const outline = detectOutline(responseText);
    if (outline) {
      updateReviewSession(session.chatId, { outline, phase: 'approval' });
      await sendLongMessage(bot, session.chatId, responseText);
      await bot.sendMessage(session.chatId, '\nReply *yes* to approve this outline, *cancel* to stop, or send edits.');
    } else {
      await sendLongMessage(bot, session.chatId, responseText);
    }
  } catch (err) {
    stopTyping(typing);
    throw err;
  }
}

async function handleApproval(session: ReviewSession, text: string, bot: TelegramBot): Promise<void> {
  const lower = text.toLowerCase().trim();

  if (['yes', 'y', 'approve', 'confirm', 'ok'].includes(lower)) {
    await runWriteupAndUpdates(session, bot);
  } else if (['no', 'n', 'cancel', 'skip'].includes(lower)) {
    updateReviewSession(session.chatId, { phase: 'done' });
    sessionPrompts.delete(session.claudeSessionId);
    await bot.sendMessage(session.chatId, 'Weekly review cancelled.');
  } else {
    // Treat as edited outline
    updateReviewSession(session.chatId, { outline: text });
    await bot.sendMessage(session.chatId, 'Outline updated. Reply *yes* to approve or *cancel* to stop.');
  }
}

async function runWriteupAndUpdates(session: ReviewSession, bot: TelegramBot): Promise<void> {
  updateReviewSession(session.chatId, { phase: 'writeup' });
  await bot.sendMessage(session.chatId, 'Writing review...');
  const typing = startTyping(bot, session.chatId);

  try {
    // Step 1: Spawn review-writer
    const writerResult = await runAgent('review-writer', `review_type: weekly
target_date: ${session.targetDate}
approved_outline: ${session.outline}
conversation_context: ${session.prepContext}`);

    if (writerResult.error) {
      log.error('review-writer failed', { error: writerResult.error });
      stopTyping(typing);
      await bot.sendMessage(session.chatId, `Review write-up failed: ${writerResult.error}`);
      updateReviewSession(session.chatId, { phase: 'done' });
      sessionPrompts.delete(session.claudeSessionId);
      return;
    }

    // Step 2: Determine and run post-interview agents
    updateReviewSession(session.chatId, { phase: 'updates' });

    const analysisResult = await askClaudeOneShot(`Based on this weekly review prep context and approved outline, determine which post-interview updates are needed. Reply with a JSON object containing boolean fields: "projects", "psychology", "json_updates".

Set "projects" to true if active projects were discussed with meaningful updates (thesis changes, new risks, decisions).
Set "psychology" to true if psychological patterns were observed or challenged.
Set "json_updates" to true if trackable items were mentioned (#workout, #book, #crm, #place, etc.).

Prep context:
${session.prepContext}

Approved outline:
${session.outline}

Reply ONLY with the JSON object, nothing else.`);

    let updates = { projects: false, psychology: false, json_updates: false };
    if (analysisResult.text) {
      try {
        const parsed = JSON.parse(analysisResult.text.replace(/```json?\n?|\n?```/g, '').trim());
        updates = { ...updates, ...parsed };
      } catch {
        log.warn('Failed to parse update analysis, running all agents', { text: analysisResult.text });
        updates = { projects: true, psychology: true, json_updates: true };
      }
    }

    const agentResults: Record<string, boolean> = {};

    const agentPromises: Promise<void>[] = [];

    if (updates.projects) {
      agentPromises.push(
        runAgent('project-updater', `Update project pages based on this weekly review.\n\nPrep context:\n${session.prepContext}\n\nOutline:\n${session.outline}`)
          .then(r => { agentResults.projects = !r.error; if (r.error) log.error('project-updater failed', { error: r.error }); })
      );
    }

    if (updates.psychology) {
      agentPromises.push(
        runAgent('psychology-updater', `scope: observation\nchanges: Based on weekly review observations\nchangelog_entry: ${session.targetDate} weekly review\n\nPrep context:\n${session.prepContext}\n\nOutline:\n${session.outline}`)
          .then(r => { agentResults.psychology = !r.error; if (r.error) log.error('psychology-updater failed', { error: r.error }); })
      );
    }

    if (updates.json_updates) {
      agentPromises.push(
        runAgent('json-updater', `Apply any JSON data updates from this weekly review.\n\nPrep context:\n${session.prepContext}\n\nOutline:\n${session.outline}`)
          .then(r => { agentResults.json_updates = !r.error; if (r.error) log.error('json-updater failed', { error: r.error }); })
      );
    }

    if (agentPromises.length > 0) {
      await Promise.all(agentPromises);
    }

    try {
      gitCommitAndPush(`Weekly review: ${session.targetDate}`);
    } catch (err) {
      log.error('Git commit failed', { error: (err as Error).message });
    }

    stopTyping(typing);

    const agentSummary = [
      writerResult.text ? 'Review written to journal.' : null,
      agentResults.projects === true ? 'Project pages updated.' : agentResults.projects === false ? 'Project update failed.' : null,
      agentResults.psychology === true ? 'Psychology profile updated.' : agentResults.psychology === false ? 'Psychology update failed.' : null,
      agentResults.json_updates === true ? 'JSON data updated.' : agentResults.json_updates === false ? 'JSON update failed.' : null,
    ].filter(Boolean).join('\n');

    updateReviewSession(session.chatId, { phase: 'done' });
    sessionPrompts.delete(session.claudeSessionId);
    await sendLongMessage(bot, session.chatId, `Weekly review complete.\n\n${agentSummary}`);
  } catch (err) {
    stopTyping(typing);
    sessionPrompts.delete(session.claudeSessionId);
    throw err;
  }
}

export const weeklyHandler = { start, handleMessage };

registerReviewHandler('weekly', weeklyHandler);
