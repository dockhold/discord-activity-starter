// HTTP routes: the setup page, config, static files and POST /api/token
// against a fake of Discord's API.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../src/config.js';
import { deriveSessionKey, verifySession } from '../src/session.js';
import {
  CLIENT_ID, HOST, INSTANCE, SECRET, USER_A, allLogs, assertNoSensitive, connect, raw, sensitive, startApp, startFakeDiscord,
} from './helpers.js';

const FORGED = {
  Host: 'evil.example',
  'X-Forwarded-Host': 'evil.example',
  'X-Forwarded-For': '203.0.113.7',
  'X-Forwarded-Proto': 'http',
  'X-Real-IP': '203.0.113.8',
  'CF-Connecting-IP': '203.0.113.9',
};

// POST with headers sent exactly as given, forged Host included.
async function post(url, body, headers = {}) {
  const r = await raw('POST', url, { headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, headers: { get: (n) => r.headers[n.toLowerCase()] ?? null }, json: async () => JSON.parse(r.text), text: async () => r.text };
}

test('unconfigured: health, the setup page and closed APIs', async () => {
  const s = await startApp({ config: readConfig({ DOCKHOLD_APP_HOSTNAME: HOST }) });
  try {
    const health = await fetch(`${s.url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const page = await raw('GET', `${s.url}/`, { headers: FORGED });
    assert.equal(page.status, 200);
    const html = page.text;
    for (const want of ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', "the app&#39;s Variables tab", 'Secrets in the dashboard sidebar', `<code>${HOST}</code>`, 'https://127.0.0.1', 'Enable Activities', 'URL Mappings']) {
      assert.ok(html.includes(want), `setup page names ${want}`);
    }
    assert.ok(!html.includes('evil.example'), 'a forged Host does not reach the page');
    assert.ok(!html.includes('<script'), 'the setup page runs no script');
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);

    assert.equal((await fetch(`${s.url}/.proxy/health`)).status, 200);
    assert.equal((await fetch(`${s.url}/api/config`)).status, 503);
    assert.equal((await post(`${s.url}/api/token`, { code: 'abc', instance_id: INSTANCE })).status, 503);
    const ws = connect(s.wsUrl);
    const closed = await ws.closed;
    assert.equal(closed.status, 503);
  } finally {
    await s.close();
  }
});

test('unconfigured without a platform hostname: the page says what to paste', async () => {
  const s = await startApp({ config: readConfig({}) });
  try {
    const html = (await raw('GET', `${s.url}/`, { headers: FORGED })).text;
    assert.ok(html.includes("your app's address without <code>https://</code>"));
    assert.ok(!html.includes('evil.example'));
  } finally {
    await s.close();
  }
});

test('configured: the client, config and static files, with and without /.proxy', async () => {
  const s = await startApp();
  try {
    for (const prefix of ['', '/.proxy']) {
      const index = await fetch(`${s.url}${prefix}/`);
      assert.equal(index.status, 200);
      assert.match(await index.text(), /<div id="app">/);
      assert.equal(index.headers.get('cache-control'), 'no-cache');
      assert.equal(index.headers.get('content-security-policy'), "default-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
      const asset = await fetch(`${s.url}${prefix}/assets/app-abc123.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get('content-type'), /^text\/javascript/);
      assert.match(asset.headers.get('cache-control'), /immutable/);
      const cfg = await raw('GET', `${s.url}${prefix}/api/config`, { headers: FORGED });
      assert.deepEqual(JSON.parse(cfg.text), { clientId: CLIENT_ID }, 'the client ID only, no host name');
    }
    const head = await fetch(`${s.url}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    for (const bad of ['/../package.json', '/%2e%2e/package.json', '/assets/../../package.json', '/..%2f..%2fpackage.json', '/%00', '/nope.js', '/api/nope']) {
      assert.equal((await raw('GET', `${s.url}${bad}`)).status, 404, bad);
    }
    assert.equal((await fetch(`${s.url}/`, { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(`${s.url}/api/token`)).status, 405);
  } finally {
    await s.close();
  }
});

test('POST /api/token: a good code returns the Discord token and our session', async () => {
  const discord = await startFakeDiscord({ codes: { 'goodcode123': USER_A, 'goodcode456': USER_A } });
  sensitive.add('goodcode123').add('goodcode456');
  const s = await startApp({ discordApiBase: discord.base });
  try {
    const t0 = Date.now();
    const res = await post(`${s.url}/api/token`, { code: 'goodcode123', instance_id: INSTANCE }, FORGED);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    sensitive.add(body.session_token);
    assert.match(body.access_token, /^fake-access-token-/);
    assert.deepEqual(body.user, { id: USER_A.id, name: USER_A.name });
    assert.ok(body.session_expires_at >= t0 + 15 * 60 * 1000 - 1000 && body.session_expires_at <= Date.now() + 15 * 60 * 1000);
    const v = verifySession(deriveSessionKey(SECRET, CLIENT_ID), body.session_token, Date.now());
    assert.equal(v.ok, true);
    assert.equal(v.session.userId, USER_A.id);
    assert.equal(v.session.instanceId, INSTANCE);

    // What Discord was sent: the code and our credentials, no redirect_uri.
    assert.equal(discord.calls.token.length, 1);
    assert.deepEqual(Object.keys(discord.calls.token[0].form).sort(), ['client_id', 'client_secret', 'code', 'grant_type']);
    assert.equal(discord.calls.token[0].form.code, 'goodcode123');
    assert.equal(discord.calls.token[0].contentType, 'application/x-www-form-urlencoded');
    assert.equal(discord.calls.me.length, 1);

    // The same route with the /.proxy prefix.
    const viaProxy = await post(`${s.url}/.proxy/api/token`, { code: 'goodcode456', instance_id: INSTANCE });
    assert.equal(viaProxy.status, 200);
    sensitive.add((await viaProxy.json()).session_token);
  } finally {
    await s.close();
    await discord.close();
  }
});

test('POST /api/token: a bad code is refused and Discord\'s answer is not passed on', async () => {
  const discord = await startFakeDiscord({ codes: {} });
  sensitive.add('badcode789');
  const s = await startApp({ discordApiBase: discord.base });
  try {
    const res = await post(`${s.url}/api/token`, { code: 'badcode789', instance_id: INSTANCE });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!text.includes('badcode789'));
    assert.ok(!text.includes('invalid_grant'));
    assert.equal(discord.calls.me.length, 0);
    assert.ok(s.logs.some((l) => l.startsWith('Sign-in refused by Discord (HTTP 400)')));
  } finally {
    await s.close();
    await discord.close();
  }
});

test('POST /api/token: Discord errors map to plain answers', async () => {
  for (const [status, want] of [[401, 400], [429, 503], [500, 502]]) {
    const discord = await startFakeDiscord({ tokenStatus: status });
    const s = await startApp({ discordApiBase: discord.base });
    try {
      const res = await post(`${s.url}/api/token`, { code: `forced${status}`, instance_id: INSTANCE });
      assert.equal(res.status, want, `Discord ${status}`);
    } finally {
      await s.close();
      await discord.close();
    }
  }
  const s = await startApp({ discordApiBase: 'http://127.0.0.1:9/api/v10' });
  try {
    assert.equal((await post(`${s.url}/api/token`, { code: 'unreachable1', instance_id: INSTANCE })).status, 502);
  } finally {
    await s.close();
  }
});

test('POST /api/token: malformed and oversized requests never reach Discord', async () => {
  const discord = await startFakeDiscord({ codes: {} });
  const s = await startApp({ discordApiBase: discord.base });
  try {
    for (const body of ['not json', '{}', JSON.stringify({ code: 'abc' }), JSON.stringify({ code: 'a b', instance_id: INSTANCE }), JSON.stringify({ code: 'abc', instance_id: 'bad id!' }), JSON.stringify({ code: 7, instance_id: INSTANCE })]) {
      assert.equal((await post(`${s.url}/api/token`, body)).status, 400, body);
    }
    const big = JSON.stringify({ code: 'abc', instance_id: INSTANCE, pad: 'x'.repeat(5000) });
    assert.equal((await post(`${s.url}/api/token`, big)).status, 413);
    assert.equal(discord.calls.token.length, 0);
  } finally {
    await s.close();
    await discord.close();
  }
});

test('POST /api/token: a code gets three tries, whatever X-Forwarded-For says', async () => {
  const discord = await startFakeDiscord({ codes: {} });
  sensitive.add('replayedcode1');
  const s = await startApp({ discordApiBase: discord.base });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await post(`${s.url}/api/token`, { code: 'replayedcode1', instance_id: INSTANCE }, { 'X-Forwarded-For': `198.51.100.${i}`, 'X-Real-IP': `198.51.100.${i}` });
      statuses.push(res.status);
      if (res.status === 429) assert.equal(res.headers.get('retry-after'), '60');
    }
    assert.deepEqual(statuses, [400, 400, 400, 429, 429]);
    assert.equal(discord.calls.token.length, 3);
  } finally {
    await s.close();
    await discord.close();
  }
});

test('POST /api/token: a shared budget of 120 sign-ins, whatever the headers say', async () => {
  const discord = await startFakeDiscord({ codes: {} });
  const frozen = Date.now(); // a stopped clock: the bucket does not refill during the test
  const s = await startApp({ discordApiBase: discord.base, now: () => frozen });
  try {
    const statuses = [];
    for (let i = 0; i < 125; i += 1) {
      const res = await post(`${s.url}/api/token`, { code: `flood${i}`, instance_id: INSTANCE }, { 'X-Forwarded-For': `198.51.100.${i % 250}`, 'CF-Connecting-IP': `198.51.100.${i % 250}`, Host: `h${i}.example` });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses.slice(0, 120), Array(120).fill(400));
    assert.deepEqual(statuses.slice(120), Array(5).fill(429));
    assert.equal(discord.calls.token.length, 120);
    assert.equal(s.logs.filter((l) => l.startsWith('Sign-in limit reached')).length, 1, 'logged once, not per request');
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
  } finally {
    await s.close();
    await discord.close();
  }
});

test('POST /api/token: anything but application/json is refused with 415', async () => {
  const discord = await startFakeDiscord({ codes: {} });
  const s = await startApp({ discordApiBase: discord.base });
  try {
    const body = JSON.stringify({ code: 'typecode1', instance_id: INSTANCE });
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      const r = await raw('POST', `${s.url}/api/token`, { headers: type ? { 'Content-Type': type } : {}, body });
      assert.equal(r.status, 415, type || 'no Content-Type');
    }
    const ok = await raw('POST', `${s.url}/api/token`, { headers: { 'Content-Type': 'application/json; charset=utf-8' }, body });
    assert.equal(ok.status, 400, 'JSON with a charset gets through to the code check');
    assert.equal(discord.calls.token.length, 1);
  } finally {
    await s.close();
    await discord.close();
  }
});

test("POST /api/token: Discord's Retry-After pauses sign-ins without calling Discord", async () => {
  const discord = await startFakeDiscord({ tokenStatus: 429, retryAfter: '2' });
  const s = await startApp({ discordApiBase: discord.base });
  try {
    const first = await post(`${s.url}/api/token`, { code: 'busy1', instance_id: INSTANCE });
    assert.equal(first.status, 503);
    assert.equal(first.headers.get('retry-after'), '2');
    const second = await post(`${s.url}/api/token`, { code: 'busy2', instance_id: INSTANCE });
    assert.equal(second.status, 503);
    assert.ok(['1', '2'].includes(second.headers.get('retry-after')), second.headers.get('retry-after'));
    assert.equal(discord.calls.token.length, 1, 'the second request did not reach Discord');
    await new Promise((r) => setTimeout(r, 2100));
    await post(`${s.url}/api/token`, { code: 'busy3', instance_id: INSTANCE });
    assert.equal(discord.calls.token.length, 2, 'after the wait, Discord is asked again');
    assert.equal(s.logs.filter((l) => l.startsWith('Discord asked this app to wait 2 s')).length, 1);
  } finally {
    await s.close();
    await discord.close();
  }
});

test('no secret, token or code in any log line of this file', () => {
  for (let i = 0; i < 125; i += 1) sensitive.add(`flood${i}`);
  assert.ok(allLogs.length > 0);
  assertNoSensitive(allLogs, assert);
});

