// Synthetic benchmark of the game loop, in one process, no sockets: many
// rooms of eight riders, every room stepped each tick the way the server's
// clock does it, and each message serialised once, as its broadcast does.
// Only that server work is timed; the riders' own decisions (turn at random
// now and then, avoid a wall or trail just ahead) are not.
//
// Usage: node tests/bench.mjs [rooms] [riders] [game seconds] [realtime]
//   default 200 rooms, 8 riders, 120 game seconds, as fast as it can.
//   With "realtime" it runs the ticks on a 15-a-second timer instead and
//   reports the rate it kept and the CPU the whole process used.
// Runs from the repository (node tests/bench.mjs) or inside the image
// (node /bench.mjs, with the file mounted there).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const local = new URL('../server/src/game.js', import.meta.url);
const { HZ, Room, SIZE } = await import(existsSync(fileURLToPath(local)) ? local.href : '/app/server/src/game.js');

const [roomCount = 200, riderCount = 8, gameSeconds = 120] = process.argv.slice(2, 5).map(Number);
const realtime = process.argv.includes('realtime');
const STEP = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

global.gc?.();
const before = process.memoryUsage();
const rooms = [];
for (let r = 0; r < roomCount; r += 1) {
  const room = new Room(`i-bench-${r}`);
  const players = [];
  for (let k = 0; k < riderCount; k += 1) {
    const p = { id: String(100000000000000000n + BigInt(r * 100 + k)), name: `Rider ${r}-${k}` };
    room.sockets.add({ player: p });
    players.push(p);
  }
  room.presenceChanged();
  for (const p of players) room.ride(p);
  rooms.push({ room, players });
}

let seed = 42;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const free = (room, x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE && !room.grid[y * SIZE + x];
function decide({ room, players }) {
  if (room.phase !== 'play') return;
  for (const p of players) {
    const cy = room.cycleOf(p.id);
    if (!cy?.alive) continue;
    const [dx, dy] = STEP[cy.dir];
    const blocked = !free(room, cy.x + dx, cy.y + dy) || !free(room, cy.x + 2 * dx, cy.y + 2 * dy);
    if (blocked || random() < 0.06) {
      const sides = cy.dir === 'up' || cy.dir === 'down' ? ['left', 'right'] : ['up', 'down'];
      const open = sides.filter((d) => free(room, cy.x + STEP[d][0], cy.y + STEP[d][1]));
      if (open.length) room.turn(p, open[Math.floor(random() * open.length)]);
    }
  }
}

const tickMs = [];
let playSteps = 0;
let playStepMs = 0;
let bytes = 0;
let messages = 0;
let biggestTick = 0;
let rounds = 0;
function tick() {
  for (const r of rooms) decide(r);
  const t0 = performance.now();
  for (const { room } of rooms) {
    const inPlay = room.phase === 'play';
    const s0 = inPlay ? performance.now() : 0;
    for (const msg of room.step()) {
      const data = JSON.stringify(msg);
      bytes += data.length;
      messages += 1;
      if (msg.t === 'tick') biggestTick = Math.max(biggestTick, data.length);
      if (msg.t === 'phase' && msg.phase === 'results') rounds += 1;
    }
    if (inPlay) {
      playSteps += 1;
      playStepMs += performance.now() - s0;
    }
  }
  tickMs.push(performance.now() - t0);
}

const ticks = gameSeconds * HZ;
const cpu0 = process.cpuUsage();
const wall0 = performance.now();
if (realtime) {
  const period = 1000 / HZ;
  let next = performance.now() + period;
  await new Promise((resolve) => {
    const run = () => {
      tick();
      if (tickMs.length >= ticks) return resolve();
      const t = performance.now();
      next = Math.max(next + period, t);
      setTimeout(run, next - t);
    };
    setTimeout(run, period);
  });
} else {
  for (let i = 0; i < ticks; i += 1) tick();
}
const wall = performance.now() - wall0;
const cpu = process.cpuUsage(cpu0);
const after = process.memoryUsage();

const sorted = [...tickMs].sort((a, b) => a - b);
const mean = tickMs.reduce((a, b) => a + b, 0) / tickMs.length;
const pct = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
console.log(JSON.stringify({
  node: process.version,
  rooms: roomCount,
  riders: roomCount * riderCount,
  gameSeconds,
  mode: realtime ? 'realtime' : 'synthetic',
  rounds,
  roomStepsInPlay: playSteps,
  perTickAllRoomsMs: { mean: +mean.toFixed(3), p50: +pct(0.5).toFixed(3), p99: +pct(0.99).toFixed(3), max: +sorted.at(-1).toFixed(3) },
  perRoomStepInPlayUs: +((playStepMs / Math.max(1, playSteps)) * 1000).toFixed(2),
  serverShareOfOneCoreAt15Hz: `${((mean * HZ) / 10).toFixed(2)}%`,
  achievedHz: +((tickMs.length / wall) * 1000).toFixed(2),
  processCpuOverWall: `${(((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(1)}%`,
  messagesPerSecond: Math.round((messages / tickMs.length) * HZ),
  bytesPerSecondPerRoom: Math.round((bytes / tickMs.length / roomCount) * HZ),
  biggestTickBytes: biggestTick,
  memory: { rssBefore: mb(before.rss), rssAfter: mb(after.rss), heapBefore: mb(before.heapUsed), heapAfter: mb(after.heapUsed) },
}, null, 1));
