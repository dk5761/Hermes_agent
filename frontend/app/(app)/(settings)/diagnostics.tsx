/**
 * Diagnostics — Stage 4 (Logs & diagnostics).
 *
 * Mirrors design/screens-3.jsx::LogsScreen. Top SegControl picks a log
 * stream (Hermes / Server / Network), Input filters client-side, and a
 * virtualised list shows tail-N lines. Long-press a row to copy it.
 *
 * Hermes' /api/logs returns `{ file, lines: string[] }`. Each line may be a
 * raw text string or a JSON-encoded pino payload — we sniff for `{...}` and
 * extract `level`, `time`, `msg` when present, otherwise fall through to a
 * regex tuned for the raw `[ISO] [tag] message` format used by the agent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  type ListRenderItemInfo,
  Pressable,
  RefreshControl,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { sqliteKv } from "@/state/sqlite-kv";
import {
  getDbStats,
  vacuumDb,
  clearRqCache,
  wipeEverything,
  type DbStats,
} from "@/db/diagnostics";
import {
  clearAudioCache,
  getAudioCacheBytes,
} from "@/audio/playback-controller";

import {
  Button,
  EmptyState,
  Input,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  Row,
  SegControl,
  Stack,
  StatusPill,
  Text,
  Toggle,
  showToast,
  useThemeTokens,
  useToast,
} from "@/components/ui";
import { getLogs, type LogFile } from "@/api/logs";
import { usePendingSends } from "@/state/pending-sends";
import { usePendingMutations } from "@/state/pending-mutations";
import { useDevSettings } from "@/state/dev-settings";

type Tab = "hermes" | "server" | "network";

const TAB_OPTIONS = [
  { value: "hermes" as const, label: "Hermes" },
  { value: "server" as const, label: "Server" },
  { value: "network" as const, label: "Network" },
];

const TAB_TO_FILE: Record<Tab, LogFile> = {
  hermes: "agent",
  server: "errors",
  network: "web",
};

type Level = "info" | "warn" | "error" | null;

interface ParsedLine {
  /** Stable index into the original buffer (used as React key). */
  idx: number;
  /** Raw line, kept for copy-to-clipboard. */
  raw: string;
  /** Display timestamp (ISO substring or HH:MM:SS) — empty when absent. */
  ts: string;
  /** Detected level — null when not derivable. */
  level: Level;
  /** Best-effort message body (everything after timestamp + level). */
  message: string;
}

const ISO_TIMESTAMP_RE =
  /^\[(\d{4}-\d{2}-\d{2}T[\d:.Z+-]+)\]\s*(?:\[([^\]]+)\])?\s*(.*)$/;

function normalizeLevel(s: string | undefined): Level {
  if (!s) return null;
  const v = s.toLowerCase();
  if (v.includes("err") || v === "fatal" || v.includes("crit")) return "error";
  if (v.includes("warn")) return "warn";
  if (v.includes("info") || v.includes("debug") || v.includes("trace")) return "info";
  return null;
}

function parseLine(raw: string, idx: number): ParsedLine {
  // Try JSON (pino structured) first — cheap because most agent lines start
  // with '[' so we only attempt JSON.parse when the line begins with '{'.
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const ts =
        typeof obj.time === "number"
          ? new Date(obj.time).toISOString()
          : typeof obj.time === "string"
            ? obj.time
            : typeof obj.ts === "string"
              ? obj.ts
              : "";
      const level = normalizeLevel(
        typeof obj.level === "string"
          ? obj.level
          : typeof obj.level === "number"
            ? // pino numeric levels: 30=info, 40=warn, 50=error, 60=fatal
              obj.level >= 50
              ? "error"
              : obj.level >= 40
                ? "warn"
                : "info"
            : undefined,
      );
      const message =
        typeof obj.msg === "string"
          ? obj.msg
          : typeof obj.message === "string"
            ? obj.message
            : raw;
      return { idx, raw, ts, level, message };
    } catch {
      // Fall through to text path.
    }
  }

  // Text path: `[ISO] [tag] rest...`
  const m = raw.match(ISO_TIMESTAMP_RE);
  if (m && typeof m[1] === "string") {
    const ts = m[1];
    const tag = m[2];
    const rest = m[3] ?? "";
    return { idx, raw, ts, level: normalizeLevel(tag), message: rest };
  }
  return { idx, raw, ts: "", level: null, message: raw };
}

