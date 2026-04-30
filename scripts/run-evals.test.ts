import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock src/config.js before any import that transitively pulls it in.
// The module path is relative to the scripts/ directory one level up.
vi.mock('../src/config.js', () => ({
  default: {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 12345,
    VAULT_DIR: '/tmp/vault',
    LOGS_DIR: '/tmp/logs',
    TIMEZONE: 'America/Chicago',
    CLAUDE_TIMEOUT_MS: 300_000,
    CLAUDE_INGEST_TIMEOUT_MS: 900_000,
    CLAUDE_LINT_TIMEOUT_MS: 300_000,
    AGENT_MODEL: 'opus',
    ONESHOT_MODEL: 'sonnet',
    CONVERSATION_MODEL: 'opus',
    DEFAULT_CHAT_MODEL: 'haiku',
    TG_MAX_MESSAGE_LENGTH: 4096,
    SESSIONS_FILE: '/tmp/logs/tg-sessions.json',
    KNOWLEDGE_DIR: '/tmp/vault/knowledge',
    INGESTION_QUEUE_FILE: '/tmp/logs/kb-ingestion-queue.json',
    PLAYBOOK_QUEUE_FILE: '/tmp/logs/playbook-queue.json',
    REVIEW_SESSIONS_FILE: '/tmp/logs/review-sessions.json',
    HTTP_PORT: 3847,
    HTTP_HOST: '127.0.0.1',
    FAMILY_NAMES: [],
    READWISE_TOKEN: '',
    WHOOP_CLIENT_ID: '',
    WHOOP_CLIENT_SECRET: '',
    JARVIS_HTTP_SECRET: '',
    CLASSIFIER_MODEL: 'haiku',
    CLASSIFIER_TIMEOUT_MS: 20_000,
    RESOLVER_CONFIDENCE_THRESHOLD: 0.7,
    RESOLVER_AMBIGUITY_DELTA: 0.05,
    RESOLVER_MIN_WORDS: 5,
  },
  PROJECT_ROOT: '/tmp/project',
}));

// Mock src/ai/claude.js to prevent spawn side effects and claude binary resolution.
vi.mock('../src/ai/claude.js', () => ({
  runAgent: vi.fn(),
  killActiveProcesses: vi.fn(),
}));

// Mock the resolver pipeline so the runner's resolver-branch tests don't spawn
// a real Haiku call. skill-registry is also mocked to avoid filesystem scans.
vi.mock('../src/bot/resolver.js', () => ({
  classifyIntent: vi.fn(),
}));

vi.mock('../src/bot/skill-registry.js', () => ({
  getSkillRegistry: vi.fn(() => [
    { name: 'journal', kind: 'slash', description: 'Add to journal.' },
    { name: 'workout', kind: 'slash', description: 'Generate a workout.' },
  ]),
}));

const { runAssertion, validateEvalFile, parseCliArgs, runFixture } = await import('./run-evals.js');
const { runAgent } = await import('../src/ai/claude.js');
const { classifyIntent } = await import('../src/bot/resolver.js');

// ---------------------------------------------------------------------------
// runAssertion — substring
// ---------------------------------------------------------------------------
describe('runAssertion: substring', () => {
  it('passes when output contains the value', () => {
    const result = runAssertion({ type: 'substring', value: 'hello' }, 'say hello world');
    expect(result.passed).toBe(true);
    expect(result.type).toBe('substring');
    expect(result.detail).toBeUndefined();
  });

  it('fails when output does not contain the value', () => {
    const result = runAssertion({ type: 'substring', value: 'missing' }, 'say hello world');
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('missing substring');
    expect(result.detail).toContain('"missing"');
  });
});

