# Voice memo v2 — frontend-first UX

**Goal:** WhatsApp/Telegram-grade recording experience. The frontend owns the
real-time feel: the input slides out into a recording strip, a live waveform
paints as the user speaks, the audio bubble appears in chat the instant they
release, and the server is just durable storage + final transcription.

**Architectural shift:**

```
Today                                  v2
─────                                  ──
record → upload → wait for server →    record → live waveform →
  → backend extracts peaks →             release → instant bubble in chat
  → bubble appears on response           with peaks + uploading indicator
                                       → upload in background
                                       → server transcribes →
                                       → bubble caption updates
                                       → on failure: retry CTA
```

**Three core principles:**

1. **Frontend captures peaks live.** Recorder's metering output → 80 buckets.
   Backend ffmpeg becomes a fallback for old clients only.
2. **Optimistic everything.** Audio bubble materialises in chat the moment
   the user stops recording. Upload + transcription happen in the background.
3. **Local audio is canonical until acknowledged.** The m4a stays on disk +
   in chat-store until the server confirms. On failure, retry from local.

**Three recording modes (all show live waveform overlay, NO live transcript):**

| Mode | Trigger | End |
|---|---|---|
| **Tap-toggle** | Tap (release < 500 ms) | Tap mic again → send |
| **Hold-with-lock** | Press > 500 ms, swipe up to lock icon above mic | Tap mic to stop → send (hands free) |
| **Hold-release** | Press > 500 ms, never lock, just release | Release → send |

Slide left/down past threshold = cancel in any mode.

**Post-send (every mode, identical):**
- Audio bubble appears instantly with the captured waveform
- Caption pill says "Transcribing…" while server processes
- When server returns → replace pill with collapsed accordion ("Transcription ▼")
- On server error → retry CTA

**Scope:**
- Live waveform capture replacing ffmpeg
- Optimistic memo insertion (status = uploading)
- WhatsApp-style recording UI: tap-toggle, hold-with-lock, hold-release
- Persistent pending-memo queue (survives app restart)
- Retry on upload failure
- Backend remains the durable store + fallback peaks extractor

**Out of scope (explicitly):**
- Any live transcription / on-device STT during recording. Voice memos are audio-first; transcription happens server-side after send.

**Out of scope:**
- Live transcription / on-device STT during recording. Audio-only.
- Voice waveform DURING playback morphing visually (just static peaks +
  played fill, same as today).
- Background-thread upload in the iOS sense (BackgroundTasks API). v2 just
  uses normal fetch — uploads are interrupted if the app is killed; the
  pending-memo store handles retry on next launch.
- Voice activity detection (VAD) for auto-stop. User-driven start/stop only.

---

## Locked decisions

1. **Peaks source:** `expo-audio`'s `setOnRecordingStatusUpdate` with
   `meteringEnabled: true`. Polled at ~50 ms intervals. dB → linear via
   `Math.pow(10, db / 20)` clamped 0..1.
2. **Bucket count:** still 80 (matches v1 schema, AudioMessage geometry).
   Bucketing strategy: divide total recording duration into 80 equal slices,
   max amplitude per slice. As recording grows past 80 buckets-worth, fold
   into existing buckets (running max) so a long memo still gets 80 final
   peaks.
3. **Optimistic ID format:** UUID prefixed `local-`. Replaced by server
   `hist-u-<dbId>` on upload success. Chat-store handles ID swap.
4. **Local audio persistence:** copy from temp recording path → permanent
   path under `${documentDirectory}voice-memo-pending/<localId>.m4a` on
   release. Stays until upload acknowledged + server response stored.
5. **Retry policy:** 3 automatic retries with exponential backoff (1s, 5s,
   30s). After 3 failures, show "Failed — tap to retry" CTA. Retry button
   resets the counter.
6. **Live transcription preview:** SFSpeech (already in deps). English-
   biased; user-language picker not exposed in v2 (auto-detect via system).
   Pure visual hint — server transcription is authoritative.
7. **Recording UI replacement:** input box + send button hide; replaced by
   a "recording strip" with timer (left), "Slide to cancel" hint (center),
   pulsing red dot. Overlay above: live waveform + scrolling transcript.
8. **Backend ffmpeg path:** kept as fallback. If client doesn't send
   `audioPeaks` in the multipart body, server runs the existing extractor.
   Old clients keep working unchanged.

---

## Phase 0 — Live peaks capture in voice-memo-recorder (1.5h)

### Files

- `frontend/src/voice/voice-memo-recorder.ts` — extend with metering + peak
  bucketing.
