// UI-internal view models (P14.T01a §4.7). These are not contracts: decoders build them
// from contract bodies, and screens render them. Statuses stay strings so an unknown
// value renders as text instead of failing.
export type Id = string;

export interface PersonRef {
  readonly principalId: Id;
  readonly kind: "human" | "agent" | "service";
  readonly label: string | null; // null until people.list exists (§4.14)
  readonly isSelf: boolean | null; // null until people.list exists; the UI never says "You"
}
export interface WorkspaceView {
  readonly id: Id;
  readonly displayName: string;
  readonly policyRevision: number;
}
export interface WorkspaceSummary {
  readonly workspaceId: Id;
  readonly displayName: string;
  /** The organization's display name; null where only the current workspace is known. */
  readonly organizationName: string | null;
}
export interface AccountOverviewView {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly truncated: boolean;
  readonly onboarding: "available" | "unavailable";
}
export interface GoalView {
  readonly id: Id;
  readonly objective: string;
  readonly status: string;
  readonly criteria: readonly string[];
  readonly owner: PersonRef;
  readonly revision: number;
  readonly updatedAt: string;
}
export interface TaskView {
  readonly id: Id;
  readonly goalId: Id | null;
  readonly objective: string;
  readonly status: string;
  readonly owner: PersonRef;
  readonly revision: number;
  readonly updatedAt: string;
}
export interface QuestionView {
  readonly id: Id;
  readonly taskId: Id;
  readonly prompt: string;
  readonly status: string;
  readonly respondent: PersonRef | null;
  readonly revision: number;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
}
export interface AnswerView {
  readonly id: Id;
  readonly questionId: Id;
  readonly text: string;
  readonly answeredBy: PersonRef;
  readonly createdAt: string;
}
// M2 PR-2: GET /workspace/:ws/connections (WorkspaceConnections@1). One store installation
// of the workspace (StoreInstallation@1, decoded); never a credential or token.
export interface StoreConnectionView {
  readonly installationId: Id;
  readonly connectionId: Id;
  readonly storeId: Id | null;
  readonly shopDomain: string;
  /** unlinked | linked | suspended | uninstalled; an unknown value renders as its text. */
  readonly status: string;
  readonly grantedScopes: readonly string[];
  readonly updatedAt: string;
}
export type InstallLinkReason =
  | "offered"
  | "linked"
  | "not_permitted"
  | "not_registered"
  | "route_not_ready";
