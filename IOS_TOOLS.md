# iOS Native Tools

Hermes agent reads + writes native iOS Calendar, Reminders, Notifications, and arbitrary Apple Shortcuts via the user's mobile app. The phone is the EventKit broker — no CalDAV, no third-party services.

> Implementation status — committed but not yet deployed to production. See `IOS_NATIVE_TOOLS_PLAN.md` for the design + phased rollout. Phase 8 (deploy) is the last step.

## At a glance

```
[Hermes agent]──MCP──[ios-tools-stdio]──HTTP──[Fastify gateway]──WS──[Mobile app]──EventKit──[iOS Calendar / Reminders / Notifications / Shortcuts]
```

Every tool the agent invokes from `mcp-ios-tools` round-trips through this chain. When the phone is offline, the gateway tries a silent APNs push to wake the app; if that fails, it queues server-side and replays on next reconnect.

## Tool catalog

All tools accept JSON args matching the schemas registered with Hermes' MCP. Snake_case + ISO-8601 on the agent side; the MCP shim translates to camelCase + epoch milliseconds for the native module.

| Tool | Purpose | Required args | Optional args |
|---|---|---|---|
| `ios.calendar.add_event` | Create iCloud Calendar event | `title`, `start`, `end` (ISO-8601) | `notes`, `calendar_id`, `all_day` |
| `ios.calendar.list_events` | Read events in a window | `start_range`, `end_range` (ISO-8601) | `calendar_ids[]` |
| `ios.calendar.delete_event` | Delete an event | `event_id` | — |
| `ios.reminders.add` | Create a Reminder | `title` | `due_date` (ISO-8601), `list_id`, `notes` |
| `ios.reminders.list` | Read reminders | — | `filter` (`pending|completed|all`), `list_ids[]` |
| `ios.reminders.complete` | Mark reminder done | `reminder_id` | — |
| `ios.notification.send` | Schedule a local push | `title`, `body` | `fire_at` (ISO-8601) |
| `ios.shortcut.run` | Invoke any Shortcut by name | `name` | `input` (string) |

Result formats:

- Add tools (`add_event`, `add_reminder`) return `{ id }`
- Delete / complete return `{ ok: true }`
- List tools return arrays with timestamps formatted back to ISO-8601
- Notification returns `{ id }` (notification request id)
- `shortcut.run` returns `{ ok: true }` — caveat: this means "URL launched", not "shortcut completed"; there's no public iOS API to confirm completion

## Error codes

The agent sees these error codes verbatim. Behavior the agent should follow is seeded in `~/.hermes/memories/MEMORY.md` (Phase 8 deploy step):

| Code | Meaning | Agent should |
|---|---|---|
| `offline` | Phone unreachable, silent push failed, queue full | Note in chat, do NOT retry |
| `queued` | Phone unreachable, but call persisted — will fire on reconnect | Treat as success-eventually |
| `timeout` | WS open but native call didn't finish in `timeout_ms` | Note in chat; user can retry |
| `permission_denied` | iOS permission was denied for the relevant category | Tell the user to grant permission in iOS Settings |
| `unknown` | Catch-all (notFound, unsupported, native exception) | Surface the message to the user |

## Setup (per-environment)

### Local docker

```bash
# 1. Set env in backend/.env (gitignored):
echo "IOS_MCP_TOKEN=$(openssl rand -hex 32)" >> backend/.env
echo "IOS_MCP_USER_ID=<your-user-id-from-bootstrap>" >> backend/.env

# 2. Build gateway + recreate
cd backend && pnpm build && cd ..
docker compose up -d --force-recreate gateway

# 3. Patch hermes config + restart
./scripts/patch-hermes-config.py
docker compose up -d --force-recreate hermes hermes-cron

# 4. EAS dev build of mobile app (rebuild required because of new native module)
cd frontend && eas build --profile development --platform ios --local
# install the resulting .ipa via Xcode or TestFlight
```

### VPS (production)

```bash
# 1. Pull repo updates
ssh root@<vps>
cd /root/repos/Hermes_agent && git pull

# 2. Add to /root/.hermes/.env:
cat >> /root/.hermes/.env <<EOF
IOS_MCP_TOKEN=$(openssl rand -hex 32)
IOS_MCP_USER_ID=<your-user-id-from-gateway-DB>
EOF

# 3. Add same IOS_MCP_TOKEN to backend/.env
echo "IOS_MCP_TOKEN=<paste same value>" >> /root/repos/Hermes_agent/backend/.env

# 4. Re-build gateway + restart everything (handles dashboard token rotation)
cd /root/repos/Hermes_agent/backend && pnpm build && cd /root/repos/Hermes_agent
sudo bash scripts/post-hermes-update.sh   # runs patch-hermes-config + restarts in order

# 5. Seed MEMORY.md (one-time)
cat >> /root/.hermes/memories/MEMORY.md <<'EOF'
§
iOS native tools (Calendar / Reminders / Notifications / Shortcuts) are exposed via the `mcp-ios-tools` toolset. The phone may be offline.
- Error code "offline": DO NOT retry. Note in chat that the action couldn't complete; user can re-ask later. Do not fall back to push notifications.
- Error code "queued": treat as success-eventually — the call persisted server-side and will fire when the phone reconnects.
- Default calendar: "Work" (in user's iCloud). Default reminder list: "Inbox". For things due today specifically, use list "Today".
§
When asked to schedule, prefer ios.calendar.add_event for time-bound items, ios.reminders.add for tasks. If the user says "remind me at 4pm", that's a reminder with a due_date, not a calendar block. Calendar events are for "block 2-3pm for X" / "schedule meeting with Y on Z".
§
ios.shortcut.run can invoke ANY shortcut on the user's phone. The user has explicitly opted into this — no whitelist. Be conservative: only invoke a shortcut if the name clearly matches the user's intent. If unsure, list shortcut names back and ask which one. Never invent shortcut names.
EOF

# 6. EAS production build of mobile app (when ready):
#    cd frontend && eas build --profile production --platform ios
#    Distribute via TestFlight and install on phone.
```

