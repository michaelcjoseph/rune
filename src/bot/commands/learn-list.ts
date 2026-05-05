import type { MessageSender } from '../../transport/sender.js';
import {
  recentLearnings,
  DEFAULT_LEARNINGS_LIMIT,
  type LearningEntry,
} from '../../vault/learnings.js';

function formatLearning(entry: LearningEntry): string {
  const date = entry.ts.slice(0, 10); // YYYY-MM-DD from ISO; appendLearning always writes ISO
  return `• [${date}] ${entry.text}`;
}

export function formatLearningsList(
  entries: LearningEntry[],
  limit: number = DEFAULT_LEARNINGS_LIMIT,
): string {
  if (entries.length === 0) {
    return 'No learnings yet. Use /learn <text> to add one.';
  }
  // Oldest-first in the list so the most recent (highest weight) appears last.
  const lines = entries.map(formatLearning);
  const header = `Prepending the ${entries.length} most recent learning${entries.length === 1 ? '' : 's'} (limit ${limit}):`;
  return [header, ...lines].join('\n');
}

export async function handleLearnList(sender: MessageSender, userId: number): Promise<void> {
  const entries = recentLearnings();
  await sender.send(userId, formatLearningsList(entries));
}
