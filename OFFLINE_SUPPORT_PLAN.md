# Offline support — phase by phase

**Goal:** the app paints meaningfully when launched without network. Users see
their last-seen sessions list, recent chat history, and queued sends instead
of empty screens. New writes (send / archive / rename / etc.) are queued and
replay automatically once connectivity returns.

**Architecture summary:**

```
┌─ AsyncStorage ──────────────────────────────────────┐
│  • TanStack Query cache (sessions, messages, ...)   │
│  • pending-sends queue (chat send frames)           │
│  • pending-mutations queue (PATCH/DELETE/POST)      │
│  • persisted Zustand stores (already done)          │
└─────────────────────────────────────────────────────┘
       ↑ rehydrate                        ↓ replay
┌─ Cold start ───────┐         ┌─ NetInfo / WS ──────┐
│  Paint from cache  │         │  Online → drain     │
│  Show stale data   │         │  Offline → queue    │
└────────────────────┘         └─────────────────────┘
```

**Scope:**
- Reads (sessions list + chat history + search) painted from disk on cold start.
- Writes (send + session-level mutations) queued + replayed.
- Manual test only — no automated tests this round.

**Out of scope:**
- True offline-first sync (CRDTs, vector clocks). This is a "best-effort
  cache" approach: stale-while-revalidate.
- Encrypted storage. AsyncStorage on iOS lives in the app sandbox; no
  passphrase prompt for cache today. Document the threat model.

---

## Locked decisions

1. **Persister:** `@tanstack/react-query-persist-client` + `@tanstack/query-async-storage-persister`. Official, no third-party churn.
2. **Storage backend:** AsyncStorage (already a dependency). MMKV would be faster but adds native code; revisit only if perf bottleneck shows up.
3. **Cache key prefix:** `hermes.rq.cache.v1` — bump the version suffix on any shape-breaking API change.
4. **maxAge:** 7 days. Older entries dropped on hydrate.
5. **Selective dehydration:** persist only the queries we care to revive. Auth, push tokens, and ephemeral picker queries are excluded.
6. **Mutation queue:** separate Zustand store (`pending-mutations.v1`), per-mutation type discriminated union. NOT TanStack's built-in mutation persistence — we want explicit control over ordering and dedup.
7. **Network-state hook:** `@react-native-community/netinfo`. Required dep — drives both UI banners and queue drains.
8. **Stale-while-revalidate everywhere:** when online, every cached query refetches in background after first paint.

---

## Phase 0 — Spike + dependency install (30 min)

Install:
```
@tanstack/react-query-persist-client
@tanstack/query-async-storage-persister
@react-native-community/netinfo
```

Validate:
- `pnpm typecheck` clean
- App still cold-starts (no infinite spinner from persister bugs)
- NetInfo reads true/false correctly via `useNetInfo` in a one-line test

Acceptance: deps installed, no build break, NetInfo reachable.

---

## Phase 1 — TanStack Query persistence (1.5h)

### Files

- `frontend/app/_layout.tsx` — swap `<QueryClientProvider>` for `<PersistQueryClientProvider>`.
- `frontend/src/cache/query-persister.ts` — NEW. Exports the configured persister + `dehydrateOptions`.

### Wire-up

```ts
// frontend/src/cache/query-persister.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";

export const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: "hermes.rq.cache.v1",
  throttleTime: 1000, // batch writes — don't hammer disk during streaming
});

export const PERSIST_MAX_AGE = 1000 * 60 * 60 * 24 * 7; // 7 days

// Selective persistence: drop queries that shouldn't be revived from disk.
export const dehydrateOptions = {
  shouldDehydrateQuery: (q: { queryKey: ReadonlyArray<unknown> }) => {
    const k = q.queryKey;
    if (!Array.isArray(k) || k.length === 0) return false;
    const root = k[0];
    // Exclude: auth (security), upload progress (ephemeral), live activity
    // bridge (device-state), provider-keys catalog (re-fetch on demand).
    if (root === "auth") return false;
    if (root === "uploads") return false;
    if (root === "live-activity") return false;
    if (root === "provider-keys") return false;
    return true;
  },
};
```

In `_layout.tsx`:
```tsx
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { persister, PERSIST_MAX_AGE, dehydrateOptions } from "@/cache/query-persister";

<PersistQueryClientProvider
  client={queryClient}
  persistOptions={{
    persister,
    maxAge: PERSIST_MAX_AGE,
    dehydrateOptions,
    buster: "1", // bump to force a one-time cache wipe
  }}
  onSuccess={() => {
    queryClient.resumePausedMutations();
  }}
>
```

### Defaults

