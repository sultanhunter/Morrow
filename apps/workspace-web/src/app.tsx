// The workspace app (P14.T01a): the router, the session view (§4.6), workspace entry,
// the leave guard and the services screens use. It never selects or records an active
// workspace: entering `/w/:workspaceId` asks the server (bootstrap) every time.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { routeTitle, workspaceRoutes, type RouteMatch } from "@morrow/contracts/routes";
import {
  AccountScreen,
  AppShell,
  AskScreen,
  Button,
  ConnectionScreen,
  ConnectionsScreen,
  Dialog,
  EntryLayout,
  HomeScreen,
  InboxScreen,
  ModelDefaultScreen,
  NotFoundScreen,
  QuestionScreen,
  ReentryNotice,
  ServicesProvider,
  SettingsFrame,
  SignedOutScreen,
  SignInScreen,
  SignOutUnconfirmedScreen,
  StateView,
  TaskScreen,
  UnavailableDestination,
  WorkScreen,
  WorkspaceLoadFailedScreen,
  WorkspaceUnavailableScreen,
  copy,
  inSettings,
  useRead,
  useServices,
  useServicesVersion,
  type ChallengeHost,
  type Composed,
  type Id,
  type Outcome,
  type StoreLinkHandoff,
  type UiServices,
  type WorkspacePort,
  type WorkspaceView,
} from "@morrow/workspace-ui";
import { captureHandoff, type Handoff } from "./handoff";
import { newCommandKey } from "./http/client";
import { clearIntended, storeIntended, takeIntended } from "./intended-route";
import { createLeaveGuard, type LeaveGuard } from "./leave-guard";
import { clearMorrowStorage, createPending, type Pending } from "./pending";
import { createRouter, type LeaveRequest, type Router } from "./router";

export type SessionView =
  | { readonly kind: "active" }
  | {
      readonly kind: "expired";
      readonly workspaceId: Id | null;
      readonly draftsDropped: boolean;
      /** The account landing's first read was a 401 and nothing private was shown. */
      readonly fresh: boolean;
    }
  | {
      readonly kind: "workspace_unavailable";
      readonly workspaceId: Id;
      readonly offerSignIn: boolean;
    }
  | { readonly kind: "probe_failed"; readonly workspaceId: Id }
  | { readonly kind: "signed_out" }
  | { readonly kind: "sign_out_unconfirmed" };
type Entry =
  | { readonly ws: Id; readonly state: "loading" }
  | { readonly ws: Id; readonly state: "ok"; readonly view: WorkspaceView }
  | { readonly ws: Id; readonly state: "failed" };

export interface AppProps {
  readonly port: WorkspacePort;
  readonly composed: Composed;
  readonly loginBodyVersion: 1 | 2;
  /** Leaves the page for sign-in; each entry validates its own target. */
  readonly assignLocation: (url: string) => void;
  /**
   * A full document load of `/`. An ended session view (signed out, unavailable, sign-in)
   * leaves this way, so nothing private stays in memory (§4.6).
   */
  readonly loadRoot: () => void;
  /** Created once per page load by the entry, outside React (StrictMode-safe). */
  readonly runtime: AppRuntime;
  readonly fixture?: ReactNode;
  /** P05.T01ab: the bot-challenge widget host; without one no form asks for a token. */
  readonly challenge?: ChallengeHost;
}

/** A host for builds that ask for no challenge (the fixture build). */
export const noChallenge: ChallengeHost = () => ({
  token: () => Promise.resolve(null),
  reset: () => {},
  remove: () => {},
});

export interface AppRuntime {
  readonly router: Router;
  readonly guard: LeaveGuard;
  readonly pending: Pending;
  /** Set once when `/` restored the intended route on this load (§4.6). */
  restored: { path: string; consumed: boolean } | null;
  /**
   * M2 PR-2: the install continuation this load was opened with (memory only), until its
   * link step settles or the session view ends.
   */
  handoff: Handoff | null;
  requestLeave: (request: LeaveRequest) => void;
}