function levelKind(level: Level): "online" | "connecting" | "offline" | null {
  // Reuses StatusPill kinds to avoid net-new visual surface area.
  if (level === "error") return "offline";
  if (level === "warn") return "connecting";
  if (level === "info") return "online";
  return null;
}

function levelLabel(level: Level): string {
  return level ?? "log";
}

export default function DiagnosticsScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const tokens = useThemeTokens();
  const toast = useToast();

  const [tab, setTab] = useState<Tab>("hermes");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const file: LogFile = TAB_TO_FILE[tab];

  const logsQ = useQuery({
    queryKey: ["logs", file],
    queryFn: () => getLogs(file, 200),
    staleTime: 2_000,
    retry: false,
  });

  // Auto-refresh every 5s while toggle is on. Cleanup on unmount + tab swap.
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (!autoRefresh) return;
    intervalRef.current = setInterval(() => {
      void qc.invalidateQueries({ queryKey: ["logs", file] });
    }, 5_000);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, file, qc]);

  const parsed = useMemo<ParsedLine[]>(() => {
    const lines = logsQ.data?.lines ?? [];
    const all = lines.map((raw, i) => parseLine(raw, i));
    if (!search.trim()) return all;
    const needle = search.trim().toLowerCase();
    return all.filter(
      (p) => p.raw.toLowerCase().includes(needle),
    );
  }, [logsQ.data, search]);

  const onLongPressLine = useCallback(
    async (line: ParsedLine) => {
      // Tap-and-hold to copy is a hidden gesture; the haptic is the only
      // confirmation the user gets that the gesture was recognized.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
        () => undefined,
      );
      try {
        await Clipboard.setStringAsync(line.raw);
        toast.show("Line copied", "success");
      } catch {
        toast.show("Copy failed", "error");
      }
    },
    [toast],
  );

  const onPressLine = useCallback((line: ParsedLine) => {
    setExpanded((prev) => ({ ...prev, [line.idx]: !prev[line.idx] }));
  }, []);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ParsedLine>) => {
      const isExpanded = !!expanded[item.idx];
      const kind = levelKind(item.level);
      return (
        <Pressable
          onPress={() => onPressLine(item)}
          onLongPress={() => onLongPressLine(item)}
          delayLongPress={300}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderBottomWidth: 1,
            borderBottomColor: tokens.lineSoft,
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 8,
          }}
        >
          <Text
            kind="mono"
            mono
            color={tokens.ink3}
            style={{ fontSize: 10, lineHeight: 14, width: 78 }}
            numberOfLines={1}
          >
            {item.ts ? item.ts.slice(11, 19) : ""}
          </Text>
          <View style={{ width: 64, alignItems: "flex-start" }}>
            {kind ? (
              <StatusPill kind={kind} label={levelLabel(item.level)} />
            ) : (
              <Text kind="micro" color={tokens.ink3}>
                ·
              </Text>
            )}
          </View>
          <Text
            kind="mono"
            mono
            color={tokens.ink2}
            style={{ flex: 1, fontSize: 11, lineHeight: 15 }}
            numberOfLines={isExpanded ? undefined : 1}
          >
            {item.message || item.raw}
          </Text>
        </Pressable>
      );
    },
    [expanded, onLongPressLine, onPressLine, tokens.ink2, tokens.ink3, tokens.lineSoft],
  );

  const headerRight = (
    <Row gap={8} align="center">
      <Text kind="caption" className="text-ink-3">
        Tail
      </Text>
      <Toggle on={autoRefresh} onChange={setAutoRefresh} />
    </Row>
  );

  const isLoading = logsQ.isLoading;
  const isError = logsQ.isError;
  const hasLines = parsed.length > 0;

  return (
    <PhoneSafeArea>
      <NavBar
        title="Logs & diagnostics"
        onBack={() => router.back()}
        trailing={headerRight}
      />
      <StorageCard />
      <SyncDiagnostics />
      <Stack gap={10} style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
        <SegControl
          options={TAB_OPTIONS}
          value={tab}
          onChange={(v) => setTab(v as Tab)}
        />
        <Input
          value={search}
          onChange={setSearch}
          icon="search"
          placeholder="Filter…"
        />
        <Row align="center" justify="space-between">
          <Text kind="caption" mono className="text-ink-3">
            {file}.log · {parsed.length} lines
          </Text>
          <Text kind="caption" className="text-ink-3">
            {autoRefresh ? "Tail · 5s" : "Manual"}
          </Text>
        </Row>
      </Stack>

      <View
        className="bg-sunken border border-line-soft"
        style={{
          flex: 1,
          marginHorizontal: 16,
          marginBottom: 12,
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {isLoading ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={tokens.accent} />
          </View>
        ) : isError ? (
          <EmptyState
            icon="terminal"
            title="Failed to load logs"
            body={(logsQ.error as Error)?.message ?? "Unknown error"}
            action={
              <Button kind="secondary" onClick={() => logsQ.refetch()}>
                Retry
              </Button>
            }
          />
        ) : !hasLines ? (
          <EmptyState
            icon="terminal"
            title="No log lines"
            body={
              search
                ? "Try a different filter."
                : "Hermes hasn't written any lines for this stream yet."
            }
          />
        ) : (
          <FlatList<ParsedLine>
            data={parsed}
            renderItem={renderItem}
            keyExtractor={(item) => String(item.idx)}
            initialNumToRender={40}
            windowSize={5}
            removeClippedSubviews
            refreshControl={
              <RefreshControl
                refreshing={logsQ.isFetching && !logsQ.isLoading}
                onRefresh={() => logsQ.refetch()}
                tintColor={tokens.accent}
                colors={[tokens.accent]}
              />
            }
          />
        )}
      </View>

      <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
        <Button
          kind="secondary"
          full
          leftIcon="download"
          onClick={() => {
            // TODO: wire actual export (share-sheet of the joined buffer).
            toast.show("Export coming soon", "info");
          }}
        >
          Export logs
        </Button>
      </View>
    </PhoneSafeArea>
  );
}

