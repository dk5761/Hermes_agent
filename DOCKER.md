# Local "VPS" via Docker Compose

Runs Hermes + Node gateway in containers, with hot-reload on the gateway. Expo
app stays on your host (Mac) and connects to the gateway over LAN — exactly
emulates phone-talks-to-VPS.

```
┌───────── docker compose ─────────┐
│  hermes:9119 ◄─── http://hermes:9119 from gateway                 │
│       │                                                            │
│  gateway:8080 (tsx watch + bind-mounted src/)                     │
└───────┼────────────────────────────────────────────────────────────┘
        ▼ port 8080 → 0.0.0.0:8080
   ┌─────────────────────────────────────────────────────┐
   │ Mac LAN IP:8080 ◄── iPhone / Android via Wi-Fi       │
   └─────────────────────────────────────────────────────┘
```

## Prerequisites

- Docker Desktop ≥ 4.24 (or Docker Engine + Compose v2 on Linux)
- ~5 GB free disk for the Hermes image + gateway image
- Mac LAN IP — find with `ipconfig getifaddr en0`

## One-time setup

```bash
cd /Users/drshnk/Developer/personal/hermes-app

# 1. Create backend .env from template + fill secrets
cp backend/.env.example backend/.env
$EDITOR backend/.env
# At minimum set:
#   JWT_SECRET=<32+ random chars>
#   STORAGE_SIGNED_URL_SECRET=<32+ random chars>
#   BOOTSTRAP_USERNAME=admin
#   BOOTSTRAP_PASSWORD=<your password>

# 2. Build images (5-10 min first time)
HERMES_UID=$(id -u) HERMES_GID=$(id -g) docker compose build

# 3. One-time Hermes config (model + API key)
./scripts/hermes-cli.sh setup
# OR set values directly:
./scripts/hermes-cli.sh config set model openrouter/anthropic/claude-sonnet-4-5
./scripts/hermes-cli.sh env set OPENROUTER_API_KEY sk-or-...
```

## Run

```bash
HERMES_UID=$(id -u) HERMES_GID=$(id -g) docker compose up
# (or `up -d` to background)
```

What happens:
1. `hermes` container boots, dashboard reachable inside compose net at `http://hermes:9119`
2. Healthcheck waits for `/api/status` 200
3. `gateway` container starts only after Hermes is healthy
4. Gateway runs `pnpm db:migrate` (idempotent), then `pnpm dev` (tsx watch)
5. Gateway scrapes the Hermes session token from served HTML automatically
6. Gateway is live at `http://<your-lan-ip>:8080`

## Hot reload

Edit any file under `backend/src/` or `backend/scripts/` on your Mac — the
container's `tsx watch` notices via polling and restarts the gateway in
~1 second.

What restarts on change:
- `backend/src/**` — sync, tsx watch restarts node
- `backend/scripts/**` — sync (only matters if you re-run a script)
- `backend/drizzle.config.ts`, `backend/tsconfig.json` — sync, tsx watch restarts

What requires `docker compose up --build` (rebuild image):
- `package.json` / `pnpm-lock.yaml` (new deps)
- `backend/Dockerfile`

## Frontend (host)

```bash
cd frontend

# point Expo at the gateway via your Mac's LAN IP
cat > .env <<EOF
EXPO_PUBLIC_API_URL=http://$(ipconfig getifaddr en0):8080
EXPO_PUBLIC_WS_URL=ws://$(ipconfig getifaddr en0):8080
EOF

# first run on a real device (or simulator)
pnpm prebuild
pnpm ios:device       # or pnpm android:device, or pnpm ios for simulator

# subsequent JS-only reloads
pnpm start
```

## Stopping / cleaning up

```bash
docker compose stop                  # stop both, keep volumes
docker compose down                  # remove containers, keep volumes
docker compose down -v               # also drop named volumes (gateway_node_modules)
rm -rf data/hermes-home              # nuke Hermes state
rm -rf backend/data                  # nuke gateway state
```

## Common operations

### Update gateway dependencies

