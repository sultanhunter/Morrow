// M3 PR-2: the task's Runs tab (/w/:ws/work/:taskId). Each Listings run on the task shows
// its status, selection and progress; its details show the credits reserved and charged,
// the model usage as counts, and every product's status, failure reason, reviewer flags
// (counts only) and whether its draft is in a proposal for review. A run stopped or out of
// time before it finished offers the stale close, which returns its unused credits. No
// draft text, product content, provider id or per-call cost is ever shown or read.
import { useId, useState } from "react";
import { copy } from "../copy";
import type { Id, RunDetailView, RunView } from "../model";
import { useCommand, useRead, useServices } from "../services";
import { Button, RouteLink } from "../components/controls";
import { Icon, StatusTag, Time } from "../components/display";
import { StateView, outcomeState } from "../components/feedback";
import { CommandFeedback } from "./entry";

const label = (key: string) => copy.models.labels[key] ?? key;
const fieldLabel = (key: string) => copy.agents.fieldLabels[key] ?? key;

function Reconcile({ ws, onChanged }: { readonly ws: Id; readonly onChanged: () => void }) {
  const services = useServices();
  const command = useCommand<Record<string, never>, { readonly closed: number }>({
    marker: { workspaceId: ws, kind: "run" },
    send: (c) => services.port.runs.reconcile(ws, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") onChanged();
    },
  });
  const done = command.phase.phase === "settled" && command.phase.outcome.kind === "ok";
  return (
    <div className="action-block">
      <p>{copy.runs.interrupted}</p>
      <Button disabled={command.busy || done} onClick={() => void command.submit({})}>
        {copy.runs.reconcile}
      </Button>
      <CommandFeedback
        phase={command.phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
        {...(command.phase.phase === "settled" && command.phase.outcome.kind === "ok"
          ? { success: copy.runs.reconciled(command.phase.outcome.value.closed) }
          : {})}
      />
    </div>
  );
}

function RunDetails({
  ws,
  runId,
  onChanged,
}: {
  readonly ws: Id;
  readonly runId: Id;
  readonly onChanged: () => void;
}) {
  const services = useServices();
  const [detail, reload] = useRead(`${ws}|run|${runId}`, () => services.port.runs.get(ws, runId));
  if (detail.kind !== "ok") return <>{outcomeState(detail, reload, { compact: true })}</>;
  const d: RunDetailView = detail.value;
  const credits =
    d.credits.status === "settled" && d.credits.settled !== null
      ? copy.runs.creditsSettled(d.credits.settled)
      : d.credits.status === "released"
        ? copy.runs.creditsReleased
        : d.credits.reserved !== null
          ? copy.runs.creditsReserved(d.credits.reserved)
          : null;
  return (
    <div className="run-details">
      <dl className="facts">
        {credits ? (
          <div>
            <dt>{copy.models.credits(d.run.creditsPerProduct)}</dt>
            <dd>{credits}</dd>
          </div>
        ) : null}
        {d.usage.attempts !== null ? (
          <div>
            <dt>
              {copy.runs.selection(label(d.run.selection.model), label(d.run.selection.effort))}
            </dt>
            <dd>
              {copy.runs.usage(
                d.usage.attempts,
                d.usage.inputTokens ?? 0,
                d.usage.outputTokens ?? 0,
              )}
            </dd>
          </div>
        ) : null}
      </dl>
      {d.interrupted ? (
        <Reconcile
          ws={ws}
          onChanged={() => {
            reload();
            onChanged();
          }}
        />
      ) : null}
      <ul className="item-list" data-testid="run-products">
        {d.products.map((p) => (
          <li key={p.index} className="item item-stacked">
            <p>
              <span dir="auto">{p.productId}</span>
            </p>
            <p className="meta">
              <StatusTag family="runProduct" status={p.status} />
              {p.attempts > 0 ? <span>{copy.runs.attempts(p.attempts)}</span> : null}
              {p.proposalId ? <span>{copy.runs.proposal}</span> : null}
              {p.proposalId && services.composed["review.get"] ? (
                <RouteLink route="review" params={{ workspaceId: ws, proposalId: p.proposalId }}>
                  {copy.runs.review}
                </RouteLink>
              ) : null}
            </p>
            {p.failureCode ? (
              <p className="muted">{copy.runs.failureCodes[p.failureCode] ?? p.failureCode}</p>
            ) : null}
            {p.flags && copy.runs.flags(p.flags) ? (
              <p className="muted">{copy.runs.flags(p.flags)}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunRow({
  ws,
  run,
  n,
  onChanged,
}: {
  readonly ws: Id;
  readonly run: RunView;
  readonly n: number | null;
  readonly onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <li className="item item-stacked">
      <p>
        <strong>{n === null ? copy.runs.runUnnumbered : copy.runs.run(n)}</strong>{" "}
        <span className="muted">
          {copy.runs.selection(label(run.selection.model), label(run.selection.effort))}
        </span>
      </p>
      <p className="meta">
        <StatusTag family="run" status={run.status} />
        <span>{copy.runs.progress(run.productsDrafted, run.productsFailed, run.productCount)}</span>
        <Time value={run.createdAt} />
      </p>
      <p className="muted">{run.fields.map(fieldLabel).join(" · ")}</p>
      {run.endedReason ? (
        <p className="muted">{copy.runs.endedReasons[run.endedReason] ?? run.endedReason}</p>
      ) : null}
      <div className="item-actions">
        <Button
          variant="quiet"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="chevron" size={16} />
          {open ? copy.runs.hideDetails : copy.runs.showDetails}
        </Button>
      </div>
      <div id={panel} hidden={!open}>
        {open ? <RunDetails ws={ws} runId={run.runId} onChanged={onChanged} /> : null}
      </div>
    </li>
  );
}

export function RunsPanel({ ws, taskId }: { readonly ws: Id; readonly taskId: Id }) {
  const services = useServices();
  const [runs, reload] = useRead(`${ws}|task-runs|${taskId}`, () =>
    services.port.runs.listOfTask(ws, taskId),
  );
  if (runs.kind !== "ok") return <>{outcomeState(runs, reload)}</>;
  if (runs.value.length === 0) return <StateView kind="empty" message={copy.runs.empty} />;
  // Newest first from the server; numbered from the oldest only when the list is whole (the
  // server returns at most runsListLimit, so a full list may leave older runs out).
  const whole = runs.value.length < runsListLimit;
  return (
    <ul className="item-list" data-testid="task-runs">
      {runs.value.map((run, i) => (
        <RunRow
          key={run.runId}
          ws={ws}
          run={run}
          n={runNumber(runs.value.length, i, whole)}
          onChanged={reload}
        />
      ))}
    </ul>
  );
}
/** GET /work/tasks/:taskId/runs returns at most this many runs, newest first. */
export const runsListLimit = 20;
/** A run's number from the oldest, or null when older runs may be left out of the list. */
export const runNumber = (count: number, index: number, whole: boolean): number | null =>
  whole ? count - index : null;
