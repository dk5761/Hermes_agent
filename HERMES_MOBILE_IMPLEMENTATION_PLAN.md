# Hermes Mobile App Implementation Plan

## Goal

Build a personal Expo React Native app for controlling a Hermes agent running on a VPS. Hermes itself must stay private on the VPS. A custom gateway will expose a mobile-safe HTTPS/WebSocket API for login, sessions, chat, streaming tool progress, uploads, cron visibility, and notifications.

## Target Architecture

```text
Expo mobile app
  -> HTTPS REST + WSS
  -> Hermes Mobile Gateway on VPS
  -> Hermes API bound to 127.0.0.1
  -> Hermes state.db / cron jobs / upload processing
```

The gateway owns public access, authentication, app-specific sessions, uploads, file processing, push notifications, and all mobile compatibility concerns. Hermes remains a private local dependency behind the gateway.

## Deployment Shape

```text
public internet
  -> Caddy on :443
  -> Hermes Mobile Gateway on 127.0.0.1:{gateway_port}
  -> Hermes API or Hermes adapter on 127.0.0.1:{hermes_or_adapter_port}
```

Only Caddy should listen publicly. The Node gateway, Hermes API server, any optional Python sidecar, MinIO, and internal admin/debug ports should bind to loopback or a private Docker network.

## Hermes Contract Verification

Before building the gateway adapter, verify the exact Hermes integration surface in the checked-out `hermes-agent/` version. Do not assume every required capability is available as a stable HTTP endpoint.

Known likely surfaces to verify:

- OpenAI-compatible/API-server endpoints for chat or runs.
- Streaming event endpoint shape and exact event names.
- Session list/history/title APIs, or whether sessions must be read from Hermes SQLite.
- Cron job list/output APIs, or whether cron must be read from `~/.hermes/cron/jobs.json` and output files.
- Image input support and request-size limits.
- Whether file/PDF inputs are rejected and must be transformed by the gateway.

The gateway should use Hermes HTTP endpoints when they are stable and sufficient. If a capability is not exposed over HTTP, the gateway can use a narrow adapter that reads Hermes-owned files/SQLite or invokes Hermes CLI/library code directly. This adapter boundary should be isolated so future Hermes API changes do not leak into the mobile app.

If Hermes only exposes the needed functionality as Python library code, prefer a small FastAPI sidecar bound to `127.0.0.1` over repeated Node shell-outs. The Node gateway then calls the sidecar over loopback. Phase 0 should decide between:

- Direct Hermes HTTP API.
- Node adapter reading files/SQLite for narrow read-only features.
- FastAPI sidecar wrapping Hermes Python library calls.
- CLI/shell-out only for low-frequency operations where startup cost is acceptable.

## MVP Scope

The first version should include:

- Single personal login with refresh-token based sessions.
- App-only session list, session creation, session rename, and session delete/archive.
- Text chat with real-time streaming.
- Real-time tool progress events in the chat UI.
- Image upload, thumbnail generation, local app caching, and Hermes-compatible image handling.
- PDF/file upload compatibility at the gateway layer, with basic text extraction.
- Basic cron list/detail/output views.
- Expo push token registration, with cron notifications prepared for the next phase.

Out of scope for MVP:

- Multi-user/team support.
- Cloudflare relay infrastructure.
- Complex file RAG.
- Full iPhone Shortcuts/actions integration.
- App Store polish, subscriptions, or public SaaS behavior.

## Gateway Stack

Use:

- Node.js 22 + TypeScript.
- Fastify for HTTP APIs.
- `@fastify/websocket` for live chat events.
- Drizzle ORM.
- SQLite for MVP metadata.
- Zod for request/response validation.
- Password hashing for the single personal account, preferably Argon2id if it is easy to install on the VPS.
- JWT access tokens plus a long-lived refresh token stored in Expo SecureStore. Full refresh-token rotation is optional for MVP.
- `sharp` for image normalization, compression, and thumbnails.
- PDF extraction through a Node package or a small Python helper.
- AWS S3 SDK for the storage abstraction, even when the first provider is local.
- Expo Server SDK for push notifications in a later phase.
- Caddy for HTTPS reverse proxy.
- systemd or Docker Compose for deployment.

