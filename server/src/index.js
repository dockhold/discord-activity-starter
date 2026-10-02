// Starts the server on 0.0.0.0:$PORT. Missing Discord values never stop it:
// it serves a setup page on / and /health answers 200 until they are set.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { readConfig, setupLogLine } from './config.js';
import { DEFAULT_CLIENT_DIST, createServer } from './server.js';

let config;
try {
  config = readConfig(process.env);
} catch (err) {
  console.error(`Cannot start: ${err.message}`);
  process.exit(1);
}

const app = createServer({ config });

app.httpServer.on('error', (err) => {
  console.error(`Cannot listen on port ${config.port}: ${err.code ?? err.message}`);
  process.exit(1);
});

app.httpServer.listen(config.port, '0.0.0.0', () => {
  console.log(`Listening on 0.0.0.0:${config.port}.`);
  if (!config.configured) {
    console.log(setupLogLine(config.problems));
  } else {
    console.log('Discord sign-in is configured. Serving the Activity.');
    if (!existsSync(path.join(DEFAULT_CLIENT_DIST, 'index.html'))) {
      console.log('The client is not built yet: run "npm ci && npm run build" in client/.');
    }
  }
});

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received: closing connections.`);
  setTimeout(() => {
    console.log('Shutdown took too long: exiting now.');
    process.exit(0);
  }, 8000).unref();
  app.close().then(() => {
    console.log('Stopped.');
    process.exit(0);
  });
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
