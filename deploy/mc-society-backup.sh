#!/bin/bash
# Nightly mc-society backup -> /mnt/data/mc-society/backups/mc-society-backup-<date>.zip
# Run from host cron at 04:00 (after Mongo 02:00 and Paperless 03:00, so the
# three never overlap).
#
# Backs up the two things that cannot be rebuilt: the Minecraft world, and the
# villagers' memories. Everything else in the stack -- the server jar,
# libraries/, versions/ -- is 240 MB of redownloadable files and is excluded.
#
# Credentials are read at runtime rather than copied here, so this file holds no
# secrets. Structure and the Discord helper mirror mongo-backup.sh and
# paperless-backup.sh; keep the three in sync when editing any of them.
set -euo pipefail

STACK=/mnt/data/mc-society
BACKUPDIR="$STACK/backups"
LOGFILE="$STACK/mc-society-backup.log"
RETENTION_DAYS=90
DATE=$(date +%F)
ARCHIVE="mc-society-backup-$DATE.zip"
CONTAINER=mcs-paper

# filebrowser serves backups/ read-only at /srv/mc-society (root=/srv, no baseURL).
FILES_BASE_URL="${FILES_BASE_URL:-$(grep -E '^FILES_BASE_URL=' /home/jack/docker/backup-notify.env 2>/dev/null | cut -d= -f2- || true)}"
FB_URL="${FILES_BASE_URL:-https://files.heroncs.co.uk}"
FB_URL="${FB_URL%/}/files/mc-society"

log() { echo "[$(date '+%F %T')] $*" >> "$LOGFILE"; }

# Webhook lives in one shared file (not in compose) so it can be rotated in one place.
WEBHOOK=$(grep -E '^DISCORD_WEBHOOK_URL=' /home/jack/docker/backup-notify.env 2>/dev/null | cut -d= -f2- || true)

# Rich Discord embed. Body is identical to mongo-backup.sh -- only SERVICE differs.
# Args: STATUS(SUCCESS|ERROR)  MESSAGE  [ARCHIVE]  [SIZE]  [URL]
send_discord() {
  [ -n "$WEBHOOK" ] || return 0
  STATUS="$1" MESSAGE="${2:-}" ARCHIVE="${3:-}" FSIZE="${4:-}" DLURL="${5:-}" \
  KEEP="$RETENTION_DAYS" SERVICE="MC Society" \
  python3 - "$WEBHOOK" <<'PY' || true
import json, os, sys, time, socket, datetime, urllib.request, urllib.error

webhook = sys.argv[1]
env     = os.environ.get
ok      = env("STATUS") == "SUCCESS"

emerald, danger = 0x10B981, 0xED4245
embed = {
    "title": f"Heron CS | {env('SERVICE')} Backup — " + ("Completed" if ok else "Failed"),
    "description": env("MESSAGE") or "",
    "color": emerald if ok else danger,
    "fields": [],
    "footer": {"text": f"Heron CS backups • {socket.gethostname()}"},
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
f = embed["fields"]
if env("ARCHIVE"): f.append({"name": "Archive", "value": f"`{env('ARCHIVE')}`", "inline": True})
if env("FSIZE"):   f.append({"name": "Size",    "value": env("FSIZE"),          "inline": True})
if env("KEEP"):    f.append({"name": "Retention", "value": f"{env('KEEP')} days", "inline": True})
if env("DLURL"):   f.append({"name": "Download", "value": f"[Open in FileBrowser]({env('DLURL')})", "inline": False})

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

mkdir -p "$BACKUPDIR"

# --- the save fence -------------------------------------------------------
# Unique to this backup, and the reason it cannot just copy files: Minecraft
# holds region data in memory and flushes on its own schedule, so an archive
# taken mid-write contains a torn chunk that looks fine until someone walks
# into it. save-off stops autosave, save-all flushes, and save-on MUST run
# again afterwards -- a server left with saving disabled silently loses
# everything since the last flush, which is a far worse outcome than a failed
# backup. Hence the trap.
RCON_PW=$(grep -E '^RCON_PASSWORD=' "$STACK/.env" 2>/dev/null | cut -d= -f2- || true)
SAVES_OFF=0

rcon() { docker exec "$CONTAINER" rcon-cli --password "$RCON_PW" "$@" >/dev/null 2>&1; }

restore_saving() {
  if [ "$SAVES_OFF" -eq 1 ]; then
    if rcon save-on; then log "Autosave re-enabled"
    else log "WARNING: could not re-enable autosave -- run 'save-on' manually"; fi
    SAVES_OFF=0
  fi
}
trap restore_saving EXIT INT TERM

log "Starting mc-society backup"

if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" && [ -n "$RCON_PW" ]; then
  if rcon save-off; then
    SAVES_OFF=1
    rcon save-all || log "WARNING: save-all reported an error; continuing"
    sleep 5   # let the flush land before reading the region files
    log "World flushed and autosave paused"
  else
    log "WARNING: RCON unavailable; backing up without a save fence"
  fi
else
  # A stopped server is already consistent on disk -- this is not an error.
  log "$CONTAINER not running; backing up files at rest"
fi

# --- the archive ----------------------------------------------------------
#
# Only existing paths are passed to zip: it exits non-zero when told to archive
# a file that is not there, and a fresh server has no banned-ips.json, so a
# fixed list would fail the backup for a file whose absence is normal.
WANTED=(
  data/world data/world_nether data/world_the_end
  data/server.properties data/ops.json data/whitelist.json
  data/banned-players.json data/banned-ips.json
  data/bukkit.yml data/spigot.yml data/paper-global.yml
  bots
  docker-compose.yml docker-compose.village.yml
)
TARGETS=()
for p in "${WANTED[@]}"; do [ -e "$STACK/$p" ] && TARGETS+=("$p"); done

OK=1
if [ ${#TARGETS[@]} -eq 0 ]; then
  log "FAILED: nothing to back up under $STACK"
  OK=0
else
  # action-code/ is model-written scratch files, regenerated on demand.
  ( cd "$STACK" && zip -rq "$BACKUPDIR/$ARCHIVE" "${TARGETS[@]}" -x 'bots/*/action-code/*' ) \
    >> "$LOGFILE" 2>&1 || OK=0
fi

# Refuse to report success on an archive that cannot be read back. A backup is
# only worth having if it opens, and a torn zip is exactly what the save fence
# exists to prevent -- so verify rather than assume it worked.
if [ "$OK" -eq 1 ] && ! unzip -tqq "$BACKUPDIR/$ARCHIVE" >> "$LOGFILE" 2>&1; then
  log "FAILED: archive did not pass an integrity check"
  OK=0
fi

# Re-enable saving as early as possible, not just on exit.
restore_saving

find "$BACKUPDIR" -maxdepth 1 -name 'mc-society-backup-*.zip' -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

if [ "$OK" -eq 1 ] && [ -f "$BACKUPDIR/$ARCHIVE" ]; then
  SIZE=$(du -h "$BACKUPDIR/$ARCHIVE" | cut -f1)
  log "Backup completed: $ARCHIVE ($SIZE)"
  send_discord SUCCESS "Nightly backup completed successfully." \
    "$ARCHIVE" "$SIZE" "$FB_URL/$ARCHIVE"
else
  log "Backup FAILED for $DATE"
  send_discord ERROR "Backup failed — see the log on the host for details." "$ARCHIVE"
  exit 1
fi
