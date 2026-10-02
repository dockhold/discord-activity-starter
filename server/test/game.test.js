// Trails, the game, without sockets: the rules, the round, spawns and what
// the room sends. Every case steps the room by hand, so nothing waits.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AWAY_TICKS, COUNTDOWN_TICKS, HZ, MAX_QUEUED_TURNS, MAX_RIDERS, RESULTS_TICKS, Room, SIZE, msOf, spawnPoints,
} from '../src/game.js';

const user = (n, name = `Rider ${n}`) => ({ id: String(100000000000000000n + BigInt(n)), name });
const A = user(1, 'Ana');
const B = user(2, 'Bo');
const C = user(3, 'Cy');
const D = user(4, 'Di');
const cellOf = (x, y) => y * SIZE + x;
const xy = (cell) => [cell % SIZE, Math.floor(cell / SIZE)];

// A room with one socket per player, as the server builds it.
function roomWith(...players) {
  const room = new Room('i-test');
  for (const p of players) room.sockets.add({ player: p });
  room.presenceChanged();
  return room;
}

function steps(room, n) {
  const msgs = [];
  for (let i = 0; i < n; i += 1) msgs.push(...room.step());
  return msgs;
}

// Steps until `done(room)` or `max` ticks; returns every message sent.
function until(room, done, max = 10_000) {
  const msgs = [];
  for (let i = 0; i < max && !done(room); i += 1) msgs.push(...room.step());
  assert.ok(done(room), 'the room reached the expected point');
  return msgs;
}

// Puts riders at exact spots and starts play: [player, x, y, dir] each.
function arena(room, specs) {
  for (const [p] of specs) room.ride(p);
  room.step(); // lobby to countdown
  room.spawn(specs.map(([p]) => room.riders.get(p.id)), specs.map(([, x, y, dir]) => ({ x, y, dir })));
  room.phase = 'play';
  room.left = 0;
  return room;
}

const head = (room, p) => {
  const cy = room.cycleOf(p.id);
  return [cy.x, cy.y];
};
const ticks = (msgs) => msgs.filter((m) => m.t === 'tick');
const results = (msgs) => msgs.find((m) => m.t === 'phase' && m.phase === 'results');

test('collisions: each wall ends a ride', () => {
  for (const [x, y, dir] of [[0, 30, 'left'], [63, 30, 'right'], [30, 0, 'up'], [30, 63, 'down']]) {
    const room = arena(roomWith(A, B, C), [[A, x, y, dir], [B, 10, 10, 'down'], [C, 50, 50, 'up']]);
    const msgs = room.step();
    assert.deepEqual(ticks(msgs)[0].out, [0], `the ${dir} wall`);
    assert.equal(room.cycleOf(A.id).alive, false);
    assert.deepEqual(head(room, A), [x, y], 'a crashed cycle does not move into the wall');
    assert.equal(room.phase, 'play', 'two riders left: the round goes on');
  }
});

test('collisions: a rider\'s own trail ends the ride', () => {
  const room = arena(roomWith(A, B), [[A, 10, 10, 'right'], [B, 40, 40, 'up']]);
  for (const d of ['down', 'left', 'up']) {
    room.turn(A, d);
    room.step();
    assert.ok(room.cycleOf(A.id).alive, `still riding after turning ${d}`);
  }
  assert.deepEqual(head(room, A), [9, 10]);
  room.turn(A, 'right');
  const msgs = room.step();
  assert.deepEqual(ticks(msgs)[0].out, [0], 'turned back into its own first cell');
  assert.equal(results(msgs).result.winner.id, B.id);
});

test('collisions: another rider\'s trail ends the ride, and the trail stays for the round', () => {
  const room = arena(roomWith(A, B, C), [[A, 10, 20, 'right'], [B, 14, 18, 'down'], [C, 50, 50, 'up']]);
  // B crosses A's row first: down from (14,18) through (14,20) and on.
  steps(room, 3);
  assert.deepEqual(head(room, B), [14, 21]);
  assert.deepEqual(head(room, A), [13, 20]);
  const msgs = room.step(); // A moves into (14,20), which B's trail holds
  assert.deepEqual(ticks(msgs)[0].out, [0]);
  assert.equal(room.grid[cellOf(14, 20)], 2, 'B\'s trail is still on the board');
  assert.equal(room.grid[cellOf(13, 20)], 1, 'A\'s trail stays after A is out');
  steps(room, 5);
  assert.equal(room.grid[cellOf(10, 20)], 1, 'and is still there five ticks later');
});

