/**
 * Notifications inbox — `/(settings)/notifications-inbox`.
 *
 * Local log of every push the app has received (see
 * `src/state/notifications-inbox.ts`). Tapping an item marks it read and,
 * if the payload carries a known deep-link (cron output today, more later),
 * navigates to it. Swiping right archives. Long-press opens delete.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  View,
  type ListRenderItem,
} from "react-native";
import { useRouter } from "expo-router";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";

import {
  ActionSheet,
  Chip,
  EmptyState,
  Icon,
  NavBar,
  NavIcon,
  PhoneSafeArea,
  Row,
  SegControl,
  Stack,
  Text,
  useThemeTokens,
  type ActionSheetHandle,
} from "@/components/ui";
import {
  useNotificationsInbox,
  type InboxItem,
} from "@/state/notifications-inbox";
import { formatRelative } from "@/util/time";

type FilterKey = "unread" | "all" | "archived";

function pickStr(d: Record<string, unknown>, key: string): string | null {
  const v = d[key];
  return typeof v === "string" ? v : null;
}

function isCronOutput(d: Record<string, unknown>): { jobId: string; outputId: string } | null {
  if (d.type !== "cron_output") return null;
  const jobId = pickStr(d, "jobId");
  const outputId = pickStr(d, "outputId");
  if (!jobId || !outputId) return null;
  return { jobId, outputId };
}

export default function NotificationsInboxScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();
  const items = useNotificationsInbox((s) => s.items);
  const markRead = useNotificationsInbox((s) => s.markRead);
  const markAllRead = useNotificationsInbox((s) => s.markAllRead);
  const archive = useNotificationsInbox((s) => s.archive);
  const unarchive = useNotificationsInbox((s) => s.unarchive);
  const remove = useNotificationsInbox((s) => s.remove);
  const clearAll = useNotificationsInbox((s) => s.clearAll);
  const [filter, setFilter] = useState<FilterKey>("unread");

  const counts = useMemo(() => {
    let unread = 0;
    let all = 0;
    let archived = 0;
    for (const it of items) {
      if (it.archived) archived += 1;
      else {
        all += 1;
        if (!it.read) unread += 1;
      }
    }
    return { unread, all, archived };
  }, [items]);

  const filtered = useMemo<InboxItem[]>(() => {
    switch (filter) {
      case "unread":
        return items.filter((it) => !it.archived && !it.read);
      case "all":
        return items.filter((it) => !it.archived);
      case "archived":
        return items.filter((it) => it.archived);
    }
  }, [items, filter]);

  const onTap = useCallback(
    (item: InboxItem) => {
      markRead(item.id);
      const cron = isCronOutput(item.data);
      if (cron) {
        router.push(
          `/(cron)/${encodeURIComponent(cron.jobId)}/output/${encodeURIComponent(cron.outputId)}` as never,
        );
      }
    },
    [markRead, router],
  );

  const actionSheetRef = useRef<ActionSheetHandle>(null);
  const onLongPress = useCallback(
    (item: InboxItem) => {
      const archiveLabel = item.archived ? "Unarchive" : "Archive";
      const reset = item.archived
        ? () => unarchive(item.id)
        : () => archive(item.id);
      actionSheetRef.current?.present({
        title: item.title || "Notification",
        actions: [
          {
            id: "archive",
            label: archiveLabel,
            icon: "archive",
            onPress: reset,
          },
          {
            id: "delete",
            label: "Delete",
            icon: "trash",
            destructive: true,
            onPress: () => remove(item.id),
          },
        ],
      });
    },
    [archive, unarchive, remove],
  );

  const onMenu = useCallback(() => {
    actionSheetRef.current?.present({
      title: "Inbox actions",
      actions: [
        {
          id: "mark-all-read",
          label: "Mark all read",
          icon: "check",
          onPress: markAllRead,
        },
        {
          id: "clear",
          label: "Clear all",
          icon: "trash",
          destructive: true,
          onPress: () =>
            Alert.alert("Clear all notifications?", "This cannot be undone.", [
              { text: "Cancel", style: "cancel" },
              { text: "Clear", style: "destructive", onPress: clearAll },
            ]),
        },
      ],
    });
  }, [markAllRead, clearAll]);

  const renderItem = useCallback<ListRenderItem<InboxItem>>(
    ({ item }) => (
      <SwipeRow
        item={item}
        onTap={() => onTap(item)}
        onLongPress={() => onLongPress(item)}
        onSwipeArchive={() =>
          item.archived ? unarchive(item.id) : archive(item.id)
        }
      />
    ),
    [onTap, onLongPress, archive, unarchive],
  );

  return (
    <PhoneSafeArea>
      <NavBar
        title="Inbox"
        onBack={() => router.back()}
        trailing={
          items.length > 0 ? <NavIcon name="more" onPress={onMenu} /> : null
        }
      />

      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 4,
          paddingBottom: 8,
        }}
      >
        <SegControl
          options={[
            { value: "unread", label: `Unread · ${counts.unread}` },
            { value: "all", label: `All · ${counts.all}` },
            { value: "archived", label: `Archived · ${counts.archived}` },
          ]}
          value={filter}
          onChange={(v) => setFilter(v as FilterKey)}
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(it) => it.id}
        renderItem={renderItem}
        contentContainerStyle={{
          paddingBottom: 60,
          flexGrow: 1,
        }}
        ListEmptyComponent={
          <EmptyState
            icon="bell"
            title={
              filter === "unread"
                ? "No unread notifications"
                : filter === "archived"
                  ? "No archived notifications"
                  : "No notifications yet"
            }
            body={
              filter === "all"
                ? "Pushes from cron jobs and approvals will appear here."
                : undefined
            }
          />
        }
      />
      <ActionSheet ref={actionSheetRef} />
    </PhoneSafeArea>
  );
}

// ─── row + swipe ───────────────────────────────────────────────────────────

interface SwipeRowProps {
  item: InboxItem;
  onTap: () => void;
  onLongPress: () => void;
  onSwipeArchive: () => void;
}

function SwipeRow({ item, onTap, onLongPress, onSwipeArchive }: SwipeRowProps) {
  const tokens = useThemeTokens();
  return (
    <ReanimatedSwipeable
      friction={2}
      rightThreshold={56}
      renderRightActions={(_progress, drag) => (
        <SwipeActionBg drag={drag} archived={item.archived} />
      )}
      onSwipeableOpen={(direction) => {
        if (direction === "right") onSwipeArchive();
      }}
    >
      <Pressable
        onPress={onTap}
        onLongPress={onLongPress}
        style={({ pressed }) => ({
          opacity: pressed ? 0.7 : 1,
          paddingVertical: 14,
          paddingHorizontal: 16,
          flexDirection: "row",
          gap: 12,
          alignItems: "flex-start",
          backgroundColor: tokens.bg,
          borderBottomWidth: 1,
          borderBottomColor: tokens.lineSoft,
        })}
      >
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            marginTop: 8,
            backgroundColor: item.read ? "transparent" : tokens.accent,
          }}
        />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Row gap={8} align="center" justify="space-between">
            <Text
              kind="body-lg"
              numberOfLines={1}
              style={{
                fontWeight: item.read ? "500" : "600",
                flex: 1,
                minWidth: 0,
              }}
            >
              {item.title || "(untitled)"}
            </Text>
            <Text kind="caption" color={tokens.ink3} style={{ flexShrink: 0 }}>
              {formatRelative(Math.floor(item.receivedAt / 1000))}
            </Text>
          </Row>
          {item.body ? (
            <Text kind="body" color={tokens.ink3} numberOfLines={2}>
              {item.body}
            </Text>
          ) : null}
          {isCronOutput(item.data) ? (
            <Row gap={4} style={{ marginTop: 2 }}>
              <Chip>cron output</Chip>
            </Row>
          ) : null}
        </View>
      </Pressable>
    </ReanimatedSwipeable>
  );
}

function SwipeActionBg({
  drag,
  archived,
}: {
  drag: SharedValue<number>;
  archived: boolean;
}) {
  const tokens = useThemeTokens();
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: drag.value + 80 }],
  }));
  return (
    <View
      style={{
        width: 80,
        backgroundColor: tokens.accent,
        justifyContent: "center",
      }}
    >
      <Animated.View style={[{ alignItems: "center" }, animStyle]}>
        <Icon name="archive" size={20} color={tokens.surface} />
        <Text
          kind="caption"
          color={tokens.surface}
          style={{ marginTop: 4, fontWeight: "600" }}
        >
          {archived ? "Unarchive" : "Archive"}
        </Text>
      </Animated.View>
    </View>
  );
}