/** One per page load: the router, guard and pending commands, and the one restore. */
export function createAppRuntime(): AppRuntime {
  // `/` reads the intended route once, deletes it and re-validates it before use.
  let restored: AppRuntime["restored"] = null;
  if (window.location.pathname === "/" && !window.location.search && !window.location.hash) {
    const intended = takeIntended();
    if (intended) {
      window.history.replaceState(null, "", intended);
      restored = { path: intended, consumed: false };
    }
  }
  // M2 PR-2: `/w/:ws/connections#handoff=<token>` is read and replaced before the router
  // reads the address (anything else with a fragment stays NotFound).
  const handoff = captureHandoff(window, newCommandKey);
  const pending = createPending();
  const guard = createLeaveGuard(window, () => pending.blocking());
  pending.subscribe(() => guard.sync());
  const runtime: AppRuntime = {
    router: undefined as unknown as Router,
    guard,
    pending,
    restored,
    handoff,
    requestLeave: () => {},
  };
  const router = createRouter(window, guard, (request) => runtime.requestLeave(request));
  return Object.assign(runtime, { router });
}

/**
 * §4.6: a workspace 401 can't tell foreign, revoked, non-member and expired apart.
 * With the account list composed, one probe decides. Without it (PR-1), a 401 on the
 * first workspace request after a restore is "unavailable to you" (no loop); any other
 * 401 asks for sign-in.
 */
export function workspace401Decision(state: {
  readonly overviewComposed: boolean;
  readonly restored: { readonly consumed: boolean } | null;
}): "probe" | "workspace_unavailable" | "expire" {
  if (state.overviewComposed) return "probe";
  if (state.restored && !state.restored.consumed) return "workspace_unavailable";
  return "expire";
}
/**
 * The path to keep as the intended route when a session ends, unless it was just
 * restored: a restore whose bootstrap never succeeded is dropped, so sign-in cannot
 * loop. Once the restored path was entered, it is an ordinary path to resume.
 */
export function intendedOnExpiry(
  path: string,
  restored: { readonly path: string; readonly consumed: boolean } | null,
): string | null {
  return restored && !restored.consumed && restored.path === path ? null : path;
}

const sessionTitles = {
  expired: copy.signIn.sessionEndedTitle,
  workspace_unavailable: copy.workspace.unavailableTitle,
  probe_failed: copy.workspace.loadFailedTitle,
  signed_out: copy.signOut.doneTitle,
  sign_out_unconfirmed: copy.signOut.unconfirmedTitle,
} as const satisfies Record<Exclude<SessionView["kind"], "active">, string>;
/**
 * document.title: each screen's own fixed heading (WCAG 2.4.2) or its route title,
 * never record text (AC03).
 */
export function screenTitle(view: {
  readonly session: SessionView["kind"];
  readonly match: RouteMatch | null;
  readonly entryFailed: boolean;
  readonly fresh?: boolean;
}): string {
  if (view.session === "expired" && view.fresh) return copy.signIn.title;
  if (view.session !== "active") return sessionTitles[view.session];
  if (!view.match) return copy.notFound.title;
  if (view.entryFailed) return copy.workspace.loadFailedTitle;
  return destinationTitle(view.match.id, view.match.params.section);
}
/**
 * A route's name as the interface shows it: the Sunrise label where it differs from the
 * contract's title (ADR-0032: "Work" is Projects, "Agents" is Team; a settings section by
 * its own name), else the contract's.
 */
export function destinationTitle(id: string, section?: string): string {
  if (id === "settings_section" && section !== undefined)
    if (Object.hasOwn(copy.settings.sections, section)) return copy.settings.sections[section]!;
  return Object.hasOwn(copy.routeTitles, id)
    ? copy.routeTitles[id]!
    : (routeTitle(workspaceRoutes, id) ?? copy.notFound.title);
}

const workspaceScoped = (match: RouteMatch | null): Id | null =>
  match && typeof match.params.workspaceId === "string" ? match.params.workspaceId : null;

