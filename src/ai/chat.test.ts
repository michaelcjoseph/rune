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
    runCodex.mockImplementation(async (_prompt: string, opts: { onEvent?: (event: Record<string, unknown>) => void }) => {
      opts.onEvent?.({ type: 'thread.started', thread_id: 'codex-thread' });
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
    expect(result).toEqual({ text: 'codex reply', error: null, executor: { format: 'codex', sessionId: 'codex-thread' } });
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
    await askChatWithContext({
      ...base,
      model: 'gpt-5.6-terra',
      priorMessages: [{ role: 'user', text: 'do not replay', ts: 'now' }],
      executor: { format: 'codex', sessionId: 'codex-thread' },
    });

    expect(runCodex).toHaveBeenCalledWith('current question', expect.objectContaining({
      resumeSessionId: 'codex-thread',
      persistentSession: true,
    }));
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
