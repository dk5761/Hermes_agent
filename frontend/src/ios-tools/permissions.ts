/**
 * Cached permission state for ios-tools categories.
 *
 * Caches the result of each permission request so we never call
 * requestXPermission() again after the user has already granted or denied.
 *
 * Usage:
 *   const granted = await ensurePermission("calendar");
 *   // throws IosToolPermissionError if denied or restricted
 */

import IosTools from "ios-tools";
import type { PermissionStatus } from "ios-tools";
import type { PermissionCategory } from "./types";

// ─── Permission error ─────────────────────────────────────────────────────────

export class IosToolPermissionError extends Error {
  readonly code = "permission_denied" as const;
  readonly category: PermissionCategory;

  constructor(category: PermissionCategory, status: PermissionStatus) {
    super(
      `ios-tools: permission for "${category}" is ${status}. ` +
        "The user must grant access in iOS Settings.",
    );
    this.name = "IosToolPermissionError";
    this.category = category;
  }
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

// Map<category, last-known-status>. Never persisted — a fresh launch will
// re-check with getX StatusPermission() which is a fast synchronous-style read.
const cache = new Map<PermissionCategory, PermissionStatus>();

// ─── Per-category helpers ─────────────────────────────────────────────────────

/**
 * Returns the current permission status for a category by querying
 * the native module without prompting the user.
 */
async function getStatus(
  category: PermissionCategory,
): Promise<PermissionStatus> {
  switch (category) {
    case "calendar":
      return IosTools.getCalendarPermissionStatus();
    case "reminders":
      return IosTools.getRemindersPermissionStatus();
    case "notifications":
      // UNUserNotificationCenter does not expose a cheap status-only method
      // in our native module — request doubles as a status check (it won't
      // re-prompt if already determined).
      return IosTools.requestNotificationsPermission();
  }
}

/**
 * Requests permission for a category, prompting the user when the status
 * is `not_determined`. Updates the in-process cache.
 */
async function requestPermission(
  category: PermissionCategory,
): Promise<PermissionStatus> {
  let status: PermissionStatus;
  switch (category) {
    case "calendar":
      status = await IosTools.requestCalendarPermission();
      break;
    case "reminders":
      status = await IosTools.requestRemindersPermission();
      break;
    case "notifications":
      status = await IosTools.requestNotificationsPermission();
      break;
  }
  cache.set(category, status);
  return status;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensures the given permission category is granted.
 *
 * Algorithm:
 * 1. If cache says `granted` → return true immediately (no native call).
 * 2. If cache says `denied` or `restricted` → throw IosToolPermissionError.
 * 3. Otherwise (cache miss or `not_determined`) → query native status.
 *    - If already `granted` → cache and return.
 *    - If `not_determined` → request (user prompt), cache result.
 *    - If `denied` / `restricted` → cache and throw.
 *
 * @throws IosToolPermissionError when iOS has denied or restricted access.
 */
export async function ensurePermission(
  category: PermissionCategory,
): Promise<true> {
  // Fast path: already cached.
  const cached = cache.get(category);
  if (cached === "granted") return true;
  if (cached === "denied" || cached === "restricted") {
    throw new IosToolPermissionError(category, cached);
  }

  // Slow path: need to check or prompt.
  let status = await getStatus(category);
  cache.set(category, status);

  if (status === "not_determined") {
    status = await requestPermission(category);
  }

  if (status === "granted") return true;
  throw new IosToolPermissionError(category, status);
}

/**
 * Clears all cached permission state. Useful in tests or after the user
 * visits iOS Settings and grants access externally.
 */
export function resetPermissionCache(): void {
  cache.clear();
}
