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
        // Reply arrived. If an op is still attached we leave the pill alone —
        // its op-event:end will clean up. Otherwise drop the passive pill.
        if (!chatStatus.hasOp()) chatStatus.clear();
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
        chatStatus.setStatus(frame.label);
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
        if (frame.opKind === 'classifier') return; // safety net — sender filters
        if (frame.subKind === 'start') {
          chatStatus.attachOp(frame.opId, frame.label, frame.startedAt);
          activityPanel.start(frame.label);
        } else if (frame.subKind === 'progress') {
          chatStatus.tickOp(frame.opId, frame.startedAt);
          if (frame.detail) activityPanel.append(frame.detail);
        } else if (frame.subKind === 'end') {
          chatStatus.detachOp(frame.opId);
          activityPanel.markDone(frame.status);
        }
      }
    };

    ws.onclose = () => {
      updateStatus('disconnected');
      // Clear live-run tracking — end frames won't arrive on a closed connection
      activeAgentRuns.clear();
      if (activeRunsInterval) { clearInterval(activeRunsInterval); activeRunsInterval = null; }
      document.querySelectorAll('.run-live').forEach(el => el.remove());
      // Drop chat status pill — /api/state poll will rehydrate any still-active op.
      chatStatus.clear();
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

  // Unified chat status pill. Driven by both `status` frames (startTyping /
  // stopTyping) and `op-event` frames (cancellable, with elapsed timer).
  // Pinned above the input form so it stays visible regardless of scroll.
  const chatStatus = (() => {
    const mainEl = document.getElementById('main');
    const formEl = document.getElementById('input-form');
    let el = null;
    let labelEl = null;
    let elapsedEl = null;
    let moreEl = null;
    let cancelBtn = null;
    let ticker = null;
    let currentOpId = null;
    let opStartedAtMs = 0;
    let currentLabel = '';
    let moreCount = 0;

    function ensure() {
      if (el) return;
      el = document.createElement('div');
      el.id = 'chat-status';
      el.className = 'chat-status';
      el.setAttribute('aria-live', 'polite');
      const spinner = document.createElement('span');
      spinner.className = 'cs-spinner';
      labelEl = document.createElement('span');
      labelEl.className = 'cs-label';
      elapsedEl = document.createElement('span');
      elapsedEl.className = 'cs-elapsed';
      moreEl = document.createElement('span');
      moreEl.className = 'cs-more';
      el.append(spinner, labelEl, elapsedEl, moreEl);
      mainEl.insertBefore(el, formEl);
      paintMore();
    }

    function destroy() {
      if (ticker) { clearInterval(ticker); ticker = null; }
      if (cancelBtn) cancelBtn = null;
      if (el) { el.remove(); el = null; }
      labelEl = elapsedEl = moreEl = null;
      currentOpId = null;
      currentLabel = '';
      opStartedAtMs = 0;
      moreCount = 0;
    }

    function paintLabel(text) {
      currentLabel = text;
      if (labelEl) labelEl.textContent = text;
    }

    function paintElapsed() {
      if (!elapsedEl) return;
      if (opStartedAtMs > 0) {
        const secs = Math.floor((Date.now() - opStartedAtMs) / 1000);
        elapsedEl.textContent = `· ${secs}s`;
      } else {
        elapsedEl.textContent = '';
      }
    }

    function paintMore() {
      if (!moreEl) return;
      moreEl.textContent = moreCount > 0 ? `· +${moreCount} more` : '';
    }

    function addCancelButton(opId) {
      if (cancelBtn) return;
      cancelBtn = document.createElement('button');
      cancelBtn.className = 'cs-cancel';
      cancelBtn.title = 'Cancel';
      cancelBtn.textContent = '✕';
      cancelBtn.addEventListener('click', () => {
        cancelBtn.disabled = true;
        fetch(`/api/ops/${encodeURIComponent(opId)}/cancel`, { method: 'POST' })
          .catch(() => { if (cancelBtn) cancelBtn.disabled = false; });
      });
      el.appendChild(cancelBtn);
    }

    function removeCancelButton() {
      if (cancelBtn) { cancelBtn.remove(); cancelBtn = null; }
    }

    return {
      // Called on { kind: 'status', label } frames. Plain spinner + label, no cancel.
      setStatus(label) {
        if (label == null || label === '') {
          // stopTyping arrived. If an op is still attached, keep the pill;
          // otherwise drop it.
          if (currentOpId) return;
          destroy();
          return;
        }
        ensure();
        paintLabel(label);
        paintElapsed();
      },
      // Called on { kind: 'op-event', subKind: 'start' }. Upgrades pill with
      // friendly label + elapsed counter + cancel button.
      attachOp(opId, label, startedAtIso) {
        ensure();
        currentOpId = opId;
        opStartedAtMs = new Date(startedAtIso).getTime();
        paintLabel(label);
        paintElapsed();
        addCancelButton(opId);
        if (!ticker) ticker = setInterval(paintElapsed, 1000);
      },
      // Called on { subKind: 'progress' }. Reconciler if local ticker drifted.
      tickOp(opId, startedAtIso) {
        if (currentOpId !== opId) return;
        opStartedAtMs = new Date(startedAtIso).getTime();
        paintElapsed();
      },
      // Called on { subKind: 'end' }. Removes elapsed + cancel; keeps the pill
      // only if a passive status is still active.
      detachOp(opId) {
        if (currentOpId !== opId) return;
        currentOpId = null;
        opStartedAtMs = 0;
        if (ticker) { clearInterval(ticker); ticker = null; }
        removeCancelButton();
        paintElapsed();
        // If we never had a passive label (just the op), drop the pill.
        if (!currentLabel) destroy();
      },
      // Force-clear (used on WS disconnect or when a message reply arrives).
      clear() { destroy(); },
      // Whether an op is currently attached — used to keep `message` frame
      // arrival from yanking the pill out from under an in-flight op.
      hasOp() { return currentOpId !== null; },
      // Concurrent-op count beyond the attached one; rendered as "+N more".
      setMoreCount(n) {
        moreCount = n;
        paintMore();
      },
    };
  })();

  // Sidebar "Claude Activity" panel — live trace of tool calls inside the
  // current Claude op. Driven by op-event progress frames with `detail`.
  // Capped at 50 rows (oldest dropped). Persists until the next op starts.
  const activityPanel = (() => {
    const contentEl = document.getElementById('activity-content');
    const MAX_ROWS = 50;
    let rowCount = 0;
    let lastDetail = '';

    function ts() {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function reset() {
      contentEl.innerHTML = '<span class="muted">Idle</span>';
      rowCount = 0;
      lastDetail = '';
    }

    function appendRow(text, extraClass) {
      // First real row replaces the "Idle" placeholder.
      if (rowCount === 0) contentEl.innerHTML = '';
      const row = document.createElement('div');
      row.className = extraClass ? `activity-row ${extraClass}` : 'activity-row';
      row.textContent = `[${ts()}] · ${text}`;
      contentEl.appendChild(row);
      rowCount++;
      // Drop oldest if over cap.
      while (rowCount > MAX_ROWS) {
        const first = contentEl.firstChild;
        if (!first) break; // defensive: invariant says rowCount tracks children
        contentEl.removeChild(first);
        rowCount--;
      }
      contentEl.scrollTop = contentEl.scrollHeight;
    }

    return {
      start(label) {
        reset();
        appendRow(label || 'Started', 'activity-start');
      },
      append(detail) {
        // Skip duplicate consecutive details (the same tool_use can republish
        // on the 5s heartbeat after the immediate setOpDetail emission).
        if (detail === lastDetail) return;
        lastDetail = detail;
        appendRow(detail);
      },
      markDone(status) {
        const cls = status === 'cancelled' ? 'activity-cancelled' : 'activity-done';
        const text = status === 'cancelled' ? '⊘ cancelled' : '✓ done';
        appendRow(text, cls);
      },
      // Used by /api/state hydration when a tab opens mid-flight.
      hydrate(label, detail) {
        if (rowCount > 0) return;
        appendRow(label || 'Running', 'activity-start');
        if (detail) appendRow(detail);
      },
    };
  })();

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

  // Cockpit state polling with diff-render
  let lastStateJson = '';
  let lastCockpitJson = '';

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

  function pollCockpit() {
    fetch('/api/cockpit').then(r => r.json()).then(view => {
      const json = JSON.stringify(view);
      if (json === lastCockpitJson) return;
      lastCockpitJson = json;
      renderCockpit(view);
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

    // Approvals panel: Phase 6 C2 — owned by fetchAndRenderApprovals()
    // below, which polls GET /api/approvals for row-level data. The
    // count-only summary from state.pendingApprovals is no longer rendered
    // here — the dedicated poller replaces it with per-row Approve/Reject/
    // Open buttons.

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

    // Projects panel removed — the Cockpit panel below subsumes it
    // (per-project task progress + lifecycle status + actions, all via
    // GET /api/cockpit). state.projects is still computed server-side but
    // no longer rendered by any sidebar surface.

    // Mutations panel
    renderMutations(state.mutations ?? { active: [], recent: [] });

    // Chat status pill — hydrate from in-flight ops when we don't already have
    // one attached (covers tab-opened-mid-run). End frames over WS still drive
    // detach for the active op. Single-pill design: when multiple ops are
    // running, attach the most-recently-started one and append a "+N more"
    // hint so the user knows the rest exist. (The recent-runs sidebar panel
    // shows full agent-level history.)
    const inFlight = (state.inFlight ?? [])
      .filter(op => op.kind !== 'classifier')
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    if (!chatStatus.hasOp() && inFlight.length > 0) {
      const op = inFlight[0];
      chatStatus.attachOp(op.opId, op.label, op.startedAt);
      activityPanel.hydrate(op.label, op.detail);
    }
    chatStatus.setMoreCount(Math.max(0, inFlight.length - (chatStatus.hasOp() ? 1 : 0)));
  }

  // Returns only fixed CSS-class constants — safe to interpolate into a class attribute.
  function statusPillClass(status) {
    const s = (status || '').toLowerCase();
    if (s === 'done' || s.startsWith('done')) return 'pill-done';
    if (s === 'in progress' || s === 'active') return 'pill-inprogress';
    if (s === 'spec' || s === 'planned') return 'pill-spec';
    return 'pill-default';
  }

  // ---- Cockpit panel (product/project registry view) ----

  function renderCockpit(view) {
    const el = document.getElementById('cockpit-content');
    if (!el) return;
    // buildCockpitView turns a missing or corrupt registry into a clean unavailable view.
    if (!view || view.available !== true) {
      const reason = (view && view.unavailableReason) || 'cockpit unavailable';
      setHTML(el, `<span class="muted">${escHtml(reason)}</span>`);
      return;
    }
    const products = view.products || [];
    if (products.length === 0) {
      setHTML(el, '<span class="muted">No products registered</span>');
      return;
    }
    // Filter lifecycle-`done` projects per product, but KEEP every product
    // header visible so the user always sees the full product lineup. A
    // product whose project list is empty after filtering renders an
    // inline "all done" placeholder inside its card. The global "No
    // products registered" fallback above only fires when the registry
    // itself has zero products — not when products exist but their
    // projects are all done.
    const visibleProducts = products.map(product => ({
      ...product,
      projects: (product.projects || []).filter(p => p.lifecycleStatus !== 'done'),
    }));
    const html = visibleProducts.map(product => {
      const projects = product.projects;
      const rows = projects.length === 0
        ? '<div class="cockpit-empty muted">all done</div>'
        : projects.map(proj => {
            const run = proj.runStatus && proj.runStatus !== 'idle'
              ? ` <span class="run-pill">${escHtml(proj.runStatus)}</span>`
              : '';
            // Each action is its own explicit-click control — gated per-action. Slug and
            // action ride in data-* attributes (not inline onclick) so a registry-derived
            // slug never lands in a JS-in-HTML-attribute context; a delegated listener on
            // #cockpit-content dispatches the click.
            const actions = (proj.actions || []).map(action =>
              `<button class="cockpit-action-btn" data-slug="${escHtml(proj.slug)}" ` +
                `data-product="${escHtml(product.name)}" ` +
                `data-action="${escHtml(action)}">${escHtml(cockpitActionLabel(action))}</button>`,
            ).join('');
            // C3.2: render the in-flight gen-eval-loop progress block when
            // proj.progress is present (round / failed evaluator / heartbeat /
            // models + Cancel). A non-parseable lastHeartbeatAt is treated as
            // stalled (amber), mirroring src/intent/supervision.ts.
            const liveProgressHtml = proj.progress ? renderCockpitProgress(proj.progress) : '';
            // Static task progress bar (done / total) — sourced from tasks.md
            // via getProjectSummaries() and passed through buildCockpitView's
            // third arg. Reuses the same .progress-bar-wrap / .progress-text
            // CSS classes the removed Projects panel used.
            const taskProgressHtml = proj.taskProgress ? renderTaskProgress(proj.taskProgress) : '';
            return `<div class="cockpit-project">` +
              `<div class="cockpit-project-header">` +
                `<span class="project-slug">${escHtml(proj.slug)}</span>` +
                `<span class="status-pill ${statusPillClass(proj.lifecycleStatus)}">${escHtml(proj.lifecycleStatus)}</span>` +
                run +
              `</div>` +
              taskProgressHtml +
              liveProgressHtml +
              `<div class="cockpit-actions">${actions}</div>` +
              `</div>`;
          }).join('');
      const trackedLabel = product.repoBacked ? '' : ' <span class="cockpit-tracked muted">tracked</span>';
      return `<div class="cockpit-product">` +
        `<div class="cockpit-product-name">${escHtml(product.name)}${trackedLabel}</div>` +
        rows +
        `</div>`;
    }).join('');
    setHTML(el, html);
  }

  // Render the static task-progress bar for a cockpit project card. Same
  // markup the (removed) Projects sidebar panel used — keeps the CSS
  // classes (.progress-bar-wrap, .progress-bar-fill, .progress-text)
  // single-sourced. NaN-guards on both values so a malformed tasks.md
  // can't produce NaN% in the inline style.
  function renderTaskProgress(tp) {
    const done = Number.isFinite(tp.done) ? tp.done : 0;
    const total = Number.isFinite(tp.total) ? tp.total : 0;
    // Clamp to [0, 100] in case a malformed tasks.md reports done > total
    // — the bar would otherwise overflow semantically (CSS overflow:hidden
    // hides the visual but the inline style would still be > 100%).
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return `<div class="cockpit-task-progress">` +
      `<div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%"></div></div>` +
      `<span class="progress-text">${escHtml(String(done))}/${escHtml(String(total))}</span>` +
      `</div>`;
  }

  // C3.2: render the in-flight progress block (round / failed / heartbeat /
  // models + Cancel button) for a project with an active gen-eval-loop. The
  // shape is `CockpitProgress` from src/intent/cockpit.ts. Pure HTML build —
  // delegated click handler (`handleCockpitClick`) wires the Cancel button.
  // Heartbeat staleness threshold matches src/jobs/stall-check.ts.
  const STALL_THRESHOLD_MS = 5 * 60 * 1000;
  function renderCockpitProgress(progress) {
    const round = Number.isFinite(progress.round) ? progress.round : 1;
    const cap = Number.isFinite(progress.cap) ? progress.cap : null;
    const failed = Number.isFinite(progress.failedEvaluatorRounds) ? progress.failedEvaluatorRounds : 0;
    const heartbeatMs = Date.parse(progress.lastHeartbeatAt ?? '');
    const ageMs = Number.isFinite(heartbeatMs) ? (Date.now() - heartbeatMs) : NaN;
    // Non-parseable heartbeat → treat as stalled (amber). Same invariant the
    // supervision module enforces — never crash, always surface as stale.
    const stale = !Number.isFinite(ageMs) || ageMs >= STALL_THRESHOLD_MS;
    const ageLabel = Number.isFinite(ageMs) ? fmtAge(ageMs) : 'no heartbeat';
    const roundLabel = cap !== null ? `round ${round} / ${cap}` : `round ${round}`;
    // Models line — omit entirely when neither is set (A7 hasn't landed in
    // the data feed yet).
    const gen = progress.modelGen ? `gen: ${escHtml(progress.modelGen)}` : '';
    const evalLabel = progress.modelEval ? `eval: ${escHtml(progress.modelEval)}` : '';
    const modelsLine = (gen || evalLabel)
      ? `<div class="cockpit-progress-models">${[gen, evalLabel].filter(Boolean).join(' · ')}</div>`
      : '';
    const cancelBtn = progress.mutationId
      ? `<button class="cockpit-cancel-btn" data-mutation-id="${escHtml(progress.mutationId)}">Cancel</button>`
      : '';
    return `<div class="cockpit-progress">` +
      `<div class="cockpit-progress-line">` +
        `<span>${escHtml(roundLabel)}</span>` +
        `<span class="dot">·</span>` +
        // escHtml(String(failed)) for pattern consistency with the other
        // user-derived spans on this row — the Number.isFinite guard above
        // already proves `failed` is a number, but keeping every interpolated
        // value behind escHtml removes the implicit type-safety dependency.
        `<span>failed evaluator: ${escHtml(String(failed))}</span>` +
        `<span class="dot">·</span>` +
        `<span class="cockpit-heartbeat${stale ? ' cockpit-heartbeat-stale' : ''}">${escHtml(ageLabel)}</span>` +
      `</div>` +
      modelsLine +
      (cancelBtn ? `<div class="cockpit-progress-actions">${cancelBtn}</div>` : '') +
      `</div>`;
  }
  function fmtAge(ms) {
    if (ms < 0) return 'just now';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }

  function cockpitActionLabel(action) {
    if (action === 'start') return 'Start';
    if (action === 'continue') return 'Continue';
    if (action === 'enter-planning-mode') return 'Plan';
    return action;
  }

  // Cockpit per-project actions. start/continue dispatch /work --auto (gated by the
  // confirmation modal); enter-planning-mode dispatches `/plan <product>` through the chat
  // surface — the Planner conversation (Layer 1) runs in the chat panel until the dedicated
  // planning panel (Track C1) lands.
  function cockpitAction(slug, action, product) {
    if (action === 'enter-planning-mode') {
      // C1.3: open the dedicated planning panel rather than dispatching
      // `/plan <product>` through the chat plumbing. The panel is the user
      // surface for the planning conversation; the previous chat-dispatch
      // fallback (A4.3) is replaced now that C1.1's panel exists.
      if (!product) return;
      if (typeof window.openPlanningPanel === 'function') {
        window.openPlanningPanel(product);
      } else {
        // Defensive: if the panel JS didn't load (e.g., during a partial
        // reload), fall back to the chat dispatch so the user can still
        // start a planning session.
        sendMessage(`/plan ${product}`);
      }
      return;
    }
    if (action === 'start' || action === 'continue') {
      // start / continue both dispatch /work --auto — explicit per-action confirmation first.
      showConfirmModal(slug);
      return;
    }
    // Unknown future action — do nothing rather than mis-dispatching a work run.
  }

  // Delegated click handler — attached once to the static #cockpit-content container so it
  // survives setHTML re-renders. Reading data-* attributes avoids inline onclick entirely.
  function handleCockpitClick(e) {
    // C3.2: Cancel button on the in-flight progress block routes to
    // POST /api/mutations/<id>/cancel. Disable the button on click so a
    // double-tap doesn't fire two cancels — re-enable on transport error so
    // the user can retry.
    const cancelBtn = e.target.closest('.cockpit-cancel-btn');
    if (cancelBtn) {
      const id = cancelBtn.dataset.mutationId;
      if (!id) return;
      cancelBtn.disabled = true;
      fetch(`/api/mutations/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
        .catch(() => { cancelBtn.disabled = false; });
      return;
    }
    const btn = e.target.closest('.cockpit-action-btn');
    if (!btn) return;
    cockpitAction(btn.dataset.slug, btn.dataset.action, btn.dataset.product);
  }

  // ---- Pending Approvals panel (Phase 6 C2) ----
  //
  // Polls GET /api/approvals and renders one row per pending entry across
  // intent-proposal-queue, playbook-queue, ask-twice proposal-queue, and
  // supervision `blocked-on-human` runs. Each row carries data-approval-id +
  // data-action and is dispatched by handleApprovalsClick. Mirrors the
  // pollCockpit + handleCockpitClick pattern above so the panel survives
  // setHTML re-renders without per-button listeners.
  let lastApprovalsJson = '';
  function pollApprovals() {
    fetch('/api/approvals')
      .then(r => {
        // Treat a non-OK response (e.g., 500 with {"error": "approvals list failed"})
        // as a poll failure rather than calling r.json() and silently rendering
        // "None" — the catch leaves the previously-rendered rows in place.
        if (!r.ok) throw new Error(`approvals fetch returned ${r.status}`);
        return r.json();
      })
      .then(rows => {
        const json = JSON.stringify(rows);
        if (json === lastApprovalsJson) return;
        lastApprovalsJson = json;
        renderApprovals(rows);
      })
      .catch(() => { /* network blip or server error — next tick retries */ });
  }
  function renderApprovals(rows) {
    const el = document.getElementById('approvals-content');
    if (!el) return;
    if (!Array.isArray(rows) || rows.length === 0) {
      setHTML(el, '<span class="muted">None</span>');
      return;
    }
    const html = rows.map(renderApprovalRow).join('');
    setHTML(el, html);
  }
  function renderApprovalRow(row) {
    // Defensive coercion — every interpolated field goes through escHtml.
    const id = String(row.id ?? '');
    const type = String(row.type ?? '');
    const pp = String(row.productProject ?? '—');
    const summary = String(row.summary ?? '');
    const age = Number.isFinite(row.age) ? fmtAge(row.age * 1000) : '';
    // blocked-on-human rows are queue-uneditable (dispatchApprovalStatus
    // returns 'not-found' for that source) — render the buttons as disabled
    // so a user click can't appear to do nothing.
    const isBlocked = type === 'blocked-on-human';
    const disabledAttr = isBlocked ? ' disabled' : '';
    const approveBtn = `<button class="approval-btn approval-btn-approve" ` +
      `data-approval-id="${escHtml(id)}" data-action="approve"${disabledAttr}>Approve</button>`;
    const rejectBtn = `<button class="approval-btn approval-btn-reject" ` +
      `data-approval-id="${escHtml(id)}" data-action="reject"${disabledAttr}>Reject</button>`;
    const openBtn = `<button class="approval-btn approval-btn-open" ` +
      `data-approval-id="${escHtml(id)}" data-action="open">Open</button>`;
    return `<div class="approval-row">` +
      `<div class="approval-row-head">` +
        `<span class="approval-row-product">${escHtml(pp)}</span>` +
        `<span class="approval-row-type">${escHtml(type)}</span>` +
      `</div>` +
      `<div class="approval-row-summary">${escHtml(summary)}</div>` +
      `<div class="approval-row-meta"><span class="approval-row-age">${escHtml(age)}</span></div>` +
      `<div class="approval-row-actions">${approveBtn}${rejectBtn}${openBtn}</div>` +
      `</div>`;
  }
  function handleApprovalsClick(e) {
    // Disabled buttons don't fire click events in the browser, so the
    // disabled state itself is the gate — no `btn.disabled` check needed
    // (matches the handleCockpitClick pattern).
    const btn = e.target.closest('.approval-btn');
    if (!btn) return;
    const id = btn.dataset.approvalId;
    const action = btn.dataset.action;
    if (!id || !action) return;
    if (action === 'approve' || action === 'reject') {
      btn.disabled = true;
      // Both segments encoded defensively — `action` is one of two literals
      // today (the strict equality above proves it), but encoding makes the
      // safety explicit so a relaxed guard in the future can't introduce a
      // malformed URL.
      fetch(`/api/approvals/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { method: 'POST' })
        .then((r) => {
          if (!r.ok) {
            // Re-enable so the user can retry. The next poll will refresh
            // the row if the server-side state actually changed.
            btn.disabled = false;
          } else {
            // Bust the cache so the next poll re-renders without this row.
            lastApprovalsJson = '';
            pollApprovals();
          }
        })
        .catch(() => { btn.disabled = false; });
      return;
    }
    if (action === 'open') {
      // 'open' is a no-op placeholder for now — the ASCII mockup includes
      // it but each source type wants different behavior (scroll to a
      // cockpit project, open an Obsidian file, etc.). Leaving the button
      // present so the panel matches the mockup; wire-up arrives with the
      // live-verification refinement task.
      return;
    }
  }

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
    // The `.run-btn` Running… disable/re-enable loop that lived here is
    // gone — those buttons existed only in the removed Projects sidebar
    // panel. The cockpit's `.cockpit-action-btn` buttons don't need this
    // hook (action gating happens server-side; in-flight rendering
    // happens via the cockpit progress block + run pill).
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
  document.getElementById('cockpit-content')?.addEventListener('click', handleCockpitClick);
  document.getElementById('approvals-content')?.addEventListener('click', handleApprovalsClick);
  // Phase-shifted ~2.5s from pollState so the two pollers' file reads don't fire in lock-step.
  setTimeout(() => { pollCockpit(); setInterval(pollCockpit, 5000); }, 2500);
  // Phase-shifted again from pollCockpit so the three I/O pollers stagger
  // their queue/registry reads.
  setTimeout(() => { pollApprovals(); setInterval(pollApprovals, 5000); }, 3700);

  // -----------------------------------------------------------------------
  // Planning panel (project 08 Phase 6 C1.1)
  //
  // State machine driving the slide-in panel. The panel goes through:
  //   - hidden (no active session)
  //   - scoping       (textarea visible, transcript grows per turn)
  //   - spec-proposed (artifact visible, Approve/Refine/Abandon row)
  //   - approved      (auto-close + toast — handled inline after API success)
  //   - abandoned     (auto-close + toast)
  //
  // API surface (POST):
  //   /api/planning/start    → {id, status}
  //   /api/planning/turn     → {reply, status}
  //   /api/planning/approve  → 200 ok / 404 / 409 / 500
  //   /api/planning/abandon  → 200 ok (idempotent)
  //
  // Exposed via window.openPlanningPanel(product) so C1.3 can wire the
  // cockpit Plan button to it. No other globals leak from this IIFE.
  // -----------------------------------------------------------------------

  /** Per-panel local state. `transcript` is the only client-side memory of
   *  the conversation; the server keeps the authoritative session via
   *  getActivePlanningSession (chatId-keyed). One panel at a time. */
  const planningState = {
    open: false,
    product: '',
    status: 'scoping', // 'scoping' | 'spec-proposed' | 'approved' | 'abandoned'
    transcript: [], // [{role: 'user'|'assistant', text: string}]
    artifact: null, // {product, title, spec, tasks, testPlan} | null
  };

  function planningEl(id) { return document.getElementById(id); }

  function setPlanningStatus(status) {
    planningState.status = status;
    const pill = planningEl('planning-panel-status');
    if (!pill) return;
    pill.textContent = status;
    pill.className = 'planning-status-pill status-' + status;
  }

  function renderPlanningTranscript() {
    const el = planningEl('planning-panel-transcript');
    if (!el) return;
    const html = planningState.transcript.map(turn =>
      '<div class="planning-turn ' + escHtml(turn.role) + '">' +
        '<span class="planning-turn-role">' + escHtml(turn.role) + '</span>' +
        '<div class="planning-turn-body">' + escHtml(turn.text) + '</div>' +
      '</div>'
    ).join('');
    setHTML(el, html);
    // Auto-scroll to the bottom so the latest turn is visible.
    el.scrollTop = el.scrollHeight;
  }

  function renderPlanningView() {
    const scopingEl = planningEl('planning-panel-scoping');
    const specEl = planningEl('planning-panel-spec');
    if (!scopingEl || !specEl) return;
    if (planningState.status === 'spec-proposed' && planningState.artifact) {
      scopingEl.classList.add('hidden');
      specEl.classList.remove('hidden');
      const a = planningState.artifact;
      planningEl('planning-panel-spec-title').textContent = a.title || '';
      planningEl('planning-panel-spec-spec').textContent = a.spec || '';
      planningEl('planning-panel-spec-tasks').textContent = a.tasks || '';
      planningEl('planning-panel-spec-testplan').textContent = a.testPlan || '';
    } else {
      scopingEl.classList.remove('hidden');
      specEl.classList.add('hidden');
    }
  }

  function showPlanningToast(text) {
    const toast = planningEl('planning-toast');
    if (!toast) return;
    toast.textContent = text;
    toast.classList.remove('hidden', 'fading');
    // Auto-dismiss after 3.5s with a fade.
    setTimeout(() => { toast.classList.add('fading'); }, 3000);
    setTimeout(() => { toast.classList.add('hidden'); toast.classList.remove('fading'); }, 3500);
  }

  function closePlanningPanel() {
    const panel = planningEl('planning-panel');
    if (!panel) return;
    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden', 'true');
    planningState.open = false;
    planningState.product = '';
    planningState.status = 'scoping';
    planningState.transcript = [];
    planningState.artifact = null;
    renderPlanningTranscript();
    renderPlanningView();
    setPlanningStatus('scoping');
  }

  /** Open the panel scoped to a product slug. POSTs /api/planning/start to
   *  create the session, then renders the empty-scoping state. Exposed via
   *  window.openPlanningPanel so the cockpit Plan button (C1.3) can call it. */
  async function openPlanningPanel(product) {
    if (!product) return;
    const panel = planningEl('planning-panel');
    if (!panel) return;
    planningState.open = true;
    planningState.product = product;
    planningState.transcript = [];
    planningState.artifact = null;
    planningEl('planning-panel-product').textContent = product;
    setPlanningStatus('scoping');
    renderPlanningTranscript();
    renderPlanningView();
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    // Best-effort start — if it fails (e.g., 401 in dev), the panel stays
    // open with a friendly transcript message so the user knows something
    // went wrong rather than seeing a silent blank.
    try {
      const r = await fetch('/api/planning/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        planningState.transcript.push({
          role: 'assistant',
          text: 'Could not start planning session: ' + (body.error || ('HTTP ' + r.status)),
        });
        renderPlanningTranscript();
      }
    } catch (err) {
      planningState.transcript.push({
        role: 'assistant',
        text: 'Could not start planning session: ' + (err && err.message ? err.message : String(err)),
      });
      renderPlanningTranscript();
    }
  }

  async function submitPlanningReply() {
    const ta = planningEl('planning-panel-reply');
    const btn = planningEl('planning-panel-send');
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    if (btn) btn.disabled = true;
    planningState.transcript.push({ role: 'user', text });
    renderPlanningTranscript();
    try {
      const r = await fetch('/api/planning/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        planningState.transcript.push({
          role: 'assistant',
          text: 'Error: ' + (body.error || ('HTTP ' + r.status)),
        });
        renderPlanningTranscript();
        return;
      }
      planningState.transcript.push({ role: 'assistant', text: body.reply || '' });
      renderPlanningTranscript();
      // If the handler returned a spec-proposed status, the server has the
      // artifact in the session. The reply text typically includes a
      // summary line; the artifact itself we can't introspect from the
      // turn response, so we ask the server for the latest state via
      // status — for now, mark spec-proposed and parse a fenced JSON
      // artifact from the reply if present.
      if (body.status === 'spec-proposed') {
        const artifact = tryParseSpecArtifactFromReply(body.reply || '');
        if (artifact) planningState.artifact = artifact;
        setPlanningStatus('spec-proposed');
        renderPlanningView();
      } else {
        setPlanningStatus(body.status || 'scoping');
      }
    } catch (err) {
      planningState.transcript.push({
        role: 'assistant',
        text: 'Error: ' + (err && err.message ? err.message : String(err)),
      });
      renderPlanningTranscript();
    } finally {
      if (btn) btn.disabled = false;
      ta.focus();
    }
  }

  /** Best-effort: try to extract a spec-artifact JSON block from the
   *  assistant's reply text. The defaultScopingTurn prompt emits a fenced
   *  ```spec-artifact JSON``` block; parse it client-side so the panel can
   *  render the artifact without a separate fetch. Returns null if the
   *  reply has no fenced block or the JSON is malformed. */
  function tryParseSpecArtifactFromReply(reply) {
    const m = /```spec-artifact\s*\n([\s\S]*?)\n```/.exec(reply);
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed && typeof parsed === 'object' &&
          typeof parsed.title === 'string' &&
          typeof parsed.spec === 'string' &&
          typeof parsed.tasks === 'string' &&
          typeof parsed.testPlan === 'string') {
        return parsed;
      }
    } catch (e) { /* malformed — fall through */ }
    return null;
  }

  async function approvePlanning() {
    try {
      const r = await fetch('/api/planning/approve', { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        showPlanningToast('Spec approved — scaffolding project files.');
        closePlanningPanel();
      } else {
        planningState.transcript.push({
          role: 'assistant',
          text: 'Approve failed: ' + (body.error || ('HTTP ' + r.status)),
        });
        renderPlanningTranscript();
      }
    } catch (err) {
      planningState.transcript.push({
        role: 'assistant',
        text: 'Approve error: ' + (err && err.message ? err.message : String(err)),
      });
      renderPlanningTranscript();
    }
  }

  function refinePlanning() {
    // Keep the artifact visible but re-enter scoping so the user can ask
    // Claude to revise specific parts. No API call — the server-side
    // session stays in spec-proposed; the next /turn call will drive
    // another scoping turn (handlePlanningTurn already supports this).
    setPlanningStatus('scoping');
    renderPlanningView();
    const ta = planningEl('planning-panel-reply');
    if (ta) ta.focus();
  }

  async function abandonPlanning() {
    try {
      await fetch('/api/planning/abandon', { method: 'POST' });
    } catch (err) {
      // Idempotent on the server; client toast either way.
    }
    showPlanningToast('Planning session abandoned.');
    closePlanningPanel();
  }

  // Wire up panel button + textarea handlers (once per page load).
  planningEl('planning-panel-close')?.addEventListener('click', () => {
    // X button is a soft close (does NOT abandon the session — the user
    // can re-open via the cockpit Plan button to resume).
    closePlanningPanel();
  });
  planningEl('planning-panel-send')?.addEventListener('click', () => { void submitPlanningReply(); });
  planningEl('planning-panel-reply')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submitPlanningReply();
    }
  });
  planningEl('planning-panel-approve')?.addEventListener('click', () => { void approvePlanning(); });
  planningEl('planning-panel-refine')?.addEventListener('click', () => { refinePlanning(); });
  planningEl('planning-panel-abandon')?.addEventListener('click', () => { void abandonPlanning(); });

  // Expose openPlanningPanel for C1.3's cockpit Plan-button wiring.
  window.openPlanningPanel = openPlanningPanel;
})();
