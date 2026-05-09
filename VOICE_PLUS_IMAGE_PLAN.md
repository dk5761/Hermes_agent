# Voice memo + image attachments — phased plan

Goal: let users record a voice memo with one or more images attached. Same UX as a text+image send — the only change is the user can hold the mic instead of typing.

Source of truth for the contract: hermes-agent's `image.attach` → `prompt.submit` protocol. Already used by `chat.send`; voice-memo route just needs the same dance.

---

## 0. Current state (what exists)

### Hermes-agent (no change needed)
- `image.attach { session_id, path }` JSON-RPC binds an image to the session.
- `prompt.submit { session_id, text }` consumes any prior-attached images.
- `chat.send` flow uses this combo successfully today.

### Backend gateway (Fastify, TS)
- `backend/src/ws/gateway-ws.ts:459-520` — `handleChatSend` does:
  1. `attachmentBridge.build({ userId, appSessionId, attachmentIds })` → resolves attachment IDs to local file paths.
  2. Per resolved image: `sharedClient.request("image.attach", { session_id, path })`.
  3. `prompt.submit { session_id, text }`.
- `backend/src/routes/voice-memo.ts:111-185` — `forwardTranscriptToHermes` does ONLY `prompt.submit { session_id, text }`. No bridge call, no image.attach, no `attachmentIds` field on the multipart route.

### Mobile (Expo / RN)
- `src/state/pending-attachments.ts` — image queue (`addPending`, `clearSession`, framework-agnostic).
- `app/(app)/(chats)/chat/[id].tsx` — reads `usePendingAttachments`, threads `attachmentIds` into `chat.send`.
- `src/voice/MicButton.tsx` + `src/voice/voice-memo-recorder.ts` — records audio, calls `postVoiceMemo(sessionId, uri, durationMs, peaks)`. Doesn't know pending attachments exist.
- `src/api/voice-memo.ts` `postVoiceMemo()` — multipart with `audio`, `audioDurationMs`, `audioPeaks` fields. No `attachmentIds`.
- `src/state/chat-store.ts` `pushVoiceMemoMessage()` — local-first bubble shape doesn't carry `attachmentRefs`.

### Chat-history payload
- Text bubble: `payload.attachmentIds: string[]` already persisted by `handleChatSend` (and read by `historyRowToUiRow` at `chat/[id].tsx:261-264`).
- Voice memo bubble: payload has audio fields only. No `attachmentIds`.

---

## 1. Phase plan

Phases are sequential. Each phase ends with a green typecheck + at least one verifiable behavior. Backend phases are VPS-deployable independently; mobile phases ship via EAS OTA.

### Phase 1 — Backend: extract `attachAndSubmit` shared helper

**File: `backend/src/ws/attach-and-submit.ts`** (new, ~60 lines)

```ts
export interface AttachAndSubmitArgs {
  sharedClient: HermesWsPool["getOrCreateShared"] extends () => infer C ? C : never;
  hermesSessionId: string;
  attachmentBridge: AttachmentBridge;
  userId: string;
  appSessionId: string;
  attachmentIds: readonly string[];
  text: string;
  promptPrefix?: string; // for clipboard / system additions
  log: AppLogger;
}
export interface AttachAndSubmitResult {
  finalText: string;
  resolvedAttachmentIds: string[];
  warnings: string[];
}
export async function attachAndSubmit(args: AttachAndSubmitArgs): Promise<AttachAndSubmitResult>;
```

- Encapsulates: `attachmentBridge.build` → for-loop of `image.attach` → `prompt.submit`.
- Returns the `finalText` (with prompt prefix from clipboard etc.) plus resolved IDs and any warnings.
- Throws typed errors: `AttachmentUnauthorizedError`, `ImageAttachFailedError`, `PromptSubmitFailedError` so callers can map to their own error surfaces (WS `control.error` vs HTTP 4xx/5xx).