## Mobile App Stack

Use:

- Expo Router.
- TypeScript.
- TanStack Query for REST data.
- Zustand for active chat/session UI state.
- Expo SecureStore for auth tokens.
- Expo FileSystem for local attachment cache.
- Expo ImagePicker and Expo DocumentPicker.
- Expo Notifications.
- A small custom WebSocket client for gateway events.

Clawket is useful as a reference for reconnect behavior, event-driven streaming, local image caching, and capability flags, but it should not be used as a direct base.

## Storage Plan

Design storage as S3-compatible from day one, even if the MVP uses local disk first.

Recommended progression:

```text
Phase 1: Local filesystem provider
Phase 1.5: MinIO-compatible provider for staging/testing if useful
Phase 2: AWS S3 or another official S3-compatible object store
```

The app and higher-level gateway code should never depend on local filesystem paths. They should work with blob IDs, object keys, and signed gateway URLs.

### Blob Store Interface

```ts
export type BlobRef = {
  id: string;
  bucket: string;
  key: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  originalName?: string;
};

export interface BlobStore {
  putObject(input: {
    key: string;
    body: Buffer | NodeJS.ReadableStream;
    mimeType: string;
  }): Promise<void>;

  getObject(input: {
    key: string;
  }): Promise<NodeJS.ReadableStream>;

  getSignedReadUrl(input: {
    key: string;
    expiresInSeconds: number;
  }): Promise<string>;

  deleteObject(input: {
    key: string;
  }): Promise<void>;

  materializeLocalFile(input: {
    key: string;
  }): Promise<string>;
}
```

Provider files:

```text
gateway/src/storage/blob-store.ts
gateway/src/storage/local-blob-store.ts
gateway/src/storage/s3-blob-store.ts
```

### Local Provider

The MVP local provider stores objects under:

```text
/srv/hermes-mobile/uploads/{tenant-or-user}/{yyyy}/{mm}/{sha256-or-id}
```

Even though this is local disk, the database should store object keys and metadata rather than absolute paths. `materializeLocalFile()` can return the local path directly.

### S3/MinIO Provider

The S3 provider should use:

- `@aws-sdk/client-s3`
- `@aws-sdk/s3-request-presigner`

It should support AWS S3, MinIO, and other S3-compatible services through configuration:

```text
STORAGE_PROVIDER=local|s3
STORAGE_BUCKET=hermes-mobile
STORAGE_REGION=...
STORAGE_ENDPOINT=...
STORAGE_ACCESS_KEY_ID=...
STORAGE_SECRET_ACCESS_KEY=...
STORAGE_FORCE_PATH_STYLE=true|false
```

For Hermes processing, `materializeLocalFile()` downloads the object into a private gateway cache path such as:

```text
/srv/hermes-mobile/cache/materialized/{sha256}
```

This keeps Hermes compatible with local-path based tools without exposing object storage details to the app.

## Upload Handling

All uploads go to the gateway first.

For every upload, the gateway should:

- Authenticate the user.
- Enforce file size and MIME allowlists.
- Compute SHA-256.
- Store the original through `BlobStore`.
- Create attachment metadata in the DB.
- Generate thumbnails or derived artifacts when needed.
- Return a gateway-owned attachment ID to the app.

Images:

- Store original.
- Generate thumbnail.
- Generate a Hermes-ready compressed image, targeting roughly 500-900 KB.
- Cache local app copies with Expo FileSystem to avoid repeated downloads.

PDFs and other files:

- Store original.
- Extract text where possible.
- Store extracted text as metadata or a derived blob.
- For born-digital PDFs, use text extraction in Phase 4.
- For scanned PDFs, defer OCR or vision-based page extraction to Phase 4.5.

## Hermes Image/File Strategy