```bash
# On host: edit package.json, run pnpm install (refreshes lockfile + IDE)
cd backend && pnpm install
cd ..

# Rebuild image so the container picks up new deps
docker compose build gateway
docker compose up -d gateway
```

### Run a one-off Hermes CLI command

```bash
./scripts/hermes-cli.sh model              # interactive model picker
./scripts/hermes-cli.sh config get
./scripts/hermes-cli.sh cron list
```

### Shell inside the gateway container

```bash
docker compose exec gateway sh
```

### Watch logs

```bash
docker compose logs -f gateway
docker compose logs -f hermes
docker compose logs -f               # both
```

### Force-rotate the Hermes token (test refresh path)

```bash
docker compose restart hermes
# Gateway's next call gets 401, launcher re-scrapes the new token
# automatically. Watch `docker compose logs gateway` to see it happen.
```

### Inspect the gateway DB from host

```bash
sqlite3 backend/data/gateway.db
.tables
.schema users
```

## Troubleshooting

**Phone can't reach gateway**
- Confirm Mac LAN IP: `ipconfig getifaddr en0`
- Confirm phone on same Wi-Fi
- macOS firewall: System Settings → Network → Firewall → allow incoming for Docker
- Test from another device: `curl http://<lan-ip>:8080/health`

**`better-sqlite3` errors on first boot**
- The named volume `gateway_node_modules` got out of sync with `package.json`
- Fix: `docker compose down -v && docker compose up --build`

**File changes not detected**
- `CHOKIDAR_USEPOLLING=true` is already set in compose; if still missed,
  bump to `CHOKIDAR_INTERVAL=500` in compose env

**Hermes setup wizard hangs**
- `hermes-cli.sh setup` needs an interactive TTY. Run from a real terminal,
  not from Claude Code or a CI script.

**"depends_on healthcheck never goes green"**
- Hermes' first boot pulls Playwright/Chromium — can take 30-60s
- Check `docker compose logs hermes` for actual error
- If config.yaml is missing, run `./scripts/hermes-cli.sh setup` first

**Gateway logs show `ECONNREFUSED hermes:9119`**
- Hermes container died. `docker compose logs hermes` to see why.
- Common: API key missing from `~/.hermes/.env` (i.e. `data/hermes-home/.env`)

## Architecture notes

- **Networking:** `gateway` reaches Hermes via the compose service name (`http://hermes:9119`), bypassing the host's localhost. Hermes' host-header middleware accepts any `Host:` since it's bound to `0.0.0.0`. We DO also map Hermes to `127.0.0.1:9119` on the host purely for debugging — the gateway doesn't use that path.
- **Token capture:** With `HERMES_TOKEN=""` and `HERMES_LAUNCH_MODE=external`, the gateway's launcher scrapes `window.__HERMES_SESSION_TOKEN__` from `http://hermes:9119/` at boot and on every 401. No manual token step.
- **DB:** SQLite at `backend/data/gateway.db` (bind-mounted in). `pnpm db:migrate` runs at every container start; safe because drizzle-kit is idempotent.
- **Cron output watcher:** Gateway mounts `data/hermes-home` read-only at `/data/hermes-home`. Hermes writes outputs to `data/hermes-home/cron/output/{job_id}/*.md`. Gateway's chokidar watcher detects new files and fires Expo pushes.
- **Storage:** Local provider only. Blobs at `backend/data/blobs/`. Switch to S3 by editing `backend/.env` (no rebuild needed).

## Going to production (briefly)

The compose file is dev-tuned. For VPS:
1. Set `NODE_ENV=production` in env, swap `pnpm dev` → `pnpm build && node dist/index.js` in Dockerfile CMD
2. Drop the bind mounts on src/scripts (use the COPY layer)
3. Drop `CHOKIDAR_USEPOLLING`
4. Front Caddy on `:443` → `gateway:8080` (compose internal)
5. Don't expose `9119` to host loopback in prod — gateway-internal only
6. Add the systemd unit + Caddy config (next phase if you want).
