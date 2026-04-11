import TelegramBot from 'node-telegram-bot-api';
import { updateReviewSession } from './session.js';
import type { ReviewSession, ReviewType } from './session.js';
import type { ReviewTypeHandler } from './orchestrator.js';
import { askClaudeWithContext, askClaudeOneShot, runAgent } from '../ai/claude.js';
import { readVaultFile } from '../vault/files.js';
import { gitCommitAndPush } from '../vault/git.js';
import { sendLongMessage, startTyping, stopTyping } from '../integrations/telegram/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('interview-review');

export interface PrepAgentCall {
  agent: string;
  prompt: string;
  label: string;  // for prepContext headers, e.g. "Journal Scanner (Month 1)"
}

export interface InterviewReviewConfig {
  type: ReviewType;
  outlineMarker: string;
  skillPath: string;
  defaultInstructions: string;
  buildPromptHeader: (session: ReviewSession) => string;
  prepAgents: (session: ReviewSession) => PrepAgentCall[];
  postAgents: 'dynamic' | 'psychology-only';
  psychologyScope: string;
}

/** Convert YYYY-MM-DD to YYYY_MM_DD for scanner agent prompts */
export function toScannerDate(isoDate: string): string {
  return isoDate.replace(/-/g, '_');
}

/** Extract interview instructions (Steps 2-3) from the full SKILL.md */
function extractInterviewInstructions(skillContent: string): string {
  const step2Start = skillContent.indexOf('## Step 2: Interview');
  const step4Start = skillContent.indexOf('## Step 4:');
  if (step2Start === -1) return skillContent;
  const end = step4Start !== -1 ? step4Start : skillContent.length;
  return skillContent.slice(step2Start, end).trim();
}

/** Detect outline in Claude's response using a case-insensitive marker */
export function detectOutline(response: string, marker: string): string | null {
  const lower = response.toLowerCase();
  const idx = lower.indexOf(marker.toLowerCase());
  if (idx === -1) return null;
  return response.slice(idx).trim();
}

// Store the system prompt per session for multi-turn reuse
const sessionPrompts = new Map<string, string>();

function buildSystemPrompt(session: ReviewSession, prepContext: string, skillInstructions: string, promptHeader: string): string {
  return `${promptHeader}

## Context from Prep Agents

${prepContext}

## Interview Instructions

${skillInstructions}`;
}

function getSkillInstructions(config: InterviewReviewConfig): string {
  const skillContent = readVaultFile(config.skillPath);
  return skillContent
    ? extractInterviewInstructions(skillContent)
    : config.defaultInstructions;
}

