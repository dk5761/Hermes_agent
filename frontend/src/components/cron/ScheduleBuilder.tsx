/**
 * ScheduleBuilder — friendly schedule picker that replaces the raw cron chip
 * row in CronEditor.
 *
 * Mode tabs: Daily / Weekly / Monthly / Hourly / Custom
 *
 * No native date-picker dependency is required — the package
 * @react-native-community/datetimepicker is NOT present in this project.
 * Time is picked via two horizontal scrollable chip rows (hours 0-23,
 * minutes 0/5/10/…/55) which are cross-platform and match the codebase's
 * existing chip aesthetic.
 *
 * Day-of-month is a horizontal scrollable chip strip (1-31).
 * Days-of-week are 7 toggle chips (S M T W T F S).
 * Hourly step uses a simple +/- stepper (1-12).
 * "At minute" for hourly uses 4 common-bucket chips: 0 / 15 / 30 / 45.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ScrollView,
  TouchableOpacity,
  View,
} from "react-native";

import { Chip, Field, Input, Row, Stack, Text, useThemeTokens } from "@/components/ui";
import { formatPreview, isValidCron, nextRuns } from "@/util/cronPreview";
import {
  cronToSchedule,
  scheduleToCron,
  type DailySchedule,
  type HourlySchedule,
  type MonthlySchedule,
  type ScheduleMode,
  type WeeklySchedule,
} from "@/util/cronBuilder";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScheduleBuilderProps {
  /** Current cron expression — mode is derived from this on mount. */
  schedule: string;
  /** Called whenever the builder produces a new valid expression. */
  onChange: (expr: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODES: ReadonlyArray<{ id: ScheduleMode; label: string }> = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
  { id: "hourly", label: "Hourly" },
  { id: "custom", label: "Custom" },
];

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5); // 0, 5, 10 … 55
const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => i + 1);
const DOW_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const MINUTE_BUCKETS = [0, 15, 30, 45];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// TimePicker — two horizontal chip rows: hours + minutes
// ---------------------------------------------------------------------------

interface TimePickerProps {
  hour: number;
  minute: number;
  onHourChange: (h: number) => void;
  onMinuteChange: (m: number) => void;
}

