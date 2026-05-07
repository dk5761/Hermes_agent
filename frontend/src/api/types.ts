// API DTOs mirroring backend response shapes (gateway is source of truth).
// Hermes upstream payloads passthrough additional fields; we model only what
// the app actually consumes and keep the rest as `unknown`.

export interface AuthUser {
  id: string;
  username: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: string | number;
  user: AuthUser;
}

export interface RefreshResponse {
  accessToken: string;
  // Rotation: gateway returns a fresh refresh token on every successful
  // /auth/refresh, with a brand-new TTL window. Old token is revoked
  // server-side. Both fields are present on every successful refresh
  // response from this gateway version forward.
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

export interface SessionDto {
  id: string;
  hermesSessionId: string | null;
  title: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  preview: string | null;
  // Per-session model override. Both null = use the global default.
  modelOverride: string | null;
  providerOverride: string | null;
  // Lineage: app-session id of the parent if this row was created via
  // POST /sessions/:id/branch. null for organically-created sessions.
  parentAppSessionId: string | null;
}

/**
 * Response shape for POST /sessions/:id/branch. The new session inherits the
 * parent's chat history via Hermes' /branch slash command. `hermesSessionId`
 * may be null briefly between the slash-command parse and the DB write —
 * callers should treat it as eventually consistent.
 */
export interface BranchSessionResponse {
  id: string;
  title: string;
  hermesSessionId: string | null;
  parentId: string;
}

export interface SessionsListResponse {
  sessions: SessionDto[];
}

export interface CreateSessionResponse {
  id: string;
  title: string | null;
  hermesSessionId: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

// Canonical chat-history row from the gateway. Permanent (never swept).
// Each row's payload depends on `kind` — see backend src/ws/chat-history.ts.
export type HistoryKind =
  | "user.message"
  | "assistant.message"
  | "tool.call"
  | "reasoning"
  | "approval.request"
  | "clarify.request"
  | "sudo.request"
  | "secret.request"
  | "error";

export interface HistoryRow {
  id: number;
  kind: HistoryKind;
  createdAt: number;
  payload: Record<string, unknown>;
  /**
   * Relative URL path like `/voice-blobs/voice/<sha>.m4a`. Present only on
   * `user.message` rows that carry a voice memo. Absent (undefined) for
   * text-only messages — treat as null for rendering purposes.
   */
  audioBlobUrl?: string;
  /** Total voice memo duration in milliseconds. Present when audioBlobUrl is set. */
  audioDurationMs?: number;
  /** "transcribing" | "completed" | "failed". Present when audioBlobUrl is set. */
  transcriptionStatus?: string;
  /** Error detail when transcriptionStatus === "failed". */
  transcriptionError?: string | null;
  /** Waveform data: 80 normalized floats (0..1). Null for old rows or failed extraction. */
  audioPeaks?: number[] | null;
}

/**
 * Paginated history page returned by GET /sessions/:id/messages.
 * `rows` is always sorted ascending by id (oldest first).
 * `hasBefore` drives infinite-scroll-up; `hasAfter` is informational
 * (the WS stream is the source of newer content, not a fetch).
 */
export interface MessagesPage {
  rows: HistoryRow[];
  hasBefore: boolean;
  hasAfter: boolean;
}

/** @deprecated Use {@link MessagesPage}. Kept as a one-version alias. */
export type HistoryResponse = MessagesPage;

// Attachment kinds the gateway recognizes; "file" is reserved for future
// generic types (Phase 4 only persists image and pdf).
export type AttachmentKind = "image" | "pdf" | "file";

export interface AttachmentDTO {
  id: string;
  kind: AttachmentKind;
  mime: string;
  sizeBytes: number;
  sha256: string;
  originalName: string | null;
  hasThumb: boolean;
  extractedTextPreview: string | null;
  createdAt: number;
}

// Cron — Hermes-shaped job (jobs.json), augmented with gateway notify pref.
// Hermes exposes many fields; we narrow to what the UI consumes and keep the
// rest tolerable via index signature so backend payload tweaks don't break TS.

export interface CronSchedule {
  kind?: string;
  display?: string;
  [key: string]: unknown;
}

export interface CronRepeatInfo {
  times: number | null;
  completed: number;
}

export type CronJobState = "scheduled" | "running" | "paused" | "completed" | "failed" | string;
export type CronLastStatus = "success" | "error" | "skipped" | string | null;

export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  schedule: CronSchedule;
  schedule_display: string;
  repeat: CronRepeatInfo;
  enabled: boolean;
  state: CronJobState;
  paused_at: string | null;
  paused_reason: string | null;
  created_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: CronLastStatus;
  last_error: string | null;
  last_delivery_error: string | null;
  deliver: string | null;
  origin: unknown;
  enabled_toolsets: string[] | null;
  workdir: string | null;
  model: string | null;
  provider: string | null;
  base_url: string | null;
  skill: string | null;
  skills: string[] | null;
  script: string | null;
  context_from: string[] | null;
  notifyOnComplete: boolean;
  // Permissive fallback for fields we don't model explicitly.
  [key: string]: unknown;
}

export interface CronJobsResponse {
  jobs: CronJob[];
}

export interface CronJobResponse extends CronJob {}

export interface CronOutputSummary {
  id: string;
  jobId: string;
  createdAt: number;
  preview?: string | null;
}

export interface CronOutputsResponse {
  outputs: CronOutputSummary[];
}

export interface CronOutputDetail {
  id: string;
  jobId: string;
  createdAt: number;
  content: string;
}

export interface CronNotifyPref {
  jobId: string;
  notifyOnComplete: boolean;
  lastSeenOutputId: string | null;
  updatedAt: number;
}

export interface CronNotifyPrefsResponse {
  prefs: CronNotifyPref[];
}

export interface DeviceTokenRegistrationResponse {
  id: string;
}

export interface ApiErrorBody {
  error: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody | string,
  ) {
    super(typeof body === "string" ? body : body.error);
    this.name = "ApiError";
  }
}
