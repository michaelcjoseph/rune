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

function itemTitle(item) {
  return item?.title || item?.text || item?.raw || item?.id || '';
}

function renderBody(body) {
  if (Array.isArray(body)) return body.filter(Boolean).map(line => `<p>${escHtml(line)}</p>`).join('');
  return body ? `<p>${escHtml(body)}</p>` : '';
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
  const headline = kind === 'fix' ? ' deep-action--headline' : '';
  const primary = kind === 'fix' ? ' data-primary-action="fix" aria-label="Fix headline bug action"' : '';
  return `<button type="button" class="deep-action deep-action--${attr(kind)} deep-action--${attr(state)}${headline}" ` +
    `${dataName}="${attr(itemId)}" data-action-state="${attr(state)}"${primary}${disabled ? ' disabled' : ''}${busy}>` +
      `${escHtml(label)}${extra}` +
    `</button>`;
}

function renderActionMeta(action) {
  if (!action) return '';
  const bits = [];
  if (action.state && action.state !== 'available') bits.push(action.state);
  if (action.reason) bits.push(action.reason);
  if (action.detail) bits.push(action.detail);
  if (action.runId) bits.push(action.runId);
  if (action.attemptId) bits.push(action.attemptId);
  if (bits.length === 0) return '';
  return `<span class="deep-action-meta">${escHtml(bits.join(' - '))}</span>`;
}

function renderFixNotice(action) {
  if (!action || action.state === 'available') return '';
  const bits = [];
  if (action.state) bits.push(action.state);
  if (action.reason) bits.push(action.reason);
  if (action.detail) bits.push(action.detail);
  if (action.runId) bits.push(action.runId);
  if (action.attemptId) bits.push(action.attemptId);
  if (bits.length === 0) return '';
  return `<p class="deep-fix-notice deep-fix-notice--${attr(action.state)}">${escHtml(bits.join(' - '))}</p>`;
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
  const fixNotice = kind === 'bugs' ? renderFixNotice(item.fix) : '';
  return `<article class="deep-backlog-item deep-backlog-item--${attr(kind)}" data-backlog-item-id="${attr(item.id)}">` +
    `<div class="deep-row-head">` +
      `<strong>${escHtml(itemTitle(item))}</strong>` +
      `<span>${escHtml(item.status || 'open')}</span>` +
    `</div>` +
    `<div class="deep-item-id">${escHtml(item.id)}</div>` +
    `${renderBody(item.body)}` +
    `${fixNotice}` +
    `<div class="deep-actions">` +
      `${fix}` +
      `${renderActionButton(item.plan, item.id, 'plan')}` +
      `${renderActionMeta(item.plan)}` +
      `${fixMeta}` +
    `</div>` +
  `</article>`;
}

function renderWarning(warning) {
  const file = warning.file || 'backlog';
  const line = Number.isFinite(warning.lineNumber) && warning.lineNumber > 0
    ? `:${warning.lineNumber}`
    : '';
  const code = warning.code ? ` [${warning.code}]` : '';
  return `<li><span>${escHtml(`${file}${line}${code}`)}</span> - ${escHtml(warning.message || 'warning')}</li>`;
}

function renderBacklogAdd(kind) {
  const singular = kind === 'bugs' ? 'bug' : 'idea';
  return `<form data-backlog-add-form data-kind="${attr(kind)}">` +
    `<input name="text" type="text" placeholder="New ${singular}">` +
    `<button type="submit">Add ${singular}</button>` +
  `</form>`;
}

function renderBacklogKind(backlog, kind) {
  const items = list(backlog?.[kind]);
  const title = kind === 'bugs' ? 'Bugs' : 'Ideas';
  return `<section class="deep-panel deep-panel--backlog deep-panel--${attr(kind)}" data-surface="${attr(kind)}">` +
    `<div class="deep-panel-head"><h3>${title}</h3><span>${items.length}</span></div>` +
    `<div class="deep-backlog-add deep-backlog-add--single">${renderBacklogAdd(kind)}</div>` +
    `<div class="deep-backlog-list" data-backlog-kind="${attr(kind)}">` +
      `${items.map(item => renderBacklogItem(item, kind)).join('') || `<p class="muted">No ${title.toLowerCase()}</p>`}` +
    `</div>` +
  `</section>`;
}

