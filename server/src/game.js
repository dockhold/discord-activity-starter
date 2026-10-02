// Trails: a light-cycle arena for one Activity instance. Up to eight riders
// steer on a 64 x 64 grid and everyone else in the room watches. The server
// owns the state and the clock: clients only ask to ride, to watch or to
// turn, and every rule is applied here.
//
// A room does nothing on its own. The server calls step() 15 times a second
// while busy() is true and sends what it returns to every socket in the
// room. Time is counted in ticks, so the tests play whole rounds without
// waiting for them.
//
// Messages to the page:
//   state   everything, sent on join and whenever a round is set up
//   tick    one per tick of play: each rider's new head cell (-1 for none)
//           and, when someone went out, their places in the list
//   phase   play has started, or the round is over (with the result)
//   roster  riders, who is here and the scoreboard, when one of them changes
// A trail travels as its corners: consecutive points share a row or a
// column, and the last point is the head. A cell is y * 64 + x.

export const SIZE = 64;
export const HZ = 15;
export const MAX_RIDERS = 8;
export const COUNTDOWN_TICKS = 3 * HZ;
export const RESULTS_TICKS = 3 * HZ;
export const AWAY_TICKS = 30 * HZ; // a rider gone from the room this long loses their place
export const MAX_QUEUED_TURNS = 2; // per rider, between two ticks; more are dropped
const LATE_SPAWN_TICKS = HZ; // a countdown that respawns keeps at least a second, once
const RING_RADIUS = 20;
const KEEP_SCORES = 64; // users remembered on the scoreboard
const SHOW_SCORES = 10;

const STEP = new Map([['up', [0, -1]], ['down', [0, 1]], ['left', [-1, 0]], ['right', [1, 0]]]);
const OPPOSITE = new Map([['up', 'down'], ['down', 'up'], ['left', 'right'], ['right', 'left']]);

export const msOf = (ticks) => Math.round((ticks * 1000) / HZ);
const inside = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE;

// The direction along the ring, clockwise on screen (y grows downwards),
// rounded to the nearest of the four.
function clockwise(angle) {
  const a = angle + 1e-6; // a tie between two directions goes the same way every time
  const tx = -Math.sin(a);
  const ty = Math.cos(a);
  if (Math.abs(tx) > Math.abs(ty)) return tx > 0 ? 'right' : 'left';
  return ty > 0 ? 'down' : 'up';
}

// Spawns evenly spaced on a ring around the centre, each facing clockwise
// along it. `rotate` turns the ring by whole places, so riders start
// somewhere else each round. A spot on a trail, next to another spawn, or
// one cell from a wall, a trail or another rider's first move slides along
// its radius until it fits. Returns null if nothing fits (on an empty board
// everything fits at the first try).
export function spawnPoints(count, grid, rotate = 0) {
  const centre = (SIZE - 1) / 2;
  const points = [];
  for (let k = 0; k < count; k += 1) {
    const angle = (2 * Math.PI * ((k + rotate) % count)) / count - Math.PI / 2;
    const dir = clockwise(angle);
    const [dx, dy] = STEP.get(dir);
    let found = null;
    for (let i = 0; i < 2 * RING_RADIUS && !found; i += 1) {
      const r = RING_RADIUS + (i % 2 ? (i + 1) / 2 : -i / 2); // 20, 21, 19, 22, 18, ...
      const x = Math.round(centre + r * Math.cos(angle));
      const y = Math.round(centre + r * Math.sin(angle));
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(x, y) || !inside(nx, ny) || grid[y * SIZE + x] || grid[ny * SIZE + nx]) continue;
      const clear = points.every((p) => {
        const [pdx, pdy] = STEP.get(p.dir);
        const near = Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) < 2;
        const sameFirstMove = p.x + pdx === nx && p.y + pdy === ny;
        const intoSpawn = (p.x === nx && p.y === ny) || (p.x + pdx === x && p.y + pdy === y);
        return !near && !sameFirstMove && !intoSpawn;
      });
      if (clear) found = { x, y, dir };
    }
    if (!found) return null;
    points.push(found);
  }
  return points;
}

