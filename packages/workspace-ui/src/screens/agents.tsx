// M3 PR-1: the Listings agent card of one connected store (ADR-0022 item 3 and its
// 2026-10-20 amendment; item 15), on M2 PR-2's connection detail screen
// (/w/:ws/connections/:connectionId) for that connection's store.
//   * Enable (and resume after the owner's own "Stop AI work") is two steps: the server
//     builds the installation document (agent version, permissions on this store, product
//     fields), the person reviews exactly that, and Confirm sends its digest and its
//     single-use nonce. Nothing the browser holds can widen what the agent gets.
//   * "Stop AI work" needs a reason the person writes; it is recorded with the stop.
//   * Every button shows only when the server's kernel said this person may use it.
//   * A review that expired or was already used stays open with that message and a
//     "Start again" action; it never closes silently.
//   * A platform or connection stop shows as Paused (only its own path lifts it).
import { useState } from "react";
import { copy } from "../copy";
import type { Id, ListingsChangeView, ListingsDocumentView, WorkspaceView } from "../model";
import { useCommand, useDirty, useRead, useServices } from "../services";
import { Button, Dialog, TextArea } from "../components/controls";
import { Tag, Time } from "../components/display";
import { outcomeState } from "../components/feedback";
import { CommandFeedback } from "./entry";

