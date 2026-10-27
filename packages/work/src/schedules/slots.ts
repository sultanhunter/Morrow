import type { Current_Schedule } from "@morrow/contracts";

// Schedule@1's slots (ADR-0043 items 7 and 9; plan row SD12), in plain arithmetic over Intl's
// zone offsets, so the Workers, the browser and the tests compute exactly what the database
// fires. The database is the authority: fire_due_schedules computes every slot itself in SQL
// (migration schedules-shop-zone, morrow_work.schedule_resolve_local and its siblings), and
// this module is its twin for previews and checks. lab:mandates runs both over the same
// schedules and zones, daylight-saving weeks included, and requires the same instants.
//
// The rules:
//   * A slot is a local date and a local minute in the schedule's own zone. daily: up to four
//     times; weekly: the listed days at one time; monthly: day 1 to 28 or the month's last day
//     at one time; every: the local times from midnight on the step (15 minutes to 12 hours,
//     each dividing the day). Optional first and last local dates bound the slots, inclusive.
//   * Daylight saving: a local time that does not exist (the clocks go forward over it) fires at
//     the next valid minute, the moment the clocks change; a local time that happens twice (the
//     clocks go back) fires once, at its first occurrence. Two local slots that land on the
//     same instant fire once (a slot is its instant, and the trigger key names the instant).
//   * Catch-up after downtime (missedRun): every slot from the schedule's next slot up to now
//     is due. skip fires the latest due slot only inside its on-time window (5 minutes) and
//     drops the rest; run_latest_once fires the latest due slot once inside the 24-hour replay
//     horizon (ADR-0043 Values) and drops the rest. Either way the next slot then moves past
//     now, so a burst never follows an outage or a stop.

export const scheduleOnTimeMs = 5 * 60_000;
export const scheduleReplayHorizonMs = 24 * 3_600_000;
export const scheduleMinimumGapMinutes = 15;
const minuteMs = 60_000;
const dayMs = 86_400_000;
const dayMinutes = 1440;
const weekDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's days_from_civil). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
/** The date of a day number (civil_from_days). */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}
/** 0 for Monday to 6 for Sunday (1970-01-01 was a Thursday). */
export const weekdayOf = (days: number): number => (((days + 3) % 7) + 7) % 7;
const lastDayOfMonth = (year: number, month: number): number =>
  daysFromCivil(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) -
  daysFromCivil(year, month, 1);

/** A local date YYYY-MM-DD as a day number, or null when the month has no such day. */
export function localDateDays(text: string): number | null {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > lastDayOfMonth(year, month)) return null;
  return daysFromCivil(year, month, day);
}
/** HH:MM as minutes after local midnight. */
export const localTimeMinutes = (text: string): number =>
  Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      era: "short",
    });
    formatters.set(zone, f);
  }
  return f;
}
/** The zone's offset from UTC at an instant, in whole minutes (local = UTC + offset). */
export function zoneOffsetMinutes(zone: string, instantMs: number): number {
  const at = Math.floor(instantMs / 1000) * 1000;
  const parts: Record<string, string> = {};
  for (const p of formatter(zone).formatToParts(new Date(at))) parts[p.type] = p.value;
  const year = parts.era === "BC" ? 1 - Number(parts.year) : Number(parts.year);
  const local =
    daysFromCivil(year, Number(parts.month), Number(parts.day)) * dayMs +
    Number(parts.hour) * 3_600_000 +
    Number(parts.minute) * minuteMs +
    Number(parts.second) * 1000;
  return Math.round((local - at) / minuteMs);
}
/** The local day number of an instant in a zone. */
export const localDayOf = (zone: string, instantMs: number): number =>
  Math.floor((instantMs + zoneOffsetMinutes(zone, instantMs) * minuteMs) / dayMs);

/**
 * The instant of a local wall-clock minute (minutes since 1970-01-01T00:00 local): the one
 * instant that shows it; its first occurrence when the clocks go back over it; and, when the
 * clocks go forward over it, the next valid minute, the instant the clocks change.
 */