export class Room {
  constructor(id) {
    this.id = id;
    this.sockets = new Set(); // each socket carries .player = { id, name }
    this.emptySince = null;
    this.people = new Map(); // user ID -> name, for everyone with a socket here
    this.riders = new Map(); // user ID -> { id, name, c, awaySince }, at most MAX_RIDERS
    this.wins = new Map(); // user ID -> { name, wins }
    this.grid = new Uint8Array(SIZE * SIZE); // 0 empty, else the cycle's index + 1
    this.phase = 'lobby'; // lobby, countdown, play, results
    this.left = 0; // ticks left in the countdown or the results
    this.clock = 0; // ticks stepped since the room was made
    this.round = 0;
    this.n = 0; // ticks played in this round
    this.cycles = []; // this round's riders, in the order of the tick's head list
    this.startedWith = 0;
    this.result = null;
    this.forfeits = []; // cycles whose rider chose to watch since the last tick
    this.extended = false; // whether this countdown was already given more time
    this.rosterDirty = false;
    this.lastRoster = '';
  }

  socketsOf(userId) {
    let n = 0;
    for (const ws of this.sockets) if (ws.player.id === userId) n += 1;
    return n;
  }

  // Called after a socket joins or leaves. A rider with no socket left is
  // away: their cycle rides on, and their place is kept for AWAY_TICKS.
  presenceChanged() {
    this.people = new Map();
    for (const ws of this.sockets) this.people.set(ws.player.id, ws.player.name);
    for (const r of this.riders.values()) {
      if (this.people.has(r.id)) r.awaySince = null;
      else if (r.awaySince === null) r.awaySince = this.clock;
    }
    this.rosterDirty = true;
  }

  // The handlers below act for `player`, which the server takes from the
  // session token. ride() returns a short reason when it refuses; the others
  // quietly ignore what they cannot do.
  ride(player) {
    if (this.riders.has(player.id)) return null;
    if (this.riders.size >= MAX_RIDERS) return 'The arena is full. Watch this one.';
    this.riders.set(player.id, { id: player.id, name: player.name, c: this.freeColour(), awaySince: null });
    this.rosterDirty = true;
    return null;
  }

  // Watching in the middle of a round takes the rider out of it.
  watch(player) {
    if (!this.riders.delete(player.id)) return false;
    const cy = this.cycleOf(player.id);
    if (this.phase === 'play' && cy?.alive) {
      cy.alive = false;
      this.forfeits.push(this.cycles.indexOf(cy));
    }
    this.rosterDirty = true;
    return true;
  }

  // Queues a turn for the player's own cycle. Ignored: an unknown direction,
  // no cycle in this round, the way it already goes, straight back, and
  // anything past MAX_QUEUED_TURNS.
  turn(player, d) {
    if (typeof d !== 'string' || !STEP.has(d)) return;
    if (this.phase !== 'play' && this.phase !== 'countdown') return;
    const cy = this.cycleOf(player.id);
    if (!cy?.alive || cy.queue.length >= MAX_QUEUED_TURNS) return;
    const ahead = cy.queue.length ? cy.queue[cy.queue.length - 1] : cy.dir;
    if (d === ahead || d === OPPOSITE.get(ahead)) return;
    cy.queue.push(d);
  }

  cycleOf(userId) {
    return this.cycles.find((cy) => cy.id === userId) ?? null;
  }

  // The first colour no rider holds, preferring one no trail on the board has.
  freeColour() {
    const held = new Set([...this.riders.values()].map((r) => r.c));
    const onBoard = new Set(this.cycles.map((cy) => cy.c));
    for (let c = 0; c < MAX_RIDERS; c += 1) if (!held.has(c) && !onBoard.has(c)) return c;
    for (let c = 0; c < MAX_RIDERS; c += 1) if (!held.has(c)) return c;
    return 0;
  }

  // Riders in the room now, in the order they chose to ride.
  ready() {
    return [...this.riders.values()].filter((r) => r.awaySince === null);
  }