function DocumentReview({
  ws,
  storeId,
  document,
  onDone,
  onCancel,
}: {
  readonly ws: Id;
  readonly storeId: Id;
  readonly document: ListingsDocumentView;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const services = useServices();
  const confirm = useCommand<{ documentDigest: string; nonce: string }, ListingsChangeView>({
    marker: { workspaceId: ws, kind: "agent" },
    send: (c) => services.port.agents.listingsEnable(ws, storeId, c),
    onOutcome: (outcome) => {
      // A conflict (the review expired, was used, or no longer matches) keeps the dialog
      // open with its message until the person starts again.
      if (outcome.kind === "ok") onDone();
    },
  });
  const enable = document.purpose === "enable";
  const stale = confirm.phase.phase === "settled" && confirm.phase.outcome.kind === "conflict";
  return (
    <Dialog
      open
      title={copy.agents.reviewTitle(document.purpose)}
      onClose={stale ? onDone : onCancel}
      footer={
        stale ? (
          <Button variant="primary" data-initial-focus onClick={onDone}>
            {copy.agents.startAgain}
          </Button>
        ) : (
          <>
            <Button onClick={onCancel} disabled={confirm.busy}>
              {copy.agents.cancel}
            </Button>
            <Button
              variant="primary"
              data-initial-focus
              disabled={confirm.busy}
              onClick={() =>
                void confirm.submit({
                  documentDigest: document.documentDigest,
                  nonce: document.nonce,
                })
              }
            >
              {enable ? copy.agents.confirmEnable : copy.agents.confirmResume}
            </Button>
          </>
        )
      }
    >
      <p>{copy.agents.reviewIntro}</p>
      <p className="meta">{copy.agents.version(document.releaseRevision)}</p>
      <h3>{copy.agents.permissions}</h3>
      <ul className="item-list" data-testid="listings-grants">
        {document.grants.map((g) => (
          <li key={g.capabilityId} className="item">
            {copy.agents.capabilities[g.capabilityId] ?? g.capabilityId}
          </li>
        ))}
      </ul>
      <h3>{copy.agents.fields}</h3>
      <p>{document.fields.map((f) => copy.agents.fieldLabels[f] ?? f).join(", ")}</p>
      <p className="muted small">
        {copy.agents.expires} <Time value={document.expiresAt} />
      </p>
      <CommandFeedback
        phase={confirm.phase}
        onCheckAgain={confirm.checkAgain}
        onRetry={confirm.retry}
        success={enable ? copy.agents.enabled : copy.agents.resumed}
        messages={{ conflict: () => copy.agents.expired }}
      />
    </Dialog>
  );
}

function StopDialog({
  ws,
  storeId,
  onDone,
  onCancel,
}: {
  readonly ws: Id;
  readonly storeId: Id;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const services = useServices();
  const [reason, setReason] = useState("");
  useDirty(reason.trim() !== "");
  const stop = useCommand<{ reason: string }, ListingsChangeView>({
    marker: { workspaceId: ws, kind: "agent" },
    send: (c) => services.port.agents.listingsStop(ws, storeId, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") onDone();
    },
  });
  const valid = reason.trim() !== "" && reason.length <= 1024;
  return (
    <Dialog
      open
      title={copy.agents.stopTitle}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabled={stop.busy}>
            {copy.agents.cancel}
          </Button>
          <Button
            variant="secondary"
            disabled={!valid || stop.busy}
            onClick={() => void stop.submit({ reason })}
          >
            {copy.agents.confirmStop}
          </Button>
        </>
      }
    >
      <p>{copy.agents.stopIntro}</p>
      <TextArea
        label={copy.agents.reason}
        hint={copy.agents.reasonHint}
        value={reason}
        onChange={setReason}
        maxLength={1024}
        required
      />
      <CommandFeedback
        phase={stop.phase}
        onCheckAgain={stop.checkAgain}
        onRetry={stop.retry}
        success={copy.agents.stoppedDone}
      />
    </Dialog>
  );
}

/** The Listings agent card of one store: status, Enable or resume, and Stop AI work. */
export function ListingsAgentCard({
  workspace,
  storeId,
}: {
  readonly workspace: WorkspaceView;
  readonly storeId: Id;
}) {
  const services = useServices();
  const ws = workspace.id;
  const [status, reload] = useRead(`${ws}|agents.listings|${storeId}`, () =>
    services.port.agents.listingsStatus(ws, storeId),
  );
  const [review, setReview] = useState<ListingsDocumentView | null>(null);
  const [stopping, setStopping] = useState(false);
  const prepare = useCommand<Record<string, never>, ListingsDocumentView>({
    marker: null,
    send: (c) => services.port.agents.listingsDocument(ws, storeId, c),
    onOutcome: (outcome, sent) => {
      if (outcome.kind === "ok" && sent.current) setReview(outcome.value);
      if (outcome.kind === "conflict") reload();
    },
  });
  const done = () => {
    setReview(null);
    setStopping(false);
    prepare.reset();
    reload();
  };
  const body = (() => {
    if (status.kind !== "ok") return outcomeState(status, reload, { compact: true });
    const view = status.value;
    const installation = view.installation;
    return (
      <>
        <p className="meta">
          {installation === null ? (
            <Tag tone="neutral">{copy.agents.disabled}</Tag>
          ) : installation.stopped ? (
            <Tag tone="warning">{copy.agents.stopped}</Tag>
          ) : view.blocked ? (
            <Tag tone="warning">{copy.agents.blocked}</Tag>
          ) : installation.status === "active" ? (
            <Tag tone="success">{copy.agents.active}</Tag>
          ) : (
            <Tag tone="neutral">{copy.agents.disabled}</Tag>
          )}
        </p>
        {installation === null ? <p>{copy.agents.notEnabled}</p> : null}
        {view.blocked && installation !== null ? (
          <p className="muted">{copy.agents.blockedDetail}</p>
        ) : null}
        {!view.linked ? <p className="muted">{copy.agents.notLinked}</p> : null}
        <div className="item-actions">
          {view.actions.enable || view.actions.resume ? (
            <Button
              variant="primary"
              disabled={prepare.busy}
              onClick={() => void prepare.submit({})}
            >
              {prepare.busy
                ? copy.agents.preparing
                : view.actions.enable
                  ? copy.agents.enable
                  : copy.agents.resume}
            </Button>
          ) : null}
          {view.actions.stop && installation !== null && !installation.stopped ? (
            <Button variant="secondary" onClick={() => setStopping(true)}>
              {copy.agents.stop}
            </Button>
          ) : null}
        </div>
        <CommandFeedback
          phase={prepare.phase}
          onCheckAgain={prepare.checkAgain}
          onRetry={prepare.retry}
          messages={{ conflict: (o) => o.message || copy.agents.expired }}
        />
      </>
    );
  })();
  return (
    <section className="panel" aria-labelledby={`listings-agent-${storeId}`}>
      <div className="panel-head">
        <h2 id={`listings-agent-${storeId}`}>{copy.agents.listingsTitle}</h2>
      </div>
      <p>{copy.agents.listingsIntro}</p>
      {body}
      {review ? (
        <DocumentReview
          ws={ws}
          storeId={storeId}
          document={review}
          onDone={done}
          onCancel={() => {
            setReview(null);
            prepare.reset();
          }}
        />
      ) : null}
      {stopping ? (
        <StopDialog ws={ws} storeId={storeId} onDone={done} onCancel={() => setStopping(false)} />
      ) : null}
    </section>
  );
}
