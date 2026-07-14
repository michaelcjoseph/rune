import { beforeEach, describe, expect, it, vi } from 'vitest';

const askClaude = vi.hoisted(() => vi.fn());
const runCodex = vi.hoisted(() => vi.fn());
const buildChildEnv = vi.hoisted(() => vi.fn(() => ({ PATH: '/bin', SAFE_ONLY: 'yes' })));
const cleanupCodexThread = vi.hoisted(() => vi.fn());

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/test/project',
  default: {
    MODEL_POLICY_FILE: '/test/model-policy.json',
    VAULT_DIR: '/test/vault',
  },
}));
vi.mock('../intent/model-policy.js', () => ({
  loadModelPolicy: () => ({
    models: [
      { alias: 'opus', provider: 'anthropic', format: 'claude', capabilities: [], costTier: 'high', status: 'active' },
      { alias: 'gpt-5.6-terra', provider: 'openai', format: 'codex', capabilities: [], costTier: 'high', status: 'active' },
    ],
  }),
}));
vi.mock('./claude.js', () => ({
  askClaudeWithContext: askClaude,
  buildClaudeChildEnv: buildChildEnv,
}));
vi.mock('./codex.js', () => ({ runCodex }));
vi.mock('./codex-sessions.js', () => ({ cleanupCodexThread }));
vi.mock('../vault/voice.js', () => ({ buildVoicePromptSection: () => 'VOICE' }));

const { askChatWithContext } = await import('./chat.js');

const base = {
  legacyClaudeSessionId: 'rune-session',
  message: 'current question',
  systemPrompt: 'SYSTEM',
  priorMessages: [],
  executor: null,
  writeEnabled: false,
  allowedTools: ['Read'],
};

