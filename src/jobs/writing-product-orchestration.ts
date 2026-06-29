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
    sender: unknown;
  };

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

export function planWritingProductRun(input: { topic: string }): WritingProductRunPlan {
  const topic = input.topic.trim();
  const slug = slugifyWritingIdentifier(topic);
  return {
    product: 'writing',
    topic,
    slug,
    branch: `rune-writing/${slug}`,
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

export async function startWritingProductRun(input: StartWritingProductRunInput): Promise<WritingProductRunPlan> {
  const topic = input.command === 'blog' ? input.topic : input.target;
  return planWritingProductRun({ topic });
}
