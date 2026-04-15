import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadVaultFile = vi.fn();
const mockGetTodayDate = vi.fn();

vi.mock('../../vault/files.js', () => ({
  readVaultFile: mockReadVaultFile,
}));

vi.mock('../../utils/time.js', () => ({
  getTodayDate: mockGetTodayDate,
}));

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { handleCareer } = await import('./career.js');

describe('handleCareer', () => {
  const mockBot = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
  const chatId = 123;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTodayDate.mockReturnValue('2026-04-14');
  });

  it('shows active applications sorted by staleness (most stale first)', async () => {
    mockReadVaultFile.mockReturnValue(
      JSON.stringify([
        { company: 'Acme', role: 'Engineer', status: 'applied', dateApplied: '2026-04-10', lastUpdated: '2026-04-12' },
        { company: 'Globex', role: 'Senior Engineer', status: 'interviewing', dateApplied: '2026-03-01', lastUpdated: '2026-03-20' },
        { company: 'Initech', role: 'Staff Engineer', status: 'applied', dateApplied: '2026-04-01', lastUpdated: '2026-04-10' },
      ]),
    );

    await handleCareer(mockBot, chatId);

    const msg = mockBot.sendMessage.mock.calls[0][1] as string;
    const lines = msg.split('\n');
    // Globex (25d) should appear before Initech (4d) before Acme (2d)
    const globexIdx = lines.findIndex((l: string) => l.includes('Globex'));
    const initechIdx = lines.findIndex((l: string) => l.includes('Initech'));
    const acmeIdx = lines.findIndex((l: string) => l.includes('Acme'));
    expect(globexIdx).toBeLessThan(initechIdx);
    expect(initechIdx).toBeLessThan(acmeIdx);
  });

  it('flags stale applications (14+ days since lastUpdated)', async () => {
    mockReadVaultFile.mockReturnValue(
      JSON.stringify([
        { company: 'StaleCorps', role: 'Dev', status: 'applied', dateApplied: '2026-03-01', lastUpdated: '2026-03-15' },
        { company: 'FreshCo', role: 'Dev', status: 'applied', dateApplied: '2026-04-10', lastUpdated: '2026-04-13' },
      ]),
    );

    await handleCareer(mockBot, chatId);

    const msg = mockBot.sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('!! StaleCorps');
    expect(msg).not.toContain('!! FreshCo');
    expect(msg).toContain('FreshCo');
  });

  it('filters out rejected/withdrawn/accepted applications', async () => {
    mockReadVaultFile.mockReturnValue(
      JSON.stringify([
        { company: 'Active', role: 'Dev', status: 'applied', dateApplied: '2026-04-01', lastUpdated: '2026-04-10' },
        { company: 'Rejected', role: 'Dev', status: 'Rejected', dateApplied: '2026-03-01', lastUpdated: '2026-03-15' },
        { company: 'Withdrawn', role: 'Dev', status: 'withdrawn', dateApplied: '2026-03-01', lastUpdated: '2026-03-15' },
        { company: 'Accepted', role: 'Dev', status: 'Accepted', dateApplied: '2026-03-01', lastUpdated: '2026-03-15' },
      ]),
    );

    await handleCareer(mockBot, chatId);

    const msg = mockBot.sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('Active');
    expect(msg).not.toContain('Rejected');
    expect(msg).not.toContain('Withdrawn');
    expect(msg).not.toContain('Accepted');
  });

  it('shows "No applications file found" when file is missing', async () => {
    mockReadVaultFile.mockReturnValue(null);

    await handleCareer(mockBot, chatId);

    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      chatId,
      'No applications file found (career/applications.json).',
    );
  });

  it('shows "No active applications" when all are rejected/withdrawn', async () => {
    mockReadVaultFile.mockReturnValue(
      JSON.stringify([
        { company: 'A', role: 'Dev', status: 'rejected', dateApplied: '2026-03-01', lastUpdated: '2026-03-15' },
        { company: 'B', role: 'Dev', status: 'withdrawn', dateApplied: '2026-03-01', lastUpdated: '2026-03-15' },
      ]),
    );

    await handleCareer(mockBot, chatId);

    expect(mockBot.sendMessage).toHaveBeenCalledWith(chatId, 'No active applications.');
  });

  it('handles malformed JSON gracefully (error message)', async () => {
    mockReadVaultFile.mockReturnValue('not valid json {{{');

    await handleCareer(mockBot, chatId);

    const msg = mockBot.sendMessage.mock.calls[0][1] as string;
    expect(msg).toMatch(/^Error:/);
  });

  it('summary line shows correct active and stale counts', async () => {
    mockReadVaultFile.mockReturnValue(
      JSON.stringify([
        { company: 'Stale1', role: 'Dev', status: 'applied', dateApplied: '2026-03-01', lastUpdated: '2026-03-01' },
        { company: 'Stale2', role: 'Dev', status: 'interviewing', dateApplied: '2026-03-01', lastUpdated: '2026-03-25' },
        { company: 'Fresh', role: 'Dev', status: 'applied', dateApplied: '2026-04-10', lastUpdated: '2026-04-13' },
        { company: 'Gone', role: 'Dev', status: 'rejected', dateApplied: '2026-03-01', lastUpdated: '2026-03-15' },
      ]),
    );

    await handleCareer(mockBot, chatId);

    const msg = mockBot.sendMessage.mock.calls[0][1] as string;
    expect(msg).toContain('3 active | 2 stale (14+ days)');
  });
});
