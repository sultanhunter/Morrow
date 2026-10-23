// T7 PR 16 (v1 build order): Team, agent pages, Add agents, Settings, Shop knowledge and
// Files. UI-internal view models, as model.ts's are: not contracts. In this build only the
// fixture adapter serves them; the HTTP build leaves the whole group uncomposed (it sends
// nothing and the screens show "not built yet"). T2, T4, T11 and T13 decode their routes
// into these shapes when the routes exist. ADR-0033 and ADR-0034 (projects, goals) are not
// approved: "Works toward" and "Works in" are display text here, never records.
import type { Command, Outcome } from "./port";
import type { Id, ModelCatalogueView } from "./model";

/** The drawn characters (ADR-0032 item 3). A face confers nothing. */
export type AgentCharacter =
  | "morrow"
  | "listings"
  | "business_analyst"
  | "inventory"
  | "support"
  | "marketing"
  | "specialist";
/** A specialist's prop for its skill (Sunrise brief §2.4). */
export type SpecialistProp = "calendar" | "envelope" | "magnifier" | "pencil" | "chart";
/** Status words from the closed badge list (ADR-0032 item 2). */
export type AgentStatus = "active" | "working" | "needs_you" | "paused" | "done";
export type PersonRole = "owner" | "admin" | "member";

/** The catalogue's model and effort keys, in the order the picker shows them. */
export const thinkingModels = ["claude_haiku_5_5", "claude_sonnet_5_5", "claude_opus_5_5"] as const;
export const thinkingEfforts = ["low", "medium", "high"] as const;
export interface ThinkingChoice {
  readonly model: string;
  readonly effort: string;
}
/**
 * How an agent thinks (ADR-0027 item 12). `workspace_default`: the choice is the
 * workspace's model default (governance.model_default.revise; the Listings agent today),
 * read and revised through `models.*`. `own`: the agent's own choice (`team.reviseThinking`).
 */
export interface ThinkingView extends ThinkingChoice {
  readonly source: "workspace_default" | "own";
  /** The usual choice for this kind of helper (the catalogue defaults). */
  readonly usual: ThinkingChoice;
  readonly revision: number | null;
  /** The server decided whether this viewer may change it. */
  readonly canChange: boolean;
  /** For `own`: credits per job by model and effort, and the most one job may use. */
  readonly estimates: readonly ThinkingEstimate[];
  readonly jobLimit: number | null;
}
export interface ThinkingEstimate extends ThinkingChoice {
  readonly typical: number;
  readonly most: number;
}
/** One choice in the picker, as the card shows it. */
export interface ThinkingOption extends ThinkingChoice {
  readonly typical: number;
  /** The most one job can use; null where the catalogue charges per product. */
  readonly most: number | null;
  readonly unit: "job" | "product";
  /** Within the limit that applies; a choice that doesn't fit can't be saved. */
  readonly fits: boolean;
}

/** Listings: the catalogue's entries, each fitting when within the member ceiling. */
export function optionsFromCatalogue(view: ModelCatalogueView): readonly ThinkingOption[] {
  return view.entries.map((e) => ({
    model: e.model,
    effort: e.effort,
    typical: e.creditsPerProduct,
    most: null,
    unit: "product" as const,
    // checkWorkspaceDefault: the ceiling must admit the default.
    fits: e.creditsPerProduct <= view.ceiling,
  }));
}
/** Every other helper: its estimates against the most one job may use. */
export function optionsFromEstimates(view: ThinkingView): readonly ThinkingOption[] {
  return view.estimates.map((e) => ({
    model: e.model,
    effort: e.effort,
    typical: e.typical,
    most: e.most,
    unit: "job" as const,
    fits: view.jobLimit === null || e.most <= view.jobLimit,
  }));
}

