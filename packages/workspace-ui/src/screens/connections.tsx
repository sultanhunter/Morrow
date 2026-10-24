// Connections (M2 PR-2; P09.T02a; the M2 brief, flow 4). `/w/:ws/connections` lists the
// workspace's store installations and the install-link offer, and finishes a link when the
// page was opened with an install continuation; `/w/:ws/connections/:connectionId` shows one
// installation. The server decides everything: who sees the install link, whether the
// continuation, session, grant and subscription allow a link, and the link itself. This
// screen shows those decisions. The continuation stays in memory (the app holds it), and
// preview, apply and status reuse its one command key, so a retry or a Check again is the
// same request and never a second link. The installation's page also holds "Disconnect
// store", the person's kill switch for the whole store: shown only when the server's kernel
// allows it, with a recorded reason, and a note that reconnecting needs a new install.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { copy } from "../copy";
import type {
  ConnectionDisconnectView,
  DisconnectResultView,
  Id,
  InstallLinkView,
  StoreConnectionView,
  StoreLinkPreviewView,
  WorkspaceView,
} from "../model";
import type { Command, Outcome, StoreLinkHandoff } from "../port";
import { useCommand, useDirty, useRead, useServices } from "../services";
import { useConnections } from "../workspace-data";
import { Button, Dialog, RouteLink, TextArea } from "../components/controls";
import { RecordText, StatusTag, Time } from "../components/display";
import { OutcomeNotice, StateView, StatusRegion, outcomeState } from "../components/feedback";
import { ListingsAgentCard } from "./agents";
import { CommandFeedback } from "./entry";

