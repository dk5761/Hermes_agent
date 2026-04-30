# Hermes Mobile App — screen inventory

Reference for what every screen in the app should contain. Marks status:
- ✅ shipped
- 🟡 partial — exists but missing parts
- ⬜ not built yet

---

## 0. App shell

### Root layout (`app/_layout.tsx`) ✅
- QueryClientProvider (TanStack Query)
- AuthGate (hydrates SecureStore tokens before rendering)
- StatusBar (dark)
- Notification listeners (foreground + tap)
- Push token registration after auth

### Auth group (`app/(auth)/_layout.tsx`) ✅
- Redirect to `/(app)` if already authed

### App group (`app/(app)/_layout.tsx`) ✅
- Redirect to `/login` if not authed
- Stack navigator with title bars
- Should evolve into drawer + nested stack so cron/settings have their own stacks. Currently single stack with all screens at the same level.

---

## 1. Auth

### Login (`/login`) ✅
- Username field
- Password field (secure)
- Submit button
- Error banner on 401
- "Connecting to: <gateway URL>" footer (debug aid)
- 🟡 missing: biometric unlock toggle (deferred)

---

## 2. Sessions & Chat

### Session list (`/(app)`) ✅
- FlatList of sessions ordered by `updatedAt` desc
- Each row: title, preview snippet, relative time
- Tap → chat
- Long-press → action sheet: rename / archive / delete
- "+" FAB → create + navigate to new chat
- Pull-to-refresh
- Empty state: "no chats yet — tap + to start"
- 🟡 missing: search bar at top, archived-toggle filter

### Chat (`/chat/[id]`) ✅
- Inverted FlatList of message rows
- Bubble types: user, assistant, tool card, reasoning block (collapsible), approval card, error
- Composer at bottom: "+" attachment button, text input, send/stop button
- Connection status banner (connecting / online / reconnecting / sync_required)
- Inline thumbnails for image attachments in user bubbles
- PDF rows in user bubbles
- Approval / clarify / sudo / secret cards inline with response inputs
- 🟡 missing: scroll-to-bottom indicator, message timestamps on tap, copy-message gesture, retry-failed-send

### Session search (`/search`) ⬜
- Text input with debounced query
- Results list grouped by session, with snippet + match highlighting
- Tap result → opens that chat scrolled to the matched message
- Keyboard shortcuts on iPad / hardware keyboard
- Backed by `GET /sessions/search?q=`

---

## 3. Cron

### Cron list (`/cron`) ✅
- FlatList of all jobs
- Each row: name, schedule_display, last_run_at (relative), enabled badge, state (paused?)
- Inline notify-on-complete toggle (per-row switch)
- Tap → job detail
- Pull-to-refresh
- "+" FAB → new job (⬜)
- 🟡 missing: filter by enabled/paused, sort options

### Cron job detail (`/cron/[jobId]`) ✅
- Job summary card: prompt (collapsible), schedule, model, deliver target, state, next_run_at
- Action buttons: pause/resume, run-now (trigger), edit (⬜), delete
- "Notify me on completion" toggle (writes via `PUT /cron/jobs/:id/notify-prefs`)
- Outputs list: scrollable, each row shows timestamp + first-line preview
- Pull-to-refresh
- 🟡 missing: edit screen, last-status pill, error-history view

### Cron output (`/cron/[jobId]/output/[outputId]`) ✅
- Top bar: timestamp + "Open job" link
- Markdown rendering of the output content
- 🟡 missing: copy-to-clipboard, share sheet, raw-source toggle

### New/Edit cron job (`/cron/new`, `/cron/[jobId]/edit`) ⬜
- Name input
- Prompt textarea (multi-line)
- Schedule picker — cron expression input + helper presets ("every hour", "weekdays 9am", "once a day")
- Schedule preview ("next 3 runs: …")
- Model override picker (auto = inherit current main)
- Toolsets to enable (multi-select)
- Delivery target dropdown (origin / local / telegram / etc. — read from Hermes capabilities)
- Repeat count (optional)
- Workdir path (advanced)
- Save → POST /cron/jobs or PUT /cron/jobs/:id
- Validation errors inline
- Backed by `POST/PUT /cron/jobs`

---

## 4. Settings

### Settings index (`/settings`) ✅ (basic)
- Signed-in-as row (username)
- Server URLs (api + ws, monospace)
- Version
- Link rows to sub-screens:
  - Account & security ⬜
  - Models ⬜ (main + aux)
  - Vision (auxiliary model) ✅
  - Other auxiliary models ⬜
  - Provider API keys ⬜
  - Tools & toolsets ⬜
  - Skills ⬜
  - Notifications ⬜
  - Storage ⬜
  - Logs & diagnostics ⬜
  - About ⬜
- Logout button at bottom