export interface InstallLinkView {
  readonly offered: boolean;
  /** The registered https install link, only when offered. */
  readonly url: string | null;
  readonly reason: InstallLinkReason;
}
export interface ConnectionsView {
  readonly installations: readonly StoreConnectionView[];
  readonly installLink: InstallLinkView;
}
// "Disconnect store": GET /workspace/:ws/connections/:connectionId/disconnect (ids and codes
// only; never the person's reason, a credential or a token).
export interface ConnectionDisconnectView {
  readonly connectionId: Id;
  readonly storeId: Id;
  readonly installationStatus: "linked" | "suspended" | "uninstalled";
  /** The open stop on the connection: a person's disconnect, or an uninstall or scope change. */
  readonly stop: {
    readonly setBy: "human" | "system" | "operator";
    readonly reasonCode: string;
    readonly createdAt: string;
  } | null;
  /** What this person may do now (the server's kernel decided). */
  readonly actions: { readonly disconnect: boolean };
}
/** POST .../disconnect: what the disconnect found, and whether the token is erased yet. */
export interface DisconnectResultView {
  readonly priorStateObserved: "active" | "already_stopped";
  /** "pending": the store is disconnected; Morrow finishes erasing its token on its own. */
  readonly credential: "destroyed" | "pending";
}
/** The store-link preview: the installation it links and the CSRF value apply sends back. */
export interface StoreLinkPreviewView {
  readonly installationId: Id;
  readonly csrfToken: string;
}
/** A recorded link decision (apply or status): applied, or denied with nothing changed. */
export interface StoreLinkResultView {
  readonly outcome: "applied" | "denied";
}
// M3 PR-1: the Listings agent of one connected store (ADR-0022 item 3 and its amendment)
// and the workspace's model default (item 16).
export interface ListingsAgentView {
  readonly storeId: Id;
  /** The store's association is current (enable and resume need it; a stop never does). */
  readonly linked: boolean;
  /**
   * A platform stop, or a stop on the store's connection, is in effect: no AI work runs
   * although the installation may be active. Only those stops' own paths lift them.
   */
  readonly blocked: boolean;
  readonly installation: {
    readonly installationId: Id;
    readonly status: string;
    readonly revision: number;
    /** A person's "Stop AI work" is in effect. */
    readonly stopped: boolean;
    readonly updatedAt: string;
  } | null;
  /** What this person may do now (the server's kernel decided). */
  readonly actions: { readonly enable: boolean; readonly resume: boolean; readonly stop: boolean };
}
/** The server-built installation document the owner confirms (five minutes, single use). */
export interface ListingsDocumentView {
  readonly documentDigest: string;
  readonly nonce: string;
  readonly purpose: "enable" | "resume";
  readonly installationId: Id;
  readonly expiresAt: string;
  readonly releaseRevision: number;
  /** The exact grant set: capability and verbs (scope: this store and the listing fields). */
  readonly grants: readonly { readonly capabilityId: string; readonly verbs: readonly string[] }[];
  readonly fields: readonly string[];
}
export interface ListingsChangeView {
  readonly installationId: Id;
  readonly status: string;
  readonly revision: number;
}
export interface ModelEntryView {
  readonly model: string;
  readonly effort: string;
  readonly creditsPerProduct: number;
  readonly runProductLimit: number;
  readonly allowedForMember: boolean;
}
export interface ModelCatalogueView {
  readonly catalogueVersion: number;
  readonly entries: readonly ModelEntryView[];
  readonly workspaceDefault: { readonly model: string; readonly effort: string };
  /** The member ceiling in credits per product. */
  readonly ceiling: number;
  /** null until the default is first changed. */
  readonly revision: number | null;
  readonly canRevise: boolean;
  /** Run admission is open in this deployment (M3 PR-2); while false, Ask writes nothing. */
  readonly draftingAvailable: boolean;
}
// M3 PR-2: Listings runs (GET /work/tasks/:taskId/runs, GET /work/runs/:runId). Ids,
// statuses, counts and credits only: never a draft's text, a product as read, a provider
// id or a cost per call.
export interface RunView {
  readonly runId: Id;
  readonly taskId: Id;
  readonly storeId: Id;
  /** queued | running | succeeded | failed | cancelled; an unknown value renders as text. */
  readonly status: string;
  readonly endedReason: string | null;
  readonly selection: { readonly model: string; readonly effort: string };
  readonly creditsPerProduct: number;
  readonly productCount: number;
  readonly fields: readonly string[];
  readonly productsDrafted: number;
  readonly productsFailed: number;
  readonly createdAt: string;
  readonly endedAt: string | null;
}
export interface RunProductView {
  readonly index: number;
  readonly productId: string;
  /** pending | in_progress | drafted | failed | skipped. */
  readonly status: string;
  readonly attempts: number;
  readonly failureCode: string | null;
  /** The pending proposal this product's draft is in, once proposed. */
  readonly proposalId: Id | null;
  /** Reviewer flags as counts (links, emails, phones, tags added and removed). */
  readonly flags: {
    readonly newUrls: number;
    readonly newEmails: number;
    readonly newPhones: number;
    readonly tagsAdded: number;
    readonly tagsRemoved: number;
  } | null;
}
export interface RunDetailView {
  readonly run: RunView;
  readonly credits: {
    readonly reserved: number | null;
    readonly settled: number | null;
    readonly status: string | null;
  };
  readonly usage: {
    readonly attempts: number | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  };
  readonly products: readonly RunProductView[];
  /** Still open while its lease was revoked or ended: the stale close returns its credits. */
  readonly interrupted: boolean;
}
export interface RunAdmittedView {
  readonly runId: Id;
  readonly childTaskId: Id;
  readonly productCount: number;
  readonly creditsReserved: number;
  /** The selection the run uses (the workspace default when the request named none). */
  readonly selection: { readonly model: string; readonly effort: string };
}
// v1 PR 3: review, approve and apply (GET /work/proposals/:id/review, the decision, the apply
// and the apply history). Product values are text the screen shows as text (a description's
// HTML included, never rendered); the refs are passed back to the server exactly as read.
export type ListingFieldName =
  | "title"
  | "descriptionHtml"
  | "seo.title"
  | "seo.description"
  | "tags";
