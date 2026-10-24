// P14.T01a §4.7: the one port screens depend on. The HTTP adapter and the scripted
// fixture adapter (apps/workspace-web) both implement it. No screen sees a transport.
import type {
  AccountOverviewView,
  AnswerView,
  ApplyResultView,
  ConnectionDisconnectView,
  ConnectionsView,
  DisconnectResultView,
  GoalView,
  Id,
  ListingsAgentView,
  ListingsChangeView,
  ListingsDocumentView,
  ModelCatalogueView,
  OperationView,
  Page,
  PendingApprovalView,
  PersonRef,
  QuestionView,
  RecordRefView,
  ReviewDecidedView,
  ReviewDecisionBody,
  ReviewView,
  RunAdmittedView,
  RunDetailView,
  RunView,
  StoreLinkPreviewView,
  StoreLinkResultView,
  TaskView,
  WorkspaceView,
} from "./model";

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
  /**
   * v1 PR 3: review, approve and apply. The review shows before and after per product and
   * field; a decision binds the exact digest it names (a selection previews its own); apply
   * claims that exact approval and writes each product once through the gateway (the same
   * key continues an apply that ran out of time); a recheck reads one product back; the
   * person who applied an uncertain change may set it aside once they checked it in Shopify
   * (nothing is sent; Morrow keeps checking).
   */
  readonly review: {
    listPending(ws: Id): Promise<Outcome<readonly PendingApprovalView[]>>;
    get(ws: Id, proposalId: Id, selected: readonly number[] | null): Promise<Outcome<ReviewView>>;
    decide(
      ws: Id,
      proposalId: Id,
      c: Command<ReviewDecisionBody>,
    ): Promise<Outcome<ReviewDecidedView>>;
    apply(
      ws: Id,
      proposalId: Id,
      c: Command<{ readonly proposalRef: RecordRefView; readonly approvalRef: RecordRefView }>,
    ): Promise<Outcome<ApplyResultView>>;
    operationsOfTask(ws: Id, taskId: Id): Promise<Outcome<readonly OperationView[]>>;
    recheck(
      ws: Id,
      operationId: Id,
      c: Command<Record<string, never>>,
    ): Promise<Outcome<OperationView>>;
    setAside(
      ws: Id,
      operationId: Id,
      c: Command<Record<string, never>>,
    ): Promise<Outcome<OperationView>>;
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
  "review.listPending",
  "review.get",
  "review.decide",
  "review.apply",
  "review.operationsOfTask",
  "review.recheck",
  "review.setAside",
] as const;
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
