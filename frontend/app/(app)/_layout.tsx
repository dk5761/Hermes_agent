import { useEffect } from "react";
import { Tabs, useRouter } from "expo-router";
import { useAuthStore } from "@/auth/store";
import { AppTabBar } from "@/components/ui/AppTabBar";

export default function AppLayout() {
  const router = useRouter();
  const isAuthed = useAuthStore((s) => Boolean(s.accessToken && s.user));
  const hydrated = useAuthStore((s) => s.hydrated);

  useEffect(() => {
    if (hydrated && !isAuthed) router.replace("/login");
  }, [hydrated, isAuthed, router]);

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
