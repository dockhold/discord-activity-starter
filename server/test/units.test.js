import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readConfig, setupLogLine } from '../src/config.js';
import { createTokenLimiter } from '../src/ratelimit.js';
import { deriveSessionKey, signSession, verifySession } from '../src/session.js';
import { CLIENT_ID, OTHER_SECRET, SECRET, USER_A, USER_B, INSTANCE } from './helpers.js';

const OTHER_CLIENT_ID = '987654321098765432';

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const TTL = 15 * 60 * 1000;

test('session: a token verifies and carries the user, name and instance', () => {
  const key = deriveSessionKey(SECRET, CLIENT_ID);
  const { token, expiresAt } = signSession(key, { userId: USER_A.id, name: USER_A.name, instanceId: INSTANCE }, T0, TTL);
  assert.equal(expiresAt, T0 + TTL);
  const v = verifySession(key, token, T0 + 1000);
  assert.deepEqual(v, { ok: true, session: { userId: USER_A.id, name: USER_A.name, instanceId: INSTANCE, expiresAt: T0 + TTL } });
});

test('session: lasts 15 minutes and not a second more', () => {
  const key = deriveSessionKey(SECRET, CLIENT_ID);
  const { token } = signSession(key, { userId: USER_A.id, name: 'A', instanceId: INSTANCE }, T0, TTL);
  assert.equal(verifySession(key, token, T0 + TTL - 1000).ok, true);
  assert.deepEqual(verifySession(key, token, T0 + TTL), { ok: false, reason: 'expired' });
});

test('session: a token signed with another key is refused', () => {
  const { token } = signSession(deriveSessionKey(OTHER_SECRET, CLIENT_ID), { userId: USER_A.id, name: 'A', instanceId: INSTANCE }, T0, TTL);
  assert.deepEqual(verifySession(deriveSessionKey(SECRET, CLIENT_ID), token, T0), { ok: false, reason: 'signature' });
});

test('session: a token edited to name another user is refused', () => {
  const key = deriveSessionKey(SECRET, CLIENT_ID);
  const { token } = signSession(key, { userId: USER_A.id, name: 'A', instanceId: INSTANCE }, T0, TTL);
  const [body, mac] = token.split('.');
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  p.sub = USER_B.id;
  const forged = `${Buffer.from(JSON.stringify(p)).toString('base64url')}.${mac}`;
  assert.deepEqual(verifySession(key, forged, T0), { ok: false, reason: 'signature' });
});

test('session: a token from another Discord application is refused', () => {
  const { token } = signSession(deriveSessionKey(SECRET, OTHER_CLIENT_ID), { userId: USER_A.id, name: 'A', instanceId: INSTANCE }, T0, TTL);
  assert.deepEqual(verifySession(deriveSessionKey(SECRET, CLIENT_ID), token, T0), { ok: false, reason: 'signature' });
});

test('session: another spelling of the same signature bytes is refused', () => {
  const key = deriveSessionKey(SECRET, CLIENT_ID);
  const { token } = signSession(key, { userId: USER_A.id, name: 'A', instanceId: INSTANCE }, T0, TTL);
  const [body, sig] = token.split('.');
  // 32 bytes take 43 base64url characters; the last one carries 2 unused
  // bits. Setting them gives a different string that decodes to the same MAC.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(sig.at(-1));
  const variant = `${sig.slice(0, -1)}${alphabet[last | 1]}`;
  assert.notEqual(variant, sig);
  assert.deepEqual(Buffer.from(variant, 'base64url'), Buffer.from(sig, 'base64url'));
  assert.equal(verifySession(key, token, T0).ok, true);
  assert.deepEqual(verifySession(key, `${body}.${variant}`, T0), { ok: false, reason: 'malformed' });
});

test('session: malformed tokens are refused', () => {
  const key = deriveSessionKey(SECRET, CLIENT_ID);
  for (const bad of [undefined, null, 42, '', 'a', 'a.b.c', 'a.', '.b', 'ab$.cd', 'x'.repeat(2000)]) {
    assert.equal(verifySession(key, bad, T0).ok, false, String(bad).slice(0, 20));
  }
});

