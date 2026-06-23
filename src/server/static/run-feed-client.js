export function parseRunFeedFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== 'object' || frame.kind !== 'run-event') return null;
  return frame;
}

function tsMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

export function createRunFeedState(options = {}) {
  const runs = new Map();
  const maxLogLines = Number.isFinite(options.maxLogLines) && options.maxLogLines > 0
    ? Math.floor(options.maxLogLines)
    : 200;

  function trimLogLines(lines) {
    if (!Array.isArray(lines)) return [];
    return lines.slice(-maxLogLines);
  }

  function ensureRun(runId, base) {
    let run = runs.get(runId);
    if (!run) {
      run = {
        runId,
        product: base.product,
        target: clone(base.target),
        lastLogLines: [],
        _ts: {},
      };
      runs.set(runId, run);
    }
    if (base.product) run.product = base.product;
    if (base.target) run.target = clone(base.target);
    return run;
  }

  function shouldApply(run, key, ts) {
    const next = tsMs(ts);
    const prev = run._ts[key] || 0;
    if (next < prev) return false;
    run._ts[key] = next;
    return true;
  }

  function publicRun(run) {
    if (!run) return null;
    const { _ts, ...rest } = run;
    return clone(rest);
  }

  return {
    applySnapshot(snapshot) {
      const run = ensureRun(snapshot.runId, snapshot);
      const snapshotTs = tsMs(snapshot.ts);
      run.product = snapshot.product;
      run.target = clone(snapshot.target);
      run.state = snapshot.state;
      run.tasks = clone(snapshot.tasks);
      run.elapsedMs = snapshot.elapsedMs;
      run.worktreePath = snapshot.worktreePath;
      run.agents = clone(snapshot.agents || []);
      run.lastLogLines = clone(trimLogLines(snapshot.lastLogLines || []));
      if (snapshot.outcome !== undefined) run.outcome = snapshot.outcome;
      run.ts = snapshot.ts;
      run._ts = {
        snapshot: snapshotTs,
        progress: snapshotTs,
        agents: snapshotTs,
        log: snapshotTs,
        state: snapshotTs,
      };
      return publicRun(run);
    },

    applyEvent(event) {
      if (!event || event.kind !== 'run-event') return null;
      const run = ensureRun(event.runId, event);
      if (event.subKind === 'progress') {
        if (!shouldApply(run, 'progress', event.ts)) return publicRun(run);
        run.tasks = clone(event.tasks);
      } else if (event.subKind === 'agents') {
        if (!shouldApply(run, 'agents', event.ts)) return publicRun(run);
        run.agents = clone(event.agents || []);
      } else if (event.subKind === 'log') {
        if (!shouldApply(run, 'log', event.ts)) return publicRun(run);
        run.lastLogLines = trimLogLines([...(run.lastLogLines || []), ...(event.lines || [])]);
      } else if (event.subKind === 'state') {
        if (!shouldApply(run, 'state', event.ts)) return publicRun(run);
        run.state = event.state;
        run.elapsedMs = event.elapsedMs;
        if (event.outcome !== undefined) run.outcome = event.outcome;
      }
      run.ts = event.ts;
      return publicRun(run);
    },

    getRun(runId) {
      return publicRun(runs.get(runId));
    },
  };
}

export function createRunFeedSubscription({
  runId,
  fetchLive,
  openStream,
  socket,
  fetchJson,
  onState,
  maxLogLines,
}) {
  const loadLive = fetchLive || ((id) => fetchJson(`/api/work-runs/${encodeURIComponent(id)}/live`));
  const feed = createRunFeedState({ maxLogLines });
  let stream = null;

  async function connect() {
    const snapshot = await loadLive(runId);
    const state = feed.applySnapshot(snapshot);
    if (onState) onState(state);
    stream = openRunStream();
  }

  function applyEvent(event) {
    if (!event || event.runId !== runId) return;
    const state = feed.applyEvent(event);
    if (onState) onState(state);
  }

  function handleFrame(raw) {
    const event = parseRunFeedFrame(raw);
    if (event) applyEvent(event);
  }

  function openRunStream() {
    if (openStream) {
      return openStream({ runId, onFrame: handleFrame });
    }
    if (!socket) return null;
    const onMessage = (event) => handleFrame(event?.data);
    socket.addEventListener('message', onMessage);
    return {
      close() {
        socket.removeEventListener('message', onMessage);
      },
    };
  }

  return {
    connect,
    async reconnect() {
      if (stream && typeof stream.close === 'function') stream.close();
      stream = null;
      await connect();
    },
    applyEvent,
    getState() {
      return feed.getRun(runId);
    },
    close() {
      if (stream && typeof stream.close === 'function') stream.close();
      stream = null;
    },
  };
}
