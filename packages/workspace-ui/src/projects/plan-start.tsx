// The person-bound plan start (ADR-0034 item 5), as one tap and two commands: the server
// builds PlanStartDocument@1 for the draft digest it holds (step 1), and the same tap
// consumes exactly that document by its digest and nonce (step 2). The screen consumes a
// document only when it binds what the screen shows; a stale, expired, reused or unknown
// document, or an ineligible actor, starts nothing and re-reads the card. Each step is a
// single-flight command with its own kept key, Check again and re-entry marker.
import { useCallback, useRef, useState, type ReactNode } from "react";
import { copy } from "../copy";
import type { Id } from "../model";
import type { Command, Outcome } from "../port";
import { useCommand, useServices, type CommandPhase } from "../services";
import { Button } from "../components/controls";
import { OutcomeNotice, StatusRegion } from "../components/feedback";
import { projectsCopy } from "./copy";
import type { PlanStartDocumentView, PlanStartResultView } from "./model";

type Refusal = "changed" | "mismatch" | "expired" | "ineligible" | "message";
export type StartNotice =
  | { readonly kind: "none" }
  | { readonly kind: "refused"; readonly reason: Refusal; readonly message: string | null }
  | { readonly kind: "failed"; readonly outcome: Outcome<unknown> };

/**
 * Whether a server-built document binds what the screen shows: the same target, the same
 * draft digest (a card) or project (Finish), a well-formed digest and nonce, and not yet
 * expired by the person's clock. `expired` and `mismatch` start nothing.
 */
export function documentBinds(
  doc: PlanStartDocumentView,
  expected: {
    readonly target: string;
    readonly draftDigest: string | null;
    readonly projectId: Id | null;
  },
  now: number = Date.now(),
): "binds" | "mismatch" | "expired" {
  const same =
    doc.target === expected.target &&
    doc.draftDigest === expected.draftDigest &&
    doc.projectId === expected.projectId &&
    /^[a-f0-9]{64}$/.test(doc.documentDigest) &&
    doc.nonce.length >= 16 &&
    doc.nonce.length <= 256;
  if (!same) return "mismatch";
  const expires = Date.parse(doc.expiresAt);
  return Number.isFinite(expires) && expires > now ? "binds" : "expired";
}

/**
 * A start or its document refused as `denied`: the server's own words when it gave any,
 * otherwise that this person may not start it (ADR-0034 item 5(b): `actor_ineligible`,
 * a missing permission, or stopped). Both steps say the same; never "it changed".
 */
export function deniedNotice(message: string): StartNotice {
  return message
    ? { kind: "refused", reason: "message", message }
    : { kind: "refused", reason: "ineligible", message: null };
}

/** What the feedback reads of a start flow (any body type). */
export interface StartFlowView {
  readonly busy: boolean;
  readonly notice: StartNotice;
  readonly document: {
    readonly phase: CommandPhase<PlanStartDocumentView>;
    readonly checkAgain: () => Promise<void>;
    readonly retry: () => Promise<void>;
  };
  readonly start: {
    readonly phase: CommandPhase<PlanStartResultView>;
    readonly checkAgain: () => Promise<void>;
    readonly retry: () => Promise<void>;
  };
}