function TimePicker({ hour, minute, onHourChange, onMinuteChange }: TimePickerProps) {
  // Snap the initial scroll position to the selected chip on mount.
  const hourScrollRef = useRef<ScrollView>(null);
  const minScrollRef = useRef<ScrollView>(null);

  // Chip width + gap for scroll-to calculation (approximate — good enough)
  const CHIP_W = 42;
  const GAP = 6;

  useEffect(() => {
    const timeout = setTimeout(() => {
      hourScrollRef.current?.scrollTo({
        x: Math.max(0, hour * (CHIP_W + GAP) - 80),
        animated: false,
      });
      const minIdx = MINUTES.indexOf(minute);
      if (minIdx >= 0) {
        minScrollRef.current?.scrollTo({
          x: Math.max(0, minIdx * (CHIP_W + GAP) - 80),
          animated: false,
        });
      }
    }, 50);
    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Stack gap={8}>
      <Field label="Hour">
        <ScrollView
          ref={hourScrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: GAP, paddingHorizontal: 0 }}
        >
          {HOURS.map((h) => (
            <Chip key={h} active={hour === h} onPress={() => onHourChange(h)}>
              {pad2(h)}
            </Chip>
          ))}
        </ScrollView>
      </Field>
      <Field label="Minute">
        <ScrollView
          ref={minScrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: GAP, paddingHorizontal: 0 }}
        >
          {MINUTES.map((m) => (
            <Chip key={m} active={minute === m} onPress={() => onMinuteChange(m)}>
              {pad2(m)}
            </Chip>
          ))}
        </ScrollView>
      </Field>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Stepper — simple +/- numeric control
// ---------------------------------------------------------------------------

interface StepperProps {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label?: string;
}

function Stepper({ value, min, max, onChange, label }: StepperProps) {
  const tokens = useThemeTokens();
  return (
    <Row gap={12} align="center">
      <TouchableOpacity
        onPress={() => onChange(Math.max(min, value - 1))}
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: tokens.chip,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text kind="h3" color={tokens.ink2}>
          -
        </Text>
      </TouchableOpacity>
      <Text kind="body-lg" style={{ minWidth: 36, textAlign: "center" }}>
        {label ? `${value} ${label}` : String(value)}
      </Text>
      <TouchableOpacity
        onPress={() => onChange(Math.min(max, value + 1))}
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: tokens.chip,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text kind="h3" color={tokens.ink2}>
          +
        </Text>
      </TouchableOpacity>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Mode bodies
// ---------------------------------------------------------------------------

interface DailyBodyProps {
  sched: DailySchedule;
  onChange: (s: DailySchedule) => void;
}

function DailyBody({ sched, onChange }: DailyBodyProps) {
  return (
    <TimePicker
      hour={sched.hour}
      minute={sched.minute}
      onHourChange={(h) => onChange({ ...sched, hour: h })}
      onMinuteChange={(m) => onChange({ ...sched, minute: m })}
    />
  );
}

interface WeeklyBodyProps {
  sched: WeeklySchedule;
  onChange: (s: WeeklySchedule) => void;
}

function WeeklyBody({ sched, onChange }: WeeklyBodyProps) {
  const toggleDay = useCallback(
    (d: number) => {
      const has = sched.daysOfWeek.includes(d);
      let next: number[];
      if (has) {
        next = sched.daysOfWeek.filter((x) => x !== d);
        // Keep at least one day selected
        if (next.length === 0) next = [1]; // default to Monday
      } else {
        next = [...sched.daysOfWeek, d].sort((a, b) => a - b);
      }
      onChange({ ...sched, daysOfWeek: next });
    },
    [sched, onChange],
  );

  return (
    <Stack gap={16}>
      <Field label="Days">
        <Row gap={6} style={{ flexWrap: "wrap" }}>
          {DOW_LABELS.map((lbl, idx) => (
            <Chip
              key={idx}
              active={sched.daysOfWeek.includes(idx)}
              onPress={() => toggleDay(idx)}
            >
              {lbl}
            </Chip>
          ))}
        </Row>
      </Field>
      <TimePicker
        hour={sched.hour}
        minute={sched.minute}
        onHourChange={(h) => onChange({ ...sched, hour: h })}
        onMinuteChange={(m) => onChange({ ...sched, minute: m })}
      />
    </Stack>
  );
}

interface MonthlyBodyProps {
  sched: MonthlySchedule;
  onChange: (s: MonthlySchedule) => void;
}

function MonthlyBody({ sched, onChange }: MonthlyBodyProps) {
  return (
    <Stack gap={16}>
      <Field label="Day of month">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, paddingHorizontal: 0 }}
        >
          {DAYS_OF_MONTH.map((d) => (
            <Chip
              key={d}
              active={sched.dayOfMonth === d}
              onPress={() => onChange({ ...sched, dayOfMonth: d })}
            >
              {String(d)}
            </Chip>
          ))}
        </ScrollView>
      </Field>
      <TimePicker
        hour={sched.hour}
        minute={sched.minute}
        onHourChange={(h) => onChange({ ...sched, hour: h })}
        onMinuteChange={(m) => onChange({ ...sched, minute: m })}
      />
    </Stack>
  );
}

interface HourlyBodyProps {
  sched: HourlySchedule;
  onChange: (s: HourlySchedule) => void;
}

function HourlyBody({ sched, onChange }: HourlyBodyProps) {
  return (
    <Stack gap={16}>
      <Field label="Every">
        <Stepper
          value={sched.everyHours}
          min={1}
          max={12}
          onChange={(v) => onChange({ ...sched, everyHours: v })}
          label={sched.everyHours === 1 ? "hour" : "hours"}
        />
      </Field>
      <Field label="At minute">
        <Row gap={6}>
          {MINUTE_BUCKETS.map((m) => (
            <Chip
              key={m}
              active={sched.atMinute === m}
              onPress={() => onChange({ ...sched, atMinute: m })}
            >
              :{pad2(m)}
            </Chip>
          ))}
        </Row>
      </Field>
    </Stack>
  );
}

interface CustomBodyProps {
  expr: string;
  onChange: (expr: string) => void;
  valid: boolean;
}

function CustomBody({ expr, onChange, valid }: CustomBodyProps) {
  return (
    <Field
      label="Cron expression"
      hint="5-field POSIX: minute hour dom month dow"
      error={valid ? undefined : "Invalid cron expression"}
    >
      <Input value={expr} onChange={onChange} mono />
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Live summary
// ---------------------------------------------------------------------------

interface SummaryProps {
  schedule: string;
}

function Summary({ schedule }: SummaryProps) {
  const tokens = useThemeTokens();
  const valid = isValidCron(schedule);
  const runs = useMemo(() => (valid ? nextRuns(schedule, 3) ?? [] : []), [schedule, valid]);

  return (
    <View
      style={{
        padding: 12,
        backgroundColor: tokens.surface,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: tokens.line,
      }}
    >
      <Text
        kind="micro"
        color={tokens.ink3}
        className="uppercase"
        style={{ marginBottom: 6 }}
      >
        Next 3 runs
      </Text>
      {runs.length > 0 ? (
        <Stack gap={4}>
          {runs.map((d, i) => (
            <Text key={i} kind="caption" mono>
              {formatPreview(d)}
            </Text>
          ))}
        </Stack>
      ) : (
        <Text kind="caption" mono color={tokens.ink3}>
          {valid ? "—" : "(invalid expression)"}
        </Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Default schedules per mode (used when switching tabs)
// ---------------------------------------------------------------------------

function defaultForMode(mode: ScheduleMode, currentExpr: string): string {
  switch (mode) {
    case "daily":
      return "0 9 * * *";
    case "weekly":
      return "0 9 * * 1";
    case "monthly":
      return "0 9 1 * *";
    case "hourly":
      return "0 * * * *";
    case "custom":
      return currentExpr;
  }
}

// ---------------------------------------------------------------------------
// ScheduleBuilder
// ---------------------------------------------------------------------------

export function ScheduleBuilder({ schedule, onChange }: ScheduleBuilderProps) {
  const tokens = useThemeTokens();

  // Derive the initial mode from the incoming expression
  const parsed = useMemo(() => cronToSchedule(schedule), []);  // only on mount
  const [mode, setMode] = useState<ScheduleMode>(parsed.mode);

  // Per-mode structured state. Initialised from the incoming expression once.
  const [dailySched, setDailySched] = useState<DailySchedule>(
    parsed.mode === "daily"
      ? parsed
      : { mode: "daily", hour: 9, minute: 0 },
  );
  const [weeklySched, setWeeklySched] = useState<WeeklySchedule>(
    parsed.mode === "weekly"
      ? parsed
      : { mode: "weekly", daysOfWeek: [1], hour: 9, minute: 0 },
  );
  const [monthlySched, setMonthlySched] = useState<MonthlySchedule>(
    parsed.mode === "monthly"
      ? parsed
      : { mode: "monthly", dayOfMonth: 1, hour: 9, minute: 0 },
  );
  const [hourlySched, setHourlySched] = useState<HourlySchedule>(
    parsed.mode === "hourly"
      ? parsed
      : { mode: "hourly", everyHours: 1, atMinute: 0 },
  );
  const [customExpr, setCustomExpr] = useState<string>(
    parsed.mode === "custom" ? parsed.expr : schedule,
  );

  // Emit to parent whenever anything in the active mode changes.
  const emitForMode = useCallback(
    (m: ScheduleMode) => {
      let expr: string;
      switch (m) {
        case "daily":   expr = scheduleToCron(dailySched);   break;
        case "weekly":  expr = scheduleToCron(weeklySched);  break;
        case "monthly": expr = scheduleToCron(monthlySched); break;
        case "hourly":  expr = scheduleToCron(hourlySched);  break;
        case "custom":  expr = customExpr;                   break;
        default:        expr = schedule;
      }
      onChange(expr);
    },
    [dailySched, weeklySched, monthlySched, hourlySched, customExpr, onChange, schedule],
  );

  // Fire whenever structured state for the active mode changes.
  useEffect(() => { emitForMode(mode); }, [dailySched]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { emitForMode(mode); }, [weeklySched]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { emitForMode(mode); }, [monthlySched]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { emitForMode(mode); }, [hourlySched]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { emitForMode(mode); }, [customExpr]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onModeChange = useCallback(
    (next: ScheduleMode) => {
      setMode(next);
      // When switching to custom, pre-fill with whatever the last expression was.
      if (next === "custom") {
        // currentExpr is whatever was last emitted — capture it by reading
        // the relevant structured state synchronously.
        let lastExpr: string;
        switch (mode) {
          case "daily":   lastExpr = scheduleToCron(dailySched);   break;
          case "weekly":  lastExpr = scheduleToCron(weeklySched);  break;
          case "monthly": lastExpr = scheduleToCron(monthlySched); break;
          case "hourly":  lastExpr = scheduleToCron(hourlySched);  break;
          default:        lastExpr = customExpr;
        }
        setCustomExpr(lastExpr);
        onChange(lastExpr);
      } else {
        // Emit the default expression for the new mode immediately so the
        // parent's `schedule` state doesn't lag.
        const expr = defaultForMode(next, customExpr);
        onChange(expr);
      }
    },
    [mode, dailySched, weeklySched, monthlySched, hourlySched, customExpr, onChange],
  );

  // The expression that drives the live summary is derived from active mode.
  const currentExpr = useMemo(() => {
    switch (mode) {
      case "daily":   return scheduleToCron(dailySched);
      case "weekly":  return scheduleToCron(weeklySched);
      case "monthly": return scheduleToCron(monthlySched);
      case "hourly":  return scheduleToCron(hourlySched);
      case "custom":  return customExpr;
    }
  }, [mode, dailySched, weeklySched, monthlySched, hourlySched, customExpr]);

  return (
    <Stack gap={16}>
      {/* Mode tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 6, paddingHorizontal: 0 }}
      >
        {MODES.map((m) => (
          <Chip
            key={m.id}
            active={mode === m.id}
            onPress={() => onModeChange(m.id)}
          >
            {m.label}
          </Chip>
        ))}
      </ScrollView>

      {/* Cron expression badge — always visible so power users can see what's being built */}
      <Text kind="caption" mono color={tokens.ink3}>
        {currentExpr}
      </Text>

      {/* Mode body */}
      {mode === "daily" && (
        <DailyBody sched={dailySched} onChange={setDailySched} />
      )}
      {mode === "weekly" && (
        <WeeklyBody sched={weeklySched} onChange={setWeeklySched} />
      )}
      {mode === "monthly" && (
        <MonthlyBody sched={monthlySched} onChange={setMonthlySched} />
      )}
      {mode === "hourly" && (
        <HourlyBody sched={hourlySched} onChange={setHourlySched} />
      )}
      {mode === "custom" && (
        <CustomBody
          expr={customExpr}
          onChange={setCustomExpr}
          valid={isValidCron(customExpr)}
        />
      )}

      {/* Live summary */}
      <Summary schedule={currentExpr} />
    </Stack>
  );
}
