// v1 PR 15: the Inbox, the exception screen and the activity log (the Inbox, EmptyStates,
// MemberHome, Phone and SettingsActivity boards). The views mirror the api's replies
// (GET /work/inbox, GET /work/operations/:id, GET /work/activity): ids, closed codes,
// counts and times, which the screens word. Nothing here decides authority: the server
// filtered every item for this person, and the screens only count and link what it sent.
import type { Id, OperationView } from "./model";

export type InboxSectionState = "ok" | "denied";
export type InboxItemView =
  | {
      readonly kind: "question";
      readonly id: Id;
      readonly taskId: Id;
      /** A person's or an agent's words: always shown as text. */
      readonly prompt: string;
      readonly createdAt: string;
      readonly open: true;
    }
  | {
      readonly kind: "approval";
      readonly id: Id;
      readonly proposalId: Id;
      readonly storeId: Id | null;
      readonly capabilityId: string;
      readonly targetCount: number;
      readonly expiresAt: string;
      /** The store is linked now; a change for a disconnected store can't be applied. */
      readonly storeLinked: boolean;
      readonly open: boolean;
    }
  | {
      readonly kind: "exception";
      readonly reason: "uncertain_operation" | "failed_operation";
      readonly id: Id;
      readonly proposalId: Id;
      readonly taskId: Id;
      readonly storeId: Id;
      readonly status: "uncertain" | "failed" | "conflict";
      readonly reasonCode: string | null;
      readonly updatedAt: string;
      readonly open: boolean;
    }
  | {
      readonly kind: "connection";
      readonly reason: "disconnected" | "uninstalled" | "scopes_changed" | "stopped";
      readonly id: Id;
      readonly storeId: Id;
      readonly setBy: "human" | "system" | "operator";
      readonly since: string;
      readonly open: true;
    };
export interface InboxView {
  readonly sections: {
    readonly questions: InboxSectionState;
    readonly approvals: InboxSectionState;
    readonly changes: InboxSectionState;
    readonly connections: InboxSectionState;
  };
  readonly items: readonly InboxItemView[];
  /** A source had more than the reply carries: the count shows as "N+". */
  readonly more: boolean;
}

/**
 * The Inbox preview (default off): the kinds whose backend isn't built yet, from fixtures
 * only. `run_question` is an agent's question from a run (the agent loop's inbox.ask,
 * PR 11); `reconnect` is ADR-0025 item 10's Reconnect after Shopify permissions changed
 * (PR 5). The HTTP build never composes `samples.inbox`.
 */
export type InboxSampleView =
  | {
      readonly kind: "run_question";
      readonly id: Id;
      readonly agent: "listings" | "inventory" | "analyst";
      readonly prompt: string;
      readonly choices: readonly string[];
      readonly askedAt: string;
    }
  | {
      readonly kind: "reconnect";
      readonly id: Id;
      readonly missingPermissions: readonly string[];
      readonly stoppedAgents: readonly string[];
      readonly since: string;
    };
export interface InboxSamplesView {
  readonly items: readonly InboxSampleView[];
}

/** GET /work/operations/:id: one apply outcome, its history and its read-backs (codes). */
export interface OperationDetailView {
  readonly operation: OperationView;
  readonly storeId: Id;
  readonly transitions: readonly {
    readonly revision: number;
    readonly from: string;
    readonly to: string;
    readonly reason: string | null;
    readonly occurredAt: string;
  }[];
  readonly readbacks: readonly {
    readonly sequence: number;
    readonly observedAt: string;
    readonly outcome: string;
    readonly verdict: string | null;
  }[];
}

export type ActivityActorView =
  | { readonly kind: "person"; readonly principalId: Id }
  | { readonly kind: "morrow" }
  | { readonly kind: "shopify" };
