import { apiFetch } from "./client";
import type { DeviceTokenRegistrationResponse } from "./types";

export interface RegisterPushTokenInput {
  expoToken: string;
  platform: "ios" | "android";
  deviceName?: string;
}

export async function registerPushToken(
  input: RegisterPushTokenInput,
): Promise<DeviceTokenRegistrationResponse> {
  const data = await apiFetch<DeviceTokenRegistrationResponse>(
    "/devices/push-token",
    { method: "POST", body: input },
  );
  if (!data || typeof data.id !== "string") {
    throw new Error("Invalid /devices/push-token response");
  }
  return data;
}

// Best-effort. Logout flow continues even if this fails (token may be stale or
// the device offline). The backend can also clean up via its own GC.
export async function unregisterPushToken(expoToken: string): Promise<void> {
  try {
    await apiFetch("/devices/push-token", {
      method: "DELETE",
      body: { expoToken },
    });
  } catch {
    // intentional swallow — see WHY note above.
  }
}