describe('provider-aware chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    askClaude.mockResolvedValue({ text: 'claude reply', error: null });
    runCodex.mockImplementation(async (_prompt: string, opts: {
      onEvent?: (event: Record<string, unknown>) => void;
      resumeSessionId?: string;
    }) => {
      opts.onEvent?.({
        type: 'thread.started',
        thread_id: opts.resumeSessionId ?? 'codex-thread',
      });
      opts.onEvent?.({ type: 'item.completed', item: { type: 'agent_message', text: 'codex reply' } });
      return { text: '', error: null, exitCode: 0 };
    });
  });

  it('creates a persistent Codex thread with system, voice, and prior conversation context', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      priorMessages: [{ role: 'assistant', text: 'earlier answer', ts: 'now' }],
    });

    expect(runCodex).toHaveBeenCalledWith(expect.stringContaining('earlier answer'), expect.objectContaining({
      model: 'gpt-5.6-terra',
      persistentSession: true,
      sandboxMode: 'read-only',
      opLabel: 'chat',
      env: { PATH: '/bin', SAFE_ONLY: 'yes' },
    }));
    expect(buildChildEnv).toHaveBeenCalledWith('product-chat');
    expect(result).toEqual({
      text: 'codex reply',
      error: null,
      executor: {
        format: 'codex',
        sessionId: 'codex-thread',
        writeEnabled: false,
      },
    });
  });

  it('gives a fresh write-enabled Codex product chat full Git-capable access', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      writeEnabled: true,
      product: 'rune',
      cwd: '/workspace/rune',
    });

    expect(runCodex).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      cwd: '/workspace/rune',
      product: 'rune',
      persistentSession: true,
      sandboxMode: 'danger-full-access',
    }));
    expect(result.executor).toEqual({
      format: 'codex',
      sessionId: 'codex-thread',
      writeEnabled: true,
      cwd: '/workspace/rune',
    });
    const configOverrides = runCodex.mock.calls[0]![1].configOverrides as string[];
    expect(configOverrides).toHaveLength(1);
    expect(configOverrides[0]).toContain('cockpit_list_runs');
    expect(configOverrides[0]).toContain('cockpit_inspect_run');
    expect(configOverrides[0]).toContain('cockpit_active_runs');
  });

  it('scrubs the environment for global and product Codex chats alike', async () => {
    await askChatWithContext({ ...base, model: 'gpt-5.6-terra' });
    await askChatWithContext({ ...base, model: 'gpt-5.6-terra', product: 'writing' });
    for (const call of runCodex.mock.calls) {
      expect(call[1].env).toEqual({ PATH: '/bin', SAFE_ONLY: 'yes' });
    }
  });

  it('cleans a newly-created Codex thread when the first turn fails', async () => {
    runCodex.mockImplementationOnce(async (_prompt: string, opts: { onEvent?: (event: Record<string, unknown>) => void }) => {
      opts.onEvent?.({ type: 'thread.started', thread_id: 'failed-thread-1234' });
      return { text: null, error: 'boom', exitCode: 1 };
    });
    const result = await askChatWithContext({ ...base, model: 'gpt-5.6-terra' });
    expect(result.error).toBe('boom');
    expect(cleanupCodexThread).toHaveBeenCalledWith('failed-thread-1234');
  });

  it('resumes an existing Codex thread without replaying the transcript', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      priorMessages: [{ role: 'user', text: 'do not replay', ts: 'now' }],
      executor: {
        format: 'codex',
        sessionId: 'codex-thread',
        writeEnabled: false,
      },
    });

    expect(runCodex).toHaveBeenCalledWith('current question', expect.objectContaining({
      resumeSessionId: 'codex-thread',
      persistentSession: true,
    }));
    const options = runCodex.mock.calls[0]![1];
    expect(options).not.toHaveProperty('sandboxMode');
    expect(result.executor).toEqual({
      format: 'codex',
      sessionId: 'codex-thread',
      writeEnabled: false,
    });
  });

  it('starts a read-only thread with replayed context when a product loses its workspace binding', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'rune',
      priorMessages: [{ role: 'assistant', text: 'earlier product answer', ts: 'now' }],
      executor: {
        format: 'codex',
        sessionId: 'full-access-thread',
        writeEnabled: true,
        cwd: '/workspace/rune',
      },
    });

    const [prompt, options] = runCodex.mock.calls[0]!;
    expect(prompt).toContain('SYSTEM');
    expect(prompt).toContain('earlier product answer');
    expect(options).toEqual(expect.objectContaining({
      cwd: '/test/vault',
      product: 'rune',
      sandboxMode: 'read-only',
    }));
    expect(options).not.toHaveProperty('resumeSessionId');
    expect(result.executor).toEqual({
      format: 'codex',
      sessionId: 'codex-thread',
      writeEnabled: false,
    });
  });

  it('fails closed for a legacy product thread whose workspace cannot be resolved', async () => {
    await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'rune',
      priorMessages: [{ role: 'assistant', text: 'legacy product context', ts: 'now' }],
      executor: { format: 'codex', sessionId: 'legacy-product-thread' },
    });

    const [prompt, options] = runCodex.mock.calls[0]!;
    expect(prompt).toContain('legacy product context');
    expect(options).toEqual(expect.objectContaining({
      cwd: '/test/vault',
      product: 'rune',
      sandboxMode: 'read-only',
    }));
    expect(options).not.toHaveProperty('resumeSessionId');
  });

  it('starts a full-access thread with replayed context when an unresolved product gains a workspace', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'rune',
      cwd: '/workspace/rune',
      writeEnabled: true,
      priorMessages: [{ role: 'assistant', text: 'earlier read-only answer', ts: 'now' }],
      executor: {
        format: 'codex',
        sessionId: 'read-only-thread',
        writeEnabled: false,
      },
    });

    const [prompt, options] = runCodex.mock.calls[0]!;
    expect(prompt).toContain('SYSTEM');
    expect(prompt).toContain('earlier read-only answer');
    expect(options).toEqual(expect.objectContaining({
      cwd: '/workspace/rune',
      product: 'rune',
      sandboxMode: 'danger-full-access',
    }));
    expect(options).not.toHaveProperty('resumeSessionId');
    expect(result.executor).toEqual({
      format: 'codex',
      sessionId: 'codex-thread',
      writeEnabled: true,
      cwd: '/workspace/rune',
    });
  });

  it('resumes a matching full-access product thread without a sandbox argument', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'rune',
      cwd: '/workspace/rune',
      writeEnabled: true,
      priorMessages: [{ role: 'user', text: 'do not replay this product turn', ts: 'now' }],
      executor: {
        format: 'codex',
        sessionId: 'full-access-thread',
        writeEnabled: true,
        cwd: '/workspace/rune',
      },
    });

    expect(runCodex).toHaveBeenCalledWith('current question', expect.objectContaining({
      cwd: '/workspace/rune',
      product: 'rune',
      resumeSessionId: 'full-access-thread',
    }));
    const options = runCodex.mock.calls[0]![1];
    expect(options).not.toHaveProperty('sandboxMode');
    expect(result.executor).toEqual({
      format: 'codex',
      sessionId: 'full-access-thread',
      writeEnabled: true,
      cwd: '/workspace/rune',
    });
    const configOverrides = runCodex.mock.calls[0]![1].configOverrides as string[];
    expect(configOverrides).toHaveLength(1);
    expect(configOverrides[0]).toContain('cockpit_inspect_run');
  });

  it('passes the product-scoped MCP registration to Claude product chats', async () => {
    await askChatWithContext({
      ...base,
      model: 'opus',
      product: 'assay',
      cwd: '/workspace/assay',
      writeEnabled: true,
    });

    const options = askClaude.mock.calls[0]![3];
    expect(options.mcpArgs?.slice(0, 2)).toEqual(['--strict-mcp-config', '--mcp-config']);
    expect(options.mcpArgs?.[2]).toContain('RUNE_PRODUCT_CHAT_PRODUCT');
    expect(options.mcpArgs?.[2]).toContain('assay');
  });

  it('rotates a full-access thread when its scoped writable root changes', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'writing',
      cwd: '/workspace/writing',
      writableRoot: '/workspace/writing/docs/brand',
      writeEnabled: true,
      priorMessages: [{ role: 'assistant', text: 'earlier scoped answer', ts: 'now' }],
      executor: {
        format: 'codex',
        sessionId: 'writing-scope-thread',
        writeEnabled: true,
        cwd: '/workspace/writing',
        writableRoot: '/workspace/writing/docs/rune',
      },
    });

    const [prompt, options] = runCodex.mock.calls[0]!;
    expect(prompt).toContain('SYSTEM');
    expect(prompt).toContain('earlier scoped answer');
    expect(options).toEqual(expect.objectContaining({
      cwd: '/workspace/writing',
      product: 'writing',
      sandboxMode: 'danger-full-access',
    }));
    expect(options).not.toHaveProperty('resumeSessionId');
    expect(result.executor).toEqual({
      format: 'codex',
      sessionId: 'codex-thread',
      writeEnabled: true,
      cwd: '/workspace/writing',
      writableRoot: '/workspace/writing/docs/brand',
    });
  });

  it('rotates a full-access thread when its product repository root changes', async () => {
    await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'rune',
      cwd: '/workspace/rune-new',
      writeEnabled: true,
      priorMessages: [{ role: 'assistant', text: 'earlier repository answer', ts: 'now' }],
      executor: {
        format: 'codex',
        sessionId: 'old-repository-thread',
        writeEnabled: true,
        cwd: '/workspace/rune-old',
      },
    });

    const [prompt, options] = runCodex.mock.calls[0]!;
    expect(prompt).toContain('earlier repository answer');
    expect(options).toEqual(expect.objectContaining({
      cwd: '/workspace/rune-new',
      product: 'rune',
      sandboxMode: 'danger-full-access',
    }));
    expect(options).not.toHaveProperty('resumeSessionId');
  });

  it('resumes a full-access thread whose scoped writable root still matches', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'writing',
      cwd: '/workspace/writing',
      writableRoot: '/workspace/writing/docs/rune',
      writeEnabled: true,
      priorMessages: [{ role: 'user', text: 'do not replay scoped history', ts: 'now' }],
      executor: {
        format: 'codex',
        sessionId: 'writing-scope-thread',
        writeEnabled: true,
        cwd: '/workspace/writing',
        writableRoot: '/workspace/writing/docs/rune',
      },
    });

    expect(runCodex).toHaveBeenCalledWith('current question', expect.objectContaining({
      cwd: '/workspace/writing',
      product: 'writing',
      resumeSessionId: 'writing-scope-thread',
    }));
    const options = runCodex.mock.calls[0]![1];
    expect(options).not.toHaveProperty('sandboxMode');
    expect(result.executor).toEqual({
      format: 'codex',
      sessionId: 'writing-scope-thread',
      writeEnabled: true,
      cwd: '/workspace/writing',
      writableRoot: '/workspace/writing/docs/rune',
    });
  });

  it('does not upgrade a legacy configured product thread until the session is cleared', async () => {
    await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'rune',
      cwd: '/workspace/rune',
      writeEnabled: true,
      executor: { format: 'codex', sessionId: 'legacy-thread' },
    });

    expect(runCodex).toHaveBeenCalledWith('current question', expect.objectContaining({
      resumeSessionId: 'legacy-thread',
    }));
    const options = runCodex.mock.calls[0]![1];
    expect(options).not.toHaveProperty('sandboxMode');
  });

  it('preserves context when a cross-provider switch starts a Claude session', async () => {
    await askChatWithContext({
      ...base,
      model: 'opus',
      priorMessages: [{ role: 'assistant', text: 'from Terra', ts: 'now' }],
      executor: null,
    });

    expect(askClaude).toHaveBeenCalledWith(expect.stringContaining('from Terra'), 'rune-session', 'SYSTEM', expect.objectContaining({ model: 'opus' }));
  });
});