Set sensible network-aware defaults on the QueryClient:
```ts
defaultOptions: {
  queries: {
    retry: 2,
    staleTime: 30_000,
    gcTime: 1000 * 60 * 60 * 24 * 7, // match persist age
    refetchOnWindowFocus: false,
    refetchOnReconnect: true, // reconnect → background refresh
    networkMode: "offlineFirst", // serve cache when offline, retry on reconnect
  },
  mutations: {
    networkMode: "offlineFirst",
    retry: 0,
  },
},
```

### Acceptance

- Cold start with airplane mode → sessions list paints last-seen rows from disk.
- Cold start online → list paints from cache, then refreshes in background.
- Bump `buster` → next launch wipes the cache once, then resumes.

### Edge cases

- **Hydrate race**: PersistQueryClientProvider blocks renders until hydrate finishes. Add a brief splash if it takes >500ms. (Default behaviour suspends — wrap in a Suspense fallback.)
- **Corrupt cache**: persister catches JSON parse errors and starts empty. No crash.
- **Big payloads**: per-session chat history caches grow. Phase 2 trims via `maxPages` on infinite queries.

---

## Phase 2 — Trim infinite-query bloat (45 min)

The chat pagination uses `useInfiniteQuery` keyed by session. With 100+ sessions
visited, total cached pages add up. Cap retained pages on disk to ~3 latest
windows per session.

### Change

```ts
// chat/[id].tsx
useInfiniteQuery({
  ...,
  maxPages: 3, // keep only the latest 3 pages in cache; older ones drop on persist
});
```

This affects in-memory and on-disk cache identically — TanStack drops oldest
pages when length > maxPages.

### Acceptance

- Open a chat, scroll up to load 5 pages, leave, return → only the last 3 are
  in cache. The chat still renders the latest 3 pages (which is what's at the
  bottom anyway since chat is bottom-anchored).

### Edge cases

- **Deep-link to old message**: when `?messageId=N` triggers `?around=N`
  fetch, that becomes the latest page in the infinite query, so it persists.
  Older pages get dropped — correct.
- **Active scroll-up at the moment of trim**: TanStack drops from the start
  of the array; the user's viewport is anchored to the bottom, so they don't
  see the drop. If they scroll back up, those pages refetch.

---

## Phase 3 — NetInfo + online-state singleton (1h)

### Files

- `frontend/src/state/network-status.ts` — NEW. Single source of truth for
  "are we online".

### Why a separate store

Multiple consumers want this signal: the queue drainer (Phase 4), the offline
banner (Phase 6), retry buttons. `useNetInfo` works but creates a subscription
per call — better to centralise.

```ts
// frontend/src/state/network-status.ts
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { create } from "zustand";

interface NetworkState {
  online: boolean;
  type: string | null;
  // Last transition timestamp; useful for debouncing retries.
  changedAt: number;
  init: () => () => void; // returns unsubscribe
}

export const useNetworkStatus = create<NetworkState>((set) => ({
  online: true,
  type: null,
  changedAt: Date.now(),
  init: () => {
    const apply = (s: NetInfoState) => {
      const next = !!s.isConnected && s.isInternetReachable !== false;
      set((prev) =>
        next === prev.online ? prev : { online: next, type: s.type, changedAt: Date.now() },
      );
    };
    void NetInfo.fetch().then(apply);
    return NetInfo.addEventListener(apply);
  },
}));
```

Init from `_layout.tsx`:
```tsx
useEffect(() => useNetworkStatus.getState().init(), []);
```

### Acceptance

- Toggle airplane mode → store flips within ~1s.
- Hook usage: `useNetworkStatus(s => s.online)` returns true/false reactively.

### Edge cases

- **Captive portal**: `isConnected: true` but `isInternetReachable: false`. We
  treat that as offline so we don't fire failing requests.
- **First boot before init resolves**: defaults to `true` — assume online.
  The first `NetInfo.fetch()` corrects within ~100ms.
- **iOS vs Android `isInternetReachable`**: on iOS this can return null
  briefly. The `!== false` check treats null as online (innocent until
  proven offline).

---

## Phase 4 — Pending mutations queue (2h)

Reads now revive from cache. Writes that fail offline silently 500 today
(network error → mutation onError → toast). For a real offline experience,
queue mutations and replay on reconnect.

### Scope

Cover only mutation paths the user actually invokes from offline-prone screens:
- `chat.send` — already covered by Phase 5 of the chat-pagination work
  (pending-sends store).
- `archiveSession`, `renameSession`, `deleteSession`
- `setSessionModel`, `setMainModel`
- `tag` add/remove on sessions
- `markRead` / archive on the notifications inbox (these mutate via local
  store anyway — no backend call — skip)

