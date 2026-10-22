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
export interface Page<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

const kindLabel = { human: "Member", agent: "Agent", service: "Service" } as const;
/** Opaque label (§4.10): "Member ·" plus the last four characters of the principal id. */
export function personLabel(person: PersonRef): string {
  return `${kindLabel[person.kind]} · ${person.principalId.slice(-4)}`;
}
