import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeClassList {
  values = new Set<string>();

  add(...names: string[]) {
    for (const name of names) this.values.add(name);
  }

  remove(...names: string[]) {
    for (const name of names) this.values.delete(name);
  }

  toggle(name: string, force?: boolean) {
    const next = force ?? !this.values.has(name);
    if (next) this.values.add(name);
    else this.values.delete(name);
    return next;
  }

  contains(name: string) {
    return this.values.has(name);
  }
}

class FakeElement {
  id = '';
  className = '';
  hidden = false;
  disabled = false;
  value = '';
  textContent = '';
  innerHTML = '';
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 400;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  firstChild: FakeElement | null = null;
  listeners = new Map<string, Set<(event: any) => void>>();

  constructor(id = '') {
    this.id = id;
  }

  setAttribute(name: string, value: string) {
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = value;
    }
  }

  append(...nodes: FakeElement[]) {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node: FakeElement) {
    node.parentElement = this;
    this.children.push(node);
    this.firstChild = this.children[0] ?? null;
    return node;
  }

  insertBefore(node: FakeElement, before: FakeElement | null) {
    node.parentElement = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index >= 0) this.children.splice(index, 0, node);
    else this.children.push(node);
    this.firstChild = this.children[0] ?? null;
    return node;
  }

  prepend(node: FakeElement) {
    node.parentElement = this;
    this.children.unshift(node);
    this.firstChild = this.children[0] ?? null;
  }

  removeChild(node: FakeElement) {
    this.children = this.children.filter(child => child !== node);
    this.firstChild = this.children[0] ?? null;
    node.parentElement = null;
    return node;
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  addEventListener(type: string, listener: (event: any) => void) {
    const set = this.listeners.get(type) ?? new Set<(event: any) => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  dispatchEvent(event: any) {
    for (const listener of this.listeners.get(event?.type) ?? []) listener(event);
  }

  querySelector() {
    return null;
  }

  focus() {}
}

class FakeDocument {
  body = new FakeElement('body');
  elements = new Map<string, FakeElement>();

  constructor() {
    this.body.dataset = {};
    for (const id of [
      'messages',
      'chat',
      'input-form',
      'message-input',
      'model-select',
      'main',
      'ws-status',
      'activity-content',
      'runs-content',
      'session-content',
      'queue-content',
      'review-content',
      'planning-content',
      'cockpit-content',
      'approvals-content',
      'restart-btn',
      'backlog-add-submit',
      'backlog-add-input',
      'backlog-drawer-content',
      'backlog-drawer-close',
      'backlog-add-chip',
      'modal-cancel',
      'modal-run',
      'confirm-modal',
      'modal-slug',
      'modal-dispatch-mode',
      'mutations-active-content',
      'mutations-recent-content',
      'drawer-close',
      'mutation-drawer',
      'drawer-title',
      'drawer-output',
      'planning-panel',
      'planning-panel-product',
      'planning-panel-status',
      'planning-panel-transcript',
      'planning-panel-scoping',
      'planning-panel-spec',
      'planning-panel-spec-title',
      'planning-panel-spec-spec',
      'planning-panel-spec-assumptions',
      'planning-panel-spec-self-review',
      'planning-toast',
      'planning-panel-close',
      'planning-panel-send',
      'planning-panel-reply',
      'planning-panel-approve',
      'planning-panel-refine',
      'planning-panel-abandon',
    ]) {
      this.elements.set(id, new FakeElement(id));
    }
    const messages = this.getElementById('messages')!;
    const chat = this.getElementById('chat')!;
    messages.parentElement = chat;
    const main = this.getElementById('main')!;
    const form = this.getElementById('input-form')!;
    main.appendChild(form);
  }

  getElementById(id: string) {
    if (!this.elements.has(id)) this.elements.set(id, new FakeElement(id));
    return this.elements.get(id) ?? null;
  }

  createElement(tag: string) {
    return new FakeElement(tag);
  }

  querySelector(selector: string) {
    if (selector === 'meta[name="obsidian-vault"]') return { content: '' };
    if (selector === 'meta[name="is-production"]') return { content: 'false' };
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor() {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const originals: Record<string, unknown> = {};

function installAppHarness() {
  const document = new FakeDocument();
  const windowListeners = new Map<string, Set<(event: any) => void>>();
  const window = {
    location: { search: '', protocol: 'http:', host: '127.0.0.1:9999' },
    markdownit: () => ({ render: (text: string) => `<p>${text}</p>` }),
    hljs: { getLanguage: () => false, highlight: () => ({ value: '' }) },
    addEventListener: vi.fn((type: string, listener: (event: any) => void) => {
      const set = windowListeners.get(type) ?? new Set<(event: any) => void>();
      set.add(listener);
      windowListeners.set(type, set);
    }),
    dispatchEvent: vi.fn((event: any) => {
      for (const listener of windowListeners.get(event?.type) ?? []) listener(event);
    }),
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init: { detail?: unknown } = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
  };
  originals.window = (globalThis as any).window;
  originals.document = (globalThis as any).document;
  originals.WebSocket = (globalThis as any).WebSocket;
  originals.CustomEvent = (globalThis as any).CustomEvent;
  originals.fetch = (globalThis as any).fetch;
  originals.localStorage = (globalThis as any).localStorage;
  originals.highlightBlocks = (globalThis as any).highlightBlocks;
  originals.setInterval = (globalThis as any).setInterval;
  originals.clearInterval = (globalThis as any).clearInterval;
  originals.setTimeout = (globalThis as any).setTimeout;

  (globalThis as any).window = window;
  (globalThis as any).document = document;
  (globalThis as any).WebSocket = FakeWebSocket;
  (globalThis as any).CustomEvent = window.CustomEvent;
  (globalThis as any).localStorage = { getItem: vi.fn(() => null), setItem: vi.fn() };
  (globalThis as any).highlightBlocks = vi.fn();
  (globalThis as any).setInterval = vi.fn(() => 0);
  (globalThis as any).clearInterval = vi.fn();
  (globalThis as any).setTimeout = vi.fn(() => 0);
  (globalThis as any).fetch = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url === '/api/state') {
        return {
          ready: true,
          sessions: { webview: null, telegram: null },
          ingestionQueueDepth: 0,
          activeReview: null,
          activePlanning: null,
          recentAgentRuns: [],
          mutations: { active: [], recent: [] },
          inFlight: [],
        };
      }
      return [];
    },
    text: async () => '[]',
  }));
  FakeWebSocket.instances = [];
  return { document };
}

