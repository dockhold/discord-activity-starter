// Shared test helpers: a fake of the two Discord API routes the server calls,
// an in-process server with its log captured, and a small WebSocket client.

import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { readConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { deriveSessionKey, signSession } from '../src/session.js';

export const CLIENT_ID = '123456789012345678';
export const SECRET = 'test-client-secret-0123456789abcdef';
export const OTHER_SECRET = 'another-client-secret-fedcba9876543210';
export const HOST = 'activity-test-a1b2c3.dockhold.app';
export const USER_A = { id: '111111111111111111', name: 'Ana' };
export const USER_B = { id: '222222222222222222', name: 'Bo' };
export const USER_C = { id: '333333333333333333', name: 'Cy' };
export const INSTANCE = 'i-1276580072400224306-gc-912952092627435520-912954213460484116';

// Every value that must never appear in a log line, collected as tests run.
export const sensitive = new Set([SECRET, OTHER_SECRET]);
// Every log line any in-process server wrote.
export const allLogs = [];

export function configured(extra = {}) {
  return readConfig({ DISCORD_CLIENT_ID: CLIENT_ID, DISCORD_CLIENT_SECRET: SECRET, DOCKHOLD_APP_HOSTNAME: HOST, ...extra });
}

export function fakeDist() {
  const dir = mkdtempSync(path.join(tmpdir(), 'activity-dist-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="app"></div><script type="module" src="/assets/app-abc123.js"></script>\n');
  writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log("app")\n');
  return dir;
}

// A stand-in for discord.com/api: POST /oauth2/token and GET /users/@me.
// `codes` maps an accepted authorization code to the user it signs in.
// `tokenStatus` forces an answer for every token exchange.
export async function startFakeDiscord({ codes = {}, tokenStatus = null, retryAfter = null } = {}) {
  const calls = { token: [], me: [] };
  const issued = new Map();
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname.endsWith('/oauth2/token')) {
        const form = Object.fromEntries(new URLSearchParams(raw));
        calls.token.push({ form, contentType: req.headers['content-type'] });
        if (tokenStatus) {
          res.writeHead(tokenStatus, { 'Content-Type': 'application/json', ...(retryAfter ? { 'Retry-After': retryAfter } : {}) });
          return res.end(JSON.stringify({ error: 'forced', echo: form.code }));
        }
        const user = codes[form.code];
        if (form.client_id !== CLIENT_ID || form.client_secret !== SECRET) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid_client' }));
        }
        if (!user || form.grant_type !== 'authorization_code') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid_grant', error_description: `Invalid "code" in request: ${form.code}` }));
        }
        n += 1;
        const accessToken = `fake-access-token-${n}-${'x'.repeat(16)}`;
        issued.set(accessToken, user);
        sensitive.add(accessToken);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 604800, refresh_token: `fake-refresh-${n}`, scope: 'identify' }));
      }
      if (req.method === 'GET' && url.pathname.endsWith('/users/@me')) {
        const auth = req.headers.authorization ?? '';
        calls.me.push({ auth });
        const user = issued.get(auth.replace(/^Bearer /, ''));
        if (!user) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: '401: Unauthorized' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: user.id, username: user.name.toLowerCase(), global_name: user.name, avatar: null }));
      }
      res.writeHead(404);
      return res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v10`;
  return { base, calls, close: () => new Promise((r) => server.close(r)) };
}

// A plain HTTP request. Unlike fetch, it sends a forged Host header as given.
export function raw(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

export async function startApp({ config = configured(), discordApiBase, limits, clientDist = fakeDist(), now } = {}) {
  const logs = [];
  const log = (line) => {
    logs.push(line);
    allLogs.push(line);
  };
  const app = createServer({ config, discordApiBase: discordApiBase ?? 'http://127.0.0.1:9/api/v10', log, limits, clientDist, now });
  await new Promise((r) => app.httpServer.listen(0, '127.0.0.1', r));
  const port = app.httpServer.address().port;
  return {
    app,
    logs,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    port,
    close: () => app.close(),
  };
}

export function mint(user, { secret = SECRET, clientId = CLIENT_ID, instanceId = INSTANCE, nowMs = Date.now(), ttlMs = 15 * 60 * 1000 } = {}) {
  const { token } = signSession(deriveSessionKey(secret, clientId), { userId: user.id, name: user.name, instanceId }, nowMs, ttlMs);
  sensitive.add(token);
  return token;
}

// Opens a socket and records everything it receives. `protocols` is what
// the page sends: ['activity-session', <session token>].
export function connect(url, { headers, protocols = [] } = {}) {
  const ws = new WebSocket(url, protocols, { headers });
  const messages = [];
  const waiters = [];
  const opened = Date.now();
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  ws.on('error', () => {});
  // Settles on its own after 15 s, so a socket the server never closes fails
  // its test with a clear value instead of hanging the run.
  const closed = new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString(), ms: Date.now() - opened }));
    ws.on('unexpected-response', (_req, res) => resolve({ code: -1, status: res.statusCode, ms: Date.now() - opened }));
    setTimeout(() => resolve({ code: 'still open after 15 s' }), 15_000).unref();
  });
  const open = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    ws.on('error', reject);
  });
  open.catch(() => {}); // awaited by the tests that expect the socket to open
  function next(match, timeoutMs = 3000) {
    const fn = typeof match === 'string' ? (m) => m.t === match : match;
    const hit = messages.find(fn);
    if (hit) {
      messages.splice(messages.indexOf(hit), 1);
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const w = { match: fn, resolve: (m) => { clearTimeout(timer); messages.splice(messages.indexOf(m), 1); resolve(m); } };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error(`no "${typeof match === 'string' ? match : 'matching'}" message within ${timeoutMs} ms`));
      }, timeoutMs);
      waiters.push(w);
    });
  }
  const send = (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  return { ws, messages, closed, open, next, send };
}

export function signedIn(user, opts = {}) {
  return ['activity-session', mint(user, opts)];
}

// Opens a socket signed in with a minted token; resolves after "welcome".
export async function player(wsUrl, user, opts = {}) {
  const c = connect(wsUrl, { protocols: signedIn(user, opts) });
  await c.open;
  c.welcome = await c.next('welcome');
  return c;
}

// Fails without printing the offending line, which would print the value.
export function assertNoSensitive(lines, assert) {
  assert.ok(sensitive.size > 2, 'the run collected the values to look for');
  lines.forEach((line, i) => {
    for (const s of sensitive) {
      assert.ok(!line.includes(s), `log line ${i + 1} contains a secret, token or code`);
    }
  });
}