test('collisions: two heads entering one cell are both out', () => {
  const room = arena(roomWith(A, B, C), [[A, 10, 10, 'right'], [B, 12, 10, 'left'], [C, 50, 50, 'up']]);
  const msgs = room.step();
  assert.deepEqual(ticks(msgs)[0].out, [0, 1]);
  assert.equal(room.grid[cellOf(11, 10)], 0, 'nobody took the cell');
  assert.equal(results(msgs).result.winner.id, C.id, 'the third rider wins');
});

test('collisions: three heads entering one cell are all out', () => {
  const room = arena(roomWith(A, B, C, D), [[A, 10, 10, 'right'], [B, 12, 10, 'left'], [C, 11, 9, 'down'], [D, 50, 50, 'up']]);
  const msgs = room.step();
  assert.deepEqual(ticks(msgs)[0].out, [0, 1, 2]);
  assert.equal(room.grid[cellOf(11, 10)], 0, 'nobody took the cell');
  assert.equal(results(msgs).result.winner.id, D.id, 'the fourth rider wins');
});

test('collisions: two heads swapping cells are both out', () => {
  const room = arena(roomWith(A, B), [[A, 10, 10, 'right'], [B, 11, 10, 'left']]);
  const msgs = room.step();
  assert.deepEqual(ticks(msgs)[0].out, [0, 1]);
  const r = results(msgs).result;
  assert.deepEqual([r.practice, r.winner], [false, null], 'nobody left: no winner');
});

test('collisions: the order of riders in the list does not matter', () => {
  // A's next cell is where B's head is now. B moves away in the same tick,
  // but its head stays as trail, so A is out whichever way round they are.
  for (const order of [[A, B], [B, A]]) {
    const at = new Map([[A.id, [10, 10, 'right']], [B.id, [11, 10, 'down']]]);
    const room = arena(roomWith(A, B, C), [...order.map((p) => [p, ...at.get(p.id)]), [C, 50, 50, 'up']]);
    room.step();
    assert.equal(room.cycleOf(A.id).alive, false);
    assert.equal(room.cycleOf(B.id).alive, true);
  }
});

test('turns: a reversal, the same direction and unknown directions are ignored', () => {
  const room = arena(roomWith(A, B), [[A, 10, 10, 'right'], [B, 40, 40, 'up']]);
  for (const d of ['left', 'right', 'north', 'UP', '', '__proto__', 'constructor', 'toString', 5, null, undefined, {}, ['up']]) room.turn(A, d);
  assert.deepEqual(room.cycleOf(A.id).queue, []);
  room.step();
  assert.deepEqual(head(room, A), [11, 10]);
  assert.equal(room.cycleOf(A.id).alive, true);
});

test('turns: two buffered between ticks, so a quick double turn works; a third is dropped', () => {
  const room = arena(roomWith(A, B), [[A, 10, 10, 'right'], [B, 40, 40, 'up']]);
  room.turn(A, 'up');
  room.turn(A, 'left'); // a reversal of "right", but not of "up": allowed second
  room.turn(A, 'down'); // dropped: two already waiting
  assert.equal(MAX_QUEUED_TURNS, 2);
  assert.deepEqual(room.cycleOf(A.id).queue, ['up', 'left']);
  room.step();
  assert.deepEqual(head(room, A), [10, 9]);
  room.step();
  assert.deepEqual(head(room, A), [9, 9]);
  room.step();
  assert.deepEqual(head(room, A), [8, 9], 'the third turn never happened');
  assert.equal(room.cycleOf(A.id).alive, true);
});

test('turns: a flood of 100 turns a tick changes at most one direction per move', () => {
  const room = arena(roomWith(A, B), [[A, 32, 32, 'right'], [B, 5, 5, 'down']]);
  const dirs = ['up', 'down', 'left', 'right'];
  let prev = head(room, A);
  let prevStep = null;
  for (let t = 0; t < 40 && room.cycleOf(A.id).alive; t += 1) {
    for (let i = 0; i < 100; i += 1) room.turn(A, dirs[(i * 7 + t) % 4]);
    assert.ok(room.cycleOf(A.id).queue.length <= 2);
    room.step();
    if (!room.cycleOf(A.id).alive) break;
    const now = head(room, A);
    const stepNow = [now[0] - prev[0], now[1] - prev[1]];
    assert.equal(Math.abs(stepNow[0]) + Math.abs(stepNow[1]), 1, 'one cell a tick');
    if (prevStep) assert.ok(!(stepNow[0] === -prevStep[0] && stepNow[1] === -prevStep[1]), 'never straight back');
    prev = now;
    prevStep = stepNow;
  }
});

