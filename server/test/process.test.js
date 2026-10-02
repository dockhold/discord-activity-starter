// The real entry point as a child process: the startup contract, SIGTERM,
// and what the process shows on its command line and in its output.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLIENT_ID, HOST, SECRET, USER_A, USER_B, USER_C, connect, signedIn } from './helpers.js';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function start(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY], {
    env: { PATH: process.env.PATH, PORT: String(port), DOCKHOLD_APP_HOSTNAME: HOST, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
  const deadline = Date.now() + 10_000;
  while (!out.includes('Listening on')) {
    if (Date.now() > deadline) throw new Error(`did not start: ${out}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return { child, port, url: `http://127.0.0.1:${port}`, output: () => out, exited };
}

test('unconfigured: serves, answers /health, logs one setup line, does not exit', async () => {
  const p = await start({});
  try {
    assert.equal((await fetch(`${p.url}/health`)).status, 200);
    assert.equal((await fetch(`${p.url}/`)).status, 200);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(p.child.exitCode, null, 'still running');
    const setup = p.output().split('\n').filter((l) => l.startsWith('Setup needed:'));
    assert.equal(setup.length, 1);
    assert.match(setup[0], /DISCORD_CLIENT_ID is not set \(set it in the app's Variables tab\)/);
    assert.match(setup[0], /DISCORD_CLIENT_SECRET is not set \(set it in Secrets in the dashboard sidebar\)/);
  } finally {
    p.child.kill('SIGTERM');
    await p.exited;
  }
});

test('a bad PORT refuses to start with one line', async () => {
  const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, PORT: 'eighty' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(out, /^Cannot start: PORT must be a whole number/);
});

test('SIGTERM with players connected: 1001 to each socket, exit 0 within 10 seconds', async () => {
  const p = await start({ DISCORD_CLIENT_ID: CLIENT_ID, DISCORD_CLIENT_SECRET: SECRET });
  const wsUrl = `ws://127.0.0.1:${p.port}/ws`;
  const sockets = [];
  for (const user of [USER_A, USER_B, USER_A, USER_C]) {
    const c = connect(wsUrl, { protocols: signedIn(user) });
    await c.open;
    await c.next('welcome');
    sockets.push(c);
  }

  // The secret arrives in the environment only: not on the command line.
  if (existsSync(`/proc/${p.child.pid}/cmdline`)) {
    const cmdline = readFileSync(`/proc/${p.child.pid}/cmdline`, 'utf8');
    assert.ok(!cmdline.includes(SECRET), 'the secret is not on the command line');
    assert.ok(cmdline.includes('index.js'));
  }

  const t0 = Date.now();
  p.child.kill('SIGTERM');
  const { code, at } = await p.exited;
  assert.equal(code, 0);
  assert.ok(at - t0 < 10_000, `exited after ${at - t0} ms`);
  for (const c of sockets) assert.equal((await c.closed).code, 1001);
  const out = p.output();
  assert.match(out, /SIGTERM received: closing connections\.\nStopped\./);
  assert.ok(!out.includes(SECRET));
});
