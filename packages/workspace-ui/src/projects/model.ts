// UI-internal view models of the project screens (T7 PR 19; ADR-0033, ADR-0034). They are
// not contracts: T2's decoders build them from GoalProgress@1, PlanDraft@1,
// PlanStartDocument@1 and the collaboration parts, and screens render them. Words and
// statuses stay strings, so an unknown value renders as its text instead of failing.
// Every sentence here is written by code on the server, per viewer, from fixed templates
// and the values that viewer may see; a screen never computes a value, word or estimate.
import type { Id } from "../model";

/** The health words code computes (ADR-0033 item 4; the flow-contracts brief). */
export const healthWords = [
  "on_track",
  "behind",
  "done",
  "needs_you",
  "not_measured",
  "not_checked_yet",
  "starting_point",
  "not_started",
] as const;
export type HealthWord = (typeof healthWords)[number];
export interface HealthView {
  /** One of `healthWords`; any other value renders as its own text. */
  readonly word: string;
  /** The reason sentence code wrote from a fixed template, or null. */
  readonly reason: string | null;
}

/** Who appears on a row, card or message. A name, face or title confers nothing. */
export interface MemberView {
  readonly kind: "morrow" | "person" | "agent" | "specialist";
  readonly name: string;
  /** The server's label: "Owner", "Member", "You own this project"; null when none. */
  readonly role: string | null;
}

// ---- The Projects page (route `work`)
export interface CreditsMonthView {
  readonly used: number;
  readonly allowance: number;
  readonly left: number;
  /** The day the allowance renews, `YYYY-MM-DD`. */
  readonly renewsOn: string;
  /** Spent in Asks outside any project. */
  readonly askUsed: number;
}
export interface GoalLineView {
  readonly title: string;
  /** Today's value as code wrote it ("11 of 12 facts · goal 12 of 12 by Fri, Nov 13"). */
  readonly value: string | null;
}
export interface ProjectRowView {
  readonly projectId: Id;
  /** Its goal record: New task files a task there through the work API. */
  readonly goalId: Id;
  readonly title: string;
  /** The end date, `YYYY-MM-DD` ("Ends Fri, Dec 4"). */
  readonly endsOn: string;
  /** "2 changes need you", "Started today". */
  readonly note: string | null;
  readonly mainGoal: GoalLineView | null;
  /** The other goals' one-line summaries. */
  readonly moreGoals: readonly string[];
  readonly health: HealthView;
  readonly members: readonly MemberView[];
  readonly credits: { readonly used: number; readonly planned: string | null };
}
export interface AreaRowView {
  readonly projectId: Id;
  readonly goalId: Id;
  /** The template's label: Product pages, Stock, Customer emails, Sales and numbers, Promotions. */
  readonly label: string;
  readonly agent: MemberView;
  readonly note: string | null;
  readonly goal: GoalLineView | null;
  readonly health: HealthView;
  readonly repeating: number;
  readonly alerts: number;
  readonly creditsThisMonth: number;
}
export interface QuickTasksRowView {
  readonly projectId: Id;
  readonly goalId: Id;
  readonly open: number;
  readonly creditsThisMonth: number;
}
export interface FinishedRowView {
  readonly projectId: Id;
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly finishedOn: string;
  readonly goalsMet: number;
  readonly goalsTotal: number;
  readonly health: HealthView;
}
export interface ProjectsOverviewView {
  /** Null when this person may not see the workspace's credits. */
  readonly credits: CreditsMonthView | null;
  readonly dated: readonly ProjectRowView[];
  readonly areas: readonly AreaRowView[];
  readonly quickTasks: QuickTasksRowView | null;
  readonly finished: readonly FinishedRowView[];
  readonly counts: { readonly openTasks: number; readonly repeating: number };
  /** Starters code picked from the shop and the season, for "Tell Morrow…". */
  readonly starters: readonly string[];
  /** What this person may do now (the server's kernel decided; it checks again). */
  readonly actions: {
    readonly ask: boolean;
    readonly create: boolean;
    readonly createTask: boolean;
  };
}

export const taskBuckets = ["needs_you", "to_do", "working", "done_today"] as const;
export type TaskBucket = (typeof taskBuckets)[number];
export interface ProjectTaskRowView {
  readonly taskId: Id;
  readonly title: string;
  readonly owner: MemberView;
  readonly projectId: Id;
  readonly projectTitle: string;
  /** One of `taskBuckets`. */
  readonly bucket: string;
  /** "Due Fri, Oct 30", "Finishes by 3:00 pm". */
  readonly when: string | null;
  /** "1 question needs you". */
  readonly note: string | null;
  /** The person owns it or it waits for them. */
  readonly mine: boolean;
}
export interface ProjectTasksView {
  readonly rows: readonly ProjectTaskRowView[];
}

