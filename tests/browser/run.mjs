// Browser check of Trails with the real Discord SDK bundle, a stand-in for
// the Discord client (harness.js) and a fake of Discord's API. Headless
// Chrome over the DevTools protocol. Two frames, two users, one room: they
// sign in, ride a round to the end, and the run saves screenshots of the
// lobby, the countdown, play and the results. Then a six-rider round (four
// more riders on plain sockets, one frame shrunk to a phone), then a restart
// and a restart with a new client secret.
//
// Not part of CI. Needs Chrome or Chromium (CHROME=<binary>, default
// google-chrome), and the client built and the server installed:
//   cd client && npm ci && npm run build && cd ../server && npm ci && cd ..
//   node tests/browser/run.mjs [screenshot folder]
// Prints one PASS or FAIL line per check and exits non-zero if any failed.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OUT = path.resolve(process.argv[2] ?? mkdtempSync(path.join(tmpdir(), 'trails-screens-')));
mkdirSync(OUT, { recursive: true });
const require = createRequire(`${REPO}/server/package.json`);
const WebSocket = require('ws');
const load = (file) => import(pathToFileURL(path.join(REPO, 'server', 'src', file)).href);
const { createServer } = await load('server.js');
const { readConfig } = await load('config.js');
const { deriveSessionKey, signSession } = await load('session.js');
const { SIZE } = await load('game.js');

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  [${detail}]`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INSTANCE = 'i-harness-1';
const ANA = '111111111111111111';
const BO = '222222222222222222';

// Fake Discord API: codes harnesscodeA* sign in Ana, harnesscodeB* sign in Bo.
const tokenCalls = [];
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.url.endsWith('/oauth2/token')) {
      const f = Object.fromEntries(new URLSearchParams(raw));
      tokenCalls.push(Object.keys(f).sort().join(','));
      const who = f.code?.startsWith('harnesscodeA') ? 'A' : f.code?.startsWith('harnesscodeB') ? 'B' : null;
      if (!who) { res.writeHead(400); return res.end('{"error":"invalid_grant"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ access_token: `tok${who}${tokenCalls.length}`, token_type: 'Bearer', scope: 'identify' }));
    }
    if (req.url.endsWith('/users/@me')) {
      const who = (req.headers.authorization ?? '').includes('tokA') ? 'A' : 'B';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(who === 'A' ? { id: ANA, username: 'ana', global_name: 'Ana' } : { id: BO, username: 'bo', global_name: 'Bo' }));
    }
    res.writeHead(404); return res.end();
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const apiBase = `http://127.0.0.1:${fake.address().port}/api/v10`;

const dist = mkdtempSync(path.join(tmpdir(), 'harness-dist-'));
cpSync(`${REPO}/client/dist`, dist, { recursive: true });
for (const f of ['harness.html', 'harness.js', 'harness.css']) cpSync(path.join(HERE, f), path.join(dist, f));

const SECRET1 = 'harness-secret-0123456789abcdef';
const configFor = (secret) => readConfig({ DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: secret, DOCKHOLD_APP_HOSTNAME: 'harness.dockhold.app' });
let config = configFor(SECRET1);
const logs = [];
let app = createServer({ config, discordApiBase: apiBase, clientDist: dist, log: (l) => logs.push(l) });
await new Promise((r) => app.httpServer.listen(0, '127.0.0.1', r));
const port = app.httpServer.address().port;

