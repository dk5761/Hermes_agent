import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const refreshTokens = sqliteTable(
  "refresh_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex("refresh_tokens_token_hash_idx").on(t.tokenHash),
    userIdx: index("refresh_tokens_user_idx").on(t.userId),
  }),
);

export const appSessions = sqliteTable(
  "app_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hermesSessionId: text("hermes_session_id"),
    titleOverride: text("title_override"),
    archivedAt: integer("archived_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    userArchivedIdx: index("app_sessions_user_archived_idx").on(t.userId, t.archivedAt),
    hermesSessionIdx: index("app_sessions_hermes_session_idx").on(t.hermesSessionId),
  }),
);

export const messageMeta = sqliteTable(
  "message_meta",
  {
    id: text("id").primaryKey(),
    appSessionId: text("app_session_id")
      .notNull()
      .references(() => appSessions.id, { onDelete: "cascade" }),
    clientMessageId: text("client_message_id").notNull(),
    role: text("role").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    sessionIdx: index("message_meta_session_idx").on(t.appSessionId),
    clientMsgIdx: uniqueIndex("message_meta_session_client_idx").on(t.appSessionId, t.clientMessageId),
  }),
);

export const blobObjects = sqliteTable(
  "blob_objects",
  {
    id: text("id").primaryKey(),
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    originalName: text("original_name"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    objectKeyIdx: uniqueIndex("blob_objects_object_key_idx").on(t.objectKey),
    sha256Idx: index("blob_objects_sha256_idx").on(t.sha256),
    userIdx: index("blob_objects_user_idx").on(t.userId),
  }),
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    appSessionId: text("app_session_id").references(() => appSessions.id, { onDelete: "set null" }),
    blobId: text("blob_id")
      .notNull()
      .references(() => blobObjects.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    thumbBlobId: text("thumb_blob_id").references(() => blobObjects.id, { onDelete: "set null" }),
    derivedTextBlobId: text("derived_text_blob_id").references(() => blobObjects.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    sessionIdx: index("attachments_session_idx").on(t.appSessionId),
    blobIdx: index("attachments_blob_idx").on(t.blobId),
  }),
);

export const derivedArtifacts = sqliteTable(
  "derived_artifacts",
  {
    id: text("id").primaryKey(),
    parentBlobId: text("parent_blob_id")
      .notNull()
      .references(() => blobObjects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    blobId: text("blob_id")
      .notNull()
      .references(() => blobObjects.id, { onDelete: "cascade" }),
    metaJson: text("meta_json"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    parentIdx: index("derived_artifacts_parent_idx").on(t.parentBlobId),
  }),
);

export const wsEvents = sqliteTable(
  "ws_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appSessionId: text("app_session_id")
      .notNull()
      .references(() => appSessions.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    sessionIdIdx: index("ws_events_session_id_idx").on(t.appSessionId, t.id),
    createdAtIdx: index("ws_events_created_at_idx").on(t.createdAt),
  }),
);

// Permanent narrative log per chat — never swept. Mirrors the canonical
// "story" of a conversation: user prompts, assistant final messages, tool
// calls, reasoning blocks, blocking requests, errors, attachment refs.
// Streaming-only event types (delta/start/progress) are NOT stored here —
// they live in ws_events for short-lived replay only.
export const chatHistory = sqliteTable(
  "chat_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appSessionId: text("app_session_id")
      .notNull()
      .references(() => appSessions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    sessionIdIdx: index("chat_history_session_id_idx").on(t.appSessionId, t.id),
  }),
);

export const pushTokens = sqliteTable(
  "push_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expoToken: text("expo_token").notNull(),
    platform: text("platform").notNull(),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (t) => ({
    expoTokenIdx: uniqueIndex("push_tokens_expo_token_idx").on(t.expoToken),
    userIdx: index("push_tokens_user_idx").on(t.userId),
  }),
);

export const cronPrefs = sqliteTable(
  "cron_prefs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hermesJobId: text("hermes_job_id").notNull(),
    notifyOnComplete: integer("notify_on_complete").notNull().default(0),
    lastSeenOutputId: text("last_seen_output_id"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    userJobIdx: uniqueIndex("cron_prefs_user_job_idx").on(t.userId, t.hermesJobId),
    jobIdx: index("cron_prefs_job_idx").on(t.hermesJobId),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;
export type AppSession = typeof appSessions.$inferSelect;
export type BlobObject = typeof blobObjects.$inferSelect;
export type WsEvent = typeof wsEvents.$inferSelect;

export const _sqlPragma = sql`PRAGMA foreign_keys = ON;`;
