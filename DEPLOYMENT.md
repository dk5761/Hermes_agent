# Deployment — VPS (no Docker)

Production deployment of the Hermes mobile gateway + Hermes core agent on a single Ubuntu VPS, fronted by nginx with Let's Encrypt TLS.

## Stack

```
[mobile app]
    │ HTTPS / WSS  (DNS via Cloudflare, A record → VPS public IP)
    ▼
[nginx :443]  Let's Encrypt cert, auto-renew via certbot.timer
    │ HTTP/1.1 + Upgrade
    ▼
[hermes-gateway.service]  systemd · Node 22 · 127.0.0.1:8080
    │ JSON-RPC over WS
    ▼
[hermes-dashboard.service]  systemd · Python 3.13 · 127.0.0.1:9119
    │
    ▼
[Hermes core]  ~/.hermes/ (sessions / skills / cron / memories)
```

| Layer | Purpose | Source |
|---|---|---|
| nginx | TLS termination + reverse proxy + WS upgrade | `/etc/nginx/sites-available/hermes` |
| `hermes-gateway` | Mobile-facing Fastify backend (`backend/src/index.ts`) | `~/repos/Hermes_agent/backend/` |
| `hermes-dashboard` | Python entry that exposes the JSON-RPC bridge the gateway speaks to | `hermes dashboard --port 9119 --tui` |

## Production endpoints

- App API: `https://hermes.drshnk.dev`
- WebSocket: `wss://hermes.drshnk.dev/api/ws`
- Health: `https://hermes.drshnk.dev/health`

Mobile app picks the host up from `frontend/.env`:

```
EXPO_PUBLIC_API_URL=https://hermes.drshnk.dev
EXPO_PUBLIC_WS_URL=wss://hermes.drshnk.dev
```

Rebuild the iOS bundle (`npx expo run:ios --device`) after editing — env vars are baked at build time.

## Daily ops

### One-shot scripts (TL;DR)

| Goal | Command |
|---|---|
| Fresh VPS bootstrap | `sudo DOMAIN=hermes.drshnk.dev bash scripts/install-vps.sh` |
| After `hermes update` | `sudo bash scripts/post-hermes-update.sh` |
| Add/refresh Obsidian sync | `sudo bash scripts/install-obsidian-sync.sh` |
| Re-apply config patches only | `python3 scripts/patch-hermes-config.py --config /root/.hermes/config.yaml` |

All four are idempotent and safe to re-run. `install-vps.sh` chains `install-obsidian-sync.sh` automatically at the end (skip with `SKIP_OBSIDIAN=1`).

The hand-written walk-through below still lives here for reference / debugging — but in 95% of cases the scripts above are the answer.

### Live logs

```bash
ssh root@<vps> "journalctl -u hermes-gateway -u hermes-dashboard -f"
```

Filter to one service:

```bash
ssh root@<vps> "journalctl -u hermes-gateway -f"
ssh root@<vps> "journalctl -u hermes-dashboard -f"
```

### Restart

```bash
ssh root@<vps> "systemctl restart hermes-dashboard hermes-gateway"
```

**Always restart both together.** Hermes 0.12+ regenerates an in-memory `_SESSION_TOKEN` on every dashboard startup. The gateway scrapes that token from `/index.html` once at start time and reuses it for every upstream WS open. The auto-refresh path only triggers on HTTP 401, but a stale-token WS upgrade gets rejected with a "non-101 status" error that the gateway doesn't recognize as auth-related — so it never re-scrapes. Result: every chat hangs with `upstream_ws_open_failed`. Bare `systemctl restart hermes-dashboard` (without restarting the gateway) is what causes this; the one-liner above is correct.

### Restart and verify (one command, run after any deploy or VPS reboot)

```bash
ssh root@<vps> "systemctl restart hermes-dashboard hermes-gateway && sleep 8 && \
  echo '=== service status ===' && systemctl is-active hermes-dashboard hermes-gateway nginx && \
  echo && echo '=== ports ===' && ss -tlnp | grep -E ':(80|443|8080|9119)\s' && \
  echo && echo '=== gateway → hermes link ===' && \
  journalctl -u hermes-gateway --since '15 seconds ago' --no-pager | grep -iE 'using external|upstream|listening|migrations|ECONNREFUSED' | tail -8 && \
  echo && echo '=== external HTTPS ===' && \
  curl -s -m 10 https://hermes.drshnk.dev/health -w 'HTTP %{http_code}\n'"
```

