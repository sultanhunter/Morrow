// A round over the golden set, version 2: the CI replay (every case against its recording, in
// the eval world) and the live round's shape (ADR-0041 item 37: each case at least three times
// for pass^3, on the workspace's credits within the owner's Anthropic monthly limit, under
// ADR-0035's standing approval). Both produce the same EvalReport@2, so arms compare the same
// way.
//
// The live round runs only through a driver that the deployed environment provides; none
// exists yet (it needs the agent loop, H7, teammate calls, H10, and Morrow's main thread,
// H11a). Its gate refuses, in order: inside CI, without the explicit confirmation, while the
// reviewed switch (agent-evals-live.json in docs/decisions) is off, with a bindings file
// inside the repository, without a driver, and without the round's pass marks written before
// the round (thresholds.ts). A case whose harness rows the driver has not deployed is skipped.
import { calibrateJudge, parseCalibrationSet, type EvalCalibrationSet } from "./calibration";
import type {
  EvalArm,
  EvalCase,
  EvalGate,
  EvalHarnessRow,
  EvalRecording,
  EvalRubric,
  EvalSet,
  EvalVariant,
} from "./format";
import {
  EvalFormatError,
  evalCasesPerCategoryMin,
  evalCategories,
  parseEvalCase,
  parseEvalRecording,
  parseEvalRubric,
  parseEvalSet,
  recordingFileName,
} from "./format";
import {
  forcedCompactionVariant,
  parseAblationPlan,
  parseCompactionProgramme,
  parseContextFillSweep,
  parseMemoryRedTeam,
  parseToolSelection,
  type EvalAblationPlan,
  type EvalCompactionProgramme,
  type EvalContextFillSweep,
  type EvalMemoryRedTeam,
  type EvalToolSelection,
} from "./programme";
import { replayCase, type EvalReplayOptions, type EvalTrace } from "./replay";
import { caseReport, repetitionReport, roundReport, type EvalCaseMeta, type EvalReport } from "./report";
import { scoreTrace } from "./score";
import { evalRoundStart, parseEvalThresholds, type EvalThresholds } from "./thresholds";

export interface EvalProgramme {
  readonly contextFill: EvalContextFillSweep;
  readonly compaction: EvalCompactionProgramme;
  readonly memoryRedTeam: EvalMemoryRedTeam;
  readonly toolSelection: EvalToolSelection;
  readonly ablation: EvalAblationPlan;
}
export interface EvalLibrary {
  readonly set: EvalSet;
  readonly cases: ReadonlyMap<string, EvalCase>;
  readonly rubrics: ReadonlyMap<string, EvalRubric>;
  /** Keyed by recordingFileName(caseId, arm). */
  readonly recordings: ReadonlyMap<string, EvalRecording>;
  readonly thresholds: EvalThresholds;
  readonly programme: EvalProgramme;
  readonly calibration: readonly EvalCalibrationSet[];
}
/**
 * Parses and cross-checks every file of a set: exactly the set's cases, at least eight per
 * category, each with its rubric and a recording for the primary arm; every recording for a
 * case and arm of the set; every rubric used; the pass marks for the same set, each eval round
 * gating at least one case; the programme files and calibration sets against the cases.
 */
