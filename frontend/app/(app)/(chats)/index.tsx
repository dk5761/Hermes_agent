import { useCallback, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Screen } from "@/components/Screen";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/Button";
import {
  archiveSession,
  createSession,
  deleteSession,
  listSessions,
  renameSession,
} from "@/api/sessions";
import type { SessionDto } from "@/api/types";
import { BORDER, MUTED, ROW, TEXT } from "@/config";
import { formatRelative } from "@/util/time";

const QUERY_KEY = ["sessions"] as const;

export default function SessionsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [renameId, setRenameId] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listSessions,
  });

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
    mutationFn: ({ id, title }: { id: string; title: string }) => renameSession(id, title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const onLongPress = useCallback(
    (s: SessionDto) => {
      Alert.alert(s.title, undefined, [
        {
          text: "Rename",
          onPress: () => {
            // Native prompt only on iOS — fall back to inline edit on Android.
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
            setRenameId(s.id);
          },
        },
        {
          text: s.archived ? "Unarchive" : "Archive",
          onPress: () => archive.mutate({ id: s.id, archived: !s.archived }),
        },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            Alert.alert("Delete session?", "This cannot be undone.", [
              { text: "Cancel", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: () => remove.mutate(s.id) },
            ]),
        },
        { text: "Cancel", style: "cancel" },
      ]);
    },
    [archive, remove, rename],
  );

  const onSettings = useCallback(() => {
    router.push("/(settings)");
  }, [router]);

  const onCreate = useCallback(() => {
    create.mutate();
  }, [create]);

  const renderItem = useCallback(
    ({ item }: { item: SessionDto }) => (
      <Pressable
        onPress={() => router.push({ pathname: "/chat/[id]", params: { id: item.id } })}
        onLongPress={() => onLongPress(item)}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View style={styles.rowMain}>
          <Text style={styles.title} numberOfLines={1}>
            {item.archived ? "[archived] " : ""}
            {item.title}
          </Text>
          {item.preview ? (
            <Text style={styles.preview} numberOfLines={1}>
              {item.preview}
            </Text>
          ) : (
            <Text style={[styles.preview, styles.muted]}>no messages yet</Text>
          )}
        </View>
        <Text style={styles.time}>{formatRelative(item.updatedAt)}</Text>
      </Pressable>
    ),
    [onLongPress, router],
  );

  const keyExtractor = useCallback((item: SessionDto) => item.id, []);

  return (
    <Screen flat>
      <Stack.Screen
        options={{
          title: "Sessions",
          headerRight: () => (
            <View style={styles.headerRight}>
              <Pressable onPress={onSettings} style={styles.headerBtn} accessibilityRole="button">
                <Text style={styles.headerBtnText}>menu</Text>
              </Pressable>
              <Pressable
                onPress={onCreate}
                style={[styles.headerBtn, styles.primaryBtn]}
                disabled={create.isPending}
                accessibilityRole="button"
              >
                <Text style={[styles.headerBtnText, styles.primaryBtnText]}>+ new</Text>
              </Pressable>
            </View>
          ),
        }}
      />
      {sessionsQuery.isLoading ? (
        <Spinner />
      ) : sessionsQuery.isError ? (
        <View style={styles.errorWrap}>
          <Text style={styles.error}>Failed to load sessions.</Text>
          <Button label="Retry" onPress={() => sessionsQuery.refetch()} />
        </View>
      ) : (
        <FlatList
          data={sessionsQuery.data?.sessions ?? []}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          ItemSeparatorComponent={Separator}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.empty}>No sessions yet.</Text>
              <Button label="Start a chat" onPress={onCreate} loading={create.isPending} />
            </View>
          }
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={sessionsQuery.isFetching}
              onRefresh={() => sessionsQuery.refetch()}
              tintColor={MUTED}
            />
          }
        />
      )}
      {/* renameId is stored but rename UI is currently delegated to Alert.prompt on iOS */}
      {renameId ? null : null}
    </Screen>
  );
}

function Separator() {
  return <View style={styles.sep} />;
}

const styles = StyleSheet.create({
  listContent: { paddingVertical: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: ROW,
    gap: 12,
  },
  rowPressed: {
    opacity: 0.6,
  },
  rowMain: { flex: 1, gap: 2 },
  title: { color: TEXT, fontSize: 16, fontWeight: "600" },
  preview: { color: MUTED, fontSize: 13 },
  muted: { fontStyle: "italic" },
  time: { color: MUTED, fontSize: 11 },
  sep: { height: 1, backgroundColor: BORDER, marginLeft: 16 },
  emptyWrap: { padding: 32, gap: 16, alignItems: "stretch" },
  empty: { color: MUTED, fontSize: 14, textAlign: "center" },
  errorWrap: { padding: 16, gap: 12 },
  error: { color: "#FCA5A5", fontSize: 14 },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  headerBtnText: { color: TEXT, fontSize: 14, fontWeight: "600" },
  primaryBtn: { backgroundColor: "#2C6BED" },
  primaryBtnText: { color: "#FFFFFF" },
});
