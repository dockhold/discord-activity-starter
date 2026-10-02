// The WebSocket: sign-in during the handshake, the game, and the bounds.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import test from 'node:test';
import { LIMITS } from '../src/limits.js';
import {
  INSTANCE, OTHER_SECRET, SECRET, USER_A, USER_B, USER_C, allLogs, assertNoSensitive, connect, mint, player, signedIn, startApp,
} from './helpers.js';

const OTHER_INSTANCE = 'i-1276580072400224399-gc-912952092627435520-912954213460484116';

// Messages that carry the roster, and one that shows a given player riding.
const hasRoster = (m) => m.t === 'state' || m.t === 'roster';
const riding = (u) => (m) => hasRoster(m) && m.riders.some((r) => r.id === u.id);

// A WebSocket upgrade over a bare TCP socket. Resolves with the status line,
// the response headers, the socket, and when the server closed it.
// With allowHalfOpen the peer keeps its side open after the server ends its
// own, the way a hostile client would.
function rawUpgrade(port, { protocol, path = '/ws', headers = {}, allowHalfOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ port, host: '127.0.0.1', allowHalfOpen });
    const t0 = Date.now();
    let buf = Buffer.alloc(0);
    let head = null;
    const closed = new Promise((r) => sock.on('close', () => r(Date.now() - t0)));
    sock.on('error', () => {});
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (!head && end >= 0) {
        head = buf.subarray(0, end).toString();
        sock.off('data', onData);
        const [statusLine, ...lines] = head.split('\r\n');
        resolve({ sock, statusLine, headers: lines.join('\n').toLowerCase(), rest: buf.subarray(end + 4), closed });
      }
    };
    sock.on('data', onData);
    sock.on('connect', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n`
        + `${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}${extra}\r\n`,
      );
    });
    setTimeout(() => reject(new Error('no answer to the upgrade')), 3000).unref();
  });
}

// One masked client text frame (payload under 126 bytes).
function frame(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const out = Buffer.alloc(6 + payload.length);
  out[0] = 0x81;
  out[1] = 0x80 | payload.length;
  mask.copy(out, 2);
  for (let i = 0; i < payload.length; i += 1) out[6 + i] = payload[i] ^ mask[i % 4];
  return out;
}

test('refused at the handshake (401), with nothing left open', async () => {
  const s = await startApp();
  try {
    const [body, mac] = mint(USER_A).split('.');
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    p.sub = USER_B.id;
    const edited = `${Buffer.from(JSON.stringify(p)).toString('base64url')}.${mac}`;
    const cases = [
      ['no subprotocol', undefined],
      ['the name without a token', 'activity-session'],
      ['a junk token', 'activity-session, not-a-token'],
      ['an expired token', `activity-session, ${mint(USER_A, { nowMs: Date.now() - LIMITS.sessionTtlMs - 1000 })}`],
      ['a token signed with another key', `activity-session, ${mint(USER_A, { secret: OTHER_SECRET })}`],
      ['a token from another Discord application', `activity-session, ${mint(USER_A, { clientId: '987654321098765432' })}`],
      ['a token edited to another user', `activity-session, ${edited}`],
      ['a user ID in place of a token', `activity-session, ${USER_A.id}`],
      ['the token before the name', `${mint(USER_A)}, activity-session`],
      ['a valid token with an extra protocol', `activity-session, ${mint(USER_A)}, chat`],
    ];
    for (const [name, protocol] of cases) {
      const r = await rawUpgrade(s.port, { protocol });
      assert.equal(r.statusLine, 'HTTP/1.1 401 Unauthorized', name);
      const ms = await r.closed;
      assert.ok(ms < 500, `${name}: TCP closed at once (${ms} ms)`);
      assert.equal(s.app.wss.clients.size, 0, `${name}: no socket was opened`);
    }
    assert.equal(s.app.rooms.size, 0, 'no room was created');
    // The ws client sees the same refusal.
    const c = connect(s.wsUrl);
    assert.equal((await c.closed).status, 401);
    assert.equal(s.logs.filter((l) => l.startsWith('Refused a WebSocket without a valid session')).length, 1, 'logged once, not per refusal');
  } finally {
    await s.close();
  }
});

test('a refused handshake is released at once, even when the peer keeps its side open', async () => {
  const s = await startApp();
  let r;
  try {
    r = await rawUpgrade(s.port, { protocol: 'activity-session, not-a-token', allowHalfOpen: true });
    assert.equal(r.statusLine, 'HTTP/1.1 401 Unauthorized');
    const count = () => new Promise((res, rej) => s.app.httpServer.getConnections((e, n) => (e ? rej(e) : res(n))));
    let open = await count();
    for (let i = 0; i < 100 && open > 0; i += 1) {
      await new Promise((res) => setTimeout(res, 10));
      open = await count();
    }
    assert.equal(open, 0, 'the server still holds the refused connection after 1 s');
  } finally {
    r?.sock.destroy();
    await s.close();
  }
});

test('a valid token signs in during the handshake: welcome without sending anything', async () => {
  const s = await startApp();
  try {
    const r = await rawUpgrade(s.port, { protocol: `activity-session, ${mint(USER_A)}` });
    assert.equal(r.statusLine, 'HTTP/1.1 101 Switching Protocols');
    assert.match(r.headers, /^sec-websocket-protocol: activity-session$/m, 'only the name is echoed, never the token');
    const c = connect(s.wsUrl, { protocols: signedIn(USER_B) });
    await c.open;
    assert.equal(c.ws.protocol, 'activity-session');
    const welcome = await c.next('welcome');
    assert.deepEqual(welcome.you, { id: USER_B.id, name: USER_B.name });
    r.sock.destroy();
    c.ws.close();
  } finally {
    await s.close();
  }
});

test('identity comes from the token, never from a message', async () => {
  const s = await startApp();
  try {
    const c = await player(s.wsUrl, USER_A);
    c.send({ t: 'auth', userId: USER_B.id, user: { id: USER_B.id, name: 'Bo' }, token: mint(USER_B) });
    c.send({ t: 'ride', userId: USER_B.id, name: 'Bo', player: { id: USER_B.id, name: 'Bo' } });
    const st = await c.next((m) => hasRoster(m) && m.riders.length > 0);
    assert.deepEqual(st.riders.map((r) => [r.id, r.name]), [[USER_A.id, USER_A.name]]);
    assert.deepEqual(st.people.map((x) => x.id), [USER_A.id]);
    c.ws.close();
  } finally {
    await s.close();
  }
});

test('forged X-Forwarded-* and Host on the upgrade confer nothing', async () => {
  const s = await startApp();
  try {
    const r = await rawUpgrade(s.port, {
      headers: { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-User': USER_A.id, 'X-Discord-User-Id': USER_A.id },
    });
    assert.equal(r.statusLine, 'HTTP/1.1 401 Unauthorized');
    assert.equal(s.app.wss.clients.size, 0);
  } finally {
    await s.close();
  }
});

// Trails over real sockets. Cells are y * 64 + x; a direction is read from
// two heads in a row.
const SIZE = 64;
const CENTRE = (SIZE - 1) / 2;
const xy = (cell) => [cell % SIZE, Math.floor(cell / SIZE)];
const dirBetween = (from, to) => {
  const [x0, y0] = xy(from);
  const [x1, y1] = xy(to);
  return { '1,0': 'right', '-1,0': 'left', '0,1': 'down', '0,-1': 'up' }[`${x1 - x0},${y1 - y0}`] ?? null;
};
// The turn at right angles that points away from the centre (towards the
// nearest wall), or towards it.
function sideways(cy, away) {
  const [x, y] = xy(cy.pts.at(-1));
  const flip = (a, b) => (away ? a : b);
  if (cy.dir === 'left' || cy.dir === 'right') return y < CENTRE ? flip('up', 'down') : flip('down', 'up');
  return x < CENTRE ? flip('left', 'right') : flip('right', 'left');
}
// One rider's heads, tick by tick, from the spawn, while alive.
function headsOf(spawn, ticks, i) {
  const cells = [spawn];
  for (const m of ticks) if (m.h[i] >= 0) cells.push(m.h[i]);
  return cells;
}
// The direction of each move, and how often it changed from the spawn's.
function turnsIn(cells, spawnDir) {
  const dirs = cells.slice(1).map((c, k) => dirBetween(cells[k], c));
  assert.ok(dirs.every(Boolean), 'one cell a tick, never a jump');
  let turns = 0;
  dirs.forEach((d, k) => { if (d !== (k ? dirs[k - 1] : spawnDir)) turns += 1; });
  return { dirs, turns };
}
// Waits for a message without taking it out of the list, unlike next().
async function seen(c, match, ms = 3000) {
  const end = Date.now() + ms;
  while (!c.messages.some(match)) {
    if (Date.now() > end) throw new Error('no matching message in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('Trails over sockets: two riders play a round to a winner, a spectator watches every tick and cannot steer', async () => {
  const s = await startApp();
  try {
    const a = await player(s.wsUrl, USER_A);
    const b = await player(s.wsUrl, USER_B);
    const c = await player(s.wsUrl, USER_C);
    const joined = await c.next('state');
    assert.deepEqual([joined.phase, joined.size, joined.hz, joined.cycles.length], ['lobby', 64, 15, 0]);

    a.send({ t: 'ride' });
    b.send({ t: 'ride' });
    const set = await c.next((m) => m.t === 'state' && m.phase === 'countdown' && m.cycles.length === 2);
    assert.ok(set.ms > 0 && set.ms <= 3000);
    const ia = set.cycles.findIndex((cy) => cy.id === USER_A.id);
    const ib = set.cycles.findIndex((cy) => cy.id === USER_B.id);
    assert.deepEqual([set.cycles[ia].name, set.cycles[ib].name], ['Ana', 'Bo']);

    // C, watching, tries to steer both riders, naming them in the message.
    for (const d of ['up', 'left']) c.send({ t: 'turn', d, id: USER_A.id, userId: USER_B.id, i: ia });
    await b.next((m) => m.t === 'phase' && m.phase === 'play', 5000);
    for (const d of ['down', 'right']) c.send({ t: 'turn', d, id: USER_A.id, userId: USER_B.id, i: ia });
    // B turns towards the nearest wall; A rides straight on.
    b.send({ t: 'turn', d: sideways(set.cycles[ib], true) });

    const over = await c.next((m) => m.t === 'phase' && m.phase === 'results', 10_000);
    assert.equal(over.result.practice, false);
    assert.deepEqual(over.result.winner, { id: USER_A.id, name: 'Ana', c: set.cycles[ia].c });
    assert.equal(over.ms, 3000);

    // What the spectator saw: every tick, in order, each small.
    const ticks = c.messages.filter((m) => m.t === 'tick');
    assert.ok(ticks.length > 5, `${ticks.length} ticks`);
    assert.deepEqual(ticks.map((m) => m.n), ticks.map((_, k) => k + 1), 'no tick missing');
    for (const m of ticks) assert.ok(JSON.stringify(m).length < 1024);
    const ta = turnsIn(headsOf(set.cycles[ia].pts[0], ticks, ia), set.cycles[ia].dir);
    const tb = turnsIn(headsOf(set.cycles[ib].pts[0], ticks, ib), set.cycles[ib].dir);
    assert.equal(ta.turns, 0, 'nobody steered A: the spectator could not');
    assert.equal(tb.turns, 1, 'B turned once, as B asked');
    assert.deepEqual(ticks.at(-1).out, [ib]);
    assert.ok(ticks.slice(0, -1).every((m) => !m.out), 'nobody else went out');

    const board = await c.next((m) => m.t === 'roster' && m.scores.length > 0);
    assert.deepEqual(board.scores, [{ id: USER_A.id, name: 'Ana', wins: 1 }]);
    const next = await c.next((m) => m.t === 'state' && m.phase === 'countdown', 5000);
    assert.equal(next.cycles.length, 2, 'the next round sets itself up');
    assert.ok(!c.messages.some((m) => m.t === 'error'), 'no answer to the spectator');
    for (const p of [a, b, c]) p.ws.close();
  } finally {
    await s.close();
  }
});

test('a turn flood: one change of direction a tick at most, the socket closed at the limit, the round goes on', async () => {
  const s = await startApp();
  try {
    const a = await player(s.wsUrl, USER_A);
    const b = await player(s.wsUrl, USER_B);
    a.send({ t: 'ride' });
    b.send({ t: 'ride' });
    const set = await b.next((m) => m.t === 'state' && m.cycles.length === 2);
    const ia = set.cycles.findIndex((cy) => cy.id === USER_A.id);
    await seen(b, (m) => m.t === 'tick' && m.n === 2, 6000);
    const dirs = ['up', 'left', 'down', 'right'];
    for (let i = 0; i < 100; i += 1) a.send({ t: 'turn', d: dirs[i % 4] });
    assert.equal((await a.closed).code, 1008);
    // A's cycle rides on without its socket; B keeps getting ticks.
    await seen(b, (m) => (m.t === 'tick' && m.n >= 14) || (m.t === 'phase' && m.phase === 'results'), 3000);
    const ticks = b.messages.filter((m) => m.t === 'tick');
    const { turns } = turnsIn(headsOf(set.cycles[ia].pts[0], ticks, ia), set.cycles[ia].dir);
    // Two turns wait between ticks and the rest are dropped, so the 20 turns
    // let through before the close make 2 changes (4 if the burst straddles
    // a tick). Every run so far: 2.
    assert.ok(turns >= 1 && turns <= 4, `A changed direction ${turns} times after 100 turns`);
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
    assert.ok(s.logs.some((l) => l.startsWith('Closed a socket that sent more than 20 messages')));
    b.ws.close();
  } finally {
    await s.close();
  }
});

test('a rider whose socket drops rides on straight, and the same player takes it back on a new socket', async () => {
  const s = await startApp();
  try {
    let a = await player(s.wsUrl, USER_A);
    const b = await player(s.wsUrl, USER_B);
    a.send({ t: 'ride' });
    b.send({ t: 'ride' });
    const set = await b.next((m) => m.t === 'state' && m.cycles.length === 2);
    const ia = set.cycles.findIndex((cy) => cy.id === USER_A.id);
    await b.next((m) => m.t === 'phase' && m.phase === 'play', 5000);
    a.ws.close();
    await a.closed;
    await b.next((m) => m.t === 'roster' && m.riders.some((r) => r.id === USER_A.id && !r.here));
    await seen(b, (m) => m.t === 'tick' && m.n === 5);

    a = await player(s.wsUrl, USER_A);
    const back = await a.next('state');
    assert.equal(back.phase, 'play');
    assert.equal(back.cycles[ia].id, USER_A.id);
    assert.equal(back.cycles[ia].alive, true);
    const turn = sideways(back.cycles[ia], false);
    a.send({ t: 'turn', d: turn });
    await seen(b, (m) => m.t === 'tick' && m.n >= back.n + 4, 2000);
    const ticks = b.messages.filter((m) => m.t === 'tick');
    const { dirs } = turnsIn(headsOf(set.cycles[ia].pts[0], ticks, ia), set.cycles[ia].dir);
    const away = dirs.slice(0, back.n);
    assert.ok(away.every((d) => d === set.cycles[ia].dir), 'straight on while away');
    assert.equal(dirs.at(-1), turn, 'and steered again after coming back');
    a.ws.close();
    b.ws.close();
  } finally {
    await s.close();
  }
});

test('a room that fails is closed on its own: its sockets get 1011, other rooms play on', async () => {
  const s = await startApp();
  try {
    const a = await player(s.wsUrl, USER_A);
    const b = await player(s.wsUrl, USER_B, { instanceId: OTHER_INSTANCE });
    a.send({ t: 'ride' });
    b.send({ t: 'ride' });
    await a.next((m) => m.t === 'state' && m.phase === 'countdown');
    await b.next((m) => m.t === 'state' && m.phase === 'countdown');
    s.app.rooms.get(INSTANCE).step = () => {
      throw new Error('a bug in the game');
    };
    const closed = await a.closed;
    assert.deepEqual([closed.code, closed.reason], [1011, 'room error']);
    assert.ok(!s.app.rooms.has(INSTANCE), 'the failed room is gone');
    // The other room, on the same clock, plays on.
    await b.next((m) => m.t === 'phase' && m.phase === 'play', 5000);
    await b.next('tick', 1000);
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
    assert.deepEqual(s.logs.filter((l) => l.startsWith('A room failed')), ['A room failed with an internal error and was closed.']);
    // The same Activity instance gets a fresh room.
    const again = await player(s.wsUrl, USER_A);
    const fresh = await again.next('state');
    assert.deepEqual([fresh.phase, fresh.riders.length], ['lobby', 0]);
    again.ws.close();
    b.ws.close();
  } finally {
    await s.close();
  }
});

test('an oversized message closes that socket (1009) and the server stays up', async () => {
  const s = await startApp();
  try {
    const bystander = await player(s.wsUrl, USER_B);
    const a = await player(s.wsUrl, USER_A);
    a.send(JSON.stringify({ t: 'ride', pad: 'x'.repeat(LIMITS.maxMessageBytes) }));
    assert.equal((await a.closed).code, 1009);
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
    bystander.send({ t: 'ride' });
    await bystander.next(riding(USER_B));
    // Just under the limit is fine.
    const edge = await player(s.wsUrl, USER_C);
    const msg = JSON.stringify({ t: 'pong', pad: '' });
    edge.send(JSON.stringify({ t: 'pong', pad: 'x'.repeat(LIMITS.maxMessageBytes - msg.length) }));
    edge.send({ t: 'ride' });
    await edge.next(riding(USER_C));
    assert.equal(s.logs.filter((l) => l.startsWith('Closed a socket that sent a message over')).length, 1);
    bystander.ws.close();
    edge.ws.close();
  } finally {
    await s.close();
  }
});

test('more than 20 messages in a second closes that socket (1008) and the server stays up', async () => {
  const s = await startApp();
  try {
    const bystander = await player(s.wsUrl, USER_B);
    const steady = await player(s.wsUrl, USER_C);
    const a = await player(s.wsUrl, USER_A);
    for (let i = 0; i < 100; i += 1) a.send({ t: 'pong' });
    assert.equal((await a.closed).code, 1008);
    // 15 messages a second for two seconds is within the limit.
    for (let i = 0; i < 30; i += 1) {
      steady.send({ t: 'pong' });
      await new Promise((r) => setTimeout(r, 1000 / 15));
    }
    steady.send({ t: 'ride' });
    await steady.next(riding(USER_C));
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
    bystander.send({ t: 'ride' });
    await bystander.next(riding(USER_B));
    bystander.ws.close();
    steady.ws.close();
  } finally {
    await s.close();
  }
});

// Reads server frames from a raw socket and notes when a close frame arrives.
function watchCloseFrame(r) {
  const seen = { at: null, code: null };
  let pending = r.rest;
  const scan = () => {
    while (pending.length >= 2) {
      const len7 = pending[1] & 0x7f;
      const headerLen = len7 === 126 ? 4 : 2;
      if (pending.length < headerLen) return;
      const len = len7 === 126 ? pending.readUInt16BE(2) : len7;
      if (pending.length < headerLen + len) return;
      if (pending[0] === 0x88 && seen.at === null) {
        seen.at = Date.now();
        seen.code = pending.readUInt16BE(headerLen);
      }
      pending = pending.subarray(headerLen + len);
    }
  };
  r.sock.on('data', (d) => {
    pending = Buffer.concat([pending, d]);
    scan();
  });
  scan();
  return seen;
}

// When the server has let go of every socket (ws drops a socket from
// wss.clients only once its connection is gone), or 5 s.
async function released(s) {
  const deadline = Date.now() + 5000;
  while (s.app.wss.clients.size > 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 10));
  return Date.now();
}

test('a flooding peer that ignores the close frame is cut within 1.5 s of the 1008', async () => {
  const s = await startApp();
  try {
    const r = await rawUpgrade(s.port, { protocol: `activity-session, ${mint(USER_A)}`, allowHalfOpen: true });
    assert.equal(r.statusLine, 'HTTP/1.1 101 Switching Protocols');
    const seen = watchCloseFrame(r);
    r.sock.write(Buffer.concat(Array.from({ length: 100 }, () => frame('{"t":"pong"}')))); // and never answers the close
    const cutAt = await released(s);
    assert.equal(seen.code, 1008);
    assert.ok(cutAt - seen.at <= 1500, `released ${cutAt - seen.at} ms after the close frame`);
    r.sock.destroy();
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
  } finally {
    await s.close();
  }
});

test('an oversized frame from a peer that ignores the close is cut within 1.5 s too', async () => {
  const s = await startApp();
  try {
    const r = await rawUpgrade(s.port, { protocol: `activity-session, ${mint(USER_A)}`, allowHalfOpen: true });
    const seen = watchCloseFrame(r);
    // A frame header announcing 70,000 bytes: over the limit before any payload.
    const head = Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, 0, 1, 0x11, 0x70, 1, 2, 3, 4]);
    r.sock.write(head);
    const cutAt = await released(s);
    assert.equal(seen.code, 1009);
    assert.ok(cutAt - seen.at <= 1500, `released ${cutAt - seen.at} ms after the close frame`);
    r.sock.destroy();
  } finally {
    await s.close();
  }
});

test('binary and non-JSON messages close the socket', async () => {
  const s = await startApp();
  try {
    const a = await player(s.wsUrl, USER_A);
    a.ws.send(Buffer.from([1, 2, 3]));
    assert.equal((await a.closed).code, 1003);
    const b = await player(s.wsUrl, USER_B);
    b.send('{not json');
    assert.equal((await b.closed).code, 1007);
  } finally {
    await s.close();
  }
});

// A signed-in socket that the server refuses after the handshake.
async function refusedAfterHandshake(wsUrl, user, opts) {
  const c = connect(wsUrl, { protocols: signedIn(user, opts) });
  await c.open;
  return c.closed;
}

test('caps: sockets per player in a room, per room, and rooms', async () => {
  const s = await startApp({ limits: { maxSocketsPerRoom: 4, maxRooms: 2 } });
  try {
    const open = [];
    for (let i = 0; i < LIMITS.maxSocketsPerUserPerRoom; i += 1) open.push(await player(s.wsUrl, USER_A));
    const extra = await refusedAfterHandshake(s.wsUrl, USER_A);
    assert.deepEqual([extra.code, extra.reason], [4003, 'too many connections']);

    open.push(await player(s.wsUrl, USER_B)); // the room now holds 4
    const late = await refusedAfterHandshake(s.wsUrl, USER_C);
    assert.deepEqual([late.code, late.reason], [4003, 'room full']);

    open.push(await player(s.wsUrl, USER_C, { instanceId: OTHER_INSTANCE })); // second room
    const third = await refusedAfterHandshake(s.wsUrl, USER_C, { instanceId: 'i-third-room' });
    assert.deepEqual([third.code, third.reason], [4003, 'server full']);
    assert.equal(s.app.rooms.size, 2);
    for (const c of open) c.ws.close();
  } finally {
    await s.close();
  }
});

test('caps: at the room cap an empty room makes way; with none empty, "server full"', async () => {
  const s = await startApp({ limits: { maxRooms: 2 } });
  try {
    const first = [await player(s.wsUrl, USER_A, { instanceId: 'i-room-one' }), await player(s.wsUrl, USER_B, { instanceId: 'i-room-one' })];
    const second = await player(s.wsUrl, USER_C, { instanceId: 'i-room-two' });
    for (const c of first) {
      c.ws.close();
      await c.closed;
    }
    for (let i = 0; i < 50 && s.app.rooms.get('i-room-one')?.sockets.size; i += 1) await new Promise((r) => setTimeout(r, 10));
    const third = await player(s.wsUrl, USER_A, { instanceId: 'i-room-three' });
    assert.equal(third.welcome.you.id, USER_A.id);
    assert.equal(s.app.rooms.size, 2);
    assert.ok(!s.app.rooms.has('i-room-one'), 'the empty room was evicted');
    assert.ok(s.app.rooms.has('i-room-two') && s.app.rooms.has('i-room-three'));
    const fourth = await refusedAfterHandshake(s.wsUrl, USER_B, { instanceId: 'i-room-four' });
    assert.deepEqual([fourth.code, fourth.reason], [4003, 'server full']);
    assert.equal(s.app.rooms.size, 2);
    second.ws.close();
    third.ws.close();
  } finally {
    await s.close();
  }
});

test('caps: a player over the cap across rooms cannot create a room', async () => {
  const s = await startApp({ limits: { maxSocketsPerUser: 2 } });
  try {
    const one = await player(s.wsUrl, USER_A, { instanceId: 'i-room-one' });
    const two = await player(s.wsUrl, USER_A, { instanceId: 'i-room-two' });
    const three = await refusedAfterHandshake(s.wsUrl, USER_A, { instanceId: 'i-room-three' });
    assert.deepEqual([three.code, three.reason], [4003, 'too many connections']);
    assert.equal(s.app.rooms.size, 2, 'the refused socket created no room');
    assert.equal(s.app.perUser.get(USER_A.id), 2);
    // Another player is not affected, and a closed socket frees a slot.
    const other = await player(s.wsUrl, USER_B, { instanceId: 'i-room-three' });
    one.ws.close();
    await one.closed;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.app.perUser.get(USER_A.id), 1);
    const again = await player(s.wsUrl, USER_A, { instanceId: 'i-room-four' });
    for (const c of [two, other, again]) c.ws.close();
  } finally {
    await s.close();
  }
});

test('caps: all open sockets, checked before the socket is opened', async () => {
  const s = await startApp({ limits: { maxSockets: 3 } });
  try {
    const open = [await player(s.wsUrl, USER_A), await player(s.wsUrl, USER_B), await player(s.wsUrl, USER_C)];
    const refused = connect(s.wsUrl, { protocols: signedIn({ id: '444444444444444444', name: 'Di' }) });
    assert.equal((await refused.closed).status, 503);
    assert.equal(s.app.wss.clients.size, 3);
    assert.ok(s.logs.some((l) => l.startsWith('Connection limit reached')));
    for (const c of open) c.ws.close();
  } finally {
    await s.close();
  }
});

test('the server pings every interval and drops a socket that stops answering', async () => {
  const s = await startApp({ limits: { pingIntervalMs: 200, idleTimeoutMs: 700 } });
  try {
    const answering = await player(s.wsUrl, USER_A);
    answering.ws.on('message', (d) => {
      if (JSON.parse(d.toString()).t === 'ping') answering.send({ t: 'pong' });
    });
    const silent = await player(s.wsUrl, USER_B);
    await silent.next('ping', 1000);
    const closed = await silent.closed;
    assert.equal(closed.code, 1006, 'terminated without a close frame');
    assert.equal(answering.ws.readyState, answering.ws.OPEN);
    answering.ws.close();
  } finally {
    await s.close();
  }
});

test('the defaults', () => {
  assert.equal(LIMITS.pingIntervalMs, 25_000);
  assert.equal(LIMITS.maxMessageBytes, 4096);
  assert.equal(LIMITS.maxMessagesPerSecond, 20);
  assert.equal(LIMITS.sessionTtlMs, 15 * 60 * 1000);
  assert.equal(LIMITS.maxSocketsPerUser, 6);
  assert.equal(LIMITS.closeGraceMs, 1000);
  assert.equal(LIMITS.tokenGlobalBurst, 120);
  assert.equal(LIMITS.tokenGlobalPerSecond, 2);
});

test('shutdown closes every socket with 1001', async () => {
  const s = await startApp();
  const a = await player(s.wsUrl, USER_A);
  const b = await player(s.wsUrl, USER_B);
  const t0 = Date.now();
  await s.close();
  assert.equal((await a.closed).code, 1001);
  assert.equal((await b.closed).code, 1001);
  assert.ok(Date.now() - t0 < 3000);
});

test('no secret, token or code in any log line of this file', () => {
  assert.ok(SECRET && allLogs.length > 0);
  assertNoSensitive(allLogs, assert);
});
