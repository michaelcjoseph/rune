/**
 * Test-first suite for the fresh-context fix-it self-review primitive
 * (project 20, test-plan §3).
 *
 * These tests pin `runSelfReview` itself. They fake only the role transport via
 * the injected model-call seam; they do not mock the primitive under test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runSelfReview } from './self-review.js';

const { mockRandomUUID, mockCleanupSession } = vi.hoisted(() => ({
  mockRandomUUID: vi.fn(() => 'self-review-session-1'),
  mockCleanupSession: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  randomUUID: mockRandomUUID,
}));

vi.mock('../ai/claude.js', () => ({
  cleanupSession: mockCleanupSession,
}));

interface ReviewArtifact {
  title: string;
  spec: string;
  directions: string[];
}

interface CapturedRoleCall {
  role: string;
  sessionId?: string;
  systemPrompt: string;
  message: string;
}

interface SelfReviewModelCall {
  (input: {
    role: 'pm' | 'tech-lead' | 'coder';
    sessionId: string;
    systemPrompt: string;
    message: string;
  }): Promise<string>;
}

const FLAWED_SPEC: ReviewArtifact = {
  title: 'Daily summary card',
  spec: 'Show a daily summary card, but it inconsistently says weekly totals in one bullet.',
  directions: ['daily summary card'],
};

const FIXED_SPEC: ReviewArtifact = {
  title: 'Daily summary card',
  spec: 'Show a daily summary card and keep every requirement scoped to daily totals.',
  directions: ['daily summary card'],
};

function renderArtifact(artifact: ReviewArtifact): string {
  return [
    '```self-review-artifact',
    JSON.stringify(artifact, null, 2),
    '```',
  ].join('\n');
}

function fencedArtifact(artifact: ReviewArtifact): string {
  return [
    'Self-review complete.',
    '```self-review-artifact',
    JSON.stringify(artifact, null, 2),
    '```',
  ].join('\n');
}

function parseArtifact(reply: string): ReviewArtifact {
  const match = /```self-review-artifact\s*\n([\s\S]*?)\n```/.exec(reply);
  if (!match) {
    throw new Error('missing self-review-artifact fence');
  }
  const parsed = JSON.parse(match[1]!) as Partial<ReviewArtifact>;
  if (
    typeof parsed.title !== 'string' ||
    typeof parsed.spec !== 'string' ||
    !Array.isArray(parsed.directions) ||
    !parsed.directions.every((direction) => typeof direction === 'string')
  ) {
    throw new Error('invalid self-review artifact');
  }
  return {
    title: parsed.title,
    spec: parsed.spec,
    directions: parsed.directions,
  };
}

function parseArtifactWithoutNewDirection(input: ReviewArtifact): (reply: string) => ReviewArtifact {
  const allowed = new Set(input.directions);
  return (reply: string) => {
    const artifact = parseArtifact(reply);
    const invented = artifact.directions.filter((direction) => !allowed.has(direction));
    if (invented.length > 0) {
      throw new Error(`invented product direction: ${invented.join(', ')}`);
    }
    return artifact;
  };
}

function captureModelCall(replies: string[]): { modelCall: SelfReviewModelCall; calls: CapturedRoleCall[] } {
  const calls: CapturedRoleCall[] = [];
  const queue = [...replies];
  const modelCall: SelfReviewModelCall = async ({ role, sessionId, systemPrompt, message }) => {
    calls.push({ role, sessionId, systemPrompt, message });
    return queue.shift() ?? '';
  };
  return { modelCall, calls };
}

function resetSessionMocks(): void {
  mockRandomUUID.mockReturnValue('self-review-session-1');
  mockRandomUUID.mockClear();
  mockCleanupSession.mockClear();
}

describe('runSelfReview — primitive contract (test-plan §3)', () => {
  beforeEach(() => {
    resetSessionMocks();
  });

  it('composes the role charter, sends only the rendered artifact, and returns a real revision', async () => {
    const { modelCall, calls } = captureModelCall([fencedArtifact(FIXED_SPEC)]);

    const result = await runSelfReview({
      role: 'pm',
      artifact: FLAWED_SPEC,
      render: renderArtifact,
      parse: parseArtifact,
      modelCall,
    });

    expect(result).toEqual({ artifact: FIXED_SPEC, revised: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.role).toBe('pm');
    expect(calls[0]!.sessionId).toBe('self-review-session-1');
    expect(calls[0]!.systemPrompt.toLowerCase()).toContain('product manager');
    expect(calls[0]!.systemPrompt.toLowerCase()).toContain('self-review');
    expect(calls[0]!.systemPrompt.toLowerCase()).toContain('fix');
    expect(calls[0]!.message).toContain(renderArtifact(FLAWED_SPEC));
    expect(calls[0]!.message).not.toContain('interview transcript');
    expect(calls[0]!.message).not.toContain('authoring context');
    expect(mockRandomUUID).toHaveBeenCalledTimes(1);
    expect(mockCleanupSession).toHaveBeenCalledTimes(1);
    expect(mockCleanupSession).toHaveBeenCalledWith('self-review-session-1');
  });

  it('does not run a convergence loop after a clean first response', async () => {
    const { modelCall, calls } = captureModelCall([fencedArtifact(FIXED_SPEC)]);

    await runSelfReview({
      role: 'tech-lead',
      artifact: FLAWED_SPEC,
      render: renderArtifact,
      parse: parseArtifact,
      modelCall,
    });

    expect(calls.map((call) => call.role)).toEqual(['tech-lead']);
    expect(mockCleanupSession).toHaveBeenCalledTimes(1);
    expect(mockCleanupSession).toHaveBeenCalledWith('self-review-session-1');
  });

  it('treats flag-only or malformed replies as parse failures and gives exactly one strict-format retry', async () => {
    const { modelCall, calls } = captureModelCall([
      'Looks good; no issues found.',
      fencedArtifact(FIXED_SPEC),
    ]);

    const result = await runSelfReview({
      role: 'pm',
      artifact: FLAWED_SPEC,
      render: renderArtifact,
      parse: parseArtifact,
      modelCall,
    });

    expect(result).toEqual({ artifact: FIXED_SPEC, revised: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.role).toBe('pm');
    expect(calls[1]!.sessionId).toBe('self-review-session-1');
    expect(calls[1]!.message.toLowerCase()).toContain('strict');
    expect(calls[1]!.message.toLowerCase()).toContain('format');
    expect(calls[1]!.message.toLowerCase()).not.toContain('try another fix pass');
    expect(calls[1]!.message).toContain(renderArtifact(FLAWED_SPEC));
    expect(mockRandomUUID).toHaveBeenCalledTimes(1);
    expect(mockCleanupSession).toHaveBeenCalledTimes(1);
    expect(mockCleanupSession).toHaveBeenCalledWith('self-review-session-1');
  });

  it('surfaces self-review failure when the strict-format retry is still unparseable', async () => {
    const { modelCall, calls } = captureModelCall([
      'Flag-only critique: fix the inconsistency.',
      'Still no fenced artifact.',
    ]);

    await expect(
      runSelfReview({
        role: 'coder',
        artifact: FLAWED_SPEC,
        render: renderArtifact,
        parse: parseArtifact,
        modelCall,
      }),
    ).rejects.toThrow(/self-review/i);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.role)).toEqual(['coder', 'coder']);
    expect(mockCleanupSession).toHaveBeenCalledTimes(1);
    expect(mockCleanupSession).toHaveBeenCalledWith('self-review-session-1');
  });

  it('does not accept new product direction absent from the rendered artifact', async () => {
    const inventedDirection: ReviewArtifact = {
      title: 'Daily summary card',
      spec: 'Show a daily summary card and add a new mobile push notification system.',
      directions: ['daily summary card', 'mobile push notifications'],
    };
    const { modelCall, calls } = captureModelCall([
      fencedArtifact(inventedDirection),
      fencedArtifact(FIXED_SPEC),
    ]);

    const result = await runSelfReview({
      role: 'pm',
      artifact: FLAWED_SPEC,
      render: renderArtifact,
      parse: parseArtifactWithoutNewDirection(FLAWED_SPEC),
      modelCall,
    });

    expect(result).toEqual({ artifact: FIXED_SPEC, revised: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.message).toContain('daily summary card');
    expect(calls[0]!.message).not.toContain('mobile push notifications');
  });

  it('returns the original artifact with revised=false for whitespace-only changes', async () => {
    const cleanInput: ReviewArtifact = {
      title: 'Daily summary card',
      spec: 'Line one.\n\nLine two.',
      directions: ['daily summary card'],
    };
    const reformattedOnly: ReviewArtifact = {
      title: 'Daily summary card',
      spec: 'Line one.\n \n   Line two.',
      directions: ['daily summary card'],
    };
    const { modelCall, calls } = captureModelCall([fencedArtifact(reformattedOnly)]);

    const result = await runSelfReview({
      role: 'pm',
      artifact: cleanInput,
      render: renderArtifact,
      parse: parseArtifact,
      modelCall,
    });

    expect(result).toEqual({ artifact: cleanInput, revised: false });
    expect(calls).toHaveLength(1);
    expect(mockCleanupSession).toHaveBeenCalledTimes(1);
    expect(mockCleanupSession).toHaveBeenCalledWith('self-review-session-1');
  });
});