export interface RecordRefView {
  readonly organizationId: Id;
  readonly workspaceId: Id;
  readonly storeId: Id | null;
  readonly kind: "proposal" | "approval";
  readonly id: Id;
  readonly revision: number;
  readonly digest: string;
}
export interface FieldChangeView {
  readonly field: ListingFieldName;
  /** As the draft read it; null when Shopify had none or the snapshot is gone. */
  readonly before: string | readonly string[] | null;
  readonly after: string | readonly string[];
}
export interface ProductReviewView {
  /** The product's index in the root proposal. */
  readonly targetIndex: number;
  readonly productId: string;
  /** available, expired (the 90-day snapshot is gone) or redacted (shop/redact). */
  readonly source: "available" | "expired" | "redacted";
  readonly changes: readonly FieldChangeView[];
  readonly tags: { readonly added: readonly string[]; readonly removed: readonly string[] } | null;
  readonly flags: RunProductView["flags"];
}
export interface OperationView {
  readonly operationId: Id;
  readonly taskId: Id;
  readonly proposalId: Id;
  readonly productId: string;
  readonly targetIndex: number;
  /**
   * authorized, dispatching, submitted, verifying, verified, conflict, failed, uncertain, or
   * cancel_requested (the person who applied it set it aside after checking it in Shopify).
   */
  readonly status: string;
  readonly reason: string | null;
  readonly uncertaintyReason: string | null;
  readonly verdict: string | null;
  readonly updatedAt: string;
}
export interface ReviewView {
  readonly proposal: {
    readonly id: Id;
    readonly digest: string;
    readonly storeId: Id;
    readonly taskId: Id | null;
    readonly targetCount: number;
    readonly expiresAt: string;
    readonly partialApproval: boolean;
    /** Drafted from untrusted content (product text): its sources are named (ADR-0027 item 5). */
    readonly untrustedSource: boolean;
    readonly derivedFromId: Id | null;
    readonly selectedTargetIndexes: readonly number[] | null;
  };
  readonly proposalRef: RecordRefView;
  readonly approval: {
    readonly id: Id;
    readonly revision: number;
    readonly status: string;
    readonly effectiveAt: string | null;
    readonly expiresAt: string;
  } | null;
  readonly approvalRef: RecordRefView | null;
  /** reviewer, proposer or viewer. */
  readonly viewerRole: string;
  readonly actionable: boolean;
  /** redacted, link_changed or not_reviewer when the person cannot act here. */
  readonly blocked: string | null;
  readonly confirmation: { readonly required: boolean; readonly phrase: string };
  readonly products: readonly ProductReviewView[];
  readonly claim: { readonly mine: boolean; readonly operations: readonly OperationView[] } | null;
  /** v1 PR 4: set when this proposal undoes an applied change. */
  readonly undoOf: UndoOfView | null;
}
export interface ReviewDecisionBody {
  readonly decision: "approve" | "reject";
  readonly selectedTargetIndexes: readonly number[] | null;
  readonly expectedDecisionDigest: string;
  readonly soloOwnerConfirmation: string | null;
  readonly expectedRevision: number;
}
export interface ReviewDecidedView {
  readonly proposalRef: RecordRefView;
  readonly approvalRef: RecordRefView;
  readonly status: string;
  readonly expiresAt: string;
}
export interface ApplyResultView {
  /** Products still waiting their turn; the same request again continues them. */
  readonly pending: number;
  readonly operations: readonly OperationView[];
}
export interface PendingApprovalView {
  readonly proposalId: Id;
  readonly storeId: Id | null;
  readonly capabilityId: string;
  readonly targetCount: number;
  readonly expiresAt: string;
  readonly viewerRole: string;
}
// v1 PR 4: Undo, the history's undo state and "Approve several at once". The server decides
// every one of them; the screens only show what it says.
/**
 * none (not confirmed in Shopify: an unknown outcome is never undone), available (until
 * `availableUntil`), requested (an undo is waiting or running: `undoProposalId`), undone,
 * changed (Morrow changed the product again since) or unavailable (90 days passed, or the
 * shop's data was deleted).
 */
export type UndoStateName =
  | "none"
  | "available"
  | "requested"
  | "undone"
  | "changed"
  | "unavailable";