export function App({
  port,
  composed,
  loginBodyVersion,
  assignLocation,
  loadRoot,
  runtime,
  fixture,
  challenge = noChallenge,
}: AppProps) {
  const { router, guard, pending } = runtime;
  const route = useSyncExternalStore(router.subscribe, router.state);
  const [session, setSession] = useState<SessionView>({ kind: "active" });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [entry, setEntry] = useState<Entry | null>(null);
  const [leave, setLeave] = useState<LeaveRequest | null>(null);
  const [signOutState, setSignOutState] = useState<"idle" | "busy" | "incomplete">("idle");
  const reads = useRef(new Map<string, Promise<Outcome<unknown>>>());
  runtime.requestLeave = setLeave;

  // A 401 or a sign-out ends the private view and bypasses the leave guard, including a
  // "Leave this page?" dialog that was already open.
  const ended = () => {
    // An ended session view never keeps a continuation (it was bound to that session).
    runtime.handoff = null;
    reads.current = new Map();
    setEntry(null);
    setLeave(null);
    guard.bypass();
  };
  // Whether any private reply (a workspace entry, the account list or a work read) was
  // shown on this page load: a first 401 at `/` before that is the signed-out entry.
  const privateShown = useRef(false);
  const expire = (workspaceId: Id | null) => {
    const draftsDropped = guard.hasDirty();
    const intended = intendedOnExpiry(router.state().path, runtime.restored);
    if (intended === null) clearIntended();
    else storeIntended(intended);
    ended();
    const fresh = workspaceId === null && !privateShown.current;
    setSession({ kind: "expired", workspaceId, draftsDropped, fresh });
  };
  // Concurrent 401s (two panels, a read and a command) are handled once: one probe.
  const handling = useRef(false);
  const unauthenticated = async (scope: { readonly workspaceId: Id | null }) => {
    if (sessionRef.current.kind !== "active" || handling.current) return;
    handling.current = true;
    const ws = scope.workspaceId;
    if (ws === null) return expire(null);
    const decision = workspace401Decision({
      overviewComposed: composed["account.overview"],
      restored: runtime.restored,
    });
    if (decision === "probe") {
      const probe = await port.account.overview();
      if (sessionRef.current.kind !== "active") return;
      if (probe.kind === "ok") {
        clearIntended();
        ended();
        setSession({ kind: "workspace_unavailable", workspaceId: ws, offerSignIn: false });
      } else if (probe.kind === "unauthenticated") expire(ws);
      else {
        ended();
        setSession({ kind: "probe_failed", workspaceId: ws });
      }
      return;
    }
    const restored = runtime.restored;
    if (decision === "workspace_unavailable" && restored) {
      // One failed restore discards the intended route, so sign-in cannot loop.
      restored.consumed = true;
      clearIntended();
      ended();
      setSession({ kind: "workspace_unavailable", workspaceId: ws, offerSignIn: true });
      return;
    }
    expire(ws);
  };
  const unauthenticatedRef = useRef(unauthenticated);
  unauthenticatedRef.current = unauthenticated;

  // Every port reply passes here: a 401 ends the private view (§4.6).
  const guarded = useMemo(
    () =>
      guardPort(
        port,
        (ws) => void unauthenticatedRef.current({ workspaceId: ws }),
        () => {
          privateShown.current = true;
        },
      ),
    [port],
  );

  const services = useMemo<UiServices>(
    () => ({
      port: guarded,
      composed,
      loginBodyVersion,
      fixture: fixture !== undefined,
      navigate: (path, options) => {
        router.navigate(path, options?.replace ? { replace: true } : {});
      },
      // The session view is chosen before the route, so an ended view is left by a full
      // document load; an active one navigates in the app.
      openAccount: () => {
        if (sessionRef.current.kind === "active") router.navigate("/");
        else loadRoot();
      },
      setDirty: (token, dirty) => guard.setDirty(token, dirty),
      read: <T,>(key: string, load: () => Promise<Outcome<T>>) => {
        const existing = reads.current.get(key) as Promise<Outcome<T>> | undefined;
        if (existing) return existing;
        const map = reads.current;
        const promise = load().finally(() => {
          if (map.get(key) === promise) map.delete(key);
        });
        map.set(key, promise as Promise<Outcome<unknown>>);
        return promise;
      },
      newCommand: (body) => ({ key: newCommandKey(), body }),
      runCommand: (command, marker, send) => pending.run(command, marker, send),
      releaseCommand: (key) => pending.release(key),
      reentryMarkers: (ws) => {
        const live = pending.liveMarkers();
        return pending
          .markers()
          .filter(
            (m) => m.workspaceId === ws && !live.some((l) => l.at === m.at && l.kind === m.kind),
          );
      },
      dismissMarker: (marker) => pending.dismiss(marker),
      subscribe: (listener) => pending.subscribe(listener),
      version: () => pending.version(),
      startSignIn: async (workspaceId, token) => {
        const outcome = await port.session.startSignIn(workspaceId, token);
        if (outcome.kind !== "ok") return "failed";
        assignLocation(outcome.value.navigateTo);
        return "started";
      },
      signOut: () => void signOutRef.current(),
      challenge,
    }),
    // Stable for the app's life: the props it reads never change, callbacks read refs.
    [guarded],
  );

  const finishSignOut = (kind: "signed_out" | "sign_out_unconfirmed") => {
    pending.clear();
    clearMorrowStorage();
    ended();
    setSession({ kind });
  };
  const signOut = async () => {
    if (signOutState === "busy") return;
    setSignOutState("busy");
    const outcome = await port.session.signOut();
    setSignOutState("idle");
    if (outcome.kind === "ok" || outcome.kind === "denied") finishSignOut("signed_out");
    else if (outcome.kind === "uncertain") finishSignOut("sign_out_unconfirmed");
    else if (sessionRef.current.kind === "active") setSignOutState("incomplete");
  };
  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;
  const retrySignOut = async () => {
    setSignOutState("busy");
    const outcome = await port.session.signOut();
    setSignOutState("idle");
    if (outcome.kind === "ok" || outcome.kind === "denied") setSession({ kind: "signed_out" });
  };

  // Workspace entry: one bootstrap per workspace (and per Retry); caches drop on a switch.
  const ws = session.kind === "active" ? workspaceScoped(route.match) : null;
  const [attempt, setAttempt] = useState(0);
  const entering = useRef<{ key: string; promise: Promise<Outcome<WorkspaceView>> } | null>(null);
  useEffect(() => {
    if (ws === null) return;
    if (entry && entry.ws === ws && entry.state !== "failed") return;
    if (entry && entry.ws !== ws) reads.current = new Map();
    let live = true;
    setEntry({ ws, state: "loading" });
    const key = `${ws}#${attempt}`;
    if (entering.current?.key !== key)
      entering.current = { key, promise: port.workspace.bootstrap(ws) };
    entering.current.promise.then((outcome) => {
      if (!live) return;
      if (outcome.kind === "ok") {
        if (runtime.restored) runtime.restored.consumed = true;
        privateShown.current = true;
        setEntry({ ws, state: "ok", view: outcome.value });
      } else if (outcome.kind === "unauthenticated")
        void unauthenticatedRef.current({ workspaceId: ws });
      else setEntry({ ws, state: "failed" });
    });
    return () => {
      live = false;
    };
    // `entry` is read, not watched: a new workspace or a retry starts a bootstrap.
  }, [ws, attempt, port]);

  const title = screenTitle({
    session: session.kind,
    match: route.match,
    entryFailed: ws !== null && entry?.ws === ws && entry.state === "failed",
    fresh: session.kind === "expired" && session.fresh,
  });
  useEffect(() => {
    document.title = `${title} · ${copy.brand}`;
  }, [title]);

  // In-app navigation moves focus to the main region (not on the first load).
  const firstPath = useRef(route.path);
  useEffect(() => {
    if (route.path === firstPath.current) return;
    firstPath.current = route.path;
    document.getElementById("main")?.focus({ preventScroll: false });
  }, [route.path]);

  // A return to the tab re-reads the markers another tab may have written.
  const [, setVisible] = useState(0);
  useEffect(() => {
    const changed = () => setVisible((n) => n + 1);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);

  const leaveDialog = (
    <Dialog
      open={leave !== null}
      title={copy.leave.title}
      onClose={() => setLeave(null)}
      footer={
        <>
          <Button data-initial-focus onClick={() => setLeave(null)}>
            {copy.leave.stay}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const target = leave;
              setLeave(null);
              if (target) router.navigate(target.target, { replace: target.replace, force: true });
            }}
          >
            {copy.leave.leave}
          </Button>
        </>
      }
    >
      <p>{copy.leave.body}</p>
    </Dialog>
  );

  let content: ReactNode;
  const entryLayout = (children: ReactNode) => (
    <EntryLayout fixture={fixture}>{children}</EntryLayout>
  );
  if (session.kind === "signed_out") content = entryLayout(<SignedOutScreen />);
  else if (session.kind === "sign_out_unconfirmed")
    content = entryLayout(
      <SignOutUnconfirmedScreen
        busy={signOutState === "busy"}
        onRetry={() => void retrySignOut()}
      />,
    );
  else if (session.kind === "expired")
    content = entryLayout(
      <SignInScreen
        workspaceId={session.workspaceId}
        draftsDropped={session.draftsDropped}
        fresh={session.fresh}
      />,
    );
  else if (session.kind === "workspace_unavailable")
    content = entryLayout(
      <WorkspaceUnavailableScreen
        workspaceId={session.workspaceId}
        offerSignIn={session.offerSignIn}
      />,
    );
  else if (session.kind === "probe_failed")
    content = entryLayout(
      <WorkspaceLoadFailedScreen
        onRetry={() => {
          handling.current = false;
          setSession({ kind: "active" });
          setEntry(null);
          setAttempt((n) => n + 1);
        }}
      />,
    );
  else if (!route.match) content = entryLayout(<NotFoundScreen />);
  else if (route.match.id === "account")
    content = entryLayout(
      <AccountScreen signOutState={signOutState} onSignOut={() => void signOutRef.current()} />,
    );
  else if (ws === null || !entry || entry.ws !== ws || entry.state === "loading")
    content = entryLayout(<StateView kind="loading" />);
  else if (entry.state === "failed")
    content = entryLayout(<WorkspaceLoadFailedScreen onRetry={() => setAttempt((n) => n + 1)} />);
  else
    content = (
      <WorkspaceFrame
        workspace={entry.view}
        match={route.match}
        fixture={fixture}
        signOutState={signOutState}
        onSignOut={() => void signOutRef.current()}
        handoff={
          runtime.handoff && runtime.handoff.workspaceId === entry.view.id
            ? { token: runtime.handoff.token, key: runtime.handoff.key }
            : null
        }
        onHandoffSettled={() => {
          runtime.handoff = null;
        }}
      />
    );
  return (
    <ServicesProvider value={services}>
      {content}
      {leaveDialog}
    </ServicesProvider>
  );
}

