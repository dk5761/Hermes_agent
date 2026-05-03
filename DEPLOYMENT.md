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

The gateway re-scrapes Hermes' auth token on every WS connect, so order is not strict — but restarting `hermes-dashboard` while the gateway is running causes a transient upstream-disconnect that the gateway recovers from on its own.

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

### Backup

Two paths to back up. The gateway's database + blobs:

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