- (Possibly) `frontend/src/voice/peak-bucketer.ts` — extracted helper.

### Implementation

1. Enable metering when constructing the recorder. expo-audio v55+ exposes
   `meteringEnabled: true` on the recording options. If not, set
   `_isMeteringEnabled` via the record options.
2. Subscribe to status updates at 50ms cadence:
   ```ts
   recorder.setOnRecordingStatusUpdate((status) => {
     if (status.metering !== undefined) {
       bucketer.push(dbToLinear(status.metering));
     }
   });
   ```
3. `peak-bucketer.ts` exposes:
   ```ts
   class PeakBucketer {
     constructor(targetBucketCount: number = 80) { ... }
     push(linearAmplitude: number): void;  // 0..1
     /** Get current snapshot (for live waveform render). */
     snapshot(): number[];  // up to targetBucketCount, 0..1
     /** Final snapshot, padded if recording shorter than targetBucketCount samples. */
     finalize(): number[];  // exactly targetBucketCount, 0..1
   }
   ```
   The bucketer:
   - For the first `N < targetBucketCount` samples, each sample IS its own
     bucket. The visible waveform grows bar by bar.
   - Once `samples > targetBucketCount`, fold incoming samples into the
     last bucket via running max.
   - Periodically (every `samples >= targetBucketCount * k` for k>1)
     compress: take pairs of buckets, replace with their max, halve the
     resolution. Keeps total bucket count at `targetBucketCount` even for
     long memos.

4. Return peaks from `stop()`:
   ```ts
   async stop(): Promise<{ uri: string; durationMs: number; sizeBytes: number; peaks: number[] }>
   ```

5. Expose a live snapshot subscription for the recording UI:
   ```ts
   subscribeToPeaks(listener: (peaks: number[]) => void): () => void;
   ```
   Throttled to ~10 fps so the live waveform render isn't flooded.

### Acceptance

- Recording for 5s produces ~100 metering samples → 80 final peaks.
- Long recording (60s) still produces 80 peaks via the fold/compress logic.
- Silent audio → all peaks at min height.
- `pnpm typecheck` clean.

### Edge cases

- expo-audio's metering API differs slightly between SDK versions; fall back
  to ffmpeg-side peaks if `metering === undefined` on every status update.
- iOS lock screen / phone call interruption → recording stops; peaks
  finalized on whatever was captured.

---

## Phase 1 — Optimistic chat-store + pending-memo persistence (3h)

### Files

- `frontend/src/state/pending-memos.ts` — NEW. Zustand store, sqliteKv-persisted.
- `frontend/src/state/chat-store.ts` — extend `UserMessage` to allow
  `id: "local-<uuid>"`, add `uploadStatus: "uploading" | "uploaded" | "failed"`
  and `localAudioUri: string` fields.
- `frontend/src/voice/voice-memo-uploader.ts` — NEW. Upload coordinator:
  takes a pending memo, posts to backend, on success marks uploaded and
  swaps the chat-store ID; on failure increments retry count.

### Pending-memo store shape

```ts
type PendingMemo = {
  id: string;                       // local UUID, e.g. "local-abc123"
  sessionId: string;
  localAudioUri: string;            // file:// URI in app sandbox
  durationMs: number;
  peaks: number[];                  // 80 peaks captured at record time
  enqueuedAt: number;
  retries: number;
  status: "uploading" | "failed";
  lastError?: string;
};

interface PendingMemosState {
  byId: Record<string, PendingMemo>;
  enqueue(args: Omit<PendingMemo, "id" | "enqueuedAt" | "retries" | "status">): string;
  markUploading(id: string): void;
  markFailed(id: string, error: string): void;
  remove(id: string): void;        // on success
  retry(id: string): Promise<void>;
}
```

Persisted via existing `sqliteKv` adapter so memos survive app restart.

### Upload coordinator

```ts
// voice-memo-uploader.ts
export async function uploadPendingMemo(memo: PendingMemo): Promise<void> {
  // POST /sessions/:id/messages/voice with audio + peaks form fields
  // On success: replace chat-store entry's ID with server hist-u-<id>,
  //             remove from pending-memos store, delete local audio file.
  // On failure: bump retry count, schedule next retry with backoff,
  //             keep local audio file.
}
```

### Cold-start replay

On app launch (after auth), the pending-memos store hydrates and re-fires
`uploadPendingMemo` for any memo with `status === "uploading"`. Network-aware
via `useNetworkStatus`.

### Acceptance

- Stop recording → audio bubble appears in chat with `local-<id>` ID and
  peaks rendered immediately.
