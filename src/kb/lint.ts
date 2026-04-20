import { runAgent } from '../ai/claude.js';
import { createLogger } from '../utils/logger.js';
import config from '../config.js';

const log = createLogger('kb-lint');

/**
 * Run a health check on the knowledge base wiki.
 * Uses the wiki-linter agent to check for issues.
 */
export async function lintKB(): Promise<{ success: boolean; report: string }> {
  log.info('Starting wiki lint');

  const prompt = `Run a health check on the knowledge base.

Follow the lint workflow:
1. Read knowledge/schema.md for conventions (especially frontmatter requirements)
2. Read knowledge/index.md to get the full page inventory
3. Read wiki pages and check for:
   - Missing/invalid YAML frontmatter (every page needs type, tags, related, created, last-verified)
   - Expired temporal facts (valid-until date has passed — critical issue)
   - Verification overdue (last-verified >90 days old on pages with valid-until set — warning)
   - Orphan pages (exist in wiki/ but not in index.md)
   - Dead wikilinks (link to pages that don't exist)
   - Missing cross-references (pages that should link to each other; check related field vs body links)
   - Stale content (pages not updated in >90 days with time-sensitive info)
   - Contradictions between pages
   - Missing pages (concepts mentioned frequently but lacking a dedicated page)
   - Index drift (index summary doesn't match page content)
4. Produce a structured report with findings and recommendations
5. Append a LINT entry to knowledge/log.md`;

  const result = await runAgent('wiki-linter', prompt, config.CLAUDE_LINT_TIMEOUT_MS);

  if (result.error) {
    log.error('Lint failed', { error: result.error });
    return { success: false, report: `Lint error: ${result.error}` };
  }

  log.info('Lint complete');
  return { success: true, report: result.text || 'No issues found.' };
}