Hermes API currently works best with text and image URL/data-image inputs, and it rejects direct file parts. The gateway adapts mobile uploads into Hermes-compatible input.

For vision-capable main models:

```text
user image
  -> gateway compresses image
  -> gateway sends image as Hermes-compatible image input
  -> Hermes/main model reasons over the image
```

For non-vision main models:

```text
user image/PDF
  -> gateway stores and prepares file
  -> auxiliary vision model analyzes visual content
  -> extracted visual/text context is added to the user message
  -> main model receives normal text context
```

This supports a setup such as:

```text
main model: xiaomi/mimo-v2.5-pro
vision model: xiaomi/mimo-v2.5
```

The exact provider/model wiring should be kept in Hermes config, while the gateway only needs to choose whether to send image input directly or request text extraction before the main chat run.

For MVP, do not build the full two-model routing layer until it is actually needed. Start with the simplest working path:

- If the selected Hermes main model accepts images, send Hermes-compatible image inputs.
- If the selected main model is text-only, fall back to text extraction for PDFs and defer image-to-text/aux-vision routing until the first non-vision model is chosen for real use.

## Gateway API Shape

REST:

```text
POST   /auth/login
POST   /auth/refresh
POST   /auth/logout

GET    /sessions
POST   /sessions
PATCH  /sessions/:id
DELETE /sessions/:id

GET    /sessions/:id/messages

POST   /uploads
GET    /uploads/:id
GET    /uploads/:id/thumb

GET    /cron/jobs
GET    /cron/jobs/:id
GET    /cron/outputs
GET    /cron/outputs/:id

POST   /devices/push-token
```

WebSocket:

```text
GET /ws
```

Client request events:

```text
chat.send
chat.abort
session.subscribe
```

Server events:

```text
chat.run.start
message.delta
tool.start
tool.update
tool.complete
message.final
message.error
session.updated
cron.updated
```

### WebSocket Replay and Resume

Gateway WebSocket events must be resumable. Every persisted or replayable event should include:

```ts
type GatewayEventEnvelope<T> = {
  id: number;
  sessionId?: string;
  type: string;
  createdAt: string;
  payload: T;
};
```

Rules:

- Use monotonically increasing event IDs per app session, or a global monotonically increasing ID with session filtering.
- Store chat-run events in the gateway database for at least 24 hours.
- After a run completes, retain its replay events for at least 1 hour after the final message has been reconciled, even if the general cleanup job is aggressive.
- Client reconnect should send `lastEventId` for the active session.
- Gateway should replay missing events after `lastEventId`, then continue live streaming.
- If replay is no longer possible, gateway sends a `sync.required` event and the app reloads session history.
- `message.delta` events should be replayable during active runs; final message history remains the long-term source after completion.

## Database Ownership

The gateway database should store:

- User account and password hash.
- Refresh tokens.
- App sessions.
- Mapping from app session ID to Hermes session ID.
- Message metadata and app-local message state if needed.
- Attachment metadata.
- Blob references.
- Derived artifact references.
- Short-lived WebSocket event log for replay/resume.
- Device push tokens.
- Cron notification preferences.

Hermes continues to own its native session history, tool execution, and cron internals. The gateway stores only what the mobile app needs for stable UX, file references, event replay, and app-specific metadata.

## Cron Source of Truth

Hermes remains the source of truth for cron jobs and cron outputs. The gateway should not create a second scheduler.

The gateway responsibilities are:

- Verify whether Hermes exposes stable cron APIs for job listing, detail, updates, and outputs.
- If no stable API exists, read from Hermes cron files through an isolated adapter.
- Store only mobile-specific data such as notification preferences, last-seen output IDs, and deep-link mapping.
- Send Expo notifications when selected Hermes cron outputs appear or jobs complete.

## Implementation Phases

### Phase 0: Hermes API Contract Spike

