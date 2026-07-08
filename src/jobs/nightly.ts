import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import type { NotificationBus } from '../transport/notification-bus.js';
import { sanitizeErrorForTelegram } from './morning-prep.js';
import { captureSessions } from './capture.js';
import { executeActivitySync } from './whoop-sync.js';
import { processIngestionQueue, lintKB, enqueue } from '../kb/engine.js';
import { repairKnowledgeIndex } from '../kb/index-integrity.js';
import { runKnowledgeSupersessionReconciliation } from '../kb/knowledge-supersession.js';
import { conservativeSupersessionAdjudicator } from '../kb/supersession-adjudicator.js';
import { runLibrarySync } from './lenny-sync.js';
import { extractPlaybookDrafts } from './playbook-extract.js';
import { runNoteTriage } from './note-triage.js';
import {
  runJournalIntentProducer,
  type JournalIntentQueueEntry,
} from '../intent/journal-intent-producer.js';
import {
  readIntentProposalQueue,
  appendIntentProposals,
  type QueuedIntentProposal,
} from '../intent/intent-proposal-queue.js';
import { readRegistry } from '../intent/registry.js';
import { rebuildRegistry } from './registry-rebuild.js';
import { extractMeetings, appendProjectDecisions } from './meeting-extract.js';
import { askClaudeOneShot, runAgent, registerActiveProcess, unregisterActiveProcess } from '../ai/claude.js';
import { readVaultFile, writeVaultFile } from '../vault/files.js';
import { gitCommitAndPush } from '../vault/git.js';
import { getTodayDate, getTodayFilename, getDayOfWeek } from '../utils/time.js';
import { createLogger } from '../utils/logger.js';
import config, { PROJECT_ROOT } from '../config.js';
import { decideFailClosed } from '../intent/escalation.js';
import { runNightlyObservation } from '../intent/observation-nightly.js';
import {
  readVaultSignals,
  readTelemetrySignals,
  readInteractionSignals,
} from '../intent/observation-sensor-readers.js';
import { diarize, triage } from '../intent/observation-callbacks.js';
import type { SensorSignal, TriageVerdict } from '../intent/observation-loop.js';
import { readFiledIdeas, appendFiledIdeas } from '../intent/observation-ideas-io.js';
import { createMutation } from '../transport/mutations.js';
import { runLearningLoop } from '../intent/learning-loop.js';
import {
  readFeedbackRecords,
  feedbackRecordId,
  readProcessedFeedbackIds,
  writeProcessedFeedbackIds,
} from '../intent/feedback-reader.js';
import { runPostMortem } from '../intent/postmortem.js';
import { writeNightlyLearningLesson } from '../intent/learning-write-path.js';

const log = createLogger('nightly');

interface NightlyStepResult {
  step: string;
  status: 'success' | 'skipped' | 'error';
  detail?: string;
}

export interface NightlyResult {
  steps: NightlyStepResult[];
}

async function stepCaptureSession(): Promise<NightlyStepResult> {
  const { captured } = await captureSessions();
  if (captured === 0) {
    return { step: 'Session capture', status: 'skipped', detail: 'No active sessions' };
  }
  return { step: 'Session capture', status: 'success', detail: `${captured} session(s) captured` };
}

async function stepLibrarySync(): Promise<NightlyStepResult> {
  const result = await runLibrarySync();
  return { step: 'Library sync', ...result };
}

async function stepKBQueue(): Promise<NightlyStepResult> {
  const { processed, errors, created, updated } = await processIngestionQueue();
  if (processed === 0 && errors === 0) {
    return { step: 'KB queue', status: 'skipped', detail: 'Queue empty' };
  }
  if (errors > 0) {
    return { step: 'KB queue', status: 'error', detail: `${processed} processed, ${errors} failed` };
  }
  return {
    step: 'KB queue',
    status: 'success',
    detail: `${processed} source(s) ingested, ${created} created, ${updated} updated`,
  };
}

function stepKBIndexRepair(): NightlyStepResult {
  const result = repairKnowledgeIndex(config.VAULT_DIR);
  if (result.added === 0) {
    return { step: 'KB index repair', status: 'skipped', detail: result.detail };
  }
  return { step: 'KB index repair', status: 'success', detail: `added=${result.added}; ${result.detail}` };
}

async function stepKnowledgeReconciliation(date: string): Promise<NightlyStepResult> {
  const result = await runKnowledgeSupersessionReconciliation({
    vaultDir: config.VAULT_DIR,
    now: date,
    supersessions: [{ from: 'Jarvis', to: 'Rune', aliases: ['jarvis'] }],
    adjudicateCandidate: conservativeSupersessionAdjudicator,
  });

  const status = result.candidates === 0 ? 'skipped' : 'success';
  const artifactParts: string[] = [];
  if (result.editedFiles.length > 0) {
    artifactParts.push(`inline changelog: ${result.editedFiles.join(', ')}`);
  }
  if (result.accepted + result.rejected + result.ambiguous > 0) {
    artifactParts.push('supersession audit: knowledge/supersessions.jsonl');
  }
  const artifactDetail = artifactParts.length > 0 ? `; ${artifactParts.join('; ')}` : '';
  const detail =
    `${result.candidates} candidate(s), ${result.accepted} accepted, ` +
    `${result.rejected} rejected, ${result.ambiguous} ambiguous, ` +
    `${result.skipped} skipped; ${result.detail}${artifactDetail}`;
  return { step: 'Knowledge reconciliation', status, detail };
}

