import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ingestSource, queryKB, lintKB, getKBStats } from '../kb/engine.js';
import { searchRepo, searchVault as coldVaultSearch, searchWithFilter } from '../kb/search.js';
import {
  getVaultIndexStatus as daemonIndexStatus,
  queryVaultIndex as daemonIndexSearch,
} from '../kb/./vault-index.js';

type BroadVaultSearch = (
  query: string,
  options?: { directory?: string; maxResults?: number },
) => Array<{ file: string; line: number; content: string }> | Promise<Array<{ file: string; line: number; content: string }>>;

export interface CreateRuneMcpServerOptions {
  tools: readonly ToolName[];
  name?: string;
  kbQueryBroadSearch?: BroadVaultSearch;
}

/**
 * Shared MCP server factory (project 16-claude-app-connector).
 *
 * One registry of tool registrations; `createRuneMcpServer(opts)` builds an
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
  'repo_search',
  'kb_ingest',
  'kb_stats',
  'kb_lint',
] as const;

export const CONTENT_TOOLS = ['journal_range', 'follow_wikilinks'] as const;

const UTILITY_TOOLS = ['refresh_vault_index'] as const;

/** Union of every tool name the factory can register. */
export type ToolName =
  | (typeof APP_SURFACE_TOOLS)[number]
  | (typeof ADMIN_TOOLS)[number]
  | (typeof CONTENT_TOOLS)[number]
  | (typeof UTILITY_TOOLS)[number];

/** Lazy loader for the read-tools trio handler + deps modules (shared by
 *  three registrations; Node's module cache makes repeat calls free). */
const lazyReadTools = () =>
  Promise.all([import('./tools/read-tools.js'), import('./tools/read-tools-deps.js')]);

const lazyVaultIndexTools = () => import('./tools/vault-index-tools.js');

const lazyJournalRangeTool = () =>
  Promise.all([import('./tools/journal-range.js'), import('./tools/journal-range-deps.js')]);

const lazyFollowWikilinksTool = () =>
  Promise.all([import('./tools/follow-wikilinks.js'), import('./tools/follow-wikilinks-deps.js')]);

function daemonBroadSearch(
  query: string,
  options?: { directory?: string; maxResults?: number },
): Array<{ file: string; line: number; content: string }> {
  const { ready } = daemonIndexStatus();
  return ready ? daemonIndexSearch(query, options) : coldVaultSearch(query, options);
}

