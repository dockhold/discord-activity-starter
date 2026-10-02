// Trails, the page side. It draws what the server sends and sends back only
// "ride", "watch" and "turn" (a turn on a key press, a swipe or a button,
// never per frame). Heads glide between ticks: the board is drawn about one
// tick behind the newest one, on a clock kept in step with the server's.

type Dir = 'up' | 'down' | 'left' | 'right';
type Phase = 'lobby' | 'countdown' | 'play' | 'results';
type Person = { id: string; name: string };
type Rider = Person & { c: number; here: boolean };
type Score = Person & { wins: number };
type Who = Person & { c: number };
type Result = { practice: boolean; winner?: Who | null; rider?: Who; ms: number };
type CycleMsg = Who & { alive: boolean; dir: Dir; pts: number[] };
type Roster = { riders: Rider[]; people: Person[]; scores: Score[] };
type StateMsg = Roster & { t: 'state'; size: number; hz: number; phase: Phase; ms: number; n: number; cycles: CycleMsg[]; result: Result | null };
type TickMsg = { t: 'tick'; n: number; h: number[]; out?: number[] };
type PhaseMsg = { t: 'phase'; phase: Phase; ms: number; result?: Result };
type RosterMsg = Roster & { t: 'roster' };
export type GameMsg = StateMsg | TickMsg | PhaseMsg | RosterMsg;

type Cycle = Who & {
  alive: boolean;
  dir: Dir;
  cells: number[]; // cells[t] is where the head was after tick t
  corners: number[]; // indexes into cells where the trail turns
  outAt: number | null; // the tick it went out
  burstAt: number | null; // when the crash was drawn (ms)
};

// Eight colours that stay apart under the common colour vision deficiencies,
// with brightness from dim to bright as a second cue. Names next to the heads
// are the third.
export const COLOURS = ['#38e4ff', '#ff7ab8', '#ff9a1f', '#f4f6ff', '#b47cff', '#f8f05a', '#ff3b3b', '#3a5cff'];
const COLOUR_NAMES = ['cyan', 'pink', 'orange', 'white', 'violet', 'yellow', 'red', 'blue'];
const KEYS: Record<string, Dir> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right',
};
const STEP: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const ARROWS: Record<Dir, string> = { up: '↑', down: '↓', left: '←', right: '→' };
const RENDER_DELAY_TICKS = 1.2; // how far behind the newest tick the board is drawn
const SWIPE_PX = 18;
const MAX_TURNS_PER_SECOND = 12; // well under the server's 20 messages a second

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

