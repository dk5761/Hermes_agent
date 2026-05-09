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

### 2026-05-09 — chat: historyId on envelopes for live↔history dedup

- **Source:** `4736577` (latest `main`, includes b9be3e2 backend change).
- **Previous:** `dc7afe3` (hermes v0.12.0 → v0.13.0 + patches, same day).
- **Migrations applied:** none.
- **Restarted:** `hermes-gateway` only.
- **Backend changes (`backend/src/ws/gateway-ws.ts`):**
  - `gateway.user.message`: reordered to call `appendHistory` first, capture the `chat_history.id`, then stamp it on the envelope payload as `historyId` before `appendEvent`.
  - `message.complete`: same reorder. Both the TTS-bridge variant and the default path through `maybePersistHistory` now stamp `historyId`.
  - `tool.complete`: same reorder. TTS-bridge variant + default path both stamp `historyId` for the persisted `tool.call` row.
  - `maybePersistHistory` signature changed: now returns `{ historyId } | null` so the default emit path can inject the id.
- **Why:** mobile chat-store reducers now key live message ids off `historyId` (`hist-u-${historyId}` / `hist-a-${historyId}` / `hist-t-${historyId}`) to match what `historyRowToUiRow` produces for the same row. Without aligned ids, the dedup filter in `chat/[id].tsx` couldn't drop history copies after a session-messages refetch, and the entire turn rendered twice. Closing/reopening the app "fixed" the duplication because cold start wipes the in-memory chat-store.
- **Frontend (mobile, OTA, NOT in this VPS deploy):** chat-store gains a `gateway.user.message` reducer case (rename live UserMessage by clientId) plus updated `message.complete` / `tool.complete` reducers that prefer the history-id-derived id when present. Older clients that don't read `historyId` still work — they just see live ids unchanged.
- **Compatibility:** older clients (no `historyId` reader) ignore the extra payload field. No breaking change.
- **Verified:** `curl /health` → 200 + `/cron/outputs/by-job` → 401 + `/ws` → 404 (route is upgrade-only). Gateway uptime ticks from 0 post-restart.
- **Branch state on VPS after deploy:** `main` tracking `origin/main` at `4736577`.

### 2026-05-09 — hermes-agent system bump v0.12.0 → v0.13.0 + patches re-applied

- **System hermes:** `v0.12.0 (2026.4.30)` → `v0.13.0 (2026.5.7)` via `hermes update`. 643 commits applied. `hermes-agent` Python package version `0.11.0 → 0.13.0` upstream; `croniter` is now a core dep.
- **Submodule pointer (parent repo):** `7d46484 → 498bfc7c` (commit `d5fa256`). Verified locally before VPS deploy: all 7 patch scripts apply cleanly to the new source (apply → check → unpatch round-trip, all touched files parse).
- **Patches re-applied (all idempotent on `--apply`):**
  - `patch-hermes-config.py` — already up to date (no config drift from update).
  - `patch-hermes-reload-mcp.py` (`gateway/run.py` + `hermes_cli/main.py`).
  - `patch-hermes-slash-history.py` (`tui_gateway/slash_worker.py`, preload + refresh).
  - `patch-hermes-stt-rpc.py` (`tui_gateway/server.py`).
  - `patch-hermes-stt-warmup.py` (`tui_gateway/server.py`).
  - `patch-hermes-stt-introspect.py` (`tools/stt_introspect_tool.py` + `toolsets.py`).
  - `patch-hermes-tts-kokoro.py` (`tools/tts_tool.py`, three injections — cache, generate, dispatch).
  - `patch-hermes-tts-warmup.py` (`tui_gateway/server.py`).
  - All marked `PATCHED` in post-update `--check`.
- **Custom skills redeployed:** `manage-mcp`.
- **Restarted (in order):** `hermes-dashboard` → `hermes-gateway` → `hermes-cron`. The dashboard restart rotates `_SESSION_TOKEN`, gateway re-scrapes from `/index.html`. Skipping that order leaves chat hung with `upstream_ws_open_failed`.
- **Verified:**
  - `hermes --version` → `v0.13.0 (2026.5.7) — Up to date`.
  - `curl /health` → 200, uptime ticks from 0.
  - `curl /cron/outputs/by-job` → 401 (route registered, auth-gated).
  - `doctor.sh` → PASS (services up, HTTP reachable, source patches present, MCP listing succeeds, dashboard token scrapeable).
