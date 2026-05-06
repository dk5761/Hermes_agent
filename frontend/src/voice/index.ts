export { useVoiceInput, resolveEngine } from "./useVoiceInput";
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

// Phase 5 + 6: settings store
export { useVoiceSettings } from "../state/voice-settings";
export type { VoiceSettings, VoiceSettingsActions, VoiceEngine } from "../state/voice-settings";

// Phase 2: model state
export { useWhisperModelState } from "./whisper-model-state";
export type {
  WhisperModelState,
  WhisperModelStateValues,
  WhisperModelStateActions,
  WhisperModelStatus,
} from "./whisper-model-state";
