# Obsidian Sync — Hermes Integration

End-to-end-encrypted Obsidian vault synced to the Hermes runtime so the agent can read your notes for context and write daily summaries / memory state back into them. Uses the official `obsidian-headless` client (Feb 2026 release).

## Architecture

```
[iPhone Obsidian]──┐
[Mac Obsidian]   ──┼─► Obsidian Sync (E2E encrypted)
                   │
[VPS / Local]    ──┘
   ├─ obsidian-sync container/daemon  ←─►  cloud
   │     writes vault to ./data/obsidian-vault (or /srv/obsidian-vault on VPS)
   │
   └─ hermes container/daemon
         bind-mount: same path → /vault
         OBSIDIAN_VAULT_PATH=/vault
         bundled `obsidian` skill enabled in platform_toolsets.cli
```

## Vault layout convention

The agent shares your real personal vault (`Drshnk`). To keep blast radius contained, a folder convention divides agent-owned files from your hand-curated notes:

```
Drshnk/
├── (your existing folders — agent reads, never writes)
├── Daily Notes/        ← daily dashboard cron writes here
└── Hermes/             ← everything else the agent generates
    ├── Memory/         ← Memory Keep-Alive plugin (when installed)
    ├── Summaries/      ← conversation / cron summaries
    ├── Drafts/         ← agent-generated drafts you review/move
    └── README.md       ← describes the convention to the agent
```

**Enforcement:** prompt-level only. The agent's system prompt instructs it to write inside `Hermes/` (and `Daily Notes/`) and to leave everything else read-only. There is no OS-level restriction — accidents are possible. Mitigations:

- **Obsidian Sync version history** — built-in, free with Sync subscription, restores any single file.
- **Daily git snapshot** — `scripts/backup-snapshot.sh` covers `data/obsidian-vault/` once we add it (tracked in TODO).
- **Audit week** — watch what the agent writes for the first ~7 days; tighten or relax once you see its behavior.

## Local setup (Docker)

### 1. Files added by the integration

| Path | Purpose |
|---|---|
| `docker-compose.yml` (`obsidian-sync` service) | Runs Belphemur's headless image; bind-mounts `./data/obsidian-vault` |
| `obsidian-sync.env.example` | Template you copy to `obsidian-sync.env` (gitignored) |
| `data/obsidian-vault/` | Vault contents (synced from cloud; gitignored under `/data/`) |
| `scripts/patch-hermes-config.py` | Adds `obsidian` to `platform_toolsets.cli` so the agent can use the skill |

### 2. One-time auth (interactive)

The Belphemur image uses a token (not username/password) so MFA flows through cleanly. Run once:

```bash
cp obsidian-sync.env.example obsidian-sync.env
docker compose run --rm --entrypoint get-token obsidian-sync
```

Enter your Obsidian email + login password (and MFA if enabled). The container prints a token. Paste it into `obsidian-sync.env` as `OBSIDIAN_AUTH_TOKEN`.

### 3. Fill in remaining env

In `obsidian-sync.env`:

```env
OBSIDIAN_AUTH_TOKEN=eyJ...      # from step 2
VAULT_NAME=Drshnk               # exact case-sensitive vault name
VAULT_PASSWORD=...              # E2E encryption password (Settings → Sync → Encryption password)
SYNC_MODE=bidirectional         # or pull-only / mirror-remote
```

`VAULT_PASSWORD` is the **encryption password**, not your account login. They are separate credentials. Skip if your vault is not E2E-encrypted.

### 4. Start sync + verify

```bash
docker compose up -d obsidian-sync
docker compose logs -f obsidian-sync
```

Wait for log lines indicating sync complete. First sync time depends on vault size — minutes for a few hundred notes.

```bash
ls data/obsidian-vault/        # should show your top-level vault folders
```

### 5. Enable the Hermes Obsidian skill

The skill is bundled with Hermes but only active when listed in `platform_toolsets.cli`. The patch script does this automatically:

```bash
./scripts/patch-hermes-config.py
docker compose up -d --force-recreate hermes hermes-cron
```

`--force-recreate` is required so the new vault bind-mount and `OBSIDIAN_VAULT_PATH` env land in the running container.

### 6. Smoke test

In a Hermes chat, ask:

```
List the top-level folders in my Obsidian vault.
```

Expected: agent uses the obsidian skill, lists folders matching `data/obsidian-vault/`.

```
Create a note "Hermes/Test.md" with the body "wired up correctly".
```

Expected: file appears in `data/obsidian-vault/Hermes/Test.md`, and within seconds also lands in your Obsidian app on phone/desktop.

