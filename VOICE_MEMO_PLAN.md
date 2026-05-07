# Voice memo support — phase by phase

**Goal:** ship Telegram-style voice messaging in the chat. Users can long-press
the mic button to send a voice memo. The chat renders an audio bubble with
playback controls + a transcription caption underneath. Agent receives the
transcript as a normal text turn so it can still respond.

**UX pattern (locked):**

| Gesture | Behavior | What the agent sees |
|---|---|---|
| **Tap** mic button | Transcribe-to-composer (current behavior) | The text user types/sends |
| **Long-press** mic button | Voice memo mode — record-while-held, send on release | The transcription text only |

**Architecture summary:**

```
mobile (long-press)
   ↓ record while held (expo-audio)
   ↓ release → multipart POST /sessions/:id/messages/voice {audio}
backend
   ↓ save blob to /app/data/blobs/<sha256>.m4a
   ↓ stt.transcribe RPC → text
   ↓ insert chat_history row {role:user, content:text, audio_blob_path, audio_duration_ms}
   ↓ forward transcript to Hermes as a normal user prompt
   ↓ assistant streams back as usual
mobile chat list
   ↓ render <AudioMessage> bubble for any row with audio_blob_path
   ↓ caption shows transcript underneath
```

**Scope:**
- Audio capture + upload + storage + playback in chat.
- Server-side transcription as the only text the agent sees.
- Storage hygiene: cleanup with session delete + age-based pruning.

**Out of scope:**
- Waveform rendering (v2). Plain progress bar only in v1.
- Voice memo replies from the agent (TTS generation). Future feature.
- Real-time streaming during recording (we upload after release).
- Speaker / background-noise separation, language hints (use the existing STT
  config — multilingual auto-detect).
- Editing/trimming a recorded memo before sending.

---

## Locked decisions

1. **Recording library:** `expo-audio`. Already installed; new dep avoided.
2. **Format on disk:** `.m4a` (AAC). Default expo-audio output, well-compressed
   (~8 KB/sec at typical voice quality), supported by faster-whisper via ffmpeg.
3. **Size cap:** 10 MB per memo (same as the existing transcribe endpoint).
   At 8 KB/sec that's ~20 minutes — well above the 60-90s typical memo length.
4. **Server-side blob storage:** reuse `/app/data/blobs/<sha256>.m4a`. Same
   convention as the image attachments already in production.
5. **DB schema:** add `audio_blob_path TEXT` + `audio_duration_ms INTEGER`
   nullable columns to `chat_history`. Null = text-only message (existing
   behavior preserved).
6. **Transcription provider:** the existing `stt.transcribe` RPC. No
   transcription on the device; we always go through Hermes' faster-whisper.
7. **Single playback at a time:** only one audio bubble plays at a time.
   Tapping a second bubble pauses the first.
8. **Cancel UX:** slide-to-cancel during recording (Telegram pattern). If the
   user drags the mic button down/left past a threshold, recording aborts and
   no upload happens. Audio data is discarded.
9. **No upload-retry queue for voice memos.** If the multipart UPLOAD fails
   (network drop, blob write fail), the recording is lost and a toast
   surfaces. V2 may add a SQLite-backed queue if users complain.
