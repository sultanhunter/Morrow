// Screens outside a workspace (P14.T01a §4.6, §4.10): sign-in, signed out, sign-out
// unconfirmed, not found, workspace unavailable and the account landing.
import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { buildWorkspacePath, workspaceRoutes } from "@morrow/contracts/routes";
import { copy } from "../copy";
import type { Id, WorkspaceSummary } from "../model";
import type { Outcome } from "../port";
import { useCommand, useDirty, useRead, useServices, type CommandPhase } from "../services";
import { Button, TextField } from "../components/controls";
import { Icon } from "../components/display";
import { OutcomeNotice, StateView, StatusRegion, outcomeState } from "../components/feedback";

/** Starts sign-in once; at login body v1 it needs a workspace to name. */
export function SignInButton({ workspaceId }: { readonly workspaceId: Id | null }) {
  const services = useServices();
  const [state, setState] = useState<"idle" | "starting" | "failed">("idle");
  const unusable = services.loginBodyVersion === 1 && workspaceId === null;
  const start = async () => {
    if (state === "starting" || unusable) return;
    setState("starting");
    const result = await services.startSignIn(workspaceId);
    setState(result === "failed" ? "failed" : "starting");
  };
  return (
    <div className="sign-in">
      <Button variant="primary" onClick={start} disabled={unusable || state === "starting"}>
        {state === "starting" ? copy.signIn.starting : copy.signIn.button}
      </Button>
      {unusable ? <p className="muted">{copy.signIn.needWorkspaceLink}</p> : null}
      <StatusRegion message={state === "failed" ? copy.signIn.failed : null} />
    </div>
  );
}

/**
 * A 401 ends the session view (§4.6). `fresh`: the first account read of this page load
 * at `/` was a 401 and nothing private was shown, so this is the signed-out entry rather
 * than "your session ended" (the server can't tell the two apart; the copy stays true).
 */
export function SignInScreen({
  workspaceId,
  draftsDropped,
  fresh = false,
}: {
  readonly workspaceId: Id | null;
  readonly draftsDropped: boolean;
  readonly fresh?: boolean;
}) {
  return (
    <section className="entry-card" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title">{fresh ? copy.signIn.title : copy.signIn.sessionEndedTitle}</h1>
      <p>{fresh ? copy.signIn.landing : copy.signIn.sessionEnded}</p>
      {draftsDropped ? <p className="muted">{copy.signIn.draftsDropped}</p> : null}
      <SignInButton workspaceId={workspaceId} />
    </section>
  );
}

export function SignedOutScreen() {
  return (
    <section className="entry-card" aria-labelledby="signed-out-title">
      <h1 id="signed-out-title">{copy.signOut.doneTitle}</h1>
      <p>{copy.signOut.done}</p>
      <AccountLink />
    </section>
  );
}

export function SignOutUnconfirmedScreen({
  busy,
  onRetry,
}: {
  readonly busy: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <section className="entry-card" aria-labelledby="sign-out-unconfirmed-title">
      <h1 id="sign-out-unconfirmed-title">{copy.signOut.unconfirmedTitle}</h1>
      <div role="status" className="notice notice-warning">
        <p>{copy.signOut.unconfirmed}</p>
        <Button onClick={onRetry} disabled={busy}>
          {busy ? copy.signOut.working : copy.signOut.tryAgain}
        </Button>
      </div>
    </section>
  );
}

function AccountLink({
  children = copy.workspace.backToAccount,
}: {
  readonly children?: ReactNode;
}) {
  const services = useServices();
  return (
    <a
      className="text-link"
      href="/"
      onClick={(event) => {
        event.preventDefault();
        services.openAccount();
      }}
    >
      {children}
    </a>
  );
}

export function NotFoundScreen() {
  return (
    <section className="entry-card" aria-labelledby="not-found-title">
      <h1 id="not-found-title">{copy.notFound.title}</h1>
      <p>{copy.notFound.body}</p>
      <AccountLink>{copy.notFound.back}</AccountLink>
    </section>
  );
}

