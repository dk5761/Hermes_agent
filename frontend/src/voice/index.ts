export { useVoiceInput } from "./useVoiceInput";
export type {
  VoiceInputState,
  VoiceInputError,
  UseVoiceInputOptions,
  UseVoiceInputResult,
} from "./useVoiceInput";
export {
  getStatus as getVoicePermissionStatus,
  requestIfNeeded as requestVoicePermission,
  openSettings as openVoiceSettings,
} from "./permissions";
export type { VoicePermissionStatus } from "./permissions";
export { MicButton } from "./MicButton";
export type { MicButtonProps } from "./MicButton";

// Phase 5: settings store
export { useVoiceSettings } from "../state/voice-settings";
export type { VoiceSettings, VoiceSettingsActions } from "../state/voice-settings";
