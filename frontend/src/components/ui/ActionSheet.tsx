/**
 * ActionSheet — themed bottom-sheet replacement for ActionSheetIOS / Alert.
 *
 * One imperative ref API:
 *   const ref = useRef<ActionSheetHandle>(null);
 *   ref.current?.present({
 *     title: "Refactor cron output dispatch",
 *     subtitle: "Started · running",
 *     actions: [
 *       { id: "pin", label: "Pin to top", icon: "pin", onPress: ... },
 *       { id: "delete", label: "Delete", icon: "trash", destructive: true, onPress: ... },
 *     ],
 *   });
 *
 * The component renders nothing until presented; mount it once near the
 * screen root and trigger from long-press handlers.
 */
import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSegments } from "expo-router";

import { Icon, type IconName } from "./Icon";
import { Sheet, type SheetHandle } from "./Sheet";
import { Stack } from "./Stack";
import { Text } from "./Text";
import { useThemeTokens } from "./tokens";

export interface ActionSheetItem {
  id: string;
  label: string;
  icon?: IconName;
  destructive?: boolean;
  // Returning a Promise is supported but not awaited — fire-and-forget.
  onPress: () => void | Promise<void>;
}

export interface ActionSheetConfig {
  title?: string;
  subtitle?: string;
  actions: ReadonlyArray<ActionSheetItem>;
}

export interface ActionSheetHandle {
  present: (config: ActionSheetConfig) => void;
  dismiss: () => void;
}

export const ActionSheet = forwardRef<ActionSheetHandle>(function ActionSheet(
  _props,
  ref,
) {
  const tokens = useThemeTokens();
  const insets = useSafeAreaInsets();
  const segments = useSegments();
  const sheetRef = useRef<SheetHandle>(null);
  const [config, setConfig] = useState<ActionSheetConfig | null>(null);
  // The floating AppTabBar is only painted on tab-root screens. Push the
  // sheet content above it on those screens; on Stack children (e.g. the
  // chat detail screen) the tab bar isn't visible, so we use just the
  // safe-area inset and let the sheet sit flush at the bottom.
  const appIdx = segments.indexOf("(app)" as never);
  const afterApp = appIdx >= 0 ? segments.slice(appIdx + 1) : segments;
  const tabBarVisible = afterApp.length <= 1;
  const tabBarFloor = tabBarVisible
    ? Math.max(insets.bottom, 12) + 60 + 12
    : Math.max(insets.bottom, 12);

  useImperativeHandle(
    ref,
    () => ({
      present: (cfg: ActionSheetConfig) => {
        setConfig(cfg);
        // Defer present until next frame so the inner BottomSheetModal sees
        // the up-to-date config on first render.
        setTimeout(() => sheetRef.current?.present(), 16);
      },
      dismiss: () => sheetRef.current?.dismiss(),
    }),
    [],
  );

  const onChange = useCallback((idx: number) => {
    if (idx < 0) setConfig(null);
  }, []);

  const onPick = useCallback(
    (item: ActionSheetItem) => {
      sheetRef.current?.dismiss();
      // Run the handler after the dismiss animation kicks off so the sheet
      // doesn't appear frozen while the action runs (e.g., opening a modal,
      // navigating, etc.). 60ms is the rough sheet-collapse start.
      setTimeout(() => {
        try {
          void item.onPress();
        } catch {
          // Handlers shouldn't throw; swallow defensively to keep the
          // sheet from leaking error UI.
        }
      }, 60);
    },
    [],
  );

  const onCancel = useCallback(() => {
    sheetRef.current?.dismiss();
  }, []);

  // Snap height grows with the action count so we don't clip on long lists
  // (e.g., 7 actions on the chats screen). Each row is ~52pt + header +
  // cancel + 16pt grip + tab-bar floor (so Cancel never sits behind the
  // floating AppTabBar on tab-root screens).
  const headerHeight = config?.title ? 56 : 0;
  const rowsHeight = (config?.actions.length ?? 0) * 52;
  const cancelHeight = 64;
  const gripPadding = 24;
  const targetHeight =
    headerHeight + rowsHeight + cancelHeight + gripPadding + tabBarFloor;
  // Cap so very tall sheets stay under 80% of the screen.
  const snapPoints: ReadonlyArray<string | number> =
    targetHeight > 0
      ? [Math.min(targetHeight, 760)]
      : ["50%"];

  return (
    <Sheet
      ref={sheetRef}
      snapPoints={snapPoints}
      onChange={onChange}
    >
      {config ? (
        <Stack gap={0} style={{ paddingBottom: 12 }}>
          {config.title || config.subtitle ? (
            <Stack
              gap={2}
              style={{
                paddingHorizontal: 20,
                paddingVertical: 12,
              }}
            >
              {config.title ? (
                <Text kind="body-lg" numberOfLines={1} style={{ fontWeight: "600" }}>
                  {config.title}
                </Text>
              ) : null}
              {config.subtitle ? (
                <Text kind="caption" color={tokens.ink3} numberOfLines={1}>
                  {config.subtitle}
                </Text>
              ) : null}
            </Stack>
          ) : null}

          <View
            style={{
              backgroundColor: tokens.bg,
              borderTopWidth: 1,
              borderTopColor: tokens.lineSoft,
            }}
          >
            {config.actions.map((a, i) => (
              <ActionRow
                key={a.id}
                item={a}
                isLast={i === config.actions.length - 1}
                onPress={() => onPick(a)}
              />
            ))}
          </View>

          <View
            style={{
              paddingHorizontal: 16,
              paddingTop: 12,
              paddingBottom: tabBarFloor,
            }}
          >
            <Pressable
              onPress={onCancel}
              style={({ pressed }) => ({
                paddingVertical: 16,
                borderRadius: 14,
                backgroundColor: tokens.chip,
                alignItems: "center",
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text kind="body-lg" style={{ fontWeight: "600" }}>
                Cancel
              </Text>
            </Pressable>
          </View>
        </Stack>
      ) : null}
    </Sheet>
  );
});

function ActionRow({
  item,
  isLast,
  onPress,
}: {
  item: ActionSheetItem;
  isLast: boolean;
  onPress: () => void;
}) {
  const tokens = useThemeTokens();
  const color = item.destructive ? tokens.danger : tokens.ink;
  const iconColor = item.destructive ? tokens.danger : tokens.ink2;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingHorizontal: 20,
        paddingVertical: 14,
        backgroundColor: pressed ? tokens.sunken : "transparent",
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: tokens.lineSoft,
      })}
    >
      {item.icon ? <Icon name={item.icon} size={18} color={iconColor} /> : null}
      <Text kind="body-lg" color={color} style={{ fontWeight: "500", flex: 1 }}>
        {item.label}
      </Text>
    </Pressable>
  );
}
