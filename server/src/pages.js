// The setup page (shown on / until both values are set) and the static files
// of the built client. Neither reads the Host header: the address shown on the
// setup page comes from DOCKHOLD_APP_HOSTNAME, which Dockhold sets for every app.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { PLACES } from './config.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function setupPage({ problems, appHostname }) {
  const target = appHostname
    ? `<code>${escapeHtml(appHostname)}</code>`
    : "your app's address without <code>https://</code> (for example <code>my-activity-a1b2c3.dockhold.app</code>)";
  const missing = problems
    .map((p) => `<li><code>${escapeHtml(p.name)}</code> ${escapeHtml(p.text)}. Set it in ${escapeHtml(PLACES[p.name])}.</li>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Discord Activity: setup needed</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; color: #1f2328; background: #fff; }
code { background: #f0f1f3; padding: 0.1em 0.3em; border-radius: 4px; word-break: break-all; }
h1 { font-size: 1.5rem; }
li { margin: 0.4rem 0; }
.note { border-left: 4px solid #5865f2; padding: 0.2rem 0.8rem; background: #f4f5ff; }
@media (prefers-color-scheme: dark) {
  body { color: #e6e6e6; background: #16171a; }
  code { background: #2a2c31; }
  .note { background: #1f2133; }
}
</style>
</head>
<body>
<h1>This Discord Activity needs two values</h1>
<p>The server is running. It waits for these before it serves the game:</p>
<ul>
${missing}
</ul>
<h2>In Discord's developer portal</h2>
<ol>
<li><strong>Create the application</strong> at <a href="https://discord.com/developers/applications">discord.com/developers/applications</a>. On its <strong>OAuth2</strong> page, copy the <strong>Client ID</strong> into <code>DISCORD_CLIENT_ID</code>, reset and copy the <strong>Client Secret</strong> into <code>DISCORD_CLIENT_SECRET</code>, and add <code>https://127.0.0.1</code> under <strong>Redirects</strong> (Discord requires one; the Activity never uses it).</li>
<li><strong>Enable Activities</strong> under <strong>Activities</strong>, <strong>Settings</strong>.</li>
<li><strong>Map the URL</strong> under <strong>Activities</strong>, <strong>URL Mappings</strong>: prefix <code>/</code>, target ${target}.</li>
</ol>
<p>A secret is created under Secrets in the dashboard sidebar with an entry name of your choice (for example <code>discord-activity-client-secret</code>), then mapped to this app as <code>DISCORD_CLIENT_SECRET</code>. Restart the app if it does not restart on its own.</p>
<p class="note">Until Discord verifies the application, only you, members of its developer team and the App Testers you invite can launch it, in servers with fewer than 25 members.</p>
</body>
</html>
`;
}

// Serves a file from the built client, or returns false when there is none.
// HTML responses carry `htmlCsp` as their Content-Security-Policy.
export async function serveStatic(distDir, pathname, req, res, headers, htmlCsp) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (rel.includes('\0')) return false;
  if (rel === '/' || rel === '') rel = '/index.html';
  const root = path.resolve(distDir);
  const file = path.resolve(root, `.${rel}`);
  if (!file.startsWith(root + path.sep)) return false;
  let info;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const isAsset = rel.startsWith('/assets/');
  res.writeHead(200, {
    ...headers,
    ...(ext === '.html' && htmlCsp ? { 'Content-Security-Policy': htmlCsp } : {}),
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': info.size,
    // Built assets carry a content hash in their name. Discord's proxy drops
    // cache headers on text/html, so the page itself is always fetched fresh.
    'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}
