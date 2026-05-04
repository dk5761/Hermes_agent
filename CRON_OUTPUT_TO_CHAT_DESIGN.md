# Cron Output → Mobile Chat: Design Notes

**Status:** Design exploration. Not implemented. Captured 2026-05-04.

This document explains how cron job outputs could be delivered into mobile app chat sessions, and the trade-offs between three approaches. Read this first before picking up the work.

---

## 1. The Problem

Today, when a user creates a cron job from the mobile app and the job runs, the output text is **saved to disk only** at `data/hermes-home/cron/outputs/<job_hash>/<run_id>.json`. The mobile app surfaces this in the **Cron tab → run history**, but the output never appears in the chat session where the user originally created the cron.

For comparison: a cron created from a Telegram chat with `deliver: origin` posts the output back to that Telegram chat as a new message. The mobile app's `cli` platform has no equivalent — Hermes treats `cli` as turn-based (request/response only), with no outbound push channel.

**Goal:** make cron output appear in the originating mobile chat session, so the user sees a continuation of the conversation thread.

---

## 2. Current State (as of 2026-05-04)

### How cron delivery works in Hermes today

File: `hermes-agent/gateway/cron/scheduler.py`

- `_KNOWN_DELIVERY_PLATFORMS` — whitelist set of platforms Hermes can push to. Currently includes: `telegram`, `discord`, `slack`, `whatsapp`, `signal`, `matrix`, `mattermost`. Notably **not** `cli`.
- `_HOME_TARGET_ENV_VARS` — per-platform env var that names the default chat ID (e.g. `TELEGRAM_HOME_CHANNEL`).
- `_resolve_origin()` — reads the `origin` field stored on a cron job. `origin` is set when the cron was created via a messaging platform turn: `{platform, chat_id, thread_id, user_id}`. Crons created via the mobile app's `cli` platform do **not** populate origin (Hermes doesn't know how to push back to cli).
- `_resolve_delivery_targets()` — handles comma-separated `deliver` field for fan-out (e.g. `deliver: telegram,discord`).
- `_send_to_platform()` — the actual delivery dispatcher. Branches per platform name to call the right adapter (e.g. `gateway/platforms/telegram.py`).
- Format wrapper:
  ```
  Cronjob Response: <name>
  (job_id: <hash>)
  -------------

  <content>

  To stop or manage this job, send me a new message
  ```
- MEDIA: tags in agent output → extracted via `extract_media()` → sent as native attachments by adapters.
- Telegram chunks at `MAX_MESSAGE_LENGTH = 4096` (paragraph-aware split), see `gateway/platforms/telegram.py:1067`.

### How the mobile app currently surfaces cron output

- Backend gateway watches the FS via `backend/src/hermes/cron-fs.ts` (`listCronOutputs`, `readCronOutput`).
- Routes in `backend/src/routes/cron.ts`: `GET /cron/outputs?job_id=…` and `GET /cron/outputs/:output_id?job_id=…`.
- Frontend Cron tab pulls these and renders. No push notification when a new output lands.

### Why mobile is "second-class"

Hermes' `cli` platform is how mobile gateway sessions are tagged when they hit `/api/ws`. The agent treats cli as a single turn — no concept of "push a message into this session later". Persistent chat history lives in the **gateway DB** (`chat_history`), not in Hermes. Hermes has no idea our gateway maintains durable session state.

So any solution must bridge: cron run completes (Hermes side) → message lands in mobile chat (gateway side).

---

## 3. Three Options

### Option C: Push Notification + Deep-Link (cheapest, recommended first)

Reuses existing push notification infrastructure (chat_complete pushes already work).

**Flow:**
1. Backend gateway watches `cron/outputs/` for new files (already does this for the read API).
2. New file detected → fire push notification: title `Cron: <job name>`, body = first ~200 chars of output.
3. Tap → deep-link to existing Cron tab → run detail view.

