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

function renderProductMarkdown(text) {
  const raw = String(text || '');
  const factory = typeof window !== 'undefined' ? window.markdownit : null;
  // Fallback escapes HTML and preserves line breaks — `.deep-chat-message` is
  // `white-space: normal`, so bare escaped text would collapse newlines.
  const fallback = () => escHtml(raw).replace(/\n/g, '<br>');
  if (typeof factory !== 'function') return fallback();
  try {
    const md = factory({ html: false, linkify: true, typographer: true });
    if (md && typeof md.render === 'function') return md.render(raw);
  } catch (_) { /* fall back to escaped plain text */ }
  return fallback();
}

function actionLabel(action, fallback) {
  if (!action) return fallback;
  if (action.enabled === false) return fallback;
  if (action.state === 'gating') return `${fallback} scoping`;
  if (action.state === 'declined') return `${fallback} declined`;
  if (action.state === 'handoff-failed') return `${fallback} handoff failed`;
  if (action.state === 'proceeding') return `${fallback} running`;
  if (action.state === 'disabled') return fallback;
  return fallback;
}

function renderActionButton(action, itemId, kind, extra = '') {
  if (!action) return '';
  const state = action.enabled === false ? 'disabled' : (action.state || 'available');
  const disabled = action.enabled === false || state !== 'available';
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
  if (action.disabledReason) bits.push(action.disabledReason);
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

function renderProjectRunControl(project) {
  const control = project.runControl || { state: 'start' };
  const mode = control.dispatchMode
    ? `<span class="deep-action-meta">${escHtml(control.fallbackReason ? `${control.dispatchMode} - ${control.fallbackReason}` : control.dispatchMode)}</span>`
    : '';
  const error = control.error
    ? `<span class="deep-action-meta deep-action-meta--error">${escHtml(control.error)}</span>`
    : '';
  if (control.state === 'cancel' && control.mutationId) {
    return `<div class="deep-actions deep-project-actions">` +
      `<button type="button" class="deep-action deep-action--cancel" data-project-run-action="cancel" ` +
        `data-project-slug="${attr(project.slug)}" data-mutation-id="${attr(control.mutationId)}">Cancel</button>` +
      `${mode}${error}` +
    `</div>`;
  }
  return `<div class="deep-actions deep-project-actions">` +
    `<button type="button" class="deep-action deep-action--start" data-project-run-action="start" ` +
      `data-project-slug="${attr(project.slug)}">Start</button>` +
    `${mode}${error}` +
  `</div>`;
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
      `${renderProjectRunControl(project)}` +
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

function renderOperationActivity(activity) {
  const rows = list(activity).map(row => {
    const label = row.status ? `${row.status}: ${row.detail || row.label || row.opId || 'op'}` : (row.detail || row.label || row.opId || 'op');
    return `<article class="deep-op-row deep-op-row--activity" data-op-activity-id="${attr(row.opId || '')}">` +
      `<span>${escHtml(row.at || '')}</span><span>${escHtml(label)}</span>` +
    `</article>`;
  }).join('');
  return rows || '<p class="muted">No live activity yet</p>';
}

function renderOperations(operations) {
  const model = operations || {};
  const ops = list(model.inFlightOps).map(op =>
    `<article class="deep-op-row"><span>${escHtml(op.opId)}</span><span>${escHtml(op.detail || op.label || 'op')}</span><button type="button" data-cancel-op-id="${attr(op.opId)}">Cancel</button></article>`
  ).join('');
  const mutations = list(model.mutations).map(mutation =>
    `<article class="deep-op-row"><span>${escHtml(mutation.id)}</span><span>${escHtml(mutation.kind || mutation.status || 'mutation')}</span><button type="button" data-cancel-mutation-id="${attr(mutation.id)}">Cancel</button></article>`
  ).join('');
  const planning = model.planning
    ? `<p>Planning ${escHtml(model.planning.product || '')} ${escHtml(model.planning.status || '')}</p>`
    : '<p class="muted">No active planning</p>';
  return `<section class="deep-panel deep-panel--operations" data-surface="operations">` +
    `<div class="deep-panel-head"><h3>Operations</h3><span>controls</span></div>` +
    `<h4>Active ops</h4>${ops || '<p class="muted">No active ops</p>'}` +
    `<h4>Activity</h4><div class="deep-op-activity" data-product-op-activity>${renderOperationActivity(model.activity)}</div>` +
    `<h4>Work runs</h4>${mutations || '<p class="muted">No active mutations</p>'}` +
    `<h4>Planning</h4>${planning}` +
  `</section>`;
}

function renderSideTabs(view, operations, liveRuns = {}, activeSidePanel = 'operations') {
  const active = activeSidePanel === 'runs' ? 'runs' : 'operations';
  const tabs = [
    { id: 'operations', label: 'Operations' },
    { id: 'runs', label: 'Runs' },
  ];
  return `<section class="deep-side-tab-panel" data-surface="side-panel" data-active-side-panel="${attr(active)}">` +
    `<div class="deep-side-tabs" role="tablist" aria-label="Product operations panels">` +
      tabs.map(tab =>
        `<button type="button" role="tab" data-side-panel-tab="${attr(tab.id)}" ` +
          `aria-selected="${tab.id === active ? 'true' : 'false'}" ` +
          `class="${tab.id === active ? 'is-active' : ''}">${escHtml(tab.label)}</button>`
      ).join('') +
    `</div>` +
    `<div class="deep-side-tab-body">` +
      (active === 'runs' ? renderRuns(view, liveRuns) : renderOperations(operations)) +
    `</div>` +
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

function renderChatMessages(messages) {
  const rows = list(messages).map(message =>
    `<article class="deep-chat-message deep-chat-message--${attr(message.role || 'assistant')}" ` +
      `data-chat-message-role="${attr(message.role || 'assistant')}">` +
      `${renderProductMarkdown(message.text || '')}` +
    `</article>`
  ).join('');
  return `<div class="deep-chat-transcript" data-product-chat-transcript aria-live="polite">` +
    (rows || '<p class="muted">No messages yet</p>') +
  `</div>`;
}

function renderChatOpStatus(activeOp) {
  if (!activeOp?.opId) return '';
  // Recompute from startedAt on every render (matches the global UI) so a full
  // re-render mid-op shows true elapsed rather than the stale elapsedMs:0 stamp.
  const elapsed = activeOp.startedAt
    ? Date.now() - new Date(activeOp.startedAt).getTime()
    : (Number.isFinite(activeOp.elapsedMs) ? activeOp.elapsedMs : 0);
  return `<div class="deep-chat-op-status chat-status" data-product-chat-op-status data-op-id="${attr(activeOp.opId)}" aria-live="polite">` +
    `<span class="cs-spinner"></span>` +
    `<span class="cs-label">${escHtml(activeOp.label || 'Asking Claude')}</span>` +
    `<span class="cs-elapsed">· ${escHtml(fmtElapsed(elapsed))}</span>` +
    `<button type="button" class="cs-cancel" data-cancel-op-id="${attr(activeOp.opId)}" title="Cancel" aria-label="Cancel operation">&times;</button>` +
  `</div>`;
}

function specField(label, value) {
  return `<div class="deep-spec-field">` +
    `<span class="deep-spec-label">${escHtml(label)}</span>` +
    `<pre class="deep-spec-body">${escHtml(value || '')}</pre>` +
  `</div>`;
}

// Inline planning surface rendered inside the product chat panel. The chat
// panel IS the planning surface in the home/product layout (the standalone
// #planning-panel overlay is unreachable now that the sidebar is hidden). When
// a spec is proposed the structured artifact (title/spec/tasks/test-plan) and
// the Approve/Refine/Abandon actions render here instead of in a separate panel.
function renderPlanning(planning) {
  if (!planning?.active) return '';
  const status = planning.status || 'scoping';
  const statusPill = `<span class="planning-status-pill status-${attr(status)}" data-planning-status>${escHtml(status)}</span>`;
  if (status !== 'spec-proposed' || !planning.artifact) {
    return `<div class="deep-planning" data-planning-active>` +
      `<div class="deep-planning-head"><strong>Planning</strong>${statusPill}</div>` +
      `<p class="muted">Reply below to shape the spec. Approve scaffolds it; /clear abandons.</p>` +
    `</div>`;
  }
  const a = planning.artifact;
  return `<div class="deep-planning deep-planning--spec" data-planning-active>` +
    `<div class="deep-planning-head"><strong>Proposed spec</strong>${statusPill}</div>` +
    `<div class="deep-planning-spec-body">` +
      specField('title', a.title) +
      specField('spec', a.spec) +
      specField('tasks', a.tasks) +
      specField('test-plan', a.testPlan) +
    `</div>` +
    `<div class="deep-planning-actions">` +
      `<button type="button" class="deep-planning-approve" data-planning-action="approve">Approve</button>` +
      `<button type="button" class="deep-planning-refine" data-planning-action="refine">Refine</button>` +
      `<button type="button" class="deep-planning-abandon" data-planning-action="abandon">Abandon</button>` +
    `</div>` +
  `</div>`;
}

function renderChat(view, messages = [], planning = null, activeOp = null) {
  const planningActive = !!planning?.active;
  const placeholder = planningActive ? `Reply to planning...` : `Message ${attr(view.name)}...`;
  const messageCount = list(messages).length;
  const depthLabel = `${messageCount} ${messageCount === 1 ? 'message' : 'messages'} deep`;
  return `<section class="deep-panel deep-panel--chat chat-panel--secondary" data-surface="chat" ` +
    `data-panel-priority="secondary" data-chat-scope="product" data-search-scope="repo+vault" aria-label="product chat">` +
    `<div class="deep-panel-head"><h3>Chat</h3><span data-chat-message-depth>${escHtml(depthLabel)}</span></div>` +
    `<p class="muted">Product repo + vault scope. KB research opens in Claude App.</p>` +
    `${renderChatOpStatus(activeOp)}` +
    `${renderPlanning(planning)}` +
    `${renderChatMessages(messages)}` +
    `<a href="app://claude" data-app-deeplink>Open Claude App</a>` +
    `${renderChatCommands()}` +
    `<form data-product-chat-form data-product="${attr(view.name)}">` +
      `<textarea name="message" rows="3" placeholder="${attr(placeholder)}"></textarea>` +
      `<button type="submit">Send</button>` +
    `</form>` +
  `</section>`;
}

// Best-effort parse of the fenced ```spec-artifact JSON block the planning
// scoping turn emits, so the chat panel can render the structured spec without a
// separate fetch. Mirrors tryParseSpecArtifactFromReply in app.js. Returns null
// when no well-formed block is present.
function tryParseSpecArtifact(reply) {
  const match = /```spec-artifact\s*\n([\s\S]*?)\n```/.exec(String(reply || ''));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed && typeof parsed === 'object' &&
        typeof parsed.title === 'string' &&
        typeof parsed.spec === 'string' &&
        typeof parsed.tasks === 'string' &&
        typeof parsed.testPlan === 'string') {
      return parsed;
    }
  } catch (_) { /* malformed — fall through */ }
  return null;
}

function isSpecArtifact(value) {
  return value && typeof value === 'object' &&
    typeof value.title === 'string' &&
    typeof value.spec === 'string' &&
    typeof value.tasks === 'string' &&
    typeof value.testPlan === 'string';
}

export function renderProductDeepView(view, options = {}) {
  const activeTab = options.activeTab || 'projects';
  const activeSidePanel = options.activeSidePanel === 'runs' ? 'runs' : 'operations';
  const chatMessages = options.chatMessages || [];
  const planning = options.planning || null;
  const activeOp = options.activeOp || null;
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
        `${renderChat(view, chatMessages, planning, activeOp)}` +
        `${renderSideTabs(view, options.operations, options.liveRuns || {}, activeSidePanel)}` +
      `</aside>` +
    `</div>` +
  `</section>`;
}

function defaultPostJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async response => {
    if (!response.ok) {
      // Surface the server's typed reason (e.g. "global work-run cap reached",
      // "parked (blocked-on-human) run exists") instead of a bare status — the
      // inline card error relies on this to tell the user what to do.
      let detail = `Request failed: ${response.status}`;
      try {
        const parsed = await response.json();
        if (parsed && typeof parsed.error === 'string' && parsed.error) detail = parsed.error;
      } catch (_) { /* non-JSON body — keep the status string */ }
      throw new Error(detail);
    }
    return response.json();
  });
}

