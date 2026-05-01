/**
 * Search screen — Stage 6 satellite.
 *
 * Visual target: design_handoff_hermes/design/screens-2.jsx::SearchScreen.
 *
 * Backend is `/sessions/search?q=...`. The upstream Hermes payload shape is
 * loosely typed (HERMES_CONTRACT.md notes it explicitly), so we normalize
 * results into a single internal shape and bucket by where the match landed
 * (titles vs messages) for the design's grouped layout.
 *
 * Recent-queries chip row is wired to AsyncStorage so a session-cold open
 * still has something to show in the empty state.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, View } from "react-native";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Chip,
  EmptyState,
  Icon,
  Input,
  NavBar,
  PhoneSafeArea,
  Row,
  Stack,
  Text,
  useThemeTokens,
} from "@/components/ui";
import { searchSessions, type SearchHit, type SearchResponse } from "@/api/sessions";

type Filter = "all" | "titles" | "messages";

interface NormalizedHit {
  sessionId: string;
  // Where this hit originated, used for grouping.
  bucket: "titles" | "messages";
  title: string;
  snippet: string;
  match: [number, number] | null;
  whenLabel: string;
}

const RECENT_KEY = "hermes.search.recent.v1";
const RECENT_MAX = 5;
const DEBOUNCE_MS = 300;

function safeString(o: unknown, key: string): string | undefined {
  if (!o || typeof o !== "object") return undefined;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function safeNumber(o: unknown, key: string): number | undefined {
  if (!o || typeof o !== "object") return undefined;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

function formatRelative(when: number | string | undefined): string {
  if (when === undefined || when === null) return "";
  const ms = typeof when === "number" ? when : Date.parse(String(when));
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function findMatchRange(text: string, query: string): [number, number] | null {
  if (!text || !query) return null;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return null;
  return [i, i + query.length];
}

function pickHitArray(payload: SearchResponse | undefined): SearchHit[] {
  if (!payload) return [];
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.sessions)) return payload.sessions;
  if (Array.isArray(payload.matches)) return payload.matches;
  return [];
}

function normalizeHit(hit: SearchHit, query: string): NormalizedHit | null {
  const sessionId =
    safeString(hit, "sessionId") ??
    safeString(hit, "appSessionId") ??
    safeString(hit, "id");
  if (!sessionId) return null;

  const title = safeString(hit, "title") ?? "Untitled";
  const rawSnippet =
    safeString(hit, "snippet") ??
    safeString(hit, "text") ??
    safeString(hit, "preview") ??
    "";
  const when =
    safeNumber(hit, "updatedAt") ??
    safeNumber(hit, "createdAt") ??
    safeString(hit, "updatedAt") ??
    safeString(hit, "createdAt");

  // Bucket: if the match falls inside the title, classify as "titles" — even
  // if the upstream also returned a snippet. Otherwise "messages".
  const titleMatch = findMatchRange(title, query);
  const snippetMatch =
    Array.isArray(hit.match) && hit.match.length === 2
      ? ([hit.match[0], hit.match[1]] as [number, number])
      : findMatchRange(rawSnippet, query);

  const bucket: "titles" | "messages" =
    titleMatch && (!snippetMatch || titleMatch[0] >= 0) ? "titles" : "messages";

  return {
    sessionId,
    bucket,
    title,
    snippet: rawSnippet,
    match: bucket === "titles" ? titleMatch : snippetMatch,
    whenLabel: formatRelative(when),
  };
}

interface HighlightedTextProps {
  text: string;
  match: [number, number] | null;
  numberOfLines?: number;
  className?: string;
}

function HighlightedText({ text, match, numberOfLines, className }: HighlightedTextProps) {
  const tokens = useThemeTokens();
  if (!match) {
    return (
      <Text kind="body" className={className} numberOfLines={numberOfLines}>
        {text}
      </Text>
    );
  }
  const [a, b] = match;
  const before = text.slice(0, a);
  const hit = text.slice(a, b);
  const after = text.slice(b);
  return (
    <Text kind="body" className={className} numberOfLines={numberOfLines}>
      {before}
      <Text
        kind="body"
        color={tokens.accent}
        style={{ backgroundColor: tokens.accentBg }}
      >
        {hit}
      </Text>
      {after}
    </Text>
  );
}

interface SectionHeaderProps {
  title: string;
  count: number;
}

function SectionHeader({ title, count }: SectionHeaderProps) {
  return (
    <Row
      align="center"
      justify="space-between"
      style={{ paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6 }}
    >
      <Text kind="micro" className="text-ink-3 uppercase">
        {title}
      </Text>
      <Text kind="caption" className="text-ink-3">
        {count} {count === 1 ? "match" : "matches"}
      </Text>
    </Row>
  );
}

interface ResultRowProps {
  hit: NormalizedHit;
  onPress: (sessionId: string) => void;
}

function ResultRow({ hit, onPress }: ResultRowProps) {
  const tokens = useThemeTokens();
  return (
    <Pressable
      onPress={() => onPress(hit.sessionId)}
      style={({ pressed }) => ({
        marginHorizontal: 16,
        marginBottom: 8,
        padding: 12,
        backgroundColor: tokens.surface,
        borderColor: tokens.line,
        borderWidth: 1,
        borderRadius: 12,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Row gap={10} align="flex-start">
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            backgroundColor: tokens.chip,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="terminal" size={14} color={tokens.ink2} />
        </View>
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Row align="center" justify="space-between" gap={8}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <HighlightedText
                text={hit.title}
                match={hit.bucket === "titles" ? hit.match : null}
                numberOfLines={1}
              />
            </View>
            {hit.whenLabel ? (
              <Text kind="caption" className="text-ink-3">
                {hit.whenLabel}
              </Text>
            ) : null}
          </Row>
          {hit.snippet ? (
            <HighlightedText
              text={hit.snippet}
              match={hit.bucket === "messages" ? hit.match : null}
              numberOfLines={2}
              className="text-ink-3"
            />
          ) : null}
        </Stack>
      </Row>
    </Pressable>
  );
}

type ListItem =
  | { kind: "section"; key: string; title: string; count: number }
  | { kind: "result"; key: string; hit: NormalizedHit };

export default function SearchScreen() {
  const tokens = useThemeTokens();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [hits, setHits] = useState<NormalizedHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const inflight = useRef<AbortController | null>(null);

  // Load recent queries once on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(RECENT_KEY);
        if (cancelled || !raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setRecent(parsed.filter((v): v is string => typeof v === "string").slice(0, RECENT_MAX));
        }
      } catch {
        // Corrupt entry — ignore.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounce query → debounced.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // Persist a recent search after a successful (non-empty) hit.
  const persistRecent = useCallback(
    (q: string) => {
      if (!q) return;
      setRecent((prev) => {
        const next = [q, ...prev.filter((r) => r !== q)].slice(0, RECENT_MAX);
        void AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next)).catch(() => {});
        return next;
      });
    },
    [],
  );

  // Run the search whenever `debounced` changes.
  useEffect(() => {
    if (!debounced) {
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const payload = await searchSessions(debounced);
        if (ctrl.signal.aborted) return;
        const arr = pickHitArray(payload);
        const normalized = arr
          .map((h) => normalizeHit(h, debounced))
          .filter((h): h is NormalizedHit => h !== null);
        setHits(normalized);
        if (normalized.length > 0) persistRecent(debounced);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Search failed");
        setHits([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => ctrl.abort();
  }, [debounced, persistRecent]);

  // Build the flat list with section headers per filter.
  const items: ListItem[] = useMemo(() => {
    const grouped: Record<"titles" | "messages", NormalizedHit[]> = {
      titles: [],
      messages: [],
    };
    for (const h of hits) {
      if (filter === "titles" && h.bucket !== "titles") continue;
      if (filter === "messages" && h.bucket !== "messages") continue;
      grouped[h.bucket].push(h);
    }
    const out: ListItem[] = [];
    if (grouped.titles.length > 0) {
      out.push({ kind: "section", key: "sec-titles", title: "In titles", count: grouped.titles.length });
      for (const h of grouped.titles) {
        out.push({ kind: "result", key: `t-${h.sessionId}-${h.match?.[0] ?? 0}`, hit: h });
      }
    }
    if (grouped.messages.length > 0) {
      out.push({
        kind: "section",
        key: "sec-messages",
        title: "In messages",
        count: grouped.messages.length,
      });
      for (const h of grouped.messages) {
        out.push({
          kind: "result",
          key: `m-${h.sessionId}-${h.match?.[0] ?? 0}`,
          hit: h,
        });
      }
    }
    return out;
  }, [hits, filter]);

  const onOpenSession = useCallback((sessionId: string) => {
    router.push(`/chat/${sessionId}`);
  }, []);

  const onPickRecent = useCallback((q: string) => {
    setQuery(q);
  }, []);

  const showInitialEmpty = !debounced && !loading;
  const showNoMatchesEmpty =
    !!debounced && !loading && !error && items.length === 0;

  return (
    <PhoneSafeArea>
      <NavBar title="Search" onBack={() => router.back()} />
      <Stack gap={10} style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
        <Input
          value={query}
          onChange={setQuery}
          icon="search"
          placeholder="Search across all chats"
          autoFocus
        />
        <Row gap={6}>
          <Chip active={filter === "all"} onPress={() => setFilter("all")}>
            All
          </Chip>
          <Chip active={filter === "titles"} onPress={() => setFilter("titles")}>
            In titles
          </Chip>
          <Chip active={filter === "messages"} onPress={() => setFilter("messages")}>
            In messages
          </Chip>
        </Row>
      </Stack>

      {loading ? (
        <View style={{ padding: 24, alignItems: "center" }}>
          <ActivityIndicator color={tokens.accent} />
        </View>
      ) : null}

      {error ? (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <Text kind="body" color={tokens.danger}>
            {error}
          </Text>
        </View>
      ) : null}

      {showInitialEmpty ? (
        <View style={{ flex: 1 }}>
          <EmptyState
            icon="search"
            title="Search your chats"
            body="Find messages by content, code snippets, or session titles."
          />
          {recent.length > 0 ? (
            <Stack gap={8} style={{ paddingHorizontal: 16, paddingTop: 4 }}>
              <Text kind="micro" className="text-ink-3 uppercase">
                Recent
              </Text>
              <Row gap={6} style={{ flexWrap: "wrap" }}>
                {recent.map((r) => (
                  <Chip key={r} onPress={() => onPickRecent(r)}>
                    {r}
                  </Chip>
                ))}
              </Row>
            </Stack>
          ) : null}
        </View>
      ) : null}

      {showNoMatchesEmpty ? (
        <View style={{ flex: 1 }}>
          <EmptyState
            icon="search"
            title="Nothing matches"
            body="Try a different query."
          />
          {recent.length > 0 ? (
            <Stack gap={8} style={{ paddingHorizontal: 16, paddingTop: 4 }}>
              <Text kind="micro" className="text-ink-3 uppercase">
                Recent
              </Text>
              <Row gap={6} style={{ flexWrap: "wrap" }}>
                {recent.map((r) => (
                  <Chip key={r} onPress={() => onPickRecent(r)}>
                    {r}
                  </Chip>
                ))}
              </Row>
            </Stack>
          ) : null}
        </View>
      ) : null}

      {!loading && !error && items.length > 0 ? (
        <FlatList
          data={items}
          keyExtractor={(it) => it.key}
          contentContainerStyle={{ paddingBottom: 32 }}
          renderItem={({ item }) =>
            item.kind === "section" ? (
              <SectionHeader title={item.title} count={item.count} />
            ) : (
              <ResultRow hit={item.hit} onPress={onOpenSession} />
            )
          }
        />
      ) : null}
    </PhoneSafeArea>
  );
}
