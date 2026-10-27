// Judge calibration against the owner's labels (ADR-0041 items 19 and 37; OD-2026-10-26-7,
// question 22): rubric criteria of kind `model` are judged by Opus 5.5 in a separate context,
// and a judge counts only once it agrees with the owner on a labelled set of about 60 example
// results, relabelled once a quarter. The same measure calibrates the review runs (their catch
// rate and false-block rate). The repository holds example ids, the case, rubric and criterion
// each one grades, the live slot naming its result in the deployed environment (the result is
// store data, so it stays there), the owner's label as a code, and the targets, written before
// the owner labels. Pure: no I/O, clock or randomness.
import type { EvalCase, EvalRubric } from "./format";
import {
  EvalFormatError,
  evalCaseIdPattern,
  evalDeepFreeze,
  evalInteger,
  evalList,
  evalNullable,
  evalNumber,
  evalOneOf,
  evalRecord,
  evalSetIdPattern,
  evalSyntheticIdsOnly,
  evalText,
  evalVersion,
  evalRubricIdPattern,
} from "./format";

export type EvalLabel = "pass" | "fail";
export interface EvalCalibrationExample {
  readonly exampleId: string;
  readonly caseId: string;
  readonly rubricId: string;
  readonly criterionId: string;
  /** The live slot naming the result in the deployed environment (never the result itself). */
  readonly resultSlot: string;
  /** The owner's label, or null until the owner labels it. */
  readonly ownerLabel: EvalLabel | null;
}
export interface EvalCalibrationSet {
  readonly schemaVersion: 1;
  readonly calibrationId: string;
  readonly setId: string;
  readonly quarter: string;
  readonly judge: {
    readonly model: "claude-opus-5-5";
    readonly effort: "medium" | "high";
    readonly context: "separate";
  };
  readonly examplesMin: number;
  /** Written before the owner labels: the judge counts only when it meets both. */
  readonly targets: { readonly agreementMin: number; readonly kappaMin: number };
  readonly examples: readonly EvalCalibrationExample[];
}
const quarterPattern = /^20[0-9]{2}-Q[1-4]$/;
const calibrationIdPattern = /^calibration\.20[0-9]{2}-q[1-4]@[1-9][0-9]{0,2}$/;
const exampleIdPattern = /^ex_[0-9]{3,4}$/;
const slotPattern = /^[a-z][a-z0-9_]{0,31}$/;
export function parseCalibrationSet(
  value: unknown,
  cases: ReadonlyMap<string, EvalCase>,
  rubrics: ReadonlyMap<string, EvalRubric>,
): EvalCalibrationSet {
  const r = evalRecord(value, "calibration", [
    "schemaVersion",
    "calibrationId",
    "setId",
    "quarter",
    "judge",
    "examplesMin",
    "targets",
    "examples",
  ]);
  evalVersion(r.schemaVersion, "calibration.schemaVersion", 1);
  const judge = evalRecord(r.judge, "calibration.judge", ["model", "effort", "context"]);
  const targets = evalRecord(r.targets, "calibration.targets", ["agreementMin", "kappaMin"]);
  const examplesMin = evalInteger(r.examplesMin, "calibration.examplesMin", 20, 1000);
  const examples = evalList(
    r.examples,
    "calibration.examples",
    1000,
    (v, p) => {
      const x = evalRecord(v, p, [
        "exampleId",
        "caseId",
        "rubricId",
        "criterionId",
        "resultSlot",
        "ownerLabel",
      ]);
      const example = {
        exampleId: evalText(x.exampleId, p + ".exampleId", { pattern: exampleIdPattern }),
        caseId: evalText(x.caseId, p + ".caseId", { pattern: evalCaseIdPattern }),
        rubricId: evalText(x.rubricId, p + ".rubricId", { pattern: evalRubricIdPattern }),
        criterionId: evalText(x.criterionId, p + ".criterionId", {
          pattern: /^[a-z][a-z0-9_]{0,47}$/,
        }),
        resultSlot: evalText(x.resultSlot, p + ".resultSlot", { pattern: slotPattern }),
        ownerLabel: evalNullable(x.ownerLabel, p + ".ownerLabel", (l, q) =>
          evalOneOf(l, q, ["pass", "fail"] as const),
        ),
      };
      // Each example grades a model criterion of the case's own rubric.
      const evalCase = cases.get(example.caseId);
      const rubric = rubrics.get(example.rubricId);
      if (!evalCase || evalCase.rubricId !== example.rubricId || !rubric)
        throw new EvalFormatError("EVAL_CALIBRATION_CASE", p);
      if (!rubric.criteria.some((c) => c.criterionId === example.criterionId && c.kind === "model"))
        throw new EvalFormatError("EVAL_CALIBRATION_CRITERION", p + ".criterionId");
      return example;
    },
    { min: examplesMin },
  );
  if (new Set(examples.map((e) => e.exampleId)).size !== examples.length)
    throw new EvalFormatError("EVAL_DUPLICATE", "calibration.examples");
  if (new Set(examples.map((e) => e.resultSlot)).size !== examples.length)
    throw new EvalFormatError("EVAL_DUPLICATE", "calibration.examples.resultSlot");
  const quarter = evalText(r.quarter, "calibration.quarter", { pattern: quarterPattern });
  const calibrationId = evalText(r.calibrationId, "calibration.calibrationId", {
    pattern: calibrationIdPattern,
  });
  if (!calibrationId.startsWith("calibration." + quarter.toLowerCase() + "@"))
    throw new EvalFormatError("EVAL_CALIBRATION_QUARTER", "calibration.calibrationId");
  const parsed = {
    schemaVersion: 1 as const,
    calibrationId,
    setId: evalText(r.setId, "calibration.setId", { pattern: evalSetIdPattern }),
    quarter,
    judge: {
      model: evalOneOf(judge.model, "calibration.judge.model", ["claude-opus-5-5"] as const),
      effort: evalOneOf(judge.effort, "calibration.judge.effort", ["medium", "high"] as const),
      context: evalOneOf(judge.context, "calibration.judge.context", ["separate"] as const),
    },
    examplesMin,
    targets: {
      agreementMin: evalNumber(targets.agreementMin, "calibration.targets.agreementMin", 0.5, 1),
      kappaMin: evalNumber(targets.kappaMin, "calibration.targets.kappaMin", 0, 1),
    },
    examples,
  };
  evalSyntheticIdsOnly(r, "calibration");
  return evalDeepFreeze(parsed);
}

