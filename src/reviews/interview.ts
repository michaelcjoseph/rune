import TelegramBot from 'node-telegram-bot-api';
import { updateReviewSession, onReviewSessionDeleted } from './session.js';
import type { ReviewSession, ReviewType } from './session.js';
import type { ReviewTypeHandler } from './orchestrator.js';
import { askClaudeWithContext, askClaudeOneShot, runAgent, AGENT_NOT_FOUND_PREFIX, type ClaudeResult } from '../ai/claude.js';
import { readVaultFile } from '../vault/files.js';
import { gitCommitAndPush } from '../vault/git.js';
import { sendLongMessage, startTyping, stopTyping } from '../integrations/telegram/client.js';
import { createLogger } from '../utils/logger.js';
import { getPendingPlaybookDrafts } from '../jobs/playbook-extract.js';
import { enqueue as enqueueKB } from '../kb/queue.js';

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
  /** Optional synchronous prep — appended to prepContext after agent results.
   *  Use for local computations (changelog scans, queue dumps) that don't need an LLM. */
  extraPrepContext?: (session: ReviewSession) => string | null;
  postAgents: 'dynamic' | 'psychology-only';
  psychologyScope: string;
}

/** Convert YYYY-MM-DD to YYYY_MM_DD for scanner agent prompts */
export function toScannerDate(isoDate: string): string {
  return isoDate.replace(/-/g, '_');
}

