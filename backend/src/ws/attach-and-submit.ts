/**
 * attach-and-submit — shared helpers for the
 *   bridge.build → image.attach → prompt.submit
 * sequence that turns a user message (text or voice transcript) plus
 * attachment ids into a Hermes prompt invocation.
 *
 * Used by:
 *   - `gateway-ws.ts` `handleChatSend` (text + image WS frame)
 *   - `routes/voice-memo.ts` `forwardTranscriptToHermes` (audio + image,
 *     after STT lands)
 *
 * Split into two functions because the callers persist their `user.message`
 * chat_history row at different points relative to the image.attach call:
 *   - chat.send persists *between* image.attach and prompt.submit so the
 *     persisted envelope's `historyId` round-trips back to the mobile
 *     reducer for live↔history dedup.
 *   - voice-memo persists at multipart-parse time so the audio bubble
 *     shows in the chat *before* STT completes, then runs image.attach +
 *     prompt.submit later (after the transcript lands).
 *
 *   prepareImageAttach() — bridge.build + image.attach loop. Returns the
 *     finalText (with bridge-generated prompt prefix) so callers can
 *     persist it on the chat_history row.
 *   submitPrompt() — prompt.submit with the busy-interrupt retry branch
 *     and an optional caller-provided session-recovery callback.
 *
 * The helpers do NOT:
 *   - Persist chat_history rows (callers own this; payload shape differs).
 *   - Get/create the upstream Hermes session id (callers pass it in).
 *   - Surface warnings to the client — returned in the result so each
 *     caller can map to its protocol (WS control.error vs HTTP response).
 */
import {
  AttachmentBridge,
  AttachmentUnauthorizedError,
  type AttachmentBridgeResult,
  type AttachmentBridgeWarning,
} from "./attachment-bridge.js";
import type { HermesWsClient } from "../hermes/ws-client.js";
import type { AppLogger } from "../logger.js";

// ─── error types — callers map to their protocol ───────────────────────────

/**
 * Generic failure from `attachmentBridge.build`. Wraps the underlying error.
 * `AttachmentUnauthorizedError` is re-thrown as-is so callers can match on
 * the existing class.
 */
export class AttachmentResolutionError extends Error {
  // `wrappedError` rather than `cause` because TS strict mode complains
  // that parameter-property `cause` overrides Error.cause without `override`.
  constructor(public readonly wrappedError: unknown) {
    super("attachment_resolution_failed");
    this.name = "AttachmentResolutionError";
  }
}

/** Hermes' `image.attach` JSON-RPC failed for a specific attachment. */
export class ImageAttachFailedError extends Error {
  constructor(
    public readonly attachmentId: string,
    public readonly wrappedError: unknown,
  ) {
    super(`image_attach_failed:${attachmentId}`);
    this.name = "ImageAttachFailedError";
  }
}

/** Hermes' `prompt.submit` JSON-RPC failed and recovery (if any) didn't help. */
export class PromptSubmitFailedError extends Error {
  constructor(public readonly wrappedError: unknown) {
    super("prompt_submit_failed");
    this.name = "PromptSubmitFailedError";
  }
}

// ─── prepareImageAttach ────────────────────────────────────────────────────

export interface PrepareImageAttachDeps {
  sharedClient: HermesWsClient;
  attachmentBridge: AttachmentBridge;
  log: AppLogger;
}

export interface PrepareImageAttachInput {
  userId: string;
  appSessionId: string;
  /** Hermes upstream session id (caller is responsible for create/lookup). */
  hermesSessionId: string;
  attachmentIds: readonly string[];
  text: string;
}

export interface PrepareImageAttachResult {
  /** User text concatenated with the bridge's prompt prefix (PDF text etc.). */
  finalText: string;
  /** null when there were no attachments. */
  bridgeResult: AttachmentBridgeResult | null;
  /** Bridge warnings; callers surface to the client however they like. */
  warnings: AttachmentBridgeWarning[];
}

/**
 * Resolve attachments → image.attach loop → return finalText.
 *
 * Throws:
 *   - `AttachmentUnauthorizedError` — caller doesn't own one of the attachments.
 *   - `AttachmentResolutionError` — bridge.build threw a generic error.
 *   - `ImageAttachFailedError` — Hermes rejected an image.attach call.
 */
export async function prepareImageAttach(
  deps: PrepareImageAttachDeps,
  input: PrepareImageAttachInput,
): Promise<PrepareImageAttachResult> {
  const { sharedClient, attachmentBridge, log } = deps;
  const { userId, appSessionId, hermesSessionId, attachmentIds, text } = input;

  let bridgeResult: AttachmentBridgeResult | null = null;
  if (attachmentIds.length > 0) {
    try {
      bridgeResult = await attachmentBridge.build({
        userId,
        appSessionId,
        attachmentIds,
      });
    } catch (err) {
      if (err instanceof AttachmentUnauthorizedError) {
        throw err;
      }
      log.error({ err }, "prepareImageAttach: bridge.build failed");
      throw new AttachmentResolutionError(err);
    }
  }
  const warnings = bridgeResult?.warnings ?? [];

  // image.attach must precede prompt.submit on the same upstream session
  // (HERMES_CONTRACT.md). Failures abort — no persist, no submit.
  if (bridgeResult) {
    for (const img of bridgeResult.imagePaths) {
      try {
        await sharedClient.request("image.attach", {
          session_id: hermesSessionId,
          path: img.localPath,
        });
      } catch (err) {
        log.error(
          { err, attachmentId: img.attachmentId },
          "prepareImageAttach: image.attach failed",
        );
        throw new ImageAttachFailedError(img.attachmentId, err);
      }
    }
  }

  const finalText = buildFinalPromptText(text, bridgeResult?.promptPrefix ?? "");
  return { finalText, bridgeResult, warnings };
}

