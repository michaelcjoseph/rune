import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ingestSource, queryKB, lintKB, getKBStats } from '../kb/engine.js';
import { searchWithFilter } from '../kb/search.js';

/**
 * Shared MCP server factory (project 16-claude-app-connector).
 *
 * One registry of tool registrations; `createJarvisMcpServer(opts)` builds an
 * `McpServer` exposing exactly the requested tool set. Two named sets:
 *
 * - {@link ADMIN_TOOLS} — the `kb_*` admin set the local stdio entry
 *   (`mcp/index.ts`, via {@link createKBServer}) has always exposed.
 * - {@link APP_SURFACE_TOOLS} — the six App-surface tools the remote `/mcp`
 *   endpoint exposes to the Claude App connector (spec R2 req 6).
 *
 * The App-surface tools other than `kb_query` are registered with their real
 * names and input schemas but placeholder handlers; each handler is replaced
 * by its own implementation task (log-idea-tool, log-conversation-tool,
 * read-tools-trio in docs/projects/16-claude-app-connector/tasks.md).
 */

/** The App-surface tools exposed to the Claude App connector (spec R2 req 6). */
export const APP_SURFACE_TOOLS = [
  'kb_query',
  'vault_search',
  'log_idea',
  'crm_lookup',
  'get_priorities',
  'log_conversation',
] as const;

/** The `kb_*` admin set the local stdio entry exposes (unchanged behavior).
 *  ADMIN-ONLY by design: `kb_ingest` interpolates caller `guidance` into a
 *  privileged wiki-compiler prompt unsanitized, and `kb_search` returns raw
 *  vault-relative paths — neither may join {@link APP_SURFACE_TOOLS}. */
export const ADMIN_TOOLS = [
  'kb_query',
  'kb_search',
  'kb_ingest',
  'kb_stats',
  'kb_lint',
] as const;

/** Union of every tool name the factory can register. */
export type ToolName = (typeof APP_SURFACE_TOOLS)[number] | (typeof ADMIN_TOOLS)[number];

/** Placeholder result for App-surface tools whose handler implementation
 *  task has not landed yet. Registration (name + schema) is real; behavior
 *  arrives with each tool's own task. */
function notImplemented(tool: string) {
  return {
    content: [{ type: 'text' as const, text: `${tool} is not implemented yet.` }],
    isError: true as const,
  };
}

/** Every tool the factory knows how to register, keyed by tool name. */
const TOOL_REGISTRY: Record<ToolName, (server: McpServer) => void> = {
  kb_query: (server) => {
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
  },

  kb_search: (server) => {
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
  },

  kb_ingest: (server) => {
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
  },

  kb_stats: (server) => {
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
  },

  kb_lint: (server) => {
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
  },

  vault_search: (server) => {
    server.tool(
      'vault_search',
      'Search vault content (journals, pages, projects). Returns matching snippets with paths.',
      {
        query: z.string().describe('Search query text'),
        types: z.array(z.enum(['journals', 'pages', 'projects'])).optional()
          .describe('Restrict search to these vault areas (default: all three)'),
        maxResults: z.number().optional().describe('Max results to return'),
      },
      // TODO(read-tools-trio): replace with the vaultSearch handler from
      // ./tools/read-tools.js — swap THIS closure in TOOL_REGISTRY; do not
      // add a second server.tool() registration elsewhere.
      async () => notImplemented('vault_search'),
    );
  },

  log_idea: (server) => {
    server.tool(
      'log_idea',
      'Capture an idea or bug, routed to a product target (or the inbox when unresolved).',
      {
        title: z.string().describe('Short title for the idea or bug'),
        friction: z.string().describe('The friction or description the item addresses'),
        product: z.string().optional().describe('Product target inferred from thread context'),
        kind: z.enum(['idea', 'bug']).optional().describe("Item kind (default 'idea')"),
      },
      // Lazy import: the deps module pulls config.ts (env-var-required at
      // import), so it must not load before the tool is actually called.
      async (input) => {
        const [{ logIdea }, { buildProductionLogIdeaDeps }] = await Promise.all([
          import('./tools/log-idea.js'),
          import('./tools/log-idea-deps.js'),
        ]);
        return logIdea(input, buildProductionLogIdeaDeps());
      },
    );
  },

  crm_lookup: (server) => {
    server.tool(
      'crm_lookup',
      'Look up a person or company from the CRM.',
      { name: z.string().describe('Name (or substring) to look up') },
      // TODO(read-tools-trio): replace with the crmLookup handler.
      async () => notImplemented('crm_lookup'),
    );
  },

  get_priorities: (server) => {
    server.tool(
      'get_priorities',
      "Get current priorities from the journal's #priorities block (today, falling back to yesterday).",
      {},
      // TODO(read-tools-trio): replace with the getPriorities handler.
      async () => notImplemented('get_priorities'),
    );
  },

  log_conversation: (server) => {
    server.tool(
      'log_conversation',
      "Write a finished conversation into today's journal (summary or full reconstruction), optionally into the KB queue.",
      {
        mode: z.enum(['full', 'summary']).describe('full = reconstructed transcript; summary = one-line bullet'),
        content: z.string().describe('The transcript or summary text to write'),
        kb_worthy: z.boolean().optional().describe('Also write to the KB raw-source queue (summary mode only)'),
      },
      // TODO(log-conversation-tool): replace with the logConversation handler
      // from ./tools/log-conversation.js.
      async () => notImplemented('log_conversation'),
    );
  },
};

/**
 * Build an `McpServer` exposing exactly `opts.tools`. Fails loudly at
 * construction on an unknown tool name or an empty tool list — a server
 * that silently exposes nothing (or not what was asked) is never intentional.
 *
 * Every call returns an INDEPENDENT server instance: the SDK binds one
 * transport per `Server`, so the stdio entry and the future `/mcp` HTTP
 * mount must each call this factory rather than share an instance.
 *
 * Does NOT initialize the KB — `initKB()` is a process-startup concern
 * (daemon: src/index.ts; standalone stdio: src/mcp/index.ts).
 */
export function createJarvisMcpServer(opts: { tools: readonly ToolName[]; name?: string }): McpServer {
  if (opts.tools.length === 0) {
    throw new Error('createJarvisMcpServer: empty tool list — a server exposing no tools is a configuration error');
  }
  // Defense-in-depth behind the ToolName type: callers that cast (or build
  // the list dynamically) still fail loudly. The known set is deliberately
  // not enumerated in the message — this error may surface remotely.
  const unknown = opts.tools.filter((name) => !(name in TOOL_REGISTRY));
  if (unknown.length > 0) {
    throw new Error(`createJarvisMcpServer: unknown tool name(s): ${unknown.join(', ')}`);
  }

  const server = new McpServer({
    name: opts.name ?? 'jarvis-kb',
    version: '1.0.0',
  });

  for (const name of opts.tools) {
    TOOL_REGISTRY[name](server);
  }

  return server;
}

/** The original stdio-entry server: the `kb_*` admin set, behavior unchanged. */
export function createKBServer(): McpServer {
  return createJarvisMcpServer({ tools: ADMIN_TOOLS });
}