function renderWorkTabs(view, activeTab = 'projects') {
  const tabs = [
    { id: 'projects', label: 'Projects', count: list(view.projects).length },
    { id: 'bugs', label: 'Bugs', count: list(view.backlog?.bugs).length },
    { id: 'ideas', label: 'Ideas', count: list(view.backlog?.ideas).length },
  ];
  const warnings = list(view.backlog?.warnings).map(renderWarning).join('');
  const panel = (id, html) =>
    `<div class="deep-tab-panel ${activeTab === id ? 'is-active' : ''}" data-work-tab-panel="${attr(id)}" ` +
      `${activeTab === id ? '' : 'aria-hidden="true"'}>${html}</div>`;

  return `<section class="deep-work-column" data-surface="work" data-active-work-tab="${attr(activeTab)}">` +
    `<div class="deep-work-tabs" role="tablist" aria-label="Product work">` +
      tabs.map(tab =>
        `<button type="button" class="${activeTab === tab.id ? 'is-active' : ''}" ` +
          `data-work-tab="${attr(tab.id)}" role="tab" aria-selected="${activeTab === tab.id ? 'true' : 'false'}">` +
          `${escHtml(tab.label)} <span>${escHtml(tab.count)}</span>` +
        `</button>`
      ).join('') +
    `</div>` +
    (warnings ? `<div class="deep-warnings"><strong>Warnings</strong><ul>${warnings}</ul></div>` : '') +
    panel('projects', renderProjects(view.projects)) +
    panel('bugs', renderBacklogKind(view.backlog, 'bugs')) +
    panel('ideas', renderBacklogKind(view.backlog, 'ideas')) +
  `</section>`;
}

function renderBacklog(backlog) {
  const warnings = list(backlog?.warnings).map(warning =>
    renderWarning(warning)
  ).join('');
  return `<section class="deep-panel deep-panel--backlog" data-surface="backlog">` +
    `<div class="deep-panel-head"><h3>Backlog</h3><span>Bugs / Ideas</span></div>` +
    `<div class="deep-backlog-add">` +
      `<form data-backlog-add-form data-kind="bugs"><input name="text" type="text" placeholder="New bug"><button type="submit">Add bug</button></form>` +
      `<form data-backlog-add-form data-kind="ideas"><input name="text" type="text" placeholder="New idea"><button type="submit">Add idea</button></form>` +
    `</div>` +
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
    `<h4>Active ops</h4>${ops || '<p class="muted">No active ops</p>'}` +
    `<h4>Work runs</h4>${mutations || '<p class="muted">No active mutations</p>'}` +
    `<h4>Planning</h4>${planning}` +
  `</section>`;
}

const PRODUCT_CHAT_COMMANDS = ['/fresh', '/fresh-full', '/clear', '/opus', '/sonnet', '/haiku'];

function renderChatCommands() {
  return `<div class="deep-chat-commands" aria-label="Chat commands">` +
    PRODUCT_CHAT_COMMANDS.map(command =>
      `<button type="button" data-chat-command="${attr(command)}">${escHtml(command)}</button>`
    ).join('') +
  `</div>`;
}

function renderProductSearch(view) {
  return `<form data-product-search-form data-product="${attr(view.name)}" data-search-scope="repo+vault">` +
    `<input name="query" type="search" placeholder="Search repo + vault" aria-label="Search repo and vault">` +
    `<button type="submit">Search</button>` +
  `</form>`;
}

function renderChatMessages(messages) {
  const rows = list(messages).map(message =>
    `<article class="deep-chat-message deep-chat-message--${attr(message.role || 'assistant')}" ` +
      `data-chat-message-role="${attr(message.role || 'assistant')}">` +
      `${escHtml(message.text || '')}` +
    `</article>`
  ).join('');
  return `<div class="deep-chat-transcript" data-product-chat-transcript aria-live="polite">` +
    (rows || '<p class="muted">No messages yet</p>') +
  `</div>`;
}

function renderChat(view, messages = []) {
  return `<section class="deep-panel deep-panel--chat chat-panel--secondary" data-surface="chat" ` +
    `data-panel-priority="secondary" data-chat-scope="product" data-search-scope="repo+vault" aria-label="product chat">` +
    `<div class="deep-panel-head"><h3>Chat</h3><span>${escHtml(view.name)}</span></div>` +
    `<p class="muted">Product repo + vault scope. KB research opens in Claude App.</p>` +
    `${renderChatMessages(messages)}` +
    `<a href="app://claude" data-app-deeplink>Open Claude App</a>` +
    `${renderChatCommands()}` +
    `${renderProductSearch(view)}` +
    `<form data-product-chat-form data-product="${attr(view.name)}">` +
      `<textarea name="message" rows="3" placeholder="Message ${attr(view.name)}..."></textarea>` +
      `<button type="submit">Send</button>` +
    `</form>` +
  `</section>`;
}

