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
  FlatList,
  type ListRenderItemInfo,
  Pressable,
  RefreshControl,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";

import {
  Button,
  EmptyState,
  Input,
  NavBar,
  PhoneSafeArea,
  Row,
  SegControl,
  Stack,
  StatusPill,
  Text,
  Toggle,
  useThemeTokens,
  useToast,
} from "@/components/ui";
import { getLogs, type LogFile } from "@/api/logs";

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
