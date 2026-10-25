// The round report (EvalReport@1) and the design comparison (EvalComparison@1), ADR-0037
// item 10: each case's result per repetition, then designs compared task by task (which
// tasks flipped), not only by totals. Both hold ids, codes and numbers only: no request,
// fixture text, brief, reply or store data, so a live round's report may be kept as evidence.
import type { EvalCategory, EvalDesign } from "./format";
import { evalWorldVersion } from "./format";
import type { EvalCaseScore, EvalCheckResult, EvalMetrics } from "./score";

export type EvalRoundKind = "replay" | "live";
export type EvalCaseStatus = "pass" | "fail" | "mixed" | "error" | "skipped";
export interface EvalRepetitionReport {
  readonly repetition: number;
  readonly status: "pass" | "fail" | "error";
  readonly admission: string;
  readonly endCode: string;
  readonly failedChecks: readonly string[];
  readonly checks: readonly EvalCheckResult[];
  readonly rubric: {
    readonly codePassed: number;
    readonly codeTotal: number;
    readonly failed: readonly string[];
    readonly pending: readonly string[];
  };
  readonly metrics: EvalMetrics;
}
export interface EvalCaseReport {
  readonly caseId: string;
  readonly category: EvalCategory;
  readonly rubricId: string;
  readonly status: EvalCaseStatus;
  readonly passes: number;
  /** Why the case did not run (`slot_unbound` in a live round), or null. */
  readonly skipped: string | null;
  readonly repetitions: readonly EvalRepetitionReport[];
}
export interface EvalReport {
  readonly schemaVersion: 1;
  readonly kind: EvalRoundKind;
  readonly setId: string;
  readonly design: EvalDesign;
  readonly worldVersion: number;
  readonly cases: readonly EvalCaseReport[];
  /** Credits: the eval world's fake prices in a replay, the workspace's real draw in a live round. */
  readonly totals: Readonly<Record<EvalCaseStatus, number>> & {
    readonly cases: number;
    readonly creditsDrawn: number;
  };
}

export function repetitionReport(repetition: number, score: EvalCaseScore): EvalRepetitionReport {
  const code = score.criteria.filter((c) => c.kind === "code");
  return {
    repetition,
    status: score.status,
    admission: score.admission,
    endCode: score.endCode,
    failedChecks: score.checks.filter((c) => !c.pass).map((c) => c.checkId),
    checks: score.checks,
    rubric: {
      codePassed: code.filter((c) => c.verdict === "pass").length,
      codeTotal: code.length,
      failed: score.criteria.filter((c) => c.verdict === "fail").map((c) => c.criterionId),
      pending: score.criteria.filter((c) => c.verdict === "pending").map((c) => c.criterionId),
    },
    metrics: score.metrics,
  };
}
export function caseReport(
  meta: { readonly caseId: string; readonly category: EvalCategory; readonly rubricId: string },
  repetitions: readonly EvalRepetitionReport[],
  skipped: string | null = null,
): EvalCaseReport {
  const passes = repetitions.filter((r) => r.status === "pass").length;
  const status: EvalCaseStatus =
    skipped !== null
      ? "skipped"
      : repetitions.some((r) => r.status === "error")
        ? "error"
        : passes === repetitions.length
          ? "pass"
          : passes === 0
            ? "fail"
            : "mixed";
  return { ...meta, status, passes, skipped, repetitions };
}
export function roundReport(
  kind: EvalRoundKind,
  setId: string,
  design: EvalDesign,
  cases: readonly EvalCaseReport[],
): EvalReport {
  const creditsDrawn = cases.reduce(
    (sum, c) => sum + c.repetitions.reduce((n, r) => n + r.metrics.creditsDrawn, 0),
    0,
  );
  const totals = {
    cases: cases.length,
    creditsDrawn,
    pass: 0,
    fail: 0,
    mixed: 0,
    error: 0,
    skipped: 0,
  };
  for (const c of cases) totals[c.status] += 1;
  return { schemaVersion: 1, kind, setId, design, worldVersion: evalWorldVersion, cases, totals };
}

