/**
 * Test-suite-as-deliverable for the Telegram UX (project 08-intent-layer
 * Phase 6 Track C / test-plan.md §20). Written test-first ahead of
 * C4/C5/C6 implementations; failing tests pin the contracts the impl
 * must satisfy:
 *
 *   - C4 (Telegram `/plan` command) — already shipped via A4.3.
 *     Tests here document the contract and pass today.
 *   - C5 (engine notifications) — gen-eval-loop terminal events emit
 *     formatted Telegram messages distinct from the existing generic
 *     work-run summary. Tests fail until the format lands.
 *   - C6 (approval inline-buttons) — `sender.send(userId, prompt,
 *     {approval: {prompt, options}})` renders as an inline-keyboard
 *     message; clicking a button routes the callback. Tests fail
 *     until `TelegramSender.send` honors `opts.approval` and the
 *     bot's callback-query handler is wired.
 *
 * DOM-side / actual network sends are mocked; the contract under test
 * is what TelegramSender writes to the bot SDK and how `dispatchText`
 * routes incoming messages.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    TG_MAX_MESSAGE_LENGTH: 4096,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_USER_ID: 42,
  },
}));

const mockSendLongMessage = vi.fn().mockResolvedValue(undefined);
const mockStartTyping = vi.fn().mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
const mockStopTyping = vi.fn();
vi.mock('../integrations/telegram/client.js', () => ({
  sendLongMessage: mockSendLongMessage,
  startTyping: mockStartTyping,
  stopTyping: mockStopTyping,
}));

const { TelegramSender } = await import('./telegram-sender.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockBot(): any {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendChatAction: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
  };
}

// ---------------------------------------------------------------------------
// §20. /plan <product> command (C4 — already shipped via A4.3)
// ---------------------------------------------------------------------------
//
// These tests document the live contract; they should pass today. They
// stay here so a regression in the /plan routing surfaces in this suite
// alongside C5/C6 expectations.

describe('Telegram UX — /plan command (C4)', () => {
  it.todo(
    '/plan aura creates a planning session and replies with the first scoping question',
  );
  it.todo(
    'subsequent free-form messages route through handlePlanningTurn until the session terminates',
  );
  it.todo(
    'when handlePlanningTurn returns spec-proposed, Jarvis sends an inline-keyboard approval message (C6)',
  );
  it.todo('/plan with no product lists registered products and waits for the user\'s choice');
  it.todo('/clear or /fresh during a planning session abandons it');
  it.todo('a planning session active for one user does not affect routing for other users');
});

// ---------------------------------------------------------------------------
// §20. Engine notifications (C5)
// ---------------------------------------------------------------------------
//
// The existing `TelegramSender.onMutationEvent` emits a generic
// `✅ /work --auto on <slug> finished` for any mutation. C5 specializes
// the gen-eval-loop terminal events into three structured formats with
// rounds, cross-model verdict, and short id — distinguishable from the
// generic work-run summary.

describe('Telegram UX — engine notifications (C5)', () => {
  let bot: ReturnType<typeof mockBot>;
  let sender: InstanceType<typeof TelegramSender>;

  beforeEach(() => {
    bot = mockBot();
    sender = new TelegramSender(bot);
    vi.clearAllMocks();
    mockSendLongMessage.mockResolvedValue(undefined);
  });

  it('gen-eval-loop `completed` sends the structured ✅ merged message with rounds + verdict + id', () => {
    sender.onMutationEvent({
      kind: 'mutation-event',
      subKind: 'completed',
      mutationId: 'mut-abcd1234-rest-of-uuid',
      mutationKind: 'gen-eval-loop',
      userId: 42,
      ts: '2026-05-25T12:00:00Z',
      data: {
        product: 'aura',
        project: '03-onboarding',
        rounds: 2,
        adjudication: {
          generatorModel: 'sonnet', generatorProvider: 'anthropic',
          evaluatorModel: 'codex', evaluatorProvider: 'openai',
          verdict: 'pass',
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const sentTexts = (mockSendLongMessage.mock.calls).map((c) => c[2] as string);
    const merged = sentTexts.find((t) => /✅.*merged to main/.test(t));
    expect(merged).toBeDefined();
    expect(merged!).toMatch(/aura\/03-onboarding/);
    expect(merged!).toMatch(/2 rounds/);
    expect(merged!).toMatch(/cross-model PASS/);
    expect(merged!).toMatch(/id=/);
  });

  it('gen-eval-loop escalated `failed` sends the structured ⏸ blocked-on-you message with reason + cockpit URL', () => {
    sender.onMutationEvent({
      kind: 'mutation-event',
      subKind: 'failed',
      mutationId: 'mut-12345678-rest-of-uuid',
      mutationKind: 'gen-eval-loop',
      userId: 42,
      ts: '2026-05-25T12:00:00Z',
      data: {
        product: 'aura',
        project: '03-onboarding',
        reason: 'escalated after 3 failed evaluator rounds (cap=3)',
        failedEvaluatorRounds: 3,
        cap: 3,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const sentTexts = (mockSendLongMessage.mock.calls).map((c) => c[2] as string);
    const blocked = sentTexts.find((t) => /⏸.*blocked on you/.test(t));
    expect(blocked).toBeDefined();
    expect(blocked!).toMatch(/aura\/03-onboarding/);
    expect(blocked!).toMatch(/3\/3/);
    expect(blocked!).toMatch(/id=/);
  });

  it('gen-eval-loop hard failure (worktree create, applier crash) sends the structured 💥 failed message', () => {
    sender.onMutationEvent({
      kind: 'mutation-event',
      subKind: 'failed',
      mutationId: 'mut-deadbeef-rest-of-uuid',
      mutationKind: 'gen-eval-loop',
      userId: 42,
      ts: '2026-05-25T12:00:00Z',
      data: {
        product: 'aura',
        project: '03-onboarding',
        reason: 'worktree create failed: refusing to create existing path',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const sentTexts = (mockSendLongMessage.mock.calls).map((c) => c[2] as string);
    const hardFail = sentTexts.find((t) => /💥.*failed/.test(t) && !/blocked on you/.test(t));
    expect(hardFail).toBeDefined();
    expect(hardFail!).toMatch(/worktree create failed/);
    expect(hardFail!).toMatch(/id=/);
  });

  it('does NOT duplicate — one terminal event sends exactly one structured message (the existing tracker is replaced, not added to)', () => {
    sender.onMutationEvent({
      kind: 'mutation-event',
      subKind: 'completed',
      mutationId: 'mut-abcd1234-rest',
      mutationKind: 'gen-eval-loop',
      userId: 42,
      ts: '2026-05-25T12:00:00Z',
      data: { product: 'aura', project: '03', rounds: 1 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // For gen-eval-loop terminal events, exactly one structured message
    // should fire — NOT both the structured one and the generic
    // `✅ /work --auto on …` one. The C5 impl must specialize the
    // gen-eval-loop branch and skip the generic fall-through.
    expect(mockSendLongMessage).toHaveBeenCalledTimes(1);
  });

  it('non-specialized mutation kinds keep the existing generic ✅ /work --auto format (no regression)', () => {
    // gen-eval-loop (C5) and work-run (project 11) have specialized formatters;
    // every OTHER kind (project-edit, proposal-action, …) keeps the generic
    // format. work-run itself no longer uses it — its outcome-aware + early-exit
    // rendering is covered in telegram-sender.test.ts.
    sender.onMutationEvent({
      kind: 'mutation-event',
      subKind: 'completed',
      mutationId: 'mut-edit-1',
      mutationKind: 'project-edit',
      userId: 42,
      ts: '2026-05-25T12:00:00Z',
      data: { slug: '08-intent-layer', durationMs: 5000 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const sent = (mockSendLongMessage.mock.calls[0]![2] as string);
    expect(sent).toMatch(/\/work --auto on 08-intent-layer/);
  });
});

// ---------------------------------------------------------------------------
// §20. Approval inline-buttons (C6)
// ---------------------------------------------------------------------------
//
// Today TelegramSender.send() ignores `opts.approval` (the SendOpts.approval
// field exists in the interface but the TG implementation has no branch for
// it). C6 wires the inline-keyboard rendering and the callback-query
// handler that routes button clicks.

describe('Telegram UX — approval inline-buttons (C6)', () => {
  let bot: ReturnType<typeof mockBot>;
  let sender: InstanceType<typeof TelegramSender>;

  beforeEach(() => {
    bot = mockBot();
    sender = new TelegramSender(bot);
    vi.clearAllMocks();
    mockSendLongMessage.mockResolvedValue(undefined);
  });

  it('sender.send with opts.approval renders as an inline-keyboard message (one button per option)', async () => {
    await sender.send(42, 'Approve the proposed spec?', {
      approval: {
        prompt: 'Approve the proposed spec?',
        options: [
          { value: 'approve', label: 'Approve' },
          { value: 'refine', label: 'Refine' },
          { value: 'abandon', label: 'Abandon' },
        ],
      },
    });
    // The keyboard render goes via bot.sendMessage with reply_markup,
    // NOT through the bare sendLongMessage path.
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
    const [, , optsArg] = bot.sendMessage.mock.calls[0]!;
    expect(optsArg).toBeDefined();
    expect(optsArg.reply_markup).toBeDefined();
    expect(optsArg.reply_markup.inline_keyboard).toBeDefined();
    // One row per option, or all options in one row — the impl is free
    // to choose layout; what matters is each option produces one button.
    const buttons = optsArg.reply_markup.inline_keyboard.flat();
    expect(buttons.length).toBe(3);
    expect(buttons.map((b: { text: string }) => b.text)).toEqual(['Approve', 'Refine', 'Abandon']);
  });

  it('plain send (no opts.approval) does NOT use inline-keyboard — stays on the plain sendLongMessage path', async () => {
    await sender.send(42, 'Just a normal message');
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(mockSendLongMessage).toHaveBeenCalledTimes(1);
  });

  it('each inline button carries its option value as the callback_data payload', async () => {
    await sender.send(42, 'Pick one', {
      approval: {
        prompt: 'Pick one',
        options: [
          { value: 'approve-plan-xyz', label: 'Approve' },
          { value: 'reject-plan-xyz', label: 'Reject' },
        ],
      },
    });
    const [, , optsArg] = bot.sendMessage.mock.calls[0]!;
    const buttons = optsArg.reply_markup.inline_keyboard.flat() as Array<{ callback_data: string }>;
    expect(buttons.map((b) => b.callback_data)).toEqual(['approve-plan-xyz', 'reject-plan-xyz']);
  });
});
