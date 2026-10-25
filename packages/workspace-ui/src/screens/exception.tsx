// v1 PR 15: one change Morrow couldn't confirm or didn't apply (the route contract's
// `exception`, /w/:ws/inbox/exceptions/:operationId, under the Inbox). It reads the
// operation the server lets this person see (GET /work/operations/:id: the proposal's
// reviewer or proposer) and shows its result in plain words, with the review screen's own
// "Check again" and "I checked it in Shopify" (OperationList), whose commands the server
// checks. An unknown outcome is never shown as done; nothing here sends a change.
import { inboxDate, type OperationDetailView } from "../inbox-model";
import type { Id, WorkspaceView } from "../model";
import { useRead, useServices } from "../services";
import { RouteLink } from "../components/controls";
import { outcomeState } from "../components/feedback";
import { inboxCopy } from "../sunrise/inbox-copy";
import { OperationList } from "./review";

const d = inboxCopy.detail;
type Kind = "uncertain" | "set_aside" | "failed" | "settled" | null;
/** Which result the page words, from the operation's status alone. */
export const exceptionKind = (view: OperationDetailView): Kind => {
  const s = view.operation.status;
  if (s === "uncertain") return "uncertain";
  // A person checked it in Shopify; the outcome is still unknown to Morrow, never done.
  if (s === "cancel_requested") return "set_aside";
  if (s === "failed" || s === "conflict") return "failed";
  return "settled";
};
/**
 * How many times Morrow read the product back. The server sends only the 20 latest
 * read-backs, newest first, so their number would understate it once there are more: each
 * read-back's sequence counts the operation's read-backs from 1 (0045's two inserts take
 * max+1, and the table is append-only), so the newest one's sequence is the count.
 */
export const readbackCount = (view: OperationDetailView): number =>
  view.readbacks[0]?.sequence ?? 0;
/**
 * The line saying how often Morrow read the product back, or null when no read-back has
 * happened and none can (review F1). Check again is offered only for a change Morrow
 * couldn't confirm or a person set aside (review.tsx), and 0045's reconcile reads back only
 * submitted, uncertain and cancel_requested operations: a change that wasn't applied (a
 * definite failure, or a conflict found before sending) or is settled is never read back
 * later, so a line about checks it hasn't had would promise one that never comes.
 */
export const checksLine = (view: OperationDetailView): string | null => {
  const last = view.readbacks[0] ?? null;
  if (last === null) {
    const kind = exceptionKind(view);
    return kind === "uncertain" || kind === "set_aside" ? d.checks(0) : null;
  }
  return `${d.checks(readbackCount(view))} ${d.lastCheck(inboxDate(last.observedAt))}`;
};
const titles = {
  uncertain: d.uncertainTitle,
  set_aside: d.setAsideTitle,
  failed: d.failedTitle,
  settled: d.settledTitle,
} as const;
const bodies = {
  uncertain: d.uncertainBody,
  set_aside: d.setAsideBody,
  failed: d.failedBody,
  settled: d.settledBody,
} as const;

/** The result card: the operation, its read-back line when there is one, and the links. */
export function ExceptionResult({
  ws,
  view,
  onChanged,
}: {
  readonly ws: Id;
  readonly view: OperationDetailView;
  readonly onChanged: () => void;
}) {
  const o = view.operation;
  const checks = checksLine(view);
  return (
    <section className="card" aria-labelledby="exception-result-title">
      <div className="card-head">
        <h2 id="exception-result-title">{d.resultTitle}</h2>
      </div>
      <OperationList ws={ws} operations={[o]} onChanged={onChanged} testId="exception-operation" />
      {checks !== null ? <p className="muted">{checks}</p> : null}
      <div className="item-actions">
        <RouteLink
          route="review"
          params={{ workspaceId: ws, proposalId: o.proposalId }}
          className="text-link"
        >
          {d.openReview}
        </RouteLink>
        <RouteLink
          route="task"
          params={{ workspaceId: ws, taskId: o.taskId }}
          className="text-link"
        >
          {d.openTask}
        </RouteLink>
      </div>
    </section>
  );
}

export function ExceptionScreen({
  workspace,
  operationId,
}: {
  readonly workspace: WorkspaceView;
  readonly operationId: Id;
}) {
  const services = useServices();
  const ws = workspace.id;
  const [detail, reload] = useRead(`${ws}|operation|${operationId}`, () =>
    services.port.inbox.operation(ws, operationId),
  );
  const kind = detail.kind === "ok" ? exceptionKind(detail.value) : null;
  return (
    <div className="page exception">
      <header className="page-header">
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <RouteLink route="inbox" params={{ workspaceId: ws }}>
            {d.back}
          </RouteLink>
        </nav>
        <div className="title-row">
          <h1>{kind === null ? d.title : titles[kind]}</h1>
        </div>
        {kind !== null ? <p className="scope-line">{bodies[kind]}</p> : null}
      </header>
      {detail.kind === "ok" ? (
        <ExceptionResult ws={ws} view={detail.value} onChanged={reload} />
      ) : (
        outcomeState(detail, reload)
      )}
    </div>
  );
}
