import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { albumTools } from './albums.js';
import { playTools } from './play.js';
import { playlistTools } from './playlist.js';
import { readTools } from './read.js';
import { loadSpotifyConfig } from './utils.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Load API key once at startup
const config = await loadSpotifyConfig();
const API_KEY = config.apiKey;
if (!API_KEY) throw new Error('apiKey missing from config/secret');

const httpServer = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end('ok');
    return;
  }

  // Auth
  if (req.headers['x-api-key'] !== API_KEY) {
    res.writeHead(401).end('Unauthorized');
    return;
  }

  const server = new McpServer({ name: 'spotify-controller', version: '1.0.0' });
  [...readTools, ...playTools, ...albumTools, ...playlistTools].forEach((tool) => {
    server.tool(tool.name, tool.description, tool.schema, tool.handler);
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

httpServer.listen(PORT, () => {
  console.log(`MCP server listening on port ${PORT}`);
});
