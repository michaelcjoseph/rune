import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * Test-first suite for test-plan.md §6 — escalation policy (08-intent-layer, Phase 1).
 *
 * Written BEFORE the implementation. `src/intent/escalation.ts` currently ships as a
 * contract stub whose functions throw 'not implemented', so every test here is RED. That is
 * the intended, correct state: this is a "Tests (write first)" task — the suite goes green
 * when Phase 1's escalation-policy implementation tasks land. Do not implement the policy to
 * make these pass; that is a separate task.
 */

// --- Mocks (must precede the module import) ---
// Every escalation decision is logged for auditability; the implementation imports createLogger.
const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../utils/logger.js', () => ({ createLogger: () => mockLog }));

import {
  parseEscalationPolicy,
  decide,
  decideFailClosed,
  type EscalationPolicy,
} from './escalation.js';

// --- Fixtures ---

/** A policy with one rule per escalation condition from the spec. */
function samplePolicy(overrides: Partial<EscalationPolicy> = {}): EscalationPolicy {
  return {
    version: 1,
    rules: [
      {
        id: 'high-risk-paths',
        condition: 'high-risk-change-class',
        pathPatterns: ['**/auth.ts', '**/migrations/**', '**/credentials/**'],
      },
      { id: 'unresolved-review', condition: 'unresolvable-cross-model-review' },
      { id: 'evaluator-round-cap', condition: 'run-exceeded-bounds', maxEvaluatorRounds: 3 },
      { id: 'consequential-self-spec', condition: 'consequential-self-generated-spec' },
    ],
    ...overrides,
  };
}

/** A change that matches no escalation condition under `samplePolicy()`. */
function benignChange() {
  return {
    changedPaths: ['src/intent/registry.ts'],
    crossModelReview: 'resolved' as const,
    evaluatorRounds: 1,
    specOrigin: 'michael' as const,
    specConsequence: 'routine' as const,
  };
}

