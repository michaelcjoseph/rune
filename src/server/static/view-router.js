const HOME_ROUTE = { view: 'home' };

function cloneRoute(route) {
  return { ...route };
}

function routeUrl(route) {
  if (!route || route.view !== 'product' || !route.product) return '#/';
  const product = encodeURIComponent(route.product);
  const run = route.focusRunId ? `?run=${encodeURIComponent(route.focusRunId)}` : '';
  return `#/products/${product}${run}`;
}

export function parseClientRoute(hash) {
  const raw = String(hash || '');
  const withoutHash = raw.startsWith('#') ? raw.slice(1) : raw;
  const [pathPart, queryPart = ''] = withoutHash.split('?');
  const path = pathPart || '/';
  const productPrefix = '/products/';

  if (!path.startsWith(productPrefix)) return cloneRoute(HOME_ROUTE);

  const encodedProduct = path.slice(productPrefix.length).split('/')[0];
  if (!encodedProduct) return cloneRoute(HOME_ROUTE);

  let product;
  try {
    product = decodeURIComponent(encodedProduct);
  } catch {
    return cloneRoute(HOME_ROUTE);
  }
  if (!product) return cloneRoute(HOME_ROUTE);

  const params = new URLSearchParams(queryPart);
  const focusRunId = params.get('run') || '';
  const route = { view: 'product', product };
  if (focusRunId) route.focusRunId = focusRunId;
  return route;
}

export function createClientViewRouter({ window, onChange } = {}) {
  const win = window || globalThis.window;
  if (!win) throw new Error('createClientViewRouter requires a window');

  let state = parseClientRoute(win.location?.hash || '');

  function setState(next, opts = {}) {
    state = cloneRoute(next);
    const url = routeUrl(state);
    if (opts.replace) {
      win.history?.replaceState?.(cloneRoute(state), '', url);
    } else if (opts.push !== false) {
      win.history?.pushState?.(cloneRoute(state), '', url);
    }
    if (onChange) onChange(cloneRoute(state));
  }

  function syncFromLocation() {
    const next = parseClientRoute(win.location?.hash || '');
    state = cloneRoute(next);
    if (onChange) onChange(cloneRoute(state));
  }

  win.addEventListener?.('popstate', syncFromLocation);
  win.addEventListener?.('hashchange', syncFromLocation);

  return {
    getState() {
      return cloneRoute(state);
    },
    goHome() {
      setState(HOME_ROUTE);
    },
    goProduct(product, opts = {}) {
      if (!product) {
        setState(HOME_ROUTE);
        return;
      }
      const next = { view: 'product', product: String(product) };
      if (opts.focusRunId) next.focusRunId = String(opts.focusRunId);
      setState(next);
    },
    replace(route) {
      setState(route || HOME_ROUTE, { replace: true });
    },
  };
}

