#!/bin/bash
# Tell somebody when the village stops thinking.
#
# Run from host cron every 5 minutes. Deployed to
# /mnt/data/mc-society/mc-society-village-alert.sh (mode 750).
#
# WHY THIS EXISTS
# ---------------
# On 2026-08-09 the village stopped taking LLM turns and nobody found out for
# SIXTEEN HOURS. Nothing was broken in a way anything watched for:
#
#   - the container never crashed      -> restarts=0
#   - all eight villagers stayed connected and visible in `list`
#   - reflex modes kept running, so they walked, fled and fought on autopilot
#   - the healthcheck was RIGHT the whole time, reporting "no turn completed
#     for 57288s" and going unhealthy for 945 consecutive checks -- to nobody
#   - the mcs-watch dashboard showed green, because it read agents.lastSeen,
#     which is one batch write at process start and so cannot tell a thinking
#     villager from a dead one
#
# Docker's healthcheck has no notification side. This script is that side.
#
# IT ALERTS. IT NEVER RESTARTS.
# -----------------------------
# src/society/heartbeat.js and the compose healthcheck both say this
# deliberately, and the absence of a `docker restart` in this file is the
# enforcement -- the same discipline as mcs-watch having no write path. A
# village that cannot think is nearly always waiting on a model to be loaded,
# and restarting it in a loop would destroy the evidence while fixing nothing.
#
# Structure and the Discord helper mirror mc-society-backup.sh, mongo-backup.sh
# and paperless-backup.sh; keep them in sync when editing any of them.
set -euo pipefail

STACK=/mnt/data/mc-society
LOGFILE="$STACK/mc-society-alert.log"
STATEFILE="$STACK/.village-alert-state"

# Containers to watch, and how long a container must be unhealthy before we
# shout. 3 failing checks at the 60s interval is ~3 minutes -- long enough that
# a restart or a slow first turn does not page anybody, short enough that
# sixteen hours is impossible.
WATCH="mcs-village mcs-paper mcs-mongo"
MIN_STREAK=3

# Re-shout this often while a fault persists. The failure being fixed was 945
# silent checks, so transition-only alerting is not enough on its own; but one
# alert every five minutes for a day is how people learn to ignore a channel.
RENAG_SECONDS=21600     # 6 hours

log() { echo "[$(date '+%F %T')] $*" >> "$LOGFILE"; }

# Webhook lives in one shared file (not in compose) so it can be rotated in one place.
WEBHOOK=$(grep -E '^DISCORD_WEBHOOK_URL=' /home/jack/docker/backup-notify.env 2>/dev/null | cut -d= -f2- || true)

# Rich Discord embed. Body is identical to mc-society-backup.sh -- only SERVICE,
# the title verb and the field names differ.
# Args: STATUS(SUCCESS|ERROR)  MESSAGE  [DETAIL]  [LOADED]
send_discord() {
  [ -n "$WEBHOOK" ] || return 0
  STATUS="$1" MESSAGE="${2:-}" DETAIL="${3:-}" LOADED="${4:-}" \
  SERVICE="MC Society Village" \
  python3 - "$WEBHOOK" <<'PY' || true
import json, os, sys, time, socket, datetime, urllib.request, urllib.error

webhook = sys.argv[1]
env     = os.environ.get
ok      = env("STATUS") == "SUCCESS"

emerald, danger = 0x10B981, 0xED4245
embed = {
    "title": f"Heron CS | {env('SERVICE')} — " + ("Recovered" if ok else "Not thinking"),
    "description": env("MESSAGE") or "",
    "color": emerald if ok else danger,
    "fields": [],
    "footer": {"text": f"Heron CS backups • {socket.gethostname()}"},
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
f = embed["fields"]
# The healthcheck's own words. "no turn completed for 57288s" is the single most
# diagnostic string available and it was already being written, to nobody.
if env("DETAIL"): f.append({"name": "Healthcheck", "value": f"`{env('DETAIL')}`", "inline": False})
# What the inference server actually has resident. "Nothing suitable is loaded"
# is the cause most of the time, and `lms load` is the whole fix -- so put the
# answer in the alert rather than making somebody go and look.
if env("LOADED"): f.append({"name": "Models loaded", "value": env("LOADED"), "inline": False})

payload = {"username": "Heron CS Backups", "embeds": [embed]}
req = urllib.request.Request(
    webhook, data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json",
             "User-Agent": "heroncs-backup/1.0"})  # Discord 403s the default urllib UA
for attempt in range(2):  # one retry, honouring Discord's Retry-After on a 429
    try:
        urllib.request.urlopen(req, timeout=15)
        break
    except urllib.error.HTTPError as e:
        if e.code == 429 and attempt == 0:
            try:    wait = float(e.headers.get("Retry-After", "1"))
            except (TypeError, ValueError): wait = 1.0
            time.sleep(min(wait, 5))
            continue
        break
    except Exception:
        break
PY
}

