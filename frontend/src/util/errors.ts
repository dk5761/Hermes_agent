/**
 * Error → human-readable string normalization.
 *
 * Used by the global TanStack MutationCache.onError handler so a failed
 * mutation can fire a toast with a sensible message regardless of the
 * underlying error shape (gateway ApiError, network Error, plain string).
 */
import { ApiError } from "@/api/types";

/** Mapping of well-known gateway error codes to user-facing copy. */
const KNOWN_CODES: Record<string, string> = {
  current_password_incorrect: "Current password is incorrect.",
  new_password_too_weak: "New password is too weak.",
  invalid_credentials: "Username or password is incorrect.",
  unauthorized: "Session expired. Please sign in again.",
  forbidden: "You don't have permission to do that.",
  not_found: "That resource is no longer available.",
  rate_limited: "Too many requests. Try again in a moment.",
  validation_failed: "Some fields are invalid.",
};

/**
 * Coerces any thrown value into a user-readable message. Prefers the
 * gateway's `{error: <code>}` body over the HTTP error string.
 */
export function humanizeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (typeof err.body === "string" && err.body.trim().length > 0) {
      return err.body;
    }
    if (err.body && typeof err.body === "object") {
      const code = err.body.error;
      if (code && KNOWN_CODES[code]) return KNOWN_CODES[code];
      if (code) return code;
    }
    return `Request failed (${err.status})`;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  if (typeof err === "string" && err.trim().length > 0) {
    return err;
  }
  return "Something went wrong";
}