- Network outage during upload → bubble shows "Failed" CTA after 3 retries;
  audio file still on disk.
- Tap retry → uploads from local file; on success, ID swaps to server form.
- Force-quit + reopen → pending memos resume uploading.

### Edge cases

- **Audio file deleted externally** (cache cleanup, OS purge) — show
  "Recording lost" error, remove from pending-memos.
- **Backend session deleted while memo pending** — upload returns 404;
  treat as permanent failure, remove with toast.
- **ID swap race** — chat-store needs a careful update so the bubble's
  identity stays intact in the FlatList (use the same key for the new ID
  to avoid an unmount/remount on swap).

---

## Phase 2 — WhatsApp-style recording UI: 3 modes (4h)

### Files

- `frontend/src/voice/RecordingStrip.tsx` — NEW. Replaces the input box
  during recording.
- `frontend/src/voice/RecordingOverlay.tsx` — NEW. The above-strip overlay
  with live waveform.
- `frontend/src/voice/LockHint.tsx` — NEW. Floats above the mic button
  during hold mode; the swipe-up target.
- `frontend/src/voice/MicButton.tsx` — gesture machine driving the modes.
- `frontend/app/(app)/(chats)/chat/[id].tsx` — wire in/out the strip vs the
  composer based on `isRecording` state.

### Strip layout (replaces the input row)

```
┌────────────────────────────────────────────────────────────┐
│  ●  0:14    ◀ Slide to cancel                       ▶/✓  │
└────────────────────────────────────────────────────────────┘
```

- Pulsing red dot + timer (left)
- "Slide to cancel" hint with arrow (center, fades as user drags)
- Right side: in tap-toggle / locked-hold mode → send button (✓). In
  hold-release mode → empty (release sends).
- Background: matches chat bg
- Slide-in animation: 200ms ease-out from left
- Slide-out: 150ms ease-in to left

### Overlay (above the strip, live waveform only — NO transcript)

```
┌────────────────────────────────────────────────────────────┐
│         ▁▂▃▅▇█▇▅▃▂▁▁▂▃▅▇█▇▅▃         (live waveform)      │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

Waveform reads from the bucketer subscription (Phase 0) and auto-scrolls
so the most recent peaks paint at the right edge.

### Lock hint (above the mic button, during hold mode only)

```
       ╭───╮
       │ 🔒 │   ← floats ~80pt above mic, fades in when hold > 500ms
       │   │
       │ ▲ │
       ╰───╯
