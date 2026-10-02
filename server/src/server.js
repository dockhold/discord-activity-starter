// The whole server: the built client, GET /api/config, POST /api/token,
// GET /health and the game's WebSocket at /ws, on one port.
//
// Trust rules:
//   * A player's identity comes only from our signed session token, never
//     from a message body. The token is checked during the WebSocket
//     handshake, so a socket without a valid session is never opened.
//   * Host and X-Forwarded-* are never read. URLs are parsed against a fixed
//     base, the address on the setup page comes from DOCKHOLD_APP_HOSTNAME,
//     and the sign-in rate limit is keyed on the code (see ratelimit.js).
//   * Nothing logs a client secret, a Discord token, an authorization code
//     or a session token. Log lines carry counts and status codes only.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { LIMITS } from './limits.js';
import { INSTANCE_ID, deriveSessionKey, signSession, verifySession } from './session.js';
import { createTokenLimiter } from './ratelimit.js';
import { exchangeCode, fetchUser } from './discord.js';
import { HZ, Room } from './game.js';
import { serveStatic, setupPage } from './pages.js';

export const DISCORD_API = 'https://discord.com/api/v10';
export const DEFAULT_CLIENT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
// The page offers two WebSocket subprotocols: this name, then its session
// token. The server answers with the name only, so the token is never echoed.
export const SUBPROTOCOL = 'activity-session';

