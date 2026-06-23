import { createRunFeedSubscription as defaultCreateRunFeedSubscription } from './run-feed-client.js';

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attr(value) {
  return escHtml(value);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function fmtElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function fmtTarget(target) {
  if (!target?.slug) return 'target';
  return `${target.kind || 'target'} ${target.slug}`;
}

function fmtProgress(progress) {
  const done = Number.isFinite(progress?.done) ? progress.done : 0;
  const total = Number.isFinite(progress?.total) ? progress.total : 0;
  return `${done}/${total}`;
}

function actionLabel(action, fallback) {
  if (!action) return fallback;
  if (action.state === 'gating') return `${fallback} scoping`;
  if (action.state === 'declined') return `${fallback} declined`;
  if (action.state === 'handoff-failed') return `${fallback} handoff failed`;
  if (action.state === 'proceeding') return `${fallback} running`;
  if (action.state === 'disabled') return fallback;
  return fallback;
}

function renderActionButton(action, itemId, kind, extra = '') {
  if (!action) return '';
  const state = action.state || 'available';
  const disabled = state !== 'available';
  const label = actionLabel(action, kind === 'fix' ? 'Fix' : 'Plan');
  const dataName = kind === 'fix' ? 'data-fix-item-id' : 'data-plan-item-id';
  const busy = state === 'gating' ? ' aria-busy="true"' : '';
  return `<button type="button" class="deep-action deep-action--${attr(kind)} deep-action--${attr(state)}" ` +
    `${dataName}="${attr(itemId)}" data-action-state="${attr(state)}"${disabled ? ' disabled' : ''}${busy}>` +
      `${escHtml(label)}${extra}` +
    `</button>`;
}

function renderActionMeta(action) {
  if (!action) return '';
  const bits = [];
  if (action.state && action.state !== 'available') bits.push(action.state);
  if (action.reason) bits.push(action.reason);
  if (action.runId) bits.push(action.runId);
  if (action.attemptId) bits.push(action.attemptId);
  if (bits.length === 0) return '';
  return `<span class="deep-action-meta">${escHtml(bits.join(' - '))}</span>`;
}

function renderProjects(projects) {
  const rows = list(projects).map(project => {
    const progress = fmtProgress(project.taskProgress);
    const percent = project.taskProgress?.total > 0
      ? Math.min(100, Math.max(0, Math.round((project.taskProgress.done / project.taskProgress.total) * 100)))
      : 0;
    return `<article class="deep-project" data-project-slug="${attr(project.slug)}">` +
      `<div class="deep-row-head">` +
        `<strong>${escHtml(project.slug)}</strong>` +
        `<span class="status-pill ${project.lifecycle === 'done' ? 'pill-done' : 'pill-inprogress'}">${escHtml(project.lifecycle)}</span>` +
      `</div>` +
      `<div class="deep-progress" aria-label="${attr(progress)} tasks">` +
        `<div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${percent}%"></div></div>` +
        `<span class="progress-text">${escHtml(progress)}</span>` +
      `</div>` +
    `</article>`;
  }).join('');
  return `<section class="deep-panel deep-panel--projects" data-surface="projects">` +
    `<div class="deep-panel-head"><h3>Projects</h3><span>${list(projects).length}</span></div>` +
    (rows || '<p class="muted">No projects</p>') +
  `</section>`;
}

function renderBacklogItem(item, kind) {
  const fix = kind === 'bugs' ? renderActionButton(item.fix, item.id, 'fix') : '';
  const fixMeta = kind === 'bugs' ? renderActionMeta(item.fix) : '';
  return `<article class="deep-backlog-item deep-backlog-item--${attr(kind)}" data-backlog-item-id="${attr(item.id)}">` +
    `<div class="deep-row-head">` +
      `<strong>${escHtml(item.id)}</strong>` +
      `<span>${escHtml(item.status || 'open')}</span>` +
    `</div>` +
    `<h4>${escHtml(item.title || item.raw || item.id)}</h4>` +
    (item.body ? `<p>${escHtml(item.body)}</p>` : '') +
    `<div class="deep-actions">` +
      `${renderActionButton(item.plan, item.id, 'plan')}` +
      `${fix}` +
      `${renderActionMeta(item.plan)}` +
      `${fixMeta}` +
    `</div>` +
  `</article>`;
}

function renderBacklog(backlog) {
  const warnings = list(backlog?.warnings).map(warning =>
    `<li>line ${escHtml(warning.line)} - ${escHtml(warning.message)}</li>`
  ).join('');
  return `<section class="deep-panel deep-panel--backlog" data-surface="backlog">` +
    `<div class="deep-panel-head"><h3>Backlog</h3><span>Bugs / Ideas</span></div>` +
    `<div class="deep-backlog-columns">` +
      `<div class="deep-backlog-column" data-backlog-kind="bugs"><h4>Bugs</h4>${list(backlog?.bugs).map(item => renderBacklogItem(item, 'bugs')).join('') || '<p class="muted">No bugs</p>'}</div>` +
      `<div class="deep-backlog-column" data-backlog-kind="ideas"><h4>Ideas</h4>${list(backlog?.ideas).map(item => renderBacklogItem(item, 'ideas')).join('') || '<p class="muted">No ideas</p>'}</div>` +
    `</div>` +
    (warnings ? `<div class="deep-warnings"><strong>Warnings</strong><ul>${warnings}</ul></div>` : '') +
  `</section>`;
}

function renderAgents(agents) {
  const rows = list(agents).map(agent =>
    `<li class="${agent.active ? 'active' : ''}">` +
      `<span>${escHtml(agent.role)}</span>` +
      `<span>${agent.model ? `${escHtml(agent.model)} - ` : ''}${agent.active ? 'active' : 'idle'}</span>` +
    `</li>`
  ).join('');
  return rows ? `<ul class="deep-agents">${rows}</ul>` : '<p class="muted">No agents reported</p>';
}

function renderLogs(lines) {
  const rows = list(lines).map(line => `<li>${escHtml(line)}</li>`).join('');
  return rows ? `<ol class="deep-run-logs">${rows}</ol>` : '<p class="muted">No live logs yet</p>';
}

function renderActiveRun(activeRun, liveRuns = {}) {
  if (!activeRun?.runId) return '<div class="deep-live-run muted">No active run</div>';
  const live = liveRuns[activeRun.runId] || {};
  const tasks = live.tasks || activeRun.tasks;
  const agents = live.agents || activeRun.agents;
  const elapsedMs = live.elapsedMs ?? activeRun.elapsedMs;
  const state = live.state || activeRun.state;
  const outcome = live.outcome || activeRun.outcome;
  const worktreePath = live.worktreePath || activeRun.worktreePath;
  const transcriptUrl = live.transcriptUrl || activeRun.transcriptUrl;
  const target = live.target || activeRun.target;
  return `<article class="deep-live-run" data-run-id="${attr(activeRun.runId)}">` +
    `<div class="deep-row-head">` +
      `<strong>${escHtml(activeRun.runId)}</strong>` +
      `<span class="status-pill pill-inprogress">${escHtml(state)}</span>` +
    `</div>` +
    `<div class="deep-run-meta">` +
      `<span>${escHtml(fmtTarget(target))}</span>` +
      `<span>${escHtml(fmtProgress(tasks))} tasks</span>` +
      `<span>${escHtml(fmtElapsed(elapsedMs))}</span>` +
      (outcome ? `<span>outcome ${escHtml(outcome)}</span>` : '') +
    `</div>` +
    `<code class="deep-worktree">${escHtml(worktreePath)}</code>` +
    `<div class="deep-live-grid">` +
      `<div><h4>Agent activity</h4>${renderAgents(agents)}</div>` +
      `<div><h4>Logs</h4>${renderLogs(live.lastLogLines)}</div>` +
    `</div>` +
    (transcriptUrl ? `<a class="workrun-transcript" href="${attr(transcriptUrl)}">Transcript</a>` : '') +
  `</article>`;
}

function renderRuns(view, liveRuns = {}) {
  const history = list(view.runs).map(run =>
    `<article class="deep-run-row" data-run-id="${attr(run.runId)}">` +
      `<div class="deep-row-head">` +
        `<strong>${escHtml(run.runId)}</strong>` +
        `<span>${escHtml(run.outcome)}</span>` +
      `</div>` +
      `<div class="deep-run-meta">` +
        `<span>${escHtml(fmtTarget(run.target))}</span>` +
        `<time>${escHtml(run.endedAt)}</time>` +
      `</div>` +
      (run.transcriptUrl ? `<a class="workrun-transcript" href="${attr(run.transcriptUrl)}">Transcript</a>` : '') +
    `</article>`
  ).join('');
  return `<section class="deep-panel deep-panel--runs" data-surface="runs">` +
    `<div class="deep-panel-head"><h3>Runs</h3><span>${list(view.runs).length}</span></div>` +
    renderActiveRun(view.activeRun, liveRuns) +
    `<div class="deep-run-history">${history || '<p class="muted">No recent runs</p>'}</div>` +
  `</section>`;
}

function renderOperations(operations) {
  if (!operations) return '';
  const approvals = list(operations.pendingApprovals).map(approval =>
    `<article class="deep-op-row">` +
      `<span>${escHtml(approval.label || approval.kind || approval.id)}</span>` +
      `<span>${escHtml(approval.kind || '')}</span>` +
      `<button type="button" data-approval-id="${attr(approval.id)}" data-approval-action="approve">Approve</button>` +
      `<button type="button" data-approval-id="${attr(approval.id)}" data-approval-action="reject">Reject</button>` +
    `</article>`
  ).join('');
  const ops = list(operations.inFlightOps).map(op =>
    `<article class="deep-op-row"><span>${escHtml(op.opId)}</span><span>${escHtml(op.label || 'op')}</span><button type="button" data-cancel-op-id="${attr(op.opId)}">Cancel</button></article>`
  ).join('');
  const mutations = list(operations.mutations).map(mutation =>
    `<article class="deep-op-row"><span>${escHtml(mutation.id)}</span><span>${escHtml(mutation.kind || mutation.status || 'mutation')}</span><button type="button" data-cancel-mutation-id="${attr(mutation.id)}">Cancel</button></article>`
  ).join('');
  const planning = operations.planning
    ? `<p>Planning ${escHtml(operations.planning.product || '')} ${escHtml(operations.planning.status || '')}</p>`
    : '<p class="muted">No active planning</p>';
  return `<section class="deep-panel deep-panel--operations" data-surface="operations">` +
    `<div class="deep-panel-head"><h3>Operations</h3><span>controls</span></div>` +
    `<h4>Pending approvals</h4>${approvals || '<p class="muted">No pending approvals</p>'}` +
    `<h4>Active ops</h4>${ops || '<p class="muted">No active ops</p>'}` +
    `<h4>Work runs</h4>${mutations || '<p class="muted">No active mutations</p>'}` +
    `<h4>Planning</h4>${planning}` +
    (operations.restartAvailable ? '<button type="button" data-restart-server>Restart server</button>' : '') +
  `</section>`;
}

function renderChat(view) {
  return `<section class="deep-panel deep-panel--chat chat-panel--secondary" data-surface="chat" ` +
    `data-panel-priority="secondary" data-chat-scope="product" data-search-scope="repo+vault" aria-label="product chat">` +
    `<div class="deep-panel-head"><h3>Chat</h3><span>${escHtml(view.name)}</span></div>` +
    `<p class="muted">Product repo + vault scope. KB research opens in Claude App.</p>` +
    `<a href="app://claude" data-app-deeplink>Open Claude App</a>` +
    `<form data-product-chat-form data-product="${attr(view.name)}">` +
      `<textarea name="message" rows="3" placeholder="Message ${attr(view.name)}..."></textarea>` +
      `<button type="submit">Send</button>` +
    `</form>` +
  `</section>`;
}

export function renderProductDeepView(view, options = {}) {
  if (!view) {
    return '<section class="product-deep-view product-deep-view--unavailable"><h2>Product unavailable</h2></section>';
  }

  if (view.repoBacked === false) {
    return `<section class="product-deep-view product-deep-view--limited" data-product="${attr(view.name)}">` +
      `<header class="deep-header"><h2>${escHtml(view.name)}</h2><span>limited - not repo-backed</span></header>` +
      `<p>${escHtml(view.limitedReason || 'Known product is not repo-backed.')}</p>` +
    `</section>`;
  }

  return `<section class="product-deep-view" data-product="${attr(view.name)}">` +
    `<header class="deep-header">` +
      `<h2>${escHtml(view.name)}</h2>` +
      `<nav aria-label="Product surfaces">` +
        `<button type="button" data-surface-jump="projects">Projects</button>` +
        `<button type="button" data-surface-jump="backlog">Backlog</button>` +
        `<button type="button" data-surface-jump="runs">Runs</button>` +
        `<button type="button" data-surface-jump="chat">Chat</button>` +
      `</nav>` +
    `</header>` +
    `<div class="deep-grid">` +
      `${renderProjects(view.projects)}` +
      `${renderBacklog(view.backlog)}` +
      `${renderRuns(view, options.liveRuns || {})}` +
      `${renderChat(view)}` +
      `${renderOperations(options.operations)}` +
    `</div>` +
  `</section>`;
}

function defaultPostJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(response => {
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
  });
}

