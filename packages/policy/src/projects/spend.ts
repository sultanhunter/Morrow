// Spend per project and helper (ADR-0033 item 11; owner question 2): display only, with no
// project limit. Settled credits show by project and helper: a run counts toward its task's
// goal record, a Coordinator run in a project conversation (ADR-0034 item 8) toward that
// project, and an Ask run toward "Ask Morrow". Everyone who can view a project sees its
// credits. Nothing here reserves, holds or refuses: budgets stay ADR-0026's, in code.

export type SpendHelper =
  | { readonly kind: "agent"; readonly installationId: string }
  | { readonly kind: "coordinator" }
  | { readonly kind: "specialist" };
export type SpendAttribution =
  | { readonly kind: "task"; readonly goalId: string }
  | { readonly kind: "project_conversation"; readonly projectId: string }
  | { readonly kind: "ask" };
export interface SettledRun {
  readonly runId: string;
  /** Settled credits: a non-negative integer (never a hold or an estimate). */
  readonly credits: number;
  readonly helper: SpendHelper;
  readonly attribution: SpendAttribution;
}
export interface ProjectSpend {
  readonly target:
    | { readonly kind: "project"; readonly projectId: string }
    | { readonly kind: "ask_morrow" };
  readonly credits: number;
  readonly byHelper: readonly { readonly helper: string; readonly credits: number }[];
}
const helperKey = (h: SpendHelper) => (h.kind === "agent" ? `agent:${h.installationId}` : h.kind);

/**
 * Totals settled credits by project (each goal record's one project) and by helper. A run
 * whose goal record has no project counts toward no project (it is not dropped silently:
 * it is returned in `unattributed`). Order: projects by id, then Ask Morrow; helpers by key.
 */
export function spendByProject(
  runs: readonly SettledRun[],
  projectOfGoal: ReadonlyMap<string, string>,
): { readonly projects: readonly ProjectSpend[]; readonly unattributed: readonly string[] } {
  const totals = new Map<string, Map<string, number>>();
  const unattributed: string[] = [];
  for (const run of runs) {
    if (!Number.isSafeInteger(run.credits) || run.credits < 0)
      throw new RangeError("SPEND_INVALID");
    let target: string | null;
    if (run.attribution.kind === "ask") target = "ask_morrow";
    else if (run.attribution.kind === "project_conversation")
      target = `project:${run.attribution.projectId}`;
    else {
      const project = projectOfGoal.get(run.attribution.goalId);
      target = project === undefined ? null : `project:${project}`;
    }
    if (target === null) {
      unattributed.push(run.runId);
      continue;
    }
    const helpers = totals.get(target) ?? new Map<string, number>();
    helpers.set(helperKey(run.helper), (helpers.get(helperKey(run.helper)) ?? 0) + run.credits);
    totals.set(target, helpers);
  }
  const projects: ProjectSpend[] = [...totals.entries()]
    .sort(([a], [b]) =>
      a === "ask_morrow" ? 1 : b === "ask_morrow" ? -1 : a < b ? -1 : a > b ? 1 : 0,
    )
    .map(([target, helpers]) => ({
      target:
        target === "ask_morrow"
          ? { kind: "ask_morrow" as const }
          : { kind: "project" as const, projectId: target.slice("project:".length) },
      credits: [...helpers.values()].reduce((a, b) => a + b, 0),
      byHelper: [...helpers.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([helper, credits]) => ({ helper, credits })),
    }));
  return { projects, unattributed };
}
