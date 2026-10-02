#!/usr/bin/env bash
# Smoke test for the discord-activity-starter image, run under tight limits:
# uid 1001, no capabilities, no privilege escalation, 256 MB of memory and no
# swap, a small CPU share, a fixed PORT and the DOCKHOLD_APP_URL and
# DOCKHOLD_APP_HOSTNAME values an app receives. The root filesystem is
# read-only on top of that, which proves the app writes nothing to disk. The
# network is internal: the containers reach each other and nothing else, so
# Discord's API is unreachable on purpose.
#
# 1. The server's unit tests (server/test, node --test) run inside the image,
#    as uid 1001 with no capabilities and no network. They cover the sign-in
#    against a fake of Discord's API.
# 2. The app with no Discord values: setup page, /health, one log line, no
#    crash loop, clean stop.
# 3. The app with values: the game page, config, sign-in refusals on the
#    socket, a round of the game, message bounds, the sign-in rate limit.
# 4. Log and command-line hygiene, then SIGTERM with players connected.
#
# Usage: tests/smoke.sh <image>
# Needs: docker, bash 4 or newer. Run from the repository root.
# Prints one PASS or FAIL line per case and exits non-zero if any failed.
set -euo pipefail

IMAGE=${1:?usage: tests/smoke.sh <image>}
RUN="dasmoke-$$-$RANDOM"
NET="$RUN-net"
APP="$RUN-app"
PORT=8080
URL="http://app:$PORT"
APP_HOST=discord-activity-smoke-a1b2c3.dockhold.app
WORK=$(mktemp -d "${TMPDIR:-/tmp}/dasmoke.XXXXXX")
chmod 0777 "$WORK"

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "PASS  $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() {
  echo "FAIL  $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}
info() { echo "INFO  $1"; }

cleanup() {
  docker rm -f "$APP" "$RUN-hold" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

rand_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

# Values reach containers through the environment of this script, never as
# literal arguments, so they do not show up in a process listing.
export DISCORD_CLIENT_ID=123456789012345678
export DISCORD_CLIENT_SECRET
DISCORD_CLIENT_SECRET=$(rand_hex 24)
export SMOKE_SECRET=$DISCORD_CLIENT_SECRET
printf '%s\n' "$DISCORD_CLIENT_SECRET" > "$WORK/sensitive"
chmod 0666 "$WORK/sensitive" # the probe runs as uid 1001 and appends to it

docker network create --internal "$NET" >/dev/null

HARDEN=(--user 1001:1001 --cap-drop ALL --security-opt no-new-privileges)
LIMITS=("${HARDEN[@]}" --memory 256m --memory-swap 256m --cpus 0.25
  --read-only --tmpfs /tmp:mode=1777 --network "$NET" -e PORT="$PORT"
  -e DOCKHOLD_APP_URL="https://$APP_HOST" -e DOCKHOLD_APP_HOSTNAME="$APP_HOST")

probe() {
  docker run --rm --network "$NET" "${HARDEN[@]}" -e SMOKE_SECRET \
    -v "$PWD/tests/probe.mjs:/probe.mjs:ro" -v "$WORK:/work" -w /app/server \
    "$IMAGE" node /probe.mjs "$URL" "$1" "$APP_HOST"
}

# Runs the probe and turns its PASS/FAIL lines into this script's counts.
probe_cases() {
  local line
  while IFS= read -r line; do
    case $line in
      "PASS  "*) pass "${line#PASS  }" ;;
      "FAIL  "*) fail "${line#FAIL  }" ;;
      *) info "probe: $line" ;;
    esac
  done < <(probe "$1" 2>&1 || echo "FAIL  the probe ($1) exited with an error")
}

start() {
  docker run -d --name "$APP" --network-alias app "${LIMITS[@]}" "$@" "$IMAGE" >/dev/null
  local i=0 t0
  t0=$(date +%s)
  until docker run --rm --network "$NET" "${HARDEN[@]}" "$IMAGE" \
      node -e "fetch('$URL/health').then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 60 ] || [ "$(docker inspect -f '{{.State.Running}}' "$APP")" != true ]; then
      fail "the app becomes healthy"
      docker logs "$APP" 2>&1 | tail -n 20
      exit 1
    fi
    sleep 1
  done
  info "healthy $(( $(date +%s) - t0 )) s after start"
}

stop_app() {
  local t0 t1 code oom
  t0=$(date +%s%N)
  docker stop -t 10 "$APP" >/dev/null
  t1=$(date +%s%N)
  code=$(docker inspect -f '{{.State.ExitCode}}' "$APP")
  oom=$(docker inspect -f '{{.State.OOMKilled}}' "$APP")
  local ms=$(( (t1 - t0) / 1000000 ))
  if [ "$code" = 0 ] && [ "$oom" = false ] && [ "$ms" -lt 10000 ]; then
    pass "$1 ($ms ms, exit $code)"
  else
    fail "$1 ($ms ms, exit $code, oom $oom)"
  fi
  docker logs "$APP" >> "$WORK/all.log" 2>&1
  docker rm "$APP" >/dev/null
}

