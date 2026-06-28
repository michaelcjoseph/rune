export type ClientRoute =
  | { view: 'home' }
  | { view: 'product'; product: string; focusRunId?: string };

export interface ClientViewRouter {
  getState(): ClientRoute;
  goHome(): void;
  goProduct(product: string, opts?: { focusRunId?: string }): void;
  replace(route?: ClientRoute): void;
}

export function parseClientRoute(hash: string): ClientRoute;

export function createClientViewRouter(opts?: {
  window?: Window;
  onChange?: (route: ClientRoute) => void;
}): ClientViewRouter;
