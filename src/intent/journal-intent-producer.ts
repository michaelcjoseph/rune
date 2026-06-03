/**
 * Journal-to-intent producer — the nightly C7 step body that turns a day's
 * journal text into pending entries in `logs/intent-proposal-queue.json`.
 *
 * Pure: this module owns the *parse* (scan markdown for product-tagged notes)
 * and the *planning* (route through `planJournalIntent`) and the *dedupe*
 * (against the existing queue). The actual queue I/O is the step caller's
 * job — `runJournalIntentProducer` returns the entries to enqueue rather
 * than writing them itself, which keeps this module easy to test with
 * synthetic inputs and side-effect-free.
 *
 * Two-stage shape:
 *   1. `scanJournalForIntent(content, registeredProducts)` extracts
 *      `JournalNote[]` from the day's markdown. Each line with one or more
 *      `#<slug>` tags becomes a note; the slug list is the `products`
 *      attribution (registered + unregistered, the planner decides which is
 *      which). Lines with no tags produce no note (the planner would skip
 *      them, but we avoid even building the noise).
 *   2. `runJournalIntentProducer({journalContent, registeredProducts,
 *      existingQueueEntries})` runs the full pipeline:
 *      scan → planJournalIntent → derive a stable sourceNoteId per
 *      proposal → drop proposals whose sourceNoteId is already in the
 *      queue (idempotency: re-running on the same journal must not
 *      re-enqueue, regardless of the existing entry's status — a rejected
 *      proposal stays rejected; the dedupe key is sourceNoteId, not
 *      proposal kind or pending status).
 *
 * Test contract: `src/intent/journal-intent-e2e.test.ts` (§21).
 *
 * STATUS: Phase 6 C7 — producer. C7 sub-task 1 (nightly wiring) lives in
 * `src/jobs/nightly.ts`; this module is the parse + plan + dedupe core
 * that wiring consumes.
 */

import { createHash } from 'node:crypto';
import { planJournalIntent, type JournalNote, type IntentProposal } from './journal-intent.js';

/** Lower-case slug — same convention as `policies/products.json` and the
 *  registry. Single rule keeps the tag-extraction parser unambiguous when
 *  multiple `#<slug>` tags appear on one line. */
const SLUG_RE = /#([a-z0-9][a-z0-9_-]*)\b/g;

/**
 * Extract product-tagged notes from a day's journal markdown.
 *
 * Each line containing one or more `#<slug>` tags becomes a `JournalNote`
 * whose `text` is the surrounding line (with the tag(s) intact — the
 * downstream synthesizer chooses whether to keep them) and whose
 * `products` is the deduped slug list in first-seen order. Untagged lines
 * produce no note. Both registered and unregistered products are emitted
 * — the planner downstream needs the unregistered ones to emit
 * `register-product` proposals (and the registered ones to emit
 * `vault-intake`). The registry filtering happens in `planJournalIntent`,
 * not here.
 */
export function scanJournalForIntent(content: string): JournalNote[] {
  const notes: JournalNote[] = [];
  // Line-based scan — a tagged note is a single line. The journal format
  // uses bullet points and short paragraphs; a single line is the right
  // granule (multi-line synthesis happens later, in the vault updater).
  for (const rawLine of content.split('\n')) {
    const products = extractProducts(rawLine);
    if (products.length === 0) continue;
    notes.push({ text: rawLine.trim(), products });
  }
  return notes;
}

