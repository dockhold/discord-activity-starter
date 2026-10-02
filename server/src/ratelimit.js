// Rate limit for POST /api/token, kept in memory (one copy of the app).
//
// Every request reaches us through Discord's proxy, which exists to hide the
// player's address, and Discord documents no header that carries it. So the
// limit cannot be per player. It is two things instead:
//   * per authorization code: a few tries per code, so one code cannot be
//     replayed against Discord over and over;
//   * one global token bucket (a burst, refilled at a steady rate), so nobody
//     can make this app hammer Discord's token endpoint with made-up codes.
// X-Forwarded-For and friends are never read. Codes are kept only as a
// SHA-256 hash, never as the code itself.

import { createHash } from 'node:crypto';

export function createTokenLimiter({ triesPerCode, codeWindowMs, globalBurst, globalPerSecond, now = Date.now }) {
  const codes = new Map(); // sha256(code) -> { count, resetAt }
  let tokens = globalBurst;
  let refilledAt = now();

  function sweep(t) {
    for (const [k, v] of codes) if (v.resetAt <= t) codes.delete(k);
  }

  // Returns 'ok', 'global' or 'code'. A refused request uses no budget.
  return function check(code) {
    const t = now();
    // A clock that steps backwards refills nothing and takes nothing.
    const elapsed = Math.max(0, t - refilledAt);
    tokens = Math.min(globalBurst, tokens + (elapsed / 1000) * globalPerSecond);
    refilledAt = t;
    if (tokens < 1) return 'global';

    const key = createHash('sha256').update(code).digest('base64');
    let entry = codes.get(key);
    if (entry && entry.resetAt <= t) {
      codes.delete(key);
      entry = undefined;
    }
    if (entry && entry.count >= triesPerCode) return 'code';

    tokens -= 1;
    if (entry) entry.count += 1;
    else codes.set(key, { count: 1, resetAt: t + codeWindowMs });
    // The bucket bounds how many codes can be stored at once.
    if (codes.size > globalBurst * 2) sweep(t);
    return 'ok';
  };
}
