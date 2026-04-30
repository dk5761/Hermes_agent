/**
 * Skills — Stage 4 (Skills list).
 *
 * Mirrors design/screens-3.jsx::SkillsScreen. Search filters client-side
 * across name + description. Tapping a row currently shows a "Coming soon"
 * alert; the detail view is deferred.
 */
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import {
  Button,
  Chip,
  EmptyState,
  Input,
  ListGroup,
  ListRow,
  NavBar,
  PhoneSafeArea,
  Row,
  Stack,
  Text,
  useThemeTokens,
} from "@/components/ui";
import { getSkills, type Skill, type SkillSource } from "@/api/skills";

type Filter = "all" | "built-in" | "user" | "auto";

const SOURCE_LABEL: Record<SkillSource, string> = {
  "built-in": "built-in",
  user: "user",
  auto: "auto-saved",
  unknown: "skill",
};

export default function SkillsScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const skillsQ = useQuery({
    queryKey: ["skills"],
    queryFn: getSkills,
    staleTime: 30_000,
    retry: false,
  });

  const all = skillsQ.data ?? [];

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: all.length, "built-in": 0, user: 0, auto: 0 };
    for (const s of all) {
      if (s.source === "built-in") c["built-in"] += 1;
      else if (s.source === "user") c.user += 1;
      else if (s.source === "auto") c.auto += 1;
    }
    return c;
  }, [all]);

  const visible = useMemo<Skill[]>(() => {
    const needle = search.trim().toLowerCase();
    return all.filter((s) => {
      if (filter !== "all") {
        if (filter === "built-in" && s.source !== "built-in") return false;
        if (filter === "user" && s.source !== "user") return false;
        if (filter === "auto" && s.source !== "auto") return false;
      }
      if (!needle) return true;
      return (
        s.name.toLowerCase().includes(needle) ||
        s.description.toLowerCase().includes(needle)
      );
    });
  }, [all, filter, search]);

  const onRowPress = useCallback(() => {
    Alert.alert("Coming soon", "Skill detail screen isn't built yet.");
  }, []);

  const renderRow = useCallback(
    (s: Skill) => (
      <ListRow
        key={s.name}
        icon="hash"
        iconColor={s.source === "built-in" ? tokens.accentBg : undefined}
        title={s.name}
        subtitle={s.description}
        right={
          <Text
            kind="micro"
            mono
            color={tokens.ink2}
            style={{
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: 4,
              backgroundColor: tokens.chip,
              marginRight: 4,
            }}
          >
            {SOURCE_LABEL[s.source]}
          </Text>
        }
        onPress={onRowPress}
        chevron
      />
    ),
    [onRowPress, tokens.accentBg, tokens.chip, tokens.ink2],
  );

  const isLoading = skillsQ.isLoading;
  const isError = skillsQ.isError;

  return (
    <PhoneSafeArea>
      <NavBar title="Skills" onBack={() => router.back()} />

      <Stack gap={10} style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 }}>
        <Input
          value={search}
          onChange={setSearch}
          icon="search"
          placeholder="Search skills"
        />
        <Row gap={6}>
          <Chip active={filter === "all"} onClick={() => setFilter("all")}>
            All · {counts.all}
          </Chip>
          <Chip
            active={filter === "built-in"}
            onClick={() => setFilter("built-in")}
          >
            Built-in
          </Chip>
          <Chip active={filter === "user"} onClick={() => setFilter("user")}>
            User
          </Chip>
          <Chip active={filter === "auto"} onClick={() => setFilter("auto")}>
            Auto-saved
          </Chip>
        </Row>
      </Stack>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={
          <RefreshControl
            refreshing={skillsQ.isFetching && !skillsQ.isLoading}
            onRefresh={() => skillsQ.refetch()}
            tintColor={tokens.accent}
          />
        }
      >
        {isLoading ? (
          <View style={{ paddingVertical: 60, alignItems: "center" }}>
            <ActivityIndicator color={tokens.accent} />
          </View>
        ) : isError ? (
          <EmptyState
            icon="hash"
            title="Failed to load skills"
            body={(skillsQ.error as Error)?.message ?? "Unknown error"}
            action={
              <Button kind="secondary" onClick={() => skillsQ.refetch()}>
                Retry
              </Button>
            }
          />
        ) : all.length === 0 ? (
          <EmptyState
            icon="hash"
            title="No skills yet"
            body="Skills are auto-created from your sessions."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon="hash"
            title="No matches"
            body="Try a different search term or filter."
          />
        ) : (
          <ListGroup>{visible.map(renderRow)}</ListGroup>
        )}
      </ScrollView>
    </PhoneSafeArea>
  );
}