export interface UndoStateView {
  readonly state: UndoStateName;
  readonly availableUntil: string | null;
  readonly undoProposalId: Id | null;
  /** This change is itself an undo of that change. */
  readonly undoOfOperationId: Id | null;
}
/** One change in the task's history, with its undo state. */
export interface HistoryOperationView extends OperationView {
  readonly undo: UndoStateView;
}
/** POST /work/operations/:id/undo: the new change Morrow built, waiting for approval. */
export interface UndoRequestedView {
  readonly proposalId: Id;
  readonly approvalId: Id;
  readonly status: string;
  readonly expiresAt: string;
  readonly operationId: Id;
}
/** On the review screen: this proposal undoes that applied change. */
export interface UndoOfView {
  readonly operationId: Id;
  readonly proposalId: Id;
  readonly productId: string;
  readonly appliedAt: string | null;
}
export interface BatchItemView {
  readonly proposalId: Id;
  readonly digest: string;
  readonly approvalId: Id;
  readonly revision: number;
  readonly targetCount: number;
  readonly expiresAt: string;
}
/** The server-built document of the changes waiting on one task (5 minutes, this session). */
export interface BatchDocumentView {
  readonly proposalId: Id;
  readonly taskId: Id;
  readonly items: readonly BatchItemView[];
  /** too_few, cost_confirmation or mixed_confirmation when no batch is offered. */
  readonly unavailable: string | null;
  /** The solo owner's one phrase for the whole batch (ADR-0024 item 9), when required. */
  readonly confirmation: { readonly required: boolean; readonly phrase: string | null };
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly documentDigest: string;
}
export interface BatchDecisionBody {
  readonly documentDigest: string;
  readonly issuedAt: string;
  /** The typed phrase, exactly as the document gave it, or null when none is needed. */
  readonly soloOwnerConfirmation: string | null;
  readonly items: readonly {
    readonly proposalId: Id;
    readonly digest: string;
    readonly approvalId: Id;
    readonly revision: number;
  }[];
}
export interface BatchDecidedView {
  readonly decided: readonly ReviewDecidedView[];
}
// v1 PR 4: the product picker on Ask (the catalogue routes of M2 PR-3): ids and titles only.
export interface CatalogProductView {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}
export interface CatalogPageView<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export interface CatalogCollectionView {
  readonly id: string;
  readonly title: string;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

// ADR-0032 Home: the board's sections that have no backend yet. Only the fixture adapter
// answers `samples.home`, and only where its scenario composes it; the HTTP build keeps
// it uncomposed (not_in_build, nothing sent). These are presentational strings for a
// preview, never contract data: the contracts and backend of ADR-0033 and ADR-0034
// (projects with goals, Morrow drafting plans; accepted 2026-10-24) land in their own PRs.
export type AgentKind =
  | "morrow"
  | "listings"
  | "analyst"
  | "inventory"
  | "support"
  | "marketing"
  | "specialist";
/** An agent a workspace installs (Morrow, the Coordinator, and one-time specialists aren't). */
export type InstalledAgentKind = Exclude<AgentKind, "morrow" | "specialist">;
export type SampleHealth = "on_track" | "behind" | "working" | "needs_you";
export interface HomeSamplesView {
  readonly viewerName: string;
  readonly waiting: {
    readonly review: number;
    readonly tasks: number;
    readonly alerts: number;
  };
  readonly creditsLeft: string;
  readonly projects: readonly {
    readonly id: Id;
    readonly name: string;
    readonly ends: string;
    readonly summary: string;
    readonly health: SampleHealth;
  }[];
  readonly everyday: readonly {
    readonly name: string;
    readonly summary: string;
    readonly health: SampleHealth | null;
  }[];
  readonly team: {
    /** Installed agents, each on the route contract's `agent` route; Morrow is implicit. */
    readonly agents: readonly {
      readonly agent: InstalledAgentKind;
      readonly installationId: Id;
    }[];
    readonly people: readonly { readonly name: string; readonly presence: "online" | "away" }[];
  };
  readonly today: readonly {
    readonly when: string;
    readonly title: string;
    readonly who: string;
    readonly agent: AgentKind | null;
    readonly where: string;
    readonly status: "done" | "working" | "to_do";
  }[];
  readonly glance: {
    readonly source: string;
    readonly metrics: readonly {
      readonly label: string;
      readonly value: string;
      readonly note: string | null;
    }[];
    readonly take: string;
  };
  readonly ideas: readonly {
    readonly id: Id;
    readonly agent: AgentKind;
    readonly text: string;
    readonly helps: string;
  }[];
  readonly recentAsks: readonly {
    readonly asked: string;
    readonly when: string;
    readonly outcome: string;
  }[];
}

const kindLabel = { human: "Member", agent: "Agent", service: "Service" } as const;
/** Opaque label (§4.10): "Member ·" plus the last four characters of the principal id. */
export function personLabel(person: PersonRef): string {
  return `${kindLabel[person.kind]} · ${person.principalId.slice(-4)}`;
}
