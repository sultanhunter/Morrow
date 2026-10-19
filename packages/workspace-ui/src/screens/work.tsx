// Work (P14.T01a §4.10): goals 25 per page with Load more, a disclosure of each goal's
// tasks (50 per page), and the create-goal and create-task dialogs. Empty and denied
// are distinct; a field denial renders as denied, never as a partial list.
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { copy } from "../copy";
import type { GoalView, Id, Page, TaskView, WorkspaceView } from "../model";
import type { Outcome } from "../port";
import { useCommand, useDirty, useRead, useServices, type ReadState } from "../services";
import { Button, Dialog, RouteLink, TextArea, TextField } from "../components/controls";
import { Icon, PersonLabel, RecordText, StatusTag } from "../components/display";
import { StateView, StatusRegion, outcomeState } from "../components/feedback";
import { CommandFeedback } from "./entry";

/** First page through a shared read, later pages appended on Load more. */
export function usePaged<T>(
  key: string,
  loadPage: (after: string | null) => Promise<Outcome<Page<T>>>,
): {
  readonly first: ReadState<Page<T>>;
  readonly items: readonly T[];
  readonly next: string | null;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
  readonly loadMore: () => void;
  readonly reload: () => void;
} {
  const services = useServices();
  const [first, reload] = useRead(key, () => loadPage(null));
  const [extra, setExtra] = useState<{ items: readonly T[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  useEffect(() => {
    setExtra(null);
    setMoreFailed(false);
  }, [first]);
  const base = first.kind === "ok" ? first.value : { items: [], next: null };
  const items = extra ? [...base.items, ...extra.items] : base.items;
  const next = extra ? extra.next : base.next;
  const loadMore = useCallback(() => {
    if (next === null || loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    services
      .read(`${key}|after|${next}`, () => loadPage(next))
      .then((outcome) => {
        setLoadingMore(false);
        if (outcome.kind !== "ok") {
          setMoreFailed(true);
          return;
        }
        setExtra((current) => ({
          items: [...(current?.items ?? []), ...outcome.value.items],
          next: outcome.value.next,
        }));
      });
  }, [services, key, next, loadingMore, loadPage]);
  return { first, items, next, loadingMore, moreFailed, loadMore, reload };
}

function LoadMore({
  paged,
}: {
  readonly paged: {
    next: string | null;
    loadingMore: boolean;
    moreFailed: boolean;
    loadMore: () => void;
  };
}) {
  if (paged.next === null) return null;
  return (
    <div className="load-more">
      <Button onClick={paged.loadMore} disabled={paged.loadingMore}>
        {paged.loadingMore ? copy.states.loading : copy.work.loadMore}
      </Button>
      {paged.moreFailed ? <p className="muted small">{copy.states.unavailable}</p> : null}
    </div>
  );
}

function TaskList({ ws, goal }: { readonly ws: Id; readonly goal: GoalView }) {
  const services = useServices();
  const loadPage = useCallback(
    (after: string | null) => services.port.work.listTasks(ws, goal.id, after),
    [services, ws, goal.id],
  );
  const paged = usePaged<TaskView>(`${ws}|tasks|${goal.id}`, loadPage);
  if (paged.first.kind !== "ok")
    return <>{outcomeState(paged.first, paged.reload, { compact: true })}</>;
  if (!paged.items.length) return <StateView kind="empty" compact message={copy.work.noTasks} />;
  return (
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
            <StatusTag family="task" status={task.status} />
          </li>
        ))}
      </ul>
      <LoadMore paged={paged} />
    </>
  );
}

