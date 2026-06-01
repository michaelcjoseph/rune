import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks must precede the import of the module under test ---

const mockConfig = {
  IS_PRODUCTION: false as boolean,
  LAUNCHD_LABEL: 'com.jarvis.daemon',
};
vi.mock('../config.js', () => ({ default: mockConfig }));

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { restartServer } = await import('./restart.js');

function fakeChild() {
  return { unref: vi.fn() };
}

describe('server/restart restartServer', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockConfig.IS_PRODUCTION = false;
    mockConfig.LAUNCHD_LABEL = 'com.jarvis.daemon';
  });

  it('refuses and does not spawn outside production', () => {
    mockConfig.IS_PRODUCTION = false;
    const result = restartServer();
    expect(result).toEqual({ ok: false, reason: 'not-production' });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns a detached, unref\'d launchctl kickstart -k in production', () => {
    mockConfig.IS_PRODUCTION = true;
    const child = fakeChild();
    mockSpawn.mockReturnValue(child);

    const result = restartServer();

    expect(result).toEqual({ ok: true });
    const uid = (process.getuid as () => number)();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      'launchctl',
      ['kickstart', '-k', `gui/${uid}/com.jarvis.daemon`],
      { detached: true, stdio: 'ignore' },
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('honors a custom LAUNCHD_LABEL', () => {
    mockConfig.IS_PRODUCTION = true;
    mockConfig.LAUNCHD_LABEL = 'com.example.custom';
    mockSpawn.mockReturnValue(fakeChild());

    restartServer();

    const uid = (process.getuid as () => number)();
    expect(mockSpawn).toHaveBeenCalledWith(
      'launchctl',
      ['kickstart', '-k', `gui/${uid}/com.example.custom`],
      { detached: true, stdio: 'ignore' },
    );
  });

  it('returns spawn-failed when spawn throws', () => {
    mockConfig.IS_PRODUCTION = true;
    mockSpawn.mockImplementation(() => { throw new Error('boom'); });

    const result = restartServer();

    expect(result).toEqual({ ok: false, reason: 'spawn-failed' });
  });
});
