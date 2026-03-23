import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SpotifyConfig } from './utils.js';

export interface UserSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
  clientSecret: string;
}

// In-memory stores
const authCodes = new Map<
  string,
  {
    session: UserSession;
    redirectUri: string;
    state: string;
    expiresAt: number;
  }
>();
const bearerTokens = new Map<string, UserSession>();

function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function getSessionFromBearer(
  authHeader: string | undefined,
): UserSession | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const session = bearerTokens.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    bearerTokens.delete(token);
    return null;
  }
  return session;
}

export async function handleOAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  config: SpotifyConfig,
  serverUrl: string,
): Promise<boolean> {
  const url = new URL(req.url!, 'http://localhost');

  // Discovery metadata
  if (
    req.method === 'GET' &&
    url.pathname === '/.well-known/oauth-authorization-server'
  ) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        issuer: serverUrl,
        authorization_endpoint: `${serverUrl}/authorize`,
        token_endpoint: `${serverUrl}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
      }),
    );
    return true;
  }

  // /authorize — redirect to Spotify login
  if (req.method === 'GET' && url.pathname === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const clientId = url.searchParams.get('client_id') ?? config.clientId;

    const encodedState = Buffer.from(
      JSON.stringify({ redirectUri, state, clientId }),
    ).toString('base64url');

    const scopes = [
      'user-read-private',
      'user-read-playback-state',
      'user-modify-playback-state',
      'user-read-currently-playing',
      'playlist-read-private',
      'playlist-modify-private',
      'playlist-modify-public',
      'user-library-read',
      'user-library-modify',
      'user-read-recently-played',
    ];

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: `${serverUrl}/oauth/callback`,
      scope: scopes.join(' '),
      state: encodedState,
    });

    res.writeHead(302, {
      Location: `https://accounts.spotify.com/authorize?${params}`,
    });
    res.end();
    return true;
  }

  // /oauth/callback — Spotify redirects here after login
  if (req.method === 'GET' && url.pathname === '/oauth/callback') {
    const code = url.searchParams.get('code');
    const encodedState = url.searchParams.get('state') ?? '';

    if (!code) {
      res.writeHead(400).end('Missing code');
      return true;
    }

    let stateData: { redirectUri: string; state: string; clientId: string };
    try {
      stateData = JSON.parse(Buffer.from(encodedState, 'base64url').toString());
    } catch {
      res.writeHead(400).end('Invalid state');
      return true;
    }

    try {
      // Exchange Spotify code — use the clientId from state to find clientSecret
      // For simplicity, we use the server's clientSecret (same Spotify app)
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${serverUrl}/oauth/callback`,
      });

      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${stateData.clientId}:${config.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      });

      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();

      const session: UserSession = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
        clientId: stateData.clientId,
        clientSecret: config.clientSecret,
      };

      const authCode = generateToken();
      authCodes.set(authCode, {
        session,
        redirectUri: stateData.redirectUri,
        state: stateData.state,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      const redirectParams = new URLSearchParams({
        code: authCode,
        state: stateData.state,
      });
      res.writeHead(302, {
        Location: `${stateData.redirectUri}?${redirectParams}`,
      });
      res.end();
    } catch (err) {
      console.error('OAuth callback error:', err);
      res.writeHead(500).end('Authentication failed');
    }
    return true;
  }

  // /token — exchange auth code for bearer token
  if (req.method === 'POST' && url.pathname === '/token') {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const code = params.get('code') ?? '';
    const entry = authCodes.get(code);

    if (!entry || entry.expiresAt <= Date.now()) {
      authCodes.delete(code);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
      return true;
    }

    authCodes.delete(code);

    const bearerToken = generateToken();
    const expiresIn = 3600;
    bearerTokens.set(bearerToken, {
      ...entry.session,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        access_token: bearerToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
      }),
    );
    return true;
  }

  return false;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}
