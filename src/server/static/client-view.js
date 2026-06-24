import { createHomeView } from './home-view.js';
import { createProductDeepView } from './product-deep-view.js';
import { createClientViewRouter } from './view-router.js';

function fetchJson(url) {
  return fetch(url).then(response => {
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
  });
}

function setRouteDataset(route) {
  document.body.dataset.view = route.view;
  if (route.view === 'product') {
    document.body.dataset.product = route.product;
    if (route.focusRunId) document.body.dataset.focusRunId = route.focusRunId;
    else delete document.body.dataset.focusRunId;
  } else {
    delete document.body.dataset.product;
    delete document.body.dataset.focusRunId;
  }
}

function createHomeRoot() {
  const main = document.getElementById('main');
  if (!main) return null;
  let root = document.getElementById('home-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'home-root';
    main.prepend(root);
  }
  return root;
}

function createProductRoot() {
  const main = document.getElementById('main');
  if (!main) return null;
  let root = document.getElementById('product-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'product-root';
    main.prepend(root);
  }
  return root;
}

const homeRoot = createHomeRoot();
const productRoot = createProductRoot();
let homeLoaded = false;
let home = null;
let productView = null;
let loadedProductRoute = '';

const router = createClientViewRouter({
  window,
  onChange(route) {
    setRouteDataset(route);
    if (route.view === 'home' && homeRoot && !homeLoaded) {
      homeLoaded = true;
      home.load().catch(error => {
        home.render({
          available: false,
          products: [],
          unavailableReason: error?.message || 'could not load home pulse',
        });
      });
    }
    if (route.view === 'home') {
      productView?.close?.();
      productView = null;
      loadedProductRoute = '';
    }
    if (route.view === 'product' && productRoot) {
      const routeKey = `${route.product || ''}:${route.focusRunId || ''}`;
      if (loadedProductRoute === routeKey) return;
      loadedProductRoute = routeKey;
      productView?.close?.();
      productView = createProductDeepView({
        root: productRoot,
        product: route.product,
        focusRunId: route.focusRunId,
        fetchJson,
        loadOperations: true,
      });
      productView.load().catch(error => {
        productView.render({
          name: route.product,
          repoBacked: false,
          limitedReason: error?.message || 'could not load product',
          projects: [],
          backlog: { bugs: [], ideas: [], warnings: [] },
          runs: [],
        });
      });
    }
  },
});

home = homeRoot
  ? createHomeView({ root: homeRoot, fetchJson, router })
  : null;

setRouteDataset(router.getState());
if (router.getState().view === 'home' && home) {
  homeLoaded = true;
  home.load().catch(error => {
    home.render({
      available: false,
      products: [],
      unavailableReason: error?.message || 'could not load home pulse',
    });
  });
}
if (router.getState().view === 'product' && productRoot) {
  router.replace(router.getState());
}

window.jarvisClientRouter = router;