test('session: the key is derived, not the secret itself', () => {
  const key = deriveSessionKey(SECRET, CLIENT_ID);
  assert.equal(key.length, 32);
  assert.notDeepEqual(key, Buffer.from(SECRET));
  assert.notDeepEqual(key, createHash('sha256').update(SECRET).digest());
  assert.deepEqual(key, deriveSessionKey(SECRET, CLIENT_ID));
  assert.notDeepEqual(key, deriveSessionKey(OTHER_SECRET, CLIENT_ID));
  assert.throws(() => deriveSessionKey('', CLIENT_ID));
  assert.throws(() => deriveSessionKey(SECRET));
  assert.notDeepEqual(key, deriveSessionKey(SECRET, OTHER_CLIENT_ID));
});

test('config: nothing set names both values and where to set them', () => {
  const c = readConfig({});
  assert.equal(c.configured, false);
  assert.equal(c.port, 8080);
  const line = setupLogLine(c.problems);
  assert.match(line, /^Setup needed: /);
  assert.match(line, /DISCORD_CLIENT_ID is not set \(set it in the app's Variables tab\)/);
  assert.match(line, /DISCORD_CLIENT_SECRET is not set \(set it in Secrets in the dashboard sidebar\)/);
  assert.equal(line.split('\n').length, 1);
});

test('config: a wrong client ID is named, the secret is never echoed', () => {
  const c = readConfig({ DISCORD_CLIENT_ID: 'my-app', DISCORD_CLIENT_SECRET: SECRET });
  assert.equal(c.configured, false);
  const line = setupLogLine(c.problems);
  assert.match(line, /DISCORD_CLIENT_ID is not a Discord application ID/);
  assert.ok(!line.includes(SECRET));
  assert.ok(!line.includes('my-app'));
  assert.ok(!JSON.stringify(c.problems).includes(SECRET));
});

test('config: values are trimmed, a bad PORT refuses, a bad hostname is dropped', () => {
  const c = readConfig({ DISCORD_CLIENT_ID: ' 123456789012345678\n', DISCORD_CLIENT_SECRET: `${SECRET}\n`, PORT: '9000', DOCKHOLD_APP_HOSTNAME: 'My-App.dockhold.app' });
  assert.equal(c.configured, true);
  assert.equal(c.clientId, '123456789012345678');
  assert.equal(c.clientSecret, SECRET);
  assert.equal(c.port, 9000);
  assert.equal(c.appHostname, 'my-app.dockhold.app');
  assert.throws(() => readConfig({ PORT: 'eighty' }), /PORT/);
  assert.equal(readConfig({ DOCKHOLD_APP_HOSTNAME: 'https://x.dockhold.app' }).appHostname, '');
  assert.equal(readConfig({ DOCKHOLD_APP_HOSTNAME: '<script>' }).appHostname, '');
});

test('rate limit: three tries per code, then refused until the window ends', () => {
  let t = T0;
  const check = createTokenLimiter({ triesPerCode: 3, codeWindowMs: 600_000, globalBurst: 120, globalPerSecond: 2, now: () => t });
  assert.deepEqual([check('c1'), check('c1'), check('c1'), check('c1')], ['ok', 'ok', 'ok', 'code']);
  assert.equal(check('c2'), 'ok');
  t += 600_000;
  assert.equal(check('c1'), 'ok');
});

test('rate limit: a shared bucket of 120, refilled at 2 a second; refusals cost nothing', () => {
  let t = T0;
  const check = createTokenLimiter({ triesPerCode: 3, codeWindowMs: 600_000, globalBurst: 120, globalPerSecond: 2, now: () => t });
  for (let i = 0; i < 120; i += 1) assert.equal(check(`code-${i}`), 'ok');
  assert.equal(check('one-more'), 'global');
  t += 499;
  assert.equal(check('one-more'), 'global');
  t += 1;
  assert.equal(check('one-more'), 'ok', 'half a second refills one');
  assert.equal(check('two-more'), 'global');
  t += 3_600_000;
  for (let i = 0; i < 120; i += 1) assert.equal(check(`later-${i}`), 'ok', 'refills to the burst, not past it');
  assert.equal(check('later-overflow'), 'global');
});

test('rate limit: a clock that steps back an hour does not put the bucket in debt', () => {
  let t = T0;
  const check = createTokenLimiter({ triesPerCode: 3, codeWindowMs: 600_000, globalBurst: 120, globalPerSecond: 2, now: () => t });
  for (let i = 0; i < 120; i += 1) assert.equal(check(`code-${i}`), 'ok');
  t -= 3_600_000;
  assert.equal(check('after-the-step'), 'global', 'still empty: the step back refills nothing');
  t += 500;
  assert.equal(check('half-a-second-later'), 'ok', 'half a second later one sign-in is allowed again');
});