10. **Transcription retry IS supported.** If the upload succeeds but STT fails
    (faster-whisper crash, timeout, model error), the blob is preserved and
    the chat_history row is written with `transcription_status = "failed"`.
    Mobile renders the audio bubble with a "Transcription failed — tap to
    retry" caption. Tapping fires `POST /sessions/:id/messages/:msgId/
    retry-transcription` which re-runs STT against the existing blob and
    updates the row in place. Free retry semantics, no queue needed for v1.
11. **Single voice channel.** Voice memos go through Hermes' chat pipeline
    just like text messages — no separate "voice room" or alternate channel.

---

## Phase 0 — Schema migration + storage prep (45 min)

### Files

- `backend/src/db/migrations/0008_voice_memo.sql` (NEW)
- `backend/src/db/migrations/meta/0008_snapshot.json` (regenerate via drizzle)
- `backend/src/db/schema.ts` (add the two columns to `chat_history`)
- `backend/data/blobs/` — confirm bind mount works for audio same as images

### Migration

```sql
ALTER TABLE chat_history ADD COLUMN audio_blob_path TEXT;
ALTER TABLE chat_history ADD COLUMN audio_duration_ms INTEGER;
ALTER TABLE chat_history ADD COLUMN transcription_status TEXT;
ALTER TABLE chat_history ADD COLUMN transcription_error TEXT;
CREATE INDEX chat_history_audio_idx ON chat_history(audio_blob_path) WHERE audio_blob_path IS NOT NULL;
```

`transcription_status` values: `"completed"` (success or text-only message),
`"transcribing"` (in flight), `"failed"` (STT errored — retry available).
Default NULL means text-only message — no behavioral change for existing rows.
`transcription_error` carries the underlying error message for failed rows.

The partial index keeps cleanup queries fast without bloating the index for
text-only messages (which dominate row count).

### Acceptance

- `pnpm db:migrate` runs cleanly.
- `SELECT audio_blob_path, audio_duration_ms FROM chat_history LIMIT 1` works.
- Existing chat_history rows default to NULL — no behavioral change.

### Edge cases

- **Reverting:** SQLite doesn't support `DROP COLUMN` cleanly. Document that
  the migration is one-way for v1. Future revert needs a table rebuild.
- **Other clients reading the table:** the gateway is the only writer; mobile
  reads via `/sessions/:id/messages` API which we update in Phase 1.

---

## Phase 1 — Backend `POST /sessions/:id/messages/voice` (3h)

### Files

- `backend/src/routes/voice-memo.ts` (NEW)
- `backend/src/server.ts` — register the new route
- `backend/src/db/schema.ts` — already updated in Phase 0

### Endpoint

```
POST /sessions/:id/messages/voice
Content-Type: multipart/form-data; boundary=...
fields: audio (m4a/aac/mp3/wav, up to 10 MB)