// Chrome with the DevTools protocol.
const profile = mkdtempSync(path.join(tmpdir(), 'harness-chrome-'));
const chrome = spawn(process.env.CHROME ?? 'google-chrome', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
while (!existsSync(`${profile}/DevToolsActivePort`)) await sleep(100);
await sleep(200);
const [cdpPort, cdpPath] = readFileSync(`${profile}/DevToolsActivePort`, 'utf8').trim().split('\n');
const cdp = new WebSocket(`ws://127.0.0.1:${cdpPort}${cdpPath}`);
await new Promise((r) => cdp.on('open', r));
let id = 0;
const pending = new Map();
const consoleLines = [];
cdp.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') consoleLines.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') consoleLines.push(`EXCEPTION ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  if (m.method === 'Log.entryAdded') consoleLines.push(`LOG ${m.params.entry.source} ${m.params.entry.level} ${m.params.entry.text}`);
});
const send = (method, params = {}, sessionId) => new Promise((resolve) => { id += 1; pending.set(id, resolve); cdp.send(JSON.stringify({ id, method, params, sessionId })); });
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1588, height: 576, deviceScaleFactor: 2, mobile: false }, sessionId);
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  return r.result?.result?.value;
};
const until = async (expr, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await evaluate(expr).catch(() => null);
    if (v) return v;
    await sleep(40);
  }
  return null;
};
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  console.log(`INFO  screenshot ${file}`);
  return file;
}
const both = (cond) => `(() => { const a = view('a'), b = view('b'); return a && b && a.pill !== undefined && b.pill !== undefined && (${cond}) ? {a, b} : null; })()`;
await send('Page.navigate', { url: `http://127.0.0.1:${port}/harness.html` }, sessionId);

// An autopilot that reads the server's room (the test driver may peek) and
// steers away from walls and trails, the way a player would.
const STEP = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const KEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const room = () => app.rooms.get(INSTANCE);
function space(r, x, y, d) {
  let n = 0;
  for (let cx = x + STEP[d][0], cy = y + STEP[d][1]; cx >= 0 && cy >= 0 && cx < SIZE && cy < SIZE && !r.grid[cy * SIZE + cx]; cx += STEP[d][0], cy += STEP[d][1]) n += 1;
  return n;
}
function advise(userId, { margin = 3, wander = 0 } = {}) {
  const r = room();
  if (!r || r.phase !== 'play') return null;
  const cy = r.cycleOf(userId);
  if (!cy?.alive || cy.queue.length) return null;
  const ahead = space(r, cy.x, cy.y, cy.dir);
  const sides = cy.dir === 'up' || cy.dir === 'down' ? ['left', 'right'] : ['up', 'down'];
  const best = sides.map((d) => [d, space(r, cy.x, cy.y, d)]).sort((p, q) => q[1] - p[1])[0];
  if (ahead <= margin && best[1] > ahead) return best[0];
  if (wander && Math.random() < wander && best[1] > 6) return best[0];
  return null;
}
const pilots = new Set();
function pilot(userId, steer, opts) {
  let lastTick = -1;
  const t = setInterval(() => {
    const r = room();
    if (!r || r.n === lastTick) return;
    lastTick = r.n;
    const d = advise(userId, opts);
    if (d) steer(d);
  }, 25);
  pilots.add(t);
  return () => { clearInterval(t); pilots.delete(t); };
}

// 1. Both frames sign in, see each other and the lobby.
const ready = await until(both(`a.people.length === 2 && b.people.length === 2 && a.big === 'Trails'`));
check('two frames sign in through the SDK and see each other in the lobby', Boolean(ready), JSON.stringify(await evaluate(`({a: view('a'), b: view('b'), commands})`)));
const cmds = await evaluate('commands');
const auth = cmds.filter((c) => c.includes(':AUTHORIZE:'));
check('authorize asks for identify only, with prompt none and the configured client ID', auth.length === 2 && auth.every((c) => c.includes('"scope":["identify"]') && c.includes('"prompt":"none"') && c.includes('"client_id":"123456789012345678"')), JSON.stringify(auth));
check('authenticate gets the Discord access token from /api/token', cmds.filter((c) => /:AUTHENTICATE:\{"access_token":"tok[AB]\d+"\}/.test(c)).length === 2, JSON.stringify(cmds.filter((c) => c.includes('AUTHENTICATE'))));
check('the token exchange sent no redirect_uri', tokenCalls.length === 2 && tokenCalls.every((k) => k === 'client_id,client_secret,code,grant_type'), JSON.stringify(tokenCalls));
check('the wide layout at 780 x 560, with a sharp canvas', ready?.a.wide === true && ready?.a.canvas?.[0] >= 800, JSON.stringify(ready?.a));
check('four turn buttons exist; hidden with a mouse, shown on touch', ready?.a.keys === 4 && ready?.a.padShown === false && /arrow keys or WASD/.test(ready?.a.help ?? ''), JSON.stringify(ready?.a));
check('watching, the arrow keys are left to the page (they scroll)', (await evaluate(`key('a', 'ArrowDown')`)) === false);
await shot('trails-lobby');

// 2. Both ride: a countdown with arrows in both frames.
await evaluate(`click('a', 'Ride')`);
await evaluate(`click('b', 'Ride')`);
const counting = await until(both(`a.overlay.includes('countdown') && b.overlay.includes('countdown') && a.on === 'Ride' && b.on === 'Ride'`), 5000);
check('Ride in both frames starts a countdown in both', Boolean(counting), JSON.stringify(await evaluate(`({a: view('a'), b: view('b')})`)));
const two = await until(both(`a.big === '2' && b.big === '2'`), 4000);
check('the countdown counts down, and tells each rider their colour', Boolean(two) && /^You are \w+, heading (up|down|left|right)\.$/.test(two.a.sub) && two.a.sub !== two.b.sub, JSON.stringify(two));
await sleep(350);
await shot('trails-countdown');

// 3. Play. A steers with the keyboard (and an autopilot near walls); B turns
//    once with a swipe, then rides straight into a wall.
const stopA = pilot(ANA, (d) => evaluate(`key('a', '${KEY[d]}')`), { margin: 3 });
const go = await until(both(`a.big === 'Go' && b.big === 'Go'`), 5000);
check('play starts with "Go" in both frames', Boolean(go), JSON.stringify(await evaluate(`({a: view('a'), b: view('b')})`)));
const live = await until(both(`a.pill === '2 of 2 riding' && a.overlay.includes('hidden')`), 3000);
check('then the board is clear and the header counts the riders', Boolean(live), JSON.stringify(await evaluate(`view('a')`)));
const r0 = room();
const anaStart = r0.cycleOf(ANA).dir;
const boStart = r0.cycleOf(BO).dir;
while (room().n < 4) await sleep(10);
// A turns towards the centre with a key; B turns with a swipe.
const toCentre = (cy) => (cy.dir === 'left' || cy.dir === 'right' ? (cy.y < 32 ? 'down' : 'up') : (cy.x < 32 ? 'right' : 'left'));
const anaTurn = toCentre(room().cycleOf(ANA));
check('riding, an arrow key is taken by the game', (await evaluate(`key('a', '${KEY[anaTurn]}')`)) === true);
const outward = (cy) => (cy.dir === 'left' || cy.dir === 'right' ? (cy.y < 32 ? 'up' : 'down') : (cy.x < 32 ? 'left' : 'right'));
const boTurn = outward(room().cycleOf(BO));
const swipeBy = { up: [0, -40], down: [0, 40], left: [-40, 0], right: [40, 0] }[boTurn];
await evaluate(`swipe('b', ${swipeBy[0]}, ${swipeBy[1]})`);
let turned = false;
for (const end = Date.now() + 1500; Date.now() < end && !turned; await sleep(15)) {
  turned = room().cycleOf(ANA).dir === anaTurn && room().cycleOf(BO).dir === boTurn;
}
check('a key press turns Ana and a swipe turns Bo (the server applied both)', turned, JSON.stringify({ anaStart, anaTurn, ana: room().cycleOf(ANA).dir, boStart, boTurn, bo: room().cycleOf(BO).dir }));
while (room().phase === 'play' && room().n < 9) await sleep(10);
await shot('trails-play');
const over = await until(both(`a.overlay.includes('results') && b.overlay.includes('results')`), 15000);
stopA();
check('a round to the end: Bo crashes, both frames show the winner', Boolean(over) && over.a.big === 'You win' && over.b.big === 'Ana wins' && /Next round in \d\./.test(over.b.sub), JSON.stringify(await evaluate(`({a: view('a'), b: view('b')})`)));
await sleep(250);
await shot('trails-results');
check('the scoreboard counts the win in both frames', over && /Ana\s*1/.test(over.b.scores.join('|')) && /Ana\s*1/.test(over.a.scores.join('|')), JSON.stringify(over?.b.scores));
const again = await until(both(`a.overlay.includes('countdown') && b.overlay.includes('countdown')`), 6000);
check('the next round starts by itself', Boolean(again), JSON.stringify(await evaluate(`({a: view('a'), b: view('b')})`)));

// 4. Watch: Bo leaves the next round; Ana practises alone.
await evaluate(`click('b', 'Watch')`);
const watching = await until(both(`b.on === 'Watch' && a.people.some((p) => p.startsWith('Bo') && p.includes('watching'))`), 4000);
check('Watch takes Bo out of the round; Ana\'s list shows Bo watching', Boolean(watching), JSON.stringify(await evaluate(`({a: view('a'), b: view('b')})`)));
const practice = await until(both(`a.overlay.includes('results') && a.big.startsWith('Survived') && b.big.startsWith('Ana survived')`), 20000);
check('a solo round is practice: "Survived N s" in both frames, no win counted', Boolean(practice) && /Ana\s*1/.test(practice.a.scores.join('|')), JSON.stringify(await evaluate(`({a: view('a'), b: view('b')})`)));
await evaluate(`click('a', 'Watch')`);
await until(both(`a.on === 'Watch' && a.big === 'Trails'`), 8000);

// 5. Showcase: six riders (the two frames and four bots on plain sockets).
//    Bo's frame becomes a phone: 390 x 780 with touch.
await send('Emulation.setDeviceMetricsOverride', { width: 1196, height: 800, deviceScaleFactor: 2, mobile: false }, sessionId);
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
await evaluate(`(() => { const b = document.getElementById('b'); b.width = '390'; b.height = '780'; return true; })()`);
await evaluate(`swipe('b', 0, 0)`);
const phone = await until(`(() => { const b = view('b'); return b && !b.wide && b.padShown && /Swipe/.test(b.help) ? b : null; })()`, 5000);
check('on a phone-sized frame with touch: board on top, four turn buttons shown, swipe help', Boolean(phone), JSON.stringify(await evaluate(`view('b')`)));

const key = deriveSessionKey(SECRET1, '123456789012345678');
// Mira's name is long and has an emoji where a cut by UTF-16 units would
// split it.
const MIRA = 'Mira the Racer\u{1F3CD}\uFE0F\u{1F3C1}!';
const bots = ['Kai', MIRA, 'Juno', 'Teo'].map((name, i) => {
  const uid = String(300000000000000000n + BigInt(i));
  const { token } = signSession(key, { userId: uid, name, instanceId: INSTANCE }, Date.now(), 15 * 60 * 1000);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['activity-session', token]);
  ws.on('message', (d) => { if (JSON.parse(d.toString()).t === 'ping') ws.send('{"t":"pong"}'); });
  ws.on('error', () => {});
  return { uid, ws };
});
await Promise.all(bots.map((b) => new Promise((r) => b.ws.on('open', r))));
await evaluate(`click('a', 'Ride')`);
await evaluate(`click('b', 'Ride')`);
for (const b of bots) b.ws.send('{"t":"ride"}');
const six = await until(both(`a.overlay.includes('countdown') && a.people.length === 6`), 6000);
check('six riders in one room: four more join on plain sockets', Boolean(six) && room().cycles.length === 6, JSON.stringify({ six: Boolean(six), cycles: room()?.cycles.length }));
check('a long name is cut without splitting its emoji', six?.a.people.some((p) => p.startsWith('Mira the Racer\u{1F3CD}\uFE0F\u2026')), JSON.stringify(six?.a.people));
const stops = [
  pilot(ANA, (d) => evaluate(`key('a', '${KEY[d]}')`), { margin: 3, wander: 0.06 }),
  pilot(BO, (d) => evaluate(`key('b', '${KEY[d]}')`), { margin: 4, wander: 0.08 }),
  ...bots.map((b, i) => pilot(b.uid, (d) => b.ws.send(JSON.stringify({ t: 'turn', d })), { margin: 2 + (i % 3), wander: 0.05 + i * 0.02 })),
];
await until(both(`a.pill.includes('riding')`), 6000);
// Early in the round, while Bo is sure to be riding: a button turns Bo.
while (room().phase === 'play' && room().n < 3) await sleep(5);
const boCy = room().cycleOf(BO);
const side = boCy.dir === 'up' || boCy.dir === 'down' ? 'left' : 'up';
await evaluate(`(() => { const d = doc('b'); const k = d.querySelector('.key-${side}'); k.dispatchEvent(new d.defaultView.PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' })); return true; })()`);
let pressed = false;
for (const end = Date.now() + 1000; Date.now() < end && !pressed; await sleep(5)) pressed = room().cycleOf(BO).dir === side || room().cycleOf(BO).queue.includes(side);
check('an on-screen button sends a turn', pressed, JSON.stringify({ side, alive: room().cycleOf(BO).alive, dir: room().cycleOf(BO).dir }));
while (room().phase === 'play' && room().n < 45) await sleep(10);
await shot('trails-showcase');
for (const s of stops) s(); // everyone rides straight on: the round ends soon
const showOver = await until(both(`a.overlay.includes('results') && b.overlay.includes('results')`), 30000);
check('the six-rider round ends with a result in both frames', Boolean(showOver), JSON.stringify(await evaluate(`({a: view('a'), b: view('b')})`)));
await sleep(300);
await shot('trails-showcase-results');
for (const b of bots) b.ws.close();
await evaluate(`click('a', 'Watch')`);
await evaluate(`click('b', 'Watch')`);
await until(both(`a.big === 'Trails' && b.big === 'Trails' && a.people.length === 2`), 10000);