export function evalLibrary(files: {
  readonly set: unknown;
  readonly cases: readonly unknown[];
  readonly rubrics: readonly unknown[];
  readonly recordings: readonly unknown[];
  readonly thresholds: unknown;
  readonly programme: {
    readonly contextFill: unknown;
    readonly compaction: unknown;
    readonly memoryRedTeam: unknown;
    readonly toolSelection: unknown;
    readonly ablation: unknown;
  };
  readonly calibration: readonly unknown[];
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
  for (const category of evalCategories)
    if ([...cases.values()].filter((c) => c.category === category).length < evalCasesPerCategoryMin)
      throw new EvalFormatError("EVAL_SET_CATEGORY", category);
  const rubrics = new Map<string, EvalRubric>();
  for (const value of files.rubrics) {
    const parsed = parseEvalRubric(value);
    if (rubrics.has(parsed.rubricId)) throw new EvalFormatError("EVAL_DUPLICATE", parsed.rubricId);
    rubrics.set(parsed.rubricId, parsed);
  }
  const recordings = new Map<string, EvalRecording>();
  for (const value of files.recordings) {
    const parsed = parseEvalRecording(value);
    const name = recordingFileName(parsed.caseId, parsed.arm);
    if (recordings.has(name)) throw new EvalFormatError("EVAL_DUPLICATE", name);
    if (!cases.has(parsed.caseId) || !set.arms.includes(parsed.arm))
      throw new EvalFormatError("EVAL_RECORDING_UNKNOWN", name);
    recordings.set(name, parsed);
  }
  for (const evalCase of cases.values()) {
    if (!rubrics.has(evalCase.rubricId))
      throw new EvalFormatError("EVAL_RUBRIC_MISSING", evalCase.caseId);
    if (!recordings.has(recordingFileName(evalCase.caseId, set.primaryArm)))
      throw new EvalFormatError("EVAL_RECORDING_MISSING", evalCase.caseId);
  }
  for (const rubricId of rubrics.keys())
    if (![...cases.values()].some((c) => c.rubricId === rubricId))
      throw new EvalFormatError("EVAL_RUBRIC_UNUSED", rubricId);
  const thresholds = parseEvalThresholds(files.thresholds);
  if (thresholds.setId !== set.setId) throw new EvalFormatError("EVAL_THRESHOLDS_SET", "thresholds.setId");
  if (set.liveRepetitionsMin < thresholds.k)
    throw new EvalFormatError("EVAL_THRESHOLDS_K", "set.liveRepetitionsMin");
  for (const round of thresholds.rounds) {
    if (round.source === "eval" && ![...cases.values()].some((c) => c.gates.includes(round.gate)))
      throw new EvalFormatError("EVAL_ROUND_NO_CASES", round.roundId);
    for (const arm of [round.arm, round.baseline?.arm].filter((a) => a !== undefined))
      if (!set.arms.includes(arm)) throw new EvalFormatError("EVAL_ROUND_ARM", round.roundId);
  }
  const programme: EvalProgramme = {
    contextFill: parseContextFillSweep(files.programme.contextFill, cases),
    compaction: parseCompactionProgramme(files.programme.compaction, cases),
    memoryRedTeam: parseMemoryRedTeam(files.programme.memoryRedTeam, cases),
    toolSelection: parseToolSelection(files.programme.toolSelection, cases),
    ablation: parseAblationPlan(files.programme.ablation),
  };
  for (const part of Object.values(programme))
    if (part.setId !== set.setId) throw new EvalFormatError("EVAL_PROGRAMME_SET", "programme");
  const calibration = files.calibration.map((value) => parseCalibrationSet(value, cases, rubrics));
  for (const c of calibration)
    if (c.setId !== set.setId) throw new EvalFormatError("EVAL_CALIBRATION_SET", c.calibrationId);
  return { set, cases, rubrics, recordings, thresholds, programme, calibration };
}

const meta = (evalCase: EvalCase): EvalCaseMeta => ({
  caseId: evalCase.caseId,
  category: evalCase.category,
  class: evalCase.class,
  gates: evalCase.gates,
  rubricId: evalCase.rubricId,
});

export interface EvalReplayRound {
  readonly report: EvalReport;
  readonly traces: ReadonlyMap<string, EvalTrace>;
}
/** The CI replay of one arm: each case once (the replay is deterministic). */
export async function replayRound(
  library: EvalLibrary,
  arm: EvalArm,
  options: EvalReplayOptions = {},
): Promise<EvalReplayRound> {
  if (!library.set.arms.includes(arm)) throw Error("EVAL_ARM_NOT_IN_SET");
  const traces = new Map<string, EvalTrace>();
  const reports = [];
  for (const caseId of library.set.cases) {
    const evalCase = library.cases.get(caseId)!;
    const recording = library.recordings.get(recordingFileName(caseId, arm));
    if (!recording) {
      reports.push(caseReport(meta(evalCase), [], "no_recording"));
      continue;
    }
    const trace = await replayCase(evalCase, recording, arm, options);
    traces.set(caseId, trace);
    const score = scoreTrace(evalCase, library.rubrics.get(evalCase.rubricId)!, trace);
    reports.push(caseReport(meta(evalCase), [repetitionReport(1, score)]));
  }
  return { report: roundReport("replay", library.set.setId, arm, reports), traces };
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
  /** The harness plan rows deployed where the driver runs; a case needing another is skipped. */
  readonly deployed: readonly EvalHarnessRow[];
  runCase(input: {
    readonly evalCase: EvalCase;
    readonly arm: EvalArm;
    readonly variant: EvalVariant;
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

/**
 * A live round: the cases its gate covers, each `repetitions` times (at least the set's
 * minimum), under one arm and variant, graded and pinned to the round's pass marks, which must
 * have been written on or before the round's date.
 */
export async function liveRound(
  library: EvalLibrary,
  driver: EvalLiveDriver,
  input: {
    readonly roundId: string;
    readonly roundDate: string;
    /** For a comparison round: run its baseline arm and variant instead of its own. */
    readonly side: "candidate" | "baseline";
    readonly repetitions: number;
    readonly bindings: EvalLiveBindings;
  },
): Promise<EvalReport> {
  const start = await evalRoundStart(library.thresholds, input.roundId, input.roundDate);
  if (!start.ok) throw Error(start.code);
  const round = start.round;
  const side =
    input.side === "candidate"
      ? { arm: round.arm, variant: round.variant }
      : (round.baseline ?? (() => { throw Error("EVAL_LIVE_NO_BASELINE"); })());
  if (
    !Number.isInteger(input.repetitions) ||
    input.repetitions < Math.max(library.set.liveRepetitionsMin, library.thresholds.k) ||
    input.repetitions > 10
  )
    throw Error("EVAL_LIVE_REPETITIONS");
  const gate: EvalGate = round.gate;
  const reports = [];
  for (const caseId of library.set.cases) {
    const written = library.cases.get(caseId)!;
    if (!written.gates.includes(gate)) continue;
    const slots = input.bindings.cases[caseId] ?? {};
    const needed = written.fixtures.flatMap((f) => (f.liveSlot ? [f.liveSlot] : []));
    if (needed.some((slot) => !(slot in slots))) {
      reports.push(caseReport(meta(written), [], "slot_unbound"));
      continue;
    }
    if (written.requires.some((row) => !driver.deployed.includes(row))) {
      reports.push(caseReport(meta(written), [], "requires_unbuilt"));
      continue;
    }
    const evalCase =
      side.variant === "forced_compaction"
        ? forcedCompactionVariant(
            written,
            library.programme.compaction.compactAt.min,
            side.arm === "provider_context@1" ? "provider" : "fallback",
          )
        : written;
    const repetitions = [];
    for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
      const trace = await driver.runCase({
        evalCase,
        arm: side.arm,
        variant: side.variant,
        repetition,
        slots,
      });
      if (trace.caseId !== caseId || trace.arm !== side.arm) throw Error("EVAL_LIVE_TRACE");
      const score = scoreTrace(evalCase, library.rubrics.get(evalCase.rubricId)!, trace);
      repetitions.push(repetitionReport(repetition, score));
    }
    reports.push(caseReport(meta(written), repetitions));
  }
  return roundReport("live", library.set.setId, side.arm, reports, {
    k: library.thresholds.k,
    variant: side.variant,
    thresholds: { roundId: round.roundId, digest: start.digest },
  });
}

/** Whether a quarter's judge may grade model criteria, from the owner's labels. */
export function judgeStatus(
  library: EvalLibrary,
  quarter: string,
  judged: Readonly<Record<string, "pass" | "fail">>,
) {
  const set = library.calibration.find((c) => c.quarter === quarter);
  if (!set) throw Error("EVAL_CALIBRATION_QUARTER_UNKNOWN");
  return calibrateJudge(set, judged);
}