/** Pull every `#<slug>` from a line, deduped, preserving first-seen order. */
function extractProducts(line: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of line.matchAll(SLUG_RE)) {
    const slug = match[1]!;
    // Skip purely-numeric tags. A product slug is a named thing; an all-digit
    // `#<n>` is always a prose list reference ("approach #2", "item #4 is from
    // the Julien call"), never a product. Left unguarded these misfire as
    // `register-product` proposals for products named "2"/"4" (and feed
    // `disambiguation` candidate lists with the same junk).
    if (/^\d+$/.test(slug)) continue;
    // Skip well-known non-product tags so a `#playbook` / `#crm` / `#meeting`
    // marker on a non-product line doesn't get mistaken for a product slug.
    if (NON_PRODUCT_TAGS.has(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/** Tag names already in use by other journal-scanning conventions. The
 *  scanner skips these so a line tagged `#playbook` doesn't get picked up
 *  as a product reference. Add to this list when a new journal-scoped
 *  convention lands.
 *
 *  Sourced from the daily-tags analyzer prompt in `src/jobs/nightly.ts`
 *  (the canonical list of journal-routing tags) plus the JSON-data-store
 *  routing targets. Includes both singular and plural forms (e.g. `book`
 *  / `books`) since the journal convention is loose. */
const NON_PRODUCT_TAGS = new Set([
  // Conversation/intent tags scanned by other nightly steps.
  'playbook', 'crm', 'meeting', 'family', 'career', 'idea',
  // Data-store routing tags used by the daily-tags analyzer.
  'health', 'workout', 'workouts',
  'book', 'books', 'blog',
  'diet', 'nutrition',
  'study', 'progress',
  'place', 'places',
  'priorities', 'topics',
  'application', 'applications',
  'investment', 'investments',
]);

/** A single queue entry: the proposal plus the stable id of the source
 *  note used for cross-pass dedupe. The shape matches what the e2e test
 *  passes back as `existingQueueEntries`. */
export interface JournalIntentQueueEntry {
  sourceNoteId: string;
  proposal: IntentProposal;
}

/** Inputs and outputs for the C7 step body. Internal — the nightly caller
 *  constructs the input inline and destructures the output; no external
 *  module imports these types. */
interface JournalIntentProducerInput {
  journalContent: string;
  registeredProducts: string[];
  existingQueueEntries: JournalIntentQueueEntry[];
}
interface JournalIntentProducerOutput {
  toEnqueue: JournalIntentQueueEntry[];
}

/**
 * Run the full producer pipeline for one journal — scan → plan → derive
 * sourceNoteIds → dedupe against the existing queue. Returns the entries
 * the caller should append (the caller owns the queue file).
 *
 * Idempotency: the dedupe key is `sourceNoteId`, a stable hash of the
 * proposal's identifying fields (kind + product + note/item). Re-running
 * with the previously produced entries in `existingQueueEntries` yields
 * an empty `toEnqueue` regardless of those entries' status — a rejected
 * proposal stays rejected because the dedupe doesn't look at status.
 */
export function runJournalIntentProducer(
  input: JournalIntentProducerInput,
): JournalIntentProducerOutput {
  const notes = scanJournalForIntent(input.journalContent);
  const plan = planJournalIntent({
    notes,
    roadmapCandidates: [],
    registeredProducts: input.registeredProducts,
  });
  const existingIds = new Set(input.existingQueueEntries.map((e) => e.sourceNoteId));
  const toEnqueue: JournalIntentQueueEntry[] = [];
  for (const proposal of plan.proposals) {
    const sourceNoteId = makeSourceNoteId(proposal);
    if (existingIds.has(sourceNoteId)) continue;
    // Guard against an in-batch duplicate too — if two journal lines happen
    // to produce the same proposal (same product + same text), the second
    // is a redundant dedupe of the first. The Set absorbs it.
    existingIds.add(sourceNoteId);
    toEnqueue.push({ sourceNoteId, proposal });
  }
  return { toEnqueue };
}

/** Build a stable id for a proposal — same input always hashes to the same
 *  output, so a re-run sees the previous run's entries and skips. The hash
 *  includes the discriminant + the identifying fields per kind. */
function makeSourceNoteId(proposal: IntentProposal): string {
  let payload: string;
  switch (proposal.kind) {
    case 'vault-intake':
      payload = `vault-intake:${proposal.product}:${proposal.note}`;
      break;
    case 'roadmap':
      payload = `roadmap:${proposal.product}:${proposal.item}`;
      break;
    case 'register-product':
      payload = `register-product:${proposal.product}:${proposal.note}`;
      break;
    case 'disambiguation':
      // The candidate order is stable from the scanner (first-seen), so
      // include it in the hash directly without sorting.
      payload = `disambiguation:${proposal.note}:${proposal.candidates.join(',')}`;
      break;
  }
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
