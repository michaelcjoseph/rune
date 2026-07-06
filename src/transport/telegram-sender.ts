import type TelegramBot from 'node-telegram-bot-api';
import { sendLongMessage, startTyping, stopTyping } from '../integrations/telegram/client.js';
import type { MessageSender, SendOpts } from './sender.js';
import type { BusMutationEvent, BusOpEvent } from './notification-bus.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('telegram-sender');

interface TrackerEntry {
  userId: number;
  messageId: number;
  lastEditTs: number;
}

const TRACKER_EDIT_THROTTLE_MS = 10_000;

/** Short mutation-id suffix surfaced in C5 messages so the user can correlate
 *  a Telegram notification with the cockpit/log entry. The full id is a
 *  randomUUID; the first 8 chars carry plenty of entropy for a coarse
 *  cross-reference. */
function shortMutationId(id: string): string {
  return id.slice(0, 8);
}

/** Phase 6 C5: structured terminal message for a gen-eval-loop mutation.
 *  Three branches by `(subKind, data)`:
 *    - completed                              → `✅ … merged to main` + rounds + cross-model verdict
 *    - failed AND failedEvaluatorRounds set   → `⏸ … blocked on you` (escalated by the loop)
 *    - failed AND failedEvaluatorRounds unset → `💥 … failed` (hard failure — applier crash etc.) */
function formatGenEvalLoopTerminal(event: BusMutationEvent): string {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const product = String(data['product'] ?? '');
  const project = String(data['project'] ?? '');
  const id = shortMutationId(event.mutationId);
  // Use shortMutationId for the target fallback too — keeps both id-derived
  // strings consistent if the formatter ever changes how it shortens.
  const target = product && project ? `${product}/${project}` : (product || project || id);
  if (event.subKind === 'completed') {
    const rounds = typeof data['rounds'] === 'number' ? (data['rounds'] as number) : 1;
    const adj = (data['adjudication'] ?? {}) as Record<string, unknown>;
    const verdict = String(adj['verdict'] ?? 'pass').toUpperCase();
    const genProvider = adj['generatorProvider'];
    const evalProvider = adj['evaluatorProvider'];
    // Cross-model when both providers exist and differ; same-model otherwise.
    const crossModel = !!genProvider && !!evalProvider && genProvider !== evalProvider;
    const verdictLine = crossModel ? `cross-model ${verdict}` : `single-model ${verdict}`;
    return `✅ ${target} merged to main · ${rounds} rounds · ${verdictLine} · id=${id}`;
  }
  // subKind === 'failed'
  const failed = data['failedEvaluatorRounds'];
  const cap = data['cap'];
  const reason = String(data['reason'] ?? 'unknown');
  if (typeof failed === 'number' && typeof cap === 'number') {
    // Escalated by the evaluator-round cap — user picks up.
    return `⏸ ${target} blocked on you · ${failed}/${cap} failed evaluator rounds · ${reason} · id=${id}`;
  }
  // Hard failure — worktree create, applier crash, etc.
  return `💥 ${target} failed · ${reason} · id=${id}`;
}

/** Project 13: run-start notification for a `work-run` mutation. Surfaces the
 *  UN-SCRUBBED operator worktree path so Michael can `cd` straight into a live
 *  (or later parked) run in one step — Telegram (to TELEGRAM_USER_ID) is a
 *  local-operator surface, so the raw `cd`-able path is delivered verbatim. The
 *  cockpit WebSocket (localhost-bound, auth-gated) is the OTHER scrub-exempt
 *  local-operator surface that carries this field; every PERSISTED/COMMITTED
 *  surface (mutations.jsonl, summary/index, transcript, forensics) stays
 *  scrubbed. NOTE: both exemptions assume the cockpit stays local — broadening
 *  `RUNE_ALLOWED_HOSTS` to a remote origin must revisit this field. Returns
 *  null when no path is present so the caller never surfaces an empty alert. */
function formatWorkRunStart(event: BusMutationEvent): string | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const worktree = typeof data['operatorWorktreePath'] === 'string' ? data['operatorWorktreePath'].trim() : '';
  if (!worktree) return null;
  const slug = String(data['projectSlug'] ?? event.mutationId.slice(0, 8));
  const runId = String(data['runId'] ?? event.mutationId);
  return `🚀 work-run started · ${slug} · id=${runId}\n📂 ${worktree}`;
}

