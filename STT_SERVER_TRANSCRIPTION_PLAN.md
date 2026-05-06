# Server-side STT — phase by phase

**Goal:** add a fourth voice engine — Hermes' on-VPS `faster-whisper` — alongside
the existing on-device options (WhisperKit, SFSpeech, auto). Enforce a default
60-second hard cap on local engines so long recordings auto-route to server.
Offline + server-selected falls back to a local engine. Local cap-exceeded
delivers whatever was captured rather than discarding.

**Architecture summary:**

```
                  ┌─ engine = whisper ─→ WhisperKit on-device (streaming, <60s)
                  │
                  ├─ engine = sfspeech ─→ Apple SFSpeech on-device (streaming, <60s)
                  │
useVoiceInput ─→  ├─ engine = server   ─→ POST /transcribe → gateway → WS:stt.transcribe → Hermes faster-whisper
                  │                       (single-shot, ≤300s)
                  │
                  └─ engine = auto     ─→ resolveEngine() picks one based on:
                                            • model status
                                            • clip length cap
                                            • online state
```

**Scope:**
- New `server` engine in `voice.engine` enum.
- New `voice.localCapSeconds` setting (default 60) + `voice.serverCapSeconds` (default 300).
- New `voice.fallbackOnOffline` toggle (default true).
- 60s timer in `useVoiceInput` — local engines auto-stop at cap, deliver what was captured.
- Auto routing: `auto` engine + offline + server selected → falls back to local.
- Hermes WS RPC `stt.transcribe` — patch lives in `scripts/patch-hermes-stt-rpc.py`, idempotent, applied via `post-hermes-update.sh`.
- Gateway endpoint `POST /sessions/:id/transcribe` — multipart upload, Bearer auth.
- Mobile UI: record .m4a, upload, await transcript, paint into composer with "Transcribing…" spinner.

