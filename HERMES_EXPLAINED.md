# Hermes Agent — what it is, what it does, how we use it

A from-scratch explanation aimed at someone who has never seen Hermes before. Read it once, you'll understand the whole system.

---

## Part 1 — What is Hermes?

Hermes is an **AI agent** built by Nous Research. "Agent" = a long-running program that talks to a large language model in a loop, with the ability to use tools (run shell commands, write files, browse the web, search its memory, etc.) until a task is done.

In one sentence: **Hermes is your personal AI assistant as a long-running daemon, not a chatbot tab.**

If you've used Claude Code or Cursor's agent mode or Aider, Hermes is in that family — but designed to live on a server you own and stay running 24/7, not on your laptop tied to your editor session.

### Why Hermes specifically (vs ChatGPT, Claude.ai, Cursor)

Five things make Hermes different:

1. **Lives on a server, not your laptop.** Install on a $5 VPS or a Modal/Daytona serverless box. Runs forever. You talk to it from your phone, terminal, or chat apps — same brain across surfaces.

2. **Provider-agnostic.** Bring your own model. Pick from OpenRouter (200+ models), Anthropic, OpenAI, Nous Portal, Xiaomi MiMo, MoonShot Kimi, MiniMax, NVIDIA NIM, GLM/z.ai, HuggingFace, or your own endpoint. Switch with one command. No vendor lock-in.

3. **Closed learning loop.** Hermes builds memory of you across sessions: who you are, what you work on, what your preferences are. It also creates **skills** — small reusable procedures it learned from doing tasks. Next time a similar task comes up, the skill kicks in. ("Last time I refactored this codebase, I checked X first.")

4. **Multiple front-ends share state.** Hermes has a TUI (terminal UI), a web dashboard, a messaging gateway (Telegram, Discord, Slack, WhatsApp, Signal, Email), and an MCP server (so Claude Code / Cursor can use it as a tool). All of them share the same session history, memory, and cron jobs because the brain is one process per box.

5. **Cron + autonomous tasks.** You can schedule the agent: "Every weekday at 7am, summarize my unread emails and DM me on Telegram." It runs unattended.

### What it actually does

Roughly the surface area:

| Feature | What it means |
|---|---|
| Chat | Real conversation with a model, with the agent running tools as needed |
| Tools | 40+ built-in: shell, file edit, web fetch, web search, git ops, image gen, voice, calendar, memory search, etc. |
| Toolsets | Tools grouped (e.g. "code", "research", "ops"); enable per session |
| Skills | Procedural memory the agent writes for itself; auto-invoked or `/skill-name` |
| Memory | Persistent facts about you (Honcho-based dialectic user model) |
| Session search | FTS5 + LLM summarization across all your past conversations |
| Cron | Native scheduler — `hermes cron add "every monday 9am" "morning brief"` |
| Subagents | Spawn isolated child agents for parallel work |
| Terminal backends | Run shell commands locally, in Docker, over SSH, in Daytona/Singularity/Modal |
| Multi-platform delivery | Same agent talks to you via Telegram + Discord + email simultaneously |
| Voice | Voice memo transcription + TTS responses on supported platforms |
| Approvals / sudo | Asks before running destructive commands; you can require sudo for sensitive ops |
| MCP server | Exposes its own tools to other MCP clients (Claude Code, Cursor) |

---

## Part 2 — Hermes architecture

Hermes is **one Python codebase** that exposes multiple entry points. They all share one data root.

### Data root: `~/.hermes/`

Everything Hermes knows lives here:

```
~/.hermes/
├── config.yaml              # active model, provider, toolsets, personality, etc.
├── .env                     # API keys for providers (OPENROUTER_API_KEY, etc.)
├── state.db                 # SQLite — all sessions, messages, costs, FTS5 index
├── memory.db                # SQLite — Honcho user-modeling facts
├── cron/
│   ├── jobs.json            # scheduled jobs (cron expressions + prompts)
│   └── output/{job_id}/{ts}.md   # one markdown file per run
├── skills/                  # auto-generated procedural memories
├── logs/                    # structured logs per component
├── messaging/               # gateway state (telegram pairings, discord channels…)
└── uploads/                 # files attached in chat
```