/** The start flow of one card (or Finish). `request` is step 1's port call. */
export function usePlanStart<B>(options: {
  readonly ws: Id;
  readonly request: (c: Command<B>) => Promise<Outcome<PlanStartDocumentView>>;
  readonly expected: {
    readonly target: string;
    readonly draftDigest: string | null;
    readonly projectId: Id | null;
  };
  readonly onStarted: (result: PlanStartResultView) => void;
  /** The card or project changed or the document can't be used: read it again. */
  readonly onStale: () => void;
}) {
  const services = useServices();
  const latest = useRef(options);
  latest.current = options;
  const [notice, setNotice] = useState<StartNotice>({ kind: "none" });
  const start = useCommand<{ documentDigest: string; nonce: string }, PlanStartResultView>({
    marker: { workspaceId: options.ws, kind: "plan" },
    send: (c) => services.port.plans.start(latest.current.ws, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") {
        setNotice({ kind: "none" });
        latest.current.onStarted(outcome.value);
      } else if (outcome.kind === "conflict" || outcome.kind === "not_found") {
        // Stale, expired, already used or unknown: nothing started; a new tap asks again.
        setNotice({ kind: "refused", reason: "changed", message: null });
        latest.current.onStale();
      } else if (outcome.kind === "denied") {
        setNotice(deniedNotice(outcome.message));
      } else if (outcome.kind !== "unavailable" && outcome.kind !== "rate_limited")
        setNotice({ kind: "failed", outcome });
    },
  });
  const document = useCommand<B, PlanStartDocumentView>({
    marker: { workspaceId: options.ws, kind: "plan" },
    send: (c) => latest.current.request(c),
    onOutcome: (outcome, sent) => {
      if (outcome.kind === "ok") {
        if (!sent.current) return;
        const binds = documentBinds(outcome.value, latest.current.expected);
        if (binds !== "binds") {
          setNotice({ kind: "refused", reason: binds, message: null });
          latest.current.onStale();
          return;
        }
        void start.submit({
          documentDigest: outcome.value.documentDigest,
          nonce: outcome.value.nonce,
        });
      } else if (outcome.kind === "conflict" || outcome.kind === "not_found") {
        setNotice({ kind: "refused", reason: "changed", message: null });
        latest.current.onStale();
      } else if (outcome.kind === "denied") {
        setNotice(deniedNotice(outcome.message));
      } else if (outcome.kind !== "unavailable" && outcome.kind !== "rate_limited")
        setNotice({ kind: "failed", outcome });
    },
  });
  const begin = useCallback(
    (body: B) => {
      setNotice({ kind: "none" });
      // A new tap after a refusal is a new request: both keys are minted afresh.
      start.reset();
      void document.submit(body);
    },
    [document, start],
  );
  const busy = document.busy || start.busy;
  return { begin, busy, notice, document, start } as const;
}

function phaseNotice<T>(
  phase: CommandPhase<T>,
  onCheckAgain: () => void,
  onRetry: () => void,
): ReactNode {
  if (phase.phase === "uncertain")
    return <OutcomeNotice kind="uncertain" busy={phase.checking} onAction={onCheckAgain} />;
  if (phase.phase !== "settled") return null;
  if (phase.outcome.kind === "unavailable")
    return <OutcomeNotice kind="not_saved" onAction={onRetry} />;
  if (phase.outcome.kind === "rate_limited")
    return <OutcomeNotice kind="rate_limited" onAction={onRetry} />;
  return null;
}

/** What a start flow says: unknown outcomes first, then refusals, never success early. */
export function PlanStartFeedback({
  flow,
  changed = projectsCopy.card.changedSince,
}: {
  readonly flow: StartFlowView;
  /** What a stale start says here (a card, or Finish's project). */
  readonly changed?: string;
}) {
  const startNotice = phaseNotice(
    flow.start.phase,
    () => void flow.start.checkAgain(),
    () => void flow.start.retry(),
  );
  if (startNotice) return <>{startNotice}</>;
  const documentNotice = phaseNotice(
    flow.document.phase,
    () => void flow.document.checkAgain(),
    () => void flow.document.retry(),
  );
  if (documentNotice) return <>{documentNotice}</>;
  const notice = flow.notice;
  if (notice.kind === "refused") {
    const text =
      notice.reason === "message" && notice.message
        ? notice.message
        : notice.reason === "mismatch"
          ? projectsCopy.card.mismatch
          : notice.reason === "expired"
            ? projectsCopy.card.expired
            : notice.reason === "ineligible"
              ? projectsCopy.card.ineligible
              : changed;
    return (
      <div role="status" className="notice notice-warning">
        <p dir="auto">{text}</p>
      </div>
    );
  }
  if (notice.kind === "failed")
    return (
      <div role="status" className="notice notice-danger">
        <p>
          {notice.outcome.kind === "not_in_build" ? copy.states.notInBuild : copy.outcome.refused}
        </p>
      </div>
    );
  return <StatusRegion message={null} />;
}

/** The one primary button of a card, with its feedback below. */
export function PlanStartButton({
  label,
  flow,
  onStart,
  disabled = false,
}: {
  readonly label: string;
  readonly flow: StartFlowView;
  readonly onStart: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Button variant="primary" disabled={disabled || flow.busy} onClick={onStart}>
      {flow.busy ? projectsCopy.card.starting : label}
    </Button>
  );
}