## How to find your `IOS_MCP_USER_ID`

Single-user mode binds the MCP server to one user UUID. Find it:

```bash
# Local
docker compose exec gateway sqlite3 /app/data/gateway.db "SELECT id, username FROM users;"

# VPS
sqlite3 /root/repos/Hermes_agent/backend/data/gateway.db "SELECT id, username FROM users;"
```

Use the `id` for your username (typically `darshan`). Multi-user is out of scope for v1.

## Permissions on first run

iOS prompts for permissions per category, on first call. Each prompt is one-time per app install:

- Calendar — first call to any `ios.calendar.*` tool
- Reminders — first call to any `ios.reminders.*` tool
- Notifications — first call to `ios.notification.send`
- Shortcuts — no prompt (URL scheme), but the Shortcuts app must be installed and the named shortcut must exist

Apple requires usage-description strings in `Info.plist` (already added to `app.json`):

- `NSCalendarsFullAccessUsageDescription` (iOS 17+)
- `NSCalendarsUsageDescription` (iOS 16 fallback)
- `NSRemindersFullAccessUsageDescription` (iOS 17+)
- `NSRemindersUsageDescription` (iOS 16 fallback)

iOS 17 introduced "Full Access" vs "Write Only" for both Calendar and Reminders. The native module always requests Full Access (we need both read and write). If the user picks Write Only at the prompt, the module treats it as denied because list/read tools won't work.

## Integration test checklist

Run all six on a real device after Phase 8 deploys:

| # | Scenario | Expected |
|---|---|---|
| 1 | Happy path | "Add reminder buy milk at 4pm" → reminder appears in Reminders Inbox at 4pm today |
| 2 | First-time permission | Fresh install + first calendar request → iOS prompt → grant → event created |
| 3 | Offline | Force-quit app, airplane mode → "add reminder X" from Hermes web/another device → MCP returns `offline` → agent says "couldn't add, phone offline" |
| 4 | Cron + asleep | `0 7 * * *` "block 9-9:30 daily review" → fires at 7am UTC, silent push wakes phone, event created. Verify on iPhone Calendar within 30s. |
| 5 | Shortcut escape hatch | User has Shortcut "Set Focus Work" → "Set my focus to work" → Shortcuts app opens, runs |
| 6 | Read-back | "What's on my calendar tomorrow?" → list of events with ISO timestamps |

## Known limitations (v1)

1. **Handler lives on per-chat WS, not app-root WS.** Tools only work while a chat screen is mounted. Phase 8 to add an always-on presence WS at the app root so tools work even when the user is on the cron tab or settings.

2. **Single-user.** `IOS_MCP_USER_ID` is a hardcoded env var. Multi-user mode would need session-id → user-id mapping in the MCP server.

3. **`shortcut.run` returns `ok` on URL launch, not on shortcut completion.** No public iOS API to confirm. If the agent needs the shortcut's output, the shortcut itself must write to a file Hermes can read (e.g., write to vault).

4. **Silent push budget.** iOS rate-limits silent pushes (~3/hour sustained). Bursty cron loops may exceed and queue instead of waking. Fine for typical use.

5. **Apple ID for App Store distribution.** Free dev provisioning works for personal use. If shipping via TestFlight/App Store, the `NSReminders*UsageDescription` strings will be reviewed.

## Architecture references

- `IOS_NATIVE_TOOLS_PLAN.md` — full design, 8-phase rollout, time estimates
- `frontend/modules/ios-tools/` — Expo native module (Swift + TS)
- `frontend/src/ios-tools/` — JS handler, permissions cache, client wrapper
- `backend/src/ios-tools/` — server-side queue + silent push
- `backend/src/ws/ios-tools-router.ts` — WS request/response correlator
- `backend/src/routes/internal-ios-tools.ts` — `POST /internal/ios-tool`
- `backend/src/mcp/ios-tools-stdio.ts` — MCP stdio server (Hermes spawns this)
- `scripts/patch-hermes-config.py` — registers MCP server in Hermes config
- `CRON_OUTPUT_TO_CHAT_DESIGN.md` — sibling design doc with the same gateway-as-broker pattern
