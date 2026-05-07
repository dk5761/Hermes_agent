# Voice memo waveform — phase by phase

**Goal:** replace the plain progress bar inside `<AudioMessage>` with a real
waveform rendered from server-extracted audio peaks. Telegram-style: fixed
bars per memo, "played" portion filled with accent color, "unplayed" portion
tinted, tap/drag to seek.

**Approach (decided in VOICE_MEMO_PLAN v1 review):** server-side peaks
generation via ffmpeg. Backend extracts peaks at upload time, stores as JSON
on the `chat_history` row, returns alongside audio metadata. Mobile renders
from the array.

**Scope:**
- New `audio_peaks_json` column on `chat_history`.
- Inline ffmpeg subprocess inside the voice memo POST, ~200-500 ms extra.
- N=80 peaks per memo (Telegram convention).
- AudioMessage waveform component with fill + tap/drag seek.
- Graceful fallback: old memos (peaks=NULL) keep the plain progress bar.

**Out of scope:**
- Backfill of historical memos (would need a one-shot script — skip for v1).
- Per-pixel scaling (we use fixed 80 bars; long memos compress, short memos
  spread out).
- Animated bar height (the bars are static; only the fill animates).
- Microphone-input live waveform during recording (cosmetic only — defer).

---

## Locked decisions

1. **Bucket count:** N=80. Telegram uses 100, WhatsApp ~50; 80 is the sweet
   spot for our 280pt min bubble width (80 bars × 3pt each = 240pt).
2. **Sample format:** ffmpeg → 8 kHz mono PCM float32. 60 s clip = 480 k
   samples; bucket = 6000 samples each; peak per bucket = `max(abs(samples))`.
3. **Normalization:** divide every peak by the global max across all 80
   buckets. Loudest moment = 1.0. Quiet memos still fill the visual area.
4. **Storage:** JSON-encoded array of 80 floats rounded to 3 decimals
   (e.g. `[0.123, 0.456, ...]`). ~720 bytes per row. Negligible storage
   impact even at 10k memos (~7 MB).
5. **Inline extraction.** Synchronous within the voice memo POST. Adds
   ~200-500 ms. Acceptable since the same request already runs faster-whisper
   STT (5-10 s for 60 s clips). The extra ffmpeg run is in the noise.
6. **No retry / backfill on failure.** If peaks extraction fails (ffmpeg
   crash, malformed audio), log a warning and proceed with `peaks = null`.
   Mobile falls back to plain progress bar. STT path is unaffected.
7. **Bar geometry:** width 2pt, gap 1pt, max height 24pt, min height 2pt.
   Bars centered vertically.

---

## Phase 0 — Schema migration (15 min)

### Files

- `backend/src/db/migrations/0009_audio_peaks.sql` (NEW)
- `backend/src/db/migrations/meta/0009_snapshot.json` (regen)
- `backend/src/db/schema.ts`

### Migration

```sql
ALTER TABLE chat_history ADD COLUMN audio_peaks_json TEXT;
```

NULL for existing rows. No index — we never query by peaks, just project
them in row reads.

### Acceptance

- `pnpm db:migrate` runs cleanly.
- `SELECT audio_peaks_json FROM chat_history LIMIT 1` returns NULL.
- `pnpm typecheck` clean.

---

## Phase 1 — Backend peak extraction (2h)

### Files

- `backend/src/blobs/audio-peaks.ts` (NEW) — ffmpeg-driven extractor
- `backend/src/routes/voice-memo.ts` — call extractor inline, store on row

### Extractor

```ts
// backend/src/blobs/audio-peaks.ts
export async function extractAudioPeaks(
  blobPath: string,
  bucketCount: number = 80,
): Promise<number[] | null> {
  // spawn ffmpeg, pipe stdout to a Buffer, parse as Float32Array, bucket
  // by averaging max(abs(samples)) per bucket, normalize to [0..1].
}
```

Implementation details:
- Use `child_process.spawn("ffmpeg", ["-i", blobPath, "-ac", "1", "-ar", "8000", "-f", "f32le", "-"])`.
- Read stdout into a Buffer; convert to `Float32Array` via `new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)`.
- For each bucket of `floor(samples.length / bucketCount)` samples, compute
  `Math.max(...absValues)`. (Use a loop, not spread — 6000 args breaks call
  stack on `Math.max(...arr)`.)