/** Flatten every logged argument across levels into one searchable string. */
function allLogs(): string {
  return [mockLog.info, mockLog.warn, mockLog.error, mockLog.debug]
    .flatMap((fn) => fn.mock.calls)
    .flat()
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('escalation policy — declarative file, data not code (test-plan §6)', () => {
  it('treats the policy as data — a rule added only as file content fires with no code change', () => {
    // The `payment-code` rule is not in samplePolicy(); it exists purely as parsed file
    // content. It driving a verdict proves rules are data the decision module reads, not
    // code — adding or changing a rule needs no code change or deploy.
    const withExtraRule: EscalationPolicy = {
      version: 1,
      rules: [
        ...samplePolicy().rules,
        { id: 'payment-code', condition: 'high-risk-change-class', pathPatterns: ['**/billing/**'] },
      ],
    };
    const policy = parseEscalationPolicy(JSON.stringify(withExtraRule));
    const decision = decide({ changedPaths: ['src/billing/charge.ts'] }, policy);
    expect(decision.verdict).toBe('escalate');
    expect(decision.ruleId).toBe('payment-code');
  });

  it('fails fast with a clear error when the policy file is malformed or structurally invalid', () => {
    // Beyond bad JSON: a non-array `rules`, a rule missing its `condition`, an unknown
    // condition, and a per-condition required field missing must all fail at parse time —
    // a broken policy is never silently treated as an empty, permissive one.
    const missingCondition = JSON.stringify({ version: 1, rules: [{ id: 'r' }] });
    const unknownCondition = JSON.stringify({ version: 1, rules: [{ id: 'r', condition: 'banana' }] });
    const highRiskNoPatterns = JSON.stringify({
      version: 1,
      rules: [{ id: 'r', condition: 'high-risk-change-class' }],
    });
    const boundsNoCap = JSON.stringify({
      version: 1,
      rules: [{ id: 'r', condition: 'run-exceeded-bounds' }],
    });
    for (const corrupt of [
      '{ not json',
      '',
      '{"version":1}',
      '{"version":1,"rules":"not-an-array"}',
      missingCondition,
      unknownCondition,
      highRiskNoPatterns,
      boundsNoCap,
    ]) {
      expect(() => parseEscalationPolicy(corrupt)).toThrow(
        /malformed|invalid|could not parse|missing|unknown|expected|required/i,
      );
    }
  });
});

describe('escalation policy — escalate vs. proceed (test-plan §6)', () => {
  it('escalates a change the policy classifies as high-risk', () => {
    const decision = decide({ changedPaths: ['src/server/auth.ts'] }, samplePolicy());
    expect(decision.verdict).toBe('escalate');
  });

  it('proceeds — without consulting Michael — on a change matching no escalation condition', () => {
    const decision = decide(benignChange(), samplePolicy());
    expect(decision.verdict).toBe('proceed');
    expect(decision.condition).toBeUndefined();
    expect(decision.ruleId).toBeUndefined();
  });

  it('is deterministic — identical inputs always yield the same verdict, with no LLM call', () => {
    // No askClaude mock is installed: a resolver that reached for an LLM would fail here.
    // Equality across two calls pins the determinism the spec requires of the resolver.
    const change = { changedPaths: ['src/server/auth.ts'], evaluatorRounds: 9 };
    const a = decide(change, samplePolicy());
    const b = decide(change, samplePolicy());
    expect(a).toEqual(b);
  });
});

describe('escalation policy — the four spec conditions (test-plan §6)', () => {
  it('escalates a high-risk change class', () => {
    const decision = decide({ changedPaths: ['db/migrations/003_add_users.sql'] }, samplePolicy());
    expect(decision.verdict).toBe('escalate');
    expect(decision.condition).toBe('high-risk-change-class');
  });

  it('escalates an unresolvable cross-model review', () => {
    const decision = decide({ crossModelReview: 'unresolved' }, samplePolicy());
    expect(decision.verdict).toBe('escalate');
    expect(decision.condition).toBe('unresolvable-cross-model-review');
  });

  it('escalates a run that exceeded its bounds', () => {
    // samplePolicy() caps Evaluator rounds at 3; a 4th round is over the bound.
    const decision = decide({ evaluatorRounds: 4 }, samplePolicy());
    expect(decision.verdict).toBe('escalate');
    expect(decision.condition).toBe('run-exceeded-bounds');
    // A run still within bounds does not escalate on this condition.
    expect(decide({ evaluatorRounds: 3 }, samplePolicy()).verdict).toBe('proceed');
  });

  it('escalates a self-generated spec too consequential to approve unattended', () => {
    const decision = decide(
      { specOrigin: 'self-generated', specConsequence: 'consequential' },
      samplePolicy(),
    );
    expect(decision.verdict).toBe('escalate');
    expect(decision.condition).toBe('consequential-self-generated-spec');
    // A routine self-generated spec is specced and run unattended.
    expect(
      decide({ specOrigin: 'self-generated', specConsequence: 'routine' }, samplePolicy()).verdict,
    ).toBe('proceed');
  });
});

describe('escalation policy — fail closed (test-plan §6)', () => {
  it('fails closed on a missing policy — escalates rather than proceeding', () => {
    // benignChange() would `proceed` under a valid policy, so an `escalate` here can only
    // be the fail-closed path, not a rule firing.
    const decision = decideFailClosed(benignChange(), null);
    expect(decision.verdict).toBe('escalate');
    expect(decision.failClosed).toBe(true);
  });

  it('fails closed on a malformed policy — never falls open to permissive auto-merge', () => {
    const decision = decideFailClosed(benignChange(), '{ not json');
    expect(decision.verdict).toBe('escalate');
    expect(decision.verdict).not.toBe('proceed');
    expect(decision.failClosed).toBe(true);
  });

  it('delegates to a normal decision when the raw policy is valid', () => {
    const decision = decideFailClosed(
      { changedPaths: ['src/server/auth.ts'] },
      JSON.stringify(samplePolicy()),
    );
    expect(decision.verdict).toBe('escalate');
    expect(decision.failClosed).toBeFalsy();
  });
});

describe('escalation policy — auditability (test-plan §6)', () => {
  it('logs every escalation decision with the condition and rule that fired', () => {
    decide({ changedPaths: ['src/server/auth.ts'] }, samplePolicy());
    const logged = allLogs();
    expect(logged).toMatch(/high-risk-paths/); // the rule id
    expect(logged).toMatch(/high-risk-change-class/); // the condition
  });

  it('logs a fail-closed escalation too', () => {
    decideFailClosed(benignChange(), null);
    expect(allLogs()).toMatch(/fail.?closed|missing|unavailable|malformed/i);
  });
});

describe('escalation policy — supervision surface (test-plan §6, §10)', () => {
  it('an escalate decision carries a blocked-on-Michael reason the cockpit can surface', () => {
    // §10 supervision and the cockpit are built in later phases; here we only pin the
    // decision shape they consume — an escalation is human-readable and distinguishable
    // from `proceed` so it can render as blocked-on-Michael.
    const decision = decide({ crossModelReview: 'unresolved' }, samplePolicy());
    expect(decision.verdict).toBe('escalate');
    expect(typeof decision.reason).toBe('string');
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});
