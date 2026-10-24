// P14.T01a §4.7: the one port screens depend on. The HTTP adapter and the scripted
// fixture adapter (apps/workspace-web) both implement it. No screen sees a transport.
import type {
  AccountOverviewView,
  AnswerView,
  ConnectionDisconnectView,
  ConnectionsView,
  DisconnectResultView,
  GoalView,
  HomeSamplesView,
  Id,
  ListingsAgentView,
  ListingsChangeView,
  ListingsDocumentView,
  ModelCatalogueView,
  Page,
  PersonRef,
  QuestionView,
  RunAdmittedView,
  RunDetailView,
  RunView,
  StoreLinkPreviewView,
  StoreLinkResultView,
  TaskView,
  WorkspaceView,
} from "./model";
import type {
  AskConversationView,
  ChoiceAnswer,
  PlanEdits,
  PlanStartDocumentView,
  PlanStartResultView,
  ProjectConversationView,
  ProjectDetailView,
  ProjectsOverviewView,
  ProjectTasksView,
  RepeatingView,
  StopStepsResultView,
} from "./projects/model";
import { teamPortMethods, type LibraryPort, type SettingsPort, type TeamPort } from "./team-model";

export type Outcome<T> =
  | { readonly kind: "ok"; readonly value: T; readonly replayed: boolean }
  | { readonly kind: "unauthenticated" } // 401 (§4.6)
  | { readonly kind: "denied"; readonly message: string; readonly reference: string | null } // 403
  | { readonly kind: "not_found" } // 404: absent, foreign or not viewable
  | { readonly kind: "conflict"; readonly recheck: boolean; readonly message: string } // 409
  // 400; `message` is the server's safe message where the route names one (a run refusal).
  | { readonly kind: "invalid"; readonly field: string | null; readonly message?: string }
  | { readonly kind: "rate_limited"; readonly retryAfterSeconds: number } // 429: nothing ran
  | { readonly kind: "unavailable"; readonly offline: boolean } // reads; commands never yet uncertain
  | { readonly kind: "uncertain" } // §4.9: only a decoded terminal reply ends it
  | { readonly kind: "not_in_build" };

/** A command keeps one lowercase UUID v4 key, reused verbatim until a terminal reply. */
export interface Command<B> {
  readonly key: string;
  readonly body: Readonly<B>;
}

/**
 * P05.T01ab: the bot challenge a guarded POST carries (`X-Morrow-Challenge`). The app
 * mounts one invisible widget per form in a host element the screen renders.
 */
export type ChallengeAction = "login" | "signup";
export interface ChallengeWidget {
  /**
   * A fresh single-use token for the next POST; `null` when the server asks for no
   * challenge (`{"provider":"none"}`); `"failed"` when none could be obtained.
   */
  token(): Promise<string | null | "failed">;
  /** After every guarded POST, so the next one gets a fresh token. */
  reset(): void;
  remove(): void;
}
export type ChallengeHost = (action: ChallengeAction, element: HTMLElement) => ChallengeWidget;

