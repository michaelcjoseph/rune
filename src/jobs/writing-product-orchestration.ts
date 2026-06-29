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

function slugifyTopic(topic: string): string {
  const slug = topic
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
  const slug = slugifyTopic(topic);
  return {
    product: 'writing',
    topic,
    slug,
    branch: `rune-writing/${slug}`,
    routePaths: ['/rune', `/rune/${slug}`],
    workRunPayload: {
      product: 'writing',
      projectSlug: slug,
      target: { kind: 'writing-page', slug },
    },
    surfaceStates: [...WRITING_PRODUCT_SURFACE_STATES],
  };
}