// The registered install link: https on Shopify's admin or a myshopify host only. The
// decoder checks the same shape; this is the last check before an href is rendered.
const installUrlPattern =
  /^https:\/\/(admin\.shopify\.com|[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com)\/[!-~]+$/;
const scopeLabel = (scope: string) =>
  Object.hasOwn(copy.connections.scopeLabels, scope) ? copy.connections.scopeLabels[scope]! : scope;

type LinkResult =
  | "linked"
  | "denied"
  | "expired"
  | "route"
  | "refused"
  | "conflict"
  | "not_in_build"
  | "dismissed";
type LinkStep =
  | { readonly step: "previewing" }
  | { readonly step: "preview_failed"; readonly uncertain: boolean; readonly offline: boolean }
  | {
      readonly step: "confirm";
      readonly preview: StoreLinkPreviewView;
      readonly notice: "not_linked_yet" | "not_saved" | null;
    }
  | { readonly step: "applying"; readonly preview: StoreLinkPreviewView }
  | {
      readonly step: "uncertain";
      readonly preview: StoreLinkPreviewView;
      readonly checking: boolean;
    }
  | { readonly step: "done"; readonly result: LinkResult };

/** The link step of one install continuation: preview, then the person's Link click. */
function LinkStore({
  ws,
  handoff,
  installations,
  onSettled,
  onLinked,
  onDismissed,
}: {
  readonly ws: Id;
  readonly handoff: StoreLinkHandoff;
  readonly installations: readonly StoreConnectionView[];
  /** The continuation is spent (or set aside): the app forgets it. */
  readonly onSettled: () => void;
  readonly onLinked: () => void;
  /** "Not now": the step closes. */
  readonly onDismissed: () => void;
}) {
  const services = useServices();
  const titleId = useId();
  const command = useRef<Command<{ handoffToken: string }>>({
    key: handoff.key,
    body: { handoffToken: handoff.token },
  });
  const [step, setStep] = useState<LinkStep>({ step: "previewing" });
  const live = useRef(true);
  const latest = useRef({ onSettled, onLinked, onDismissed });
  latest.current = { onSettled, onLinked, onDismissed };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const run = useCallback(
    <T,>(send: () => Promise<Outcome<T>>) => services.runCommand(command.current, null, send),
    [services],
  );
  const finish = useCallback(
    (result: LinkResult) => {
      services.releaseCommand(command.current.key);
      latest.current.onSettled();
      if (live.current) setStep({ step: "done", result });
      if (result === "linked") latest.current.onLinked();
      if (result === "dismissed") latest.current.onDismissed();
    },
    [services],
  );
  const preview = useCallback(async () => {
    setStep({ step: "previewing" });
    const outcome = await run(() => services.port.storeLinks.preview(ws, command.current));
    if (!live.current) return;
    switch (outcome.kind) {
      case "ok":
        // A preview joined to an apply still in flight under the same key (a remount
        // mid-apply) answers that apply's reply: check again once it settles.
        return typeof outcome.value.csrfToken === "string" &&
          typeof outcome.value.installationId === "string"
          ? setStep({ step: "confirm", preview: outcome.value, notice: null })
          : setStep({ step: "preview_failed", uncertain: true, offline: false });
      case "not_found":
        return finish("expired");
      case "conflict":
        // The preview's only 409: the workspace has no fixed morrow_direct route.
        return finish("route");
      case "denied":
      case "invalid":
        return finish("refused");
      case "not_in_build":
        return finish("not_in_build");
      case "unauthenticated":
        return; // the app ends the session view
      case "uncertain":
        return setStep({ step: "preview_failed", uncertain: true, offline: false });
      case "unavailable":
        return setStep({ step: "preview_failed", uncertain: false, offline: outcome.offline });
      default:
        return setStep({ step: "preview_failed", uncertain: false, offline: false });
    }
  }, [services, ws, run, finish]);
  // A recorded decision ends the continuation; a status 404 means nothing was recorded, so
  // the same link can be sent again with the same key.
  const settle = useCallback(
    (outcome: Outcome<{ readonly outcome: "applied" | "denied" }>, p: StoreLinkPreviewView) => {
      if (!live.current) return;
      switch (outcome.kind) {
        case "ok":
          return finish(outcome.value.outcome === "applied" ? "linked" : "denied");
        case "not_found":
          return finish("expired");
        case "conflict":
          return finish("conflict");
        case "denied":
        case "invalid":
          return finish("refused");
        case "not_in_build":
          return finish("not_in_build");
        case "unauthenticated":
          return;
        case "uncertain":
          return setStep({ step: "uncertain", preview: p, checking: false });
        default:
          return setStep({ step: "confirm", preview: p, notice: "not_saved" });
      }
    },
    [finish],
  );
  const apply = useCallback(
    async (p: StoreLinkPreviewView) => {
      setStep({ step: "applying", preview: p });
      settle(await run(() => services.port.storeLinks.apply(ws, command.current, p.csrfToken)), p);
    },
    [services, ws, run, settle],
  );
  const check = useCallback(
    async (p: StoreLinkPreviewView) => {
      setStep({ step: "uncertain", preview: p, checking: true });
      const outcome = await run(() => services.port.storeLinks.status(ws, command.current));
      if (outcome.kind === "not_found") {
        if (live.current) setStep({ step: "confirm", preview: p, notice: "not_linked_yet" });
        return;
      }
      settle(outcome, p);
    },
    [services, ws, run, settle],
  );
  // One preview per mounted continuation (a StrictMode double effect sends one request;
  // a remount sends the same key again, which the server answers as the same handoff).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void preview();
  }, [preview]);

  if (step.step === "done" && step.result === "dismissed") return null;
  const shopOf = (installationId: Id) =>
    installations.find((i) => i.installationId === installationId)?.shopDomain ?? null;
  let body: ReactNode;
  switch (step.step) {
    case "previewing":
      body = <StateView kind="loading" compact message={copy.connections.checking} />;
      break;
    case "preview_failed":
      body = step.uncertain ? (
        <OutcomeNotice kind="uncertain" onAction={() => void preview()} />
      ) : (
        <StateView
          kind={step.offline ? "offline" : "unavailable"}
          compact
          onRetry={() => void preview()}
        />
      );
      break;
    case "confirm":
    case "applying": {
      const shop = shopOf(step.preview.installationId);
      const busy = step.step === "applying";
      const p = step.preview;
      body = (
        <>
          <p dir="auto" className="reading">
            {shop ? copy.connections.confirm(shop) : copy.connections.confirmUnknownShop}
          </p>
          <p className="muted">{copy.connections.confirmBody}</p>
          {step.step === "confirm" && step.notice === "not_linked_yet" ? (
            <p role="status">{copy.connections.notLinkedYet}</p>
          ) : null}
          {step.step === "confirm" && step.notice === "not_saved" ? (
            <OutcomeNotice kind="not_saved" onAction={() => void apply(p)} />
          ) : null}
          <div className="form-actions">
            <Button variant="primary" disabled={busy} onClick={() => void apply(p)}>
              {busy ? copy.connections.linking : copy.connections.link}
            </Button>
            <Button variant="quiet" disabled={busy} onClick={() => finish("dismissed")}>
              {copy.connections.notNow}
            </Button>
          </div>
        </>
      );
      break;
    }
    case "uncertain": {
      const p = step.preview;
      body = <OutcomeNotice kind="uncertain" busy={step.checking} onAction={() => void check(p)} />;
      break;
    }
    case "done":
      body =
        step.result === "linked" ? (
          <StatusRegion message={copy.connections.linked} />
        ) : step.result === "not_in_build" ? (
          <StateView kind="not_in_build" compact />
        ) : step.result === "route" ? (
          <div role="status" className="notice notice-warning">
            <p className="notice-title">{copy.connections.routeRequired}</p>
            <p>{copy.connections.routeRequiredBody}</p>
          </div>
        ) : (
          <div
            role="status"
            className={step.result === "expired" ? "notice notice-warning" : "notice notice-danger"}
          >
            <p>
              {step.result === "expired"
                ? copy.connections.linkExpired
                : step.result === "conflict"
                  ? copy.connections.linkConflict
                  : step.result === "denied"
                    ? copy.connections.linkDenied
                    : copy.connections.linkRefused}
            </p>
          </div>
        );
      break;
  }
  return (
    <section className="panel action-block" aria-labelledby={titleId}>
      <h2 id={titleId}>{copy.connections.linkTitle}</h2>
      {body}
    </section>
  );
}