/** Project 11: outcome-aware terminal message for a `work-run` mutation. Keyed
 *  on the typed `outcome` (carried on the terminal event's `data`), so a run
 *  that exited 0 while doing nothing renders as `⚠️ no-op`, never `✅ finished`.
 *  An early-exit terminal with no classified outcome (worktree-create /
 *  project-not-found / spec-read failure) renders by `subKind` — never the bare
 *  generic finished-in-Ns format — so a work run can't read as success without
 *  a verified outcome. */
function formatWorkRunTerminal(event: BusMutationEvent, opts: { suppressMergeClaim?: boolean } = {}): string {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const slug = String(data['projectSlug'] ?? event.mutationId.slice(0, 8));
  const reason = String(data['reason'] ?? '');
  const id = shortMutationId(event.mutationId);

  // Project 13, Phase 1b — parked-aware branch. A parked run terminates the
  // mutation normally (subKind completed) but is paused for a human; it must
  // NOT render as its underlying classification ("no-op", "did nothing"). Park
  // is deliberately not a WorkOutcome, so it's branched here before the
  // outcome switch. Surfaces the pending check + the UN-SCRUBBED operator
  // worktree path (Telegram is a local-operator surface) so Michael can act in
  // one step.
  if (data['parked'] === true) {
    const pendingCheck = typeof data['pendingCheck'] === 'string' ? data['pendingCheck'] : '';
    const parkedQuestion = data['parkedQuestion'] && typeof data['parkedQuestion'] === 'object'
      ? data['parkedQuestion'] as Record<string, unknown>
      : null;
    const question = parkedQuestion && typeof parkedQuestion['question'] === 'string' ? parkedQuestion['question'] : '';
    const worktree = typeof data['operatorWorktreePath'] === 'string' ? data['operatorWorktreePath'] : '';
    const command = typeof data['command'] === 'string' ? data['command'] : '';
    const parkedReason = typeof data['reason'] === 'string' ? data['reason'] : '';
    const lines = [`⏸️ ${slug} parked · needs you · id=${id}`];
    if (question) lines.push(`❓ ${question}`);
    if (pendingCheck) lines.push(`📋 ${pendingCheck}`);
    if (worktree) lines.push(`📂 ${worktree}`);
    if (command) lines.push(`▶️ ${command}`);
    if (parkedReason) lines.push(`↳ ${parkedReason}`);
    return lines.join('\n');
  }

  const outcome = typeof data['outcome'] === 'string' ? (data['outcome'] as string) : '';
  if (!outcome) {
    // An early-exit work-run terminal (worktree-create / project-not-found /
    // spec-read failure) carries no classified outcome. Render by subKind —
    // NEVER the bare "✅ finished in Ns" (the generic format), so a work run can
    // never read as success without a verified outcome (requirement 19).
    return event.subKind === 'completed'
      ? `✅ ${slug} completed (no outcome recorded) · id=${id}`
      : `❌ ${slug} failed · ${reason || 'unknown'} · id=${id}`;
  }

  const wp = (data['workProduct'] ?? {}) as Record<string, unknown>;
  const commits = typeof wp['commitCount'] === 'number' ? (wp['commitCount'] as number) : 0;
  const transitions = (wp['transitions'] ?? {}) as Record<string, unknown>;
  const checked = typeof transitions['tasksNewlyChecked'] === 'number' ? (transitions['tasksNewlyChecked'] as number) : 0;
  const remaining = typeof transitions['tasksRemaining'] === 'number' ? (transitions['tasksRemaining'] as number) : 0;
  const total = checked + remaining;

  switch (outcome) {
    case 'branch-complete': {
      // Phase 3.5 — gated-merge activation: a branch-complete run that landed on
      // the base branch reads as merged; one the gate HELD off it surfaces the
      // reason (never a silently-dropped alert); one not run through gated-merge
      // (or a disposition not stamped) keeps the legacy "not yet on <base>"
      // wording. The base branch is stamped on the event (defaults to `main`).
      const base = typeof data['baseBranch'] === 'string' ? (data['baseBranch'] as string) : 'main';
      if (data['merged'] === true) {
        if (opts.suppressMergeClaim) {
          return `✅ ${slug} branch-complete · ${commits} commit(s) · id=${id}`;
        }
        const branchNote = data['branchDeleted'] === true ? 'branch deleted' : 'branch retained';
        return `✅ ${slug} merged to ${base} · ${commits} commit(s) · ${branchNote} · id=${id}`;
      }
      const held = typeof data['gateHeldReason'] === 'string' ? (data['gateHeldReason'] as string) : '';
      if (held) {
        return `✅ ${slug} branch-complete · held off ${base}: ${held} · ${commits} commit(s) · id=${id}`;
      }
      return `✅ ${slug} branch-complete · ${commits} commit(s), all tasks checked (not yet on ${base}) · id=${id}`;
    }
    case 'partial':
      return `📊 ${slug} partial · ${commits} commit(s), ${checked}/${total} tasks done · id=${id}`;
    case 'noop':
      return `⚠️ ${slug} no-op · did nothing: 0 commits, no task changes, clean tree · id=${id}`;
    case 'dirty-uncommitted':
      return `⚠️ ${slug} dirty-uncommitted · uncommitted work left behind, 0 commits · id=${id}`;
    case 'failed':
      return `❌ ${slug} failed · ${reason || 'unknown'} · id=${id}`;
    default:
      // Unknown outcome — surface it rather than silently dropping to success.
      return `⚠️ ${slug} ${outcome} · ${reason} · id=${id}`;
  }
}