Specifically NOT covered (require careful design, defer):
- Attachment uploads (large + Sharing-plate-style flows; user expects
  immediate feedback)
- `sendCronJobUpdate` (cron schedule edits — rare and acceptable to fail loud)

### Files

- `frontend/src/state/pending-mutations.ts` — NEW. Zustand store with
  AsyncStorage persistence (`chat.pending-mutations.v1`).
- `frontend/src/ws/mutation-drainer.ts` — NEW. Watches network status,
  drains queued mutations on reconnect.

### State

```ts
// Discriminated union — one branch per mutation kind. The mutation kind
// itself is enough to dispatch to the right API client; the payload carries
// only the inputs we'd pass to that client.
export type PendingMutation =
  | { kind: "session.archive"; payload: { sessionId: string; archived: boolean } }
  | { kind: "session.rename"; payload: { sessionId: string; title: string } }
  | { kind: "session.delete"; payload: { sessionId: string } }
  | { kind: "session.setModel"; payload: { sessionId: string; provider: string; model: string } | { sessionId: string; clear: true } }
  | { kind: "session.tagAdd"; payload: { sessionId: string; tag: string } }
  | { kind: "session.tagRemove"; payload: { sessionId: string; tag: string } };

interface PendingMutationsState {
  queue: Array<{
    id: string;            // uuid
    enqueuedAt: number;
    retries: number;
    lastError?: string;
    mutation: PendingMutation;
  }>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  enqueue: (m: PendingMutation) => string;
  remove: (id: string) => void;
  bumpRetry: (id: string, error: string) => void;
}
```

### Drainer

`ws/mutation-drainer.ts`:
- Subscribes to `useNetworkStatus`. On rising edge `online: false → true`,
  drain the queue serially.
- Per item: dispatch to the matching API client (`archiveSession`,
  `renameSession`, etc.).
- On success: remove from queue + invalidate the relevant TanStack query.
- On failure: bump retry count, retry with backoff (1s/5s/30s). Cap at 3.

### Optimistic UI

Each consumer (chat list rename, archive, delete) calls the mutation as today
via TanStack `useMutation` PLUS enqueues to pending-mutations. The TanStack
mutation runs first (provides optimistic onMutate behaviour); the enqueue
is the safety net. On reconnect drainer replays from queue, then dedups
based on the side-effect being already applied (return the mutation with no
visible change).

Simpler version: skip TanStack mutations entirely for the offline-prone
operations. Drive everything through pending-mutations + optimistic
chat-store updates. Pick one approach in implementation; don't mix.

### Acceptance

- Airplane on → archive a chat → list visibly updates (optimistic).
- Toggle airplane off → mutation lands, server state matches.
- Force-quit mid-queue → restart resumes drain on reconnect.

### Edge cases

- **Conflicting mutations**: rename "A" → "B" and rename "A" → "C" while
  offline. Queue preserves order; backend applies both, last write wins.
  Acceptable.
- **Delete then mutate**: delete then rename same session offline. The
  rename will 404 server-side. Drainer detects 404 and silently drops the
  follow-up mutation.
- **Auth expired**: drainer gets 401. Pause the queue, prompt for re-auth
  (existing flow), resume after.
- **Permanent failure** (3 retries hit): toast "Couldn't sync changes"
  and surface a "Pending sync issues" row in Settings → Diagnostics with
  Retry / Discard buttons.

---

## Phase 5 — Cold-start replay path (45 min)

When the app cold-starts:
1. AuthGate hydrates auth from SecureStore.
2. PersistQueryClientProvider hydrates RQ cache from AsyncStorage.
3. `_layout.tsx` initialises NetInfo store.
4. Pending-mutations and pending-sends stores hydrate.
5. **If online at boot**: drainers fire automatically on first `online: true`.
6. **If offline at boot**: stores hydrate, UI paints from cache, drainers
   wait. Banner shows "Offline" state.

### Files

- `frontend/app/_layout.tsx` — order the hydrate steps deterministically.
- Add a tiny diagnostic effect that logs queue lengths post-hydrate (debug
  only, gated by `__DEV__`).

### Acceptance

- Airplane on → kill app → reopen → see sessions list, last open chat
  scrolls cleanly, queued mutations indicator visible in composer/settings.

### Edge cases

- **Hydrate ordering**: don't fire mutation drainer before pending-mutations
  store has hydrated. Drainer should `await` the store's `hydrated: true`
  flag before the first drain.
- **First-launch ever**: no cache, no queue. Just render the empty states
  (login screen if not authed, empty sessions list otherwise).
- **App update with shape change**: bump the cache `buster` AND the per-store
  storage key version on schema changes.

---

## Phase 6 — Offline UI surfacing (1h)

### Surfaces

