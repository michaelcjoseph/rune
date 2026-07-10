import {
  slugifyWritingIdentifier,
  WRITING_PRODUCT_SURFACE_STATES,
  type WritingProductSurfaceState,
} from './writing-product-orchestration.js';
import { writingBranchName } from '../intent/sandbox.js';

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
  commitSha?: string;
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
  /** Read an existing artifact from the run's worktree — the critique/revise
   *  input. Optional: only critique mode requires it (critique targets an
   *  EXISTING draft; its absence there fails the run honestly rather than
   *  silently drafting). Worktree-scoped, NOT a pkms read — the vault stays
   *  MCP-only. */
  readArtifact?: (path: string) => Promise<string>;
}

export interface RunWritingPipelineInput {
  topic: string;
  requestedBy: 'blog' | 'writing-critique';
  /** Critique mode (project-19 spec §W4): judge the existing draft instead of
   *  authoring one. `slug` is PRE-DERIVED by the caller (basename → slugify) —
   *  the raw critique target is often path-shaped, and slugifying it here
   *  would fork a second branch name away from the draft's. Notes land at
   *  `outputPath`; `revisionRequested` additionally revises the draft, with
   *  both files committed together on the draft's own branch. */
  critique?: { slug: string; outputPath: string; revisionRequested: boolean };
}

type WritingPipelineTarget = {
  slug: string;
  branch: string;
  routePath: string;
  artifactPath: string;
};

type WritingPipelineResearch = {
  vaultSearch: unknown;
  journalRange: unknown;
  wikilinks: unknown;
};

function targetForTopic(topic: string, slugOverride?: string): WritingPipelineTarget {
  const slug = slugOverride ?? slugifyWritingIdentifier(topic);
  return {
    slug,
    branch: writingBranchName(slug),
    routePath: `/rune/${slug}`,
    artifactPath: `docs/rune/${slug}.md`,
  };
}

function objectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function collectSourceTexts(source: unknown): string[] {
  const texts: string[] = [];
  const seenObjects = new WeakSet<object>();

  const collect = (value: unknown) => {
    if (typeof value === 'string') {
      texts.push(value);
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          collect(JSON.parse(trimmed));
        } catch {
          // Plain text MCP results are expected; only parse JSON-shaped payloads.
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item);
      }
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    if (seenObjects.has(value)) {
      return;
    }
    seenObjects.add(value);

    const content = objectValue(value, 'content') ?? objectValue(value, 'text') ?? objectValue(value, 'excerpt');
    if (typeof content === 'string' || Array.isArray(content)) {
      collect(content);
    }
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collect(nested);
    }
  };

  collect(source);
  return texts;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function collectPrivateSourceBoundaries(research: WritingPipelineResearch): {
  fragments: Set<string>;
  normalizedFragments: Set<string>;
  tokens: Set<string>;
} {
  const fragments = new Set<string>();
  const normalizedFragments = new Set<string>();
  const tokens = new Set<string>();

  for (const sourceText of [
    ...collectSourceTexts(research.vaultSearch),
    ...collectSourceTexts(research.journalRange),
    ...collectSourceTexts(research.wikilinks),
  ]) {
    for (const token of sourceText.matchAll(/\b(?:PRIVATE|ZZ)_[A-Z0-9_]+\b/g)) {
      tokens.add(token[0]);
    }

    for (const rawLine of sourceText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length < 8) {
        continue;
      }
      fragments.add(line);
      normalizedFragments.add(normalizedText(line));

      const vaultSearchContent = line.match(/^[^:\n]+:\d+\s+[\u2014-]\s+(.+)$/)?.[1]?.trim();
      if (vaultSearchContent && vaultSearchContent.length >= 8) {
        fragments.add(vaultSearchContent);
        normalizedFragments.add(normalizedText(vaultSearchContent));
      }

      const labeledPrivateValue = line.match(
        /^(?:raw journal excerpt|third-party personal name|private identifier|private name|personal identifier|health-specific detail|psychology-specific detail)\s*:\s*(.+)$/i,
      )?.[1]?.trim();
      if (labeledPrivateValue && labeledPrivateValue.length >= 3) {
        fragments.add(labeledPrivateValue);
        normalizedFragments.add(normalizedText(labeledPrivateValue));
      }
    }
  }

  return { fragments, normalizedFragments, tokens };
}

function sanitizePublicMarkdown(markdown: string, research: WritingPipelineResearch): string {
  const privateSource = collectPrivateSourceBoundaries(research);
  const tokens = [...privateSource.tokens];
  const fragments = [...privateSource.fragments];
  const normalizedFragments = [...privateSource.normalizedFragments];

  return markdown
    .split('\n')
    .filter((line) => {
      if (tokens.some((token) => line.includes(token))) {
        return false;
      }
      if (fragments.some((fragment) => line.includes(fragment))) {
        return false;
      }
      const normalizedLine = normalizedText(line);
      return !normalizedFragments.some((fragment) => normalizedLine.includes(fragment));
    })
    .join('\n')
    .trimEnd() + '\n';
}

export async function runWritingPipeline(
  input: RunWritingPipelineInput,
  deps: WritingPipelineDeps,
): Promise<WritingPipelineResult> {
  const target = targetForTopic(input.topic, input.critique?.slug);
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

    if (input.critique) {
      // Critique mode: judge the EXISTING draft. States are a subsequence of
      // the canonical order — no drafting, revising only when requested.
      if (!deps.readArtifact) {
        throw new Error('critique mode requires a readArtifact dep (critique targets an existing draft)');
      }
      const existing = await deps.readArtifact(target.artifactPath);

      emit('critiquing');
      const critique = await deps.model.critique({
        topic: input.topic,
        requestedBy: input.requestedBy,
        markdown: existing,
        routePath: target.routePath,
      });
      // Critique notes land in the same public repo — sanitize like any artifact.
      await deps.writeArtifact(
        input.critique.outputPath,
        sanitizePublicMarkdown(critique.notes, research),
      );
      const commitPaths = [input.critique.outputPath];

      if (input.critique.revisionRequested) {
        emit('revising');
        const revision = await deps.model.revise({
          topic: input.topic,
          markdown: existing,
          critique: critique.notes,
          routePath: target.routePath,
        });
        await deps.writeArtifact(
          target.artifactPath,
          sanitizePublicMarkdown(revision.markdown, research),
        );
        commitPaths.push(target.artifactPath);
      }

      emit('ready-for-review');
      const commit = await deps.commitArtifact({
        branch: target.branch,
        paths: commitPaths,
        message: `${input.critique.revisionRequested ? 'Revise' : 'Critique'} writing page: ${input.topic.trim()}`,
      });

      emit('committed');
      return { ...resultBase, state: 'committed', committed: true, commitSha: commit.sha };
    }

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
    const publicMarkdown = sanitizePublicMarkdown(revision.markdown, research);
    await deps.writeArtifact(target.artifactPath, publicMarkdown);

    emit('ready-for-review');
    const commit = await deps.commitArtifact({
      branch: target.branch,
      paths: [target.artifactPath],
      message: `Publish writing page: ${input.topic.trim()}`,
    });

    emit('committed');
    return { ...resultBase, state: 'committed', committed: true, commitSha: commit.sha };
  } catch {
    emit('failed');
    return { ...resultBase, state: 'failed', failed: true };
  }
}
