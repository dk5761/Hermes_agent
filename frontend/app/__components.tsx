/**
 * /__components — Stage 2 visual regression check (dev only).
 *
 * Renders one of every component in every variant. Used during dev + as
 * the visual regression scaffold while screens migrate. Will be deleted
 * at Stage 6 alongside /__theme.
 *
 * Reachable from Settings -> "Components debug" (a dev-only button added
 * at the bottom of `app/(app)/settings.tsx`) or by typing `/__components`
 * in the Expo dev client URL bar.
 */
import React, { useCallback, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { Stack as RouterStack, useRouter } from "expo-router";
import {
  Button,
  Chip,
  EmptyState,
  Field,
  HermesMark,
  Icon,
  ICONS,
  Input,
  ListGroup,
  ListRow,
  MonoBlock,
  NavBar,
  NavIcon,
  PhoneSafeArea,
  ProgressBar,
  Row,
  SegControl,
  Section,
  Sheet,
  Stack,
  StatusDot,
  StatusPill,
  Text,
  ToastProvider,
  Toggle,
  useToast,
  type ButtonKind,
  type ButtonSize,
  type IconName,
  type SheetHandle,
  type StatusDotKind,
  type StatusPillKind,
  type TextKind,
} from "@/components/ui";
import { useTheme, type Density, type Mode, type Variant } from "@/theme";

const KINDS: ReadonlyArray<ButtonKind> = [
  "primary",
  "secondary",
  "ghost",
  "accent",
  "danger",
];
const SIZES: ReadonlyArray<ButtonSize> = ["sm", "md", "lg"];

const TEXT_KINDS: ReadonlyArray<TextKind> = [
  "display",
  "h1",
  "h2",
  "h3",
  "body-lg",
  "body",
  "label",
  "caption",
  "micro",
  "mono",
];

const STATUS_DOTS: ReadonlyArray<StatusDotKind> = [
  "online",
  "connecting",
  "offline",
  "idle",
];

const STATUS_PILLS: ReadonlyArray<{ kind: StatusPillKind; label: string }> = [
  { kind: "online", label: "Online" },
  { kind: "connecting", label: "Connecting" },
  { kind: "offline", label: "Offline" },
  { kind: "paused", label: "Paused" },
  { kind: "idle", label: "Idle" },
];

const ICON_NAMES = Object.keys(ICONS) as IconName[];

interface Combo {
  variant: Variant;
  mode: Mode;
  label: string;
}
const COMBOS: ReadonlyArray<Combo> = [
  { variant: "paper", mode: "light", label: "Paper L" },
  { variant: "paper", mode: "dark", label: "Paper D" },
  { variant: "graphite", mode: "light", label: "Graph L" },
  { variant: "graphite", mode: "dark", label: "Graph D" },
  { variant: "plot", mode: "light", label: "Plot L" },
  { variant: "plot", mode: "dark", label: "Plot D" },
];

export default function ComponentsDebugScreen() {
  return (
    <>
      <RouterStack.Screen options={{ headerShown: false }} />
      {/* Toast lives at this scope so the demo button has a provider. */}
      <ToastProvider>
        <ComponentsDebugBody />
      </ToastProvider>
    </>
  );
}

function ComponentsDebugBody() {
  const router = useRouter();
  const {
    variant,
    mode,
    density,
    setVariant,
    setMode,
    setDensity,
    themeName,
  } = useTheme();
  const toast = useToast();
  const sheetRef = useRef<SheetHandle>(null);

  // Local interactive state
  const [toggleA, setToggleA] = useState(true);
  const [toggleB, setToggleB] = useState(false);
  const [chipA, setChipA] = useState(true);
  const [chipB, setChipB] = useState(false);
  const [seg, setSeg] = useState("daily");
  const [seg2, setSeg2] = useState("a");
  const [progress, setProgress] = useState(0.5);
  const [inputText, setInputText] = useState("");
  const [monoText, setMonoText] = useState("");

  // Stable handlers — these cross memo boundaries inside ListRow/Pressable.
  const onPresent = useCallback(() => sheetRef.current?.present(), []);
  const onDismiss = useCallback(() => sheetRef.current?.dismiss(), []);
  const onShowToast = useCallback(
    () => toast.show("Toast: components debug", "success"),
    [toast],
  );

  // Memo listrow handler so it doesn't re-render rows every keystroke.
  const onRowPress = useCallback(() => toast.show("Row tapped", "info"), [toast]);

  const sampleRows = useMemo(
    () => [
      { icon: "user" as IconName, title: "Profile", subtitle: "darshan", chevron: true },
      { icon: "key" as IconName, title: "Provider keys", subtitle: "3 keys", chevron: true },
      { icon: "shield" as IconName, title: "Security", subtitle: "FaceID on", chevron: true },
      { icon: "trash" as IconName, title: "Delete account", danger: true },
    ],
    [],
  );

  return (
    <PhoneSafeArea edges={["top", "left", "right"]}>
      <NavBar
        title="Components"
        subtitle={`${themeName} · ${density}`}
        large
        onBack={() => router.back()}
        trailing={<NavIcon name="cog" badge />}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 80, gap: 24 }}>
        {/* ── Theme switcher ──────────────────────────────────────── */}
        <Section title="Theme">
          <View style={{ paddingHorizontal: 16, gap: 8 }}>
            <Row gap={6} style={{ flexWrap: "wrap" }}>
              {COMBOS.map((c) => {
                const active = c.variant === variant && c.mode === mode;
                return (
                  <Chip
                    key={c.label}
                    active={active}
                    onClick={() => {
                      setVariant(c.variant);
                      setMode(c.mode);
                    }}
                  >
                    {c.label}
                  </Chip>
                );
              })}
            </Row>
            <SegControl
              options={["compact", "comfortable"]}
              value={density}
              onChange={(v) => setDensity(v as Density)}
            />
          </View>
        </Section>

        {/* ── Buttons (5 kinds × 3 sizes) ─────────────────────────── */}
        <Section title="Buttons">
          <Stack gap={8} style={{ paddingHorizontal: 16 }}>
            {KINDS.map((k) => (
              <Row key={k} gap={8} style={{ flexWrap: "wrap" }}>
                {SIZES.map((s) => (
                  <Button key={s} kind={k} size={s} leftIcon="spark">
                    {`${k} · ${s}`}
                  </Button>
                ))}
              </Row>
            ))}
            <Button kind="primary" size="md" full leftIcon="send">
              Full-width primary
            </Button>
          </Stack>
        </Section>

        {/* ── Chips ───────────────────────────────────────────────── */}
        <Section title="Chips">
          <Row gap={8} style={{ paddingHorizontal: 16, flexWrap: "wrap" }}>
            <Chip active={chipA} onClick={() => setChipA(!chipA)}>
              Active
            </Chip>
            <Chip active={chipB} onClick={() => setChipB(!chipB)}>
              Default
            </Chip>
            <Chip>Static</Chip>
          </Row>
        </Section>

        {/* ── Toggles ─────────────────────────────────────────────── */}
        <Section title="Toggles">
          <Row gap={16} style={{ paddingHorizontal: 16 }}>
            <Stack gap={4}>
              <Text kind="caption" className="text-ink-3">
                On
              </Text>
              <Toggle on={toggleA} onChange={setToggleA} />
            </Stack>
            <Stack gap={4}>
              <Text kind="caption" className="text-ink-3">
                Off
              </Text>
              <Toggle on={toggleB} onChange={setToggleB} />
            </Stack>
          </Row>
        </Section>

        {/* ── Text kinds ──────────────────────────────────────────── */}
        <Section title="Type scale">
          <Stack gap={6} style={{ paddingHorizontal: 16 }}>
            {TEXT_KINDS.map((k) => (
              <Stack gap={2} key={k}>
                <Text kind="micro" className="text-ink-3 uppercase">
                  {k}
                </Text>
                <Text kind={k}>Hermes — {k}</Text>
              </Stack>
            ))}
          </Stack>
        </Section>

        {/* ── Icon grid (all 40) ──────────────────────────────────── */}
        <Section title={`Icons (${ICON_NAMES.length})`}>
          <View
            style={{
              paddingHorizontal: 16,
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            {ICON_NAMES.map((n) => (
              <View
                key={n}
                className="bg-surface border border-line"
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 8,
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                }}
              >
                <Icon name={n} size={20} />
                <Text kind="micro" className="text-ink-3">
                  {n}
                </Text>
              </View>
            ))}
          </View>
        </Section>

        {/* ── ListGroup (driven by current density) ───────────────── */}
        <Section title={`ListGroup (${density})`}>
          <ListGroup header="Account" footer="Density follows current setting">
            {sampleRows.map((r) => (
              <ListRow
                key={r.title}
                icon={r.icon}
                title={r.title}
                subtitle={r.subtitle}
                chevron={r.chevron}
                danger={r.danger}
                onClick={onRowPress}
              />
            ))}
          </ListGroup>
        </Section>

        {/* ── Status indicators ───────────────────────────────────── */}
        <Section title="Status">
          <Stack gap={8} style={{ paddingHorizontal: 16 }}>
            <Row gap={12}>
              {STATUS_DOTS.map((k) => (
                <Row gap={6} key={k}>
                  <StatusDot kind={k} />
                  <Text kind="caption">{k}</Text>
                </Row>
              ))}
            </Row>
            <Row gap={6} style={{ flexWrap: "wrap" }}>
              {STATUS_PILLS.map((p) => (
                <StatusPill key={p.kind} kind={p.kind} label={p.label} />
              ))}
            </Row>
          </Stack>
        </Section>

        {/* ── SegControl ──────────────────────────────────────────── */}
        <Section title="SegControl">
          <Stack gap={8} style={{ paddingHorizontal: 16 }}>
            <SegControl
              options={["hourly", "daily", "weekly"]}
              value={seg}
              onChange={setSeg}
            />
            <SegControl
              options={[
                { value: "a", label: "Alpha" },
                { value: "b", label: "Beta" },
              ]}
              value={seg2}
              onChange={setSeg2}
            />
          </Stack>
        </Section>

        {/* ── ProgressBar ─────────────────────────────────────────── */}
        <Section title="ProgressBar">
          <Stack gap={8} style={{ paddingHorizontal: 16 }}>
            <ProgressBar value={progress} />
            <Row gap={6}>
              <Button size="sm" kind="secondary" onClick={() => setProgress(0)}>
                0%
              </Button>
              <Button size="sm" kind="secondary" onClick={() => setProgress(0.25)}>
                25%
              </Button>
              <Button size="sm" kind="secondary" onClick={() => setProgress(0.5)}>
                50%
              </Button>
              <Button size="sm" kind="secondary" onClick={() => setProgress(1)}>
                100%
              </Button>
            </Row>
          </Stack>
        </Section>

        {/* ── Field + Input ───────────────────────────────────────── */}
        <Section title="Field & Input">
          <Stack gap={12} style={{ paddingHorizontal: 16 }}>
            <Field label="Server URL" hint="The Hermes gateway endpoint">
              <Input
                value={inputText}
                onChange={setInputText}
                placeholder="https://hermes.example.com"
                icon="globe"
              />
            </Field>
            <Field
              label="Cron expression"
              error="Invalid expression"
              mono
            >
              <Input
                value={monoText}
                onChange={setMonoText}
                placeholder="0 9 * * *"
                mono
              />
            </Field>
          </Stack>
        </Section>

        {/* ── MonoBlock ───────────────────────────────────────────── */}
        <Section title="MonoBlock">
          <View style={{ paddingHorizontal: 16 }}>
            <MonoBlock>
              {`$ hermes run --once 0xCAFE\n→ session 7d2a created\n→ streaming...`}
            </MonoBlock>
          </View>
        </Section>

        {/* ── EmptyState ──────────────────────────────────────────── */}
        <Section title="EmptyState">
          <EmptyState
            icon="archive"
            title="No archived sessions"
            body="Archive a session to keep it out of your main list. Long-press to archive."
            action={
              <Button kind="accent" leftIcon="plus">
                New session
              </Button>
            }
          />
        </Section>

        {/* ── Sheet trigger + Toast trigger + Mark ────────────────── */}
        <Section title="Overlays">
          <Stack gap={8} style={{ paddingHorizontal: 16 }}>
            <Button kind="secondary" leftIcon="moreV" onClick={onPresent}>
              Open bottom sheet
            </Button>
            <Button kind="ghost" leftIcon="bell" onClick={onShowToast}>
              Show toast
            </Button>
            <Row gap={12} align="center">
              <HermesMark size={28} />
              <Text kind="body-lg">HermesMark</Text>
            </Row>
          </Stack>
        </Section>
      </ScrollView>

      {/* Sheet portal — stays in-tree but hidden until presented. */}
      <Sheet ref={sheetRef} snapPoints={[260]}>
        <Stack gap={12} style={{ padding: 20 }}>
          <Text kind="h3">Bottom sheet</Text>
          <Text kind="body" className="text-ink-3">
            Demo of @gorhom/bottom-sheet wrapped via our `Sheet` component.
            Pan down or tap outside to dismiss.
          </Text>
          <Button kind="primary" full onClick={onDismiss}>
            Dismiss
          </Button>
        </Stack>
      </Sheet>
    </PhoneSafeArea>
  );
}