### Account & security (`/settings/account`) ⬜
- Username (read-only)
- Change password (form: current → new → confirm)
- Active sessions / refresh tokens list with "revoke" buttons (one row per device)
- Biometric unlock toggle (deferred to later phase)
- Sign out everywhere button

### Main model picker (`/settings/model`) ⬜
- Current model card with capabilities (vision/tools/reasoning/context window)
- Provider list (same source as vision picker — derived from `models_dev_cache.json`)
- Per-provider model list, scrollable
- Tap → confirm sheet → save (writes `model.provider` + `model.name` via `PUT /api/config`)
- Search box at top to filter across all providers
- Filter chips: vision-capable / tool-calling / reasoning
- Backed by Hermes `/api/config` (full read/write)

### Vision aux model (`/settings/vision`) ✅
- Provider radio list (auto + custom + nous + codex always on top, then dynamic from models.dev)
- Model text input + chip suggestions (live from models.dev)
- Base URL field (only for `custom`)
- API key field (secure, with placeholder explaining env-var fallback)
- Save → PUT `/settings/vision`
- Status: "Currently overriding with X" or "Using auto chain"
- 🟡 could add: "Test with sample image" button

### Other auxiliary models (`/settings/aux`) ⬜
- Same UX pattern as vision, repeated for:
  - **Web extract** — `auxiliary.web_extract` — used by browser/scraping tools
  - **Compression** — `auxiliary.compression` — used to compact long contexts
  - **Session search** — `auxiliary.session_search` — used to summarize FTS5 hits across past chats
  - **Skills hub** — `auxiliary.skills_hub` — model that classifies which skill to load
  - **Approval** — `auxiliary.approval` — model that pre-judges destructive commands
- Each section collapsible. All defaults to `auto` so users only touch the ones they care about.

### Provider API keys (`/settings/keys`) ⬜
- List of all known providers with their `envKey` from models.dev
- Show whether each key is set on Hermes (read from `/api/env`)
- Tap row → modal with secure input
- Save updates Hermes' `~/.hermes/.env` via `PUT /api/env`
- Reveal button (gated by re-entering JWT password)
- "Test" button per provider hits a tiny health endpoint
- Backed by Hermes `/api/env` + `/api/env/reveal`

### Tools & toolsets (`/settings/tools`) ⬜
- List of toolsets (code, research, ops, web, voice, …) with descriptions
- Per-toolset: enabled / available / configured indicators
- Drill-in to see individual tools per toolset
- Toggle to enable/disable toolset for the active session or globally
- Configuration hints inline (e.g. "needs GITHUB_TOKEN")
- Backed by `GET /tools/toolsets`

### Skills browser (`/settings/skills`) ⬜
- Searchable list of skills (built-in + auto-generated)
- Each skill row: name, description, source (built-in / auto-saved / user)
- Tap → markdown view of the skill content
- Toggle enabled/disabled
- "Open in chat" — drops `/<skill-name>` into the composer
- Edit (advanced) — sends user to web dashboard since editing a skill is rich
- Backed by `GET /skills`

### Notifications (`/settings/notifications`) ⬜
- Permission status: allowed / denied / undetermined + button to open OS settings
- Push token shown (last 8 chars, with "rotate" action)
- Per-feature toggles:
  - Cron completion notifications (master switch)
  - Approval-request notifications (when Hermes is blocked waiting on you)
  - Tool-completion notifications (long-running tools)
- Quiet hours window (start/end time picker)
- Test push button → server sends a self-ping
- Backed by `POST /devices/push-token`, plus per-job toggles already on cron rows

### Storage (`/settings/storage`) ⬜
- Two tabs: **App cache** (on-device) and **Server storage** (gateway)
- App cache:
  - Disk used by thumbnails (sum of `${cacheDirectory}/thumbs/`)
  - "Clear thumbnail cache" button
  - Disk used by attachments
  - Token hint
- Server storage:
  - Total blob bytes (from gateway)
  - Per-kind breakdown: images / pdfs / derived
  - Last cleanup sweep summary (`/health/detailed` data)
  - "Run cleanup now" button (admin)
  - Storage provider (local / s3) badge
- Backed by gateway `/health/detailed` + a new `/storage/usage` endpoint (TODO)

### Logs & diagnostics (`/settings/diagnostics`) ⬜
- Tabs: **Gateway** (gateway logs) / **Hermes** (Hermes logs)
- Hermes tab uses `GET /logs?file=agent&lines=200`
- File picker: agent / errors / mcp / cron / web (Hermes log files)
- Search filter
- Tail mode (auto-refresh every 5s)
- Copy-to-clipboard button
- Plus health summary card at top: hermes reachable / ws upstream / cleanup status — straight from `/health/detailed`

### Analytics (`/settings/usage`) ⬜
- Time-range chip: 7d / 30d / 90d
- Total spend
- Per-day token + cost line chart (input / output / cache stacked)
- Per-model breakdown bar
- Top-cost sessions list
- Backed by `GET /analytics/usage?days=`

