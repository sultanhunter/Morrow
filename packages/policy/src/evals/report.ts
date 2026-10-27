// The round report (EvalReport@2) and the arm comparison (EvalComparison@2), ADR-0041 item 37
// and ADR-0037 item 10: each case's result per repetition, pass^k per case and per category,
// then arms compared task by task (which tasks flipped), not only by totals. Both hold ids,
// codes and numbers only: no request, fixture text, brief, reply or store data, so a live
// round's report may be kept as evidence.
import type { EvalArm, EvalCaseClass, EvalCategory, EvalGate, EvalVariant } from "./format";
import { evalCategories, evalWorldVersion } from "./format";
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
export interface EvalCaseMeta {
  readonly caseId: string;
  readonly category: EvalCategory;
  readonly class: EvalCaseClass;
  readonly gates: readonly EvalGate[];
  readonly rubricId: string;
}
export interface EvalCaseReport extends EvalCaseMeta {
  readonly status: EvalCaseStatus;
  readonly passes: number;
  /** Why the case did not run (`slot_unbound`, `requires_unbuilt`, `no_recording`), or null. */
  readonly skipped: string | null;
  readonly repetitions: readonly EvalRepetitionReport[];
}
export interface EvalCategoryReport {
  readonly category: EvalCategory;
  readonly cases: number;
  readonly safetyCases: number;
  /** Mean pass^k over the category's cases that ran at least k times; null when none did. */
  readonly passK: number | null;
}
export interface EvalReport {
  readonly schemaVersion: 2;
  readonly kind: EvalRoundKind;
  readonly setId: string;
  readonly arm: EvalArm;
  /** The cases as written, or with compaction forced early. */
  readonly variant: EvalVariant;
  readonly worldVersion: number;
  /** The k of pass^k this report states (3 for a live round, ADR-0041 item 37). */
  readonly k: number;
  /**
   * The round and the digest of its pass marks, pinned when the round started (thresholds.ts):
   * a mark changed after the round cannot grade it. Null for a replay.
   */
  readonly thresholds: { readonly roundId: string; readonly digest: string } | null;
  readonly cases: readonly EvalCaseReport[];
  readonly categories: readonly EvalCategoryReport[];
  /** Credits: the eval world's fake prices in a replay, the workspace's real draw in a live round. */
  readonly totals: Readonly<Record<EvalCaseStatus, number>> & {
    readonly cases: number;
    readonly creditsDrawn: number;
  };
}

/**
 * pass^k: the chance that k repetitions of a case all pass, estimated without bias from `n`
 * repetitions of which `c` passed, C(c, k) / C(n, k) (the tau-bench estimator). Null when the
 * case ran fewer than k times. Safety cases need 1.0: every repetition passes.
 */
export function evalPassK(c: number, n: number, k: number): number | null {
  if (
    !Number.isInteger(c) ||
    !Number.isInteger(n) ||
    !Number.isInteger(k) ||
    k < 1 ||
    c < 0 ||
    c > n
  )
    throw Error("EVAL_PASS_K");
  if (n < k) return null;
  let value = 1;
  for (let i = 0; i < k; i += 1) value *= (c - i) / (n - i);
  return Math.max(0, value);
}
export function casePassK(report: EvalCaseReport, k: number): number | null {
  if (report.status === "skipped" || report.status === "error") return null;
  return evalPassK(report.passes, report.repetitions.length, k);
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
  meta: EvalCaseMeta,
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
  arm: EvalArm,
  cases: readonly EvalCaseReport[],
  options: {
    readonly k?: number;
    readonly variant?: EvalVariant;
    readonly thresholds?: { readonly roundId: string; readonly digest: string } | null;
  } = {},
): EvalReport {
  const k = options.k ?? (kind === "live" ? 3 : 1);
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
  const categories = evalCategories.map((category): EvalCategoryReport => {
    const own = cases.filter((c) => c.category === category);
    const values = own.map((c) => casePassK(c, k)).filter((v): v is number => v !== null);
    return {
      category,
      cases: own.length,
      safetyCases: own.filter((c) => c.class === "safety").length,
      passK: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null,
    };
  });
  return {
    schemaVersion: 2,
    kind,
    setId,
    arm,
    variant: options.variant ?? "as_written",
    worldVersion: evalWorldVersion,
    k,
    thresholds: options.thresholds ?? null,
    cases,
    categories,
    totals,
  };
}
const round = (value: number) => Math.round(value * 10000) / 10000;

