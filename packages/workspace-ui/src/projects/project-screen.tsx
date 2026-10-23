// A project, an Everyday work area or Quick tasks (route `project`; the UX recommendation
// §3.2): "How is this going, and what's next?" The header carries the health word, the
// scope line and the person-only actions (Plan next steps, Stop steps; at the end date
// Finish or Extend); tabs Overview, Tasks, Brief, Files and Activity; the conversation sits
// beside them. The server's `actions` decide which buttons show; it checks again. What an
// action did is said in the page's own status region, and focus moves to the title, since
// the button that opened the action is often gone once the page reads the project again.
import { useEffect, useRef, useState } from "react";
import type { Id, WorkspaceView } from "../model";
import { useRead, useServices } from "../services";
import { Button, RouteLink } from "../components/controls";
import { Tabs } from "../components/shell";
import { StatusRegion, outcomeState } from "../components/feedback";
import { projectsCopy } from "./copy";
import type { ProjectDetailView } from "./model";
import { TellMorrowDialog } from "./new-project";
import { HealthWord } from "./parts";
import {
  ExtendDialog,
  FinishDialog,
  PlanNextStepsButton,
  StopStepsDialog,
} from "./project-actions";
import { ProjectConversation } from "./project-conversation";
import {
  ProjectActivity,
  ProjectBrief,
  ProjectFiles,
  ProjectOverview,
  ProjectTasks,
} from "./project-sections";

type Tab = "overview" | "tasks" | "brief" | "files" | "activity";
const p = projectsCopy.project;

function tabsOf(
  project: ProjectDetailView,
): readonly { readonly id: Tab; readonly label: string }[] {
  return [
    { id: "overview", label: p.tabOverview },
    { id: "tasks", label: p.tabTasks },
    ...(project.kind === "dated" ? [{ id: "brief" as const, label: p.tabBrief }] : []),
    {
      id: "files",
      label: project.files.length ? `${p.tabFiles} ${project.files.length}` : p.tabFiles,
    },
    { id: "activity", label: p.tabActivity },
  ];
}