/** Extract interview instructions (Steps 2-3) from the full SKILL.md */
export function extractInterviewInstructions(skillContent: string): string {
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

onReviewSessionDeleted((id) => sessionPrompts.delete(id));

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

      const prepSections = results.map((r, i) => {
        const call = prepCalls[i]!;
        return `# ${call.label}\n${r.text || `(${call.agent} failed: ${r.error})`}`;
      });

      if (config.postAgents === 'dynamic') {
        const drafts = getPendingPlaybookDrafts();
        if (drafts.length > 0) {
          const draftList = drafts.map(d =>
            `- **${d.slug}** (${d.domain}, from [[${d.sourceJournal}]]):\n${d.entryMarkdown}`
          ).join('\n\n');
          prepSections.push(`# Pending Playbook Drafts (${drafts.length})\n${draftList}\n\n*Surface these during the review so the user can approve, reject, or edit them. Approved drafts will be appended to pages/playbook.md after outline approval.*`);
        }
      }

      const extra = config.extraPrepContext?.(session);
      if (extra) prepSections.push(extra);

      const prepContext = prepSections.join('\n\n');

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

      type AgentStatus = 'ok' | 'failed' | 'missing';
      const agentResults: Record<string, AgentStatus> = {};
      const agentPromises: Promise<void>[] = [];

      const runPostAgent = (key: string, agentName: string, prompt: string, onSuccess?: (r: ClaudeResult) => void): Promise<void> =>
        runAgent(agentName, prompt).then(r => {
          if (!r.error) {
            agentResults[key] = 'ok';
            try { onSuccess?.(r); } catch (err) { log.error(`${agentName} onSuccess failed`, { error: (err as Error).message }); }
          } else if (r.error.startsWith(AGENT_NOT_FOUND_PREFIX)) {
            agentResults[key] = 'missing';
            log.warn(`Post-agent missing: ${agentName}`, { key });
          } else {
            agentResults[key] = 'failed';
            log.error(`${agentName} failed`, { error: r.error });
          }
        });

      const enqueueTouchedFiles = (output: string, pattern: RegExp, filter?: (path: string) => boolean): void => {
        const matches = output.match(pattern) || [];
        const unique = [...new Set(matches)];
        for (const file of unique) {
          if (!filter || filter(file)) enqueueKB(file);
        }
      };

      if (config.postAgents === 'dynamic') {
        const analysisResult = await askClaudeOneShot(`Based on this ${config.type} review prep context and approved outline, determine which post-interview updates are needed. Reply with a JSON object containing boolean fields: "projects", "psychology", "json_updates", "worldview", "playbook".

Set "projects" to true if active projects were discussed with meaningful updates (thesis changes, new risks, decisions).
Set "psychology" to true if psychological patterns were observed or challenged.
Set "json_updates" to true if trackable items were mentioned (#workout, #book, #crm, #place, etc.).
Set "worldview" to true if the outline proposes specific changes to world-view/*.md files (belief shifts the user approved applying).
Set "playbook" to true if the outline approves applying playbook drafts from the queue or proposes new tactical patterns to add.

Prep context:
${session.prepContext}

Approved outline:
${session.outline}

Reply ONLY with the JSON object, nothing else.`);

        let updates = { projects: false, psychology: false, json_updates: false, worldview: false, playbook: false };
        if (analysisResult.text) {
          try {
            const parsed = JSON.parse(analysisResult.text.replace(/```json?\n?|\n?```/g, '').trim());
            updates = { ...updates, ...parsed };
          } catch {
            log.warn('Failed to parse update analysis, running all agents', { text: analysisResult.text });
            updates = { projects: true, psychology: true, json_updates: true, worldview: true, playbook: true };
          }
        }

        if (updates.projects) {
          agentPromises.push(runPostAgent('projects', 'project-updater',
            `Update project pages based on this ${config.type} review.\n\nPrep context:\n${session.prepContext}\n\nOutline:\n${session.outline}`,
            r => enqueueTouchedFiles(r.text || '', /projects\/[a-z0-9-]+\.md/g, f => !f.startsWith('projects/archive/'))));
        }

        if (updates.psychology) {
          agentPromises.push(runPostAgent('psychology', 'psychology-updater',
            `scope: ${config.psychologyScope}\nchanges: Based on ${config.type} review observations\nchangelog_entry: ${session.targetDate} ${config.type} review\n\nPrep context:\n${session.prepContext}\n\nOutline:\n${session.outline}`));
        }

        if (updates.json_updates) {
          agentPromises.push(runPostAgent('json_updates', 'json-updater',
            `Apply any JSON data updates from this ${config.type} review.\n\nPrep context:\n${session.prepContext}\n\nOutline:\n${session.outline}`));
        }

        if (updates.worldview) {
          agentPromises.push(runPostAgent('worldview', 'worldview-updater',
            `Apply approved worldview diffs from this ${config.type} review outline to world-view/*.md. Only apply changes explicitly present in the outline.\n\nPrep context:\n${session.prepContext}\n\nOutline:\n${session.outline}`,
            r => enqueueTouchedFiles(r.text || '', /world-view\/[a-z0-9-]+\.md/g)));
        }

        if (updates.playbook) {
          agentPromises.push(runPostAgent('playbook', 'playbook-updater',
            `Apply approved playbook drafts from logs/playbook-queue.json. Only apply drafts the outline approves; leave the rest in the queue.\n\nPrep context:\n${session.prepContext}\n\nOutline:\n${session.outline}`,
            () => enqueueKB('pages/playbook.md')));
        }
      } else {
        // psychology-only mode
        agentPromises.push(runPostAgent('psychology', 'psychology-updater',
          `scope: ${config.psychologyScope}\nchanges: Based on ${config.type} review observations\nchangelog_entry: ${session.targetDate} ${config.type} review\n\nPrep context:\n${session.prepContext}\n\nOutline:\n${session.outline}`));
      }

      if (agentPromises.length > 0) {
        await Promise.all(agentPromises);
      }

      try {
        await gitCommitAndPush(`${capitalize(config.type)} review: ${session.targetDate}`);
      } catch (err) {
        log.error('Git commit failed', { error: (err as Error).message });
      }

      stopTyping(typing);

      const summarize = (key: string, ok: string, failed: string, missing: string): string | null => {
        const state = agentResults[key];
        if (state === 'ok') return ok;
        if (state === 'failed') return failed;
        if (state === 'missing') return missing;
        return null;
      };

      const agentSummary = [
        writerResult.text ? 'Review written to journal.' : null,
        summarize('projects', 'Project pages updated.', 'Project update failed.', 'Projects skipped (agent missing).'),
        summarize('psychology', 'Psychology profile updated.', 'Psychology update failed.', 'Psychology skipped (agent missing).'),
        summarize('json_updates', 'JSON data updated.', 'JSON update failed.', 'JSON updates skipped (agent missing).'),
        summarize('worldview', 'Worldview updated.', 'Worldview update failed.', 'Worldview skipped (agent missing).'),
        summarize('playbook', 'Playbook entries added.', 'Playbook update failed.', 'Playbook skipped (agent missing).'),
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