// --- Comparing arms task by task -----------------------------------------------------------
/** `not_compared`: one side has no run (no recording, a slot unbound, a row not built). */
export type EvalFlip = "fixed" | "broke" | "same" | "changed" | "not_compared";
export interface EvalComparisonRow {
  readonly caseId: string;
  readonly category: EvalCategory | null;
  readonly baseline: EvalCaseStatus | "missing";
  readonly candidate: EvalCaseStatus | "missing";
  readonly flip: EvalFlip;
  /** Mean per repetition, candidate minus baseline; null when either side has no run. */
  readonly modelTurnsDelta: number | null;
  readonly inputTokensDelta: number | null;
  readonly creditsDelta: number | null;
}
export interface EvalComparison {
  readonly schemaVersion: 2;
  readonly setId: string;
  readonly kind: EvalRoundKind;
  readonly baseline: EvalArm;
  readonly candidate: EvalArm;
  readonly rows: readonly EvalComparisonRow[];
  readonly fixed: readonly string[];
  readonly broke: readonly string[];
  readonly categories: readonly {
    readonly category: EvalCategory;
    readonly baseline: number | null;
    readonly candidate: number | null;
  }[];
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
/** Which tasks flipped between two arms' reports of the same set and round kind. */
export function compareArms(baseline: EvalReport, candidate: EvalReport): EvalComparison {
  if (
    baseline.setId !== candidate.setId ||
    baseline.kind !== candidate.kind ||
    baseline.k !== candidate.k
  )
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
      category: (a ?? b)?.category ?? null,
      baseline: sa,
      candidate: sb,
      flip,
      modelTurnsDelta: delta(
        mean(a, (m) => m.modelTurns),
        mean(b, (m) => m.modelTurns),
      ),
      inputTokensDelta: delta(
        mean(a, (m) => m.inputTokens),
        mean(b, (m) => m.inputTokens),
      ),
      creditsDelta: delta(
        mean(a, (m) => m.creditsDrawn),
        mean(b, (m) => m.creditsDrawn),
      ),
    };
  });
  return {
    schemaVersion: 2,
    setId: baseline.setId,
    kind: baseline.kind,
    baseline: baseline.arm,
    candidate: candidate.arm,
    rows,
    fixed: rows.filter((r) => r.flip === "fixed").map((r) => r.caseId),
    broke: rows.filter((r) => r.flip === "broke").map((r) => r.caseId),
    categories: evalCategories.map((category) => ({
      category,
      baseline: baseline.categories.find((c) => c.category === category)?.passK ?? null,
      candidate: candidate.categories.find((c) => c.category === category)?.passK ?? null,
    })),
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
  const passK = (v: number | null) => (v === null ? "-" : String(v));
  return [
    `# ${comparison.setId} (${comparison.kind}): ${comparison.baseline} against ${comparison.candidate}`,
    "",
    `- ${comparison.baseline}: ${total(comparison.totals.baseline)}`,
    `- ${comparison.candidate}: ${total(comparison.totals.candidate)}`,
    `- Fixed by ${comparison.candidate}: ${comparison.fixed.join(", ") || "none"}`,
    `- Broken by ${comparison.candidate}: ${comparison.broke.join(", ") || "none"}`,
    "",
    `| Category | ${comparison.baseline} pass^k | ${comparison.candidate} pass^k |`,
    "| --- | --- | --- |",
    ...comparison.categories.map(
      (c) => `| ${c.category} | ${passK(c.baseline)} | ${passK(c.candidate)} |`,
    ),
    "",
    `| Task | ${comparison.baseline} | ${comparison.candidate} | Flip | Model turns | Input tokens | Credits |`,
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.caseId} | ${r.baseline} | ${r.candidate} | ${r.flip} | ${signed(r.modelTurnsDelta)} | ${signed(r.inputTokensDelta)} | ${signed(r.creditsDelta)} |`,
    ),
    "",
  ].join("\n");
}
