# Chat history pagination — phase by phase

**Goal:** add `limit`/`before`/`around` pagination to the gateway's
`GET /sessions/:id/messages` so the mobile app loads chat history in pages
instead of all-at-once. Eliminates the deep-link flicker on old messages
and gates long sessions from getting slow on cold open.

**Architecture:** gateway-only change. Hermes agent is untouched (it has its
own LLM-context compactor — separate concern). The gateway's `chat_history`
SQLite already has `(app_session_id, id)` indexed → range queries are O(log n).

**WS streaming:** untouched. New messages flow through `chat-store` via WS
events as today. Pagination only affects the cold REST load path.

**Scope deferred:** automated tests (manual test only per user).

---

## Locked decisions

1. **Page size: 50 messages per page.** Bigger than typical chat (~20) so the
   user rarely sees a load while scrolling, smaller than today's "all at once"
   so cold open is fast for long sessions.

2. **Around-window split: 25 before + 25 after target.** Symmetric. If target
   is near top/bottom of the session, the window is shifted to fit (still
   returns up to 50 rows).

3. **Response shape:** `{ rows: HistoryRow[], hasBefore: bool, hasAfter: bool }`.
   Tells the client when to stop fetching upward / downward.

4. **Replace existing endpoint** — no v2/legacy split. Single-tenant deploy.

5. **Default behavior with no params** = latest 50 (same effective UX as today
   for short sessions). `hasBefore` is true if older history exists.

6. **Streaming integration:** when a new WS event arrives via `chat-store`, the
   "live" portion of the chat (chat-store events) layers on top of the latest
   loaded page. No backend round-trip for new messages.

---

## Phase 0 — Spike (30 min) — OPTIONAL

Validate the SQL plan + FlashList anchoring before committing to the full
implementation. Two questions to answer:

1. Does `WHERE app_session_id=? AND id BETWEEN ? AND ? ORDER BY id LIMIT ?`
   actually use the existing index? `EXPLAIN QUERY PLAN` should show
   `SEARCH chat_history USING INDEX chat_history_session_id_idx`.
2. Does FlashList v2 with `maintainVisibleContentPosition` correctly preserve
   the user's scroll position when older items prepend to `data`?

Skip if confident. Acceptance: pasted EXPLAIN output confirming index use,
plus a 5-line test page proving viewport stability after a prepend.

---

## Phase 1 — Backend: paginated /messages endpoint (1-2h)

### `backend/src/ws/chat-history.ts`

Extend `loadHistory` (or add `loadHistoryWindow`):

```ts
export interface LoadHistoryOpts {
  limit?: number;     // default 50, capped at 100
  before?: number;    // chat_history.id; returns rows where id < before
  around?: number;    // chat_history.id; returns N/2 before + N/2 after
}

export interface LoadHistoryResult {
  rows: HistoryRow[];     // always sorted ascending by id
  hasBefore: boolean;     // true when older rows exist beyond returned set
  hasAfter: boolean;      // true when newer rows exist beyond returned set
}

export async function loadHistoryWindow(
  db: Db,
  appSessionId: string,
  opts?: LoadHistoryOpts,
): Promise<LoadHistoryResult>;
```

SQL strategy:

- **No params:** `SELECT * FROM chat_history WHERE app_session_id=? ORDER BY id DESC LIMIT ?` then `.reverse()` in JS to ascending. `hasBefore` = (returned count == limit).
- **`?before=N`:** `SELECT * ... WHERE app_session_id=? AND id < ? ORDER BY id DESC LIMIT ?` then reverse. `hasBefore` = (returned count == limit). `hasAfter` = always true (caller already has newer content).
- **`?around=N`:** Two queries (cheaper than complex single SQL):
  - `SELECT * WHERE app_session_id=? AND id <= around ORDER BY id DESC LIMIT N/2+1` → reverse
  - `SELECT * WHERE app_session_id=? AND id > around ORDER BY id ASC LIMIT N/2`
  - Concat. `hasBefore` = (left side hit limit). `hasAfter` = (right side hit limit).