function GoalRow({
  ws,
  goal,
  onCreateTask,
}: {
  readonly ws: Id;
  readonly goal: GoalView;
  readonly onCreateTask: (goal: GoalView) => void;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <li className="goal">
      <div className="goal-head">
        <div className="goal-text">
          <RecordText as="h3">{goal.objective}</RecordText>
          <p className="meta">
            <StatusTag family="goal" status={goal.status} />
            <PersonLabel person={goal.owner} />
          </p>
        </div>
        <div className="goal-actions">
          <Button aria-expanded={open} aria-controls={panel} onClick={() => setOpen((v) => !v)}>
            <Icon name="chevron" size={16} />
            {open ? copy.work.hideTasks : copy.work.showTasks}
          </Button>
          <Button onClick={() => onCreateTask(goal)}>{copy.work.createTask}</Button>
        </div>
      </div>
      <div id={panel} className="goal-tasks" hidden={!open}>
        {open ? <TaskList ws={ws} goal={goal} /> : null}
      </div>
    </li>
  );
}

const objectiveLimit = 8192;
const criterionLimit = 2048;
function CreateGoalDialog({
  ws,
  open,
  onClose,
  onCreated,
}: {
  readonly ws: Id;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const services = useServices();
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState<string[]>([""]);
  const [checked, setChecked] = useState(false);
  const command = useCommand<
    { objective: string; criteria: readonly string[] },
    { readonly goalId: Id }
  >({
    marker: { workspaceId: ws, kind: "goal" },
    send: (c) => services.port.work.createGoal(ws, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") {
        setObjective("");
        setCriteria([""]);
        setChecked(false);
        onCreated();
      }
    },
  });
  useDirty(open && (objective !== "" || criteria.some((c) => c !== "") || command.busy));
  const objectiveValid = objective.trim() !== "" && objective.length <= objectiveLimit;
  const criteriaValid =
    criteria.length >= 1 &&
    criteria.length <= 20 &&
    criteria.every((c) => c.trim() !== "" && c.length <= criterionLimit);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (!objectiveValid || !criteriaValid || command.busy) return;
    void command.submit({ objective, criteria: [...criteria] });
  };
  const locked = command.busy;
  // Closing drops the draft. An unconfirmed command is released, and its text-free
  // marker then shows as a re-entry notice; a request in flight can't be abandoned.
  const close = () => {
    if (command.phase.phase === "sending") return;
    command.reset();
    setObjective("");
    setCriteria([""]);
    setChecked(false);
    onClose();
  };
  return (
    <Dialog open={open} title={copy.work.createGoalTitle} onClose={close}>
      <form onSubmit={submit} noValidate>
        <TextArea
          label={copy.work.objective}
          value={objective}
          onChange={setObjective}
          hint={copy.work.objectiveHint}
          error={checked && !objectiveValid ? copy.outcome.invalid : null}
          disabled={locked}
          maxLength={objectiveLimit}
          required
        />
        <fieldset className="criteria" disabled={locked}>
          <legend>{copy.work.criteria}</legend>
          <p className="muted small">{copy.work.criteriaHint}</p>
          {criteria.map((value, index) => (
            <div className="criterion" key={index}>
              <TextField
                label={copy.work.criterion(index + 1)}
                value={value}
                onChange={(next) =>
                  setCriteria((all) => all.map((c, i) => (i === index ? next : c)))
                }
                error={
                  checked && (value.trim() === "" || value.length > criterionLimit)
                    ? copy.outcome.invalid
                    : null
                }
                maxLength={criterionLimit}
                required
              />
              {criteria.length > 1 ? (
                <Button
                  variant="quiet"
                  onClick={() => setCriteria((all) => all.filter((_, i) => i !== index))}
                >
                  {copy.work.removeCriterion(index + 1)}
                </Button>
              ) : null}
            </div>
          ))}
          {criteria.length < 20 ? (
            <Button variant="quiet" onClick={() => setCriteria((all) => [...all, ""])}>
              {copy.work.addCriterion}
            </Button>
          ) : null}
        </fieldset>
        <CommandFeedback
          phase={command.phase}
          onCheckAgain={command.checkAgain}
          onRetry={command.retry}
        />
        <div className="dialog-footer">
          <Button onClick={close} disabled={command.phase.phase === "sending"}>
            {copy.work.cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={locked}>
            {copy.work.saveGoal}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CreateTaskDialog({
  ws,
  goal,
  onClose,
  onCreated,
}: {
  readonly ws: Id;
  readonly goal: GoalView | null;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const services = useServices();
  const [objective, setObjective] = useState("");
  const [checked, setChecked] = useState(false);
  const command = useCommand<{ goalId: Id; objective: string }, { readonly taskId: Id }>({
    marker: { workspaceId: ws, kind: "task" },
    send: (c) => services.port.work.createTask(ws, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") {
        setObjective("");
        setChecked(false);
        onCreated();
      }
    },
  });
  useDirty(goal !== null && (objective !== "" || command.busy));
  const valid = objective.trim() !== "" && objective.length <= objectiveLimit;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (!goal || !valid || command.busy) return;
    void command.submit({ goalId: goal.id, objective });
  };
  const close = () => {
    if (command.phase.phase === "sending") return;
    command.reset();
    setObjective("");
    setChecked(false);
    onClose();
  };
  return (
    <Dialog open={goal !== null} title={copy.work.createTaskTitle} onClose={close}>
      <form onSubmit={submit} noValidate>
        {goal ? (
          <RecordText as="p" className="muted">
            {goal.objective}
          </RecordText>
        ) : null}
        <TextArea
          label={copy.work.objective}
          value={objective}
          onChange={setObjective}
          hint={copy.work.objectiveHint}
          error={checked && !valid ? copy.outcome.invalid : null}
          disabled={command.busy}
          maxLength={objectiveLimit}
          required
        />
        <CommandFeedback
          phase={command.phase}
          onCheckAgain={command.checkAgain}
          onRetry={command.retry}
        />
        <div className="dialog-footer">
          <Button onClick={close} disabled={command.phase.phase === "sending"}>
            {copy.work.cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={command.busy}>
            {copy.work.saveTask}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function WorkScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const loadPage = useCallback(
    (after: string | null) => services.port.work.listGoals(ws, after),
    [services, ws],
  );
  const paged = usePaged<GoalView>(`${ws}|goals`, loadPage);
  const [creatingGoal, setCreatingGoal] = useState(false);
  const [taskGoal, setTaskGoal] = useState<GoalView | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const canCreate = services.composed["work.createGoal"];
  return (
    <div className="page">
      <header className="page-header page-header-actions">
        <h1>{copy.work.title}</h1>
        {canCreate && paged.first.kind === "ok" ? (
          <Button variant="primary" onClick={() => setCreatingGoal(true)}>
            {copy.work.createGoal}
          </Button>
        ) : null}
      </header>
      <StatusRegion message={confirmation} />
      {paged.first.kind !== "ok" ? (
        outcomeState(paged.first, paged.reload, { denied: copy.work.denied })
      ) : paged.items.length === 0 ? (
        <StateView kind="empty" title={copy.work.empty} message={copy.work.emptyBody} />
      ) : (
        <>
          <ul className="goal-list">
            {paged.items.map((goal) => (
              <GoalRow key={goal.id} ws={ws} goal={goal} onCreateTask={setTaskGoal} />
            ))}
          </ul>
          <LoadMore paged={paged} />
        </>
      )}
      <CreateGoalDialog
        ws={ws}
        open={creatingGoal}
        onClose={() => setCreatingGoal(false)}
        onCreated={() => {
          setCreatingGoal(false);
          setConfirmation(copy.work.goalCreated);
          paged.reload();
        }}
      />
      <CreateTaskDialog
        ws={ws}
        goal={taskGoal}
        onClose={() => setTaskGoal(null)}
        onCreated={() => {
          setTaskGoal(null);
          setConfirmation(copy.work.taskCreated);
        }}
      />
    </div>
  );
}
