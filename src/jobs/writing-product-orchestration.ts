import { writingBranchName } from '../intent/sandbox.js';

export type WritingProductSurfaceState =
  | 'researching'
  | 'drafting'
  | 'critiquing'
  | 'revising'
  | 'ready-for-review'
  | 'committed'
  | 'failed';

export interface WritingProductRunPlan {
  product: 'writing';
  topic: string;
  slug: string;
  branch: string;
  routePaths: string[];
  migration: {
    ideas: {
      sourceVaultPath: 'writing/topics.md';
      destinationRepoPath: 'docs/rune/writing-ideas.md';
    };
    voice: {
      sourceVaultPath: 'writing/voice.md';
      access: 'mcp';
      destinationRepoPath: string;
      copiedIntoProduct: true;
    };
    historicalContent: {
      staysInPkms: true;
      migrates: false;
    };
  };
  pipelineInputs: {
    voiceGuidelines: {
      repoPath: string;
      required: true;
    };
  };
  sourceAccess: {
    pkms: {
      mode: 'mcp-only';
      disallowDirectVaultReads: true;
      requiredTools: string[];
    };
  };
  workRunPayload: {
    product: 'writing';
    projectSlug: string;
    target: { kind: 'writing-page'; slug: string };
  };
  surfaceStates: WritingProductSurfaceState[];
}

export interface StartedWritingProductRun extends WritingProductRunPlan {
  branchStatus: 'created' | 'resumed';
  publish: {
    mode: 'branch-commit';
    externalDeployment: false;
    commitSha: string;
  };
}

export const WRITING_PRODUCT_SURFACE_STATES: WritingProductSurfaceState[] = [
  'researching',
  'drafting',
  'critiquing',
  'revising',
  'ready-for-review',
  'committed',
  'failed',
];

const WRITING_VOICE_GUIDELINES_REPO_PATH = 'docs/rune/writing-voice.md';

export type StartWritingProductRunInput =
  | {
    command: 'blog';
    chatId: number;
    topic: string;
    sender: unknown;
  }
  | {
    command: 'writing-critique';
    chatId: number;
    target: string;
    outputPath: string;
    revisionRequested?: boolean;
    sender: unknown;
  };

export interface StartWritingProductRunDeps {
  createWritingWorktree: (input: {
    product: 'writing';
    project: string;
    branch: string;
  }) => Promise<{ worktree: string; resumed?: boolean }>;
  runWritingPipeline: (input: {
    topic: string;
    requestedBy: 'blog' | 'writing-critique';
    branch: string;
    worktree: string;
    critiqueOutputPath?: string;
    revisionRequested?: boolean;
  }) => Promise<{
    state: string;
    committed?: boolean;
    commitSha?: string;
    branch: string;
  }>;
  deployExternal?: (input: { branch: string; routePath: string }) => Promise<void>;
}

export function slugifyWritingIdentifier(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new Error('planWritingProductRun: topic must include at least one alphanumeric character');
  }
  return slug;
}

export function writingTargetSlugSource(target: string): string {
  const trimmed = target.trim();
  const basename = trimmed.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? trimmed;
  const withoutExtension = basename.replace(/\.[a-z0-9]+$/i, '');
  return withoutExtension.trim() || trimmed;
}

export function planWritingProductRun(input: { topic: string }): WritingProductRunPlan {
  const topic = input.topic.trim();
  const slug = slugifyWritingIdentifier(topic);
  return {
    product: 'writing',
    topic,
    slug,
    branch: writingBranchName(slug),
    routePaths: ['/rune', `/rune/${slug}`],
    migration: {
      ideas: {
        sourceVaultPath: 'writing/topics.md',
        destinationRepoPath: 'docs/rune/writing-ideas.md',
      },
      voice: {
        sourceVaultPath: 'writing/voice.md',
        access: 'mcp',
        destinationRepoPath: WRITING_VOICE_GUIDELINES_REPO_PATH,
        copiedIntoProduct: true,
      },
      historicalContent: {
        staysInPkms: true,
        migrates: false,
      },
    },
    pipelineInputs: {
      voiceGuidelines: {
        repoPath: WRITING_VOICE_GUIDELINES_REPO_PATH,
        required: true,
      },
    },
    sourceAccess: {
      pkms: {
        mode: 'mcp-only',
        disallowDirectVaultReads: true,
        requiredTools: [
          'vault_search',
          'journal_range',
          'follow_wikilinks',
        ],
      },
    },
    workRunPayload: {
      product: 'writing',
      projectSlug: slug,
      target: { kind: 'writing-page', slug },
    },
    surfaceStates: [...WRITING_PRODUCT_SURFACE_STATES],
  };
}

export async function startWritingProductRun(input: StartWritingProductRunInput): Promise<WritingProductRunPlan>;
export async function startWritingProductRun(
  input: StartWritingProductRunInput,
  deps: StartWritingProductRunDeps,
): Promise<StartedWritingProductRun>;
export async function startWritingProductRun(
  input: StartWritingProductRunInput,
  deps?: StartWritingProductRunDeps,
): Promise<WritingProductRunPlan | StartedWritingProductRun> {
  const planTopic = input.command === 'blog' ? input.topic : writingTargetSlugSource(input.target);
  const pipelineTopic = input.command === 'blog' ? input.topic : input.target;
  const plan = planWritingProductRun({ topic: planTopic });
  if (!deps) {
    return plan;
  }

  const worktree = await deps.createWritingWorktree({
    product: 'writing',
    project: plan.slug,
    branch: plan.branch,
  });
  const pipelineResult = await deps.runWritingPipeline({
    topic: pipelineTopic,
    requestedBy: input.command,
    branch: plan.branch,
    worktree: worktree.worktree,
    ...(input.command === 'writing-critique'
      ? {
        critiqueOutputPath: input.outputPath,
        revisionRequested: input.revisionRequested ?? false,
      }
      : {}),
  });

  if (pipelineResult.branch !== plan.branch) {
    throw new Error(
      `startWritingProductRun: pipeline returned branch ${pipelineResult.branch}, expected ${plan.branch}`,
    );
  }
  if (pipelineResult.state !== 'committed' && pipelineResult.committed !== true) {
    throw new Error(`startWritingProductRun: writing pipeline did not commit ${plan.branch}`);
  }
  if (!pipelineResult.commitSha) {
    throw new Error(`startWritingProductRun: writing pipeline committed ${plan.branch} without a commit sha`);
  }

  return {
    ...plan,
    branchStatus: worktree.resumed ? 'resumed' : 'created',
    publish: {
      mode: 'branch-commit',
      externalDeployment: false,
      commitSha: pipelineResult.commitSha,
    },
  };
}