export interface ActivityLineView {
  readonly label: "last" | "now" | "next" | "waiting" | "cannot" | "access_ends" | "credits";
  readonly text: string;
}
export interface CreditsUseView {
  readonly used: number;
  /** null: no limit of its own (it counts toward the shop's). */
  readonly limit: number | null;
}
export interface MorrowView {
  readonly status: AgentStatus;
  readonly lines: readonly ActivityLineView[];
  readonly creditsThisMonth: number;
  readonly thinking: ThinkingView;
}
export interface AgentSummaryView {
  /** The installation id: the `agent` route's parameter. */
  readonly agentId: Id;
  readonly character: AgentCharacter;
  readonly name: string;
  readonly summary: string;
  readonly status: AgentStatus;
  readonly worksIn: readonly string[];
  readonly lines: readonly ActivityLineView[];
  readonly credits: CreditsUseView;
  readonly thinking: ThinkingView;
}
export interface SpecialistSummaryView {
  readonly name: string;
  readonly prop: SpecialistProp;
  readonly summary: string;
  readonly status: AgentStatus;
  readonly worksIn: string;
  readonly lines: readonly ActivityLineView[];
  readonly thinking: ThinkingChoice;
}
export interface TeamPersonView {
  readonly name: string;
  readonly initials: string;
  readonly role: PersonRole;
  readonly presence: "online" | "away";
  readonly isViewer: boolean;
  readonly canApprove: string;
  readonly approveGivenBy: string | null;
}
export interface TeamView {
  readonly shopName: string;
  /** The Owner's name, for "Only … can change this." */
  readonly ownerName: string;
  readonly viewerRole: PersonRole;
  readonly morrow: MorrowView;
  readonly agents: readonly AgentSummaryView[];
  readonly specialists: readonly SpecialistSummaryView[];
  /** What new specialists start on (Owner only). */
  readonly specialistDefault: ThinkingView;
  readonly people: readonly TeamPersonView[];
  readonly canAddAgents: boolean;
}

export interface PermissionsView {
  readonly onItsOwn: readonly string[];
  readonly asksFirst: readonly string[];
  readonly never: readonly string[];
}
export interface AgentDetailView {
  readonly agentId: Id;
  readonly character: AgentCharacter;
  readonly name: string;
  readonly status: AgentStatus;
  readonly addedBy: string;
  readonly addedOn: string;
  readonly about: string;
  readonly worksToward: {
    readonly area: string;
    readonly goal: string;
    readonly percent: number;
    readonly target: string;
    readonly health: "on_track" | "behind";
    readonly measuredBy: string;
  } | null;
  readonly worksIn: readonly {
    readonly name: string;
    readonly detail: string;
    readonly status: "active" | "needs_review" | "done";
  }[];
  readonly thinking: ThinkingView;
  readonly permissions: PermissionsView;
  readonly recentWork: readonly {
    readonly what: string;
    readonly where: string;
    readonly when: string;
    readonly result: string;
    readonly credits: number;
  }[];
  readonly now: string;
  readonly lastJob: string | null;
  readonly next: string | null;
  readonly creditsMonth: CreditsUseView;
  readonly creditsToday: CreditsUseView;
  readonly creditsResetOn: string;
  readonly permission: {
    readonly grantedBy: string;
    readonly grantedOn: string;
    readonly nextRenewal: string;
    readonly daysLeft: number;
  };
  readonly shopifyAccess: readonly { readonly text: string; readonly has: boolean }[];
  readonly schedule: readonly {
    readonly icon: "calendar" | "repeat" | "store" | "task" | "mention" | "idea";
    readonly title: string;
    readonly detail: string | null;
  }[];
  readonly notes: readonly string[];
  readonly ownerName: string;
}

export type AgentCategory = "product_pages" | "sales" | "stock" | "customer_emails" | "promotions";
export interface CatalogueEntryView {
  /** The `agent_listing` route's parameter. */
  readonly releaseId: Id;
  readonly character: AgentCharacter;
  readonly name: string;
  readonly summary: string;
  readonly category: AgentCategory;
  /** Set once added: the `agent` route's parameter. */
  readonly addedAs: Id | null;
  /** Waiting for a teammate to review its permission. */
  readonly waitingReview: boolean;
  readonly worksIn: string;
  readonly does: readonly string[];
  readonly schedule: readonly string[];
  readonly permissions: PermissionsView;
  /** Shopify access it needs that the shop hasn't given yet: asked for, never assumed. */
  readonly shopifyAccess: readonly string[];
  readonly accessNote: string | null;
  readonly startsOn: ThinkingChoice;
  readonly usualCredits: string;
  readonly defaultMonthlyLimit: number;
  readonly example: { readonly title: string; readonly points: readonly string[] } | null;
  /** A teammate who also reviews this agent's permission before it starts. */
  readonly reviewer: string | null;
}
export interface CatalogueView {
  readonly shopName: string;
  readonly entries: readonly CatalogueEntryView[];
  readonly canAdd: boolean;
  readonly creditsLeft: number;
  readonly creditsRenewOn: string;
}
/** The add document the server built; the dialog shows exactly this. */
export interface AddDocumentView {
  readonly documentDigest: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly releaseId: Id;
  readonly character: AgentCharacter;
  readonly name: string;
  readonly summary: string;
  readonly willBeAbleTo: readonly string[];
  readonly willNotBeAbleTo: readonly string[];
  readonly worksIn: string;
  readonly thinking: ThinkingChoice;
  readonly monthlyCreditLimit: number;
  readonly shopifyAccess: readonly string[];
  readonly reviewer: string | null;
}
export interface AddResultView {
  readonly status: "added" | "waiting_review";
  readonly agentId: Id | null;
}
/** The monthly credit limit a person may set when adding an agent. */
export const monthlyLimitRange = { min: 10, max: 4000 } as const;

