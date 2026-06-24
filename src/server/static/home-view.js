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

function renderStatus(status) {
  if (!status) return '<p class="muted">Global status unavailable</p>';
  const pending = status.pendingApprovals || {};
  const pendingCount = Number(pending.intent || 0) + Number(pending.playbook || 0) + Number(pending.proposal || 0);
  const activeOps = Number.isFinite(status.activeOps) ? status.activeOps : list(status.inFlight).length;
  const activeMutations = Number.isFinite(status.activeMutations)
    ? status.activeMutations
    : list(status.mutations?.active).length;
  return `<div class="home-operation-status">` +
    `<div><strong>Global status</strong><span>${status.ready ? 'ready' : 'not ready'}</span></div>` +
    `<div><strong>Active ops</strong><span>${escHtml(activeOps)}</span></div>` +
    `<div><strong>Active mutations</strong><span>${escHtml(activeMutations)}</span></div>` +
    `<div><strong>Pending approvals</strong><span>${escHtml(pendingCount)}</span></div>` +
  `</div>`;
}

function renderApprovalRow(row) {
  const id = row?.id || '';
  if (!id) return '';
  const type = row.type || row.source || '';
  const summary = row.summary || row.label || id;
  const product = row.productProject || '';
  const age = Number.isFinite(row.age) ? fmtElapsed(row.age * 1000) : '';
  return `<article class="home-approval-row" data-approval-id="${attr(id)}">` +
    `<div class="home-approval-copy">` +
      `<strong>${escHtml(summary)}</strong>` +
      `<span>${escHtml([product, type, age].filter(Boolean).join(' - '))}</span>` +
    `</div>` +
    `<div class="home-approval-actions">` +
      `<button type="button" data-approval-id="${attr(id)}" data-approval-action="approve">Approve</button>` +
      `<button type="button" data-approval-id="${attr(id)}" data-approval-action="reject">Reject</button>` +
    `</div>` +
  `</article>`;
}

function renderOperationalRail(operations) {
  if (!operations) return '';
  const approvals = list(operations.approvals).map(renderApprovalRow).filter(Boolean).join('');
  const restart = operations.restartAvailable
    ? `<button type="button" class="home-restart-btn" data-restart-server>Restart server</button>`
    : '';
  return `<aside class="home-operational-rail" data-home-operational-rail>` +
    `<section class="home-operation-panel">${renderStatus(operations.status)}</section>` +
    `<section class="home-operation-panel">` +
      `<div class="home-operation-head"><h3>Pending approvals</h3><span>${escHtml(list(operations.approvals).length)}</span></div>` +
      `${approvals || '<p class="muted">No pending approvals</p>'}` +
    `</section>` +
    (restart ? `<section class="home-operation-panel">${restart}</section>` : '') +
  `</aside>`;
}

function renderHomeViewWithOptions(pulse, options = {}) {
  if (!pulse || pulse.available !== true) {
    const reason = pulse?.unavailableReason || 'Home pulse unavailable';
    return `<section class="home-unavailable">` +
      `<h2>Home unavailable</h2>` +
      `<p>${escHtml(reason)}</p>` +
    `</section>`;
  }

  const products = Array.isArray(pulse.products) ? pulse.products : [];
  if (products.length === 0) {
    return `<section class="home-view"><h2>Home</h2><p class="muted">No products registered</p>${renderOperationalRail(options.operations)}</section>`;
  }

  return `<section class="home-view">` +
    `<div class="home-header"><h2>Home</h2><span>${escHtml(fmtCount(products.length, 'product', 'products'))}</span></div>` +
    `<div class="home-layout">` +
      `<div class="home-products">${products.map(renderProductCard).join('')}</div>` +
      `${renderOperationalRail(options.operations)}` +
    `</div>` +
  `</section>`;
}

export function renderHomeView(pulse, options = {}) {
  return renderHomeViewWithOptions(pulse, options);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function attr(value) {
  return escHtml(value);
}

function defaultPostJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(response => {
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json().catch(() => ({}));
  });
}

function isProductionSurface() {
  if (typeof document === 'undefined') return false;
  return document.querySelector?.('meta[name="is-production"]')?.content === 'true';
}

export function createHomeView({ root, fetchJson, postJson, router }) {
  if (!root) throw new Error('createHomeView requires a root');
  const loadJson = fetchJson || (url => fetch(url).then(r => r.json()));
  const post = postJson || defaultPostJson;
  let currentPulse = null;
  let operations = null;

  function render() {
    root.innerHTML = renderHomeView(currentPulse, { operations });
  }

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

    const approval = event.target?.closest?.('[data-approval-action]');
    if (approval) {
      event.preventDefault?.();
      const id = approval.dataset?.approvalId;
      const action = approval.dataset?.approvalAction;
      if (!id || !action || approval.disabled) return;
      approval.disabled = true;
      post(`/api/approvals/${encodeURIComponent(id)}/${encodeURIComponent(action)}`)
        .catch(() => { approval.disabled = false; });
      return;
    }

    const restart = event.target?.closest?.('[data-restart-server]');
    if (restart) {
      event.preventDefault?.();
      if (restart.disabled) return;
      restart.disabled = true;
      post('/api/server/restart').catch(() => { restart.disabled = false; });
    }
  });

  return {
    async load() {
      currentPulse = await loadJson('/api/home');
      const [status, approvals] = await Promise.all([
        loadJson('/api/state').catch(() => null),
        loadJson('/api/approvals').catch(() => []),
      ]);
      operations = {
        status,
        approvals: list(approvals),
        restartAvailable: Boolean(status?.restartAvailable || isProductionSurface()),
      };
      render();
      return currentPulse;
    },
    render(pulse, opts = {}) {
      currentPulse = pulse;
      operations = opts.operations || operations;
      render();
    },
  };
}
