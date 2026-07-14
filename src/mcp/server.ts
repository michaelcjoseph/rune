import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ingestSource, queryKB, lintKB, getKBStats } from '../kb/engine.js';
import { searchRepo, searchVault as coldVaultSearch, searchWithFilter } from '../kb/search.js';
import {
  getVaultIndexStatus as daemonIndexStatus,
  queryVaultIndex as daemonIndexSearch,
} from '../kb/./vault-index.js';
import { getMcpMetricsSnapshot, instrumentMcpTool, type McpToolCallback } from './metrics.js';
import { VALID_SLUG } from '../intent/sandbox.js';
import { PRODUCT_CHAT_MCP_TOOLS } from './product-chat-tools.js';
export { PRODUCT_CHAT_MCP_TOOLS } from './product-chat-tools.js';

type BroadVaultSearch = (
  query: string,
  options?: { directory?: string; maxResults?: number },
) => Array<{ file: string; line: number; content: string }> | Promise<Array<{ file: string; line: number; content: string }>>;

export interface CreateRuneMcpServerOptions {
  tools: readonly ToolName[];
  name?: string;
  /** Server-owned scope for product-chat diagnostic tools. Never caller input. */
  productScope?: string;
  kbQueryBroadSearch?: BroadVaultSearch;
  getActiveSessionCount?: () => number;
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

export const CONTENT_TOOLS = ['journal_range', 'follow_wikilinks', 'tag_date_query'] as const;

/** Health/workout tools (MCP health expansion) — exposed both remotely
 *  (daemon /mcp) and locally (stdio, alongside {@link ADMIN_TOOLS}). */
export const HEALTH_TOOLS = [
  'whoop_snapshot',
  'health_trends',
  'workout_history',
  'nutrition_log',
  'health_doc',
  'generate_workout',
  'log_workout_done',
  'log_meal',
  'update_workout_plan',
] as const;

const UTILITY_TOOLS = ['refresh_vault_index', 'mcp_metrics_snapshot'] as const;

/** Union of every tool name the factory can register. */
export type ToolName =
  | (typeof APP_SURFACE_TOOLS)[number]
  | (typeof ADMIN_TOOLS)[number]
  | (typeof CONTENT_TOOLS)[number]
  | (typeof HEALTH_TOOLS)[number]
  | (typeof UTILITY_TOOLS)[number]
  | (typeof PRODUCT_CHAT_MCP_TOOLS)[number];

/** Lazy loader for the read-tools trio handler + deps modules (shared by
 *  three registrations; Node's module cache makes repeat calls free). */
const lazyReadTools = () =>
  Promise.all([import('./tools/read-tools.js'), import('./tools/read-tools-deps.js')]);

const lazyVaultIndexTools = () => import('./tools/vault-index-tools.js');

const lazyJournalRangeTool = () =>
  Promise.all([import('./tools/journal-range.js'), import('./tools/journal-range-deps.js')]);

const lazyFollowWikilinksTool = () =>
  Promise.all([import('./tools/follow-wikilinks.js'), import('./tools/follow-wikilinks-deps.js')]);

const lazyTagDateQueryTool = () =>
  Promise.all([import('./tools/tag-date-query.js'), import('./tools/tag-date-query-deps.js')]);

const lazyHealthReadTools = () =>
  Promise.all([import('./tools/health-read.js'), import('./tools/health-read-deps.js')]);

const lazyGenerateWorkoutTool = () =>
  Promise.all([import('./tools/generate-workout.js'), import('./tools/generate-workout-deps.js')]);

const lazyLogWorkoutDoneTool = () =>
  Promise.all([import('./tools/log-workout-done.js'), import('./tools/log-workout-done-deps.js')]);

const lazyLogMealTool = () =>
  Promise.all([import('./tools/log-meal.js'), import('./tools/log-meal-deps.js')]);

const lazyUpdateWorkoutPlanTool = () =>
  Promise.all([import('./tools/update-workout-plan.js'), import('./tools/update-workout-plan-deps.js')]);

const lazyCockpitRunTools = () => import('./tools/cockpit-runs.js');

function daemonBroadSearch(
  query: string,
  options?: { directory?: string; maxResults?: number },
): Array<{ file: string; line: number; content: string }> {
  const { ready } = daemonIndexStatus();
  return ready ? daemonIndexSearch(query, options) : coldVaultSearch(query, options);
}

type ServerWithMutableTool = {
  tool: (name: string, ...rest: unknown[]) => unknown;
};

function instrumentServerTools(server: McpServer): McpServer {
  const mutableServer = server as unknown as ServerWithMutableTool;
  const originalTool = mutableServer.tool.bind(server);
  mutableServer.tool = (name: string, ...rest: unknown[]): unknown => {
    const callback = rest.at(-1);
    if (typeof callback === 'function') {
      rest[rest.length - 1] = instrumentMcpTool(name, callback as McpToolCallback);
    }
    return originalTool(name, ...rest);
  };
  return server;
}

function warmIndexAgeMs(status: ReturnType<typeof daemonIndexStatus>): number | null {
  const lastRebuildAt = (status as { lastRebuildAt?: unknown }).lastRebuildAt;
  if (typeof lastRebuildAt !== 'string') return null;
  const timestamp = Date.parse(lastRebuildAt);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Date.now() - timestamp);
}

