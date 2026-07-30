import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { getBaseEnv } from '../jobs/credential-injector.js';
import { redactSecrets } from '../utils/redact-secrets.js';
import { scrubAbsolutePaths } from '../utils/sanitize-paths.js';

const execFile = promisify(execFileCb);
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 64 * 1024;
const MAX_REASON_LENGTH = 320;
const FULL_SHA = /^[0-9a-f]{40,64}$/;
const SHORT_SHA = /^[0-9a-f]{7,64}$/;

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export type ProductChatGitRunner = (
  args: readonly string[],
  options: { cwd: string },
) => Promise<GitCommandResult>;

export interface CommitConfirmed {
  status: 'confirmed';
  baselineHead: string;
  head: string;
  shortSha: string;
  subject: string;
  clean: true;
}

export interface CommitUnconfirmed {
  status: 'unconfirmed';
  baselineHead?: string;
  observedHead?: string;
  reason: string;
}

export type ProductChatCommitOutcome = CommitConfirmed | CommitUnconfirmed;

/** Deliberately narrower than `DEFAULT_BASE_ENV_KEYS`: `HOME` is omitted so the
 *  verifier cannot reach `~/.gitconfig`, its credential helpers, or an ambient
 *  askpass binary. `getBaseEnv` is still the shared source so the launchd-safe
 *  `PATH` construction stays in one place. */
const VERIFIER_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'] as const;

