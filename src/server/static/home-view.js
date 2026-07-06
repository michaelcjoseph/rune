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

function renderMcpMonitoring(product) {
  const mcp = product?.monitoring?.mcp;
  if (!mcp?.status) return '';
  const status = mcp.status === 'ok' ? 'ok' : 'degraded';
  const label = status === 'ok' ? 'MCP daemon ok' : 'MCP daemon degraded';
  const detail = mcp.error || mcp.endpoint || mcp.checkedAt || '';
  return `<div class="home-mcp-status home-mcp-status--${escHtml(status)}" data-mcp-status="${escHtml(status)}">` +
    `<strong>${escHtml(label)}</strong>` +
    (detail ? `<span>${escHtml(detail)}</span>` : '<span>Health check returned no detail</span>') +
  `</div>`;
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
    renderMcpMonitoring(product) +
    outcome +
    (attention
      ? `<div class="home-attention home-attention--urgent" aria-label="attention signals"><strong>Needs attention</strong><ul>${attention}</ul></div>`
      : '<div class="home-attention muted">No attention signals</div>') +
    `<button class="home-open-product" type="button" data-home-open-product ` +
      `data-product="${escHtml(product.name)}">Open project</button>` +
  `</article>`;
}

function productClass(product) {
  return product?.class === 'internal' ? 'internal' : 'external';
}

function renderProductGroup(productGroup, label) {
  const products = productGroup.products.map(renderProductCard).join('');
  return `<section class="home-product-class home-product-class--${attr(productGroup.class)}" ` +
    `data-home-product-class="${attr(productGroup.class)}">` +
      `<div class="home-product-class-head">` +
        `<h3>${escHtml(label)}</h3>` +
        `<span>${escHtml(fmtCount(productGroup.products.length, 'product', 'products'))}</span>` +
      `</div>` +
      `<div class="home-product-class-grid">${products}</div>` +
    `</section>`;
}

function renderProductRoster(products) {
  const groups = {
    internal: [],
    external: [],
  };
  for (const product of products) {
    groups[productClass(product)].push(product);
  }
  return [
    groups.internal.length > 0
      ? renderProductGroup({ class: 'internal', products: groups.internal }, 'Internal')
      : '',
    groups.external.length > 0
      ? renderProductGroup({ class: 'external', products: groups.external }, 'External')
      : '',
  ].join('');
}

function fillBlankBlockClosures(html) {
  let next = String(html || '');
  let previous = '';
  while (next !== previous) {
    previous = next;
    next = next.replace(/>\s*<\/(section|div|article)>/gi, '>&#8203;</$1>');
  }
  return next;
}

function renderStatus(status, approvals) {
  if (!status) return '<p class="muted">Global status unavailable</p>';
  const pending = status.pendingApprovals || {};
  const approvalRows = Array.isArray(approvals) ? approvals : null;
  const pendingCount = approvalRows
    ? approvalRows.length
    : Number(pending.intent || 0) +
      Number(pending.playbook || 0) +
      Number(pending.proposal || 0) +
      Number(pending.blockedOnHuman || pending['blocked-on-human'] || 0);
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
  const error = row.error
    ? `<div class="home-approval-error" role="alert">${escHtml(row.error)}</div>`
    : '';
  return `<article class="home-approval-row" data-approval-id="${attr(id)}">` +
    `<div class="home-approval-copy">` +
      `<strong>${escHtml(summary)}</strong>` +
      `<span>${escHtml([product, type, age].filter(Boolean).join(' - '))}</span>` +
      error +
    `</div>` +
    `<div class="home-approval-actions">` +
      `<button type="button" data-approval-id="${attr(id)}" data-approval-action="approve">Approve</button>` +
      `<button type="button" data-approval-id="${attr(id)}" data-approval-action="reject">Reject</button>` +
    `</div>` +
  `</article>`;
}

function connectionLabel(status) {
  if (status === 'connected') return 'Connected';
  if (status === 'connecting') return 'Connecting';
  return 'Disconnected';
}

function renderConnectionIndicator(status) {
  const normalized = status === 'connected' || status === 'connecting' ? status : 'disconnected';
  return `<span class="home-connection home-connection--${attr(normalized)}" ` +
    `data-home-connection-status="${attr(normalized)}" aria-label="Webview ${attr(connectionLabel(normalized))}">` +
    `<span class="home-connection-dot" aria-hidden="true"></span>` +
    `<span>${escHtml(connectionLabel(normalized))}</span>` +
  `</span>`;
}

