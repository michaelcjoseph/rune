import { slugifyWritingIdentifier } from './writing-product-orchestration.js';

export type WritingReachabilitySurface = 'telegram' | 'cockpit';

export type WritingReachabilityTerminalRun = {
  runId: string;
  product: string;
  status: 'completed' | 'failed' | 'blocked-on-human';
  outcome?: string;
  branch?: string;
  target?: { kind: string; slug: string };
};

export type WritingReachabilityDeps = {
  dispatchBlogCommand: (input: {
    surface: WritingReachabilitySurface;
    product: 'writing';
    text: string;
  }) => Promise<{ runId: string }>;
  observeTerminalRun: (input: {
    runId: string;
    timeoutMs: number;
  }) => Promise<WritingReachabilityTerminalRun>;
  readBranchFile: (input: {
    repo: 'michaelcjoseph.com';
    branch: string;
    path: string;
  }) => Promise<string>;
};

export type WritingReachabilityResult = {
  ok: true;
  runId: string;
  product: 'writing';
  branch: string;
  slug: string;
  routePaths: ['/rune', `/rune/${string}`];
  pagePaths: ['src/app/rune/page.tsx', 'src/app/rune/[slug]/page.tsx'];
};

const WRITING_REACHABILITY_PAGE_PATHS = [
  'src/app/rune/page.tsx',
  'src/app/rune/[slug]/page.tsx',
] as const;

export async function runWritingUserReachabilityCheck(
  input: {
    surface: WritingReachabilitySurface;
    topic: string;
    timeoutMs: number;
  },
  deps: WritingReachabilityDeps,
): Promise<WritingReachabilityResult> {
  const topic = input.topic.trim();
  const slug = slugifyWritingIdentifier(topic);
  const branch = `rune-writing/${slug}`;
  const routePaths = ['/rune', `/rune/${slug}`] as ['/rune', `/rune/${string}`];

  const started = await deps.dispatchBlogCommand({
    surface: input.surface,
    product: 'writing',
    text: `/blog ${topic}`,
  });
  const terminal = await deps.observeTerminalRun({
    runId: started.runId,
    timeoutMs: input.timeoutMs,
  });

  if (
    terminal.runId !== started.runId ||
    terminal.product !== 'writing' ||
    terminal.status !== 'completed' ||
    terminal.outcome !== 'branch-complete' ||
    terminal.branch !== branch ||
    terminal.target?.kind !== 'writing-page' ||
    terminal.target.slug !== slug
  ) {
    throw new Error(
      `Writing reachability terminal run did not complete branch-complete for ${branch}: ` +
      `status=${terminal.status} outcome=${terminal.outcome ?? 'unknown'} branch=${terminal.branch ?? 'unknown'}`,
    );
  }

  for (const path of WRITING_REACHABILITY_PAGE_PATHS) {
    try {
      const content = await deps.readBranchFile({
        repo: 'michaelcjoseph.com',
        branch,
        path,
      });
      if (content.trim().length === 0) {
        throw new Error('file is empty');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Required page ${path} missing from ${branch}: ${message}`);
    }
  }

  return {
    ok: true,
    runId: started.runId,
    product: 'writing',
    branch,
    slug,
    routePaths,
    pagePaths: [...WRITING_REACHABILITY_PAGE_PATHS],
  };
}
