# Cron Inbox — implementation plan

Scope: when the agent schedules a recurring task, ask the user where the
output should go (current chat or a new dedicated inbox), default to inbox,
and surface the inbox in the existing Cron tab. New jobs only — existing
crons keep their current markdown-file + push-notification flow untouched.

## Locked decisions

1. **Binding cardinality.** 1:1 — every cron has its own dedicated inbox
   (when `output_kind='inbox'`). N:1 (one inbox for many crons) is out of
   scope; revisit if a user asks.
2. **Inbox composer.** Enabled in **follow-up mode** — the user can ask the
   agent a question about the cron's output. The follow-up prompt routes to
   the same Hermes session the cron uses, so the agent retains the cron's
   instructions and prior runs as context.
3. **Cron tab placement.** Top-level (already exists at
   `frontend/app/(app)/(cron)`). This plan extends the existing screens
   rather than introducing a new tab.
4. **Migration scope.** New jobs only. Existing crons created without an
   `output_target` keep firing into `${HERMES_HOME}/cron/output/<jobId>/*.md`
   with the existing `CronOutputWatcher` push fan-out. No retroactive bind.

## How the pieces fit

Existing today:
- `hermes-cron` service runs `jobs.json`, writes output as markdown to
  `${HERMES_HOME}/cron/output/<jobId>/*.md`.
- Backend `CronOutputWatcher` watches the directory, sends Expo pushes
  using each user's `cron_prefs` row.
- Frontend `(cron)` tab lists jobs (`GET /cron/jobs` proxied to Hermes'
  `/api/cron/jobs`), supports create/edit/delete.

New on top:
- `cron_job_bindings` table maps `cron_job_id → app_session_id` with an
  `output_kind` ('inbox' | 'session') discriminator.
- `app_sessions.kind` discriminator separates user chats from cron inboxes.
- Cron worker (gateway-side post-processor) on each output file:
  - If a binding exists: run `prompt.submit` against the bound Hermes
    session so the cron output streams into chat_history of the bound
    `app_session`. Skip the existing push fan-out (the chat-complete
    notifier handles that path).
  - If no binding: existing `CronOutputWatcher` flow fires unchanged.
- Frontend `(cron)` index shows the destination per job ("→ Inbox" link).
  Tapping the inbox link navigates to `chat/[id]` rendered with kind
  `'cron_inbox'` (composer behaves as follow-up).

## Phase 0 — Schema + bindings table (~2h)

**DB migration** (`backend/src/db/migrations/0010_cron_inbox.sql`):

```sql
ALTER TABLE app_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'user';
-- 'user' | 'cron_inbox'

ALTER TABLE app_sessions ADD COLUMN cron_job_id TEXT NULL;
-- Hermes' job_id when kind='cron_inbox'. Soft FK (no fkeys across the
-- gateway↔Hermes boundary; we resolve via /api/cron/jobs lookups).

CREATE INDEX app_sessions_kind_idx ON app_sessions (kind);

CREATE TABLE cron_job_bindings (
  cron_job_id        TEXT PRIMARY KEY,    -- Hermes' job_id (1:1)
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_session_id     TEXT NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
  output_kind        TEXT NOT NULL,       -- 'inbox' | 'session'
  hermes_session_id  TEXT NULL,           -- lazy-bound on first fire
  created_at         INTEGER NOT NULL
);
CREATE INDEX cron_job_bindings_user_idx ON cron_job_bindings (user_id);
```

**Schema TS** (`backend/src/db/schema.ts`):
- Add `kind` + `cronJobId` to `appSessions`.
- New `cronJobBindings` table definition.

**Sessions list filter** (`backend/src/routes/sessions.ts`):
- `GET /sessions` filters `WHERE kind='user'` so cron inboxes don't pollute
  the chats list.
- New `GET /cron/inboxes` returns `app_sessions` with `kind='cron_inbox'`
  joined with `cron_job_bindings` for display.

**Frontend types** (`frontend/src/api/types.ts`):
- `SessionDto.kind: 'user' | 'cron_inbox'`.
- `SessionDto.cronJobId?: string`.

## Phase 1 — Cron worker routing (~3h)

**`backend/src/cron/output-watcher.ts`** add a dispatch step before the
existing push fan-out:

```ts
const binding = await getBinding(jobId);
if (binding) {
  await routeToBoundSession(binding, outputBytes, jobMeta);
  return; // skip legacy push path — chat-complete-notifier covers it
}
// fall through to existing markdown push
```

**New module** `backend/src/cron/route-to-session.ts`:
1. Load the cron output markdown file as the agent's prompt body —
   actually no, the markdown IS the agent's output. We don't re-prompt.
   Instead: synthesise the chat history rows directly from the markdown.

Rethink: the cron output today is *generated* by Hermes — it's the agent
already running. Re-running prompt.submit would double-execute. Cleaner
path: persist the existing output as a synthetic `assistant.message` row
in the bound app_session (gateway-only operation, no Hermes round-trip).

```
function routeToBoundSession(binding, mdBytes, jobMeta):
  appSessionId = binding.app_session_id
  text = mdBytes.toString('utf8')

  // Synthetic user.message giving the chat narrative a Q→A shape.
  appendHistory(db, appSessionId, "user.message", {
    text: `▼ Scheduled run · ${formatTimestamp(now)}`,
    cronRun: true,
    cronJobId: binding.cron_job_id,
  })

  // The actual output as an assistant.message row.
  appendHistory(db, appSessionId, "assistant.message", {
    text,
    cronRun: true,
    cronJobId: binding.cron_job_id,
  })

  // Push a live envelope so an open chat screen updates immediately.
  registry.emit(appSessionId, { type: "message.complete", payload: ... })

  // Existing chat-complete-notifier handles push notifications.
```

This means **no Hermes round-trip on output ingestion** — Hermes already
ran the cron job, we just route its output. Simpler, faster, no concurrency
conflict with user-driven turns.

**Follow-up flow** (Phase 3 detail): when the user types in an inbox,
chat.send routes normally. The bound `hermes_session_id` (lazy-created
when the user sends their first follow-up) carries the cron's prompt as
context via session.create with the cron's instructions as system prompt.

## Phase 2 — Agent contract: `schedule_chat_task` tool (~3h)

**MCP tool** registered as `mcp-cron-scheduler` (gateway-hosted, mirrors
the `ios-tools` pattern). Defined in `backend/src/mcp/cron-scheduler.ts`:

```ts
schedule_chat_task({
  name: string;
  cron: string;                  // standard cron expression
  prompt: string;                // what the agent should run on each fire
  output_target?: {              // omit → tool errors with "ask user"
    kind: "inbox" | "current_session";
    inbox_name?: string;         // when kind='inbox', defaults to `name`
    app_session_id?: string;     // when kind='current_session'
  };
})
```

**Implementation** (atomic):
1. If `output_target` missing → return JSON `{ "needs_user_input": true,
   "question": "Where should this cron's output go?", "options": [...] }`.
   The agent surfaces this to the user via the existing clarify.request
   path (or just re-prompts).
2. Create cron entry via Hermes' `POST /api/cron/jobs`.
3. If `output_target.kind === 'inbox'`: create new `app_session` with
   `kind='cron_inbox'`, `cron_job_id=<jobId>`, title=inbox_name.
4. Insert into `cron_job_bindings`.
5. Return `{ success, jobId, appSessionId, output_kind }`.

**Discoverability**:
- Add `mcp-cron-scheduler` to `_CORE_TOOLSETS` in
  `scripts/patch-hermes-config.py`.
- Tool description says "use this when the user asks to schedule a recurring
  AI task" — the agent picks it over the bare `cron_create` flavor that
  doesn't bind to an inbox.

## Phase 3 — Frontend: inbox renders as chat + follow-up composer (~3h)

**`frontend/app/(app)/(chats)/chat/[id].tsx`**:
- Detect `session?.kind === 'cron_inbox'`. Branch the composer:
  - **Header**: shows "Cron: <name> · <schedule>" instead of the regular
    title (data from `cron_job_bindings` join in `GET /sessions/:id`).
  - **Composer placeholder**: "Ask a follow-up about this cron…".
  - **Send semantics**: identical to user chat — `chat.send` over WS to
    the bound Hermes session. The first follow-up creates the Hermes
    session (lazy bind in `cron_job_bindings.hermes_session_id`).