test('turns: a player without a cycle changes nothing, and nobody steers another rider', () => {
  const room = arena(roomWith(A, B, C), [[A, 10, 10, 'right'], [B, 40, 40, 'up']]);
  room.turn(C, 'down'); // watching
  room.turn(A, 'down'); // A's own
  assert.deepEqual(room.cycleOf(B.id).queue, []);
  room.step();
  assert.deepEqual(head(room, A), [10, 11]);
  assert.deepEqual(head(room, B), [40, 39], 'B went straight on');
  // Turns outside a round are ignored too.
  const lobby = roomWith(A);
  lobby.turn(A, 'up');
  assert.equal(lobby.cycles.length, 0);
});

test('spawns: 1 to 8 riders, on the ring, evenly spaced, facing clockwise, never adjacent', () => {
  const centre = (SIZE - 1) / 2;
  const step = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  for (let n = 1; n <= MAX_RIDERS; n += 1) {
    for (let rotate = 0; rotate < n + 2; rotate += 1) {
      const grid = new Uint8Array(SIZE * SIZE);
      const pts = spawnPoints(n, grid, rotate);
      assert.equal(pts.length, n);
      const cells = new Set();
      const angles = [];
      for (const p of pts) {
        const [dx, dy] = step[p.dir];
        const rx = p.x - centre;
        const ry = p.y - centre;
        assert.ok(p.x >= 0 && p.y >= 0 && p.x < SIZE && p.y < SIZE);
        assert.ok(Math.abs(Math.hypot(rx, ry) - 20) < 1.5, `on the ring: ${n} riders, ${JSON.stringify(p)}`);
        assert.ok(dx * -ry + dy * rx > 0, `clockwise: ${n} riders, ${JSON.stringify(p)}`);
        const nx = p.x + dx;
        const ny = p.y + dy;
        assert.ok(nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE, 'the first move stays on the board');
        cells.add(cellOf(p.x, p.y)).add(cellOf(nx, ny));
        angles.push(Math.atan2(ry, rx));
      }
      assert.equal(cells.size, 2 * n, 'spawns and first moves are all different cells');
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          assert.ok(Math.max(Math.abs(pts[i].x - pts[j].x), Math.abs(pts[i].y - pts[j].y)) >= 2, 'not adjacent');
        }
      }
      angles.sort((a, b) => a - b);
      for (let i = 1; i < n; i += 1) assert.ok(Math.abs(angles[i] - angles[i - 1] - (2 * Math.PI) / n) < 0.12, 'evenly spaced');
    }
  }
});

test('spawns: never on a trail, and not facing one', () => {
  // A trail on the ring itself, and one across the top: spawns move off both.
  const centre = (SIZE - 1) / 2;
  for (let n = 1; n <= MAX_RIDERS; n += 1) {
    const grid = new Uint8Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        if (Math.abs(Math.hypot(x - centre, y - centre) - 20) < 0.75 || y === 11) grid[cellOf(x, y)] = 9;
      }
    }
    const pts = spawnPoints(n, grid, 0);
    assert.equal(pts.length, n);
    const step = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    for (const p of pts) {
      assert.equal(grid[cellOf(p.x, p.y)], 0, 'not on a trail');
      assert.equal(grid[cellOf(p.x + step[p.dir][0], p.y + step[p.dir][1])], 0, 'not facing a trail');
    }
  }
  // With no room at all, there is no spawn rather than a bad one.
  assert.equal(spawnPoints(2, new Uint8Array(SIZE * SIZE).fill(1), 0), null);
});