# 1. Unit tests inside the image. No CPU cap here: some cases measure timing.
unit_out=$(docker run --rm "${HARDEN[@]}" --memory 256m --memory-swap 256m --read-only --tmpfs /tmp:mode=1777 \
  --network none -v "$PWD/server/test:/app/server/test:ro" -w /app/server "$IMAGE" \
  node --test --test-timeout=60000 "test/*.test.js" 2>&1) && unit_rc=0 || unit_rc=$?
node_version=$(docker run --rm "${HARDEN[@]}" --network none "$IMAGE" node --version)
unit_summary=$(grep -E '^# (pass|fail) ' <<<"$unit_out" | tr '\n' ' ')
if [ "$unit_rc" = 0 ]; then pass "server unit tests inside the image, Node $node_version: $unit_summary"; else fail "server unit tests inside the image"; echo "$unit_out" | tail -n 60; fi

# 2. No Discord values yet.
start -e DISCORD_CLIENT_ID= -e DISCORD_CLIENT_SECRET=
probe_cases unconfigured
sleep 10
running=$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$APP")
if [ "$running" = "true 0" ]; then pass "unconfigured: still running after 10 s, no restart"; else fail "unconfigured: still running after 10 s [$running]"; fi
setup_lines=$(docker logs "$APP" 2>&1 | grep -c '^Setup needed: ' || true)
setup_line=$(docker logs "$APP" 2>&1 | grep '^Setup needed: ' || true)
if [ "$setup_lines" = 1 ] \
  && [[ $setup_line == *"DISCORD_CLIENT_ID is not set (set it in the app's Variables tab)"* ]] \
  && [[ $setup_line == *"DISCORD_CLIENT_SECRET is not set (set it in Secrets in the dashboard sidebar)"* ]]; then
  pass "unconfigured: one log line names both values and where to set them"
else
  fail "unconfigured: one log line names both values [$setup_lines lines]"
fi
stop_app "unconfigured: stops on SIGTERM within 10 s"

# 3. With Discord values.
start -e DISCORD_CLIENT_ID -e DISCORD_CLIENT_SECRET
probe_cases configured
docker logs "$APP" 2>&1 | grep -q '^Discord sign-in is configured' && pass "configured: the log says so" || fail "configured: the log says so"

# 4a. The secret is in the environment only, not on any command line.
cmdlines=$(docker exec "$APP" sh -c 'for f in /proc/[0-9]*/cmdline; do tr "\0" " " < "$f"; echo; done' 2>/dev/null || true)
inspect=$(docker inspect -f '{{json .Path}} {{json .Args}} {{json .Config.Cmd}} {{json .Config.Entrypoint}}' "$APP")
if [ -n "$cmdlines" ] && ! grep -qF "$DISCORD_CLIENT_SECRET" <<<"$cmdlines$inspect"; then
  pass "no secret on the process command line ($(head -n 1 <<<"$cmdlines" | tr -s ' '))"
else
  fail "no secret on the process command line"
fi

# 4b. SIGTERM with three players and one unsigned socket connected.
rm -f "$WORK/hold.ready" "$WORK/hold.result"
docker run -d --name "$RUN-hold" --network "$NET" "${HARDEN[@]}" -e SMOKE_SECRET \
  -v "$PWD/tests/probe.mjs:/probe.mjs:ro" -v "$WORK:/work" -w /app/server \
  "$IMAGE" node /probe.mjs "$URL" hold "$APP_HOST" >/dev/null
for _ in $(seq 1 30); do [ -f "$WORK/hold.ready" ] && break; sleep 0.5; done
[ -f "$WORK/hold.ready" ] || fail "four sockets connected before the stop"
stop_app "configured: stops on SIGTERM within 10 s with players connected"
for _ in $(seq 1 30); do [ -f "$WORK/hold.result" ] && break; sleep 0.5; done
codes=$(cat "$WORK/hold.result" 2>/dev/null || echo none)
if [ "$codes" = "1001 1001 1001 1001" ]; then pass "every socket got a 1001 close on SIGTERM"; else fail "every socket got a 1001 close on SIGTERM [$codes]"; fi
docker rm -f "$RUN-hold" >/dev/null 2>&1 || true

# 4c. Log hygiene over both runs: no secret, no session token, no code.
values=$(grep -c . "$WORK/sensitive")
leaks=0
while IFS= read -r value; do
  [ -n "$value" ] && grep -qF -- "$value" "$WORK/all.log" && leaks=$((leaks + 1))
done < "$WORK/sensitive"
if [ "$leaks" = 0 ] && [ "$values" -gt 10 ]; then pass "no secret, token or code in any log line ($values values checked)"; else fail "no secret, token or code in any log line ($leaks of $values found)"; fi
bad=$(grep -E -i 'error|exception|unhandled|warn' "$WORK/all.log" || true)
if [ -z "$bad" ]; then pass "no errors or warnings in the logs"; else fail "no errors or warnings in the logs: $bad"; fi
while IFS= read -r line; do info "log: $line"; done < <(sort "$WORK/all.log" | uniq -c | sed 's/^ *//')

echo "$PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