### About (`/settings/about`) ⬜
- App version, build number, commit SHA
- Hermes version (read from `/api/status`)
- Gateway version (read from `/health`)
- Open-source acknowledgements
- Privacy policy / TOS links (TestFlight will require these eventually)
- Reset onboarding button (re-runs the wizard)

### Danger zone (collapsed at the bottom of settings) ⬜
- Reset gateway DB (sign-out everywhere on this gateway, wipes app_sessions)
- Reset Hermes session list (calls bulk-delete via `/api/sessions`)
- Factory reset device (clears all SecureStore + AsyncStorage + cache)
- All actions require re-entering password

---

## 5. Modals & overlays

### Image lightbox ⬜
- Triggered by tapping an image bubble
- Pinch-to-zoom, swipe-to-dismiss
- "Save to camera roll" / "Share" actions

### Tool call detail ⬜
- Triggered by tapping a tool card
- Full args (JSON) collapsible
- Full output collapsible
- Inline diff renderer for file edits
- Duration + status

### Approval modal (full-screen variant) ⬜
- For destructive commands when the inline card isn't enough
- Shows the command, a diff preview if file edit, "approve once" / "approve all in session" / "deny" buttons
- Optional reason input
- Used when push notification taps an active approval

### Composer attachment menu ✅
- iOS: ActionSheetIOS
- Android: Alert with options
- Photo library / Document picker entries
- 🟡 missing: camera capture entry

### Session-list rename modal ⬜
- Currently uses `Alert.prompt` (iOS-only)
- Replace with a proper modal screen for cross-platform parity

---

## 6. Onboarding (first run) ⬜

Sequence shown only when `users` table has been bootstrapped but the app has never seen this device:

### Welcome ⬜
- Logo, one-line value prop ("Talk to your Hermes agent from anywhere")
- "Continue" button

### Server connection check ⬜
- Auto-pings `${API_URL}/health` and shows green/red
- "Test connection" button if red
- Edit-URL modal for changing `EXPO_PUBLIC_API_URL` (in dev only — prod ships baked-in)

### Sign in ⬜
- Same as login screen but framed as "first sign in"

### Notification permission ⬜
- Explainer ("we'll ping you when cron jobs finish")
- "Enable" button → `Notifications.requestPermissionsAsync()`
- Skip-for-now option

### Pick model (optional) ⬜
- Quick model picker if Hermes still has the default model
- "Use existing" / "Pick later" options

### Done ⬜
- "You're set up" + button to start a chat

---

## 7. Background / OS integrations (mostly invisible)

### Push notification handler ✅
- Foreground: invalidates affected query, optional in-app banner
- Tap (cold start or warm): routes to `/cron/[jobId]/output/[outputId]` based on payload `data.type`

### Deep links ⬜
- `hermesapp://chat/<id>` → open chat
- `hermesapp://cron/<jobId>` → open job detail
- `hermesapp://settings/vision` → open vision settings
- Used by Siri Shortcuts, web pages, etc.

### Share extension ⬜
- iOS share sheet → "Send to Hermes"
- Accepts text + images
- Drops them into a session picker, then chat composer

### Voice input ⬜
- Long-press the send button → record
- Hits Hermes' voice transcription
- Shows live transcript

### Spotlight / Quick actions ⬜
- iOS: "New chat" / "Continue last chat" home-screen shortcuts
- Android: app shortcuts

---

## 8. Status snapshot

| Area | Shipped | Partial | Missing |
|---|---:|---:|---:|
| Auth | 1 | 0 | 1 (biometric) |
| Sessions / chat | 2 | 0 | 1 (search) |
| Cron | 3 | 0 | 2 (new/edit, error history) |
| Settings | 2 | 1 | 11 |
| Modals | 1 | 0 | 4 |
| Onboarding | 0 | 0 | 5 |
| OS integrations | 1 | 0 | 4 |
| **Totals** | **10** | **1** | **28** |

10 screens shipped covers the MVP loop (login → chat → cron → notifications). The 28 missing screens are mostly settings depth, onboarding polish, and OS-level integrations — none are blockers for daily use.

## Suggested build order if you want to keep going

1. **Sessions search** — small, very high utility, single-query implementation.
2. **Main model picker** — biggest user-facing knob; reuse the vision settings UX.
3. **Provider API keys** — unlocks all the other aux model screens (no point picking a model you don't have a key for).
4. **Notifications screen** — push UX hygiene; surface the per-job toggles in one place.
5. **Other aux models** — copy the vision screen N times.
6. **Image lightbox** — small but huge UX win.
7. **New/Edit cron job** — completes the cron loop end-to-end.
8. **Onboarding sequence** — last because it shapes around what already works.

Everything past step 8 is polish.