// Names are cut by what a reader sees as one character (an emoji made of
// several code points stays whole), or by code points where the browser
// cannot tell.
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function short(name: string) {
  const chars = segmenter ? Array.from(segmenter.segment(name), (g) => g.segment) : Array.from(name);
  return chars.length > 16 ? `${chars.slice(0, 15).join('')}…` : name;
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export class Trails {
  private size = 64;
  private hz = 15;
  private phase: Phase = 'lobby';
  private phaseEndsAt = 0;
  private playStartedAt = 0;
  private n = 0; // newest tick
  private drawTick = 0; // the (fractional) tick on screen
  private clockOffset: number | null = null; // tick minus performance.now() in ticks
  private cycles: Cycle[] = [];
  private result: Result | null = null;
  private roster: Roster = { riders: [], people: [], scores: [] };
  private me: Person | null = null;
  private connection = '';
  private notice = '';
  private noticeUntil = 0;
  private pending: { d: Dir; at: number } | null = null;
  private bucket = MAX_TURNS_PER_SECOND;
  private bucketAt = 0;
  private overlayKey = ''; // what the overlay shows now, to skip redundant updates

  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private grid: HTMLCanvasElement | null = null;
  private px = 0; // board size in CSS pixels
  private dpr = 1;
  private readonly status = el('span', 'pill');
  private readonly rideButton = el('button', 'seg');
  private readonly watchButton = el('button', 'seg');
  private readonly board = el('div', 'board');
  private readonly stage = el('div', 'stage');
  private readonly big = el('div', 'big');
  private readonly sub = el('div', 'sub');
  private readonly overlay = el('div', 'overlay');
  private readonly banner = el('div', 'banner');
  private readonly scores = el('ol', 'scores');
  private readonly people = el('ul', 'people');
  private readonly hereTitle = el('h2', '', 'Here now');
  private readonly help = el('p', 'help');

  constructor(mount: HTMLElement, private readonly send: (msg: object) => void) {
    this.canvas = el('canvas');
    this.canvas.setAttribute('aria-label', 'The Trails arena');
    this.canvas.setAttribute('role', 'img');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot draw the game.');
    this.ctx = ctx;

    this.rideButton.textContent = 'Ride';
    this.watchButton.textContent = 'Watch';
    this.rideButton.addEventListener('click', () => this.send({ t: 'ride' }));
    this.watchButton.addEventListener('click', () => this.send({ t: 'watch' }));
    const toggle = el('div', 'toggle', this.rideButton, this.watchButton);
    toggle.setAttribute('role', 'group');
    toggle.setAttribute('aria-label', 'Ride or watch');

    this.overlay.append(this.big, this.sub);
    this.overlay.setAttribute('role', 'status');
    this.overlay.setAttribute('aria-live', 'polite');
    this.board.append(this.canvas, this.overlay, this.banner);
    this.stage.append(this.board);

    const pad = el('div', 'pad');
    for (const d of ['up', 'left', 'down', 'right'] as Dir[]) {
      const b = el('button', `key key-${d}`, ARROWS[d]);
      b.setAttribute('aria-label', `Turn ${d}`);
      b.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        this.turn(d);
      });
      pad.append(b);
    }

    const side = el('aside', 'side',
      el('section', '', el('h2', '', 'Wins'), this.scores),
      el('section', '', this.hereTitle, this.people),
      this.help);
    const brand = el('div', 'brand', el('span', 'mark'), 'Trails');
    this.root = el('div', 'trails',
      el('header', 'bar', brand, this.status, toggle),
      el('div', 'main', this.stage, el('div', 'controls', pad, side)));
    mount.replaceChildren(this.root);

    window.addEventListener('keydown', (ev) => this.onKey(ev));
    this.listenForSwipes();
    const coarse = window.matchMedia('(pointer: coarse)');
    const touch = () => {
      this.root.classList.toggle('touch', coarse.matches || this.root.classList.contains('touched'));
      this.help.textContent = this.root.classList.contains('touch')
        ? 'Swipe on the board or use the buttons to turn.'
        : 'Turn with the arrow keys or WASD.';
    };
    coarse.addEventListener('change', touch);
    window.addEventListener('touchstart', () => {
      this.root.classList.add('touched');
      touch();
    }, { once: true, passive: true });
    touch();

    new ResizeObserver(() => this.resize()).observe(this.stage);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.updateUi();
    requestAnimationFrame((t) => this.frame(t));
  }

  setMe(me: Person) {
    this.me = me;
    this.updateUi();
  }

  setConnection(text: string) {
    this.connection = text;
    this.updateUi();
  }

  showNotice(text: string) {
    this.notice = text;
    this.noticeUntil = performance.now() + 4000;
    this.updateUi();
  }

  receive(msg: GameMsg) {
    const now = performance.now();
    if (msg.t === 'state') {
      this.size = msg.size;
      this.hz = msg.hz;
      this.phase = msg.phase;
      this.phaseEndsAt = now + msg.ms;
      this.n = msg.n;
      this.drawTick = msg.n;
      this.clockOffset = null;
      this.result = msg.result;
      this.cycles = msg.cycles.map((cy) => this.cycleFrom(cy, msg.n));
      this.roster = { riders: msg.riders, people: msg.people, scores: msg.scores };
      this.pending = null;
      if (this.phase === 'play') this.playStartedAt = now - 1000;
      this.drawGrid();
    } else if (msg.t === 'tick') {
      this.n = msg.n;
      const sample = msg.n - now / this.tickMs;
      if (this.clockOffset === null || Math.abs(sample - this.clockOffset) > 2) this.clockOffset = sample;
      else this.clockOffset += (sample - this.clockOffset) * 0.1;
      msg.h.forEach((cell, i) => {
        const cy = this.cycles[i];
        if (cy && cell >= 0) this.extend(cy, cell);
      });
      for (const i of msg.out ?? []) {
        const cy = this.cycles[i];
        if (cy) {
          cy.alive = false;
          cy.outAt = msg.n;
        }
      }
      if (msg.out?.length) this.updateUi();
      return;
    } else if (msg.t === 'phase') {
      this.phase = msg.phase;
      this.phaseEndsAt = now + msg.ms;
      if (msg.result) this.result = msg.result;
      if (msg.phase === 'play') {
        this.playStartedAt = now;
        this.n = 0;
        this.drawTick = 0;
        this.clockOffset = null;
      }
    } else if (msg.t === 'roster') {
      this.roster = { riders: msg.riders, people: msg.people, scores: msg.scores };
    }
    this.updateUi();
  }

  private get tickMs() {
    return 1000 / this.hz;
  }

  private cycleFrom(m: CycleMsg, n: number): Cycle {
    const cy: Cycle = { id: m.id, name: m.name, c: m.c, alive: m.alive, dir: m.dir, cells: [m.pts[0]], corners: [], outAt: m.alive ? null : n, burstAt: m.alive ? null : 0 };
    for (let i = 1; i < m.pts.length; i += 1) {
      const [x0, y0] = this.xy(m.pts[i - 1]);
      const [x1, y1] = this.xy(m.pts[i]);
      const sx = Math.sign(x1 - x0);
      const sy = Math.sign(y1 - y0);
      for (let x = x0 + sx, y = y0 + sy, k = 0; k < this.size; x += sx, y += sy, k += 1) {
        this.extend(cy, y * this.size + x);
        if (x === x1 && y === y1) break;
      }
    }
    cy.dir = m.dir;
    return cy;
  }

  private extend(cy: Cycle, cell: number) {
    const cells = cy.cells;
    const last = cells[cells.length - 1];
    const dir = this.dirBetween(last, cell);
    if (cells.length >= 2 && dir !== this.dirBetween(cells[cells.length - 2], last)) cy.corners.push(cells.length - 1);
    cells.push(cell);
    if (dir) cy.dir = dir;
  }

  private xy(cell: number): [number, number] {
    return [cell % this.size, Math.floor(cell / this.size)];
  }

  private dirBetween(a: number, b: number): Dir | null {
    const [x0, y0] = this.xy(a);
    const [x1, y1] = this.xy(b);
    if (x1 > x0) return 'right';
    if (x1 < x0) return 'left';
    if (y1 > y0) return 'down';
    if (y1 < y0) return 'up';
    return null;
  }

  private mine(): Cycle | null {
    return this.cycles.find((cy) => cy.id === this.me?.id) ?? null;
  }

  private riding() {
    return this.roster.riders.some((r) => r.id === this.me?.id);
  }

  // Whether a turn now would steer anything: your own cycle, still riding,
  // in the countdown or in play.
  private canTurn() {
    return Boolean(this.mine()?.alive) && (this.phase === 'play' || this.phase === 'countdown');
  }

  // Input. A turn goes out only for a cycle that can use it, and at most
  // MAX_TURNS_PER_SECOND, so holding or mashing keys never trips the
  // server's message limit.
  private turn(d: Dir) {
    if (!this.canTurn()) return;
    const now = performance.now();
    this.bucket = Math.min(MAX_TURNS_PER_SECOND, this.bucket + ((now - this.bucketAt) / 1000) * MAX_TURNS_PER_SECOND);
    this.bucketAt = now;
    if (this.bucket < 1) return;
    this.bucket -= 1;
    this.pending = { d, at: now };
    this.send({ t: 'turn', d });
  }

  // Keys are taken only while they steer; otherwise the arrows scroll the
  // page as usual, for someone watching.
  private onKey(ev: KeyboardEvent) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const d = KEYS[ev.key];
    if (!d || !this.canTurn()) return;
    ev.preventDefault();
    if (!ev.repeat) this.turn(d);
  }

  private listenForSwipes() {
    let start: { x: number; y: number; id: number } | null = null;
    this.board.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse') return;
      start = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    });
    this.board.addEventListener('pointermove', (ev) => {
      if (!start || ev.pointerId !== start.id) return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (Math.hypot(dx, dy) < SWIPE_PX) return;
      this.turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
      start = { x: ev.clientX, y: ev.clientY, id: ev.pointerId }; // keep going: one swipe can turn twice
    });
    const end = () => { start = null; };
    this.board.addEventListener('pointerup', end);
    this.board.addEventListener('pointercancel', end);
  }

  // The page around the board. Called on changes, not every frame.
  private updateUi() {
    const me = this.me;
    const riding = this.riding();
    const mine = this.mine();
    const full = this.roster.riders.length >= COLOURS.length && !riding;
    this.rideButton.classList.toggle('on', riding);
    this.watchButton.classList.toggle('on', !riding);
    this.rideButton.disabled = full;
    this.rideButton.title = full ? 'The arena is full. Watch this one.' : 'Ride in the next round';
    this.rideButton.setAttribute('aria-pressed', String(riding));
    this.watchButton.setAttribute('aria-pressed', String(!riding));

    const alive = this.cycles.filter((cy) => cy.alive).length;
    const pill = this.connection
      || (this.phase === 'lobby' ? 'Waiting for riders'
        : this.phase === 'countdown' ? 'Get ready'
          : this.phase === 'play' ? `${alive} of ${this.cycles.length} riding`
            : 'Round over');
    this.status.textContent = pill;
    this.status.classList.toggle('warn', Boolean(this.connection));
    this.status.classList.toggle('live', !this.connection && this.phase === 'play');

    let banner = '';
    if (this.notice && performance.now() < this.noticeUntil) banner = this.notice;
    else if (riding && !mine && (this.phase === 'play' || this.phase === 'results')) banner = 'You ride next round.';
    else if (mine && !mine.alive && this.phase === 'play') banner = 'You are out. Next round soon.';
    else if (!riding && this.phase !== 'lobby') banner = full ? 'Watching. The arena is full.' : 'Watching. Press Ride to join the next round.';
    this.banner.textContent = banner;
    this.banner.hidden = !banner;

    this.scores.replaceChildren(...(this.roster.scores.length
      ? this.roster.scores.map((s) => el('li', s.id === me?.id ? 'me' : '', el('span', 'name', short(s.name)), el('span', 'wins', String(s.wins))))
      : [el('li', 'empty', 'No wins yet.')]));

    const riders = new Map(this.roster.riders.map((r) => [r.id, r]));
    const rows: HTMLElement[] = [];
    const seen = new Set<string>();
    const row = (id: string, name: string) => {
      seen.add(id);
      const r = riders.get(id);
      const cy = this.cycles.find((c) => c.id === id);
      const dot = el('span', 'dot');
      if (r) dot.style.setProperty('--c', COLOURS[r.c]);
      else dot.classList.add('none');
      let tag = r ? '' : 'watching';
      if (r && !r.here) tag = 'away';
      else if (r && cy && !cy.alive && this.phase !== 'countdown') tag = 'out';
      else if (r && !cy && this.phase !== 'lobby') tag = 'next round';
      const li = el('li', id === me?.id ? 'me' : '', dot, el('span', 'name', short(name)));
      if (id === me?.id) li.append(el('span', 'tag you', 'you'));
      if (tag) li.append(el('span', 'tag', tag));
      rows.push(li);
    };
    for (const p of this.roster.people) row(p.id, p.name);
    for (const r of this.roster.riders) if (!seen.has(r.id)) row(r.id, r.name);
    this.people.replaceChildren(...rows);
    this.hereTitle.textContent = `Here now: ${this.roster.people.length}`;
    this.overlayKey = '';
    this.updateOverlay(performance.now());
  }

  // The words over the board. The countdown number changes every second,
  // so this runs from the frame loop too, and only touches the page when
  // the text changes.
  private updateOverlay(now: number) {
    const left = Math.max(0, Math.ceil((this.phaseEndsAt - now) / 1000));
    const mine = this.mine();
    let big = '';
    let sub = '';
    let colour = '';
    let kind = this.phase as string;
    if (this.phase === 'lobby') {
      big = 'Trails';
      sub = this.riding() ? 'Starting...' : 'Press Ride to play. Up to eight can ride.';
    } else if (this.phase === 'countdown') {
      big = String(Math.max(1, left));
      if (mine) {
        sub = `You are ${COLOUR_NAMES[mine.c]}, heading ${mine.dir}.`;
        colour = COLOURS[mine.c];
      } else {
        sub = 'Get ready.';
      }
    } else if (this.phase === 'play') {
      if (now - this.playStartedAt < 600) big = 'Go';
      kind = 'go';
    } else if (this.phase === 'results' && this.result) {
      const r = this.result;
      const next = left > 0 ? `Next round in ${left}.` : '';
      if (r.practice && r.rider) {
        big = r.rider.id === this.me?.id ? `Survived ${seconds(r.ms)}` : `${short(r.rider.name)} survived ${seconds(r.ms)}`;
        sub = `Practice. ${next}`;
        colour = COLOURS[r.rider.c];
      } else if (r.winner) {
        big = r.winner.id === this.me?.id ? 'You win' : `${short(r.winner.name)} wins`;
        sub = next;
        colour = COLOURS[r.winner.c];
      } else {
        big = 'Draw';
        sub = `Nobody is left. ${next}`;
      }
    }
    const key = `${kind}|${big}|${sub}|${colour}`;
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    this.big.textContent = big;
    this.sub.textContent = sub.trim();
    this.overlay.className = `overlay ${kind}${big || sub ? '' : ' hidden'}`;
    this.overlay.style.setProperty('--c', colour || 'var(--text)');
  }

  private resize() {
    const wide = this.root.clientWidth >= 640 && window.innerWidth / window.innerHeight > 1.15;
    this.root.classList.toggle('wide', wide);
    const avail = wide
      ? Math.min(this.stage.clientWidth, this.stage.clientHeight)
      : Math.min(this.stage.clientWidth, Math.max(220, window.innerHeight * 0.62));
    const px = Math.max(160, Math.floor(avail));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (px === this.px && dpr === this.dpr) return;
    this.px = px;
    this.dpr = dpr;
    this.board.style.width = `${px}px`;
    this.board.style.height = `${px}px`;
    this.canvas.width = Math.round(px * dpr);
    this.canvas.height = Math.round(px * dpr);
    this.drawGrid();
  }

  // The floor, drawn once per size on a canvas of its own.
  private drawGrid() {
    const w = this.canvas.width;
    if (!w) return;
    const g = this.grid ?? document.createElement('canvas');
    this.grid = g;
    g.width = w;
    g.height = w;
    const c = g.getContext('2d');
    if (!c) return;
    const cell = w / this.size;
    const bg = c.createRadialGradient(w / 2, w / 2, w * 0.05, w / 2, w / 2, w * 0.75);
    bg.addColorStop(0, '#0d1424');
    bg.addColorStop(1, '#04060b');
    c.fillStyle = bg;
    c.fillRect(0, 0, w, w);
    for (let i = 0; i <= this.size; i += 4) {
      c.strokeStyle = i % 16 === 0 ? 'rgba(98, 140, 255, 0.16)' : 'rgba(98, 140, 255, 0.07)';
      c.lineWidth = Math.max(1, this.dpr * 0.75);
      const p = Math.round(i * cell) + 0.5;
      c.beginPath();
      c.moveTo(p, 0);
      c.lineTo(p, w);
      c.moveTo(0, p);
      c.lineTo(w, p);
      c.stroke();
    }
    c.strokeStyle = 'rgba(56, 228, 255, 0.55)';
    c.lineWidth = 2 * this.dpr;
    c.shadowColor = 'rgba(56, 228, 255, 0.8)';
    c.shadowBlur = 10 * this.dpr;
    c.strokeRect(this.dpr, this.dpr, w - 2 * this.dpr, w - 2 * this.dpr);
  }

  // The draw clock: the server's tick, minus a little, never backwards and
  // never past the newest tick.
  private advance(now: number) {
    if (this.phase !== 'play' && this.phase !== 'results') {
      this.drawTick = this.n;
      return;
    }
    if (this.clockOffset === null) return;
    const target = now / this.tickMs + this.clockOffset - RENDER_DELAY_TICKS;
    this.drawTick = Math.min(this.n, Math.max(this.drawTick, target));
  }

  private frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    if (!this.grid || !this.px) return;
    this.advance(now);
    if (this.phase === 'countdown' || this.phase === 'results' || this.phase === 'play') this.updateOverlay(now);
    if (this.notice && now >= this.noticeUntil) {
      this.notice = '';
      this.updateUi();
    }
    const ctx = this.ctx;
    const scale = this.canvas.width / this.size;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.grid, 0, 0);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const k = Math.floor(this.drawTick);
    const f = this.drawTick - k;
    const heads = this.cycles.map((cy) => this.headAt(cy, k, f));

    // Trails: a soft halo and a solid line, added together so crossings glow.
    ctx.globalCompositeOperation = 'lighter';
    for (const pass of [{ w: 2.2, a: 0.1 }, { w: 1.1, a: 0.22 }, { w: 0.55, a: 1 }]) {
      ctx.lineWidth = pass.w;
      this.cycles.forEach((cy, i) => {
        ctx.globalAlpha = pass.a * (this.isOut(cy) ? 0.55 : 1);
        ctx.strokeStyle = COLOURS[cy.c];
        this.tracePath(cy, k, heads[i]);
        ctx.stroke();
      });
    }
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 0.16;
    ctx.strokeStyle = '#ffffff';
    this.cycles.forEach((cy, i) => {
      if (this.isOut(cy)) return;
      this.tracePath(cy, k, heads[i]);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    this.cycles.forEach((cy, i) => {
      if (!this.isOut(cy)) this.drawHead(cy, heads[i], now);
      else this.drawBurst(cy, now);
    });
    if (this.phase === 'countdown') this.cycles.forEach((cy, i) => this.drawArrows(cy, heads[i], now));
    this.drawLabels(heads);
  }

  // Where a head is at fractional tick k + f.
  private headAt(cy: Cycle, k: number, f: number) {
    const last = cy.cells.length - 1;
    const a = this.xy(cy.cells[Math.min(k, last)]);
    const b = this.xy(cy.cells[Math.min(k + 1, last)]);
    const t = k + 1 <= last ? f : 0;
    const dir = this.dirBetween(cy.cells[Math.min(k, last)], cy.cells[Math.min(k + 1, last)]) ?? cy.dir;
    return { x: a[0] + (b[0] - a[0]) * t + 0.5, y: a[1] + (b[1] - a[1]) * t + 0.5, dir };
  }

  private isOut(cy: Cycle) {
    return !cy.alive && cy.outAt !== null && this.drawTick >= cy.outAt - 1;
  }

  private tracePath(cy: Cycle, k: number, head: { x: number; y: number }) {
    const ctx = this.ctx;
    const upto = Math.min(k, cy.cells.length - 1);
    const [x0, y0] = this.xy(cy.cells[0]);
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, y0 + 0.5);
    for (const c of cy.corners) {
      if (c > upto) break;
      const [x, y] = this.xy(cy.cells[c]);
      ctx.lineTo(x + 0.5, y + 0.5);
    }
    const [xk, yk] = this.xy(cy.cells[upto]);
    ctx.lineTo(xk + 0.5, yk + 0.5);
    ctx.lineTo(head.x, head.y);
  }

  private drawHead(cy: Cycle, head: { x: number; y: number; dir: Dir }, now: number) {
    const ctx = this.ctx;
    const colour = COLOURS[cy.c];
    const winner = this.phase === 'results' && this.result?.winner?.id === cy.id;
    const pulse = 1 + (winner ? 0.35 : 0.08) * Math.sin(now / (winner ? 120 : 260));
    const [dx, dy] = STEP[head.dir];
    ctx.save();
    ctx.translate(head.x, head.y);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.shadowColor = colour;
    ctx.shadowBlur = (winner ? 26 : 16) * this.dpr * pulse;
    ctx.fillStyle = colour;
    this.capsule(2.2 * pulse, 1.2 * pulse);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    this.capsule(1.3, 0.56);
    ctx.fill();
    ctx.restore();
    // Your own head wears a ring, and shows the turn you just asked for.
    if (cy.id === this.me?.id) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 0.18;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 1.75 + 0.15 * Math.sin(now / 200), 0, Math.PI * 2);
      ctx.stroke();
      if (this.pending && now - this.pending.at < 300 && this.pending.d !== head.dir) this.drawChevron(head.x, head.y, this.pending.d, 2.3, '#ffffff', 1 - (now - this.pending.at) / 300);
    }
  }

  private capsule(len: number, wid: number) {
    const ctx = this.ctx;
    const r = wid / 2;
    ctx.beginPath();
    ctx.moveTo(-len / 2 + r, -r);
    ctx.lineTo(len / 2 - r, -r);
    ctx.arc(len / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(-len / 2 + r, r);
    ctx.arc(-len / 2 + r, 0, r, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
  }

  private drawChevron(x: number, y: number, d: Dir, dist: number, colour: string, alpha: number) {
    const ctx = this.ctx;
    const [dx, dy] = STEP[d];
    ctx.save();
    ctx.translate(x + dx * dist, y + dy * dist);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.strokeStyle = colour;
    ctx.lineWidth = 0.32;
    ctx.beginPath();
    ctx.moveTo(-0.45, -0.65);
    ctx.lineTo(0.35, 0);
    ctx.lineTo(-0.45, 0.65);
    ctx.stroke();
    ctx.restore();
  }

  // During the countdown: where each rider will go.
  private drawArrows(cy: Cycle, head: { x: number; y: number }, now: number) {
    const t = (now % 900) / 900;
    for (let i = 0; i < 3; i += 1) {
      const step = (i + t) * 1.4 + 1.6;
      this.drawChevron(head.x, head.y, cy.dir, step, COLOURS[cy.c], (1 - (i + t) / 3) * 0.9);
    }
  }

  private drawBurst(cy: Cycle, now: number) {
    if (cy.burstAt === null) cy.burstAt = now;
    const age = (now - cy.burstAt) / 700;
    if (age >= 1) return;
    const ctx = this.ctx;
    const [x, y] = this.xy(cy.cells[cy.cells.length - 1]);
    const cx = x + 0.5;
    const cyy = y + 0.5;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1 - age;
    ctx.strokeStyle = COLOURS[cy.c];
    ctx.fillStyle = COLOURS[cy.c];
    ctx.lineWidth = 0.35;
    ctx.beginPath();
    ctx.arc(cx, cyy, 0.6 + age * 4.2, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2 + cy.c;
      const r = 0.4 + age * (2.5 + (i % 3));
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r, cyy + Math.sin(a) * r, 0.22 * (1 - age) + 0.05, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Names next to the heads, in screen pixels so the text stays sharp. Your
  // own label goes first; each label takes the first spot around its head
  // that no earlier label covers.
  private drawLabels(heads: { x: number; y: number; dir: Dir }[]) {
    const ctx = this.ctx;
    const unit = this.px / this.size; // CSS pixels per cell
    const size = Math.round(Math.max(10, Math.min(14, this.px / 44)));
    const now = performance.now();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const order = this.cycles.map((_, i) => i).sort((i, j) => Number(this.cycles[j].id === this.me?.id) - Number(this.cycles[i].id === this.me?.id));
    for (const i of order) {
      const cy = this.cycles[i];
      if (this.isOut(cy) && (cy.burstAt === null || now - cy.burstAt > 1500)) continue;
      const h = heads[i];
      const text = cy.id === this.me?.id ? `${short(cy.name)} (you)` : short(cy.name);
      const w = ctx.measureText(text).width;
      const hx = h.x * unit;
      const hy = h.y * unit;
      const gap = unit * 1.4 + 4;
      const above = { x: hx - w / 2, y: hy - gap - size / 2 };
      const below = { x: hx - w / 2, y: hy + gap + size / 2 };
      const right = { x: hx + gap, y: hy };
      const left = { x: hx - gap - w, y: hy };
      const spots = h.dir === 'left' || h.dir === 'right' ? [above, below, right, left] : [right, left, above, below];
      const fit = (p: { x: number; y: number }) => {
        const x = Math.max(4, Math.min(this.px - w - 4, p.x));
        const y = Math.max(size, Math.min(this.px - size, p.y));
        return { x, y, w, h: size + 4 };
      };
      const free = (r: { x: number; y: number; w: number; h: number }) => placed.every((o) => r.x + r.w + 3 < o.x || o.x + o.w + 3 < r.x || r.y + r.h / 2 < o.y - o.h / 2 || o.y + o.h / 2 < r.y - r.h / 2);
      const spot = spots.map(fit).find(free) ?? fit(spots[0]);
      placed.push(spot);
      ctx.globalAlpha = this.isOut(cy) ? 0.5 : 1;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(4, 6, 11, 0.85)';
      ctx.strokeText(text, spot.x, spot.y);
      ctx.fillStyle = COLOURS[cy.c];
      ctx.fillText(text, spot.x, spot.y);
    }
    ctx.globalAlpha = 1;
  }
}
