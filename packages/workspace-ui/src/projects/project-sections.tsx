// The sections of a project page: the Overview of a dated project (Since you were last
// here, Goals, Plan, Latest update, Credits) and of an Everyday work area (its goal,
// alerts, repeating tasks, who works here, spend), and the Tasks, Brief, Files and
// Activity tabs. Tasks come from the work API by the project's goal record, the backend
// that exists today.
import { useCallback } from "react";
import type { Id, TaskView } from "../model";
import { useServices } from "../services";
import { Button, RouteLink } from "../components/controls";
import { PersonLabel, RecordText, StatusTag } from "../components/display";
import { StateView, outcomeState } from "../components/feedback";
import { copy } from "../copy";
import { usePaged } from "../screens/work";
import { projectsCopy } from "./copy";
import { GoalList } from "./goals";
import type { ProjectDetailView } from "./model";
import { HealthWord, MemberName, Section, StatusWord } from "./parts";
import { UpdateCard } from "./project-conversation";

const p = projectsCopy.project;

function SinceLastVisit({ project }: { readonly project: ProjectDetailView }) {
  const since = project.sinceLastVisit;
  if (!since || !since.items.length) return null;
  return (
    <Section id="pj-since-title" title={p.sinceTitle}>
      <p className="pj-meta" dir="auto">
        {p.sinceVisit(since.lastVisit)}
      </p>
      <ul className="pj-simple-list">
        {since.items.map((item) => (
          <li key={item.title} className="pj-simple-row">
            <span className="pj-simple-main">
              <strong dir="auto">{item.title}</strong>
              {item.detail ? (
                <span dir="auto" className="pj-meta">
                  {item.detail}
                </span>
              ) : null}
              {item.at ? <span className="pj-meta">{item.at}</span> : null}
            </span>
            {item.health ? <HealthWord health={item.health} /> : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function PlanSection({ ws, project }: { readonly ws: Id; readonly project: ProjectDetailView }) {
  if (!project.plan.length) return null;
  return (
    <Section id="pj-plan-title" title={p.planTitle}>
      <ol className="pj-plan">
        {project.plan.map((step) => (
          <li key={step.index} className={`pj-step pj-step-${step.status}`}>
            <span className="pj-step-number">{p.step(step.index)}</span>
            <div className="pj-step-body">
              <h3 className="pj-step-title">
                {step.taskId ? (
                  <RouteLink
                    route="task"
                    params={{ workspaceId: ws, taskId: step.taskId }}
                    className="pj-row-link"
                  >
                    <span dir="auto">{step.title}</span>
                  </RouteLink>
                ) : (
                  <span dir="auto">{step.title}</span>
                )}
                {step.repeats ? <span className="pj-pill">{p.repeats}</span> : null}
              </h3>
              <p className="pj-meta">
                <MemberName member={step.owner} />
                {step.detail ? (
                  <>
                    {" · "}
                    <span dir="auto">{step.detail}</span>
                  </>
                ) : null}
              </p>
            </div>
            <StatusWord status={step.status} />
          </li>
        ))}
      </ol>
      <p className="pj-meta">{p.automaticUpdate}</p>
    </Section>
  );
}

function CreditsSection({ ws, project }: { readonly ws: Id; readonly project: ProjectDetailView }) {
  const credits = project.credits;
  if (!credits) return null;
  return (
    <Section
      id="pj-credits-section-title"
      title={project.kind === "area" ? p.spendTitle : p.creditsTitle}
      action={
        <RouteLink
          route="settings_section"
          params={{ workspaceId: ws, section: "billing" }}
          className="text-link"
        >
          {p.seePlan}
        </RouteLink>
      }
    >
      <p>{p.creditsUsed(credits.used, credits.planned)}</p>
      {credits.byHelper.length ? (
        <ul className="pj-simple-list">
          {credits.byHelper.map((row) => (
            <li key={row.name} className="pj-simple-row">
              <span dir="auto">{row.name}</span>
              <span dir="auto" className="pj-meta">
                {row.line}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {credits.balance ? (
        <p className="pj-meta" dir="auto">
          {credits.balance}
        </p>
      ) : null}
      {credits.note ? (
        <p className="pj-meta" dir="auto">
          {credits.note}
        </p>
      ) : null}
    </Section>
  );
}

function RepeatingSection({ project }: { readonly project: ProjectDetailView }) {
  return (
    <Section id="pj-area-repeating-title" title={p.repeatingTitle}>
      {project.repeating.length ? (
        <ul className="pj-simple-list">
          {project.repeating.map((row) => (
            <li key={row.id} className="pj-simple-row">
              <span className="pj-simple-main">
                <strong dir="auto">{row.title}</strong>
                <span className="pj-meta">
                  <span dir="auto">{row.schedule}</span> · <MemberName member={row.owner} />
                </span>
                {row.next ? (
                  <span className="pj-meta" dir="auto">
                    {row.next}
                  </span>
                ) : null}
                {row.note ? (
                  <span className="pj-meta" dir="auto">
                    {row.note}
                  </span>
                ) : null}
              </span>
              <StatusWord status={row.status} />
            </li>
          ))}
        </ul>
      ) : (
        <StateView kind="empty" compact message={p.repeatingEmpty} />
      )}
    </Section>
  );
}

function AlertsSection({ project }: { readonly project: ProjectDetailView }) {
  return (
    <Section id="pj-area-alerts-title" title={p.alertsTitle}>
      {project.alerts.length ? (
        <ul className="pj-simple-list">
          {project.alerts.map((row) => (
            <li key={row.id} className="pj-simple-row">
              <span className="pj-simple-main">
                <strong dir="auto">{row.title}</strong>
                {row.note ? (
                  <span className="pj-meta" dir="auto">
                    {row.note}
                  </span>
                ) : null}
                {row.lastTold ? (
                  <span className="pj-meta" dir="auto">
                    {row.lastTold}
                  </span>
                ) : null}
              </span>
              <StatusWord status={row.status} />
            </li>
          ))}
        </ul>
      ) : (
        <StateView kind="empty" compact message={p.alertsEmpty} />
      )}
    </Section>
  );
}

function WhoSection({ project }: { readonly project: ProjectDetailView }) {
  if (!project.members.length) return null;
  return (
    <Section id="pj-who-title" title={p.whoTitle}>
      <ul className="pj-simple-list">
        {project.members.map((row) => (
          <li key={row.member.kind + row.member.name} className="pj-simple-row">
            <span className="pj-simple-main">
              <MemberName member={row.member} />
              {row.member.role ? (
                <span className="pj-meta" dir="auto">
                  {row.member.role}
                </span>
              ) : null}
              {row.note ? (
                <span className="pj-meta" dir="auto">
                  {row.note}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function ProjectOverview({
  ws,
  project,
}: {
  readonly ws: Id;
  readonly project: ProjectDetailView;
}) {
  if (project.kind === "area" || project.kind === "quick_tasks")
    return (
      <div className="pj-stack">
        {project.goals.length ? (
          <Section id="pj-goals-title" title={p.areaGoalTitle}>
            <GoalList goals={project.goals} />
          </Section>
        ) : null}
        {project.kind === "area" ? <AlertsSection project={project} /> : null}
        {project.kind === "area" ? <RepeatingSection project={project} /> : null}
        <WhoSection project={project} />
        <CreditsSection ws={ws} project={project} />
      </div>
    );
  return (
    <div className="pj-stack">
      <SinceLastVisit project={project} />
      {project.goals.length ? (
        <Section id="pj-goals-title" title={p.goalsTitle}>
          <GoalList goals={project.goals} />
        </Section>
      ) : null}
      <PlanSection ws={ws} project={project} />
      {project.latestUpdate || project.updateNote ? (
        <Section id="pj-update-title" title={p.updateTitle}>
          {project.latestUpdate ? (
            <UpdateCard update={project.latestUpdate} />
          ) : (
            <p dir="auto">{project.updateNote}</p>
          )}
        </Section>
      ) : null}
      <CreditsSection ws={ws} project={project} />
    </div>
  );
}

/** The project's tasks, read from the work API by its goal record (25 per page). */
export function ProjectTasks({
  ws,
  project,
}: {
  readonly ws: Id;
  readonly project: ProjectDetailView;
}) {
  const services = useServices();
  const loadPage = useCallback(
    (after: string | null) => services.port.work.listTasks(ws, project.goalId, after),
    [services, ws, project.goalId],
  );
  const paged = usePaged<TaskView>(`${ws}|tasks|${project.goalId}|project`, loadPage);
  return (
    <Section id="pj-tasks-title" title={p.tasksTitle}>
      {paged.first.kind !== "ok" ? (
        outcomeState(paged.first, paged.reload, { compact: true })
      ) : paged.items.length ? (
        <>
          <ul className="item-list">
            {paged.items.map((task) => (
              <li key={task.id} className="item">
                <RouteLink
                  route="task"
                  params={{ workspaceId: ws, taskId: task.id }}
                  className="item-link"
                >
                  <RecordText>{task.objective}</RecordText>
                </RouteLink>
                <span className="pj-meta">
                  <PersonLabel person={task.owner} />
                </span>
                <StatusTag family="task" status={task.status} />
              </li>
            ))}
          </ul>
          {paged.next !== null ? (
            <Button onClick={paged.loadMore} disabled={paged.loadingMore}>
              {paged.loadingMore ? copy.states.loading : copy.work.loadMore}
            </Button>
          ) : null}
        </>
      ) : (
        <StateView kind="empty" compact message={p.tasksEmpty} />
      )}
    </Section>
  );
}

export function ProjectBrief({ project }: { readonly project: ProjectDetailView }) {
  const brief = project.brief;
  if (!brief)
    return (
      <Section id="pj-brief-title" title={p.briefTitle}>
        <StateView kind="empty" compact message={p.noBrief} />
      </Section>
    );
  return (
    <Section id="pj-brief-title" title={p.briefTitle}>
      <p className="pj-meta" dir="auto">
        {brief.byline}
      </p>
      {brief.why ? (
        <>
          <h3>{p.why}</h3>
          <p dir="auto">{brief.why}</p>
        </>
      ) : null}
      {brief.doneWhen ? (
        <>
          <h3>{p.doneWhen}</h3>
          <p dir="auto">{brief.doneWhen}</p>
        </>
      ) : null}
      {brief.honesty ? <p dir="auto">{brief.honesty}</p> : null}
      {brief.questions.length ? (
        <>
          <h3>{p.questions}</h3>
          <ol className="pj-card-list">
            {brief.questions.map((q) => (
              <li key={q} dir="auto">
                {q}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {brief.cannotDo.length ? (
        <>
          <h3>{p.cannotDo}</h3>
          <ul className="pj-card-list">
            {brief.cannotDo.map((line) => (
              <li key={line} dir="auto">
                {line}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {brief.whoSees ? (
        <>
          <h3>{p.whoSees}</h3>
          <p dir="auto">{brief.whoSees}</p>
        </>
      ) : null}
    </Section>
  );
}

export function ProjectFiles({ project }: { readonly project: ProjectDetailView }) {
  return (
    <Section id="pj-files-title" title={p.filesTitle}>
      {project.files.length ? (
        <>
          <ul className="pj-simple-list">
            {project.files.map((file) => (
              <li key={file.id} className="pj-simple-row">
                <span className="pj-simple-main">
                  <strong dir="auto">{file.title}</strong>
                  <span className="pj-meta" dir="auto">
                    {file.from}
                  </span>
                  {file.note ? (
                    <span className="pj-meta" dir="auto">
                      {file.note}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="pj-meta">{p.filesNote}</p>
        </>
      ) : (
        <StateView kind="empty" compact message={p.filesEmpty} />
      )}
    </Section>
  );
}

export function ProjectActivity({ project }: { readonly project: ProjectDetailView }) {
  return (
    <Section id="pj-activity-title" title={p.activityTitle}>
      {project.activity.length ? (
        <ol className="pj-activity">
          {project.activity.map((row, index) => (
            <li key={`${index}-${row.at}`}>
              <span className="pj-activity-at">{row.at}</span>
              <span dir="auto">{row.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <StateView kind="empty" compact message={p.activityEmpty} />
      )}
    </Section>
  );
}
