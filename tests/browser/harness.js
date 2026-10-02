// Stands in for the Discord client: answers the SDK's handshake and commands
// for two Activity frames, as two different users.
const users = {
  a: { id: '111111111111111111', name: 'Ana' },
  b: { id: '222222222222222222', name: 'Bo' },
};
const counts = { a: 0, b: 0 };
window.commands = [];
window.addEventListener('message', (ev) => {
  if (!Array.isArray(ev.data)) return;
  const [op, payload] = ev.data;
  const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentWindow === ev.source);
  if (!frame) return;
  const who = frame.id;
  if (op === 0) {
    window.commands.push(`${who}:HANDSHAKE:${JSON.stringify(payload)}`);
    ev.source.postMessage([1, { cmd: 'DISPATCH', evt: 'READY', nonce: null, data: { v: 1, config: { api_endpoint: '//discord.com/api', environment: 'production' } } }], '*');
    return;
  }
  if (op !== 1) return;
  window.commands.push(`${who}:${payload.cmd}:${JSON.stringify(payload.args)}`);
  let data = null;
  if (payload.cmd === 'AUTHORIZE') {
    counts[who] += 1;
    data = { code: `harnesscode${who.toUpperCase()}${counts[who]}` };
  } else if (payload.cmd === 'AUTHENTICATE') {
    data = {
      access_token: payload.args.access_token,
      user: { username: users[who].name.toLowerCase(), discriminator: '0', id: users[who].id, public_flags: 0, global_name: users[who].name },
      scopes: ['identify'],
      expires: new Date(Date.now() + 600000).toISOString(),
      application: { description: '', id: '123456789012345678', name: 'Harness' },
    };
  }
  ev.source.postMessage([1, { cmd: payload.cmd, evt: null, nonce: payload.nonce, data }], '*');
});
window.doc = (who) => document.getElementById(who).contentDocument;
window.view = (who) => {
  const d = window.doc(who);
  if (!d) return null;
  const root = d.querySelector('.trails');
  if (!root) return { pre: [...d.querySelectorAll('#app > .status, #app > .detail')].map((e) => e.textContent) };
  const banner = d.querySelector('.banner');
  return {
    pill: d.querySelector('.pill')?.textContent ?? '',
    big: d.querySelector('.big')?.textContent ?? '',
    sub: d.querySelector('.sub')?.textContent ?? '',
    overlay: d.querySelector('.overlay')?.className ?? '',
    banner: banner && !banner.hidden ? banner.textContent : '',
    on: d.querySelector('.seg.on')?.textContent ?? '',
    rideDisabled: d.querySelector('.seg')?.disabled ?? null,
    people: [...d.querySelectorAll('.people li')].map((li) => li.textContent),
    scores: [...d.querySelectorAll('.scores li')].map((li) => li.textContent),
    wide: root.classList.contains('wide'),
    keys: d.querySelectorAll('.pad .key').length,
    padShown: d.defaultView.getComputedStyle(d.querySelector('.pad')).display !== 'none',
    help: d.querySelector('.help')?.textContent ?? '',
    canvas: (() => { const c = d.querySelector('canvas'); return c ? [c.width, c.height] : null; })(),
  };
};
window.click = (who, text) => {
  const b = [...window.doc(who).querySelectorAll('button')].find((x) => x.textContent === text);
  if (!b || b.disabled) return false;
  b.click();
  return true;
};
// A key press in a frame. Returns whether the page took it (preventDefault).
window.key = (who, key) => {
  const w = window.doc(who).defaultView;
  const ev = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  w.dispatchEvent(ev);
  return ev.defaultPrevented;
};
// A finger on the board, moved dx, dy CSS pixels in a few steps.
window.swipe = (who, dx, dy) => {
  const d = window.doc(who);
  const w = d.defaultView;
  const board = d.querySelector('.board');
  const r = board.getBoundingClientRect();
  const x0 = r.left + r.width / 2;
  const y0 = r.top + r.height / 2;
  const opts = (x, y) => ({ pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true });
  board.dispatchEvent(new w.PointerEvent('pointerdown', opts(x0, y0)));
  for (let i = 1; i <= 4; i += 1) board.dispatchEvent(new w.PointerEvent('pointermove', opts(x0 + (dx * i) / 4, y0 + (dy * i) / 4)));
  board.dispatchEvent(new w.PointerEvent('pointerup', opts(x0 + dx, y0 + dy)));
  return true;
};