// ─── storage card ────────────────────────────────────────────────────────────

/** Formats raw bytes to a human-readable KB / MB string. */
function formatBytes(bytes: number): string {
  if (bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function StorageCard() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [stats, setStats] = useState<DbStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [vacuuming, setVacuuming] = useState(false);
  const [audioCacheBytes, setAudioCacheBytes] = useState<number>(-1);
  const [clearingAudioCache, setClearingAudioCache] = useState(false);

  const fetchStats = useCallback(() => {
    setLoading(true);
    setAudioCacheBytes(getAudioCacheBytes());
    getDbStats()
      .then(setStats)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  // Fetch once on mount.
  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const onVacuum = useCallback(() => {
    setVacuuming(true);
    vacuumDb()
      .then(() => {
        toast.show("Vacuum complete", "success");
        fetchStats();
      })
      .catch(() => toast.show("Vacuum failed", "error"))
      .finally(() => setVacuuming(false));
  }, [fetchStats, toast]);

  const onClearCache = useCallback(() => {
    Alert.alert(
      "Clear query cache?",
      "Removes persisted query data (sessions list, chat history). Queues and preferences stay.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => {
            clearRqCache()
              .then(() => queryClient.clear())
              .then(() => {
                toast.show("Cache cleared", "info");
                fetchStats();
              })
              .catch(() => toast.show("Clear failed", "error"));
          },
        },
      ],
    );
  }, [fetchStats, queryClient, toast]);

  const onResetQueues = useCallback(() => {
    Alert.alert(
      "Reset all queues?",
      "Drops every queued send and mutation, including failed ones. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: () => {
            // Clear via store APIs so in-memory snapshots stay in sync with DB.
            usePendingSends.getState().clearAll();
            usePendingMutations.getState().clearAll();
            toast.show("Queues reset", "info");
            fetchStats();
          },
        },
      ],
    );
  }, [fetchStats, toast]);

  const onWipeEverything = useCallback(() => {
    Alert.alert(
      "Wipe everything?",
      "Deletes the entire SQLite database and re-creates it from scratch. Auth survives. All other cached data, queues and preferences will be lost.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          style: "destructive",
          onPress: () => {
            // Second confirmation — extra friction for the nuclear action.
            Alert.alert(
              "Are you absolutely sure?",
              "This cannot be undone. The app will need a restart after wiping.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Wipe",
                  style: "destructive",
                  onPress: () => {
                    wipeEverything()
                      .then(() => {
                        toast.show(
                          "Database wiped. Please restart the app.",
                          "info",
                        );
                        fetchStats();
                      })
                      .catch(() => toast.show("Wipe failed", "error"));
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }, [fetchStats, toast]);

  const onClearAudioCache = useCallback(() => {
    Alert.alert(
      "Clear voice cache?",
      `Removes downloaded audio files (${formatBytes(audioCacheBytes)}). They will re-download on next playback.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => {
            setClearingAudioCache(true);
            clearAudioCache()
              .then(() => {
                toast.show("Voice cache cleared", "info");
                setAudioCacheBytes(0);
              })
              .catch(() => toast.show("Clear failed", "error"))
              .finally(() => setClearingAudioCache(false));
          },
        },
      ],
    );
  }, [audioCacheBytes, toast]);

  return (
    <Stack gap={6} style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
      <Row align="center" justify="space-between" style={{ paddingLeft: 4 }}>
        <Text kind="micro" className="text-ink-3 uppercase">
          Storage
        </Text>
        <Pressable onPress={fetchStats} hitSlop={8}>
          <Text kind="micro" className="text-ink-3">
            {loading ? "…" : "↻"}
          </Text>
        </Pressable>
      </Row>
      <ListGroup>
        <ListRow
          title="DB file size"
          detail={stats ? formatBytes(stats.fileBytes) : "—"}
          icon="database"
        />
        <ListRow
          title="rq_cache"
          detail={stats ? String(stats.rqCache) : "—"}
          icon="archive"
        />
        <ListRow
          title="kv"
          detail={stats ? String(stats.kv) : "—"}
          icon="hash"
        />
        <ListRow
          title="pending_mutations"
          detail={stats ? String(stats.pendingMutations) : "—"}
          icon="refresh"
        />
        <ListRow
          title="pending_sends"
          detail={stats ? String(stats.pendingSends) : "—"}
          icon="send"
        />
        <ListRow
          title="meta"
          detail={stats ? String(stats.meta) : "—"}
          icon="more"
        />
        <ListRow
          title="voice cache"
          detail={audioCacheBytes >= 0 ? formatBytes(audioCacheBytes) : "—"}
          icon="mic"
        />
      </ListGroup>
      <Stack gap={8} style={{ paddingTop: 4 }}>
        <Button
          kind="secondary"
          full
          disabled={vacuuming}
          onClick={onVacuum}
        >
          {vacuuming ? "Vacuuming…" : "Vacuum"}
        </Button>
        <Button kind="secondary" full onClick={onClearCache}>
          Clear cache
        </Button>
        <Button
          kind="secondary"
          full
          disabled={clearingAudioCache || audioCacheBytes === 0}
          onClick={onClearAudioCache}
        >
          {clearingAudioCache ? "Clearing…" : "Clear voice cache"}
        </Button>
        <Button kind="danger" full onClick={onResetQueues}>
          Reset all queues
        </Button>
        <Button kind="danger" full onClick={onWipeEverything}>
          Wipe everything
        </Button>
      </Stack>
    </Stack>
  );
}

// ─── sync diagnostics ───────────────────────────────────────────────────────

const RQ_CACHE_KEY = "hermes.rq.cache.v1";

function SyncDiagnostics() {
  const queryClient = useQueryClient();
  const sendsCount = usePendingSends((s) => Object.keys(s.frames).length);
  const mutQueue = usePendingMutations((s) => s.queue);
  const mutPending = usePendingMutations((s) => s.pendingCount());
  const mutFailed = usePendingMutations((s) => s.failedCount());

  const onMutationsRow = useCallback(() => {
    if (mutFailed === 0 && mutPending === 0) return;
    const opts: Array<{ text: string; onPress?: () => void; style?: "destructive" | "cancel" | "default" }> = [];
    if (mutFailed > 0) {
      opts.push({
        text: "Retry failed",
        onPress: () => {
          const ids = usePendingMutations
            .getState()
            .queue.filter((e) => e.failed)
            .map((e) => e.id);
          for (const id of ids) usePendingMutations.getState().resetForRetry(id);
        },
      });
      opts.push({
        text: "Discard failed",
        style: "destructive",
        onPress: () => {
          Alert.alert("Discard failed changes?", "This cannot be undone.", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Discard",
              style: "destructive",
              onPress: () => {
                const ids = usePendingMutations
                  .getState()
                  .queue.filter((e) => e.failed)
                  .map((e) => e.id);
                for (const id of ids) usePendingMutations.getState().remove(id);
              },
            },
          ]);
        },
      });
    }
    opts.push({ text: "Close", style: "cancel" });
    Alert.alert(
      "Pending mutations",
      `${mutPending} pending · ${mutFailed} failed`,
      opts,
    );
  }, [mutFailed, mutPending]);

  const onClearCache = useCallback(() => {
    Alert.alert(
      "Clear cache?",
      "Removes the persisted query cache (sessions list, chat history). Auth, queues and preferences stay.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => {
            void sqliteKv.removeItem(RQ_CACHE_KEY)
              .then(() => queryClient.clear())
              .then(() => {
                showToast("Cache cleared", "info");
              })
              .catch(() => undefined);
          },
        },
      ],
    );
  }, [queryClient]);

  const onResetQueues = useCallback(() => {
    Alert.alert(
      "Reset all queues?",
      "Drops every queued send and mutation, including failed ones. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: () => {
            usePendingSends.getState().clearAll();
            usePendingMutations.getState().clearAll();
            showToast("Queues reset", "info");
          },
        },
      ],
    );
  }, []);

  return (
    <Stack gap={6} style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
      <Text kind="micro" className="text-ink-3 uppercase" style={{ paddingLeft: 4 }}>
        Sync
      </Text>
      <ListGroup>
        <ListRow
          title="Pending sends"
          detail={String(sendsCount)}
          icon="send"
          chevron={sendsCount > 0}
          onPress={() => {
            if (sendsCount === 0) return;
            Alert.alert("Pending sends", `${sendsCount} message${sendsCount === 1 ? "" : "s"} waiting to deliver. They'll send automatically once the network is reachable.`);
          }}
        />
        <ListRow
          title="Pending mutations"
          detail={
            mutFailed > 0
              ? `${mutPending} pending · ${mutFailed} failed`
              : String(mutQueue.length)
          }
          icon="refresh"
          chevron={mutQueue.length > 0}
          onPress={onMutationsRow}
        />
        <ListRow
          title="Clear cache"
          icon="archive"
          chevron
          onPress={onClearCache}
        />
        <ListRow
          title="Reset all queues"
          icon="close"
          danger
          onPress={onResetQueues}
        />
      </ListGroup>
      {__DEV__ ? <DevToolsSection /> : null}
    </Stack>
  );
}

function DevToolsSection() {
  const mockOffline = useDevSettings((s) => s.mockOffline);
  const setMockOffline = useDevSettings((s) => s.setMockOffline);
  return (
    <Stack gap={6} style={{ paddingTop: 16 }}>
      <Text kind="micro" className="text-ink-3 uppercase" style={{ paddingLeft: 4 }}>
        Developer
      </Text>
      <ListGroup>
        <ListRow
          title="Mock offline"
          subtitle={
            mockOffline
              ? "All requests fail; banner + queues active. Metro keeps working."
              : "Toggle to simulate a no-network device for offline-path testing."
          }
          icon="globe"
          right={
            <Toggle
              on={mockOffline}
              onChange={(next) => setMockOffline(next)}
            />
          }
        />
      </ListGroup>
    </Stack>
  );
}
