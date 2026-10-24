// v1 PR 3: the review screen (/w/:ws/review/:proposalId) and the task's apply history.
// Each product shows before and after per field as plain text (a description's HTML is
// shown as its source, never rendered), tag changes and the reviewer flags. The person
// approves all, approves a selection (which first previews the selection's own exact digest)
// or rejects; an approval binds that exact digest, and any other change needs a new proposal.
// Apply claims exactly that approval; the server checks permission, stops, plan and the
// product again, writes each product once and reads it back. Every decision is the server's:
// this screen only sends the exact refs it read.
// v1 PR 4: Undo on each applied change in the task's history (a NEW change back to the values
// read before it, reviewed and approved like any other; the server decides when it is
// offered), the undo's own review says what it undoes, and "Approve several at once": one
// confirmation of the server-built document of the changes waiting on this task, all or none.
import { useState, type FormEvent } from "react";
import { copy } from "../copy";
import type {
  ApplyResultView,
  BatchDecidedView,
  BatchDecisionBody,
  BatchDocumentView,
  FieldChangeView,
  HistoryOperationView,
  Id,
  OperationView,
  ProductReviewView,
  RecordRefView,
  ReviewDecidedView,
  ReviewDecisionBody,
  ReviewView,
  UndoRequestedView,
  WorkspaceView,
} from "../model";
import { useCommand, useDirty, useRead, useServices } from "../services";
import { Button, RouteLink, TextField } from "../components/controls";
import { RecordText, StatusTag, Time } from "../components/display";
import { StateView, outcomeState } from "../components/feedback";
import { CommandFeedback } from "./entry";

const fieldLabel = (field: string) => copy.review.fields[field] ?? field;
const valueText = (value: string | readonly string[] | null) =>
  value === null ? copy.review.empty : typeof value === "string" ? value : value.join(", ");

/** The shown text of one operation's result: its status, and why when it was not applied. */
export function operationNote(o: OperationView): string | null {
  if (o.status === "cancel_requested") return copy.review.setAsideNote;
  if (o.status === "uncertain")
    return (o.reason !== null ? copy.review.reasons[o.reason] : undefined) ?? copy.review.uncertain;
  if (o.status === "failed" || o.status === "conflict")
    return (o.reason !== null ? copy.review.reasons[o.reason] : undefined) ?? null;
  return null;
}

function FieldRow({ change }: { readonly change: FieldChangeView }) {
  return (
    <tr>
      <th scope="row">{fieldLabel(change.field)}</th>
      <td>
        <RecordText as="div" className="review-value">
          {valueText(change.before)}
        </RecordText>
      </td>
      <td>
        <RecordText as="div" className="review-value">
          {valueText(change.after)}
        </RecordText>
      </td>
    </tr>
  );
}