// An unlinked store's next step: reopen from Shopify, or, for a reader who cannot link
// (the install link is not_permitted), the owner's.
function finishCopy(offer: InstallLinkView): string {
  return offer.reason === "not_permitted"
    ? copy.connections.finishByOwner
    : copy.connections.finishFromShopify;
}

function InstallOffer({ offer }: { readonly offer: InstallLinkView }) {
  const titleId = useId();
  if (offer.reason === "linked") return null;
  const url =
    offer.offered && offer.url !== null && installUrlPattern.test(offer.url) ? offer.url : null;
  return (
    <section className="panel" aria-labelledby={titleId}>
      <h2 id={titleId}>{copy.connections.installTitle}</h2>
      {url !== null ? (
        <>
          <p>{copy.connections.installOffered}</p>
          <p>
            <a
              className="button button-primary"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {copy.connections.installLink}
            </a>
          </p>
          <p className="muted small">{copy.connections.installLinkNote}</p>
        </>
      ) : offer.reason === "offered" ? (
        <p>{copy.connections.installReason.not_registered}</p>
      ) : (
        <p>{copy.connections.installReason[offer.reason]}</p>
      )}
    </section>
  );
}

export function ConnectionsScreen({
  workspace,
  handoff,
  onHandoffSettled,
}: {
  readonly workspace: WorkspaceView;
  /** The install continuation this page was opened with, if any (memory only). */
  readonly handoff: StoreLinkHandoff | null;
  readonly onHandoffSettled: () => void;
}) {
  const ws = workspace.id;
  const titleId = useId();
  // Read once per mount and on Retry or a link: a background re-read that failed would
  // drop the shop name from the link step's confirm line while its outcome is unknown.
  const [list, reload] = useConnections(ws, "mount");
  // Held for this screen's life, so the link step's result stays shown after the app
  // forgets the continuation.
  const [linking] = useState(handoff);
  const [linkOpen, setLinkOpen] = useState(handoff !== null);
  // While a link step is undecided, the install link would only distract from it.
  const [linkSettled, setLinkSettled] = useState(false);
  const installations = list.kind === "ok" ? list.value.installations : [];
  const unlinked = installations.some((i) => i.status === "unlinked");
  return (
    <div className="page">
      <header className="page-header">
        <h1>{copy.connections.title}</h1>
      </header>
      {linking && linkOpen ? (
        <LinkStore
          ws={ws}
          handoff={linking}
          installations={installations}
          onSettled={() => {
            setLinkSettled(true);
            onHandoffSettled();
          }}
          onLinked={reload}
          onDismissed={() => setLinkOpen(false)}
        />
      ) : null}
      <section className="panel" aria-labelledby={titleId}>
        <h2 id={titleId}>{copy.connections.storesTitle}</h2>
        {list.kind !== "ok" ? (
          outcomeState(list, reload)
        ) : installations.length ? (
          <>
            <ul className="item-list">
              {installations.map((i) => (
                <li key={i.connectionId} className="item">
                  <RouteLink
                    route="connection"
                    params={{ workspaceId: ws, connectionId: i.connectionId }}
                    className="item-link"
                  >
                    <RecordText>{i.shopDomain}</RecordText>
                  </RouteLink>
                  <StatusTag family="installation" status={i.status} />
                </li>
              ))}
            </ul>
            {unlinked && (!linkOpen || linkSettled) ? (
              <p className="muted">{finishCopy(list.value.installLink)}</p>
            ) : null}
          </>
        ) : (
          <StateView kind="empty" message={copy.connections.noStores} />
        )}
      </section>
      {list.kind === "ok" && (!linkOpen || linkSettled) ? (
        <InstallOffer offer={list.value.installLink} />
      ) : null}
    </div>
  );
}