**`frontend/src/state/chat-store.ts`** + `historyRowToUiRow`:
- Recognise `payload.cronRun === true`. For `kind: "user.message"` rows
  with that flag, render a divider-style row (no bubble, just a centered
  pill "▼ Scheduled run · 2026-05-08 09:00") instead of a normal user
  bubble.
- Backfill divider for "N runs while away" between consecutive cron-run
  divider rows older than the last opened-at marker.

**Cron tab** (`frontend/app/(app)/(cron)/index.tsx`):
- Each job row shows its destination chip:
  - `→ Inbox` (tap → navigate to `/chat/<inbox_app_session_id>`)
  - `→ Chat: <session title>` (tap → navigate to that chat)
- Filter: "Show: All / Inbox / In-chat" segmented control.

**`frontend/app/(app)/_layout.tsx`** doesn't need changes (Cron tab already
exists).

## Phase 4 — Notifications + lifecycle (~2h)

**Push** (`backend/src/cron/notify.ts`):
- Per-binding `notify_on_run` toggle (default: TRUE for inbox, FALSE for
  current-session). Stored on `cron_job_bindings.notify_on_run BOOLEAN`.
- Tap → deep-links to `/chat/<app_session_id>` (inbox or chat alike).

**Lifecycle**:
- Delete cron job (existing route): cascade-delete the inbox session +
  its binding. User chats with current-session bindings keep their
  cron_history rows (they stand alone as messages).
- Delete inbox app_session: cascades to bindings via FK; gateway also
  calls Hermes `DELETE /api/cron/jobs/<id>` to remove the schedule.
- Delete user app_session that was bound as `current_session`: re-bind
  the cron to a fresh inbox so it doesn't lose its destination silently.
  Show a toast: "Your scheduled task '<name>' moved to its own inbox."

## Phase 5 — Manual test pass (~1h)

1. Ask agent: "Every minute remind me to drink water" — verify clarify
   prompt for destination → pick Inbox → cron created + inbox session
   created + binding inserted.
2. Wait 60s — confirm divider + assistant message appear in inbox without
   reload (live envelope).
3. Force quit + reopen — confirm inbox is in Cron tab, not in Chats list.
4. Open inbox, type "What's the second one?" — confirm follow-up routes
   to the bound Hermes session and gets a contextual reply.
5. Delete cron from Cron tab — confirm inbox session is gone.
6. Repeat with "Output goes to this chat" — confirm cron rows appear
   inline in the user chat with divider style, no inbox created.

## Out of scope

- Migrating existing markdown-file crons to inbox sessions.
- N:1 inbox bindings (one inbox aggregating multiple crons).
- Editing a cron's destination after creation (delete + recreate for v1).
- Long-form cron output beyond chat_history payload size limits — markdown
  output >256KB gets truncated with a note + a link to the original file.

## File touch list (estimated)

| Layer | File | LoC ± |
|---|---|---|
| Backend | `db/migrations/0010_cron_inbox.sql` | +30 (new) |
| Backend | `db/schema.ts` | +20 |
| Backend | `routes/sessions.ts` | +5 (filter) |
| Backend | `routes/cron-inboxes.ts` | +80 (new) |
| Backend | `cron/route-to-session.ts` | +120 (new) |
| Backend | `cron/output-watcher.ts` | +20 (dispatch branch) |
| Backend | `mcp/cron-scheduler.ts` | +180 (new MCP server) |
| Backend | `ws/gateway-ws.ts` | +20 (cron_run flag handling) |
| Frontend | `api/types.ts` | +5 |
| Frontend | `api/cron.ts` | +20 |
| Frontend | `state/chat-store.ts` | +15 (cronRun divider) |
| Frontend | `app/(app)/(chats)/chat/[id].tsx` | +40 (kind branch) |
| Frontend | `app/(app)/(cron)/index.tsx` | +30 (destination chips) |
| Frontend | `components/ui/Message.tsx` | +25 (divider variant) |
| Scripts | `patch-hermes-config.py` | +1 (toolset) |
| Plan | `CRON_INBOX_PLAN.md` | this file |

Total: ~610 LoC across ~16 files. Estimate end-to-end: 11h split across
the five phases.