function WorkspaceFrame({
  workspace,
  match,
  fixture,
  signOutState,
  onSignOut,
  handoff,
  onHandoffSettled,
}: {
  readonly workspace: WorkspaceView;
  readonly match: RouteMatch;
  readonly fixture: ReactNode;
  readonly signOutState: "idle" | "busy" | "incomplete";
  readonly onSignOut: () => void;
  readonly handoff: StoreLinkHandoff | null;
  readonly onHandoffSettled: () => void;
}) {
  const services = useServices();
  useServicesVersion();
  const [overview] = useRead(
    services.composed["account.overview"] ? "account.overview" : null,
    () => services.port.account.overview(),
  );
  const markers = services.reentryMarkers(workspace.id);
  const notices = (
    <>
      {signOutState === "incomplete" ? (
        <div role="status" className="notice notice-danger">
          <p>{copy.signOut.incomplete}</p>
          <Button onClick={onSignOut}>{copy.signOut.tryAgain}</Button>
        </div>
      ) : null}
      {markers.map((marker) => (
        <ReentryNotice
          key={`${marker.kind}-${marker.at}`}
          marker={marker}
          onDismiss={() => services.dismissMarker(marker)}
        />
      ))}
    </>
  );
  const params = match.params;
  const screen = (() => {
    switch (match.id) {
      case "home":
        return <HomeScreen workspace={workspace} />;
      case "work":
        return <WorkScreen workspace={workspace} />;
      case "task":
        return <TaskScreen workspace={workspace} taskId={params.taskId!} />;
      // M3 PR-2: Ask, a Listings run on picked products.
      case "ask":
        return services.composed["runs.admit"] ? (
          <AskScreen workspace={workspace} />
        ) : (
          <UnavailableDestination title={destinationTitle(match.id)} />
        );
      case "inbox":
        return <InboxScreen workspace={workspace} />;
      case "question":
        return <QuestionScreen workspace={workspace} questionId={params.questionId!} />;
      // M2 PR-2: the store connections screens.
      case "connections":
        return (
          <ConnectionsScreen
            workspace={workspace}
            handoff={handoff}
            onHandoffSettled={onHandoffSettled}
          />
        );
      case "connection":
        return <ConnectionScreen workspace={workspace} connectionId={params.connectionId!} />;
      // M3 PR-1: the model default under Settings > Governance (the Listings agent card is
      // on the connection screen above).
      case "settings_section":
        return params.section === "governance" ? (
          <ModelDefaultScreen workspace={workspace} />
        ) : (
          <UnavailableDestination title={destinationTitle(match.id, params.section)} />
        );
      default:
        return <UnavailableDestination title={destinationTitle(match.id)} />;
    }
  })();
  const page = match.id + JSON.stringify(params);
  return (
    <AppShell
      workspace={workspace}
      currentRoute={match.id}
      page={page}
      switcherWorkspaces={overview.kind === "ok" ? overview.value.workspaces : null}
      onSignOut={onSignOut}
      signOutBusy={signOutState === "busy"}
      notices={notices}
      fixture={fixture}
    >
      <div key={page}>
        {inSettings(match.id) ? (
          <SettingsFrame workspaceId={workspace.id} route={match.id} sectionParam={params.section}>
            {screen}
          </SettingsFrame>
        ) : (
          screen
        )}
      </div>
    </AppShell>
  );
}