export interface RepeatingRowView {
  readonly id: Id;
  readonly title: string;
  readonly owner: MemberView;
  readonly projectId: Id;
  readonly projectTitle: string;
  /** "Every Monday at 9:00 am". */
  readonly schedule: string;
  readonly next: string | null;
  /** "About 12", "None: you do it". */
  readonly credits: string | null;
  /** active | off | working; any other value renders as text. */
  readonly status: string;
  readonly note: string | null;
}
export interface AlertRowView {
  readonly id: Id;
  readonly title: string;
  readonly owner: MemberView;
  readonly projectId: Id;
  readonly projectTitle: string;
  /** The goal it watches. */
  readonly watches: string;
  readonly lastTold: string | null;
  readonly status: string;
  readonly note: string | null;
}
/** A repeating task Morrow drafted that nothing runs until a person turns it on. */
export interface RepeatingDraftView {
  readonly messageId: Id;
  readonly title: string;
  readonly owner: MemberView;
  readonly projectTitle: string;
  readonly when: string;
  readonly youGet: string;
  readonly credits: string | null;
  readonly drafted: string;
}
export interface RepeatingView {
  readonly waiting: readonly RepeatingDraftView[];
  readonly repeating: readonly RepeatingRowView[];
  readonly alerts: readonly AlertRowView[];
}

