/**
 * Mr. Mags HTTP API server.
 *
 * Lives inside the Electron main process. Owns the @mediagato/brain instance
 * (single PGlite writer). Exposes a tiny REST surface on 127.0.0.1:11436 so
 * multiple front doors can share one brain:
 *
 *   - Claude Desktop spawns server/index.js (MCP stdio relay) which proxies
 *     each MCP call here.
 *   - Browser extension's background service worker calls these endpoints
 *     directly to inject context into AI chats.
 *   - CLI / scripts / future MCP transports — same shape.
 *
 * Localhost-only bind. No auth — anyone with shell access already owns the
 * brain file, so a token would be theater. CORS allows everything because
 * the browser extension calls from its own origin and the server is bound
 * to 127.0.0.1 anyway.
 */
const http = require('node:http');
const brain = require('@mediagato/brain');

const PORT = parseInt(process.env.MRMAGS_API_PORT || '11436', 10);
const HOST = '127.0.0.1';

// ── helpers ───────────────────────────────────────────────────────────────

function send(res, status, body) {
  const text = body == null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function ok(res, body) { send(res, 200, body); }
function bad(res, msg, code = 400) { send(res, code, { error: msg }); }
function notFound(res, msg = 'not found') { send(res, 404, { error: msg }); }

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 1024 * 1024) {  // 1MB cap on body
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => {
      if (!buf.trim()) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

// ── route handlers ────────────────────────────────────────────────────────

const APP_VERSION = '0.2.2';

async function handleHealth(req, res) {
  let memory_count = 0;
  try { memory_count = (await brain.getAllMemories()).length; } catch {}
  ok(res, {
    ok: true,
    name: 'mrmags',
    version: APP_VERSION,
    dbPath: brain.dbPath(),
    seededAt: await brain.isSeeded(),
    memory_count,
  });
}

async function handleListMemories(req, res) {
  const rows = await brain.getAllMemories();
  ok(res, rows);
}

async function handleGetMemory(req, res, filename) {
  const row = await brain.getMemory(decodeURIComponent(filename));
  if (!row) return notFound(res, 'memory not found');
  ok(res, { filename, ...row });
}

async function handleSaveMemory(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return bad(res, e.message); }
  const { filename, content, layer } = body;
  if (!filename || typeof filename !== 'string') return bad(res, 'filename required');
  if (typeof content !== 'string') return bad(res, 'content required (string)');
  await brain.setMemory(filename, content, body.updatedBy || 'http', layer || 'instance');
  ok(res, { saved: filename, length: content.length });
}

async function handleDeleteMemory(req, res, filename) {
  const fn = decodeURIComponent(filename);
  const existing = await brain.getMemory(fn);
  if (!existing) return notFound(res, 'memory not found');
  await brain.deleteMemory(fn);
  ok(res, { deleted: fn });
}

async function handleListState(req, res) {
  const rows = await brain.getAllState();
  ok(res, rows);
}

async function handleGetState(req, res, key) {
  const row = await brain.getState(decodeURIComponent(key));
  if (!row) return notFound(res, 'state key not found');
  ok(res, { key: decodeURIComponent(key), ...row });
}

async function handleSetState(req, res, key) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return bad(res, e.message); }
  if (typeof body.value !== 'string') return bad(res, 'value required (string)');
  await brain.setState(decodeURIComponent(key), body.value, body.updatedBy || 'http');
  ok(res, { saved: decodeURIComponent(key) });
}

async function handleSeedPack(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return bad(res, e.message); }
  const pack = (body.pack || 'teacher').toLowerCase();
  const sporeBase = process.env.MRMAGS_SPORE_BASE || 'https://app.modelreins.com';
  const url = `${sporeBase}/saas/spore/seed?pack=${encodeURIComponent(pack)}`;

  const beforeMem = (await brain.getAllMemories()).length;
  const beforeState = (await brain.getAllState()).length;

  let payload;
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    payload = await r.json();
  } catch (e) {
    // Fallback: bundled pack file shipped inside the app
    const path = require('node:path');
    const fs = require('node:fs');
    const yaml = require('yaml');
    const candidates = [
      path.join(__dirname, 'packs', `${pack}.yaml`),
      path.join(process.resourcesPath || __dirname, 'app', 'packs', `${pack}.yaml`),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) return bad(res, `could not fetch ${url} (${e.message}) and no bundled pack at ${candidates.join(' or ')}`, 502);
    payload = yaml.parse(fs.readFileSync(found, 'utf8'));
  }

  const count = await brain.seedFromSpore(payload);
  const afterMem = (await brain.getAllMemories()).length;
  const afterState = (await brain.getAllState()).length;
  ok(res, {
    pack,
    attempted: count,
    addedMemories: afterMem - beforeMem,
    addedState: afterState - beforeState,
  });
}

async function handleGetName(req, res) {
  ok(res, { name: await brain.getName() });
}

async function handleSetName(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return bad(res, e.message); }
  if (!body.name || typeof body.name !== 'string') return bad(res, 'name required');
  await brain.setName(body.name);
  ok(res, { name: body.name });
}

// ── router ────────────────────────────────────────────────────────────────

async function route(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && p === '/health') return handleHealth(req, res);

  if (method === 'GET'    && p === '/memories')                return handleListMemories(req, res);
  if (method === 'POST'   && p === '/memory')                  return handleSaveMemory(req, res);
  if (method === 'GET'    && p.startsWith('/memory/'))         return handleGetMemory(req, res, p.slice('/memory/'.length));
  if (method === 'DELETE' && p.startsWith('/memory/'))         return handleDeleteMemory(req, res, p.slice('/memory/'.length));

  if (method === 'GET'  && p === '/state')                   return handleListState(req, res);
  if (method === 'POST' && p === '/state')                   return bad(res, 'POST /state/<key> instead');
  if (method === 'GET'  && p.startsWith('/state/'))          return handleGetState(req, res, p.slice('/state/'.length));
  if (method === 'POST' && p.startsWith('/state/'))          return handleSetState(req, res, p.slice('/state/'.length));

  if (method === 'POST' && p === '/spore/seed')              return handleSeedPack(req, res);

  if (method === 'GET'  && p === '/name')                    return handleGetName(req, res);
  if (method === 'POST' && p === '/name')                    return handleSetName(req, res);

  notFound(res, `${method} ${p} not handled`);
}

// ── lifecycle ─────────────────────────────────────────────────────────────

let server = null;

function start() {
  if (server) return Promise.resolve(server);
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      route(req, res).catch((e) => {
        console.error('[api] handler crashed:', e);
        if (!res.headersSent) bad(res, e.message, 500);
      });
    });
    server.on('error', reject);
    server.listen(PORT, HOST, () => {
      console.error(`[api] listening on http://${HOST}:${PORT}`);
      resolve(server);
    });
  });
}

async function stop() {
  if (!server) return;
  return new Promise((resolve) => {
    server.close(() => {
      server = null;
      resolve();
    });
  });
}

module.exports = { start, stop, PORT, HOST };
