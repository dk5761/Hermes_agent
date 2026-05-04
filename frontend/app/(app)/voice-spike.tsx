// Phase 0 spike screen. Hidden route — not in any tab bar.
// Navigate manually: router.push("/voice-spike") OR type the URL into a
// browser pointed at the dev server.
//
// Delete this file after Phase 1 lands.

import { ScrollView, View } from "react-native";
import { NavBar, PhoneSafeArea } from "@/components/ui";
import { safeBack } from "@/util/nav";
import { VoiceSpike } from "@/voice/spike";

export default function VoiceSpikeScreen(): React.ReactElement {
  return (
    <PhoneSafeArea>
      <NavBar title="Voice Spike (Phase 0)" onBack={() => safeBack("/")} />
      <ScrollView>
        <View style={{ padding: 16 }}>
          <VoiceSpike />
        </View>
      </ScrollView>
    </PhoneSafeArea>
  );
}