export interface EvalCalibrationResult {
  readonly calibrationId: string;
  readonly labelled: number;
  readonly judged: number;
  /** Share of labelled examples where the judge agrees with the owner. */
  readonly agreement: number | null;
  /** Cohen's kappa: agreement beyond chance. */
  readonly kappa: number | null;
  /** Of the results the owner failed, the share the judge failed (a reviewer's catch rate). */
  readonly catchRate: number | null;
  /** Of the results the owner passed, the share the judge failed (a reviewer's false blocks). */
  readonly falseBlockRate: number | null;
  /** Whether the judge may grade model criteria this quarter. */
  readonly calibrated: boolean;
}
/**
 * The judge's agreement with the owner's labels. Only labelled examples the judge also graded
 * count; the judge is calibrated when there are at least `examplesMin` of them and both
 * targets are met.
 */
export function calibrateJudge(
  set: EvalCalibrationSet,
  judged: Readonly<Record<string, EvalLabel>>,
): EvalCalibrationResult {
  const pairs = set.examples.flatMap((e) =>
    e.ownerLabel !== null && judged[e.exampleId] !== undefined
      ? [{ owner: e.ownerLabel, judge: judged[e.exampleId]! }]
      : [],
  );
  for (const id of Object.keys(judged))
    if (!set.examples.some((e) => e.exampleId === id))
      throw Error("EVAL_CALIBRATION_UNKNOWN_EXAMPLE");
  const n = pairs.length;
  const count = (owner: EvalLabel, judge: EvalLabel) =>
    pairs.filter((p) => p.owner === owner && p.judge === judge).length;
  const pp = count("pass", "pass");
  const ff = count("fail", "fail");
  const pf = count("pass", "fail");
  const fp = count("fail", "pass");
  const agreement = n ? (pp + ff) / n : null;
  const ownerPass = (pp + pf) / (n || 1);
  const judgePass = (pp + fp) / (n || 1);
  const chance = ownerPass * judgePass + (1 - ownerPass) * (1 - judgePass);
  const kappa =
    agreement === null
      ? null
      : chance >= 1
        ? agreement === 1
          ? 1
          : 0
        : (agreement - chance) / (1 - chance);
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10000) / 10000);
  const result = {
    calibrationId: set.calibrationId,
    labelled: set.examples.filter((e) => e.ownerLabel !== null).length,
    judged: n,
    agreement: round(agreement),
    kappa: round(kappa),
    catchRate: round(ff + fp ? ff / (ff + fp) : null),
    falseBlockRate: round(pp + pf ? pf / (pp + pf) : null),
  };
  return {
    ...result,
    calibrated:
      n >= set.examplesMin &&
      result.agreement !== null &&
      result.kappa !== null &&
      result.agreement >= set.targets.agreementMin &&
      result.kappa >= set.targets.kappaMin,
  };
}