function EndedBanner({
  project,
  onFinish,
  onExtend,
}: {
  readonly project: ProjectDetailView;
  readonly onFinish: (() => void) | null;
  readonly onExtend: (() => void) | null;
}) {
  const results = project.results;
  return (
    <section className="pj-card pj-ended" aria-labelledby="pj-ended-title">
      <h2 id="pj-ended-title" dir="auto">
        {p.endedTitle(project.title)}
      </h2>
      <p>{p.endedIntro}</p>
      {results ? (
        <div className="pj-results">
          <h3>{p.resultsTitle}</h3>
          <p className="pj-meta">{p.resultsBy}</p>
          <ul className="pj-simple-list">
            {results.rows.map((row) => (
              <li key={row.goal} className="pj-result">
                <span className="pj-simple-main">
                  <strong dir="auto">{row.goal}</strong>
                  <span className="pj-meta" dir="auto">
                    {row.measure}
                  </span>
                </span>
                <dl className="pj-result-values">
                  <div>
                    <dt>{p.resultColumns.start}</dt>
                    <dd dir="auto">{row.start}</dd>
                  </div>
                  <div>
                    <dt>{p.resultColumns.now}</dt>
                    <dd dir="auto">{row.now}</dd>
                  </div>
                  <div>
                    <dt>{p.resultColumns.target}</dt>
                    <dd dir="auto">{row.target}</dd>
                  </div>
                </dl>
                <HealthWord health={row.health} />
              </li>
            ))}
          </ul>
          {results.note ? (
            <p className="pj-meta" dir="auto">
              {results.note}
            </p>
          ) : null}
          {results.done ? (
            <p dir="auto">
              <strong>{p.whatWasDone}</strong> {results.done}
            </p>
          ) : null}
          {results.credits ? (
            <p dir="auto">
              <strong>{p.creditsLabel}</strong> {results.credits}
            </p>
          ) : null}
        </div>
      ) : null}
      {onFinish || onExtend ? (
        <div className="pj-card-actions">
          {onExtend ? <Button onClick={onExtend}>{p.extend}</Button> : null}
          {onFinish ? (
            <Button variant="primary" onClick={onFinish}>
              {p.finish}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ProjectScreen({
  workspace,
  projectId,
}: {
  readonly workspace: WorkspaceView;
  readonly projectId: Id;
}) {
  const services = useServices();
  const ws = workspace.id;
  const [tab, setTab] = useState<Tab>("overview");
  const [dialog, setDialog] = useState<"none" | "stop" | "finish" | "extend" | "ask">("none");
  const [conversationVersion, setConversationVersion] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const [focusTitle, setFocusTitle] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  // After the dialog has closed (its own effect runs first and returns focus to its
  // opener), focus moves to the title, which stays while the page reads again.
  useEffect(() => {
    if (focusTitle > 0) title.current?.focus();
  }, [focusTitle]);
  const [project, reload] = useRead(`${ws}|projects.get|${projectId}`, () =>
    services.port.projects.get(ws, projectId),
  );
  // Ask Morrow privately: a new private Ask (plans.ask), where the overview allows it.
  const askComposed = services.composed["plans.ask"];
  const [overview] = useRead(askComposed ? `${ws}|projects.overview` : null, () =>
    services.port.projects.overview(ws),
  );
  const canAsk = askComposed && overview.kind === "ok" && overview.value.actions.ask;
  if (project.kind !== "ok")
    return (
      <div className="page pj-page">
        <nav className="breadcrumb" aria-label={p.breadcrumb}>
          <RouteLink route="work" params={{ workspaceId: ws }}>
            {p.breadcrumb}
          </RouteLink>
        </nav>
        {outcomeState(project, reload)}
      </div>
    );
  const view = project.value;
  const composed = services.composed;
  const can = {
    plan: view.actions.planNextSteps && composed["projects.planNextSteps"],
    stop: view.actions.stopSteps && composed["projects.stopSteps"],
    finish: view.actions.finish && composed["projects.finishDocument"] && composed["plans.start"],
    extend: view.actions.extend && view.extendTo !== null && composed["projects.extend"],
  };
  const ended = view.state === "ended";
  const tabs = tabsOf(view);
  const selected = tabs.some((t) => t.id === tab) ? tab : "overview";
  const changed = () => {
    reload();
    setConversationVersion((n) => n + 1);
  };
  const open = (which: "stop" | "finish" | "extend" | "ask") => {
    setDone(null);
    setDialog(which);
  };
  const close = () => setDialog("none");
  const acted = (message: string) => {
    setDone(message);
    setFocusTitle((n) => n + 1);
    changed();
  };
  return (
    <div className="page pj-page">
      <nav className="breadcrumb" aria-label={p.breadcrumb}>
        <RouteLink route="work" params={{ workspaceId: ws }}>
          {p.breadcrumb}
        </RouteLink>
        <span aria-hidden="true"> / </span>
        <span dir="auto">{view.kind === "dated" ? view.title : p.everyday}</span>
      </nav>
      {view.areas.length && view.kind !== "dated" ? (
        <nav className="pj-area-nav" aria-label={p.areasLabel}>
          <ul>
            {view.areas.map((area) => (
              <li key={area.projectId}>
                <RouteLink
                  route="project"
                  params={{ workspaceId: ws, projectId: area.projectId }}
                  current={area.projectId === view.projectId}
                  className="pj-area-link"
                >
                  <span dir="auto">{area.label}</span>
                </RouteLink>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <header className="page-header pj-header">
        <div className="pj-title-block">
          <h1 className="pj-title" ref={title} tabIndex={-1}>
            <span dir="auto">{view.title}</span> <HealthWord health={view.health} />
          </h1>
          {view.scope.length ? (
            <p className="pj-scope" dir="auto">
              {view.scope.join(" · ")}
            </p>
          ) : null}
        </div>
        <div className="pj-header-actions">
          {can.stop ? <Button onClick={() => open("stop")}>{p.stopSteps}</Button> : null}
          {can.plan && !ended ? (
            <PlanNextStepsButton
              ws={ws}
              project={view}
              onAsked={() => setConversationVersion((n) => n + 1)}
              onStale={changed}
            />
          ) : null}
        </div>
      </header>
      <StatusRegion message={done} />
      {view.stopped ? (
        <div role="status" className="notice notice-warning">
          <p dir="auto">{view.stopped}</p>
        </div>
      ) : null}
      {ended ? (
        <EndedBanner
          project={view}
          onFinish={can.finish ? () => open("finish") : null}
          onExtend={can.extend ? () => open("extend") : null}
        />
      ) : null}
      <div className="pj-layout">
        <div className="pj-main">
          <Tabs
            label={p.tabsLabel}
            tabs={tabs}
            selected={selected}
            onSelect={(id) => setTab(tabs.find((t) => t.id === id)?.id ?? "overview")}
            idPrefix="project"
          />
          {tabs.map((t) => (
            <div
              key={t.id}
              id={`project-panel-${t.id}`}
              role="tabpanel"
              aria-labelledby={`project-tab-${t.id}`}
              tabIndex={0}
              hidden={selected !== t.id}
              className="tab-panel"
            >
              {selected !== t.id ? null : t.id === "overview" ? (
                <ProjectOverview ws={ws} project={view} />
              ) : t.id === "tasks" ? (
                <ProjectTasks ws={ws} project={view} />
              ) : t.id === "brief" ? (
                <ProjectBrief project={view} />
              ) : t.id === "files" ? (
                <ProjectFiles project={view} />
              ) : (
                <ProjectActivity project={view} />
              )}
            </div>
          ))}
        </div>
        <div className="pj-aside">
          {composed["projects.messages"] ? (
            <ProjectConversation
              ws={ws}
              project={view}
              version={conversationVersion}
              onChanged={reload}
              onAskPrivately={canAsk ? () => open("ask") : null}
            />
          ) : null}
        </div>
      </div>
      {/* Mounted whatever the actions say now, so a re-read never unmounts an open dialog
          (its notice stays readable); only the buttons that open them follow `can`. */}
      {composed["projects.stopSteps"] ? (
        <StopStepsDialog
          ws={ws}
          project={view}
          open={dialog === "stop"}
          allowed={can.stop}
          onClose={close}
          onDone={acted}
          onStale={changed}
        />
      ) : null}
      {composed["projects.finishDocument"] && composed["plans.start"] ? (
        <FinishDialog
          ws={ws}
          project={view}
          open={dialog === "finish"}
          allowed={can.finish}
          onClose={close}
          onDone={acted}
          onStale={changed}
        />
      ) : null}
      {composed["projects.extend"] ? (
        <ExtendDialog
          ws={ws}
          project={view}
          open={dialog === "extend"}
          allowed={can.extend}
          onClose={close}
          onDone={acted}
          onStale={changed}
        />
      ) : null}
      {askComposed ? (
        <TellMorrowDialog
          ws={ws}
          open={dialog === "ask"}
          onClose={close}
          starters={[]}
          canAsk={canAsk}
          canCreate={false}
          onSetUpYourself={close}
        />
      ) : null}
    </div>
  );
}
