const productSessions = new Map();
const productSessionSubscribers = new Set();
const productChatConsumerWindows = new WeakSet();

function list(value) {
  return Array.isArray(value) ? value : [];
}

function fmtClock(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function opDisplayLabel(frame) {
  return frame?.opKind === 'chat' ? 'Asking Claude' : (frame?.label || 'Asking Claude');
}

function isScopedChatOperationFrame(frame, product) {
  return frame?.kind === 'op-event' &&
    frame.opKind === 'chat' &&
    typeof product === 'string' &&
    product.length > 0;
}

export function getProductSession(product) {
  let session = productSessions.get(product);
  if (!session) {
    session = {
      chatMessages: [],
      planning: { active: false, status: 'scoping', artifact: null },
      activeOp: null,
      statusLabel: null,
      streamingMessageIndex: -1,
      opActivity: [],
      revision: 0,
    };
    productSessions.set(product, session);
  }
  return session;
}

function notifyProductSessionSubscribers(product, frame) {
  for (const subscriber of productSessionSubscribers) {
    try {
      subscriber(product, frame);
    } catch (error) {
      console.error('product chat session subscriber failed', error);
    }
  }
}

function appendOperationActivity(session, row) {
  session.opActivity = [...list(session.opActivity), row].slice(-50);
}

function closeStreamingMessage(session) {
  const messages = list(session.chatMessages);
  const index = Number.isFinite(session.streamingMessageIndex) ? session.streamingMessageIndex : -1;
  if (index < 0 || !messages[index]) {
    session.streamingMessageIndex = -1;
    return;
  }
  const nextMessages = [...messages];
  nextMessages[index] = { ...messages[index], role: 'assistant' };
  session.chatMessages = nextMessages;
  session.streamingMessageIndex = -1;
}

function appendStreamingChunk(session, text) {
  const messages = list(session.chatMessages);
  const index = Number.isFinite(session.streamingMessageIndex) ? session.streamingMessageIndex : -1;
  if (index < 0 || !messages[index]) {
    session.chatMessages = [...messages, { role: 'assistant streaming', text }];
    session.streamingMessageIndex = session.chatMessages.length - 1;
    return;
  }
  const nextMessages = [...messages];
  nextMessages[index] = {
    ...messages[index],
    text: `${messages[index].text || ''}${text}`,
  };
  session.chatMessages = nextMessages;
}

function finalizeStreamingMessage(session, text) {
  const messages = list(session.chatMessages);
  const index = Number.isFinite(session.streamingMessageIndex) ? session.streamingMessageIndex : -1;
  if (index >= 0 && messages[index]) {
    const nextMessages = [...messages];
    nextMessages[index] = { role: 'assistant', text };
    session.chatMessages = nextMessages;
  } else {
    session.chatMessages = [...messages, { role: 'assistant', text }];
  }
  session.streamingMessageIndex = -1;
}

function setSessionStatus(session, label) {
  session.statusLabel = label || null;
  if (session.activeOp?.opId) {
    session.activeOp = {
      ...session.activeOp,
      label: session.statusLabel || session.activeOp.label || 'Asking Claude',
    };
  }
}

function applyProductOperationFrame(session, frame, product) {
  if (!isScopedChatOperationFrame(frame, product) || !frame.opId) return false;
  const existing = session.activeOp?.opId === frame.opId ? session.activeOp : null;
  const base = {
    opId: frame.opId,
    label: session.statusLabel || existing?.label || opDisplayLabel(frame),
    startedAt: frame.startedAt || existing?.startedAt,
    elapsedMs: Number.isFinite(frame.elapsedMs) ? frame.elapsedMs : (existing?.elapsedMs || 0),
  };
  if (frame.subKind === 'start') {
    if (session.streamingMessageIndex >= 0 && session.activeOp?.opId !== frame.opId) {
      closeStreamingMessage(session);
    }
    session.activeOp = base;
    appendOperationActivity(session, {
      ...base,
      at: fmtClock(frame.startedAt),
      status: 'started',
    });
    return true;
  }
  if (frame.subKind === 'progress') {
    if (!existing) return false;
    session.activeOp = { ...existing, ...base };
    if (frame.detail) {
      appendOperationActivity(session, {
        ...base,
        at: fmtClock(new Date().toISOString()),
        detail: frame.detail,
      });
    }
    return true;
  }
  if (frame.subKind === 'end') {
    if (!existing) return false;
    session.activeOp = null;
    session.statusLabel = null;
    if (frame.status === 'cancelled' || frame.status === 'error' || frame.error) {
      closeStreamingMessage(session);
    }
    appendOperationActivity(session, {
      ...base,
      at: fmtClock(new Date().toISOString()),
      detail: frame.error || frame.detail || frame.status || 'done',
      status: frame.status || 'ended',
    });
    return true;
  }
  return false;
}

function applyProductChatFrame(frame) {
  const product = typeof frame?.product === 'string' && frame.product
    ? frame.product
    : null;
  if (!product) return false;
  const session = getProductSession(product);
  if (frame.kind === 'chunk') {
    appendStreamingChunk(session, frame.text || '');
  } else if (frame.kind === 'message') {
    finalizeStreamingMessage(session, frame.text || '');
    setSessionStatus(session, null);
  } else if (frame.kind === 'status') {
    setSessionStatus(session, frame.label || null);
  } else if (frame.kind === 'op-event') {
    if (!applyProductOperationFrame(session, frame, product)) return false;
  } else {
    return false;
  }
  session.revision += 1;
  notifyProductSessionSubscribers(product, frame);
  return true;
}

export function subscribeProductSessions(subscriber) {
  productSessionSubscribers.add(subscriber);
  return () => productSessionSubscribers.delete(subscriber);
}

function newestScopedChatOperation(state, product) {
  let newest = null;
  let newestStartedAt = -Infinity;
  for (const op of list(state?.inFlight)) {
    if (op?.kind !== 'chat' || op?.scope !== product || !op?.opId) continue;
    const startedAt = Date.parse(op.startedAt || '');
    const comparableStartedAt = Number.isFinite(startedAt) ? startedAt : -Infinity;
    if (!newest || comparableStartedAt >= newestStartedAt) {
      newest = op;
      newestStartedAt = comparableStartedAt;
    }
  }
  return newest;
}

export function reconcileProductSessionOperation(product, state) {
  const session = getProductSession(product);
  const liveOp = newestScopedChatOperation(state, product);
  if (!liveOp) {
    session.activeOp = null;
    session.statusLabel = null;
    return;
  }
  const retainedStatus = session.activeOp?.opId === liveOp.opId
    ? session.statusLabel
    : null;
  session.statusLabel = retainedStatus;
  session.activeOp = {
    opId: liveOp.opId,
    label: retainedStatus || liveOp.label || 'Asking Claude',
    startedAt: liveOp.startedAt,
    elapsedMs: Number.isFinite(liveOp.elapsedMs) ? liveOp.elapsedMs : 0,
  };
}

export function initializeProductChatFrameConsumer(
  targetWindow = typeof window !== 'undefined' ? window : null,
) {
  if (!targetWindow?.addEventListener || productChatConsumerWindows.has(targetWindow)) return;
  targetWindow.addEventListener('rune-webview-frame', event => {
    applyProductChatFrame(event?.detail);
  });
  productChatConsumerWindows.add(targetWindow);
}

export function resetProductSessions() {
  productSessions.clear();
}