test('a round: lobby, a countdown once someone rides, play, results, and the next countdown', () => {
  const room = roomWith(A, B, C);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.busy(), true, 'the roster still has to go out');
  steps(room, 1);
  assert.equal(room.busy(), false, 'nobody riding: the clock can stop');
  room.ride(A);
  room.ride(B);
  let msgs = room.step();
  const state = msgs.find((m) => m.t === 'state');
  assert.equal(state.phase, 'countdown');
  assert.equal(state.ms, 3000);
  assert.deepEqual(state.cycles.map((cy) => [cy.name, cy.pts.length, cy.alive]), [['Ana', 1, true], ['Bo', 1, true]]);
  assert.deepEqual(state.riders.map((r) => r.name), ['Ana', 'Bo']);
  steps(room, COUNTDOWN_TICKS - 1);
  assert.equal(room.phase, 'countdown');
  msgs = room.step();
  assert.deepEqual(msgs, [{ t: 'phase', phase: 'play', ms: 0 }], `play starts ${COUNTDOWN_TICKS} ticks (3 s) into the countdown`);
  // Nobody steers: both ride straight into a wall.
  msgs = until(room, (r) => r.phase === 'results');
  const over = results(msgs);
  assert.ok(over.result.winner, 'one of two outlasted the other');
  assert.equal(over.ms, 3000);
  assert.equal(room.wins.get(over.result.winner.id).wins, 1);
  msgs = steps(room, RESULTS_TICKS - 1);
  assert.equal(room.phase, 'results');
  msgs = room.step();
  assert.equal(room.phase, 'countdown', 'the next round sets itself up');
  assert.equal(msgs.find((m) => m.t === 'state').cycles.length, 2);
  // Everyone stops riding: back to the lobby, and the clock can stop.
  room.watch(A);
  room.watch(B);
  msgs = room.step();
  assert.equal(room.phase, 'lobby');
  assert.equal(msgs.find((m) => m.t === 'state').cycles.length, 0);
  assert.equal(room.busy(), false);
});

test('a round of two or more ends when one is left; the scoreboard counts wins per user', () => {
  const room = roomWith(A, B, C);
  // Three riders ride down; the loser turns left and crashes into a trail or
  // the wall long before the others reach the bottom.
  const play = (loser) => {
    arena(room, [[A, 10, 30, 'down'], [B, 30, 30, 'down'], [C, 50, 30, 'down']]);
    room.turn(loser, 'left');
    until(room, (r) => !r.cycleOf(loser.id).alive);
  };
  play(A);
  assert.equal(room.phase, 'play', 'one out, two still riding: no result yet');
  room.watch(B); // B gives up: C is the last one riding
  let msgs = room.step();
  assert.deepEqual(ticks(msgs)[0].out, [1]);
  assert.equal(results(msgs).result.winner.id, C.id);
  room.ride(B);
  play(B);
  room.watch(A);
  room.step();
  room.ride(A);
  assert.deepEqual(room.roster().scores, [{ id: C.id, name: 'Cy', wins: 2 }]);
  play(C);
  room.watch(B);
  msgs = room.step();
  assert.equal(results(msgs).result.winner.id, A.id);
  assert.deepEqual(room.roster().scores.map((s) => [s.name, s.wins]), [['Cy', 2], ['Ana', 1]]);
});

test('practice: a solo round ends when its rider is out, shows the time, counts no win', () => {
  const room = roomWith(A, B);
  room.ride(A);
  let msgs = until(room, (r) => r.phase === 'play');
  assert.equal(msgs.find((m) => m.t === 'state').cycles.length, 1);
  msgs = until(room, (r) => r.phase === 'results');
  const over = results(msgs);
  assert.equal(over.result.practice, true);
  assert.equal(over.result.rider.id, A.id);
  assert.equal(over.result.ms, msOf(room.n));
  assert.ok(room.n > 20, `rode ${room.n} ticks straight into a wall`);
  assert.equal(room.wins.size, 0, 'practice counts no win');
  steps(room, RESULTS_TICKS);
  assert.equal(room.phase, 'countdown', 'and goes again while the rider stays');
});

test('a rider who joins in the middle of a round waits for the next one', () => {
  const room = arena(roomWith(A, B, C), [[A, 10, 30, 'down'], [B, 50, 30, 'up']]);
  assert.equal(room.ride(C), null);
  room.step();
  assert.equal(room.cycleOf(C.id), null);
  room.turn(C, 'left');
  assert.deepEqual(room.roster().riders.map((r) => r.name), ['Ana', 'Bo', 'Cy']);
  until(room, (r) => r.phase === 'countdown');
  assert.deepEqual(room.cycles.map((cy) => cy.name), ['Ana', 'Bo', 'Cy']);
});

