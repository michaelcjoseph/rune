import { describe, it, expect } from 'vitest';

import {
  EVIDENCE_REQUIRED_CLASSES,
  citesReproducibleFailure,
  describeEvidenceGaps,
  describesFailureScenario,
  evidenceGapsForFinding,
  findingSignature,
  isAnchoredLocation,
} from './finding-evidence.js';
import type { ObjectionFinding } from './team-task-workflow.js';

function finding(over: Partial<ObjectionFinding> = {}): ObjectionFinding {
  return {
    class: 'concurrency',
    severity: 'high',
    location: 'src/lease.ts:42',
    rationale: 'withLease releases on holder abort while work may still run, ' +
      'so a later waiter enters the same critical section',
    ...over,
  };
}

describe('finding-evidence — anchored location', () => {
  it('accepts a file path with an extension, with or without a line', () => {
    expect(isAnchoredLocation('src/lease.ts:42')).toBe(true);
    expect(isAnchoredLocation('src/lease.ts')).toBe(true);
    expect(isAnchoredLocation('lease.ts:42 (withLease)')).toBe(true);
    expect(isAnchoredLocation('  packages/core/src/a-b.tsx:7  ')).toBe(true);
  });

  it('rejects the placeholders roles reach for instead of naming a place', () => {
    for (const placeholder of [
      '', '   ', 'unknown', 'Unknown', 'n/a', 'N/A', 'various', 'multiple files',
      'throughout', 'the diff', 'see above', 'tbd', 'none',
    ]) {
      expect(isAnchoredLocation(placeholder), placeholder).toBe(false);
    }
  });

  it('rejects prose that names no file', () => {
    expect(isAnchoredLocation('the lease acquisition code')).toBe(false);
    expect(isAnchoredLocation('withLease')).toBe(false);
  });
});

describe('finding-evidence — failure scenario', () => {
  it('accepts a terse but real rationale', () => {
    // 31 chars. An earlier length-floor draft downgraded this, which would have
    // suppressed a genuine security objection.
    expect(describesFailureScenario('unsanitized shell interpolation')).toBe(true);
    expect(describesFailureScenario('token comparison leaks timing')).toBe(true);
  });

  it('rejects an empty or one-word rationale', () => {
    expect(describesFailureScenario('')).toBe(false);
    expect(describesFailureScenario('   ')).toBe(false);
    expect(describesFailureScenario('unsafe')).toBe(false);
  });

  it('rejects a bare restatement of the objection class', () => {
    for (const bare of [
      'security issue', 'a concurrency bug', 'data-integrity problem',
      'Security vulnerability.', 'the outbound risk',
    ]) {
      expect(describesFailureScenario(bare), bare).toBe(false);
    }
  });
});

describe('finding-evidence — reproducible failures are never downgradable', () => {
  it('recognizes a runnable command', () => {
    expect(citesReproducibleFailure('npx vitest run src/a.test.ts fails on main')).toBe(true);
    expect(citesReproducibleFailure('`npm run build` exits 2 here')).toBe(true);
    expect(citesReproducibleFailure('pytest -k lease reproduces it')).toBe(true);
  });

  it('recognizes a named test file', () => {
    expect(citesReproducibleFailure('src/lease.test.ts asserts the opposite')).toBe(true);
  });

  it('exempts such a finding even with no location at all', () => {
    expect(evidenceGapsForFinding(finding({
      location: 'unknown',
      rationale: 'src/lease.test.ts fails',
    }))).toEqual([]);
  });

  it('does not treat ordinary prose as reproducible', () => {
    expect(citesReproducibleFailure('the tests would probably fail')).toBe(false);
  });
});

describe('finding-evidence — the contract', () => {
  it('applies to exactly the three high-stakes classes', () => {
    expect([...EVIDENCE_REQUIRED_CLASSES].sort()).toEqual([
      'concurrency', 'data-integrity', 'security',
    ]);
    for (const objectionClass of ['privacy', 'outbound', 'cost-perf'] as const) {
      expect(
        evidenceGapsForFinding(finding({ class: objectionClass, location: 'unknown', rationale: 'x' })),
        objectionClass,
      ).toEqual([]);
    }
  });

  it('passes a finding that carries both a location and a scenario', () => {
    expect(evidenceGapsForFinding(finding())).toEqual([]);
  });

  it('flags the run-815bdec6 verdict: a real scenario with nowhere to look', () => {
    const gaps = evidenceGapsForFinding(finding({ location: '' }));
    expect(gaps).toEqual(['location']);
    expect(describeEvidenceGaps(gaps)).toContain('concrete location');
  });

  it('flags both gaps when neither is supplied', () => {
    expect(evidenceGapsForFinding(finding({ location: 'various', rationale: 'security issue' })))
      .toEqual(['location', 'failure-scenario']);
  });

  it('ignores a low-severity finding — it maps to pass-with-warnings and never blocks', () => {
    expect(evidenceGapsForFinding(finding({ severity: 'low', location: 'unknown', rationale: 'x' })))
      .toEqual([]);
  });

  it('applies at every blocking severity', () => {
    for (const severity of ['medium', 'high', 'critical'] as const) {
      expect(evidenceGapsForFinding(finding({ severity, location: 'unknown' })), severity)
        .toEqual(['location']);
    }
  });
});

describe('finding-evidence — signature', () => {
  it('is stable across whitespace so a re-prompted finding matches its original', () => {
    expect(findingSignature(finding({ rationale: 'a  b\n c' })))
      .toBe(findingSignature(finding({ rationale: 'a b c' })));
  });

  it('separates findings that differ in class, severity, or location', () => {
    const base = findingSignature(finding());
    expect(findingSignature(finding({ class: 'security' }))).not.toBe(base);
    expect(findingSignature(finding({ severity: 'medium' }))).not.toBe(base);
    expect(findingSignature(finding({ location: 'src/other.ts:1' }))).not.toBe(base);
  });
});
