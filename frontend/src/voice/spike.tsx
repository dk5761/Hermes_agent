// SPIKE — Phase 0 only. Throwaway. Do NOT import from elsewhere.
//
// Drop <VoiceSpike /> into a screen on the dev build and verify:
//   1. Permissions prompt fires on first start.
//   2. Partial-result events fire while speaking.
//   3. Final-result event fires after you stop.
//   4. Errors from the module surface in the UI.
//
// This file exists purely so the spike compiles against the project's
// real tsconfig + node_modules. Delete it when Phase 1 ships.

import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

export function VoiceSpike(): React.ReactElement {
  const [partial, setPartial] = useState("");
  const [final, setFinal] = useState("");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results[0]?.transcript ?? "";
    if (event.isFinal) {
      setFinal(transcript);
      setPartial("");
    } else {
      setPartial(transcript);
    }
  });

  useSpeechRecognitionEvent("error", (event) => {
    setError(`${event.error}: ${event.message ?? ""}`);
    setRecording(false);
  });

  useSpeechRecognitionEvent("end", () => setRecording(false));

  const start = async (): Promise<void> => {
    setError(null);
    setFinal("");
    setPartial("");
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      setError(`permission denied: ${perm.status}`);
      return;
    }
    await ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      interimResults: true,
      continuous: true,
      requiresOnDeviceRecognition: false,
      addsPunctuation: true,
    });
    setRecording(true);
  };

  const stop = async (): Promise<void> => {
    await ExpoSpeechRecognitionModule.stop();
    setRecording(false);
  };

  return (
    <View style={{ padding: 16, gap: 12 }}>
      <Pressable
        onPressIn={start}
        onPressOut={stop}
        style={{
          padding: 24,
          backgroundColor: recording ? "#c00" : "#444",
          borderRadius: 12,
          alignItems: "center",
        }}
      >
        <Text style={{ color: "#fff" }}>
          {recording ? "RECORDING — release to stop" : "Hold to record"}
        </Text>
      </Pressable>
      <Text>partial: {partial}</Text>
      <Text>final: {final}</Text>
      {error ? <Text style={{ color: "red" }}>error: {error}</Text> : null}
    </View>
  );
}