- **Notes:**
  - Pre-update snapshot **failed to push** to `dk5761/hermes-snapshots` (GitHub 100MB file size limit; existing 334MB + 354MB tarballs rejected). Re-ran with `SKIP_SNAPSHOT=1`. Pre-existing concern — needs git-lfs or a separate object store. Local snapshot tarballs still exist in `/root/hermes-snapshots/` (the upload-to-GitHub leg is what's broken).
- **Branch state on VPS after deploy:** `main` tracking `origin/main` at `d5fa256`. System hermes at upstream commit-hash equivalent of `498bfc7c`.

### 2026-05-09 — cron Jobs/Outputs split + outputs aggregator

- **Source:** `c795625` (latest `main`).
- **Previous:** `66e20ad` (chat.send idempotency, 2026-05-08).
- **Migrations applied:** none.
- **Restarted:** `hermes-gateway` only.
- **Backend changes:**
  - New endpoint `GET /cron/outputs/by-job` — one row per job that has runs on disk, sorted newest-first, includes orphan dirs whose parent job was deleted (frontend renders an `archived` badge for those).
  - `cron-fs.ts` `extractPreview()` now anchors on the `## Response` heading so list-row previews skip the Hermes preamble (Job ID / Run Time / Schedule / Prompt) and read from the actual run output.
  - Read buffer per file bumped 1 KB → 8 KB so long prompt blocks don't push the response body out of range.
  - `CronOutputSummary` / `CronOutput` now include a populated `preview` field; `CronOutputSummary.createdAt` is now a string (ISO) — frontend types updated to match.
- **Verified on VPS:**
  - `curl /health` → 200, uptime ticks from 0.
  - `curl /cron/outputs/by-job` → 401 (route registered + auth required, not 404).
  - `curl /cron/outputs?job_id=x` and `/cron/jobs` → 401 (existing routes still wired).
- **Frontend (mobile, OTA, NOT in this VPS deploy):**
  - Cron tab now splits into `[Jobs | Outputs]` via SegControl. New `CronJobOutputs` screen at `/(cron)/[jobId]/outputs`. CronDetail "Recent runs" capped at 4 with "See all" → that screen.
  - `cache/query-persister.ts` skips `pending` + `error` queries from dehydration (fixes the "promise.then is not a function" crash on launch). `PERSIST_BUSTER` bumped to 2 to wipe any poisoned cache row from prior launches.
  - `chat.abort` is now durable — routed through `usePendingSends` so the queue-drainer re-delivers it on reconnect. Fixes the kill+reopen case where stopping a generation but losing the abort frame in transit caused the response to "auto-restart" on reopen.
- **Branch state on VPS after deploy:** `main` tracking `origin/main` at `c795625`.

### 2026-05-08 — chat.send idempotency via clientId

- **Source:** `66e20ad` (latest `main`).
- **Previous:** `cd8e146` (install-vps.sh idempotency fixes, same day).
- **Migrations applied:** none (uses `json_extract` over the existing `payload_json` column).
- **Restarted:** `hermes-gateway` only (dashboard untouched).
- **What broke before:** closing the app right after a response, then reopening, sometimes triggered a duplicate agent run with no user bubble. Pending-sends persists each frame to SQLite on enqueue and DELETEs on send; SQLite WAL with `synchronous=NORMAL` doesn't fsync after every commit, so a recent DELETE could be lost when the OS evicted the backgrounded app. On reopen, hydrate restored the row as `queued`, the queue-drainer fired the same frame on WS reconnect, and the gateway processed it as a brand-new turn. The drainer doesn't push a local user bubble (its job is just to flush queued frames), so the user saw the agent processing nothing.
- **Fix:** gateway-side dedup keyed by a frontend-minted `clientId`.
  - `chat.send` schema accepts an optional `clientId` (≤128 chars).
  - `handleChatSend` runs `SELECT … WHERE kind='user.message' AND json_extract(payload_json,'$.clientId')=?` before processing; on hit it logs and returns — no second `prompt.submit` to Hermes, no second user.message persist, no second envelope emitted.
  - `user.message` payload now stores `clientId` so the dedup query has something to match on next time.
- **Frontend:** `ClientFrame` `chat.send` gains `clientId`. `send()` / `regenerate()` mint the id once, persist the pending-sends row with the same id (new `enqueueWithId` accessor), and include it in the WS frame. Older clients that omit `clientId` hit the legacy path unchanged.
- **Verified on VPS:** WS test sending the same frame twice with `clientId=DEDUP-X` — first send produced `gateway.user.message` + `message.start` + `message.complete`; second send produced *zero* events. Gateway log: `chat.send: duplicate clientId, skipping (replay after kill+reopen) clientId=DEDUP-X rowId=564`.
- **Branch state on VPS after deploy:** `main` tracking `origin/main` at `66e20ad`.

### 2026-05-08 — install-vps.sh idempotency fixes (Steps 5 + 6)

- **Source:** `cd8e146` (latest `main`).
- **Previous:** `5bbefbc` (Kokoro TTS + assistant audio bubble + auth rotation, same day).
- **Migrations applied:** none.
- **No service restart required** — only script changes.
- **Fixes:**
  - **Step 5 (auth.json check, `478a10e`):** `grep -q '"credential_pool":\s*{[^}]'` was line-oriented, so on a pretty-printed `auth.json` (where `{` sits at end-of-line), `[^}]` had nothing to match against and the check always failed. Replaced with a `have_creds()` python helper that parses the JSON and verifies at least one provider list under `credential_pool` is non-empty. Tested against populated pool (pass), missing key (reject), `{"credential_pool":{}}` (reject).
  - **Step 6 (.env placeholder check, `cd8e146`):** `EXPO_ACCESS_TOKEN` was in the regex that flags empty/placeholder values, but `backend/src/config.ts` marks the variable `.optional()` (only required for high-volume push throughput) — empty is a legitimate state. Removed from the check; `JWT_SECRET` / `BOOTSTRAP_PASSWORD` / `APNS_KEY_P8` remain.
- **Verified on VPS:** `install-vps.sh` now passes Steps 1–6 cleanly (`✓ credential pool populated`, `✓ .env present, no obvious placeholders`) and continues through build + migrate + systemd writeout.
- **Branch state on VPS after deploy:** `main` tracking `origin/main` at `cd8e146`.

### 2026-05-08 — Kokoro TTS + assistant audio bubble + auth rotation

- **Source:** `5bbefbc` (latest `main`).
- **Previous:** `8afa8d7` (voice-memo v2 backend + STT introspection deploy, 2026-05-08).
- **Migrations applied:** none.
- **Hermes source patches (all PATCHED + verified):**
  - `patch-hermes-tts-kokoro.py` — three injections into `tools/tts_tool.py`: module-global `_kokoro_instance` cache + `_get_kokoro_instance()` lazy loader (Patch A), `_generate_kokoro()` synth function with WAV→ffmpeg conversion + 80-bucket RMS peaks sidecar (Patch B), `provider == "kokoro"` dispatch case (Patch C). **Re-applied via `--unpatch && apply` because the prior deploy left the Phase-3 PB_BLOCK without the peaks sidecar.**
  - `patch-hermes-tts-warmup.py` — daemon thread pre-loads Kokoro at dashboard startup; `_TTS_READY` event gates the synth handler so the first call never races the load.
  - `patch-hermes-config.py` — `tts.provider = kokoro`, `tts.kokoro.{voice=am_michael, speed=1.0, lang=en-us}` enforced.
- **Backend changes:**
  - `backend/src/ws/tts-bridge.ts` (new) — extractMediaFromMessageText, translateHermesPath, relocateTtsBlob; gateway intercepts `message.complete`, strips `MEDIA:<path>` from text, copies the Hermes-side blob into `/app/data/blobs/voice/<sha>.mp3`, persists `audio_blob_path/duration/peaks` on the assistant.message row, injects same fields onto the live envelope payload.
  - `auth/refresh.ts` — `rotateRefreshToken` (validate + revoke + issue inside one transaction). `/auth/refresh` returns `{accessToken, refreshToken, refreshTokenExpiresAt}`. Old refresh tokens are now revoked on each refresh; active users renew their 30-day window without re-login.
  - `ws/client.ts` (frontend) — gains `onAuthRequired` callback. Wired to the central `attemptRefresh` so a WS 4401 close triggers refresh + auto-reconnect (one-shot per connection, terminal `auth_required` if refresh itself fails).
  - Frontend `attemptRefresh` consolidated: `uploads.ts`, `transcribe.ts`, `voice-memo.ts` now import the central one from `api/client.ts` (their old in-line copies lacked the inflight lock — would have replayed revoked tokens under rotation).
  - `playback-controller.ts` — cache filename now derived from blob URL extension (`.m4a`/`.mp3`/`.ogg`/`.wav`); old hardcoded `.m4a` made iOS expo-audio refuse to play TTS mp3 bytes.
- **Verified:**
  - `https://hermes.drshnk.dev/health` (assumed via /health locally) → 200.
  - `/voice-blobs/voice/x.mp3` → 401 (auth gate present).
  - `/auth/refresh` with garbage token → 401 (rotation rejects invalid).
  - Kokoro patches all PATCHED including peaks sidecar (`grep -n "peaks sidecar" tts_tool.py` → present).
  - Hermes `tts_tool.py` AST clean (`python -c "import ast; ast.parse(...)"`).
  - `hermes-dashboard` + `hermes-gateway` + `hermes-cron` active.
- **Restarted:** `hermes-dashboard` (kokoro warmup pre-loads), then `hermes-gateway` (rebuilt with TTS bridge + rotation).
- **Note:** `install-vps.sh` bailed on Step 5 ("no provider credentials in /root/.hermes/auth.json") even though the existing deployment is running fine. Likely the auth.json check looks for a specific provider key shape that's set elsewhere on this VPS. Worked around by running the targeted patch + restart bits via `post-hermes-update.sh SKIP_UPDATE=1` and a manual `--unpatch && apply` cycle for the kokoro patch.
- **Branch state on VPS after deploy:** `main` tracking `origin/main` at `5bbefbc`.

### 2026-05-08 — voice-memo v2 backend + STT introspection (full v2 deploy)

- **Source:** `8afa8d7` (latest `main`).
- **Previous:** `aef31bf` (server-side transcription deploy, 2026-05-07).
- **Migrations applied:** `0008_voice_memo.sql` (audio_blob_path, audio_duration_ms, transcription_status, transcription_error + partial index) and `0009_audio_peaks.sql` (audio_peaks_json column). Drizzle reports "migrations applied successfully".
- **Backend new routes verified (auth-gated, 401):**
  - `POST /sessions/:id/messages/voice` — multipart audio upload + optional `audioPeaks` form field. Server validates client peaks (length=80, every value in [0,1]) and uses them directly when valid; falls back to the existing ffmpeg `extractAudioPeaks()` extractor when absent or invalid.
  - `POST /sessions/:id/messages/:msgId/retry-transcription`
  - `GET /voice-blobs/*` — auth-gated raw audio bytes
  - `POST /sessions/:id/transcribe` (existing, no regression)
  - `POST /sessions/:id/branch` (existing, no regression)
- **Hermes source patches (all PATCHED + verified):**
  - `patch-hermes-stt-warmup.py` — module-load background thread pre-loads the local STT model. `_STT_READY` event gates the handler so the first request doesn't race the warmup and corrupt the partial cache file.
  - `patch-hermes-stt-rpc.py` — handler waits up to 120s on `_STT_READY` before serving.
  - `patch-hermes-stt-introspect.py` — `stt_status` agent tool registered via `tools/stt_introspect_tool.py`; toolset entry added to `toolsets.py`. Agent can answer "which STT model are you using?" with ground-truth values (`configured_model`, `loaded_model`, `ready`) instead of hallucinating defaults.
  - `patch-hermes-slash-history.py` (preload + refresh) — unchanged, still PATCHED.
- **Config:** `stt.local.model = large-v3-turbo` (multilingual Hindi+English, ~1.6 GB). `_CORE_TOOLSETS` in `patch-hermes-config.py` updated to include `stt_introspect`; toolset added to `platform_toolsets.cli`, `.tui`, `.api_server`.
- **Warmup performance on VPS (post-restart):** `[stt-warmup] loaded large-v3-turbo in 23064ms` — first-ever load on VPS pulled from HuggingFace; subsequent restarts warm in <10s from local cache.
- **Verified:**
  - Schema: `audio_peaks_json` column at index 10 in chat_history.
  - Public domain: `https://hermes.drshnk.dev/health` → 200.
  - Local: `http://127.0.0.1:8080/health` → 200.
  - `hermes-gateway` + `hermes-dashboard` active.
- **Restarted:** `hermes-dashboard` (so warmup + introspect patches load), then `hermes-gateway` (rebuilt with new voice memo + waveform routes).
- **Branch state on VPS after deploy:** `main` tracking `origin/main` at `8afa8d7`.

### 2026-05-08 — STT model upgrade (`large-v3-turbo`) + warmup + agent introspection

Hermes-side patches only — gateway code unchanged from previous deploy (`aef31bf`).

- **Source patches applied:**
  - `scripts/patch-hermes-stt-warmup.py` — spawns a background thread at server.py module-load that pre-loads the local STT model so the FIRST `stt.transcribe` RPC doesn't pay the model-download + load cost. Module-level `_STT_READY` event gates the handler; concurrent loads (warmup + first user request racing) used to corrupt the partial cache file. The handler now `wait()`s up to 120s on the event before serving.
  - `scripts/patch-hermes-stt-rpc.py` — handler updated to `wait()` on `_STT_READY` before dispatching. Two patches both reapplied via `--unpatch && --apply` since the marker block changed.
  - `scripts/patch-hermes-stt-introspect.py` (NEW) — adds an `stt_status` agent tool registered via `tools/stt_introspect_tool.py`. Inserts an `stt_introspect` toolset entry into `toolsets.py`. The agent can now answer "which STT model are you using?" with ground-truth values (`configured_model`, `loaded_model`, `ready`) instead of hallucinating from training defaults.
- **Config:** `stt.local.model` flipped from `base` to `large-v3-turbo` in `/root/.hermes/config.yaml`. Multilingual (Hindi + English), ~1.6 GB on disk, ~1× realtime CPU on the 2-vCPU VPS, ~3-4% WER. First request post-restart paid the ~3 min HF download; subsequent restarts warm in ~10s from local cache.
- **`patch-hermes-config.py`:** `_CORE_TOOLSETS` now includes `stt_introspect` so the toolset is added to `platform_toolsets.cli`, `.tui`, and `.api_server` on every config patch run. Three changes applied on VPS, backup written to `config.yaml.bak`.
- **Wiring:** `post-hermes-update.sh` step 2cc (warmup) + step 2cd (introspect) ensure these survive `hermes update`. `install-vps.sh` patch invocations updated to match for fresh-provisioning.
- **Verified:** `[stt-warmup] loaded large-v3-turbo in 3949ms` after restart (down from 169s on first download). `stt_status` tool registered in the registry. `/health` = 200.
- **Restarted:** `hermes-dashboard` (so the patched `server.py` reloads with the warmup thread + readiness gate + new tool), then `hermes-gateway` (no code change, but still restarted to re-scrape the rotated `_SESSION_TOKEN`).
- **Branch state on VPS after deploy:** `main` tracking `origin/main` at `aef31bf` — gateway code intentionally NOT updated with the recent voice-memo-v2 work. That's a separate deploy when the v2 flow is ready for remote use.

### 2026-05-07 — server-side transcription (`stt.transcribe` RPC + `POST /transcribe`)

- **Source:** `aef31bf` (latest `main`).
- **Previous:** `183d293` (slash-worker history refresh).
- **Migrations applied:** none.
- **Hermes source patch:** `scripts/patch-hermes-stt-rpc.py` injects the `stt.transcribe` JSON-RPC handler into `tui_gateway/server.py` (registered via the same `@method()` decorator used for every other handler) and adds `"stt.transcribe"` to the `_LONG_HANDLERS` frozenset so faster-whisper transcription runs on the dashboard's `ThreadPoolExecutor` instead of stalling the WS event loop. Idempotent; `--check` reports both patches PATCHED. Wired into `post-hermes-update.sh` step 2c and `install-vps.sh` step 10 so it survives `hermes update` + fresh provisioning.
- **Backend:** new endpoint `POST /sessions/:id/transcribe` accepts a multipart `audio` field (10 MB cap), session ownership-checked, calls Hermes via the shared WS pool with a 30s deadline and one-shot stale-worker retry. Returns `{ transcript, provider, durationMs }`. Hermes-side provider stays whatever `/root/.hermes/config.yaml` `stt.provider` is — currently `local` (faster-whisper, model `base`).
- **Verified (auth-gated, 401):** `POST /sessions/:id/transcribe`. `/health` = 200. Existing `POST /sessions/:id/branch` still 401 (no regression).
- **Restarted:** `hermes-dashboard` (so the patched `server.py` reloads with the new method + frozenset), then `hermes-gateway` (rebuilt with the new route).
- **Branch state on VPS after deploy:** `main` tracking `origin/main` at `aef31bf`.

### 2026-05-06 (PM) — slash-worker history refresh + branch retry

- **Source:** `183d293` (latest `main`).
- **Previous:** `837d31a` (morning deploy).
- **Migrations applied:** none.
- **Hermes source patch:** `scripts/patch-hermes-slash-history.py` now installs a SECOND patch entry (`slash-worker-refresh-history`) that re-loads `conversation_history` from the SQLite session DB at the top of every `_run()` call. Boot-time preload alone wasn't enough — Hermes' dashboard spawns the slash worker eagerly when the chat opens, so the boot snapshot finds zero messages and every subsequent `/branch` in that worker sees the same stale empty list. Re-running the patch script reported `[preload-history] already patched, skipping` + `[refresh-history] applied`.
- **Backend change:** gateway now retries `slash.exec` once on Hermes RPC code 5030 ("slash worker exited") for both `POST /sessions/:id/branch` and `POST /sessions/:id/reload-mcp` — hides the stale-subprocess handshake from the mobile client so the user no longer needs to tap Fork twice after a hot-patch / dashboard restart.
- **Verified (auth-gated, 401):** `POST /sessions/:id/branch`, `POST /sessions/:id/reload-mcp`. `/health` = 200.
- **Restarted:** `hermes-dashboard` (so the slash-worker subprocess pool reloads with the patched module), then `hermes-gateway` (rebuilt with the retry helper).
- **Branch state on VPS after deploy:** `main` tracking `origin/main` at `183d293`.

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

---

## Mobile OTA log

JS-only EAS Update shipments. Production channel reaches preview + prod
builds with `runtimeVersion: { policy: "appVersion" }`. Native rebuild only
needed when `appVersion` bumps or a native module is added.

Run from `frontend/`:

```bash
eas update --channel production --message "<short summary> (<commit>)"
```

**Important:** `eas update` bundles env from the local `.env` at run time, **not** from the build profile's `env` block in `eas.json` (that's builds only). Production OTAs MUST either:

