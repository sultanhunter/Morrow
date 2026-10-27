// The safety values a loop catalogue version pins on every run it admits (AgentRunSafety@1;
// ADR-0041 items 3, 6, 7, 8, 9, 17 and 18, with OD-2026-10-26-12: credits are the only budget,
// so there is no cost check-in). Plan row H7a: until H3 rewrites the proposed loop catalogue
// version 2 with these values in docs/decisions/model-policy.json (ADR-0041 item 38), this module
// is their one source, drift-tested against migration agent-runs' loop_catalogue_versions row
// (tests/agent-loop-migrations.test.mjs). Every value is a safety range or a check-in that asks a
// person, never a limit that ends work; the model never sees any of it.
//
// A version's template is the profile without the turn's max_tokens: that comes from the
// catalogue entry the run is admitted on (ADR-0041 item 8), so runSafety composes the two and
// SQL composes them the same way (agent_safety_compose). Pure: no I/O, clock or node:* import.
import type { Current_AgentRunSafety } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { checkRunSafety } from "./harness";

/** AgentRunSafety@1 without turn.maxOutputTokens, which the catalogue entry supplies. */
export type RunSafetyTemplate = Omit<Current_AgentRunSafety, "turn"> & {
  readonly turn: { readonly callBudgetMs: number };
};

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/**
 * Safety profile 1, ADR-0041's seeds: check-ins at 1,000 model turns, 10,000 tool calls, 24
 * hours of active time and 7 days since the requester's last act, and the kernel's 32 children;
 * the detectors of item 18; the envelope of 24 hours active or 7 days; the 30-minute lease
 * renewed below 20 minutes; person waits of 7 days with reminders at 24 and 72 hours; credits
 * parked 7 days; the provider back-off; segment rolls at 1,000 steps and before waits over 5
 * minutes; a call budget of 28 minutes (the turn step's 30 minutes less 2).
 */
export const runSafetyProfile1: RunSafetyTemplate = freeze({
  schemaVersion: 1,
  profileVersion: 1,
  turn: { callBudgetMs: 28 * minute },
  checkIns: {
    modelTurns: 1000,
    toolCalls: 10000,
    activeMs: day,
    sinceRequesterActMs: 7 * day,
    children: 32,
  },
  detectors: {
    signatureRing: 32,
    repetition: { nudgeAt: 3, tripAt: 4 },
    errorStreak: { nudgeAt: 3, tripAt: 5 },
    alternation: { nudgeAfterSteps: 6, tripAfterSteps: 8 },
    idleTurns: { tripAt: 3 },
    stall: { replanAt: 12, tripAfterReplans: 2 },
    costWithoutProgress: { medianMultiple: 4, expectedTurns: 25 },
    renewalThrash: { keptBasisPoints: 7000, keptTimes: 2, compactions: 3, withinTurns: 20 },
    outputCut: { tripAt: 3 },
  },
  envelope: { activeMs: day, wallMs: 7 * day },
  lease: { ms: 30 * minute, renewBelowMs: 20 * minute },
  personWait: { ms: 7 * day, remindersMs: [day, 3 * day] },
  creditsPark: { closeAfterMs: 7 * day },
  providerBackoff: {
    scheduleMs: [minute, 5 * minute, 15 * minute, 30 * minute, hour],
    thenEveryMs: hour,
    checkInAfterMs: day,
  },
  segments: { rollSteps: 1000, rollBeforeWaitMs: 5 * minute },
});

/** The safety template each loop catalogue version pins (version 2, proposed: profile 1). */
export const loopSafetyTemplates: Readonly<Record<number, RunSafetyTemplate>> = freeze({
  2: runSafetyProfile1,
});

/**
 * A run's AgentRunSafety@1: its catalogue version's template with the entry's max_tokens.
 * Returns null for a version with no template, or a profile that is not a valid AgentRunSafety@1
 * or breaks one of its orderings (checkRunSafety).
 */
export function runSafety(
  catalogueVersion: number,
  maxOutputTokens: number,
): Current_AgentRunSafety | null {
  const template = Object.hasOwn(loopSafetyTemplates, catalogueVersion)
    ? loopSafetyTemplates[catalogueVersion]
    : undefined;
  if (!template) return null;
  const safety = {
    ...template,
    turn: { maxOutputTokens, callBudgetMs: template.turn.callBudgetMs },
  } as Current_AgentRunSafety;
  if (!validateCurrentDefinition("AgentRunSafety", safety)) return null;
  if (checkRunSafety(safety).length > 0) return null;
  return freeze(structuredClone(safety));
}
