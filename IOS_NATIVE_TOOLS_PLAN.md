# iOS Native Tools — Phase-by-Phase Plan

**Status:** Design + plan. Not started. Captured 2026-05-04.

This document plans Option 3 from `IOS_INTEGRATION_OPTIONS.md` (or rather: from the chat conversation on 2026-05-04 — see git log for context). Goal: let the Hermes agent on the VPS read/write iOS-native data (Calendar, Reminders, Notifications, arbitrary Shortcuts) by routing tool calls through the existing mobile-app WS connection to EventKit running on-device.

---

## 1. Goal

Hermes agent says "add reminder to call mom at 4pm" → reminder appears in iOS Reminders app within seconds. Same for Calendar events, local push notifications, and arbitrary Apple Shortcuts.

No CalDAV, no Pushcut, no third-party services. The user's existing mobile app becomes the EventKit broker.

## 2. Architecture

```
┌──────────┐  WS    ┌────────────┐    HTTP   ┌──────────────┐ stdio  ┌──────────┐
│ Mobile   │◄──────►│ Fastify    │◄─────────►│ ios-tools-   │◄──────►│ Hermes   │
│ App      │        │ Gateway    │  internal │ stdio.ts     │  MCP   │ Agent    │
│          │        │            │           │ (MCP server) │        │          │
│ ┌──────┐ │        │ ┌────────┐ │           └──────────────┘        └──────────┘
│ │ios-  │ │        │ │/internal│ │
│ │tools │◄┼────────┼─►/ios-  │ │
│ │native│ │  WS    │ │tool    │ │
│ │module│ │  frame │ └────────┘ │
│ └──┬───┘ │        └────────────┘
│    ▼    │
│ EventKit│   (Calendar / Reminders / UserNotifications / Shortcuts URL)
└──────────┘
```

### Components

| Layer | What it does | Where |
|---|---|---|
| `ios-tools` native module | Wraps `EKEventStore`, `EKReminder`, `UNUserNotificationCenter`, `UIApplication.shared.open(shortcuts://...)`. Handles iOS permission prompts. | `frontend/modules/ios-tools/` (new Expo native module) |
| Mobile WS handler | Receives `ios_tool_call` frames from gateway, dispatches to native module, returns `ios_tool_result`. | `frontend/src/ws/ios-tools-handler.ts` |
| Gateway HTTP endpoint | `POST /internal/ios-tool` — receives MCP server requests, looks up user's active WS, forwards. Auth: shared bearer token. | `backend/src/routes/internal-ios-tools.ts` |
| Gateway WS routing | Maps user_id → active WS connection; sends frames; awaits result with timeout. | Extend `backend/src/ws/gateway-ws.ts` |
| MCP stdio server | Spawned by Hermes per session. Reads MCP frames on stdin, POSTs to gateway, writes results to stdout. | `backend/src/mcp/ios-tools-stdio.ts` |
| Hermes config | Registers `ios-tools` as MCP server, adds `mcp-ios-tools` to `platform_toolsets.cli`. | `scripts/patch-hermes-config.py` |
| Hermes memory seed | MEMORY.md entries: default calendar, default list, offline behavior. | `/root/.hermes/memories/MEMORY.md` |

### Tool surface (initial)

```
ios.calendar.add_event(title, start, end, notes?, calendar?)        → {event_id}
ios.calendar.list_events(start_range, end_range, calendar?)         → [{id, title, start, end, ...}]
ios.calendar.delete_event(event_id)                                 → {ok}
ios.reminders.add(title, due_date?, list?, notes?)                  → {reminder_id}
ios.reminders.list(filter?: pending|completed|all, list?)           → [{id, title, due, ...}]
ios.reminders.complete(reminder_id)                                 → {ok}
ios.notification.send(title, body, fire_at?)                        → {notification_id}
ios.shortcut.run(shortcut_name, input?: string)                     → {result_text?}    # escape hatch
```

