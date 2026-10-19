// Screens outside a workspace (P14.T01a §4.6, §4.10): sign-in, signed out, sign-out
// unconfirmed, not found, workspace unavailable and the account landing.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { buildWorkspacePath, workspaceRoutes } from "@morrow/contracts/routes";
import { copy } from "../copy";
import type { Id, WorkspaceSummary } from "../model";
import type { Outcome } from "../port";
import {
  useChallenge,
  useCommand,
  useDirty,
  useRead,
  useServices,
  type CommandPhase,
} from "../services";
import { Button, TextField } from "../components/controls";
import { OutcomeNotice, StateView, StatusRegion, outcomeState } from "../components/feedback";

/**
 * Starts sign-in once; at login body v1 it needs a workspace to name. The start POST
 * carries a fresh bot-challenge token (P05.T01ab); a challenge that fails, a 403
 * `challenge_*` and a 429 all show the existing "Sign-in couldn't start".
 */
export function SignInButton({ workspaceId }: { readonly workspaceId: Id | null }) {
  const services = useServices();
  const challenge = useChallenge("login");
  const [state, setState] = useState<"idle" | "starting" | "failed">("idle");
  const unusable = services.loginBodyVersion === 1 && workspaceId === null;
  const start = async () => {
    if (state === "starting" || unusable) return;
    setState("starting");
    const result = await challenge.run((token) => services.startSignIn(workspaceId, token));
    setState(result === "started" ? "starting" : "failed");
  };
  return (
    <div className="sign-in">
      <Button variant="primary" onClick={start} disabled={unusable || state === "starting"}>
        {state === "starting" ? copy.signIn.starting : copy.signIn.button}
      </Button>
      {challenge.host}
      {unusable ? <p className="muted">{copy.signIn.needWorkspaceLink}</p> : null}
      <StatusRegion message={state === "failed" ? copy.signIn.failed : null} />
    </div>
  );
}

export function SignInScreen({
  workspaceId,
  draftsDropped,
}: {
  readonly workspaceId: Id | null;
  readonly draftsDropped: boolean;
}) {
  return (
    <section className="entry-card" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title">{copy.signIn.sessionEndedTitle}</h1>
      <p>{copy.signIn.sessionEnded}</p>
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

function CreateOrganizationForm({
  onCreated,
  onRefetch,
}: {
  readonly onCreated: (workspaceId: Id) => void;
  readonly onRefetch: () => void;
}) {
  const services = useServices();
  const [organizationName, setOrganizationName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [checked, setChecked] = useState(false);
  const command = useCommand<
    { organizationName: string; workspaceName: string },
    { readonly workspaceId: Id }
  >({
    marker: null,
    send: (c) => services.port.account.createOrganization(c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") onCreated(outcome.value.workspaceId);
      else if (outcome.kind === "conflict" && outcome.recheck) onRefetch();
    },
  });
  useDirty(organizationName !== "" || workspaceName !== "" || command.busy);
  const organization = normalizeName(organizationName);
  const workspace = normalizeName(workspaceName);
  const settled = command.phase.phase === "settled" ? command.phase.outcome : null;
  const nameRejected = settled?.kind === "invalid";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (organization === null || workspace === null || command.busy) return;
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
        phase={command.phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
        messages={{
          denied: copy.account.unavailable,
          conflict: (o) => (o.recheck ? copy.account.alreadyOnboarded : copy.account.keyConflict),
          rateLimited: copy.account.rateLimited,
        }}
      />
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={command.busy}>
          {copy.account.create}
        </Button>
      </div>
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
      return (
        <div role="status" className="notice notice-danger">
          <p>{copy.outcome.invalid}</p>
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

function WorkspaceChooser({
  workspaces,
  truncated,
}: {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly truncated: boolean;
}) {
  const services = useServices();
  return (
    <section className="entry-card" aria-labelledby="account-title">
      <h1 id="account-title">{copy.account.title}</h1>
      <p>{copy.account.choose}</p>
      <ul className="chooser">
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
                <span dir="auto">{w.displayName}</span>
              </a>
            </li>
          );
        })}
      </ul>
      {truncated ? <p className="muted">{copy.account.truncated}</p> : null}
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

/** `/`: landing before the account routes are composed, then list, chooser or signup. */
export function AccountScreen() {
  const services = useServices();
  const [overview, reload] = useRead("account.overview", () => services.port.account.overview());
  // After a confirmed signup the form unmounts first, so its draft no longer holds the
  // leave guard when the new workspace opens.
  const [created, setCreated] = useState<Id | null>(null);
  const openWorkspace = (workspaceId: Id) =>
    services.navigate(buildWorkspacePath(workspaceRoutes, "home", { workspaceId }), {
      replace: true,
    });
  if (created !== null) return <OpenOnly workspaceId={created} open={openWorkspace} />;
  if (overview.kind === "not_in_build")
    return (
      <section className="entry-card" aria-labelledby="account-title">
        <h1 id="account-title">{copy.signIn.title}</h1>
        <p>{copy.account.landing}</p>
        <SignInButton workspaceId={null} />
      </section>
    );
  if (overview.kind !== "ok")
    return (
      <section className="entry-card" aria-labelledby="account-title">
        <h1 id="account-title">{copy.account.title}</h1>
        {outcomeState(overview, reload)}
      </section>
    );
  const { workspaces, truncated, onboarding } = overview.value;
  if (workspaces.length === 1)
    return <OpenOnly workspaceId={workspaces[0]!.workspaceId} open={openWorkspace} />;
  if (workspaces.length > 1)
    return <WorkspaceChooser workspaces={workspaces} truncated={truncated} />;
  if (onboarding === "available")
    return <CreateOrganizationForm onCreated={setCreated} onRefetch={reload} />;
  return (
    <section className="entry-card" aria-labelledby="account-title">
      <h1 id="account-title">{copy.account.title}</h1>
      <p>{copy.account.invite}</p>
    </section>
  );
}