**What's needed:**
- New watcher (chokidar) on `data/hermes-home/cron/outputs/` in the gateway.
- Lookup: which user created this cron? Store user binding in `cronPrefs` table when cron is created via mobile app (already have `cronPrefs` row keyed by `userId + hermesJobId`).
- Trigger Expo push to that user's registered devices.
- Deep-link route already exists.

**Pros:**
- ~1-2 days. Reuses notification infra entirely.
- No Hermes code changes.
- Validates whether user actually wants cron output in chats at all before committing to deeper work.

**Cons:**
- Output lives in Cron tab, not in chat thread.
- No conversational continuation — you can't "reply" to the cron output.

---

### Option A: Gateway-Side Synthetic Message Injection (chat-native, medium lift)

Gateway watches cron output files and inserts synthetic `assistant` messages into the originating chat session.

**Flow:**
1. When mobile frontend POSTs `/cron/jobs`, gateway records `{sessionId, userId}` in `cronPrefs` for that hermes job ID.
2. Gateway watches `cron/outputs/` for new files (same as Option C).
3. On new file: read JSON, look up `sessionId` from `cronPrefs`, insert row into `chat_history` table:
   - `role: assistant`
   - `content: <cron output text>` (possibly with the same "Cronjob Response:" wrapper for parity)
   - `metadata: {kind: "cron_output", job_id, run_id}` so frontend can render differently
4. Fire push notification → deep-link to that chat session.
5. User opens chat → sees the cron output as an inline assistant message.

