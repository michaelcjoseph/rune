import type { ClientViewRouter } from './view-router.js';
import type {
  LiveRunSnapshot,
  RunFeedEvent,
} from './run-feed-client.js';

export type ProductDeepViewData = Record<string, unknown>;

export interface ProductDeepViewController {
  load(): Promise<ProductDeepViewData>;
  render(view?: ProductDeepViewData | null, opts?: Record<string, unknown>): void;
  reload(): Promise<ProductDeepViewData>;
  close(): void;
  sendProductMessage(text: string, product?: string): Promise<unknown>;
  focusRun(runId: string): Promise<void>;
}

export function renderProductDeepView(
  view: ProductDeepViewData | null,
  options?: Record<string, unknown>,
): string;

export function __resetProductSessions(): void;

export function initializeProductChatFrameConsumer(
  targetWindow?: Pick<Window, 'addEventListener'>,
): void;

export function createProductDeepView(opts?: {
  root?: HTMLElement;
  product?: string;
  focusRunId?: string;
  fetchJson?: (url: string) => Promise<unknown>;
  postJson?: (url: string, body?: unknown) => Promise<unknown>;
  sendChat?: (input: { product: string; text: string }) => Promise<unknown>;
  createRunFeedSubscription?: (opts: {
    runId: string;
    fetchJson?: (url: string) => Promise<unknown>;
    fetchLive?: (runId: string) => Promise<unknown>;
    onState: (state: unknown) => void;
  }) => {
    connect?: () => Promise<void>;
    applyEvent?: (event: RunFeedEvent) => void;
    close?: () => void;
    reconnect?: () => Promise<void>;
  };
  operations?: Record<string, unknown> | null;
  router?: Partial<ClientViewRouter>;
  loadOperations?: boolean;
}): ProductDeepViewController;
