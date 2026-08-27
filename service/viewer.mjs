import { createServer } from 'node:http';

const port = 3001;
// The public viewer must never proxy the Vite development server. Its HMR
// websocket is unreliable through tunnels and can enter a reconnect loop.
const siteOrigin = 'http://127.0.0.1:3002';
const dataOrigin = 'http://127.0.0.1:4300';
const blockedPaths = ['/__debug', '/.env', '/data', '/service', '/scripts'];
const clients = new Map();

function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...extra,
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  response.end(JSON.stringify(payload));
}

function rateLimited(request) {
  const address = request.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const previous = clients.get(address);
  const entry = !previous || now - previous.startedAt > 60_000 ? { startedAt: now, requests: 0 } : previous;
  entry.requests += 1;
  clients.set(address, entry);
  return entry.requests > 180;
}

async function publicStatus() {
  const response = await fetch(`${dataOrigin}/api/published`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Archive service unavailable.');
  const archive = await response.json();
  return {
    online: true,
    credentials: { gameAuth: false, apiKey: false, steamId: false, knownCode: false },
    steamId64: archive.published?.ownerSteamId64 ?? '',
    discoveredCodes: archive.matches.length,
    analyzedMatches: archive.matches.length,
    playerCount: archive.players.length,
    steam: { status: 'viewer', message: archive.published ? 'Last published snapshot' : 'Nothing published yet', hasSavedSession: false, qrDataUrl: '' },
    importing: { running: false, total: 0, processed: 0, imported: 0, failed: 0, message: '' },
    maps: { running: false, total: archive.matches.length, processed: archive.matches.length, resolved: archive.matches.length, failed: 0, message: '' },
  };
}

async function publicArchive() {
  const response = await fetch(`${dataOrigin}/api/published`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Archive service unavailable.');
  return response.json();
}

async function proxySite(request, response, url) {
  const upstream = await fetch(new URL(`${url.pathname}${url.search}`, siteOrigin), {
    headers: { Accept: request.headers.accept ?? '*/*' },
    signal: AbortSignal.timeout(15_000),
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  const headers = securityHeaders();
  for (const name of ['content-type', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  response.writeHead(upstream.status, headers);
  if (request.method === 'HEAD') response.end();
  else response.end(body);
}

const server = createServer(async (request, response) => {
  try {
    if (rateLimited(request)) return sendJson(response, 429, { error: 'Too many viewer requests. Try again shortly.' });
    if (!['GET', 'HEAD'].includes(request.method ?? '')) return sendJson(response, 405, { error: 'This viewer is read-only.' });
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname === '/' && url.searchParams.get('viewer') !== '1') {
      response.writeHead(302, securityHeaders({ Location: '/?viewer=1#played-with' }));
      return response.end();
    }
    if (blockedPaths.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) return sendJson(response, 404, { error: 'Not found.' });
    if (url.pathname === '/api/status') return sendJson(response, 200, await publicStatus());
    if (url.pathname === '/api/archive') return sendJson(response, 200, await publicArchive());
    if (url.pathname.startsWith('/api/')) return sendJson(response, 405, { error: 'This viewer is read-only.' });
    return await proxySite(request, response, url);
  } catch (error) {
    return sendJson(response, 503, { error: error instanceof Error ? error.message : 'Viewer unavailable.' });
  }
});

server.listen(port, '127.0.0.1', () => console.log(`Stackline read-only viewer: http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
