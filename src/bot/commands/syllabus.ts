import { readVaultFile } from '../../vault/files.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-syllabus');

function formatProgress(raw: string): string {
  try {
    const data = JSON.parse(raw);
    const parts: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      parts.push(`${key}: ${value}`);
    }
    return parts.join(' | ');
  } catch {
    return raw.trim();
  }
}

export async function handleSyllabus(sender: MessageSender, userId: number): Promise<void> {
  try {
    const syllabus = readVaultFile('study/syllabus.md');
    const progress = readVaultFile('study/progress.json');

    if (!syllabus?.trim() && !progress?.trim()) {
      await sender.send(userId, 'No study data found (study/syllabus.md and study/progress.json missing).');
      return;
    }

    const sections: string[] = [];

    if (progress?.trim()) {
      sections.push(`Progress: ${formatProgress(progress)}`);
    }

    if (syllabus?.trim()) {
      sections.push(syllabus.trim());
    }

    await sender.send(userId, sections.join('\n\n'));
  } catch (err) {
    log.error('Syllabus error', { error: (err as Error).message });
    await sender.send(userId, `Error: ${(err as Error).message}`);
  }
}
