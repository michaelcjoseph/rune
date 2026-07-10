import { createMutation } from '../../transport/mutations.js';
import {
  slugifyWritingIdentifier,
  writingTargetSlugSource,
} from '../../jobs/writing-product-orchestration.js';
import { writingBranchName } from '../../intent/sandbox.js';
import { createLogger } from '../../utils/logger.js';
import type { MessageSender } from '../../transport/sender.js';

const log = createLogger('cmd-writing-critique');

function parseWritingCritiqueArgs(args: string): { target: string; revisionRequested: boolean } {
  const trimmed = args.trim();
  const revisionMatch = trimmed.match(/^--(?:revise|revision)\s+(.+)$/i);
  if (!revisionMatch) {
    return { target: trimmed, revisionRequested: false };
  }
  return { target: (revisionMatch[1] ?? '').trim(), revisionRequested: true };
}

/** /writing-critique [--revise] <target> — dispatch a critique run through the
 *  mutation pipeline: the writing applier critiques the EXISTING
 *  docs/rune/{slug}.md into docs/rune/critiques/{slug}.md (and revises the
 *  draft when --revise is set), committing on the draft's own
 *  rune-writing/{slug} branch. Slug derivation reuses the orchestration
 *  module's helpers so a path-shaped target can never fork a second slug. */
export async function handleWritingCritique(
  sender: MessageSender,
  userId: number,
  args: string,
): Promise<void> {
  const { target, revisionRequested } = parseWritingCritiqueArgs(args);
  if (!target) {
    await sender.send(userId, 'Usage: /writing-critique <target>');
    return;
  }

  let slug: string;
  try {
    slug = slugifyWritingIdentifier(writingTargetSlugSource(target));
  } catch {
    await sender.send(userId, 'The critique target needs at least one alphanumeric character.');
    return;
  }
  const outputPath = `docs/rune/critiques/${slug}.md`;

  log.info('Dispatching writing run for /writing-critique', { userId, slug, outputPath, revisionRequested });
  const result = await createMutation('writing', {
    command: 'writing-critique',
    chatId: userId,
    product: 'writing',
    projectSlug: slug,
    critiqueTarget: target,
    outputPath,
    revisionRequested,
  }, sender.name === 'webview' ? 'webview' : 'cli');

  if (!result.ok) {
    await sender.send(userId, `Could not start the critique run: ${result.reason}`);
    return;
  }
  await sender.send(
    userId,
    `✍️ Critique run started for "${target}" — branch ${writingBranchName(slug)}, id ${result.descriptor.id.slice(0, 8)}. I'll message you at the terminal.`,
  );
}