`hasBefore` is the trigger for the frontend's scroll-up fetch; `hasAfter` is
informational (won't drive UX in v1 — chat is anchored to bottom anyway).

### `backend/src/routes/sessions.ts`

Update the `GET /sessions/:id/messages` handler:

- zod-parse `limit?`, `before?`, `around?` from `request.query` with `z.coerce.number().int().positive()`.
- Reject if both `before` and `around` set (400 invalid_params).
- Cap `limit` to 100; default 50.
- Call `loadHistoryWindow` with parsed params.
- Return `{ rows, hasBefore, hasAfter }`.

### Acceptance criteria

- `curl /sessions/X/messages` returns latest 50 + `hasBefore: true` (when session has 51+ rows)
- `curl /sessions/X/messages?before=100` returns rows where `id < 100`, max 50
- `curl /sessions/X/messages?around=50` returns ~25 either side of id=50
- Both `before` and `around` together → 400
- Sub-10ms p99 on 10k-row sessions (existing index, range scan only)

---

## Phase 2 — Frontend API client (30 min)

### `frontend/src/api/sessions.ts`

```ts
export interface MessagesPage {
  rows: HistoryDto[];
  hasBefore: boolean;
  hasAfter: boolean;
}

export interface GetMessagesOpts {
  limit?: number;
  before?: number;
  around?: number;
}

export async function getMessages(
  id: string,
  opts?: GetMessagesOpts,
): Promise<MessagesPage>;
```

### `frontend/src/api/types.ts`

Adjust `HistoryResponse` → import `MessagesPage` (keep the old type as an alias
during the migration, or just replace at every call site since the codebase is
small).

### Acceptance

- `pnpm typecheck` clean
- All existing call sites updated to `.rows` access

---

## Phase 3 — Chat screen: useInfiniteQuery + scroll-up (2-3h)

### `frontend/app/(app)/(chats)/chat/[id].tsx`

Replace the `useQuery` for messages with `useInfiniteQuery`:

```ts
const messagesQuery = useInfiniteQuery({
  queryKey: ["session-messages", sessionId],
  initialPageParam: undefined as { before?: number; around?: number } | undefined,
  queryFn: ({ pageParam }) => getMessages(sessionId, { ...pageParam, limit: 50 }),
  getNextPageParam: (last) => last.hasBefore
    ? { before: last.rows[0]?.id }
    : undefined,
  staleTime: 30_000,
  // ...
});
```

**Note:** "next page" semantically = "older history" (older first), since the
chat is anchored to bottom. There's no `getPreviousPageParam` because the WS
stream already delivers newer content.

### Scroll-up trigger

FlashList exposes `onStartReached` (v2). Wire it to `fetchNextPage()`:

```tsx
<FlashList
  onStartReached={() => {
    if (!messagesQuery.isFetchingNextPage && messagesQuery.hasNextPage) {
      void messagesQuery.fetchNextPage();
    }
  }}
  onStartReachedThreshold={0.3}
  // ...
/>
```

### Viewport stability

When a new page prepends, FlashList must preserve the user's visual position.
`maintainVisibleContentPosition` in v2 already supports `minIndexForVisible: 1`
or similar — verify in the spike or Phase 0.

### Loading indicator at top

Render a small spinner above the list when `isFetchingNextPage`. Use
`ListHeaderComponent` so it scrolls with the content.

### Flatten pages → rows

```ts
const allRows = useMemo(
  () => messagesQuery.data?.pages.flatMap((p) => p.rows) ?? [],
  [messagesQuery.data],
);
```

This becomes the input to `historyRows` (existing transformation pipeline).

### Acceptance

- Open a session with 200+ rows → only latest 50 load on cold open
- Scroll to top → next 50 load, viewport stays stable
- Continue scrolling up → keeps loading until `hasBefore: false`
- Spinner appears at top during fetch, disappears when done
- New WS events still appear at bottom (chat-store unchanged)
- Typecheck clean

---

## Phase 4 — Deep-link with around-cursor (1h)

### Update Phase 6's flow

When the chat opens with `?messageId=N`:

1. The `useInfiniteQuery`'s `initialPageParam` is set to `{ around: N }`.
2. FlashList mounts with the around-window already loaded — target message
   is guaranteed to be in the initial page.
3. On first paint, compute `targetIndex` from the loaded rows.
4. Pass `initialScrollIndex={targetIndex}` to FlashList.
5. Disable `startRenderingFromBottom` for the deep-link case (no bottom anchor).
6. Existing flash-tint effect runs as today.

### Implementation sketch

```ts
const initialPageParam = useMemo(
  () => targetMessageId ? { around: targetMessageId } : undefined,
  [targetMessageId],
);

// In useInfiniteQuery:
initialPageParam,

// In FlashList:
initialScrollIndex={targetMessageId != null ? computedTargetIdx : undefined}
maintainVisibleContentPosition={{
  startRenderingFromBottom: targetMessageId == null,
  autoscrollToBottomThreshold: 0.2,
}}
```

### Acceptance

- Tap a search result for an OLD message (50+ rows back) → chat opens directly
  positioned at that message, no flicker, no animated long scroll
- Flash-tint highlights the target for ~1500ms (Phase 6 behavior)
- Loading either direction works after landing — scroll up extends with `before`,
  WS streaming extends at bottom

---

## Phase 5 — Polish + edge cases (1h)

### Jump-to-latest button

When the user has paginated up and is far from the bottom, show a floating
button "Jump to latest" that calls `flatListRef.current?.scrollToEnd({
animated: true })`. Reuse the existing accent button styling.

Trigger condition: scroll position > 1 viewport away from end. Use
`onScroll` + a ref-based threshold (don't make it state to avoid re-render
churn).

### Edge cases to handle

- **Session with < 50 messages:** `hasBefore: false`, no scroll-up trigger fires.
  Default UX same as today.
- **Deep-link target deleted from DB:** `around=<deleted_id>` returns the
  rows around where it would have been. Effect's `findIndex` returns -1,
  graceful no-op (Phase 6's existing behavior).
- **Rapid scroll-up beyond available pages:** TanStack Query dedupes
  in-flight `fetchNextPage` calls. `isFetchingNextPage` guards against
  re-firing.
- **Session switch mid-fetch:** `useInfiniteQuery` keyed by sessionId, so a
  switch invalidates the query and starts fresh.

### Acceptance

- Jump-to-latest button appears when scrolled up > 1 viewport
- Tap → smooth scroll to bottom; button hides
- Long sessions (1000+ messages) cold-open in < 200ms

---

## Risks & open questions

- **`maintainVisibleContentPosition` + page prepend:** FlashList v2's behavior
  here isn't trivial. Phase 0 spike validates. If it doesn't preserve
  position, fallback is to compute the offset delta manually before/after
  the prepend and call `scrollToOffset`.
- **`onStartReached` + `startRenderingFromBottom: true`:** these may interact
  weirdly. Phase 0 should test.
- **Initial render with `initialScrollIndex` outside the loaded data:**
  shouldn't happen (around-window guarantees inclusion) but worth a guard.

---

## Total estimate

| Phase | Time |
|---|---|
| 0 — Spike (optional) | 30 min |
| 1 — Backend | 1-2h |
| 2 — API client | 30 min |
| 3 — useInfiniteQuery + scroll-up | 2-3h |
| 4 — Deep-link integration | 1h |
| 5 — Polish | 1h |
| **Total** | **6-8h** |