**File: `backend/src/ws/gateway-ws.ts`** (refactor)
- Replace lines 459-520 of `handleChatSend` with a single `attachAndSubmit({...})` call.
- Map the new typed errors to existing `control.error` payloads (no protocol change for the mobile client).

**Tests:** add `backend/scripts/test-attach-and-submit.ts` smoke runner — mocks shared client + bridge, asserts the call sequence.

**Deliverables:** typecheck green, chat.send still works (manual: send a text+image from mobile, verify upstream sees `image.attach` then `prompt.submit`). No mobile change.

---

### Phase 2 — Backend: voice-memo route accepts `attachmentIds`

**File: `backend/src/routes/voice-memo.ts`**
- Add multipart field branch: `else if (part.type === "field" && part.fieldname === "attachmentIds")` → parse JSON string into `string[]`. Reject (HTTP 400) on malformed JSON or non-string elements.
- Cap on count (mirror chat.send: max 20 attachments).
- Persist `attachmentIds` into the `user.message` chat_history row payload alongside the audio fields.
- Replace `forwardTranscriptToHermes`'s single `prompt.submit` call with `attachAndSubmit({...})` from Phase 1.

**Edge case to handle**:
- Voice memo persists the user.message row BEFORE transcription completes (transcribing → completed). Attachments need to be visible on the bubble immediately, not after transcription. Persist `attachmentIds` on the row at multipart-parse time, not at `forwardTranscriptToHermes` time.

**Tests:** integration test (Fastify-inject) — POST a multipart with audio + `attachmentIds`, assert the bridge is invoked with the right args and the response payload includes `attachmentIds`.

**Deliverables:** route accepts the field, persists it, and forwards via `attachAndSubmit`. No mobile change yet — the field is optional, old clients keep working.

---

### Phase 3 — Mobile API: `postVoiceMemo` accepts `attachmentIds`

**File: `frontend/src/api/voice-memo.ts`**
- Add `attachmentIds?: readonly string[]` parameter to `postVoiceMemo`.
- Append a multipart field `attachmentIds` (JSON-stringified array) when non-empty.
- Update the response `VoiceMemoMessage` type to include `attachmentIds?: string[]` so callers can render them.

**File: `frontend/src/voice/voice-memo-uploader.ts`**
- Pending-memo store gains `attachmentRefs?: AttachmentDTO[]` field.
- Upload path passes `memo.attachmentRefs?.map(a => a.id)` through to `postVoiceMemo`.
- On success, the server response's `attachmentIds` flows into the bubble update.

**File: `frontend/src/state/pending-memos.ts`** (new field on memo type)
- Persist `attachmentRefs` so a kill+reopen during a voice memo upload still includes the images.

**Deliverables:** typecheck green. Calling `postVoiceMemo` with attachmentIds works end-to-end against Phase 2 backend (test on local docker).

---

### Phase 4 — Mobile UI: MicButton wires pending attachments + chat-store renders them

**File: `frontend/src/voice/MicButton.tsx`** (and/or its parent in `chat/[id].tsx`)
- On mic-release → before enqueuing the pending-memo, snapshot `usePendingAttachments(sessionId)` and stuff the array onto the memo entry.
- After enqueue, `clearPending(sessionId)` — same hand-off semantic as text+image send.

**File: `frontend/src/state/chat-store.ts`** `pushVoiceMemoMessage`
- Optimistic local-only path takes optional `attachmentRefs` and stores them on the UserMessage. Renderer (`Message.tsx` UserRow) already supports `attachmentRefs`.

**File: `frontend/src/voice/voice-memo-uploader.ts`**
- After `renameMessage(localId, hist-u-${dbId})`, sync `attachmentRefs` from server response into the bubble.

