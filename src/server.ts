import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SpotifyApi } from '@spotify/web-api-ts-sdk';
import { albumTools } from './albums.js';
import {
  type UserSession,
  getSessionFromBearer,
  handleOAuthRoutes,
} from './oauth.js';
import { playTools } from './play.js';
import { playlistTools } from './playlist.js';
import { readTools } from './read.js';
import {
  createSpotifyApi,
  loadSpotifyConfig,
  spotifyApiContext,
} from './utils.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${PORT}`;

const config = await loadSpotifyConfig();
const API_KEY = config.apiKey;
if (!API_KEY) throw new Error('apiKey missing from config/secret');

function buildMcpServer() {
  const server = new McpServer({
    name: 'spotify-controller',
    version: '1.0.0',
  });
  [...readTools, ...playTools, ...albumTools, ...playlistTools].forEach(
    (tool) => {
      server.tool(tool.name, tool.description, tool.schema, tool.handler);
    },
  );
  return server;
}

async function getSpotifyApiForSession(
  session: UserSession,
): Promise<SpotifyApi> {
  const now = Date.now();
  let { accessToken } = session;

  if (session.expiresAt <= now) {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    });
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${session.clientId}:${session.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    if (!response.ok) throw new Error('Failed to refresh token');
    const data = await response.json();
    accessToken = data.access_token;
    session.accessToken = accessToken;
    session.expiresAt = now + data.expires_in * 1000;
  }

  return SpotifyApi.withAccessToken(session.clientId, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor((session.expiresAt - now) / 1000),
    refresh_token: session.refreshToken,
  });
}

const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end('ok');
    return;
  }

  // OAuth routes (unauthenticated)
  if (await handleOAuthRoutes(req, res, config, SERVER_URL)) return;

  // Determine SpotifyApi instance based on auth method
  let spotifyApi: SpotifyApi;
  const apiKey = req.headers['x-api-key'];
  const bearerSession = getSessionFromBearer(req.headers.authorization);

  if (apiKey === API_KEY) {
    spotifyApi = await createSpotifyApi();
  } else if (bearerSession) {
    spotifyApi = await getSpotifyApiForSession(bearerSession);
  } else {
    res.writeHead(401).end('Unauthorized');
    return;
  }

  // Run MCP request with the correct SpotifyApi in context
  await spotifyApiContext.run(spotifyApi, async () => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
});

httpServer.listen(PORT, () => {
  console.error(`MCP server listening on port ${PORT}`);
  console.error(
    `OAuth discovery: ${SERVER_URL}/.well-known/oauth-authorization-server`,
  );
});