`shortcut.run` covers anything not natively wrapped — HomeKit, Music, Focus modes, third-party apps with Shortcuts actions. The user defines Shortcuts on iPhone once, agent invokes by name.

### Auth + identity

- **Single-user mode** for v1. MCP server is bound to a single user via env (`IOS_MCP_USER_ID=<uuid>`). All tool calls route to that user's active mobile WS.
- **Multi-user (future)** would require Hermes session id → gateway user id mapping. Out of scope for v1.
- **MCP ↔ gateway**: shared bearer token (`IOS_MCP_TOKEN` env, generated at install).
- **Gateway ↔ mobile**: existing JWT auth on the WS connection (already in place).
- **Mobile → EventKit**: iOS permission prompts on first call per category (Calendar, Reminders, Notifications, Contacts).

### Availability semantics

The mobile app is not always online. iOS aggressively suspends backgrounded apps. The tools must report their own availability:

- `online` — app is foregrounded, WS connected → tool call executes immediately
- `degraded` — app is backgrounded but WS still alive → tool call queued, executed when foreground (next user-app interaction)
- `offline` — no WS → tool returns `{error: "offline", suggestion: "use push notification with deep link"}`

The agent should learn (via MEMORY.md) to fall back to a push notification deep-link when iOS tools are offline.

---

## 3. Phases

### Phase 0 — Spike + risk vetting (1 day)

**Goal:** confirm the unknowns before committing to the full plan.