function formatMergeSuccessProgress(event: BusMutationEvent): string | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  if (data['event'] !== 'merge-success') return null;
  const slug = String(data['projectSlug'] ?? event.mutationId.slice(0, 8));
  const base = typeof data['baseBranch'] === 'string' ? data['baseBranch'] : 'main';
  const branch = typeof data['branch'] === 'string' ? data['branch'] : '';
  const product = typeof data['product'] === 'string' ? data['product'] : '';
  const target = product ? `${product}/${slug}` : slug;
  const parts = [
    `✅ ${target} merged to ${base}`,
    branch ? `branch ${branch}` : '',
    `id=${shortMutationId(event.mutationId)}`,
  ].filter((part) => part !== '');
  return parts.join(' · ');
}

function formatCloseoutCommitProgress(event: BusMutationEvent): string | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  if (data['event'] !== 'closeout-commit') return null;
  const taskText = typeof data['taskText'] === 'string' ? data['taskText'] : '';
  const shortSha = typeof data['shortSha'] === 'string'
    ? data['shortSha']
    : typeof data['commitSha'] === 'string'
      ? data['commitSha'].slice(0, 7)
      : '';
  const subject = typeof data['commitSubject'] === 'string' ? data['commitSubject'] : '';
  const done = typeof data['tasksDone'] === 'number' ? data['tasksDone'] : null;
  const total = typeof data['tasksTotal'] === 'number' ? data['tasksTotal'] : null;
  const remaining = typeof data['tasksRemaining'] === 'number' ? data['tasksRemaining'] : null;
  const counts = done !== null && total !== null && remaining !== null
    ? `${done}/${total} done · ${remaining} remaining`
    : '';
  const parts = [
    '📌 closeout commit',
    taskText,
    shortSha,
    counts,
    subject,
  ].filter((part) => part !== '');
  return parts.length > 1 ? parts.join(' · ') : null;
}

/** Legacy generic format for non-gen-eval-loop mutations — unchanged behavior. */
function formatGenericTerminal(event: BusMutationEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  const slug = String(data?.['slug'] ?? data?.['projectSlug'] ?? event.mutationId.slice(0, 8));
  const durationSec = typeof data?.['durationMs'] === 'number' ? data['durationMs'] / 1000 : null;
  const durStr = durationSec !== null ? ` in ${durationSec.toFixed(1)}s` : '';
  return event.subKind === 'completed'
    ? `✅ /work --auto on ${slug} finished${durStr}`
    : `❌ /work --auto on ${slug} failed: ${String(data?.['reason'] ?? 'unknown')}`;
}

/** TelegramSender implements MessageSender by delegating to the existing telegram
 *  client helpers. Maintains per-user typing timers so callers just call
 *  startTyping/stopTyping with a userId rather than managing interval handles. */
export class TelegramSender implements MessageSender {
  readonly name = 'telegram' as const;

  private typingTimers = new Map<number, ReturnType<typeof setInterval>>();
  private trackers = new Map<string, TrackerEntry>();
  // Pending sendMessage promises keyed by opId. editTracker / deleteTracker
  // await these before reading `trackers`, so progress/end events for
  // fast ops can't race ahead of the initial send and become orphaned.
  private pendingSends = new Map<string, Promise<void>>();

  constructor(private bot: TelegramBot) {}

