/**
 * Shared types for the App-surface MCP tool handlers (project 16).
 */

// Type alias (not interface) on purpose: aliases get an implicit index
// signature, which the SDK's CallToolResult requires of handler returns.
export type McpTextResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};