function ProductCard({
  product,
  selectable,
  selected,
  onToggle,
}: {
  readonly product: ProductReviewView;
  readonly selectable: boolean;
  readonly selected: boolean;
  readonly onToggle: () => void;
}) {
  const flags = product.flags ? copy.runs.flags(product.flags) : "";
  const headingId = `review-product-${product.targetIndex}`;
  return (
    <li className="item item-stacked" aria-labelledby={headingId}>
      <h3 id={headingId}>
        <RecordText>{product.productId}</RecordText>
      </h3>
      {selectable ? (
        <label className="check">
          <input type="checkbox" checked={selected} onChange={onToggle} />
          {copy.review.include(product.productId)}
        </label>
      ) : null}
      {product.source === "expired" ? <p className="muted">{copy.review.expired}</p> : null}
      {flags ? (
        <p className="notice notice-warning">
          {copy.review.flagsNotice} {flags}
        </p>
      ) : null}
      <table className="review-table">
        <thead>
          <tr>
            <th scope="col">{copy.review.field}</th>
            <th scope="col">{copy.review.before}</th>
            <th scope="col">{copy.review.after}</th>
          </tr>
        </thead>
        <tbody>
          {product.changes.map((change) => (
            <FieldRow key={change.field} change={change} />
          ))}
        </tbody>
      </table>
      {product.tags && (product.tags.added.length || product.tags.removed.length) ? (
        <dl className="facts">
          {product.tags.added.length ? (
            <div>
              <dt>{copy.review.tagsAdded}</dt>
              <dd>
                <RecordText>{product.tags.added.join(", ")}</RecordText>
              </dd>
            </div>
          ) : null}
          {product.tags.removed.length ? (
            <div>
              <dt>{copy.review.tagsRemoved}</dt>
              <dd>
                <RecordText>{product.tags.removed.join(", ")}</RecordText>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </li>
  );
}

/**
 * Each product's apply result. An uncertain one can be read back again, and the person who
 * applied it can set it aside once they checked it in Shopify (the server decides who may);
 * a set-aside one can still be read back.
 */
export function OperationList({
  ws,
  operations,
  onChanged,
  testId,
}: {
  readonly ws: Id;
  readonly operations: readonly (OperationView | HistoryOperationView)[];
  readonly onChanged: () => void;
  readonly testId?: string;
}) {
  return (
    <ul className="item-list" data-testid={testId}>
      {operations.map((o) => (
        <li key={o.operationId} className="item item-stacked">
          <p>
            <RecordText>{o.productId}</RecordText>
          </p>
          <p className="meta">
            <StatusTag family="operation" status={o.status} />
            <Time value={o.updatedAt} />
          </p>
          {operationNote(o) ? <p className="muted">{operationNote(o)}</p> : null}
          {o.status === "uncertain" || o.status === "cancel_requested" ? (
            <Recheck ws={ws} operationId={o.operationId} onChanged={onChanged} />
          ) : null}
          {o.status === "uncertain" ? (
            <SetAside ws={ws} operationId={o.operationId} onChanged={onChanged} />
          ) : null}
          {"undo" in o ? <UndoLine ws={ws} operation={o} onChanged={onChanged} /> : null}
        </li>
      ))}
    </ul>
  );
}

function Recheck({
  ws,
  operationId,
  onChanged,
}: {
  readonly ws: Id;
  readonly operationId: Id;
  readonly onChanged: () => void;
}) {
  const services = useServices();
  const command = useCommand<Record<string, never>, OperationView>({
    marker: null,
    send: (c) => services.port.review.recheck(ws, operationId, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") onChanged();
    },
  });
  return (
    <div className="item-actions">
      <Button disabled={command.busy} onClick={() => void command.submit({})}>
        {copy.review.checkAgain}
      </Button>
      <CommandFeedback
        phase={command.phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
      />
    </div>
  );
}

function SetAside({
  ws,
  operationId,
  onChanged,
}: {
  readonly ws: Id;
  readonly operationId: Id;
  readonly onChanged: () => void;
}) {
  const services = useServices();
  const command = useCommand<Record<string, never>, OperationView>({
    marker: null,
    send: (c) => services.port.review.setAside(ws, operationId, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") onChanged();
    },
  });
  if (!services.composed["review.setAside"]) return null;
  return (
    <div className="item-actions">
      <p className="muted">{copy.review.setAsideHint}</p>
      <Button disabled={command.busy} onClick={() => void command.submit({})}>
        {copy.review.setAside}
      </Button>
      <CommandFeedback
        phase={command.phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
      />
    </div>
  );
}

/**
 * v1 PR 4: one applied change's undo state in the task's history, as the server reports it.
 * Undo is offered only where the server says it is available; it asks the server to read
 * the product and build a NEW change back to the earlier values, which then waits for
 * approval like any other (nothing is written to the store here).
 */
export function UndoLine({
  ws,
  operation,
  onChanged,
}: {
  readonly ws: Id;
  readonly operation: HistoryOperationView;
  readonly onChanged: () => void;
}) {
  const services = useServices();
  const [made, setMade] = useState<UndoRequestedView | null>(null);
  const command = useCommand<Record<string, never>, UndoRequestedView>({
    marker: null,
    send: (c) => services.port.review.undo(ws, operation.operationId, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") {
        setMade(outcome.value);
        onChanged();
      }
    },
  });
  const u = operation.undo;
  const open = (proposalId: Id) => (
    <RouteLink route="review" params={{ workspaceId: ws, proposalId }} className="text-link">
      {copy.review.undoOpen}
    </RouteLink>
  );
  const of = u.undoOfOperationId !== null ? <p className="muted">{copy.review.undoOf}</p> : null;
  if (made !== null)
    return (
      <div className="item-actions" role="status">
        <p>{copy.review.undoRequested}</p>
        {open(made.proposalId)}
      </div>
    );
  switch (u.state) {
    case "available":
      if (!services.composed["review.undo"] || u.availableUntil === null) return of;
      return (
        <>
          {of}
          <div className="item-actions">
            <p className="muted">
              {copy.review.undoAvailable} <Time value={u.availableUntil} />
            </p>
            <Button disabled={command.busy} onClick={() => void command.submit({})}>
              {copy.review.undo}
            </Button>
            <CommandFeedback
              phase={command.phase}
              onCheckAgain={command.checkAgain}
              onRetry={command.retry}
            />
          </div>
        </>
      );
    case "requested":
    case "undone":
      return (
        <>
          {of}
          <div className="item-actions">
            <p className="muted">
              {u.state === "requested" ? copy.review.undoWaiting : copy.review.undone}
            </p>
            {u.undoProposalId !== null ? open(u.undoProposalId) : null}
          </div>
        </>
      );
    case "changed":
      return (
        <>
          {of}
          <p className="muted">{copy.review.undoChanged}</p>
        </>
      );
    case "unavailable":
      return (
        <>
          {of}
          <p className="muted">{copy.review.undoUnavailable}</p>
        </>
      );
    default:
      return of;
  }
}

/**
 * v1 PR 4: "Approve several at once" (ADR-0024 item 9). The server builds the document of the
 * changes waiting on this task (each one's exact digest and revision, for this person and
 * session, 5 minutes); one confirmation sends it back unchanged and the server approves each
 * of them exactly, or none. A document that is no longer current approves nothing.
 */
export function BatchApprove({
  ws,
  proposalId,
  onDecided,
}: {
  readonly ws: Id;
  readonly proposalId: Id;
  readonly onDecided: (count: number) => void;
}) {
  const services = useServices();
  const [open, setOpen] = useState(false);
  const [document, reload] = useRead<BatchDocumentView>(
    open ? `${ws}|review-batch|${proposalId}` : null,
    () => services.port.review.batch(ws, proposalId),
  );
  const command = useCommand<BatchDecisionBody, BatchDecidedView>({
    marker: null,
    send: (c) => services.port.review.decideBatch(ws, proposalId, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") onDecided(outcome.value.decided.length);
    },
  });
  if (!services.composed["review.batch"] || !services.composed["review.decideBatch"]) return null;
  if (!open)
    return (
      <div className="form-actions">
        <Button onClick={() => setOpen(true)}>{copy.review.batch}</Button>
      </div>
    );
  const close = () => {
    command.reset();
    setOpen(false);
  };
  const settled = command.phase.phase === "settled" ? command.phase.outcome : null;
  return (
    <section className="panel" aria-labelledby="review-batch-title" data-testid="review-batch">
      <h2 id="review-batch-title">{copy.review.batchTitle}</h2>
      {document.kind !== "ok" ? (
        outcomeState(document, reload)
      ) : document.value.unavailable !== null ? (
        <>
          <p className="muted">
            {copy.review.batchUnavailable[document.value.unavailable] ?? copy.states.unavailable}
          </p>
          <div className="form-actions">
            <Button onClick={close}>{copy.review.batchCancel}</Button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">{copy.review.batchIntro}</p>
          <ul className="item-list">
            {document.value.items.map((item) => (
              <li key={item.proposalId} className="item">
                <RouteLink
                  route="review"
                  params={{ workspaceId: ws, proposalId: item.proposalId }}
                  className="text-link"
                >
                  {copy.review.batchItem(item.targetCount)}
                </RouteLink>
                <p className="meta">
                  <RecordText>{item.proposalId}</RecordText>
                  <span>
                    {copy.review.expires} <Time value={item.expiresAt} />
                  </span>
                </p>
              </li>
            ))}
          </ul>
          <p className="meta">
            {copy.review.batchExpires} <Time value={document.value.expiresAt} />
          </p>
          <div className="form-actions">
            <Button
              variant="primary"
              disabled={command.busy || settled?.kind === "ok"}
              onClick={() =>
                void command.submit({
                  documentDigest: document.value.documentDigest,
                  issuedAt: document.value.issuedAt,
                  items: document.value.items.map((i) => ({
                    proposalId: i.proposalId,
                    digest: i.digest,
                    approvalId: i.approvalId,
                    revision: i.revision,
                  })),
                })
              }
            >
              {copy.review.batchConfirm(document.value.items.length)}
            </Button>
            <Button disabled={command.busy} onClick={close}>
              {copy.review.batchCancel}
            </Button>
          </div>
          <CommandFeedback
            phase={command.phase}
            onCheckAgain={command.checkAgain}
            onRetry={command.retry}
          />
          {settled?.kind === "conflict" ? (
            <div className="form-actions">
              <Button
                onClick={() => {
                  command.reset();
                  reload();
                }}
              >
                {copy.states.retry}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function Apply({
  ws,
  proposalId,
  refs,
  onChanged,
}: {
  readonly ws: Id;
  readonly proposalId: Id;
  readonly refs: { readonly proposalRef: RecordRefView; readonly approvalRef: RecordRefView };
  readonly onChanged: () => void;
}) {
  const services = useServices();
  const [result, setResult] = useState<ApplyResultView | null>(null);
  const command = useCommand<
    { readonly proposalRef: RecordRefView; readonly approvalRef: RecordRefView },
    ApplyResultView
  >({
    marker: null,
    send: (c) => services.port.review.apply(ws, proposalId, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") {
        setResult(outcome.value);
        if (outcome.value.pending === 0) onChanged();
      }
    },
  });
  const unavailable =
    command.phase.phase === "settled" && command.phase.outcome.kind === "unavailable";
  return (
    <section className="panel" aria-labelledby="review-apply-title">
      <h2 id="review-apply-title">{copy.review.apply}</h2>
      <p className="muted">{copy.review.applyIntro}</p>
      <div className="form-actions">
        <Button
          variant="primary"
          disabled={command.busy}
          onClick={() =>
            void (result !== null && result.pending > 0 ? command.retry() : command.submit(refs))
          }
        >
          {result !== null && result.pending > 0 ? copy.review.continue : copy.review.apply}
        </Button>
      </div>
      {unavailable ? (
        <div role="status" className="notice notice-warning">
          <p>{copy.review.applyUnavailable}</p>
        </div>
      ) : (
        <CommandFeedback
          phase={command.phase}
          onCheckAgain={command.checkAgain}
          onRetry={command.retry}
        />
      )}
      {result !== null ? (
        <>
          {result.pending > 0 ? <p role="status">{copy.review.pending(result.pending)}</p> : null}
          <h3>{copy.review.results}</h3>
          <OperationList
            ws={ws}
            operations={result.operations}
            onChanged={onChanged}
            testId="review-results"
          />
        </>
      ) : null}
    </section>
  );
}

function Decide({
  ws,
  review,
  selected,
  onDecided,
}: {
  readonly ws: Id;
  readonly review: ReviewView;
  readonly selected: readonly number[];
  readonly onDecided: (decided: ReviewDecidedView) => void;
}) {
  const services = useServices();
  const [phrase, setPhrase] = useState("");
  const [checked, setChecked] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const all = review.products.length;
  const subset = selected.length > 0 && selected.length < all;
  const command = useCommand<ReviewDecisionBody, ReviewDecidedView>({
    marker: null,
    send: (c) => services.port.review.decide(ws, review.proposal.id, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") onDecided(outcome.value);
    },
  });
  useDirty(phrase !== "" || command.busy);
  const confirmation = review.confirmation.required ? phrase : null;
  const phraseValid =
    !review.confirmation.required || phrase.normalize("NFC") === review.confirmation.phrase;
  const revision = review.approval?.revision ?? 1;
  const approve = async (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (!phraseValid || command.busy || selected.length === 0) return;
    let digest = review.proposal.digest;
    let expectedRevision = revision;
    let selection: readonly number[] | null = null;
    if (subset) {
      // A selection binds the derived proposal's own digest: read it first.
      setPreviewing(true);
      const preview = await services.port.review.get(ws, review.proposal.id, selected);
      setPreviewing(false);
      if (preview.kind !== "ok") {
        setPreviewFailed(true);
        return;
      }
      setPreviewFailed(false);
      digest = preview.value.proposal.digest;
      expectedRevision = preview.value.approval?.revision ?? revision;
      selection = [...selected];
    }
    await command.submit({
      decision: "approve",
      selectedTargetIndexes: selection,
      expectedDecisionDigest: digest,
      soloOwnerConfirmation: confirmation,
      expectedRevision,
    });
  };
  const reject = () =>
    void command.submit({
      decision: "reject",
      selectedTargetIndexes: null,
      expectedDecisionDigest: review.proposal.digest,
      soloOwnerConfirmation: null,
      expectedRevision: revision,
    });
  const settled = command.phase.phase === "settled" ? command.phase.outcome : null;
  return (
    <form className="panel" onSubmit={(event) => void approve(event)} noValidate>
      {review.confirmation.required ? (
        <TextField
          label={copy.review.confirmLabel}
          value={phrase}
          onChange={setPhrase}
          hint={copy.review.confirmHint(review.confirmation.phrase)}
          error={checked && !phraseValid ? copy.outcome.invalid : null}
          disabled={command.busy}
          maxLength={256}
          required
        />
      ) : null}
      <div className="form-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={command.busy || previewing || selected.length === 0}
        >
          {subset ? copy.review.approveSome(selected.length) : copy.review.approveAll}
        </Button>
        <Button disabled={command.busy || previewing} onClick={reject}>
          {copy.review.reject}
        </Button>
      </div>
      {previewFailed ? (
        <div role="status" className="notice notice-danger">
          <p>{copy.states.unavailable}</p>
        </div>
      ) : null}
      <CommandFeedback
        phase={command.phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
        {...(settled?.kind === "ok"
          ? {
              success:
                settled.value.status === "rejected" ? copy.review.rejected : copy.review.approved,
            }
          : {})}
      />
    </form>
  );
}

export function ReviewScreen({
  workspace,
  proposalId,
}: {
  readonly workspace: WorkspaceView;
  readonly proposalId: Id;
}) {
  const services = useServices();
  const ws = workspace.id;
  const [review, reload] = useRead(`${ws}|review|${proposalId}`, () =>
    services.port.review.get(ws, proposalId, null),
  );
  const [unselected, setUnselected] = useState<readonly number[]>([]);
  const [decided, setDecided] = useState<ReviewDecidedView | null>(null);
  const [batched, setBatched] = useState<number | null>(null);
  if (review.kind !== "ok") return <div className="page">{outcomeState(review, reload)}</div>;
  const r = review.value;
  const pending = r.approval?.status === "pending";
  const selectable = pending && r.actionable && r.proposal.partialApproval && r.products.length > 1;
  const selected = r.products
    .map((p) => p.targetIndex)
    .filter((index) => !unselected.includes(index));
  // What Apply sends: the approval this screen just recorded (a selection names its derived
  // proposal), or the root's own approval once it is approved.
  const refs =
    decided !== null && decided.status === "approved"
      ? {
          proposalId: decided.proposalRef.id,
          proposalRef: decided.proposalRef,
          approvalRef: decided.approvalRef,
        }
      : r.approval?.status === "approved" && r.approvalRef !== null
        ? { proposalId: r.proposal.id, proposalRef: r.proposalRef, approvalRef: r.approvalRef }
        : null;
  const blocked = r.blocked !== null ? (copy.review.blocked[r.blocked] ?? r.blocked) : null;
  return (
    <div className="page">
      <header className="page-header">
        <h1>{copy.review.title}</h1>
        <p className="muted">{copy.review.intro}</p>
        {r.proposal.untrustedSource ? <p className="muted">{copy.review.untrusted}</p> : null}
        <p className="meta">
          <span>{copy.review.store(r.proposal.storeId)}</span>
          {r.approval ? (
            <span>
              {r.claim !== null && r.approval.status === "approved"
                ? copy.review.approvalClaimed
                : copy.review.approvalStatus(r.approval.status)}
            </span>
          ) : null}
          {pending ? (
            <span>
              {copy.review.expires} <Time value={r.approval!.expiresAt} />
            </span>
          ) : null}
        </p>
        {r.proposal.taskId ? (
          <div className="item-actions">
            <RouteLink
              route="task"
              params={{ workspaceId: ws, taskId: r.proposal.taskId }}
              className="text-link"
            >
              {copy.review.taskLink}
            </RouteLink>
          </div>
        ) : null}
      </header>
      {blocked ? (
        <div role="status" className="notice notice-warning">
          <p>{blocked}</p>
        </div>
      ) : null}
      {r.undoOf !== null ? (
        <div className="notice" data-testid="review-undo-of">
          <p>
            <RecordText>{copy.review.undoBanner(r.undoOf.productId)}</RecordText>
          </p>
          {r.undoOf.appliedAt !== null ? (
            <p className="meta">
              {copy.review.undoBannerApplied} <Time value={r.undoOf.appliedAt} />
            </p>
          ) : null}
        </div>
      ) : null}
      {batched !== null ? (
        <div role="status" className="notice">
          <p>{copy.review.batchApproved(batched)}</p>
        </div>
      ) : null}
      <section className="panel" aria-labelledby="review-products-title">
        <h2 id="review-products-title">{copy.review.productsTitle(r.products.length)}</h2>
        {r.products.length ? (
          <ul className="item-list" data-testid="review-products">
            {r.products.map((product) => (
              <ProductCard
                key={product.targetIndex}
                product={product}
                selectable={selectable}
                selected={!unselected.includes(product.targetIndex)}
                onToggle={() =>
                  setUnselected((list) =>
                    list.includes(product.targetIndex)
                      ? list.filter((i) => i !== product.targetIndex)
                      : [...list, product.targetIndex],
                  )
                }
              />
            ))}
          </ul>
        ) : (
          <StateView kind="empty" message={blocked ?? copy.states.empty} compact />
        )}
      </section>
      {pending && r.actionable && decided === null ? (
        <Decide ws={ws} review={r} selected={selected} onDecided={setDecided} />
      ) : null}
      {pending && r.actionable && decided === null && r.proposal.derivedFromId === null ? (
        <BatchApprove
          ws={ws}
          proposalId={r.proposal.id}
          onDecided={(count) => {
            setBatched(count);
            reload();
          }}
        />
      ) : null}
      {refs !== null && r.actionable && r.claim === null ? (
        <Apply ws={ws} proposalId={refs.proposalId} refs={refs} onChanged={reload} />
      ) : null}
      {r.claim !== null ? (
        <section className="panel" aria-labelledby="review-history-title">
          <h2 id="review-history-title">{copy.review.history}</h2>
          <OperationList
            ws={ws}
            operations={r.claim.operations}
            onChanged={reload}
            testId="review-history"
          />
        </section>
      ) : null}
    </div>
  );
}

/** The task's apply history: every product applied from its proposals, newest first. */
export function AppliedPanel({ ws, taskId }: { readonly ws: Id; readonly taskId: Id }) {
  const services = useServices();
  const [operations, reload] = useRead(`${ws}|task-operations|${taskId}`, () =>
    services.port.review.operationsOfTask(ws, taskId),
  );
  if (operations.kind !== "ok") return <>{outcomeState(operations, reload)}</>;
  if (operations.value.length === 0)
    return <StateView kind="empty" message={copy.review.historyEmpty} />;
  return (
    <>
      {operations.value.some((o) => o.undo.state === "available") &&
      services.composed["review.undo"] ? (
        <p className="muted">{copy.review.undoIntro}</p>
      ) : null}
      <OperationList
        ws={ws}
        operations={operations.value}
        onChanged={reload}
        testId="task-operations"
      />
    </>
  );
}