function restoreAppHarness() {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete (globalThis as any)[key];
    else (globalThis as any)[key] = value;
  }
}

async function importFreshApp() {
  const url = pathToFileURL(new URL('./app.js', import.meta.url).pathname);
  await import(`${url.href}?scope-routing=${Date.now()}-${Math.random()}`);
}

describe('global webview app frame routing', () => {
  afterEach(() => {
    restoreAppHarness();
  });

  it('renders only global message/chunk/status frames into the global transcript and status pill', async () => {
    const { document } = installAppHarness();
    await importFreshApp();
    const socket = FakeWebSocket.instances[0]!;
    expect(socket).toBeDefined();

    socket.receive({ kind: 'chunk', product: 'aura', text: 'aura background chunk' });
    socket.receive({ kind: 'message', product: 'aura', text: 'aura background final' });
    socket.receive({ kind: 'status', product: 'aura', label: 'Aura is thinking' });

    const messages = document.getElementById('messages')!;
    const main = document.getElementById('main')!;
    expect(messages.children).toHaveLength(0);
    expect(messages.innerHTML).not.toContain('aura background');
    expect(main.children.some(child => child.id === 'chat-status')).toBe(false);

    socket.receive({ kind: 'chunk', text: 'global chunk' });
    socket.receive({ kind: 'message', text: 'global final' });
    socket.receive({ kind: 'status', label: 'Global is thinking' });

    expect(messages.children).toHaveLength(2);
    expect(messages.children.map(child => child.innerHTML).join('\n')).toContain('global chunk');
    expect(messages.children.map(child => child.innerHTML).join('\n')).toContain('global final');
    expect(main.children.some(child => child.id === 'chat-status')).toBe(true);
  });
});
