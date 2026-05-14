/* Jarvis webview client */
'use strict';

(function () {
  // Auth bootstrap: if ?token= is in the URL, exchange it for a cookie then redirect.
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (token) {
    fetch('/api/auth-bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then(r => {
      if (r.ok) {
        window.location.replace('/'); // replace keeps the token URL out of history
      } else {
        document.body.innerHTML = '<p style="color:red;padding:2rem">Auth failed. Check your token.</p>';
      }
    }).catch(() => {
      document.body.innerHTML = '<p style="color:red;padding:2rem">Auth request failed.</p>';
    });
    return; // Don't init app while redirecting
  }

  // Markdown renderer — highlight.js runs inline during rendering so language
  // hints from fenced code blocks (```python) are respected and streaming
  // re-renders don't re-run hljs on already-highlighted DOM nodes.
  const md = window.markdownit({
    html: false,
    linkify: true,
    typographer: true,
    highlight: function(str, lang) {
      if (lang && window.hljs.getLanguage(lang)) {
        try {
          return '<pre><code class="hljs">' +
            window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
            '</code></pre>';
        } catch (_) {}
      }
      return ''; // markdown-it escapes and wraps the fallback
    },
  });
  const vaultName = document.querySelector('meta[name="obsidian-vault"]')?.content ?? '';

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderMarkdown(text) {
    let html = md.render(text);
    // Wikilink substitution: [[Note Title]] → obsidian:// anchor
    html = html.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
      const href = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(title)}`;
      return `<a href="${escHtml(href)}" class="wikilink">${escHtml(title)}</a>`;
    });
    return html;
  }

  // Message history ring buffer (last 20 user messages)
  const RING_SIZE = 20;
  const ring = [];
  let ringPos = -1; // -1 = not recalling

  // DOM refs
  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('input-form');
  const input = document.getElementById('message-input');
  const modelSelect = document.getElementById('model-select');
  let pendingModelSwitch = null;

  // Auto-scroll state
  let userScrolledUp = false;
  messagesEl.parentElement.addEventListener('scroll', () => {
    const el = messagesEl.parentElement;
    userScrolledUp = el.scrollTop + el.clientHeight < el.scrollHeight - 5;
  });

  function scrollToBottom() {
    if (!userScrolledUp) {
      messagesEl.parentElement.scrollTop = messagesEl.parentElement.scrollHeight;
    }
  }

  function appendMessage(role, html, id) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    if (id) div.id = id;
    div.innerHTML = html;
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }

  // WebSocket with reconnect-backoff
  let ws = null;
  let reconnectDelay = 2000;
  let streamingDiv = null;
  let streamingText = '';

  function connect() {
    const wsScheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(`${wsScheme}${window.location.host}/api/ws`);

    ws.onopen = () => {
      reconnectDelay = 2000;
      updateStatus('connected');
    };

    ws.onmessage = (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }

      if (frame.kind === 'message') {
        clearStatusIndicator();
        if (streamingDiv) {
          // Finalize streaming tail
          streamingDiv.innerHTML = renderMarkdown(streamingText);
          highlightBlocks(streamingDiv);
          streamingDiv = null;
          streamingText = '';
        }
        const div = appendMessage('assistant', renderMarkdown(frame.text));
        if (frame.approval) {
          renderApproval(frame.approval, div);
        }
      } else if (frame.kind === 'status') {
        handleStatusEvent(frame);
      } else if (frame.kind === 'chunk') {
        // Streaming chunk — append to tail node
        streamingText += frame.text;
        if (!streamingDiv) {
          streamingDiv = appendMessage('assistant streaming', renderMarkdown(streamingText));
        } else {
          streamingDiv.innerHTML = renderMarkdown(streamingText);
          highlightBlocks(streamingDiv);
        }
        scrollToBottom();
      } else if (frame.kind === 'agent-event') {
        handleAgentEvent(frame);
      } else if (frame.kind === 'mutation-event') {
        handleMutationEvent(frame);
      } else if (frame.kind === 'op-event') {
        handleOpEvent(frame);
      }
    };

    ws.onclose = () => {
      updateStatus('disconnected');
      // Clear live-run tracking — end frames won't arrive on a closed connection
      activeAgentRuns.clear();
      if (activeRunsInterval) { clearInterval(activeRunsInterval); activeRunsInterval = null; }
      document.querySelectorAll('.run-live').forEach(el => el.remove());
      clearStatusIndicator();
      // Drop op pills — /api/state poll will rehydrate any still-active ops
      activeOps.clear();
      if (opTickerInterval) { clearInterval(opTickerInterval); opTickerInterval = null; }
      document.querySelectorAll('.op-pill').forEach(el => el.remove());
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        connect();
      }, reconnectDelay);
    };

    ws.onerror = () => {
      // onclose fires after onerror; reconnect handled there
    };
  }

  function renderApproval(approval, container) {
    const bar = document.createElement('div');
    bar.className = 'approval-bar';
    const prompt = document.createElement('p');
    prompt.textContent = approval.prompt;
    bar.appendChild(prompt);
    for (const opt of approval.options) {
      const btn = document.createElement('button');
      btn.className = 'approval-btn';
      btn.textContent = opt.label;
      btn.onclick = () => sendMessage(opt.value);
      bar.appendChild(btn);
    }
    container.appendChild(bar);
  }

  function sendMessage(text) {
    if (!text.trim() || !ws || ws.readyState !== WebSocket.OPEN) return;
    appendMessage('user', md.render(text));
    ring.push(text);
    if (ring.length > RING_SIZE) ring.shift();
    ringPos = -1;
    ws.send(JSON.stringify({ kind: 'message', text }));
  }

  function updateStatus(status) {
    const el = document.getElementById('ws-status');
    if (el) { el.textContent = status; el.className = `ws-status ${status}`; }
  }

  // Model dropdown
  modelSelect.addEventListener('change', () => {
    pendingModelSwitch = `/${modelSelect.value}`;
  });

  // Form submit
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    let text = input.value;
    if (!text.trim()) return;
    if (pendingModelSwitch) {
      sendMessage(pendingModelSwitch);
      pendingModelSwitch = null;
    }
    sendMessage(text);
    input.value = '';
    input.style.height = 'auto';
  });

  // Keyboard shortcuts
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event('submit'));
      return;
    }
    // Up-arrow with empty input → recall
    if (e.key === 'ArrowUp' && !input.value) {
      e.preventDefault();
      if (ring.length === 0) return;
      if (ringPos === -1) ringPos = ring.length - 1;
      else if (ringPos > 0) ringPos--;
      input.value = ring[ringPos];
      return;
    }
    // Down-arrow when recalling → cycle forward
    if (e.key === 'ArrowDown' && ringPos !== -1) {
      e.preventDefault();
      if (ringPos < ring.length - 1) { ringPos++; input.value = ring[ringPos]; }
      else { ringPos = -1; input.value = ''; }
    }
  });

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });

  // Activity/thinking indicator
  function clearStatusIndicator() {
    const el = document.getElementById('status-indicator');
    if (el) el.remove();
  }

  function handleStatusEvent(frame) {
    clearStatusIndicator();
    if (frame.label != null && frame.label !== '') {
      const div = document.createElement('div');
      div.id = 'status-indicator';
      div.className = 'status-indicator';
      div.innerHTML = `<span class="status-dot"></span><span class="status-label">${escHtml(frame.label)}</span>`;
      messagesEl.appendChild(div);
      scrollToBottom();
    }
  }

  // Live agent-run tracking (from WS agent-event frames)
  const activeAgentRuns = new Map(); // runId → { agent, startedAt, timerEl }
  let activeRunsInterval = null;

  function handleAgentEvent(frame) {
    const runsEl = document.getElementById('runs-content');
    if (!runsEl) return;
    if (frame.subKind === 'start') {
      const row = document.createElement('div');
      row.className = 'run-row run-live';
      const agentSpan = document.createElement('span');
      agentSpan.className = 'run-agent';
      agentSpan.textContent = frame.agent;
      const timerSpan = document.createElement('span');
      timerSpan.className = 'run-meta run-ok';
      timerSpan.textContent = '0s';
      row.append(agentSpan, timerSpan);
      runsEl.insertBefore(row, runsEl.firstChild);
      activeAgentRuns.set(frame.runId, { agent: frame.agent, startedAt: frame.startedAt, timerEl: timerSpan, row });
      if (!activeRunsInterval) {
        activeRunsInterval = setInterval(() => {
          const now = Date.now();
          for (const [, run] of activeAgentRuns) {
            run.timerEl.textContent = fmtDuration(now - new Date(run.startedAt).getTime()) + ' ▶';
          }
        }, 500);
      }
    } else if (frame.subKind === 'end') {
      const run = activeAgentRuns.get(frame.runId);
      activeAgentRuns.delete(frame.runId);
      if (activeAgentRuns.size === 0 && activeRunsInterval) {
        clearInterval(activeRunsInterval);
        activeRunsInterval = null;
      }
      // Remove live row by stored reference; bust poll cache so recent-runs panel updates
      if (run) run.row.remove();
      lastStateJson = '';
    }
  }

  // ---- In-flight op pills ----
  // Each visible Claude CLI spawn renders a cancellable pill in the chat
  // until it ends. Classifier ops (sub-second resolver calls) are filtered
  // out by the bus → sender layer before reaching the WS, so we only see
  // user-facing ops here.
  const activeOps = new Map(); // opId → { label, startedAt (ms), pillEl, elapsedEl }
  let opTickerInterval = null;

  function upsertOpPill(op) {
    // op: { opId, label, startedAt (iso string), elapsedMs }
    const startedAtMs = new Date(op.startedAt).getTime();
    const existing = activeOps.get(op.opId);
    if (existing) {
      existing.startedAt = startedAtMs;
      return;
    }
    const pill = document.createElement('div');
    pill.className = 'op-pill';
    pill.id = `op-pill-${op.opId}`;
    pill.innerHTML =
      `<span class="op-spinner"></span>` +
      `<span class="op-label">${escHtml(op.label)}</span>` +
      `<span class="op-elapsed">${Math.floor((op.elapsedMs ?? 0) / 1000)}s</span>` +
      `<button class="op-cancel" title="Cancel">✕</button>`;
    const cancelBtn = pill.querySelector('.op-cancel');
    cancelBtn.addEventListener('click', () => {
      cancelBtn.disabled = true;
      fetch(`/api/ops/${encodeURIComponent(op.opId)}/cancel`, { method: 'POST' })
        .catch(() => { cancelBtn.disabled = false; });
    });
    messagesEl.appendChild(pill);
    activeOps.set(op.opId, {
      label: op.label,
      startedAt: startedAtMs,
      pillEl: pill,
      elapsedEl: pill.querySelector('.op-elapsed'),
    });
    scrollToBottom();
    if (!opTickerInterval) {
      opTickerInterval = setInterval(() => {
        const now = Date.now();
        for (const [, entry] of activeOps) {
          const secs = Math.floor((now - entry.startedAt) / 1000);
          entry.elapsedEl.textContent = `${secs}s`;
        }
      }, 1000);
    }
  }

  function removeOpPill(opId) {
    const entry = activeOps.get(opId);
    if (!entry) return;
    entry.pillEl.remove();
    activeOps.delete(opId);
    if (activeOps.size === 0 && opTickerInterval) {
      clearInterval(opTickerInterval);
      opTickerInterval = null;
    }
  }

  function handleOpEvent(frame) {
    // frame: { kind, opId, opKind, label, agent?, startedAt, elapsedMs, subKind, ... }
    if (frame.opKind === 'classifier') return; // safety net — sender already filters
    if (frame.subKind === 'start' || frame.subKind === 'progress') {
      upsertOpPill(frame);
    } else if (frame.subKind === 'end') {
      removeOpPill(frame.opId);
    }
  }

  // Cockpit state polling with diff-render
  let lastStateJson = '';

  function setText(el, text, muted) {
    if (el.textContent !== text) el.textContent = text;
    if (muted !== undefined) el.classList.toggle('muted', muted);
  }

  function setHTML(el, html) {
    if (el.dataset.lastHtml !== html) {
      el.innerHTML = html;
      el.dataset.lastHtml = html;
    }
  }

  function pollState() {
    fetch('/api/state').then(r => r.json()).then(state => {
      const json = JSON.stringify(state);
      if (json === lastStateJson) return;
      lastStateJson = json;
      renderState(state);
    }).catch(() => {});
  }

  function fmtDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
  }

  function fmtRelative(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  function renderState(state) {
    // Session panel
    const sessionEl = document.getElementById('session-content');
    if (state.activeSession) {
      const s = state.activeSession;
      setText(sessionEl, `${s.sessionId.slice(0, 8)} · ${s.model} · ${s.messageCount} msgs`, false);
    } else {
      setText(sessionEl, 'No active session', true);
    }

    // Queue panel
    const queueEl = document.getElementById('queue-content');
    const depth = state.ingestionQueueDepth ?? 0;
    setText(queueEl, `${depth} pending`, depth === 0);

    // Review panel
    const reviewEl = document.getElementById('review-content');
    if (state.activeReview) {
      const r = state.activeReview;
      setText(reviewEl, `${r.type} · ${r.phase}`, false);
    } else {
      setText(reviewEl, 'None', true);
    }

    // Approvals panel
    const approvalsEl = document.getElementById('approvals-content');
    const pb = state.pendingApprovals?.playbook ?? 0;
    const pr = state.pendingApprovals?.proposal ?? 0;
    const total = pb + pr;
    setText(approvalsEl, total === 0 ? 'None' : `${pb} playbook · ${pr} proposal`, total === 0);

    // Recent agent runs panel
    const runsEl = document.getElementById('runs-content');
    const runs = state.recentAgentRuns ?? [];
    if (runs.length === 0) {
      setHTML(runsEl, '<span class="muted">No runs yet</span>');
    } else {
      const html = runs.slice(0, 5).map(r => {
        const cls = r.status === 'error' ? 'run-error' : 'run-ok';
        return `<div class="run-row"><span class="run-agent">${escHtml(r.agent)}</span><span class="${cls} run-meta">${escHtml(fmtDuration(r.durationMs))} · ${escHtml(fmtRelative(r.startedAt))}</span></div>`;
      }).join('');
      setHTML(runsEl, html);
    }

    // Projects panel
    renderProjects(state.projects ?? []);

    // Mutations panel
    renderMutations(state.mutations ?? { active: [], recent: [] });

    // In-flight op pills — hydrate any ops we don't already track. End-frame
    // arrival via WS still removes them; this just covers tab-opened-mid-run.
    const inFlight = (state.inFlight ?? []).filter(op => op.kind !== 'classifier');
    const seen = new Set();
    for (const op of inFlight) {
      seen.add(op.opId);
      upsertOpPill(op);
    }
    for (const opId of activeOps.keys()) {
      if (!seen.has(opId)) removeOpPill(opId);
    }
  }

  // ---- Projects panel ----

  // Track active work-run slugs to disable their buttons
  const runningProjectSlugs = new Set();

  function renderProjects(projects) {
    const el = document.getElementById('projects-content');
    if (!el) return;
    if (projects.length === 0) {
      setHTML(el, '<span class="muted">No projects found</span>');
      return;
    }
    // Update running slugs from state
    runningProjectSlugs.clear();

    const html = projects.map(p => {
      const done = p.progress?.done ?? 0;
      const total = p.progress?.total ?? 0;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const statusCls = statusPillClass(p.status);
      const slug = p.slug;
      return `<div class="project-row">` +
        `<div class="project-header">` +
        `<span class="project-slug">${escHtml(slug)}</span>` +
        `<span class="status-pill ${statusCls}">${escHtml(p.status)}</span>` +
        `</div>` +
        `<div class="project-footer">` +
        `<div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%"></div></div>` +
        `<span class="progress-text">${done}/${total}</span>` +
        `<button class="run-btn" data-slug="${escHtml(slug)}" onclick="window._runWorkAuto('${escHtml(slug)}')">Run /work --auto</button>` +
        `</div>` +
        `</div>`;
    }).join('');
    setHTML(el, html);
  }

  function statusPillClass(status) {
    const s = (status || '').toLowerCase();
    if (s === 'done' || s.startsWith('done')) return 'pill-done';
    if (s === 'in progress') return 'pill-inprogress';
    if (s === 'spec') return 'pill-spec';
    return 'pill-default';
  }

  // Expose to onclick handlers (IIFE scope)
  window._runWorkAuto = function(slug) {
    showConfirmModal(slug);
  };

  // ---- Confirmation modal ----

  let modalSlug = null;

  function showConfirmModal(slug) {
    modalSlug = slug;
    const modal = document.getElementById('confirm-modal');
    const slugEl = document.getElementById('modal-slug');
    if (modal && slugEl) {
      slugEl.textContent = slug;
      modal.classList.remove('hidden');
    }
  }

  function hideConfirmModal() {
    modalSlug = null;
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.classList.add('hidden');
  }

  document.getElementById('modal-cancel')?.addEventListener('click', hideConfirmModal);

  document.getElementById('modal-run')?.addEventListener('click', () => {
    const slug = modalSlug;
    hideConfirmModal();
    if (!slug) return;
    fetch('/api/mutations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'work-run', payload: { projectSlug: slug } }),
    }).then(r => r.json()).then(data => {
      if (data.error) {
        appendMessage('assistant', `<p>Error: ${escHtml(data.error)}</p>`);
      } else {
        appendMessage('assistant', `<p>Started /work --auto for <strong>${escHtml(slug)}</strong> (id: ${escHtml(data.id)})</p>`);
        lastStateJson = ''; // bust poll cache
      }
    }).catch(() => {
      appendMessage('assistant', '<p>Failed to start work run.</p>');
    });
  });

  // ---- Mutations panel ----

  // Track active mutations and their drawer state
  const activeMutationTimers = new Map(); // mutationId → { timerEl, startedAt, row }
  let mutationTimerInterval = null;

  // Drawer state
  let drawerMutationId = null;
  const drawerLines = [];

  function renderMutations(mutations) {
    renderActiveMutations(mutations.active ?? []);
    renderRecentMutations(mutations.recent ?? []);

    // Update running project slugs for button state
    for (const m of mutations.active ?? []) {
      if (m.kind === 'work-run' && m.payload?.projectSlug) {
        runningProjectSlugs.add(m.payload.projectSlug);
      }
    }
    updateRunButtons();
  }

  function updateRunButtons() {
    document.querySelectorAll('.run-btn').forEach(btn => {
      const slug = btn.dataset.slug;
      if (runningProjectSlugs.has(slug)) {
        btn.textContent = 'Running…';
        btn.disabled = true;
      } else {
        btn.textContent = 'Run /work --auto';
        btn.disabled = false;
      }
    });
  }

  function renderActiveMutations(active) {
    const el = document.getElementById('mutations-active-content');
    if (!el) return;
    if (active.length === 0) {
      setHTML(el, '<span class="muted">None</span>');
      // Stop timer if no active runs
      if (activeMutationTimers.size === 0 && mutationTimerInterval) {
        clearInterval(mutationTimerInterval);
        mutationTimerInterval = null;
      }
      return;
    }
    for (const m of active) {
      if (!activeMutationTimers.has(m.id)) {
        // New active — add row
        const row = document.createElement('div');
        row.className = 'mutation-row mutation-active';
        row.dataset.mutationId = m.id;
        const slug = escHtml(String(m.payload?.projectSlug ?? m.id.slice(0, 8)));
        const timerSpan = document.createElement('span');
        timerSpan.className = 'run-meta run-ok';
        timerSpan.textContent = '0s ▶';
        row.innerHTML = `<span class="run-agent">${slug}</span>`;
        row.append(timerSpan);
        row.addEventListener('click', () => openDrawer(m.id, String(m.payload?.projectSlug ?? m.id)));
        el.insertBefore(row, el.firstChild);
        activeMutationTimers.set(m.id, { timerEl: timerSpan, startedAt: m.createdAt, row });
        if (!mutationTimerInterval) {
          mutationTimerInterval = setInterval(() => {
            const now = Date.now();
            for (const [, entry] of activeMutationTimers) {
              entry.timerEl.textContent = fmtDuration(now - new Date(entry.startedAt).getTime()) + ' ▶';
            }
          }, 500);
        }
      }
    }
    // Remove rows for mutations that are no longer active
    const activeIds = new Set(active.map(m => m.id));
    for (const [id, entry] of activeMutationTimers) {
      if (!activeIds.has(id)) {
        entry.row.remove();
        activeMutationTimers.delete(id);
      }
    }
    if (activeMutationTimers.size === 0 && mutationTimerInterval) {
      clearInterval(mutationTimerInterval);
      mutationTimerInterval = null;
    }
  }

  function renderRecentMutations(recent) {
    const el = document.getElementById('mutations-recent-content');
    if (!el) return;
    const shown = recent.slice(0, 5);
    if (shown.length === 0) {
      setHTML(el, '<span class="muted">No recent runs</span>');
      return;
    }
    const html = shown.map(m => {
      const cls = m.status === 'completed' ? 'run-ok' : 'run-error';
      const slug = escHtml(String(m.payload?.projectSlug ?? m.id.slice(0, 8)));
      return `<div class="mutation-row" data-mutation-id="${escHtml(m.id)}" onclick="window._openMutationDrawer('${escHtml(m.id)}', '${slug}')">` +
        `<span class="run-agent">${slug}</span>` +
        `<span class="${cls} run-meta">${escHtml(m.status)}</span>` +
        `</div>`;
    }).join('');
    setHTML(el, html);
  }

  // ---- Run detail drawer ----

  window._openMutationDrawer = function(mutationId, label) {
    openDrawer(mutationId, label);
  };

  function openDrawer(mutationId, label) {
    drawerMutationId = mutationId;
    drawerLines.length = 0;
    const drawer = document.getElementById('mutation-drawer');
    const drawerTitle = document.getElementById('drawer-title');
    const drawerOutput = document.getElementById('drawer-output');
    if (!drawer || !drawerTitle || !drawerOutput) return;
    drawerTitle.textContent = label;
    drawerOutput.textContent = '';
    drawer.classList.remove('hidden');
  }

  document.getElementById('drawer-close')?.addEventListener('click', () => {
    drawerMutationId = null;
    drawerLines.length = 0;
    document.getElementById('mutation-drawer')?.classList.add('hidden');
  });

  function handleMutationEvent(frame) {
    // Update active mutations timer if this is a new event
    if (frame.subKind === 'output' && drawerMutationId === frame.mutationId) {
      const line = String(frame.data?.line ?? '');
      drawerLines.push(line);
      const drawerOutput = document.getElementById('drawer-output');
      if (drawerOutput) {
        drawerOutput.textContent = drawerLines.join('\n');
        drawerOutput.scrollTop = drawerOutput.scrollHeight;
      }
    }
    if (frame.subKind === 'completed' || frame.subKind === 'failed') {
      // Bust poll cache so mutations panel refreshes
      lastStateJson = '';
      // Remove from active timers
      const entry = activeMutationTimers.get(frame.mutationId);
      if (entry) {
        entry.row.remove();
        activeMutationTimers.delete(frame.mutationId);
        if (activeMutationTimers.size === 0 && mutationTimerInterval) {
          clearInterval(mutationTimerInterval);
          mutationTimerInterval = null;
        }
      }
      if (drawerMutationId === frame.mutationId) {
        const status = frame.subKind === 'completed' ? '✅ Completed' : `❌ Failed: ${String(frame.data?.reason ?? '')}`;
        drawerLines.push(`\n--- ${status} ---`);
        const drawerOutput = document.getElementById('drawer-output');
        if (drawerOutput) {
          drawerOutput.textContent = drawerLines.join('\n');
          drawerOutput.scrollTop = drawerOutput.scrollHeight;
        }
      }
    }
  }

  // Init
  connect();
  pollState();
  setInterval(pollState, 5000);
})();
