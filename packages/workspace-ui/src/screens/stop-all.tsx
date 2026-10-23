// T7 PR 16: "Stop all AI work" on Settings > Activity (the SettingsActivity board; ADR-0005:
// human_only, no second approver; the UX recommendation's 6.3). It is wired to the stop that
// exists: each store's Listings "Stop AI work" (`agents.listingsStop`), one command per store,
// each with its own key, sent at once. So it works in every build that composes the Listings
// agent, and it widens nothing: the server decides who may stop each store, and the screen
// only shows that decision.
//   * The person types the word "stop" first. Agents never see this control.
//   * Each store's outcome shows on its own. A lost reply stays "not confirmed" with Check
//     again (the same key), until a decoded reply says stopped or not; it never reads as
//     stopped. Nothing ran on "unavailable" or "rate limited", so Try again sends the same
//     key again, as one form's command does.
//   * Turning AI work back on is each store's own Resume, which asks for the server's
//     document as Enable does.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Dialog, RouteLink } from "../components/controls";
import { StatusRegion, outcomeState } from "../components/feedback";
import type { Id, ListingsAgentView, ListingsChangeView, StoreConnectionView } from "../model";
import type { Command, Outcome } from "../port";
import { useRead, useServices, type UiServices } from "../services";
import {
  isStopConfirmation,
  stopAllState,
  stopWord,
  type StopAllState,
  type StopTarget,
} from "../team-model";
import { sunriseCopy } from "../sunrise/copy";
import { Badge, SrIcon } from "../sunrise/parts";

const s = sunriseCopy.stop;

/** What stops, read from the existing routes: each store's connection and Listings agent. */
async function readStopAll(services: UiServices, ws: Id): Promise<Outcome<StopAllState>> {
  const list = await services.port.connections.list(ws);
  if (list.kind !== "ok") return list;
  const stores: { connection: StoreConnectionView; listings: ListingsAgentView }[] = [];
  for (const connection of list.value.installations) {
    if (connection.storeId === null) continue;
    const listings = await services.port.agents.listingsStatus(ws, connection.storeId);
    // A store with no Listings agent has nothing to stop.
    if (listings.kind === "not_found") continue;
    // Anything else unreadable: say so, rather than claim there is nothing to stop.
    if (listings.kind !== "ok") return listings;
    stores.push({ connection, listings: listings.value });
  }
  return { kind: "ok", value: stopAllState(stores), replayed: false };
}

export type StopRowPhase =
  | { readonly kind: "sending" }
  | { readonly kind: "checking" }
  | { readonly kind: "uncertain" }
  | { readonly kind: "stopped" }
  | { readonly kind: "not_sent" }
  | { readonly kind: "refused"; readonly message: string };
export interface StopRow {
  readonly target: StopTarget;
  readonly phase: StopRowPhase;
}
// The replies that end a command (its key is released); the rest keep it for the same send.
const terminal = ["ok", "invalid", "denied", "not_found", "conflict", "not_in_build"];

