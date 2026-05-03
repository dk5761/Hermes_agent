// Push notification payload types.
// The `data` field is the deep-link contract consumed by the mobile app.
// Mirror of the documented contract in src/cron/notify.ts — keep in sync.

export interface PushDataCronOutput {
  type: "cron_output";
  jobId: string;
  outputId: string;
}

export interface PushDataChatComplete {
  type: "chat_complete";
  appSessionId: string;
}

// "Test" push fired by Settings → "Send test notification". The mobile
// notification handler ignores it for routing (no deep link target) but
// still records it to the inbox.
export interface PushDataTest {
  type: "test";
}

export type PushData =
  | PushDataCronOutput
  | PushDataChatComplete
  | PushDataTest;

export interface PushPayload {
  to: string;
  title: string;
  body: string;
  data: PushData;
  // Defaults to "default" sound; null suppresses sound. We never set sound
  // explicitly here so Expo applies user-configured defaults.
  sound?: "default" | null;
}

export interface PushSendResult {
  // Tokens reported by Expo as DeviceNotRegistered. Caller must delete these
  // rows from push_tokens to stop future sends.
  staleTokens: string[];
  okCount: number;
  errorCount: number;
}
