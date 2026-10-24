// Pure helpers of the project screens: day formatting, word labels and tones, and the
// orders the boards use. None computes a value, health word or estimate: those come from
// the server as read (ADR-0033 item 4).
import { projectsCopy } from "./copy";
import type { HealthView, ProjectRowView, ProjectTaskRowView, TaskBucket } from "./model";
import { taskBuckets } from "./model";

const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A `YYYY-MM-DD` day as a valid UTC date, or null. */
export function parseDay(value: string): Date | null {
  const match = dayPattern.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}
const dayFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
/** "Fri, Dec 4" for `2026-12-04`; anything else renders as given. */
export function formatDay(value: string): string {
  const date = parseDay(value);
  return date ? dayFormat.format(date) : value;
}
/** "Dec 4": the short form the sidebar and rows use. */
export function formatShortDay(value: string): string {
  const date = parseDay(value);
  return date
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
        date,
      )
    : value;
}

/** Badge tones (Sunrise): caution your turn, info being worked on, success done. */
export type WordTone = "caution" | "info" | "success" | "warning" | "neutral" | "critical";
export type WordGlyph = "ring" | "half" | "check" | "alert" | "circle" | "pause" | "minus";
export interface WordStyle {
  readonly label: string;
  /** Null: plain text, no badge (Not checked yet, Starting point, Not started). */
  readonly tone: WordTone | null;
  readonly glyph: WordGlyph;
}
const healthStyles: Readonly<Record<string, WordStyle>> = {
  on_track: { label: projectsCopy.health.on_track, tone: "success", glyph: "check" },
  done: { label: projectsCopy.health.done, tone: "success", glyph: "check" },
  behind: { label: projectsCopy.health.behind, tone: "warning", glyph: "alert" },
  needs_you: { label: projectsCopy.health.needs_you, tone: "caution", glyph: "ring" },
  not_measured: { label: projectsCopy.health.not_measured, tone: null, glyph: "circle" },
  not_checked_yet: { label: projectsCopy.health.not_checked_yet, tone: null, glyph: "circle" },
  starting_point: { label: projectsCopy.health.starting_point, tone: null, glyph: "circle" },
  not_started: { label: projectsCopy.health.not_started, tone: null, glyph: "circle" },
};
/** A health word's label and badge; an unknown word is plain text as given. */
export function healthStyle(health: HealthView): WordStyle {
  return Object.hasOwn(healthStyles, health.word)
    ? healthStyles[health.word]!
    : { label: health.word, tone: null, glyph: "circle" };
}

const statusStyles: Readonly<Record<string, WordStyle>> = {
  done: { label: projectsCopy.status.done, tone: "success", glyph: "check" },
  to_do: { label: projectsCopy.status.to_do, tone: "neutral", glyph: "circle" },
  working: { label: projectsCopy.status.working, tone: "info", glyph: "half" },
  needs_you: { label: projectsCopy.status.needs_you, tone: "caution", glyph: "ring" },
  not_started: { label: projectsCopy.status.not_started, tone: "neutral", glyph: "circle" },
  cancelled: { label: projectsCopy.status.cancelled, tone: "neutral", glyph: "minus" },
  paused: { label: projectsCopy.status.paused, tone: "neutral", glyph: "pause" },
  active: { label: projectsCopy.status.active, tone: "success", glyph: "check" },
  off: { label: projectsCopy.status.off, tone: "neutral", glyph: "pause" },
  done_today: { label: projectsCopy.status.done_today, tone: "success", glyph: "check" },
};
/** A step, task, repeating task or alert status; unknown values render as text. */
export function statusStyle(status: string): WordStyle {
  return Object.hasOwn(statusStyles, status)
    ? statusStyles[status]!
    : { label: status, tone: "neutral", glyph: "circle" };
}

/** Dated projects, earliest end first (the boards' order); ties by title. */
export function byEndDate(rows: readonly ProjectRowView[]): readonly ProjectRowView[] {
  return [...rows].sort(
    (a, b) => a.endsOn.localeCompare(b.endsOn) || a.title.localeCompare(b.title),
  );
}

/**
 * The Tasks tab's columns in the board's order, with the rows Mine keeps. A bucket the
 * screen doesn't know gets its own column after them, named by its text, so no row is
 * ever dropped.
 */
export function bucketRows(
  rows: readonly ProjectTaskRowView[],
  mine: boolean,
): readonly { readonly bucket: string; readonly rows: readonly ProjectTaskRowView[] }[] {
  const shown = mine ? rows.filter((r) => r.mine) : rows;
  const known: readonly string[] = taskBuckets;
  const others = [...new Set(shown.map((r) => r.bucket).filter((b) => !known.includes(b)))];
  return [...taskBuckets, ...others].map((bucket: TaskBucket | string) => ({
    bucket,
    rows: shown.filter((r) => r.bucket === bucket),
  }));
}