This is **the** source of truth. Every Hermes interface reads/writes here.

### Entry points (all in `hermes_cli/main.py`)

```bash
hermes              # interactive TUI — terminal chat with the agent
hermes web          # FastAPI server on 127.0.0.1:9119 (browser dashboard + REST + WS)
hermes dashboard    # alias of `web`
hermes gateway      # messaging gateway (telegram/discord/slack/whatsapp/signal/email)
hermes cron         # cron CLI — list/add/edit/run scheduled jobs
hermes mcp serve    # MCP stdio server for Claude Code / Cursor
hermes model        # interactive model picker — switch provider/model live
hermes config set   # edit config.yaml
hermes setup        # run the full first-time setup wizard
hermes batch        # batch trajectory generation for RL training
hermes claw migrate # import sessions from OpenClaw
```

The two we care about are **`hermes web`** (the dashboard / our gateway target) and **`hermes`** (TUI — useful for debugging).

### The agent loop (the actual brain)

When Hermes processes a user message, it does this in a loop:

```
1. Build context: system prompt + memory + last N messages
2. Call the LLM (your configured provider)
3. LLM returns either:
   - Final text → emit message.complete, exit loop
   - Tool calls → for each, run the tool, capture output, append to context
4. If tool calls happened → goto 2
```

Plus a **side track** that runs in parallel:
- After each turn, the agent considers: "Is there a memory worth saving?" If yes, write a memory.
- After complex multi-step tasks, considers: "Could this be a reusable skill?" If yes, write a skill file.

This loop runs for the TUI, the web dashboard, the messaging gateway — same code, different transports.

### How the transports work (this is the bit we plug into)

`hermes web` (i.e. `hermes_cli/web_server.py`) starts a FastAPI server with two pieces:

#### 1. Browser SPA + REST API at `/api/*`

A complete admin UI: edit config, view sessions, run cron jobs, browse skills, see costs. The mobile gateway proxies the read-only parts of this.

Key REST endpoints:

```
GET  /api/sessions              list all conversations
GET  /api/sessions/{id}         one session's metadata
GET  /api/sessions/{id}/messages full message history
GET  /api/sessions/search?q=    FTS5 search across all messages
DELETE /api/sessions/{id}       delete

GET  /api/cron/jobs             list cron jobs
POST /api/cron/jobs             create
PUT  /api/cron/jobs/{id}        update
POST /api/cron/jobs/{id}/pause  pause
POST /api/cron/jobs/{id}/resume resume
POST /api/cron/jobs/{id}/trigger trigger now
DELETE /api/cron/jobs/{id}      delete

GET  /api/model/info            current model + capabilities
GET  /api/config                full config (redacted)
PUT  /api/config                update config
GET  /api/skills                list installed skills
GET  /api/tools/toolsets        list toolsets + enabled state
GET  /api/logs?file=&lines=     tail logs
GET  /api/analytics/usage?days= cost / token rollups
```

Auth: a per-process random token (`secrets.token_urlsafe(32)`) is generated at boot and **only embedded in the served HTML**. Every API call requires `X-Hermes-Session-Token: <token>` or `Authorization: Bearer <token>`. Token rotates every restart.

DNS-rebinding mitigation: a host-header middleware rejects requests whose `Host:` doesn't match the bound interface.

#### 2. JSON-RPC WebSocket at `/api/ws`

This is the **chat interface**. It's the same JSON-RPC protocol the TUI uses to talk to the agent — re-used over WebSocket for browser/mobile clients.

It's wire-compatible with stdio. Newline-delimited JSON-RPC 2.0 frames in both directions:

```json
// client → server (request)
{"jsonrpc":"2.0","id":1,"method":"prompt.submit","params":{"session_id":"xyz","text":"hello"}}

// server → client (response)
{"jsonrpc":"2.0","id":1,"result":{"status":"streaming"}}

// server → client (notification — no id)
{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"xyz","payload":{"text":"hi "}}}
```

**Methods you can call** (subset):

