# Discord Activity starter

Trails, a realtime light-cycle arena that runs inside a Discord voice
channel. Up to eight riders steer glowing trails around the board, the last
one riding wins, and everyone else in the call watches live. One app on
[Dockhold](https://dockhold.eu) serves the game page, the Discord sign-in and
the game's WebSocket connection. Deploy it as it is, or use it as the starting
point for your own Activity.

This template is not affiliated with Discord.

## Who can launch it

Discord decides who can open an Activity. Until Discord has verified your
application, the Activity launches only for you, the members of the
application's [developer team](https://discord.com/developers/teams), and up
to 50 App Testers you invite in the Developer Portal. Discord also limits an
unverified Activity to servers with fewer than 25 members. Deploying this
template does not change any of that.

To let anyone open it, take your application through Discord's
[verification and Discovery process](https://docs.discord.com/developers/discovery/enabling-discovery).
Discord's help article
[How Can Users Discover and Play My Activity](https://support-dev.discord.com/hc/en-us/articles/21204493235991-How-Can-Users-Discover-and-Play-My-Activity)
explains teams, App Testers and verification.

[![Deploy on Dockhold](https://dockhold.eu/button.svg)](https://app.dockhold.eu/new?repo=https://github.com/dockhold/discord-activity-starter&name=discord-activity-starter&ref=button-discord-activity)

## Set it up

You need a Discord account with Developer Mode on (User Settings, Advanced).

### 1. Create the Discord application

1. In the [Developer Portal](https://discord.com/developers/applications),
   click **New Application**. If other people will test it, choose your
   developer team as the owner: team members can launch it.
2. On the **OAuth2** page, copy the **Client ID**. Click **Reset Secret** and
   copy the **Client Secret**.
3. Still on **OAuth2**, under **Redirects**, add `https://127.0.0.1` and save.
   Discord requires one redirect. The Activity never uses it: Discord's SDK
   brings the player back to the Activity by itself.

### 2. Deploy the app

1. Open the [Deploy link](https://app.dockhold.eu/new?repo=https://github.com/dockhold/discord-activity-starter&name=discord-activity-starter&ref=button-discord-activity)
   and sign in if asked. Leave **App size** as it is. The free plan is
   enough.
2. Under **Environment**, click **+ Add Variable** and add
   `DISCORD_CLIENT_ID` with the Client ID as its value.
3. In the **Secrets** list, click **+ New secret**. Give the entry a name that
   belongs to this app, for example `discord-activity-client-secret`, because
   secrets are shared across your apps by name. Paste the Client Secret as
   its value, tick it, and set its **Env var name** to
   `DISCORD_CLIENT_SECRET`.

   | Env var | Kind | Value |
   | --- | --- | --- |
   | `DISCORD_CLIENT_ID` | variable, on the app's Variables tab | the Client ID |
   | `DISCORD_CLIENT_SECRET` | secret, from Secrets in the dashboard sidebar | the Client Secret |

4. Click **Deploy** and wait until the app shows as running. Note its
   address, for example `https://discord-activity-starter-a1b2c3.dockhold.app`.

If a value is missing, the app still starts. Its address then shows a setup
page that names the missing value and the exact URL mapping target, and the
app's log says the same in one line. Add the value on the app's Variables tab
or under Secrets in the dashboard sidebar, then click **Restart** if the app
does not restart on its own.

Dockhold sets `PORT`, `DOCKHOLD_APP_URL` and `DOCKHOLD_APP_HOSTNAME` itself.
Do not add them.

### 3. Turn on the Activity in Discord

1. In the Developer Portal, open **Activities**, **Settings** and turn on
   **Enable Activities**.
2. Open **Activities**, **URL Mappings** and set the root mapping: prefix `/`,
   target your app's address without `https://`, for example
   `discord-activity-starter-a1b2c3.dockhold.app`. Save.

### 4. Launch it

Join a voice channel, open the Activities menu (the rocket icon) and pick your
application. The first time, Discord asks you to authorize it. Click **Ride**
and a round starts after a three-second countdown. Riding alone is practice.
A second account on your developer team, or one of your App Testers, joins the
same voice channel, opens the Activity and clicks **Ride** too: from the next
round you ride against each other.

## How to play

* **Ride or watch.** Click **Ride** to join the next round, **Watch** to sit
  out. Up to eight people ride at once; everyone else in the room watches.
* **Steer.** Your light cycle moves by itself, one cell at a time. You only
  choose when to turn: the arrow keys or WASD on a computer, a swipe on the
  board or the four buttons on a phone. You cannot turn straight back.
* **Stay in.** You are out when you hit a wall, any trail (your own too), or
  another rider: riders who reach the same cell at once are all out.
  Trails stay on the board until the round ends.
* **Win.** The last one riding wins the round. The scoreboard counts wins
  for as long as the room lasts. A round you ride alone is practice: it ends
  when you crash and shows how long you lasted.
* **Rounds.** The countdown shows your colour and the way you are heading.
  After each round the result stays up for three seconds, then the next
  countdown starts by itself for everyone still riding. If you click Ride in
  the middle of a round, you ride from the next one.
* **Leaving.** If you close the Activity in the middle of a round, your cycle
  rides on in a straight line until it crashes. Come back during the round and
  you steer it again. After 30 seconds away you lose your place.

## How it works

* `client/` is the game page: Vite, TypeScript and Discord's
  [Embedded App SDK](https://github.com/discord/embedded-app-sdk). It reads
  the client ID from `GET /api/config` when it loads, so nothing
  Discord-specific is built into it.
* `server/` is a Node server with one dependency, `ws`. On one port it serves
  the built page, `GET /api/config`, `POST /api/token`, `GET /health` and the
  WebSocket at `/ws`.
* **Sign-in.** The page asks Discord to authorize the `identify` scope and
  sends the code to `POST /api/token`. The server exchanges the code with your
  client secret, looks up the Discord user once, and returns two things: the
  Discord access token, which the page hands to the SDK, and a session token
  of its own. The session token is signed by the server, names the Discord
  user and the Activity instance, and lasts 15 minutes.
* **The socket.** The page opens it with two WebSocket subprotocols: the
  name `activity-session`, then its session token. The server checks the
  token during the handshake and answers 401 without one, so no socket opens
  for a caller without a valid session. It echoes only the name, never the
  token, and no message carries the token. The player's identity comes from
  the token, never from a message.
* **The game.** The server runs it, 15 ticks a second, and is the only judge
  of a crash. A page sends three things: ride, watch, and a turn when the
  player presses a key, swipes or taps a button. On each tick the server
  sends only what changed: each rider's new head cell and who went out, under
  100 bytes with eight riders. A page that joins in the middle of a round gets
  the whole board once. The page draws heads gliding between ticks, so the
  game looks smooth at 15 ticks a second. Rooms are keyed by Discord's
  Activity instance ID, so everyone in one voice channel's Activity shares a
  board. Everyone else in the room watches and shows up in the list of who is
  here.
* **The game clock.** One timer serves every room that has riders. It stops
  when no room has any, so an idle app spends nothing on the game.
* **Staying connected.** The server sends a ping every 25 seconds and the page
  answers it. A socket that stays silent for a minute is closed. Before the
  page reconnects with an expired session, or after the server refused its
  handshake, it authorizes again with `prompt: "none"` (no dialog) and
  fetches a new session.
* **Paths.** Requests reach your app through Discord's proxy and your URL
  mapping. Discord documents the `/.proxy/` path prefix as optional, so the
  server answers every route with and without it.

## One copy, and what a restart does

Run the app as one copy. Rooms live in the server's memory, so a second copy
would split the players of one game between two servers.

A restart or a deploy ends the round in progress. Every open page gets a
close message, signs in to Discord again (without a dialog), reconnects by
itself and lands in a fresh room: an empty board, no wins on the scoreboard,
and nobody riding until they click Ride again.

A room ends about a minute after everyone has left it.

## Limits built into the server

* A message larger than 4 KB closes that socket.
* More than 20 messages in a second from one socket closes it.
* At most eight riders a room. Between two ticks a rider can have two turns
  waiting; more are dropped, so a flood of turns changes a cycle's direction
  at most once a tick. A turn can only steer the sender's own cycle.
* Who is here and the scoreboard go out at most once a tick, and only when
  they changed. Riders coming and going during a countdown move the spawns
  and send the board at most once a tick, and add time to the countdown once
  at most, so they cannot hold it open.
* A room whose game fails with an error is closed on its own: its players
  get a close message (1011) and reconnect into a fresh room, and every other
  room plays on.
* A socket the server closes and that does not answer the close is cut a
  second later.
* Rooms, sockets per room, sockets per player (in one room and across rooms)
  and open sockets in total are capped. These caps bound memory; CPU is
  what a busy app runs short of first. Measured under the smoke test's
  limits (a CPU limit of 0.25): 20 riders got a steady 15 ticks a second,
  and 400 riders in 50 rooms got 14.6 on average, with short slowdowns when
  the CPU limit cut in. Without that limit the same 400 got a steady 15.
  For many busy rooms, give the app more CPU.
* `POST /api/token` allows three tries per authorization code and draws on
  one shared sign-in budget for the whole app, refilled at a steady rate.
  Discord's proxy hides player addresses, so the limit cannot be per player.
  When Discord asks the app to slow down, sign-ins wait as long as Discord
  says, without calling it again.

The numbers are in [`server/src/limits.js`](server/src/limits.js), and the
game's own (board size, tick rate, riders, timers) at the top of
[`server/src/game.js`](server/src/game.js). Change them there as your
Activity grows.

## Make it yours

Click **Use this template** on GitHub to make your own copy, connect that
repository in Dockhold, and deploy it. From then on every push redeploys the
app, and the checks in `.github/workflows/check.yml` run on every push to your
copy. The game's rules are in `server/src/game.js`, the board and the
controls in `client/src/trails.ts`, and the sign-in and connection in
`client/src/main.ts`.

## Local development

Discord's own guide develops Activities through a tunnel. Use a second
Discord application for development, so your deployed app's URL mapping stays
as it is. You need Node 22.

```bash
cd client && npm ci && npm run build && cd ..
cd server && npm ci
```

Put the development application's values in `server/.env` (git ignores
`.env` files), one per line: `DISCORD_CLIENT_ID=...` and
`DISCORD_CLIENT_SECRET=...`. Then start the server in `server/`, and a tunnel
to it in a second terminal:

```bash
PORT=8080 node --env-file=.env src/index.js
cloudflared tunnel --url http://localhost:8080
```

Set the development application's root URL mapping to the tunnel's host name
and launch it from a voice channel. Run `npm run watch` in `client/` to
rebuild the page as you edit it. Run `npm test` in `server/` for the server's
tests. `tests/smoke.sh <image>` runs those tests inside a built image and then
tests the image itself, as CI does. `node tests/bench.mjs` times the game
loop with 200 rooms of eight riders. `node tests/browser/run.mjs` plays
rounds in headless Chrome with a stand-in for the Discord client (it needs
Chrome and a built client; see the top of the file).

## Security notes

* The server never logs the client secret, a Discord token, an authorization
  code or a session token. The tests check every log line for them.
* Session tokens are signed with a key derived from the client secret and the
  client ID. If you reset the secret in Discord and update it here, every
  session ends and players sign in again when they reconnect.
* Rooms trust the instance ID the client sends. For a game with stakes,
  verify it with Discord's
  [activity instance endpoint](https://docs.discord.com/developers/activities/development-guides/multiplayer-experience)
  before signing it into the session.
* An open socket is not checked again after its session token expires. A
  copy that adds kick or ban needs a way to revoke sessions on the server.
* The session token travels in the WebSocket handshake's
  `Sec-WebSocket-Protocol` header. The fallback, a query parameter
  (`/ws?s=<token>`), would put the token in access logs, so it is not built
  unless Discord's proxy turns out to drop that header.
* The game page is served with a Content-Security-Policy that allows only its
  own origin.
* Report security problems privately through this repository's **Security**
  tab (**Report a vulnerability**), not in a public issue. Other problems with
  this template go in an issue.

## License

MIT, see [LICENSE](LICENSE). Discord's Embedded App SDK is MIT licensed by
Discord.