export type ActivityRecordView = {
  readonly id: Id;
  readonly at: string;
  readonly actor: ActivityActorView;
} & (
  | {
      readonly kind: "approval_decided";
      readonly decision: "approve" | "reject";
      readonly proposalId: Id;
      readonly taskId: Id | null;
      readonly storeId: Id | null;
      readonly targetCount: number;
    }
  | {
      readonly kind: "change_outcome";
      readonly outcome: "verified" | "not_applied" | "unknown" | "set_aside";
      readonly reasonCode: string | null;
      readonly operationId: Id;
      readonly proposalId: Id;
      readonly taskId: Id;
      readonly storeId: Id;
    }
  | {
      readonly kind: "ai_work_stopped";
      readonly storeId: Id;
      readonly agent: "listings";
      readonly alreadyStopped: boolean;
    }
  | { readonly kind: "store_disconnected"; readonly storeId: Id; readonly alreadyStopped: boolean }
  | {
      readonly kind: "store_ended";
      readonly storeId: Id;
      readonly reason: "uninstalled" | "scopes_changed" | "other";
    }
  | { readonly kind: "agent_added"; readonly storeId: Id; readonly agent: "listings" | "other" }
  | {
      readonly kind: "drafts_requested";
      readonly taskId: Id;
      readonly storeId: Id;
      readonly productCount: number;
      readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
      readonly drafted: number;
      readonly failed: number;
    }
);
export interface ActivityLogView {
  readonly entries: readonly ActivityRecordView[];
  /** The next page's cursor ("Show earlier"), or null at the start of the log. */
  readonly next: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers the Inbox, Home and the sidebar share, so they count the same read.

const shortDay = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});
/** A server time as the shop's admin shows dates ("Mon, Oct 26"); its text if unparseable. */
export function inboxDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : shortDay.format(date);
}

/** The Inbox tabs (the board's All, To review, Questions; Problems for what went wrong). */
export const inboxTabs = ["all", "review", "questions", "problems"] as const;
export type InboxTab = (typeof inboxTabs)[number];
export function inboxTab(item: InboxItemView): Exclude<InboxTab, "all"> {
  if (item.kind === "approval") return "review";
  if (item.kind === "question") return "questions";
  return "problems";
}
/** The items that wait for a person: the Inbox count (information is listed, not counted). */
export function openItems(view: InboxView): readonly InboxItemView[] {
  return view.items.filter((i) => i.open);
}
/** The count a person sees: the open items, "N+" when the server had more. */
export function inboxCountLabel(view: InboxView): string {
  const n = openItems(view).length;
  return view.more ? `${n}+` : String(n);
}
/** Open items per tab ("all" is every open item). */
export function inboxTabCount(view: InboxView, tab: InboxTab): number {
  const open = openItems(view);
  return tab === "all" ? open.length : open.filter((i) => inboxTab(i) === tab).length;
}
/** Every section answered: only then can the Inbox (or Home) say nothing waits. */
export function inboxComplete(view: InboxView): boolean {
  return Object.values(view.sections).every((s) => s === "ok");
}
/**
 * The most urgent first: store connection problems, changes Morrow can't confirm, changes
 * to review (soonest expiry first), questions (newest first), then information.
 */
export function byInboxUrgency(items: readonly InboxItemView[]): InboxItemView[] {
  const rank = (i: InboxItemView) =>
    !i.open
      ? 5
      : i.kind === "connection"
        ? 0
        : i.kind === "exception"
          ? 1
          : i.kind === "approval"
            ? 2
            : 3;
  const time = (i: InboxItemView) => {
    const value =
      i.kind === "approval"
        ? -Date.parse(i.expiresAt)
        : i.kind === "question"
          ? Date.parse(i.createdAt)
          : i.kind === "exception"
            ? Date.parse(i.updatedAt)
            : Date.parse(i.since);
    return Number.isNaN(value) ? 0 : value;
  };
  return [...items].sort((a, b) => rank(a) - rank(b) || time(b) - time(a));
}

/** The Activity filters (the board's Everything, Store changes, Approvals, Access and stops). */
export const activityFilters = ["all", "store", "approvals", "access"] as const;
export type ActivityFilter = (typeof activityFilters)[number];
/** Which filter shows a record ("work" shows under Everything only). */
export function activityCategory(r: ActivityRecordView): Exclude<ActivityFilter, "all"> | "work" {
  switch (r.kind) {
    case "change_outcome":
      return "store";
    case "approval_decided":
      return "approvals";
    case "ai_work_stopped":
    case "store_disconnected":
    case "store_ended":
    case "agent_added":
      return "access";
    case "drafts_requested":
      return "work";
  }
}
