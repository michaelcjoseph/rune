import { describe, expect, it, vi } from 'vitest';
import {
  appendCommitReceipt,
  captureCommitBaseline,
  isExplicitCommitRequest,
  renderCommitReceipt,
  verifyCommitCompletion,
  type ProductChatGitRunner,
} from './product-chat-commit.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function runner(outputs: Record<string, string | Error>): ProductChatGitRunner {
  return vi.fn(async (args) => {
    const key = args.join(' ');
    const value = outputs[key];
    if (value instanceof Error) throw value;
    if (value === undefined && key.startsWith('merge-base --is-ancestor ')) {
      return { stdout: '', stderr: '' };
    }
    if (value === undefined) throw new Error(`unexpected Git call: ${key}`);
    return { stdout: value, stderr: '' };
  });
}

describe('explicit product-chat commit intent', () => {
  it.each([
    'commit these changes',
    'Please commit the current work.',
    'git commit',
    'go ahead and commit all remaining changes',
    'Could you please commit this?',
  ])('accepts %j', (text) => {
    expect(isExplicitCommitRequest(text)).toBe(true);
  });

  it.each([
    "don't commit these changes",
    'please do not commit',
    'was this committed?',
    'show the last commit',
    'what does git commit do?',
    'the commit handler needs a test',
    'fix the commit receipt',
  ])('rejects %j', (text) => {
    expect(isExplicitCommitRequest(text)).toBe(false);
  });

  // Prose that merely opens with the word "commit" is a statement about
  // commits, not a request to create one. Treating it as a commit turn runs
  // Git verification on an ordinary question and staples an "unconfirmed"
  // receipt onto the answer.
  it.each([
    'commit message needs work',
    'commit message conventions in this repo are inconsistent',
    'git commit style should follow this convention',
    'commit types like feat/fix should be used',
    'commit history is messy',
    'our commit hygiene is bad',
    'commit message and PR title conventions',
    'the commit and the push are separate concepts',
    'should I commit these changes?',
    'explain the commit flow',
  ])('rejects prose about commits: %j', (text) => {
    expect(isExplicitCommitRequest(text)).toBe(false);
  });

  // A directive is still a directive after a preamble or a lead-in clause.
  it.each([
    'looks good, commit it',
    'Looks good, please commit it',
    'ok now commit these changes',
    'update the readme and commit it',
    'commit and push',
    'yes, commit it',
    'commit everything',
    'can you commit the staged changes',
  ])('accepts a directive in context: %j', (text) => {
    expect(isExplicitCommitRequest(text)).toBe(true);
  });

  // Documented limitation: a bare affirmative carries no commit language, and
  // inferring intent from the surrounding conversation is what this contract
  // forbids. Such a turn still gets a terminal reply, just no commit receipt.
  it.each(['yes please', 'do it', 'ship it', 'go ahead'])(
    'does not infer commit intent from a bare affirmative: %j',
    (text) => {
      expect(isExplicitCommitRequest(text)).toBe(false);
    },
  );
});

