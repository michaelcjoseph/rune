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
    WORKSPACE_DIR: '/test/workspace',
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
  authority: 'read-only' as const,
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
        authority: 'read-only',
        cwd: '/test/vault',
      },
    });
  });

  it('gives a fresh write-enabled Codex product chat full Git-capable access', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      authority: 'product-full-access',
      product: 'rune',
      cwd: '/workspace/rune',
      writableRoot: '/workspace/rune',
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
      authority: 'product-full-access',
      cwd: '/workspace/rune',
      writableRoot: '/workspace/rune',
    });
    const configOverrides = runCodex.mock.calls[0]![1].configOverrides as string[];
    expect(configOverrides).toHaveLength(1);
    expect(configOverrides[0]).toContain('cockpit_list_runs');
    expect(configOverrides[0]).toContain('cockpit_inspect_run');
    expect(configOverrides[0]).toContain('cockpit_active_runs');
  });

  it('gives an unresolved product constrained workspace-write access without product MCP diagnostics', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      authority: 'product-workspace-write',
      product: 'unknown',
      cwd: '/test/workspace',
      writableRoot: '/test/workspace',
    });

    expect(runCodex).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      cwd: '/test/workspace',
      product: 'unknown',
      persistentSession: true,
      sandboxMode: 'workspace-write',
      strictConfig: true,
      ignoreUserConfig: true,
      ignoreRules: true,
    }));
    const configOverrides = runCodex.mock.calls[0]![1].configOverrides as string[];
    expect(configOverrides).toEqual(expect.arrayContaining([
      'mcp_servers={}',
      'features.hooks=false',
      'features.apps=false',
      'features.remote_plugin=false',
      'sandbox_workspace_write.network_access=false',
      'sandbox_workspace_write.writable_roots=[]',
      'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      'sandbox_workspace_write.exclude_slash_tmp=true',
    ]));
    expect(result.executor).toEqual({
      format: 'codex',
      sessionId: 'codex-thread',
      authority: 'product-workspace-write',
      cwd: '/test/workspace',
      writableRoot: '/test/workspace',
    });
  });

  it('gives fallback Claude chat an empty strict MCP surface', async () => {
    await askChatWithContext({
      ...base,
      model: 'opus',
      authority: 'product-workspace-write',
      product: 'unknown',
      cwd: '/test/workspace',
      writableRoot: '/test/workspace',
      allowedTools: ['Read', 'Edit', 'Write', 'Bash'],
    });

    const options = askClaude.mock.calls[0]![3];
    expect(options.mcpArgs?.slice(0, 2)).toEqual(['--strict-mcp-config', '--mcp-config']);
    expect(JSON.parse(options.mcpArgs[2])).toEqual({ mcpServers: {} });
    expect(options.allowedTools).toEqual(['Read', 'Edit', 'Write', 'Bash']);
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

  it('resumes an existing Codex thread while reasserting read-only authority', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      priorMessages: [{ role: 'user', text: 'do not replay', ts: 'now' }],
      executor: {
        format: 'codex',
        sessionId: 'codex-thread',
        authority: 'read-only',
        cwd: '/test/vault',
      },
    });

    expect(runCodex).toHaveBeenCalledWith('current question', expect.objectContaining({
      resumeSessionId: 'codex-thread',
      persistentSession: true,
      sandboxMode: 'read-only',
    }));
    expect(result.executor).toEqual({
      format: 'codex',
      sessionId: 'codex-thread',
      authority: 'read-only',
      cwd: '/test/vault',
    });
  });

  it.each([
    {
      name: 'resolved product to fallback workspace',
      request: {
        authority: 'product-workspace-write' as const,
        product: 'rune',
        cwd: '/test/workspace',
        writableRoot: '/test/workspace',
      },
      executor: {
        format: 'codex' as const,
        sessionId: 'full-access-thread',
        authority: 'product-full-access' as const,
        cwd: '/workspace/rune',
        writableRoot: '/workspace/rune',
      },
      sandboxMode: 'workspace-write',
      expectedCwd: '/test/workspace',
      expectedProduct: 'rune',
    },
    {
      name: 'fallback workspace to resolved product',
      request: {
        authority: 'product-full-access' as const,
        product: 'rune',
        cwd: '/workspace/rune',
        writableRoot: '/workspace/rune',
      },
      executor: {
        format: 'codex' as const,
        sessionId: 'fallback-thread',
        authority: 'product-workspace-write' as const,
        cwd: '/test/workspace',
        writableRoot: '/test/workspace',
      },
      sandboxMode: 'danger-full-access',
      expectedCwd: '/workspace/rune',
      expectedProduct: 'rune',
    },
    {
      name: 'fallback workspace to global read-only',
      request: {
        authority: 'read-only' as const,
      },
      executor: {
        format: 'codex' as const,
        sessionId: 'fallback-thread',
        authority: 'product-workspace-write' as const,
        cwd: '/test/workspace',
        writableRoot: '/test/workspace',
      },
      sandboxMode: 'read-only',
      expectedCwd: '/test/vault',
      expectedProduct: undefined,
    },
  ])('rotates and replays context across $name', async ({
    request,
    executor,
    sandboxMode,
    expectedCwd,
    expectedProduct,
  }) => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      priorMessages: [{ role: 'assistant', text: 'authority boundary context', ts: 'now' }],
      executor,
      ...request,
    });

    const [prompt, options] = runCodex.mock.calls[0]!;
    expect(prompt).toContain('SYSTEM');
    expect(prompt).toContain('authority boundary context');
    expect(options).toEqual(expect.objectContaining({
      cwd: expectedCwd,
      sandboxMode,
      ...(expectedProduct ? { product: expectedProduct } : {}),
    }));
    expect(options).not.toHaveProperty('resumeSessionId');
    expect(result.executor).toEqual({
      format: 'codex',
      sessionId: 'codex-thread',
      authority: request.authority,
      cwd: expectedCwd,
      ...('writableRoot' in request ? { writableRoot: request.writableRoot } : {}),
    });
  });

  it('does not treat a legacy read-only product record as fallback workspace authority', async () => {
    await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'rune',
      cwd: '/test/workspace',
      writableRoot: '/test/workspace',
      authority: 'product-workspace-write',
      priorMessages: [{ role: 'assistant', text: 'legacy product context', ts: 'now' }],
      executor: { format: 'codex', sessionId: 'legacy-product-thread', writeEnabled: false },
    });

    const [prompt, options] = runCodex.mock.calls[0]!;
    expect(prompt).toContain('legacy product context');
    expect(options).toEqual(expect.objectContaining({
      cwd: '/test/workspace',
      product: 'rune',
      sandboxMode: 'workspace-write',
    }));
    expect(options).not.toHaveProperty('resumeSessionId');
  });

  it('starts a full-access thread with replayed context when an unresolved product gains a workspace', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'rune',
      cwd: '/workspace/rune',
      writableRoot: '/workspace/rune',
      authority: 'product-full-access',
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
      authority: 'product-full-access',
      cwd: '/workspace/rune',
      writableRoot: '/workspace/rune',
    });
  });

  it('resumes a matching full-access product thread while reasserting its sandbox', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'rune',
      cwd: '/workspace/rune',
      writableRoot: '/workspace/rune',
      authority: 'product-full-access',
      priorMessages: [{ role: 'user', text: 'do not replay this product turn', ts: 'now' }],
      executor: {
        format: 'codex',
        sessionId: 'full-access-thread',
        writeEnabled: true,
        cwd: '/workspace/rune',
        writableRoot: '/workspace/rune',
      },
    });

    expect(runCodex).toHaveBeenCalledWith('current question', expect.objectContaining({
      cwd: '/workspace/rune',
      product: 'rune',
      resumeSessionId: 'full-access-thread',
      sandboxMode: 'danger-full-access',
    }));
    expect(result.executor).toEqual({
      format: 'codex',
      sessionId: 'full-access-thread',
      authority: 'product-full-access',
      cwd: '/workspace/rune',
      writableRoot: '/workspace/rune',
    });
    const configOverrides = runCodex.mock.calls[0]![1].configOverrides as string[];
    expect(configOverrides).toHaveLength(1);
    expect(configOverrides[0]).toContain('cockpit_inspect_run');
  });

  it('rotates matching Codex metadata without a thread id and replays the boundary prompt', async () => {
    await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'rune',
      cwd: '/workspace/rune',
      writableRoot: '/workspace/rune',
      authority: 'product-full-access',
      priorMessages: [{ role: 'assistant', text: 'earlier boundary context', ts: 'now' }],
      executor: {
        format: 'codex',
        authority: 'product-full-access',
        cwd: '/workspace/rune',
        writableRoot: '/workspace/rune',
      },
    });

    const [prompt, options] = runCodex.mock.calls[0]!;
    expect(prompt).toContain('SYSTEM');
    expect(prompt).toContain('VOICE');
    expect(prompt).toContain('earlier boundary context');
    expect(options).toEqual(expect.objectContaining({
      sandboxMode: 'danger-full-access',
      cwd: '/workspace/rune',
    }));
    expect(options).not.toHaveProperty('resumeSessionId');
  });

  it('passes the product-scoped MCP registration to Claude product chats', async () => {
    await askChatWithContext({
      ...base,
      model: 'opus',
      product: 'assay',
      cwd: '/workspace/assay',
      writableRoot: '/workspace/assay',
      authority: 'product-full-access',
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
      authority: 'product-full-access',
      priorMessages: [{ role: 'assistant', text: 'earlier scoped answer', ts: 'now' }],
      executor: {
        format: 'codex',
        sessionId: 'writing-scope-thread',
        authority: 'product-full-access',
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
      authority: 'product-full-access',
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
      writableRoot: '/workspace/rune-new',
      authority: 'product-full-access',
      priorMessages: [{ role: 'assistant', text: 'earlier repository answer', ts: 'now' }],
      executor: {
        format: 'codex',
        sessionId: 'old-repository-thread',
        authority: 'product-full-access',
        cwd: '/workspace/rune-old',
        writableRoot: '/workspace/rune-old',
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

  it('resumes a full-access thread whose scoped writable root still matches and reasserts authority', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'writing',
      cwd: '/workspace/writing',
      writableRoot: '/workspace/writing/docs/rune',
      authority: 'product-full-access',
      priorMessages: [{ role: 'user', text: 'do not replay scoped history', ts: 'now' }],
      executor: {
        format: 'codex',
        sessionId: 'writing-scope-thread',
        authority: 'product-full-access',
        cwd: '/workspace/writing',
        writableRoot: '/workspace/writing/docs/rune',
      },
    });

    expect(runCodex).toHaveBeenCalledWith('current question', expect.objectContaining({
      cwd: '/workspace/writing',
      product: 'writing',
      resumeSessionId: 'writing-scope-thread',
      sandboxMode: 'danger-full-access',
    }));
    expect(result.executor).toEqual({
      format: 'codex',
      sessionId: 'writing-scope-thread',
      authority: 'product-full-access',
      cwd: '/workspace/writing',
      writableRoot: '/workspace/writing/docs/rune',
    });
  });

  it('resumes a matching fallback workspace thread and reasserts workspace-write authority', async () => {
    const result = await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'unknown',
      cwd: '/test/workspace',
      writableRoot: '/test/workspace',
      authority: 'product-workspace-write',
      priorMessages: [{ role: 'user', text: 'do not replay fallback history', ts: 'now' }],
      executor: {
        format: 'codex',
        sessionId: 'fallback-thread',
        authority: 'product-workspace-write',
        cwd: '/test/workspace',
        writableRoot: '/test/workspace',
      },
    });

    expect(runCodex).toHaveBeenCalledWith('current question', expect.objectContaining({
      cwd: '/test/workspace',
      product: 'unknown',
      resumeSessionId: 'fallback-thread',
      sandboxMode: 'workspace-write',
    }));
    expect(result.executor).toEqual({
      format: 'codex',
      sessionId: 'fallback-thread',
      authority: 'product-workspace-write',
      cwd: '/test/workspace',
      writableRoot: '/test/workspace',
    });
  });

  it.each([
    {
      name: 'fallback cwd',
      executor: {
        format: 'codex' as const,
        sessionId: 'fallback-old-cwd',
        authority: 'product-workspace-write' as const,
        cwd: '/old/workspace',
        writableRoot: '/test/workspace',
      },
    },
    {
      name: 'fallback writable root',
      executor: {
        format: 'codex' as const,
        sessionId: 'fallback-old-root',
        authority: 'product-workspace-write' as const,
        cwd: '/test/workspace',
        writableRoot: '/old/workspace',
      },
    },
  ])('rotates a fallback thread when its $name changes', async ({ executor }) => {
    await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'unknown',
      cwd: '/test/workspace',
      writableRoot: '/test/workspace',
      authority: 'product-workspace-write',
      priorMessages: [{ role: 'assistant', text: 'fallback boundary context', ts: 'now' }],
      executor,
    });

    const [prompt, options] = runCodex.mock.calls[0]!;
    expect(prompt).toContain('fallback boundary context');
    expect(options).toEqual(expect.objectContaining({
      cwd: '/test/workspace',
      sandboxMode: 'workspace-write',
    }));
    expect(options).not.toHaveProperty('resumeSessionId');
  });

  it('rotates a metadata-less legacy product thread and replays its transcript', async () => {
    await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      product: 'rune',
      cwd: '/workspace/rune',
      writableRoot: '/workspace/rune',
      authority: 'product-full-access',
      priorMessages: [{ role: 'assistant', text: 'legacy answer to replay', ts: 'now' }],
      executor: { format: 'codex', sessionId: 'legacy-thread' },
    });

    const [prompt, options] = runCodex.mock.calls[0]!;
    expect(prompt).toContain('legacy answer to replay');
    expect(options).toEqual(expect.objectContaining({
      cwd: '/workspace/rune',
      sandboxMode: 'danger-full-access',
    }));
    expect(options).not.toHaveProperty('resumeSessionId');
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
