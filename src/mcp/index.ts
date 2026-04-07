import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createKBServer } from './server.js';

const server = createKBServer();
const transport = new StdioServerTransport();
await server.connect(transport);