test('a countdown respawns when riders change, and leaves at least a second', () => {
  const room = roomWith(A, B);
  room.ride(A);
  steps(room, COUNTDOWN_TICKS - 5);
  room.ride(B);
  const msgs = room.step();
  const state = msgs.find((m) => m.t === 'state');
  assert.equal(state.cycles.length, 2);
  assert.equal(state.ms, 1000);
  assert.equal(room.phase, 'countdown');
});

test('a countdown is extended once at most: toggling riders cannot hold it open', () => {
  const room = roomWith(A, B);
  room.ride(A);
  room.ride(B);
  room.step(); // the countdown starts with both
  let i = 0;
  for (; i < COUNTDOWN_TICKS + HZ && room.phase === 'countdown'; i += 1) {
    if (i % 10 === 9) {
      if (room.riders.has(B.id)) room.watch(B);
      else room.ride(B);
    }
    room.step();
  }
  assert.equal(room.phase, 'play', `still counting down after ${i} ticks`);
});

test('a rider whose socket closes rides on straight, and takes control again on return', () => {
  const room = arena(roomWith(A, B), [[A, 10, 10, 'right'], [B, 50, 50, 'up']]);
  const sockA = [...room.sockets].find((ws) => ws.player.id === A.id);
  room.sockets.delete(sockA);
  room.presenceChanged();
  steps(room, 5);
  assert.deepEqual(head(room, A), [15, 10], 'kept going without a pause');
  assert.equal(room.roster().riders.find((r) => r.id === A.id).here, false);
  room.sockets.add({ player: A }); // back, on a new socket
  room.presenceChanged();
  room.turn(A, 'down');
  room.step();
  assert.deepEqual(head(room, A), [15, 11]);
  assert.equal(room.roster().riders.find((r) => r.id === A.id).here, true);
});

test('a rider away for 30 seconds loses their place; one back in time keeps it', () => {
  const room = roomWith(A, B);
  room.ride(A);
  room.ride(B);
  room.step();
  const leave = (p) => {
    for (const ws of room.sockets) if (ws.player.id === p.id) room.sockets.delete(ws);
    room.presenceChanged();
  };
  leave(A);
  steps(room, 200);
  room.sockets.add({ player: A });
  room.presenceChanged();
  steps(room, AWAY_TICKS);
  assert.ok(room.riders.has(A.id), 'back after 13 s: still riding');
  leave(B);
  steps(room, AWAY_TICKS - 1);
  assert.ok(room.riders.has(B.id), 'not yet');
  const msgs = room.step();
  assert.ok(!room.riders.has(B.id), `gone after ${AWAY_TICKS / HZ} s`);
  const roster = msgs.find((m) => m.t === 'roster' || m.t === 'state');
  assert.deepEqual(roster.riders.map((r) => r.id), [A.id]);
  // The last rider gone too: the room stops ticking once it is back in the lobby.
  leave(A);
  until(room, (r) => !r.busy());
  assert.equal(room.phase, 'lobby');
});

test('watching in the middle of a round takes that rider out', () => {
  const room = arena(roomWith(A, B, C), [[A, 10, 30, 'down'], [B, 30, 30, 'down'], [C, 50, 30, 'down']]);
  room.step();
  assert.equal(room.watch(B), true);
  assert.equal(room.watch(B), false, 'already watching');
  const msgs = room.step();
  assert.deepEqual(ticks(msgs)[0].out, [1]);
  assert.equal(ticks(msgs)[0].h[1], -1);
  assert.equal(room.phase, 'play', 'two left');
  assert.equal(room.grid[cellOf(30, 31)], 2, 'B\'s trail stays');
});

test('eight riders at most, each with their own colour', () => {
  const players = Array.from({ length: 9 }, (_, i) => user(10 + i));
  const room = roomWith(...players);
  for (const p of players.slice(0, 8)) assert.equal(room.ride(p), null);
  assert.equal(room.ride(players[8]), 'The arena is full. Watch this one.');
  assert.equal(room.riders.size, 8);
  assert.deepEqual([...room.riders.values()].map((r) => r.c), [0, 1, 2, 3, 4, 5, 6, 7]);
  room.watch(players[3]);
  assert.equal(room.ride(players[8]), null);
  assert.equal(room.riders.get(players[8].id).c, 3, 'takes the colour that came free');
});