A healthy run reports:

| Section | Healthy output |
|---|---|
| service status | three `active` lines (dashboard / gateway / nginx) |
| ports | `127.0.0.1:8080` (gateway), `127.0.0.1:9119` (hermes), `0.0.0.0:80` + `0.0.0.0:443` (nginx) |
| gateway → hermes link | `db migrations up to date` + `using external Hermes` + `Server listening at http://127.0.0.1:8080` + `gateway.ready` event |
| external HTTPS | `{"status":"ok","uptimeS":N}` followed by `HTTP 200` |

If the link line shows `ECONNREFUSED 127.0.0.1:9119`, `hermes-dashboard` failed to start — drop into `journalctl -u hermes-dashboard -n 100 --no-pager` for the cause (commonly missing `hermes login` for a provider, or a corrupt `~/.hermes/`).

If service status shows `failed` for `hermes-gateway`, check whether you remembered the migrations copy step after a build:

```bash
ssh root@<vps> "ls /root/repos/Hermes_agent/backend/dist/src/db/migrations/ 2>/dev/null | head"
```

Should list at least the latest `.sql` files. If empty / missing, see the **Re-deploy** section.

### Status

```bash
ssh root@<vps> "systemctl status hermes-dashboard hermes-gateway --no-pager"
```

### Re-deploy after backend code changes

Push your local backend tree (excluding caches and the `.env`):

```bash
rsync -avz --delete \
  --exclude=node_modules --exclude=dist --exclude=data --exclude='.env*' \
  ./backend/ \
  root@<vps>:/root/repos/Hermes_agent/backend/

ssh root@<vps> "
  cd /root/repos/Hermes_agent/backend
  pnpm install --frozen-lockfile
  pnpm build
  rm -rf dist/src/db/migrations
  cp -r src/db/migrations dist/src/db/migrations
  systemctl restart hermes-gateway
"
```

The `cp migrations` step is required because `tsc` only compiles TypeScript — the SQL migration files don't move into `dist/` on their own. The runtime auto-migrator (`backend/src/db/client.ts::runMigrations`) reads from `dist/src/db/migrations/` in production.

### Update Hermes core

When upgrading Hermes (the Python agent at `/usr/local/lib/hermes-agent/`), follow Hermes' own upgrade docs, then:

```bash
ssh root@<vps> "systemctl restart hermes-dashboard hermes-gateway"
```

After a Hermes upgrade you may also need to re-apply the project's MCP-server / toolset config — see the next section.

### Patch Hermes config (MCP servers + platform_toolsets)

Hermes config lives outside this repo (per-host: `~/.hermes/config.yaml` on the VPS, `./data/hermes-home/config.yaml` for local docker). To keep this project's required `mcp_servers` + `platform_toolsets` entries in sync across hosts, this repo ships an idempotent patch script at `scripts/patch-hermes-config.py`.

The script's desired state lives in two dicts at the top of the file:

```python
DESIRED_MCP_SERVERS = { "fs": { "command": "npx", ... } }
DESIRED_PLATFORM_TOOLSETS = { "cli": ["hermes-cli", "mcp-fs"] }
```

Edit those, commit, then re-run on each host. The patch is purely additive — it never overwrites or removes entries you've added by hand. A `.bak` is written before any change.

#### One-time prereq per host

```bash
# macOS:
python3 -m pip install --user ruamel.yaml

# Debian / Ubuntu (VPS):
apt-get install -y python3-ruamel.yaml
```

#### Local (docker)

```bash
cd <repo>
./scripts/patch-hermes-config.py            # default: ./data/hermes-home/config.yaml
docker compose restart hermes gateway
```

Note: docker-compose `restart` is **not** sufficient when the gateway's env_file changed (compose only reads env at container CREATE). For env changes use `docker compose up -d --force-recreate gateway`. For the patch script (which only mutates Hermes' YAML), `restart` works.

#### VPS

```bash
ssh root@<vps>
cd /root/repos/Hermes_agent
git pull
python3 scripts/patch-hermes-config.py --config /root/.hermes/config.yaml
systemctl restart hermes-dashboard hermes-gateway
```

Or one-shot from your laptop:

```bash
ssh root@<vps> "cd /root/repos/Hermes_agent && git pull && \
  python3 scripts/patch-hermes-config.py --config /root/.hermes/config.yaml && \
  systemctl restart hermes-dashboard hermes-gateway"
```

#### Dry-run / CI

