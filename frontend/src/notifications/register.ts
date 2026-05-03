import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { secureStorage } from "@/auth/secure-storage";
import {
  registerPushToken,
  unregisterPushToken,
} from "@/api/devices";

// We persist the most recently-registered Expo push token in SecureStore so
// boot-time re-registration is a no-op when nothing changed. Expo can rotate
// tokens; in that case we always re-POST on rotation.
const KEY_LAST_TOKEN = "pushToken";
const KEY_PUSH_DENIED = "pushDenied";

export type PushPermissionState = "granted" | "denied" | "unsupported";

interface EnsureResult {
  state: PushPermissionState;
  token: string | null;
}

function platformOrNull(): "ios" | "android" | null {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return null;
}

// expo-notifications requires a `projectId` for push tokens in EAS builds.
// In dev (Expo Go / bare dev client without EAS config) projectId may be
// undefined; getExpoPushTokenAsync still works in many setups but logs a
// warning. We pass it conditionally so dev doesn't hard-error.
function resolveProjectId(): string | undefined {
  const easPid = Constants.easConfig?.projectId;
  if (typeof easPid === "string" && easPid.length > 0) return easPid;
  const extraPid = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
    ?.eas?.projectId;
  if (typeof extraPid === "string" && extraPid.length > 0) return extraPid;
  return undefined;
}

async function readStoredToken(): Promise<string | null> {
  return secureStorage.get(KEY_LAST_TOKEN);
}

async function writeStoredToken(token: string | null): Promise<void> {
  if (token === null) {
    await secureStorage.del(KEY_LAST_TOKEN);
  } else {
    await secureStorage.set(KEY_LAST_TOKEN, token);
  }
}

export async function setPushDeniedFlag(value: boolean): Promise<void> {
  if (value) {
    await secureStorage.set(KEY_PUSH_DENIED, "1");
  } else {
    await secureStorage.del(KEY_PUSH_DENIED);
  }
}

export async function ensurePushPermissionAndToken(): Promise<EnsureResult> {
  if (Platform.OS === "web") {
    return { state: "unsupported", token: null };
  }
  if (!Platform.OS || !["ios", "android"].includes(Platform.OS)) {
    return { state: "unsupported", token: null };
  }

  // Android 13+ requires runtime POST_NOTIFICATIONS permission and a channel
  // for sound/vibration to actually fire. expo-notifications still surfaces
  // the legacy default channel so we set it explicitly for visibility.
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted ||
    existing.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  if (!granted) {
    const req = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });
    granted = req.granted ||
      req.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  }
  if (!granted) {
    await setPushDeniedFlag(true);
    return { state: "denied", token: null };
  }
  await setPushDeniedFlag(false);

  const projectId = resolveProjectId();
  if (!projectId) {
    console.warn(
      "[push] No EAS projectId configured. " +
        "getExpoPushTokenAsync requires one in standalone builds. " +
        "Add `extra.eas.projectId` to app.json (run `eas init` to create it).",
    );
  }
  try {
    const tokenResp = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    return { state: "granted", token: tokenResp.data };
  } catch (err) {
    console.warn("[push] getExpoPushTokenAsync failed:", err);
    return { state: "denied", token: null };
  }
}

// Returns the token actually in use (or null if denied/unsupported). Called
// after auth hydrates so we can attach the token to the user's device list.
export async function registerPushTokenWithBackend(opts?: {
  deviceName?: string;
}): Promise<string | null> {
  const { state, token } = await ensurePushPermissionAndToken();
  if (state !== "granted" || !token) return null;
  const platform = platformOrNull();
  if (!platform) return null;

  const stored = await readStoredToken();
  if (stored === token) {
    console.log("[push] token unchanged, skipping re-registration");
    return token;
  }

  console.log("[push] registering token", token.slice(0, 24) + "…", platform);
  try {
    await registerPushToken({
      expoToken: token,
      platform,
      deviceName: opts?.deviceName,
    });
    await writeStoredToken(token);
    console.log("[push] token registered with backend");
    return token;
  } catch (err) {
    console.warn("[push] backend registration failed:", err);
    throw err;
  }
}

// Called on logout. Best-effort delete + clear local state. We don't await
// network failures.
export async function clearPushTokenWithBackend(): Promise<void> {
  const stored = await readStoredToken();
  if (stored) {
    await unregisterPushToken(stored);
  }
  await writeStoredToken(null);
}