// 6. Restart the server: both frames reconnect into a fresh room.
await app.close();
const gone = await until(`(() => { const a = view('a'); return a && /restarted/.test(a.pill) ? a : null; })()`, 5000);
check('a restart shows "The server restarted. Reconnecting..."', Boolean(gone), JSON.stringify(await evaluate(`view('a')`)));
app = createServer({ config, discordApiBase: apiBase, clientDist: dist, log: (l) => logs.push(l) });
await new Promise((r) => app.httpServer.listen(port, '127.0.0.1', r));
const back = await until(both(`a.big === 'Trails' && b.big === 'Trails' && a.people.length === 2 && b.people.length === 2 && a.scores.join() === 'No wins yet.' && !/Reconnecting/.test(a.pill)`), 30000);
check('after the restart both frames are back in a fresh room (no wins, nobody riding)', Boolean(back), JSON.stringify(await evaluate(`({a: view('a'), b: view('b')})`)));
const auth2 = (await evaluate('commands')).filter((c) => c.includes(':AUTHORIZE:'));
check('a valid session reconnects without signing in again', auth2.length === 2, JSON.stringify(auth2.length));

// 7. Restart with a new client secret: old sessions are refused at the
//    handshake; each frame signs in again with prompt "none".
await app.close();
config = configFor('rotated-secret-fedcba9876543210');
app = createServer({ config, discordApiBase: apiBase, clientDist: dist, log: (l) => logs.push(l) });
await new Promise((r) => app.httpServer.listen(port, '127.0.0.1', r));
const rejoined = await until(`(() => { const a = view('a'), b = view('b'); const auth = commands.filter((c) => c.includes(':AUTHORIZE:')); return auth.length >= 4 && a.people.length === 2 && b.people.length === 2 && !/Reconnecting|Could not/.test(a.pill) ? {a, b, auth: auth.length} : null; })()`, 40000);
check('a refused handshake leads to a new sign-in and back into the room', Boolean(rejoined), JSON.stringify(await evaluate(`({a: view('a'), b: view('b'), auth: commands.filter((c) => c.includes(':AUTHORIZE:')).length})`)));
const auth3 = (await evaluate('commands')).filter((c) => c.includes(':AUTHORIZE:'));
check('exactly one new authorize per frame, with prompt none', auth3.length === 4 && auth3.slice(2).every((c) => c.includes('"prompt":"none"')), JSON.stringify(auth3.length));
check('the old sessions were refused at the handshake', logs.some((l) => l.startsWith('Refused a WebSocket without a valid session')), JSON.stringify(logs));
check('authenticate ran only once per frame', (await evaluate('commands')).filter((c) => c.includes(':AUTHENTICATE:')).length === 2);
check('no exception in the page', !consoleLines.some((l) => l.startsWith('EXCEPTION')), consoleLines.join(' | '));
check('no Content-Security-Policy violation in the page', !consoleLines.some((l) => /Content Security Policy|Refused to/i.test(l)), consoleLines.join(' | '));
const page = await fetch(`http://127.0.0.1:${port}/`);
check('the game page is served with its Content-Security-Policy', page.headers.get('content-security-policy') === "default-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
console.log(`page console and log: ${JSON.stringify(consoleLines)}`);
check('no token in the server log', !logs.some((l) => /tok[AB]|harnesscode|harness-secret|rotated-secret|\.[A-Za-z0-9_-]{43}/.test(l)), logs.join(' | '));
console.log(`server log: ${JSON.stringify(logs)}`);

for (const t of pilots) clearInterval(t);
chrome.kill();
await app.close();
fake.close();
console.log(`screenshots in ${OUT}`);
console.log(`${results.filter(Boolean).length} passed, ${results.filter((x) => !x).length} failed`);
process.exit(results.every(Boolean) ? 0 : 1);
