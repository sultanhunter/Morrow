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
//   * The words name what stopped (Listings, on how many stores) and never claim more: a
//     store whose work this person may not stop is said to be still on.
import { useCallback, useEffect, useId, useRef, useState, type Ref } from "react";
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

/** Stopped on `stopped` stores; with work this person may not stop, that is said too. */
export function stoppedText(stopped: number, notAllowed: number): string {
  const done = s.done(stopped);
  return notAllowed > 0 ? `${done} ${s.someNotAllowed(notAllowed)}` : done;
}
/** What a stop's replies add up to: never more stopped than did. */
export function stopOutcomeText(rows: readonly StopRow[], notAllowed: number): string {
  if (!rows.every((r) => r.phase.kind === "stopped")) return s.partly;
  return stoppedText(rows.length, notAllowed);
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
            <Badge kind="stopped" />
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
                {stopOutcomeText(rows, state.notAllowed)}
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
              {state.notAllowed > 0 ? (
                <p className="sr-help">{s.someNotAllowed(state.notAllowed)}</p>
              ) : null}
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

/**
 * What is on and what is stopped, from one read. "Stopped" names the stores it stopped on;
 * with work this person may not stop still on, it says so (it never reads as all stopped).
 */
export function StopAllStatus({
  workspaceId,
  state,
  onOpen,
  resultRef,
}: {
  readonly workspaceId: Id;
  readonly state: StopAllState;
  readonly onOpen: () => void;
  /** The stopped banner's heading, focused after a stop (the opener is gone by then). */
  readonly resultRef?: Ref<HTMLHeadingElement>;
}) {
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
          onClick={onOpen}
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
          <Badge kind="stopped" />
          <h3 className="sr-banner-title" ref={resultRef} tabIndex={-1}>
            {s.stoppedTitle(state.stopped)}
          </h3>
        </div>
        <div className="sr-banner-body">
          <p className="sr-reading">{s.stoppedBody}</p>
          {state.notAllowed > 0 ? (
            <p className="sr-reading">{s.someNotAllowed(state.notAllowed)}</p>
          ) : null}
          <p className="sr-help">{s.turnOnHow}</p>
          <RouteLink route="connections" params={{ workspaceId }} className="sr-link">
            {s.openStore}
          </RouteLink>
        </div>
      </div>
    );
  return <p className="sr-reading">{state.notAllowed > 0 ? s.notAllowed : s.nothing}</p>;
}

/** The card at the top of Activity: what is on, the stop, and what became of it. */
export function StopAllCard({ workspaceId }: { readonly workspaceId: Id }) {
  const services = useServices();
  const ws = workspaceId;
  const [read, reload] = useRead(`${ws}|stopAll`, () => readStopAll(services, ws));
  const stop = useStopAll(ws);
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  // What the dialog stops is fixed when it opens; a reread meanwhile changes nothing in it.
  const [dialog, setDialog] = useState<StopAllState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // After a confirmed stop the dialog closes and the reread removes its opener: focus moves
  // to the result once the reread (not the reply from before the stop) is shown.
  const focusAfterReread = useRef<{ readonly from: StopAllState | null } | null>(null);
  useEffect(() => {
    const pending = focusAfterReread.current;
    if (pending === null || read.kind === "loading") return;
    if (read.kind === "ok" && read.value === pending.from) return;
    focusAfterReread.current = null;
    if (resultRef.current) resultRef.current.focus();
    else if (document.activeElement === null || document.activeElement === document.body)
      titleRef.current?.focus();
  }, [read]);
  const confirm = async (state: StopAllState) => {
    setMessage(null);
    const all = await stop.start(state.targets);
    if (all) focusAfterReread.current = { from: read.kind === "ok" ? read.value : null };
    reload();
    if (all) {
      setDialog(null);
      setMessage(stoppedText(state.targets.length, state.notAllowed));
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
    return (
      <StopAllStatus
        workspaceId={ws}
        state={state}
        resultRef={resultRef}
        onOpen={() => {
          if (!stop.busy && !stop.unsettled) stop.clear();
          setDialog(state);
        }}
      />
    );
  })();
  return (
    <section className="sr-card sr-stop-card" aria-labelledby={titleId}>
      <div className="sr-card-head">
        <h2 id={titleId} className="sr-card-title" ref={titleRef} tabIndex={-1}>
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
            onConfirm={() => void confirm(dialog)}
            onSend={send}
            onClose={() => setDialog(null)}
          />
        ) : null}
      </div>
    </section>
  );
}
