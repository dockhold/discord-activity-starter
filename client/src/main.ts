// The game page Discord shows in the voice channel.
//
// 1. Ask our server for the Discord client ID (GET /api/config).
// 2. SDK ready(), then authorize with the `identify` scope only.
// 3. POST the code to /api/token. The server answers with a Discord access
//    token (used once, for the SDK's authenticate) and our session token.
// 4. Open the WebSocket with the session token as its second subprotocol.
//    The server checks it during the handshake; no message carries it.
// 5. Before reconnecting with an expired session, authorize again with
//    prompt "none" and ask /api/token for a new session.
//
// Every request uses a plain path (/api/..., /ws). Discord's proxy forwards
// them to the URL mapping for "/", and the server accepts /.proxy/ too.

import { DiscordSDK } from '@discord/embedded-app-sdk';
import { Trails, type GameMsg } from './trails';
import './style.css';

type Session = { token: string; expiresAt: number };
type Config = { clientId: string };

const RENEW_BEFORE_MS = 60_000;

const app = document.getElementById('app') as HTMLElement;
let sdk: DiscordSDK;
let config: Config;
let session: Session;
let socket: WebSocket | null = null;
let attempt = 0;
let game: Trails | null = null;
let connection = 'Connecting...';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function message(text: string, detail?: string) {
  app.replaceChildren(el('p', { className: 'status' }, text), ...(detail ? [el('p', { className: 'detail' }, detail)] : []));
}

async function errorText(res: Response) {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function main() {
  const res = await fetch('/api/config');
  if (!res.ok) {
    message('This Activity is not set up yet.', await errorText(res));
    return;
  }
  config = (await res.json()) as Config;

  // Outside Discord there is no frame_id, and the SDK cannot start.
  if (!new URLSearchParams(location.search).has('frame_id')) {
    message('This is a Discord Activity. Open it from a voice channel in Discord.');
    return;
  }

  sdk = new DiscordSDK(config.clientId);
  await sdk.ready();
  message('Signing in...');
  session = await signIn(true);
  await connect();
}

// Authorize, then trade the code for our session. The Discord access token
// goes to the SDK once and is not kept.
async function signIn(first: boolean): Promise<Session> {
  const { code } = await sdk.commands.authorize({
    client_id: config.clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, instance_id: sdk.instanceId }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const body = (await res.json()) as { access_token: string; session_token: string; session_expires_at: number };
  if (first) await sdk.commands.authenticate({ access_token: body.access_token });
  return { token: body.session_token, expiresAt: body.session_expires_at };
}

function scheduleReconnect(delayMs?: number) {
  attempt += 1;
  const wait = delayMs ?? Math.min(15_000, 500 * 2 ** attempt) + Math.random() * 500;
  setTimeout(() => {
    connect().catch((err: unknown) => {
      connection = `Could not reconnect: ${err instanceof Error ? err.message : String(err)}`;
      render();
      scheduleReconnect();
    });
  }, wait);
}

async function connect() {
  if (session.expiresAt - Date.now() < RENEW_BEFORE_MS) {
    connection = 'Renewing the session...';
    render();
    session = await signIn(false);
  }
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, ['activity-session', session.token]);
  let welcomed = false;
  socket = ws;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.t === 'ping') {
      ws.send('{"t":"pong"}');
      return;
    }
    if (msg.t === 'welcome') {
      welcomed = true;
      attempt = 0;
      connection = '';
      game ??= new Trails(app, send);
      game.setMe(msg.you);
      render();
    } else if (msg.t === 'error') {
      game?.showNotice(String(msg.message));
    } else if (msg.t === 'state' || msg.t === 'tick' || msg.t === 'phase' || msg.t === 'roster') {
      game?.receive(msg as GameMsg);
    }
  };
  ws.onclose = (ev) => {
    if (socket === ws) socket = null;
    if (ev.code === 4003) {
      connection = `Cannot join: ${ev.reason}. Trying again shortly.`;
      render();
      scheduleReconnect(15_000);
      return;
    }
    // A socket that closes before "welcome" was refused at the handshake
    // (the browser reports 1006): sign in again before the next try.
    if (!welcomed) session.expiresAt = 0;
    // A restart of the server ends the game: the next connection starts a
    // fresh room for this Activity instance.
    connection = ev.code === 1001 ? 'The server restarted. Reconnecting...' : 'Connection lost. Reconnecting...';
    render();
    scheduleReconnect();
  };
}

function send(msg: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

// Until the first "welcome" the page shows the connection state as plain
// text; after it, the game shows it in its header.
function render() {
  if (game) game.setConnection(connection);
  else message(connection || 'Connecting...');
}

main().catch((err: unknown) => {
  message('Something went wrong.', err instanceof Error ? err.message : String(err));
});