export interface WorkspacePort {
  readonly session: {
    /** `challenge` is the X-Morrow-Challenge token, or null when none is asked for. */
    startSignIn(
      workspaceId: Id | null,
      challenge?: string | null,
    ): Promise<Outcome<{ readonly navigateTo: string }>>;
    signOut(): Promise<Outcome<"ended">>;
    keepAlive(): Promise<Outcome<null>>; // not_in_build until the P05.T01y keeper (§4.14)
  };
  readonly workspace: { bootstrap(ws: Id): Promise<Outcome<WorkspaceView>> };
  readonly account: {
    overview(): Promise<Outcome<AccountOverviewView>>;
    /** `challenge` is the X-Morrow-Challenge token (P05.T01ab), or null when none is asked for. */
    createOrganization(
      c: Command<{ organizationName: string; workspaceName: string }>,
      challenge?: string | null,
    ): Promise<Outcome<{ readonly workspaceId: Id }>>;
  };
  readonly work: {
    listGoals(ws: Id, after: string | null): Promise<Outcome<Page<GoalView>>>;
    getGoal(ws: Id, id: Id): Promise<Outcome<GoalView>>;
    createGoal(
      ws: Id,
      c: Command<{ objective: string; criteria: readonly string[] }>,
    ): Promise<Outcome<{ readonly goalId: Id }>>;
    listTasks(ws: Id, goalId: Id, after: string | null): Promise<Outcome<Page<TaskView>>>;
    getTask(ws: Id, id: Id): Promise<Outcome<TaskView>>;
    createTask(
      ws: Id,
      c: Command<{ goalId: Id; objective: string }>,
    ): Promise<Outcome<{ readonly taskId: Id }>>;
    markReady(
      ws: Id,
      id: Id,
      c: Command<{ expectedRevision: number }>,
    ): Promise<Outcome<{ readonly revision: number }>>;
    assign(
      ws: Id,
      id: Id,
      c: Command<{ assigneeId: Id; expectedRevision: number }>,
    ): Promise<Outcome<{ readonly revision: number }>>;
    listTaskQuestions(
      ws: Id,
      taskId: Id,
      after: string | null,
    ): Promise<Outcome<Page<QuestionView>>>;
    ask(
      ws: Id,
      taskId: Id,
      c: Command<{ question: string; respondentId: Id }>,
    ): Promise<Outcome<{ readonly questionId: Id }>>;
    listMyOpenQuestions(ws: Id, after: string | null): Promise<Outcome<Page<QuestionView>>>;
    getQuestion(ws: Id, id: Id): Promise<Outcome<QuestionView>>;
    answer(
      ws: Id,
      id: Id,
      c: Command<{ text: string; expectedRevision: number }>,
    ): Promise<Outcome<{ readonly answerRevision: number }>>;
    cancelQuestion(
      ws: Id,
      id: Id,
      c: Command<{ expectedRevision: number }>,
    ): Promise<Outcome<{ readonly revision: number }>>;
    getAnswer(ws: Id, id: Id): Promise<Outcome<AnswerView>>;
  };
  readonly people: { list(ws: Id): Promise<Outcome<readonly PersonRef[]>> }; // not_in_build (§4.14)
  // M2 PR-2: the workspace's store connections and the install-link offer.
  readonly connections: {
    list(ws: Id): Promise<Outcome<ConnectionsView>>;
    /** "Disconnect store": the connection's state and whether this person may disconnect. */
    disconnectStatus(ws: Id, connectionId: Id): Promise<Outcome<ConnectionDisconnectView>>;
    /** "Disconnect store": a person's kill switch on the whole store, with their reason. */
    disconnect(
      ws: Id,
      connectionId: Id,
      c: Command<{ reason: string }>,
    ): Promise<Outcome<DisconnectResultView>>;
  };
  // M2 PR-2 (P05.T03b routes, the P09.T02a issuer behind preview): link the store an install
  // continuation names. The handoff token is the fragment the connector redirect carried;
  // it lives in memory only. All three reuse the handoff's one command key; apply also
  // sends the CSRF value preview returned.
  readonly storeLinks: {
    preview(ws: Id, c: Command<{ handoffToken: string }>): Promise<Outcome<StoreLinkPreviewView>>;
    apply(
      ws: Id,
      c: Command<{ handoffToken: string }>,
      csrfToken: string,
    ): Promise<Outcome<StoreLinkResultView>>;
    status(ws: Id, c: Command<{ handoffToken: string }>): Promise<Outcome<StoreLinkResultView>>;
  };
  /** M3 PR-1: the Listings agent of one connected store. */
  readonly agents: {
    listingsStatus(ws: Id, storeId: Id): Promise<Outcome<ListingsAgentView>>;
    /** Step 1 of Enable (or resume): the server builds the document the owner confirms. */
    listingsDocument(
      ws: Id,
      storeId: Id,
      c: Command<Record<string, never>>,
    ): Promise<Outcome<ListingsDocumentView>>;
    /** Step 2: confirms exactly that document, by its digest and single-use nonce. */
    listingsEnable(
      ws: Id,
      storeId: Id,
      c: Command<{ documentDigest: string; nonce: string }>,
    ): Promise<Outcome<ListingsChangeView>>;
    /** "Stop AI work": a person's kill switch, with their reason. */
    listingsStop(
      ws: Id,
      storeId: Id,
      c: Command<{ reason: string }>,
    ): Promise<Outcome<ListingsChangeView>>;
  };
  /**
   * M3 PR-2: Listings runs on a task. Admission names a linked store, 1 to 25 products, the
   * listing fields and a catalogue selection (or null for the workspace default); never a
   * provider, price or credit amount. Reconcile closes the workspace's interrupted runs.
   */
  readonly runs: {
    admit(
      ws: Id,
      taskId: Id,
      c: Command<{
        storeId: Id;
        products: readonly string[];
        fields: readonly string[];
        selection: { readonly model: string; readonly effort: string } | null;
      }>,
    ): Promise<Outcome<RunAdmittedView>>;
    listOfTask(ws: Id, taskId: Id): Promise<Outcome<readonly RunView[]>>;
    get(ws: Id, runId: Id): Promise<Outcome<RunDetailView>>;
    reconcile(
      ws: Id,
      c: Command<Record<string, never>>,
    ): Promise<Outcome<{ readonly closed: number }>>;
  };
  /** M3 PR-1: the model catalogue and the workspace's default and member ceiling. */
  readonly models: {
    list(ws: Id): Promise<Outcome<ModelCatalogueView>>;
    reviseDefault(
      ws: Id,
      c: Command<{
        model: string;
        effort: string;
        maxCreditsPerProduct: number;
        expectedRevision: number | null;
      }>,
    ): Promise<Outcome<{ readonly revision: number }>>;
  };
  /**
   * T7 PR 19 (ADR-0033): projects, Everyday work areas and Quick tasks. No route exists
   * yet (T2 and T6 build them), so the HTTP build never composes these: each answers
   * not_in_build and sends nothing, and the screens keep today's Work view. The fixture
   * build composes them only in its projects preview scenarios. A default-off switch.
   * Bodies carry ids, revisions, one person's text and closed choices; never a tenant,
   * workspace, actor, grant, role or measured value.
   */
  readonly projects: {
    overview(ws: Id): Promise<Outcome<ProjectsOverviewView>>;
    tasks(ws: Id): Promise<Outcome<ProjectTasksView>>;
    repeating(ws: Id): Promise<Outcome<RepeatingView>>;
    get(ws: Id, projectId: Id): Promise<Outcome<ProjectDetailView>>;
    messages(ws: Id, projectId: Id): Promise<Outcome<ProjectConversationView>>;
    /** A person's message; `mentionMorrow` adds the typed @Morrow mention (request ask). */
    post(
      ws: Id,
      projectId: Id,
      c: Command<{ text: string; mentionMorrow: boolean }>,
    ): Promise<Outcome<{ readonly messageId: Id }>>;
    /** "Plan next steps": the person's act starts one Morrow run with the project in view. */
    planNextSteps(
      ws: Id,
      projectId: Id,
      c: Command<{ expectedRevision: number }>,
    ): Promise<Outcome<{ readonly messageId: Id }>>;
    /** "Stop this project's steps": person-only, under that person's grants (item 11). */
    stopSteps(
      ws: Id,
      projectId: Id,
      c: Command<{ expectedRevision: number }>,
    ): Promise<Outcome<StopStepsResultView>>;
    /** Extend: `workspace.goal.revise` of the end date (`YYYY-MM-DD`). */
    extend(
      ws: Id,
      projectId: Id,
      c: Command<{ endsOn: string; expectedRevision: number }>,
    ): Promise<Outcome<{ readonly revision: number }>>;
    /** Step 1 of Finish: the server builds the start document of its code-built card. */
    finishDocument(
      ws: Id,
      projectId: Id,
      c: Command<{ keepRepeating: boolean; expectedRevision: number }>,
    ): Promise<Outcome<PlanStartDocumentView>>;
    /** "Set it up yourself": the ordinary form, as the person's own commands. */
    create(
      ws: Id,
      c: Command<{ title: string; endsOn: string; goal: string }>,
    ): Promise<Outcome<{ readonly projectId: Id }>>;
  };
  /**
   * T7 PR 19 (ADR-0034): Ask Morrow's plan cards and the person-bound plan start. Off like
   * `projects`. A card creates nothing; Start is the server's start document for the
   * draft digest it holds, consumed once by the same person's tap.
   */
  readonly plans: {
    ask(
      ws: Id,
      c: Command<{ conversationId: Id | null; text: string }>,
    ): Promise<Outcome<{ readonly conversationId: Id }>>;
    conversation(ws: Id, conversationId: Id): Promise<Outcome<AskConversationView>>;
    /** A tapped answer starts a new run as the person's act. */
    answer(
      ws: Id,
      conversationId: Id,
      c: Command<{ messageId: Id; answer: ChoiceAnswer }>,
    ): Promise<Outcome<{ readonly messageId: Id }>>;
    /** Edit: a new revision with a new digest, keeping the original's taint. */
    revise(
      ws: Id,
      conversationId: Id,
      c: Command<{ messageId: Id; draftDigest: string; edits: PlanEdits }>,
    ): Promise<Outcome<{ readonly draftDigest: string; readonly revision: number }>>;
    /** Step 1 of Start: the server builds PlanStartDocument@1 (5 minutes, single use). */
    startDocument(
      ws: Id,
      c: Command<{ messageId: Id; draftDigest: string }>,
    ): Promise<Outcome<PlanStartDocumentView>>;
    /** Step 2: consumes exactly that document, by its digest and nonce. */
    start(
      ws: Id,
      c: Command<{ documentDigest: string; nonce: string }>,
    ): Promise<Outcome<PlanStartResultView>>;
  };
  /** T7 PR 16: Team, agent pages and Add agents; Settings; Shop knowledge and Files. */
  readonly team: TeamPort;
  readonly settings: SettingsPort;
  readonly library: LibraryPort;
  /**
   * ADR-0032 Home preview: sample sections with no backend (no contract, no route). The
   * HTTP build never composes it; the fixture build composes it only in its
   * `home_preview` scenario. A default-off switch, not a feature.
   */
  readonly samples: { home(ws: Id): Promise<Outcome<HomeSamplesView>> };
}

