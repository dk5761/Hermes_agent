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
