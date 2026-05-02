import "dotenv/config";
import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().min(1).default("127.0.0.1"),

    DATABASE_URL: z.string().min(1).default("./data/gateway.db"),

    JWT_SECRET: z.string().min(16, "JWT_SECRET must be >= 16 chars"),
    ACCESS_TOKEN_TTL: z.string().min(1).default("15m"),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

    STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
    STORAGE_LOCAL_ROOT: z.string().min(1).default("./data/blobs"),
    STORAGE_BUCKET: z.string().min(1).default("hermes-mobile-local"),
    STORAGE_SIGNED_URL_SECRET: z.string().min(16, "STORAGE_SIGNED_URL_SECRET must be >= 16 chars"),
    STORAGE_SIGNED_URL_TTL_S: z.coerce.number().int().positive().default(300),

    // S3 / S3-compat (MinIO etc). Required only when STORAGE_PROVIDER=s3.
    STORAGE_REGION: z.string().min(1).optional(),
    STORAGE_ENDPOINT: z
      .string()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined)),
    STORAGE_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
    STORAGE_FORCE_PATH_STYLE: z
      .union([z.literal("true"), z.literal("false")])
      .default("true")
      .transform((v) => v === "true"),
    STORAGE_S3_CACHE_DIR: z.string().min(1).default("./data/cache/materialized"),

    WS_EVENT_RETENTION_HOURS: z.coerce.number().int().positive().default(24),
    WS_EVENT_POSTRUN_GRACE_HOURS: z.coerce.number().int().positive().default(1),

    UPLOAD_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(26214400),
    UPLOAD_MAX_PDF_BYTES: z.coerce.number().int().positive().default(52428800),
    UPLOAD_MAX_OTHER_BYTES: z.coerce.number().int().positive().default(10485760),
    UPLOAD_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(54525952),
    UPLOAD_PROMPT_PDF_PER_FILE_BYTES: z.coerce.number().int().positive().default(30720),
    UPLOAD_PROMPT_PDF_TOTAL_BYTES: z.coerce.number().int().positive().default(51200),

    BOOTSTRAP_USERNAME: z.string().optional(),
    BOOTSTRAP_PASSWORD: z.string().optional(),

    HERMES_LAUNCH_MODE: z.enum(["external", "spawn"]).default("external"),
    HERMES_BASE_URL: z.string().url().default("http://127.0.0.1:9119"),
    HERMES_TOKEN: z.string().optional(),
    HERMES_HOME: z.string().optional(),
    HERMES_PYTHON: z.string().min(1).default("python3"),
    HERMES_AGENT_DIR: z.string().optional(),
    HERMES_PORT: z.coerce.number().int().positive().default(9119),
    HERMES_SPAWN_RESTART_BACKOFF_MS: z.coerce.number().int().positive().default(2000),
    HERMES_SPAWN_RESTART_MAX_BACKOFF_MS: z.coerce.number().int().positive().default(60000),
    HERMES_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

    OCR_ENABLED: z
      .union([z.literal("true"), z.literal("false")])
      .default("true")
      .transform((v) => v === "true"),
    OCR_MAX_PAGES: z.coerce.number().int().positive().default(10),
    OCR_DPI: z.coerce.number().int().positive().default(200),
    OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
    OCR_LANGUAGES: z.string().min(1).default("eng"),
    OCR_PDFTOPPM_BIN: z.string().min(1).default("pdftoppm"),
    OCR_TESSERACT_BIN: z.string().min(1).default("tesseract"),

    // Phase 6: Expo push + cron output watcher.
    // EXPO_ACCESS_TOKEN is optional; only required for high-volume pushes
    // (Expo enforces rate-limits more aggressively without it).
    EXPO_ACCESS_TOKEN: z
      .string()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : undefined)),

    // APNs auth-key credentials for ActivityKit push (Phase: live activity).
    // All four fields must be set for live activity push to work; if any is
    // missing the gateway logs a warning and falls back to "foreground-only"
    // updates (the JS side still drives the activity directly via the
    // bridge while the app is open).
    APNS_KEY_ID: z.string().optional(),
    APNS_TEAM_ID: z.string().optional(),
    APNS_BUNDLE_ID: z.string().optional(),
    // Base64-encoded contents of the .p8 auth key. We accept the raw
    // file contents too — both shapes are decoded in the apns client.
    APNS_KEY_P8: z.string().optional(),
    APNS_USE_SANDBOX: z
      .union([z.literal("true"), z.literal("false")])
      .default("false")
      .transform((v) => v === "true"),
    CRON_OUTPUT_WATCH_ENABLED: z
      .union([z.literal("true"), z.literal("false")])
      .default("true")
      .transform((v) => v === "true"),
    // chokidar awaitWriteFinish poll interval. Higher = lower CPU, slower
    // detection of completed writes.
    CRON_WATCH_POLL_MS: z.coerce.number().int().positive().default(100),

    // Phase 7: rate limiting. Global default is generous; tighter overrides
    // are applied at the route level for /auth/login and /uploads.
    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_UPLOAD_MAX: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_UPLOAD_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

    // Phase 7: cleanup sweepers. Disabling is for tests / first-boot diagnostics.
    CLEANUP_ENABLED: z
      .union([z.literal("true"), z.literal("false")])
      .default("true")
      .transform((v) => v === "true"),
    CLEANUP_ORPHAN_BLOB_AGE_HOURS: z.coerce.number().int().positive().default(24),
    CLEANUP_REFRESH_TOKEN_GRACE_DAYS: z.coerce.number().int().positive().default(7),
    CLEANUP_PUSH_TOKEN_STALE_DAYS: z.coerce.number().int().positive().default(90),
    MATERIALIZE_CACHE_MAX_AGE_DAYS: z.coerce.number().int().positive().default(14),
  })
  .superRefine((env, ctx) => {
    // External mode: token is optional. If empty, the launcher auto-scrapes
    // it from the served HTML at HERMES_BASE_URL/.
    if (env.HERMES_LAUNCH_MODE === "spawn") {
      if (!env.HERMES_AGENT_DIR) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["HERMES_AGENT_DIR"],
          message: "HERMES_AGENT_DIR required when HERMES_LAUNCH_MODE=spawn",
        });
      }
    }
    if (env.STORAGE_PROVIDER === "s3") {
      const required: ReadonlyArray<["STORAGE_REGION" | "STORAGE_ACCESS_KEY_ID" | "STORAGE_SECRET_ACCESS_KEY", string | undefined]> = [
        ["STORAGE_REGION", env.STORAGE_REGION],
        ["STORAGE_ACCESS_KEY_ID", env.STORAGE_ACCESS_KEY_ID],
        ["STORAGE_SECRET_ACCESS_KEY", env.STORAGE_SECRET_ACCESS_KEY],
      ];
      for (const [name, value] of required) {
        if (!value || value.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} required when STORAGE_PROVIDER=s3`,
          });
        }
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