async function stepDailyTags(date: string, content: string | null): Promise<NightlyStepResult> {
  const KNOWN_JSON_FILES = [
    'pages/books.json — book log',
    'pages/crm.json — contact interactions',
    'pages/places.json — places visited',
    'health/workouts.json — workout log',
    'study/progress.json — study progress',
    'career/applications.json — job applications',
    'investments/investments.json — investment tracking',
  ];
  // Ideas and writing topics moved to the Note triage step (project 23) — Daily tags now
  // handles only nutrition on the markdown side.
  const KNOWN_MARKDOWN_FILES = [
    'health/nutrition.md — meal notes (#diet tags)',
  ];

  if (!content?.trim()) {
    return { step: 'Daily tags', status: 'skipped', detail: 'No journal for today' };
  }

  // Guard against very large journals overwhelming the prompt
  const MAX_JOURNAL_CHARS = 50_000;
  const truncatedContent = content.length > MAX_JOURNAL_CHARS
    ? content.slice(0, MAX_JOURNAL_CHARS) + '\n\n[truncated]'
    : content;

  const implicitCrmRule = config.IMPLICIT_CRM_NAMES.length > 0
    ? `\n- **Implicit CRM references**: even without an explicit \`#crm\` tag, any mention of ${config.IMPLICIT_CRM_NAMES.map((n) => `\`[[${n}]]\``).join(' or ')} should produce a CRM update for that contact (append today's journal_ref, add any new context).`
    : '';

  const analysisPrompt = `Analyze this journal entry and identify all inline tags (words prefixed with #, like #workout, #crm, #place, #books, #priorities, #diet, etc.). For each tagged item, extract the relevant data from the surrounding text and propose an update.

## Known targets

**JSON data files** (handled by the \`json-updater\` agent):
${KNOWN_JSON_FILES.map((f) => `- ${f}`).join('\n')}

**Markdown content files** (handled by the \`daily-content-updater\` agent):
${KNOWN_MARKDOWN_FILES.map((f) => `- ${f}`).join('\n')}

Journal entry for ${date}:
---
${truncatedContent}
---

For each tag found, output a proposed update in this format:

**#tagname** → target file
- Data to add/update: [extracted details]

## Special rules

- **\`#books\` summaries**: when you propose a \`#books\` → \`pages/books.json\` update and the journal doesn't already include a summary, include a 1-2 sentence \`summary:\` field derived from your general knowledge of the book (premise + core themes, neutral tone). If you are not confident you know the specific book, omit the summary field and note \`summary: UNKNOWN\` so a downstream helper can fill it in.${implicitCrmRule}
- **\`#study\` status inference**: when the journal describes *starting* a study topic, set \`status: "in_progress"\`. When it describes *finishing* a topic, set \`status: "completed"\`. Use journal wording as the signal ("started reading X", "finished X", "completed X course").
- **\`#diet\` tags** → \`health/nutrition.md\`. Propose the meal line in the form expected by \`daily-content-updater\`: a date + time + meal description. Multiple \`#diet\` mentions in one journal can share the same date heading.
- **\`#idea\` tags and writing topics are handled by a separate pipeline** — do NOT propose updates for them.
- **\`#health\` tags do NOT map to any file**. Do not propose an update for them. Instead, after the regular update list, emit a line:

  \`Health flags: <brief summary of each #health mention, semicolon-separated>\`

  If there are no \`#health\` mentions, omit this line entirely. These flags surface in the nightly summary for later weekly-review discussion.

If no actionable tags are found (no JSON updates AND no markdown updates AND no \`#health\` flags AND no implicit sam/jude references), say "No updates needed." and briefly summarize what was in the journal.

Be concise. Only propose updates for tags that clearly map to a target above or match the special rules.`;

  let analysis = await askClaudeOneShot(analysisPrompt);
  if (analysis.error?.includes('timed out')) {
    log.warn('Daily tags analyzer timed out, retrying once');
    analysis = await askClaudeOneShot(analysisPrompt);
  }

  if (analysis.error || !analysis.text) {
    return { step: 'Daily tags', status: 'error', detail: analysis.error || 'Empty response' };
  }

  // Extract any "Health flags:" line for surfacing in the step detail.
  const healthFlags = extractHealthFlags(analysis.text);

  // Match the new canonical marker + keep backward-compat with the old phrase.
  const noUpdates = /no (json )?updates needed/i.test(analysis.text);
  if (noUpdates) {
    const detail = healthFlags
      ? `No updates, but health flags: ${healthFlags}`
      : 'No actionable tags';
    return { step: 'Daily tags', status: 'skipped', detail };
  }

  // Route to json-updater and/or daily-content-updater based on which target files
  // the analyzer referenced. Each agent gets the full analysis text; its own scope
  // (per frontmatter + prompt) limits what it acts on.
  // Match full paths OR bare file names — the analyzer LLM may emit either form.
  const mentionsJson = /\b(books|crm|places|workouts|progress|applications|investments)\.json\b/.test(analysis.text);
  const mentionsMarkdown = /\bnutrition\.md\b/.test(analysis.text);

  const agentPrompt = `Apply the following proposed updates to the appropriate vault files. Read each target file first to understand its structure, then add the new entries.

Only modify files in your declared scope. Do not create new files or modify files outside the proposed scope.

Proposed updates:
${analysis.text}

Date context: ${date}`;

  const results: string[] = [];
  if (mentionsJson) {
    const r = await runAgent('json-updater', agentPrompt, undefined, false);
    if (r.error) {
      return { step: 'Daily tags', status: 'error', detail: `json-updater failed: ${r.error}` };
    }
    results.push('json-updater');
  }
  if (mentionsMarkdown) {
    const r = await runAgent('daily-content-updater', agentPrompt, undefined, false);
    if (r.error) {
      return { step: 'Daily tags', status: 'error', detail: `daily-content-updater failed: ${r.error}` };
    }
    results.push('daily-content-updater');
  }

  if (results.length === 0) {
    // Analyzer proposed updates but no recognized targets — unusual; flag as success-but-noop.
    const detail = healthFlags
      ? `No recognized targets; health flags: ${healthFlags}`
      : 'No recognized targets in analysis';
    return { step: 'Daily tags', status: 'skipped', detail };
  }

  await gitCommitAndPush(`Daily tag processing: ${date}`);
  const base = `Tags processed via ${results.join(' + ')}`;
  const detail = healthFlags ? `${base}; health flags: ${healthFlags}` : base;
  return { step: 'Daily tags', status: 'success', detail };
}