export const portMethods = [
  "session.startSignIn",
  "session.signOut",
  "session.keepAlive",
  "workspace.bootstrap",
  "account.overview",
  "account.createOrganization",
  "work.listGoals",
  "work.getGoal",
  "work.createGoal",
  "work.listTasks",
  "work.getTask",
  "work.createTask",
  "work.markReady",
  "work.assign",
  "work.listTaskQuestions",
  "work.ask",
  "work.listMyOpenQuestions",
  "work.getQuestion",
  "work.answer",
  "work.cancelQuestion",
  "work.getAnswer",
  "people.list",
  "connections.list",
  "connections.disconnectStatus",
  "connections.disconnect",
  "storeLinks.preview",
  "storeLinks.apply",
  "storeLinks.status",
  "agents.listingsStatus",
  "agents.listingsDocument",
  "agents.listingsEnable",
  "agents.listingsStop",
  "models.list",
  "models.reviseDefault",
  "runs.admit",
  "runs.listOfTask",
  "runs.get",
  "runs.reconcile",
  "projects.overview",
  "projects.tasks",
  "projects.repeating",
  "projects.get",
  "projects.messages",
  "projects.post",
  "projects.planNextSteps",
  "projects.stopSteps",
  "projects.extend",
  "projects.finishDocument",
  "projects.create",
  "plans.ask",
  "plans.conversation",
  "plans.answer",
  "plans.revise",
  "plans.startDocument",
  "plans.start",
  ...teamPortMethods,
  "samples.home",
] as const;
/** T7 PR 19: the project screens' methods, uncomposed over HTTP until T2 and T6 land. */
export const projectPortMethods = portMethods.filter(
  (m): m is Extract<PortMethod, `projects.${string}` | `plans.${string}`> =>
    m.startsWith("projects.") || m.startsWith("plans."),
);
export type PortMethod = (typeof portMethods)[number];
/** Which port methods this build composes (§4.2). An uncomposed method sends nothing. */
export type Composed = Readonly<Record<PortMethod, boolean>>;

/**
 * M2 PR-2: an install continuation captured from `/w/:ws/connections#handoff=` (memory
 * only) and the one command key its preview, apply and status share.
 */
export interface StoreLinkHandoff {
  readonly token: string;
  readonly key: string;
}

/** A decoded reply that ends an unknown outcome (§4.9). */
export function isTerminal(outcome: Outcome<unknown>): boolean {
  return ["ok", "invalid", "denied", "not_found", "conflict"].includes(outcome.kind);
}
