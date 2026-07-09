import type { ClientViewRouter } from './view-router.js';

export type HomeViewData = Record<string, unknown>;
export type HomeViewRenderOptions = {
  operations?: Record<string, unknown> | null;
  unreadProducts?: Set<string> | string[];
};

export interface HomeViewController {
  load(): Promise<HomeViewData>;
  render(pulse: HomeViewData | null, opts?: HomeViewRenderOptions): void;
  close(): void;
}

export function renderHomeView(
  pulse: HomeViewData | null,
  options?: HomeViewRenderOptions,
): string;

export function createHomeView(opts: {
  root: HTMLElement;
  fetchJson?: (url: string) => Promise<unknown>;
  postJson?: (url: string, body?: unknown) => Promise<unknown>;
  router?: Partial<ClientViewRouter>;
}): HomeViewController;
