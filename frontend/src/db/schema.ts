/**
 * String constants for SQLite table and column names.
 * Import these instead of repeating magic strings across call sites.
 */

export const TABLES = {
  rqCache: "rq_cache",
  kv: "kv",
  pendingMutations: "pending_mutations",
  pendingSends: "pending_sends",
  meta: "meta",
  schemaVersion: "schema_version",
} as const;

export const COLUMNS = {
  rqCache: {
    queryKey: "query_key",
    state: "state",
    updatedAt: "updated_at",
  },
  kv: {
    key: "key",
    value: "value",
    updatedAt: "updated_at",
  },
  pendingMutations: {
    id: "id",
    enqueuedAt: "enqueued_at",
    retries: "retries",
    lastError: "last_error",
    kind: "kind",
    payload: "payload",
  },
  pendingSends: {
    id: "id",
    sessionId: "session_id",
    enqueuedAt: "enqueued_at",
    text: "text",
    attachments: "attachments",
    status: "status",
    retries: "retries",
  },
  meta: {
    key: "key",
    value: "value",
  },
  schemaVersion: {
    version: "version",
  },
} as const;
