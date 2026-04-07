import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ingestSource, queryKB, lintKB, getKBStats } from '../kb/engine.js';
import { searchWithFilter } from '../kb/search.js';

export function createKBServer(): McpServer {
  const server = new McpServer({
    name: 'jarvis-kb',
    version: '1.0.0',
  });

  server.tool(
    'kb_query',
    'Query the Jarvis knowledge base. Returns a synthesized answer with wikilink citations.',
    { question: z.string().describe('The question to answer using the knowledge base') },
    async ({ question }) => {
      const result = await queryKB(question);
      return {
        content: [{ type: 'text' as const, text: result.answer }],
        isError: !result.success,
      };
    },
  );

  server.tool(
    'kb_search',
    'Search the wiki with optional metadata filtering by page type and tags.',
    {
      query: z.string().describe('Search query text'),
      type: z.enum(['entity', 'concept', 'topic', 'comparison']).optional().describe('Filter by page type'),
      tags: z.array(z.string()).optional().describe('Filter by tags (matches any)'),
      maxResults: z.number().optional().describe('Max results to return (default 20)'),
    },
    async ({ query, type, tags, maxResults }) => {
      const results = searchWithFilter(
        query,
        type || tags ? { type, tags } : undefined,
        { maxResults },
      );
      const text = results.length === 0
        ? 'No results found.'
        : results.map((r) => `${r.file}:${r.line} — ${r.content}`).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'kb_ingest',
    'Ingest a source file into the knowledge base. The source must exist in the Obsidian vault.',
    {
      sourcePath: z.string().describe('Vault-relative path to the source file'),
      guidance: z.string().optional().describe('Optional guidance for the wiki compiler'),
    },
    async ({ sourcePath, guidance }) => {
      const result = await ingestSource(sourcePath, { guidance });
      return {
        content: [{ type: 'text' as const, text: result.output }],
        isError: !result.success,
      };
    },
  );

  server.tool(
    'kb_stats',
    'Get knowledge base statistics: page counts by category and recent log entries.',
    {},
    async () => {
      const stats = getKBStats();
      const text = [
        `Total pages: ${stats.totalPages}`,
        `  Entities: ${stats.entities}`,
        `  Concepts: ${stats.concepts}`,
        `  Topics: ${stats.topics}`,
        `  Comparisons: ${stats.comparisons}`,
        '',
        'Recent operations:',
        ...stats.recentLog.map((l) => `  ${l}`),
      ].join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'kb_lint',
    'Run a health check on the knowledge base. Returns a structured report of issues.',
    {},
    async () => {
      const result = await lintKB();
      return {
        content: [{ type: 'text' as const, text: result.report }],
        isError: !result.success,
      };
    },
  );

  return server;
}
