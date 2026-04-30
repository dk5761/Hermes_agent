# Hermes Adapter Contract (Phase 0 output)

Audited against `../hermes-agent/` upstream (Nous Research Hermes Agent).

## Hermes process

- Entry: `python -m hermes_cli.main web` (or `hermes web`).
- Default bind: `127.0.0.1:9119`. Refuses non-loopback unless `--insecure`.
- Auth: per-process random `_SESSION_TOKEN` (`secrets.token_urlsafe(32)`).
  - **Not env-overridable.** Generated fresh on every start.
  - Only surfaced via `<script>window.__HERMES_SESSION_TOKEN__="..."</script>` injected into the SPA index HTML at `web_server.py:2617`.
  - Sent as `X-Hermes-Session-Token: <tok>` or `Authorization: Bearer <tok>`.
  - WS auth via `?token=<tok>` query string on `/api/ws` upgrade.
- Host-header middleware locks to bound interface (`localhost`/`127.0.0.1`/`::1` for loopback) — gateway must send a matching `Host` header.
- CORS regex locks to `localhost|127.0.0.1` — never call from mobile/browser; always relay through gateway.
- `~/.hermes/` is the data root: `state.db` (SQLite), `cron/jobs.json`, `cron/output/{job_id}/*.md`, `config.yaml`, `logs/`.

## Gateway launcher strategy

1. Spawn Hermes as child process (`uv run` or `python -m hermes_cli.main web --port 9119`).
2. Capture stdout/stderr to gateway logs.
3. Poll `GET http://127.0.0.1:9119/` until 200, parse `window.__HERMES_SESSION_TOKEN__="(.+)"` from response body.
4. Use the captured token for all `/api/*` REST + `/api/ws` WS calls.
5. On Hermes restart (detected via WS close + REST 401), re-scrape token.
6. Health check: `GET /api/status` (public).

## REST surface (proxied via gateway)

All endpoints under `/api/*` require the token except: `/api/status`, `/api/config/defaults`, `/api/config/schema`, `/api/model/info`, `/api/dashboard/themes`, `/api/dashboard/plugins*`, `/api/plugins/*`.

| Gateway route | Hermes route | Notes |
|---|---|---|
| `GET /sessions` | `GET /api/sessions?limit=&offset=` | returns `{sessions, total, limit, offset}` |
| `GET /sessions/search?q=` | `GET /api/sessions/search` | FTS5 |
| `GET /sessions/:id` | `GET /api/sessions/{id}` | |
| `GET /sessions/:id/messages` | `GET /api/sessions/{id}/messages` | |
| `DELETE /sessions/:id` | `DELETE /api/sessions/{id}` | |
| `GET /cron/jobs` | `GET /api/cron/jobs` | |
| `POST /cron/jobs` | `POST /api/cron/jobs` | |
| `PATCH /cron/jobs/:id` | `PUT /api/cron/jobs/{id}` | |
| `POST /cron/jobs/:id/(pause\|resume\|trigger)` | same | |
| `DELETE /cron/jobs/:id` | same | |
| `GET /cron/outputs?job_id=` | **not exposed** | Read `~/.hermes/cron/output/{job_id}/*.md` from FS. Add custom Hermes endpoint later if desired. |
| `GET /model/info` | `GET /api/model/info` | public, no token |
| `GET /skills` | `GET /api/skills` | |
| `GET /tools/toolsets` | `GET /api/tools/toolsets` | |
| `GET /logs?file=&lines=` | `GET /api/logs` | |
| `GET /analytics/usage?days=` | `GET /api/analytics/usage` | |

POST `/sessions` and `PATCH /sessions/:id` (rename/archive) — Hermes has no native rename API. Gateway-side title override stored in gateway DB, fall through to Hermes `title` if no override.

## WebSocket: `/api/ws` (JSON-RPC 2.0)

Newline-delimited JSON-RPC. Connect → server emits `gateway.ready` event → client sends requests, server emits responses + push events.

### Methods (client → server)

- `session.create {cols?}` → `{session_id, info}` (async; `session.info` follows)
- `session.list {limit?}` → `{sessions:[...]}`
- `session.resume {session_id, cols?}` → `{session_id, resumed, message_count, messages, info}`
- `session.title|usage|history|undo|compress|save|close|branch|steer {session_id, ...}`
- `session.interrupt {session_id}` — abort current turn
- `prompt.submit {session_id, text}` — start streaming turn
- `prompt.background {session_id, text}` → `{task_id}`
- `image.attach {session_id, path}` — **path must be locally readable by Hermes process**
- `clarify.respond | sudo.respond | secret.respond | approval.respond` — respond to blocking requests
- `config.set | config.get`
- `commands.catalog | command.dispatch | slash.exec | cli.exec`
- `model.options | terminal.resize | voice.toggle | process.stop | reload.mcp`
- Spawn-tree / subagent ops as needed

### Events (server → client)

- Lifecycle: `gateway.ready`, `session.info`, `error`, `status.update`
- Streaming a turn: `message.start` → `message.delta` (+ `thinking.delta`, `reasoning.delta`) → `message.complete {text, usage, status, reasoning?, warning?}`
- Tools: `tool.start`, `tool.generating`, `tool.progress`, `tool.complete`, `reasoning.available`
- Subagents: `subagent.start`, `subagent.tool`, `subagent.complete`
- Blocking: `approval.request`, `clarify.request`, `sudo.request`, `secret.request`
- Voice: `voice.transcript`, `voice.status`
- Background: `background.complete`

## Adapter strategy summary

| Capability | Strategy |
|---|---|
| Sessions list/get/search/messages/delete | HTTP proxy |
| Chat send + stream + tool/reasoning + approvals | One upstream WS per active mobile session, JSON-RPC pass-through with envelope translation |
| Image upload | Mobile → gateway HTTP upload → gateway materializes blob to local FS path → `image.attach {path}` over WS |
| Cron CRUD | HTTP proxy |
| Cron outputs | Read from `~/.hermes/cron/output/` (gateway has FS access to Hermes home) |
| Model info / config / skills / toolsets / logs / analytics | HTTP proxy |
| Auth | Gateway adds its own JWT layer; Hermes token stays internal |

## Risks tracked

1. **Approval blocking** — Hermes blocks for ≤300s; mobile must respond within window or gateway auto-denies.
2. **Mid-turn reconnect loses deltas** — gateway snapshots final `message.complete` to its event log; mobile reconciles via `lastEventId` + Hermes `session.resume` history fetch.
3. **Hermes restart** — invalidates token + WS sessions; gateway re-scrapes token + reconnects, mobile sees `sync.required`.
4. **`session.create` is async** — gateway must not return until `session.info` event fires, or surface a "preparing" state.
5. **Plugin routes (`/api/plugins/*`)** — bypass auth in Hermes; do not proxy.
6. **No cron output endpoint** — FS read in gateway. Document path so future S3-mode keeps working (cron outputs stay local to Hermes).

## Source references

- `hermes-agent/hermes_cli/web_server.py` — REST + auth + token injection
- `hermes-agent/tui_gateway/server.py` — JSON-RPC dispatcher
- `hermes-agent/tui_gateway/ws.py` — WS handler
- `hermes-agent/hermes_state.py` — SQLite session/message schema
- `hermes-agent/cron/jobs.py`, `cron/scheduler.py` — cron storage + scheduler
- `hermes-agent/agent/image_routing.py` — vision input routing
