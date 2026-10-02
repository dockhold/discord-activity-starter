// Client side of tests/smoke.sh. Runs inside a container made from the image
// under test, on the same isolated network as the app, with the image's own
// Node and ws. Prints one PASS or FAIL line per check and exits non-zero if
// any check failed.
//
// Usage: node /probe.mjs <base url> <unconfigured|configured|hold> <host>
// Needs SMOKE_SECRET (the app's DISCORD_CLIENT_SECRET) for "configured" and
// "hold", to sign session tokens the way the server does. Writes every token
// and code it used to /work/sensitive, so the smoke test can look for them in
// the app's log.

import { appendFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire('/app/server/package.json');
const WebSocket = require('ws');
const { deriveSessionKey, signSession } = await import('/app/server/src/session.js');

const [base, mode, appHost] = process.argv.slice(2);
const wsBase = `${base.replace(/^http/, 'ws')}`;
const CLIENT_ID = '123456789012345678';
const INSTANCE = 'i-1276580072400224306-gc-912952092627435520-912954213460484116';
const A = { id: '111111111111111111', name: 'Ana' };
const B = { id: '222222222222222222', name: 'Bo' };
const FORGED = { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'http', 'X-Real-IP': '203.0.113.8' };
let failed = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` [${detail}]` : ''}`);
  if (!ok) failed += 1;
}

function remember(value) {
  appendFileSync('/work/sensitive', `${value}\n`);
}

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}${path}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

function mint(user, { secret = process.env.SMOKE_SECRET, clientId = CLIENT_ID, nowMs = Date.now(), instanceId = INSTANCE } = {}) {
  const { token } = signSession(deriveSessionKey(secret, clientId), { userId: user.id, name: user.name, instanceId }, nowMs, 15 * 60 * 1000);
  remember(token);
  return token;
}

// Opens a socket with the given subprotocols (the page sends
// ['activity-session', <session token>]), records messages and the close.
function socket({ protocols = [], headers, path = '/ws' } = {}) {
  const ws = new WebSocket(`${wsBase}${path}`, protocols, { headers });
  const t0 = Date.now();
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
  ws.on('error', () => {});
  const closed = new Promise((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString(), ms: Date.now() - t0 }));
    ws.on('unexpected-response', (_q, res) => resolve({ code: -1, status: res.statusCode, ms: Date.now() - t0 }));
  });
  const until = (pred, ms = 5000) => new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      const hit = messages.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() > deadline) return resolve(null);
      return setTimeout(tick, 20);
    };
    tick();
  });
  const send = (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  return { ws, messages, closed, until, send };
}

// The turn at right angles that points away from the centre of the board.
function outward(cy) {
  const x = cy.pts.at(-1) % 64;
  const y = Math.floor(cy.pts.at(-1) / 64);
  if (cy.dir === 'left' || cy.dir === 'right') return y < 31.5 ? 'up' : 'down';
  return x < 31.5 ? 'left' : 'right';
}

async function unconfigured() {
  check('/health answers 200', (await req('GET', '/health')).status === 200);
  const page = await req('GET', '/', { headers: FORGED });
  check('/ answers the setup page', page.status === 200 && page.text.includes('This Discord Activity needs two values'));
  for (const want of ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'Variables tab', 'Secrets in the dashboard sidebar', `<code>${appHost}</code>`, 'Enable Activities', 'URL Mappings', 'https://127.0.0.1']) {
    check(`setup page names ${want}`, page.text.includes(want));
  }
  check('a forged Host does not reach the setup page', !page.text.includes('evil.example'));
  check('/api/config answers 503', (await req('GET', '/api/config')).status === 503);
  check('/api/token answers 503', (await req('POST', '/api/token', { headers: { 'Content-Type': 'application/json' }, body: '{"code":"x","instance_id":"i-1"}' })).status === 503);
  const s = socket();
  const c = await s.closed;
  check('the WebSocket is refused (503)', c.status === 503, JSON.stringify(c));
}

async function configured() {
  for (const prefix of ['', '/.proxy']) {
    const index = await req('GET', `${prefix}/`);
    check(`${prefix || ''}/ serves the game page`, index.status === 200 && index.text.includes('<main id="app">'));
    const asset = index.text.match(/\/assets\/index-[\w-]+\.js/)?.[0];
    const js = asset ? await req('GET', `${prefix}${asset}`) : { status: 0, headers: {} };
    check(`${prefix || ''}/assets serves the built script`, js.status === 200 && /javascript/.test(js.headers['content-type'] ?? ''));
    check(`${prefix || ''}/ carries the game page's Content-Security-Policy`, index.headers['content-security-policy'] === "default-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'", index.headers['content-security-policy']);
    const cfg = await req('GET', `${prefix}/api/config`, { headers: FORGED });
    check(`${prefix || ''}/api/config gives the client ID only`, cfg.status === 200 && cfg.text === `{"clientId":"${CLIENT_ID}"}`, cfg.text);
  }
  check('/.proxy/health answers 200', (await req('GET', '/.proxy/health')).status === 200);

  // Sign-in refusals at the handshake: 401, and no socket.
  const edited = (() => {
    const [b, mac] = mint(A).split('.');
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    p.sub = B.id;
    return `${Buffer.from(JSON.stringify(p)).toString('base64url')}.${mac}`;
  })();
  const refusals = [
    ['no subprotocol', []],
    ['no token', ['activity-session']],
    ['a junk token', ['activity-session', 'junk']],
    ['an expired token', ['activity-session', mint(A, { nowMs: Date.now() - 16 * 60 * 1000 })]],
    ['a token signed with another key', ['activity-session', mint(A, { secret: 'not-the-app-secret-0123456789' })]],
    ['a token from another Discord application', ['activity-session', mint(A, { clientId: '987654321098765432' })]],
    ['a token edited to another user', ['activity-session', edited]],
    ['a user ID instead of a token', ['activity-session', A.id]],
  ];
  for (const [name, protocols] of refusals) {
    const c = await socket({ protocols }).closed;
    check(`a socket presenting ${name} is refused at the handshake (401)`, c.status === 401 && c.ms < 2000, JSON.stringify(c));
  }
  const forged = await socket({ headers: { ...FORGED, 'X-Forwarded-User': A.id, 'X-Discord-User-Id': A.id } }).closed;
  check('forged X-Forwarded-* and Host on the upgrade confer nothing (401)', forged.status === 401, JSON.stringify(forged));

  // A round of Trails. Identity comes from the token even when a message
  // claims another.
  const pa = socket({ protocols: ['activity-session', mint(A)] });
  const pb = socket({ protocols: ['activity-session', mint(B)] });
  const wa = await pa.until((m) => m.t === 'welcome');
  await pb.until((m) => m.t === 'welcome');
  check('a valid token signs in during the handshake, no message sent', wa?.you?.id === A.id, JSON.stringify(wa));
  pa.send({ t: 'ride', userId: B.id, player: { id: B.id, name: 'Bo' } });
  const riding = await pa.until((m) => (m.t === 'state' || m.t === 'roster') && m.riders.length > 0);
  check('identity comes from the token, not the message body', JSON.stringify(riding?.riders?.map((r) => r.id)) === JSON.stringify([A.id]), JSON.stringify(riding?.riders));
  pb.send({ t: 'ride' });
  const set = await pa.until((m) => m.t === 'state' && m.phase === 'countdown' && m.cycles.length === 2);
  check('two riders get a countdown with both cycles', Boolean(set), JSON.stringify(set));
  const ib = set ? set.cycles.findIndex((cy) => cy.id === B.id) : -1;
  pb.send({ t: 'turn', d: 'up', id: A.id }); // during the countdown: queued for B's own cycle only
  await pa.until((m) => m.t === 'phase' && m.phase === 'play', 6000);
  if (set) pb.send({ t: 'turn', d: outward(set.cycles[ib]) }); // B steers into the nearest wall
  const over = await pa.until((m) => m.t === 'phase' && m.phase === 'results', 12000);
  check('two riders play a round over the network, the server names the winner', over?.result?.winner?.id === A.id, JSON.stringify(over));
  const ticks = pa.messages.filter((m) => m.t === 'tick');
  check('ticks arrive in order, each well under 1 KB', ticks.length > 5 && ticks.every((m, k) => m.n === k + 1 && JSON.stringify(m).length < 1024), JSON.stringify(ticks.slice(-3)));
  const here = await pa.until((m) => (m.t === 'state' || m.t === 'roster') && m.people.length === 2);
  check('the list of who is here names both players', Boolean(here));

  // Bounds: the offending socket is closed, everyone else carries on.
  const big = socket({ protocols: ['activity-session', mint(A)] });
  await big.until((m) => m.t === 'welcome');
  big.send(JSON.stringify({ t: 'pong', pad: 'x'.repeat(4096) }));
  const bc = await big.closed;
  check('a message over 4 KB closes that socket (1009)', bc.code === 1009, JSON.stringify(bc));
  const flood = socket({ protocols: ['activity-session', mint(B)] });
  await flood.until((m) => m.t === 'welcome');
  for (let i = 0; i < 100; i += 1) flood.send({ t: 'pong' });
  const fc = await flood.closed;
  check('more than 20 messages in a second closes that socket (1008)', fc.code === 1008, JSON.stringify(fc));
  check('the server is still up after both', (await req('GET', '/health')).status === 200);
  const mark = pb.messages.length;
  let next = null;
  for (const end = Date.now() + 8000; !next && Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    next = pb.messages.slice(mark).find((m) => m.t === 'tick' || (m.t === 'state' && m.phase === 'countdown'));
  }
  check('the riders already connected go on to the next round', Boolean(next), JSON.stringify(pb.messages.slice(mark).map((m) => m.t)));
  pa.ws.close();
  pb.ws.close();

  // POST /api/token: Discord is unreachable here, so every try fails upstream;
  // the fourth try of one code is refused before any upstream call.
  remember('smokecode123');
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await req('POST', '/api/token', {
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${i}`, 'X-Real-IP': `198.51.100.${i}`, Host: `h${i}.example` },
      body: JSON.stringify({ code: 'smokecode123', instance_id: INSTANCE }),
    });
    statuses.push(r.status);
  }
  check('/api/token: three tries per code, then 429, whatever X-Forwarded-For says', JSON.stringify(statuses) === '[502,502,502,429]', JSON.stringify(statuses));
  const bad = await req('POST', '/api/token', { headers: { 'Content-Type': 'application/json' }, body: '{"code":"bad code!","instance_id":"x"}' });
  check('/api/token refuses a malformed code (400)', bad.status === 400);
  const plain = await req('POST', '/api/token', { headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ code: 'smokecode456', instance_id: INSTANCE }) });
  check('/api/token refuses anything but JSON (415)', plain.status === 415);
}

// Holds sockets open until the app stops, then reports their close codes.
async function hold() {
  const socks = [A, B, A, { id: '333333333333333333', name: 'Cy' }].map((u) => socket({ protocols: ['activity-session', mint(u)] }));
  for (const s of socks) await s.until((m) => m.t === 'welcome');
  writeFileSync('/work/hold.ready', 'ready\n');
  const codes = [];
  for (const s of socks) codes.push((await s.closed).code);
  writeFileSync('/work/hold.result', `${codes.join(' ')}\n`);
}

if (mode === 'unconfigured') await unconfigured();
else if (mode === 'configured') await configured();
else if (mode === 'hold') await hold();
else throw new Error(`unknown mode ${mode}`);
process.exit(failed ? 1 : 0);