**What's needed:**
- Origin tracking: extend `POST /cron/jobs` to capture `sessionId` from request, store in `cronPrefs`. Schema change: add `originSessionId` column.
- Watcher (same as Option C).
- `chat_history` writer with dedupe (don't re-inject on watcher restart — track processed `run_id`s in a `cronOutputsDelivered` table, or use a marker file `.delivered` next to each output).
- MEDIA: tag handling → resolve to blob attachments stored in `data/blobs/`. Frontend already handles attachment rendering.
- Frontend: render cron-output messages with a small badge (e.g. clock icon + cron name) so user knows it's not a regular agent reply.

**Edge cases:**
- What if user deleted the chat session? → Skip injection, fall back to push-only (Option C behavior).
- What if user replies to the synthetic message? → Hermes treats it as fresh context. The cron output is not in Hermes' agent loop history, so a reply doesn't continue the cron's thread of thought. **This is a fundamental limitation** — short of teaching Hermes about persistent sessions, replies are new turns from Hermes' POV.
- Cron created in chat A, user moves to chat B → output still goes to chat A (where origin was recorded).

**Pros:**
- True chat-thread continuation UX.
- Zero Hermes changes — gateway peeks at Hermes' filesystem (already does this).
- Forward-compatible: if Hermes adds new cron features (retries, etc.), our gateway logic doesn't break.

**Cons:**
- Mobile is the only platform that benefits. Can't combine `deliver: telegram, mobile` in a clean way — would need parallel logic in our gateway watcher.
- Effort: ~3-4 days.
- Replies don't continue the cron's reasoning thread (limitation, not bug).

---

### Option B: Hermes-Side Mobile Platform Adapter (most invasive, agent-native)

Add `mobile` (or upgrade `cli`) as a first-class delivery platform inside Hermes. Hermes calls back into our gateway when delivering.

**Flow:**
1. New file `hermes-agent/gateway/platforms/mobile.py` — adapter that does HTTP POST to our gateway with the cron output.
2. Add `"mobile"` to `_KNOWN_DELIVERY_PLATFORMS` in `cron/scheduler.py`.
3. Add `elif platform == "mobile": from ...platforms.mobile import send; await send(...)` branch in `_send_to_platform`.
4. Optionally: when `cli` session creates a cron, auto-set `origin: {platform: "mobile", session_id: ...}` so `deliver: origin` works natively.
5. Gateway exposes new endpoint `POST /internal/cron-deliver` (Hermes → gateway loopback) which writes to `chat_history` and fires push.
6. Auth: shared secret token between Hermes and gateway, since they're on the same Docker network (loopback only).

**What's needed:**
- ~3-4 files modified in Hermes Python code.
- New gateway endpoint with token auth.
- Same `chat_history` writer logic as Option A.
- Frontend changes same as Option A.

**Pros:**
- True fan-out: `deliver: telegram,mobile` works because Hermes treats them uniformly.
- Mobile is a first-class citizen in Hermes' delivery model.
- Forward-compatible with future Hermes delivery features (retries, batching, MEDIA: handling improvements).
- `deliver: origin` works uniformly — set up in Telegram → goes to Telegram, set up in mobile → goes to mobile.

**Cons:**
- Modifies Hermes upstream code → maintenance cost on every Hermes update.
- Bidirectional dependency: Hermes now knows about gateway (was previously one-way).
- Auth surface: new shared secret.
- ~1 week.

---

## 4. The Patcher Script (for Option B)

If you go with Option B, you'll modify Hermes source. To survive Hermes upgrades, build a script that re-applies the patch automatically.

### Architecture

```
hermes-patches/
  mobile_adapter.py         # Full adapter, copied verbatim into Hermes
  patch-hermes-mobile.py    # The patcher script
  hermes-versions.yaml      # Tested Hermes commits/tags
  scheduler-anchors.yaml    # Pattern definitions for surgical edits
```

### Two-layer patching

**Layer 1 — drop-in file (stable):** `mobile_adapter.py` is fully self-contained. Holds 95% of the logic — HTTP callback to gateway, MEDIA: handling, chunking. Patcher copies it verbatim to `/opt/hermes/gateway/platforms/mobile.py`. Easy: just file copy. Doesn't break on Hermes refactors.

**Layer 2 — anchor edits (fragile):** Two surgical edits to `cron/scheduler.py`:
1. Add `"mobile"` to `_KNOWN_DELIVERY_PLATFORMS` set literal.
2. Add `elif` branch in `_send_to_platform` that imports and calls the adapter.

Use **libcst** (not regex) — preserves formatting, AST-aware, fails loudly when anchors don't match.

### Patcher flow

```python
1. Detect Hermes version (git rev-parse HEAD in hermes-agent dir, or pip show)
2. Check version in supported list (hermes-versions.yaml)
3. Idempotency: parse scheduler.py with libcst. If "mobile" already in the set literal → skip.
4. Apply libcst transform: add to set, add elif branch.
5. Copy mobile_adapter.py → gateway/platforms/mobile.py
6. Smoke test: `python -c "from gateway.cron.scheduler import _KNOWN_DELIVERY_PLATFORMS; assert 'mobile' in _KNOWN_DELIVERY_PLATFORMS"`
7. Print diff summary
```

### Failure modes

| Scenario | Behavior |
|---|---|
| Anchor moved (Hermes refactored function name) | Patcher exits with "expected pattern X near line Y, not found". Update the anchor or pin Hermes to last known good commit. |
| Hermes version not in supported list | Warn but don't refuse — let user decide to proceed. |
| Already patched | No-op, exit cleanly. |
| Smoke test fails after patch | Restore from `.bak` snapshot, exit non-zero. |

### Run-as-part-of-build

Add to `docker-compose.yml` build step or run script in `Dockerfile` for `hermes` and `hermes-cron` services so the patch is baked into images. Or run as a one-shot init container before main services start.

### Reversibility

Patcher should:
- Save original `scheduler.py` to `scheduler.py.unpatched` once (first run only).
- Provide `--unpatch` flag that restores from `.unpatched` and removes `mobile.py`.

### Pattern reference

Same pattern we already use for `scripts/patch-hermes-config.py` (idempotent ruamel.yaml-based config patcher with `DESIRED_MCP_SERVERS` + `DESIRED_PLATFORM_TOOLSETS` dicts). Code patching is fragile-er than config patching, but the principle is identical: declarative desired state + idempotent reconciliation + loud failures.

---

## 5. Comparison Table

| | Option C: Push Only | Option A: Gateway Injection | Option B: Hermes Adapter + Patcher |
|---|---|---|---|
| **UX** | Tap notification → Cron tab → output | Output appears as inline assistant message in chat | Same as A |
| **Effort** | 1-2 days | 3-4 days | ~1 week + ongoing patch maintenance |
| **Hermes code changes** | None | None | Yes — 3-4 files |
| **Maintenance on Hermes upgrade** | None | None | Re-run patcher; manual fix if anchors moved |
| **Fan-out (telegram + mobile)** | N/A | Awkward (parallel logic) | Native, clean |
| **Cron-output-as-chat-message** | No | Yes | Yes |
| **Reply-to-cron continues thread** | No | No (limitation of Hermes architecture) | No (same limitation) |
| **Push notifications** | Yes | Yes (same infra) | Yes (same infra) |
| **Origin tracking (`deliver: origin` works)** | Manual via `cronPrefs` | Manual via `cronPrefs` | Native — auto-populated by Hermes |
| **Auth surface** | None new | None new | Shared secret Hermes ↔ gateway |
| **Forward compat with Hermes delivery features** | Partial | Partial | Full |
| **Coupling direction** | One-way (gateway reads Hermes FS) | One-way (gateway reads Hermes FS) | Bidirectional (Hermes calls gateway) |

---

## 6. Recommendation

**Ship Option C now.** It validates whether you actually want cron output in chats at all — pushes alone may be enough, especially if cron output is mostly summary/status.

**Use it for 2-4 weeks.** Notice if you crave the inline-message UX. If you're frequently jumping to the Cron tab and wishing the output was in your conversation thread, that's the signal to upgrade.

**If signal is strong → build A first, not B.** A is 80% of the value at 50% of the cost. No Hermes patching means no upgrade pain. The fan-out feature B unlocks (one cron → telegram AND mobile) is rare in practice.

**Only build B + patcher if:**
- You actively want fan-out for the same cron job, OR
- You plan to upstream the adapter to Hermes proper (PR), in which case the patcher is just a stopgap until the PR merges.

---

## 7. Implementation Notes (when ready to build)

### Origin tracking (needed for A and B)

Schema change to `cronPrefs` table: add `originSessionId TEXT` column. Backfill nullable.

In `backend/src/routes/cron.ts`, `POST /cron/jobs` handler:
- Read `X-Hermes-Session-Id` header (or body field) from request.
- After Hermes returns the created job ID, upsert `cronPrefs` row with `{userId, hermesJobId, originSessionId}`.

Frontend: when calling `POST /cron/jobs`, include current `sessionId` in the request body.

### File watcher (Option A and C)

Use chokidar on `${HERMES_HOME}/cron/outputs/` recursively. Pattern:

```typescript
chokidar.watch(`${hermesHome}/cron/outputs`, {
  ignoreInitial: true,  // don't fire for existing files on startup
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 500 },  // wait for write to finish
}).on('add', async (filePath) => {
  // Parse filePath → extract job_hash and run_id
  // Look up cronPrefs by hermesJobId → get userId + originSessionId
  // Read JSON, inject as chat message (Option A) or just push (Option C)
});
```

Track delivered runs in a new `cronOutputsDelivered` table to survive watcher restarts:
```sql
CREATE TABLE cronOutputsDelivered (
  hermesJobId TEXT NOT NULL,
  runId TEXT NOT NULL,
  deliveredAt INTEGER NOT NULL,
  PRIMARY KEY (hermesJobId, runId)
);
```

### chat_history insertion (Option A and B)

```typescript
await db.insert(chatHistory).values({
  sessionId: originSessionId,
  role: 'assistant',
  content: cronOutputText,
  metadata: JSON.stringify({ kind: 'cron_output', jobId, runId, jobName }),
  createdAt: Date.now(),
});
```

Frontend: in chat message renderer, check `metadata.kind === 'cron_output'` and add a clock badge + cron name above the message bubble.

### Push notification format (all options)

Reuse `chat_complete` notification helper. Title: `Cron: <job_name>`. Body: first 200 chars of output, single line. Data payload: `{ kind: 'cron_output', sessionId, jobId, runId }` so deep-link router can navigate appropriately.

### Hermes adapter file (Option B)

```python
# hermes-agent/gateway/platforms/mobile.py
import os
import httpx

GATEWAY_URL = os.environ["MOBILE_GATEWAY_URL"]  # e.g. http://gateway:8080
GATEWAY_TOKEN = os.environ["MOBILE_GATEWAY_TOKEN"]

async def send(*, chat_id: str, content: str, attachments: list, job_meta: dict) -> bool:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{GATEWAY_URL}/internal/cron-deliver",
            headers={"Authorization": f"Bearer {GATEWAY_TOKEN}"},
            json={
                "session_id": chat_id,
                "content": content,
                "attachments": attachments,
                "job_meta": job_meta,
            },
        )
        return resp.status_code == 200
```

Gateway endpoint:
```typescript
// backend/src/routes/internal.ts
app.post('/internal/cron-deliver', async (req, reply) => {
  // Validate Authorization: Bearer <token> matches env
  // Parse body
  // Insert into chat_history
  // Fire push notification
  return reply.send({ ok: true });
});
```

Bind only on internal Docker network. Don't expose externally.

---

## 8. Open Questions (for future-me)

1. **Should cron output be a special message type in the chat, or just a regular assistant message?** Special type lets us render it differently (clock badge, cron name) but adds frontend complexity. Regular message is simpler but indistinguishable from agent replies.

2. **What happens if the user deletes the originating chat session?** Skip injection? Move output to a "Cron archive" session? Fall back to push-only?

3. **MEDIA: attachments for cron output.** Hermes' Telegram adapter handles MEDIA: tags by sending native attachments. For mobile, we'd need to: (a) extract MEDIA: tag, (b) resolve file path inside Hermes container, (c) copy to gateway's blobs dir, (d) link in chat_history attachment column. Non-trivial — defer to v2.

4. **Rate limiting.** What if a cron fires every minute and dumps 10KB? Should gateway throttle injections per session? Probably yes — limit to 1 injection per cron per minute, drop subsequent runs to disk-only with an "X cron runs queued" indicator.

5. **Backfill on watcher startup.** If gateway was down for an hour and 3 cron runs completed, should they all inject when watcher comes back? Probably yes for the most recent run only, with a "+ 2 more in Cron tab" link. Tracked via the `cronOutputsDelivered` table.

---

## 9. References

- Hermes scheduler: `hermes-agent/gateway/cron/scheduler.py` (lines 74-83 platform whitelist, 138-185 origin/target resolution, 236-260 fan-out, 321-460 send dispatch)
- Telegram adapter: `hermes-agent/gateway/platforms/telegram.py` (line 249 max length, 1067-1069 chunking)
- Existing config patcher: `scripts/patch-hermes-config.py` (the pattern to mimic for the code patcher)
- Backend cron routes: `backend/src/routes/cron.ts`
- Backend cron FS watcher: `backend/src/hermes/cron-fs.ts`
- DB schema: `backend/src/db/schema.ts` (look for `cronPrefs`, `chatHistory`)
- Frontend cron tab: `frontend/app/(app)/(cron)/index.tsx`
- Existing push infra: search for `chat_complete` and `expo-server-sdk` usage in `backend/src/`
- Docker compose: `docker-compose.yml` (services: hermes, hermes-cron, gateway)