  // Whether the server should keep stepping this room.
  busy() {
    return this.riders.size > 0 || this.phase !== 'lobby' || this.rosterDirty;
  }

  // One tick. Returns the messages for everyone in the room, in order.
  step() {
    this.clock += 1;
    const out = [];
    for (const r of this.riders.values()) {
      if (r.awaySince !== null && this.clock - r.awaySince >= AWAY_TICKS) {
        this.riders.delete(r.id);
        this.rosterDirty = true;
      }
    }
    if (this.phase === 'lobby') {
      if (this.ready().length) this.setUp(out);
    } else if (this.phase === 'countdown') {
      const ready = this.ready();
      if (!ready.length) {
        this.toLobby(out);
      } else {
        if (ready.length !== this.cycles.length || ready.some((r, i) => r.id !== this.cycles[i].id)) {
          this.spawn(ready);
          // More time once only: riders coming and going must not be able to
          // hold the countdown open.
          if (!this.extended && this.left < LATE_SPAWN_TICKS) {
            this.left = LATE_SPAWN_TICKS;
            this.extended = true;
          }
          this.pushSnapshot(out);
        }
        this.left -= 1;
        if (this.left <= 0) {
          this.phase = 'play';
          out.push({ t: 'phase', phase: 'play', ms: 0 });
        }
      }
    } else if (this.phase === 'play') {
      this.move(out);
    } else if (this.phase === 'results') {
      this.left -= 1;
      if (this.left <= 0) {
        if (this.ready().length) this.setUp(out);
        else this.toLobby(out);
      }
    }
    if (this.rosterDirty) {
      this.rosterDirty = false;
      const roster = this.roster();
      const json = JSON.stringify(roster);
      if (json !== this.lastRoster) {
        this.lastRoster = json;
        out.push({ t: 'roster', ...roster });
      }
    }
    return out;
  }

  setUp(out) {
    this.round += 1;
    this.phase = 'countdown';
    this.left = COUNTDOWN_TICKS;
    this.extended = false;
    this.result = null;
    this.spawn(this.ready());
    this.pushSnapshot(out);
  }

  toLobby(out) {
    this.phase = 'lobby';
    this.left = 0;
    this.n = 0;
    this.cycles = [];
    this.startedWith = 0;
    this.result = null;
    this.grid.fill(0);
    this.pushSnapshot(out);
  }

  // Clears the board and puts `riders` on it, at `points` when given (the
  // tests use that to set up a crash) or else on the ring.
  spawn(riders, points = null) {
    this.grid.fill(0);
    this.n = 0;
    this.forfeits = [];
    const at = points ?? spawnPoints(riders.length, this.grid, this.round) ?? [];
    this.cycles = at.map((p, i) => {
      const r = riders[i];
      this.grid[p.y * SIZE + p.x] = i + 1;
      return { id: r.id, name: r.name, c: r.c, alive: true, x: p.x, y: p.y, dir: p.dir, moved: null, queue: [], pts: [p.y * SIZE + p.x] };
    });
    this.startedWith = this.cycles.length;
  }

  aliveCount() {
    let n = 0;
    for (const cy of this.cycles) if (cy.alive) n += 1;
    return n;
  }

  // A round of two or more ends when one rider (or none) is left; a solo
  // round (practice) ends when its rider is out.
  over() {
    const alive = this.aliveCount();
    return this.startedWith >= 2 ? alive <= 1 : alive === 0;
  }

