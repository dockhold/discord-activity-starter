// Reads the configuration once, at start. Never returns or prints the client
// secret; callers get it only through `clientSecret` and must not log it.

const SNOWFLAKE = /^\d{15,22}$/;
const HOSTNAME = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;

export const PLACES = Object.freeze({
  DISCORD_CLIENT_ID: "the app's Variables tab",
  DISCORD_CLIENT_SECRET: 'Secrets in the dashboard sidebar',
});

export function readConfig(env) {
  const clientId = (env.DISCORD_CLIENT_ID ?? '').trim();
  const clientSecret = (env.DISCORD_CLIENT_SECRET ?? '').trim();
  const rawHost = (env.DOCKHOLD_APP_HOSTNAME ?? '').trim();
  const appHostname = HOSTNAME.test(rawHost) ? rawHost.toLowerCase() : '';

  let port = 8080;
  if (env.PORT !== undefined && env.PORT !== '') {
    port = Number(env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('PORT must be a whole number between 1 and 65535.');
    }
  }

  const problems = [];
  if (!clientId) {
    problems.push({ name: 'DISCORD_CLIENT_ID', text: 'is not set' });
  } else if (!SNOWFLAKE.test(clientId)) {
    problems.push({
      name: 'DISCORD_CLIENT_ID',
      text: 'is not a Discord application ID (it is a long number, copied from the OAuth2 page)',
    });
  }
  if (!clientSecret) {
    problems.push({ name: 'DISCORD_CLIENT_SECRET', text: 'is not set' });
  }

  return {
    port,
    clientId: problems.some((p) => p.name === 'DISCORD_CLIENT_ID') ? '' : clientId,
    clientSecret,
    appHostname,
    problems,
    configured: problems.length === 0,
  };
}

// The one log line printed at start while something is missing.
export function setupLogLine(problems) {
  const parts = problems.map((p) => `${p.name} ${p.text} (set it in ${PLACES[p.name]})`);
  return `Setup needed: ${parts.join('; ')}. Serving the setup page on / until then.`;
}
