/** Build equivalent isolated MCP registrations for Claude and Codex chats. */

import { join } from 'node:path';
import config, { PROJECT_ROOT } from '../config.js';
import { VALID_SLUG } from '../intent/sandbox.js';
import {
  PRODUCT_CHAT_MCP_SERVER_NAME,
  PRODUCT_CHAT_MCP_TOOLS,
  PRODUCT_CHAT_SCOPE_ENV,
} from '../mcp/product-chat-tools.js';
import {
  buildIsolatedMcpRegistration,
  type IsolatedMcpRegistration,
} from './isolated-mcp-config.js';

function productMcpEnv(product: string): Record<string, string> {
  const env: Record<string, string> = {
    [PRODUCT_CHAT_SCOPE_ENV]: product,
    VAULT_DIR: config.VAULT_DIR,
    RUNE_LOGS_DIR: config.LOGS_DIR,
    RUNE_WORKSPACE_DIR: config.WORKSPACE_DIR,
  };
  for (const key of ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR'] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/**
 * The registration is deliberately complete rather than additive: both CLIs
 * see one required `rune-kb` server and no arbitrary user MCP registrations.
 */
export function buildProductChatMcpConfig(product: string): IsolatedMcpRegistration {
  if (!VALID_SLUG.test(product)) throw new Error('Invalid product scope.');
  const server = {
    command: process.execPath,
    args: [
      '--import',
      join(PROJECT_ROOT, 'scripts', 'register-ts.mjs'),
      join(PROJECT_ROOT, 'src', 'mcp', 'product-chat.ts'),
    ],
    cwd: PROJECT_ROOT,
    env: productMcpEnv(product),
  };
  return buildIsolatedMcpRegistration({
    serverName: PRODUCT_CHAT_MCP_SERVER_NAME,
    server,
    enabledTools: PRODUCT_CHAT_MCP_TOOLS,
    startupTimeoutSec: 10,
    toolTimeoutSec: 180,
  });
}