1. Inline the env on the command (one-off):
   ```bash
   EXPO_PUBLIC_API_URL=https://hermes.drshnk.dev \
   EXPO_PUBLIC_WS_URL=wss://hermes.drshnk.dev \
   eas update --channel production --message "..."
   ```
2. Or use `--environment production` after setting the vars in the EAS dashboard
   (https://expo.dev/accounts/nanatsuxiv/projects/hermes-app/environment-variables).

Skipping this ships the developer's local LAN IP into production — see the
2026-05-09 corrective entry below.

### 2026-05-09 — verify hardened release pipeline (production)

- **Source commit:** `2228abe`. No app code change vs the previous OTA — this run validates the new release infra.
- **Update group:** `8ad23eab-a3b1-4836-82b7-a6532f7d4f83`.
- **Channel:** `production`. Runtime: `0.1.0`. Native rebuild: none.
- **What's different operationally:**
  - EAS server-side env vars (`eas env:create --environment production`) hold the canonical prod URLs. Both `eas build --profile production` and `eas update --channel production` pull them automatically.
  - `eas.json` build profiles now declare `"environment": "<name>"` explicitly so EAS resolves env vars by environment name (no implicit name-matching dance).
  - Inline `env` blocks removed from `eas.json` — server-side is canonical. Inline blocks would have overridden server vars and re-introduced the divergence risk.
  - `frontend/scripts/safe-eas-update.sh` wraps `eas update`, refuses to publish if the resolved `EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_WS_URL` (shell **or** `.env`) points at a LAN/private/loopback address. Bypass: `ALLOW_LOCAL_URL=1`.
  - `pnpm update:prod -m "<msg>"` and `pnpm update:preview -m "<msg>"` route through the wrapper. Devs should never invoke raw `eas update` going forward.
- **Procedure used for this ship:** stashed local `.env` (which holds dev LAN URL) → `pnpm update:prod -m "..."` → restored `.env`. EAS pulled the prod URLs from the server during expo export.
- **Dashboard:** https://expo.dev/accounts/nanatsuxiv/projects/hermes-app/updates/8ad23eab-a3b1-4836-82b7-a6532f7d4f83

### 2026-05-09 — chat fixes: scroll jump + dup turn + single live todo panel (production)

- **Source commit:** `4736577`. Covers `2d8de9a` (scroll), `b9be3e2` (historyId dedup), `4736577` (todo panel).
- **Update group:** `1a5af219-5f15-4480-bbd7-3c513e21b4f2`.
- **Channel:** `production`. Runtime: `0.1.0`. Native rebuild: none.
- **What ships:**
  - **Scroll-up no longer jumps to bottom.** Replaced FlashList's `autoscrollToBottomThreshold: 0.2` with a manual stick-to-bottom effect. The library variant fired against a stale "near bottom" flag on every data change, so pagination prepends + WS stream events were snapping the user back. The new effect tracks `isAtBottomRef` from `handleScroll` and only scrolls when (at-bottom) AND (tail row changed OR active stream).
  - **Message trains no longer duplicate after a refetch.** Live message ids now match history row ids (`hist-u-${historyId}` / `hist-a-${historyId}` / `hist-t-${historyId}`). Backend stamps `historyId` on each envelope; frontend reads it. Existing dedup at chat/[id].tsx now matches all three kinds, so a session-messages refetch during an active turn no longer renders a second copy.
  - **Single live todo panel** above the composer — replaces inline TodoPlanCard rows. Each agent step that updates the todo tool no longer piles up as a new card; the panel auto-resolves the latest in-flight (or completed) todo and updates in place. Inline todo rows are filtered out of the chat list.
- **Backend pre-req:** the historyId stamping requires gateway commit `4736577` deployed on VPS (see VPS deploy log entry above). Older gateways → frontend gracefully falls back to the prior id scheme; dedup just doesn't fire (matches pre-fix behavior, no regression).
- **Dashboard:** https://expo.dev/accounts/nanatsuxiv/projects/hermes-app/updates/1a5af219-5f15-4480-bbd7-3c513e21b4f2

### 2026-05-09 — fix: prod API URL revert (production)

- **Source commit:** `dc7afe3` (no app code changes — env-only re-bundle).
- **Update group:** `a6116c0f-147c-4bd7-b18e-e43744c45b06`.
- **Channel:** `production`. Runtime: `0.1.0`. Native rebuild: none.
- **What broke:** the prior OTA (`7d28dae0-…`) was bundled without the prod env explicit on the command, so metro picked up the developer's local `.env` and shipped `EXPO_PUBLIC_API_URL=http://192.168.1.11:8080` into production. App tried to talk to a LAN IP and failed for everyone outside that network.
- **Fix:** re-shipped the same JS with `EXPO_PUBLIC_API_URL=https://hermes.drshnk.dev EXPO_PUBLIC_WS_URL=wss://hermes.drshnk.dev` inlined on the `eas update` command. Updated this doc above so future OTAs go out with the correct env.
- **Dashboard:** https://expo.dev/accounts/nanatsuxiv/projects/hermes-app/updates/a6116c0f-147c-4bd7-b18e-e43744c45b06

### 2026-05-09 — cron Jobs/Outputs + persister fix + durable chat.abort (production)

- **Source commit:** `f4dc783` — covers `c795625` (durable chat.abort), `e82a58e` (cron docs), `4f29c3a` (cron tabs UI), `cc4e7d2` (cron outputs aggregator backend, mobile types update), `977bfa0` (query persister hydration crash fix).
- **Update group:** `7d28dae0-b24c-40be-b1fd-772eb0283750`.
- **Channel:** `production` (reaches preview + prod). Runtime version: `0.1.0`. Native rebuild: none.
- **What ships:**
  - Cron tab now splits into `[Jobs | Outputs]` via SegControl. New `CronJobOutputs` screen for full per-job run history. CronDetail "Recent runs" capped at 4 with "See all" link. Outputs tab joins backend's new `/cron/outputs/by-job` aggregator with the existing `/cron/jobs` for name + schedule. Orphan output dirs (parent job deleted) render with an `archived` badge.
  - `cache/query-persister.ts` skips `pending` + `error` queries from dehydration — fixes the `TypeError: promise.then is not a function` crash on cold launch when a query was in-flight at backgrounding. `PERSIST_BUSTER` bumped `1 → 2` to wipe poisoned rows from prior launches.
  - `chat.abort` is now durable — routed through `usePendingSends` so the queue-drainer re-delivers it on reconnect. Fixes the kill+reopen case where stopping a generation but losing the abort frame in transit caused the response to "auto-restart" on reopen (the live stream from the never-aborted Hermes turn looked like a fresh generation since the user message was already accepted).
- **Backend pre-req:** `/cron/outputs/by-job` deployed to VPS at `c795625` earlier today (see VPS deploy log entry above). The Outputs tab calls into that route.
- **Dashboard:** https://expo.dev/accounts/nanatsuxiv/projects/hermes-app/updates/7d28dae0-b24c-40be-b1fd-772eb0283750

### 2026-05-08 — App updates screen (production)

- **Source commit:** `656bf1c` — `settings: add "App updates" screen`.
- **Update group:** `3425956f-201f-4ce5-840b-aa8fb9e841a6`.
- **Channel:** `production` (also reaches preview builds since both bake the
  VPS URL). Runtime version: `0.1.0`.
- **What ships:** new `Settings → Account → App updates` row + screen. Auto-
  checks on mount, walks user through check → download (indeterminate
  progress) → ready → restart, with explicit error recovery. Disabled state
  in dev / Expo Go since `Updates.isEnabled` is false there.
- **Native rebuild:** none.
- **Dashboard:** https://expo.dev/accounts/nanatsuxiv/projects/hermes-app/updates/3425956f-201f-4ce5-840b-aa8fb9e841a6

### 2026-05-08 — TTS bubble + auth refresh + chat.send dedup (production)

- **Source commit:** `e9f0f38` — combined window covering Kokoro TTS frontend
  rendering, WS auto-refresh + refresh-token rotation, audio cache extension
  fix, MEDIA tag streaming strip, `chat.send` clientId idempotency, and the
  reasoning-only short-circuit fix.
- **Update group:** `27e1239d-29c8-4558-a6d2-09940a1167aa`.
- **Channel:** `production`. Runtime version: `0.1.0`.
- **Backend dependency:** requires gateway at `66e20ad` or later (the
  clientId dedup); already deployed to VPS in the same window.
- **Native rebuild:** none — pure JS/TS, no plugin or native-module changes.
- **Dashboard:** https://expo.dev/accounts/nanatsuxiv/projects/hermes-app/updates/27e1239d-29c8-4558-a6d2-09940a1167aa