// ---------------------------------------------------------------------------
// runAssertion — citation_present
// ---------------------------------------------------------------------------
describe('runAssertion: citation_present', () => {
  it('passes for bare wikilink [[slug]]', () => {
    const result = runAssertion(
      { type: 'citation_present', target: 'some-topic' },
      'see [[some-topic]] for details',
    );
    expect(result.passed).toBe(true);
  });

  it('passes for alias wikilink [[slug|label]]', () => {
    const result = runAssertion(
      { type: 'citation_present', target: 'some-topic' },
      'see [[some-topic|Topic Name]] for details',
    );
    expect(result.passed).toBe(true);
  });

  it('fails when citation is absent', () => {
    const result = runAssertion(
      { type: 'citation_present', target: 'some-topic' },
      'no citation here at all',
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('[[some-topic]]');
  });

  it('does not match a different slug', () => {
    const result = runAssertion(
      { type: 'citation_present', target: 'topic-a' },
      'see [[topic-b]] here',
    );
    expect(result.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runAssertion — max_length_chars
// ---------------------------------------------------------------------------
describe('runAssertion: max_length_chars', () => {
  it('passes when output length is within the limit', () => {
    const result = runAssertion({ type: 'max_length_chars', value: 100 }, 'short');
    expect(result.passed).toBe(true);
    expect(result.detail).toBeUndefined();
  });

  it('fails when output exceeds the limit', () => {
    const result = runAssertion({ type: 'max_length_chars', value: 3 }, 'toolong');
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('7 chars');
    expect(result.detail).toContain('max 3');
  });
});

// ---------------------------------------------------------------------------
// runAssertion — json_shape
// ---------------------------------------------------------------------------
describe('runAssertion: json_shape', () => {
  it('passes when output is a JSON object containing all required keys', () => {
    const result = runAssertion(
      { type: 'json_shape', required_keys: ['name', 'age'] },
      JSON.stringify({ name: 'Alice', age: 30, extra: true }),
    );
    expect(result.passed).toBe(true);
  });

  it('fails when output is not valid JSON', () => {
    const result = runAssertion(
      { type: 'json_shape', required_keys: ['name'] },
      'not json at all {',
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('not valid JSON');
  });

  it('fails when output is a JSON array, not an object', () => {
    const result = runAssertion(
      { type: 'json_shape', required_keys: [] },
      '[1, 2, 3]',
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('not a JSON object');
  });

  it('fails when required keys are missing', () => {
    const result = runAssertion(
      { type: 'json_shape', required_keys: ['name', 'score'] },
      JSON.stringify({ name: 'Alice' }),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('missing keys');
    expect(result.detail).toContain('score');
  });

  it('passes with no required_keys when output is a valid object', () => {
    const result = runAssertion(
      { type: 'json_shape' },
      '{}',
    );
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runAssertion — regex
// ---------------------------------------------------------------------------
describe('runAssertion: regex', () => {
  it('passes when regex matches', () => {
    const result = runAssertion(
      { type: 'regex', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      '2026-04-22',
    );
    expect(result.passed).toBe(true);
    expect(result.detail).toBeUndefined();
  });

  it('fails when regex does not match', () => {
    const result = runAssertion(
      { type: 'regex', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      'not-a-date',
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('regex did not match');
  });

  it('supports flags (case-insensitive)', () => {
    const result = runAssertion(
      { type: 'regex', pattern: 'hello', flags: 'i' },
      'HELLO WORLD',
    );
    expect(result.passed).toBe(true);
  });

  it('returns passed:false with detail when regex is invalid (does not throw)', () => {
    const result = runAssertion(
      { type: 'regex', pattern: '[invalid(' },
      'anything',
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('invalid regex');
  });
});

// ---------------------------------------------------------------------------
// runAssertion — unknown type fallback
// ---------------------------------------------------------------------------
describe('runAssertion: unknown type', () => {
  it('returns passed:false with an "unknown assertion type" detail', () => {
    const result = runAssertion(
      // Cast to bypass TS narrowing so we can pass a bad type at runtime
      { type: 'nonexistent' as 'substring' },
      'any output',
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('unknown assertion type');
    expect(result.type).toBe('nonexistent');
  });
});

// ---------------------------------------------------------------------------
// validateEvalFile
// ---------------------------------------------------------------------------
describe('validateEvalFile', () => {
  const validFile = {
    agent: 'kb-query',
    fixtures: [
      {
        name: 'basic query',
        input: 'What is X?',
        assertions: [{ type: 'substring', value: 'X' }],
      },
    ],
  };

  it('returns ok:true for a valid eval file', () => {
    const result = validateEvalFile(validFile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.agent).toBe('kb-query');
    }
  });

  it('fails when root is not an object (null)', () => {
    const result = validateEvalFile(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('root must be a mapping');
  });

  it('fails when root is a primitive', () => {
    const result = validateEvalFile('string value');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('root must be a mapping');
  });

  it('fails when agent is missing', () => {
    const result = validateEvalFile({ fixtures: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('agent');
  });

  it('fails when agent is an empty string', () => {
    const result = validateEvalFile({ agent: '', fixtures: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('agent');
  });

  it('fails when agent contains path-traversal segments', () => {
    const result = validateEvalFile({ agent: '../../etc/passwd', fixtures: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('lowercase-kebab-case');
  });

  it('fails when agent has uppercase or underscores (not kebab-case)', () => {
    const result = validateEvalFile({ agent: 'KB_Query', fixtures: [] });
    expect(result.ok).toBe(false);
  });

  it('accepts kebab-case agent names with digits', () => {
    const result = validateEvalFile({
      agent: 'wiki-compiler-v2',
      fixtures: [
        { name: 't', input: 'q', assertions: [{ type: 'substring', value: 'a' }] },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('fails when fixtures is missing', () => {
    const result = validateEvalFile({ agent: 'kb-query' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('fixtures');
  });

  it('fails when fixtures is not an array', () => {
    const result = validateEvalFile({ agent: 'kb-query', fixtures: 'bad' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('fixtures');
  });

  it('fails when a fixture is missing name', () => {
    const result = validateEvalFile({
      agent: 'kb-query',
      fixtures: [{ input: 'Q?', assertions: [{ type: 'substring', value: 'A' }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('name');
  });

  it('fails when a fixture has an empty name', () => {
    const result = validateEvalFile({
      agent: 'kb-query',
      fixtures: [{ name: '', input: 'Q?', assertions: [{ type: 'substring', value: 'A' }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('name');
  });

  it('fails when a fixture is missing input', () => {
    const result = validateEvalFile({
      agent: 'kb-query',
      fixtures: [{ name: 'test', assertions: [{ type: 'substring', value: 'A' }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('input');
  });

  it('fails when a fixture has an empty assertions list', () => {
    const result = validateEvalFile({
      agent: 'kb-query',
      fixtures: [{ name: 'test', input: 'Q?', assertions: [] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('assertions');
  });

  it('fails when a fixture is missing assertions entirely', () => {
    const result = validateEvalFile({
      agent: 'kb-query',
      fixtures: [{ name: 'test', input: 'Q?' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('assertions');
  });

  it('accepts a file with multiple valid fixtures', () => {
    const result = validateEvalFile({
      agent: 'kb-query',
      fixtures: [
        { name: 'q1', input: 'Question 1', assertions: [{ type: 'substring', value: 'foo' }] },
        { name: 'q2', input: 'Question 2', assertions: [{ type: 'max_length_chars', value: 500 }] },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------
describe('parseCliArgs', () => {
  it('returns defaults for empty argv', () => {
    const args = parseCliArgs([]);
    expect(args.agentFilter).toBeNull();
    expect(args.dryRun).toBe(false);
    expect(args.help).toBe(false);
    expect(args.unknown).toEqual([]);
  });

  it('recognizes --dry-run', () => {
    const args = parseCliArgs(['--dry-run']);
    expect(args.dryRun).toBe(true);
    expect(args.agentFilter).toBeNull();
  });

  it('recognizes --help and -h', () => {
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs(['-h']).help).toBe(true);
  });

  it('captures a positional arg as agentFilter', () => {
    const args = parseCliArgs(['wiki-compiler']);
    expect(args.agentFilter).toBe('wiki-compiler');
    expect(args.dryRun).toBe(false);
  });

  it('combines agent filter with --dry-run in any order', () => {
    const a = parseCliArgs(['wiki-compiler', '--dry-run']);
    expect(a.agentFilter).toBe('wiki-compiler');
    expect(a.dryRun).toBe(true);
    const b = parseCliArgs(['--dry-run', 'wiki-compiler']);
    expect(b.agentFilter).toBe('wiki-compiler');
    expect(b.dryRun).toBe(true);
  });

  it('collects unknown flags into unknown list', () => {
    const args = parseCliArgs(['--bogus', '--also-bogus']);
    expect(args.unknown).toEqual(['--bogus', '--also-bogus']);
  });

  it('treats a second positional arg as unknown (not a second filter)', () => {
    const args = parseCliArgs(['wiki-compiler', 'kb-query']);
    expect(args.agentFilter).toBe('wiki-compiler');
    expect(args.unknown).toEqual(['kb-query']);
  });

  it('treats unknown short flags as unknown, not as agentFilter', () => {
    const args = parseCliArgs(['-v']);
    expect(args.agentFilter).toBeNull();
    expect(args.unknown).toEqual(['-v']);
  });
});

// ---------------------------------------------------------------------------
// runFixture — resolver special-case branch
// ---------------------------------------------------------------------------
describe('runFixture: resolver branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes agent=resolver through classifyIntent, not runAgent', async () => {
    vi.mocked(classifyIntent).mockResolvedValue({
      skill: 'workout',
      args: 'home strength',
      confidence: 0.9,
      second_skill: null,
      second_confidence: 0,
      ambiguous: false,
      raw: '{"skill":"workout"}',
    });

    const report = await runFixture('resolver', {
      name: 'workout request',
      input: 'design me a workout',
      assertions: [{ type: 'substring', value: '"skill":"workout"' }],
    });

    expect(classifyIntent).toHaveBeenCalledTimes(1);
    expect(runAgent).not.toHaveBeenCalled();
    expect(report.passed).toBe(true);
  });

  it('serializes the ClassifyResult as JSON (omitting raw) for assertions', async () => {
    vi.mocked(classifyIntent).mockResolvedValue({
      skill: 'journal',
      args: 'note this',
      confidence: 0.85,
      second_skill: null,
      second_confidence: 0,
      ambiguous: false,
      raw: 'should not appear in output',
    });

    const report = await runFixture('resolver', {
      name: 'journal',
      input: 'add this to my journal please',
      assertions: [
        { type: 'json_shape', required_keys: ['skill', 'args', 'confidence', 'second_skill'] },
        { type: 'substring', value: '"skill":"journal"' },
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.assertions).toHaveLength(2);
    expect(report.assertions.every((a) => a.passed)).toBe(true);
  });

  it('reports agentError when classifyIntent throws', async () => {
    vi.mocked(classifyIntent).mockRejectedValue(new Error('classifier exploded'));

    const report = await runFixture('resolver', {
      name: 'crash',
      input: 'anything at all here',
      assertions: [{ type: 'substring', value: 'anything' }],
    });

    expect(report.passed).toBe(false);
    expect(report.agentError).toBe('classifier exploded');
    expect(report.assertions).toHaveLength(0);
  });

  it('does not invoke the resolver branch for non-resolver agents', async () => {
    vi.mocked(runAgent).mockResolvedValue({ text: 'agent output', error: null });

    await runFixture('wiki-compiler', {
      name: 'normal agent',
      input: 'ingest this',
      assertions: [{ type: 'substring', value: 'agent output' }],
    });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(classifyIntent).not.toHaveBeenCalled();
  });
});
