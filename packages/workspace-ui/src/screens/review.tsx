// v1 PR 3: the review screen (/w/:ws/review/:proposalId) and the task's apply history.
// Each product shows before and after per field as plain text (a description's HTML is
// shown as its source, never rendered), tag changes and the reviewer flags. The person
// approves all, approves a selection (which first previews the selection's own exact digest)
// or rejects; an approval binds that exact digest, and any other change needs a new proposal.
// Apply claims exactly that approval; the server checks permission, stops, plan and the
// product again, writes each product once and reads it back. Every decision is the server's:
// this screen only sends the exact refs it read.
import { useState, type FormEvent } from "react";
import { copy } from "../copy";
import type {
  ApplyResultView,
  FieldChangeView,
  Id,
  OperationView,
  ProductReviewView,
  RecordRefView,
  ReviewDecidedView,
  ReviewDecisionBody,
  ReviewView,
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
        <label className="checkbox">
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

/** Each product's apply result; an uncertain one can be read back again. */
export function OperationList({
  ws,
  operations,
  onChanged,
  testId,
}: {
  readonly ws: Id;
  readonly operations: readonly OperationView[];
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
          {o.status === "uncertain" ? (
            <Recheck ws={ws} operationId={o.operationId} onChanged={onChanged} />
          ) : null}
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
          {r.proposal.taskId ? (
            <RouteLink route="task" params={{ workspaceId: ws, taskId: r.proposal.taskId }}>
              {copy.review.taskLink}
            </RouteLink>
          ) : null}
        </p>
      </header>
      {blocked ? (
        <div role="status" className="notice notice-warning">
          <p>{blocked}</p>
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
    <OperationList
      ws={ws}
      operations={operations.value}
      onChanged={reload}
      testId="task-operations"
    />
  );
}
