import { seedAndProcess } from '../../kb/seed.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-seed');

export async function handleSeed(sender: MessageSender, userId: number, args: string): Promise<void> {
  const dryRun = args.trim() === '--dry-run';

  await sender.send(userId,
    dryRun ? 'Scanning vault for seed sources...' : 'Seeding KB: discovering and enqueuing vault files...',
  );
  sender.startTyping(userId);

  try {
    const result = await seedAndProcess(
      undefined,
      async (msg) => {
        await sender.send(userId, msg);
      },
      { dryRun, processAfter: !dryRun },
    );

    sender.stopTyping(userId);

    const summary = [
      `Seed complete.`,
      `Discovered: ${result.seed.discovered}`,
      `Already ingested: ${result.seed.skippedAlreadyIngested}`,
      `Enqueued: ${result.seed.enqueued}`,
    ];

    if (!dryRun) {
      summary.push(`Processed: ${result.processed}`, `Errors: ${result.errors}`);
    }

    await sender.send(userId, summary.join('\n'));
  } catch (err) {
    sender.stopTyping(userId);
    log.error('Seed error', { error: (err as Error).message });
    await sender.send(userId, `Seed error: ${(err as Error).message}`);
  }
}
