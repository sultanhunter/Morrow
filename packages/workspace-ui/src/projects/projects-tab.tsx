// The Projects tab of the Projects page: credits this month, Projects with an end date
// (by end date), Everyday work (one area per added agent, then Quick tasks) and Finished.
// Rows stack below 760 px; their cell labels are always read by screen readers.
import type { Id } from "../model";
import { StateView } from "../components/feedback";
import { projectsCopy } from "./copy";
import { byEndDate, formatDay, formatShortDay } from "./format";
import type { ProjectsOverviewView } from "./model";
import { CellLabel, HealthWord, MemberName, Section, memberList, InlineLink } from "./parts";

const c = projectsCopy.page;

export function ProjectsTab({
  ws,
  overview,
}: {
  readonly ws: Id;
  readonly overview: ProjectsOverviewView;
}) {
  const credits = overview.credits;
  return (
    <div className="pj-stack">
      {credits ? (
        <section className="pj-card pj-credits" aria-labelledby="pj-credits-title">
          <h2 id="pj-credits-title">{c.creditsTitle}</h2>
          <p>
            {c.credits(
              credits.used,
              credits.allowance,
              credits.left,
              formatShortDay(credits.renewsOn),
            )}{" "}
            <InlineLink route="settings_section" params={{ workspaceId: ws, section: "billing" }}>
              {c.seePlan}
            </InlineLink>
          </p>
          <p className="muted">{c.creditsNote(credits.askUsed)}</p>
        </section>
      ) : null}

      <Section id="pj-dated-title" title={c.datedTitle}>
        <p className="muted">{c.datedIntro}</p>
        {overview.dated.length ? (
          <div className="pj-rows pj-rows-dated">
            <div className="pj-row pj-row-head" aria-hidden="true">
              <span>{c.columns.project}</span>
              <span>{c.columns.mainGoal}</span>
              <span>{c.columns.health}</span>
              <span>{c.columns.members}</span>
              <span>{c.columns.credits}</span>
            </div>
            <ul className="pj-row-list">
              {byEndDate(overview.dated).map((row) => (
                <li key={row.projectId} className="pj-row">
                  <div className="pj-cell pj-cell-main">
                    <CellLabel>{c.columns.project}</CellLabel>
                    <InlineLink
                      strong
                      route="project"
                      params={{ workspaceId: ws, projectId: row.projectId }}
                    >
                      <span dir="auto" className="pj-row-title">
                        {row.title}
                      </span>
                    </InlineLink>
                    <span className="pj-meta">
                      {c.ends(formatDay(row.endsOn))}
                      {row.note ? (
                        <>
                          {" · "}
                          <span dir="auto">{row.note}</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.mainGoal}</CellLabel>
                    {row.mainGoal ? (
                      <>
                        <span dir="auto">{row.mainGoal.title}</span>
                        {row.mainGoal.value ? (
                          <span dir="auto" className="pj-meta">
                            {row.mainGoal.value}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="pj-meta">{c.noGoal}</span>
                    )}
                    {row.moreGoals.map((line) => (
                      <span key={line} dir="auto" className="pj-meta">
                        {c.moreGoal(line)}
                      </span>
                    ))}
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.health}</CellLabel>
                    <HealthWord health={row.health} />
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.members}</CellLabel>
                    <span dir="auto" className="pj-meta">
                      {memberList(row.members)}
                    </span>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.credits}</CellLabel>
                    <span>{c.creditsUsed(row.credits.used)}</span>
                    {row.credits.planned ? (
                      <span dir="auto" className="pj-meta">
                        {row.credits.planned}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <StateView kind="empty" compact message={c.datedEmpty} />
        )}
      </Section>

      <Section id="pj-everyday-title" title={c.everydayTitle}>
        <p className="muted">{c.everydayIntro}</p>
        {overview.areas.length || overview.quickTasks ? (
          <div className="pj-rows pj-rows-areas">
            <div className="pj-row pj-row-head" aria-hidden="true">
              <span>{c.columns.area}</span>
              <span>{c.columns.goal}</span>
              <span>{c.columns.health}</span>
              <span>{c.columns.repeating}</span>
              <span>{c.columns.credits}</span>
            </div>
            <ul className="pj-row-list">
              {overview.areas.map((area) => (
                <li key={area.projectId} className="pj-row">
                  <div className="pj-cell pj-cell-main">
                    <CellLabel>{c.columns.area}</CellLabel>
                    <InlineLink
                      strong
                      route="project"
                      params={{ workspaceId: ws, projectId: area.projectId }}
                    >
                      <span dir="auto" className="pj-row-title">
                        {area.label}
                      </span>
                    </InlineLink>
                    <span className="pj-meta">
                      {c.withAgent} <MemberName member={area.agent} />
                      {area.note ? (
                        <>
                          {" · "}
                          <span dir="auto">{area.note}</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.goal}</CellLabel>
                    {area.goal ? (
                      <>
                        <span dir="auto">{area.goal.title}</span>
                        {area.goal.value ? (
                          <span dir="auto" className="pj-meta">
                            {area.goal.value}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="pj-meta">{c.noGoal}</span>
                    )}
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.health}</CellLabel>
                    <HealthWord health={area.health} />
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.repeating}</CellLabel>
                    <span>{c.repeatingCount(area.repeating, area.alerts)}</span>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.credits}</CellLabel>
                    <span>{c.creditsMonth(area.creditsThisMonth)}</span>
                  </div>
                </li>
              ))}
              {overview.quickTasks ? (
                <li className="pj-row">
                  <div className="pj-cell pj-cell-main">
                    <CellLabel>{c.columns.area}</CellLabel>
                    <InlineLink
                      strong
                      route="project"
                      params={{ workspaceId: ws, projectId: overview.quickTasks.projectId }}
                    >
                      <span className="pj-row-title">{c.quickTasks}</span>
                    </InlineLink>
                    <span className="pj-meta">{c.quickTasksNote}</span>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.goal}</CellLabel>
                    <span className="pj-meta">{c.noGoal}</span>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.health}</CellLabel>
                    <span>{c.openCount(overview.quickTasks.open)}</span>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.repeating}</CellLabel>
                    <span>{c.repeatingCount(0, 0)}</span>
                  </div>
                  <div className="pj-cell">
                    <CellLabel>{c.columns.credits}</CellLabel>
                    <span>{c.creditsMonth(overview.quickTasks.creditsThisMonth)}</span>
                  </div>
                </li>
              ) : null}
            </ul>
          </div>
        ) : (
          <StateView kind="empty" compact message={c.everydayEmpty} />
        )}
      </Section>

      <Section id="pj-finished-title" title={c.finishedTitle}>
        {overview.finished.length ? (
          <ul className="pj-simple-list">
            {overview.finished.map((row) => (
              <li key={row.projectId} className="pj-simple-row">
                <span className="pj-simple-main">
                  <InlineLink
                    strong
                    route="project"
                    params={{ workspaceId: ws, projectId: row.projectId }}
                  >
                    <span dir="auto" className="pj-row-title">
                      {row.title}
                    </span>
                  </InlineLink>
                  <span className="pj-meta">
                    {c.finishedLine(formatShortDay(row.finishedOn), row.goalsMet, row.goalsTotal)}
                  </span>
                </span>
                <HealthWord health={row.health} />
              </li>
            ))}
          </ul>
        ) : (
          <StateView kind="empty" compact message={c.finishedEmpty} />
        )}
      </Section>
    </div>
  );
}