  async send(userId: number, text: string, opts?: SendOpts): Promise<void> {
    // Phase 6 C6.1: when the caller supplies an `approval` payload, render
    // it as a Telegram inline keyboard rather than a plain message. Each
    // option becomes one inline button whose `callback_data` carries the
    // option's `value` — the bot's callback_query handler (C6.2) routes
    // that payload through the same actioning path the cockpit approval
    // inbox uses, so a proposal acted on in either surface is reflected
    // in both. The text is the prompt (already prepared by the caller).
    if (opts?.approval) {
      const buttons = opts.approval.options.map((o) => ({
        text: o.label,
        callback_data: o.value,
      }));
      // Layout: all buttons on a single row. The contract is "one button
      // per option" — the test allows either single-row or multi-row, so
      // the simplest layout is the right default. A future refinement
      // could wrap at N buttons per row for long option lists.
      await this.bot.sendMessage(userId, text, {
        reply_markup: { inline_keyboard: [buttons] },
      });
      return;
    }
    await sendLongMessage(this.bot, userId, text);
  }

  startTyping(userId: number, _label?: string): void {
    if (this.typingTimers.has(userId)) return;
    this.typingTimers.set(userId, startTyping(this.bot, userId));
  }

  stopTyping(userId: number): void {
    const timer = this.typingTimers.get(userId);
    if (timer === undefined) return;
    stopTyping(timer);
    this.typingTimers.delete(userId);
  }

