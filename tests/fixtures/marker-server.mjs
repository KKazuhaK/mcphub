import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Server } from '@modelcontextprotocol/server';

// Writes what it was given to stderr (a careless upstream does), then either exits or serves a
// tool that never echoes a credential.
console.error(`startup env=${process.env.MARKER_ENV} args=${process.argv.slice(2).join(' ')}`);
if (process.argv.includes('--fail')) {
  console.error(`fatal: cannot start with ${process.env.MARKER_ENV}`);
  process.exit(3);
}

const server = new Server(
  { name: 'marker-fixture', version: '1.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler('tools/list', async () => ({
  tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }],
}));
server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: 'pong' }] }));
await server.connect(new StdioServerTransport());
