#!/usr/bin/env node
/**
 * Stop hook: block a turn from ending on a non-response.
 *
 * Enforces execution-discipline rule 2 (~/.claude/CLAUDE.md): every turn must
 * end with a substantive user-facing message. A turn that ends silently — empty
 * output, or a known non-response like "No response requested." — is always
 * wrong, even when the task is complete (the correct ending is an explicit
 * "Done — <what landed>").
 *
 * Contract (Claude Code Stop hook):
 *   stdin  : JSON { transcript_path, stop_hook_active, session_id, ... }
 *   stdout : JSON { decision: "block", reason } to force a continuation,
 *            or nothing (exit 0) to allow the stop.
 *
 * Loop guard: when `stop_hook_active` is true we are ALREADY continuing because
 * of a prior block from this hook. We do not block a second time — that caps
 * retries at one and prevents an infinite stop/continue loop. We still log the
 * repeat so a persistent non-responder is visible.
 *
 * This is a NECESSARY-not-SUFFICIENT check: it guarantees a real message is
 * emitted; it cannot verify the message is true. "Said done but wasn't" is a
 * separate failure (rule 1/3), out of scope here.
 */

'use strict';

const fs = require('fs');

const AUDIT_LOG = '/Users/jarvis/workspace/jarvis/logs/hook-nonresponse.jsonl';

/** Normalize a message to its alphanumeric skeleton for exact denylist match.
 *  "No response requested." -> "noresponserequested". Exact-equality match (not
 *  substring) so a message that legitimately discusses "no response" is not
 *  caught. */
function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Known non-responses, normalized. Add new variants here as they surface —
// denylist by design (near-zero false positives) rather than a length floor
// (which would catch legitimately terse replies like "Done.").
const DENYLIST = new Set([
  'noresponserequested',
  'noresponseneeded',
  'noresponserequired',
  'noresponsenecessary',
  'noresponse',
  'nofurtherresponse',
  'nofurtheraction',
  'nothingtodo',
  'nothingtoreport',
]);

function audit(record) {
  try {
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(record) + '\n');
  } catch {
    // Audit is best-effort — never let a logging failure break the hook.
  }
}

/** Pull the final assistant message text from a transcript JSONL file.
 *  Returns the concatenated text blocks of the last `type: "assistant"` entry,
 *  trimmed. Empty string when there is no assistant text (e.g. the turn ended
 *  on a tool-use block with no prose). */
function lastAssistantText(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null; // can't read — fail open (see main)
  }
  const lines = raw.split('\n').filter(Boolean);
  // A single assistant turn is written as MULTIPLE JSONL entries — a
  // thinking-only entry, a text entry, a tool_use entry — each on its own
  // line. Trusting only the last assistant entry false-positives when the turn
  // ends on a thinking- or tool_use-only block (textlen 0) even though earlier
  // entries in the SAME turn carried real prose. So accumulate text across all
  // assistant entries in the current turn, scanning back only to the turn
  // boundary: a genuine user prompt (string content), NOT a tool_result entry
  // (user-role entries whose content is a tool_result array — those are
  // intra-turn, not a new human message).
  const parts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type === 'user' && entry.message) {
      const c = entry.message.content;
      // A real human turn boundary: plain string, or an array with no
      // tool_result block. Tool-result carrier entries are intra-turn — skip.
      const isToolResult =
        Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
      if (!isToolResult) break;
      continue;
    }
    if (entry.type !== 'assistant' || !entry.message) continue;
    const content = entry.message.content;
    if (typeof content === 'string') {
      if (content.trim()) parts.push(content.trim());
    } else if (Array.isArray(content)) {
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim();
      if (text) parts.push(text);
    }
  }
  // parts is newest-first; order doesn't matter for the empty/denylist check.
  return parts.join('\n').trim();
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    // Malformed hook input — fail open so we never wedge a session.
    process.exit(0);
  }

  const ts = new Date().toISOString();
  const text = input.transcript_path ? lastAssistantText(input.transcript_path) : null;

  // Could not read the transcript — fail open. Blocking on an unreadable
  // transcript would risk wedging every turn; better to under-enforce.
  if (text === null) {
    audit({ ts, action: 'allow', reason: 'transcript-unreadable', session: input.session_id });
    process.exit(0);
  }

  const isNonResponse = text === '' || DENYLIST.has(normalize(text));

  if (!isNonResponse) {
    process.exit(0); // normal path: real message, allow the stop silently
  }

  // One-retry cap: if we already forced a continuation and STILL got a
  // non-response, let the turn end but log it loudly.
  if (input.stop_hook_active) {
    audit({
      ts,
      action: 'allow-after-retry',
      reason: 'non-response persisted after one block',
      sample: text.slice(0, 80),
      session: input.session_id,
    });
    process.exit(0);
  }

  audit({
    ts,
    action: 'block',
    sample: text.slice(0, 80),
    session: input.session_id,
  });

  const reason =
    "Your turn ended on a non-response" +
    (text ? ` ("${text.slice(0, 60)}")` : ' (empty message)') +
    '. Per execution-discipline rule 2, every turn must end with a substantive ' +
    'user-facing message. If the task is complete, say so explicitly ' +
    "(e.g. \"Done — <what landed>\"). If you're blocked, state what on. Continue now.";

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

main();
