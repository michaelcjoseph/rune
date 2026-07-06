import { appendToJournal } from '../../vault/journal.js';
import { createLogger } from '../../utils/logger.js';
import {
  clearLastWorkout,
  formatBlock,
  readLastWorkout,
} from '../../health/last-workout.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-done-workout');

const STALE_HOURS = 48;
const CONFIRM_WINDOW_MS = 10 * 60 * 1000;

let lastStaleWarnAt: number | null = null;

function ageHours(generatedAt: string): number {
  const ms = Date.now() - new Date(generatedAt).getTime();
  return ms / 3_600_000;
}

export async function handleDoneWorkout(sender: MessageSender, userId: number): Promise<void> {
  const result = readLastWorkout();
  if (result.status === 'missing') {
    await sender.send(userId, "Nothing to log — run /workout first.");
    return;
  }
  if (result.status === 'corrupt') {
    await sender.send(userId, 'Could not parse the last workout file.');
    return;
  }
  const entry = result.entry;

  const age = ageHours(entry.generated_at);
  if (age > STALE_HOURS) {
    const now = Date.now();
    if (lastStaleWarnAt !== null && now - lastStaleWarnAt <= CONFIRM_WINDOW_MS) {
      lastStaleWarnAt = null;
    } else {
      lastStaleWarnAt = now;
      await sender.send(userId,
        `This workout was generated ${Math.round(age)} hours ago. Run /done-workout again within 10 minutes to confirm.`,
      );
      return;
    }
  } else {
    lastStaleWarnAt = null;
  }

  try {
    appendToJournal(formatBlock(entry));
  } catch (err) {
    log.error('Journal append failed', { error: String(err) });
    await sender.send(userId, 'Could not append to today\'s journal. The workout file is preserved — try again.');
    return;
  }

  // Append succeeded; clearLastWorkout is best-effort (a failed delete only
  // risks a duplicate log on a second /done-workout, and logs internally).
  clearLastWorkout();
  await sender.send(userId, 'Logged. Nightly /daily will parse into workouts.json.');
}

/** Test-only — reset the in-memory stale-warning timestamp between tests. */
export function _resetDoneWorkoutState(): void {
  lastStaleWarnAt = null;
}
