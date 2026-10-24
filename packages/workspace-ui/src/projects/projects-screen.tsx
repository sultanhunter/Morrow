// Projects (route `work`, ADR-0033 item 9; the UX recommendation §3.2): "What are we
// working toward?" Tabs Projects, Tasks and Repeating, and New project, which opens "Tell
// Morrow what you want to achieve" with "Set it up yourself". Each tab owns its loading,
// denied and unavailable states, so the page never fails as a whole.
import { useState } from "react";
import type { WorkspaceView } from "../model";
import { useRead, useServices } from "../services";
import { Button } from "../components/controls";
import { Tabs } from "../components/shell";
import { outcomeState } from "../components/feedback";
import { projectsCopy } from "./copy";
import { NewTaskDialog } from "./new-task";
import { SetUpProjectDialog, TellMorrowDialog } from "./new-project";
import { ProjectsTab } from "./projects-tab";
import { RepeatingTab } from "./repeating-tab";
import { TasksTab } from "./tasks-tab";

type Tab = "projects" | "tasks" | "repeating";
const c = projectsCopy.page;

export function ProjectsScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const [tab, setTab] = useState<Tab>("projects");
  const [dialog, setDialog] = useState<"none" | "tell" | "yourself" | "task">("none");
  const [tasksVersion, setTasksVersion] = useState(0);
  const [overview, reloadOverview] = useRead(`${ws}|projects.overview`, () =>
    services.port.projects.overview(ws),
  );
  const [tasks, reloadTasks] = useRead(
    tab === "tasks" ? `${ws}|projects.tasks|${tasksVersion}` : null,
    () => services.port.projects.tasks(ws),
  );
  const [repeating, reloadRepeating] = useRead(
    tab === "repeating" ? `${ws}|projects.repeating` : null,
    () => services.port.projects.repeating(ws),
  );
  const view = overview.kind === "ok" ? overview.value : null;
  const canAsk = view !== null && view.actions.ask && services.composed["plans.ask"];
  const canCreate = view !== null && view.actions.create && services.composed["projects.create"];
  const tabs: readonly { readonly id: Tab; readonly label: string }[] = [
    { id: "projects", label: c.tabProjects },
    {
      id: "tasks",
      label: view ? `${projectsCopy.page.tabTasks} ${view.counts.openTasks}` : c.tabTasks,
    },
    {
      id: "repeating",
      label: view ? `${c.tabRepeating} ${view.counts.repeating}` : c.tabRepeating,
    },
  ];
  return (
    <div className="page pj-page">
      <header className="page-header pj-header">
        <div>
          <h1>{c.title}</h1>
          <p className="muted" dir="auto">
            {c.intro(workspace.displayName)}
          </p>
        </div>
        {canAsk || canCreate ? (
          <Button variant="primary" onClick={() => setDialog(canAsk ? "tell" : "yourself")}>
            {c.newProject}
          </Button>
        ) : null}
      </header>
      {view === null ? (
        outcomeState(overview, reloadOverview)
      ) : (
        <>
          <Tabs
            label={c.tabsLabel}
            tabs={tabs}
            selected={tab}
            onSelect={(id) => setTab(id === "tasks" || id === "repeating" ? id : "projects")}
            idPrefix="projects"
          />
          <div
            id="projects-panel-projects"
            role="tabpanel"
            aria-labelledby="projects-tab-projects"
            tabIndex={0}
            hidden={tab !== "projects"}
            className="tab-panel"
          >
            {tab === "projects" ? <ProjectsTab ws={ws} overview={view} /> : null}
          </div>
          <div
            id="projects-panel-tasks"
            role="tabpanel"
            aria-labelledby="projects-tab-tasks"
            tabIndex={0}
            hidden={tab !== "tasks"}
            className="tab-panel"
          >
            {tab === "tasks" ? (
              tasks.kind === "ok" ? (
                <TasksTab
                  ws={ws}
                  tasks={tasks.value}
                  canCreate={view.actions.createTask && services.composed["work.createTask"]}
                  onNewTask={() => setDialog("task")}
                />
              ) : (
                outcomeState(tasks, reloadTasks)
              )
            ) : null}
          </div>
          <div
            id="projects-panel-repeating"
            role="tabpanel"
            aria-labelledby="projects-tab-repeating"
            tabIndex={0}
            hidden={tab !== "repeating"}
            className="tab-panel"
          >
            {tab === "repeating" ? (
              repeating.kind === "ok" ? (
                <RepeatingTab ws={ws} view={repeating.value} />
              ) : (
                outcomeState(repeating, reloadRepeating)
              )
            ) : null}
          </div>
          <TellMorrowDialog
            ws={ws}
            open={dialog === "tell"}
            onClose={() => setDialog("none")}
            starters={view.starters}
            canAsk={canAsk}
            canCreate={canCreate}
            onSetUpYourself={() => setDialog("yourself")}
          />
          <SetUpProjectDialog
            ws={ws}
            open={dialog === "yourself"}
            onClose={() => setDialog("none")}
            canAsk={canAsk}
            onAskInstead={() => setDialog("tell")}
          />
          <NewTaskDialog
            ws={ws}
            open={dialog === "task"}
            onClose={() => setDialog("none")}
            overview={view}
            onCreated={() => {
              setDialog("none");
              setTasksVersion((n) => n + 1);
              reloadOverview();
            }}
          />
        </>
      )}
    </div>
  );
}