```

When the user drags up past the lock threshold (~60pt above mic), the lock
"snaps" and the recording converts to **locked-hold mode**: user can release
the screen, recording continues, mic button transforms into a stop/send
button (tap to commit).

### Three-mode state machine

```
idle
  │
  ├──tap (heldMs<500ms, no drag)─▶ tap-toggle
  │                                   │
  │                                   ├──tap mic again──▶ committing─▶ idle
  │                                   ├──slide cancel──▶ cancelled──▶ idle
  │                                   └──drag up to lock─▶ locked-hold (rare;
  │                                                                   tap-mode users
  │                                                                   typically don't lock)
  │
  └──hold (heldMs>=500ms)──▶ hold-active
                              │
                              ├──release without drag──▶ committing─▶ idle  (classic PTT)
                              ├──drag down/left──▶ cancelled──▶ idle        (slide cancel)
                              └──drag up past lock threshold──▶ locked-hold
                                                                   │
                                                                   ├──tap mic──▶ committing─▶ idle
                                                                   └──slide cancel──▶ cancelled──▶ idle
```

- `recording` (any sub-state) → strip + overlay visible, input hidden
- `committing` → strip slides out, audio bubble inserted into chat-store
  optimistically (Phase 1), upload starts in background
- `cancelled` → strip + overlay slide out, input slides back in, NO bubble,
  recording discarded

### Implementation notes

- The 500 ms threshold is the existing `LONG_PRESS_THRESHOLD_MS` constant
  (Phase 7.5). Keep it.
- `pressOriginRef` tracks the initial finger position. PanResponder /
  ViewResponder reads `onResponderMove` to compute deltas.
  - `dx > 80` → cancel
  - `dy > 80` (downward) → cancel
  - `dy < -60` (upward, only during hold-active) → engage lock
- Lock UI only renders during hold-active state, fades in over 200 ms once
  `heldMs >= 500`.
- After locking, MicButton's icon changes from "mic" to a "stop" / "send"
  square. Tap → commit.

### Acceptance

- Tap mic (release within 500 ms) → tap-toggle mode. Strip + overlay
  appear. Tap mic again → bubble appears, upload starts.
- Press and hold > 500 ms, then release → classic PTT. Bubble appears,
  upload starts on release.
- Press and hold > 500 ms, drag finger up past 60 pt threshold → lock
  engages (haptic), user can release the screen. Tap mic → commit.
- Drag down/left past 80 pt threshold from any mode → cancel haptic, no
  bubble, input returns.

### Edge cases

- **Keyboard open before recording** — `Keyboard.dismiss()` on start.
- **Mid-recording rotation / split-view** — strip + overlay use flex
  + safe-area; layout adapts.
- **Pinned plan card / branch chip above composer** — they stay; strip
  replaces only the textarea + send button row.
- **Lock target outside screen bounds** — clamp drag-up sensing if the
  screen is short (lock hint floats inside the visible region).

---

## Phase 3 — Backend keeps fallback, accepts client peaks (1h)

### Files

- `backend/src/routes/voice-memo.ts` — accept `audioPeaks` form field.

### Implementation

- Multipart parse: read `audioPeaks` text field. If present, validate
  (JSON.parse → array of 80 numbers in 0..1).
- If valid client peaks: use them directly. Skip ffmpeg.
- If absent or invalid: run the existing `extractAudioPeaks` ffmpeg path.
- Log when client peaks land vs ffmpeg fallback (metric).

### Acceptance

- Mobile sends peaks → DB row has them, no ffmpeg subprocess spawned.
- Old client / curl test without peaks → ffmpeg still extracts.
- Bad peaks (wrong shape, out-of-range) → reject silently, fallback to ffmpeg.

### Edge cases

- **Client sends peaks for a corrupted audio file** — peaks still stored.
  STT will fail naturally on the bad audio; the row is marked
  transcription_status=failed; user retries.

---

## Phase 4 — Manual test pass (1h)

| Scenario | Expected |
|---|---|
| Tap mic | Input slides out, strip slides in, overlay shows live waveform |
| Speak for 5s | Live transcript builds up; live waveform grows bar by bar |
| Speak for 60s | Waveform stays at 80 bars (compress logic working); rec-bar timer reads "1:00" |
| Slide to cancel mid-recording | No bubble, strip slides out, input slides back |
| Tap mic again to stop | Audio bubble appears in chat with peaks; uploading indicator |
| Upload succeeds | Bubble's caption fills with server transcript; uploading indicator clears |
| Upload fails (kill server mid-upload) | Bubble shows "Failed" + retry CTA; tap retry → uploads from local |
| Force-quit during upload | Reopen → upload resumes from pending-memos store |
| Send memo offline | Bubble appears immediately; persists in pending-memos; uploads when online |
| Multiple back-to-back memos | Each gets its own local-<id>; uploaded serially or in parallel (decide) |

---

## Risks + open questions

- **expo-audio metering reliability.** If the API is flaky on certain
  devices, the live waveform falls back to a "bouncing" placeholder during
  recording but the FINAL peaks are still extracted server-side via ffmpeg.
  v2 should detect missing metering and gracefully degrade.
- **Disk space.** 30 days × 1 memo/day × 240 KB = 7 MB on the device.
  Pending-memos with a typo'd cleanup hook could leak. Add a startup audit
  + LRU cap.
- **Race: upload starts before chat-store render.** The upload coordinator
  must not delete the local audio file until BOTH the server returns 201
  AND the chat-store's optimistic entry has had its ID swapped. Atomic step.
- **Concurrent uploads.** If user fires 5 memos in 10s, do they upload in
  parallel or serially? Server can handle ~3 concurrent transcribes.
  Default to serial drain via the pending-memos coordinator (simpler), with
  a settings toggle for parallel later.
- **Live-transcript / mic conflict.** Documented above. May need to
  disable on iOS 17.x if reliably broken.

---

## Total estimate

| Phase | Time |
|---|---|
| 0 — Live peaks capture | 1.5h |
| 1 — Optimistic store + persistence | 3h |
| 2 — WhatsApp recording UI (3 modes + lock) | 4h |
| 3 — Backend client-peaks fallback | 1h |
| 4 — Manual test pass | 1h |
| **Total** | **~10.5h** |

Cuts if needed:
- Skip lock-to-record from Phase 2 — ship with tap-toggle + classic PTT
  only. Saves ~1h, users can't free their thumb on long memos.
- Skip Phase 1's pending-memo persistence — upload-fail just shows toast,
  no retry. Saves ~1.5h, accepts data loss on flaky networks.
- Cut version: ~7h covers "instant bubble + live waveform + tap-toggle +
  classic PTT" without lock + persistence polish.