function defaultSendChat({ product, text }) {
  if (typeof window !== 'undefined' && typeof window.runeSendWebviewMessage === 'function') {
    const sent = window.runeSendWebviewMessage({ product, text });
    if (sent) return Promise.resolve({ live: true });
  }
  return defaultPostJson('/api/chat', { product, message: text });
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const WORK_RUN_MUTATION_KINDS = new Set(['work-run', 'orchestrated-work']);

function mutationProduct(mutation) {
  const payload = mutation?.payload || {};
  return typeof mutation?.product === 'string' ? mutation.product
    : typeof payload.product === 'string' ? payload.product
    : 'rune';
}

function mutationProjectSlug(mutation) {
  const payload = mutation?.payload || {};
  return typeof payload.projectSlug === 'string' ? payload.projectSlug : '';
}

function isTerminalMutation(mutation) {
  return mutation?.status === 'completed' || mutation?.status === 'failed' || mutation?.status === 'rejected';
}

function activeProjectMutation(mutations, product, projectSlug) {
  return list(mutations).find(mutation =>
    WORK_RUN_MUTATION_KINDS.has(mutation?.kind) &&
    !isTerminalMutation(mutation) &&
    mutationProduct(mutation) === product &&
    mutationProjectSlug(mutation) === projectSlug
  );
}

function overlayRunControlsFromState(view, state, product) {
  if (!view?.projects) return view;
  // A failed /api/state fetch arrives here as null — keep the server-provided
  // runControl rather than resetting every project to 'start' (which would hide
  // a live run's Cancel button on a transient blip).
  if (!state) return view;
  const activeMutations = list(state?.mutations?.active);
  const next = clone(view);
  next.projects = list(next.projects).map(project => {
    const mutation = activeProjectMutation(activeMutations, product, project.slug);
    const existing = project.runControl || { state: 'start' };
    if (mutation?.id) {
      const payload = mutation.payload || {};
      return {
        ...project,
        runControl: {
          state: 'cancel',
          mutationId: mutation.id,
          ...(typeof payload.dispatchMode === 'string' ? { dispatchMode: payload.dispatchMode } : {}),
          ...(typeof payload.fallbackReason === 'string' ? { fallbackReason: payload.fallbackReason } : {}),
        },
      };
    }
    return {
      ...project,
      runControl: {
        state: 'start',
        ...(existing.dispatchMode ? { dispatchMode: existing.dispatchMode } : {}),
        ...(existing.fallbackReason ? { fallbackReason: existing.fallbackReason } : {}),
      },
    };
  });
  return next;
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

// Op-events carry no product field, so they are user-global. Scope the product
// chat pill to `chat` ops only — product chat + planning turns are chat-kind
// (claude.ts opLabel:'chat'). Project runs emit no op-events (mutation/run
// events, already surfaced in the Runs + Operations panels); background `agent`
// ops (nightly, prep, reviews) are unrelated noise, so they are excluded.
const PRODUCT_VISIBLE_OP_KINDS = new Set(['chat']);

function shouldShowProductOp(frame) {
  return frame?.kind === 'op-event' &&
    frame.opKind !== 'classifier' &&
    PRODUCT_VISIBLE_OP_KINDS.has(frame.opKind);
}

function opDisplayLabel(frame) {
  if (frame?.opKind === 'chat') return 'Asking Claude';
  return frame?.label || 'Asking Claude';
}

function fmtClock(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Per-product chat + planning state kept at module scope so it survives
// navigating away from a product and back (client-view.js close()s the view and
// constructs a fresh one on each route change). In-session only — not persisted
// across a full page reload. Keyed by product slug.
const productSessions = new Map();

function getProductSession(product) {
  let session = productSessions.get(product);
  if (!session) {
    session = {
      chatMessages: [],
      planning: { active: false, status: 'scoping', artifact: null },
      activeOp: null,
      opActivity: [],
    };
    productSessions.set(product, session);
  }
  return session;
}

/** Test seam: clear all retained per-product chat/planning state. */
export function __resetProductSessions() {
  productSessions.clear();
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
  let activeSidePanel = 'operations';
  const session = getProductSession(product);
  let chatMessages = session.chatMessages;
  let planning = session.planning;
  let activeOp = session.activeOp || null;
  let opActivity = list(session.opActivity);
  let streamingMessageIndex = -1;
  let opTicker = null;

  function persistSession() {
    session.chatMessages = chatMessages;
    session.planning = planning;
    session.activeOp = activeOp;
    session.opActivity = opActivity;
  }

  function render() {
    root.innerHTML = renderProductDeepView(current, {
      liveRuns,
      operations: { ...(currentOperations || {}), activity: opActivity.length ? opActivity : list(currentOperations?.activity) },
      activeTab,
      activeSidePanel,
      chatMessages,
      planning,
      activeOp,
    });
  }

  function syncOpTicker() {
    if (activeOp?.opId && !opTicker) {
      opTicker = setInterval(() => {
        if (!activeOp?.opId) {
          syncOpTicker();
          return;
        }
        // Update only the elapsed text node — a full render() here would
        // replace root.innerHTML every second, wiping the chat textarea (typed
        // text + focus) and the transcript scroll position. Elapsed is
        // recomputed from startedAt on the next real render, so we don't mutate
        // activeOp here.
        const el = root.querySelector?.('[data-product-chat-op-status] .cs-elapsed');
        if (el) {
          const ms = Date.now() - new Date(activeOp.startedAt || Date.now()).getTime();
          el.textContent = `· ${fmtElapsed(ms)}`;
        }
      }, 1000);
      return;
    }
    if (!activeOp?.opId && opTicker) {
      clearInterval(opTicker);
      opTicker = null;
    }
  }

  function appendOperationActivity(row) {
    opActivity = [...opActivity, row].slice(-50);
    persistSession();
  }

  function handleOpFrame(frame) {
    if (!shouldShowProductOp(frame)) return;
    const base = {
      opId: frame.opId,
      label: opDisplayLabel(frame),
      startedAt: frame.startedAt,
      elapsedMs: Number.isFinite(frame.elapsedMs) ? frame.elapsedMs : 0,
    };
    if (frame.subKind === 'start') {
      activeOp = base;
      appendOperationActivity({ ...base, at: fmtClock(frame.startedAt), status: 'started' });
      syncOpTicker();
      render();
      return;
    }
    if (frame.subKind === 'progress') {
      if (activeOp?.opId === frame.opId) activeOp = { ...activeOp, ...base };
      if (frame.detail) {
        appendOperationActivity({
          ...base,
          at: fmtClock(new Date().toISOString()),
          detail: frame.detail,
        });
      } else {
        persistSession();
      }
      render();
      return;
    }
    if (frame.subKind === 'end') {
      if (activeOp?.opId === frame.opId) activeOp = null;
      appendOperationActivity({
        ...base,
        at: fmtClock(new Date().toISOString()),
        detail: frame.error || frame.detail || frame.status || 'done',
        status: frame.status || 'ended',
      });
      syncOpTicker();
      render();
    }
  }

  async function reloadProductAndOperations() {
    const [nextView, state] = await Promise.all([
      loadJson(`/api/products/${encodeURIComponent(product)}`),
      loadJson('/api/state').catch(() => null),
    ]);
    current = overlayRunControlsFromState(nextView, state, product);
    const nextOperations = operationsFromState(state, product);
    if (nextOperations) currentOperations = nextOperations;
    render();
    return current;
  }

  // Start launches an autonomous run that edits + commits without further
  // confirmation, so gate it behind a confirm() that names the project and the
  // resolved dispatch mode — mirroring the cockpit Start modal. Proceeds when
  // window.confirm is unavailable (node/test) so headless callers aren't blocked.
  function confirmStartRun(projectSlug) {
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
    const project = list(current?.projects).find(p => p.slug === projectSlug);
    const control = project?.runControl || {};
    let mode = '';
    if (control.dispatchMode === 'orchestrated') {
      mode = '\n\nMode: orchestrated (product-team loop)';
    } else if (control.dispatchMode === 'legacy') {
      mode = `\n\nMode: legacy /work --auto · fallback: ${control.fallbackReason || 'unspecified'}`;
    } else if (control.dispatchMode) {
      mode = `\n\nMode: ${control.dispatchMode}`;
    }
    return window.confirm(
      `Start a work run on "${projectSlug}"?${mode}\n\n` +
        'It runs autonomously and edits + commits without further confirmation.',
    );
  }

  function setProjectRunControlError(projectSlug, message) {
    current = clone(current);
    for (const project of list(current?.projects)) {
      if (project.slug !== projectSlug) continue;
      project.runControl = {
        ...(project.runControl || { state: 'start' }),
        error: message,
      };
    }
    render();
  }

  function appendChatMessage(role, text) {
    chatMessages = [...chatMessages, { role, text }];
    streamingMessageIndex = -1;
    persistSession();
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
    persistSession();
    render();
  }

  function restoreTemporarilyDisabledPlanActions() {
    current = clone(current);
    for (const kind of ['bugs', 'ideas']) {
      for (const item of list(current?.backlog?.[kind])) {
        if (item.plan?.disabledReason === 'planning-active') {
          item.plan = { kind: 'plan', enabled: true };
        }
      }
    }
  }

  function resetPlanning({ restorePlanActions = true } = {}) {
    planning = { active: false, status: 'scoping', artifact: null };
    if (restorePlanActions) restoreTemporarilyDisabledPlanActions();
    persistSession();
    render();
  }

  function resetChatSession({ restorePlanActions = true } = {}) {
    chatMessages = [];
    streamingMessageIndex = -1;
    if (planning.active) {
      planning = { active: false, status: 'scoping', artifact: null };
      if (restorePlanActions) restoreTemporarilyDisabledPlanActions();
    }
    persistSession();
    render();
  }

  function markPlanningActiveOnBacklog() {
    current = clone(current);
    for (const kind of ['bugs', 'ideas']) {
      for (const item of list(current?.backlog?.[kind])) {
        if (item.plan && item.plan.enabled !== false) {
          item.plan = { kind: 'plan', enabled: false, disabledReason: 'planning-active' };
        }
      }
    }
  }

  function focusChatInput() {
    root.querySelector?.('[data-product-chat-form] [name="message"]')?.focus?.();
  }

  // Drive one planning turn through the structured planning endpoint so the chat
  // panel can render the proposed spec + Approve/Refine/Abandon. The user line is
  // appended by the caller; this appends the assistant reply and updates the
  // spec-proposed state.
  async function planningTurn(text) {
    let body;
    try {
      body = await post('/api/planning/turn', { text });
    } catch (err) {
      appendChatMessage('assistant', `Planning error: ${err?.message || err}`);
      return null;
    }
    const status = body?.status || 'scoping';
    const artifact = status === 'spec-proposed'
      ? (isSpecArtifact(body?.artifact) ? body.artifact : tryParseSpecArtifact(body?.reply || ''))
      : null;
    planning = {
      ...planning,
      active: true,
      status,
      artifact: status === 'spec-proposed' ? (artifact || planning.artifact) : null,
    };
    persistSession();
    appendChatMessage('assistant', body?.reply || '');
    return body;
  }

  async function approvePlanning() {
    let body;
    try {
      body = await post('/api/planning/approve');
    } catch (err) {
      appendChatMessage('assistant', `Approve failed: ${err?.message || err}`);
      return;
    }
    appendChatMessage('system', body?.slug
      ? `Spec approved — scaffolding ${body.slug}.`
      : 'Spec approved — scaffolding project files.');
    resetPlanning({ restorePlanActions: false });
  }

  async function abandonPlanning() {
    try {
      await post('/api/planning/abandon');
    } catch (_) { /* idempotent server-side */ }
    appendChatMessage('system', 'Planning session abandoned.');
    resetPlanning();
  }

  async function sendProductMessage(text, messageProduct = product) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    appendChatMessage('user', trimmed);
    const isCommand = trimmed.startsWith('/');
    const clearsSession = trimmed === '/clear' || trimmed.startsWith('/fresh');
    // While planning, free-form text drives the planning conversation through the
    // structured endpoint; slash commands fall through to the normal path so
    // /clear, /fresh, and model switches keep working (and abandon the session).
    if (planning.active && !isCommand) return planningTurn(trimmed);
    const result = await send({ product: messageProduct, text: trimmed });
    if (clearsSession) {
      resetChatSession();
      return result;
    }
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
      return;
    }
    if (frame.kind === 'op-event') {
      handleOpFrame(frame);
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

    const sidePanelTab = event.target?.closest?.('[data-side-panel-tab]');
    if (sidePanelTab) {
      event.preventDefault?.();
      const next = sidePanelTab.dataset?.sidePanelTab;
      if (next === 'operations' || next === 'runs') {
        activeSidePanel = next;
        render();
      }
      return;
    }

    const surfaceJump = event.target?.closest?.('[data-surface-jump]');
    if (surfaceJump) {
      event.preventDefault?.();
      const surface = surfaceJump.dataset?.surfaceJump;
      if (surface === 'projects' || surface === 'bugs' || surface === 'ideas') {
        activeTab = surface;
        render();
      } else if (surface === 'runs') {
        activeSidePanel = 'runs';
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

    const planningAction = event.target?.closest?.('[data-planning-action]');
    if (planningAction) {
      event.preventDefault?.();
      const action = planningAction.dataset?.planningAction;
      if (action === 'approve') { await approvePlanning(); return; }
      if (action === 'abandon') { await abandonPlanning(); return; }
      if (action === 'refine') {
        planning = { ...planning, status: 'scoping' };
        persistSession();
        render();
        focusChatInput();
      }
      return;
    }

    const plan = event.target?.closest?.('[data-plan-item-id]');
    if (plan) {
      event.preventDefault?.();
      const itemId = plan.dataset?.planItemId;
      if (!itemId || plan.disabled) return;
      plan.disabled = true;
      let result;
      try {
        result = await post(`/api/backlog/${encodeURIComponent(product)}/items/${encodeURIComponent(itemId)}/plan`);
      } catch (err) {
        plan.disabled = false;
        appendChatMessage('assistant', `Plan failed: ${err?.message || err}`);
        return;
      }
      const item = findBacklogItem(itemId);
      // Enter planning mode in the right-column chat: the chat panel IS the
      // planning surface. The next free-form chat turn drives the planning
      // conversation (the backend routes product-scoped text to the active
      // planning session); a proposed spec then renders inline with
      // Approve/Refine/Abandon.
      planning = {
        active: true,
        status: 'scoping',
        artifact: null,
        sessionId: result?.planningSessionId,
        promotionId: result?.promotionId,
      };
      markPlanningActiveOnBacklog();
      appendChatMessage(
        'system',
        `Planning started for ${itemTitle(item) || itemId}. Reply in this chat to shape the spec; Approve scaffolds it.`,
      );
      persistSession();
      focusChat();
      focusChatInput();
      return;
    }

    const projectRun = event.target?.closest?.('[data-project-run-action]');
    if (projectRun) {
      event.preventDefault?.();
      const action = projectRun.dataset?.projectRunAction;
      const projectSlug = projectRun.dataset?.projectSlug;
      if (!projectSlug || projectRun.disabled) return;
      // Gate Start (not Cancel) behind a confirmation; a decline leaves the
      // button usable (return before disabling).
      if (action === 'start' && !confirmStartRun(projectSlug)) return;
      projectRun.disabled = true;
      try {
        if (action === 'start') {
          await post('/api/mutations', { kind: 'work-run', payload: { product, projectSlug } });
        } else if (action === 'cancel') {
          const mutationId = projectRun.dataset?.mutationId;
          if (!mutationId) throw new Error('missing mutation id');
          await post(`/api/mutations/${encodeURIComponent(mutationId)}/cancel`);
        } else {
          return;
        }
        await reloadProductAndOperations();
      } catch (err) {
        projectRun.disabled = false;
        setProjectRunControlError(projectSlug, `${action === 'cancel' ? 'Cancel' : 'Start'} failed: ${err?.message || err}`);
      }
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

  async function submitChatForm(chatForm) {
    const text = chatForm.elements?.message?.value || '';
    if (!String(text).trim()) return;
    await sendProductMessage(text, chatForm.dataset?.product || product);
    chatForm.reset?.();
  }

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
      await submitChatForm(chatForm);
      return;
    }
  };

  const onKeyDown = async event => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    const form = event.target?.closest?.('[data-product-chat-form]');
    if (!form || event.target?.name !== 'message') return;
    event.preventDefault?.();
    await submitChatForm(form);
  };

  root.addEventListener?.('click', onClick);
  root.addEventListener?.('submit', onSubmit);
  root.addEventListener?.('keydown', onKeyDown);
  if (typeof window !== 'undefined') {
    window.addEventListener?.('rune-webview-frame', onWebviewFrame);
  }

  return {
    async load() {
      current = await loadJson(`/api/products/${encodeURIComponent(product)}`);
      if (loadOperations && !operations) {
        const state = await loadJson('/api/state').catch(() => null);
        currentOperations = operationsFromState(state, product);
        current = overlayRunControlsFromState(current, state, product);
      }
      // Adopt an already-active planning session (e.g. started from Telegram or a
      // prior visit) so the chat panel surfaces it. In-session planning state
      // restored from the store wins; otherwise seed from /api/state.
      if (!planning.active && currentOperations?.planning?.product === product) {
        planning = {
          ...planning,
          active: true,
          status: currentOperations.planning.status || 'scoping',
        };
        persistSession();
      }
      // Surface a live run on entry: when a run is active and the user hasn't
      // deep-linked to a specific run, open the lower panel on Runs so progress
      // is visible without a click. Operations stays the default otherwise.
      // Scoped to load() only — a later polling refresh or a run starting
      // mid-session must not yank the user off whatever tab they're reading.
      if (current?.activeRun?.runId) activeSidePanel = 'runs';
      render();
      if (focusRunId) {
        activeSidePanel = 'runs';
        await focusRun(focusRunId);
        render();
      }
      return current;
    },
    render(view = current, opts = {}) {
      current = view;
      if (opts.liveRuns) liveRuns = opts.liveRuns;
      if (opts.activeTab) activeTab = opts.activeTab;
      if (opts.activeSidePanel === 'operations' || opts.activeSidePanel === 'runs') activeSidePanel = opts.activeSidePanel;
      if (opts.chatMessages) chatMessages = opts.chatMessages;
      if ('activeOp' in opts) activeOp = opts.activeOp;
      currentOperations = opts.operations || currentOperations;
      render();
    },
    close() {
      subscription?.close?.();
      subscription = null;
      if (opTicker) {
        clearInterval(opTicker);
        opTicker = null;
      }
      root.removeEventListener?.('click', onClick);
      root.removeEventListener?.('submit', onSubmit);
      root.removeEventListener?.('keydown', onKeyDown);
      if (typeof window !== 'undefined') {
        window.removeEventListener?.('rune-webview-frame', onWebviewFrame);
      }
    },
  };
}
