import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initKB } from '../kb/engine.js';
import { createKBServer } from './server.js';

// Standalone stdio entry: ensure the KB scaffolding exists before serving.
// (The daemon path calls initKB() in src/index.ts at startup instead — the
// factory itself deliberately does not initialize the KB.)
initKB();

const server = createKBServer();
const transport = new StdioServerTransport();
await server.connect(transport);