/** One command per store, each keeping its key until a terminal reply (§4.7 to §4.9). */
function useStopAll(ws: Id) {
  const services = useServices();
  const commands = useRef(new Map<Id, Command<{ reason: string }>>());
  const live = useRef(true);
  const [rows, setRows] = useState<readonly StopRow[] | null>(null);
  useEffect(() => {
    live.current = true;
    const held = commands.current;
    return () => {
      live.current = false;
      for (const command of held.values()) services.releaseCommand(command.key);
    };
  }, [services]);
  const set = (storeId: Id, phase: StopRowPhase) =>
    setRows((current) =>
      current === null
        ? current
        : current.map((row) => (row.target.storeId === storeId ? { ...row, phase } : row)),
    );
  const send = useCallback(
    async (target: StopTarget, checking: boolean): Promise<StopRowPhase | null> => {
      let command = commands.current.get(target.storeId);
      if (!command) {
        command = services.newCommand({ reason: s.reason });
        commands.current.set(target.storeId, command);
      }
      const sent = command;
      set(target.storeId, { kind: checking ? "checking" : "sending" });
      const outcome: Outcome<ListingsChangeView> = await services.runCommand(
        sent,
        { workspaceId: ws, kind: "agent" },
        () => services.port.agents.listingsStop(ws, target.storeId, sent),
      );
      if (!live.current) return null;
      if (outcome.kind === "unauthenticated") return null; // the app ends the session view
      if (terminal.includes(outcome.kind)) {
        services.releaseCommand(sent.key);
        if (commands.current.get(target.storeId) === sent) commands.current.delete(target.storeId);
      }
      const phase: StopRowPhase =
        outcome.kind === "ok"
          ? { kind: "stopped" }
          : outcome.kind === "uncertain"
            ? { kind: "uncertain" }
            : outcome.kind === "unavailable" || outcome.kind === "rate_limited"
              ? { kind: "not_sent" }
              : {
                  kind: "refused",
                  message:
                    (outcome.kind === "denied" || outcome.kind === "conflict") && outcome.message
                      ? outcome.message
                      : s.rows.refused,
                };
      set(target.storeId, phase);
      return phase;
    },
    [services, ws],
  );
  const start = useCallback(
    async (targets: readonly StopTarget[]) => {
      setRows(targets.map((target) => ({ target, phase: { kind: "sending" } })));
      const phases = await Promise.all(targets.map((target) => send(target, false)));
      return phases.every((phase) => phase?.kind === "stopped");
    },
    [send],
  );
  const busy =
    rows?.some((r) => r.phase.kind === "sending" || r.phase.kind === "checking") ?? false;
  // An outcome still unknown is settled first: a new dialog shows it, not a fresh stop.
  const unsettled = rows?.some((r) => r.phase.kind === "uncertain") ?? false;
  const clear = useCallback(() => setRows(null), []);
  return { rows, start, send, busy, unsettled, clear } as const;
}

