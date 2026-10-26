// A round over the golden set: the CI replay (every case against its recording, in the eval
// world) and the live round's shape (ADR-0037 item 10: each task at least twice, on the
// workspace's credits within the owner's Anthropic monthly limit, under ADR-0035's standing
// approval). Both produce the same EvalReport@1, so designs compare the same way.
//
// The live round runs only through a driver that the deployed environment provides; none
// exists yet (it needs the agent loop, PR #64, and teammate calls, ADR-0037 plan PRs 4 and
// 5). Its gate refuses, in order: inside CI, without the explicit confirmation, while the
// reviewed switch (agent-evals-live.json in docs/decisions) is off, with a bindings file
// inside the repository, and without a driver.
import type { EvalCase, EvalDesign, EvalRecording, EvalRubric, EvalSet } from "./format";
import {
  EvalFormatError,
  parseEvalCase,
  parseEvalRecording,
  parseEvalRubric,
  parseEvalSet,
  recordingFileName,
} from "./format";
import { replayCase, type EvalReplayOptions, type EvalTrace } from "./replay";
import { caseReport, repetitionReport, roundReport, type EvalReport } from "./report";
import { scoreTrace } from "./score";

export interface EvalLibrary {
  readonly set: EvalSet;
  readonly cases: ReadonlyMap<string, EvalCase>;
  readonly rubrics: ReadonlyMap<string, EvalRubric>;
  /** Keyed by recordingFileName(caseId, design). */
  readonly recordings: ReadonlyMap<string, EvalRecording>;
}
/**
 * Parses and cross-checks every file of a set: exactly the set's cases, each with its rubric
 * and a recording for the primary design; every recording for a case and design of the set.
 */
export function evalLibrary(files: {
  readonly set: unknown;
  readonly cases: readonly unknown[];
  readonly rubrics: readonly unknown[];
  readonly recordings: readonly unknown[];
}): EvalLibrary {
  const set = parseEvalSet(files.set);
  const cases = new Map<string, EvalCase>();
  for (const value of files.cases) {
    const parsed = parseEvalCase(value);
    if (cases.has(parsed.caseId)) throw new EvalFormatError("EVAL_DUPLICATE", parsed.caseId);
    cases.set(parsed.caseId, parsed);
  }
  if ([...cases.keys()].sort().join() !== [...set.cases].sort().join())
    throw new EvalFormatError("EVAL_SET_CASES", "set.cases");
  const rubrics = new Map<string, EvalRubric>();
  for (const value of files.rubrics) {
    const parsed = parseEvalRubric(value);
    if (rubrics.has(parsed.rubricId)) throw new EvalFormatError("EVAL_DUPLICATE", parsed.rubricId);
    rubrics.set(parsed.rubricId, parsed);
  }
  const recordings = new Map<string, EvalRecording>();
  for (const value of files.recordings) {
    const parsed = parseEvalRecording(value);
    const name = recordingFileName(parsed.caseId, parsed.design);
    if (recordings.has(name)) throw new EvalFormatError("EVAL_DUPLICATE", name);
    if (!cases.has(parsed.caseId) || !set.designs.includes(parsed.design))
      throw new EvalFormatError("EVAL_RECORDING_UNKNOWN", name);
    recordings.set(name, parsed);
  }
  for (const evalCase of cases.values()) {
    if (!rubrics.has(evalCase.rubricId))
      throw new EvalFormatError("EVAL_RUBRIC_MISSING", evalCase.caseId);
    if (!recordings.has(recordingFileName(evalCase.caseId, set.primaryDesign)))
      throw new EvalFormatError("EVAL_RECORDING_MISSING", evalCase.caseId);
  }
  for (const rubricId of rubrics.keys())
    if (![...cases.values()].some((c) => c.rubricId === rubricId))
      throw new EvalFormatError("EVAL_RUBRIC_UNUSED", rubricId);
  return { set, cases, rubrics, recordings };
}

export interface EvalReplayRound {
  readonly report: EvalReport;
  readonly traces: ReadonlyMap<string, EvalTrace>;
}
/** The CI replay of one design: each case once (the replay is deterministic). */
export async function replayRound(
  library: EvalLibrary,
  design: EvalDesign,
  options: EvalReplayOptions = {},
): Promise<EvalReplayRound> {
  if (!library.set.designs.includes(design)) throw Error("EVAL_DESIGN_NOT_IN_SET");
  const traces = new Map<string, EvalTrace>();
  const reports = [];
  for (const caseId of library.set.cases) {
    const evalCase = library.cases.get(caseId)!;
    const meta = { caseId, category: evalCase.category, rubricId: evalCase.rubricId };
    const recording = library.recordings.get(recordingFileName(caseId, design));
    if (!recording) {
      reports.push(caseReport(meta, [], "no_recording"));
      continue;
    }
    const trace = await replayCase(evalCase, recording, design, options);
    traces.set(caseId, trace);
    const score = scoreTrace(evalCase, library.rubrics.get(evalCase.rubricId)!, trace);
    reports.push(caseReport(meta, [repetitionReport(1, score)]));
  }
  return { report: roundReport("replay", library.set.setId, design, reports), traces };
}