// "Disconnect store" (ADR-0022 item 15; ADR-0005): the person's kill switch for the whole
// store. The person writes a reason, which is recorded with the stop; the server's kernel
// decides who may (the button shows only when it said so), and the dialog says exactly
// what happens and that reconnecting needs a new install.
function DisconnectDialog({
  ws,
  connectionId,
  onDone,
  onCancel,
}: {
  readonly ws: Id;
  readonly connectionId: Id;
  readonly onDone: (result: DisconnectResultView) => void;
  readonly onCancel: () => void;
}) {
  const services = useServices();
  const [reason, setReason] = useState("");
  useDirty(reason.trim() !== "");
  const disconnect = useCommand<{ reason: string }, DisconnectResultView>({
    marker: { workspaceId: ws, kind: "disconnect" },
    send: (c) => services.port.connections.disconnect(ws, connectionId, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") onDone(outcome.value);
    },
  });
  const valid = reason.trim() !== "" && reason.length <= 1024;
  const d = copy.connections.disconnect;
  return (
    <Dialog
      open
      title={d.dialogTitle}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabled={disconnect.busy}>
            {d.cancel}
          </Button>
          <Button
            variant="secondary"
            disabled={!valid || disconnect.busy}
            onClick={() => void disconnect.submit({ reason })}
          >
            {d.confirm}
          </Button>
        </>
      }
    >
      <ul className="item-list" data-testid="disconnect-effects">
        {d.dialogBody.map((line) => (
          <li key={line} className="item">
            {line}
          </li>
        ))}
      </ul>
      <p>{d.reconnectNote}</p>
      <TextArea
        label={d.reason}
        hint={d.reasonHint}
        value={reason}
        onChange={setReason}
        maxLength={1024}
        required
      />
      <CommandFeedback
        phase={disconnect.phase}
        onCheckAgain={disconnect.checkAgain}
        onRetry={disconnect.retry}
        success={d.done}
        messages={{ denied: d.notPermitted }}
      />
    </Dialog>
  );
}