export interface PlanView {
  readonly asOf: string;
  readonly creditsLeft: number;
  readonly used: number;
  readonly monthly: number;
  readonly renewsOn: string;
  readonly dailyAverage: string;
  readonly projectedLeft: string;
  readonly planName: string;
  readonly paidThrough: "shopify" | "morrow";
  readonly carryOver: string;
  readonly extraCredits: { readonly enabled: boolean; readonly upTo: number | null };
  readonly byProject: readonly {
    readonly group: "dated" | "everyday" | "none";
    readonly name: string;
    readonly detail: string;
    readonly who: string;
    readonly credits: number;
    readonly planned: string | null;
  }[];
  readonly byHelper: readonly {
    readonly group: "agents" | "specialists";
    readonly character: AgentCharacter;
    readonly prop: SpecialistProp | null;
    readonly name: string;
    readonly where: string;
    readonly thinking: ThinkingChoice;
    readonly used: number;
    readonly limit: number | null;
    readonly note: string | null;
  }[];
  readonly ownerName: string;
  readonly viewerIsOwner: boolean;
}
export type LinkableMailbox = "google_mailbox" | "microsoft_mailbox" | "merchant_domain";
/** ADR-0030 item 10: the workspace's sending addresses. Only `morrow_managed` at launch. */
export interface EmailAddressesView {
  readonly addresses: readonly {
    readonly id: Id;
    readonly kind: "morrow_managed";
    readonly address: string;
    readonly displayName: string;
    readonly status: "active" | "disabled";
    readonly isDefault: boolean;
  }[];
  /** Where customers' answers go (the verified support address), or null before it's set. */
  readonly supportAddress: string | null;
  /** Reserved kinds, each by its own ADR: shown as "Coming soon". */
  readonly linkable: readonly LinkableMailbox[];
  readonly waiting: readonly {
    readonly title: string;
    readonly agentName: string;
    readonly character: AgentCharacter;
    readonly where: string;
    readonly expires: string;
    readonly sender: string;
  }[];
  readonly ownerName: string;
  readonly viewerIsOwner: boolean;
}
export interface KnowledgeView {
  readonly items: readonly {
    readonly id: Id;
    readonly kind: "fact" | "suggested" | "lesson";
    readonly title: string;
    readonly text: string;
    readonly source: string;
  }[];
}
export interface FilesView {
  readonly files: readonly {
    readonly id: Id;
    readonly name: string;
    readonly type: "pdf" | "csv" | "xlsx" | "image";
    readonly from: string;
    readonly character: AgentCharacter | null;
    readonly where: string;
    readonly date: string;
    readonly size: string;
  }[];
}

export interface TeamPort {
  overview(ws: Id): Promise<Outcome<TeamView>>;
  agent(ws: Id, agentId: Id): Promise<Outcome<AgentDetailView>>;
  /** `target`: an added agent's id, `morrow`, or `specialists` (what new ones start on). */
  reviseThinking(
    ws: Id,
    target: Id,
    c: Command<{ model: string; effort: string; expectedRevision: number | null }>,
  ): Promise<Outcome<{ readonly revision: number }>>;
  catalogue(ws: Id): Promise<Outcome<CatalogueView>>;
  /** Step 1 of adding: the server builds the document the person confirms. */
  addDocument(
    ws: Id,
    releaseId: Id,
    c: Command<{ model: string; effort: string; monthlyCreditLimit: number }>,
  ): Promise<Outcome<AddDocumentView>>;
  /** Step 2: confirms exactly that document, by its fingerprint and single-use value. */
  addConfirm(
    ws: Id,
    releaseId: Id,
    c: Command<{ documentDigest: string; nonce: string }>,
  ): Promise<Outcome<AddResultView>>;
}
export interface SettingsPort {
  plan(ws: Id): Promise<Outcome<PlanView>>;
  emailAddresses(ws: Id): Promise<Outcome<EmailAddressesView>>;
}
export interface LibraryPort {
  knowledge(ws: Id): Promise<Outcome<KnowledgeView>>;
  files(ws: Id): Promise<Outcome<FilesView>>;
}
export const teamPortMethods = [
  "team.overview",
  "team.agent",
  "team.reviseThinking",
  "team.catalogue",
  "team.addDocument",
  "team.addConfirm",
  "settings.plan",
  "settings.emailAddresses",
  "library.knowledge",
  "library.files",
] as const;
