import { createMutation } from '../../transport/mutations.js';
import { slugifyWritingIdentifier } from '../../jobs/writing-product-orchestration.js';
import { writingBranchName } from '../../intent/sandbox.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-blog');

/** /blog <topic> — dispatch a writing run through the mutation pipeline (the
 *  `writing` applier drives the pipeline: research → draft → critique →
 *  revise → commit on rune-writing/{slug}). Replies immediately with the run
 *  identity; the terminal ✍️/💥 message arrives via the mutation bus. */
export async function handleBlog(sender: MessageSender, userId: number, args: string): Promise<void> {
  const topic = args.trim();
  if (!topic) {
    await sender.send(userId, 'Usage: /blog <topic>');
    return;
  }

  let slug: string;
  try {
    slug = slugifyWritingIdentifier(topic);
  } catch {
    await sender.send(userId, 'The topic needs at least one alphanumeric character.');
    return;
  }

  log.info('Dispatching writing run for /blog', { userId, topic, slug });
  const result = await createMutation('writing', {
    command: 'blog',
    chatId: userId,
    product: 'writing',
    projectSlug: slug,
    topic,
  }, sender.name === 'webview' ? 'webview' : 'cli');

  if (!result.ok) {
    await sender.send(userId, `Could not start the writing run: ${result.reason}`);
    return;
  }
  await sender.send(
    userId,
    `✍️ Writing run started for "${topic}" — branch ${writingBranchName(slug)}, id ${result.descriptor.id.slice(0, 8)}. I'll message you at the terminal.`,
  );
}