export function resolveLocalMinute(zone: string, localMinute: number): number {
  const wall = localMinute * minuteMs;
  const before = zoneOffsetMinutes(zone, wall - dayMs);
  const after = zoneOffsetMinutes(zone, wall + dayMs);
  const early = wall - before * minuteMs;
  const late = wall - after * minuteMs;
  const shows = (instant: number) => instant + zoneOffsetMinutes(zone, instant) * minuteMs === wall;
  const a = shows(early),
    b = shows(late);
  if (a && b) return Math.min(early, late);
  if (a) return early;
  if (b) return late;
  // A gap: the first minute after `lo` whose offset differs from lo's is the change.
  let lo = Math.min(early, late),
    hi = Math.max(early, late);
  const base = zoneOffsetMinutes(zone, lo);
  while (hi - lo > minuteMs) {
    const mid = lo + Math.floor((hi - lo) / 2 / minuteMs) * minuteMs;
    if (zoneOffsetMinutes(zone, mid) === base) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** The local minutes of the day `days` on which the schedule has slots, ascending. */
export function daySlots(schedule: Current_Schedule, days: number): readonly number[] {
  switch (schedule.kind) {
    case "daily":
      return schedule.times.map(localTimeMinutes);
    case "weekly":
      return schedule.daysOfWeek.includes(weekDays[weekdayOf(days)]!)
        ? [localTimeMinutes(schedule.time)]
        : [];
    case "monthly": {
      const { year, month, day } = civilFromDays(days);
      const wanted =
        schedule.dayOfMonth === "last" ? lastDayOfMonth(year, month) : schedule.dayOfMonth;
      return day === wanted ? [localTimeMinutes(schedule.time)] : [];
    }
    case "every": {
      const out: number[] = [];
      for (let m = 0; m < dayMinutes; m += schedule.everyMinutes) out.push(m);
      return out;
    }
  }
}

const searchDays = 400;
/** The schedule's first slot strictly after an instant, or null when none remains. */
export function nextSlotAfter(schedule: Current_Schedule, afterMs: number): number | null {
  const zone = schedule.timeZone;
  const first = schedule.startDate === null ? null : localDateDays(schedule.startDate);
  const last = schedule.endDate === null ? null : localDateDays(schedule.endDate);
  let day = localDayOf(zone, afterMs) - 1;
  if (first !== null && day < first) day = first;
  for (let n = 0; n < searchDays; n++, day++) {
    if (last !== null && day > last) return null;
    for (const minute of daySlots(schedule, day)) {
      const instant = resolveLocalMinute(zone, day * dayMinutes + minute);
      if (instant > afterMs) return instant;
    }
  }
  return null;
}

export interface FirePlan {
  /** The one slot to fire now, or null. */
  readonly fire: number | null;
  /** The schedule's next slot after now, or null when the schedule has ended. */
  readonly next: number | null;
  /** Whether a due slot was dropped (missed and not fired). */
  readonly missed: boolean;
}
/**
 * What one firing pass does with a schedule whose next slot is `nextSlotMs` (always one of its
 * slots) at `nowMs`: nothing before it is due; otherwise the latest due slot inside the window
 * missedRun allows fires once and every other due slot is dropped.
 */
export function firePlan(schedule: Current_Schedule, nextSlotMs: number, nowMs: number): FirePlan {
  if (nextSlotMs > nowMs) return { fire: null, next: nextSlotMs, missed: false };
  const window = schedule.missedRun === "skip" ? scheduleOnTimeMs : scheduleReplayHorizonMs;
  const from = Math.max(nextSlotMs, nowMs - window);
  let latest: number | null = null;
  for (let s = nextSlotAfter(schedule, from - 1); s !== null && s <= nowMs; ) {
    latest = s;
    s = nextSlotAfter(schedule, s);
  }
  return {
    fire: latest,
    next: nextSlotAfter(schedule, nowMs),
    missed: latest === null || latest !== nextSlotMs,
  };
}

/** The UTC text of a slot as the trigger key carries it: YYYY-MM-DDTHH:MM:SSZ. */
export function slotText(instantMs: number): string {
  return new Date(Math.floor(instantMs / 1000) * 1000).toISOString().replace(".000Z", "Z");
}
/** The trigger key of one slot (ADR-0043 item 23): `sched:<schedule id>:<slot UTC>`. */
export const scheduleTriggerKey = (scheduleId: string, slotMs: number): string =>
  "sched:" + scheduleId + ":" + slotText(slotMs);