→ 201 Created
{
  message: {
    id: number,
    role: "user",
    content: <transcript>,
    audioBlobUrl: <relative path>,
    audioDurationMs: <ms>,
    createdAt: <unix s>
  }
}
```

### Flow

1. Auth + session ownership check.
2. Read multipart audio field, enforce 10 MB cap.
3. Compute sha256 → store at `/app/data/blobs/voice/<sha>.m4a`. If exact dupe
   already exists, reuse the path.
4. Probe duration. expo-audio returns it client-side; pass it as a sibling
   form field. Server clamps to 10 minutes max.
5. **Insert chat_history row immediately** with `audio_blob_path`,
   `audio_duration_ms`, `content = ""`, `transcription_status = "transcribing"`.
   This is the durable record — even if STT crashes, the blob + row survive.
6. Call `stt.transcribe` via existing WS pool. Reuse `transcribeWithRetry`.
7. **On STT success:** UPDATE the row with `content = <transcript>`,
   `transcription_status = "completed"`. Then call the existing
   `ensureHermesSession` helper to get `hermes_session_id`. Forward the
   transcript text to Hermes as a normal `prompt.submit` so the assistant
   streams back.
8. **On STT failure:** UPDATE the row with `transcription_status = "failed"`,
   `transcription_error = <error message>`. Do NOT forward to Hermes (no
   transcript to send). The blob stays on disk. Return 201 with the message
   envelope — the mobile bubble will render with a retry CTA.
9. Return the new message envelope including `audioBlobUrl` and
   `transcriptionStatus`.

### Important: don't double-write

The existing chat send path also inserts a chat_history row. The voice memo
flow MUST NOT create a duplicate user-message row. Either:
- Insert the row in this endpoint and skip the duplicate insert in the WS
  send path (gate by a flag),
- OR send via the WS path with audio metadata in the message envelope.

Pick the cleanest based on the existing architecture. Read the WS handler
in `backend/src/ws/gateway-ws.ts` carefully before deciding.

### Retry endpoint

```
POST /sessions/:id/messages/:msgId/retry-transcription
→ 200
{ message: { ...same envelope, with updated transcriptionStatus + content } }
```

Re-runs `stt.transcribe` against the existing blob. Only valid when the
target row's `transcription_status === "failed"`. On success, also forwards
the new transcript to Hermes as if it were a fresh user prompt (since the
agent never saw this message in the failed state).

### Storage layout

- Audio blobs go in a `voice/` subdir to keep them separate from images.
- Sha256 dedup naturally handles re-records of the same audio (rare but free).

### Acceptance

- POST a fake memo via curl with a real m4a file → 201 with transcript + blob
  URL → row visible in chat_history with both fields populated.
- The blob file actually exists on disk at the expected path.
- Hermes assistant stream fires after the user message lands.
- 10 MB cap returns 413.
- Bad MIME → 400.
- Missing field → 400.

### Edge cases

- **Slow STT** — 60s memo can take 5-10s on `base` model. Endpoint timeout is
  30s (matching transcribe), should be enough.
- **STT fails mid-flight** — bail with 503; don't insert the chat_history row;
  don't keep the blob (delete on error path).
- **session.create race** — `ensureHermesSession` already deduplicates.
- **Mime sniffing** — if the user sends MP3 instead of M4A, accept it (faster-
  whisper handles both via ffmpeg internally).

---

## Phase 2 — Mobile MicButton long-press routing (3h)

### Files

- `frontend/src/voice/MicButton.tsx` — distinguish tap vs long-press
- `frontend/src/voice/voice-memo-recorder.ts` (NEW) — expo-audio wrapper for
  the memo path (separate from the existing transcribe path)
- `frontend/src/api/voice-memo.ts` (NEW) — typed client for the new endpoint
- `frontend/src/voice/types.ts` — add memo-related types

### Gesture model

| Gesture | Behavior |
|---|---|
| Tap (release within 250 ms) | Existing transcribe-to-composer path |
| Long-press (held >250 ms) | Voice memo mode — record while held, send on release |
| Drag down/left while holding | Slide-to-cancel — release without sending, discard |

Use `react-native-gesture-handler`'s `LongPressGesture` + `PanGesture` composed
together, OR `Pressable` with `onLongPress` + an absolute-positioned cancel
threshold. Pick whatever the existing MicButton already uses for haptics.

### Recording UI while held

Telegram-style:
- Mic button stays at the same position but turns red.
- An expanding rec-bar appears next to the composer showing duration counter.
- "← Slide to cancel" hint text on the bar.
- Haptic on start, on cross-cancel-threshold, and on send.

### Send flow on release

1. Stop the recording.
2. If was-cancelled → discard, return.
3. Otherwise: get the local file URI + duration from expo-audio.
4. Show optimistic audio bubble in chat with status="uploading".
5. Multipart POST to the new endpoint.
6. On success: replace the optimistic bubble with the real message envelope
   (or just confirm the upload — the existing chat stream picks up the new
   user-row + assistant turn naturally).
7. On failure: toast + remove the optimistic bubble. No retry queue for v1.

### Acceptance

- Tap → composer fills with transcribed text, no message sent (existing path).
- Long-press → recording bar appears, on release a voice bubble appears in
  chat, transcript caption beneath, audio plays correctly on tap.
- Slide to cancel during recording → no upload, no bubble, audio discarded.
- Permission denied → existing error path still surfaces.

### Edge cases

- **Background while recording** — pause expo-audio, cancel on backgrounding.
- **Phone call during recording** — audio session interruption notification:
  cancel the recording, surface a toast.
- **Mic button accidentally double-pressed** — debounce: ignore re-press while
  state is recording.
- **Network drop mid-upload** — upload aborts, toast surfaces, optimistic
  bubble removed.

---

## Phase 3 — `<AudioMessage>` chat bubble (3h)

### Files

- `frontend/src/components/chat/AudioMessage.tsx` (NEW)
- `frontend/src/audio/playback-controller.ts` (NEW) — singleton expo-audio
  player so only one memo plays at a time

### Component shape

```
┌──────────────────────────────────────────────┐
│  ▶  ▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░  0:14 / 0:32  │
│                                              │
│  "Yeah I think we should ship the voice      │
│   memo feature next sprint, but only if…"   │
└──────────────────────────────────────────────┘
```

Components:
- Play / pause button (left)
- Plain progress bar (filled portion = elapsed)
- Duration counter `MM:SS / MM:SS`
- Transcription caption underneath, italic + slightly smaller font, with a
  show-more if longer than 4 lines

### Playback controller

Singleton per app. Holds at most one active `Audio.Sound` instance. When a
new bubble starts playing, the old one is unloaded and stopped.

```ts
// playback-controller.ts
class PlaybackController {
  private active: { sound: Audio.Sound; messageId: number } | null = null;
  async play(messageId: number, url: string): Promise<void>;
  async pause(): Promise<void>;
  async seek(progress: number): Promise<void>;  // 0..1
  subscribe(messageId: number, listener: (state) => void): () => void;
}
```

### Local cache

- First time the bubble is shown, fetch the audio bytes via fetch() from the
  gateway, write to `expo-file-system` documentDirectory under
  `audio-cache/<message_id>.m4a`.
- Subsequent plays load from cache directly.
- Cache eviction: simple LRU, cap 100 MB total (matches the offline-support
  hygiene pattern).

### Acceptance

- Bubble shows the right duration on first render.
- Tap play → audio plays, progress bar fills, duration counter updates.
- Tap second bubble while first is playing → first pauses, second starts.
- Scrub the progress bar → audio jumps to that position.
- Caption renders the transcript with show-more behavior on long content.

### Edge cases

- **Audio file missing on the server** — playback errors out cleanly with a
  retry button.
- **Cached file corrupted** — delete cache entry, refetch.
- **Permission revoked** — playback shouldn't depend on mic perm; only audio
  session category. Confirm `.playAndRecord` from Phase 1 of WhisperKit
  doesn't conflict.

---

## Phase 4 — Chat scrollback rendering (1h)

### Files

- `frontend/app/(app)/(chats)/chat/[id].tsx` — message switch
- `frontend/src/components/chat/Message.tsx` — branch on `audioBlobPath`

### Logic

When a chat_history row has `audioBlobPath != null`, render `<AudioMessage>`
instead of the text bubble. The transcript still goes into the bubble's
caption — but the primary surface is the audio.

API responses from the gateway need to include the new fields:
- `GET /sessions/:id/messages` → include `audio_blob_path` and
  `audio_duration_ms` for each row that has them.
- WS chat stream events that emit user messages should also include these
  fields when present.

### Acceptance

- Open a chat with mixed text + voice memos → text bubbles render normally,
  voice bubbles render with the audio player.
- Pull-to-refresh / pagination preserves the audio bubble correctly.

### Edge cases

- **Old clients seeing new audio messages** — gracefully handle: if the
  client doesn't know how to render audio, fall back to the text caption.
  Frontend type definitions should treat the new fields as optional.

---

## Phase 5 — Storage hygiene (1.5h)

### Files

- `backend/src/sessions/cleanup.ts` (or wherever existing image cleanup lives)
- `backend/src/routes/sessions.ts` — augment DELETE handler to nuke audio blobs

### Backend hygiene

- On `DELETE /sessions/:id`, find all `audio_blob_path` for that session and
  delete the underlying blob files. Same pattern as existing image cleanup.
  Use a transaction so file deletes only happen after DB delete commits.
- Add a startup task that prunes orphaned audio blobs (files in `voice/`
  with no chat_history reference) older than 24 hours. Catches the case
  where the endpoint crashed after writing the blob but before inserting
  the row.

### Mobile cache

- LRU cap of 100 MB on `audio-cache/` documents directory.
- Eviction triggered on first audio fetch when over cap.
- Manual "Clear voice cache" button in Settings → Diagnostics → Storage card.

### Acceptance

- Delete a chat with voice memos → blob files vanish from disk.
- Orphan blob older than 24h → pruned by startup task.
- Mobile cache stays under 100 MB.

### Edge cases

- **Concurrent delete + new memo to same session** — the DELETE handler
  already takes a row-level lock; new memo would fail with 404 after delete
  starts.
- **External viewer accessing a blob mid-delete** — file unlink is atomic on
  ext4/apfs; existing fd readers continue, new fetches 404.

---

## Phase 6 — Polish + edge cases (2h)

### Recording UI polish

- Haptic on press start, slide-to-cancel threshold cross, release-to-send.
- Animated transition for the rec-bar (slide-in from right, slide-out on
  cancel/send).
- Prevent the keyboard from popping while recording.
- Lock the textarea height so layout doesn't jank.

### Playback polish

- Tap-and-drag scrubber feels right (use `interpolate` / Reanimated).
- Pause auto-stops at end of audio.
- Seek-while-paused works.

### Other

- Privacy-veil compatibility: when the app is backgrounded mid-recording,
  cancel cleanly. Mid-playback, pause and resume on foreground.
- Notifications: cron-output inbox doesn't get spammed by voice memos (they
  go through normal chat).

### Acceptance

- Subjective polish pass — recording UI feels responsive.
- Playback feels smooth.
- No regressions in existing text chat.

---

## Phase 7 — Manual test pass (1h)

| Scenario | Expected |
|---|---|
| Tap mic button | Composer fills with transcript, no message sent |
| Long-press + release | Voice bubble appears with audio + transcript caption |
| Long-press + slide to cancel | No upload, no bubble |
| Long-press for 60s | Memo uploads, transcript matches |
| Long-press during airplane mode | Engine routes to `whisper`/`sfspeech` for transcription, but voice memo upload fails — surface clear error (or queue for v2) |
| Play voice memo, then play another | First pauses, second starts |
| Scrub progress bar | Audio jumps to position |
| Backgrounding mid-recording | Recording cancels cleanly, no zombie state |
| Backgrounding mid-playback | Audio pauses, resumes on foreground |
| Delete a chat with voice memos | Audio blob files vanish from disk |
| Voice memo on a fresh chat (no first message yet) | `ensureHermesSession` creates Hermes session, memo lands |

---

## Risks + open questions

- **Storage growth.** Each minute of voice ≈ 480 KB. 1000 memos ≈ 500 MB.
  Cleanup pruning + per-user quota are the safety nets. Keep an eye on the
  VPS disk after rollout.
- **STT cost.** Every voice memo costs faster-whisper time. On a `base`
  model, ~60s of audio = ~3-5s CPU. With ~10 concurrent users sending
  bursts, the dashboard's ThreadPoolExecutor could saturate. Worth a
  Grafana watch.
- **Multi-language memos.** STT auto-detects per memo. If the user mixes
  languages within a memo, Whisper may transcribe one language only. Same
  limitation as the existing transcribe path.
- **Voice memo offline.** v1 hard-fails when the device is offline because
  upload is impossible. v2 could queue + replay on reconnect (mirror of
  the pending-mutations queue).
- **Privacy.** Audio is stored unencrypted on the VPS. Same threat model
  as text messages today, but audio carries voice biometrics — flag in
  privacy docs if/when those exist.
- **Volume control during playback.** Use the system volume; we don't
  expose an in-bubble volume slider.
- **Long memos vs assistant context.** If a 5-minute memo transcribes to
  ~750 tokens, it still fits any modern context window. No special
  handling needed for v1.

---

## Total estimate

| Phase | Time |
|---|---|
| 0 — Schema + storage prep | 45 min |
| 1 — Backend voice-memo endpoint | 3h |
| 2 — Mobile MicButton long-press | 3h |
| 3 — AudioMessage bubble component | 3h |
| 4 — Chat scrollback rendering | 1h |
| 5 — Storage hygiene | 1.5h |
| 6 — Polish + edge cases | 2h |
| 7 — Manual test pass | 1h |
| **Total** | **~15h** |

Cuts if needed:
- Skip Phase 6 polish → ship rougher UX. Saves ~2h.
- Skip cache LRU in Phase 3 → re-fetch on every play. Saves ~30 min,
  costs bandwidth on replays.
- Skip Phase 5's orphan-pruning startup task → blobs leak silently if
  the endpoint crashes mid-write. Saves ~1h, manageable in dev.
- Cut version: ~10h, covers "long-press to send a voice memo with audio
  + caption rendering, single-playback, basic cleanup on session delete".

---

## Future (v2) work

Already deferred items that aren't lost — track them as separate tasks
when the time comes:

- Waveform rendering (server-side peaks generation OR client-side from
  the audio buffer).
- Pending voice-memo queue: record offline, upload on reconnect.
- Agent-generated voice replies via TTS (the Piper service plan from
  earlier in this branch's history).
- Trim before send.
- Speed control during playback (1×, 1.5×, 2×).
- Show the recording-source language badge (en, hi, …) on the bubble.
