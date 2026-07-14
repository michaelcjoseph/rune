/** Shared identity for the dedicated product-chat MCP surface. */

export const PRODUCT_CHAT_MCP_SERVER_NAME = 'rune-kb' as const;
export const PRODUCT_CHAT_SCOPE_ENV = 'RUNE_PRODUCT_CHAT_PRODUCT' as const;

export const PRODUCT_CHAT_MCP_TOOLS = [
  'kb_query',
  'kb_search',
  'repo_search',
  'kb_stats',
  'cockpit_list_runs',
  'cockpit_inspect_run',
  'cockpit_active_runs',
] as const;