const CODE = /^[A-Za-z0-9._~-]{1,256}$/;
const BASE_HEADERS = Object.freeze({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
const SETUP_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
// No frame-ancestors: Discord shows the page in its own frame.
const GAME_CSP = "default-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

// Discord documents the /.proxy/ prefix as optional and says both forms reach
// the mapped host the same way. It does not say whether the prefix is
// stripped before forwarding, so every route answers with and without it.
export function normalizePath(p) {
  if (p === '/.proxy') return '/';
  if (p.startsWith('/.proxy/')) return p.slice('/.proxy'.length);
  return p;
}

function pathOf(req) {
  try {
    return normalizePath(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return null;
  }
}

// The session token from Sec-WebSocket-Protocol: "activity-session, <token>".
function offeredToken(req) {
  const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
  return offered.length === 2 && offered[0] === SUBPROTOCOL ? offered[1] : null;
}

function sendJson(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
    ...extra,
  });
  res.end(data);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        resolve(null);
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

// `discordApiBase` exists for the tests, which point it at a local fake of
// Discord's API. It is deliberately not read from the environment, so no
// setting on a deployed app can redirect the client secret elsewhere.
export function createServer({
  config,
  discordApiBase = DISCORD_API,
  log = (line) => console.log(line),
  clientDist = DEFAULT_CLIENT_DIST,
  limits = {},
  now = Date.now,
} = {}) {
  const L = { ...LIMITS, ...limits };
  const key = config.configured ? deriveSessionKey(config.clientSecret, config.clientId) : null;
  const limitSignIn = createTokenLimiter({
    triesPerCode: L.tokenTriesPerCode,
    codeWindowMs: L.tokenCodeWindowMs,
    globalBurst: L.tokenGlobalBurst,
    globalPerSecond: L.tokenGlobalPerSecond,
    now,
  });
  const rooms = new Map();
  const perUser = new Map(); // Discord user ID -> open sockets, across rooms
  let discordPausedUntil = 0; // set from Discord's Retry-After on a 429
  let closing = false;
  let closed = null;

  // Repeated events (refusals, floods) log at most once a minute per kind.
  const lastNote = new Map();
  function note(kind, line) {
    const t = Date.now();
    if ((lastNote.get(kind) ?? -Infinity) + 60_000 <= t) {
      lastNote.set(kind, t);
      log(line);
    }
  }

  function discordBusy(res, retryAfterS) {
    discordPausedUntil = Math.max(discordPausedUntil, now() + retryAfterS * 1000);
    note('busy', `Discord asked this app to wait ${retryAfterS} s before the next sign-in (HTTP 429). Sign-ins answer 503 until then.`);
    return sendJson(res, 503, { error: 'Discord is busy. Try again in a moment.' }, { 'Retry-After': String(retryAfterS) });
  }

  async function handleToken(req, res) {
    if (!config.configured) return sendJson(res, 503, { error: 'This Activity is not set up yet.' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' }, { Allow: 'POST' });
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return sendJson(res, 415, { error: 'Send JSON (Content-Type: application/json).' });
    if (Number(req.headers['content-length'] ?? 0) > L.tokenBodyBytes) {
      return sendJson(res, 413, { error: 'Request too large.' }, { Connection: 'close' });
    }
    let raw;
    try {
      raw = await readBody(req, L.tokenBodyBytes);
    } catch {
      return undefined;
    }
    if (raw === null) return sendJson(res, 413, { error: 'Request too large.' }, { Connection: 'close' });

    let body = null;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      body = null;
    }
    const code = body?.code;
    const instanceId = body?.instance_id;
    if (typeof code !== 'string' || !CODE.test(code) || typeof instanceId !== 'string' || !INSTANCE_ID.test(instanceId)) {
      return sendJson(res, 400, { error: 'Send the code from the Discord SDK and the instance ID as JSON.' });
    }

    // While Discord has asked us to wait, answer without calling it.
    const waitMs = discordPausedUntil - now();
    if (waitMs > 0) {
      return sendJson(res, 503, { error: 'Discord is busy. Try again in a moment.' }, { 'Retry-After': String(Math.ceil(waitMs / 1000)) });
    }

    const verdict = limitSignIn(code);
    if (verdict !== 'ok') {
      note(
        `limit-${verdict}`,
        verdict === 'global'
          ? `Sign-in limit reached: the shared budget (${L.tokenGlobalBurst} at once, then ${L.tokenGlobalPerSecond} a second) is used up. Refusing sign-ins until it refills.`
          : 'Sign-in limit reached: an authorization code was sent too many times.',
      );
      return sendJson(res, 429, { error: 'Too many sign-in attempts. Try again in a minute.' }, { 'Retry-After': '60' });
    }

    const exchange = await exchangeCode({
      apiBase: discordApiBase,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      timeoutMs: L.discordTimeoutMs,
    });
    if (!exchange.ok) {
      if (exchange.kind === 'refused') {
        note(
          'refused',
          `Sign-in refused by Discord (HTTP ${exchange.status}). If every sign-in fails, check DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.`,
        );
        return sendJson(res, 400, { error: 'Discord did not accept this sign-in. Close the Activity and open it again.' });
      }
      if (exchange.kind === 'busy') return discordBusy(res, exchange.retryAfterS);
      note('unreachable', `Could not complete a sign-in with Discord${exchange.status ? ` (HTTP ${exchange.status})` : ' (no answer)'}.`);
      return sendJson(res, 502, { error: 'Could not reach Discord. Try again in a moment.' });
    }

    const me = await fetchUser({ apiBase: discordApiBase, accessToken: exchange.accessToken, timeoutMs: L.discordTimeoutMs });
    if (!me.ok) {
      if (me.kind === 'busy') return discordBusy(res, me.retryAfterS);
      note('user', `Could not read the signed-in Discord user${me.status ? ` (HTTP ${me.status})` : ' (no answer)'}.`);
      return sendJson(res, 502, { error: 'Could not reach Discord. Try again in a moment.' });
    }

    const session = signSession(key, { userId: me.user.id, name: me.user.name, instanceId }, now(), L.sessionTtlMs);
    return sendJson(res, 200, {
      access_token: exchange.accessToken, // for the SDK's authenticate command, in the client only
      session_token: session.token, // for our WebSocket
      session_expires_at: session.expiresAt,
      user: me.user,
    });
  }

  async function onRequest(req, res) {
    const pathname = pathOf(req);
    if (pathname === null) {
      res.writeHead(400, BASE_HEADERS);
      return res.end();
    }
    if (pathname === '/health') return sendJson(res, 200, { status: 'ok' });
    if (pathname === '/api/config') {
      if (!config.configured) {
        return sendJson(res, 503, { error: "This Activity is not set up yet. Open the app's address in a browser to see what is missing." });
      }
      return sendJson(res, 200, { clientId: config.clientId });
    }
    if (pathname === '/api/token') return handleToken(req, res);
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...BASE_HEADERS, Allow: 'GET, HEAD' });
      return res.end();
    }
    if (!config.configured && (pathname === '/' || pathname === '/index.html')) {
      const html = setupPage(config);
      res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': SETUP_CSP,
      });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    if (config.configured && (await serveStatic(clientDist, pathname, req, res, BASE_HEADERS, GAME_CSP))) return undefined;
    res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found\n');
  }

  const httpServer = http.createServer({ requestTimeout: 30_000, headersTimeout: 20_000 }, (req, res) => {
    onRequest(req, res).catch(() => {
      note('request-error', 'A request failed with an internal error.');
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' });
      else res.destroy();
    });
  });

  // The WebSocket. maxPayload makes ws close an oversized message with 1009.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: L.maxMessageBytes,
    perMessageDeflate: false,
    clientTracking: true,
    handleProtocols: (offered) => (offered.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });

  // Sign-in happens here, before the socket exists: no valid session, no
  // socket, and nothing is held open for a caller without one.
  httpServer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    // After 'upgrade' the socket is ours alone: no HTTP timeout applies and
    // the server allows half-open sockets. So destroy it once the answer is
    // written, or a peer that keeps its side open would hold it forever.
    const refuse = (status) => {
      socket.once('finish', () => socket.destroy());
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (pathOf(req) !== '/ws') return refuse(404);
    if (!config.configured || closing) return refuse(503);
    const v = verifySession(key, offeredToken(req), now());
    if (!v.ok) {
      note('ws-refused', 'Refused a WebSocket without a valid session (401).');
      return refuse(401);
    }
    if (wss.clients.size >= L.maxSockets) {
      note('max-sockets', `Connection limit reached (${L.maxSockets} open sockets). Refusing new ones.`);
      return refuse(503);
    }
    return wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, v.session));
  });

  // Closes with a code, and cuts the connection if the peer has not answered
  // the close frame within closeGraceMs.
  function drop(ws, code, reason) {
    if (ws.dropTimer) return;
    ws.close(code, reason);
    ws.dropTimer = setTimeout(() => ws.terminate(), L.closeGraceMs);
    ws.dropTimer.unref();
  }

  function send(ws, obj) {
    sendRaw(ws, JSON.stringify(obj));
  }

  function sendRaw(ws, data) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > L.maxBufferedBytes) {
      ws.terminate();
      return;
    }
    ws.send(data);
  }

  function broadcast(room, msg) {
    const data = JSON.stringify(msg);
    for (const ws of room.sockets) sendRaw(ws, data);
  }

  // The game clock: one timer, 15 times a second, for every room with
  // something to do. A room joins it on a ride, a watch, or someone arriving
  // or leaving, and drops out once it has no riders and nothing left to say,
  // so an idle server runs no game timer at all. One shared timer rather
  // than one per room: 200 busy rooms cost one wake-up a tick instead of
  // 200, every room ticks in step, and a room that leaves `rooms` (evicted
  // or swept) cannot leave a timer behind: the clock skips it and lets go.
  const TICK_MS = 1000 / HZ;
  const ticking = new Set();
  let clock = null;
  let nextTickAt = 0;

  function wake(room) {
    ticking.add(room);
    if (clock || closing) return;
    nextTickAt = performance.now() + TICK_MS;
    clock = setTimeout(runClock, TICK_MS);
    clock.unref();
  }

  function runClock() {
    if (closing) {
      clock = null;
      return;
    }
    // `clock` stays set while the rooms step: a wake() during a tick (from a
    // socket a broadcast closed, say) must not start a second clock.
    for (const room of ticking) {
      if (rooms.get(room.id) !== room) {
        ticking.delete(room);
        continue;
      }
      // A room that throws is closed on its own; every other room ticks on.
      try {
        for (const msg of room.step()) broadcast(room, msg);
        if (!room.busy()) ticking.delete(room);
      } catch {
        note('room-error', 'A room failed with an internal error and was closed.');
        ticking.delete(room);
        rooms.delete(room.id);
        for (const ws of room.sockets) drop(ws, 1011, 'room error');
      }
    }
    clock = null;
    if (ticking.size === 0) return;
    // Aim at a fixed 15 a second. A late tick shortens the next wait; a
    // stall longer than a tick is not made up with a burst.
    const t = performance.now();
    nextTickAt = Math.max(nextTickAt + TICK_MS, t);
    clock = setTimeout(runClock, nextTickAt - t);
    clock.unref();
  }

  function onConnection(ws, session) {
    ws.player = null;
    ws.room = null;
    ws.dropTimer = null;
    ws.lastSeen = Date.now();
    ws.windowStart = ws.lastSeen;
    ws.windowCount = 0;
    ws.on('error', (err) => {
      if (err?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
        note('too-big', `Closed a socket that sent a message over ${L.maxMessageBytes} bytes.`);
        drop(ws, 1009, 'message too big');
      } else {
        drop(ws, 1002, 'protocol error');
      }
    });
    ws.on('message', (data, isBinary) => onMessage(ws, data, isBinary));
    ws.on('close', () => onClose(ws));

    const { userId, name, instanceId } = session;
    // An over-cap player cannot create a room or join one.
    if ((perUser.get(userId) ?? 0) >= L.maxSocketsPerUser) return drop(ws, 4003, 'too many connections');
    let room = rooms.get(instanceId);
    if (!room) {
      // At the cap, an empty room (the one empty longest) makes way.
      if (rooms.size >= L.maxRooms) {
        let oldest = null;
        for (const r of rooms.values()) {
          if (r.sockets.size === 0 && (!oldest || r.emptySince < oldest.emptySince)) oldest = r;
        }
        if (!oldest) {
          note('max-rooms', `Room limit reached (${L.maxRooms} rooms, none empty). Refusing new ones.`);
          return drop(ws, 4003, 'server full');
        }
        rooms.delete(oldest.id);
      }
      room = new Room(instanceId);
      room.emptySince = Date.now();
      rooms.set(instanceId, room);
    }
    if (room.sockets.size >= L.maxSocketsPerRoom) return drop(ws, 4003, 'room full');
    if (room.socketsOf(userId) >= L.maxSocketsPerUserPerRoom) return drop(ws, 4003, 'too many connections');

    ws.player = { id: userId, name };
    ws.room = room;
    room.sockets.add(ws);
    room.emptySince = null;
    perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
    send(ws, { t: 'welcome', you: ws.player, sessionExpiresAt: session.expiresAt });
    room.presenceChanged();
    send(ws, room.snapshot());
    wake(room); // the others hear about the newcomer on the next tick
    return undefined;
  }

  function onMessage(ws, data, isBinary) {
    if (ws.readyState !== ws.OPEN || !ws.player) return;
    const t = Date.now();
    if (t - ws.windowStart >= 1000) {
      ws.windowStart = t;
      ws.windowCount = 0;
    }
    ws.windowCount += 1;
    if (ws.windowCount > L.maxMessagesPerSecond) {
      note('flood', `Closed a socket that sent more than ${L.maxMessagesPerSecond} messages in a second.`);
      drop(ws, 1008, 'too many messages');
      return;
    }
    ws.lastSeen = t;
    if (isBinary) {
      drop(ws, 1003, 'text only');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      msg = null;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
      drop(ws, 1007, 'invalid message');
      return;
    }
    onGame(ws, msg);
  }

  // Identity is ws.player, set from the session token. No field of a
  // message can change it, so a player can only ever steer their own cycle.
  // A turn changes nothing but the player's own queue; the clock sends the
  // result with the next tick. Turns the game cannot use are ignored without
  // an answer.
  function onGame(ws, msg) {
    const room = ws.room;
    switch (msg.t) {
      case 'pong':
        return;
      case 'turn':
        room.turn(ws.player, msg.d);
        return;
      case 'ride': {
        const err = room.ride(ws.player);
        if (err) send(ws, { t: 'error', message: err });
        else wake(room);
        return;
      }
      case 'watch':
        if (room.watch(ws.player)) wake(room);
        return;
      default:
        return; // unknown types are ignored, so older servers accept newer clients
    }
  }

  function onClose(ws) {
    clearTimeout(ws.dropTimer);
    const room = ws.room;
    if (!room) return;
    ws.room = null;
    const left = (perUser.get(ws.player.id) ?? 1) - 1;
    if (left > 0) perUser.set(ws.player.id, left);
    else perUser.delete(ws.player.id);
    room.sockets.delete(ws);
    if (room.sockets.size === 0) room.emptySince = Date.now();
    room.presenceChanged();
    wake(room);
  }

  // Every 25 seconds: an application-level ping to each socket (a text
  // message, so it crosses Discord's proxy like any other), a drop of
  // sockets silent for too long, and a sweep of rooms left empty.
  const tick = setInterval(() => {
    const t = Date.now();
    for (const ws of wss.clients) {
      if (!ws.player) continue;
      if (t - ws.lastSeen > L.idleTimeoutMs) {
        ws.terminate();
        continue;
      }
      send(ws, { t: 'ping' });
    }
    for (const [id, room] of rooms) {
      if (room.sockets.size === 0 && room.emptySince !== null && t - room.emptySince >= L.emptyRoomTtlMs) rooms.delete(id);
    }
  }, L.pingIntervalMs);
  tick.unref();

  // Stops accepting, sends every socket a 1001 close, and resolves once the
  // last connection is gone (forcing it after shutdownGraceMs).
  function close() {
    if (closed) return closed;
    closing = true;
    clearInterval(tick);
    clearTimeout(clock);
    clock = null;
    closed = new Promise((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeIdleConnections();
      for (const ws of wss.clients) ws.close(1001, 'server restarting');
      setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
        httpServer.closeAllConnections();
      }, L.shutdownGraceMs).unref();
    });
    return closed;
  }

  return { httpServer, wss, rooms, perUser, close };
}