  // Every alive cycle takes its next queued turn, then moves one cell. All
  // moves are checked against the board as it was before the tick, so the
  // order of the riders does not matter.
  move(out) {
    const cs = this.cycles;
    if (!cs.length) {
      this.toLobby(out);
      return;
    }
    const gone = this.forfeits;
    this.forfeits = [];
    if (!this.over()) {
      this.n += 1;
      const next = cs.map((cy) => {
        if (!cy.alive) return -1;
        if (cy.queue.length) {
          const d = cy.queue.shift();
          if (d !== OPPOSITE.get(cy.dir)) cy.dir = d;
        }
        const [dx, dy] = STEP.get(cy.dir);
        const x = cy.x + dx;
        const y = cy.y + dy;
        if (!inside(x, y) || this.grid[y * SIZE + x]) return -2; // a wall or a trail, its own included
        return y * SIZE + x;
      });
      // Heads entering one cell: all out. Two heads swapping cells hit each
      // other's trail above, because a head is part of its trail.
      for (let i = 0; i < next.length; i += 1) {
        const target = next[i];
        if (target < 0) continue;
        for (let j = i + 1; j < next.length; j += 1) {
          if (next[j] === target) {
            next[i] = -2;
            next[j] = -2;
          }
        }
      }
      const h = new Array(cs.length);
      for (let i = 0; i < cs.length; i += 1) {
        const cy = cs[i];
        const cell = next[i];
        if (cell === -2) {
          cy.alive = false;
          gone.push(i);
        }
        if (cell < 0) {
          h[i] = -1;
          continue;
        }
        this.grid[cell] = i + 1;
        cy.x = cell % SIZE;
        cy.y = (cell - cy.x) / SIZE;
        if (cy.moved === cy.dir) cy.pts[cy.pts.length - 1] = cell;
        else cy.pts.push(cell);
        cy.moved = cy.dir;
        h[i] = cell;
      }
      out.push(gone.length ? { t: 'tick', n: this.n, h, out: gone } : { t: 'tick', n: this.n, h });
    } else if (gone.length) {
      out.push({ t: 'tick', n: this.n, h: cs.map(() => -1), out: gone });
    }
    if (this.over()) this.finish(out);
  }

  finish(out) {
    const ms = msOf(this.n);
    if (this.startedWith >= 2) {
      const last = this.cycles.find((cy) => cy.alive);
      const winner = last ? { id: last.id, name: last.name, c: last.c } : null;
      if (winner) this.addWin(winner);
      this.result = { practice: false, winner, ms };
    } else {
      const cy = this.cycles[0];
      this.result = { practice: true, rider: { id: cy.id, name: cy.name, c: cy.c }, ms };
    }
    this.phase = 'results';
    this.left = RESULTS_TICKS;
    out.push({ t: 'phase', phase: 'results', ms: msOf(this.left), result: this.result });
  }

  addWin({ id, name }) {
    this.wins.set(id, { name, wins: (this.wins.get(id)?.wins ?? 0) + 1 });
    this.rosterDirty = true;
    if (this.wins.size <= KEEP_SCORES) return;
    let low = null;
    for (const [uid, w] of this.wins) {
      if (uid !== id && !this.riders.has(uid) && (!low || w.wins < low.wins)) low = { uid, wins: w.wins };
    }
    if (low) this.wins.delete(low.uid);
  }

  roster() {
    return {
      riders: [...this.riders.values()].map((r) => ({ id: r.id, name: r.name, c: r.c, here: r.awaySince === null })),
      people: [...this.people].map(([id, name]) => ({ id, name })),
      scores: [...this.wins]
        .map(([id, w]) => ({ id, name: w.name, wins: w.wins }))
        .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name))
        .slice(0, SHOW_SCORES),
    };
  }

  // A snapshot sent to the whole room also stands for the roster message.
  pushSnapshot(out) {
    const roster = this.roster();
    this.lastRoster = JSON.stringify(roster);
    this.rosterDirty = false;
    out.push(this.snapshot(roster));
  }

  // The whole room: for a socket that just joined, or a round being set up.
  snapshot(roster = this.roster()) {
    return {
      t: 'state',
      size: SIZE,
      hz: HZ,
      phase: this.phase,
      ms: this.phase === 'countdown' || this.phase === 'results' ? msOf(this.left) : 0,
      n: this.n,
      cycles: this.cycles.map((cy) => ({ id: cy.id, name: cy.name, c: cy.c, alive: cy.alive, dir: cy.dir, pts: [...cy.pts] })),
      result: this.result,
      ...roster,
    };
  }
}
