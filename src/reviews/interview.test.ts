import { describe, it, expect, vi } from 'vitest';

// Mock heavy dependencies so the module can be imported without side effects.
// interview.ts imports from session, ai/claude, vault/files, vault/git,
// utils/logger, jobs/playbook-extract, kb/queue.

vi.mock('../config.js', () => ({
  default: {
    VAULT_DIR: '/test/vault',
    TIMEZONE: 'America/Chicago',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 123,
    LOGS_DIR: '/tmp/jarvis-test-logs',
    get PLAYBOOK_QUEUE_FILE() { return '/tmp/jarvis-test-logs/playbook-queue.json'; },
    get REVIEW_SESSIONS_FILE() { return '/tmp/jarvis-test-logs/review-sessions.json'; },
    get SESSIONS_FILE() { return '/tmp/jarvis-test-logs/tg-sessions.json'; },
  },
  PROJECT_ROOT: '/test/project',
}));

vi.mock('./session.js', () => ({
  updateReviewSession: vi.fn(),
  onReviewSessionDeleted: vi.fn(),
}));

vi.mock('../ai/claude.js', () => ({
  askClaudeWithContext: vi.fn(),
  askClaudeOneShot: vi.fn(),
  runAgent: vi.fn(),
  AGENT_NOT_FOUND_PREFIX: 'Agent not found:',
}));

vi.mock('../vault/files.js', () => ({ readVaultFile: vi.fn() }));
vi.mock('../vault/git.js', () => ({ gitCommitAndPush: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../jobs/playbook-extract.js', () => ({ getPendingPlaybookDrafts: vi.fn(() => []) }));
vi.mock('../jobs/proposal-queue.js', () => ({
  getPendingProposals: vi.fn(() => []),
  clearApprovedProposals: vi.fn(),
}));
vi.mock('../kb/queue.js', () => ({ enqueue: vi.fn() }));

const { toScannerDate, detectOutline, extractInterviewInstructions } = await import('./interview.js');

describe('toScannerDate', () => {
  it('replaces hyphens with underscores', () => {
    expect(toScannerDate('2026-04-07')).toBe('2026_04_07');
  });

  it('handles year-only strings', () => {
    expect(toScannerDate('2026')).toBe('2026');
  });

  it('handles full ISO date with no hyphens in output', () => {
    const result = toScannerDate('2024-12-31');
    expect(result).toBe('2024_12_31');
    expect(result).not.toContain('-');
  });
});

describe('detectOutline', () => {
  it('returns null when marker is not present', () => {
    expect(detectOutline('No outline here.', 'review outline:')).toBeNull();
  });

  it('detects marker at the start of the response', () => {
    const response = 'review outline:\n- Point one\n- Point two';
    const result = detectOutline(response, 'review outline:');
    expect(result).not.toBeNull();
    expect(result).toContain('Point one');
  });

  it('detects marker in the middle of the response', () => {
    const response = 'Let me summarize what we discussed.\n\nreview outline:\n- Key insight';
    const result = detectOutline(response, 'review outline:');
    expect(result).not.toBeNull();
    expect(result!.startsWith('review outline:')).toBe(true);
  });

  it('detects marker at the end of the response', () => {
    const response = 'Great conversation. Here is the final summary.\nreview outline:';
    const result = detectOutline(response, 'review outline:');
    expect(result).not.toBeNull();
  });

  it('is case-insensitive — uppercase marker matches lowercase in response', () => {
    const response = 'Some text\nReview Outline:\n- Point';
    const result = detectOutline(response, 'review outline:');
    expect(result).not.toBeNull();
  });

  it('is case-insensitive — lowercase marker matches uppercase in response', () => {
    const response = 'Some text\nREVIEW OUTLINE:\n- Point';
    const result = detectOutline(response, 'review outline:');
    expect(result).not.toBeNull();
  });

  it('returns the slice starting from the marker position in original casing', () => {
    const response = 'Preamble\nReview Outline:\n- Point A';
    const result = detectOutline(response, 'review outline:');
    // Should preserve original casing of the response, not the marker
    expect(result).toContain('Review Outline:');
  });

  it('returns trimmed content with no leading whitespace', () => {
    const response = 'Text\n\n  review outline:\n- Item';
    const result = detectOutline(response, 'review outline:');
    expect(result).not.toBeNull();
    expect(result!.charAt(0)).not.toBe(' ');
    expect(result!.charAt(0)).not.toBe('\n');
  });
});

describe('extractInterviewInstructions', () => {
  it('returns full content when no Step 2 header is present', () => {
    const content = '# Skill\n\nSome content without step headers.';
    expect(extractInterviewInstructions(content)).toBe(content);
  });

  it('slices from Step 2 to Step 4 when both are present', () => {
    const content = `## Step 1: Prep
prep stuff

## Step 2: Interview
interview content

## Step 3: Outline
outline content

## Step 4: Write-up
writeup stuff`;
    const result = extractInterviewInstructions(content);
    expect(result.startsWith('## Step 2: Interview')).toBe(true);
    expect(result).toContain('## Step 3: Outline');
    expect(result).toContain('outline content');
    expect(result).not.toContain('## Step 4:');
    expect(result).not.toContain('writeup stuff');
  });

  it('slices from Step 2 to end when Step 4 is missing', () => {
    const content = `## Step 1: Prep
prep

## Step 2: Interview
interview body
more interview text`;
    const result = extractInterviewInstructions(content);
    expect(result.startsWith('## Step 2: Interview')).toBe(true);
    expect(result).toContain('more interview text');
  });

  it('trims whitespace from the extracted section', () => {
    const content = `## Step 2: Interview\n\n\ninterview\n\n\n## Step 4: Done\n`;
    const result = extractInterviewInstructions(content);
    expect(result.startsWith('## Step 2:')).toBe(true);
    expect(result.endsWith('interview')).toBe(true);
  });

  it('excludes the Step 4 header itself from the slice', () => {
    const content = `## Step 2: Interview\nbody\n## Step 4: Write`;
    const result = extractInterviewInstructions(content);
    expect(result).not.toContain('Step 4');
  });
});