/** The connection's "Disconnect store" card: its state and, when allowed, the button. */
function DisconnectStoreCard({
  ws,
  connectionId,
  onDisconnected,
}: {
  readonly ws: Id;
  readonly connectionId: Id;
  readonly onDisconnected: () => void;
}) {
  const services = useServices();
  const titleId = useId();
  const [status, reload] = useRead<ConnectionDisconnectView>(
    `${ws}|connections.disconnect|${connectionId}`,
    () => services.port.connections.disconnectStatus(ws, connectionId),
  );
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<DisconnectResultView | null>(null);
  const d = copy.connections.disconnect;
  let body: ReactNode;
  if (status.kind !== "ok") body = outcomeState(status, reload, { compact: true });
  else {
    const view = status.value;
    body = (
      <>
        {view.stop !== null ? (
          <>
            <p>{view.stop.setBy === "human" ? d.byPerson : d.bySystem}</p>
            <p className="muted">{d.reconnectNote}</p>
          </>
        ) : view.actions.disconnect ? (
          <>
            <p>{d.intro}</p>
            <div className="item-actions">
              <Button variant="secondary" onClick={() => setOpen(true)}>
                {d.button}
              </Button>
            </div>
          </>
        ) : view.installationStatus === "linked" ? (
          <p className="muted">{d.notPermitted}</p>
        ) : null}
      </>
    );
  }
  return (
    <section className="panel" aria-labelledby={titleId}>
      <h2 id={titleId}>{d.title}</h2>
      {body}
      {done !== null ? (
        <StatusRegion message={`${d.done} ${d.credential[done.credential] ?? ""}`.trim()} />
      ) : null}
      {open ? (
        <DisconnectDialog
          ws={ws}
          connectionId={connectionId}
          onCancel={() => setOpen(false)}
          onDone={(result) => {
            setOpen(false);
            setDone(result);
            reload();
            onDisconnected();
          }}
        />
      ) : null}
    </section>
  );
}

export function ConnectionScreen({
  workspace,
  connectionId,
}: {
  readonly workspace: WorkspaceView;
  readonly connectionId: Id;
}) {
  const ws = workspace.id;
  // Read once per mount and on Retry: a background re-read that failed would unmount the
  // Listings card, and an enable's in-flight or unknown outcome (and Check again) with it.
  const [list, reload] = useConnections(ws, "mount");
  // A disconnect remounts the agent card, so it reads the connection stop at once.
  const [generation, setGeneration] = useState(0);
  const installation =
    list.kind === "ok"
      ? (list.value.installations.find((i) => i.connectionId === connectionId) ?? null)
      : null;
  return (
    <div className="page">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <RouteLink route="connections" params={{ workspaceId: ws }}>
          {copy.connections.back}
        </RouteLink>
      </nav>
      <header className="page-header">
        <h1>{copy.connections.detailTitle}</h1>
      </header>
      {list.kind !== "ok" ? (
        outcomeState(list, reload)
      ) : installation === null ? (
        <StateView kind="not_found" />
      ) : (
        <article className="panel">
          <dl className="facts">
            <div>
              <dt>{copy.connections.shop}</dt>
              <dd>
                <RecordText>{installation.shopDomain}</RecordText>
              </dd>
            </div>
            <div>
              <dt>{copy.connections.status}</dt>
              <dd>
                <StatusTag family="installation" status={installation.status} />
              </dd>
            </div>
            <div>
              <dt>{copy.connections.scopes}</dt>
              <dd>{installation.grantedScopes.map(scopeLabel).join(", ")}</dd>
            </div>
            <div>
              <dt>{copy.connections.updated}</dt>
              <dd>
                <Time value={installation.updatedAt} />
              </dd>
            </div>
          </dl>
          {Object.hasOwn(copy.connections.statusHelp, installation.status) ? (
            <p>{copy.connections.statusHelp[installation.status]}</p>
          ) : null}
          {installation.status === "unlinked" ? (
            <p className="muted">{finishCopy(list.value.installLink)}</p>
          ) : null}
        </article>
      )}
      {/* "Disconnect store": a connection that was linked here (the server decides who may). */}
      {installation !== null && installation.status !== "unlinked" ? (
        <DisconnectStoreCard
          ws={ws}
          connectionId={connectionId}
          onDisconnected={() => {
            reload();
            setGeneration((g) => g + 1);
          }}
        />
      ) : null}
      {/* M3 PR-1: the Listings agent of this connection's store (Enable, resume and Stop AI
          work); the server decides what the person may do. */}
      {installation !== null && installation.storeId !== null ? (
        <ListingsAgentCard
          key={`${installation.storeId}|${generation}`}
          workspace={workspace}
          storeId={installation.storeId}
        />
      ) : null}
    </div>
  );
}