```bash
./scripts/patch-hermes-config.py --check    # exits 1 if changes needed, 0 if up-to-date
```

#### Adding a new MCP server (the rule that bit us)

The toolset gating that controls which MCP tools the agent can actually call is `platform_toolsets.<platform>`, **not** the top-level `toolsets:`. For mobile-app sessions the platform is `cli`. So every new MCP server needs **two** entries in the desired state, one in each dict:

```python
DESIRED_MCP_SERVERS = {
    "myserver": {                                # ← line A: declares the server
        "command": "npx",
        "args": ["-y", "some-mcp-package"],
        "timeout": 60,
        "connect_timeout": 30,
    },
}

DESIRED_PLATFORM_TOOLSETS = {
    "cli": [
        "hermes-cli",
        "mcp-myserver",                          # ← line B: gate must match server name
    ],
}
```

Without line B, MCP server connects fine, registers tools, but the agent's `enabled_toolsets` filter excludes them — the chat shows `Agent updated — 0 tool(s) available` even though MCP-layer reports `🔧 N tool(s) available from M server(s)`. The Reload-MCP toast will surface this discrepancy explicitly:

| Toast | What it means |
|---|---|
| `✅ N MCP tool(s) available` | Fully wired |
| `MCP loaded N tools but agent has 0 — check platform_toolsets` | Missing `mcp-<name>` in `platform_toolsets.cli` |
| `K/N MCP tools available to agent` | Partial — some server's tools not in cli toolset list |
| `No MCP servers connected` | MCP server failed to start (config / runtime issue) |

### Backup

#### Automated daily snapshots → private GitHub repo (production setup)

A cron job on the VPS encrypts the full Hermes state every day at 04:00 UTC and pushes it to `git@github.com:dk5761/hermes-snapshots.git` (private repo). Keeps last 14 days of snapshots; weekly aggressive `git gc` shrinks the pack so the repo stays around ~250MB.

What's included:
- `~/.hermes/` — config, sessions, memories, skills, cron jobs, SOUL.md, .env (encrypted)
- `~/repos/Hermes_agent/backend/data/` — gateway SQLite + uploaded blobs

What's excluded (regeneratable): `audio_cache/`, `image_cache/`, `logs/`, `models_dev_cache.json`.

Encryption: AES-256 symmetric via GPG. The passphrase lives at `/root/.hermes-snapshot.pass` on the VPS (root-only, `chmod 600`) and a copy must live in your password manager. **Lose both = backups unrecoverable.**

Components:

| File | Purpose |
|---|---|
| `/root/hermes-snapshot.sh` | The script (tar + gpg + git push + prune) |
| `/root/.hermes-snapshot.pass` | GPG passphrase, root-only |
| `/root/hermes-snapshots/` | Local clone of the private GitHub repo |
| `/var/log/hermes-snapshot.log` | Daily run log |
| crontab `0 4 * * *` | Trigger |

Manual snapshot (if you want one outside the daily cron):

```bash
ssh root@<vps> "/root/hermes-snapshot.sh"
```

Verify recent runs:

```bash
ssh root@<vps> "tail -20 /var/log/hermes-snapshot.log"
```

Inspect what's in the repo:

```bash
ssh root@<vps> "cd /root/hermes-snapshots && git log --oneline -10 && ls -lh"
```

#### Restore on a fresh VPS

```bash
# 1. Bring up the empty VPS, install Hermes core + mobile gateway per the
#    "First-time setup" runbook above (system packages, hermes core install,
#    repo clone, systemd units, nginx, certbot). Skip the .env / data setup.

# 2. Clone the snapshots repo
git clone git@github.com:dk5761/hermes-snapshots.git
cd hermes-snapshots

# 3. Pick the latest snapshot
LATEST=$(ls -t snapshot-*.tar.gz.gpg | head -1)
echo "Restoring $LATEST"

# 4. Decrypt — prompts for the passphrase from your password manager
gpg --decrypt "$LATEST" | tar xz -C /

# 5. Restart services
systemctl restart hermes-dashboard hermes-gateway
```

Within 5 minutes the new VPS has the same chat history, skills, cron jobs, secrets, and blobs as the old one. The gateway will re-scrape its Hermes auth token on next WS connect; mobile clients re-auth on next launch.

If you need to restore on a machine that doesn't have GitHub SSH access set up, you can also `gh release download` from a phone or use a fine-grained PAT.

#### Cleanup / change retention

