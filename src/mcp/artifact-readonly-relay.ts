import { connect } from 'node:net';

const socketPath = process.argv[2];
if (!socketPath) throw new Error('artifact read-only MCP relay requires a socket path');

const socket = connect(socketPath);
socket.once('connect', () => process.stdin.pipe(socket));
socket.pipe(process.stdout);
socket.once('error', (err) => {
  process.stderr.write(`artifact read-only MCP relay failed: ${err.message}\n`);
  process.exitCode = 1;
});
process.stdin.once('end', () => socket.end());