export function createInterviewHandler(config: InterviewReviewConfig): ReviewTypeHandler {
  async function start(session: ReviewSession, bot: TelegramBot): Promise<void> {
    await bot.sendMessage(session.chatId, `Starting ${config.type} review. Running prep agents...`);
    const typing = startTyping(bot, session.chatId);

    try {
      const prepCalls = config.prepAgents(session);
      const results = await Promise.all(
        prepCalls.map(call => runAgent(call.agent, call.prompt))
      );

      // Check if ALL agents failed
      if (results.every(r => !!r.error)) {
        stopTyping(typing);
        log.error('All prep agents failed', { type: config.type });
        await bot.sendMessage(session.chatId, 'Prep agents failed. Cannot start review.');
        updateReviewSession(session.chatId, { phase: 'done' });
        return;
      }

      const prepContext = results.map((r, i) => {
        const call = prepCalls[i]!;
        return `# ${call.label}\n${r.text || `(${call.agent} failed: ${r.error})`}`;
      }).join('\n\n');

      updateReviewSession(session.chatId, { prepContext });

      const skillInstructions = getSkillInstructions(config);
      const promptHeader = config.buildPromptHeader(session);
      const systemPrompt = buildSystemPrompt(session, prepContext, skillInstructions, promptHeader);
      sessionPrompts.set(session.claudeSessionId, systemPrompt);

      const result = await askClaudeWithContext(
        `Let's begin the ${config.type} review.`,
        session.claudeSessionId,
        systemPrompt,
      );
      stopTyping(typing);

      if (result.error) {
        log.error('Interview start failed', { error: result.error, type: config.type });
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
        log.warn('Unexpected message in review', { phase: session.phase, type: config.type, chatId: session.chatId });
    }
  }

  async function handleInterview(session: ReviewSession, text: string, bot: TelegramBot): Promise<void> {
    let systemPrompt = sessionPrompts.get(session.claudeSessionId);
    if (!systemPrompt) {
      if (session.prepContext) {
        log.info('Reconstructing system prompt from persisted prepContext', { sessionId: session.claudeSessionId });
        const skillInstructions = getSkillInstructions(config);
        const promptHeader = config.buildPromptHeader(session);
        systemPrompt = buildSystemPrompt(session, session.prepContext, skillInstructions, promptHeader);
        sessionPrompts.set(session.claudeSessionId, systemPrompt);
      } else {
        log.error('Missing system prompt and prepContext', { sessionId: session.claudeSessionId });
        await bot.sendMessage(session.chatId, `Session error — review context lost. Try starting a new /${config.type} review.`);
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
      const outline = detectOutline(responseText, config.outlineMarker);
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
      await bot.sendMessage(session.chatId, `${capitalize(config.type)} review cancelled.`);
    } else {
      updateReviewSession(session.chatId, { outline: text });
      await bot.sendMessage(session.chatId, 'Outline updated. Reply *yes* to approve or *cancel* to stop.');
    }
  }

  async function runWriteupAndUpdates(session: ReviewSession, bot: TelegramBot): Promise<void> {
    updateReviewSession(session.chatId, { phase: 'writeup' });
    await bot.sendMessage(session.chatId, 'Writing review...');
    const typing = startTyping(bot, session.chatId);

    try {
      const writerResult = await runAgent('review-writer', `review_type: ${config.type}
target_date: ${session.targetDate}
approved_outline: ${session.outline}
conversation_context: ${session.prepContext}`);

      if (writerResult.error) {
        log.error('review-writer failed', { error: writerResult.error, type: config.type });
        stopTyping(typing);
        await bot.sendMessage(session.chatId, `Review write-up failed: ${writerResult.error}`);
        updateReviewSession(session.chatId, { phase: 'done' });
        sessionPrompts.delete(session.claudeSessionId);
        return;
      }

      updateReviewSession(session.chatId, { phase: 'updates' });

      const agentResults: Record<string, boolean> = {};
      const agentPromises: Promise<void>[] = [];

      if (config.postAgents === 'dynamic') {
        const analysisResult = await askClaudeOneShot(`Based on this ${config.type} review prep context and approved outline, determine which post-interview updates are needed. Reply with a JSON object containing boolean fields: "projects", "psychology", "json_updates".

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

        if (updates.projects) {
          agentPromises.push(
            runAgent('project-updater', `Update project pages based on this ${config.type} review.\n\nPrep context:\n${session.prepContext}\n\nOutline:\n${session.outline}`)
              .then(r => { agentResults.projects = !r.error; if (r.error) log.error('project-updater failed', { error: r.error }); })
          );
        }

        if (updates.psychology) {
          agentPromises.push(
            runAgent('psychology-updater', `scope: ${config.psychologyScope}\nchanges: Based on ${config.type} review observations\nchangelog_entry: ${session.targetDate} ${config.type} review\n\nPrep context:\n${session.prepContext}\n\nOutline:\n${session.outline}`)
              .then(r => { agentResults.psychology = !r.error; if (r.error) log.error('psychology-updater failed', { error: r.error }); })
          );
        }

        if (updates.json_updates) {
          agentPromises.push(
            runAgent('json-updater', `Apply any JSON data updates from this ${config.type} review.\n\nPrep context:\n${session.prepContext}\n\nOutline:\n${session.outline}`)
              .then(r => { agentResults.json_updates = !r.error; if (r.error) log.error('json-updater failed', { error: r.error }); })
          );
        }
      } else {
        // psychology-only mode
        agentPromises.push(
          runAgent('psychology-updater', `scope: ${config.psychologyScope}\nchanges: Based on ${config.type} review observations\nchangelog_entry: ${session.targetDate} ${config.type} review\n\nPrep context:\n${session.prepContext}\n\nOutline:\n${session.outline}`)
            .then(r => { agentResults.psychology = !r.error; if (r.error) log.error('psychology-updater failed', { error: r.error }); })
        );
      }

      if (agentPromises.length > 0) {
        await Promise.all(agentPromises);
      }

      try {
        gitCommitAndPush(`${capitalize(config.type)} review: ${session.targetDate}`);
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
      await sendLongMessage(bot, session.chatId, `${capitalize(config.type)} review complete.\n\n${agentSummary}`);
    } catch (err) {
      stopTyping(typing);
      sessionPrompts.delete(session.claudeSessionId);
      throw err;
    }
  }

  return { start, handleMessage };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
