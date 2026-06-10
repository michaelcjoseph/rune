/**
 * Pure journal-parsing helpers — CONFIG-FREE on purpose. Extracted from
 * journal.ts (which re-exports parseTag for its existing callers) so pure
 * modules like the read-tools MCP handlers can reuse the #tag parsing
 * without pulling config.ts's env requirements.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract the block of lines following a `#tag` line, stopping at the next
 *  line-leading #tag or markdown heading. Returns null when the tag is not
 *  present. */
export function parseTag(content: string, tag: string): string | null {
  const lines = content.split('\n');
  const tagPattern = new RegExp(`(?:^|\\s)#${escapeRegex(tag)}(?:\\s|$)`);

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (tagPattern.test(lines[i]!)) {
      startIdx = i + 1;
      break;
    }
  }

  if (startIdx === -1) return null;

  const collected: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    // Stop at line-leading #tag (section divider) or markdown heading
    if (/^#\w/.test(line) || /^#{1,6}\s/.test(line)) break;
    collected.push(line);
  }

  return collected.join('\n').trim();
}
