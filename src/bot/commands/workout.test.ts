import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadVaultFile = vi.fn();
const mockGetDayOfWeek = vi.fn();

vi.mock('../../vault/files.js', () => ({
  readVaultFile: mockReadVaultFile,
}));

vi.mock('../../utils/time.js', () => ({
  getDayOfWeek: mockGetDayOfWeek,
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { handleWorkout } = await import('./workout.js');

describe('handleWorkout', () => {
  const mockBot = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
  const chatId = 123;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDayOfWeek.mockReturnValue('Monday');
  });

  it('sends workout section when health/plan.md has a section for today', async () => {
    const planContent = '# Workout Plan\n\n## Monday\nSquats 5x5\nBench 3x8\n\n## Tuesday\nDeadlifts 3x5\n';
    mockReadVaultFile.mockReturnValue(planContent);

    await handleWorkout(mockBot, chatId);

    expect(mockReadVaultFile).toHaveBeenCalledWith('health/plan.md');
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      "Monday's workout:\n\nSquats 5x5\nBench 3x8",
    );
  });

  it('sends "No workout plan found" when health/plan.md does not exist', async () => {
    mockReadVaultFile.mockReturnValue(null);

    await handleWorkout(mockBot, chatId);

    expect(mockReadVaultFile).toHaveBeenCalledWith('health/plan.md');
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      'No workout plan found (health/plan.md missing).',
    );
  });

  it('sends "No workout plan found" when file content is empty', async () => {
    mockReadVaultFile.mockReturnValue('');

    await handleWorkout(mockBot, chatId);

    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      'No workout plan found (health/plan.md missing).',
    );
  });

  it('sends "No workout prescription" when file exists but no section for today', async () => {
    const planContent = '# Workout Plan\n\n## Tuesday\nDeadlifts 3x5\n\n## Wednesday\nRest\n';
    mockReadVaultFile.mockReturnValue(planContent);

    await handleWorkout(mockBot, chatId);

    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      'No workout prescription for Monday.',
    );
  });

  it('handles section being the last one in the file', async () => {
    const planContent = '# Workout Plan\n\n## Sunday\nYoga\n\n## Monday\nSquats 5x5\nBench 3x8';
    mockReadVaultFile.mockReturnValue(planContent);

    await handleWorkout(mockBot, chatId);

    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      "Monday's workout:\n\nSquats 5x5\nBench 3x8",
    );
  });

  it('sends error message when an exception is thrown', async () => {
    mockReadVaultFile.mockImplementation(() => {
      throw new Error('disk read failed');
    });

    await handleWorkout(mockBot, chatId);

    expect(mockBot.sendMessage).toHaveBeenCalledWith(chatId, 'Error: disk read failed');
  });
});