## VPS setup (native, no Docker)

VPS runs Hermes via systemd (`hermes-gateway.service` + `hermes-dashboard.service`), so the Obsidian client runs natively too — no extra Docker layer for a single daemon.

### One-shot install via the script

```bash
ssh root@<vps>
cd /root/repos/Hermes_agent
git pull
sudo bash scripts/install-obsidian-sync.sh
```

The script is idempotent: re-run any time, it advances as far as it can and reports what's left. Default vault path: `/opt/obsidian-vault`. Override with `VAULT_DIR=/srv/foo` env if needed.

### What the script handles automatically

1. Installs Node 22 if missing (NodeSource apt repo)
2. `npm install -g obsidian-headless`
3. Creates the vault directory
4. Drops `/etc/systemd/system/obsidian-sync.service` (idempotent diff against desired content)
5. Patches `hermes-dashboard.service` to add `Environment=OBSIDIAN_VAULT_PATH=/opt/obsidian-vault`
6. Runs `scripts/patch-hermes-config.py` to add `obsidian` to `platform_toolsets.cli` in `~/.hermes/config.yaml`

### What requires you (interactive — MFA)

The script will bail at step 4 with clear instructions if either of these is missing. Run them once at a real terminal then re-run the script:

```bash
ob login                           # email + password + MFA from authenticator
cd /opt/obsidian-vault
ob sync-setup --vault "Drshnk"     # case-sensitive
ob sync                            # one-shot to verify decryption
```

After that, re-run the install script — it'll detect the bound vault and finish setup (systemd unit + Hermes wiring).

### Final restart of Hermes services

The install script restarts both `hermes-dashboard` and `hermes-gateway` if it touched the dashboard env. **Always restart both together** — never just dashboard.

> **Why both?** Hermes 0.12+ regenerates an in-memory `_SESSION_TOKEN` on every dashboard startup. The gateway scrapes that token from `/index.html` once at gateway-start time and reuses it. A bare `systemctl restart hermes-dashboard` rotates the token but the gateway keeps using the old one — and because the upstream-WS open failure manifests as "non-101 status" rather than HTTP 401, the gateway's auto-refresh path (which only triggers on 401) never fires. Result: chat hangs forever.
>
> Manual restart sequence if you ever touch the dashboard alone:
>
> ```bash
> systemctl restart hermes-dashboard
> systemctl restart hermes-gateway
> ```

### Verify

```bash
systemctl status obsidian-sync       # Active (running)
journalctl -u obsidian-sync -f       # watch sync events
ls /opt/obsidian-vault               # vault contents (empty until first sync)
```

In a Hermes mobile chat, ask:
> List the top-level folders in my Obsidian vault.

Confirms agent has the obsidian skill and can read the vault.

## Maxing out the integration

After basic sync works, three high-leverage additions:

### 1. Seed Hermes' memory with vault conventions

Hermes loads `~/.hermes/memories/MEMORY.md` (entries separated by `§`) into every session. Seed it once with what the agent should know about you and the vault — so it never has to be told twice:

```bash
ssh root@<vps>
cat >> /root/.hermes/memories/MEMORY.md <<'EOF'
§
User: <your name>. <role>. Time zone: <Area/City>. <comm preferences — terse, no emoji, etc.>
§
Obsidian vault at $OBSIDIAN_VAULT_PATH (vault: <vault name>). READ anywhere for context. WRITE only inside <vault>/Hermes/ and <vault>/Daily Notes/. Never modify or delete files outside those two paths. Use [[wikilinks]] when referring to other notes. Generated notes need YAML frontmatter with `created`, `tags`, `source` fields.
§
Cron jobs run with no conversation memory. Read what is needed from $OBSIDIAN_VAULT_PATH at run time. Use exactly the literal string [SILENT] when nothing changed/relevant — the delivery layer suppresses the notification.
EOF
```

These are tokens injected on every turn — keep them tight. Hermes' built-in memory review (every 10 user turns) will refine them over time.

### 2. Daily dashboard cron

Auto-generates a daily note every morning. Adjust the schedule to your timezone (VPS is UTC).