**Edge cases:**
- User picks an image, then records a voice memo, then cancels recording → image should stay queued (don't clear on cancel; only clear on actual send).
- User picks an image, records a memo, network drops mid-upload → pending-memo retries with the same attachmentRefs (already persisted from Phase 3).

**Deliverables:** holding mic with pending images attaches both. Bubble shows audio + image thumbnails. Replays correctly on history reload.

---

### Phase 5 — Polish + acceptance

- **History rendering**: voice memo history rows now also have `attachmentIds`. Verify `historyRowToUiRow` for `kind === "user.message"` picks them up — likely already works because the same path handles text bubbles. Add a dedicated fixture test if not.
- **Empty-text guard**: voice memo can have empty transcript (silent recording). Currently the route requires either text OR audio for chat.send. Voice memo always has audio. Confirm `attachAndSubmit` doesn't reject when `text === ""` (it shouldn't — Hermes treats empty prompt with attachments as "describe these images").
- **Error surfaces**: bridge errors today emit `control.error` over WS. The voice-memo route is HTTP — map to `4xx { error: "attachment_unauthorized", attachmentId }` or similar. Mobile shows the existing toast for these.
- **Telegram / desktop senders** (optional): the gateway has Telegram + desktop platforms. None of them currently combine voice + image. Out of scope.

**Acceptance pass on iOS sim:**
1. Send text + image → still works (Phase 1 didn't break it).
2. Record a voice memo with no image → still works (Phases 2-4 don't break it).
3. Pick an image → record a voice memo → release → bubble shows audio + image, agent replies referencing both.
4. Kill app mid-upload → reopen → bubble retries with image still attached.
5. Pick 4 images + record → all 4 attach.
6. Reload history → voice memo row shows the image thumbnails.

---

## 2. Risks / open questions

1. **Voice memo silent recording with images** — current STT might return empty transcript. Hermes treats empty prompts with attached images as "describe these"; verify this is the desired UX (vs "voice memo failed, retry transcription").
2. **Attachment bridge concurrency** — can the bridge handle a chat.send and a voice-memo route call racing for the same image attachment IDs? Today they're serialized per-session because the upstream WS pool has a single shared client per app_session. Phase 1 helper inherits that — no new race.
3. **chat_history payload size** — JSON `payload.attachmentIds` is a few hundred bytes. No issue.
4. **Multipart size limit** — current 10MB audio cap is per-file. Adding `attachmentIds` (a small JSON string) doesn't change anything; the images themselves were already uploaded via the attachment endpoint before voice send, so the multipart body stays small.
5. **Backwards-compat with old mobile clients** — Phase 2 adds an OPTIONAL multipart field. Old clients that don't send it keep working.

---

## 3. File-touch summary

```
backend/src/ws/attach-and-submit.ts                  [new] shared helper
backend/src/ws/gateway-ws.ts                         [refactor] handleChatSend uses helper
backend/src/routes/voice-memo.ts                     [+] accept attachmentIds, persist, attachAndSubmit
backend/scripts/test-attach-and-submit.ts            [new] smoke test
backend/scripts/test-voice-memo-route.ts             [+] add attachmentIds case (or new file)

frontend/src/api/voice-memo.ts                       [+] attachmentIds param + response field
frontend/src/state/pending-memos.ts                  [+] attachmentRefs on memo type
frontend/src/state/chat-store.ts                     [+] pushVoiceMemoMessage accepts attachmentRefs
frontend/src/voice/voice-memo-uploader.ts            [+] thread attachmentRefs through
frontend/src/voice/MicButton.tsx                     [+] snapshot pending attachments + clear on send
frontend/app/(app)/(chats)/chat/[id].tsx             [edit] wire MicButton's onSend to read pending
```

---

## 4. Estimate

- Phase 1 (helper extract + chat.send refactor): 0.5 day
- Phase 2 (voice-memo route): 0.5 day
- Phase 3 (mobile API + uploader): 0.5 day
- Phase 4 (MicButton + chat-store): 0.5 day
- Phase 5 (polish + acceptance): 0.5 day

Total: ~2.5 days.

Deploy: backend after Phase 2 (VPS pull + build + restart), OTA after Phase 4 (`pnpm update:prod`).
