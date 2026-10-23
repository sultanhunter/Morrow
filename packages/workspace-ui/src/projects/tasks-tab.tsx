// The Tasks tab of the Projects page: every task the person can see, as a board (Needs
// you, To do, Working, Done today) or a list, with Mine. A task opens on its task page
// (the work API). New task files a task in one project, area or Quick tasks.
import { useState } from "react";
import type { Id } from "../model";
import { Button } from "../components/controls";
import { StateView } from "../components/feedback";
import { projectsCopy } from "./copy";
import { bucketRows, statusStyle } from "./format";
import type { ProjectTaskRowView, ProjectTasksView } from "./model";
import { CellLabel, MemberName, WordBadge, InlineLink } from "./parts";

const c = projectsCopy.tasks;
const bucketLabel = (bucket: string) =>
  Object.hasOwn(c.buckets, bucket) ? c.buckets[bucket]! : bucket;

function TaskCard({ ws, row }: { readonly ws: Id; readonly row: ProjectTaskRowView }) {
  return (
    <li className="pj-task-card">
      <InlineLink strong route="task" params={{ workspaceId: ws, taskId: row.taskId }}>
        <span dir="auto" className="pj-row-title">
          {row.title}
        </span>
      </InlineLink>
      <MemberName member={row.owner} />
      <span dir="auto" className="pj-meta">
        {c.inProject(row.projectTitle)}
      </span>
      {row.when || row.note ? (
        <span dir="auto" className="pj-meta">
          {[row.when, row.note].filter(Boolean).join(" · ")}
        </span>
      ) : null}
    </li>
  );
}

export function TasksTab({
  ws,
  tasks,
  canCreate,
  onNewTask,
}: {
  readonly ws: Id;
  readonly tasks: ProjectTasksView;
  readonly canCreate: boolean;
  readonly onNewTask: () => void;
}) {
  const [view, setView] = useState<"board" | "list">("board");
  const [mine, setMine] = useState(true);
  const groups = bucketRows(tasks.rows, mine);
  const shown = groups.flatMap((g) => g.rows);
  return (
    <div className="pj-stack">
      <div className="pj-toolbar">
        <div className="pj-segmented" role="group" aria-label={c.viewLabel}>
          <Button aria-pressed={view === "board"} onClick={() => setView("board")}>
            {c.board}
          </Button>
          <Button aria-pressed={view === "list"} onClick={() => setView("list")}>
            {c.list}
          </Button>
        </div>
        <Button aria-pressed={mine} onClick={() => setMine((m) => !m)}>
          {c.mine}
        </Button>
        {canCreate ? <Button onClick={onNewTask}>{c.newTask}</Button> : null}
      </div>
      <p className="muted" role="status">
        {mine ? c.mineNote : c.allNote}
      </p>
      {!shown.length ? (
        <StateView kind="empty" message={c.empty} />
      ) : view === "board" ? (
        <div className="pj-board">
          {groups.map((group) => (
            <section
              key={group.bucket}
              className="pj-board-column"
              aria-labelledby={`pj-bucket-${group.bucket}`}
            >
              <h2 id={`pj-bucket-${group.bucket}`} className="pj-column-title">
                {bucketLabel(group.bucket)} <span className="pj-count">{group.rows.length}</span>
              </h2>
              {group.rows.length ? (
                <ul className="pj-task-cards">
                  {group.rows.map((row) => (
                    <TaskCard key={row.taskId} ws={ws} row={row} />
                  ))}
                </ul>
              ) : (
                <p className="pj-meta">{c.emptyBucket}</p>
              )}
            </section>
          ))}
        </div>
      ) : (
        <div className="pj-rows pj-rows-tasks">
          <div className="pj-row pj-row-head" aria-hidden="true">
            <span>{c.columns.task}</span>
            <span>{c.columns.who}</span>
            <span>{c.columns.goesIn}</span>
            <span>{c.columns.status}</span>
            <span>{c.columns.when}</span>
          </div>
          <ul className="pj-row-list">
            {shown.map((row) => (
              <li key={row.taskId} className="pj-row">
                <div className="pj-cell pj-cell-main">
                  <CellLabel>{c.columns.task}</CellLabel>
                  <InlineLink strong route="task" params={{ workspaceId: ws, taskId: row.taskId }}>
                    <span dir="auto" className="pj-row-title">
                      {row.title}
                    </span>
                  </InlineLink>
                </div>
                <div className="pj-cell">
                  <CellLabel>{c.columns.who}</CellLabel>
                  <MemberName member={row.owner} />
                </div>
                <div className="pj-cell">
                  <CellLabel>{c.columns.goesIn}</CellLabel>
                  <span dir="auto">{row.projectTitle}</span>
                </div>
                <div className="pj-cell">
                  <CellLabel>{c.columns.status}</CellLabel>
                  <WordBadge
                    style={{ ...statusStyle(row.bucket), label: bucketLabel(row.bucket) }}
                  />
                </div>
                <div className="pj-cell">
                  <CellLabel>{c.columns.when}</CellLabel>
                  <span dir="auto" className="pj-meta">
                    {[row.when, row.note].filter(Boolean).join(" · ")}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
