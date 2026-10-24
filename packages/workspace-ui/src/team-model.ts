// T7 PR 16 (v1 build order): Team, agent pages, Add agents, Settings, Shop knowledge and
// Files. UI-internal view models, as model.ts's are: not contracts. In this build only the
// fixture adapter serves them; the HTTP build leaves the whole group uncomposed (it sends
// nothing and the screens show "not built yet"). T2, T4, T11 and T13 decode their routes
// into these shapes when the routes exist. ADR-0033 and ADR-0034 (projects, goals; accepted
// 2026-10-24) have no routes yet, and this PR builds no contract or backend for them: "Works
// toward" and "Works in" are display text here, never records, until their routes exist.
import type { SpecialistProp } from "./components/avatars";
import type { Command, Outcome } from "./port";
import type { Id, ListingsAgentView, ModelCatalogueView, StoreConnectionView } from "./model";

/** The drawn characters (ADR-0032 item 3). A face confers nothing. */
export type AgentCharacter =
  | "morrow"
  | "listings"
  | "business_analyst"
  | "inventory"
  | "support"
  | "marketing"
  | "specialist";
/** A specialist's prop for its skill (Sunrise brief §2.4): PR 14's characters' own type. */
export type { SpecialistProp };
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
  /** For `own`: credits per job by model and effort. */
  readonly estimates: readonly ThinkingEstimate[];
  /**
   * For `own`: the credits this agent may use a day (its daily spending limit), or null
   * where it has none. A setting fits when one job's most fits within it.
   */
  readonly dailyLimit: number | null;
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
  /**
   * The limit that applies: credits per product (the member ceiling), or for a job the
   * agent's credits a day (one job's most must fit within it).
   */
  readonly limit: number | null;
  /** Within that limit; a choice that doesn't fit can't be saved. */
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
    limit: view.ceiling,
    // checkWorkspaceDefault: the ceiling must admit the default.
    fits: e.creditsPerProduct <= view.ceiling,
  }));
}
/** Every other helper: each estimate's most for one job against its credits a day. */
export function optionsFromEstimates(view: ThinkingView): readonly ThinkingOption[] {
  return view.estimates.map((e) => ({
    model: e.model,
    effort: e.effort,
    typical: e.typical,
    most: e.most,
    unit: "job" as const,
    limit: view.dailyLimit,
    fits: view.dailyLimit === null || e.most <= view.dailyLimit,
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
/** Whose thinking a Team dialog changes. */
export type ThinkingTargetRef =
  | { readonly kind: "agent"; readonly id: Id }
  | { readonly kind: "morrow" }
  | { readonly kind: "specialists" };
/**
 * The target's setting in the latest Team read, so a dialog always shows (and sends the
 * revision of) what the server last said, also after a conflict's reread. Null when the
 * agent is no longer on the team.
 */
export function thinkingFor(view: TeamView, target: ThinkingTargetRef): ThinkingView | null {
  if (target.kind === "morrow") return view.morrow.thinking;
  if (target.kind === "specialists") return view.specialistDefault;
  return view.agents.find((a) => a.agentId === target.id)?.thinking ?? null;
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
  readonly ownerName: string;
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
  /** When these numbers were measured (a display string from the server). */
  readonly asOf: string;
  /** The first day of this credit period, and the day the projection is for (display). */
  readonly periodStart: string;
  readonly projectedOn: string;
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
/**
 * Notifications (the SettingsNotifications board): the viewer's own choices; everyone
 * chooses their own. Emails hold counts and links only. The shop's time zone is the
 * workspace's, and only the Owner changes it.
 */
export const emailTopics = ["soon", "summary", "monday", "mentions"] as const;
export type EmailTopic = (typeof emailTopics)[number];
/** The closed choices the board offers (hours, 24-hour clock, in the shop's time zone). */
export const summaryHours = [7, 8, 9] as const;
export const quietFromHours = [20, 21, 22] as const;
export const quietUntilHours = [6, 7, 8] as const;
export const shopTimeZones = ["toronto", "winnipeg", "edmonton", "vancouver"] as const;
export type ShopTimeZone = (typeof shopTimeZones)[number];
export interface NotificationChoices {
  readonly email: Readonly<Record<EmailTopic, boolean>>;
  readonly summaryHour: number;
  readonly quiet: { readonly on: boolean; readonly from: number; readonly until: number };
  readonly timeZone: ShopTimeZone;
}
export interface NotificationsView extends NotificationChoices {
  readonly viewerName: string;
  /** The email the viewer signs in with: where Morrow's emails go. */
  readonly signInEmail: string;
  readonly ownerName: string;
  readonly canChangeTimeZone: boolean;
  readonly revision: number;
  /** What the next morning email would count (the preview). */
  readonly morning: {
    readonly toReview: number;
    readonly questions: number;
    readonly tasks: number;
    readonly alerts: number;
  };
}
/** Whether two sets of choices are the same (the save bar shows while they differ). */
export function sameNotificationChoices(a: NotificationChoices, b: NotificationChoices): boolean {
  return (
    emailTopics.every((topic) => a.email[topic] === b.email[topic]) &&
    a.summaryHour === b.summaryHour &&
    a.quiet.on === b.quiet.on &&
    a.quiet.from === b.quiet.from &&
    a.quiet.until === b.quiet.until &&
    a.timeZone === b.timeZone
  );
}

/**
 * Activity (the SettingsActivity board): what people, agents and Morrow did, newest
 * first. Nobody can change or delete it. Conversations with Morrow are private and not
 * listed. Fixture data only in this build (PR 15 brings the activity log).
 */
export const activityFilters = ["all", "store", "approvals", "access"] as const;
export type ActivityFilter = (typeof activityFilters)[number];
export type ActivityBadge =
  | "stopped"
  | "working"
  | "suggested"
  | "updated_in_shopify"
  | "done"
  | "needs_you"
  | "sent";
export interface ActivityEntryView {
  readonly id: Id;
  /** The day heading it sits under ("Today, Friday, October 23"). */
  readonly day: string;
  readonly time: string;
  readonly actor:
    | { readonly kind: "person"; readonly name: string; readonly initials: string }
    | {
        readonly kind: "helper";
        readonly name: string;
        readonly character: AgentCharacter;
        readonly prop: SpecialistProp | null;
      };
  readonly what: string;
  readonly detail: string;
  readonly category: Exclude<ActivityFilter, "all"> | "work";
  readonly badge: ActivityBadge | null;
}
export interface ActivityView {
  readonly shopName: string;
  readonly entries: readonly ActivityEntryView[];
}

/**
 * "Stop all AI work" (ADR-0005: human_only, no second approver). It is wired to the stop
 * that exists: each store's Listings "Stop AI work" (`agents.listingsStop`), one command
 * per store. A store is a target only when the server says this person may stop it and it
 * isn't stopped already. A store held by a platform or connection stop (`blocked`) runs no
 * AI work, so it is never called "on"; where this person may stop it, it stays a target, so
 * Listings stays off once that hold lifts. Turning AI work back on stays on each store's own
 * page, where Resume asks for the server's document as Enable does.
 */
export interface StopTarget {
  readonly storeId: Id;
  readonly shopDomain: string;
  readonly installationId: Id;
  /** Held by a platform or connection stop: no AI work runs there now. */
  readonly held: boolean;
}
export interface StopAllState {
  readonly targets: readonly StopTarget[];
  /** Stores whose Listings agent a person stopped. */
  readonly stopped: number;
  /** Stores held by a platform or connection stop and not stopped by a person. */
  readonly held: number;
  /** Stores with work on that this person may not stop (the server said so). */
  readonly notAllowed: number;
}
export function stopAllState(
  stores: readonly {
    readonly connection: StoreConnectionView;
    readonly listings: ListingsAgentView;
  }[],
): StopAllState {
  const targets: StopTarget[] = [];
  let stopped = 0;
  let held = 0;
  let notAllowed = 0;
  for (const { connection, listings } of stores) {
    const installation = listings.installation;
    if (installation === null || connection.storeId !== listings.storeId) continue;
    if (installation.stopped) {
      stopped += 1;
      continue;
    }
    if (listings.blocked) held += 1;
    if (listings.actions.stop)
      targets.push({
        storeId: listings.storeId,
        shopDomain: connection.shopDomain,
        installationId: installation.installationId,
        held: listings.blocked,
      });
    // Held work isn't on, so it isn't work this person can't stop.
    else if (!listings.blocked) notAllowed += 1;
  }
  return { targets, stopped, held, notAllowed };
}
/** The typed confirmation: the word "stop", in any case, with spaces around it ignored. */
export const stopWord = "stop";
export function isStopConfirmation(typed: string): boolean {
  return typed.trim().toLowerCase() === stopWord;
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
  notifications(ws: Id): Promise<Outcome<NotificationsView>>;
  /** Saves the viewer's own choices (and the shop's time zone, the Owner only). */
  reviseNotifications(
    ws: Id,
    c: Command<NotificationChoices & { expectedRevision: number }>,
  ): Promise<Outcome<{ readonly revision: number }>>;
  activity(ws: Id): Promise<Outcome<ActivityView>>;
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
  "settings.notifications",
  "settings.reviseNotifications",
  "settings.activity",
  "library.knowledge",
  "library.files",
] as const;
