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
export interface Page<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

const kindLabel = { human: "Member", agent: "Agent", service: "Service" } as const;
/** Opaque label (§4.10): "Member ·" plus the last four characters of the principal id. */
export function personLabel(person: PersonRef): string {
  return `${kindLabel[person.kind]} · ${person.principalId.slice(-4)}`;
}