test('a tick with eight riders is well under 1 KB, and only heads and who went out travel', () => {
  const players = Array.from({ length: 8 }, (_, i) => user(20 + i, 'x'.repeat(64)));
  const room = roomWith(...players);
  for (const p of players) room.ride(p);
  until(room, (r) => r.phase === 'play');
  let biggest = 0;
  let seen = 0;
  for (let i = 0; i < 400 && room.phase === 'play'; i += 1) {
    for (const p of players) if (i % 3 === 0) room.turn(p, ['up', 'down', 'left', 'right'][(i + p.name.length) % 4]);
    for (const m of room.step()) {
      if (m.t !== 'tick') continue;
      seen += 1;
      biggest = Math.max(biggest, JSON.stringify(m).length);
      assert.deepEqual(Object.keys(m).filter((k) => !['t', 'n', 'h', 'out'].includes(k)), []);
      assert.equal(m.h.length, 8);
    }
  }
  assert.ok(seen > 5);
  assert.ok(biggest < 200, `largest tick: ${biggest} bytes`);
});

// What a page does with the messages, enough to rebuild the board.
function replay(msgs, model = { cells: [] }) {
  const expand = (pts) => {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i += 1) {
      const [x0, y0] = xy(pts[i - 1]);
      const [x1, y1] = xy(pts[i]);
      assert.ok(x0 === x1 || y0 === y1, 'corners share a row or a column');
      const sx = Math.sign(x1 - x0);
      const sy = Math.sign(y1 - y0);
      for (let x = x0 + sx, y = y0 + sy; ; x += sx, y += sy) {
        out.push(cellOf(x, y));
        if (x === x1 && y === y1) break;
      }
    }
    return out;
  };
  for (const m of msgs) {
    if (m.t === 'state') model.cells = m.cycles.map((cy) => expand(cy.pts));
    if (m.t === 'tick') m.h.forEach((cell, i) => { if (cell >= 0) model.cells[i].push(cell); });
  }
  return model;
}

function boardOf(room) {
  return room.cycles.map((_, i) => [...room.grid.keys()].filter((c) => room.grid[c] === i + 1).sort((a, b) => a - b));
}

test('the protocol rebuilds the board: a join snapshot, then ticks', () => {
  const players = Array.from({ length: 6 }, (_, i) => user(30 + i));
  const room = roomWith(...players, D);
  for (const p of players) room.ride(p);
  const fromStart = replay(until(room, (r) => r.phase === 'play'));
  let late = null;
  let lateModel = null;
  for (let i = 0; i < 300 && room.phase === 'play'; i += 1) {
    for (const p of players) if ((i + p.id.length * 3 + Number(p.id.at(-1))) % 4 === 0) room.turn(p, ['up', 'left', 'down', 'right'][(i >> 2) % 4]);
    if (i === 12) {
      late = [room.snapshot()]; // someone joins mid-round
      lateModel = replay(late);
    }
    const msgs = room.step();
    replay(msgs, fromStart);
    if (lateModel) replay(msgs, lateModel);
  }
  const want = boardOf(room);
  assert.deepEqual(fromStart.cells.map((c) => [...c].sort((a, b) => a - b)), want, 'from the start of the round');
  assert.deepEqual(lateModel.cells.map((c) => [...c].sort((a, b) => a - b)), want, 'from a snapshot mid-round');
  for (const [i, cy] of room.cycles.entries()) assert.equal(fromStart.cells[i].at(-1), cellOf(cy.x, cy.y), 'the last cell is the head');
});

test('roster: who is here, sent when it changes and not again when it does not', () => {
  const room = roomWith(A);
  let msgs = room.step();
  assert.deepEqual(msgs.map((m) => m.t), ['roster']);
  assert.deepEqual(msgs[0].people, [{ id: A.id, name: 'Ana' }]);
  room.sockets.add({ player: A }); // a second socket of the same player
  room.presenceChanged();
  assert.deepEqual(room.step(), [], 'nothing new to say');
  room.sockets.add({ player: B });
  room.presenceChanged();
  msgs = room.step();
  assert.deepEqual(msgs[0].people.map((p) => p.name), ['Ana', 'Bo']);
});