// ---- One project or Everyday work area (route `project`)
export interface GoalCheckView {
  readonly label: string;
  readonly done: boolean;
  readonly note: string | null;
}
export interface GoalRowView {
  readonly label: string;
  readonly value: string;
  readonly note: string | null;
  readonly health: HealthView | null;
}
export interface GoalStepLinkView {
  readonly label: string;
  readonly owner: MemberView;
  readonly status: string;
}
export interface GoalDetailView {
  /** The criterion's key in its goal record. */
  readonly key: string;
  readonly title: string;
  /** metric | checklist | manual | none (a v1 criterion without a measure). */
  readonly measure: string;
  readonly value: string | null;
  readonly target: string | null;
  readonly start: string | null;
  /** "Checklist · counted from your Shopify product · updated 11:52 am". */
  readonly source: string | null;
  readonly health: HealthView;
  /** The drawer's "How it's measured". */
  readonly how: string | null;
  readonly checks: readonly GoalCheckView[];
  /** A hand check's questions, which Morrow wrote and a person may edit. */
  readonly questions: readonly string[];
  /** Per-product rows ("Utility Overshirt · About 11 days left"). */
  readonly rows: readonly GoalRowView[];
  readonly steps: readonly GoalStepLinkView[];
}
export interface PlanStepView {
  readonly index: number;
  readonly title: string;
  readonly owner: MemberView;
  /** done | to_do | working | needs_you | not_started | cancelled | paused. */
  readonly status: string;
  readonly detail: string | null;
  readonly repeats: boolean;
  readonly taskId: Id | null;
}
export interface UpdateRowView {
  readonly label: string;
  readonly value: string;
  readonly health: HealthView | null;
  readonly note: string | null;
}
/** The Monday update: code writes it from a fixed template, with no agent face. */
export interface ProjectUpdateView {
  /** "Week 3 · On track". */
  readonly title: string;
  /** "Mon, Nov 9, 8:00 am". */
  readonly at: string;
  readonly health: HealthView;
  readonly summary: string;
  readonly rows: readonly UpdateRowView[];
  readonly doneSince: string | null;
  readonly needsYou: string | null;
  readonly credits: string | null;
}
export interface SinceItemView {
  readonly title: string;
  readonly detail: string | null;
  readonly at: string | null;
  readonly health: HealthView | null;
}
export interface BriefView {
  /** "Written by Morrow from Maya Chen's request · started by Maya Chen · Oct 23, 2026". */
  readonly byline: string;
  readonly why: string | null;
  readonly doneWhen: string | null;
  readonly honesty: string | null;
  readonly questions: readonly string[];
  readonly cannotDo: readonly string[];
  readonly whoSees: string | null;
}
export interface FileRowView {
  readonly id: Id;
  readonly title: string;
  readonly from: string;
  readonly note: string | null;
}
export interface ActivityRowView {
  readonly at: string;
  readonly text: string;
}
export interface ProjectCreditsView {
  readonly used: number;
  readonly planned: string | null;
  readonly byHelper: readonly { readonly name: string; readonly line: string }[];
  readonly balance: string | null;
  readonly note: string | null;
}
export interface ResultRowView {
  readonly goal: string;
  readonly measure: string;
  readonly start: string;
  readonly now: string;
  readonly target: string;
  readonly health: HealthView;
}
export interface ProjectResultsView {
  readonly rows: readonly ResultRowView[];
  readonly note: string | null;
  readonly done: string | null;
  readonly credits: string | null;
}
/** Finish's one choice, when the project has a repeating task an area could keep. */
export interface FinishChoiceView {
  readonly keepLabel: string;
  readonly keepByDefault: boolean;
  readonly keepNote: string;
}
export interface MemberRowView {
  readonly member: MemberView;
  readonly note: string | null;
}
export interface ProjectDetailView {
  readonly projectId: Id;
  /** The goal record: its tasks come from the work API (`work.listTasks`). */
  readonly goalId: Id;
  /** The goal record's revision, sent back as `expectedRevision`. */
  readonly revision: number;
  /** dated | area | quick_tasks. */
  readonly kind: string;
  readonly title: string;
  readonly area: { readonly label: string; readonly agent: MemberView } | null;
  /** The Everyday work areas' links, shown on an area page. */
  readonly areas: readonly { readonly projectId: Id; readonly label: string }[];
  /** active | ended (past its end date, waiting on Finish or Extend) | finished. */
  readonly state: string;
  readonly endsOn: string | null;
  /** The date Extend moves the end to, `YYYY-MM-DD`; null when Extend isn't offered. */
  readonly extendTo: string | null;
  readonly health: HealthView;
  /** The scope line's parts ("Started today", "Ends Fri, Dec 4", …). */
  readonly scope: readonly string[];
  readonly stopped: string | null;
  /** What Stop steps would do here, as code worked it out. */
  readonly stopPreview: string | null;
  readonly sinceLastVisit: {
    readonly lastVisit: string;
    readonly items: readonly SinceItemView[];
  } | null;
  readonly goals: readonly GoalDetailView[];
  readonly plan: readonly PlanStepView[];
  readonly latestUpdate: ProjectUpdateView | null;
  readonly updateNote: string | null;
  readonly credits: ProjectCreditsView | null;
  readonly brief: BriefView | null;
  readonly files: readonly FileRowView[];
  readonly activity: readonly ActivityRowView[];
  readonly repeating: readonly RepeatingRowView[];
  readonly alerts: readonly AlertRowView[];
  readonly members: readonly MemberRowView[];
  readonly results: ProjectResultsView | null;
  readonly finish: FinishChoiceView | null;
  /** What this person may do now (the server's kernel decided; it checks again). */
  readonly actions: {
    readonly planNextSteps: boolean;
    readonly stopSteps: boolean;
    readonly finish: boolean;
    readonly extend: boolean;
    readonly post: boolean;
    readonly mentionMorrow: boolean;
  };
}

// ---- Plan cards (ADR-0034): a card creates nothing until a person starts it
export interface PlanGoalDraftView {
  readonly key: string;
  readonly title: string;
  /** Today's value and target, written by code per viewer. */
  readonly line: string;
  readonly source: string;
  readonly checks: readonly GoalCheckView[];
}
export interface PlanHelperView {
  readonly member: MemberView;
  readonly does: string;
  readonly note: string | null;
}
export interface PlanStepDraftView {
  readonly index: number;
  readonly title: string;
  readonly owner: MemberView;
  readonly when: string;
  readonly repeats: boolean;
}
export interface PlanEndChoiceView {
  /** `YYYY-MM-DD`. */
  readonly on: string;
  readonly recommended: boolean;
}
export interface PlanCardView {
  readonly messageId: Id;
  /** The digest of the revision shown; Start binds exactly this. */
  readonly draftDigest: string;
  readonly revision: number;
  /** project | task | repeating | plan_change. */
  readonly kind: string;
  readonly title: string;
  /** "Ends Fri, Dec 4 (we check results then) · A new project". */
  readonly scope: string;
  readonly endsOn: string | null;
  readonly why: string | null;
  readonly goals: readonly PlanGoalDraftView[];
  readonly helpers: readonly PlanHelperView[];
  readonly needsYou: string | null;
  readonly credits: string | null;
  /** Code's note when the estimate is above the balance. */
  readonly shortfall: string | null;
  readonly youllHear: string | null;
  readonly steps: readonly PlanStepDraftView[];
  readonly questions: readonly string[];
  readonly cannotDo: readonly string[];
  readonly related: string | null;
  readonly visibility: string;
  /** The server-derived taint sentence shown above Start, or null. */
  readonly tainted: string | null;
  /** Derived: the project this card started, so a message never changes. */
  readonly started: { readonly projectId: Id; readonly note: string } | null;
  /** Only the person who asked may start it (ADR-0034 owner question 2). */
  readonly canStart: boolean;
  readonly startNote: string | null;
  readonly canEdit: boolean;
  /** End dates Edit offers. */
  readonly endChoices: readonly PlanEndChoiceView[];
}
export interface PlanChangeView {
  /** add | change | remove. */
  readonly kind: string;
  readonly title: string;
  readonly owner: MemberView | null;
  readonly detail: string | null;
}
export interface PlanChangeCardView {
  readonly messageId: Id;
  readonly draftDigest: string;
  readonly title: string;
  readonly intro: string | null;
  readonly changes: readonly PlanChangeView[];
  readonly because: string | null;
  readonly credits: string | null;
  readonly tainted: string | null;
  readonly started: { readonly note: string } | null;
  readonly canStart: boolean;
  readonly startNote: string | null;
}

