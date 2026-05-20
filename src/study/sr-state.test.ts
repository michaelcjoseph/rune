import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../vault/files.js', () => ({
  readVaultFile: vi.fn(),
  writeVaultFile: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { readVaultFile, writeVaultFile } = await import('../vault/files.js');
const {
  readSRState,
  writeSRState,
  advanceRung,
  resetRung,
  repeatRung,
  admitConcept,
  emptyState,
  SRStateError,
  RUNGS,
  GRADES,
  SR_STATE_PATH,
} = await import('./sr-state.js');

const readMock = readVaultFile as unknown as ReturnType<typeof vi.fn>;
const writeMock = writeVaultFile as unknown as ReturnType<typeof vi.fn>;

const TODAY = '2026-05-20';
const CONCEPT = 'knowledge/wiki/concepts/neural-networks.md';

/** Build a ConceptState at a specific rung with optional overrides. */
function makeConceptAt(
  rung: (typeof RUNGS)[number],
  overrides: Partial<{
    last_grade: (typeof GRADES)[number] | null;
    lapse_count: number;
    review_count: number;
    last_questions: string[];
    last_reviewed: string | null;
  }> = {},
) {
  const state = emptyState();
  const admitted = admitConcept(state, CONCEPT, TODAY);
  // Walk up to the desired rung by applying 'good' grades
  let current = admitted;
  const targetIdx = RUNGS.indexOf(rung);
  for (let i = 0; i < targetIdx; i++) {
    current = advanceRung(current, CONCEPT, 'good', TODAY);
  }
  // Apply overrides to the concept
  if (Object.keys(overrides).length > 0) {
    const c = current.concepts[CONCEPT]!;
    current = {
      ...current,
      concepts: { ...current.concepts, [CONCEPT]: { ...c, ...overrides } },
    };
  }
  return current;
}

// ---------------------------------------------------------------------------
// advanceRung — good grade ladder
// ---------------------------------------------------------------------------

