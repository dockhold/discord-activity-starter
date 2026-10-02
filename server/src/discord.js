// The two Discord API calls the server makes. Nothing here logs: callers log
// the outcome (a status code), never a code, a token or a response body.

const SNOWFLAKE = /^\d{15,22}$/;

// Seconds to wait after a 429, from Discord's Retry-After header or the
// body's retry_after, kept between 1 second and 10 minutes.
async function retryAfterS(res) {
  let s = Number(res.headers.get('retry-after'));
  if (!Number.isFinite(s) || s <= 0) {
    try {
      s = Number((await res.json())?.retry_after);
    } catch {
      s = NaN;
    }
  }
  return Math.min(600, Math.max(1, Math.ceil(Number.isFinite(s) && s > 0 ? s : 5)));
}

// Exchanges an authorization code from the SDK's authorize command for a
// Discord access token. An Activity sends no redirect_uri: the SDK's
// authorize has none, and Discord's own Activity examples leave it out.
export async function exchangeCode({ apiBase, clientId, clientSecret, code, timeoutMs }) {
  let res;
  try {
    res = await fetch(`${apiBase}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, kind: 'unreachable' };
  }
  if (res.status === 429) {
    const wait = await retryAfterS(res);
    await res.body?.cancel().catch(() => {});
    return { ok: false, kind: 'busy', status: res.status, retryAfterS: wait };
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    return { ok: false, kind: res.status >= 500 ? 'unreachable' : 'refused', status: res.status };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, kind: 'unreachable', status: res.status };
  }
  if (typeof body?.access_token !== 'string' || body.access_token === '' || body.access_token.length > 512) {
    return { ok: false, kind: 'unreachable', status: res.status };
  }
  return { ok: true, accessToken: body.access_token };
}

// Resolves the signed-in Discord user once, with the token just issued.
export async function fetchUser({ apiBase, accessToken, timeoutMs }) {
  let res;
  try {
    res = await fetch(`${apiBase}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, kind: 'unreachable' };
  }
  if (res.status === 429) {
    const wait = await retryAfterS(res);
    await res.body?.cancel().catch(() => {});
    return { ok: false, kind: 'busy', status: res.status, retryAfterS: wait };
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    return { ok: false, kind: 'unreachable', status: res.status };
  }
  let u;
  try {
    u = await res.json();
  } catch {
    return { ok: false, kind: 'unreachable', status: res.status };
  }
  if (typeof u?.id !== 'string' || !SNOWFLAKE.test(u.id)) return { ok: false, kind: 'unreachable', status: res.status };
  const display = typeof u.global_name === 'string' && u.global_name.trim() ? u.global_name : u.username;
  // At most 32 characters (Discord's own limit), cut on whole characters.
  const name = typeof display === 'string' && display.trim() ? [...display.trim()].slice(0, 32).join('') : 'Player';
  return { ok: true, user: { id: u.id, name } };
}
