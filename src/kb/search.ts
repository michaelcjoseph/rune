import { execSync } from 'node:child_process';
import { join } from 'node:path';
import config from '../config.js';

export interface SearchResult {
  file: string;
  line: number;
  content: string;
}

/**
 * Full-text search across the vault using ripgrep.
 * Returns matching file paths with line content.
 */
export function searchVault(
  query: string,
  options?: { directory?: string; maxResults?: number },
): SearchResult[] {
  const searchDir = options?.directory
    ? join(config.VAULT_DIR, options.directory)
    : config.VAULT_DIR;

  const maxResults = options?.maxResults ?? 20;

  try {
    const output = execSync(
      `rg --json -i --max-count 3 --glob "*.md" ${JSON.stringify(query)} ${JSON.stringify(searchDir)}`,
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    ).toString();

    const results: SearchResult[] = [];

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          type: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };
        if (parsed.type === 'match' && parsed.data) {
          const filePath = parsed.data.path?.text || '';
          // Convert to relative path
          const relative = filePath.startsWith(config.VAULT_DIR)
            ? filePath.slice(config.VAULT_DIR.length + 1)
            : filePath;
          results.push({
            file: relative,
            line: parsed.data.line_number || 0,
            content: (parsed.data.lines?.text || '').trim(),
          });
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return results.slice(0, maxResults);
  } catch {
    return []; // No matches or rg not available
  }
}
