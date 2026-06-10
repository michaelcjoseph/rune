/**
 * Shared types + tiny pure helpers for the App-surface MCP tool handlers
 * (project 16). This module must stay config-free — the pure handlers
 * import it and their suites run without env vars.
 */

// Type alias (not interface) on purpose: aliases get an implicit index
// signature, which the SDK's CallToolResult requires of handler returns.
export type McpTextResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** Robust error text — a thrown non-Error must not surface as "undefined". */
export function errText(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown ?? 'unknown error');
}

/** Success result in the standard MCP text-content shape. */
export function ok(text: string): McpTextResult {
  return { content: [{ type: 'text', text }] };
}

/** Error result in the standard MCP text-content shape. */
export function err(text: string): McpTextResult {
  return { content: [{ type: 'text', text }], isError: true };
}