function renderOperationalRail(operations) {
  if (!operations) return '';
  const approvals = list(operations.approvals).map(renderApprovalRow).filter(Boolean).join('');
  const connection = renderConnectionIndicator(operations.connectionStatus || 'disconnected');
  const restart = operations.restartAvailable
    ? `<button type="button" class="home-restart-btn" data-restart-server>Restart server</button>`
    : '';
  return `<aside class="home-operational-rail" data-home-operational-rail>` +
    `<section class="home-operation-panel">${renderStatus(operations.status, operations.approvals)}</section>` +
    `<section class="home-operation-panel">` +
      `<div class="home-operation-head"><h3>Pending approvals</h3><span>${escHtml(list(operations.approvals).length)}</span></div>` +
      `${approvals || '<p class="muted">No pending approvals</p>'}` +
    `</section>` +
    `<section class="home-operation-panel home-server-panel">` +
      `<div class="home-server-actions">${connection}${restart}</div>` +
    `</section>` +
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
      `<div class="home-products">${renderProductRoster(products)}</div>` +
      `${renderOperationalRail(options.operations)}` +
    `</div>` +
  `</section>`;
}

export function renderHomeView(pulse, options = {}) {
  return fillBlankBlockClosures(renderHomeViewWithOptions(pulse, options));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function attr(value) {
  return escHtml(value);
}

async function defaultPostJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text().catch(() => '');
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (!response.ok) {
    const message = payload?.error || payload?.message || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function isProductionSurface() {
  if (typeof document === 'undefined') return false;
  return document.querySelector?.('meta[name="is-production"]')?.content === 'true';
}

function currentConnectionStatus() {
  if (typeof window === 'undefined') return 'disconnected';
  return window.runeConnectionStatus || 'disconnected';
}

export function createHomeView({ root, fetchJson, postJson, router }) {
  if (!root) throw new Error('createHomeView requires a root');
  const loadJson = fetchJson || (url => fetch(url).then(r => r.json()));
  const post = postJson || defaultPostJson;
  let currentPulse = null;
  let operations = null;
  let approvalErrors = {};

  function render() {
    root.innerHTML = renderHomeView(currentPulse, { operations });
  }

  function approvalsWithErrors(approvals) {
    return list(approvals).map(row => {
      const error = approvalErrors[row?.id];
      return error ? { ...row, error } : row;
    });
  }

  async function refreshOperations() {
    const [status, approvals] = await Promise.all([
      loadJson('/api/state').catch(() => null),
      loadJson('/api/approvals').catch(() => []),
    ]);
    const ids = new Set(list(approvals).map(row => row?.id).filter(Boolean));
    approvalErrors = Object.fromEntries(
      Object.entries(approvalErrors).filter(([id]) => ids.has(id)),
    );
    operations = {
      ...(operations || {}),
      status,
      approvals: approvalsWithErrors(approvals),
      restartAvailable: Boolean(status?.restartAvailable || operations?.restartAvailable || isProductionSurface()),
      connectionStatus: operations?.connectionStatus || currentConnectionStatus(),
    };
    if (currentPulse) render();
  }

  function approvalFailureMessage(err) {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return 'Approval action failed';
  }

  async function actionApproval(approval) {
    const id = approval.dataset?.approvalId;
    const action = approval.dataset?.approvalAction;
    if (!id || !action || approval.disabled) return;
    approval.disabled = true;
    const previousApprovals = list(operations?.approvals);
    approvalErrors = { ...approvalErrors };
    delete approvalErrors[id];
    operations = {
      ...(operations || {}),
      approvals: previousApprovals.filter(row => row?.id !== id),
    };
    if (currentPulse) render();
    try {
      await post(`/api/approvals/${encodeURIComponent(id)}/${encodeURIComponent(action)}`);
      await refreshOperations();
    } catch (err) {
      approval.disabled = false;
      approvalErrors = {
        ...approvalErrors,
        [id]: approvalFailureMessage(err),
      };
      operations = {
        ...(operations || {}),
        approvals: approvalsWithErrors(previousApprovals),
      };
      if (currentPulse) render();
    }
  }

  const onConnectionStatus = event => {
    operations = {
      ...(operations || {}),
      connectionStatus: event?.detail?.status || currentConnectionStatus(),
    };
    if (currentPulse) render();
  };

  if (typeof window !== 'undefined') {
    window.addEventListener?.('rune-connection-status', onConnectionStatus);
  }

  root.addEventListener?.('click', event => {
    const openProduct = event.target?.closest?.('[data-home-open-product]');
    if (openProduct) {
      event.preventDefault?.();
      const product = openProduct.dataset?.product;
      if (product) router?.goProduct?.(product);
      return;
    }

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
      actionApproval(approval);
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
        approvals: approvalsWithErrors(approvals),
        restartAvailable: Boolean(status?.restartAvailable || isProductionSurface()),
        connectionStatus: currentConnectionStatus(),
      };
      render();
      return currentPulse;
    },
    render(pulse, opts = {}) {
      currentPulse = pulse;
      operations = {
        ...(opts.operations || operations || {}),
        connectionStatus: opts.operations?.connectionStatus || operations?.connectionStatus || currentConnectionStatus(),
      };
      render();
    },
    close() {
      if (typeof window !== 'undefined') {
        window.removeEventListener?.('rune-connection-status', onConnectionStatus);
      }
    },
  };
}
