/**
 * cronBuilder.ts — converts between cron expressions and structured schedule
 * modes (Daily / Weekly / Monthly / Hourly / Custom).
 *
 * Only the 5-field POSIX cron syntax is handled:
 *   minute  hour  day-of-month  month  day-of-week
 *
 * Detection is conservative: anything ambiguous falls back to "custom" so
 * the user is never shown a lossy-parsed representation of their expression.
 */

export type ScheduleMode = "daily" | "weekly" | "monthly" | "hourly" | "custom";

export interface DailySchedule {
  mode: "daily";
  hour: number;
  minute: number;
}

export interface WeeklySchedule {
  mode: "weekly";
  daysOfWeek: number[]; // 0=Sun … 6=Sat
  hour: number;
  minute: number;
}

export interface MonthlySchedule {
  mode: "monthly";
  dayOfMonth: number; // 1-31
  hour: number;
  minute: number;
}

export interface HourlySchedule {
  mode: "hourly";
  everyHours: number; // 1-12
  atMinute: number;   // 0, 15, 30, 45 (or 0-59 free)
}

export interface CustomSchedule {
  mode: "custom";
  expr: string;
}

export type Schedule =
  | DailySchedule
  | WeeklySchedule
  | MonthlySchedule
  | HourlySchedule
  | CustomSchedule;

// ---------------------------------------------------------------------------
// scheduleToCron
// ---------------------------------------------------------------------------

/** Build a 5-field cron expression from a structured schedule. */
export function scheduleToCron(s: Schedule): string {
  switch (s.mode) {
    case "daily":
      return `${s.minute} ${s.hour} * * *`;

    case "weekly": {
      const days = [...s.daysOfWeek].sort((a, b) => a - b).join(",");
      return `${s.minute} ${s.hour} * * ${days}`;
    }

    case "monthly":
      return `${s.minute} ${s.hour} ${s.dayOfMonth} * *`;

    case "hourly":
      if (s.everyHours === 1) {
        return `${s.atMinute} * * * *`;
      }
      return `${s.atMinute} */${s.everyHours} * * *`;

    case "custom":
      return s.expr;
  }
}

// ---------------------------------------------------------------------------
// cronToSchedule
// ---------------------------------------------------------------------------

/**
 * Parse a cron expression into the most-specific matching Schedule.
 * Falls back to { mode: "custom", expr } for anything ambiguous.
 *
 * Detection rules (5 fields: min hour dom month dow):
 *   hourly  — numeric min, hour is "*" or "* /N", dom/month/dow all "*"
 *   daily   — numeric min + hour, dom/month/dow all "*"
 *   weekly  — numeric min + hour, dow is numeric list/single, dom/month "*"
 *   monthly — numeric min + hour, dom is numeric (1-31), month/dow "*"
 *   custom  — anything else
 */
export function cronToSchedule(expr: string): Schedule {
  const fallback: CustomSchedule = { mode: "custom", expr };

  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return fallback;

  const [minF, hourF, domF, monthF, dowF] = fields;

  // Helpers
  const isWildcard = (f: string) => f === "*";
  const isNumeric = (f: string) => /^\d+$/.test(f);
  const isStep = (f: string) => /^\*\/\d+$/.test(f);
  const isCommaList = (f: string) => /^\d+(,\d+)+$/.test(f);

  const parsedMin = isNumeric(minF) ? parseInt(minF, 10) : NaN;
  const parsedHour = isNumeric(hourF) ? parseInt(hourF, 10) : NaN;

  if (isNaN(parsedMin) || parsedMin < 0 || parsedMin > 59) return fallback;

  // -------------------------------------------------------------------------
  // Hourly: minute is numeric, hour is "*" or "*/N", dom/month/dow all "*"
  // -------------------------------------------------------------------------
  if (
    isWildcard(domF) &&
    isWildcard(monthF) &&
    isWildcard(dowF)
  ) {
    if (isWildcard(hourF)) {
      // every hour at :MM
      return { mode: "hourly", everyHours: 1, atMinute: parsedMin };
    }
    if (isStep(hourF)) {
      const n = parseInt(hourF.slice(2), 10);
      if (n >= 1 && n <= 12) {
        return { mode: "hourly", everyHours: n, atMinute: parsedMin };
      }
      return fallback;
    }
    // If hour is numeric and dom/month/dow are all "*" → daily
    if (isNumeric(hourF)) {
      if (parsedHour < 0 || parsedHour > 23) return fallback;
      return { mode: "daily", hour: parsedHour, minute: parsedMin };
    }
    return fallback;
  }

  // -------------------------------------------------------------------------
  // Beyond here, hour must be a plain number
  // -------------------------------------------------------------------------
  if (!isNumeric(hourF) || isNaN(parsedHour) || parsedHour < 0 || parsedHour > 23) {
    return fallback;
  }

  // -------------------------------------------------------------------------
  // Weekly: numeric min + hour, dow is numeric single or comma-list, dom/month "*"
  // -------------------------------------------------------------------------
  if (
    isWildcard(domF) &&
    isWildcard(monthF) &&
    (isNumeric(dowF) || isCommaList(dowF))
  ) {
    const days = dowF.split(",").map((d) => parseInt(d, 10));
    if (days.some((d) => isNaN(d) || d < 0 || d > 6)) return fallback;
    return {
      mode: "weekly",
      daysOfWeek: days,
      hour: parsedHour,
      minute: parsedMin,
    };
  }

  // -------------------------------------------------------------------------
  // Monthly: numeric min + hour + dom (1-31), month/dow both "*"
  // -------------------------------------------------------------------------
  if (
    isNumeric(domF) &&
    isWildcard(monthF) &&
    isWildcard(dowF)
  ) {
    const dom = parseInt(domF, 10);
    if (dom < 1 || dom > 31) return fallback;
    return { mode: "monthly", dayOfMonth: dom, hour: parsedHour, minute: parsedMin };
  }

  return fallback;
}
