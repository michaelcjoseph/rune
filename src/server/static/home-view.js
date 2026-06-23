function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtCount(count, singular, plural) {
  const n = Number.isFinite(count) ? count : 0;
  return `${n} ${n === 1 ? singular : plural}`;
}

function fmtElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function fmtTarget(target) {
  if (!target?.slug) return '';
  return `${target.kind || 'target'} ${target.slug}`;
}

function renderAttention(signal) {
  if (!signal || !signal.kind) return '';
  const target = fmtTarget(signal.target);
  const targetLabel = target ? ` - ${target}` : '';
  if (signal.kind === 'parked-run') {
    return `<li class="home-attention-signal home-attention-signal--parked-run home-attention-signal--urgent" ` +
      `data-attention-kind="parked-run">parked run${escHtml(targetLabel)}</li>`;
  }
  if (signal.kind === 'failed-run') {
    return `<li class="home-attention-signal home-attention-signal--failed-run home-attention-signal--urgent" ` +
      `data-attention-kind="failed-run">failed run${escHtml(targetLabel)}</li>`;
  }
  if (signal.kind === 'noop-run') {
    return `<li class="home-attention-signal home-attention-signal--noop-run" ` +
      `data-attention-kind="noop-run">no-op run${escHtml(targetLabel)}</li>`;
  }
  if (signal.kind === 'backlog-warning') {
    return `<li class="home-attention-signal home-attention-signal--backlog-warning" ` +
      `data-attention-kind="backlog-warning">${escHtml(fmtCount(signal.count, 'backlog warning', 'backlog warnings'))}</li>`;
  }
  return '';
}

function renderActiveRun(product) {
  const run = product.activeRun;
  if (!run) return '<div class="home-run muted">No active run</div>';
  const target = fmtTarget(run.target);
  const targetLabel = target ? ` - ${target}` : '';
  const state = escHtml(run.state);
  const runId = escHtml(run.runId);
  const elapsed = escHtml(fmtElapsed(run.elapsedMs));
  const ariaLabel = `${run.state} ${run.runId}${targetLabel ? ` ${targetLabel}` : ''} ${fmtElapsed(run.elapsedMs)}`;
  return `<button class="home-active-run home-active-run--${state}" type="button" data-home-active-run ` +
    `data-run-state="${state}" aria-label="${escHtml(ariaLabel)}" ` +
    `data-product="${escHtml(product.name)}" data-run-id="${escHtml(run.runId)}">` +
      `<span class="home-run-state">${state}</span>` +
      `<span>${runId}</span>` +
      `<span>${elapsed}</span>` +
      `<span>${escHtml(targetLabel)}</span>` +
    `</button>`;
}

function renderProductCard(product) {
  const counts = product.counts || {};
  const warnings = counts.backlogWarnings || 0;
  const attention = (product.attention || []).map(renderAttention).filter(Boolean).join('');
  const outcome = product.mostRecentRun
    ? `<div class="home-outcome">Recent: ${escHtml(product.mostRecentRun.outcome)} - ${escHtml(product.mostRecentRun.runId)}</div>`
    : '<div class="home-outcome muted">No completed runs</div>';
  const repoLabel = product.repoBacked ? 'repo-backed' : 'not repo-backed - tracked';

  return `<article class="home-product-card" data-home-product="${escHtml(product.name)}">` +
    `<div class="home-product-head">` +
      `<h3>${escHtml(product.name)}</h3>` +
      `<span class="home-product-status">${escHtml(repoLabel)}</span>` +
    `</div>` +
    renderActiveRun(product) +
    `<div class="home-counts">` +
      `<span>${escHtml(fmtCount(counts.activeProjects, 'active project', 'active projects'))}</span>` +
      `<span>${escHtml(fmtCount(counts.openBugs, 'open bug', 'open bugs'))}</span>` +
      `<span>${escHtml(fmtCount(counts.openIdeas, 'open idea', 'open ideas'))}</span>` +
      `<span>${escHtml(fmtCount(warnings, 'warning', 'warnings'))}</span>` +
    `</div>` +
    outcome +
    (attention
      ? `<div class="home-attention home-attention--urgent" aria-label="attention signals"><strong>Needs attention</strong><ul>${attention}</ul></div>`
      : '<div class="home-attention muted">No attention signals</div>') +
  `</article>`;
}

export function renderHomeView(pulse) {
  if (!pulse || pulse.available !== true) {
    const reason = pulse?.unavailableReason || 'Home pulse unavailable';
    return `<section class="home-unavailable">` +
      `<h2>Home unavailable</h2>` +
      `<p>${escHtml(reason)}</p>` +
    `</section>`;
  }

  const products = Array.isArray(pulse.products) ? pulse.products : [];
  if (products.length === 0) {
    return `<section class="home-view"><h2>Home</h2><p class="muted">No products registered</p></section>`;
  }

  return `<section class="home-view">` +
    `<div class="home-header"><h2>Home</h2><span>${escHtml(fmtCount(products.length, 'product', 'products'))}</span></div>` +
    `<div class="home-products">${products.map(renderProductCard).join('')}</div>` +
  `</section>`;
}

export function createHomeView({ root, fetchJson, router }) {
  if (!root) throw new Error('createHomeView requires a root');
  const loadJson = fetchJson || (url => fetch(url).then(r => r.json()));

  root.addEventListener?.('click', event => {
    const activeRun = event.target?.closest?.('[data-home-active-run]');
    if (activeRun) {
      const product = activeRun.dataset?.product;
      const runId = activeRun.dataset?.runId;
      if (product) router?.goProduct?.(product, runId ? { focusRunId: runId } : {});
      return;
    }

    const productCard = event.target?.closest?.('[data-home-product]');
    const product = productCard?.dataset?.homeProduct;
    if (product) router?.goProduct?.(product);
  });

  return {
    async load() {
      const pulse = await loadJson('/api/home');
      root.innerHTML = renderHomeView(pulse);
      return pulse;
    },
    render(pulse) {
      root.innerHTML = renderHomeView(pulse);
    },
  };
}