// --- Comparing designs task by task -------------------------------------------------------
/** `not_compared`: one side has no run (no recording, or a live slot left unbound). */
export type EvalFlip = "fixed" | "broke" | "same" | "changed" | "not_compared";
export interface EvalComparisonRow {
  readonly caseId: string;
  readonly baseline: EvalCaseStatus | "missing";
  readonly candidate: EvalCaseStatus | "missing";
  readonly flip: EvalFlip;
  /** Mean per repetition, candidate minus baseline; null when either side has no run. */
  readonly modelTurnsDelta: number | null;
  readonly creditsDelta: number | null;
}
export interface EvalComparison {
  readonly schemaVersion: 1;
  readonly setId: string;
  readonly kind: EvalRoundKind;
  readonly baseline: EvalDesign;
  readonly candidate: EvalDesign;
  readonly rows: readonly EvalComparisonRow[];
  readonly fixed: readonly string[];
  readonly broke: readonly string[];
  readonly totals: {
    readonly baseline: EvalReport["totals"];
    readonly candidate: EvalReport["totals"];
  };
}
const mean = (report: EvalCaseReport | undefined, pick: (m: EvalMetrics) => number) =>
  report && report.repetitions.length
    ? report.repetitions.reduce((sum, r) => sum + pick(r.metrics), 0) / report.repetitions.length
    : null;
const delta = (a: number | null, b: number | null) =>
  a === null || b === null ? null : Math.round((b - a) * 100) / 100;
/** Which tasks flipped between two designs' reports of the same set and round kind. */
export function compareDesigns(baseline: EvalReport, candidate: EvalReport): EvalComparison {
  if (baseline.setId !== candidate.setId || baseline.kind !== candidate.kind)
    throw Error("EVAL_COMPARE_MISMATCH");
  const before = new Map(baseline.cases.map((c) => [c.caseId, c]));
  const after = new Map(candidate.cases.map((c) => [c.caseId, c]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const rows = ids.map((caseId): EvalComparisonRow => {
    const a = before.get(caseId);
    const b = after.get(caseId);
    const sa = a?.status ?? "missing";
    const sb = b?.status ?? "missing";
    const flip: EvalFlip =
      sa === "missing" || sb === "missing" || sa === "skipped" || sb === "skipped"
        ? "not_compared"
        : sa === sb
          ? "same"
          : sb === "pass"
            ? "fixed"
            : sa === "pass"
              ? "broke"
              : "changed";
    return {
      caseId,
      baseline: sa,
      candidate: sb,
      flip,
      modelTurnsDelta: delta(
        mean(a, (m) => m.modelTurns),
        mean(b, (m) => m.modelTurns),
      ),
      creditsDelta: delta(
        mean(a, (m) => m.creditsDrawn),
        mean(b, (m) => m.creditsDrawn),
      ),
    };
  });
  return {
    schemaVersion: 1,
    setId: baseline.setId,
    kind: baseline.kind,
    baseline: baseline.design,
    candidate: candidate.design,
    rows,
    fixed: rows.filter((r) => r.flip === "fixed").map((r) => r.caseId),
    broke: rows.filter((r) => r.flip === "broke").map((r) => r.caseId),
    totals: { baseline: baseline.totals, candidate: candidate.totals },
  };
}

const signed = (value: number | null) =>
  value === null ? "-" : value > 0 ? "+" + value : String(value);
/** The comparison as a Markdown table for a person: one row per task, flips first. */
export function renderComparison(comparison: EvalComparison): string {
  const order: Record<EvalFlip, number> = {
    broke: 0,
    fixed: 1,
    changed: 2,
    same: 3,
    not_compared: 4,
  };
  const rows = [...comparison.rows].sort(
    (a, b) => order[a.flip] - order[b.flip] || (a.caseId < b.caseId ? -1 : 1),
  );
  const total = (t: EvalReport["totals"]) =>
    `${t.pass} pass, ${t.fail} fail, ${t.mixed} mixed, ${t.error} error, ${t.skipped} skipped; ${t.creditsDrawn} credits drawn`;
  return [
    `# ${comparison.setId} (${comparison.kind}): ${comparison.baseline} against ${comparison.candidate}`,
    "",
    `- ${comparison.baseline}: ${total(comparison.totals.baseline)}`,
    `- ${comparison.candidate}: ${total(comparison.totals.candidate)}`,
    `- Fixed by ${comparison.candidate}: ${comparison.fixed.join(", ") || "none"}`,
    `- Broken by ${comparison.candidate}: ${comparison.broke.join(", ") || "none"}`,
    "",
    `| Task | ${comparison.baseline} | ${comparison.candidate} | Flip | Model turns | Credits |`,
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.caseId} | ${r.baseline} | ${r.candidate} | ${r.flip} | ${signed(r.modelTurnsDelta)} | ${signed(r.creditsDelta)} |`,
    ),
    "",
  ].join("\n");
}