describe('advanceRung — good advances one rung', () => {
  it.each([
    ['1d', '3d'],
    ['3d', '7d'],
    ['7d', '14d'],
    ['14d', '30d'],
    ['30d', '60d'],
    ['60d', '120d'],
  ] as Array<[(typeof RUNGS)[number], (typeof RUNGS)[number]]>)(
    'good: %s → %s',
    (from, to) => {
      const state = makeConceptAt(from);
      const next = advanceRung(state, CONCEPT, 'good', TODAY);
      expect(next.concepts[CONCEPT]!.current_rung).toBe(to);
    },
  );

  it('good at cap (120d) stays at 120d', () => {
    const state = makeConceptAt('120d');
    const next = advanceRung(state, CONCEPT, 'good', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('120d');
  });
});

// ---------------------------------------------------------------------------
// advanceRung — easy grade (two rungs on first pass, one on repeat pass)
// ---------------------------------------------------------------------------

describe('advanceRung — easy grade', () => {
  it('easy on first pass at 1d advances two rungs → 7d', () => {
    const state = makeConceptAt('1d');
    const next = advanceRung(state, CONCEPT, 'easy', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('7d');
  });

  it('easy on first pass at 3d advances two rungs → 14d', () => {
    const state = makeConceptAt('3d');
    const next = advanceRung(state, CONCEPT, 'easy', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('14d');
  });

  it('easy on first pass at 60d advances two rungs → 120d', () => {
    const state = makeConceptAt('60d');
    const next = advanceRung(state, CONCEPT, 'easy', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('120d');
  });

  it('easy on first pass at 120d (cap) stays at 120d', () => {
    const state = makeConceptAt('120d');
    const next = advanceRung(state, CONCEPT, 'easy', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('120d');
  });

  it('easy on a repeat pass (last_grade=hard) advances only one rung', () => {
    // Simulate a hard grade so last_grade is 'hard' (repeat pass)
    const state = makeConceptAt('3d', { last_grade: 'hard' });
    const next = advanceRung(state, CONCEPT, 'easy', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('7d');
  });

  it('easy on a repeat pass at 60d → 120d (still capped)', () => {
    const state = makeConceptAt('60d', { last_grade: 'hard' });
    const next = advanceRung(state, CONCEPT, 'easy', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('120d');
  });
});

// ---------------------------------------------------------------------------
// advanceRung — hard grade (keep rung, advance next_due)
// ---------------------------------------------------------------------------

describe('advanceRung — hard grade', () => {
  it('hard keeps current_rung unchanged at 7d', () => {
    const state = makeConceptAt('7d');
    const next = advanceRung(state, CONCEPT, 'hard', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('7d');
  });

  it('hard schedules next_due 7 days out when current_rung is 7d', () => {
    const state = makeConceptAt('7d');
    const next = advanceRung(state, CONCEPT, 'hard', TODAY);
    expect(next.concepts[CONCEPT]!.next_due).toBe('2026-05-27');
  });

  it('hard at 1d schedules next_due 1 day out', () => {
    const state = makeConceptAt('1d');
    const next = advanceRung(state, CONCEPT, 'hard', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('1d');
    expect(next.concepts[CONCEPT]!.next_due).toBe('2026-05-21');
  });

  it('hard at 30d schedules next_due 30 days out', () => {
    const state = makeConceptAt('30d');
    const next = advanceRung(state, CONCEPT, 'hard', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('30d');
    expect(next.concepts[CONCEPT]!.next_due).toBe('2026-06-19');
  });

  it('hard at cap (120d) stays at 120d and schedules next_due 120 days out', () => {
    const state = makeConceptAt('120d');
    const next = advanceRung(state, CONCEPT, 'hard', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('120d');
    // 2026-05-20 + 120 = 2026-09-17
    expect(next.concepts[CONCEPT]!.next_due).toBe('2026-09-17');
  });
});

// ---------------------------------------------------------------------------
// advanceRung — again grade (reset to 1d, increment lapse_count)
// ---------------------------------------------------------------------------

describe('advanceRung — again grade', () => {
  it('again resets current_rung to 1d', () => {
    const state = makeConceptAt('14d');
    const next = advanceRung(state, CONCEPT, 'again', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('1d');
  });

  it('again increments lapse_count', () => {
    const state = makeConceptAt('7d', { lapse_count: 2 });
    const next = advanceRung(state, CONCEPT, 'again', TODAY);
    expect(next.concepts[CONCEPT]!.lapse_count).toBe(3);
  });

  it('again schedules next_due 1 day from today', () => {
    const state = makeConceptAt('60d');
    const next = advanceRung(state, CONCEPT, 'again', TODAY);
    expect(next.concepts[CONCEPT]!.next_due).toBe('2026-05-21');
  });

  it('again at cap (120d) resets current_rung to 1d and schedules next_due tomorrow', () => {
    const state = makeConceptAt('120d');
    const next = advanceRung(state, CONCEPT, 'again', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('1d');
    expect(next.concepts[CONCEPT]!.next_due).toBe('2026-05-21');
  });
});

// ---------------------------------------------------------------------------
// advanceRung — bookkeeping (every grade)
// ---------------------------------------------------------------------------

describe('advanceRung — review bookkeeping', () => {
  it('updates last_reviewed to today for every grade', () => {
    for (const grade of GRADES) {
      const state = makeConceptAt('7d');
      const next = advanceRung(state, CONCEPT, grade, '2026-05-15');
      expect(next.concepts[CONCEPT]!.last_reviewed).toBe('2026-05-15');
    }
  });

  it('increments review_count for every grade', () => {
    for (const grade of GRADES) {
      const state = makeConceptAt('7d', { review_count: 5 });
      const next = advanceRung(state, CONCEPT, grade, TODAY);
      expect(next.concepts[CONCEPT]!.review_count).toBe(6);
    }
  });

  it('sets last_grade to the grade applied', () => {
    for (const grade of GRADES) {
      const state = makeConceptAt('3d');
      const next = advanceRung(state, CONCEPT, grade, TODAY);
      expect(next.concepts[CONCEPT]!.last_grade).toBe(grade);
    }
  });

  it('appends question to last_questions when provided', () => {
    const state = makeConceptAt('1d', { last_questions: ['q1', 'q2'] });
    const next = advanceRung(state, CONCEPT, 'good', TODAY, 'new question');
    expect(next.concepts[CONCEPT]!.last_questions).toEqual(['q1', 'q2', 'new question']);
  });

  it('caps last_questions at 3, dropping the oldest', () => {
    const state = makeConceptAt('1d', { last_questions: ['q1', 'q2', 'q3'] });
    const next = advanceRung(state, CONCEPT, 'good', TODAY, 'q4');
    expect(next.concepts[CONCEPT]!.last_questions).toEqual(['q2', 'q3', 'q4']);
  });

  it('does not append to last_questions when no question is provided', () => {
    const state = makeConceptAt('1d', { last_questions: ['q1'] });
    const next = advanceRung(state, CONCEPT, 'good', TODAY);
    expect(next.concepts[CONCEPT]!.last_questions).toEqual(['q1']);
  });
});

// ---------------------------------------------------------------------------
// advanceRung — next_due date arithmetic
// ---------------------------------------------------------------------------

describe('advanceRung — next_due arithmetic', () => {
  it('good at 1d sets next_due to today + 3 days', () => {
    const state = makeConceptAt('1d');
    const next = advanceRung(state, CONCEPT, 'good', TODAY);
    // advances to 3d rung; today (2026-05-20) + 3 = 2026-05-23
    expect(next.concepts[CONCEPT]!.next_due).toBe('2026-05-23');
  });

  it('easy at 1d (first pass → 7d rung) sets next_due to today + 7 days', () => {
    const state = makeConceptAt('1d');
    const next = advanceRung(state, CONCEPT, 'easy', TODAY);
    expect(next.concepts[CONCEPT]!.next_due).toBe('2026-05-27');
  });

  it('again always sets next_due to today + 1 day', () => {
    const state = makeConceptAt('120d');
    const next = advanceRung(state, CONCEPT, 'again', TODAY);
    expect(next.concepts[CONCEPT]!.next_due).toBe('2026-05-21');
  });
});

// ---------------------------------------------------------------------------
// advanceRung — invalid grade throws SRStateError
// ---------------------------------------------------------------------------

describe('advanceRung — invalid grade', () => {
  it('throws SRStateError for an out-of-range grade string', () => {
    const state = makeConceptAt('1d');
    expect(() =>
      advanceRung(state, CONCEPT, 'ok' as (typeof GRADES)[number], TODAY),
    ).toThrowError(SRStateError);
  });

  it('thrown error message mentions the bad grade value', () => {
    const state = makeConceptAt('1d');
    expect(() =>
      advanceRung(state, CONCEPT, 'medium' as (typeof GRADES)[number], TODAY),
    ).toThrowError(/medium/);
  });

  it('does not mutate input state on a bad grade', () => {
    const state = makeConceptAt('7d');
    const frozen = JSON.stringify(state);
    try {
      advanceRung(state, CONCEPT, 'invalid' as (typeof GRADES)[number], TODAY);
    } catch {
      // expected
    }
    expect(JSON.stringify(state)).toBe(frozen);
  });
});

// ---------------------------------------------------------------------------
// advanceRung — missing concept is admitted on first grade
// ---------------------------------------------------------------------------

describe('advanceRung — concept missing from state', () => {
  it('admits the concept and applies the grade when it is not in state', () => {
    const state = emptyState();
    const next = advanceRung(state, CONCEPT, 'good', TODAY);
    expect(next.concepts[CONCEPT]).toBeDefined();
    // Admitted at rung 1d, then good advances to 3d
    expect(next.concepts[CONCEPT]!.current_rung).toBe('3d');
  });

  it('records review_count=1 for the first-ever grade on an admitted concept', () => {
    const state = emptyState();
    const next = advanceRung(state, CONCEPT, 'good', TODAY);
    expect(next.concepts[CONCEPT]!.review_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Immutability — pure functions must not mutate the input state
// ---------------------------------------------------------------------------

describe('pure functions — no input mutation', () => {
  it('advanceRung does not mutate the input state', () => {
    const state = makeConceptAt('7d');
    const frozen = JSON.stringify(state);
    advanceRung(state, CONCEPT, 'good', TODAY);
    expect(JSON.stringify(state)).toBe(frozen);
  });

  it('resetRung does not mutate the input state', () => {
    const state = makeConceptAt('14d');
    const frozen = JSON.stringify(state);
    resetRung(state, CONCEPT, TODAY);
    expect(JSON.stringify(state)).toBe(frozen);
  });

  it('repeatRung does not mutate the input state', () => {
    const state = makeConceptAt('30d');
    const frozen = JSON.stringify(state);
    repeatRung(state, CONCEPT, TODAY);
    expect(JSON.stringify(state)).toBe(frozen);
  });

  it('admitConcept does not mutate the input state', () => {
    const state = emptyState();
    const frozen = JSON.stringify(state);
    admitConcept(state, CONCEPT, TODAY);
    expect(JSON.stringify(state)).toBe(frozen);
  });
});

// ---------------------------------------------------------------------------
// admitConcept
// ---------------------------------------------------------------------------

describe('admitConcept', () => {
  it('adds the concept with rung 1d and due = today + 1', () => {
    const state = emptyState();
    const next = admitConcept(state, CONCEPT, TODAY);
    const c = next.concepts[CONCEPT]!;
    expect(c.current_rung).toBe('1d');
    expect(c.next_due).toBe('2026-05-21');
  });

  it('sets admitted_date to today', () => {
    const state = emptyState();
    const next = admitConcept(state, CONCEPT, TODAY);
    expect(next.concepts[CONCEPT]!.admitted_date).toBe(TODAY);
  });

  it('initialises review_count and lapse_count to 0', () => {
    const state = emptyState();
    const next = admitConcept(state, CONCEPT, TODAY);
    const c = next.concepts[CONCEPT]!;
    expect(c.review_count).toBe(0);
    expect(c.lapse_count).toBe(0);
  });

  it('returns state unchanged when concept already exists', () => {
    const state = makeConceptAt('14d');
    const next = admitConcept(state, CONCEPT, TODAY);
    // Should be the same object (or at least same rung — not reset to 1d)
    expect(next.concepts[CONCEPT]!.current_rung).toBe('14d');
  });
});

// ---------------------------------------------------------------------------
// resetRung + repeatRung
// ---------------------------------------------------------------------------

describe('resetRung', () => {
  it('sets rung to 1d and next_due to today + 1', () => {
    const state = makeConceptAt('30d');
    const next = resetRung(state, CONCEPT, TODAY);
    const c = next.concepts[CONCEPT]!;
    expect(c.current_rung).toBe('1d');
    expect(c.next_due).toBe('2026-05-21');
  });

  it('throws SRStateError when the concept is not in state', () => {
    const state = emptyState();
    expect(() => resetRung(state, 'missing/concept.md', TODAY)).toThrowError(SRStateError);
  });
});

describe('repeatRung', () => {
  it('keeps current_rung the same and pushes next_due by that interval', () => {
    const state = makeConceptAt('14d');
    const next = repeatRung(state, CONCEPT, TODAY);
    const c = next.concepts[CONCEPT]!;
    expect(c.current_rung).toBe('14d');
    // TODAY (2026-05-20) + 14 = 2026-06-03
    expect(c.next_due).toBe('2026-06-03');
  });

  it('throws SRStateError when the concept is not in state', () => {
    const state = emptyState();
    expect(() => repeatRung(state, 'missing/concept.md', TODAY)).toThrowError(SRStateError);
  });
});

// ---------------------------------------------------------------------------
// readSRState
// ---------------------------------------------------------------------------

describe('readSRState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty state when file is missing (null)', () => {
    readMock.mockReturnValue(null);
    const state = readSRState();
    expect(state.concepts).toEqual({});
    expect(state.meta.last_session_at).toBeNull();
  });

  it('returns empty state when file is empty string', () => {
    readMock.mockReturnValue('');
    const state = readSRState();
    expect(state.concepts).toEqual({});
  });

  it('returns empty state when file is whitespace-only', () => {
    readMock.mockReturnValue('   \n  ');
    const state = readSRState();
    expect(state.concepts).toEqual({});
  });

  it('parses a valid state file', () => {
    const validState = {
      concepts: { 'some/path.md': { concept_path: 'some/path.md', current_rung: '7d' } },
      meta: { last_session_at: null, last_session_summary: null },
    };
    readMock.mockReturnValue(JSON.stringify(validState));
    const state = readSRState();
    expect(state.concepts['some/path.md']).toBeDefined();
  });

  it('reads from SR_STATE_PATH', () => {
    readMock.mockReturnValue(null);
    readSRState();
    expect(readMock).toHaveBeenCalledWith(SR_STATE_PATH);
  });

  it('throws SRStateError on truncated/corrupt JSON', () => {
    readMock.mockReturnValue('{ "concepts": { broken');
    expect(() => readSRState()).toThrowError(SRStateError);
  });

  it('throws SRStateError when file is not a JSON object (e.g. a JSON array)', () => {
    readMock.mockReturnValue('[1, 2, 3]');
    expect(() => readSRState()).toThrowError(SRStateError);
  });

  it('throws SRStateError when concepts key is missing', () => {
    readMock.mockReturnValue(JSON.stringify({ meta: { last_session_at: null, last_session_summary: null } }));
    expect(() => readSRState()).toThrowError(SRStateError);
  });

  it('does NOT return empty state on corrupt JSON — always throws', () => {
    readMock.mockReturnValue('not json at all');
    expect(() => readSRState()).toThrow();
    // Ensure it throws SRStateError specifically, not an empty-state fallback
    try {
      readSRState();
    } catch (err) {
      expect(err).toBeInstanceOf(SRStateError);
    }
  });
});

// ---------------------------------------------------------------------------
// readSRState — new validation tests (invalid entries + array root)
// ---------------------------------------------------------------------------

describe('readSRState — concept validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws SRStateError when a concept has an invalid current_rung', () => {
    const badState = {
      concepts: {
        'some/concept.md': {
          concept_path: 'some/concept.md',
          current_rung: '99d',
          last_grade: null,
        },
      },
      meta: { last_session_at: null, last_session_summary: null },
    };
    readMock.mockReturnValue(JSON.stringify(badState));
    expect(() => readSRState()).toThrowError(SRStateError);
    expect(() => readSRState()).toThrow(/invalid current_rung/);
  });

  it('throws SRStateError when a concept has an invalid last_grade', () => {
    const badState = {
      concepts: {
        'some/concept.md': {
          concept_path: 'some/concept.md',
          current_rung: '7d',
          last_grade: 'meh',
        },
      },
      meta: { last_session_at: null, last_session_summary: null },
    };
    readMock.mockReturnValue(JSON.stringify(badState));
    expect(() => readSRState()).toThrowError(SRStateError);
    expect(() => readSRState()).toThrow(/invalid last_grade/);
  });

  it('throws SRStateError when the JSON root is an array', () => {
    readMock.mockReturnValue('[1, 2, 3]');
    expect(() => readSRState()).toThrowError(SRStateError);
  });

  it('accepts a valid concept with last_grade: null', () => {
    const validState = {
      concepts: {
        'some/concept.md': {
          concept_path: 'some/concept.md',
          current_rung: '7d',
          next_due: '2026-05-27',
          admitted_date: '2026-05-01',
          last_reviewed: null,
          last_grade: null,
          review_count: 0,
          lapse_count: 0,
          last_questions: [],
        },
      },
      meta: { last_session_at: null, last_session_summary: null },
    };
    readMock.mockReturnValue(JSON.stringify(validState));
    const state = readSRState();
    expect(state.concepts['some/concept.md']!.last_grade).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// advanceRung — easy on brand-new concept (last_grade null = first pass)
// ---------------------------------------------------------------------------

describe('advanceRung — easy on brand-new concept treats null last_grade as first pass', () => {
  it('easy on a brand-new concept advances two rungs: 1d → 7d', () => {
    const state = admitConcept(emptyState(), CONCEPT, TODAY);
    // Freshly admitted concept has last_grade: null
    expect(state.concepts[CONCEPT]!.last_grade).toBeNull();
    const next = advanceRung(state, CONCEPT, 'easy', TODAY);
    expect(next.concepts[CONCEPT]!.current_rung).toBe('7d');
  });
});

// ---------------------------------------------------------------------------
// writeSRState
// ---------------------------------------------------------------------------

describe('writeSRState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls writeVaultFile with SR_STATE_PATH and JSON content', () => {
    const state = emptyState();
    writeSRState(state);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith(SR_STATE_PATH, expect.stringContaining('"concepts"'));
  });

  it('serialized JSON is parseable and round-trips correctly', () => {
    const state = admitConcept(emptyState(), CONCEPT, TODAY);
    writeSRState(state);
    const [, written] = writeMock.mock.calls[0] as [string, string];
    const parsed = JSON.parse(written);
    expect(parsed.concepts[CONCEPT]).toBeDefined();
  });

  it('content ends with a newline', () => {
    writeSRState(emptyState());
    const [, written] = writeMock.mock.calls[0] as [string, string];
    expect(written.endsWith('\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// emptyState
// ---------------------------------------------------------------------------

describe('emptyState', () => {
  it('returns an object with empty concepts map', () => {
    expect(emptyState().concepts).toEqual({});
  });

  it('returns an object with null meta fields', () => {
    const s = emptyState();
    expect(s.meta.last_session_at).toBeNull();
    expect(s.meta.last_session_summary).toBeNull();
  });

  it('returns a new object each call (no shared reference)', () => {
    const a = emptyState();
    const b = emptyState();
    a.concepts['x'] = {} as never;
    expect(b.concepts['x']).toBeUndefined();
  });
});
