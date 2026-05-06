# VPS setup — operational notes

> **Maintenance rule:** every time we deploy code to the VPS, append a new
> entry to the **Deploy log** at the bottom of this file (date, source ref,
> what changed, what was migrated, what was restarted). Treat this doc as
> the canonical history of what's running where.

---

## Connection

```
ssh root@187.127.157.66
```

Hostname: `srv726875` · Ubuntu 24+ (kernel 6.17 on first audit) · domain
`hermes.drshnk.dev`.

## Layout

| Path | Purpose |
|---|---|
| `/root/repos/Hermes_agent` | Git clone of the project (origin = `https://github.com/dk5761/Hermes_agent`) |
| `/root/repos/Hermes_agent/backend` | Fastify gateway source |
| `/root/repos/Hermes_agent/backend/dist/src/index.js` | Built entrypoint (systemd starts this) |
| `/root/repos/Hermes_agent/backend/data/gateway.db` | SQLite — sessions, chat_history, FTS5 index, blobs metadata |
| `/root/repos/Hermes_agent/backend/.env` | Gateway secrets (HERMES_TOKEN, JWT_SECRET, etc.) |
| `/root/.hermes/` | Hermes agent state (config, cron output, logs) |

## Services

All systemd units, enabled, restart-on-failure:

| Unit | Process | Notes |
|---|---|---|
| `hermes-gateway` | `node dist/src/index.js` | Mobile-facing Fastify backend on `127.0.0.1:8080`. Nginx terminates TLS at `hermes.drshnk.dev` and proxies. |
| `hermes-dashboard` | `hermes …` | Provides `/api/ws` + tui_gateway that the mobile gateway depends on (port `127.0.0.1:9119`). |
| `hermes-cron` | `hermes gateway run` | Runs scheduled cron jobs and platform messaging gateways (Telegram/WhatsApp/etc.). |

Operations:
```bash
systemctl status hermes-gateway hermes-cron hermes-dashboard
journalctl -u hermes-gateway -f
journalctl -u hermes-gateway -n 200 --no-pager
```

## Nginx + TLS

Cert is certbot-managed for `hermes.drshnk.dev`. Only the gateway is exposed
publicly; dashboard/cron stay on localhost.

## Deploy procedure (standard)

Run as root from the VPS shell:

```bash
cd /root/repos/Hermes_agent
git fetch origin
git checkout main           # add -f if untracked files block
git pull --ff-only origin main

cd backend
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate              # idempotent — drizzle skips applied migrations

systemctl restart hermes-gateway
sleep 2
journalctl -u hermes-gateway -n 30 --no-pager --since "10 seconds ago"
```

Smoke test post-deploy:

```bash
curl -fsS http://127.0.0.1:8080/health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/search?q=test       # → 401
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/sessions/x/messages # → 401
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/sessions/x/usage    # → 401
```

If a new endpoint returns `404` instead of `401`, the route didn't register —
inspect logs and re-build.

## Deploy procedure (one-shot, idempotent)

`scripts/install-vps.sh` is the bootstrap that originally provisioned the
VPS. Re-running it picks up code changes, rebuilds, migrates, and restarts
without touching state — useful when also modifying systemd units or nginx.

```bash
sudo bash /root/repos/Hermes_agent/scripts/install-vps.sh
```

## Database

SQLite (`backend/data/gateway.db`). On first boot after a search-related
migration, the gateway runs a one-time backfill of the FTS5 `search_text`
column over `chat_history` (logged as
`search index backfilled: N rows in Xms`). Subsequent boots: no-op.

Snapshots of the Hermes side (not gateway DB) are taken via
`scripts/hermes-snapshot.sh`.

## Common pitfalls

- **Untracked file blocks `git checkout main`** — the file is identical on
  origin (e.g. a script that's already committed upstream). Use
  `git checkout -f main` after diffing to confirm content matches.
- **Backfill runs every boot** — means a previous run aborted, leaving
  rows with `search_text IS NULL`. Indexer is idempotent; on success the
  log line shows `search index up to date` instead of `... backfilled`.
- **Gateway sees 404 on a new route** — `pnpm build` likely didn't run, or
  the systemd unit wasn't restarted. Re-run the build + restart pair.

---

## Deploy log

### 2026-05-06 — branch + offline support + slash-worker history patch

- **Source:** `837d31a` (latest `main`).
- **Previous:** `c6fd37b` (offline gate creation flows).
- **Migrations applied:** `0007_branch_lineage.sql` (`parent_app_session_id` FK + index on `app_sessions`).
- **Hermes source patch applied:** `scripts/patch-hermes-slash-history.py` injected the `_preload_resumed_session()` call into `tui_gateway/slash_worker.py`. Without it, history-aware slash commands (e.g. `/branch`) bail out with empty `conversation_history` because the slash worker never enters the lazy-loading `cli.run()` path. Patch is idempotent and persists across `hermes update` via `post-hermes-update.sh` step 2bb.
- **New routes verified (auth-gated, 401):**
  - `POST /sessions/:id/branch`
- **Restarted:** `hermes-dashboard` (so the slash-worker subprocess pool reloads with the patched module), then `hermes-gateway` (rebuilt; new branch endpoint).
- **Branch state on VPS after deploy:** `main` tracking `origin/main` at `837d31a`.

### 2026-05-05 — search + chat pagination + offline queue + privacy veil

- **Source:** `eb4f3ca` (latest `main`).
- **Previous:** `67601a5` on `feat/reload-mcp`. VPS was 47 commits behind.
- **Migrations applied:** `0006_search_fts.sql` (FTS5 schema + `search_text`
  column on `chat_history`).
- **First-boot backfill:** 300 chat_history rows indexed in 8ms.
- **New routes verified (all return 401 missing_bearer):**
  - `GET /search?q=`
  - `GET /sessions/:id/messages?limit=&before=&around=`
  - `GET /sessions/:id/usage`
- **Restarted:** `hermes-gateway`. Dashboard + cron untouched.
- **Branch state on VPS after deploy:** `main` tracking `origin/main` at
  `eb4f3ca`. The previous local `feat/reload-mcp` branch retained.
