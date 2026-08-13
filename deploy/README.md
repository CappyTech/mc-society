# Deployed configuration

Copies of what actually runs the village on the host, kept here so stack
changes are reviewable in the same place as the code that they run.

| File | Deployed to |
| --- | --- |
| `docker-compose.yml` | `/mnt/data/mc-society/docker-compose.yml` |
| `docker-compose.village.yml` | `/mnt/data/mc-society/docker-compose.village.yml` |
| `mc-society-backup.sh` | `/mnt/data/mc-society/mc-society-backup.sh` (cron, 04:00) |
| `mc-society-village-alert.sh` | `/mnt/data/mc-society/mc-society-village-alert.sh` (cron, `*/5`) |

**These are copies, not the source of truth.** The host files are what runs;
nothing deploys from here. Edit the host copy, verify it, then update this one.
A drift check is worth running before assuming they match:

```bash
for f in docker-compose.yml docker-compose.village.yml \
         mc-society-backup.sh mc-society-village-alert.sh; do
  diff -q "/mnt/data/mc-society/$f" "deploy/$f" || echo "DRIFT: $f"
done
```

## Two things about this stack that are the opposite of the rest of the host

1. **The village builds locally and `src/` is bind-mounted.** There is no `build:`
   stanza for the `village` service and no GHCR image, unlike hcs-app/hcs-sync.
   `/home/jack/code/mc-society/{src,profiles,scripts}` are mounted read-only, so a
   code change deploys with a **restart**, not a rebuild:

   ```bash
   cd /mnt/data/mc-society && docker compose --env-file .env \
     -f docker-compose.yml -f docker-compose.village.yml restart village
   ```

   `docker build -t mc-society-runtime:dev .` is only needed for `package.json` or
   `Dockerfile` changes. A compose change needs `up -d` rather than `restart`.

2. **`LMSTUDIO_CHAT_MODEL` in `.env` does nothing at runtime.** It is read at
   `src/society/roster.js` inside `scripts/generate-profiles.mjs`, which is a
   **build step** — the committed `profiles/village/*.json` carry the literal id
   and that is what the container loads. Editing `.env` and restarting changes
   nothing; run `node scripts/generate-profiles.mjs` and restart. The same is true
   of `cooldown` and the enabled `modes`.

## What is deliberately not here

- **`.env`** (mode 600) holds `RCON_PASSWORD`, `LMSTUDIO_BASE_URL`,
  `LMSTUDIO_API_KEY`, `LMSTUDIO_CHAT_MODEL`, `LMSTUDIO_EMBED_MODEL`. The compose
  files reference them as `${VAR}` and contain no literal secrets, which is why
  they can live in the repo at all. Keep it that way.
- **`profile-overrides/`** pins some villagers to a second LM Studio instance.
  That is a property of one machine's GPU, not of the village.

## Running it

```bash
cd /mnt/data/mc-society
docker compose -f docker-compose.yml -f docker-compose.village.yml up -d
```

The village mounts `src/`, `profiles/` and `scripts/` from `~/code/mc-society`
read-only, so a code change needs only `restart village`. A **dependency**
change needs the image rebuilt -- `node_modules` is baked in, and a missing
module surfaces as agents retrying with backoff, which looks exactly like the
Minecraft server being unreachable.
