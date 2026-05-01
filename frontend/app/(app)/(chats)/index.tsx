/**
 * Sessions list — Stage 6 redesign.
 *
 * Visual target: design/screens-1.jsx::SessionList (lines 97-165). Replaces
 * the legacy StyleSheet implementation. All business logic (listSessions,
 * createSession, archive/delete/rename mutations) is preserved.
 *
 * Filter state is local. "Running" / "awaiting approval" badges are derived
 * by cross-referencing the chat-store: a session is `running` if it has an
 * in-flight stream, and `awaiting` if its pendingApprovals queue is non-empty.
 * Sessions not yet present in the chat-store are treated as idle.
 */
import { useCallback, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type ListRenderItem,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";

import {
  Chip,
  EmptyState,
  HermesMark,
  Icon,
  Input,
  NavBar,
  NavIcon,
  PhoneSafeArea,
  Row,
  Stack,
  StatusPill,
  Text,
  useThemeTokens,
} from "@/components/ui";
import {
  archiveSession,
  createSession,
  deleteSession,
  listSessions,
  renameSession,
} from "@/api/sessions";
import type { SessionDto } from "@/api/types";
import { useChatStore } from "@/state/chat-store";
import { formatRelative } from "@/util/time";

const QUERY_KEY = ["sessions"] as const;

type FilterKey = "all" | "running" | "awaiting" | "archived";

interface SessionRow extends SessionDto {
  badge: "running" | "approval" | null;
}

function tabBarBottomPadding(): number {
  // Floating tab bar height (~56) + slack so last row clears the pill.
  return 140;
}

export default function SessionsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const tokens = useThemeTokens();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");

  const sessionsQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listSessions,
  });

  // Reach into the chat-store directly so we re-render when streaming or
  // approvals change. We only need a thin derived view, not the full state.
  const byId = useChatStore((s) => s.byId);

  const create = useMutation({
    mutationFn: () => createSession(),
    onSuccess: (s) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      router.push({ pathname: "/chat/[id]", params: { id: s.id } });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteSession(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      archiveSession(id, archived),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      renameSession(id, title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const allSessions = sessionsQuery.data?.sessions ?? [];

  // Derive badge state per session from the chat-store snapshot.
  const decorated: SessionRow[] = useMemo(() => {
    return allSessions.map((s) => {
      const cs = byId[s.id];
      const badge: SessionRow["badge"] =
        cs?.pendingApprovals && cs.pendingApprovals.length > 0
          ? "approval"
          : cs?.isStreaming
            ? "running"
            : null;
      return { ...s, badge };
    });
  }, [allSessions, byId]);

  // Counts shown in the filter chips. Computed off the un-filtered list so
  // chip labels stay stable across filter toggles.
  const counts = useMemo(() => {
    let total = 0;
    let running = 0;
    let awaiting = 0;
    let archived = 0;
    for (const s of decorated) {
      if (s.archived) archived += 1;
      else {
        total += 1;
        if (s.badge === "running") running += 1;
        if (s.badge === "approval") awaiting += 1;
      }
    }
    return { total, running, awaiting, archived };
  }, [decorated]);

  // Apply filter + search query.
  const filtered: SessionRow[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    return decorated.filter((s) => {
      if (filter === "archived") {
        if (!s.archived) return false;
      } else {
        if (s.archived) return false;
        if (filter === "running" && s.badge !== "running") return false;
        if (filter === "awaiting" && s.badge !== "approval") return false;
      }
      if (q.length === 0) return true;
      const hay = `${s.title.toLowerCase()} ${(s.preview ?? "").toLowerCase()}`;
      return hay.includes(q);
    });
  }, [decorated, filter, query]);

  const onLongPress = useCallback(
    (s: SessionRow) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
        () => undefined,
      );
      const archiveLabel = s.archived ? "Unarchive" : "Archive";
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title: s.title,
            options: ["Cancel", "Pin", "Rename", archiveLabel, "Delete"],
            destructiveButtonIndex: 4,
            cancelButtonIndex: 0,
          },
          (idx) => {
            if (idx === 1) {
              // Pin not yet implemented (see report). Surface as no-op so
              // long-press flow stays predictable.
              return;
            }
            if (idx === 2) {
              Alert.prompt?.(
                "Rename session",
                "New title",
                (text) => {
                  if (text && text.trim()) {
                    rename.mutate({ id: s.id, title: text.trim() });
                  }
                },
                "plain-text",
                s.title,
              );
              return;
            }
            if (idx === 3) {
              archive.mutate({ id: s.id, archived: !s.archived });
              return;
            }
            if (idx === 4) {
              Alert.alert("Delete session?", "This cannot be undone.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: () => remove.mutate(s.id),
                },
              ]);
            }
          },
        );
        return;
      }
      // Android: cascading Alerts. ActionSheet equivalent isn't built-in.
      Alert.alert(s.title, undefined, [
        { text: "Pin", onPress: () => undefined },
        {
          text: "Rename",
          onPress: () => {
            Alert.prompt?.(
              "Rename session",
              "New title",
              (text) => {
                if (text && text.trim()) {
                  rename.mutate({ id: s.id, title: text.trim() });
                }
              },
              "plain-text",
              s.title,
            );
          },
        },
        {
          text: archiveLabel,
          onPress: () => archive.mutate({ id: s.id, archived: !s.archived }),
        },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            Alert.alert("Delete session?", "This cannot be undone.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Delete",
                style: "destructive",
                onPress: () => remove.mutate(s.id),
              },
            ]),
        },
        { text: "Cancel", style: "cancel" },
      ]);
    },
    [archive, remove, rename],
  );

  const onSettings = useCallback(() => {
    router.push("/(settings)" as const);
  }, [router]);

  const onSearchPress = useCallback(() => {
    router.push("/(chats)/search" as const);
  }, [router]);

  const onCreate = useCallback(() => {
    create.mutate();
  }, [create]);

  // Subtitle on the large NavBar: total sessions + active count.
  const headerSubtitle = useMemo(() => {
    const total = allSessions.filter((s) => !s.archived).length;
    const active = counts.running + counts.awaiting;
    if (total === 0) return "No sessions yet";
    return `${total} session${total === 1 ? "" : "s"} · ${active} active`;
  }, [allSessions, counts]);

  const renderItem = useCallback<ListRenderItem<SessionRow>>(
    ({ item, index }) => (
      <SessionRowView
        item={item}
        isLast={index === filtered.length - 1}
        onPress={() =>
          router.push({ pathname: "/chat/[id]", params: { id: item.id } })
        }
        onLongPress={() => onLongPress(item)}
      />
    ),
    [filtered.length, onLongPress, router],
  );

  const keyExtractor = useCallback((item: SessionRow) => item.id, []);

  return (
    <PhoneSafeArea>
      <NavBar
        large
        title="Chats"
        subtitle={headerSubtitle}
        leading={<HermesMark size={22} />}
        trailing={
          <>
            <NavIcon name="search" onPress={onSearchPress} />
            <NavIcon name="cog" onPress={onSettings} />
          </>
        }
      />

      {/* Search + filter chips. Stays pinned above the scrolling list. */}
      <Stack
        gap={10}
        style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}
      >
        <Input
          value={query}
          onChange={setQuery}
          placeholder="Search chats"
          icon="search"
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, paddingRight: 8 }}
        >
          <Chip
            active={filter === "all"}
            onPress={() => setFilter("all")}
          >{`All · ${counts.total}`}</Chip>
          <Chip
            active={filter === "running"}
            onPress={() => setFilter("running")}
          >{`● Running · ${counts.running}`}</Chip>
          <Chip
            active={filter === "awaiting"}
            onPress={() => setFilter("awaiting")}
          >{`Awaiting · ${counts.awaiting}`}</Chip>
          <Chip
            active={filter === "archived"}
            onPress={() => setFilter("archived")}
          >{`Archived · ${counts.archived}`}</Chip>
        </ScrollView>
      </Stack>

      <FlatList
        data={filtered}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={{
          paddingBottom: tabBarBottomPadding(),
          flexGrow: 1,
        }}
        ListEmptyComponent={
          sessionsQuery.isLoading ? null : (
            <EmptyState
              icon="terminal"
              title="No chats yet"
              body="Tap + to start a conversation."
            />
          )
        }
        refreshControl={
          <RefreshControl
            refreshing={sessionsQuery.isFetching && !sessionsQuery.isLoading}
            onRefresh={() => sessionsQuery.refetch()}
            tintColor={tokens.ink3}
          />
        }
      />

      {/* FAB: + new chat. Sits above the floating tab bar. */}
      <Pressable
        onPress={onCreate}
        accessibilityRole="button"
        accessibilityLabel="New chat"
        disabled={create.isPending}
        style={{
          position: "absolute",
          right: 20,
          bottom: 80,
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: tokens.ink,
          alignItems: "center",
          justifyContent: "center",
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 6 },
          elevation: 6,
          opacity: create.isPending ? 0.6 : 1,
        }}
      >
        <Icon name="plus" size={22} color={tokens.surface} />
      </Pressable>
    </PhoneSafeArea>
  );
}

