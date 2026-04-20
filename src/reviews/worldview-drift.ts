import { readVaultFile, listVaultFiles } from '../vault/files.js';

export interface DriftFlag {
  topic: string;              // e.g., "ai" (from world-view/ai.md)
  changedOn: string;          // e.g., "2026_04_15"
  summary: string;            // first non-empty line of the changelog entry
  affectedProjects: string[]; // e.g., ["projects/project-alpha.md"]
}

const CHANGELOG_ENTRY = /###\s+\[\[(\d{4}_\d{2}_\d{2})\]\]\s*\n([\s\S]*?)(?=###\s+\[\[|\n## |$)/g;

/** Compare "YYYY_MM_DD" dates as strings (works because zero-padded). */
function dateInRange(date: string, startInclusive: string, endInclusive: string): boolean {
  return date >= startInclusive && date <= endInclusive;
}

/** Extract the topic name from a world-view file path (e.g., "world-view/ai.md" → "ai"). */
function topicFromPath(path: string): string {
  return path.replace(/^world-view\//, '').replace(/\.md$/, '');
}

/** Find project files that reference a world-view topic (via `[[topic]]`, `[[world-view/topic]]`, or the topic name). */
function findProjectsCitingTopic(topic: string): string[] {
  const projectFiles = listVaultFiles('projects').filter(p =>
    p.endsWith('.md') && !p.startsWith('projects/archive/')
  );
  const patterns = [
    new RegExp(`\\[\\[${topic}\\]\\]`, 'i'),
    new RegExp(`\\[\\[world-view/${topic}\\]\\]`, 'i'),
  ];
  const hits: string[] = [];
  for (const file of projectFiles) {
    const content = readVaultFile(file) || '';
    if (patterns.some(p => p.test(content))) hits.push(file);
  }
  return hits;
}

/**
 * Scan world-view/*.md changelogs for entries within the date range.
 * For each recently-changed topic, find active projects that cite it.
 * Returns one flag per (topic × project) pair with a meaningful citation.
 *
 * Dates are YYYY_MM_DD format (matches the `### [[YYYY_MM_DD]]` changelog anchors).
 */
export function detectWorldviewDrift(startDate: string, endDate: string): DriftFlag[] {
  const worldViewFiles = listVaultFiles('world-view').filter(p =>
    p.endsWith('.md') && p !== 'world-view/world-view.md'
  );

  const flags: DriftFlag[] = [];

  for (const file of worldViewFiles) {
    const content = readVaultFile(file);
    if (!content) continue;

    const topic = topicFromPath(file);

    // Match each changelog entry block
    for (const match of content.matchAll(CHANGELOG_ENTRY)) {
      const date = match[1]!;
      if (!dateInRange(date, startDate, endDate)) continue;

      const body = (match[2] || '').trim();
      const firstLine = body.split('\n').find(l => l.trim().length > 0) || '(no summary)';

      const affected = findProjectsCitingTopic(topic);
      if (affected.length === 0) continue;

      flags.push({
        topic,
        changedOn: date,
        summary: firstLine.slice(0, 200),
        affectedProjects: affected,
      });
    }
  }

  return flags;
}

/** Format drift flags as a markdown section for inclusion in review prep context. */
export function formatDriftFlags(flags: DriftFlag[]): string | null {
  if (flags.length === 0) return null;
  const lines = flags.map(f => {
    const projList = f.affectedProjects.map(p => `\`${p}\``).join(', ');
    return `- **[[world-view/${f.topic}]]** shifted on [[${f.changedOn}]]: ${f.summary}\n  - Affects: ${projList} — raise whether the project thesis still holds.`;
  });
  return `# Worldview Drift Flags (${flags.length})\n${lines.join('\n')}\n\n*Surface these during the interview so the user can decide whether to re-examine the project thesis.*`;
}
