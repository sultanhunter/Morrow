import type { Current_Schedule } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { isIanaTimeZone } from "@morrow/contracts/time-zones";
import { localDateDays, localTimeMinutes, scheduleMinimumGapMinutes } from "./slots.js";

// Schedule@1's checks beyond its schema (ADR-0043 item 7; plan row SD12). The schema closes
// the shape; code adds what a schema cannot say: the zone is on the closed list exactly (an
// alias is mapped before anything stores a schedule), a daily schedule's times ascend and lie
// at least 15 minutes apart (also from the last time to the first across midnight, so nothing
// runs more often than every 15 minutes), a weekly schedule's days are in week order, and the
// optional dates are real days with the first no later than the last. Its SQL twin is
// morrow_work.schedule_body_valid (migration schedules-shop-zone), the CHECK on every stored
// schedule; tests/schedules.test.mjs and lab:mandates hold the two to the same answers.

export type ScheduleRefusal =
  | "schedule_invalid"
  | "zone_unknown"
  | "times_out_of_order"
  | "times_too_close"
  | "days_out_of_order"
  | "dates_invalid";
export type ScheduleCheck =
  | { readonly ok: true; readonly schedule: Current_Schedule }
  | { readonly ok: false; readonly refusal: ScheduleRefusal };
const weekOrder = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export function checkSchedule(value: unknown): ScheduleCheck {
  if (!validateCurrentDefinition("Schedule", value))
    return { ok: false, refusal: "schedule_invalid" };
  const schedule = value as Current_Schedule;
  if (!isIanaTimeZone(schedule.timeZone)) return { ok: false, refusal: "zone_unknown" };
  if (schedule.kind === "daily") {
    const minutes = schedule.times.map(localTimeMinutes);
    for (let i = 1; i < minutes.length; i++) {
      if (minutes[i]! <= minutes[i - 1]!) return { ok: false, refusal: "times_out_of_order" };
      if (minutes[i]! - minutes[i - 1]! < scheduleMinimumGapMinutes)
        return { ok: false, refusal: "times_too_close" };
    }
    if (minutes.length > 1 && minutes[0]! + 1440 - minutes.at(-1)! < scheduleMinimumGapMinutes)
      return { ok: false, refusal: "times_too_close" };
  }
  if (schedule.kind === "weekly") {
    const order = schedule.daysOfWeek.map((d) => weekOrder.indexOf(d));
    if (order.some((n, i) => i > 0 && n <= order[i - 1]!))
      return { ok: false, refusal: "days_out_of_order" };
  }
  const first = schedule.startDate === null ? null : localDateDays(schedule.startDate);
  const last = schedule.endDate === null ? null : localDateDays(schedule.endDate);
  if (
    (schedule.startDate !== null && first === null) ||
    (schedule.endDate !== null && last === null) ||
    (first !== null && last !== null && first > last)
  )
    return { ok: false, refusal: "dates_invalid" };
  return { ok: true, schedule };
}
