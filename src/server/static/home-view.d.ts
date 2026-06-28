import type { ClientViewRouter } from './view-router.js';

export type HomeViewData = Record<string, unknown>;

export interface HomeViewController {
  load(): Promise<HomeViewData>;
  render(pulse: HomeViewData | null, opts?: { operations?: Record<string, unknown> | null }): void;
  close(): void;
}

export function renderHomeView(
  pulse: HomeViewData | null,
  options?: { operations?: Record<string, unknown> | null },
): string;

export function createHomeView(opts: {
  root: HTMLElement;
  fetchJson?: (url: string) => Promise<unknown>;
  postJson?: (url: string, body?: unknown) => Promise<unknown>;
  router?: Partial<ClientViewRouter>;
}): HomeViewController;
