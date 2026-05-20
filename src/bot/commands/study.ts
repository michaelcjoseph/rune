import type { MessageSender } from '../../transport/sender.js';
import { createLogger } from '../../utils/logger.js';
import { getTodayDate } from '../../utils/time.js';
import { runSRSession } from '../../study/sr-session.js';
import { readSRState } from '../../study/sr-state.js';
import { readPool } from '../../study/sr-pool.js';
import { selectDueConcepts } from '../../study/sr-select.js';

const log = createLogger('cmd-study');

const DEFAULT_CAP = 5;
const MIN_CAP = 1;
const MAX_CAP = 10;

const USAGE = 'Usage: /study, /study <N> (1-10 questions), or /study status';

/** `/study` — spaced-repetition session entry point.
 *  - no arg      → a 5-question session
 *  - integer arg → an N-question session, N clamped to [1, 10]
 *  - `status`    → SR pool size and due-today count
 *  An already-running session is rejected inside `runSRSession`. */
export async function handleStudy(
  sender: MessageSender,
  userId: number,
  args: string,
): Promise<void> {
  const arg = args.trim();

  if (arg.toLowerCase() === 'status') {
    return handleStatus(sender, userId);
  }

  let cap = DEFAULT_CAP;
  if (arg) {
    // Require the whole arg to be an integer — `parseInt` alone would accept
    // "3foo" / "3.9" and silently start a session.
    if (!/^-?\d+$/.test(arg)) {
      await sender.send(userId, USAGE);
      return;
    }
    const n = Number.parseInt(arg, 10);
    cap = Math.min(MAX_CAP, Math.max(MIN_CAP, n));
    if (cap !== n) {
      await sender.send(userId, `Clamped to ${cap} (allowed range ${MIN_CAP}-${MAX_CAP}).`);
    }
  }

  await runSRSession({ source: 'manual', cap, userId, sender });
}

/** `/study status` — Phase 1: pool size + due-today count. Lapse hotspots are
 *  added in Phase 2. */
async function handleStatus(sender: MessageSender, userId: number): Promise<void> {
  try {
    const pool = readPool();
    if (pool.length === 0) {
      await sender.send(userId, 'SR pool: 0 concepts · due today: 0');
      return;
    }
    const today = getTodayDate();
    const state = readSRState();
    // Pass cap = pool.length so the count reflects every due concept, uncapped.
    const due = selectDueConcepts({ pool, state, today, cap: pool.length });
    await sender.send(
      userId,
      `SR pool: ${pool.length} concept${pool.length === 1 ? '' : 's'} · due today: ${due.length}`,
    );
  } catch (err) {
    log.error('Study status error', { error: err instanceof Error ? err.message : String(err) });
    await sender.send(userId, 'Could not read study status — see the logs.');
  }
}
