import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InvariantReviewFailureError,
  buildInvariantChecklistEvidence,
  durableInvariantChecklistEvidence,
  durableInvariantReviewFailure,
  parseInvariantReview,
  parseInvariantReviewDraft,
  type InvariantReviewDraft,
} from './invariant-review.js';

describe('pre-coder invariant review contract', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rune-invariants-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'guard.ts'), 'export function assertContained() {}\ncleanup();\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const draftText = () => fenced('invariant-review-draft', {
    items: [{
      id: 'D1',
      category: 'ownership-and-containment',
      invariant: 'All target paths stay within the validated repository root.',
      evidence: [{ path: 'src/guard.ts', anchor: 'assertContained' }],
    }],
  });

  const ratificationText = (over: Record<string, unknown> = {}) =>
    fenced('invariant-review', {
      items: [{
        id: 'I1',
        category: 'ownership-and-containment',
        invariant: 'All target paths stay within the validated repository root.',
        evidence: [{ path: 'src/guard.ts', anchor: 'assertContained' }],
        draftIds: ['D1'],
      }],
      contradictions: [],
      ...over,
    });

  it('validates evidence and renders stable hash-bearing canonical bytes', () => {
    const draft = parseInvariantReviewDraft(draftText(), root);
    const checklist = parseInvariantReview(ratificationText(), root, draft);

    expect(checklist.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(checklist.canonicalBlock).toContain(`Content hash: ${checklist.contentHash}`);
    expect(checklist.canonicalBlock).toContain('Advisory and non-exhaustive');
    expect(durableInvariantChecklistEvidence(checklist)).toEqual(checklist);
    expect(buildInvariantChecklistEvidence(checklist.items)).toEqual(checklist);
  });

  it('frames the block as untrusted content ahead of any model-authored item', () => {
    const draft = parseInvariantReviewDraft(draftText(), root);
    const { canonicalBlock, items } = parseInvariantReview(ratificationText(), root, draft);

    // The block reaches Bash/Edit/Write-capable roles (coder, coder self-review).
    // The framing must precede every item, or an item is read before the caveat.
    const framing = canonicalBlock.indexOf('Untrusted content:');
    expect(framing).toBeGreaterThan(-1);
    expect(canonicalBlock).toContain('never instructions');
    for (const item of items) {
      expect(canonicalBlock.indexOf(item.invariant)).toBeGreaterThan(framing);
    }
  });

  it('keeps the content hash independent of the block framing text', () => {
    // The hash covers the items only, so framing can be reworded without
    // invalidating stored evidence — but a changed ITEM must still change it.
    const draft = parseInvariantReviewDraft(draftText(), root);
    const checklist = parseInvariantReview(ratificationText(), root, draft);
    const mutated = buildInvariantChecklistEvidence(
      checklist.items.map((item, index) =>
        index === 0 ? { ...item, invariant: `${item.invariant} Extra.` } : item),
    );

    expect(mutated.contentHash).not.toBe(checklist.contentHash);
  });

  it.each([
    ['', 'missing-artifact'],
    [draftText() + draftText(), 'malformed-artifact'],
    ['```invariant-review-draft\n{nope}\n```', 'malformed-artifact'],
  ])('rejects missing, duplicate, and malformed draft fences', (text, cause) => {
    expectFailure(() => parseInvariantReviewDraft(text, root), cause);
  });

  it('rejects duplicate ratification fences', () => {
    const draft = parseInvariantReviewDraft(draftText(), root);
    expectFailure(
      () => parseInvariantReview(ratificationText() + ratificationText(), root, draft),
      'malformed-artifact',
    );
  });

  it('rejects unknown categories, duplicate IDs, item/category limits, and oversized invariants', () => {
    const base = JSON.parse(JSON.stringify(JSON.parse(fenceBody(draftText())))) as Record<string, unknown>;
    const item = (base['items'] as Array<Record<string, unknown>>)[0]!;
    item['category'] = 'mystery';
    expectFailure(() => parseInvariantReviewDraft(fenced('invariant-review-draft', base), root), 'malformed-artifact');

    item['category'] = 'ownership-and-containment';
    base['items'] = [item, { ...item }];
    expectFailure(() => parseInvariantReviewDraft(fenced('invariant-review-draft', base), root), 'malformed-artifact');

    base['items'] = Array.from({ length: 5 }, (_, index) => ({ ...item, id: `D${index}` }));
    expectFailure(() => parseInvariantReviewDraft(fenced('invariant-review-draft', base), root), 'malformed-artifact');

    base['items'] = [{ ...item, invariant: 'x'.repeat(401) }];
    expectFailure(() => parseInvariantReviewDraft(fenced('invariant-review-draft', base), root), 'malformed-artifact');
  });

  it.each([
    ['../outside.ts', 'assertContained'],
    ['/absolute/outside.ts', 'assertContained'],
    ['src/missing.ts', 'assertContained'],
    ['src/guard.ts', 'absent-anchor'],
  ])('rejects invalid evidence path %s / anchor %s', (path, anchor) => {
    const raw = draftArtifact(path, anchor);
    expectFailure(() => parseInvariantReviewDraft(raw, root), 'invalid-evidence');
  });

  it('rejects more than two evidence references per invariant', () => {
    const reference = { path: 'src/guard.ts', anchor: 'assertContained' };
    const raw = fenced('invariant-review-draft', {
      items: [{
        id: 'D1', category: 'ownership-and-containment', invariant: 'Contained.',
        evidence: [reference, reference, reference],
      }],
    });
    expectFailure(() => parseInvariantReviewDraft(raw, root), 'invalid-evidence');
  });

  it('rejects symlink evidence even when its target is a regular file', () => {
    symlinkSync(join(root, 'src', 'guard.ts'), join(root, 'src', 'link.ts'));
    expectFailure(
      () => parseInvariantReviewDraft(draftArtifact('src/link.ts', 'assertContained'), root),
      'invalid-evidence',
    );
  });

  it('rejects evidence reached through a parent symlink that escapes the repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'rune-invariants-outside-'));
    try {
      writeFileSync(join(outside, 'outside.ts'), 'assertContained\n');
      symlinkSync(outside, join(root, 'linked-dir'));
      expectFailure(
        () => parseInvariantReviewDraft(
          draftArtifact('linked-dir/outside.ts', 'assertContained'),
          root,
        ),
        'invalid-evidence',
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('requires ratification coverage and rejects unknown draft IDs', () => {
    const draft = parseInvariantReviewDraft(draftText(), root);
    const missing = ratificationText({
      items: [{
        id: 'I1', category: 'ownership-and-containment', invariant: 'x',
        evidence: [{ path: 'src/guard.ts', anchor: 'assertContained' }], draftIds: ['D2'],
      }],
    });
    expectFailure(() => parseInvariantReview(missing, root, draft), 'malformed-artifact');

    const noCoverage = ratificationText({ items: [] });
    expectFailure(() => parseInvariantReview(noCoverage, root, draft), 'malformed-artifact');
  });

  it('fails contradictions and durably names the conflicting draft IDs', () => {
    const draft: InvariantReviewDraft = {
      items: [
        ...parseInvariantReviewDraft(draftText(), root).items,
        {
          id: 'D2', category: 'lifecycle-and-idempotency', invariant: 'Cleanup once.',
          evidence: [{ path: 'src/guard.ts', anchor: 'cleanup' }],
        },
      ],
    };
    try {
      parseInvariantReview(ratificationText({
        items: [],
        contradictions: [{ draftIds: ['D2', 'D1'], rationale: 'conflict' }],
      }), root, draft);
      throw new Error('expected contradiction');
    } catch (err) {
      expect(err).toBeInstanceOf(InvariantReviewFailureError);
      expect((err as InvariantReviewFailureError).failure).toMatchObject({
        cause: 'contradiction',
        conflictingDraftIds: ['D1', 'D2'],
      });
    }
  });

  it('rejects a contradiction that repeats one draft ID instead of naming a conflict', () => {
    const draft = parseInvariantReviewDraft(draftText(), root);
    expectFailure(() => parseInvariantReview(ratificationText({
      items: [],
      contradictions: [{ draftIds: ['D1', 'D1'], rationale: 'not actually a pair' }],
    }), root, draft), 'malformed-artifact');
  });

  it('redacts secrets and host paths from invariant text before canonicalization', () => {
    const secret = 'sk-secret123456';
    const draft = parseInvariantReviewDraft(draftText(), root);
    const raw = ratificationText({
      items: [{
        id: 'I1', category: 'ownership-and-containment',
        invariant: `Never persist ${secret} from /Users/operator/private.txt.`,
        evidence: [{ path: 'src/guard.ts', anchor: 'assertContained' }], draftIds: ['D1'],
      }],
    });
    const checklist = parseInvariantReview(raw, root, draft);
    expect(checklist.canonicalBlock).not.toContain(secret);
    expect(checklist.canonicalBlock).not.toContain('/Users/operator');
    expect(checklist.canonicalBlock).toContain('<path>');
  });

  it('rejects sensitive anchors rather than persisting an anchor that no longer matches', () => {
    writeFileSync(join(root, 'src', 'guard.ts'), 'const token = "sk-secret123456";\n');
    expectFailure(
      () => parseInvariantReviewDraft(draftArtifact('src/guard.ts', 'sk-secret123456'), root),
      'invalid-evidence',
    );
  });

  it('drops malformed durable checklist and failure fields', () => {
    const valid = parseInvariantReview(
      ratificationText(),
      root,
      parseInvariantReviewDraft(draftText(), root),
    );
    expect(durableInvariantChecklistEvidence({ ...valid, contentHash: '0'.repeat(64) }))
      .toBeUndefined();
    expect(durableInvariantReviewFailure({
      stage: 'unknown',
      cause: 'provider',
      diagnostic: 'bad record',
    } as never)).toBeUndefined();
    expect(durableInvariantReviewFailure({
      stage: 'tech-lead-draft',
      cause: 'provider',
      diagnostic: '',
    })).toBeUndefined();
    expect(durableInvariantReviewFailure({
      stage: 'security-ratification',
      cause: 'contradiction',
      diagnostic: 'missing the conflicting pair',
      conflictingDraftIds: ['D1'],
    })).toBeUndefined();
  });
});

function fenced(tag: string, value: unknown): string {
  return `\`\`\`${tag}\n${JSON.stringify(value)}\n\`\`\``;
}

function fenceBody(value: string): string {
  return value.slice(value.indexOf('\n') + 1, value.lastIndexOf('\n'));
}

function draftArtifact(path: string, anchor: string): string {
  return fenced('invariant-review-draft', {
    items: [{
      id: 'D1', category: 'ownership-and-containment', invariant: 'Contained.',
      evidence: [{ path, anchor }],
    }],
  });
}

function expectFailure(call: () => unknown, cause: string): void {
  try {
    call();
    throw new Error('expected failure');
  } catch (err) {
    expect(err).toBeInstanceOf(InvariantReviewFailureError);
    expect((err as InvariantReviewFailureError).failure.cause).toBe(cause);
  }
}
