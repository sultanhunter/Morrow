// Task detail (P14.T01a §4.10): Brief and Questions tabs. The conversation and activity
// panes are not in this build (P14.T01b, P06.T02a); below a 1120 px content width they
// sit behind an aria-pressed pane switch. Assign and Ask stay hidden without people.list.
import { useCallback, useState } from "react";
import { copy } from "../copy";
import type { Id, QuestionView, TaskView, WorkspaceView } from "../model";
import { useCommand, useRead, useServices } from "../services";
import { Button, RouteLink } from "../components/controls";
import { PersonLabel, RecordText, StatusTag } from "../components/display";
import { StateView, outcomeState } from "../components/feedback";
import { PaneSwitch, Tabs } from "../components/shell";
import { CommandFeedback } from "./entry";
import { Answer } from "./inbox";
import { usePaged } from "./work";

function MarkReady({
  ws,
  task,
  onChanged,
}: {
  readonly ws: Id;
  readonly task: TaskView;
  readonly onChanged: () => void;
}) {
  const services = useServices();
  const command = useCommand<{ expectedRevision: number }, { readonly revision: number }>({
    marker: { workspaceId: ws, kind: "ready" },
    send: (c) => services.port.work.markReady(ws, task.id, c),
    // A stale revision refetches and shows the current status; the choice stays, and
    // submitting again carries the new revision, so it gets a new key.
    onOutcome: (outcome) => {
      if (outcome.kind === "ok" || (outcome.kind === "conflict" && outcome.recheck)) onChanged();
    },
  });
  return (
    <div className="action-block">
      {task.status === "draft" ? (
        <Button
          variant="primary"
          disabled={command.busy}
          onClick={() => void command.submit({ expectedRevision: task.revision })}
        >
          {copy.task.markReady}
        </Button>
      ) : null}
      <CommandFeedback
        phase={command.phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
        success={copy.task.markedReady}
        messages={{ conflict: (o) => (o.recheck ? copy.task.conflictRefreshed : o.message) }}
      />
    </div>
  );
}

function QuestionRow({
  ws,
  question,
  onChanged,
}: {
  readonly ws: Id;
  readonly question: QuestionView;
  readonly onChanged: () => void;
}) {
  const services = useServices();
  const command = useCommand<{ expectedRevision: number }, { readonly revision: number }>({
    marker: { workspaceId: ws, kind: "cancel" },
    send: (c) => services.port.work.cancelQuestion(ws, question.id, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok" || (outcome.kind === "conflict" && outcome.recheck)) onChanged();
    },
  });
  return (
    <li className="item item-stacked">
      <RecordText as="p">{question.prompt}</RecordText>
      <p className="meta">
        <StatusTag family="question" status={question.status} />
        {question.respondent ? <PersonLabel person={question.respondent} /> : null}
      </p>
      {question.status === "answered" ? <Answer ws={ws} questionId={question.id} compact /> : null}
      <div className="item-actions">
        <RouteLink
          route="question"
          params={{ workspaceId: ws, questionId: question.id }}
          className="text-link"
        >
          {copy.task.openQuestion}
        </RouteLink>
        {question.status === "open" ? (
          <Button
            disabled={command.busy}
            onClick={() => void command.submit({ expectedRevision: question.revision })}
          >
            {copy.task.cancelQuestion}
          </Button>
        ) : null}
      </div>
      <CommandFeedback
        phase={command.phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
        success={copy.task.questionCancelled}
      />
    </li>
  );
}

function QuestionsPanel({ ws, taskId }: { readonly ws: Id; readonly taskId: Id }) {
  const services = useServices();
  const loadPage = useCallback(
    (after: string | null) => services.port.work.listTaskQuestions(ws, taskId, after),
    [services, ws, taskId],
  );
  const paged = usePaged<QuestionView>(`${ws}|task-questions|${taskId}`, loadPage);
  if (paged.first.kind !== "ok") return <>{outcomeState(paged.first, paged.reload)}</>;
  return (
    <>
      {paged.items.length ? (
        <ul className="item-list">
          {paged.items.map((q) => (
            <QuestionRow key={q.id} ws={ws} question={q} onChanged={paged.reload} />
          ))}
        </ul>
      ) : (
        <StateView kind="empty" message={copy.task.noQuestions} />
      )}
      {paged.next !== null ? (
        <Button onClick={paged.loadMore} disabled={paged.loadingMore}>
          {copy.work.loadMore}
        </Button>
      ) : null}
    </>
  );
}

function BriefPanel({
  ws,
  task,
  onChanged,
}: {
  readonly ws: Id;
  readonly task: TaskView;
  readonly onChanged: () => void;
}) {
  const services = useServices();
  const [goal] = useRead(task.goalId ? `${ws}|goal|${task.goalId}` : null, () =>
    services.port.work.getGoal(ws, task.goalId ?? ""),
  );
  return (
    <div className="brief">
      <RecordText as="p" className="reading">
        {task.objective}
      </RecordText>
      <dl className="facts">
        <div>
          <dt>{copy.task.status}</dt>
          <dd>
            <StatusTag family="task" status={task.status} />
          </dd>
        </div>
        <div>
          <dt>{copy.task.owner}</dt>
          <dd>
            <PersonLabel person={task.owner} />
          </dd>
        </div>
        {task.goalId ? (
          <div>
            <dt>{copy.task.goal}</dt>
            <dd>
              {goal.kind === "ok" ? (
                <RecordText>{goal.value.objective}</RecordText>
              ) : (
                outcomeState(goal, () => {}, { compact: true })
              )}
            </dd>
          </div>
        ) : null}
      </dl>
      <MarkReady ws={ws} task={task} onChanged={onChanged} />
      {!services.composed["people.list"] ? (
        <p className="muted">{copy.task.peopleUnavailable}</p>
      ) : null}
    </div>
  );
}

export function TaskScreen({
  workspace,
  taskId,
}: {
  readonly workspace: WorkspaceView;
  readonly taskId: Id;
}) {
  const services = useServices();
  const ws = workspace.id;
  const [task, reload] = useRead(`${ws}|task|${taskId}`, () =>
    services.port.work.getTask(ws, taskId),
  );
  const [tab, setTab] = useState("brief");
  const [pane, setPane] = useState("task");
  const tabs = [
    { id: "brief", label: copy.task.brief },
    { id: "questions", label: copy.task.questions },
  ];
  return (
    <div className="page task-page" data-pane={pane}>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <RouteLink route="work" params={{ workspaceId: ws }}>
          {copy.task.breadcrumb}
        </RouteLink>
      </nav>
      {task.kind !== "ok" ? (
        outcomeState(task, reload)
      ) : (
        <>
          <header className="page-header">
            <RecordText as="h1">{task.value.objective}</RecordText>
            <p className="meta">
              <StatusTag family="task" status={task.value.status} />
              <PersonLabel person={task.value.owner} />
              <span className="muted">{copy.task.revision(task.value.revision)}</span>
            </p>
          </header>
          <PaneSwitch
            label={copy.task.panesLabel}
            selected={pane}
            onSelect={setPane}
            panes={[
              { id: "task", label: copy.task.paneTask },
              { id: "conversation", label: copy.task.paneConversation },
              { id: "activity", label: copy.task.paneActivity },
            ]}
          />
          <div className="task-layout">
            <div className="task-main">
              <Tabs
                label={copy.task.tabsLabel}
                tabs={tabs}
                selected={tab}
                onSelect={setTab}
                idPrefix="task"
              />
              <div
                id="task-panel-brief"
                role="tabpanel"
                aria-labelledby="task-tab-brief"
                tabIndex={0}
                hidden={tab !== "brief"}
                className="tab-panel"
              >
                {tab === "brief" ? (
                  <BriefPanel ws={ws} task={task.value} onChanged={reload} />
                ) : null}
              </div>
              <div
                id="task-panel-questions"
                role="tabpanel"
                aria-labelledby="task-tab-questions"
                tabIndex={0}
                hidden={tab !== "questions"}
                className="tab-panel"
              >
                {tab === "questions" ? <QuestionsPanel ws={ws} taskId={taskId} /> : null}
              </div>
            </div>
            <aside className="task-side" aria-label={copy.task.panesLabel}>
              <section className="side-pane side-conversation" aria-labelledby="conversation-title">
                <h2 id="conversation-title">{copy.task.conversationTitle}</h2>
                <StateView kind="not_in_build" compact />
              </section>
              <section className="side-pane side-activity" aria-labelledby="activity-title">
                <h2 id="activity-title">{copy.task.activityTitle}</h2>
                <StateView kind="not_in_build" compact />
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
