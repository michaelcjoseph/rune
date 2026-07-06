import { createLogger } from '../../utils/logger.js';
import {
  FOCUSES,
  LOCATIONS,
  generateWorkout,
  type Focus,
  type Location,
  type ParsedArgs,
} from '../../health/workout-generation.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-workout');

/** Parse `/workout` args. Tokens matching the location or focus vocabulary
 *  are extracted (last-write-wins); remaining tokens become the
 *  natural-language tail. Returns `null` when args are non-empty but consist
 *  entirely of 1–2 unrecognized tokens — that's a typo case (e.g. `/workout
 *  cardio`) we want to bounce back to the user with a usage line. */
export function parseWorkoutArgs(rawArgs: string): ParsedArgs | null {
  const trimmed = rawArgs.trim();
  if (!trimmed) return { location: null, focus: null, extra: '' };

  const tokens = trimmed.split(/\s+/);
  let location: Location | null = null;
  let focus: Focus | null = null;
  const remaining: string[] = [];

  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if ((LOCATIONS as readonly string[]).includes(lower)) {
      location = lower as Location;
    } else if ((FOCUSES as readonly string[]).includes(lower)) {
      focus = lower as Focus;
    } else {
      remaining.push(tok);
    }
  }

  if (location === null && focus === null && tokens.length <= 2) {
    return null;
  }

  return { location, focus, extra: remaining.join(' ') };
}

function usageMessage(): string {
  return [
    "I didn't recognize those args.",
    `Locations: ${LOCATIONS.join(', ')}`,
    `Focuses: ${FOCUSES.join(', ')}`,
    'Examples: `/workout`, `/workout gym strength`, `/workout home 30min quick`',
  ].join('\n');
}

export async function handleWorkout(sender: MessageSender, userId: number, args = ''): Promise<void> {
  const parsed = parseWorkoutArgs(args);
  if (parsed === null) {
    await sender.send(userId, usageMessage());
    return;
  }

  sender.startTyping(userId);
  try {
    const result = await generateWorkout(parsed);
    if ('error' in result) {
      log.error('Workout generation failed', { error: result.error });
      await sender.send(userId, 'Workout generation failed. Check server logs for details.');
      return;
    }
    await sender.send(userId, result.markdown);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Workout error', { error: message });
    await sender.send(userId, 'Workout generation failed. Check server logs for details.');
  } finally {
    sender.stopTyping(userId);
  }
}