/** Each store's stop and what became of it. */
function StopRows({
  rows,
  onSend,
}: {
  readonly rows: readonly StopRow[];
  readonly onSend: (target: StopTarget, checking: boolean) => void;
}) {
  return (
    <ul className="sr-stop-rows">
      {rows.map(({ target, phase }) => (
        <li key={target.storeId} className="sr-stop-row">
          <p className="sr-row-title" dir="auto">
            {s.target(target.shopDomain)}
          </p>
          {phase.kind === "stopped" ? (
            <Badge kind="paused" />
          ) : phase.kind === "sending" || phase.kind === "checking" ? (
            <p className="sr-meta" role="status">
              {phase.kind === "sending" ? s.rows.sending : s.rows.checking}
            </p>
          ) : (
            <div className="sr-stop-row-problem" role="status">
              <p className={phase.kind === "uncertain" ? "sr-reading" : "sr-error"} dir="auto">
                {phase.kind === "uncertain"
                  ? s.rows.uncertain
                  : phase.kind === "not_sent"
                    ? s.rows.notSent
                    : phase.message}
              </p>
              {phase.kind === "uncertain" ? (
                <Button onClick={() => onSend(target, true)}>{s.checkAgain}</Button>
              ) : phase.kind === "not_sent" ? (
                <Button onClick={() => onSend(target, false)}>{s.tryAgain}</Button>
              ) : null}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function StopDialog({
  state,
  rows,
  busy,
  onConfirm,
  onSend,
  onClose,
}: {
  readonly state: StopAllState;
  readonly rows: readonly StopRow[] | null;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onSend: (target: StopTarget, checking: boolean) => void;
  readonly onClose: () => void;
}) {
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const confirmed = isStopConfirmation(typed);
  const sent = rows !== null;
  // While a stop is out, the dialog stays: its replies decide what it says.
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Dialog
      open
      title={s.dialogTitle}
      onClose={close}
      footer={
        sent ? (
          <Button onClick={close} disabled={busy}>
            {s.close}
          </Button>
        ) : (
          <>
            <Button onClick={close}>{s.cancel}</Button>
            <button
              type="button"
              className="sr-button sr-button-critical"
              disabled={!confirmed}
              onClick={onConfirm}
            >
              {s.confirm}
            </button>
          </>
        )
      }
    >
      <div className="sr sr-dialog-body">
        <p className="sr-reading">{s.dialogBody}</p>
        {sent ? (
          <>
            <StopRows rows={rows} onSend={onSend} />
            {busy ? null : (
              <p className="sr-help" role="status">
                {rows.every((r) => r.phase.kind === "stopped") ? s.done : s.partly}
              </p>
            )}
          </>
        ) : (
          <>
            <div>
              <h3 className="sr-subheading">{s.whatStops}</h3>
              <ul className="sr-bullets">
                {state.targets.map((target) => (
                  <li key={target.storeId} dir="auto">
                    {s.target(target.shopDomain)}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="sr-subheading">{s.whatStays}</h3>
              <ul className="sr-bullets">
                {s.stays.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <div className="sr-field">
              <label htmlFor={inputId}>{s.typeLabel(stopWord)}</label>
              <input
                id={inputId}
                className="sr-input sr-stop-input"
                value={typed}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                maxLength={20}
                data-initial-focus
                aria-describedby={`${inputId}-hint`}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && confirmed) {
                    event.preventDefault();
                    onConfirm();
                  }
                }}
              />
              <small id={`${inputId}-hint`} className="sr-help">
                {s.typeHint}
              </small>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** The card at the top of Activity: what is on, the stop, and what became of it. */
export function StopAllCard({ workspaceId }: { readonly workspaceId: Id }) {
  const services = useServices();
  const ws = workspaceId;
  const [read, reload] = useRead(`${ws}|stopAll`, () => readStopAll(services, ws));
  const stop = useStopAll(ws);
  const titleId = useId();
  // What the dialog stops is fixed when it opens; a reread meanwhile changes nothing in it.
  const [dialog, setDialog] = useState<StopAllState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const confirm = async (targets: readonly StopTarget[]) => {
    setMessage(null);
    const all = await stop.start(targets);
    reload();
    if (all) {
      setDialog(null);
      setMessage(s.done);
    }
  };
  const send = (target: StopTarget, checking: boolean) =>
    void stop.send(target, checking).then((phase) => {
      if (phase?.kind === "stopped") reload();
    });
  const body = (() => {
    if (read.kind === "loading")
      return (
        <p className="sr-meta" role="status">
          {s.loading}
        </p>
      );
    if (read.kind !== "ok") return outcomeState(read, reload, { compact: true });
    const state = read.value;
    if (state.targets.length > 0)
      return (
        <div className="sr-stop-on">
          <div className="sr-stop-text">
            <p className="sr-reading">{s.body}</p>
            <p className="sr-stop-status">
              <Badge kind="active" />
              <span className="sr-meta">{s.on(state.targets.length)}</span>
            </p>
            {state.notAllowed > 0 ? (
              <p className="sr-help">{s.someNotAllowed(state.notAllowed)}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="sr-button sr-button-stop"
            aria-haspopup="dialog"
            onClick={() => {
              if (!stop.busy && !stop.unsettled) stop.clear();
              setDialog(state);
            }}
          >
            <SrIcon name="stop" />
            {s.open}
          </button>
        </div>
      );
    if (state.stopped > 0)
      return (
        <div className="sr-banner sr-banner-warning sr-stop-stopped">
          <div className="sr-banner-head">
            <Badge kind="paused" />
            <h3 className="sr-banner-title">{s.stoppedTitle}</h3>
          </div>
          <div className="sr-banner-body">
            <p className="sr-reading">{s.stoppedBody}</p>
            <p className="sr-help">{s.turnOnHow}</p>
            <RouteLink route="connections" params={{ workspaceId: ws }} className="sr-link">
              {s.openStore}
            </RouteLink>
          </div>
        </div>
      );
    return <p className="sr-reading">{state.notAllowed > 0 ? s.notAllowed : s.nothing}</p>;
  })();
  return (
    <section className="sr-card sr-stop-card" aria-labelledby={titleId}>
      <div className="sr-card-head">
        <h2 id={titleId} className="sr-card-title">
          {s.title}
        </h2>
      </div>
      <div className="sr-card-body">
        {body}
        {/* The outcome of a stop sent from the dialog, kept after it closes. */}
        {dialog === null &&
        stop.rows !== null &&
        stop.rows.some((r) => r.phase.kind !== "stopped") ? (
          <StopRows rows={stop.rows} onSend={send} />
        ) : null}
        <StatusRegion message={message} />
        {dialog !== null ? (
          <StopDialog
            state={dialog}
            rows={stop.rows}
            busy={stop.busy}
            onConfirm={() => void confirm(dialog.targets)}
            onSend={send}
            onClose={() => setDialog(null)}
          />
        ) : null}
      </div>
    </section>
  );
}
