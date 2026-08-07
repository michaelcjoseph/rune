import { describe, expect, it } from 'vitest';
import { parsePreCloseoutValidationEvidence } from './pre-closeout-validation.js';

describe('pre-closeout validation evidence', () => {
  it('round-trips bounded receipt timing and reuse diagnostics', () => {
    const evidence = {
      version: 1 as const,
      receiptId: 'a'.repeat(64),
      durationMs: 1_234,
      outcome: 'passed' as const,
      reuseDecision: 'reused' as const,
    };
    expect(parsePreCloseoutValidationEvidence(evidence)).toEqual(evidence);
  });

  it('requires a typed reason for fallback and rejects unbounded or extra data', () => {
    expect(parsePreCloseoutValidationEvidence({
      version: 1,
      durationMs: 5,
      outcome: 'passed',
      reuseDecision: 'fallback',
    })).toBeUndefined();
    expect(parsePreCloseoutValidationEvidence({
      version: 1,
      durationMs: 5,
      outcome: 'passed',
      reuseDecision: 'fallback',
      invalidationReason: 'toolchain-drift',
      rawOutput: 'secret',
    })).toBeUndefined();
  });

  it('round-trips recovery uncertainty without carrying recovered candidate data', () => {
    expect(parsePreCloseoutValidationEvidence({
      version: 1,
      durationMs: 0,
      outcome: 'skipped',
      reuseDecision: 'fallback',
      invalidationReason: 'recovery-uncertain',
    })).toEqual({
      version: 1,
      durationMs: 0,
      outcome: 'skipped',
      reuseDecision: 'fallback',
      invalidationReason: 'recovery-uncertain',
    });
  });
});
