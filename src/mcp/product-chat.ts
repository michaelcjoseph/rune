/** Dedicated stdio MCP entry for one configured product chat. */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const product = process.env['RUNE_PRODUCT_CHAT_PRODUCT'];
if (!product) throw new Error('Missing RUNE_PRODUCT_CHAT_PRODUCT.');

const { createProductChatServer } = await import('./server.js');
const server = createProductChatServer(product);
await server.connect(new StdioServerTransport());