function defaultSendChat({ product, text }) {
  return defaultPostJson('/api/chat', { product, message: text });
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function createProductDeepView({
  root,
  product,
  focusRunId,
  fetchJson,
  postJson,
  sendChat,
  createRunFeedSubscription = defaultCreateRunFeedSubscription,
  operations,
} = {}) {
  if (!root) throw new Error('createProductDeepView requires a root');
  const loadJson = fetchJson || (url => fetch(url).then(r => r.json()));
  const post = postJson || ((url, body) => defaultPostJson(url, body));
  const send = sendChat || defaultSendChat;
  let current = null;
  let liveRuns = {};
  let subscription = null;

  function render() {
    root.innerHTML = renderProductDeepView(current, { liveRuns, operations });
  }

  async function focusRun(runId) {
    if (!runId) return;
    const snapshot = await loadJson(`/api/work-runs/${encodeURIComponent(runId)}/live`);
    liveRuns = { ...liveRuns, [runId]: snapshot };
    subscription?.close?.();
    subscription = createRunFeedSubscription({
      runId,
      fetchJson: loadJson,
      fetchLive: async () => snapshot,
      onState(state) {
        if (state?.runId) {
          liveRuns = { ...liveRuns, [state.runId]: state };
          render();
        }
      },
    });
    await subscription.connect?.();
  }

  const onClick = async event => {
    const surfaceJump = event.target?.closest?.('[data-surface-jump]');
    if (surfaceJump) {
      event.preventDefault?.();
      const surface = surfaceJump.dataset?.surfaceJump;
      root.querySelector?.(`[data-surface="${surface}"]`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      return;
    }

    const fix = event.target?.closest?.('[data-fix-item-id]');
    if (fix) {
      event.preventDefault?.();
      const itemId = fix.dataset?.fixItemId;
      if (!itemId || fix.disabled) return;
      const result = await post(`/api/backlog/${encodeURIComponent(product)}/items/${encodeURIComponent(itemId)}/fix`);
      current = clone(current);
      for (const item of list(current?.backlog?.bugs)) {
        if (item.id === itemId) {
          item.fix = { kind: 'fix', state: 'gating', attemptId: result?.attemptId };
        }
      }
      render();
    }
  };

  const onSubmit = async event => {
    const form = event.target?.closest?.('[data-product-chat-form]');
    if (!form) return;
    event.preventDefault?.();
    const text = form.elements?.message?.value || '';
    if (!String(text).trim()) return;
    await send({ product: form.dataset?.product || product, text });
    form.reset?.();
  };

  root.addEventListener?.('click', onClick);
  root.addEventListener?.('submit', onSubmit);

  return {
    async load() {
      current = await loadJson(`/api/products/${encodeURIComponent(product)}`);
      render();
      if (focusRunId) {
        await focusRun(focusRunId);
        render();
      }
      return current;
    },
    render(view = current, opts = {}) {
      current = view;
      if (opts.liveRuns) liveRuns = opts.liveRuns;
      root.innerHTML = renderProductDeepView(current, { liveRuns, operations: opts.operations || operations });
    },
    close() {
      subscription?.close?.();
      subscription = null;
      root.removeEventListener?.('click', onClick);
      root.removeEventListener?.('submit', onSubmit);
    },
  };
}
