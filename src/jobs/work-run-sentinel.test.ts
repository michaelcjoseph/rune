import { describe, it, expect } from 'vitest';
import {
  parseWorkRunSentinel,
  WORK_RUN_SENTINEL_MARKER,
  type WorkRunSentinel,
} from './work-run-sentinel.js';

// Project 13 Phase 1b — sentinel parser (test-plan.md §2 "Sentinel parsing").
// Written test-first: `parseWorkRunSentinel` is a stub returning null, so the
// valid-sentinel cases are RED until the implementation task lands; the
// malformed→null cases pass as guards (and pin the reject contract).

describe('parseWorkRunSentinel', () => {
  /** Build a result-text block ending in a sentinel line. */
  function withSentinel(json: string, preamble = 'All done with the prep work.\n'): string {
    return `${preamble}${WORK_RUN_SENTINEL_MARKER} ${json}`;
  }

  describe('valid sentinels (RED until impl)', () => {
    it('parses a minimal valid sentinel (version + pendingCheck only)', () => {
      const text = withSentinel('{"version":1,"pendingCheck":"Run the interactive Codex check"}');
      const parsed = parseWorkRunSentinel(text);
      expect(parsed).not.toBeNull();
      expect(parsed!.version).toBe(1);
      expect(parsed!.pendingCheck).toBe('Run the interactive Codex check');
      expect(parsed!.command).toBeUndefined();
      expect(parsed!.reason).toBeUndefined();
    });

    it('parses optional command + reason when present', () => {
      const text = withSentinel(
        '{"version":1,"pendingCheck":"Confirm the result","command":"npm run codex-check","reason":"needs a human at the keyboard"}',
      );
      const parsed = parseWorkRunSentinel(text);
      expect(parsed).not.toBeNull();
      const sentinel: WorkRunSentinel = parsed!;
      expect(sentinel.pendingCheck).toBe('Confirm the result');
      expect(sentinel.command).toBe('npm run codex-check');
      expect(sentinel.reason).toBe('needs a human at the keyboard');
    });

    it('parses the sentinel as the final line after multi-line agent prose', () => {
      const text = [
        'I worked through tasks 1-3 but task 4 needs an interactive login.',
        'Reporting to the operator.',
        `${WORK_RUN_SENTINEL_MARKER} {"version":1,"pendingCheck":"Log in to the dashboard and approve"}`,
      ].join('\n');
      const parsed = parseWorkRunSentinel(text);
      expect(parsed?.pendingCheck).toBe('Log in to the dashboard and approve');
    });

    it('the LAST sentinel line wins when more than one is present', () => {
      const text = [
        `${WORK_RUN_SENTINEL_MARKER} {"version":1,"pendingCheck":"first (stale)"}`,
        `${WORK_RUN_SENTINEL_MARKER} {"version":1,"pendingCheck":"second (final)"}`,
      ].join('\n');
      expect(parseWorkRunSentinel(text)?.pendingCheck).toBe('second (final)');
    });
  });

  describe('rejected sentinels → null (guards, green pre-impl)', () => {
    it('returns null when no marker is present', () => {
      expect(parseWorkRunSentinel('Just ordinary final output, no sentinel here.')).toBeNull();
    });

    it('returns null for malformed JSON after the marker', () => {
      expect(parseWorkRunSentinel(withSentinel('{"version":1, "pendingCheck": '))).toBeNull();
    });

    it('returns null when JSON is a non-object (array / primitive)', () => {
      expect(parseWorkRunSentinel(withSentinel('[1,2,3]'))).toBeNull();
      expect(parseWorkRunSentinel(withSentinel('"just a string"'))).toBeNull();
    });

    it('returns null for an unsupported version', () => {
      expect(parseWorkRunSentinel(withSentinel('{"version":2,"pendingCheck":"x"}'))).toBeNull();
      expect(parseWorkRunSentinel(withSentinel('{"version":"1","pendingCheck":"x"}'))).toBeNull();
    });

    it('returns null when pendingCheck is missing, empty, or non-string', () => {
      expect(parseWorkRunSentinel(withSentinel('{"version":1}'))).toBeNull();
      expect(parseWorkRunSentinel(withSentinel('{"version":1,"pendingCheck":""}'))).toBeNull();
      expect(parseWorkRunSentinel(withSentinel('{"version":1,"pendingCheck":"   "}'))).toBeNull();
      expect(parseWorkRunSentinel(withSentinel('{"version":1,"pendingCheck":42}'))).toBeNull();
    });

    it('returns null when command or reason is present but not a string', () => {
      expect(
        parseWorkRunSentinel(withSentinel('{"version":1,"pendingCheck":"x","command":123}')),
      ).toBeNull();
      expect(
        parseWorkRunSentinel(withSentinel('{"version":1,"pendingCheck":"x","reason":{"a":1}}')),
      ).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(parseWorkRunSentinel('')).toBeNull();
    });
  });
});
