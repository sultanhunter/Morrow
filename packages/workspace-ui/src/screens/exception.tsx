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
import { RecordText } from "../components/display";
import { outcomeState } from "../components/feedback";
import { inboxCopy } from "../sunrise/inbox-copy";
import { OperationList } from "./review";

const d = inboxCopy.detail;
type Kind = "uncertain" | "failed" | "settled" | null;
const kindOf = (view: OperationDetailView): Kind => {
  const s = view.operation.status;
  if (s === "uncertain" || s === "cancel_requested") return "uncertain";
  if (s === "failed" || s === "conflict") return "failed";
  return "settled";
};
const titles = {
  uncertain: d.uncertainTitle,
  failed: d.failedTitle,
  settled: d.settledTitle,
} as const;
const bodies = {
  uncertain: d.uncertainBody,
  failed: d.failedBody,
  settled: d.settledBody,
} as const;

function Result({
  ws,
  view,
  onChanged,
}: {
  readonly ws: Id;
  readonly view: OperationDetailView;
  readonly onChanged: () => void;
}) {
  const o = view.operation;
  const last = view.readbacks[0] ?? null;
  return (
    <section className="card" aria-labelledby="exception-result-title">
      <div className="card-head">
        <h2 id="exception-result-title">{d.resultTitle}</h2>
      </div>
      <p className="muted">
        {d.product} <RecordText>{o.productId}</RecordText>
      </p>
      <OperationList ws={ws} operations={[o]} onChanged={onChanged} testId="exception-operation" />
      <p className="muted">
        {d.checks(view.readbacks.length)}
        {last ? ` ${d.lastCheck(inboxDate(last.observedAt))}` : ""}
      </p>
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
  const kind = detail.kind === "ok" ? kindOf(detail.value) : null;
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
        <Result ws={ws} view={detail.value} onChanged={reload} />
      ) : (
        outcomeState(detail, reload)
      )}
    </div>
  );
}