export function renderProductDeepView(view, options = {}) {
  const activeTab = options.activeTab || 'projects';
  const chatMessages = options.chatMessages || [];
  if (!view) {
    return '<section class="product-deep-view product-deep-view--unavailable"><h2>Product unavailable</h2></section>';
  }

  if (view.repoBacked === false) {
    return `<section class="product-deep-view product-deep-view--limited" data-product="${attr(view.name)}">` +
      `<header class="deep-header"><button type="button" class="deep-home-btn" data-go-home>Home</button><h2>${escHtml(view.name)}</h2><span>limited - not repo-backed</span></header>` +
      `<p>${escHtml(view.limitedReason || 'Known product is not repo-backed.')}</p>` +
    `</section>`;
  }

  return `<section class="product-deep-view" data-product="${attr(view.name)}">` +
    `<header class="deep-header">` +
      `<div class="deep-title-row"><button type="button" class="deep-home-btn" data-go-home>Home</button><h2>${escHtml(view.name)}</h2></div>` +
      `<nav aria-label="Product surfaces">` +
        `<button type="button" data-surface-jump="projects">Projects</button>` +
        `<button type="button" data-surface-jump="bugs">Bugs</button>` +
        `<button type="button" data-surface-jump="ideas">Ideas</button>` +
        `<button type="button" data-surface-jump="runs">Runs</button>` +
        `<button type="button" data-surface-jump="chat">Chat</button>` +
      `</nav>` +
    `</header>` +
    `<div class="deep-two-column">` +
      `${renderWorkTabs(view, activeTab)}` +
      `<aside class="deep-side-stack">` +
        `${renderChat(view, chatMessages)}` +
        `${renderOperations(options.operations)}` +
        `${renderRuns(view, options.liveRuns || {})}` +
      `</aside>` +
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
  if (typeof window !== 'undefined' && typeof window.jarvisSendWebviewMessage === 'function') {
    const sent = window.jarvisSendWebviewMessage({ product, text });
    if (sent) return Promise.resolve({ live: true });
  }
  return defaultPostJson('/api/chat', { product, message: text });
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function mutationProduct(mutation) {
  const payload = mutation?.payload || {};
  return typeof mutation?.product === 'string' ? mutation.product
    : typeof payload.product === 'string' ? payload.product
    : 'jarvis';
}

function operationsFromState(state, product) {
  if (!state) return null;
  const activeMutations = list(state.mutations?.active)
    .filter(mutation => mutationProduct(mutation) === product);
  const planning = state.activePlanning?.product === product ? state.activePlanning : null;
  return {
    inFlightOps: list(state.inFlight).filter(op => op.kind !== 'classifier'),
    mutations: activeMutations,
    planning,
  };
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
  openPlanningPanel,
  router,
  loadOperations = false,
} = {}) {
  if (!root) throw new Error('createProductDeepView requires a root');
  const loadJson = fetchJson || (url => fetch(url).then(r => r.json()));
  const post = postJson || ((url, body) => defaultPostJson(url, body));
  const send = sendChat || defaultSendChat;
  let current = null;
  let currentOperations = operations || null;
  let liveRuns = {};
  let subscription = null;
  let activeTab = 'projects';
  let chatMessages = [];
  let streamingMessageIndex = -1;

  function render() {
    root.innerHTML = renderProductDeepView(current, {
      liveRuns,
      operations: currentOperations,
      activeTab,
      chatMessages,
    });
  }

  function appendChatMessage(role, text) {
    chatMessages = [...chatMessages, { role, text }];
    streamingMessageIndex = -1;
    render();
  }

  function appendOrUpdateStreaming(text) {
    if (streamingMessageIndex < 0 || !chatMessages[streamingMessageIndex]) {
      chatMessages = [...chatMessages, { role: 'assistant streaming', text }];
      streamingMessageIndex = chatMessages.length - 1;
    } else {
      chatMessages = chatMessages.map((message, index) =>
        index === streamingMessageIndex
          ? { ...message, text: `${message.text || ''}${text}` }
          : message
      );
    }
    render();
  }

  async function sendProductMessage(text, messageProduct = product) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    appendChatMessage('user', trimmed);
    const result = await send({ product: messageProduct, text: trimmed });
    if (result?.text) appendChatMessage('assistant', result.text);
    return result;
  }

  function findBacklogItem(itemId) {
    return [...list(current?.backlog?.bugs), ...list(current?.backlog?.ideas)]
      .find(item => item.id === itemId);
  }

  function focusChat() {
    root.querySelector?.('[data-surface="chat"]')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  const onWebviewFrame = event => {
    const frame = event?.detail;
    if (!frame || !current) return;
    if (frame.kind === 'chunk') {
      appendOrUpdateStreaming(frame.text || '');
      return;
    }
    if (frame.kind === 'message') {
      streamingMessageIndex = -1;
      appendChatMessage('assistant', frame.text || '');
    }
  };

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
    const home = event.target?.closest?.('[data-go-home]');
    if (home) {
      event.preventDefault?.();
      router?.goHome?.();
      return;
    }

    const workTab = event.target?.closest?.('[data-work-tab]');
    if (workTab) {
      event.preventDefault?.();
      activeTab = workTab.dataset?.workTab || activeTab;
      render();
      return;
    }

    const surfaceJump = event.target?.closest?.('[data-surface-jump]');
    if (surfaceJump) {
      event.preventDefault?.();
      const surface = surfaceJump.dataset?.surfaceJump;
      if (surface === 'projects' || surface === 'bugs' || surface === 'ideas') {
        activeTab = surface;
        render();
      }
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
      return;
    }

    const plan = event.target?.closest?.('[data-plan-item-id]');
    if (plan) {
      event.preventDefault?.();
      const itemId = plan.dataset?.planItemId;
      if (!itemId || plan.disabled) return;
      plan.disabled = true;
      const result = await post(`/api/backlog/${encodeURIComponent(product)}/items/${encodeURIComponent(itemId)}/plan`);
      const item = findBacklogItem(itemId);
      appendChatMessage(
        'system',
        `Planning started for ${itemTitle(item) || itemId}. Continue the planning conversation here.`,
      );
      focusChat();
      openPlanningPanel?.({
        product,
        planningSessionId: result?.planningSessionId,
        promotionId: result?.promotionId,
        linkedSession: true,
      });
      return;
    }

    const cancelOp = event.target?.closest?.('[data-cancel-op-id]');
    if (cancelOp) {
      event.preventDefault?.();
      const id = cancelOp.dataset?.cancelOpId;
      if (!id || cancelOp.disabled) return;
      cancelOp.disabled = true;
      await post(`/api/ops/${encodeURIComponent(id)}/cancel`).catch(() => { cancelOp.disabled = false; });
      return;
    }

    const cancelMutation = event.target?.closest?.('[data-cancel-mutation-id]');
    if (cancelMutation) {
      event.preventDefault?.();
      const id = cancelMutation.dataset?.cancelMutationId;
      if (!id || cancelMutation.disabled) return;
      cancelMutation.disabled = true;
      await post(`/api/mutations/${encodeURIComponent(id)}/cancel`).catch(() => { cancelMutation.disabled = false; });
      return;
    }

    const command = event.target?.closest?.('[data-chat-command]');
    if (command) {
      event.preventDefault?.();
      const text = command.dataset?.chatCommand;
      if (!text) return;
      await sendProductMessage(text);
    }
  };

  const onSubmit = async event => {
    const backlogAdd = event.target?.closest?.('[data-backlog-add-form]');
    if (backlogAdd) {
      event.preventDefault?.();
      const kind = backlogAdd.dataset?.kind;
      const text = backlogAdd.elements?.text?.value || '';
      if (!kind || !String(text).trim()) return;
      const result = await post(`/api/backlog/${encodeURIComponent(product)}/${encodeURIComponent(kind)}`, { text });
      current = clone(current);
      const items = current?.backlog?.[kind];
      if (Array.isArray(items) && result?.item) items.push(result.item);
      render();
      backlogAdd.reset?.();
      return;
    }

    const chatForm = event.target?.closest?.('[data-product-chat-form]');
    if (chatForm) {
      event.preventDefault?.();
      const text = chatForm.elements?.message?.value || '';
      if (!String(text).trim()) return;
      await sendProductMessage(text, chatForm.dataset?.product || product);
      chatForm.reset?.();
      return;
    }

    const searchForm = event.target?.closest?.('[data-product-search-form]');
    if (!searchForm) return;
    event.preventDefault?.();
    const query = searchForm.elements?.query?.value || '';
    if (!String(query).trim()) return;
    const text = `Search repo and vault for: ${query}`;
    await sendProductMessage(text, searchForm.dataset?.product || product);
    searchForm.reset?.();
  };

  root.addEventListener?.('click', onClick);
  root.addEventListener?.('submit', onSubmit);
  if (typeof window !== 'undefined') {
    window.addEventListener?.('jarvis-webview-frame', onWebviewFrame);
  }

  return {
    async load() {
      current = await loadJson(`/api/products/${encodeURIComponent(product)}`);
      if (loadOperations && !operations) {
        const state = await loadJson('/api/state').catch(() => null);
        currentOperations = operationsFromState(state, product);
      }
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
      if (opts.activeTab) activeTab = opts.activeTab;
      if (opts.chatMessages) chatMessages = opts.chatMessages;
      currentOperations = opts.operations || currentOperations;
      render();
    },
    close() {
      subscription?.close?.();
      subscription = null;
      root.removeEventListener?.('click', onClick);
      root.removeEventListener?.('submit', onSubmit);
      if (typeof window !== 'undefined') {
        window.removeEventListener?.('jarvis-webview-frame', onWebviewFrame);
      }
    },
  };
}
