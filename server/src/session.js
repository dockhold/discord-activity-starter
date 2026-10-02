// Our own session token: proof that this server resolved a Discord user at
// sign-in. It is what the WebSocket accepts, so a Discord token never crosses
// the socket and a player cannot claim to be someone else.
//
// Format: base64url(JSON payload) "." base64url(HMAC-SHA256(key, payload part))
// The key is derived from DISCORD_CLIENT_SECRET with HKDF, a fixed label and
// the client ID, so the secret itself is never used as a signing key, a token
// from one Discord application is refused by another, and changing the secret
// ends every session.

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

const LABEL = 'discord-activity-starter session token v1';
const B64URL = /^[A-Za-z0-9_-]+$/;
const SNOWFLAKE = /^\d{15,22}$/;
export const INSTANCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TOKEN_LENGTH = 1024;
const CLOCK_SKEW_S = 60;

export function deriveSessionKey(clientSecret, clientId) {
  if (typeof clientSecret !== 'string' || clientSecret === '') {
    throw new Error('a client secret is required to derive the session key');
  }
  if (typeof clientId !== 'string' || !SNOWFLAKE.test(clientId)) {
    throw new Error('a client ID is required to derive the session key');
  }
  const info = Buffer.from(`${LABEL} ${clientId}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', Buffer.from(clientSecret, 'utf8'), Buffer.alloc(0), info, 32));
}

function mac(key, body) {
  return createHmac('sha256', key).update(body).digest();
}

export function signSession(key, { userId, name, instanceId }, nowMs, ttlMs) {
  const iat = Math.floor(nowMs / 1000);
  const payload = { v: 1, sub: userId, name, inst: instanceId, iat, exp: iat + Math.floor(ttlMs / 1000) };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { token: `${body}.${mac(key, body).toString('base64url')}`, expiresAt: payload.exp * 1000 };
}

// Returns { ok: true, session } or { ok: false, reason }, reason being
// 'malformed', 'signature' or 'expired'. The signature is compared in
// constant time before the payload is parsed.
export function verifySession(key, token, nowMs) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !B64URL.test(parts[0]) || !B64URL.test(parts[1])) return { ok: false, reason: 'malformed' };

  const expected = mac(key, parts[0]);
  const given = Buffer.from(parts[1], 'base64url');
  // One spelling per signature: other base64url spellings of the same bytes
  // (trailing bits set, padding) are refused before the comparison.
  if (given.toString('base64url') !== parts[1]) return { ok: false, reason: 'malformed' };
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' };

  let p;
  try {
    p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    !p || p.v !== 1 ||
    typeof p.sub !== 'string' || !SNOWFLAKE.test(p.sub) ||
    typeof p.name !== 'string' || p.name.length > 64 ||
    typeof p.inst !== 'string' || !INSTANCE_ID.test(p.inst) ||
    !Number.isInteger(p.iat) || !Number.isInteger(p.exp)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const now = Math.floor(nowMs / 1000);
  if (p.exp <= now) return { ok: false, reason: 'expired' };
  if (p.iat > now + CLOCK_SKEW_S) return { ok: false, reason: 'malformed' };
  return { ok: true, session: { userId: p.sub, name: p.name, instanceId: p.inst, expiresAt: p.exp * 1000 } };
}