Edit the `KEEP_DAYS=14` line in `/root/hermes-snapshot.sh`. Increase if you want longer history (cost ~15MB per extra day on disk + GitHub repo size).

To stop snapshots:

```bash
ssh root@<vps> "crontab -l | grep -v hermes-snapshot.sh | crontab -"
```

#### Ad-hoc one-off backup (local download to your laptop)

Smaller scope (just gateway DB + blobs, no Hermes state):

```bash
ssh root@<vps> "
  cd /root/repos/Hermes_agent/backend/data
  tar czf - gateway.db blobs/
" > "hermes-gateway-$(date +%Y%m%d).tgz"
```

Hermes' own state (sessions / memories / config):

```bash
ssh root@<vps> "tar czf - -C /root .hermes/" > "hermes-home-$(date +%Y%m%d).tgz"
```

## First-time setup (re-creation runbook)

Use this if you ever rebuild the VPS from scratch.

### 1. System packages

```bash
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  curl ca-certificates gnupg build-essential python3 \
  nginx certbot python3-certbot-nginx \
  poppler-utils tesseract-ocr tesseract-ocr-eng \
  dnsutils
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g pnpm@latest
```

### 2. Hermes core

Install per Hermes' own docs (the Python agent isn't covered here — its installer drops files at `/usr/local/lib/hermes-agent/` and a `hermes` binary at `/usr/local/bin/hermes`). Configure with `hermes setup`, log in to providers with `hermes login`. State lives at `~/.hermes/`.

### 3. Mobile gateway code

```bash
mkdir -p /root/repos
cd /root/repos
git clone <your-repo-url> Hermes_agent
cd Hermes_agent/backend
pnpm install --frozen-lockfile
pnpm build
mkdir -p data data/blobs data/cache/materialized
cp -r src/db/migrations dist/src/db/migrations
```

Drop your `.env` into `/root/repos/Hermes_agent/backend/.env`. See **Secrets** below.

### 4. systemd units

`/etc/systemd/system/hermes-dashboard.service`:

```ini
[Unit]
Description=Hermes dashboard (provides /api/ws + tui_gateway for the mobile gateway)
After=network.target

[Service]
Type=simple
User=root
Environment=HOME=/root
Environment=HERMES_DASHBOARD_TUI=1
ExecStart=/usr/local/bin/hermes dashboard --port 9119 --host 127.0.0.1 --no-open --tui
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hermes-dashboard

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/hermes-gateway.service`:

```ini
[Unit]
Description=Hermes mobile gateway (Fastify backend)
After=network.target hermes-dashboard.service

[Service]
Type=simple
User=root
WorkingDirectory=/root/repos/Hermes_agent/backend
EnvironmentFile=/root/repos/Hermes_agent/backend/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/src/index.js
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hermes-gateway

[Install]
WantedBy=multi-user.target
```

Enable + start:

```bash
systemctl daemon-reload
systemctl enable --now hermes-dashboard hermes-gateway
```

### 5. nginx

`/etc/nginx/conf.d/websocket-upgrade.conf` (defines the upgrade map at http-scope):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

`/etc/nginx/sites-available/hermes`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name hermes.drshnk.dev;

    client_max_body_size 50m;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable + reload:

```bash
ln -sf /etc/nginx/sites-available/hermes /etc/nginx/sites-enabled/hermes
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

### 6. DNS

Add an A record at your DNS provider for `hermes.drshnk.dev` → VPS public IP. Confirm:

```bash
dig hermes.drshnk.dev +short
```

Should return the VPS IP. If it returns `NXDOMAIN`, the record isn't on the **authoritative** nameservers yet (check with `dig drshnk.dev NS` to find them, then query directly).

### 7. TLS

```bash
certbot --nginx -d hermes.drshnk.dev \
  --non-interactive --agree-tos -m you@example.com --redirect
```

Certbot mutates the nginx site to add `listen 443 ssl;` plus a 301 redirect from HTTP→HTTPS. Renewal is handled by the `certbot.timer` systemd unit installed by the package — no extra cron needed.

Verify:

```bash
curl -s https://hermes.drshnk.dev/health
# → {"status":"ok","uptimeS":N}
```

## Secrets

The `.env` file controls authentication, blob signing, and APNs push. Three values **must** be replaced from the default placeholders before exposing the service publicly:

| Key | Why |
|---|---|
| `JWT_SECRET` | Forging this lets anyone mint JWTs and impersonate any user |
| `STORAGE_SIGNED_URL_SECRET` | Forging this lets anyone fetch any blob via signed URL |
| `BOOTSTRAP_PASSWORD` | Initial admin account password |

Rotation one-liner:

```bash
ssh root@<vps> "
  cd /root/repos/Hermes_agent/backend
  sed -i \"s|^JWT_SECRET=.*|JWT_SECRET=\$(openssl rand -hex 32)|\" .env
  sed -i \"s|^STORAGE_SIGNED_URL_SECRET=.*|STORAGE_SIGNED_URL_SECRET=\$(openssl rand -hex 32)|\" .env
  systemctl restart hermes-gateway