// --- Live rounds --------------------------------------------------------------------------
/** Morrow ids in the deployed environment for each case's live slots; kept outside the repo. */
export interface EvalLiveBindings {
  readonly schemaVersion: 1;
  readonly setId: string;
  readonly cases: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
const morrowIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
export function parseLiveBindings(value: unknown, library: EvalLibrary): EvalLiveBindings {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(value) || Object.keys(value).sort().join() !== "cases,schemaVersion,setId")
    throw new EvalFormatError("EVAL_BINDINGS_SHAPE", "bindings");
  if (value.schemaVersion !== 1 || value.setId !== library.set.setId || !isObject(value.cases))
    throw new EvalFormatError("EVAL_BINDINGS_SHAPE", "bindings");
  const cases: Record<string, Record<string, string>> = {};
  for (const [caseId, slots] of Object.entries(value.cases)) {
    const evalCase = library.cases.get(caseId);
    if (!evalCase || !isObject(slots)) throw new EvalFormatError("EVAL_BINDINGS_CASE", caseId);
    const known = evalCase.fixtures.flatMap((f) => (f.liveSlot ? [f.liveSlot] : []));
    for (const [slot, id] of Object.entries(slots))
      if (!known.includes(slot) || typeof id !== "string" || !morrowIdPattern.test(id))
        throw new EvalFormatError("EVAL_BINDINGS_SLOT", caseId + "." + slot);
    cases[caseId] = { ...(slots as Record<string, string>) };
  }
  return { schemaVersion: 1, setId: library.set.setId, cases };
}

/** Runs one case once in the deployed environment and reads back its codes-only trace. */
export interface EvalLiveDriver {
  runCase(input: {
    readonly evalCase: EvalCase;
    readonly design: EvalDesign;
    readonly repetition: number;
    readonly slots: Readonly<Record<string, string>>;
  }): Promise<EvalTrace>;
}
export type EvalLiveGate = { readonly ok: true } | { readonly ok: false; readonly code: string };
/** The live round's gate, checked before anything is read or sent. */
export function liveRoundGate(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly confirmed: boolean;
  readonly switchState: "on" | "off";
  readonly bindingsPath: string | null;
  readonly repositoryRoot: string;
  readonly driverAvailable: boolean;
}): EvalLiveGate {
  const refuse = (code: string): EvalLiveGate => ({ ok: false, code });
  // A live round never runs in CI: CI has no model key, and a round draws real credits.
  if (["CI", "GITHUB_ACTIONS"].some((name) => (input.environment[name] ?? "") !== ""))
    return refuse("EVAL_LIVE_IN_CI");
  if (!input.confirmed) return refuse("EVAL_LIVE_CONFIRMATION_MISSING");
  if (input.switchState !== "on") return refuse("EVAL_LIVE_SWITCH_OFF");
  const path = input.bindingsPath;
  const root = input.repositoryRoot.replace(/\/+$/, "");
  if (
    path === null ||
    !path.startsWith("/") ||
    path.split("/").includes("..") ||
    path === root ||
    path.startsWith(root + "/")
  )
    return refuse("EVAL_LIVE_BINDINGS_PATH");
  if (!input.driverAvailable) return refuse("EVAL_LIVE_DRIVER_UNAVAILABLE");
  return { ok: true };
}

/** A live round of one design: each case `repetitions` times (at least the set's minimum). */
export async function liveRound(
  library: EvalLibrary,
  driver: EvalLiveDriver,
  input: {
    readonly design: EvalDesign;
    readonly repetitions: number;
    readonly bindings: EvalLiveBindings;
  },
): Promise<EvalReport> {
  if (!library.set.designs.includes(input.design)) throw Error("EVAL_DESIGN_NOT_IN_SET");
  if (
    !Number.isInteger(input.repetitions) ||
    input.repetitions < library.set.liveRepetitionsMin ||
    input.repetitions > 10
  )
    throw Error("EVAL_LIVE_REPETITIONS");
  const reports = [];
  for (const caseId of library.set.cases) {
    const evalCase = library.cases.get(caseId)!;
    const meta = { caseId, category: evalCase.category, rubricId: evalCase.rubricId };
    const slots = input.bindings.cases[caseId] ?? {};
    const needed = evalCase.fixtures.flatMap((f) => (f.liveSlot ? [f.liveSlot] : []));
    if (needed.some((slot) => !(slot in slots))) {
      reports.push(caseReport(meta, [], "slot_unbound"));
      continue;
    }
    const repetitions = [];
    for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
      const trace = await driver.runCase({ evalCase, design: input.design, repetition, slots });
      if (trace.caseId !== caseId || trace.design !== input.design) throw Error("EVAL_LIVE_TRACE");
      const score = scoreTrace(evalCase, library.rubrics.get(evalCase.rubricId)!, trace);
      repetitions.push(repetitionReport(repetition, score));
    }
    reports.push(caseReport(meta, repetitions));
  }
  return roundReport("live", library.set.setId, input.design, reports);
}
