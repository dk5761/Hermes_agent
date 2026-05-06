# SQLite persistence — phase by phase

**Goal:** replace AsyncStorage as the persistence backend for everything except
secrets. One on-device SQLite database holds the TanStack Query cache, the
pending-mutations / pending-sends queues, every Zustand store currently using
AsyncStorage, and the cold-start metadata. Secrets stay in SecureStore.

**Why now:** AsyncStorage stores the entire dehydrated TanStack cache as a
single JSON blob. Cold-start hydrate parses on the JS thread; every refetch
rewrites the whole blob (1s throttle softens, doesn't fix). Hits a 6 MB
ceiling on Android. SQLite gives per-row writes, transactional atomicity,
proper TTL queries, and a single inspectable file for diagnostics.

**Architecture summary:**

```
┌─ SQLite (data/hermes.db, WAL) ─────────────────────────┐
│  rq_cache         per-query rows, JSON state          │
│  kv               generic K/V for Zustand stores      │
│  pending_mutations  typed queue rows                  │
│  pending_sends      typed queue rows                  │
│  schema_version     single row, integer               │
│  meta             one-shot flags (e.g., migrated_v1)  │
└────────────────────────────────────────────────────────┘
       ↑ rehydrate                ↓ persist
┌─ Cold start ───────┐    ┌─ Live writes ───────────────┐
│  open DB           │    │  TanStack persister:        │
│  run migrations    │    │    upsert per query, throttled
│  paint from rows   │    │  Zustand stores: kv upsert  │
│  drainers attach   │    │  Queues: typed table writes │
└────────────────────┘    └─────────────────────────────┘
```

**Scope:**
- TanStack Query cache.
- Every Zustand store currently using AsyncStorage (12 files).
- Pending-mutations queue (typed rows, atomic dequeue).
- Pending-sends queue (typed rows, per-session indexed).
- One-shot data migration from AsyncStorage on first launch.
- Diagnostics surfaces table sizes + a "Vacuum" action.

**Out of scope:**
- SecureStore-backed values (auth token, biometric flag) — stay where they are.
- Encrypted DB at rest. SQLCipher is a known follow-up; document threat model.
- Cross-device sync. This is a local cache/queue, not a sync engine.

---

## Locked decisions

1. **Driver:** `expo-sqlite`. First-party, WAL-capable, async API, supported
   on the dev client we already ship. `op-sqlite` is faster (JSI) but adds a
   plugin and isn't worth the swap for our write rates.
2. **DB file:** `data/hermes.db` inside the app sandbox. WAL mode; `synchronous=NORMAL`.
3. **Schema versioning:** single-row `schema_version` table. Migrations are
   numbered SQL files applied in order, idempotent. Bump version on any
   shape change. Never drop columns in-place — write a migration.
4. **TanStack persister:** custom adapter implementing the official `Persister`
   interface. Per-query rows so we can prune by age in SQL. Selective
   dehydration carried over from the AsyncStorage version.
5. **Zustand storage:** generic `kv` table fronted by a `StateStorage`-shaped
   adapter. Drop-in replacement — call sites that today use
   `createJSONStorage(() => AsyncStorage)` swap to `createJSONStorage(() => sqliteKv)`.
6. **Queues:** typed tables (not `kv` blobs). Lets us index by session id /
   enqueue time and atomically dequeue under transaction.
7. **Migration policy:** one-shot AsyncStorage → SQLite copy on first SQLite
   boot, gated by a `meta.migrated_v1` flag. Source keys deleted after
   successful copy. A missed key = silent state loss for that store, so the
   migration manifest must be exhaustive (Phase 6 risks).
8. **Buster:** `PERSIST_BUSTER` constant survives in `query-persister.ts`.
   Bumping it deletes all `rq_cache` rows on next boot. Schema-version bumps
   are independent (DB structure, not query shape).

---

## Inventory of AsyncStorage callers (20 files, ~12 stores)

To swap. All paths under `frontend/`:

| Surface | File | Today's key |
|---|---|---|
| TanStack cache | `src/cache/query-persister.ts` | `hermes.rq.cache.v1` |
| Pending mutations | `src/state/pending-mutations.ts` | `chat.pending-mutations.v1` |
| Pending sends | `src/state/pending-sends.ts` | `chat.pending-sends.v1` |
| Pinned sessions | `src/state/pinned-sessions.ts` | `chat.pinned-sessions.v1` |
| Session tags | `src/state/session-tags.ts` | `chat.session-tags.v1` |
| Reasoning collapse | `src/state/reasoning-collapse.ts` | `chat.reasoning-collapse.v1` |
| Recent searches | `src/state/recent-searches.ts` | `chat.recent-searches.v1` |
| Todos UI | `src/state/todos.ts` | `chat.todos.*` |
| Voice settings | `src/state/voice-settings.ts` | `chat.voice-settings.v1` |
| Notifications inbox | `src/state/notifications-inbox.ts` | `chat.inbox.v1` |
| Dev settings | `src/state/dev-settings.ts` | `chat.dev-settings.v1` |
| Theme mode | `src/theme/ThemeProvider.tsx` | `chat.theme.v1` |
| Settings screens | `app/(app)/(settings)/{appearance,notifications,voice,toolsets,diagnostics}.tsx` | misc one-offs |
| Search debounce | `src/search/useSearch.ts`, `app/(app)/(chats)/search.tsx` | `chat.search.history` |
| Boot diagnostics | `app/_layout.tsx` | bootstrap reads |

The settings-screen + boot files mostly call `AsyncStorage.getItem` / `setItem`
directly. We can either route them through the new `sqliteKv` adapter (keeps
the API) or rewrite to the typed DB module. Phase 3 does the former for
speed; Phase 8 (cleanup) decides whether any deserve typed treatment.

---

## Phase 0 — Spike + dependency install (45 min)

Install:
```
expo-sqlite
```

Open the DB once at startup and run a `PRAGMA user_version`. Verify:
- `pnpm typecheck` clean.
- DB file exists in `FileSystem.documentDirectory + 'SQLite/hermes.db'`.
- Logs show `[db] open ok, user_version=0` on first boot.
- Closing the app and reopening leaves the file intact.

**Acceptance:** dep installed, no build break, DB file present.

**Edge cases:**
- iOS sandbox path differs across simulator vs device — let `expo-sqlite`
  pick the path; never hardcode.

---

## Phase 1 — DB module + migration runner (2h)

### Files

- `src/db/sqlite.ts` — NEW. Single shared `SQLiteDatabase` handle behind a
  lazy `openDatabaseAsync` call. Exports `getDb(): Promise<SQLiteDatabase>`
  and a small typed query helper.
- `src/db/migrations/index.ts` — NEW. Ordered list of migration objects:
  `{ version: 1, sql: "CREATE TABLE rq_cache (...);" }`.
- `src/db/schema.ts` — NEW. Constants for table/column names so call sites
  don't repeat magic strings.

### Migration runner

```ts
// src/db/sqlite.ts (sketch)
export async function getDb(): Promise<SQLiteDatabase> {
  if (cached) return cached;
  const db = await openDatabaseAsync("hermes.db");
  await db.execAsync("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  await runMigrations(db);
  cached = db;
  return db;
}

async function runMigrations(db: SQLiteDatabase) {
  await db.execAsync("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);");
  const row = await db.getFirstAsync<{ version: number } | null>(
    "SELECT version FROM schema_version LIMIT 1",
  );
  let current = row?.version ?? 0;
  if (current === 0) {
    await db.runAsync("INSERT INTO schema_version (version) VALUES (0)");
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    await db.withTransactionAsync(async () => {
      await db.execAsync(m.sql);
      await db.runAsync("UPDATE schema_version SET version = ?", m.version);
    });
    current = m.version;
  }
}
```

### Initial schema (migration 1)

```sql
CREATE TABLE rq_cache (
  query_key TEXT PRIMARY KEY,         -- JSON.stringify(queryKey)
  state     TEXT NOT NULL,            -- JSON-encoded dehydrated state
  updated_at INTEGER NOT NULL         -- ms epoch
);
CREATE INDEX rq_cache_updated ON rq_cache(updated_at);

CREATE TABLE kv (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE pending_mutations (
  id          TEXT PRIMARY KEY,
  enqueued_at INTEGER NOT NULL,
  retries     INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX pending_mutations_age ON pending_mutations(enqueued_at);

CREATE TABLE pending_sends (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  text        TEXT NOT NULL,
  attachments TEXT,                  -- JSON or NULL
  status      TEXT NOT NULL,
  retries     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pending_sends_session ON pending_sends(session_id, enqueued_at);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

### Wire-up

Initialise the DB in `app/_layout.tsx` BEFORE `PersistQueryClientProvider`
mounts. Block render with a small splash if open takes >300ms.

### Acceptance

- App boots, schema_version row reports 1.
- `PRAGMA integrity_check` returns `ok` after first boot.
- Re-running the app does NOT re-execute migration 1.

### Edge cases

- **Migration crash mid-flight**: each migration runs inside a transaction.
  Crash → next boot retries from the same version. Idempotent CREATE-IF-NOT-EXISTS
  helps but we should still author migrations so partial state is acceptable.
- **DB locked on iOS background fetch**: we open per-process; expo-sqlite
  uses `nativeDatabaseSequenceQueue`, so concurrent calls serialise. No
  manual locking needed.

---

## Phase 2 — TanStack Query SQLite persister (3h)

Custom Persister keyed per query. Selective dehydration kept from the
AsyncStorage version.

### Files

- `src/cache/sqlite-persister.ts` — NEW. Implements
  `{ persistClient, restoreClient, removeClient }`.
- `src/cache/query-persister.ts` — REWRITE. Construct the SQLite persister
  instead of the AsyncStorage one. Keep `dehydrateOptions`, `PERSIST_BUSTER`,
  `PERSIST_MAX_AGE` exported.

### Sketch

```ts
// src/cache/sqlite-persister.ts
export function createSQLitePersister(opts: {
  buster: string;
  shouldDehydrateQuery: (q: { queryKey: ReadonlyArray<unknown> }) => boolean;
  maxAge: number;
}): Persister {
  return {
    async persistClient(client) {
      const db = await getDb();
      const queries = client.clientState.queries.filter(opts.shouldDehydrateQuery);
      const now = Date.now();
      // One transaction: upsert all current queries, drop any rows whose
      // key is no longer in the dehydrated set, drop expired rows.
      await db.withTransactionAsync(async () => {
        for (const q of queries) {
          const key = JSON.stringify(q.queryKey);
          const state = JSON.stringify(q);
          await db.runAsync(
            "INSERT INTO rq_cache (query_key, state, updated_at) VALUES (?, ?, ?) " +
              "ON CONFLICT(query_key) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at",
            key, state, now,
          );
        }
        await db.runAsync(
          "DELETE FROM rq_cache WHERE updated_at < ?",
          now - opts.maxAge,
        );
      });
    },
    async restoreClient() {
      const db = await getDb();
      const rows = await db.getAllAsync<{ state: string }>(
        "SELECT state FROM rq_cache WHERE updated_at >= ?",
        Date.now() - opts.maxAge,
      );
      const queries = rows.map(r => JSON.parse(r.state));
      return {
        timestamp: Date.now(),
        buster: opts.buster,
        clientState: { queries, mutations: [] },
      };
    },
    async removeClient() {
      const db = await getDb();
      await db.runAsync("DELETE FROM rq_cache");
    },
  };
}
```

Throttle: the official `PersistQueryClientProvider` calls `persistClient`
on a debounce already. We additionally batch-write via a single transaction,
so disk pressure stays bounded even at high refetch frequency.

### Acceptance

- Cold start with airplane mode → sessions list paints from cache, then would
  refresh online.
- Open chat → `rq_cache` rows count grows; per-session keys visible via
  `SELECT query_key FROM rq_cache WHERE query_key LIKE '%session%'`.
- Bump `PERSIST_BUSTER` → restore returns empty (mismatch), client repaints
  fresh, next persist re-fills.

### Edge cases

- **Query dehydration size**: chat-history infinite queries can be tens of KB.
  Per-row encoding stays manageable; SQLite text columns cap at ~1 GB so we
  never approach the limit. But we should still keep `maxPages: 3` from the
  existing plan.
- **Mutation persistence**: TanStack supports persisting paused mutations.
  We skip them — our queue is in `pending_mutations`. `restoreClient` returns
  `mutations: []` deliberately.
- **Concurrent persist + restore**: PersistQueryClientProvider serialises
  these. Don't call them outside the provider.

---

## Phase 3 — Zustand `sqliteKv` storage adapter (1.5h)

Drop-in replacement for AsyncStorage in every Zustand `persist` block.

### Files

- `src/state/sqlite-kv.ts` — NEW. Implements `StateStorage`:
  ```ts
  export const sqliteKv: StateStorage = {
    async getItem(key) {
      const db = await getDb();
      const row = await db.getFirstAsync<{ value: string }>(
        "SELECT value FROM kv WHERE key = ?", key,
      );
      return row?.value ?? null;
    },
    async setItem(key, value) {
      const db = await getDb();
      await db.runAsync(
        "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        key, value, Date.now(),
      );
    },
    async removeItem(key) {
      const db = await getDb();
      await db.runAsync("DELETE FROM kv WHERE key = ?", key);
    },
  };
  ```

### Touched files

These stores swap their `createJSONStorage(() => AsyncStorage)` to
`createJSONStorage(() => sqliteKv)`. Bare-AsyncStorage call sites (the seven
files that don't go through Zustand persist) get rewritten to use the same
adapter via a tiny wrapper that exposes `getItem`/`setItem`/`removeItem`.

```
src/state/pinned-sessions.ts
src/state/session-tags.ts
src/state/reasoning-collapse.ts
src/state/recent-searches.ts
src/state/todos.ts
src/state/voice-settings.ts
src/state/notifications-inbox.ts
src/state/dev-settings.ts
src/theme/ThemeProvider.tsx
app/_layout.tsx                          (boot diagnostics)
app/(app)/(chats)/search.tsx             (search history)
app/(app)/(settings)/appearance.tsx
app/(app)/(settings)/notifications.tsx
app/(app)/(settings)/voice.tsx
app/(app)/(settings)/toolsets.tsx
app/(app)/(settings)/diagnostics.tsx
src/search/useSearch.ts
```

### Acceptance

- After Phase 6's migration runs, every store visibly reads its prior value
  on cold start.
- Toggling a Zustand-backed setting updates `kv` immediately
  (`SELECT * FROM kv WHERE key = '<store-key>'`).

### Edge cases

- **Keys with sensitive data**: none of these should hold secrets, but audit
  before swap. Anything that looks like a token or refresh string moves to
  SecureStore instead.
- **Race on first boot before migration runs**: Phase 6's migration runs
  inside `getDb()` initialisation, BEFORE any store hydrates. Order is
  enforced by awaiting `getDb()` in `_layout.tsx`.

---

## Phase 4 — Native `pending_mutations` table (2h)

Replace the Zustand-persisted queue with a typed table. Lets us atomically
dequeue (claim a row, run, delete) without round-tripping a giant JSON blob.

### Files

- `src/state/pending-mutations.ts` — REWRITE. Same public API
  (`enqueue`, `remove`, `bumpRetry`, `clearAll`, etc.) but reads/writes
  the `pending_mutations` table directly.
- `src/ws/mutation-drainer.ts` — UNCHANGED logic, but switch to row-by-row
  dequeue: `SELECT ... ORDER BY enqueued_at ASC LIMIT 1`, run, `DELETE` on
  success or `UPDATE retries=retries+1` on failure.

### Schema reference

Already created in Phase 1. One row per queued mutation. `kind` is the
discriminator (`session.archive`, `session.rename`, ...). `payload` is JSON.

### Acceptance

- Airplane on → archive a chat → row appears in `pending_mutations`.
- Airplane off → drainer fires → row deleted on success.
- Force-quit during drain → restart leaves the row intact, drain resumes.

### Edge cases

- **Drain concurrency**: drainer is single-threaded by design. If a future
  feature wants parallel drain, add a `claimed_at` column and lock per row.
- **Schema additions**: adding fields like `priority` later is a new
  migration. Don't alter `pending_mutations` columns in place.

---

## Phase 5 — Native `pending_sends` table (2h)

Same treatment for the chat send queue.

### Files

- `src/state/pending-sends.ts` — REWRITE around the typed table.
- The optimistic-bubble rendering in `chat/[id].tsx` still reads from the
  store hook; the store wraps SQL queries the same way Phase 4 does for
  mutations.

### Acceptance

- Send while offline → row in `pending_sends` with `status='queued'`.
- Reconnect → drainer flips to `status='sending'`, then deletes on success.
- Per-session cap of 50 enforced via
  `DELETE FROM pending_sends WHERE session_id = ? AND id NOT IN (
     SELECT id FROM pending_sends WHERE session_id = ? ORDER BY enqueued_at DESC LIMIT 50
   );`

### Edge cases

- **Attachments**: stored as JSON (file URIs, mime, sizes). The actual file
  bytes stay where they are on disk until the send lands. If the user
  clears app data, dangling URIs in `pending_sends` would 404 on send —
  drain handler should detect that and mark `status='failed'` with a clear
  error.

---

## Phase 6 — One-shot migration from AsyncStorage (1.5h)

Runs once on first launch of the SQLite build. Reads each known
AsyncStorage key, writes to its new home, deletes the source.

### Files

- `src/db/migrate-from-async-storage.ts` — NEW. The migration manifest +
  driver function `runAsyncStorageMigration(): Promise<void>`.
- `src/db/sqlite.ts` — call the migrator after the SQL migrations finish,
  gated by a `meta.migrated_v1` flag.

### Manifest shape

```ts
type AsyncStorageMigrationEntry =
  | { source: string; target: { kind: "kv"; key?: string } }
  | { source: string; target: { kind: "rq_cache" } }
  | { source: string; target: { kind: "skip"; reason: string } };

const MIGRATION_V1: AsyncStorageMigrationEntry[] = [
  { source: "hermes.rq.cache.v1", target: { kind: "rq_cache" } },
  { source: "chat.pending-mutations.v1", target: { kind: "skip", reason: "rebuilt-from-scratch on first SQLite boot; queue is ephemeral" } },
  { source: "chat.pending-sends.v1",     target: { kind: "skip", reason: "same as pending-mutations" } },
  { source: "chat.pinned-sessions.v1",   target: { kind: "kv" } },
  { source: "chat.session-tags.v1",      target: { kind: "kv" } },
  { source: "chat.reasoning-collapse.v1",target: { kind: "kv" } },
  { source: "chat.recent-searches.v1",   target: { kind: "kv" } },
  { source: "chat.voice-settings.v1",    target: { kind: "kv" } },
  { source: "chat.inbox.v1",             target: { kind: "kv" } },
  { source: "chat.dev-settings.v1",      target: { kind: "kv" } },
  { source: "chat.theme.v1",             target: { kind: "kv" } },
  // …all keys from the inventory above
];
```

The TanStack cache deserves special handling: rather than parse the
single-blob format and split into per-query rows, we just throw it away and
let the next refetch repopulate. Reason: shape inflexibility — every minor
TanStack version changes its dehydrated layout, and the migration would
need to track every variant. Cheaper to refresh from network.

### Driver

```ts
export async function runAsyncStorageMigration(): Promise<void> {
  const db = await getDb();
  const flag = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM meta WHERE key = 'migrated_v1'",
  );
  if (flag?.value === "done") return;

  for (const entry of MIGRATION_V1) {
    try {
      const raw = await AsyncStorage.getItem(entry.source);
      if (raw === null) continue;
      switch (entry.target.kind) {
        case "kv":
          await sqliteKv.setItem(entry.source, raw); break;
        case "rq_cache":
          /* skip: refetch on demand */ break;
        case "skip":
          /* drop */ break;
      }
      await AsyncStorage.removeItem(entry.source);
    } catch (err) {
      console.warn("[migrate]", entry.source, err);
      // Don't throw — partial migration is acceptable; the user keeps the
      // shipped behaviour for missed keys until they retry.
    }
  }

  await db.runAsync(
    "INSERT INTO meta (key, value) VALUES ('migrated_v1', 'done')",
  );
}
```

### Acceptance

- Run the AsyncStorage build, populate stores, kill app, install the SQLite
  build over it. On first boot:
  - Stores read from SQLite, values match what was set in the prior build.
  - AsyncStorage keys for migrated stores are gone.
  - `meta.migrated_v1 = 'done'`.
- Subsequent boots: migration is a no-op (early return on flag).

### Edge cases

- **Missed key**: a Zustand store added after the manifest was written
  silently keeps reading from AsyncStorage. Mitigation: a `__DEV__`-only
  audit step that lists all `AsyncStorage.getAllKeys()` after migration and
  warns about any leftovers.
- **Partial migration crash**: per-entry try/catch + flag-only-after-loop
  means a crash mid-migration replays the whole loop next boot. Each entry
  is idempotent (writes overwrite, removes are safe on missing keys).
- **User downgrades to AsyncStorage build**: their data is gone (we deleted
  the source keys). Document: SQLite migration is one-way.

---

## Phase 7 — Storage hygiene + introspection (1.5h)

### Pruning

On boot, run a hygiene pass inside the same DB open transaction:
```sql
DELETE FROM rq_cache WHERE updated_at < ?;            -- maxAge
DELETE FROM pending_mutations WHERE retries >= 5;     -- give up
DELETE FROM pending_sends WHERE retries >= 5;
```
Plus per-session caps from Phase 5.

### Diagnostics surface

`app/(app)/(settings)/diagnostics.tsx` gets a "Storage" card:
- Total DB file size (`expo-file-system` stat).
- Row counts per table.
- "Vacuum" button → `VACUUM` in a transaction.
- "Clear cache" → `DELETE FROM rq_cache` only.
- "Reset all queues" → `DELETE FROM pending_mutations; DELETE FROM pending_sends;`
  (existing button — point at SQL).
- "Wipe everything" (dangerous, hidden behind confirmation) → close DB,
  delete file, reopen and re-run migrations. Effectively a fresh install
  for cache/state but auth survives in SecureStore.

### Acceptance

- DB stays under ~10 MB at typical usage with maxPages=3.
- Vacuum reclaims space after a heavy purge.
- "Clear cache" wipes `rq_cache` only; pending queues + Zustand state untouched.

### Edge cases

- **Vacuum during streaming**: `VACUUM` requires no other DB connection.
  We hold a single connection; it'll just block writes briefly. Make the
  button blocking with a spinner, ≤2s typical.

---

## Phase 8 — Manual test pass (1h)

| Scenario | Expected |
|---|---|
| Cold start with empty DB | Migrations run, schema_version=1, all stores default-empty |
| Cold start after AsyncStorage upgrade | Migrations + AsyncStorage migration run; pinned, themes, dev-settings all match prior values |
| Cold start with airplane on | Sessions list paints from `rq_cache`; banner offline |
| Send while offline | Row appears in `pending_sends`, optimistic bubble rendered |
| Archive while offline | Row in `pending_mutations`, list updates optimistically |
| Reconnect | Both queues drain; rows deleted on success |
| Force-quit mid-drain | Reopen → queues intact → drain resumes |
| Permanent failure (3 retries) | Diagnostics surfaces; row stays until manual retry/discard |
| Bump `PERSIST_BUSTER` | `rq_cache` cleared on next boot; queues + kv untouched |
| Bump schema version | Migration runs once on next boot; `schema_version` updates |
| Wipe-everything | DB file gone, reopens fresh, auth survives |
| 500-session stress | Cold start <1.5s, no UI jank during scroll |

---

## Risks + open questions

- **expo-sqlite under bundle splitting / Hermes engine**: confirm Phase 0
  on a clean dev-client rebuild; `expo-sqlite` requires native code, so the
  bare app build flow needs a fresh `eas build` after install.
- **Custom TanStack persister edge cases**: the most risky module. Validate
  by snapshotting `client.dehydrate()` from the AsyncStorage build, feeding
  it into the new persister's `restoreClient`, and asserting query keys
  round-trip.
- **Concurrent persist + restore on cold start**: PersistQueryClientProvider
  guards this, but if any code outside the provider calls
  `queryClient.setQueryData` during hydrate it can race. Audit before ship.
- **Schema versioning discipline**: every shape change adds a migration
  forever. Document in a release-checklist note alongside `PERSIST_BUSTER`.
- **Storage on iOS device backups**: `data/` lives in
  `Library/Application Support/SQLite/`. iCloud backup includes it. Consider
  setting `NSURLIsExcludedFromBackupKey` for the DB file if cache+queue
  shouldn't roam — usually we WANT them backed up so reinstall preserves
  state. Confirm intent.
- **Migration determinism**: write each migration as pure SQL, no JS-side
  conditional logic. Easier to reason about + replay.
- **AsyncStorage downgrade**: documented as one-way. If we ever need a
  rollback, a separate "export to AsyncStorage" path would have to be
  written; not in scope.

---

## Total estimate

| Phase | Time |
|---|---|
| 0 — Spike + deps | 45 min |
| 1 — DB module + migrations | 2h |
| 2 — TanStack SQLite persister | 3h |
| 3 — Zustand `sqliteKv` adapter | 1.5h |
| 4 — `pending_mutations` table | 2h |
| 5 — `pending_sends` table | 2h |
| 6 — AsyncStorage → SQLite migration | 1.5h |
| 7 — Storage hygiene + diagnostics | 1.5h |
| 8 — Manual test pass | 1h |
| **Total** | **~15h** |

Cuts if needed:
- Skip Phase 4–5 (typed queue tables) → keep queues in `kv` rows. Saves
  ~3h, gives up atomic dequeue and per-row indexing. Acceptable for v1
  if queue volume stays low.
- Skip Phase 7 (introspection extras) → ship without diagnostics card.
  Saves ~1h. Hygiene pruning still happens on boot.
- Cut version: ~10h, covers "all persistence in SQLite, queues stay in kv".
