// New task: one task in one project, Everyday work area or Quick tasks, so no task is
// loose (ADR-0033 item 7). It is the work API's task create (`work.createTask`), the
// backend that exists today, under the person's own grants.
import { useId, useState, type FormEvent } from "react";
import type { Id } from "../model";
import { useCommand, useDirty, useServices } from "../services";
import { Button, Dialog, TextArea } from "../components/controls";
import { CommandFeedback } from "../screens/entry";
import { projectsCopy } from "./copy";
import type { ProjectsOverviewView } from "./model";

const objectiveLimit = 8192;

/** Where a task can go: dated projects, then the areas, then Quick tasks. */
export function taskHomes(
  overview: ProjectsOverviewView,
): readonly { readonly goalId: Id; readonly label: string }[] {
  return [
    ...overview.dated.map((p) => ({ goalId: p.goalId, label: p.title })),
    ...overview.areas.map((a) => ({ goalId: a.goalId, label: a.label })),
    ...(overview.quickTasks
      ? [{ goalId: overview.quickTasks.goalId, label: projectsCopy.page.quickTasks }]
      : []),
  ];
}

export function NewTaskDialog({
  ws,
  open,
  onClose,
  overview,
  onCreated,
}: {
  readonly ws: Id;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly overview: ProjectsOverviewView;
  readonly onCreated: () => void;
}) {
  const services = useServices();
  const c = projectsCopy.tasks;
  const homes = taskHomes(overview);
  const fallback = overview.quickTasks?.goalId ?? homes[0]?.goalId ?? "";
  const [objective, setObjective] = useState("");
  const [goalId, setGoalId] = useState(fallback);
  const [checked, setChecked] = useState(false);
  const command = useCommand<{ goalId: Id; objective: string }, { readonly taskId: Id }>({
    marker: { workspaceId: ws, kind: "task" },
    send: (cmd) => services.port.work.createTask(ws, cmd),
    onOutcome: (outcome, sent) => {
      if (outcome.kind !== "ok") return;
      if (sent.current) {
        setObjective("");
        setChecked(false);
      }
      onCreated();
    },
  });
  useDirty(open && (objective !== "" || command.busy));
  const valid =
    objective.trim() !== "" &&
    objective.length <= objectiveLimit &&
    !objective.includes("\0") &&
    homes.some((h) => h.goalId === goalId);
  const formId = useId();
  const selectId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (!valid || command.busy) return;
    void command.submit({ goalId, objective });
  };
  const close = () => {
    if (command.busy) return;
    command.reset();
    setChecked(false);
    onClose();
  };
  return (
    <Dialog
      open={open}
      title={c.dialogTitle}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={command.busy}>
            {c.cancel}
          </Button>
          <Button type="submit" variant="primary" form={formId} disabled={command.busy}>
            {command.busy ? c.creating : c.create}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="pj-form">
        <TextArea
          label={c.whatLabel}
          value={objective}
          onChange={setObjective}
          error={checked && !valid ? projectsCopy.newProject.invalid : null}
          disabled={command.busy}
          maxLength={objectiveLimit}
          required
        />
        <div className="field">
          <label htmlFor={selectId}>{c.goesInLabel}</label>
          <select
            id={selectId}
            value={goalId}
            disabled={command.busy}
            aria-describedby={selectId + "-hint"}
            onChange={(event) => setGoalId(event.target.value)}
          >
            {homes.map((home) => (
              <option key={home.goalId} value={home.goalId}>
                {home.label}
              </option>
            ))}
          </select>
          <small id={selectId + "-hint"}>{c.goesInHint}</small>
        </div>
        <CommandFeedback
          phase={command.phase}
          onCheckAgain={command.checkAgain}
          onRetry={command.retry}
          success={c.created}
        />
      </form>
    </Dialog>
  );
}