```bash
ssh root@<vps>
hermes cron create '30 1 * * *' \
  --name 'daily-dashboard' \
  --skill obsidian \
  --workdir /opt/obsidian-vault \
  --deliver local \
  "$(cat <<'PROMPT'
Build today's daily note in the Obsidian vault.

Path: $OBSIDIAN_VAULT_PATH/Daily Notes/$(date -u -d "+5 hours 30 minutes" +%Y-%m-%d).md
(IST date — VPS is UTC, user is Asia/Kolkata.)

Steps:
1. If yesterday's note exists, read it and identify any unfinished tasks (lines starting with "- [ ]").
2. Compose today's note with this template:

---
created: <ISO timestamp>
tags: [daily, generated]
source: hermes-cron
---

# <Day, Month D, Year>

## Carryover from [[YYYY-MM-DD]]
<unfinished items from yesterday, or omit section>

## Top 3 for today
- [ ] (placeholder)

## Notes
<one-line journal prompt — pick from your context>

## Open threads
<glance at Hermes/Drafts/ + Hermes/Summaries/ — list files modified in last 7 days as wikilinks. Omit section if none.>

3. Write via the obsidian skill. If file exists, append "## Refresh" instead of overwriting.
4. Reply with one line.

If the vault is unreachable, reply [SILENT].
PROMPT
)"
```

`30 1 * * *` = 01:30 UTC = 07:00 IST. Adjust both the cron expression and the `+5 hours 30 minutes` offset for your timezone. Trigger immediately for testing:

```bash
hermes cron run <job-id-from-list>
```

Output lands at `/root/.hermes/cron/output/<job-id>/<timestamp>.md` and (because of bidirectional sync) in your vault under `Daily Notes/`.

### 3. Memory Keep-Alive plugin (optional)

Mirrors Hermes' internal memory into your vault as browseable Markdown notes, plus auto-creates `RESUME / CHECKLIST / DOCS` notes for every long-running task.

**Install — must be done in your Obsidian app on Mac/iPhone, can't be automated:**

1. In Obsidian → **Community plugins** → **Browse** → search "BRAT" → install **Obsidian42 - BRAT** → enable
2. Open command palette (`Cmd+P`) → **BRAT: Add a beta plugin for testing**
3. Paste: `https://github.com/TechieTer/hermes-memory-keep-alive-for-obsidian`
4. Click **Add Plugin** → wait for install
5. Settings → Community plugins → enable **Hermes Memory Keep-Alive**
6. Open the plugin's settings → point it at:
   - Hermes home: `/root/.hermes` (if running on a VPS, expose via SFTP mount or rsync mirror; or skip if you only want vault-side validation)
   - Vault Memory folder: `Drshnk/Hermes/Memory`

7. Run command: **Hermes Keep-Alive: Run validator now** to seed the initial state.

Plugin features once enabled:
- Validator runs every 60 min: repairs missing notes, keeps a workflow index current
- Smoke test every 6 hours
- Slash commands `/loop-start` and `/loop-stop` arm/disarm a keep-alive loop for long tasks

Skip this plugin if you're chat-and-go and don't run multi-day projects through Hermes.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `obsidian-sync` keeps restarting | Bad token or vault password | `docker compose logs obsidian-sync` — check for `auth failed` / `decryption failed`. Re-run get-token. |
| Vault directory empty after several minutes | `VAULT_NAME` doesn't match remote | Check name in Obsidian → Settings → Sync; case-sensitive. |
| Hermes can't see the vault | `OBSIDIAN_VAULT_PATH` not set, or vault bind not mounted | Inspect with `docker compose exec hermes env \| grep OBSIDIAN` and `docker compose exec hermes ls /vault` |
| Agent refuses to use Obsidian | Skill not in `platform_toolsets.cli` | Run `./scripts/patch-hermes-config.py` and `docker compose up -d --force-recreate hermes hermes-cron` |
| Permission denied writing to vault | UID/GID mismatch between containers | `obsidian-sync` `PUID:PGID` is pinned to `HERMES_UID:HERMES_GID`. If you've overridden HERMES_UID, restart obsidian-sync to align. |
| Files appearing as `.conflict` | Hermes and you edited the same file simultaneously | Pick the version you want, delete the other. Same as Obsidian desktop conflict resolution. |

## Cost reminder

- Obsidian Sync: $4–10/month (you must have an active subscription)
- Belphemur image: free, MIT
- Obsidian-headless package: free, MIT (official Obsidian)

## References

- [Hermes Agent — bundled Obsidian skill docs](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/skills/bundled/note-taking/note-taking-obsidian.md)
- [Obsidian — official Headless Sync docs](https://obsidian.md/help/sync/headless)
- [`obsidianmd/obsidian-headless` — official npm](https://github.com/obsidianmd/obsidian-headless)
- [`Belphemur/obsidian-headless-sync-docker` — Docker wrapper](https://github.com/Belphemur/obsidian-headless-sync-docker)
- Design rationale: see `CRON_OUTPUT_TO_CHAT_DESIGN.md` for the broader "how does Hermes interact with my data" thinking