export type ProjectMessageView =
  | {
      readonly kind: "message";
      readonly id: Id;
      readonly author: MemberView;
      readonly at: string;
      readonly text: string;
      /** "Only people who can see orders see this." */
      readonly restricted: string | null;
      /** Written by Morrow (shown on its replies). */
      readonly written: boolean;
    }
  | { readonly kind: "line"; readonly id: Id; readonly at: string; readonly text: string }
  | {
      readonly kind: "plan_change";
      readonly id: Id;
      readonly at: string;
      readonly card: PlanChangeCardView;
    }
  | {
      readonly kind: "update";
      readonly id: Id;
      readonly at: string;
      readonly update: ProjectUpdateView;
    };
export interface ProjectConversationView {
  readonly messages: readonly ProjectMessageView[];
}

// ---- Ask Morrow (route `ask_conversation`)
export interface ChoiceOptionView {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly recommended: boolean;
}
export type AskMessageView =
  | {
      readonly kind: "request";
      readonly id: Id;
      readonly author: MemberView;
      readonly at: string;
      readonly text: string;
    }
  | {
      readonly kind: "reply";
      readonly id: Id;
      readonly at: string;
      readonly text: string;
    }
  | { readonly kind: "working"; readonly id: Id; readonly text: string }
  | {
      readonly kind: "choice";
      readonly id: Id;
      readonly at: string;
      /** "1 of 2". */
      readonly position: string;
      readonly question: string;
      readonly hint: string | null;
      readonly options: readonly ChoiceOptionView[];
      /** The tapped answer, once answered. */
      readonly answered: string | null;
      readonly canAnswer: boolean;
    }
  | {
      readonly kind: "plan";
      readonly id: Id;
      readonly at: string;
      readonly intro: string | null;
      readonly card: PlanCardView;
    };
export interface AskConversationView {
  readonly conversationId: Id;
  readonly messages: readonly AskMessageView[];
  /** "This conversation: about 2 credits". */
  readonly cost: string | null;
  readonly canPost: boolean;
}

/** The server-built, person-bound, single-use start (PlanStartDocument@1), as shown. */
export interface PlanStartDocumentView {
  readonly documentDigest: string;
  readonly nonce: string;
  readonly expiresAt: string;
  /** project (a plan card) | plan_change | finish (a code-built card). */
  readonly target: string;
  /** The draft digest it binds; null for a code-built card. */
  readonly draftDigest: string | null;
  /** The project it changes; null for a new project. */
  readonly projectId: Id | null;
}
export interface PlanStartRunView {
  readonly step: string;
  /** admitted | refused; a refused step stays "Not started" with its own button. */
  readonly outcome: string;
  readonly note: string | null;
}
export interface PlanStartResultView {
  readonly projectId: Id;
  readonly runs: readonly PlanStartRunView[];
}
export interface StopStepsResultView {
  readonly turnedOff: number;
  readonly cancelled: number;
}
export type ChoiceAnswer =
  | { readonly kind: "option"; readonly optionId: string }
  | { readonly kind: "other"; readonly text: string }
  | { readonly kind: "skip" };
/** A person's closed edits of a plan card; a new revision with a new digest. */
export interface PlanEdits {
  readonly title: string;
  readonly endsOn: string | null;
  readonly dropGoals: readonly string[];
  readonly dropSteps: readonly number[];
}