// ─── row component ──────────────────────────────────────────────────────────

interface SessionRowViewProps {
  item: SessionRow;
  isLast: boolean;
  onPress: () => void;
  onLongPress: () => void;
}

function SessionRowView({
  item,
  isLast,
  onPress,
  onLongPress,
}: SessionRowViewProps) {
  const tokens = useThemeTokens();
  const barColor =
    item.badge === "running"
      ? tokens.accent
      : item.badge === "approval"
        ? tokens.warning
        : "transparent";
  const titleWeight: "500" | "600" = item.badge === "running" ? "600" : "500";
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => ({
        opacity: pressed ? 0.7 : 1,
        paddingVertical: 14,
        paddingHorizontal: 16,
        flexDirection: "row",
        gap: 12,
        alignItems: "flex-start",
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: tokens.lineSoft,
      })}
    >
      <View
        style={{
          width: 6,
          alignSelf: "stretch",
          borderRadius: 3,
          marginTop: 4,
          marginBottom: 4,
          backgroundColor: barColor,
        }}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Row gap={8} align="center" justify="space-between">
          <Text
            kind="body-lg"
            numberOfLines={1}
            style={{ fontWeight: titleWeight, flex: 1, minWidth: 0 }}
          >
            {item.archived ? "[archived] " : ""}
            {item.title}
          </Text>
          <Text kind="caption" color={tokens.ink3} style={{ flexShrink: 0 }}>
            {formatRelative(item.updatedAt)}
          </Text>
        </Row>
        {item.preview ? (
          <Text kind="body" color={tokens.ink3} numberOfLines={1}>
            {item.preview}
          </Text>
        ) : (
          <Text
            kind="body"
            color={tokens.ink3}
            style={{ fontStyle: "italic" }}
            numberOfLines={1}
          >
            no messages yet
          </Text>
        )}
        {item.badge ? (
          <Row gap={4} style={{ marginTop: 2 }}>
            <StatusPill
              kind="connecting"
              label={
                item.badge === "running"
                  ? "running"
                  : "awaiting approval"
              }
            />
          </Row>
        ) : null}
      </View>
    </Pressable>
  );
}
