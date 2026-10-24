// Feedback: confirmations, the persistent unknown-outcome notice, re-entry markers
// and the truthful state views (P14.T01a §4.4, §4.9).
import type { ReactNode } from "react";
import { copy } from "../copy";
import type { Outcome } from "../port";
import type { Marker } from "../services";
import { Button } from "./controls";
import { BadgeGlyph } from "./display";

/** Polite live region for confirmations; it says nothing until a confirmed reply. */
export function StatusRegion({ message }: { readonly message: string | null }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={message ? "status-region" : "status-region is-empty"}
    >
      {message ?? ""}
    </p>
  );
}

/** "Uncertain" persists until a decoded terminal reply; "not saved" offers the same send again. */
export function OutcomeNotice({
  kind,
  busy = false,
  onAction,
}: {
  readonly kind: "uncertain" | "not_saved" | "rate_limited";
  readonly busy?: boolean;
  readonly onAction: () => void;
}) {
  const uncertain = kind === "uncertain";
  return (
    <div role="status" className={uncertain ? "notice notice-warning" : "notice notice-danger"}>
      <p>
        {uncertain
          ? copy.outcome.uncertain
          : kind === "rate_limited"
            ? copy.outcome.rateLimited
            : copy.outcome.notSaved}
      </p>
      <Button onClick={onAction} disabled={busy}>
        {uncertain
          ? busy
            ? copy.outcome.checking
            : copy.outcome.checkAgain
          : copy.outcome.tryAgain}
      </Button>
    </div>
  );
}

export function ReentryNotice({
  marker,
  onDismiss,
}: {
  readonly marker: Marker;
  readonly onDismiss: () => void;
}) {
  return (
    <section className="notice notice-warning" aria-label={copy.reentry.label}>
      <p>{copy.reentry.body(copy.reentry.kinds[marker.kind])}</p>
      <Button onClick={onDismiss}>{copy.reentry.dismiss}</Button>
    </section>
  );
}

/**
 * A Sunrise banner (at most one per page, one idea): a tinted head with a glyph and the
 * title in the tone's text colour, then the body on white. The glyph is a word's partner,
 * never the only signal: the title says it.
 */
export function Banner({
  tone,
  title,
  children,
  headingLevel = 2,
}: {
  readonly tone: "info" | "warning" | "success" | "critical";
  readonly title: string;
  readonly children: ReactNode;
  readonly headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const glyph = { info: "half", warning: "alert", success: "check", critical: "triangle" } as const;
  return (
    <section className={`banner banner-${tone}`} aria-label={title}>
      <div className="banner-head">
        <BadgeGlyph glyph={glyph[tone]} />
        <Heading className="banner-title">{title}</Heading>
      </div>
      <div className="banner-body">{children}</div>
    </section>
  );
}

export type StateKind =
  | "loading"
  | "empty"
  | "denied"
  | "not_found"
  | "unavailable"
  | "not_in_build"
  | "offline"
  | "session_expired"
  | "workspace_unavailable";
const defaults: Readonly<Record<StateKind, string>> = {
  loading: copy.states.loading,
  empty: copy.states.empty,
  denied: copy.states.denied,
  not_found: copy.states.notFound,
  unavailable: copy.states.unavailable,
  not_in_build: copy.states.notInBuild,
  offline: copy.states.offline,
  session_expired: copy.signIn.sessionEnded,
  workspace_unavailable: copy.workspace.unavailable,
};
export function StateView({
  kind,
  title,
  message,
  reference = null,
  onRetry,
  children,
  compact = false,
}: {
  readonly kind: StateKind;
  readonly title?: string | undefined;
  readonly message?: string | undefined;
  readonly reference?: string | null;
  readonly onRetry?: (() => void) | undefined;
  readonly children?: ReactNode;
  readonly compact?: boolean;
}) {
  const body = (
    <>
      {title ? <h2 className="state-title">{title}</h2> : null}
      <p dir="auto">{message ?? defaults[kind]}</p>
      {reference ? <p className="muted small">{copy.states.reference(reference)}</p> : null}
      {onRetry ? <Button onClick={onRetry}>{copy.states.retry}</Button> : null}
      {children}
    </>
  );
  const className = `state-view state-${kind}${compact ? " is-compact" : ""}`;
  if (kind === "loading")
    return (
      <div className={className} role="status" aria-live="polite">
        {body}
      </div>
    );
  return (
    <div className={className} data-state={kind}>
      {body}
    </div>
  );
}

/** The state view for a non-ok read outcome; `null` for ok. */
export function outcomeState(
  outcome: { readonly kind: "loading" } | Outcome<unknown>,
  onRetry: () => void,
  labels: { readonly empty?: string; readonly denied?: string; readonly compact?: boolean } = {},
): ReactNode {
  const compact = labels.compact ?? false;
  switch (outcome.kind) {
    case "ok":
      return null;
    case "loading":
      return <StateView kind="loading" compact={compact} />;
    case "denied":
      return (
        <StateView
          kind="denied"
          compact={compact}
          title={labels.denied}
          message={outcome.message || copy.states.denied}
          reference={outcome.reference}
        />
      );
    case "not_found":
      return <StateView kind="not_found" compact={compact} />;
    case "not_in_build":
      return <StateView kind="not_in_build" compact={compact} />;
    case "unavailable":
      return outcome.offline ? (
        <StateView kind="offline" compact={compact} onRetry={onRetry} />
      ) : (
        <StateView kind="unavailable" compact={compact} onRetry={onRetry} />
      );
    case "unauthenticated":
      return <StateView kind="loading" compact={compact} />;
    default:
      return <StateView kind="unavailable" compact={compact} onRetry={onRetry} />;
  }
}