/**
 * Wraps a port so every `unauthenticated` reply reaches the app's §4.6 handling, and
 * every confirmed private reply is noted (`onPrivate`).
 */
export function guardPort(
  port: WorkspacePort,
  onUnauthenticated: (workspaceId: Id | null) => void,
  onPrivate: () => void = () => {},
): WorkspacePort {
  const watch =
    <A extends unknown[], R>(
      fn: (...args: A) => Promise<Outcome<R>>,
      scope: (args: A) => Id | null,
    ) =>
    async (...args: A): Promise<Outcome<R>> => {
      const outcome = await fn(...args);
      if (outcome.kind === "unauthenticated") onUnauthenticated(scope(args));
      else if (outcome.kind === "ok") onPrivate();
      return outcome;
    };
  const first = (args: readonly unknown[]) => (typeof args[0] === "string" ? args[0] : null);
  const work = Object.fromEntries(
    Object.entries(port.work).map(([name, fn]) => [
      name,
      watch((fn as (...a: unknown[]) => Promise<Outcome<unknown>>).bind(port.work), first),
    ]),
  ) as unknown as WorkspacePort["work"];
  return {
    session: port.session,
    workspace: { bootstrap: port.workspace.bootstrap.bind(port.workspace) },
    account: {
      overview: watch(port.account.overview.bind(port.account), () => null),
      createOrganization: watch(port.account.createOrganization.bind(port.account), () => null),
    },
    work,
    people: { list: watch(port.people.list.bind(port.people), first) },
    connections: {
      list: watch(port.connections.list.bind(port.connections), first),
      disconnectStatus: watch(port.connections.disconnectStatus.bind(port.connections), first),
      disconnect: watch(port.connections.disconnect.bind(port.connections), first),
    },
    storeLinks: {
      preview: watch(port.storeLinks.preview.bind(port.storeLinks), first),
      apply: watch(port.storeLinks.apply.bind(port.storeLinks), first),
      status: watch(port.storeLinks.status.bind(port.storeLinks), first),
    },
    agents: {
      listingsStatus: watch(port.agents.listingsStatus.bind(port.agents), first),
      listingsDocument: watch(port.agents.listingsDocument.bind(port.agents), first),
      listingsEnable: watch(port.agents.listingsEnable.bind(port.agents), first),
      listingsStop: watch(port.agents.listingsStop.bind(port.agents), first),
    },
    runs: {
      admit: watch(port.runs.admit.bind(port.runs), first),
      listOfTask: watch(port.runs.listOfTask.bind(port.runs), first),
      get: watch(port.runs.get.bind(port.runs), first),
      reconcile: watch(port.runs.reconcile.bind(port.runs), first),
    },
    models: {
      list: watch(port.models.list.bind(port.models), first),
      reviseDefault: watch(port.models.reviseDefault.bind(port.models), first),
    },
    samples: { home: watch(port.samples.home.bind(port.samples), first) },
  };
}