Tasks:
- Verify EAS dev build supports custom native modules (it does, but confirm with our exact Expo SDK 55 setup)
- Verify EventKit framework can be linked from an Expo module (it can; `expo-calendar` exists as a precedent — we'll fork its approach)
- Verify Reminders API access works on iOS 17+ (Apple changed authorization in iOS 17; need `EKEventStore.requestFullAccessToReminders(...)`)
- Decide: pure native module vs. fork `expo-calendar` and add Reminders + Shortcuts. The latter saves ~2 days.

Acceptance: a 50-line test app on dev build that prompts Calendar permission and reads back today's events. Proves the path works on user's device.

Files: throwaway `frontend/spike-ios-tools/` — don't commit.

---

### Phase 1 — Native module skeleton (2 days)

**Goal:** working Swift module with permission flow + read-only methods.

Files:
```
frontend/modules/ios-tools/
├── ios/
│   ├── IosToolsModule.swift          # main module class
│   ├── Calendar.swift                # EKEventStore wrapper
│   ├── Reminders.swift               # EKEventStore reminders wrapper
│   ├── Notifications.swift           # UNUserNotificationCenter wrapper
│   └── Shortcuts.swift               # URL-scheme launcher
├── src/IosToolsModule.ts             # JS-side typed exports
├── expo-module.config.json
└── package.json
```

Methods to ship in this phase (read-only first — lower permission risk):
- `requestCalendarPermission()` → `granted | denied | not_determined`
- `requestRemindersPermission()` (iOS 17+ uses `requestFullAccessToReminders`)
- `requestNotificationsPermission()`
- `listCalendars()` → `[{id, title, type}]`
- `listReminderLists()` → `[{id, title}]`
- `listEvents(start, end, calendar_id?)` → `[Event]`
- `listReminders(filter?, list_id?)` → `[Reminder]`

Acceptance: from the chat screen of dev-build app, manually call each method via a hidden debug button, verify results match Calendar/Reminders apps on the same device.

---

### Phase 2 — Native module write methods (1 day)

**Goal:** add the mutation methods.

Methods added:
- `addEvent(title, start, end, calendar_id?, notes?)` → `{event_id}`
- `deleteEvent(event_id)` → `{ok}`
- `addReminder(title, due_date?, list_id?, notes?)` → `{reminder_id}`
- `completeReminder(id)` → `{ok}`
- `sendLocalNotification(title, body, fire_at?)` → `{id}`
- `runShortcut(name, input?)` — opens `shortcuts://run-shortcut?name=X&input=Y` via `UIApplication.shared.open`

Acceptance: same debug screen, can create + delete a calendar event, add + complete a reminder, fire a local notification, run a Shortcut.

---

### Phase 3 — JS bridge + offline queue (1 day)

Files:
```
frontend/src/ios-tools/
├── client.ts            # TypeScript wrapper around the native module
├── types.ts             # tool input/output types (shared with backend)
├── permissions.ts       # cached permission state, prompts on demand
└── queue.ts             # tiny in-memory queue for backgrounded calls
```

Behavior:
- `client.callTool(name, args)` → uniform interface; resolves `{ok, result}` or `{error, code}`
- Permissions are checked + prompted on first call per category; cached after
- If app is backgrounded for `runShortcut` (which requires opening Shortcuts app), bring app to foreground first OR fail with `requires_foreground` error code

Acceptance: unit tests + a manual playground page that exercises every tool through the client.

---

### Phase 4 — Backend WS routing (2 days)

Files:
```
backend/src/ws/gateway-ws.ts                       # extend existing
backend/src/ws/ios-tools-router.ts                 # new — request/response correlator
backend/src/routes/internal-ios-tools.ts           # new — POST /internal/ios-tool
backend/src/types/ios-tools.ts                     # shared types with frontend
```

New WS frame types (gateway ↔ mobile):

```ts
// gateway → mobile
{
  type: "ios_tool_call",
  call_id: "uuid",          // correlation id
  tool: "ios.calendar.add_event",
  args: { ... },
  timeout_ms: 30_000
}

// mobile → gateway
{
  type: "ios_tool_result",
  call_id: "uuid",
  ok: true | false,
  result?: { ... },
  error?: { code, message }
}
```

`ios-tools-router.ts` keeps a `Map<call_id, deferred>` pending call registry. Resolves on `ios_tool_result`, rejects on timeout / WS close.

`POST /internal/ios-tool`:

```ts
// Request from MCP stdio server
{
  user_id: "<uuid>",        // single-user: known constant
  tool: "ios.calendar.add_event",
  args: { ... }
}
// Response
{
  ok: true,
  result: { event_id: "..." }
}
// or
{
  ok: false,
  error: { code: "offline", message: "..." }
}
```

Auth: `Authorization: Bearer ${IOS_MCP_TOKEN}` header, validated against env. Bind only to internal Docker network (in local dev) / `127.0.0.1` (on VPS).

Acceptance: a manual POST to `/internal/ios-tool` with a fake call routes to the active mobile WS, gets a result back, returns it.

---

### Phase 5 — MCP stdio server (2 days)

File: `backend/src/mcp/ios-tools-stdio.ts`

Standalone Node script. Spawned as child process by Hermes per session. Reads MCP JSON-RPC frames on stdin, writes responses on stdout.

Maps each tool name to a `POST /internal/ios-tool` call. Translates errors to MCP error format.

Tool definitions exposed to the MCP client (Hermes):

```jsonc
{
  "tools": [
    {
      "name": "ios.calendar.add_event",
      "description": "Create an event in iCloud Calendar synced to the user's iPhone. Permission is required on first call.",
      "inputSchema": {
        "type": "object",
        "required": ["title", "start", "end"],
        "properties": {
          "title": { "type": "string" },
          "start": { "type": "string", "description": "ISO-8601 timestamp" },
          "end":   { "type": "string", "description": "ISO-8601 timestamp" },
          "notes": { "type": "string" },
          "calendar": { "type": "string", "description": "Calendar name. Defaults to 'Work' (see MEMORY.md)." }
        }
      }
    }
    // ... etc for each tool
  ]
}
```

Built bundle: `backend/dist/src/mcp/ios-tools-stdio.js` — what Hermes spawns.

Acceptance: `node ios-tools-stdio.js` reads `tools/list` MCP frame on stdin, returns the full tool catalog. `tools/call` for `ios.calendar.add_event` does an end-to-end round trip and writes a valid MCP response.

---

### Phase 6 — Hermes config + memory seed (0.5 day)

File: `scripts/patch-hermes-config.py`

Add to `DESIRED_MCP_SERVERS`:

```python
"ios-tools": {
    "command": "node",
    "args": ["/root/repos/Hermes_agent/backend/dist/src/mcp/ios-tools-stdio.js"],
    "env": {
        "GATEWAY_URL": "http://127.0.0.1:8080",
        "IOS_MCP_TOKEN": "",  # populated via .env reference at runtime
        "IOS_MCP_USER_ID": "",  # populated via .env
    },
    "timeout": 30,
    "connect_timeout": 10,
},
```

Add to `DESIRED_PLATFORM_TOOLSETS["cli"]`:

```python
"mcp-ios-tools",
```

Add to `/root/.hermes/memories/MEMORY.md`:

```
§
iOS native tools (Calendar / Reminders / Notifications / Shortcuts) are exposed via the `mcp-ios-tools` toolset. The phone may be offline — if a call returns error code "offline", DO NOT retry. Send a push notification with deep-link instead so the user can perform the action when convenient. Default calendar: "Work" (set in user's iCloud). Default reminder list: "Inbox". For things due today specifically, use list "Today".
§
When asked to schedule, prefer ios.calendar.add_event for time-bound items, ios.reminders.add for tasks. If the user says "remind me at 4pm", that's a reminder with a due_date, not a calendar block. Calendar events are for "block 2-3pm for X" / "schedule meeting with Y on Z".
```

Re-run `patch-hermes-config.py` on local + VPS. Restart `hermes-dashboard` + `hermes-gateway` (token rotation handled by `post-hermes-update.sh`).

Acceptance: `hermes mcp list` (or our reload-mcp button) shows `ios-tools` registered with N tools.

---

### Phase 7 — Integration test + docs (1 day)

Test scenarios:

1. **Happy path.** Chat: "Add a reminder to call mom at 4pm today." → agent calls `ios.reminders.add(title="call mom", due_date="2026-05-04T16:00:00+05:30")` → reminder appears in iOS Reminders Inbox list.

2. **Permission prompt (first call).** Fresh install: chat: "Add event tomorrow 2-3pm: dentist." → mobile app prompts "Allow Hermes to access Calendar?" → user grants → event created in default calendar.

3. **Offline.** Mobile app force-quit, phone in airplane mode. Chat from another device: "Add reminder buy milk." → MCP returns `offline` error → agent says "Phone offline; sending push deep-link" and falls back.

4. **Cron.** Cron `0 7 * * *`: "Block my calendar from 9-9:30am for daily review." → fires daily, calendar gets the event.

5. **Shortcut escape hatch.** User has a Shortcut "Set Focus Work". Chat: "Set my focus to work mode." → agent calls `ios.shortcut.run(name="Set Focus Work")` → iOS Shortcuts opens, runs.

6. **Read-back.** Chat: "What's on my calendar tomorrow?" → agent calls `ios.calendar.list_events(...)` → renders.

Files:
```
IOS_TOOLS.md                            # user-facing setup guide
DEPLOYMENT.md                           # add to "One-shot scripts" + secrets section
OBSIDIAN.md                             # cross-link from "Maxing out the integration"
```

Doc covers:
- Setup: env vars (`IOS_MCP_TOKEN`, `IOS_MCP_USER_ID`), permissions, EAS build requirement
- Tool reference (one-liner per tool with example agent prompt)
- Troubleshooting (permission denied, offline, no Shortcuts found, etc.)

---

### Phase 8 — Deploy + ship (0.5 day)

1. Bump backend version, push branch, merge → main
2. EAS build of mobile app (production profile) → distribute via TestFlight (one user means it's basically self-internal)
3. SSH VPS: `git pull && cd backend && pnpm build && systemctl restart hermes-gateway`
4. Run `patch-hermes-config.py` + `post-hermes-update.sh` to wire the MCP server
5. Open mobile app → grant permissions when prompted by first agent action
6. Smoke-test the 6 scenarios from Phase 7

---

## 4. Total time estimate

| Phase | Days |
|---|---|
| 0 — Spike | 1 |
| 1 — Native module read | 2 |
| 2 — Native module write | 1 |
| 3 — JS bridge | 1 |
| 4 — Backend WS routing | 2 |
| 5 — MCP stdio server | 2 |
| 6 — Hermes config + memory | 0.5 |
| 7 — Integration tests + docs | 1 |
| 8 — Deploy | 0.5 |
| **Total** | **~11 days** |

Realistic with focus, single-developer. Add 50% buffer for surprises (iOS permission API changes, Expo SDK quirks, EAS build issues) → **~16 calendar days** end-to-end.

---

## 5. Risks + open questions

### High-risk

1. **iOS 17 Reminders authorization model.** Apple changed the API; needs `requestFullAccessToReminders` not the old `requestAccess(.reminder)`. Verify in Phase 0 spike.
2. **EventKit + Expo native module compatibility.** `expo-calendar` exists as precedent for Calendar; nothing official for Reminders yet. May need to write Reminders code from scratch or fork `expo-calendar`. Confirm in Phase 0.
3. **Background WS reliability.** iOS aggressively suspends backgrounded apps. Even with VOIP/silent push tricks, there's no SLA. Phase 4 must handle WS disconnect gracefully and tools must report `offline`.

### Medium-risk

4. **Multi-user.** v1 is single-user. If the project ever grows, MCP server must learn about session→user routing. Build the env-binding so it's easy to swap later.
5. **Token rotation.** `IOS_MCP_TOKEN` is shared between gateway and MCP server. If gateway restarts and token rotates, MCP server needs to re-read env. Restart MCP servers on token change (or just bake into snapshot/.env).
6. **Shortcuts URL scheme deprecation.** Apple has soft-deprecated some `shortcuts://` flows. Check current iOS support before committing to `ios.shortcut.run` design.

### Low-risk / nice-to-have

7. **Read latency for `list_events` over WS.** Probably fine for <100 events; profile if needed.
8. **Notification IDs.** Local notifications need stable IDs for cancel/update. Decide on UUID vs. content hash.
9. **Calendar sync delay.** EventKit writes are local; iCloud Calendar may take 0–30s to propagate to Watch/Mac. Tools return immediately; let cloud sync settle on its own.
10. **Tools that need both EventKit + UI** (e.g., editing an event in the Calendar UI). Out of scope for v1 — we don't open native UIs from agent calls.

### Open questions for the user (revisit before starting)

- **Q1**: Are you comfortable with EAS dev builds becoming the dev workflow (vs. Expo Go)? Native modules can't run in Expo Go.
- **Q2**: How aggressive should the offline fallback be? Always send push notification when offline, or fail quietly if the agent can retry later via cron?
- **Q3**: Cron jobs on VPS hitting iOS tools while phone is asleep — how should that work? Skip silently? Queue for next foreground? Use APNs voip-style wakeup?
- **Q4**: For `ios.shortcut.run`, do you want to predefine a whitelist of shortcuts (safer) or allow agent to invoke any (more flexible)?

---

## 6. Implementation sketches (for Phase 4-5 — the gateway-side work)

### Gateway WS routing (`ios-tools-router.ts`)

```ts
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

type Pending = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

export class IosToolsRouter {
  private pending = new Map<string, Pending>();

  // Track active WS per user. (Single-user: just one entry.)
  private activeWs = new Map<string, WebSocket>();

  registerWs(userId: string, ws: WebSocket): void {
    this.activeWs.set(userId, ws);
    ws.on("close", () => {
      if (this.activeWs.get(userId) === ws) this.activeWs.delete(userId);
    });
  }

  // Called by /internal/ios-tool route.
  async call(userId: string, tool: string, args: unknown, timeoutMs = 30_000): Promise<unknown> {
    const ws = this.activeWs.get(userId);
    if (!ws || ws.readyState !== ws.OPEN) {
      throw new IosToolError("offline", "no active mobile session");
    }
    const callId = randomUUID();
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(callId);
        reject(new IosToolError("timeout", `tool ${tool} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(callId, { resolve, reject, timeout });
    });
    ws.send(JSON.stringify({
      type: "ios_tool_call",
      call_id: callId,
      tool,
      args,
      timeout_ms: timeoutMs,
    }));
    return promise;
  }

  // Called when WS receives a frame.
  onResult(frame: { call_id: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }): void {
    const pending = this.pending.get(frame.call_id);
    if (!pending) return;  // late or duplicate
    clearTimeout(pending.timeout);
    this.pending.delete(frame.call_id);
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new IosToolError(frame.error?.code ?? "unknown", frame.error?.message ?? ""));
  }
}