# --- what is wrong, if anything -------------------------------------------
# FORCE_STATUS is a test hook: it fakes mcs-village being unhealthy so the alert
# path can be exercised end to end without breaking the village.
faults=""
detail=""

for c in $WATCH; do
  if [ "${FORCE_STATUS:-}" = "unhealthy" ] && [ "$c" = "mcs-village" ]; then
    faults="${faults}${c}: forced unhealthy (test)\n"
    detail="forced by FORCE_STATUS"
    continue
  fi

  running=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo missing)
  if [ "$running" != "true" ]; then
    faults="${faults}${c}: not running (${running})\n"
    continue
  fi

  # Restart-looping is its own fault: a container that keeps coming back looks
  # healthy in every snapshot taken between crashes.
  restarts=$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null || echo 0)

  # A container with no healthcheck reports an empty status; that is not a fault.
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null || echo "")
  streak=$(docker inspect -f '{{if .State.Health}}{{.State.Health.FailingStreak}}{{end}}' "$c" 2>/dev/null || echo 0)

  if [ "$status" = "unhealthy" ] && [ "${streak:-0}" -ge "$MIN_STREAK" ]; then
    faults="${faults}${c}: unhealthy for ${streak} checks (restarts=${restarts})\n"
    # The healthcheck's last output, which for mcs-village is the turn age.
    out=$(docker inspect -f '{{if .State.Health}}{{range .State.Health.Log}}{{.Output}}{{end}}{{end}}' "$c" 2>/dev/null \
          | tr -d '\r' | tr '\n' ' ' | tail -c 300 || true)
    [ -n "$out" ] && detail="$out"
  fi
done

# --- what the inference server has resident -------------------------------
# Only looked up when something is wrong, so the normal case costs nothing.
loaded=""
if [ -n "$faults" ]; then
  BASE=$(grep -E '^LMSTUDIO_BASE_URL=' "$STACK/.env" 2>/dev/null | cut -d= -f2- || true)
  KEY=$(grep -E '^LMSTUDIO_API_KEY=' "$STACK/.env" 2>/dev/null | cut -d= -f2- || true)
  if [ -n "$BASE" ]; then
    loaded=$(curl -s -m 8 -H "Authorization: Bearer $KEY" "${BASE%/v1}/api/v0/models" 2>/dev/null \
      | python3 -c '
import json,sys
try: rows = json.load(sys.stdin).get("data", [])
except Exception: print("(could not read /api/v0/models)"); raise SystemExit
up = [r for r in rows if r.get("state") not in (None, "not-loaded")]
if not up: print("**nothing is loaded** — run `lms load` on the inference host")
else: print("\n".join(f"`{r.get(\"id\")}` ({r.get(\"type\")}, ctx {r.get(\"loaded_context_length\")})" for r in up))
' 2>/dev/null || echo "(inference host unreachable)")
  fi
fi

# --- alert on transition, re-nag slowly, and say when it recovers ----------
prev_state=""; prev_at=0
if [ -f "$STATEFILE" ]; then
  prev_state=$(cut -d' ' -f1 "$STATEFILE" 2>/dev/null || true)
  prev_at=$(cut -d' ' -f2 "$STATEFILE" 2>/dev/null || echo 0)
fi
now=$(date +%s)

if [ -n "$faults" ]; then
  msg=$(printf 'The village is not completing turns.\n\n%b' "$faults")
  if [ "$prev_state" != "bad" ]; then
    log "FAULT (new): $(printf '%b' "$faults" | tr '\n' ';')"
    send_discord ERROR "$msg" "$detail" "$loaded"
    echo "bad $now" > "$STATEFILE"
  elif [ $((now - prev_at)) -ge "$RENAG_SECONDS" ]; then
    log "FAULT (still): $(printf '%b' "$faults" | tr '\n' ';')"
    send_discord ERROR "$msg" "$detail" "$loaded"
    echo "bad $now" > "$STATEFILE"
  else
    log "fault persists, next nag in $((RENAG_SECONDS - (now - prev_at)))s"
  fi
else
  if [ "$prev_state" = "bad" ]; then
    log "RECOVERED"
    send_discord SUCCESS "The village is completing turns again." "$detail" ""
  fi
  echo "ok $now" > "$STATEFILE"
fi
