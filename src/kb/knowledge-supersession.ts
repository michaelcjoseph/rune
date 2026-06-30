import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export interface SupersessionEvidence {
  file: string;
  line: number;
  content: string;
}

export interface SupersessionTerm {
  from: string;
  to: string;
  aliases?: string[];
}

export interface SupersessionCandidate {
  file: string;
  line: number;
  text: string;
  supersession: {
    from: string;
    to: string;
  };
  newerSources: SupersessionEvidence[];
}

export interface SupersessionDecision {
  status: 'accepted' | 'rejected' | 'ambiguous';
  replacement?: string;
  rationale: string;
}

export interface SupersessionResult {
  scannedFiles: number;
  candidates: number;
  accepted: number;
  rejected: number;
  ambiguous: number;
  editedFiles: string[];
  unchangedFiles: string[];
  detail: string;
}

export interface KnowledgeSupersessionOptions {
  vaultDir: string;
  now: string;
  supersessions: SupersessionTerm[];
  adjudicateCandidate: (candidate: SupersessionCandidate) => Promise<SupersessionDecision>;
}

export interface SupersessionCandidateFinderOptions {
  vaultDir: string;
  now: string;
  supersessions: SupersessionTerm[];
}

interface MarkdownLine {
  file: string;
  line: number;
  content: string;
  date: string | null;
}

/**
 * Reconcile deterministic rename/identity-drift candidates in curated markdown.
 * Raw journals are evidence only; the adjudicator decides whether a surfaced
 * candidate is stale current state or a still-valid historical reference.
 */
export async function runKnowledgeSupersessionReconciliation(
  opts: KnowledgeSupersessionOptions,
): Promise<SupersessionResult> {
  const candidates = findSupersessionCandidates(opts);
  const scannedFiles = listCuratedMarkdownFiles(opts.vaultDir).length;

  const result: SupersessionResult = {
    scannedFiles,
    candidates: 0,
    accepted: 0,
    rejected: 0,
    ambiguous: 0,
    editedFiles: [],
    unchangedFiles: [],
    detail: 'No supersession candidates found',
  };

  const changedFiles = new Set<string>();
  const unchangedFiles = new Set<string>();
  const detailParts: string[] = [];

  const candidatesByFile = groupCandidatesByFile(candidates);

  for (const [file, fileCandidates] of candidatesByFile) {
    const fullPath = join(opts.vaultDir, file);
    const original = readFileSync(fullPath, 'utf8');
    const hasTrailingNewline = original.endsWith('\n');
    const lines = original.split(/\r?\n/);
    if (hasTrailingNewline) lines.pop();

    let fileChanged = false;

    for (const candidate of fileCandidates) {
      const index = candidate.line - 1;
      const text = lines[index] ?? candidate.text;
      result.candidates++;
      const decision = await opts.adjudicateCandidate({
        ...candidate,
        text,
      });

      const supersession = findSupersessionTerm(opts.supersessions, candidate.supersession);
      if (decision.status === 'accepted') {
        result.accepted++;
        const replacement = decision.replacement ?? (supersession ? replaceToken(text, supersession) : text);
        appendSupersessionAudit(opts.vaultDir, {
          timestamp: opts.now,
          status: 'accepted',
          file,
          line: candidate.line,
          supersession: candidate.supersession,
          before: text,
          after: replacement,
          rationale: decision.rationale,
          evidence: candidate.newerSources,
        });
        if (replacement !== text) {
          lines[index] = replacement;
          appendChangelogEntry(lines, opts.now, candidate);
          fileChanged = true;
        } else {
          unchangedFiles.add(file);
        }
        detailParts.push(`accepted ${candidate.supersession.from}->${candidate.supersession.to} in ${file}`);
      } else if (decision.status === 'rejected') {
        result.rejected++;
        appendSupersessionAudit(opts.vaultDir, {
          timestamp: opts.now,
          status: 'rejected',
          file,
          line: candidate.line,
          supersession: candidate.supersession,
          text,
          rationale: decision.rationale,
          evidence: candidate.newerSources,
        });
        unchangedFiles.add(file);
        detailParts.push(`rejected ${candidate.supersession.from}->${candidate.supersession.to} in ${file}`);
      } else {
        result.ambiguous++;
        appendSupersessionAudit(opts.vaultDir, {
          timestamp: opts.now,
          status: 'ambiguous',
          file,
          line: candidate.line,
          supersession: candidate.supersession,
          text,
          rationale: decision.rationale,
          evidence: candidate.newerSources,
        });
        unchangedFiles.add(file);
        detailParts.push(`ambiguous ${candidate.supersession.from}->${candidate.supersession.to} in ${file}`);
      }
    }

    if (fileChanged) {
      writeFileSync(fullPath, lines.join('\n') + (hasTrailingNewline ? '\n' : ''));
      changedFiles.add(file);
      unchangedFiles.delete(file);
    }
  }

  result.editedFiles = [...changedFiles].sort();
  result.unchangedFiles = [...unchangedFiles].sort();
  result.detail = detailParts.length > 0 ? detailParts.join('; ') : result.detail;
  return result;
}

