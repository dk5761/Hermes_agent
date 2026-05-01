import { Tabs } from "expo-router";
import { useAuthStore } from "@/auth/store";
import { AppTabBar } from "@/components/ui/AppTabBar";

export default function AppLayout() {
  const isAuthed = useAuthStore((s) => Boolean(s.accessToken && s.user));
  const hydrated = useAuthStore((s) => s.hydrated);

  // Auth-state redirect is owned by useAuthRedirect() in the root layout.
  // Do NOT fire a second redirect from here — concurrent replace() calls
  // during sign-out leave the router half-mounted and the login screen
  // renders into a void.
  if (!hydrated) return null;
  if (!isAuthed) return null;

  // tabBarStyle display:none hides RN-Navigation's default tab bar; AppTabBar
  // renders separately as a floating overlay.
  return (
    <Tabs
      screenOptions={{ headerShown: false, tabBarStyle: { display: "none" } }}
      tabBar={(props) => <AppTabBar {...props} />}
    >
      <Tabs.Screen name="(chats)" options={{ title: "Chats" }} />
      <Tabs.Screen name="(cron)" options={{ title: "Cron" }} />
      <Tabs.Screen name="(settings)" options={{ title: "Settings" }} />
    </Tabs>
  );
}