| Method | What it does |
|---|---|
| `session.create` | Start a new conversation |
| `session.list` | List recent sessions |
| `session.resume {session_id}` | Reattach to an existing session, get its history |
| `session.interrupt {session_id}` | Abort current turn (stop button) |
| `prompt.submit {session_id, text}` | Send a user message → starts streaming |
| `prompt.background {session_id, text}` | Send + return immediately, get `background.complete` later |
| `image.attach {session_id, path}` | Attach a local-FS image to the next prompt |
| `clarify.respond / sudo.respond / secret.respond / approval.respond` | Answer a blocking prompt from the agent |
| `config.set / config.get` | Live config (e.g. switch model mid-session) |
| `commands.catalog` / `slash.exec` / `cli.exec` | Invoke slash commands and CLI ops |
| `model.options` | Pick a model |
| `voice.toggle` | Voice mode |
| `process.stop` / `reload.mcp` | Control |

**Events the server pushes** (subset):

| Event | Meaning |
|---|---|
| `gateway.ready` | Connection accepted, ready for requests |
| `session.info` | Session is fully initialized (agent ready) |
| `message.start` | User turn began processing |
| `message.delta` | Stream chunk of assistant text |
| `message.complete` | Turn done (with token usage, cost, status) |
| `thinking.delta` / `reasoning.delta` / `reasoning.available` | Reasoning stream (for o1-style models) |
| `tool.start` | Agent called a tool |
| `tool.generating` | Tool is preparing args |
| `tool.progress` | Long-running tool sent an update |
| `tool.complete` | Tool finished (with summary, duration, todos) |
| `subagent.start / .tool / .complete` | Spawn-tree events |
| `approval.request` | Agent asks for permission to do something destructive |
| `clarify.request` | Agent asks a clarifying question |
| `sudo.request` / `secret.request` | Agent needs sudo password / API key |
| `voice.transcript` / `voice.status` | Voice mode |
| `error` | Something went wrong |
| `background.complete` | Background prompt finished |

This is the **complete chat surface**. Everything you can do in the TUI you can do over this WebSocket.

### Cron internals

`~/.hermes/cron/jobs.json` is a list of dicts:

```json
[
  {
    "id": "cron-abc123",
    "name": "morning brief",
    "prompt": "Summarize unread emails and DM me on Telegram",
    "schedule": {"cron": "0 7 * * 1-5"},
    "enabled": true,
    "deliver": "telegram",
    "next_run_at": "2026-05-01T02:00:00Z",
    "last_run_at": "2026-04-30T02:00:00Z",
    "last_status": "ok"
  }
]
```

A scheduler thread inside `hermes web` (and inside the gateway process) wakes every minute, finds due jobs, runs them through the agent, captures the output as a markdown file at `~/.hermes/cron/output/{job_id}/{timestamp}.md`, and updates `last_run_at` / `next_run_at`.

There's no event bus for completions. Clients have to poll or watch the filesystem.

### Memory and skills (briefly)

- **Memory**: Hermes stores persistent facts about you in `memory.db` via the Honcho dialectic user-modeling library. Things like "user prefers concise answers", "user is a TypeScript dev", "user's wife's name is X". The agent retrieves relevant memories and stuffs them into the system prompt at every turn.

- **Skills**: After complex multi-step tasks, the agent decides whether to write a "skill" — a markdown file describing the procedure it just figured out. Next time you say "deploy the staging env", if a skill matches, the agent loads it as a procedure rather than re-discovering the steps.

- **Session search**: All your past messages are FTS5-indexed. `/search "the docker thing"` brings back relevant snippets from any prior session.

These are why Hermes "gets smarter" over time — most LLM front-ends start cold every conversation.

### Models

Hermes doesn't run an LLM itself. It **calls** an LLM via your configured provider. You pick a model with `hermes model` or by editing `config.yaml`:

```yaml
model:
  provider: openrouter
  name: anthropic/claude-sonnet-4-5
context_length: 200000
```

API keys live in `~/.hermes/.env`. Hermes does provider-specific quirks (Anthropic's image format, OpenAI's tool-call format, etc.) so you don't have to.