// ─── submitPrompt ──────────────────────────────────────────────────────────

export interface SubmitPromptDeps {
  sharedClient: HermesWsClient;
  log: AppLogger;
}

export interface SubmitPromptInput {
  hermesSessionId: string;
  finalText: string;
  /**
   * Optional: when prompt.submit fails with session_gone / invalid_params /
   * busy-after-interrupt, the helper calls this to obtain a fresh upstream
   * session id and retries once. Without it, the failure propagates.
   *
   * Receives the failed session id; should clear any caller-side mapping
   * and return a freshly created Hermes session id.
   */
  recoverSession?: (failedHermesSessionId: string) => Promise<string>;
  /**
   * Optional: applied to the recovered session (per-session model override
   * etc.) before the retry prompt.submit.
   */
  applyOverrideAfterRecover?: (newHermesSessionId: string) => Promise<void>;
}

export interface SubmitPromptResult {
  /** May differ from input.hermesSessionId if a recover-and-retry happened. */
  hermesSessionId: string;
}

/**
 * prompt.submit with busy-interrupt + caller-provided session recovery.
 *
 * Throws `PromptSubmitFailedError` when the final retry path doesn't help
 * (or no recovery callback was supplied for an unrecoverable error).
 */
export async function submitPrompt(
  deps: SubmitPromptDeps,
  input: SubmitPromptInput,
): Promise<SubmitPromptResult> {
  const { sharedClient, log } = deps;
  const { finalText, recoverSession, applyOverrideAfterRecover } = input;
  let hermesSessionId = input.hermesSessionId;

  const submit = async (sid: string): Promise<void> => {
    await sharedClient.request("prompt.submit", { session_id: sid, text: finalText });
  };

  try {
    await submit(hermesSessionId);
    return { hermesSessionId };
  } catch (err) {
    const reason = errorMessage(err);
    log.warn({ err, hermesSessionId, reason }, "submitPrompt: prompt.submit failed");
    const sessionGone =
      /session/i.test(reason) &&
      /not found|unknown|invalid|expired|missing|no such|gone|evicted/i.test(reason);
    const isInvalidParams = /-32602|invalid params/i.test(reason);
    const sessionBusy = /4009|session busy|busy/i.test(reason);

    // Busy-but-not-gone: interrupt then retry on the same upstream session.
    if (sessionBusy && !sessionGone && !isInvalidParams) {
      try {
        await sharedClient.request("session.interrupt", { session_id: hermesSessionId });
        // Hermes' run-thread needs a moment to hit its finally{} and clear
        // the running flag before a fresh prompt.submit will succeed.
        await new Promise((r) => setTimeout(r, 300));
        await submit(hermesSessionId);
        return { hermesSessionId };
      } catch (retryErr) {
        log.error({ err: retryErr }, "submitPrompt: retry after interrupt failed");
        // Fall through to recover-session path.
      }
    }

    // Unrecoverable on the upstream side. Ask the caller to mint a fresh
    // session id (DB shape differs between callers) then retry once.
    if ((sessionGone || isInvalidParams || sessionBusy) && recoverSession) {
      try {
        hermesSessionId = await recoverSession(hermesSessionId);
        if (applyOverrideAfterRecover) {
          await applyOverrideAfterRecover(hermesSessionId);
        }
        await submit(hermesSessionId);
        return { hermesSessionId };
      } catch (retryErr) {
        log.error({ err: retryErr }, "submitPrompt: retry after recover failed");
        throw new PromptSubmitFailedError(retryErr);
      }
    }

    throw new PromptSubmitFailedError(err);
  }
}

// ─── locals ─────────────────────────────────────────────────────────────────

/**
 * Concatenate the bridge-generated prefix with the user's text. Prefix is
 * placed first so non-image attachment context (e.g. extracted PDF text)
 * grounds the user's prompt rather than appearing as an afterthought.
 *
 * Lifted from gateway-ws.ts to keep the helper self-contained — same logic.
 */
function buildFinalPromptText(userText: string, promptPrefix: string): string {
  const trimmedPrefix = promptPrefix.trim();
  const trimmedText = userText.trim();
  if (trimmedPrefix.length === 0) return userText;
  if (trimmedText.length === 0) return trimmedPrefix;
  return `${trimmedPrefix}\n\n${userText}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
