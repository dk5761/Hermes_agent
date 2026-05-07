# Assistant TTS Frontend Integration

Goal: when the agent calls `text_to_speech` (Kokoro) the user gets a playable
audio bubble in the chat alongside the text response. Reuses the AudioMessage
+ playback-controller surface already built for voice-memo v2.

## Locked decisions (open questions resolved)

1. **Trigger model — explicit only.** Agent calls `text_to_speech` only when the
   user asks (e.g. "read this aloud"). No auto-read-aloud on every response. Set
   in the system prompt / tool description; no client-side gate needed.
2. **Audio + text layout — show both.** The assistant text bubble renders
   normally; the `text_to_speech` tool.call row directly below renders as an
   audio bubble (transcript already lives in the text bubble — we don't repeat
   it).
3. **Peaks — server-side from Kokoro np array.** `_generate_kokoro` writes a
   sidecar `<file>.peaks.json` (80 normalised floats) at synth time. Free; no
   ffmpeg needed. Gateway prefers sidecar over ffmpeg fallback.

## Architecture

Hermes (`tools/tts_tool.py`) writes audio to
`<HERMES_HOME>/cache/audio/tts_<ts>.mp3` and emits a `tool.complete` event whose
result JSON contains `media_tag: "MEDIA:<abs path>"`.

Both deploy targets share the file system across the gateway:
- **Local docker:** gateway has `./data/hermes-home:/data/hermes-home:ro` mounted
  and Hermes writes to `/opt/data/cache/audio/...`. Same host file, different
  mount path. We translate `/opt/data/...` → `/data/hermes-home/...`.
- **VPS:** Hermes writes to `/root/.hermes/cache/audio/...`; gateway reads it
  directly (same host, same path).

The chat_history table already has `audio_blob_path`, `audio_duration_ms`,
`audio_peaks_json` columns (from voice-memo v2). We populate these on the
**`tool.call` row** for `text_to_speech` so replay works for free.

## Phase A — Gateway: detect TTS tool.complete + relocate blob (~2h)

**New file:** `backend/src/ws/tts-bridge.ts`
- `extractTtsMedia(payload: unknown): { absPath: string } | null` — parses
  `tool.complete` payload, requires `name === "text_to_speech"` and `success:
  true`, returns absolute path from `media_tag` / `file_path`.
- `translateHermesPath(absPath, hermesHomeMount): string | null` — maps Hermes'
  view (`/opt/data/...` or `/root/.hermes/...`) onto the gateway's mount; falls
  through if path is already accessible.
- `relocateTtsBlob(srcAbs, blobRoot, log): Promise<{ relKey, sha, durationMs,
  peaks: number[] | null }>` — copies (sha-dedup) into
  `<blobRoot>/voice/<sha>.mp3`, reads sidecar `<src>.peaks.json` if present,
  falls back to ffmpeg-based 80-bucket peaks.

**Edit:** `backend/src/ws/chat-history.ts`
- Extend `appendHistory` to accept optional `audio?: { blobPath, durationMs,
  peaks }` and persist the three columns when supplied.

**Edit:** `backend/src/ws/gateway-ws.ts`
- In `handleUpstreamEvent`, when `ev.type === "tool.complete"` and `extractTtsMedia`
  matches: relocate blob → call new `appendHistoryWithAudio` → emit envelope
  with `audio_blob_url` / `audio_duration_ms` / `audio_peaks` injected into the
  payload so live clients get them too.
- Best-effort: failure to relocate (ENOENT, ffprobe missing) logs a warn and
  falls through to the regular persist path.

## Phase B — Frontend: render TTS tool.call as AudioMessage (~1.5h)

**Edit:** `frontend/app/(app)/(chats)/chat/[id].tsx` `historyRowToUiRow`
- For `tool.call` rows where `payload.name === "text_to_speech"` and
  `r.audioBlobUrl`: emit a synthetic `kind: "tool"` row with `detail.audioBlobUrl
  / audioDurationMs / audioPeaks` set. (HistoryRow already carries these from
  Phase A.)

**Edit:** `frontend/src/state/chat-store.ts`
- `tool.complete` reducer: when `payload.name === "text_to_speech"` and the
  envelope payload carries `audio_blob_url`, set the matching ToolCallCard's
  `detail.audioBlobUrl`/`audioDurationMs`/`audioPeaks`.
- Extend `ToolCallCard` interface comment — `detail` already accepts arbitrary
  keys.

**Edit:** `frontend/src/components/chat/AudioMessage.tsx`
- Add `variant?: "user" | "assistant"` prop (default `"user"`). The assistant
  variant:
  - Hides the retry-transcription CTA (the agent's text reply IS the transcript).
  - Hides the transcription accordion (likewise).
  - Uses an assistant-side bubble style (left-aligned, surface bg) instead of
    the user ink bubble.

**Edit:** `frontend/src/components/ui/Message.tsx` `ToolCard`
- Detect `name === "text_to_speech"` + `detail.audioBlobUrl`: render
  `<AudioMessage variant="assistant" ... />` instead of the regular collapsible
  card. Still falls back to the plain card if audio is missing (e.g. relocate
  failed — user sees the tool ran but nothing to play).

## Phase C — Server-side peaks from Kokoro np array (~30min)

**Edit:** `scripts/patch-hermes-tts-kokoro.py`
- Extend `_generate_kokoro` to compute 80 RMS-bucketed peaks from the audio
  numpy array (same shape voice-memo uses) and write them as JSON to
  `<output_path>.peaks.json` next to the audio file. Idempotent with the
  existing patch markers.

## Phase D — Deploy + manual test (~30min)

- Re-run `post-hermes-update.sh` on docker (peak sidecar lands).
- Build gateway, restart.
- Manually: open chat, ask "read this aloud: hello, world". Confirm:
  - Text bubble renders the agent's reply.
  - Audio bubble below plays the synthesized audio.
  - Reload the chat — both bubbles persist with audio still playable.
  - Replay (kill app, reopen) — same.

## Out of scope

- Auto-read-aloud toggle in settings (deferred — would require a UI prefs
  surface and prompt-injection on send).
- Streaming TTS (Kokoro generates the whole clip; <2s on KVM2 is fine).
- TTS retry button (the existing retry-transcription path does not apply).

## File touch list

- `backend/src/ws/tts-bridge.ts` (new, ~150 lines)
- `backend/src/ws/chat-history.ts` (~+15 lines)
- `backend/src/ws/gateway-ws.ts` (~+30 lines)
- `frontend/app/(app)/(chats)/chat/[id].tsx` (~+15 lines in historyRowToUiRow)
- `frontend/src/state/chat-store.ts` (~+10 lines in tool.complete reducer)
- `frontend/src/components/chat/AudioMessage.tsx` (~+30 lines for variant)
- `frontend/src/components/ui/Message.tsx` (~+10 lines for ToolCard branch)
- `scripts/patch-hermes-tts-kokoro.py` (~+25 lines for peaks sidecar)
