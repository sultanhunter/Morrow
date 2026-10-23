// Goals inside a project (ADR-0033 items 1 to 4 and 9): each goal shows today's value,
// its target, how it is measured and a health word, all written by code per viewer. A
// goal opens as a drawer in its project; there is no Goals page. No agent decides a
// number shown here.
import { useState } from "react";
import { Button, Dialog } from "../components/controls";
import { projectsCopy } from "./copy";
import type { GoalDetailView } from "./model";
import { HealthWord, MemberName, StatusWord } from "./parts";

const p = projectsCopy.project;

export function GoalSummary({
  goal,
  onOpen,
}: {
  readonly goal: GoalDetailView;
  readonly onOpen: () => void;
}) {
  return (
    <li className="pj-goal">
      <div className="pj-goal-head">
        <h3 className="pj-goal-title">
          <button
            type="button"
            className="pj-link-button"
            onClick={onOpen}
            aria-label={p.openGoal(goal.title)}
          >
            <span dir="auto">{goal.title}</span>
          </button>
        </h3>
        <HealthWord health={goal.health} />
      </div>
      {goal.value ? (
        <p className="pj-goal-value" dir="auto">
          {goal.value}
        </p>
      ) : null}
      {[goal.target, goal.start].some(Boolean) ? (
        <p className="pj-meta" dir="auto">
          {[goal.target, goal.start].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      {goal.health.reason ? <p dir="auto">{goal.health.reason}</p> : null}
      {goal.source ? (
        <p className="pj-meta" dir="auto">
          {goal.source}
        </p>
      ) : null}
      {goal.rows.length ? (
        <ul className="pj-goal-rows">
          {goal.rows.map((row) => (
            <li key={row.label}>
              <span className="pj-goal-row-main">
                <strong dir="auto">{row.label}</strong>
                <span dir="auto">{row.value}</span>
                {row.note ? (
                  <span className="pj-meta" dir="auto">
                    {row.note}
                  </span>
                ) : null}
              </span>
              {row.health ? <HealthWord health={row.health} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function GoalList({ goals }: { readonly goals: readonly GoalDetailView[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const index = goals.findIndex((g) => g.key === open);
  const goal = index >= 0 ? goals[index]! : null;
  return (
    <>
      <ul className="pj-goals">
        {goals.map((g) => (
          <GoalSummary key={g.key} goal={g} onOpen={() => setOpen(g.key)} />
        ))}
      </ul>
      <Dialog
        open={goal !== null}
        title={goal ? goal.title : ""}
        onClose={() => setOpen(null)}
        footer={
          <Button data-initial-focus onClick={() => setOpen(null)}>
            {p.close}
          </Button>
        }
      >
        {goal ? <GoalDrawerBody goal={goal} position={index + 1} total={goals.length} /> : null}
      </Dialog>
    </>
  );
}

function GoalDrawerBody({
  goal,
  position,
  total,
}: {
  readonly goal: GoalDetailView;
  readonly position: number;
  readonly total: number;
}) {
  return (
    <div className="pj-drawer">
      <p className="pj-meta">{p.goalOf(position, total)}</p>
      <p>
        <HealthWord health={goal.health} />{" "}
        {goal.health.reason ? <span dir="auto">{goal.health.reason}</span> : null}
      </p>
      <h3>{p.howMeasured}</h3>
      {goal.how ? <p dir="auto">{goal.how}</p> : null}
      {goal.value ? (
        <p className="pj-goal-value" dir="auto">
          {goal.value}
        </p>
      ) : null}
      {[goal.target, goal.start].some(Boolean) ? (
        <p className="pj-meta" dir="auto">
          {[goal.target, goal.start].filter(Boolean).join(" · ")}
        </p>
      ) : null}
      {goal.checks.length ? (
        <>
          <h3>{p.whatsChecked}</h3>
          <ul className="pj-checks">
            {goal.checks.map((check) => (
              <li key={check.label} className={check.done ? "is-done" : ""}>
                <span dir="auto">{check.label}</span>
                <span className="pj-meta">
                  {check.done ? p.checkDone : p.checkNotYet}
                  {check.note ? ` · ${check.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {goal.questions.length ? (
        <>
          <h3>{projectsCopy.project.questions}</h3>
          <ol className="pj-card-list">
            {goal.questions.map((q) => (
              <li key={q} dir="auto">
                {q}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {goal.steps.length ? (
        <>
          <h3>{p.stepsThatMove}</h3>
          <ul className="pj-card-list">
            {goal.steps.map((step) => (
              <li key={step.label} className="pj-step-link">
                <span dir="auto">{step.label}</span>
                <MemberName member={step.owner} />
                <StatusWord status={step.status} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