**Out of scope:**
- TTS (separate plan).
- Voice notes as first-class chat attachments (this plan replaces composer dictation; voice-as-message can come later).
- Provider switching (Hermes config picks `local` faster-whisper; mobile doesn't choose).

---

## Locked decisions

1. **Hermes integration via WS RPC, not HTTP.** Same pattern as existing `slash.exec`. Reuses dashboard token-scrape, auth, and pool. New method: `stt.transcribe`.
2. **Audio format on the wire: M4A (AAC).** ~25-30 KB/sec, every iOS API supports it, Hermes' `faster-whisper` accepts it directly.
3. **Encoding: base64 in JSON-RPC payload.** Simple, matches `tts.synthesize` if/when added. ~33% size overhead vs raw bytes — fine for ≤5min clips (~2 MB → ~2.7 MB base64). If perf becomes an issue, swap to multipart later.
4. **Local cap default: 60s.** User-configurable in Settings → Voice (range: 30s-180s).
5. **Server cap default: 300s.** Hermes faster-whisper handles it; mobile enforces upload size limit.
6. **Cap exceeded on local: deliver partial.** Auto-stop, transcribe captured audio, toast: "60s reached — switch to Server for longer recordings."
7. **Offline + server engine: fall back to local.** `resolveEngine()` returns `whisper` or `sfspeech` based on model status; show small caption "Offline — using <engine>".
8. **No streaming for server engine.** Single-shot. UX: "Transcribing…" spinner, replace with full transcript on response.
9. **Hermes provider stays `local` (faster-whisper).** Mobile doesn't choose; admin sets via VPS config. Future: surface server provider in mobile settings if multi-tenant.

---

## Phase 0 — Spike + decisions verified (45 min)

### Tasks

1. Confirm Hermes' `transcribe_audio(file_path, model=None)` is callable from the dashboard process. Read `tools/transcription_tools.py` end to end. Note return shape (`{success, transcript, provider}`).
2. Confirm `tui_gateway/ws.py` JSON-RPC dispatcher pattern. Identify the file location of method registration (likely a dict / decorator).
3. Check whether `faster-whisper` accepts M4A directly or needs ffmpeg pre-decode. If pre-decode: add ffmpeg invocation to the patch.
4. Measure: small (5s) M4A clip round-trip latency end-to-end via curl against a hand-tested RPC method. Target: <2s.

### Acceptance

- `transcribe_audio()` callable, returns expected shape.
- WS RPC pattern documented for Phase 1.
- M4A handling path known.

---

## Phase 1 — Hermes WS RPC: `stt.transcribe` (2h)

### Files

- `scripts/patch-hermes-stt-rpc.py` — NEW. Idempotent patcher. Markers `HERMES_PATCH:stt-rpc:start/end`. Same structure as `patch-hermes-slash-history.py` and `patch-hermes-reload-mcp.py`.
- `scripts/post-hermes-update.sh` — wire in step 2c (or next available number). Applies patch + checks via `--check` flag.
- `scripts/install-vps.sh` — same patch invocation in the bootstrap path.

### Patch shape

Inject into `tui_gateway/ws.py` (or wherever JSON-RPC methods are registered). The new method:

```python
# HERMES_PATCH:stt-rpc:start
async def _rpc_stt_transcribe(params: dict) -> dict:
    """Decode base64 audio, call transcribe_audio, return transcript."""
    import base64, tempfile, os
    audio_b64 = params.get("audio_b64", "")
    mime = params.get("mime", "audio/m4a")
    if not audio_b64:
        return {"error": "audio_b64 missing"}

    suffix = ".m4a" if "m4a" in mime or "aac" in mime else ".wav"
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="hermes-stt-")
    os.close(fd)
    try:
        with open(path, "wb") as f:
            f.write(base64.b64decode(audio_b64))
        from tools.transcription_tools import transcribe_audio
        result = transcribe_audio(path)
        return {
            "success": result.get("success", False),
            "transcript": result.get("transcript", ""),
            "provider": result.get("provider", "unknown"),
        }
    finally:
        try: os.unlink(path)
        except OSError: pass

# Register: <wherever methods are registered>
RPC_METHODS["stt.transcribe"] = _rpc_stt_transcribe
# HERMES_PATCH:stt-rpc:end
```

Exact registration syntax depends on the existing dispatcher — Phase 0 verifies.

### Acceptance

- Patch applies cleanly, `--check` reports PATCHED.
- Survives `hermes update` (post-update.sh re-runs patcher).
- `wscat`-style manual call against `127.0.0.1:9119/api/ws` returns transcript for a known M4A.

### Edge cases

- **Hermes upgrades the dispatcher signature** — patch fails to apply, `--check` reports "anchor not found", VPS deploy aborts. Manual investigation needed; same drill as other patches.
- **transcribe_audio raises** — wrap in try/except, return `{success: false, error: <message>}`. Don't let RPC errors crash the dashboard.
- **Concurrent transcriptions** — `transcribe_audio` is synchronous + CPU-bound. Run inside `asyncio.to_thread()` so we don't block the event loop.

---

## Phase 2 — Gateway endpoint (1.5h)

### Files

- `backend/src/routes/transcribe.ts` — NEW. Single route handler.
- `backend/src/index.ts` — register the route.

### Route

```
POST /sessions/:id/transcribe
  Auth: Bearer (existing requireAuth preHandler)
  Body: multipart/form-data
        field "audio" → binary M4A
  Response: 200 { transcript: string, provider: string, durationMs: number }
            413 if audio > 10 MB
            504 if Hermes RPC times out (>30s)
            503 on Hermes RPC failure
```

### Implementation sketch

```ts
const transcribeBody = z.object({});  // params validated separately

app.post("/sessions/:id/transcribe", { preHandler: requireAuth }, async (request, reply) => {
  const id = request.params.id;
  const data = await request.file();   // @fastify/multipart
  if (!data) return reply.code(400).send({ error: "missing_audio" });
  if (data.file.bytesRead > 10 * 1024 * 1024) return reply.code(413).send({ error: "too_large" });

  const buffer = await data.toBuffer();
  const mime = data.mimetype ?? "audio/m4a";

  const client = wsPool.getOrCreateShared();
  const start = Date.now();
  try {
    const result = await Promise.race([
      client.request("stt.transcribe", {
        audio_b64: buffer.toString("base64"),
        mime,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 30_000).unref()
      ),
    ]) as { success: boolean; transcript?: string; provider?: string };

    if (!result.success) return reply.code(503).send({ error: "stt_failed" });
    return reply.send({
      transcript: result.transcript ?? "",
      provider: result.provider ?? "unknown",
      durationMs: Date.now() - start,
    });
  } catch (err) {
    logger.warn({ err, sessionId: id }, "stt.transcribe failed");
    return reply.code(504).send({ error: "stt_timeout" });
  }
});
```

### Acceptance

- 401 missing_bearer when unauth'd.
- 413 on >10MB upload.
- 200 with transcript on a 5s M4A.
- ~1-2s latency for 5s clip end-to-end (LAN test).
- Adds Deploy log entry.

### Edge cases

- **Slash worker stale on first call** — borrow `slashExecWithRetry` pattern. If `stt.transcribe` returns RPC code 5030 + "slash worker exited", retry once.
- **No `@fastify/multipart` registered** — verify it's already a dep (used elsewhere?). If not, install + register.
- **Transcript with newlines / control chars** — pass through as-is. Mobile sanitizes.

---

## Phase 3 — Mobile: server engine implementation (2h)

### Files

- `frontend/src/voice/internal/useServerVoiceInput.ts` — NEW. Same `UseVoiceInputResult` shape as the other two internals.
- `frontend/src/voice/useVoiceInput.ts` — extend the router to include `server`.
- `frontend/src/api/transcribe.ts` — NEW. Thin client for `POST /transcribe`.

### Hook contract preservation

`useServerVoiceInput` returns the same shape as `useWhisperVoiceInput` and `useSFSpeechVoiceInput`. Stubbed fields:
- `partialTranscript: string` — empty (server engine doesn't stream).
- `state.kind: "recording" | "stopping" | "transcribing" | "idle" | "error"` — adds new `transcribing` state to the union (need to update `VoiceInputState` in `frontend/src/voice/types.ts`).
- `modelStatus: "ready"` always (no model to check).
- `modelProgress: 1` always.
- `ensureModelReady: () => Promise.resolve()` no-op.

### Recording flow

1. `start()` — `expo-av` `Audio.Recording`, `.m4a` preset (highQuality is fine, ~64kbps AAC).
2. `stop()` —
   - Audio recording stops, file URI obtained.
   - State → `transcribing`.
   - POST file to gateway via `apiFetch`/`request` with multipart.
   - On response: state → `idle`, `transcript` set, `onFinalTranscript(text)` callback.
   - On error: state → `error` with kind `server_stt_failed`.
3. `cancel()` — stop recording, delete file, no upload, state → idle.

### Acceptance

- `engine: "server"` selected → record + upload + transcript appears in composer.
- Error states (offline, 503, timeout) surface via `onVoiceError` toast.
- Recording file cleaned up on success and failure.

### Edge cases

- **App background mid-record** — `expo-av` may pause. iOS audio session category needs `.playAndRecord` with background mode, or accept that recordings are foreground-only. Foreground-only is fine for v1.
- **Upload while WiFi flips to cellular** — request retries or fails with timeout; user sees error toast and retries.
- **File-system failure to write recording** — fail loudly with an error toast, don't silently lose audio.

---

## Phase 4 — Cap enforcement + auto routing (1.5h)

### Files

- `frontend/src/state/voice-settings.ts` — add `localCapSeconds`, `serverCapSeconds`, `fallbackOnOffline`.
- `frontend/src/voice/useVoiceInput.ts` — add cap timer + extended `resolveEngine` rules.

### Cap timer

```ts
useEffect(() => {
  if (state.kind !== "recording") return;
  if (engine !== "whisper" && engine !== "sfspeech") return;  // no cap on server
  const cap = useVoiceSettings.getState().localCapSeconds * 1000;
  const timer = setTimeout(() => {
    void stop();  // captured audio is delivered
    showCapToast();  // "60s reached — switch to Server engine for longer recordings"
  }, cap);
  return () => clearTimeout(timer);
}, [state.kind, engine, stop]);
```

Server engine has its own cap, larger by default; same pattern.

### `resolveEngine` extended

```ts
function resolveEngine({ engine, modelStatus, online }: ResolveEngineInput): "whisper" | "sfspeech" | "server" {
  if (Platform.OS !== "ios") return "sfspeech";  // android future
  if (engine === "whisper") return "whisper";
  if (engine === "sfspeech") return "sfspeech";
  if (engine === "server") {
    return online ? "server" : (modelStatus === "ready" ? "whisper" : "sfspeech");
  }
  // engine === "auto"
  if (online && modelStatus === "ready") return "whisper";
  if (online) return "sfspeech";  // model not ready, server is fine but stay simple
  return modelStatus === "ready" ? "whisper" : "sfspeech";
}
```

### Online state

Use existing `useNetworkStatus` store from offline-support work.

### Acceptance

- 60s of WhisperKit recording → auto-stop, captured text inserted, toast shown.
- `engine: server` + offline → records via WhisperKit (or SFSpeech if model absent), banner caption "Offline — using on-device".
- `engine: auto` + 90s clip → records via WhisperKit, caps at 60s, captured text inserted.
- Settings change to `serverCapSeconds: 600` → server engine allows 10-min clips.

### Edge cases

- **Recording crashes at exactly the cap second** — Phase 3's `cancel()` semantics handle this; we just schedule `stop()` cleanly.
- **User changes engine setting mid-record** — engine resolved at hook construction (per Phase 6 of WhisperKit migration). Resolved value sticks until next mic press. Acceptable.
- **`fallbackOnOffline=false`** — server engine + offline → hard fail with toast "Server transcription requires connection." User explicitly opted into strict server-only. Edge case, surface clearly.

---

## Phase 5 — Settings UI (1h)

### Files

- `frontend/app/(app)/(settings)/voice.tsx` — extend `EnginePicker` + add cap section.

### Engine picker — four options

```
Speech recognition engine
  ○ Auto (recommended)        — on-device when ready, else system
  ○ WhisperKit (on-device)    — best privacy, requires download
  ○ Apple system (SFSpeech)   — instant, system languages
  ○ Hermes server             — long recordings, requires connection
```

Reactive caption: "Currently using: <resolved>" (already from Phase 6).

### Cap section

```
Recording limits
  Local engines (WhisperKit, Apple)
    [ Slider: 30s ───●─── 180s ]   60s
  Server engine (Hermes)
    [ Slider: 60s ───●─── 600s ]   300s
  ☐ Use on-device when offline
```

### Acceptance

- Picker writes to `useVoiceSettings.engine`, immediately reflects in resolution caption.
- Sliders persist (sqliteKv via existing Zustand wiring).
- Toggling `fallbackOnOffline` changes `resolveEngine` behavior on next mic press.

---

## Phase 6 — VPS deploy + manual test pass (1h)

### Deploy

Standard deploy procedure (per `vps_setup.md`). Plus:
- `python3 /root/repos/Hermes_agent/scripts/patch-hermes-stt-rpc.py` (auto via `post-hermes-update.sh` step).
- Restart `hermes-dashboard` (so the patched RPC dispatcher reloads).
- Restart `hermes-gateway` (rebuilt with new endpoint).
- Smoke test: `curl -F audio=@sample.m4a http://127.0.0.1:8080/sessions/x/transcribe -H 'Authorization: Bearer …'` → expect 401 missing_bearer or 200.
- Append Deploy log entry.

### Test matrix

| Scenario | Expected |
|---|---|
| Auto + WhisperKit ready + online + 30s clip | WhisperKit, transcript inserted |
| Auto + WhisperKit absent + online + 30s clip | SFSpeech, transcript inserted |
| Auto + 90s clip | Stops at 60s, captured text inserted, cap toast |
| Server + online + 60s clip | Server transcribes, transcript inserted, ~1-2s spinner |
| Server + online + 4-min clip | Server transcribes, transcript inserted, ~5-10s spinner |
| Server + offline + fallbackOnOffline=true + 30s | WhisperKit / SFSpeech runs, banner caption |
| Server + offline + fallbackOnOffline=false | Hard error toast |
| Server + 11MB upload | 413 too_large from gateway |
| Hermes WS down + Server selected | 504 stt_timeout, error toast |
| `serverCapSeconds=600` + 9-min clip | Records full clip, uploads, server transcribes |
| Voice settings cap slider | Changes persist + take effect on next press |

---

## Risks + open questions

- **faster-whisper concurrency on VPS.** Single shared whisper model instance; concurrent transcribe requests serialise. With base model + 4-core CPU that's ~3-5s per request, sustainable for personal use. If multiple users or high frequency, swap to `concurrent.futures` pool + multiple loaded models.
- **Audio format compatibility.** faster-whisper uses ffmpeg internally to decode anything. M4A should work without an explicit pre-decode. Verified in Phase 0.
- **Base64 size overhead in JSON-RPC.** ~33% bigger than raw. For 5-min M4A (~2 MB) → ~2.7 MB JSON, fine. If we ever cross 10 MB, switch the RPC to multipart-over-HTTP path.
- **Server STT quality vs WhisperKit.** Both use Whisper architecture. faster-whisper `base` ≈ Whisper Tiny/Base on quality, faster on CPU. WhisperKit `base.en` slightly better quality on Apple Silicon. Server is "long recordings" not "better quality" — set expectations in settings copy.
- **Hermes config drift.** If user changes Hermes' `stt.provider` to a cloud service (groq/openai), mobile sees that result transparently. No mobile-side change needed. Document in vps_setup.md.
- **Offline detection accuracy.** `useNetworkStatus` from offline-support can lag by ~1s. If Server-engine call fires during the lag window, request 504s. Acceptable; user retries.
- **Transcribing state cancellation.** User can't cancel mid-upload today. Add a "Cancel" affordance during the spinner state if requests routinely take >5s.

---

## Total estimate

| Phase | Time |
|---|---|
| 0 — Spike + decisions | 45 min |
| 1 — Hermes WS RPC patch | 2h |
| 2 — Gateway endpoint | 1.5h |
| 3 — Mobile server engine | 2h |
| 4 — Cap + auto routing | 1.5h |
| 5 — Settings UI | 1h |
| 6 — VPS deploy + manual test | 1h |
| **Total** | **~9.75h** |

Cuts if needed:
- Skip Phase 4's `fallbackOnOffline` toggle → always fallback. Saves 30min.
- Skip Phase 5's cap sliders → hardcode 60s/300s. Saves 30min.
- Cut version: ~8h, covers "engine picker + 60s cap + server transcription end-to-end."
