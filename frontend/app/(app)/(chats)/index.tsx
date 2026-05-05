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
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";

import {
  ActionSheet,
  Button,
  Chip,
  EmptyState,
  HermesMark,
  Icon,
  Input,
  NavBar,
  NavIcon,
  PhoneSafeArea,
  Row,
  Sheet,
  SkeletonGroup,
  Stack,
  StatusPill,
  Text,
  useThemeTokens,
  type ActionSheetHandle,
  type SheetHandle,
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
import { usePinnedSessions } from "@/state/pinned-sessions";
import { useSessionTags } from "@/state/session-tags";
import { QuickSwitcher, type QuickSwitcherHandle } from "@/search";
import { formatRelative } from "@/util/time";

const QUERY_KEY = ["sessions"] as const;

// Filter chips: presets first, then any user-defined tags get rendered as
// `tag:<name>` selections. Stored as a single string for easy useState.
type FilterKey = "all" | "running" | "awaiting" | "archived" | `tag:${string}`;

interface SessionRow extends SessionDto {
  badge: "running" | "approval" | null;
  pinned: boolean;
  tags: string[];
}

function tabBarBottomPadding(): number {
  // Floating tab bar height (~56) + slack so last row clears the pill.
  return 140;
}

export default function SessionsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const tokens = useThemeTokens();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<FilterKey>("all");
  // RefreshControl spinner is bound to user-initiated pulls only — binding to
  // `isFetching` causes a stuck spinner whenever useFocusEffect or the WS
  // event listener invalidates the sessions query in the background, because
  // the spinner appears before the user even sees the screen.
  const [pullRefreshing, setPullRefreshing] = useState(false);

  // Floating tab bar consumes ~60pt above the safe-area home indicator.
  // FAB sits 16pt above that.
  const fabBottom = Math.max(insets.bottom, 12) + 60 + 16;

  const sessionsQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listSessions,
    // Refetch every time the screen mounts (i.e. user navigates back to the
    // tab). Catches title/preview changes from the chat screen even if the
    // chat-screen-side invalidation didn't fire.
    refetchOnMount: "always",
  });

  // Refetch on tab focus too — covers the case where the screen is mounted
  // but the user was on a different tab and just switched back.
  useFocusEffect(
    useCallback(() => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    }, [queryClient]),
  );

  // Reach into the chat-store directly so we re-render when streaming or
  // approvals change. We only need a thin derived view, not the full state.
  const byId = useChatStore((s) => s.byId);
  const pinnedMap = usePinnedSessions((s) => s.pinned);
  const togglePinned = usePinnedSessions((s) => s.togglePinned);
  const tagsBySession = useSessionTags((s) => s.tagsBySession);
  const setSessionTags = useSessionTags((s) => s.setTags);

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
      return {
        ...s,
        badge,
        pinned: !!pinnedMap[s.id],
        tags: tagsBySession[s.id] ?? [],
      };
    });
  }, [allSessions, byId, pinnedMap, tagsBySession]);

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

  // Apply filter, then surface pinned sessions to the top. The underlying API
  // list is already sorted by updatedAt desc; we preserve that order within
  // each partition (pinned vs unpinned).
  const filtered: SessionRow[] = useMemo(() => {
    const tagFilter = filter.startsWith("tag:") ? filter.slice(4) : null;
    const matched = decorated.filter((s) => {
      if (filter === "archived") {
        if (!s.archived) return false;
      } else {
        if (s.archived) return false;
        if (filter === "running" && s.badge !== "running") return false;
        if (filter === "awaiting" && s.badge !== "approval") return false;
        if (tagFilter && !s.tags.includes(tagFilter)) return false;
      }
      return true;
    });
    if (filter === "archived") return matched;
    const pinned = matched.filter((s) => s.pinned);
    const rest = matched.filter((s) => !s.pinned);
    return [...pinned, ...rest];
  }, [decorated, filter]);

  // Distinct tags across all sessions, used to render the per-tag filter
  // chips after the four built-in presets.
  const distinctTags = useMemo<string[]>(() => {
    const seen = new Set<string>();
    for (const s of decorated) {
      for (const t of s.tags) seen.add(t);
    }
    return Array.from(seen).sort();
  }, [decorated]);

  // Long-press opens our themed ActionSheet (cross-platform, replaces the
  // native iOS ActionSheetIOS + Android cascading Alerts).
  const [tagsEditTarget, setTagsEditTarget] = useState<SessionRow | null>(null);
  const tagsSheetRef = useRef<SheetHandle>(null);
  const actionSheetRef = useRef<ActionSheetHandle>(null);
  const quickSwitcherRef = useRef<QuickSwitcherHandle>(null);
  const openTagsEditor = useCallback((s: SessionRow) => {
    setTagsEditTarget(s);
    setTimeout(() => tagsSheetRef.current?.present(), 50);
  }, []);
  const promptRename = useCallback(
    (s: SessionRow) => {
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
    [rename],
  );
  const confirmDelete = useCallback(
    (s: SessionRow) => {
      Alert.alert("Delete session?", "This cannot be undone.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => remove.mutate(s.id),
        },
      ]);
    },
    [remove],
  );
  const onLongPress = useCallback(
    (s: SessionRow) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
        () => undefined,
      );
      const archiveLabel = s.archived ? "Unarchive" : "Archive";
      const pinLabel = s.pinned ? "Unpin" : "Pin";
      const subtitle =
        s.badge === "running"
          ? "running"
          : s.badge === "approval"
            ? "awaiting approval"
            : s.archived
              ? "archived"
              : undefined;
      actionSheetRef.current?.present({
        title: s.title,
        subtitle,
        actions: [
          {
            id: "pin",
            label: pinLabel,
            icon: "pin",
            onPress: () => togglePinned(s.id),
          },
          {
            id: "tags",
            label: "Edit tags",
            icon: "hash",
            onPress: () => openTagsEditor(s),
          },
          {
            id: "rename",
            label: "Rename",
            icon: "edit",
            onPress: () => promptRename(s),
          },
          {
            id: "archive",
            label: archiveLabel,
            icon: "archive",
            onPress: () =>
              archive.mutate({ id: s.id, archived: !s.archived }),
          },
          {
            id: "delete",
            label: "Delete",
            icon: "trash",
            destructive: true,
            onPress: () => confirmDelete(s),
          },
        ],
      });
    },
    [archive, togglePinned, openTagsEditor, promptRename, confirmDelete],
  );

  // Tapping the search NavIcon opens the QuickSwitcher modal. Direct ref
  // call mirrors the actionSheetRef / tagsSheetRef pattern in this file —
  // a state-driven approach via Zustand silently no-op'd inside gorhom v5.
  const onSearchPress = useCallback(() => {
    quickSwitcherRef.current?.present();
  }, []);

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
        titleAction={<NavIcon name="search" onPress={onSearchPress} />}
      />

      {/* Filter chips. Stays pinned above the scrolling list. The legacy
          "Search chats" client-side filter Input was removed in favor of the
          full-text QuickSwitcher modal — the title-bar magnifying glass is
          the single search entry point. */}
      <Stack
        gap={10}
        style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}
      >
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
          {distinctTags.map((t) => {
            const key: FilterKey = `tag:${t}`;
            return (
              <Chip
                key={key}
                active={filter === key}
                onPress={() => setFilter(key)}
              >{`#${t}`}</Chip>
            );
          })}
        </ScrollView>
      </Stack>

      <FlashList
        data={filtered}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={{
          paddingBottom: tabBarBottomPadding(),
        }}
        ListEmptyComponent={
          sessionsQuery.isLoading ? (
            <SkeletonGroup count={6} />
          ) : (
            <EmptyState
              icon="terminal"
              title="No chats yet"
              body="Tap + to start a conversation."
            />
          )
        }
        refreshControl={
          <RefreshControl
            refreshing={pullRefreshing}
            onRefresh={async () => {
              setPullRefreshing(true);
              try {
                await sessionsQuery.refetch();
              } finally {
                setPullRefreshing(false);
              }
            }}
            tintColor={tokens.accent}
            colors={[tokens.accent]}
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
          bottom: fabBottom,
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

      <ActionSheet ref={actionSheetRef} />

      <QuickSwitcher ref={quickSwitcherRef} />


      <Sheet
        ref={tagsSheetRef}
        snapPoints={["55%"]}
        onChange={(idx) => {
          if (idx < 0) setTagsEditTarget(null);
        }}
      >
        {tagsEditTarget ? (
          <TagsEditor
            sessionId={tagsEditTarget.id}
            sessionTitle={tagsEditTarget.title}
            initialTags={tagsEditTarget.tags}
            onSave={(tags) => {
              setSessionTags(tagsEditTarget.id, tags);
              tagsSheetRef.current?.dismiss();
            }}
            onClose={() => tagsSheetRef.current?.dismiss()}
          />
        ) : null}
      </Sheet>
    </PhoneSafeArea>
  );
}

