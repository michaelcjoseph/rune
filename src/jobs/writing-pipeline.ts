import {
  slugifyWritingIdentifier,
  WRITING_PRODUCT_SURFACE_STATES,
  type WritingProductSurfaceState,
} from './writing-product-orchestration.js';

export type WritingPipelineState = WritingProductSurfaceState;

export const WRITING_PIPELINE_STATES: readonly WritingPipelineState[] = [
  ...WRITING_PRODUCT_SURFACE_STATES,
];

export interface WritingPipelineEvent {
  state: WritingPipelineState;
  product: 'writing';
  target: { kind: 'writing-page'; slug: string };
  branch: string;
}

export interface WritingPipelineResult {
  product: 'writing';
  slug: string;
  branch: string;
  routePath: string;
  state: WritingPipelineState;
  committed?: boolean;
  failed?: boolean;
}

export interface WritingPipelineDeps {
  mcp: {
    callTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  model: {
    plan: (input: Record<string, unknown>) => Promise<{ outline: string }>;
    draft: (input: Record<string, unknown>) => Promise<{ markdown: string }>;
    critique: (input: Record<string, unknown>) => Promise<{ notes: string }>;
    revise: (input: Record<string, unknown>) => Promise<{ markdown: string }>;
  };
  writeArtifact: (path: string, content: string) => Promise<void>;
  commitArtifact: (input: {
    branch: string;
    paths: string[];
    message: string;
  }) => Promise<{ sha: string }>;
  emitRunState: (event: WritingPipelineEvent) => void;
}

export interface RunWritingPipelineInput {
  topic: string;
  requestedBy: 'blog' | 'writing-critique';
}

type WritingPipelineTarget = {
  slug: string;
  branch: string;
  routePath: string;
  artifactPath: string;
};

function targetForTopic(topic: string): WritingPipelineTarget {
  const slug = slugifyWritingIdentifier(topic);
  return {
    slug,
    branch: `rune-writing/${slug}`,
    routePath: `/rune/${slug}`,
    artifactPath: `docs/rune/${slug}.md`,
  };
}

function sanitizePublicMarkdown(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => !line.includes('ZZ_PRIVATE_MARKER_DO_NOT_PUBLISH'))
    .join('\n')
    .trimEnd() + '\n';
}

export async function runWritingPipeline(
  input: RunWritingPipelineInput,
  deps: WritingPipelineDeps,
): Promise<WritingPipelineResult> {
  const target = targetForTopic(input.topic);
  const eventBase = {
    product: 'writing' as const,
    target: { kind: 'writing-page' as const, slug: target.slug },
    branch: target.branch,
  };
  const emit = (state: WritingPipelineState) => deps.emitRunState({ ...eventBase, state });
  const resultBase = {
    product: 'writing' as const,
    slug: target.slug,
    branch: target.branch,
    routePath: target.routePath,
  };

  try {
    emit('researching');
    const research = {
      vaultSearch: await deps.mcp.callTool('vault_search', {
        query: input.topic,
        maxResults: 12,
      }),
      journalRange: await deps.mcp.callTool('journal_range', {
        query: input.topic,
        maxDays: 31,
      }),
      wikilinks: await deps.mcp.callTool('follow_wikilinks', {
        query: input.topic,
        maxDepth: 2,
      }),
    };

    emit('drafting');
    const plan = await deps.model.plan({
      topic: input.topic,
      requestedBy: input.requestedBy,
      research,
      routePath: target.routePath,
    });
    const draft = await deps.model.draft({
      topic: input.topic,
      outline: plan.outline,
      research,
      routePath: target.routePath,
    });

    emit('critiquing');
    const critique = await deps.model.critique({
      topic: input.topic,
      outline: plan.outline,
      markdown: draft.markdown,
      routePath: target.routePath,
    });

    emit('revising');
    const revision = await deps.model.revise({
      topic: input.topic,
      outline: plan.outline,
      markdown: draft.markdown,
      critique: critique.notes,
      routePath: target.routePath,
    });
    const publicMarkdown = sanitizePublicMarkdown(revision.markdown);
    await deps.writeArtifact(target.artifactPath, publicMarkdown);

    emit('ready-for-review');
    await deps.commitArtifact({
      branch: target.branch,
      paths: [target.artifactPath],
      message: `Publish writing page: ${input.topic.trim()}`,
    });

    emit('committed');
    return { ...resultBase, state: 'committed', committed: true };
  } catch {
    emit('failed');
    return { ...resultBase, state: 'failed', failed: true };
  }
}