1. **Global banner**: thin sunken strip below NavBar on all tab roots, shown
   when offline. "Offline — showing cached data". Auto-hides on reconnect with
   a 1.5s "Back online · syncing" celebration before fading.
2. **Per-screen freshness indicator**: tiny "Updated Xm ago" caption under
   list headers, computed from the query's `dataUpdatedAt`.
3. **Composer pill** (already shipped via offline-queue): "N queued".
4. **Settings → Diagnostics**:
   - Pending mutations count + retry button
   - Pending sends count + retry button
   - "Clear cache" → wipes RQ cache
   - "Reset all queues" → drops both queues (confirmation Alert)

### Acceptance

- All tab roots show the banner when offline.
- Tapping the banner opens Diagnostics.
- "Updated Xm ago" reflects the actual `dataUpdatedAt`.

### Edge cases

- **Flicker on slow networks** (online → offline → online within 1s): debounce
  the banner. Show offline only after `online: false` has held for ≥1s.
- **Permanent failure indicator**: when pending-mutations has frames with
  `retries >= 3`, show a destructive-tinted variant of the banner: "X changes
  failed to sync".

---

## Phase 7 — Storage hygiene (45 min)

Cache + queues grow unbounded over time. Add limits + a manual nuke:

### Limits

- TanStack cache: `gcTime: 7d` already trims old entries on next hydrate.
- pending-sends: cap at 50 frames per session (already implemented in Phase
  5 chat-pagination work — verify).
- pending-mutations: cap at 100 entries total. Drop oldest when over.

### Manual purge

Settings → Diagnostics → "Clear cache" button:
- Clears RQ persister (AsyncStorage key)
- Clears chat-store live state
- Doesn't touch auth, pending queues, settings preferences

### Acceptance

- Cache stays under ~5MB after a heavy session of usage.
- Manual purge frees disk; no app crash; next online activity refetches.

### Edge cases

- **Mid-purge crash**: purge is idempotent — running it again completes.
- **User on the chat screen during purge**: in-memory state survives, but
  next background refetch re-fills disk cache. No visible disruption.

---

## Phase 8 — Manual test pass (30 min)

Test matrix:

| Scenario | Expected |
|---|---|
| Cold start online | Sessions list paints instantly from cache, then refreshes |
| Cold start airplane mode | Same paint; banner shows offline |
| Open chat while offline | Last paginated window visible |
| Send while offline | Bubble shows queued status |
| Archive a session while offline | List updates optimistically |
| Toggle airplane off | Banner clears, queues drain, list ack's match |
| Force-quit mid-queue | Reopen → queue still there → drain on reconnect |
| Permanent failure (e.g., bad URL after 3 retries) | Banner turns destructive, Diagnostics surfaces it |
| Bump cache buster | Next launch wipes cache once, repaints |
| Search results offline | Last-seen results from cache |

---

## Risks + open questions

- **AsyncStorage write thrash during streaming**: each query refetch invokes
  the persister. Throttle is set to 1s; verify no JS-thread jank during a
  long assistant turn. If yes, bump throttle or move to MMKV.
- **Sensitive data on disk**: chat content lives in plaintext AsyncStorage.
  iOS sandbox protects against other apps but not against device exfiltration.
  Document. App-lock + privacy veil (already shipped) cover the at-glance
  threat. Encrypted storage = future work.
- **Mutation dedup**: if both the in-flight TanStack mutation AND the queued
  pending-mutation succeed, server sees the same write twice. For
  idempotent ops (archive, rename) this is fine. For non-idempotent ones
  (none in our scope today) we'd need a server-side request id check.
- **maxPages = 3 for infinite chat queries**: a user who scrolls way back,
  exits, returns will have to scroll again to reload those windows. Fine
  for v1; revisit if users complain.
- **Cache schema versioning discipline**: any change to a query's response
  shape requires bumping `buster` on next release. Easy to forget. Add a
  release-checklist note.

---

## Total estimate

| Phase | Time |
|---|---|
| 0 — Spike + deps | 30 min |
| 1 — TanStack persistence | 1.5h |
| 2 — Trim infinite queries | 45 min |
| 3 — NetInfo store | 1h |
| 4 — Pending mutations queue | 2h |
| 5 — Cold-start replay | 45 min |
| 6 — Offline UI surfacing | 1h |
| 7 — Storage hygiene | 45 min |
| 8 — Manual test | 30 min |
| **Total** | **~9h** |

Cuts if needed:
- Skip Phase 4 (mutations queue) → ship reads-only offline. Saves 2h.
- Skip Phase 7 (hygiene) → ship without manual purge. Saves 45min.
- Cut version: ~6h, covers the headline "open the app offline, see your chats".
