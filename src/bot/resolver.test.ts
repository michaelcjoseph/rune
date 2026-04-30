import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/test/vault',
    TIMEZONE: 'America/Chicago',
    TELEGRAM_USER_ID: 42,
    ONESHOT_MODEL: 'opus',
    CLASSIFIER_TIMEOUT_MS: 60_000,
    RESOLVER_CONFIDENCE_THRESHOLD: 0.7,
    RESOLVER_AMBIGUITY_DELTA: 0.05,
    RESOLVER_MIN_WORDS: 5,
  },
  PROJECT_ROOT: '/test/project',
}));

vi.mock('../ai/claude.js', () => ({
  askClaudeOneShot: vi.fn(async (_prompt: string, _timeoutMs?: number) => ({ text: '{}', error: null })),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const {
  buildResolverPrompt,
  parseClassifyResponse,
  classifyIntent,
} = await import('./resolver.js');
const { askClaudeOneShot: mockCall } = await import('../ai/claude.js');

const sampleRegistry = [
  {
    name: 'journal',
    kind: 'slash' as const,
    description: 'Append an entry to today\'s journal.',
    triggers: ['add to my journal'],
  },
  {
    name: 'workout',
    kind: 'slash' as const,
    description: 'Generate a tailored daily workout.',
    triggers: ['give me a workout'],
    examples: [
      { message: 'Design me a workout for today', expected_skill: 'workout' },
      { message: 'How are you?' },
    ],
  },
];

describe('buildResolverPrompt', () => {
  it('includes every skill name in the prompt', () => {
    const prompt = buildResolverPrompt('test', sampleRegistry);
    expect(prompt).toContain('journal');
    expect(prompt).toContain('workout');
  });

  it('emits trigger phrases and examples', () => {
    const prompt = buildResolverPrompt('test', sampleRegistry);
    expect(prompt).toContain('add to my journal');
    expect(prompt).toContain('Design me a workout for today');
    expect(prompt).toContain('→ workout');
    expect(prompt).toContain('→ (not this skill)');
  });

  it('JSON-encodes the user message so quotes do not break the prompt', () => {
    const prompt = buildResolverPrompt('she said "hi" to me this morning', sampleRegistry);
    expect(prompt).toContain('"she said \\"hi\\" to me this morning"');
  });

  it('instructs the classifier to return JSON only', () => {
    const prompt = buildResolverPrompt('test', sampleRegistry);
    expect(prompt).toMatch(/JSON only/i);
    expect(prompt).toContain('"skill"');
    expect(prompt).toContain('"args"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"second_skill"');
    expect(prompt).toContain('"second_confidence"');
  });
});

describe('parseClassifyResponse', () => {
  it('parses a valid response into a ClassifyResult', () => {
    const raw = JSON.stringify({
      skill: 'journal',
      args: '11am, called dad',
      confidence: 0.91,
      second_skill: 'workout',
      second_confidence: 0.2,
    });
    const result = parseClassifyResponse(raw);
    expect(result.skill).toBe('journal');
    expect(result.args).toBe('11am, called dad');
    expect(result.confidence).toBe(0.91);
    expect(result.second_skill).toBe('workout');
    expect(result.second_confidence).toBe(0.2);
    expect(result.ambiguous).toBe(false);
  });

  it('detects ambiguous top-2 within the configured delta (0.05)', () => {
    const raw = JSON.stringify({
      skill: 'journal',
      args: 'foo',
      confidence: 0.72,
      second_skill: 'workout',
      second_confidence: 0.70,
    });
    const result = parseClassifyResponse(raw);
    expect(result.ambiguous).toBe(true);
  });

  it('does not mark ambiguous when second_skill is null', () => {
    const raw = JSON.stringify({
      skill: 'journal',
      args: '',
      confidence: 0.9,
      second_skill: null,
      second_confidence: 0,
    });
    const result = parseClassifyResponse(raw);
    expect(result.ambiguous).toBe(false);
  });

  it('tolerates a ```json code fence', () => {
    const raw = '```json\n' + JSON.stringify({
      skill: 'weekly',
      args: '',
      confidence: 0.85,
      second_skill: null,
      second_confidence: 0,
    }) + '\n```';
    const result = parseClassifyResponse(raw);
    expect(result.skill).toBe('weekly');
    expect(result.confidence).toBe(0.85);
  });

  it('tolerates a bare ``` fence', () => {
    const raw = '```\n{"skill":"weekly","args":"","confidence":0.8,"second_skill":null,"second_confidence":0}\n```';
    const result = parseClassifyResponse(raw);
    expect(result.skill).toBe('weekly');
  });

  it('returns a zero-confidence result on malformed JSON', () => {
    const result = parseClassifyResponse('not json at all');
    expect(result.skill).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.ambiguous).toBe(false);
  });

  it('clamps confidence to [0, 1]', () => {
    const raw = JSON.stringify({
      skill: 'x',
      args: '',
      confidence: 2.5,
      second_skill: null,
      second_confidence: -0.5,
    });
    const result = parseClassifyResponse(raw);
    expect(result.confidence).toBe(1);
    expect(result.second_confidence).toBe(0);
  });

  it('coerces non-numeric confidence to 0', () => {
    const raw = JSON.stringify({
      skill: 'x',
      args: '',
      confidence: 'high',
      second_skill: null,
      second_confidence: null,
    });
    const result = parseClassifyResponse(raw);
    expect(result.confidence).toBe(0);
    expect(result.second_confidence).toBe(0);
  });

  it('coerces non-string skill to null', () => {
    const raw = JSON.stringify({
      skill: 123,
      args: '',
      confidence: 0.9,
      second_skill: null,
      second_confidence: 0,
    });
    const result = parseClassifyResponse(raw);
    expect(result.skill).toBeNull();
  });

  it('coerces missing args to empty string', () => {
    const raw = JSON.stringify({
      skill: 'x',
      confidence: 0.9,
      second_skill: null,
      second_confidence: 0,
    });
    const result = parseClassifyResponse(raw);
    expect(result.args).toBe('');
  });

  it('preserves the raw text for debugging', () => {
    const raw = 'not json';
    const result = parseClassifyResponse(raw);
    expect(result.raw).toBe(raw);
  });
});

describe('classifyIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invokes the classifier with a prompt built from the registry and the short CLASSIFIER_TIMEOUT_MS', async () => {
    vi.mocked(mockCall).mockResolvedValue({
      text: JSON.stringify({
        skill: 'workout',
        args: 'home strength',
        confidence: 0.9,
        second_skill: null,
        second_confidence: 0,
      }),
      error: null,
    });

    const result = await classifyIntent('design me a workout for today', sampleRegistry);
    expect(mockCall).toHaveBeenCalledTimes(1);
    const [promptArg, timeoutArg] = vi.mocked(mockCall).mock.calls[0]!;
    expect(promptArg).toContain('workout');
    expect(promptArg).toContain('design me a workout for today');
    expect(timeoutArg).toBe(60_000);
    expect(result.skill).toBe('workout');
  });

  it('collapses to a zero-confidence result when the CLI call errors', async () => {
    vi.mocked(mockCall).mockResolvedValue({ text: null, error: 'timed out' });
    const result = await classifyIntent('hello', sampleRegistry);
    expect(result.skill).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('collapses to a zero-confidence result when CLI returns null text with no error', async () => {
    vi.mocked(mockCall).mockResolvedValue({ text: null, error: null });
    const result = await classifyIntent('hello', sampleRegistry);
    expect(result.skill).toBeNull();
  });
});