function TagsEditor({
  sessionTitle,
  initialTags,
  onSave,
  onClose,
}: {
  sessionId: string;
  sessionTitle: string;
  initialTags: string[];
  onSave: (tags: string[]) => void;
  onClose: () => void;
}) {
  const tokens = useThemeTokens();
  const [tags, setTags] = useState<string[]>(initialTags);
  const [draft, setDraft] = useState("");
  const onAdd = useCallback(() => {
    const trimmed = draft.trim().toLowerCase();
    if (!trimmed) return;
    if (tags.includes(trimmed)) {
      setDraft("");
      return;
    }
    setTags((prev) => [...prev, trimmed]);
    setDraft("");
  }, [draft, tags]);
  const onRemove = useCallback((t: string) => {
    setTags((prev) => prev.filter((x) => x !== t));
  }, []);
  return (
    <Stack gap={14} style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 }}>
      <Stack gap={4}>
        <Text kind="h3">Tags</Text>
        <Text kind="caption" color={tokens.ink3} numberOfLines={1}>
          {sessionTitle}
        </Text>
      </Stack>

      {tags.length > 0 ? (
        <Row gap={6} style={{ flexWrap: "wrap" }}>
          {tags.map((t) => (
            <Pressable
              key={t}
              onPress={() => onRemove(t)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 999,
                backgroundColor: pressed ? tokens.line : tokens.chip,
              })}
            >
              <Text kind="caption" color={tokens.ink2}>
                {t}
              </Text>
              <Icon name="close" size={10} color={tokens.ink3} />
            </Pressable>
          ))}
        </Row>
      ) : (
        <Text kind="caption" color={tokens.ink3}>
          No tags yet. Add a few to organize this chat.
        </Text>
      )}

      <Input
        value={draft}
        onChange={setDraft}
        placeholder="Add a tag (e.g. work, research)"
        onSubmit={onAdd}
      />
      <Row gap={8}>
        <Button kind="secondary" full onPress={onClose}>
          Cancel
        </Button>
        <Button kind="accent" full onPress={() => onSave(tags)}>
          Save
        </Button>
      </Row>
    </Stack>
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
          <Row gap={6} align="center" style={{ flex: 1, minWidth: 0 }}>
            {item.pinned ? (
              <Icon name="pin" size={12} color={tokens.accent} />
            ) : null}
            <Text
              kind="body-lg"
              numberOfLines={1}
              style={{ fontWeight: titleWeight, flex: 1, minWidth: 0 }}
            >
              {item.archived ? "[archived] " : ""}
              {item.title}
            </Text>
          </Row>
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
        {item.badge || item.tags.length > 0 ? (
          <Row gap={4} style={{ marginTop: 4, flexWrap: "wrap" }}>
            {item.badge ? (
              <StatusPill
                kind="connecting"
                label={
                  item.badge === "running"
                    ? "running"
                    : "awaiting approval"
                }
              />
            ) : null}
            {item.tags.slice(0, 3).map((t) => (
              <View
                key={t}
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 4,
                  backgroundColor: tokens.chip,
                }}
              >
                <Text kind="micro" color={tokens.ink2}>
                  #{t}
                </Text>
              </View>
            ))}
            {item.tags.length > 3 ? (
              <Text kind="micro" color={tokens.ink3}>
                +{item.tags.length - 3}
              </Text>
            ) : null}
          </Row>
        ) : null}
      </View>
    </Pressable>
  );
}