export function WorkspaceUnavailableScreen({
  workspaceId,
  offerSignIn,
}: {
  readonly workspaceId: Id;
  readonly offerSignIn: boolean;
}) {
  return (
    <section className="entry-card" aria-labelledby="workspace-unavailable-title">
      <h1 id="workspace-unavailable-title">{copy.workspace.unavailableTitle}</h1>
      <p>{copy.workspace.unavailable}</p>
      {offerSignIn ? <SignInButton workspaceId={workspaceId} /> : null}
      <AccountLink />
    </section>
  );
}

export function WorkspaceLoadFailedScreen({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <section className="entry-card" aria-labelledby="workspace-failed-title">
      <h1 id="workspace-failed-title">{copy.workspace.loadFailedTitle}</h1>
      <StateView kind="unavailable" message={copy.workspace.loadFailed} onRetry={onRetry} />
      <AccountLink />
    </section>
  );
}

// P05.T01x display-name rule, advisory only (the server decides): NFC, no leading or
// trailing W, no F code point, 1 to 100 code points.
const edgeSpace = new RegExp(
  "^[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+|[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+$",
  "g",
);
const forbidden = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]",
);
const loneSurrogate = new RegExp(
  "[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]",
);
export function normalizeName(value: string): string | null {
  if (loneSurrogate.test(value)) return null;
  const name = value.normalize("NFC").replace(edgeSpace, "");
  const length = [...name].length;
  if (length < 1 || length > 100 || forbidden.test(name)) return null;
  return name;
}