function requireProductScope(opts: CreateRuneMcpServerOptions): string {
  if (!opts.productScope || !VALID_SLUG.test(opts.productScope)) {
    throw new Error('Product-scoped MCP tools require a valid server-owned product scope.');
  }
  return opts.productScope;
}

/** 150s leaves headroom under the 180s kb_query TOOL_TIMEOUT_OVERRIDES_MS
 *  wrapper timeout, so the agent's own timeout SIGTERMs the child and
 *  surfaces its error instead of the wrapper orphaning a live agent. */
const KB_QUERY_AGENT_TIMEOUT_MS = 150_000;

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
        const queryDeps = {
          agentTimeoutMs: KB_QUERY_AGENT_TIMEOUT_MS,
          // A product-chat MCP is a scoped background process. It has no
          // operator identity and must not require or fabricate Telegram env.
          ...(opts.productScope !== undefined ? { agentUserVisible: false } : {}),
        };
        const result = broadSearch
          ? await queryKB(question, { ...queryDeps, searchVault: broadSearch })
          : await queryKB(question, queryDeps);
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

  mcp_metrics_snapshot: (server, opts) => {
    server.tool(
      'mcp_metrics_snapshot',
      'Return live in-memory MCP call metrics plus session and warm-index status.',
      {},
      async () => {
        const metrics = getMcpMetricsSnapshot();
        const warmIndex = daemonIndexStatus();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...metrics,
              activeSessions: opts.getActiveSessionCount?.() ?? 0,
              warmIndex: {
                ready: warmIndex.ready,
                status: warmIndex.status,
                ageMs: warmIndexAgeMs(warmIndex),
                lastRebuild: warmIndex.lastRebuild,
              },
            }),
          }],
        };
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
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      async (input) => {
        const [{ followWikilinks }, { buildProductionFollowWikilinksDeps }] =
          await lazyFollowWikilinksTool();
        return followWikilinks(input, buildProductionFollowWikilinksDeps());
      },
    );
  },

  tag_date_query: (server) => {
    server.tool(
      'tag_date_query',
      'Query warm-index markdown content by tag and/or date range, with stable result shape and bounded results.',
      {
        tag: z.string().optional().describe('Tag or hashtag to match, with or without #'),
        startDate: z.string().optional().describe('Inclusive start date in YYYY-MM-DD format'),
        endDate: z.string().optional().describe('Inclusive end date in YYYY-MM-DD format'),
        maxResults: z.number().optional().describe('Maximum results to return, 1-50 (default 20)'),
      },
      async (input) => {
        const [{ tagDateQuery }, { buildProductionTagDateQueryDeps }] =
          await lazyTagDateQueryTool();
        return tagDateQuery(input, buildProductionTagDateQueryDeps());
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
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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

  whoop_snapshot: (server) => {
    server.tool(
      'whoop_snapshot',
      "Today's Whoop health snapshot: recovery, sleep, strain, workouts. Syncs fresh data first when possible.",
      {},
      async () => {
        const [{ whoopSnapshot }, { buildProductionHealthReadDeps }] = await lazyHealthReadTools();
        return whoopSnapshot(buildProductionHealthReadDeps());
      },
    );
  },

  health_trends: (server) => {
    server.tool(
      'health_trends',
      'Whoop recovery/sleep/strain history and averages over a date range (default: last 30 days, max 90).',
      {
        startDate: z.string().optional().describe('Inclusive start date in YYYY-MM-DD format (default: 30 days ago)'),
        endDate: z.string().optional().describe('Inclusive end date in YYYY-MM-DD format (default: today)'),
      },
      async (input) => {
        const [{ healthTrends }, { buildProductionHealthReadDeps }] = await lazyHealthReadTools();
        return healthTrends(input, buildProductionHealthReadDeps());
      },
    );
  },

  workout_history: (server) => {
    server.tool(
      'workout_history',
      'Completed workouts from the training log, newest first.',
      {
        days: z.number().int().min(1).max(365).optional().describe('How many days back to include (default 30)'),
      },
      async (input) => {
        const [{ workoutHistory }, { buildProductionHealthReadDeps }] = await lazyHealthReadTools();
        return workoutHistory(input, buildProductionHealthReadDeps());
      },
    );
  },

  nutrition_log: (server) => {
    server.tool(
      'nutrition_log',
      'Recent meal notes from the nutrition log.',
      {
        days: z.number().int().min(1).max(90).optional().describe('How many days back to include (default 14)'),
      },
      async (input) => {
        const [{ nutritionLog }, { buildProductionHealthReadDeps }] = await lazyHealthReadTools();
        return nutritionLog(input, buildProductionHealthReadDeps());
      },
    );
  },

  health_doc: (server) => {
    server.tool(
      'health_doc',
      'Read a health reference doc: the workout plan, goals, equipment list, or exercise preferences.',
      {
        doc: z.enum(['plan', 'goals', 'equipment', 'exercises']).describe('Which health reference doc to read'),
      },
      async (input) => {
        const [{ healthDoc }, { buildProductionHealthReadDeps }] = await lazyHealthReadTools();
        return healthDoc(input, buildProductionHealthReadDeps());
      },
    );
  },

  generate_workout: (server) => {
    server.tool(
      'generate_workout',
      "Generate today's personalized workout via the workout-generator agent, using Whoop recovery, recent training load, equipment, and the weekly plan. Takes 1–3 minutes.",
      {
        location: z.enum(['home', 'gym']).optional().describe('Where the workout happens (default: inferred)'),
        focus: z.enum(['mobility', 'endurance', 'strength', 'speed', 'power']).optional().describe('Training focus (default: inferred)'),
        notes: z.string().max(500).optional().describe('Free-form constraints, e.g. "30min quick" or "sore hamstrings"'),
      },
      async (input) => {
        const [{ generateWorkoutTool }, { buildProductionGenerateWorkoutDeps }] =
          await lazyGenerateWorkoutTool();
        return generateWorkoutTool(input, buildProductionGenerateWorkoutDeps());
      },
    );
  },

  log_workout_done: (server) => {
    server.tool(
      'log_workout_done',
      "Log the last generated workout as completed in today's journal (the nightly pipeline parses it into the training log).",
      {
        notes: z.string().max(1000).optional().describe('Optional completion notes appended to the journal entry'),
        confirm_stale: z.boolean().optional().describe('Set true to confirm logging a workout generated more than 48h ago'),
      },
      async (input) => {
        const [{ logWorkoutDone }, { buildProductionLogWorkoutDoneDeps }] =
          await lazyLogWorkoutDoneTool();
        return logWorkoutDone(input, buildProductionLogWorkoutDoneDeps());
      },
    );
  },

  log_meal: (server) => {
    server.tool(
      'log_meal',
      'Append a meal note to the nutrition log.',
      {
        description: z.string().min(3).max(500).describe('What was eaten'),
        meal: z.string().max(40).optional().describe('Meal label, e.g. breakfast, lunch, dinner, snack'),
        time: z.string().max(20).optional().describe('Time eaten, e.g. "12:30pm" (default: now)'),
        date: z.string().optional().describe('YYYY-MM-DD date to log under (default: today)'),
      },
      async (input) => {
        const [{ logMeal }, { buildProductionLogMealDeps }] = await lazyLogMealTool();
        return logMeal(input, buildProductionLogMealDeps());
      },
    );
  },

  update_workout_plan: (server) => {
    server.tool(
      'update_workout_plan',
      'Replace the weekly workout plan document. Read the current plan via health_doc first, then submit the COMPLETE edited document; every update becomes a git commit.',
      {
        content: z.string().min(50).max(64000).describe('The complete new plan document (markdown)'),
        reason: z.string().min(3).max(200).describe('Why the plan is changing (recorded in the commit)'),
      },
      async (input) => {
        const [{ updateWorkoutPlan }, { buildProductionUpdateWorkoutPlanDeps }] =
          await lazyUpdateWorkoutPlanTool();
        return updateWorkoutPlan(input, buildProductionUpdateWorkoutPlanDeps());
      },
    );
  },

  cockpit_list_runs: (server, opts) => {
    const product = requireProductScope(opts);
    server.tool(
      'cockpit_list_runs',
      'List recent Cockpit work runs for this product only, with bounded terminal diagnostics.',
      {
        limit: z.number().int().min(1).max(20).optional().describe('Maximum runs to return (default 10)'),
      },
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      async (input) => {
        const { callCockpitRunTool } = await lazyCockpitRunTools();
        return callCockpitRunTool(product, 'listRuns', input);
      },
    );
  },

  cockpit_inspect_run: (server, opts) => {
    const product = requireProductScope(opts);
    server.tool(
      'cockpit_inspect_run',
      'Inspect one work run in this product using a full ID or unique authorized ID prefix.',
      {
        runId: z.string().min(8).max(100).describe('Full run ID or unique product-scoped prefix (minimum 8 characters)'),
        transcriptLines: z.number().int().min(1).max(100).optional().describe('Display transcript tail lines (default 50)'),
      },
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      async (input) => {
        const { callCockpitRunTool } = await lazyCockpitRunTools();
        return callCockpitRunTool(product, 'inspectRun', input);
      },
    );
  },

  cockpit_active_runs: (server, opts) => {
    const product = requireProductScope(opts);
    server.tool(
      'cockpit_active_runs',
      'List running and parked Cockpit work runs for this product with bounded safe log tails.',
      {},
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      async () => {
        const { callCockpitRunTool } = await lazyCockpitRunTools();
        return callCockpitRunTool(product, 'activeRuns');
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

  const server = instrumentServerTools(new McpServer({
    name: opts.name ?? 'rune-kb',
    version: '1.0.0',
  }));

  for (const name of opts.tools) {
    TOOL_REGISTRY[name](server, opts);
  }

  return server;
}

/** The stdio-entry server: the `kb_*` admin set plus the health/workout
 *  tools (MCP health expansion) so local Claude Code sessions get them too. */
export function createKBServer(): McpServer {
  return createRuneMcpServer({ tools: [...ADMIN_TOOLS, ...HEALTH_TOOLS] });
}

/** Dedicated product-chat server. Diagnostics never join local admin or remote surfaces. */
export function createProductChatServer(productScope: string): McpServer {
  if (!VALID_SLUG.test(productScope)) throw new Error('Invalid product scope.');
  return createRuneMcpServer({
    tools: PRODUCT_CHAT_MCP_TOOLS,
    productScope,
  });
}
