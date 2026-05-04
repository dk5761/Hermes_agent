/**
 * Voice permission helper.
 *
 * Wraps expo-speech-recognition's combined permission check (speech recognition
 * + microphone) behind a simple 4-state API with an in-process cache so we never
 * re-prompt on rapid successive presses.
 */

import { Linking } from "react-native";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";

export type VoicePermissionStatus =
  | "granted"
  | "denied"
  | "not_determined"
  | "restricted";

// ---------------------------------------------------------------------------
// In-process cache. Cleared back to null any time the permission transitions
// from not_determined so that a subsequent call picks up the real post-prompt
// status.
// ---------------------------------------------------------------------------
let _cachedStatus: VoicePermissionStatus | null = null;

/**
 * Maps the raw response from `getPermissionsAsync` / `requestPermissionsAsync`
 * to our 4-value enum.
 *
 * The combined response from expo-speech-recognition:
 *   - `granted`      → both speech-recognition and microphone are granted
 *   - `denied`       → at least one was explicitly denied by the user
 *   - `undetermined` → not yet asked
 *   - `restricted`   → iOS Content & Privacy restriction (can't ask)
 *
 * We collapse expo's `PermissionStatus.DENIED` and the `restricted` flag into
 * the two "hard-blocked" states, and treat `UNDETERMINED` as `not_determined`.
 */
function mapResponse(response: {
  granted: boolean;
  status: string;
  restricted?: boolean;
  canAskAgain: boolean;
}): VoicePermissionStatus {
  if (response.granted) {
    return "granted";
  }
  // iOS-only restricted flag takes precedence over denied so the UI can
  // distinguish "user explicitly said no" from "MDM/parental controls blocked".
  if (response.restricted === true) {
    return "restricted";
  }
  // expo-modules-core PermissionStatus values are lowercase strings:
  // "granted" | "denied" | "undetermined"
  if (response.status === "denied") {
    return "denied";
  }
  // "undetermined" from expo === not yet asked
  return "not_determined";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current combined permission status without showing a prompt.
 * Result is cached in-process; the cache is a single volatile variable that
 * refreshes on every call (we always hit the native layer so the result stays
 * accurate after the user goes to Settings and comes back).
 */
export async function getStatus(): Promise<VoicePermissionStatus> {
  const response = await ExpoSpeechRecognitionModule.getPermissionsAsync();
  _cachedStatus = mapResponse(response);
  return _cachedStatus;
}

/**
 * Requests speech-recognition + microphone permissions if the status is
 * `not_determined`. If already determined (granted/denied/restricted) returns
 * the cached status immediately without re-prompting.
 *
 * In-process guard: if another `requestIfNeeded` call is already in flight
 * (e.g. user rapidly double-presses the mic button) the second call returns
 * the cached value immediately.
 */
let _requestInFlight = false;

export async function requestIfNeeded(): Promise<VoicePermissionStatus> {
  // Fast-path: already determined and cached.
  if (_cachedStatus !== null && _cachedStatus !== "not_determined") {
    return _cachedStatus;
  }

  // Concurrent-call guard.
  if (_requestInFlight) {
    // Wait until the in-flight request resolves, then return the cached value.
    return new Promise<VoicePermissionStatus>((resolve) => {
      const poll = setInterval(() => {
        if (!_requestInFlight) {
          clearInterval(poll);
          resolve(_cachedStatus ?? "not_determined");
        }
      }, 50);
    });
  }

  _requestInFlight = true;
  try {
    // Check first — if already determined natively we avoid showing the dialog.
    const current = await ExpoSpeechRecognitionModule.getPermissionsAsync();
    const currentStatus = mapResponse(current);

    if (currentStatus !== "not_determined") {
      _cachedStatus = currentStatus;
      return _cachedStatus;
    }

    // Not yet asked — show the system prompt.
    const response =
      await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    _cachedStatus = mapResponse(response);
    return _cachedStatus;
  } finally {
    _requestInFlight = false;
  }
}

/**
 * Deep-links the user to the iOS Settings app → Hermes entry so they can
 * manually grant a previously-denied permission.
 */
export async function openSettings(): Promise<void> {
  await Linking.openSettings();
}