/** Disables an action until `Retry-After` has passed (§4.8, 429 row). */
function useHold(): readonly [boolean, (seconds: number) => void] {
  const [until, setUntil] = useState<number | null>(null);
  useEffect(() => {
    if (until === null) return;
    const timer = setTimeout(() => setUntil(null), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until]);
  return [until !== null, (seconds: number) => setUntil(Date.now() + seconds * 1000)] as const;
}

function CreateOrganizationForm({
  onCreated,
  onRefetch,
  footer,
}: {
  readonly onCreated: (workspaceId: Id) => void;
  readonly onRefetch: () => void;
  readonly footer: ReactNode;
}) {
  const services = useServices();
  const [organizationName, setOrganizationName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [checked, setChecked] = useState(false);
  const [held, hold] = useHold();
  // A 403 (signup_unavailable, or the guard's refusal) is terminal: nothing this form
  // can send will succeed, so the action stays off. Field values survive every failure.
  const [refused, setRefused] = useState(false);
  const command = useCommand<
    { organizationName: string; workspaceName: string },
    { readonly workspaceId: Id }
  >({
    marker: null,
    send: (c) => services.port.account.createOrganization(c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") onCreated(outcome.value.workspaceId);
      else if (outcome.kind === "conflict" && outcome.recheck) onRefetch();
      else if (outcome.kind === "rate_limited") hold(outcome.retryAfterSeconds);
      else if (outcome.kind === "denied") setRefused(true);
    },
  });
  useDirty(organizationName !== "" || workspaceName !== "" || command.busy);
  const organization = normalizeName(organizationName);
  const workspace = normalizeName(workspaceName);
  const settled = command.phase.phase === "settled" ? command.phase.outcome : null;
  const nameRejected = settled?.kind === "invalid" && settled.field === "name";
  // Once the hold ends the 429 copy is stale: the action is available again.
  const phase =
    settled?.kind === "rate_limited" && !held ? ({ phase: "idle" } as const) : command.phase;
  const unavailable = command.busy || held || refused;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (organization === null || workspace === null || unavailable) return;
    void command.submit({ organizationName: organization, workspaceName: workspace });
  };
  return (
    <form
      className="entry-card"
      aria-labelledby="create-organization-title"
      onSubmit={submit}
      noValidate
    >
      <h1 id="create-organization-title">{copy.account.createTitle}</h1>
      <p>{copy.account.createIntro}</p>
      <TextField
        label={copy.account.organizationName}
        value={organizationName}
        onChange={setOrganizationName}
        hint={copy.account.nameHint}
        error={(checked && organization === null) || nameRejected ? copy.account.invalidName : null}
        disabled={command.busy}
        required
      />
      <TextField
        label={copy.account.workspaceName}
        value={workspaceName}
        onChange={setWorkspaceName}
        hint={copy.account.nameHint}
        error={(checked && workspace === null) || nameRejected ? copy.account.invalidName : null}
        disabled={command.busy}
        required
      />
      <CommandFeedback
        phase={phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
        messages={{
          denied: copy.account.unavailable,
          conflict: (o) => (o.recheck ? copy.account.alreadyOnboarded : copy.account.keyConflict),
          rateLimited: copy.account.rateLimited,
        }}
      />
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={unavailable}>
          {command.phase.phase === "sending" ? copy.account.creating : copy.account.create}
        </Button>
      </div>
      {footer}
    </form>
  );
}

/** The shared rendering of a command's non-success states (§4.8, §4.9). */
export function CommandFeedback<T>({
  phase,
  onCheckAgain,
  onRetry,
  success,
  messages = {},
}: {
  readonly phase: CommandPhase<T>;
  readonly onCheckAgain: () => void;
  readonly onRetry: () => void;
  readonly success?: string;
  readonly messages?: {
    readonly denied?: string;
    readonly conflict?: (outcome: Extract<Outcome<T>, { kind: "conflict" }>) => string;
    readonly rateLimited?: (seconds: number) => string;
  };
}) {
  if (phase.phase === "uncertain")
    return <OutcomeNotice kind="uncertain" busy={phase.checking} onAction={onCheckAgain} />;
  if (phase.phase !== "settled") return <StatusRegion message={null} />;
  const outcome = phase.outcome;
  switch (outcome.kind) {
    case "ok":
      return <StatusRegion message={success ?? null} />;
    case "unavailable":
      return <OutcomeNotice kind="not_saved" onAction={onRetry} />;
    case "rate_limited":
      return (
        <div role="status" className="notice notice-danger">
          <p>{messages.rateLimited?.(outcome.retryAfterSeconds) ?? copy.outcome.rateLimited}</p>
        </div>
      );
    case "denied":
      return (
        <div role="status" className="notice notice-danger">
          <p dir="auto">{messages.denied ?? (outcome.message || copy.states.denied)}</p>
          {outcome.reference ? (
            <p className="small">{copy.states.reference(outcome.reference)}</p>
          ) : null}
        </div>
      );
    case "conflict":
      return (
        <div role="status" className="notice notice-warning">
          <p dir="auto">{messages.conflict?.(outcome) ?? outcome.message}</p>
        </div>
      );
    case "not_found":
      return (
        <div role="status" className="notice notice-danger">
          <p>{copy.states.notFound}</p>
        </div>
      );
    case "invalid":
      // Only a named field can be highlighted; without one the copy says so.
      return (
        <div role="status" className="notice notice-danger">
          <p>{outcome.field === null ? copy.outcome.refused : copy.outcome.invalid}</p>
        </div>
      );
    case "not_in_build":
      return (
        <div role="status" className="notice notice-danger">
          <p>{copy.states.notInBuild}</p>
        </div>
      );
    default:
      return <StatusRegion message={null} />;
  }
}

/** Up and Down move between the rows (§4.10; Mobbin guide §7 "Workspace row"). */
function moveBetweenRows(event: KeyboardEvent<HTMLUListElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>("a.chooser-link")];
  const at = links.indexOf(document.activeElement as HTMLAnchorElement);
  if (at < 0) return;
  event.preventDefault();
  const next = event.key === "ArrowDown" ? Math.min(at + 1, links.length - 1) : Math.max(at - 1, 0);
  links[next]?.focus();
}

function WorkspaceChooser({
  workspaces,
  truncated,
  footer,
}: {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly truncated: boolean;
  readonly footer: ReactNode;
}) {
  const services = useServices();
  return (
    <section className="entry-card" aria-labelledby="account-title">
      <h1 id="account-title">{copy.account.title}</h1>
      <p>{copy.account.choose}</p>
      <ul className="chooser" aria-labelledby="account-title" onKeyDown={moveBetweenRows}>
        {workspaces.map((w) => {
          const href = buildWorkspacePath(workspaceRoutes, "home", { workspaceId: w.workspaceId });
          return (
            <li key={w.workspaceId}>
              <a
                href={href}
                className="chooser-link"
                onClick={(event) => {
                  event.preventDefault();
                  services.navigate(href);
                }}
              >
                <span className="chooser-mark" aria-hidden="true">
                  {[...w.displayName][0]?.toUpperCase() ?? ""}
                </span>
                <span className="chooser-text">
                  <span className="chooser-name" dir="auto">
                    {w.displayName}
                  </span>
                  {w.organizationName !== null ? (
                    <span className="chooser-org" dir="auto">
                      {w.organizationName}
                    </span>
                  ) : null}
                </span>
                <Icon name="forward" size={16} />
              </a>
            </li>
          );
        })}
      </ul>
      {truncated ? <p className="muted">{copy.account.truncated}</p> : null}
      {footer}
    </section>
  );
}

/** One workspace: replace the location with it (§4.10). */
function OpenOnly({
  workspaceId,
  open,
}: {
  readonly workspaceId: Id;
  readonly open: (id: Id) => void;
}) {
  useEffect(() => open(workspaceId), [workspaceId, open]);
  return <StateView kind="loading" />;
}

/** The account landing's footer: there is no identity to show yet (§4.10, no "You"). */
function AccountFooter({
  signOutState,
  onSignOut,
}: {
  readonly signOutState: "idle" | "busy" | "incomplete";
  readonly onSignOut: () => void;
}) {
  return (
    <div className="account-footer">
      {signOutState === "incomplete" ? (
        <p role="status" className="muted">
          {copy.signOut.incomplete}
        </p>
      ) : (
        <span />
      )}
      <Button onClick={onSignOut} disabled={signOutState === "busy"}>
        {signOutState === "busy" ? copy.signOut.working : copy.signOut.button}
      </Button>
    </div>
  );
}

/**
 * `/`: the account landing (§4.10). Before the account routes are composed it is the
 * sign-in landing; after, one workspace opens, several show the chooser in server order,
 * and none shows the signup form or the invitation copy. A 401 ends the session view in
 * the app (§4.6), which shows the signed-out entry.
 */
export function AccountScreen({
  signOutState = "idle",
  onSignOut,
}: {
  readonly signOutState?: "idle" | "busy" | "incomplete";
  readonly onSignOut?: () => void;
}) {
  const services = useServices();
  const [overview, reload] = useRead("account.overview", () => services.port.account.overview());
  // After a confirmed signup the form unmounts first, so its draft no longer holds the
  // leave guard when the new workspace opens.
  const [created, setCreated] = useState<Id | null>(null);
  const openWorkspace = (workspaceId: Id) =>
    services.navigate(buildWorkspacePath(workspaceRoutes, "home", { workspaceId }), {
      replace: true,
    });
  const footer = (
    <AccountFooter signOutState={signOutState} onSignOut={onSignOut ?? services.signOut} />
  );
  if (created !== null) return <OpenOnly workspaceId={created} open={openWorkspace} />;
  if (overview.kind === "not_in_build")
    return (
      <section className="entry-card" aria-labelledby="account-title">
        <h1 id="account-title">{copy.signIn.title}</h1>
        <p>{copy.account.landing}</p>
        <SignInButton workspaceId={null} />
      </section>
    );
  // A failed read still offers Sign out, so a shared device is never left signed in
  // with no way out (§4.10); not while loading, which settles into another view.
  if (overview.kind !== "ok")
    return (
      <section className="entry-card" aria-labelledby="account-title">
        <h1 id="account-title">{copy.account.title}</h1>
        {outcomeState(overview, reload)}
        {overview.kind === "loading" ? null : footer}
      </section>
    );
  const { workspaces, truncated, onboarding } = overview.value;
  if (workspaces.length === 1)
    return <OpenOnly workspaceId={workspaces[0]!.workspaceId} open={openWorkspace} />;
  if (workspaces.length > 1)
    return <WorkspaceChooser workspaces={workspaces} truncated={truncated} footer={footer} />;
  if (onboarding === "available")
    return <CreateOrganizationForm onCreated={setCreated} onRefetch={reload} footer={footer} />;
  return (
    <section className="entry-card" aria-labelledby="account-title">
      <h1 id="account-title">{copy.account.title}</h1>
      <p>{copy.account.invite}</p>
      {footer}
    </section>
  );
}