  /** Send a short summary to Telegram on mutation completed/failed. Ignores output/log/progress.
   *  Phase 6 C5 specializes `gen-eval-loop` terminal events into three
   *  structured formats (✅ merged / ⏸ blocked on you / 💥 failed) carrying
   *  rounds, cross-model verdict, and a short id. Project 11 specializes
   *  `work-run` terminals into outcome-aware formats (✅ branch-complete /
   *  📊 partial / ⚠️ no-op / ⚠️ dirty / ❌ failed) so a no-op never reads as
   *  success, and forwards `work-run` `progress` events (the throttled
   *  commit-poll ping) as a lightweight message. Other kinds keep the generic
   *  `/work --auto` format. */
  onMutationEvent(event: BusMutationEvent): void {
    // Project 13 run-start notification: a work-run `start` event carries the
    // un-scrubbed `operatorWorktreePath` so Michael can `cd` straight into a
    // live (or later parked) run. Telegram (to TELEGRAM_USER_ID) is a local-
    // operator surface, so the raw path is delivered verbatim — this is the one
    // surface allowed to carry it un-scrubbed. A start event with no path is a
    // defensive no-op (never surface an empty alert).
    if (event.mutationKind === 'work-run' && event.subKind === 'start') {
      const start = formatWorkRunStart(event);
      if (start) {
        void this.send(event.userId, start).catch((err: unknown) => {
          log.error('TelegramSender.onMutationEvent start send failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return;
    }
    // Project 11 commit-poll progress ping: a throttled work-run `progress`
    // event carries a short "📊 <commit subject> · X/Y tasks" line. Deliver it
    // as a lightweight Telegram message so the user sees mid-run progress; the
    // throttle lives at the poll level so this never spams.
    if (event.mutationKind === 'work-run' && event.subKind === 'progress') {
      const data = event.data as Record<string, unknown> | undefined;
      const line = String(data?.['line'] ?? '');
      if (line) {
        void this.send(event.userId, line).catch((err: unknown) => {
          log.error('TelegramSender.onMutationEvent progress send failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return;
    }
    if (event.mutationKind === 'orchestrated-work' && event.subKind === 'progress') {
      const text = formatMergeSuccessProgress(event) ?? formatCloseoutCommitProgress(event);
      if (text) {
        void this.send(event.userId, text).catch((err: unknown) => {
          log.error('TelegramSender.onMutationEvent orchestrated progress send failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return;
    }
    if (event.subKind !== 'completed' && event.subKind !== 'failed') return;
    const text = event.mutationKind === 'gen-eval-loop'
      ? formatGenEvalLoopTerminal(event)
      // `orchestrated-work` and `work-run-release` terminals carry the same
      // outcome payload as work-run, so render them through the outcome-aware
      // formatter rather than the generic "/work --auto on <uuid>" fallback.
      : event.mutationKind === 'work-run' || event.mutationKind === 'work-run-release' || event.mutationKind === 'work-run-answer' || event.mutationKind === 'orchestrated-work'
        ? formatWorkRunTerminal(event, { suppressMergeClaim: event.mutationKind === 'orchestrated-work' })
        : formatGenericTerminal(event);
    // Project 13 Phase 1c: a PARKED work-run terminal gets a one-tap Release
    // button whose callback id (`work-run-release:<id>`) routes through the same
    // shared release runtime the cockpit uses. The id is the parked run's id
    // (== this mutation id). A dirty worktree is gated by the release preflight,
    // so this clean-release tap is safe.
    const data = (event.data ?? {}) as Record<string, unknown>;
    const parkedQuestion = data['parkedQuestion'] && typeof data['parkedQuestion'] === 'object'
      ? data['parkedQuestion'] as Record<string, unknown>
      : null;
    const questionOptions = parkedQuestion && Array.isArray(parkedQuestion['options'])
      ? parkedQuestion['options'].flatMap((raw) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
          const option = raw as Record<string, unknown>;
          if (typeof option['id'] !== 'string' || typeof option['label'] !== 'string') return [];
          return [{ label: option['label'], value: `work-run-answer:${event.mutationId}:${option['id']}` }];
        })
      : [];
    const releaseApproval =
      (event.mutationKind === 'work-run' || event.mutationKind === 'work-run-answer') && data['parked'] === true && questionOptions.length > 0
        ? { approval: { prompt: 'Answer this question to resume the parked run:', options: questionOptions } }
        : event.mutationKind === 'work-run' && data['parked'] === true
        ? { approval: { prompt: 'Release this parked run?', options: [{ label: '🔓 Release', value: `work-run-release:${event.mutationId}` }] } }
        : undefined;
    void this.send(event.userId, text, releaseApproval).catch((err: unknown) => {
      log.error('TelegramSender.onMutationEvent send failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  /** Render a tracker message per in-flight Claude op: send on start, edit
   *  elapsed every ~10s, delete on end. Skipped for sub-second classifier ops
   *  so the resolver doesn't spam the chat. */
  onOpEvent(event: BusOpEvent): void {
    if (event.opKind === 'classifier') return;
    if (event.subKind === 'start') {
      this.sendTracker(event);
    } else if (event.subKind === 'progress') {
      void this.editTracker(event);
    } else {
      void this.deleteTracker(event);
    }
  }

  private formatTracker(event: BusOpEvent): string {
    const elapsedSec = Math.floor(event.elapsedMs / 1000);
    return `🤔 ${event.label} · ${elapsedSec}s · /cancel`;
  }

  private sendTracker(event: BusOpEvent): void {
    const text = this.formatTracker(event);
    const send = this.bot.sendMessage(event.userId, text)
      .then((msg) => {
        this.trackers.set(event.opId, {
          userId: event.userId,
          messageId: msg.message_id,
          lastEditTs: Date.now(),
        });
      })
      .catch((err: unknown) => {
        log.warn('tracker send failed', { error: err instanceof Error ? err.message : String(err) });
      });
    this.pendingSends.set(event.opId, send);
    void send.finally(() => {
      if (this.pendingSends.get(event.opId) === send) this.pendingSends.delete(event.opId);
    });
  }

  private async editTracker(event: BusOpEvent): Promise<void> {
    await this.pendingSends.get(event.opId);
    const entry = this.trackers.get(event.opId);
    if (!entry) return;
    const now = Date.now();
    if (now - entry.lastEditTs < TRACKER_EDIT_THROTTLE_MS) return;
    const text = this.formatTracker(event);
    entry.lastEditTs = now;
    await this.bot.editMessageText(text, { chat_id: entry.userId, message_id: entry.messageId })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Telegram returns 400 with these messages when the user has already
        // deleted the tracker or the text matches what's currently rendered.
        if (msg.includes('message is not modified') || msg.includes('message to edit not found')) return;
        log.warn('tracker edit failed', { error: msg });
      });
  }

  private async deleteTracker(event: BusOpEvent): Promise<void> {
    await this.pendingSends.get(event.opId);
    const entry = this.trackers.get(event.opId);
    if (!entry) return;
    this.trackers.delete(event.opId);
    await this.bot.deleteMessage(entry.userId, entry.messageId)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('message to delete not found')) return;
        log.warn('tracker delete failed', { error: msg });
      });
  }

  /** Drain typing timers and best-effort delete in-flight tracker messages.
   *  Without the delete pass, orphaned "🤔 …" messages would linger in the
   *  chat after a restart with no way to cancel the (already-dead) op. */
  shutdown(): void {
    for (const [userId, timer] of this.typingTimers) {
      stopTyping(timer);
      this.typingTimers.delete(userId);
    }
    for (const [, entry] of this.trackers) {
      void this.bot.deleteMessage(entry.userId, entry.messageId).catch(() => {
        // Best-effort — restart already in progress, swallow errors
      });
    }
    this.trackers.clear();
    this.pendingSends.clear();
  }
}