describe('product-chat commit verification', () => {
  it('captures a full baseline HEAD', async () => {
    await expect(captureCommitBaseline('/repo', runner({
      'rev-parse --verify HEAD': `${BASE}\n`,
    }))).resolves.toEqual({ ok: true, head: BASE });
  });

  it('fails closed when baseline HEAD is unavailable or malformed', async () => {
    await expect(captureCommitBaseline('/repo', runner({
      'rev-parse --verify HEAD': 'main\n',
    }))).resolves.toEqual({ ok: false, reason: 'baseline HEAD metadata was malformed' });
    const failed = await captureCommitBaseline('/repo', runner({
      'rev-parse --verify HEAD': new Error('/Users/person/repo: sk-secret123 failed'),
    }));
    expect(failed.ok).toBe(false);
    expect(failed.ok ? '' : failed.reason).not.toContain('/Users/person');
    expect(failed.ok ? '' : failed.reason).not.toContain('sk-secret123');
  });

  it('confirms only an advanced commit with valid metadata and a clean tree', async () => {
    const result = await verifyCommitCompletion({
      repoRoot: '/repo',
      baselineHead: BASE,
      runner: runner({
        'rev-parse --verify HEAD': `${HEAD}\n`,
        'show -s --format=%H%x00%h%x00%s HEAD': `${HEAD}\0${HEAD.slice(0, 7)}\0Ship receipt\n`,
        'status --porcelain=v1 --untracked-files=all': '',
      }),
    });
    expect(result).toEqual({
      status: 'confirmed',
      baselineHead: BASE,
      head: HEAD,
      shortSha: HEAD.slice(0, 7),
      subject: 'Ship receipt',
      clean: true,
    });
    expect(renderCommitReceipt(result)).toContain(`\`${HEAD.slice(0, 7)}\` Ship receipt`);
  });

  it.each([
    ['no-op', BASE, `${BASE}\0${BASE.slice(0, 7)}\0No-op\n`, '', /did not advance/],
    ['dirty', HEAD, `${HEAD}\0${HEAD.slice(0, 7)}\0Ship\n`, ' M src/a.ts\n?? b.ts\n', /not clean \(2 changes\)/],
    ['malformed metadata', HEAD, `${HEAD}\0bad\0\n`, '', /metadata was malformed/],
  ])('reports %s as unconfirmed', async (_name, head, metadata, status, reason) => {
    const result = await verifyCommitCompletion({
      repoRoot: '/repo',
      baselineHead: BASE,
      runner: runner({
        'rev-parse --verify HEAD': `${head}\n`,
        'show -s --format=%H%x00%h%x00%s HEAD': metadata,
        'status --porcelain=v1 --untracked-files=all': status,
      }),
    });
    expect(result.status).toBe('unconfirmed');
    expect(result.status === 'unconfirmed' ? result.reason : '').toMatch(reason);
  });

  it('rejects a changed HEAD that is not proven to descend from the baseline', async () => {
    const result = await verifyCommitCompletion({
      repoRoot: '/repo',
      baselineHead: BASE,
      runner: runner({
        'rev-parse --verify HEAD': `${HEAD}\n`,
        'show -s --format=%H%x00%h%x00%s HEAD': `${HEAD}\0${HEAD.slice(0, 7)}\0Ship\n`,
        'status --porcelain=v1 --untracked-files=all': '',
        [`merge-base --is-ancestor ${BASE} ${HEAD}`]: new Error('not an ancestor'),
      }),
    });
    expect(result).toMatchObject({
      status: 'unconfirmed',
      observedHead: HEAD,
      reason: expect.stringContaining('not a verified descendant'),
    });
  });

  it('does not inspect Git after provider error, timeout, or cancellation', async () => {
    for (const error of ['provider failed', 'timed out', 'cancelled']) {
      const git = vi.fn() as unknown as ProductChatGitRunner;
      const result = await verifyCommitCompletion({
        repoRoot: '/repo',
        baselineHead: BASE,
        providerError: error,
        runner: git,
      });
      expect(result.status).toBe('unconfirmed');
      expect(git).not.toHaveBeenCalled();
    }
  });

  it('bounds and scrubs Git failures', async () => {
    const result = await verifyCommitCompletion({
      repoRoot: '/repo',
      baselineHead: BASE,
      runner: runner({
        'rev-parse --verify HEAD': new Error(`/Users/person/private sk-secret123 ${'x'.repeat(1000)}`),
        'show -s --format=%H%x00%h%x00%s HEAD': '',
        'status --porcelain=v1 --untracked-files=all': '',
      }),
    });
    const reason = result.status === 'unconfirmed' ? result.reason : '';
    expect(reason.length).toBeLessThan(380);
    expect(reason).not.toContain('/Users/person');
    expect(reason).not.toContain('sk-secret123');
  });

  it('scrubs and bounds commit subjects before rendering receipts', async () => {
    const result = await verifyCommitCompletion({
      repoRoot: '/repo',
      baselineHead: BASE,
      runner: runner({
        'rev-parse --verify HEAD': `${HEAD}\n`,
        'show -s --format=%H%x00%h%x00%s HEAD':
          `${HEAD}\0${HEAD.slice(0, 7)}\0Ship /Users/person/private sk-secret123 ${'x'.repeat(500)}\n`,
        'status --porcelain=v1 --untracked-files=all': '',
      }),
    });
    expect(result.status).toBe('confirmed');
    const subject = result.status === 'confirmed' ? result.subject : '';
    expect(subject.length).toBeLessThanOrEqual(200);
    expect(subject).not.toContain('/Users/person');
    expect(subject).not.toContain('sk-secret123');
  });

  it('appends a receipt to prose and supplies it for tool-only turns', () => {
    const outcome = {
      status: 'confirmed' as const,
      baselineHead: BASE,
      head: HEAD,
      shortSha: HEAD.slice(0, 7),
      subject: 'Ship',
      clean: true as const,
    };
    expect(appendCommitReceipt('Done.', outcome)).toBe(
      `Done.\n\nCommit confirmed: \`${HEAD.slice(0, 7)}\` Ship\nWorktree clean.`,
    );
    expect(appendCommitReceipt(null, outcome)).toBe(renderCommitReceipt(outcome));
  });
});