class IosToolError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
```

### MCP stdio server (`ios-tools-stdio.ts`)

```ts
import * as readline from "node:readline";

const GATEWAY_URL = process.env.GATEWAY_URL!;
const IOS_MCP_TOKEN = process.env.IOS_MCP_TOKEN!;
const IOS_MCP_USER_ID = process.env.IOS_MCP_USER_ID!;

const TOOLS = [/* the JSON tool catalog from Phase 5 above */];

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }

  if (frame.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: frame.id,
      result: { tools: TOOLS },
    }) + "\n");
    return;
  }

  if (frame.method === "tools/call") {
    const { name, arguments: args } = frame.params;
    try {
      const res = await fetch(`${GATEWAY_URL}/internal/ios-tool`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${IOS_MCP_TOKEN}`,
        },
        body: JSON.stringify({ user_id: IOS_MCP_USER_ID, tool: name, args }),
      });
      const body = await res.json();
      if (body.ok) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: { content: [{ type: "text", text: JSON.stringify(body.result) }] },
        }) + "\n");
      } else {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32000, message: body.error?.message ?? "tool failed" },
        }) + "\n");
      }
    } catch (err) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: -32603, message: String(err) },
      }) + "\n");
    }
  }
});
```

(Real implementation should use `@modelcontextprotocol/sdk` rather than rolling its own JSON-RPC framing, but the shape is the same.)

---

## 7. References

- [Apple — EventKit framework docs](https://developer.apple.com/documentation/eventkit)
- [Apple — Reminders API authorization changes (iOS 17)](https://developer.apple.com/documentation/eventkit/accessing_the_event_store)
- [Apple — UserNotifications framework](https://developer.apple.com/documentation/usernotifications)
- [Apple — Running shortcuts via URL schemes](https://support.apple.com/guide/shortcuts/run-shortcuts-from-the-share-sheet-apd163eb9f95/ios)
- [Expo — Native modules guide](https://docs.expo.dev/modules/overview/)
- [`expo-calendar` source](https://github.com/expo/expo/tree/main/packages/expo-calendar) — precedent for EventKit access from Expo
- [Anthropic — Model Context Protocol](https://modelcontextprotocol.io/)
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
- Internal: `CRON_OUTPUT_TO_CHAT_DESIGN.md` — sibling design doc for cron→chat that uses similar gateway-as-broker pattern
- Internal: `OBSIDIAN.md` — the Obsidian skill is the precedent for "register a tool surface in `platform_toolsets.cli`, seed memory entries"
- Internal: `scripts/patch-hermes-config.py` — pattern for declarative MCP server registration

---

## 8. When to revisit

Re-read this doc before starting **Phase 0**. The iOS landscape moves — `expo-calendar`'s API may have changed, Apple's permission model may have evolved, MCP SDK may have a new version. Do the spike. Update assumptions. Then proceed.