- Normalize: divide by the global max. If global max is 0 (silent audio),
  return an array of zeros (or null — silent memo, plain bar is fine).
- Round to 3 decimals to keep the JSON small.
- Wrap in try/catch — on ffmpeg failure, return null.
- Add a 5 s deadline so a hanging ffmpeg doesn't block the request.

### Wire into voice memo POST

Inside `/sessions/:id/messages/voice` (Phase 1 of voice memos), AFTER blob
write but BEFORE STT:

```ts
const peaks = await extractAudioPeaks(blobAbsolutePath).catch(() => null);
// then in the chat_history insert:
.values({
  ...
  audioPeaksJson: peaks ? JSON.stringify(peaks) : null,
  ...
})
```

Same insertion in the retry-transcription endpoint (peaks are already
on the row from the original upload — don't re-extract).

### Acceptance

- POST a 5 s test memo via curl → row has `audio_peaks_json` populated with
  80 floats.
- POST a malformed audio file → row has `audio_peaks_json = NULL`, no crash.
- Inspect DB: `SELECT json_array_length(audio_peaks_json) FROM chat_history WHERE audio_peaks_json IS NOT NULL` → 80 for every row.
- `pnpm typecheck` clean.

### Edge cases

- **ffmpeg not on PATH** in some prod images. Document the dep, but our
  Hermes container already has it (faster-whisper uses it).
- **Very short memos** (<1 s) → fewer than 6000 samples per bucket. Fall
  back to bucket size = `floor(samples.length / bucketCount) || 1`. Each
  bucket may be just a couple of samples; still produces 80 values, just
  noisier visually.
- **Stereo input** that ffmpeg downmixes — `-ac 1` handles it.
- **ffmpeg crash mid-stream** → process exits non-zero; we catch and
  return null.

---

## Phase 2 — Response envelope + frontend types (1h)

### Backend changes

- `backend/src/ws/chat-history.ts` — add `audioPeaks: number[] | null` to
  `HistoryRow` projection. Parse JSON on read; null if blank.
- `backend/src/routes/sessions.ts` — `GET /sessions/:id/messages` already
  spreads HistoryRow, just needs the new field.
- `backend/src/routes/voice-memo.ts` — voice memo POST response envelope
  gets `audioPeaks: number[] | null`. Retry endpoint same.

### Frontend type updates

- `frontend/src/api/types.ts` — `HistoryRow` gains `audioPeaks?: number[]`.
- `frontend/src/state/chat-store.ts` — `UserMessage` gains
  `audioPeaks?: number[]`.
- `frontend/src/api/voice-memo.ts` — `VoiceMemoMessage` envelope updated.
- `frontend/app/(app)/(chats)/chat/[id].tsx` — `historyRowToUiRow` carries
  `audioPeaks` onto the live `UserMessage`.
- `frontend/src/voice/MicButton.tsx` — `pushVoiceMemoMessage` includes
  `audioPeaks` from the response.

### Acceptance

- `pnpm typecheck` clean on both backend + frontend.
- POST a memo → frontend receives `audioPeaks: number[]` in the response.
- Open chat with mixed historical (peaks=null) and new (peaks=array) rows
  → both flow through to AudioMessage props correctly.

---

## Phase 3 — AudioMessage waveform rendering (2h)

### Files

- `frontend/src/components/chat/AudioMessage.tsx` — replace the plain
  progress bar with a `<Waveform>` subcomponent

### `<Waveform>` subcomponent

Props:
- `peaks: number[] | null` — 80 floats 0..1, or null
- `progress: number` — 0..1
- `tint: string`, `fillColor: string`
- `onSeek: (progress: number) => void`

Layout:
- 80 vertical `View` bars with `flexDirection: row`, `alignItems: center`
- Bar `i` height: `Math.max(2, peaks[i] * 24)` (min 2pt, max 24pt)
- Bar width 2pt, gap 1pt → 240pt total
- Each bar's color: filled if `i / 80 < progress`, else tinted

Fallback when `peaks == null`:
- Render the existing plain progress bar (the one we ship in v1).

Seek behavior:
- Reuse the existing PanGesture + Tap from the current scrubber.
- The drag math is the same: convert touch x → fraction of total bar
  width → seek.

### Animation during playback

- Live `progress` prop derived from `usePlaybackState().positionMs / durationMs`.
- Bars don't animate height — only the played/unplayed split moves.
- Use `useDerivedValue` (Reanimated) so the played boundary updates without
  re-rendering all 80 bars on every position tick. Or render once and use
  a single absolutely-positioned overlay mask. Cheaper.

### Decision: single-mask approach (recommended)

Render the 80 bars once with the tint color. Layer an absolutely-positioned
fill view on top with `width: progress * totalWidth` and the same bar mask.
Use Reanimated `useAnimatedStyle` for the width.

Tradeoff: the played bars share the SAME peak values as the tinted
underneath (since it's the same waveform), so a mask just colors over them.
Visually identical to drawing each bar twice. Performance much better — one
animated style per bubble instead of 80.

### Acceptance

- New memo renders waveform — bars reflect actual audio loudness.
- Old memo (peaks=null) renders the plain progress bar.
- Tap a bar → seeks to that position. Drag along bars → continuous seek.
- Smooth fill animation during playback (no per-frame re-render of bars).

### Edge cases

- **Memo shorter than 1 s** — peaks are noisy but still 80 values; visually
  shows the actual quick burst of loud audio.
- **Silent memo** (peaks all zero) — bars render at min 2pt; user sees a
  flat line. Acceptable signal of "nothing recorded".
- **Theme switch mid-playback** — bar colors update via tokens; played mask
  uses the same `accent` token.

---

## Phase 4 — Manual test pass (30 min)

| Scenario | Expected |
|---|---|
| Send new voice memo | Bubble renders 80 bars varying by loudness |
| Open chat with old voice memos (pre-Phase 0) | Plain progress bar; no errors |
| Tap a bar mid-playback | Seek to that position |
| Drag finger across bars | Continuous seek |
| Play to completion | All bars fully filled |
| Pause mid-playback | Played portion stays filled, no further animation |
| Server returns peaks=[] (empty) | Plain progress bar fallback |
| Server returns peaks with all zeros | Flat-line waveform |
| Send memo while ffmpeg unavailable on server | Backend logs warning; bubble appears with plain progress bar |
| Long memo (5 min) | Bars look compressed but still 80; play fill works |

---

## Risks + open questions

- **ffmpeg latency.** 200-500 ms per memo. On busy days (multiple
  concurrent memos), this could compound. If it becomes an issue, move
  extraction to a background worker (Phase 1.5 — defer until measured).
- **JSON parsing on every row read.** ~720 bytes × 100 messages = 72 KB
  parsed per chat open. Negligible.
- **Old memo backfill.** A future "Backfill peaks" button in Diagnostics
  could re-run extraction over historical rows. Out of scope for v1.
- **Waveform quality on very short clips.** A 0.5 s memo gives ~4000
  samples → 50 samples per bucket. Peaks come out spiky. Mitigation: use
  `(max + RMS) / 2` per bucket instead of pure max if the spikiness is
  bothersome. Don't pre-optimize.
- **Per-bar tap precision** — at 2pt + 1pt gap, finger touches span ~10
  bars. Use `closest bar index` math rather than expecting pixel-perfect
  hits. The seek already lands on a continuous fraction so this is moot.

---

## Total estimate

| Phase | Time |
|---|---|
| 0 — Schema migration | 15 min |
| 1 — ffmpeg peak extractor | 2h |
| 2 — Response envelope + types | 1h |
| 3 — Waveform rendering + seek | 2h |
| 4 — Manual test pass | 30 min |
| **Total** | **~6h** |

Cuts if needed:
- Skip Phase 4 deferred work (RMS averaging, mask animation perf) → ship
  the simpler approach. Saves ~30 min, slightly worse visuals on extreme
  edge cases.
- Cut version: ~5h with a simpler "render every bar individually with
  conditional color" approach. Fine on iOS where 80 Views is cheap.
