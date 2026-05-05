import { ingestSource, processIngestionQueue } from '../../kb/engine.js';
import { getQueue } from '../../kb/queue.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-ingest');

export async function handleIngest(sender: MessageSender, userId: number, args: string): Promise<void> {
  const trimmed = args.trim();

  // If no args, process the ingestion queue
  if (!trimmed) {
    const queue = getQueue();
    if (queue.length === 0) {
      await sender.send(userId, 'Ingestion queue is empty. Usage: /ingest <path-to-source>');
      return;
    }

    await sender.send(userId, `Processing ${queue.length} queued source(s)...`);
    sender.startTyping(userId);
    const { processed, errors } = await processIngestionQueue();
    sender.stopTyping(userId);
    await sender.send(userId, `Ingestion complete. Processed: ${processed}, Errors: ${errors}`);
    return;
  }

  // Parse: /ingest <path> [guidance after --]
  let sourcePath = trimmed;
  let guidance: string | undefined;
  const dashIdx = trimmed.indexOf(' -- ');
  if (dashIdx !== -1) {
    sourcePath = trimmed.slice(0, dashIdx).trim();
    guidance = trimmed.slice(dashIdx + 4).trim();
  }

  sender.startTyping(userId);
  try {
    const result = await ingestSource(sourcePath, { guidance });
    sender.stopTyping(userId);

    if (result.success) {
      await sender.send(userId, `Ingested successfully.\n\n${result.output}`);
    } else {
      await sender.send(userId, `Ingestion failed: ${result.output}`);
    }
  } catch (err) {
    sender.stopTyping(userId);
    log.error('Ingest error', { error: (err as Error).message, source: sourcePath });
    await sender.send(userId, `Ingest error: ${(err as Error).message}`);
  }
}