function verifierEnv(): NodeJS.ProcessEnv {
  return {
    ...getBaseEnv(VERIFIER_ENV_KEYS),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

/**
 * Read-only Git runner for the product-chat commit verifier.
 *
 * Deliberately separate from `defaultRunGit` (`src/jobs/sandbox-runtime.ts`)
 * and `canonicalGit` (`src/jobs/canonical-git.ts`): this one adds credential
 * stripping (no `HOME`, no system/global config, no terminal prompt), hook and
 * fsmonitor suppression, and a bounded timeout/buffer, because it runs against
 * a repository an operator-driven agent may just have mutated. Keep the two
 * in sync when the shared env allowlist changes.
 */
export const runProductChatGit: ProductChatGitRunner = async (args, options) => {
  const result = await execFile('git', [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    ...args,
  ], {
    cwd: options.cwd,
    env: verifierEnv(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function safeReason(raw: unknown): string {
  const message = raw instanceof Error ? raw.message : String(raw || 'unknown verification error');
  const scrubbed = scrubHostPaths(redactSecrets(message))
    .replace(/\s+/g, ' ')
    .trim();
  return (scrubbed || 'unknown verification error').slice(0, MAX_REASON_LENGTH);
}

function scrubHostPaths(raw: string): string {
  return scrubAbsolutePaths(raw)
    .replace(/(?:\/Users\/|\/home\/)[^\s:]+/g, '<host-path>')
    .replace(/(^|[\s("'=])\/(?:[^/\s:]+\/)+[^/\s:)"']+/g, '$1<host-path>')
    .replace(/[A-Za-z]:\\(?:[^\\\s:]+\\)*[^\\\s:]*/g, '<host-path>');
}

function validHead(raw: string): string | null {
  const head = raw.trim().toLowerCase();
  return FULL_SHA.test(head) ? head : null;
}

/** Tokens that may introduce an imperative clause without changing its force.
 *  Anything else in front of "commit" (an article, a possessive, a subject
 *  noun) means the word is being *discussed*, not *commanded*. */
const COMMIT_LEAD_IN = '(?:please|now|then|also|just|and|so|ok|okay|yes|yeah|yep|sure|alright|' +
  'go\\s+ahead\\s+and|go\\s+ahead|let\'?s|you\\s+can|you\\s+should|' +
  '(?:can|could|would|will)\\s+you|i\'?d\\s+like\\s+you\\s+to|i\\s+want\\s+you\\s+to)';

/** Allowlist of what may follow the verb "commit" in a genuine directive.
 *  An allowlist (rather than a blocklist of compound-noun heads such as
 *  "message"/"style"/"history") fails closed: an unrecognized continuation is
 *  read as prose *about* commits, never as a request to create one. */
const COMMIT_OBJECT = '(?:it|this|that|these|those|them|everything|all|both|any|what|whatever|' +
  'the|a|my|our|your|current|currently|staged|unstaged|remaining|pending|outstanding|new|' +
  'changes?|work|edits?|files?|updates?|fixes?|now|on|to|with|in|-{1,2}[a-z])';

const COMMIT_DIRECTIVE = new RegExp(
  `^(?:${COMMIT_LEAD_IN}[\\s,]+)*(?:git\\s+)?commit\\b(?:\\s+${COMMIT_OBJECT}\\b.*)?$`,
);

/**
 * Narrow deterministic detector for a direct request to create a commit.
 *
 * The text is split into clauses and each is tested for an *imperative commit
 * directive*: an optional lead-in, an optional `git`, the bare verb `commit`,
 * and — if anything follows — an allowlisted object. Prose that merely opens
 * with the word ("commit message needs work", "git commit style should follow
 * this convention") is therefore rejected, while a directive buried after a
 * preamble ("looks good, commit it") is accepted.
 *
 * Deliberately NOT detected: a bare affirmative with no commit language at all
 * ("yes please", "do it") following a model-proposed commit. Inferring intent
 * from surrounding prose is exactly what this contract forbids — such a turn
 * still gets the generic terminal reply, just not a verified commit receipt.
 */
export function isExplicitCommitRequest(raw: string): boolean {
  const text = raw.trim().toLowerCase().replace(/[.!]+$/g, '').trim();
  if (!text) return false;
  if (/\b(?:do\s+not|don't|dont|never|without|no\s+need\s+to|please\s+avoid)\b[^?.!]{0,48}\bcommit\b/.test(text)) {
    return false;
  }
  // A trailing question mark marks an inquiry, not an instruction — except for
  // the polite-request auxiliaries ("could you commit this?").
  if (/\?\s*$/.test(text) && !/^(?:can|could|would|will|won't|can't|couldn't)\b/.test(text)) {
    return false;
  }
  if (/^(?:was|were|is|are|did|does|has|have|what|which|who|when|where|why|how|should|shall|show|tell|list)\b/.test(text)) {
    return false;
  }
  return text
    .replace(/\?+$/g, '')
    .split(/[,;:]|\s+(?:and|then|but|however|though|although|because|since|while|after|before|unless|once)\s+/)
    .some(clause => COMMIT_DIRECTIVE.test(clause.trim()));
}

export async function captureCommitBaseline(
  repoRoot: string,
  runner: ProductChatGitRunner = runProductChatGit,
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  try {
    const result = await runner(['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot });
    const head = validHead(result.stdout);
    return head
      ? { ok: true, head }
      : { ok: false, reason: 'baseline HEAD metadata was malformed' };
  } catch (error) {
    return { ok: false, reason: `baseline HEAD unavailable: ${safeReason(error)}` };
  }
}

export async function verifyCommitCompletion(input: {
  repoRoot: string;
  baselineHead: string;
  providerError?: string | null;
  runner?: ProductChatGitRunner;
}): Promise<ProductChatCommitOutcome> {
  const baselineHead = validHead(input.baselineHead);
  if (!baselineHead) {
    return { status: 'unconfirmed', reason: 'captured baseline HEAD metadata was malformed' };
  }
  if (input.providerError) {
    return {
      status: 'unconfirmed',
      baselineHead,
      reason: `provider did not complete successfully: ${safeReason(input.providerError)}`,
    };
  }

  const runner = input.runner ?? runProductChatGit;
  try {
    const [headResult, metadataResult, statusResult] = await Promise.all([
      runner(['rev-parse', '--verify', 'HEAD'], { cwd: input.repoRoot }),
      runner(['show', '-s', '--format=%H%x00%h%x00%s', 'HEAD'], { cwd: input.repoRoot }),
      runner(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: input.repoRoot }),
    ]);
    const head = validHead(headResult.stdout);
    if (!head) {
      return { status: 'unconfirmed', baselineHead, reason: 'resulting HEAD metadata was malformed' };
    }
    if (head === baselineHead) {
      return { status: 'unconfirmed', baselineHead, observedHead: head, reason: 'HEAD did not advance' };
    }
    try {
      await runner(['merge-base', '--is-ancestor', baselineHead, head], { cwd: input.repoRoot });
    } catch (error) {
      return {
        status: 'unconfirmed',
        baselineHead,
        observedHead: head,
        reason: `resulting HEAD is not a verified descendant of baseline: ${safeReason(error)}`,
      };
    }

    const metadata = metadataResult.stdout.trimEnd().split('\0');
    const metadataHead = validHead(metadata[0] ?? '');
    const shortSha = (metadata[1] ?? '').trim().toLowerCase();
    const rawSubject = (metadata[2] ?? '').trim();
    const subject = scrubHostPaths(redactSecrets(rawSubject))
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    if (metadata.length !== 3 || metadataHead !== head || !SHORT_SHA.test(shortSha) ||
        !rawSubject || rawSubject.includes('\n') || !subject || !head.startsWith(shortSha)) {
      return { status: 'unconfirmed', baselineHead, observedHead: head, reason: 'commit metadata was malformed' };
    }

    const dirtyRows = statusResult.stdout.split(/\r?\n/).filter(Boolean).length;
    if (dirtyRows > 0) {
      return {
        status: 'unconfirmed',
        baselineHead,
        observedHead: head,
        reason: `worktree is not clean (${dirtyRows} change${dirtyRows === 1 ? '' : 's'})`,
      };
    }
    return { status: 'confirmed', baselineHead, head, shortSha, subject, clean: true };
  } catch (error) {
    return {
      status: 'unconfirmed',
      baselineHead,
      reason: `Git verification failed: ${safeReason(error)}`,
    };
  }
}

export function renderCommitReceipt(outcome: ProductChatCommitOutcome): string {
  if (outcome.status === 'confirmed') {
    return `Commit confirmed: \`${outcome.shortSha}\` ${outcome.subject}\nWorktree clean.`;
  }
  return `Commit completion not confirmed: ${safeReason(outcome.reason)}.`;
}

export function appendCommitReceipt(
  providerText: string | null,
  outcome: ProductChatCommitOutcome,
): string {
  const receipt = renderCommitReceipt(outcome);
  const prose = providerText?.trim();
  return prose ? `${prose}\n\n${receipt}` : receipt;
}