- Verify available Hermes HTTP endpoints for runs/chat, sessions, streaming events, model config, cron, and file/image handling.
- Decide per capability whether the gateway uses HTTP, Hermes SQLite/file reads, CLI invocation, or a Python library adapter.
- If Python library access is required, choose a loopback FastAPI sidecar instead of embedding Hermes Python details in the Node gateway.
- Document exact Hermes request/response/event shapes in gateway adapter tests.
- Confirm body-size limits and image/file rejection behavior.

Exit condition: the gateway adapter contract is known and test fixtures exist for chat streaming, session listing/history, and cron listing/output.

### Phase 1: Gateway Foundation

- Create gateway project.
- Add Fastify, TypeScript, config loading, structured logging.
- Add Drizzle + SQLite.
- Add auth, refresh tokens, and protected route middleware.
- Add single-user bootstrap through an environment variable or CLI seed script. Do not expose public signup.
- Add storage abstraction with `LocalBlobStore`.
- Add object metadata schema.
- Add WebSocket event log schema with a 24-hour default retention policy.

Exit condition: login works, authenticated health route works, local blob store can put/get/delete objects.

### Phase 2: Hermes Chat Bridge

- Implement Hermes adapter.
- Implement sessions API.
- Map app sessions to Hermes session IDs.
- Implement text-only `chat.send`.
- Stream Hermes deltas/tool events to gateway WebSocket clients.

Exit condition: app or test client can create a session, send text, and receive streamed assistant/tool events.

### Phase 3: Expo App MVP

- Create Expo Router app.
- Add login screen.
- Store auth tokens in SecureStore.
- Add session list.
- Add chat screen.
- Add WebSocket client and streaming UI.
- Add reconnect handling, `lastEventId` resume, and basic offline/error states.

Exit condition: phone can log in, list sessions, chat with Hermes, and see live tool progress.

### Phase 4: Uploads and Caching

- Add upload endpoint.
- Add image picker and document picker.
- Add image thumbnail generation.
- Add local app cache for thumbnails/original previews.
- Add Hermes-ready image compression.
- Add basic PDF text extraction.
- Add `materializeLocalFile()` support for Hermes processing.

Exit condition: user can send images and PDFs/files; gateway stores them through the blob abstraction and converts them into Hermes-compatible context.

### Phase 4.5: Scanned PDF and OCR/Vision Extraction

- Detect scanned PDFs or pages with little/no extractable text.
- Convert selected pages to images.
- Choose either OCR or a vision-model extraction path.
- Store extracted page text as derived artifact metadata or derived blobs.
- Feed relevant extracted text into Hermes as normal text context.

Exit condition: scanned PDFs can produce usable text context without blocking the Phase 4 born-digital PDF path.

### Phase 5: S3-Compatible Provider

- Implement `S3BlobStore`.
- Test against MinIO locally or on the VPS if desired.
- Keep MinIO private on the Docker/VPS network if used.
- Validate migration path from local object keys to S3 object keys.

Exit condition: storage provider can switch from local to MinIO/S3 via config without changing app code or upload API contracts.

### Phase 6: Cron and Notifications

- Add cron job list/detail/output endpoints.
- Add cron screens in the app.
- Register Expo push tokens.
- Add notification preferences.
- Send push notifications for selected cron completions.
- Deep link notification taps into the relevant cron output or session.

Exit condition: app can inspect scheduled Hermes jobs and receive selected completion notifications.

### Phase 7: Hardening

- Add request size limits.
- Add upload cleanup policy.
- Add cache cleanup policy.
- Add attachment virus/mime sanity checks if needed.
- Add backups for SQLite and local blobs.
- Add rate limits for login and upload endpoints.
- Add observability logs for chat runs and file processing.

Exit condition: gateway is stable enough to run continuously on the VPS.

## Current Recommendation

Start with the local filesystem provider, but keep the `BlobStore` interface and object-key based metadata from the first commit. Add the S3 provider before uploads become heavily used, or immediately after the image/PDF pipeline works locally.

This gives the MVP the lowest operational footprint while keeping migration to official S3 straightforward.