/** Every tool the factory knows how to register, keyed by tool name. */
const TOOL_REGISTRY: Record<ToolName, (server: McpServer, opts: CreateRuneMcpServerOptions) => void> = {
  kb_query: (server, opts) => {
    server.tool(
      'kb_query',
      'Query the Rune knowledge base. Returns a synthesized answer with wikilink citations.',
      { question: z.string().describe('The question to answer using the knowledge base') },
      async ({ question }) => {
        const broadSearch = opts.kbQueryBroadSearch
          ?? (opts.name === 'rune-mcp' ? daemonBroadSearch : undefined);
        const result = broadSearch
          ? await queryKB(question, { searchVault: broadSearch })
          : await queryKB(question);
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

  repo_search: (server) => {
    server.tool(
      'repo_search',
      'Search the active product repository. Use for product code, docs, project specs, tasks, bugs, and implementation questions.',
      {
        query: z.string().describe('Search query text'),
        repoPath: z.string().describe('Absolute path to the active product repository'),
        maxResults: z.number().optional().describe('Max results to return (default 20)'),
      },
      async ({ query, repoPath, maxResults }) => {
        const results = searchRepo(query, { repoPath, maxResults });
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

  refresh_vault_index: (server) => {
    server.tool(
      'refresh_vault_index',
      'Refresh the warm vault index and report readiness plus build statistics.',
      {},
      async () => {
        const { refreshVaultIndexTool, buildProductionRefreshVaultIndexDeps } =
          await lazyVaultIndexTools();
        return refreshVaultIndexTool(buildProductionRefreshVaultIndexDeps());
      },
    );
  },

  journal_range: (server) => {
    server.tool(
      'journal_range',
      'Return journal entries for an inclusive date range from the warm vault index, with cold fallback while the index is building.',
      {
        startDate: z.string().describe('Inclusive start date in YYYY-MM-DD format'),
        endDate: z.string().describe('Inclusive end date in YYYY-MM-DD format'),
      },
      async (input) => {
        const [{ journalRange }, { buildProductionJournalRangeDeps }] =
          await lazyJournalRangeTool();
        return journalRange(input, buildProductionJournalRangeDeps());
      },
    );
  },

  follow_wikilinks: (server) => {
    server.tool(
      'follow_wikilinks',
      'Resolve Obsidian wikilinks from a source file or text snippet to target vault content using the warm vault index.',
      {
        sourceFile: z.string().optional().describe('Vault-relative source markdown file to scan for wikilinks'),
        text: z.string().optional().describe('Text snippet to scan for wikilinks'),
        maxDepth: z.number().optional().describe('Maximum wikilink traversal depth, 1-5 (default 1)'),
        maxResults: z.number().optional().describe('Maximum resolved target files to return, 1-50 (default 10)'),
      },
      async (input) => {
        const [{ followWikilinks }, { buildProductionFollowWikilinksDeps }] =
          await lazyFollowWikilinksTool();
        return followWikilinks(input, buildProductionFollowWikilinksDeps());
      },
    );
  },

  vault_search: (server) => {
    server.tool(
      'vault_search',
      'Search whole-vault markdown content. Returns matching snippets with paths.',
      {
        query: z.string().describe('Search query text'),
        types: z.array(z.string()).optional()
          .describe('Optional top-level folder prefixes to narrow search; unknown or unsafe values are ignored. Default: whole vault.'),
        maxResults: z.number().optional().describe('Max results to return'),
      },
      // Lazy import: the deps module pulls config.ts (env-var-required at
      // import), so it must not load before the tool is actually called.
      async (input) => {
        const [{ vaultSearch }, { buildProductionVaultSearchDeps }] = await lazyReadTools();
        return vaultSearch(input, buildProductionVaultSearchDeps());
      },
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
      async (input) => {
        const [{ crmLookup }, { buildProductionCrmLookupDeps }] = await lazyReadTools();
        return crmLookup(input, buildProductionCrmLookupDeps());
      },
    );
  },

  get_priorities: (server) => {
    server.tool(
      'get_priorities',
      "Get current priorities from the journal's #priorities block (today, falling back to yesterday).",
      {},
      async () => {
        const [{ getPriorities }, { buildProductionGetPrioritiesDeps }] = await lazyReadTools();
        return getPriorities(buildProductionGetPrioritiesDeps());
      },
    );
  },

  log_conversation: (server) => {
    server.tool(
      'log_conversation',
      "Write a finished conversation into today's journal (summary or full reconstruction), optionally into the KB queue.",
      {
        mode: z.enum(['full', 'summary']).describe('full = reconstructed transcript; summary = one-line bullet'),
        content: z.string().max(200_000).describe('The transcript or summary text to write'),
        kb_worthy: z.boolean().optional().describe('Also write to the KB raw-source queue (summary mode only)'),
      },
      // Lazy import: the deps module pulls config.ts (env-var-required at
      // import), so it must not load before the tool is actually called.
      async (input) => {
        const [{ logConversation }, { buildProductionLogConversationDeps }] = await Promise.all([
          import('./tools/log-conversation.js'),
          import('./tools/log-conversation-deps.js'),
        ]);
        return logConversation(input, buildProductionLogConversationDeps());
      },
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
export function createRuneMcpServer(opts: CreateRuneMcpServerOptions): McpServer {
  if (opts.tools.length === 0) {
    throw new Error('createRuneMcpServer: empty tool list — a server exposing no tools is a configuration error');
  }
  // Defense-in-depth behind the ToolName type: callers that cast (or build
  // the list dynamically) still fail loudly. The known set is deliberately
  // not enumerated in the message — this error may surface remotely.
  const unknown = opts.tools.filter((name) => !(name in TOOL_REGISTRY));
  if (unknown.length > 0) {
    throw new Error(`createRuneMcpServer: unknown tool name(s): ${unknown.join(', ')}`);
  }

  const server = new McpServer({
    name: opts.name ?? 'rune-kb',
    version: '1.0.0',
  });

  for (const name of opts.tools) {
    TOOL_REGISTRY[name](server, opts);
  }

  return server;
}

/** The original stdio-entry server: the `kb_*` admin set, behavior unchanged. */
export function createKBServer(): McpServer {
  return createRuneMcpServer({ tools: ADMIN_TOOLS });
}
