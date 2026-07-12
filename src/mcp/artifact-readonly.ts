import { createServer } from 'node:net';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const socketPath = process.argv[2];
if (!socketPath) throw new Error('artifact read-only MCP broker requires a socket path');

let input = '';
for await (const chunk of process.stdin) input += chunk.toString();
const line = input.split(/\r?\n/, 1)[0];
const vaultDir = line ? JSON.parse(line) as unknown : undefined;
if (typeof vaultDir !== 'string' || !vaultDir) {
  throw new Error('artifact read-only MCP broker requires a vault path on stdin');
}

for (const key of Object.keys(process.env)) delete process.env[key];
process.env['VAULT_DIR'] = vaultDir;
process.env['TELEGRAM_BOT_TOKEN'] = 'artifact-mcp-readonly';
process.env['TELEGRAM_USER_ID'] = '0';

const [{ createRuneMcpServer }, vaultIndex] = await Promise.all([
  import('./server.js'),
  import('../kb/vault-index.js'),
]);
vaultIndex.buildVaultIndex({ containWithinRoot: true });
if (!vaultIndex.getVaultIndexStatus().ready) {
  throw new Error('artifact read-only MCP could not build the vault index');
}

const listener = createServer((socket) => {
  const server = createRuneMcpServer({
    name: 'rune-kb-artifact-readonly',
    tools: ['vault_search', 'journal_range', 'follow_wikilinks'],
  });
  void server.connect(new StdioServerTransport(socket, socket));
});
listener.listen(socketPath, () => process.stdout.write('READY\n'));

const close = (): void => {
  listener.close(() => process.exit(0));
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
