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

  // Markdown renderer
  const md = window.markdownit({ html: false, linkify: true, typographer: true });
  const vaultName = document.querySelector('meta[name="obsidian-vault"]')?.content ?? '';

  function renderMarkdown(text) {
    let html = md.render(text);
    // Wikilink substitution: [[Note Title]] → obsidian:// anchor
    html = html.replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
      const href = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(title)}`;
      return `<a href="${href}" class="wikilink">${title}</a>`;
    });
    return html;
  }

  function highlightBlocks(container) {
    container.querySelectorAll('pre code').forEach(block => {
      window.hljs.highlightElement(block);
    });
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
    highlightBlocks(div);
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
      }
    };

    ws.onclose = () => {
      updateStatus('disconnected');
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
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
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

  // Cockpit state polling
  let lastState = null;
  function pollState() {
    fetch('/api/state').then(r => r.json()).then(state => {
      if (JSON.stringify(state) === JSON.stringify(lastState)) return;
      lastState = state;
      renderState(state);
    }).catch(() => {});
  }

  function renderState(state) {
    // Session panel
    const sessionEl = document.getElementById('session-content');
    if (state.activeSession) {
      const s = state.activeSession;
      sessionEl.textContent = `${s.sessionId.slice(0, 8)} · ${s.model} · ${s.messageCount} msgs`;
      sessionEl.classList.remove('muted');
    } else {
      sessionEl.textContent = 'No active session';
      sessionEl.classList.add('muted');
    }
    // Queue panel
    const queueEl = document.getElementById('queue-content');
    const depth = state.ingestionQueueDepth ?? 0;
    queueEl.textContent = `${depth} pending`;
    queueEl.classList.toggle('muted', depth === 0);
    // Review panel
    const reviewEl = document.getElementById('review-content');
    if (state.activeReview) {
      const r = state.activeReview;
      reviewEl.textContent = `${r.type} · ${r.phase}`;
      reviewEl.classList.remove('muted');
    } else {
      reviewEl.textContent = 'None';
      reviewEl.classList.add('muted');
    }
    // Approvals panel
    const approvalsEl = document.getElementById('approvals-content');
    const total = (state.pendingApprovals?.playbook ?? 0) + (state.pendingApprovals?.proposal ?? 0);
    approvalsEl.textContent = `${total} pending`;
    approvalsEl.classList.toggle('muted', total === 0);
  }

  // Init
  connect();
  pollState();
  setInterval(pollState, 5000);
})();