export function findSupersessionCandidates(
  opts: SupersessionCandidateFinderOptions,
): SupersessionCandidate[] {
  const curatedFiles = listCuratedMarkdownFiles(opts.vaultDir);
  const journalLines = readMarkdownLines(opts.vaultDir, listMarkdownFiles(opts.vaultDir, ['journals']));
  const currentDate = parseDateOnly(opts.now);
  const candidates: SupersessionCandidate[] = [];

  for (const file of curatedFiles) {
    const fullPath = join(opts.vaultDir, file);
    const original = readFileSync(fullPath, 'utf8');
    const hasTrailingNewline = original.endsWith('\n');
    const lines = original.split(/\r?\n/);
    if (hasTrailingNewline) lines.pop();
    const lastVerified = extractLastVerified(original);

    for (let index = 0; index < lines.length; index++) {
      const text = lines[index] ?? '';
      for (const supersession of opts.supersessions) {
        if (!containsToken(text, supersession.from, supersession.aliases)) continue;

        const newerSources = findEvidence(journalLines, supersession, {
          after: lastVerified,
          onOrBefore: currentDate,
        });
        if (newerSources.length === 0) continue;

        candidates.push({
          file,
          line: index + 1,
          text,
          supersession: {
            from: supersession.from,
            to: supersession.to,
          },
          newerSources,
        });
      }
    }
  }

  return candidates;
}

function listCuratedMarkdownFiles(root: string): string[] {
  return [
    ...listMarkdownFiles(root, ['knowledge']).filter((file) => !file.startsWith('knowledge/raw/')),
    ...listMarkdownFiles(root, ['pages']),
    ...listMarkdownFiles(root, ['projects']),
    ...listMarkdownFiles(root, ['world-view']),
  ].sort();
}

function groupCandidatesByFile(candidates: SupersessionCandidate[]): Map<string, SupersessionCandidate[]> {
  const grouped = new Map<string, SupersessionCandidate[]>();
  for (const candidate of candidates) {
    const fileCandidates = grouped.get(candidate.file) ?? [];
    fileCandidates.push(candidate);
    grouped.set(candidate.file, fileCandidates);
  }
  return grouped;
}

function findSupersessionTerm(
  terms: SupersessionTerm[],
  supersession: SupersessionCandidate['supersession'],
): SupersessionTerm | null {
  return terms.find((term) => term.from === supersession.from && term.to === supersession.to) ?? null;
}

function listMarkdownFiles(root: string, segments: string[]): string[] {
  const start = join(root, ...segments);
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(toVaultRelative(root, fullPath));
      }
    }
  }

  try {
    if (statSync(start).isDirectory()) walk(start);
  } catch {
    return [];
  }

  return files.sort();
}

function readMarkdownLines(root: string, files: string[]): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  for (const file of files) {
    const content = readFileSync(join(root, file), 'utf8');
    const date = dateFromJournalPath(file);
    content.split(/\r?\n/).forEach((line, index) => {
      if (line.length > 0) {
        lines.push({ file, line: index + 1, content: line, date });
      }
    });
  }
  return lines;
}

function findEvidence(
  lines: MarkdownLine[],
  supersession: SupersessionTerm,
  bounds: { after: string | null; onOrBefore: string | null },
): SupersessionEvidence[] {
  return lines
    .filter((line) => {
      if (line.date === null) return false;
      if (bounds.after !== null && line.date <= bounds.after) return false;
      if (bounds.onOrBefore !== null && line.date > bounds.onOrBefore) return false;
      return containsToken(line.content, supersession.to);
    })
    .map((line) => ({ file: line.file, line: line.line, content: line.content }));
}

function containsToken(text: string, token: string, aliases: string[] = []): boolean {
  return [token, ...aliases].some((candidate) => {
    const escaped = escapeRegExp(candidate);
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  });
}

function replaceToken(text: string, supersession: SupersessionTerm): string {
  const alternatives = [supersession.from, ...(supersession.aliases ?? [])]
    .filter((token, index, tokens) => tokens.indexOf(token) === index)
    .map(escapeRegExp);
  return text.replace(new RegExp(`\\b(?:${alternatives.join('|')})\\b`, 'gi'), supersession.to);
}

function appendSupersessionAudit(root: string, record: Record<string, unknown>): void {
  const auditPath = join(root, 'knowledge', 'supersessions.jsonl');
  mkdirSync(dirname(auditPath), { recursive: true });
  appendFileSync(auditPath, `${JSON.stringify(record)}\n`);
}

function appendChangelogEntry(lines: string[], now: string, candidate: SupersessionCandidate): void {
  const date = parseDateOnly(now) ?? now;
  const entry = `- ${date}: Supersession audit: ${candidate.supersession.from} -> ${candidate.supersession.to} at ${candidate.file}:${candidate.line}.`;
  const headingIndex = lines.findIndex((line) => /^##\s+Supersession audit\s*$/i.test(line));

  if (headingIndex >= 0) {
    let insertAt = headingIndex + 1;
    while (insertAt < lines.length && lines[insertAt] === '') insertAt++;
    lines.splice(insertAt, 0, entry);
    return;
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length > 0) lines.push('');
  lines.push('## Supersession audit', '', entry);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractLastVerified(content: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return null;
  const frontmatter = match[1]!;
  const dateMatch = /^last-verified:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/m.exec(frontmatter);
  return dateMatch?.[1] ?? null;
}

function dateFromJournalPath(file: string): string | null {
  const match = /(?:^|\/)(\d{4})[_-](\d{2})[_-](\d{2})\.md$/.exec(file);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function parseDateOnly(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1] ?? null;
}

function toVaultRelative(root: string, fullPath: string): string {
  return relative(root, fullPath).split(sep).join('/');
}