When the model is **vision-capable**, Hermes will pass images directly. When not, you get text-only chat (or you wire an auxiliary vision model — that's the Phase 4 plan but not used in this MVP).

---

## Part 3 — How our gateway plugs into Hermes

Now the integration. Why we built the Node gateway in the first place.

### The problem

Hermes is excellent on a server. The mobile experience isn't:

| Problem | Why |
|---|---|
| `hermes web` is browser-only | The SPA assumes desktop. Tiny touch targets, no offline state. |
| Auth is a per-process random token | Phone can't see the served HTML, can't survive Hermes restarts. |
| Host-header + CORS lock to localhost | Phone on LAN can't reach Hermes directly. Even if it could, the token would leak. |
| `image.attach` takes a filesystem path | Phone can't write to the Hermes server's filesystem. |
| No push notifications | Cron job finishes at 7am, you have to remember to check. |
| No offline-friendly session list | Browser SPA hits the API every render — battery drain on mobile. |
| Files & PDFs need preprocessing | Hermes rejects raw file parts; needs images as data URLs of certain sizes. |
| WebSocket reconnects mid-turn | No envelope IDs, no replay — you lose mid-stream tokens forever. |

So we built a **gateway**: a Node service that sits between Hermes and your phone, fixes these mismatches, adds mobile-grade auth + push + uploads + replay, and hides Hermes from the public internet.

### Topology

```
your phone (LAN or cellular)
        │
   HTTPS / WSS
        │
   Caddy on :443  (TLS terminator)
        │
        ▼
   Node Gateway on 127.0.0.1:8080
   ├─ JWT auth for the phone
   ├─ Proxies REST to Hermes /api/*
   ├─ Bridges WebSocket to Hermes /api/ws
   ├─ Owns blob uploads + image processing
   ├─ Owns cron-output FS watcher → push notifications
   └─ Stores its own SQLite (gateway.db) for app-side state
        │
        ▼
   Hermes on 127.0.0.1:9119  (or in Docker)
   └─ Owns ~/.hermes/ — sessions, memory, cron, model, skills
```

Hermes never gets a public port. Every mobile request goes through the gateway. The gateway adds the auth Hermes can't, and translates between mobile-friendly contracts and Hermes-native contracts.

### The two trust boundaries

```
┌─────────┐  JWT (15m) + refresh (30d)    ┌─────────┐  X-Hermes-Session-Token   ┌────────┐
│  Phone  │ ────────────────────────────► │ Gateway │ ────────────────────────► │ Hermes │
└─────────┘                               └─────────┘                           └────────┘
```

- Phone never sees Hermes' token.
- Hermes never sees the JWT.
- Gateway brokers both, with separate audit trails.

### What the gateway adds on top of raw Hermes

| Concern | Hermes alone | Gateway adds |
|---|---|---|
| Auth | Per-process random token, manual capture | JWT + refresh, password-based, persistent |
| Sessions | Hermes-owned IDs only | Phone-owned UUIDs that map to Hermes IDs lazily |
| Rename / archive | Not supported | Gateway-side `title_override`, archive flag |
| Uploads | Path-based `image.attach`, no upload endpoint | `POST /uploads` multipart, sha256 dedup, sharp thumb + compress, PDF text extraction, OCR for scanned PDFs, signed-URL reads |
| Image input shape | Provider-specific quirks | Materialize the compressed image, call `image.attach` on chat send |
| PDF in chat | Not supported | Extract text → inject as prompt prefix (capped) |
| WebSocket replay | None — mid-turn disconnect loses tokens | Monotonic event IDs, `lastEventId` resume, `sync.required` fallback |
| Push notifications | None | Expo push via cron-output FS watcher |
| Per-job notify prefs | None | `cron_prefs` table |
| Rate limits | None | Login 10/min IP, uploads 60/min user, global 300/min |
| MIME validation | None | Magic-byte sniff, allowlist |
| Cleanup | None | Sweepers for orphan blobs, expired tokens, stale push tokens, materialize cache |
| Backups | None | Scripts for SQLite + blob rsync |

### Request flows

#### REST proxy (e.g. `GET /sessions`)

```
phone GET /sessions
  └─ Authorization: Bearer <JWT>
       │
       ▼
gateway:
  1. requireAuth middleware verifies JWT, loads user
  2. SELECT * FROM app_sessions WHERE user_id=? AND archived_at IS NULL
  3. for each session with hermes_session_id: HermesHttpClient.getSession(id)
       └─ adds X-Hermes-Session-Token + Host header
            │
            ▼
       hermes /api/sessions/{id} → metadata (title, preview, timestamps)
            │
       ◄────┘
  4. merge gateway-side state (title_override) with hermes preview
  5. return list to phone
```

If Hermes is down, gateway returns the rows it knows about with `preview: null`. App still works in degraded mode.

#### WebSocket chat send

```
phone connects ws://gateway/ws?token=<JWT>&app_session_id=<uuid>&lastEventId=<n>
  │
  ▼
gateway:
  1. JWT verified from query
  2. ownership check: app_sessions.user_id === user.id
  3. if lastEventId provided:
       SELECT * FROM ws_events WHERE app_session_id=? AND id>?
       → replay envelopes
  4. ensure upstream HermesWsClient is connected
  5. emit {type:"control.gateway.ready"}
  6. live: forward upstream events for this app_session, wrapped in envelopes

phone sends {type:"chat.send", text:"refactor X", attachmentIds:["abc","def"]}
  │
  ▼
gateway chat.send handler:
  A. resolve attachments (DB lookup, ownership, kind)
  B. if app_session has no hermes_session_id:
       upstream JSON-RPC request {method:"session.create"}
       ◄─ {result:{session_id:"hermes-xyz"}}
       UPDATE app_sessions SET hermes_session_id='hermes-xyz'
  C. for each image attachment:
       compressed-derivative blob → BlobStore.materializeLocalFile() → /path
       upstream JSON-RPC {method:"image.attach", params:{session_id, path}}
  D. for each PDF: read derived text, prepend as "[attached: name]\n{text}\n\n"
  E. upstream JSON-RPC {method:"prompt.submit", params:{session_id, text:finalPrompt}}
  F. record run start in chat-run-timer

hermes streams:
  message.start → message.delta×N → tool.start → tool.complete → message.complete
  │
  ▼ (gateway demuxer)
  G. lookup app_session_id by hermes session_id (cached)
  H. wrap each event in envelope {id, sessionId, type, createdAt, payload}
  I. if type ∈ persisted-allowlist: INSERT INTO ws_events RETURNING id (monotonic)
  J. fan out envelope to all gateway WS clients subscribed to that app_session
  K. timer.recordEvent for chat_run log
  │
  ▼
phone receives envelopes, assembles bubbles via chat-store reducer
```

#### Upload + chat with image

```
1. user picks photo → expo-image-picker returns local URI
2. gateway POST /uploads (multipart)
   - magic-byte MIME sniff (rejects type confusion)
   - sha256 streamed in flight
   - dedup per user (returns existing blob if same hash)
   - sharp: thumb (256px) + Hermes-ready compress (≤900KB target)
   - INSERT blob_objects + attachments + derived_artifacts rows
   - 201 → {id, kind:"image", hasThumb:true, hermesReady:true, sha256, ...}
3. phone caches thumb to expo-file-system (signed URL fetch)
4. phone sends {type:"chat.send", text:"what's in this", attachmentIds:[id]}
5. gateway extends prompt: image.attach with materialized compressed blob path,
   then prompt.submit
6. Hermes' configured model is vision-capable → it sees the image directly
7. response streams back as normal
```

#### Cron output → push

```
hermes scheduler runs job at 09:00 → writes ~/.hermes/cron/output/morning-brief/2026-04-30T09:00.md
                                                    │
                            chokidar watcher in gateway
                                                    │
                                                    ▼
gateway:
  1. parse jobId="morning-brief", outputId="2026-04-30T09:00"
  2. SELECT cron_prefs WHERE hermes_job_id='morning-brief'
       AND notify_on_complete=1 AND last_seen_output_id<>'2026-04-30T09:00'
  3. SELECT push_tokens WHERE user_id IN (...)
  4. fetch job name from /api/cron/jobs/morning-brief (cached 30s)
  5. ExpoClient.sendMany([
       {to: token, title: "morning brief", body: <first 80 chars>,
        data: {type:"cron_output", jobId, outputId}}
     ])
  6. UPDATE cron_prefs.last_seen_output_id
  7. on DeviceNotRegistered ticket: DELETE push_tokens row
                                                    │
                                                    ▼
Apple/Google push servers → phone notification
                                                    │
                                                    ▼
user taps notification
                                                    │
                                                    ▼
expo-router /cron/morning-brief/output/2026-04-30T09:00
                                                    │
                                                    ▼
phone GET /cron/outputs/2026-04-30T09:00?job_id=morning-brief
                                                    │
                                                    ▼
gateway reads ~/.hermes/cron/output/morning-brief/2026-04-30T09:00.md → returns content
                                                    │
                                                    ▼
phone renders markdown
```

### Why this division of labor

The boundary line is: **Hermes owns the AI brain; the gateway owns the mobile experience.**

- Hermes' database (`state.db`) is the canonical source of session/message history. Gateway only stores its own bookkeeping (`gateway.db`) — auth, app-session ↔ hermes-session mapping, event replay log, attachments, push tokens, cron prefs.
- We never duplicate Hermes' work (sessions, messages, costs, FTS5, cron scheduling). We proxy.
- We add what Hermes doesn't have (auth that survives restart, mobile uploads, replay, push, signed URLs, rate limits, cleanup).
- If we ever rip the gateway out and replace it, Hermes keeps working — your conversations and skills are intact.

### What can go wrong (failure modes)

| Failure | Symptom | Recovery |
|---|---|---|
| Hermes process crashes | Gateway gets ECONNREFUSED on REST, WS upstream closes | Spawn mode: launcher restarts with backoff. External mode: gateway logs, retries on every request. Phone shows "reconnecting" banner until upstream reachable. |
| Hermes restart rotates token | Gateway gets 401 on next REST call | Launcher re-scrapes token from served HTML, retries the original call once. Upstream WS reconnects with new token query string. |
| Phone disconnects mid-turn | Stream interrupted | Phone reconnects with `lastEventId`. Gateway replays missing envelopes from `ws_events`. If event log gap (older than retention), gateway emits `sync.required` and phone reloads from REST. |
| Hermes blocks waiting on approval | Turn is paused | Gateway forwards `approval.request` event. App shows ApprovalCard. User responds → forwards `approval.respond` → Hermes resumes. Hard server-side timeout: 300s. |
| Gateway DB corrupts | App can't list sessions | Backup script restores from `~/backups/gateway-*.db.gz`. Hermes data unaffected (separate DB). |
| Hermes data corrupts | Sessions disappear | Hermes' own backup story (rsync ~/.hermes). Gateway's `app_sessions.hermes_session_id` becomes dangling — `GET /sessions/:id/messages` returns `[]` for affected rows. |
| Phone offline | All requests fail | TanStack Query has cached responses; chat-store keeps the last assembled history. Send button disabled. |
| Push token expires | DeviceNotRegistered ticket on next push | Cleanup sweeper deletes the row. App re-registers on next launch. |

### What you can do that you couldn't before

If you only used `hermes web` directly:

- **You couldn't.** The dashboard is unusable on phone — desktop-only design, browser-tied auth, no push, no uploads.

With the gateway:
- Chat with your VPS-hosted agent from your phone over the public internet, securely (gateway behind Caddy + JWT auth).
- Stream tool calls and reasoning live, with full reconnect/resume.
- Send photos and PDFs from your phone — gateway adapts them into Hermes-compatible inputs automatically.
- Get pushed when a cron job completes, with deep-link tap to the output.
- All of this works while Hermes itself is still running on a tightly locked-down VPS port behind your gateway, with zero public exposure.

That's the whole point. Hermes does the AI agent thing; the gateway makes that experience usable from a phone in 2026 the way you'd expect.
