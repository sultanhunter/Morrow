// The Repeating tab of the Projects page: repeating tasks Morrow drafted that wait for a
// person to turn them on, every repeating task and every alert, each with its project.
// Turning one on needs `workspace.routine.activate` and its review gate (ADR-0034 owner
// question 4), which a later PR builds: until then this tab only reads.
import type { Id } from "../model";
import { StateView } from "../components/feedback";
import { projectsCopy } from "./copy";
import type { RepeatingView } from "./model";
import { CellLabel, MemberName, Section, StatusWord, ActionLink } from "./parts";

const c = projectsCopy.repeating;

export function RepeatingTab({ ws, view }: { readonly ws: Id; readonly view: RepeatingView }) {
  return (
    <div className="pj-stack">
      {view.waiting.length ? (
        <Section id="pj-waiting-title" title={c.waitingTitle}>
          <ul className="pj-simple-list">
            {view.waiting.map((draft) => (
              <li key={draft.messageId} className="pj-waiting">
                <h3 dir="auto">{draft.title}</h3>
                <p className="pj-meta">
                  <MemberName member={draft.owner} /> · {c.goesIn(draft.projectTitle)}
                </p>
                <dl className="pj-facts">
                  <dt>{c.when}</dt>
                  <dd dir="auto">{draft.when}</dd>
                  <dt>{c.youGet}</dt>
                  <dd dir="auto">{draft.youGet}</dd>
                  {draft.credits ? (
                    <>
                      <dt>{c.credits}</dt>
                      <dd dir="auto">{draft.credits}</dd>
                    </>
                  ) : null}
                </dl>
                <p dir="auto" className="pj-meta">
                  {draft.drafted}
                </p>
              </li>
            ))}
          </ul>
          <p className="muted">{c.turnOnLater}</p>
        </Section>
      ) : null}

      <Section id="pj-repeating-title" title={c.title}>
        <p className="muted">{c.intro}</p>
        {view.repeating.length ? (
          <div className="pj-rows pj-rows-repeating">
            <div className="pj-row pj-row-head" aria-hidden="true">
              <span>{c.columns.task}</span>
              <span>{c.columns.goesIn}</span>
              <span>{c.columns.when}</span>
              <span>{c.columns.next}</span>
              <span>{c.columns.credits}</span>
              <span>{c.columns.status}</span>
            </div>
            <ul className="pj-row-list">
              {view.repeating.map((row) => (
                <li key={row.id} className="pj-row">
                  <div className="pj-cell pj-cell-main">
                    <CellLabel>{c.columns.task}</CellLabel>
                    <span dir="auto" className="pj-row-title">
                      {row.title}
                    </span>
                    <span className="pj-meta">
                      <MemberName member={row.owner} />
                    </span>
                    {row.note ? (
                      <span dir="auto" className="pj-meta">
                        {row.note}
                      </span>
                    ) : null}
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.goesIn}</CellLabel>
                    <ActionLink
                      route="project"
                      params={{ workspaceId: ws, projectId: row.projectId }}
                    >
                      <span dir="auto">{row.projectTitle}</span>
                    </ActionLink>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.when}</CellLabel>
                    <span dir="auto">{row.schedule}</span>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.next}</CellLabel>
                    <span dir="auto">{row.next ?? "—"}</span>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.credits}</CellLabel>
                    <span dir="auto">{row.credits ?? "—"}</span>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.status}</CellLabel>
                    <StatusWord status={row.status} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <StateView kind="empty" compact message={c.empty} />
        )}
      </Section>

      <Section id="pj-alerts-title" title={c.alertsTitle}>
        <p className="muted">{c.alertsIntro}</p>
        {view.alerts.length ? (
          <div className="pj-rows pj-rows-alerts">
            <div className="pj-row pj-row-head" aria-hidden="true">
              <span>{c.columns.alert}</span>
              <span>{c.columns.goesIn}</span>
              <span>{c.columns.watches}</span>
              <span>{c.columns.lastTold}</span>
              <span>{c.columns.status}</span>
            </div>
            <ul className="pj-row-list">
              {view.alerts.map((row) => (
                <li key={row.id} className="pj-row">
                  <div className="pj-cell pj-cell-main">
                    <CellLabel>{c.columns.alert}</CellLabel>
                    <span dir="auto" className="pj-row-title">
                      {row.title}
                    </span>
                    <span className="pj-meta">
                      <MemberName member={row.owner} />
                    </span>
                    {row.note ? (
                      <span dir="auto" className="pj-meta">
                        {row.note}
                      </span>
                    ) : null}
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.goesIn}</CellLabel>
                    <ActionLink
                      route="project"
                      params={{ workspaceId: ws, projectId: row.projectId }}
                    >
                      <span dir="auto">{row.projectTitle}</span>
                    </ActionLink>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.watches}</CellLabel>
                    <span dir="auto">{row.watches}</span>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.lastTold}</CellLabel>
                    <span dir="auto">{row.lastTold ?? c.notYet}</span>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.status}</CellLabel>
                    <StatusWord status={row.status} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <StateView kind="empty" compact message={c.alertsEmpty} />
        )}
      </Section>
      <p className="muted">{c.footnote}</p>
    </div>
  );
}