"
```

After rotating `JWT_SECRET`, every existing access token is invalid. Mobile clients re-auth automatically on next launch via the refresh-token flow — but tokens issued by the old secret won't refresh, so users will get bounced to the login screen once.

`BOOTSTRAP_PASSWORD` is only used on first boot when there are no users in the DB. Once you've created accounts, change it to a strong value or delete the line — the gateway no longer needs it.

The APNs key (`APNS_KEY_P8`) is a base64-encoded `.p8` from Apple. Keep it secret. If it leaks, generate a new key on Apple Developer → Certificates → Keys, replace `APNS_KEY_ID` and `APNS_KEY_P8`, restart the gateway.

## Troubleshooting

### Gateway boots, then exits with "migrations folder missing"

`tsc` compiled but you forgot to copy `src/db/migrations/` into `dist/src/db/migrations/`. Re-run the migrations copy step from the deploy block.

### Gateway reports `connect ECONNREFUSED 127.0.0.1:9119`

`hermes-dashboard.service` isn't running. `systemctl status hermes-dashboard`. If it's failing, `journalctl -u hermes-dashboard -n 100 --no-pager`. Common causes:

- `hermes login` was never run for the configured provider — `hermes status` shows the unconfigured state
- `~/.hermes/` permissions wrong (must be readable+writable by the user running the service)
- Port 9119 already taken by another process — `ss -tlnp | grep 9119`

### Mobile app can authenticate but chat hangs forever

Symptom: login works, sessions list works, but sending a message produces no streaming response.

Likely the gateway → Hermes upstream WS isn't up. Two-line check:

```bash
ssh root@<vps> "journalctl -u hermes-gateway -n 200 --no-pager | grep -iE 'upstream|hermes|token'"
```

If you see `scraping Hermes token from served HTML` followed quickly by `using external Hermes`, the link is fine. If you see ECONNREFUSED loops, see the previous troubleshooting entry.

### certbot fails with "DNS problem: NXDOMAIN"

The A record isn't propagated. Wait, then re-query authoritative NS directly:

```bash
dig drshnk.dev NS +short            # find authoritative servers
dig hermes.drshnk.dev @<one-of-those-NS> +short
```

If the authoritative server returns the IP but `1.1.1.1` doesn't, public resolvers are caching an old `NXDOMAIN`. Wait for that cache (TTL 15 min default) or re-issue from a different network.

### nginx upstream error after VPS reboot

`hermes-dashboard` may take a few seconds to come up. If `hermes-gateway` started first and gave up, it won't retry on its own — `systemctl restart hermes-gateway`. The unit's `After=hermes-dashboard.service` ordering helps but doesn't guarantee dashboard is actually listening when gateway starts.

If this is recurring, add a health check to the gateway unit:

```ini
[Service]
ExecStartPre=/bin/sh -c 'until ss -tln | grep -q ":9119"; do sleep 1; done'
```

### Logs are noisy with cron-watcher misses

Hermes' cron output watcher polls `~/.hermes/cron/output/`. If you don't use cron jobs, set `CRON_OUTPUT_WATCH_ENABLED=false` in the gateway's `.env` and restart.

## Resources by service

```
hermes-gateway:
  cwd       /root/repos/Hermes_agent/backend
  binary    /usr/bin/node dist/src/index.js
  env       /root/repos/Hermes_agent/backend/.env
  data      /root/repos/Hermes_agent/backend/data/
  port      127.0.0.1:8080

hermes-dashboard:
  cwd       /root  (HOME=/root)
  binary    /usr/local/bin/hermes dashboard ...
  data      /root/.hermes/
  port      127.0.0.1:9119

nginx:
  config    /etc/nginx/sites-available/hermes
  certs     /etc/letsencrypt/live/hermes.drshnk.dev/
  ports     0.0.0.0:80, 0.0.0.0:443
```