/** Extract the `Health flags: ...` line from the daily-tags analysis output.
 *  Returns the flag text (without the prefix) or null if no health flags were emitted. */
function extractHealthFlags(analysisText: string): string | null {
  const match = analysisText.match(/^Health flags:\s*(.+)$/m);
  return match ? match[1]!.trim() : null;
}

/** Compute MM-DD for the day after `date` (ISO `YYYY-MM-DD`). Handles year rollover. */
function tomorrowMonthDay(date: string): string {
  const parts = date.split('-').map(Number) as [number, number, number];
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  d.setDate(d.getDate() + 1);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

interface CrmEntry {
  name?: string;
  birthday?: string;
}

function stepBirthdayAlerts(date: string): NightlyStepResult {
  const raw = readVaultFile('pages/crm.json');
  if (!raw) {
    return { step: 'Birthday alerts', status: 'skipped', detail: 'pages/crm.json not found' };
  }
  let entries: CrmEntry[];
  try {
    entries = JSON.parse(raw) as CrmEntry[];
  } catch {
    return { step: 'Birthday alerts', status: 'error', detail: 'pages/crm.json is not valid JSON' };
  }
  const target = tomorrowMonthDay(date);
  const names = entries
    .filter((e) => e.birthday === target && typeof e.name === 'string' && e.name.length > 0)
    .map((e) => e.name!);
  if (names.length === 0) {
    return { step: 'Birthday alerts', status: 'skipped', detail: 'No birthdays tomorrow' };
  }
  return { step: 'Birthday alerts', status: 'success', detail: `Tomorrow: ${names.join(', ')}` };
}

async function stepPlaybookExtract(): Promise<NightlyStepResult> {
  const result = await extractPlaybookDrafts();
  return { step: 'Playbook extract', status: result.status, detail: result.detail };
}

/** Project 23: extract product ideas/bugs + writing/research topics from today's journal and
 *  file them per target (product repo backlogs, writing product topic files, vault new-product
 *  ideas). Runs after Registry rebuild so the product set is fresh the same night. */
async function stepNoteTriage(date: string, content: string | null): Promise<NightlyStepResult> {
  const result = await runNoteTriage(date, content);
  return { step: 'Note triage', status: result.status, detail: result.detail };
}

/** Rebuild the cross-product registry so the cockpit's project list, lifecycle
 *  status, and task progress self-heal without a daemon restart (the other
 *  rebuild trigger is the startup hook in src/index.ts). Runs before the
 *  journal-intent producer so that step sees freshly-registered products the
 *  same night. A scan/write failure is captured as an error step, not fatal. */
function stepRebuildRegistry(): NightlyStepResult {
  const { products, projects } = rebuildRegistry();
  return {
    step: 'Registry rebuild',
    status: 'success',
    detail: `${products} product(s), ${projects} project(s)`,
  };
}

/**
 * Phase 6 C7: scan the day's journal for product-tagged notes, run the
 * journal-intent planner, and append new proposals to
 * `logs/intent-proposal-queue.json`. Dedupes against existing entries by
 * `sourceNoteId` so re-running on the same journal is a no-op. A missing
 * registry (the file hasn't been built yet) is treated as "no registered
 * products" — every product mention becomes a `register-product` proposal,
 * which is the correct surfacing rather than dropping the note.
 */
function stepJournalIntentProducer(content: string | null): NightlyStepResult {
  if (!content || content.trim().length === 0) {
    return { step: 'Journal-intent producer', status: 'skipped', detail: 'No journal content today' };
  }
  let registeredProducts: string[] = [];
  try {
    const registry = readRegistry();
    registeredProducts = registry.products.map((p) => p.name);
  } catch (err) {
    // Missing/malformed registry — fall back to empty list. The planner
    // will surface every product mention as a `register-product` proposal,
    // which is the right outcome (it tells the user to register first).
    log.warn('stepJournalIntentProducer: registry unavailable, treating as empty', {
      error: (err as Error).message,
    });
  }
  const existing = readIntentProposalQueue();
  // The producer's dedupe key is sourceNoteId. Map the queue's
  // QueuedIntentProposal[] to the producer's JournalIntentQueueEntry[]
  // shape; entries predating C7 won't have a sourceNoteId — skip those,
  // they can't dedupe and will re-surface once (acceptable one-time cost).
  const existingQueueEntries: JournalIntentQueueEntry[] = existing
    .filter((e): e is QueuedIntentProposal & { sourceNoteId: string } =>
      typeof e.sourceNoteId === 'string')
    .map((e) => ({ sourceNoteId: e.sourceNoteId, proposal: e.proposal }));
  const result = runJournalIntentProducer({
    journalContent: content,
    registeredProducts,
    existingQueueEntries,
  });
  if (result.toEnqueue.length === 0) {
    return { step: 'Journal-intent producer', status: 'skipped', detail: 'No new proposals' };
  }
  const queuedAt = new Date().toISOString();
  const toAppend: QueuedIntentProposal[] = result.toEnqueue.map((e) => ({
    queuedAt,
    proposal: e.proposal,
    status: 'pending',
    sourceNoteId: e.sourceNoteId,
  }));
  try {
    appendIntentProposals(toAppend);
  } catch (err) {
    // The `run()` harness would catch this too, but a contextualized
    // detail message is more useful in the nightly summary than a raw
    // ENOSPC/EPERM exception string. Match the pattern used by
    // stepObservation's appendFiledIdeas guard.
    log.warn('stepJournalIntentProducer: appendIntentProposals failed', {
      error: (err as Error).message,
      pending: toAppend.length,
    });
    return {
      step: 'Journal-intent producer',
      status: 'error',
      detail: `Failed to queue ${toAppend.length} proposal(s): ${(err as Error).message}`,
    };
  }
  return {
    step: 'Journal-intent producer',
    status: 'success',
    detail: `${toAppend.length} new proposal(s) queued`,
  };
}

function stepJournalIngest(filename: string, content: string | null): NightlyStepResult {
  if (!content || content.trim().length === 0) {
    return { step: 'Journal ingest', status: 'skipped', detail: 'No journal content today' };
  }
  const source = `journals/${filename}`;
  enqueue(source);
  return { step: 'Journal ingest', status: 'success', detail: source };
}

async function stepMeetingExtract(content: string | null, date: string): Promise<NightlyStepResult> {
  if (!content || content.trim().length === 0) {
    return { step: 'Meeting extract', status: 'skipped', detail: 'No journal content today' };
  }
  const meetings = await extractMeetings(content, date);
  if (meetings.length === 0) {
    return { step: 'Meeting extract', status: 'skipped', detail: 'No #meeting blocks to transcribe' };
  }

  // Aggregate decisions per project across all meetings, then call the helper
  // ONCE per project — produces a single dated heading per project per day instead
  // of one heading per decision. Runs independently of attendees so decisions-only
  // meetings still land.
  const decisionsByProject = new Map<string, string[]>();
  for (const m of meetings) {
    if (!m.project || m.decisions.length === 0) continue;
    const existing = decisionsByProject.get(m.project) ?? [];
    decisionsByProject.set(m.project, [...existing, ...m.decisions]);
  }
  let decisionsAppended = 0;
  for (const [project, decisions] of decisionsByProject) {
    const r = appendProjectDecisions(project, date, decisions);
    if (r.status === 'success') {
      decisionsAppended += r.appended;
      enqueue(`projects/${project}.md`);
    } else if (r.status === 'error') {
      log.error('Decision append failed', { project, detail: r.detail });
    }
  }
  const decisionsSuffix = decisionsAppended > 0 ? `, ${decisionsAppended} decision(s) → projects/` : '';

  // Aggregate unique attendees across all meetings to a single CRM update.
  const attendees = Array.from(new Set(meetings.flatMap((m) => m.attendees)));
  if (attendees.length === 0) {
    return { step: 'Meeting extract', status: 'success', detail: `${meetings.length} meeting(s) found, skipped CRM (no attendees)${decisionsSuffix}` };
  }

  // CRM journal_refs use underscore date form (matches journal filenames sans `.md`).
  const journalRef = date.replace(/-/g, '_');

  const crmPrompt = `Update pages/crm.json: append "${journalRef}" to the journal_refs of each attendee from today's meeting(s).

Attendees:
${attendees.map((a) => `- ${a}`).join('\n')}

Process this as a **single read-modify-write pass**:
1. Read pages/crm.json once.
2. For each attendee in the list above, follow this match hierarchy:
   a. **Exact id match**: find an existing entry whose \`id\` === the slug. If found, append \`"${journalRef}"\` to its \`journal_refs\` (dedup — skip if already present).
   b. **Exact name match** (case-insensitive, whitespace-normalized): if no id match, look for an existing entry whose \`name\` matches. If found, treat as (a).
   c. **Fuzzy name match** (ambiguous cases — e.g., the slug is \`alice\` and an existing entry has \`name: "Alice Smith"\`, or partial matches, or nicknames): do NOT auto-append and do NOT create a new entry. Instead, emit a line:
      \`FUZZY: <slug> may match existing entry <existing-id> ("<existing-name>") — human review needed\`
      Leave the file unchanged for this attendee.
   d. **No match at all** (neither exact nor fuzzy): create a new entry \`{id: <slug>, name: <derived>, journal_refs: ["${journalRef}"]}\` where \`name\` is derived by replacing hyphens with spaces and title-casing. Preserve all other fields on existing entries.
3. Write the updated array back to pages/crm.json once at the end.

Report a one-line summary per attendee. Use one of these exact prefixes so the nightly job can parse the output:
- \`<id>: appended\` — added today's ref.
- \`<id>: already present\` — dedup, no change.
- \`<id>: created new entry\` — genuinely unknown contact.
- \`FUZZY: ...\` — uncertain match (from rule c).

Do not create a new entry when rule (c) fires; conservative bias prevents silent CRM pollution.`;

  const result = await runAgent('json-updater', crmPrompt, undefined, false);
  if (result.error) {
    log.error('CRM update via json-updater failed', { error: result.error, attendees });
    return { step: 'Meeting extract', status: 'error', detail: `${meetings.length} meeting(s) extracted, CRM update failed: ${result.error}` };
  }

  // Enqueue the freshly updated CRM file so the next KB queue pass picks up the new
  // contacts and journal_refs (mirrors the post-review enqueue pattern).
  enqueue('pages/crm.json');

  // Parse any FUZZY lines from the agent output — these are uncertain name matches
  // the agent deliberately skipped writing for. Surface as a warning in the step detail.
  const fuzzyCount = (result.text ?? '').split('\n').filter((l) => /^FUZZY:/.test(l.trim())).length;
  const fuzzySuffix = fuzzyCount > 0 ? `, ${fuzzyCount} FUZZY match(es) need review` : '';

  return {
    step: 'Meeting extract',
    status: 'success',
    detail: `${meetings.length} meeting(s), ${attendees.length} attendee(s) → CRM${decisionsSuffix}${fuzzySuffix}`,
  };
}

async function stepWhoopActivity(): Promise<NightlyStepResult> {
  const result = await executeActivitySync();
  return { step: 'Whoop activity', status: result.status === 'synced' ? 'success' : result.status, detail: result.detail };
}

function stepMarkProcessed(filename: string, content: string | null, date: string): NightlyStepResult {
  if (!content) {
    return { step: 'Mark processed', status: 'skipped', detail: 'No journal content today' };
  }
  const path = `journals/${filename}`;
  const marker = `<!-- daily-processed: ${date} -->`;
  if (content.includes(marker)) {
    return { step: 'Mark processed', status: 'skipped', detail: 'Marker already present' };
  }
  // Append marker with a single blank line separator. Preserve existing trailing newline.
  const sep = content.endsWith('\n') ? '\n' : '\n\n';
  writeVaultFile(path, `${content}${sep}${marker}\n`);
  return { step: 'Mark processed', status: 'success', detail: marker };
}

/** Phase 6 B5 — observation loop step. Composes the B2 source readers,
 *  B3 LLM callbacks, B4 ideas-io, and the escalation policy into one
 *  nightly pass. Filed ideas are appended to `docs/projects/ideas.md`;
 *  `dispatch` plans fire a `gen-eval-loop` mutation; `await-approval`
 *  plans surface a Telegram approval prompt (when a bus is available)
 *  and are also recorded in the step detail. */
async function stepObservation(bus?: NotificationBus): Promise<NightlyStepResult> {
  const ideasPath = join(PROJECT_ROOT, 'docs', 'projects', 'ideas.md');

  // Read the escalation policy once per pass; pass the raw text into
  // `decideFailClosed` per filed idea so a missing/malformed policy fails
  // closed (escalates rather than auto-proceeding).
  let rawEscalationPolicy: string | null = null;
  try {
    rawEscalationPolicy = readFileSync(config.ESCALATION_POLICY_FILE, 'utf8');
  } catch {
    // Missing file → null → decideFailClosed escalates with a clear reason.
  }

  const vaultSignals = readVaultSignals({});
  const telemetrySignals = readTelemetrySignals({});
  const interactionSignals = readInteractionSignals({});
  const rawSignals = [...vaultSignals, ...telemetrySignals, ...interactionSignals];
  const diarizedSignals = await diarize(rawSignals);
  const triageResults = new WeakMap<SensorSignal, TriageVerdict>();
  for (const signal of diarizedSignals) {
    triageResults.set(signal, await triage(signal));
  }

  const result = await runNightlyObservation({
    readers: {
      vault: () => vaultSignals,
      telemetry: () => telemetrySignals,
      interactions: () => interactionSignals,
    },
    diarize: () => diarizedSignals,
    triage: (signal) => triageResults.get(signal) ?? { file: false, reason: 'missing triage result' },
    decideEscalation: (idea) =>
      decideFailClosed({ specOrigin: 'self-generated' }, rawEscalationPolicy).verdict === 'escalate'
        ? 'escalate'
        : 'proceed',
    existingIdeas: readFiledIdeas(ideasPath),
  });

  // Append filed ideas (no-op when the markdown is empty).
  try {
    appendFiledIdeas(ideasPath, result.ideasMarkdown);
  } catch (err) {
    log.warn('stepObservation: appendFiledIdeas failed', { error: (err as Error).message });
  }

  // Fire dispatch plans and accumulate await-approval messages.
  const dispatchedSlugs: string[] = [];
  const dispatchFailures: string[] = [];
  const awaitingApproval: Array<{ idea: string; reason: string }> = [];
  for (let i = 0; i < result.dispatchPlans.length; i++) {
    const plan = result.dispatchPlans[i]!;
    const outcome = result.outcomes.filter((o) => o.kind === 'filed')[i];
    const ideaTitle = outcome && outcome.kind === 'filed' ? outcome.idea.title : 'unknown';
    if (plan.action === 'dispatch') {
      const create = await createMutation(
        'gen-eval-loop',
        { product: 'rune', project: plan.projectSlug },
        'cron',
      );
      if (create.ok) {
        dispatchedSlugs.push(plan.projectSlug);
      } else {
        dispatchFailures.push(`${plan.projectSlug}: ${create.reason}`);
        log.warn('stepObservation: createMutation rejected', {
          slug: plan.projectSlug,
          reason: create.reason,
        });
      }
    } else {
      awaitingApproval.push({ idea: ideaTitle, reason: plan.reason });
      if (bus) {
        bus.publish({
          kind: 'message',
          userId: config.TELEGRAM_USER_ID,
          text: `Observation loop filed a new idea pending approval:\n• ${ideaTitle}\n• reason: ${plan.reason}`,
        });
      }
    }
  }

  // Pass-summary counts (B5.3) — meta telemetry the next pass can observe.
  const counts = {
    filed: result.outcomes.filter((o) => o.kind === 'filed').length,
    discarded: result.outcomes.filter((o) => o.kind === 'discarded').length,
    duplicate: result.outcomes.filter((o) => o.kind === 'duplicate').length,
    quiet: result.outcomes.filter((o) => o.kind === 'quiet').length,
    dispatched: dispatchedSlugs.length,
    awaitingApproval: awaitingApproval.length,
    dispatchFailures: dispatchFailures.length,
  };
  log.info('stepObservation pass summary', counts);

  // Build a short detail string for the nightly step summary.
  const parts: string[] = [
    `filed=${counts.filed}`,
    `discarded=${counts.discarded}`,
    `duplicate=${counts.duplicate}`,
  ];
  if (counts.quiet > 0) parts.push('quiet');
  if (counts.dispatched > 0) parts.push(`dispatched=${counts.dispatched}`);
  if (counts.awaitingApproval > 0) parts.push(`awaiting-approval=${counts.awaitingApproval}`);
  if (counts.dispatchFailures > 0) parts.push(`dispatch-failures=${counts.dispatchFailures}`);

  return {
    step: 'Observation loop',
    status: counts.dispatchFailures > 0 ? 'error' : 'success',
    detail: parts.join(', '),
  };
}

/** Max feedback records the learning loop post-mortems in one nightly pass — bounds
 *  the step's wall-clock (each record is a serial LLM call) so a large backlog can't
 *  stall the pipeline. The remainder is picked up on subsequent nights. */
const LEARNING_LOOP_MAX_PER_PASS = 20;
/** Per-record post-mortem timeout — the prompt is short and bounded, so it needs far
 *  less than the default Claude budget; a slow call shouldn't hold up the pass. */
const POSTMORTEM_TIMEOUT_MS = 60_000;

/** Product-team learning loop (project 14, Phase 6). Reads machine-readable feedback
 *  records, runs the Rune-owned post-mortem on each NOT-yet-processed record (up to
 *  a per-pass cap), and writes one attributed, privacy-clean lesson into the
 *  responsible role's memory.md (its own atomic commit in the rune repo). Each
 *  record is processed exactly once via a content-hash marker, so the post-mortem LLM
 *  call never re-fires for the same record on later nights. No feedback / nothing new
 *  → skipped. Each malformed record is a durable skip, never silent no-feedback.
 *
 *  Note: the marker bounds re-processing source-agnostically; a richer feedback
 *  source/cursor lands with the Phase 6 discovery-surface wiring. */
async function stepLearningLoop(): Promise<NightlyStepResult> {
  const all = readFeedbackRecords(config.FEEDBACK_FILE);
  const processed = readProcessedFeedbackIds(config.FEEDBACK_PROCESSED_FILE);
  // Compute each id once; reuse it for both the unprocessed filter and the
  // post-pass mark so the mark provably covers exactly the records we ran.
  const freshWithIds = all
    .map((r) => ({ record: r, id: feedbackRecordId(r) }))
    .filter(({ id }) => !processed.has(id))
    .slice(0, LEARNING_LOOP_MAX_PER_PASS);
  const fresh = freshWithIds.map(({ record }) => record);

  if (fresh.length === 0) {
    return { step: 'Learning loop', status: 'skipped', detail: 'No new feedback records' };
  }

  const result = await runLearningLoop({
    // `fresh` is already filtered (unprocessed) and capped; this seam exists so the
    // loop core stays I/O-free and unit-testable, not to do further reading.
    readFeedback: () => fresh,
    // Fault-isolate the post-mortem at the seam so one bad record never aborts the pass.
    attribute: async (record) => {
      try {
        return await runPostMortem(record, {
          ask: (prompt) => askClaudeOneShot(prompt, POSTMORTEM_TIMEOUT_MS, 'learning-postmortem'),
        });
      } catch (err) {
        log.warn('Learning loop: post-mortem threw', { error: String(err) });
        return { kind: 'no-lesson', rationale: `post-mortem threw: ${String(err)}` };
      }
    },
    writeLesson: async (role, lesson, record) => {
      try {
        const res = await writeNightlyLearningLesson({ role, lesson, record });
        return { committed: res.committed, captured: res.captured };
      } catch (err) {
        log.warn('Learning loop: lesson write threw', { error: String(err) });
        return { committed: false };
      }
    },
  });

  // Mark every record we READ this pass (incl. malformed) processed, so it is never
  // re-attempted — a malformed record is a once-only durable skip, not a nightly retry.
  for (const { id } of freshWithIds) processed.add(id);
  writeProcessedFeedbackIds(config.FEEDBACK_PROCESSED_FILE, processed);

  const detail =
    `${result.lessonsWritten} lesson(s), ${result.lessonsFiltered} filtered, ` +
    `${result.noLessonOutcomes} no-lesson, ${result.skipped.length} malformed`;
  // A batch where every record was malformed wrote nothing and is worth flagging,
  // not rendering green.
  const status = result.processed === 0 && result.skipped.length > 0 ? 'error' : 'success';
  return { step: 'Learning loop', status, detail };
}

async function stepLint(): Promise<NightlyStepResult> {
  if (getDayOfWeek() !== 'Sunday') {
    return { step: 'KB lint', status: 'skipped', detail: 'Not Sunday' };
  }

  const { success, report } = await lintKB();

  if (!success) {
    return { step: 'KB lint', status: 'error', detail: report.slice(0, 250) };
  }

  return { step: 'KB lint', status: 'success', detail: report.slice(0, 200) };
}

/** Convert ISO `YYYY-MM-DD` to the journal-file form `YYYY_MM_DD.md`. */
function toJournalFilename(isoDate: string): string {
  return `${isoDate.replace(/-/g, '_')}.md`;
}

/** Run the final `gitCommitAndPush` outside the per-step `run()` helper but
 *  with the same fault-isolation contract: a git failure is captured as a
 *  `Final commit` step on the result instead of escaping out of
 *  `executeNightly()`. Preserves the structured nightly summary even when
 *  the vault push fails (network down, merge conflict, etc.). */
async function safeFinalCommit(message: string, steps: NightlyStepResult[]): Promise<void> {
  try {
    await gitCommitAndPush(message);
  } catch (err) {
    steps.push({ step: 'Final commit', status: 'error', detail: `${message}: ${String(err)}` });
    log.error('Final commit failed', { message, error: String(err) });
  }
}

/** Run the full nightly pipeline. If `targetDate` is provided (ISO `YYYY-MM-DD`),
 *  processes that day's journal instead of today's — useful for backfilling a
 *  missed day via `npm run cli -- nightly --date 2026-04-17`.
 *
 *  If the target journal already contains `<!-- daily-processed: <date> -->`
 *  (written by `stepMarkProcessed` at the end of a successful run), bail out
 *  immediately and return a single-step skipped result — prevents duplicate
 *  decisions headings in `projects/*.md` and wasted LLM calls. Pass
 *  `{force: true}` to bypass the gate (CLI: `--date X --force`). */
export async function executeNightly(
  targetDate?: string,
  options?: { force?: boolean; bus?: NotificationBus },
): Promise<NightlyResult> {
  log.info('Nightly processing started', { targetDate: targetDate ?? '(today)', force: options?.force ?? false });
  const steps: NightlyStepResult[] = [];

  const run = async (
    name: string,
    fn: () => NightlyStepResult | Promise<NightlyStepResult>,
  ): Promise<NightlyStepResult> => {
    try {
      const result = await fn();
      steps.push(result);
      log.info(`Step complete: ${result.step}`, { status: result.status, detail: result.detail });
      return result;
    } catch (err) {
      const result: NightlyStepResult = { step: name, status: 'error', detail: String(err) };
      steps.push(result);
      log.error(`Step failed: ${name}`, { error: String(err) });
      return result;
    }
  };

  const todayDate = targetDate ?? getTodayDate();
  const todayFilename = targetDate ? toJournalFilename(targetDate) : getTodayFilename();
  let todayJournal: string | null = null;
  try {
    todayJournal = readVaultFile(`journals/${todayFilename}`);
  } catch (err) {
    log.error('Failed to read today\'s journal', { error: String(err) });
  }

  const marker = `<!-- daily-processed: ${todayDate} -->`;
  if (!options?.force && todayJournal?.includes(marker)) {
    const detail = `${marker} found in journals/${todayFilename}. Re-run with --force to override.`;
    const step: NightlyStepResult = { step: 'Already processed', status: 'skipped', detail };
    steps.push(step);
    log.info(`Step complete: ${step.step}`, { status: step.status, detail });
    log.info('Nightly processing complete', { steps: steps.length, earlyExit: true });
    return { steps };
  }

  await run('Session capture', stepCaptureSession);
  const dailyTags = await run('Daily tags', () => stepDailyTags(todayDate, todayJournal));

  if (dailyTags.status === 'error') {
    const abort: NightlyStepResult = {
      step: 'Aborted',
      status: 'error',
      detail: 'Daily tags failed — remaining steps skipped, processed marker not written',
    };
    steps.push(abort);
    log.error('Nightly aborted after Daily tags failure', { detail: dailyTags.detail });
    await safeFinalCommit('Nightly processing (aborted after Daily tags)', steps);
    log.info('Nightly processing complete', { steps: steps.length, aborted: true });
    return { steps };
  }

  await run('Birthday alerts', () => stepBirthdayAlerts(todayDate));
  await run('Playbook extract', stepPlaybookExtract);
  await run('Registry rebuild', stepRebuildRegistry);
  await run('Journal-intent producer', () => stepJournalIntentProducer(todayJournal));
  await run('Note triage', () => stepNoteTriage(todayDate, todayJournal));
  await run('Journal ingest', () => stepJournalIngest(todayFilename, todayJournal));
  await run('Meeting extract', () => stepMeetingExtract(todayJournal, todayDate));
  await run('Library sync', stepLibrarySync);
  await run('KB queue', stepKBQueue);
  await run('KB index repair', stepKBIndexRepair);
  await run('Knowledge reconciliation', () => stepKnowledgeReconciliation(todayDate));
  await run('Whoop activity', stepWhoopActivity);
  await run('Observation loop', () => stepObservation(options?.bus));
  await run('Learning loop', stepLearningLoop);
  await run('KB lint', stepLint);
  await run('Mark processed', () => stepMarkProcessed(todayFilename, todayJournal, todayDate));

  // Final commit for any residual uncommitted changes
  await safeFinalCommit('Nightly processing', steps);

  log.info('Nightly processing complete', { steps: steps.length });
  return { steps };
}

export function formatSummary(result: NightlyResult): string {
  const icons: Record<string, string> = { success: '+', skipped: '-', error: 'x' };
  const lines = result.steps.map((s) => {
    const icon = icons[s.status] || '?';
    const detail = s.detail ? ` — ${s.detail}` : '';
    return `[${icon}] ${s.step}${detail}`;
  });
  return `Nightly complete:\n${lines.join('\n')}`;
}

/** Prevent macOS idle/system sleep while fn runs. No-op on non-darwin platforms. */
async function withNoSleep<T>(fn: () => Promise<T>): Promise<T> {
  if (platform() !== 'darwin') return fn();
  // -i: prevent idle sleep  -s: prevent system sleep (ignored on battery)
  const caffeinate = spawn('caffeinate', ['-is'], { stdio: 'ignore' });
  caffeinate.on('error', (err) => log.warn('caffeinate spawn error', { error: err.message }));
  registerActiveProcess(caffeinate);
  try {
    return await fn();
  } finally {
    unregisterActiveProcess(caffeinate);
    if (!caffeinate.killed) caffeinate.kill();
  }
}

export async function runNightly(bus: NotificationBus): Promise<void> {
  await withNoSleep(async () => {
    try {
      const result = await executeNightly(undefined, { bus });
      const summary = formatSummary(result);
      bus.publish({ kind: 'message', userId: config.TELEGRAM_USER_ID, text: summary });
    } catch (err) {
      log.error('Nightly processing failed', { error: String(err) });
      bus.publish({ kind: 'message', userId: config.TELEGRAM_USER_ID, text: `Nightly processing failed: ${sanitizeErrorForTelegram(String(err))}` });
    }
  });
}
