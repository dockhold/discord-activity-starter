// Activity load for the resource measurement in the verification record:
// 20 signed-in sockets in 3 rooms (7, 7 and 6), all riding Trails round after
// round for the whole run. Each rider rebuilds the board from the server's
// messages, as a page does, turns at random now and then, and steers away
// from a wall or trail just ahead, so rounds last like real ones. It answers
// the server's pings, and checks every tick against its own copy of the
// board. Runs inside a container made from the image, like tests/probe.mjs.
//
// Usage: node /load.mjs <base url> <seconds> [rooms riders]   (needs SMOKE_SECRET)
// With rooms and riders given, it rides that many rooms of that many riders
// instead of the 7, 7 and 6 above.

import { createRequire } from 'node:module';

const require = createRequire('/app/server/package.json');
const WebSocket = require('ws');
const { deriveSessionKey, signSession } = await import('/app/server/src/session.js');

const [base, seconds = '600', roomCount, riderCount] = process.argv.slice(2);
const key = deriveSessionKey(process.env.SMOKE_SECRET, '123456789012345678');
const ROOMS = roomCount ? Array(Number(roomCount)).fill(Number(riderCount)) : [7, 7, 6];
const SIZE = 64;
const STEP = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const stats = { rounds: 0, wins: 0, practice: 0, ticks: 0, turns: 0, messages: 0, bytes: 0, maxTickBytes: 0, errors: 0, closes: 0, desyncs: 0, maxTickGapMs: 0 };
const rates = []; // ticks a second during play, one per round, as a room's first rider saw them

function rider(i, room) {
  const user = { id: String(100000000000000000n + BigInt(i)), name: `Rider ${i}` };
  const { token } = signSession(key, { userId: user.id, name: user.name, instanceId: `i-load-room-${room}` }, Date.now(), 15 * 60 * 1000);
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, ['activity-session', token]);
  const r = { ws, user, grid: new Uint8Array(SIZE * SIZE), cycles: [], phase: 'lobby' };
  ws.on('open', () => ws.send('{"t":"ride"}'));
  ws.on('message', (d) => {
    stats.messages += 1;
    stats.bytes += d.length;
    const m = JSON.parse(d.toString());
    if (m.t === 'ping') ws.send('{"t":"pong"}');
    else if (m.t === 'error') stats.errors += 1;
    else if (m.t === 'state') load(r, m);
    else if (m.t === 'phase') {
      r.phase = m.phase;
      if (m.phase === 'results' && r.leader) {
        stats.rounds += 1;
        if (r.firstAt && r.lastN > 30) rates.push(((r.lastN - 1) * 1000) / (r.lastAt - r.firstAt));
        r.firstAt = 0;
        if (m.result.practice) stats.practice += 1;
        else if (m.result.winner) stats.wins += 1;
      }
    } else if (m.t === 'tick') tick(r, m, d.length);
  });
  ws.on('close', () => { stats.closes += 1; });
  ws.on('error', () => {});
  return r;
}

// The board from a full state: every trail from its corners.
function load(r, m) {
  r.phase = m.phase;
  r.grid.fill(0);
  r.cycles = m.cycles.map((cy, i) => {
    const p = cy.pts;
    let [x, y] = [p[0] % SIZE, Math.floor(p[0] / SIZE)];
    r.grid[p[0]] = i + 1;
    for (let k = 1; k < p.length; k += 1) {
      const [tx, ty] = [p[k] % SIZE, Math.floor(p[k] / SIZE)];
      while (x !== tx || y !== ty) {
        x += Math.sign(tx - x);
        y += Math.sign(ty - y);
        r.grid[y * SIZE + x] = i + 1;
      }
    }
    return { id: cy.id, x, y, dir: cy.dir, alive: cy.alive };
  });
}

function free(r, x, y) {
  return x >= 0 && y >= 0 && x < SIZE && y < SIZE && !r.grid[y * SIZE + x];
}

function tick(r, m, bytes) {
  if (r.leader) {
    const now = performance.now();
    stats.ticks += 1;
    stats.maxTickBytes = Math.max(stats.maxTickBytes, bytes);
    if (m.n === 1) r.firstAt = now;
    else if (r.firstAt) stats.maxTickGapMs = Math.max(stats.maxTickGapMs, Math.round(now - r.lastAt));
    r.lastAt = now;
    r.lastN = m.n;
  }
  m.h.forEach((cell, i) => {
    const cy = r.cycles[i];
    if (!cy || cell < 0) return;
    const x = cell % SIZE;
    const y = Math.floor(cell / SIZE);
    const dx = x - cy.x;
    const dy = y - cy.y;
    if (Math.abs(dx) + Math.abs(dy) !== 1 || r.grid[cell]) stats.desyncs += 1;
    cy.dir = dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'down' : 'up';
    cy.x = x;
    cy.y = y;
    r.grid[cell] = i + 1;
  });
  for (const i of m.out ?? []) if (r.cycles[i]) r.cycles[i].alive = false;
  const me = r.cycles.find((cy) => cy.id === r.user.id);
  if (!me?.alive) return;
  const [dx, dy] = STEP[me.dir];
  const sides = me.dir === 'up' || me.dir === 'down' ? ['left', 'right'] : ['up', 'down'];
  const blocked = !free(r, me.x + dx, me.y + dy) || !free(r, me.x + 2 * dx, me.y + 2 * dy);
  if (blocked || Math.random() < 0.06) {
    const open = sides.filter((d) => free(r, me.x + STEP[d][0], me.y + STEP[d][1]));
    if (open.length) {
      r.ws.send(JSON.stringify({ t: 'turn', d: open[Math.floor(Math.random() * open.length)] }));
      stats.turns += 1;
    }
  }
}

const riders = [];
let n = 0;
ROOMS.forEach((count, room) => {
  for (let k = 0; k < count; k += 1) {
    const r = rider(n, room);
    r.leader = k === 0; // one rider per room counts rounds and ticks
    riders.push(r);
    n += 1;
  }
});

const started = Date.now();
const report = (final) => console.log(JSON.stringify({
  final,
  seconds: Math.round((Date.now() - started) / 1000),
  ...stats,
  playHz: rates.length ? { rounds: rates.length, min: +Math.min(...rates).toFixed(2), mean: +(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(2) } : null,
  open: riders.filter((r) => r.ws.readyState === WebSocket.OPEN).length,
}));
setInterval(() => report(false), 60_000).unref();
setTimeout(() => {
  report(true);
  process.exit(0);
}, Number(seconds) * 1000);
