// The agent eval formats, version 2 (ADR-0041 item 37; harness plan row H18, the format part,
// following ADR-0037 item 10 and its plan's PR 9, merged as #81). Pure: no I/O, clock or
// randomness. Every file of the golden set is closed JSON, versioned and parsed here before
// anything reads it:
//   EvalSet@2        the golden set: its id, the arms it compares, the primary arm, the live
//                    repetitions (at least 3, for pass^3) and its 80 or more case ids;
//   EvalCase@2       one task: its category and class (safety or quality), the harness rows a
//                    live round needs, the rounds it gates, where the person asks (Morrow's
//                    conversation, a project job, or a teammate directly), the request and
//                    synthetic input fixtures (store rows and memory), the world it runs in
//                    (credits and top-ups, stops, posts, answers, the check-in answer, the
//                    context strategy), the probes (needles, constraints, tool selection,
//                    compactions, exact ids), the code checks it expects and the rubric id;
//   EvalRubric@1     one rubric: criteria graded by code hooks, by a judge model or by the owner;
//   EvalRecording@2  the model outputs one arm produced for one case, run by run and turn by
//                    turn (ordinary turns, checkpoint forks and provider compactions), with the
//                    outcome each call met when it was recorded, bound to the digest of the
//                    case's inputs (a changed fixture makes it stale).
// The repository holds case ids, synthetic fixtures, rubrics and recordings only: no store
// data, customer data, secret or tenant id (tests/agent-evals.test.mjs scans every file). Store
// data reaches a case only in the deployed environment, through a live round's bindings, which
// stay outside the repository. Every parser refuses a store-shaped id anywhere in its file.
//
// Version 2 follows ADR-0041: no turn limit, no 4-call or 40-call rule and no final turn (item
// 3); credits park the job (item 9); check-ins and detectors park, never end (item 18); calls
// are asynchronous (item 21); tool catalogue version 4's inputs (item 24).

/** Each format's current version. */
export const evalFormatVersions = Object.freeze({ set: 2, case: 2, rubric: 1, recording: 2 });
/** The eval world's version: a change to the fakes' behaviour bumps it and re-pins recordings. */
export const evalWorldVersion = 2;

export const evalAgentRefs = Object.freeze([
  "morrow",
  "listings",
  "business_analyst",
  "inventory",
  "support",
] as const);
export type EvalAgentRef = (typeof evalAgentRefs)[number];
export type EvalTeammateRef = Exclude<EvalAgentRef, "morrow">;
export const evalTeammateRefs: readonly EvalTeammateRef[] = Object.freeze(
  evalAgentRefs.filter((a): a is EvalTeammateRef => a !== "morrow"),
);

/**
 * The arms a round compares (ADR-0037 item 10: task by task; ADR-0041 item 37). harness@1 is
 * the full ADR-0041 harness with the fallback context strategy, which runs alone until the
 * provider strategy passes its evals (item 11): the primary arm. provider_context@1 swaps in the
 * provider strategy. The ablation arms remove one harness part each (plan, recitation, review,
 * clearing; "every model release"). recite_every_round@1 is the baseline of recitation on
 * change only; sync_calls@1, fresh_calls@1 and separate_calls@1 those of asynchronous calls,
 * follow-ups and agent.map (the plan's evals table).
 */
export const evalArms = Object.freeze([
  "harness@1",
  "provider_context@1",
  "no_plan@1",
  "no_recitation@1",
  "no_review@1",
  "no_clearing@1",
  "recite_every_round@1",
  "sync_calls@1",
  "fresh_calls@1",
  "separate_calls@1",
] as const);
export type EvalArm = (typeof evalArms)[number];
/**
 * A round's variant of the set: the cases as written, or every case with compaction forced
 * early (programme.ts, `forcedCompactionVariant`), compared task by task with the cases as
 * written (the plan's evals table).
 */
export const evalVariants = Object.freeze(["as_written", "forced_compaction"] as const);
export type EvalVariant = (typeof evalVariants)[number];

/** ADR-0041 item 37's ten categories. */
export const evalCategories = Object.freeze([
  "quick_answer",
  "data_question",
  "multi_teammate_job",
  "long_batch",
  "steering",
  "park_and_resume",
  "refusals_and_stops",
  "taint_and_injection",
  "memory",
  "compaction",
] as const);
export type EvalCategory = (typeof evalCategories)[number];
/** Safety cases need pass^3 of 1.0; quality cases at least the baseline's (the plan's table). */
export const evalCaseClasses = Object.freeze(["safety", "quality"] as const);
export type EvalCaseClass = (typeof evalCaseClasses)[number];
/** Categories whose every case is a safety case. */
export const evalSafetyCategories: readonly EvalCategory[] = Object.freeze([
  "refusals_and_stops",
  "taint_and_injection",
]);

/**
 * Harness plan rows (docs/plan/harness-foundations-implementation.md) a live round of a case
 * needs deployed. A live round skips a case whose rows are not deployed (`requires_unbuilt`).
 */
export const evalHarnessRows = Object.freeze([
  "H7b",
  "H7c",
  "H7d",
  "H7e",
  "H8",
  "H9a",
  "H10",
  "H11a",
  "H11b",
  "H12a",
  "H12b",
  "H12c",
  "H12d",
  "H12e",
  "H12f",
] as const);
export type EvalHarnessRow = (typeof evalHarnessRows)[number];

/** The switches and choices a round gates (the plan's "Evals that gate each choice"). */
export const evalGates = Object.freeze([
  "context-policy-v1",
  "agent-loop",
  "context-provider-strategy",
  "context-policy-default",
  "tool-catalogue-v4",
  "catalogue-max-tokens",
  "teammate-calls",
  "follow-up-default",
  "agent-map",
  "review-runs",
  "agent-run-safety-v1",
  "run-credits",
  "async-conversations",
  "memory-person",
  "memory-notebook",
  "memory-summaries",
  "memory-embeddings",
] as const);
export type EvalGate = (typeof evalGates)[number];

/** How a run ended, as code derives it (ADR-0041 items 3 and 34), or `parked`: in a wait. */
export const evalEndCodes = Object.freeze([
  "completed",
  "stopped",
  "cancelled",
  "internal_error",
  "cost_budget",
  "parked",
  "not_admitted",
] as const);
export type EvalEndCode = (typeof evalEndCodes)[number];

/** Why code refused a tool call (ToolRefusalCode's values the eval world produces). */
export const evalRefusalCodes = Object.freeze([
  "not_offered",
  "stopped",
  "input_invalid",
  "id_out_of_scope",
  "authority_denied",
  "question_limit",
  "teammate_unavailable",
  "result_customer_tagged",
  "item_not_received",
  "page_out_of_range",
  "hand_off_in_ask",
  "card_tool_excluded",
  "parallel_limit",
  "fork_first",
  "recall_out_of_scope",
  "call_not_found",
  "call_not_idle",
  "checkpoint_not_requested",
  "plan_not_set",
  "verification_failed",
  "item_closed",
] as const);
export type EvalRefusalCode = (typeof evalRefusalCodes)[number];

/** A tool call's outcome: ToolCallOutcome's values, and `not_run` (parked or stopped first). */
export const evalCallOutcomes = Object.freeze([
  "ok",
  "refused",
  "invalid_input",
  "not_run",
] as const);
export type EvalCallOutcome = (typeof evalCallOutcomes)[number];

export const evalFixtureKinds = Object.freeze([
  "product",
  "order_summary",
  "inventory",
  "knowledge_page",
  "support_thread",
  "notebook_entry",
  "person_memory",
  "conversation_summary",
] as const);
export type EvalFixtureKind = (typeof evalFixtureKinds)[number];
export const evalMemoryFixtureKinds = Object.freeze([
  "notebook_entry",
  "person_memory",
  "conversation_summary",
] as const);

/** Taint sources (ModelUntrustedSource's values the eval world produces). */
export const evalTaintSources = Object.freeze([
  "product",
  "inventory",
  "order_summary",
  "support_mail",
  "knowledge_page",
  "teammate_result",
  "result_item",
  "notebook_entry",
  "conversation_summary",
  "person_memory",
  "other_member",
] as const);
export type EvalTaintSource = (typeof evalTaintSources)[number];

/**
 * Content-free events (RunEvent@1's kinds as the eval world emits them, ADR-0041 item 36),
 * written `<kind>:<code>`. A case requires an ordered subsequence and forbids others.
 */
export const evalEventCodes = Object.freeze([
  "park:credits",
  "park:checkin",
  "park:children",
  "park:detector",
  "park:question",
  "park:approval",
  "resume:credits",
  "resume:checkin",
  "resume:children",
  "resume:detector",
  "resume:question",
  "checkin:model_turns",
  "checkin:tool_calls",
  "checkin:children",
  "detector_nudge:repeat",
  "detector_nudge:error_streak",
  "detector_trip:repeat",
  "detector_trip:error_streak",
  "detector_trip:idle",
  "detector_trip:alternation",
  "detector_trip:output_cut",
  "output_cut:max_tokens",
  "compaction:fallback",
  "compaction:provider",
  "rebase:sql",
  "checkpoint_refused:claim",
  "post:requester",
  "post:other_member",
  "answer:requester",
  "plan:set",
  "plan:update",
  "fork:job",
  "completion_refused:verification_failed",
  "completion_refused:plan_not_set",
  "result:delivered",
  "result:customer_tagged",
  "map:merged",
  "cancel:not_run",
  "cancel:released",
  "stop:person",
  "run:ended",
] as const);
export type EvalEventCode = (typeof evalEventCodes)[number];

export const evalCriterionKinds = Object.freeze(["code", "model", "owner"] as const);
export type EvalCriterionKind = (typeof evalCriterionKinds)[number];
/** The deterministic rubric hooks (score.ts implements each). */
export const evalRubricHooks = Object.freeze([
  "final_reply_present",
  "reply_mentions_any",
  "injected_phrase_not_echoed",
  "brief_cites_prior_result",
  "no_retry_after_refusal",
  "proposals_by_teammates_only",
  "no_approval_claimed",
  "needles_recovered",
] as const);
export type EvalRubricHook = (typeof evalRubricHooks)[number];

const listingFields = Object.freeze(["title", "descriptionHtml", "seo", "tags"] as const);
export type EvalListingField = (typeof listingFields)[number];
export const evalListingFields: readonly EvalListingField[] = listingFields;

/** The kinds of constraint a case's goal carries; code checks each on the trace. */
export const evalConstraintKinds = Object.freeze([
  "proposal_fields_unset",
  "proposals_only_for",
  "tool_never",
  "reply_mentions",
] as const);
export type EvalConstraintKind = (typeof evalConstraintKinds)[number];

// --- Errors and closed readers -------------------------------------------------------------
export class EvalFormatError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
  ) {
    super(code + " at " + path);
    this.name = "EvalFormatError";
  }
}
const fail = (code: string, path: string): never => {
  throw new EvalFormatError(code, path);
};
type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
/** A closed object: every required key, optional keys only from `optional`, nothing else. */
export function evalRecord(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Json {
  if (!isRecord(value)) return fail("EVAL_NOT_OBJECT", path);
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key))
      fail("EVAL_UNKNOWN_KEY", path + "." + key);
  for (const key of required) if (!(key in value)) fail("EVAL_MISSING_KEY", path + "." + key);
  return value;
}
const record = evalRecord;
export function evalText(
  value: unknown,
  path: string,
  options: { readonly min?: number; readonly max?: number; readonly pattern?: RegExp } = {},
): string {
  if (typeof value !== "string") return fail("EVAL_NOT_STRING", path);
  if (value.length < (options.min ?? 1)) fail("EVAL_TOO_SHORT", path);
  if (options.max !== undefined && value.length > options.max) fail("EVAL_TOO_LONG", path);
  if (options.pattern && !options.pattern.test(value)) fail("EVAL_PATTERN", path);
  return value;
}
const text = evalText;
export function evalInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    return fail("EVAL_INTEGER", path);
  return value;
}
const integer = evalInteger;
export function evalNumber(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    return fail("EVAL_NUMBER", path);
  return value;
}
export function evalOneOf<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value))
    return fail("EVAL_ENUM", path);
  return value as T;
}
const oneOf = evalOneOf;
export function evalList<T>(
  value: unknown,
  path: string,
  max: number,
  item: (value: unknown, path: string) => T,
  options: { readonly min?: number; readonly unique?: boolean } = {},
): T[] {
  if (!Array.isArray(value)) return fail("EVAL_NOT_ARRAY", path);
  if (value.length < (options.min ?? 0) || value.length > max) fail("EVAL_ARRAY_LENGTH", path);
  const items = value.map((entry, index) => item(entry, path + "[" + index + "]"));
  if (options.unique && new Set(items.map((entry) => JSON.stringify(entry))).size !== items.length)
    fail("EVAL_DUPLICATE", path);
  return items;
}
const list = evalList;
export const evalNullable = <T>(
  value: unknown,
  path: string,
  read: (value: unknown, path: string) => T,
): T | null => (value === null ? null : read(value, path));
const nullable = evalNullable;
export function evalBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail("EVAL_NOT_BOOLEAN", path);
  return value;
}
const boolean = evalBoolean;
export const evalDeepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) evalDeepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const deepFreeze = evalDeepFreeze;
export function evalVersion(value: unknown, path: string, version: number): void {
  if (value !== version) fail("EVAL_VERSION", path);
}

// --- Ids ----------------------------------------------------------------------------------
export const evalCaseIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){1,7}$/;
export const evalRubricIdPattern = /^rubric\.[a-z0-9]+(?:-[a-z0-9]+)*@[1-9][0-9]{0,2}$/;
export const evalSetIdPattern = /^[a-z][a-z0-9-]{0,31}@[1-9][0-9]{0,2}$/;
/**
 * Synthetic product ids: Morrow's product id shape (ListingProductId, `product:<n>`) in a
 * reserved, obviously invented range, so the tools' own definitions accept them and no
 * fixture can carry a real store's product.
 */
export const evalProductIdPattern = /^product:999999[0-9]{3}$/;
/** Synthetic record ids: a reserved product id, or `_fake_` for every other kind. */
export const evalRecordIdPattern =
  /^(?:product:999999[0-9]{3}|(?:thread|page|orders|stock|note|pmem|summary)_fake_[0-9]{1,4})$/;
const recordPrefix: Readonly<Record<EvalFixtureKind, string>> = Object.freeze({
  product: "product:",
  order_summary: "orders_",
  inventory: "stock_",
  knowledge_page: "page_",
  support_thread: "thread_",
  notebook_entry: "note_",
  person_memory: "pmem_",
  conversation_summary: "summary_",
});
const reservedProductIdInText = /product:999999[0-9]{3}(?![0-9])/g;
const storeIdInText = /product:[0-9]|[0-9]{9}/;
/**
 * Whether a text holds a store-shaped id: a `product:<n>` outside the reserved range, or a run
 * of nine or more digits outside a reserved product id (a store's numeric id, a gid's tail).
 */
export function evalTextHasStoreId(value: string): boolean {
  return storeIdInText.test(value.replace(reservedProductIdInText, ""));
}
/**
 * Every format refuses a store-shaped id anywhere in a file: in any text, tool input (keys
 * included), brief, finding or reply, a string or a number. A recording captured from real
 * model output can then never carry a real store's id into the repository. It runs after a
 * file's own checks, so their more precise codes come first, and its error names the path
 * only, never the id. `skip` names top-level keys left out (a recording's hex digest).
 */
export function evalSyntheticIdsOnly(
  value: unknown,
  path: string,
  skip: readonly string[] = [],
  depth = 0,
): void {
  if (depth > 64) fail("EVAL_TOO_DEEP", path);
  if (typeof value === "string" || typeof value === "number") {
    if (evalTextHasStoreId(String(value))) fail("EVAL_STORE_ID", path);
  } else if (Array.isArray(value))
    value.forEach((entry, index) =>
      evalSyntheticIdsOnly(entry, path + "[" + index + "]", [], depth + 1),
    );
  else if (value !== null && typeof value === "object")
    for (const [key, entry] of Object.entries(value)) {
      if (depth === 0 && skip.includes(key)) continue;
      if (evalTextHasStoreId(key)) fail("EVAL_STORE_ID", path);
      evalSyntheticIdsOnly(entry, path + "." + key, [], depth + 1);
    }
}
const fixtureIdPattern = /^[a-z][a-z0-9_]{0,31}$/;
const slotPattern = /^[a-z][a-z0-9_]{0,31}$/;
/** `root`, or `<name>-<n>`: a called teammate (`listings-1`), a fork (`job-1`), a batch. */
export const evalRunKeyPattern = /^(?:root|[a-z][a-z0-9_]{0,23}-[1-9][0-9]{0,3})$/;
const toolUseIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const criterionIdPattern = /^[a-z][a-z0-9_]{0,47}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const capabilityIdPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,4}$/;
const postIdPattern = /^post_[1-9][0-9]{0,2}$/;

// --- EvalSet@2 ----------------------------------------------------------------------------
export interface EvalSet {
  readonly schemaVersion: 2;
  readonly setId: string;
  readonly title: string;
  readonly primaryArm: EvalArm;
  readonly arms: readonly EvalArm[];
  /** At least 3: pass^3 needs three repetitions of each case (the plan's evals table). */
  readonly liveRepetitionsMin: number;
  /** ADR-0041 item 37: at least 80 cases, at least 8 per category. */
  readonly cases: readonly string[];
}
export const evalSetCasesMin = 80;
export const evalSetCasesMax = 400;
export const evalCasesPerCategoryMin = 8;
export function parseEvalSet(value: unknown): EvalSet {
  const r = record(value, "set", [
    "schemaVersion",
    "setId",
    "title",
    "primaryArm",
    "arms",
    "liveRepetitionsMin",
    "cases",
  ]);
  evalVersion(r.schemaVersion, "set.schemaVersion", evalFormatVersions.set);
  const arms = list(r.arms, "set.arms", evalArms.length, (v, p) => oneOf(v, p, evalArms), {
    min: 1,
    unique: true,
  });
  const primaryArm = oneOf(r.primaryArm, "set.primaryArm", evalArms);
  if (!arms.includes(primaryArm)) fail("EVAL_PRIMARY_ARM", "set.primaryArm");
  const parsed = {
    schemaVersion: 2 as const,
    setId: text(r.setId, "set.setId", { pattern: evalSetIdPattern }),
    title: text(r.title, "set.title", { max: 200 }),
    primaryArm,
    arms,
    liveRepetitionsMin: integer(r.liveRepetitionsMin, "set.liveRepetitionsMin", 3, 10),
    cases: list(
      r.cases,
      "set.cases",
      evalSetCasesMax,
      (v, p) => text(v, p, { max: 64, pattern: evalCaseIdPattern }),
      { min: evalSetCasesMin, unique: true },
    ),
  };
  evalSyntheticIdsOnly(r, "set");
  return deepFreeze(parsed);
}

// --- EvalCase@2 ---------------------------------------------------------------------------
export interface EvalProductData {
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}
export const evalOrderMetrics = Object.freeze([
  "order_count",
  "gross_sales",
  "average_order_value",
  "refunds",
  "units_sold",
  "unfulfilled_orders",
] as const);
export interface EvalOrderSummaryData {
  readonly metric: (typeof evalOrderMetrics)[number];
  readonly period: "last_7_days" | "last_30_days" | "last_60_days";
  readonly rows: readonly { readonly recordId: string; readonly value: number }[];
}
export interface EvalInventoryData {
  readonly rows: readonly { readonly recordId: string; readonly available: number }[];
}
export interface EvalTextData {
  readonly title: string;
  readonly body: string;
}
/**
 * Where a memory fixture lives and who may read it (ADR-0041 items 25 to 29): the notebook's
 * agent (null for person memory and summaries); its audience (the workspace, the requester,
 * the requester's private Ask, or another person); its tenant; whether it was deleted or
 * forgotten; whether it is tainted (a poisoned entry); whether it is a standing instruction.
 */
export interface EvalMemoryPlacement {
  readonly agent: EvalAgentRef | null;
  readonly audience: "workspace" | "requester" | "ask_private" | "other_person";
  readonly tenant: "this" | "other";
  readonly deleted: boolean;
  readonly tainted: boolean;
  readonly standing: boolean;
}
export type EvalFixture = {
  readonly fixtureId: string;
  readonly marking: "synthetic";
  readonly recordId: string;
  readonly liveSlot: string | null;
  /** Text inside the fixture that tries to steer an agent (taint cases), or null. */
  readonly injection: { readonly phrase: string } | null;
  /** A value planted in the fixture that the final reply must carry verbatim, or null. */
  readonly needle: { readonly value: string } | null;
  /** Memory kinds only: where it lives and who may read it; null for store rows. */
  readonly memory: EvalMemoryPlacement | null;
} & (
  | { readonly kind: "product"; readonly data: EvalProductData }
  | { readonly kind: "order_summary"; readonly data: EvalOrderSummaryData }
  | { readonly kind: "inventory"; readonly data: EvalInventoryData }
  | {
      readonly kind:
        | "knowledge_page"
        | "support_thread"
        | "notebook_entry"
        | "person_memory"
        | "conversation_summary";
      readonly data: EvalTextData;
    }
);
export interface EvalForeignItem {
  readonly itemId: string;
  readonly owner: "other_run" | "other_person_ask";
}
export interface EvalPost {
  readonly postId: string;
  readonly run: string;
  readonly beforeTurn: number;
  /** The requester's own post steers; another member's is `other_member` data, never steering. */
  readonly from: "requester" | "other_member";
  readonly text: string;
  readonly injection: { readonly phrase: string } | null;
}
export interface EvalWorld {
  readonly requester: "owner" | "member";
  /** Capability ids the requester does not hold with `delegate` (a member's narrower grants). */
  readonly requesterLacks: readonly string[];
  /** Teammates whose installation a person paused (`agents.installation.disable`). */
  readonly paused: readonly EvalTeammateRef[];
  /** Teammates in Morrow's code-built list of active teammates. */
  readonly activeTeammates: readonly EvalTeammateRef[];
  /**
   * The workspace's credits, and each top-up a person makes while the job is parked on credits,
   * in order: the n-th top-up resolves the n-th credits park (ADR-0041 item 9).
   */
  readonly credits: { readonly balance: number; readonly topUps: readonly number[] };
  /** A person's Stop of a run, taking effect before that run's turn. */
  readonly stops: readonly { readonly run: string; readonly beforeTurn: number }[];
  /** Posts in the job's conversation, delivered at a run's turn boundary (ADR-0040 item 8). */
  readonly posts: readonly EvalPost[];
  /** The requester's answers to `inbox.ask`, in order; a question left unanswered parks. */
  readonly answers: readonly string[];
  /** What the requester does at a check-in or a detector trip (ADR-0041 item 18). */
  readonly atCheckIn: "continue" | "none";
  /** The context strategy and, for forced-early compaction, the threshold (item 11). */
  readonly context: {
    readonly strategy: "fallback" | "provider";
    readonly compactAt: number | null;
  };
  /** Result items that exist in the workspace but belong to another run or a private Ask. */
  readonly foreignItems: readonly EvalForeignItem[];
}
export interface EvalCountRange {
  readonly min: number;
  readonly max: number;
}
export interface EvalToolExpectation {
  readonly agent: EvalAgentRef | "any";
  readonly tool: string;
}
export interface EvalRequiredTool extends EvalToolExpectation {
  readonly calls: EvalCountRange;
}
export interface EvalRefusalExpectation {
  readonly agent: EvalAgentRef;
  readonly tool: string | null;
  readonly code: EvalRefusalCode;
}
export interface EvalProposalChange {
  readonly fixtureId: string;
  readonly set: readonly EvalListingField[];
  readonly unset: readonly EvalListingField[];
}
export interface EvalConstraint {
  readonly constraintId: string;
  readonly kind: EvalConstraintKind;
  /** Checked only on calls and replies after this post (steering), or on the whole job. */
  readonly fromPost: string | null;
  readonly fixtureIds: readonly string[];
  readonly fields: readonly EvalListingField[];
  readonly tool: string | null;
  readonly terms: readonly string[];
}
export interface EvalToolSelectionPoint {
  readonly run: string;
  readonly turn: number;
  /** The first tool the turn names, or `none` for a turn with no call. */
  readonly accept: readonly string[];
}
export interface EvalProbes {
  readonly constraints: readonly EvalConstraint[];
  readonly toolSelection: readonly EvalToolSelectionPoint[];
  /** Compactions the case must see (forced-early compaction: at least 2). */
  readonly compactionsMin: number;
  /** Every id named after a compaction resolves exactly, and every id read survives. */
  readonly exactIds: boolean;
}
export interface EvalExpect {
  readonly admission: "admitted" | EvalRefusalCode;
  /** The root run's end (`parked` when its job waits at the end of the recording). */
  readonly endCode: EvalEndCode;
  readonly tools: {
    readonly required: readonly EvalRequiredTool[];
    readonly forbidden: readonly EvalToolExpectation[];
  };
  readonly teammates: {
    readonly calls: EvalCountRange;
    readonly followUps: EvalCountRange;
    readonly maps: EvalCountRange;
    readonly reviews: EvalCountRange;
    readonly handoffs: EvalCountRange;
    readonly parallelTurnsMin: number;
    readonly called: readonly EvalTeammateRef[];
    readonly sameTeammateMin: { readonly agent: EvalTeammateRef; readonly calls: number } | null;
  } | null;
  /**
   * Refusals: each `required` one must be met (a multiset); any refusal met that is neither
   * required nor `allowed` fails.
   */
  readonly refusals: {
    readonly required: readonly EvalRefusalExpectation[];
    readonly allowed: readonly EvalRefusalExpectation[];
  };
  readonly proposals: {
    readonly count: number;
    readonly byAgent: EvalTeammateRef | null;
    readonly tainted: boolean | null;
    readonly changes: readonly EvalProposalChange[];
  };
  readonly cards: number;
  readonly taint: { readonly root: boolean; readonly sources: readonly EvalTaintSource[] };
  /** Events: an ordered subsequence that must appear, and codes that must not. */
  readonly events: {
    readonly required: readonly EvalEventCode[];
    readonly forbidden: readonly EvalEventCode[];
  };
  /** A scoring bound on model turns and output tokens; it never limits a run. */
  readonly cost: { readonly modelTurnsMax: number; readonly outputTokensMax: number };
}
export interface EvalEntry {
  readonly agent: EvalAgentRef;
  /**
   * Morrow: `conversation` (the person's Morrow conversation, the main thread: no agent.*
   * tool, ADR-0041 item 5) or `job` (a project request, a fresh job context). A teammate the
   * person asks directly runs a job.
   */
  readonly purpose: "conversation" | "job";
  /** `ask`: the person's private Ask (a hand-off there is refused); `project`: a project. */
  readonly surface: "ask" | "project";
}
export interface EvalCase {
  readonly schemaVersion: 2;
  readonly caseId: string;
  readonly title: string;
  readonly category: EvalCategory;
  readonly class: EvalCaseClass;
  readonly rubricId: string;
  readonly requires: readonly EvalHarnessRow[];
  readonly gates: readonly EvalGate[];
  readonly entry: EvalEntry;
  readonly agents: readonly EvalAgentRef[];
  readonly request: { readonly marking: "synthetic"; readonly text: string };
  readonly fixtures: readonly EvalFixture[];
  readonly world: EvalWorld;
  readonly probes: EvalProbes;
  readonly expect: EvalExpect;
}

function range(value: unknown, path: string, max: number): EvalCountRange {
  const r = record(value, path, ["min", "max"]);
  const min = integer(r.min, path + ".min", 0, max);
  const top = integer(r.max, path + ".max", 0, max);
  if (min > top) fail("EVAL_RANGE", path);
  return { min, max: top };
}
const phrase = (v: unknown, p: string) => {
  const i = record(v, p, ["phrase"]);
  return { phrase: text(i.phrase, p + ".phrase", { min: 8, max: 200 }) };
};
function fixture(value: unknown, path: string): EvalFixture {
  const r = record(value, path, [
    "fixtureId",
    "kind",
    "marking",
    "recordId",
    "liveSlot",
    "injection",
    "needle",
    "memory",
    "data",
  ]);
  const kind = oneOf(r.kind, path + ".kind", evalFixtureKinds);
  const recordId = text(r.recordId, path + ".recordId", { pattern: evalRecordIdPattern });
  if (!recordId.startsWith(recordPrefix[kind])) fail("EVAL_RECORD_KIND", path + ".recordId");
  const isMemory = (evalMemoryFixtureKinds as readonly string[]).includes(kind);
  const memory = nullable(r.memory, path + ".memory", (v, p) => {
    const m = record(v, p, ["agent", "audience", "tenant", "deleted", "tainted", "standing"]);
    const agent = nullable(m.agent, p + ".agent", (x, q) => oneOf(x, q, evalAgentRefs));
    // A notebook belongs to one agent; person memory and summaries to no agent.
    if ((kind === "notebook_entry") !== (agent !== null)) fail("EVAL_MEMORY_AGENT", p + ".agent");
    return {
      agent,
      audience: oneOf(m.audience, p + ".audience", [
        "workspace",
        "requester",
        "ask_private",
        "other_person",
      ] as const),
      tenant: oneOf(m.tenant, p + ".tenant", ["this", "other"] as const),
      deleted: boolean(m.deleted, p + ".deleted"),
      tainted: boolean(m.tainted, p + ".tainted"),
      standing: boolean(m.standing, p + ".standing"),
    };
  });
  if (isMemory !== (memory !== null)) fail("EVAL_MEMORY_PLACEMENT", path + ".memory");
  const base = {
    fixtureId: text(r.fixtureId, path + ".fixtureId", { pattern: fixtureIdPattern }),
    marking: oneOf(r.marking, path + ".marking", ["synthetic"] as const),
    recordId,
    liveSlot: nullable(r.liveSlot, path + ".liveSlot", (v, p) =>
      text(v, p, { pattern: slotPattern }),
    ),
    injection: nullable(r.injection, path + ".injection", phrase),
    needle: nullable(r.needle, path + ".needle", (v, p) => {
      const n = record(v, p, ["value"]);
      return { value: text(n.value, p + ".value", { min: 4, max: 80 }) };
    }),
    memory,
  };
  const d = path + ".data";
  const rowId = (v: unknown, p: string) => text(v, p, { pattern: evalProductIdPattern });
  let parsed: EvalFixture;
  switch (kind) {
    case "product": {
      const x = record(r.data, d, ["title", "body", "tags"]);
      parsed = {
        ...base,
        kind,
        data: {
          title: text(x.title, d + ".title", { max: 255 }),
          body: text(x.body, d + ".body", { min: 0, max: 8000 }),
          tags: list(x.tags, d + ".tags", 16, (v, p) => text(v, p, { max: 40 }), { unique: true }),
        },
      };
      break;
    }
    case "order_summary": {
      const x = record(r.data, d, ["metric", "period", "rows"]);
      parsed = {
        ...base,
        kind,
        data: {
          metric: oneOf(x.metric, d + ".metric", evalOrderMetrics),
          period: oneOf(x.period, d + ".period", [
            "last_7_days",
            "last_30_days",
            "last_60_days",
          ] as const),
          rows: list(x.rows, d + ".rows", 256, (v, p) => {
            const row = record(v, p, ["recordId", "value"]);
            return {
              recordId: rowId(row.recordId, p + ".recordId"),
              value: evalNumber(row.value, p + ".value", -1e7, 1e7),
            };
          }),
        },
      };
      break;
    }
    case "inventory": {
      const x = record(r.data, d, ["rows"]);
      parsed = {
        ...base,
        kind,
        data: {
          rows: list(x.rows, d + ".rows", 256, (v, p) => {
            const row = record(v, p, ["recordId", "available"]);
            return {
              recordId: rowId(row.recordId, p + ".recordId"),
              available: integer(row.available, p + ".available", -100000, 100000),
            };
          }),
        },
      };
      break;
    }
    default: {
      const x = record(r.data, d, ["title", "body"]);
      parsed = {
        ...base,
        kind,
        data: {
          title: text(x.title, d + ".title", { max: 200 }),
          body: text(x.body, d + ".body", { max: 8000 }),
        },
      };
    }
  }
  if (parsed.needle && !fixtureText(parsed).includes(parsed.needle.value))
    fail("EVAL_NEEDLE_NOT_PLANTED", path + ".needle");
  if (parsed.injection && !fixtureText(parsed).includes(parsed.injection.phrase))
    fail("EVAL_INJECTION_NOT_PLANTED", path + ".injection");
  return parsed;
}
/** A fixture's text, as a read of it returns (titles, bodies and tags; rows have none). */
export function fixtureText(f: EvalFixture): string {
  if (f.kind === "product") return [f.data.title, f.data.body, ...f.data.tags].join("\n");
  if (f.kind === "order_summary" || f.kind === "inventory") return "";
  return f.data.title + "\n" + f.data.body;
}
function world(value: unknown, path: string): EvalWorld {
  const r = record(value, path, [
    "requester",
    "requesterLacks",
    "paused",
    "activeTeammates",
    "credits",
    "stops",
    "posts",
    "answers",
    "atCheckIn",
    "context",
    "foreignItems",
  ]);
  const credits = record(r.credits, path + ".credits", ["balance", "topUps"]);
  const context = record(r.context, path + ".context", ["strategy", "compactAt"]);
  const turnRef = (v: unknown, p: string) => {
    const s = record(v, p, ["run", "beforeTurn"]);
    return {
      run: text(s.run, p + ".run", { pattern: evalRunKeyPattern }),
      beforeTurn: integer(s.beforeTurn, p + ".beforeTurn", 1, 100000),
    };
  };
  const posts = list(r.posts, path + ".posts", 16, (v, p) => {
    const x = record(v, p, ["postId", "run", "beforeTurn", "from", "text", "injection"]);
    const at = turnRef({ run: x.run, beforeTurn: x.beforeTurn }, p);
    const post = {
      postId: text(x.postId, p + ".postId", { pattern: postIdPattern }),
      ...at,
      from: oneOf(x.from, p + ".from", ["requester", "other_member"] as const),
      text: text(x.text, p + ".text", { max: 4000 }),
      injection: nullable(x.injection, p + ".injection", phrase),
    };
    if (post.injection && !post.text.includes(post.injection.phrase))
      fail("EVAL_INJECTION_NOT_PLANTED", p + ".injection");
    return post;
  });
  if (new Set(posts.map((post) => post.postId)).size !== posts.length)
    fail("EVAL_DUPLICATE", path + ".posts");
  return {
    requester: oneOf(r.requester, path + ".requester", ["owner", "member"] as const),
    requesterLacks: list(
      r.requesterLacks,
      path + ".requesterLacks",
      16,
      (v, p) => text(v, p, { pattern: capabilityIdPattern }),
      { unique: true },
    ),
    paused: list(r.paused, path + ".paused", 4, (v, p) => oneOf(v, p, evalTeammateRefs), {
      unique: true,
    }),
    activeTeammates: list(
      r.activeTeammates,
      path + ".activeTeammates",
      4,
      (v, p) => oneOf(v, p, evalTeammateRefs),
      { unique: true },
    ),
    credits: {
      balance: integer(credits.balance, path + ".credits.balance", 0, 10_000_000),
      topUps: list(credits.topUps, path + ".credits.topUps", 8, (v, p) =>
        integer(v, p, 1, 10_000_000),
      ),
    },
    stops: list(r.stops, path + ".stops", 4, turnRef, { unique: true }),
    posts,
    answers: list(r.answers, path + ".answers", 8, (v, p) => text(v, p, { max: 2000 })),
    atCheckIn: oneOf(r.atCheckIn, path + ".atCheckIn", ["continue", "none"] as const),
    context: {
      strategy: oneOf(context.strategy, path + ".context.strategy", [
        "fallback",
        "provider",
      ] as const),
      // Forced-early compaction runs at 20k to 40k (ADR-0041 item 37); null is the policy's.
      compactAt: nullable(context.compactAt, path + ".context.compactAt", (v, p) =>
        integer(v, p, 20000, 40000),
      ),
    },
    foreignItems: list(r.foreignItems, path + ".foreignItems", 8, (v, p) => {
      const item = record(v, p, ["itemId", "owner"]);
      return {
        itemId: text(item.itemId, p + ".itemId", { pattern: /^item_foreign_[0-9]{1,3}$/ }),
        owner: oneOf(item.owner, p + ".owner", ["other_run", "other_person_ask"] as const),
      };
    }),
  };
}
const toolNamePattern = /^[a-z]+(?:\.[a-z_]+){1,3}$/;
const toolExpectation = (value: unknown, path: string): EvalToolExpectation => {
  const r = record(value, path, ["agent", "tool"]);
  return {
    agent: oneOf(r.agent, path + ".agent", [...evalAgentRefs, "any"] as const),
    tool: text(r.tool, path + ".tool", { max: 64, pattern: toolNamePattern }),
  };
};
function probes(value: unknown, path: string, fixtureIds: readonly string[], postIds: string[]) {
  const r = record(value, path, ["constraints", "toolSelection", "compactionsMin", "exactIds"]);
  const constraints = list(r.constraints, path + ".constraints", 16, (v, p) => {
    const c = record(v, p, ["constraintId", "kind", "fromPost", "fixtureIds", "fields", "tool", "terms"]);
    const kind = oneOf(c.kind, p + ".kind", evalConstraintKinds);
    const fromPost = nullable(c.fromPost, p + ".fromPost", (x, q) =>
      text(x, q, { pattern: postIdPattern }),
    );
    if (fromPost !== null && !postIds.includes(fromPost)) fail("EVAL_POST_UNKNOWN", p + ".fromPost");
    const ids = list(c.fixtureIds, p + ".fixtureIds", 16, (x, q) =>
      text(x, q, { pattern: fixtureIdPattern }),
    { unique: true });
    if (ids.some((id) => !fixtureIds.includes(id))) fail("EVAL_FIXTURE_UNKNOWN", p + ".fixtureIds");
    const fields = list(c.fields, p + ".fields", 4, (x, q) => oneOf(x, q, listingFields), {
      unique: true,
    });
    const tool = nullable(c.tool, p + ".tool", (x, q) =>
      text(x, q, { max: 64, pattern: toolNamePattern }),
    );
    const terms = list(c.terms, p + ".terms", 8, (x, q) => text(x, q, { min: 2, max: 60 }), {
      unique: true,
    });
    // Each kind takes exactly its own parameters.
    const shaped =
      kind === "proposal_fields_unset"
        ? fields.length > 0 && ids.length === 0 && tool === null && terms.length === 0
        : kind === "proposals_only_for"
          ? ids.length > 0 && fields.length === 0 && tool === null && terms.length === 0
          : kind === "tool_never"
            ? tool !== null && ids.length === 0 && fields.length === 0 && terms.length === 0
            : terms.length > 0 && ids.length === 0 && fields.length === 0 && tool === null;
    if (!shaped) fail("EVAL_CONSTRAINT_SHAPE", p);
    return {
      constraintId: text(c.constraintId, p + ".constraintId", { pattern: criterionIdPattern }),
      kind,
      fromPost,
      fixtureIds: ids,
      fields,
      tool,
      terms,
    };
  });
  if (new Set(constraints.map((c) => c.constraintId)).size !== constraints.length)
    fail("EVAL_DUPLICATE", path + ".constraints");
  return {
    constraints,
    toolSelection: list(r.toolSelection, path + ".toolSelection", 32, (v, p) => {
      const s = record(v, p, ["run", "turn", "accept"]);
      return {
        run: text(s.run, p + ".run", { pattern: evalRunKeyPattern }),
        turn: integer(s.turn, p + ".turn", 1, 100000),
        accept: list(
          s.accept,
          p + ".accept",
          8,
          (x, q) => (x === "none" ? "none" : text(x, q, { max: 64, pattern: toolNamePattern })),
          { min: 1, unique: true },
        ),
      };
    }),
    compactionsMin: integer(r.compactionsMin, path + ".compactionsMin", 0, 16),
    exactIds: boolean(r.exactIds, path + ".exactIds"),
  };
}
function expectation(value: unknown, path: string, fixtureIds: readonly string[]): EvalExpect {
  const r = record(value, path, [
    "admission",
    "endCode",
    "tools",
    "teammates",
    "refusals",
    "proposals",
    "cards",
    "taint",
    "events",
    "cost",
  ]);
  const tools = record(r.tools, path + ".tools", ["required", "forbidden"]);
  const proposals = record(r.proposals, path + ".proposals", [
    "count",
    "byAgent",
    "tainted",
    "changes",
  ]);
  const taint = record(r.taint, path + ".taint", ["root", "sources"]);
  const events = record(r.events, path + ".events", ["required", "forbidden"]);
  const cost = record(r.cost, path + ".cost", ["modelTurnsMax", "outputTokensMax"]);
  const refusalRow = (v: unknown, p: string): EvalRefusalExpectation => {
    const y = record(v, p, ["agent", "tool", "code"]);
    return {
      agent: oneOf(y.agent, p + ".agent", evalAgentRefs),
      tool: nullable(y.tool, p + ".tool", (t, q) => text(t, q, { max: 64, pattern: toolNamePattern })),
      code: oneOf(y.code, p + ".code", evalRefusalCodes),
    };
  };
  const refusals = record(r.refusals, path + ".refusals", ["required", "allowed"]);
  const eventCode = (v: unknown, p: string) => oneOf(v, p, evalEventCodes);
  const parsedEvents = {
    required: list(events.required, path + ".events.required", 32, eventCode),
    forbidden: list(events.forbidden, path + ".events.forbidden", 32, eventCode, { unique: true }),
  };
  if (parsedEvents.required.some((code) => parsedEvents.forbidden.includes(code)))
    fail("EVAL_EVENT_BOTH", path + ".events");
  return {
    admission: oneOf(r.admission, path + ".admission", ["admitted", ...evalRefusalCodes] as const),
    endCode: oneOf(r.endCode, path + ".endCode", evalEndCodes),
    tools: {
      required: list(tools.required, path + ".tools.required", 24, (v, p) => {
        const x = record(v, p, ["agent", "tool", "calls"]);
        return {
          ...toolExpectation({ agent: x.agent, tool: x.tool }, p),
          calls: range(x.calls, p + ".calls", 100000),
        };
      }),
      forbidden: list(tools.forbidden, path + ".tools.forbidden", 32, toolExpectation, {
        unique: true,
      }),
    },
    teammates: nullable(r.teammates, path + ".teammates", (v, p) => {
      const t = record(v, p, [
        "calls",
        "followUps",
        "maps",
        "reviews",
        "handoffs",
        "parallelTurnsMin",
        "called",
        "sameTeammateMin",
      ]);
      return {
        calls: range(t.calls, p + ".calls", 1000),
        followUps: range(t.followUps, p + ".followUps", 1000),
        maps: range(t.maps, p + ".maps", 100),
        reviews: range(t.reviews, p + ".reviews", 100),
        handoffs: range(t.handoffs, p + ".handoffs", 100),
        parallelTurnsMin: integer(t.parallelTurnsMin, p + ".parallelTurnsMin", 0, 1000),
        called: list(t.called, p + ".called", 4, (x, q) => oneOf(x, q, evalTeammateRefs), {
          unique: true,
        }),
        sameTeammateMin: nullable(t.sameTeammateMin, p + ".sameTeammateMin", (x, q) => {
          const s = record(x, q, ["agent", "calls"]);
          return {
            agent: oneOf(s.agent, q + ".agent", evalTeammateRefs),
            calls: integer(s.calls, q + ".calls", 2, 1000),
          };
        }),
      };
    }),
    refusals: {
      required: list(refusals.required, path + ".refusals.required", 32, refusalRow),
      allowed: list(refusals.allowed, path + ".refusals.allowed", 32, refusalRow, {
        unique: true,
      }),
    },
    proposals: {
      count: integer(proposals.count, path + ".proposals.count", 0, 500),
      byAgent: nullable(proposals.byAgent, path + ".proposals.byAgent", (v, p) =>
        oneOf(v, p, evalTeammateRefs),
      ),
      tainted: nullable(proposals.tainted, path + ".proposals.tainted", boolean),
      changes: list(proposals.changes, path + ".proposals.changes", 64, (v, p) => {
        const x = record(v, p, ["fixtureId", "set", "unset"]);
        const fixtureId = text(x.fixtureId, p + ".fixtureId", { pattern: fixtureIdPattern });
        if (!fixtureIds.includes(fixtureId)) fail("EVAL_FIXTURE_UNKNOWN", p + ".fixtureId");
        const fields = (y: unknown, q: string) =>
          list(y, q, 4, (z, s) => oneOf(z, s, listingFields), { unique: true });
        const set = fields(x.set, p + ".set");
        const unset = fields(x.unset, p + ".unset");
        if (set.some((field) => unset.includes(field))) fail("EVAL_FIELD_BOTH", p);
        return { fixtureId, set, unset };
      }),
    },
    cards: integer(r.cards, path + ".cards", 0, 10),
    taint: {
      root: boolean(taint.root, path + ".taint.root"),
      sources: list(
        taint.sources,
        path + ".taint.sources",
        evalTaintSources.length,
        (v, p) => oneOf(v, p, evalTaintSources),
        { unique: true },
      ),
    },
    events: parsedEvents,
    cost: {
      modelTurnsMax: integer(cost.modelTurnsMax, path + ".cost.modelTurnsMax", 1, 100000),
      outputTokensMax: integer(cost.outputTokensMax, path + ".cost.outputTokensMax", 1, 1e9),
    },
  };
}
export function parseEvalCase(value: unknown): EvalCase {
  const r = record(value, "case", [
    "schemaVersion",
    "caseId",
    "title",
    "category",
    "class",
    "rubricId",
    "requires",
    "gates",
    "entry",
    "agents",
    "request",
    "fixtures",
    "world",
    "probes",
    "expect",
  ]);
  evalVersion(r.schemaVersion, "case.schemaVersion", evalFormatVersions.case);
  const entryRecord = record(r.entry, "case.entry", ["agent", "purpose", "surface"]);
  const entry: EvalEntry = {
    agent: oneOf(entryRecord.agent, "case.entry.agent", evalAgentRefs),
    purpose: oneOf(entryRecord.purpose, "case.entry.purpose", ["conversation", "job"] as const),
    surface: oneOf(entryRecord.surface, "case.entry.surface", ["ask", "project"] as const),
  };
  // The main thread lives in the person's Ask only; a teammate asked directly runs a job.
  if (entry.purpose === "conversation" && (entry.agent !== "morrow" || entry.surface !== "ask"))
    fail("EVAL_ENTRY_PURPOSE", "case.entry");
  const agents = list(r.agents, "case.agents", evalAgentRefs.length, (v, p) =>
    oneOf(v, p, evalAgentRefs),
  { min: 1, unique: true });
  if (!agents.includes(entry.agent)) fail("EVAL_ENTRY_NOT_AGENT", "case.agents");
  const request = record(r.request, "case.request", ["marking", "text"]);
  const fixtures = list(r.fixtures, "case.fixtures", 64, fixture);
  const ids = fixtures.map((f) => f.fixtureId);
  if (new Set(ids).size !== ids.length) fail("EVAL_DUPLICATE", "case.fixtures");
  const recordIds = fixtures.map((f) => f.recordId);
  if (new Set(recordIds).size !== recordIds.length)
    fail("EVAL_DUPLICATE", "case.fixtures.recordId");
  for (const f of fixtures)
    if (f.memory?.agent && !agents.includes(f.memory.agent))
      fail("EVAL_WORLD_AGENT", "case.fixtures");
  const parsedWorld = world(r.world, "case.world");
  for (const teammate of [...parsedWorld.activeTeammates, ...parsedWorld.paused])
    if (!agents.includes(teammate)) fail("EVAL_WORLD_AGENT", "case.world");
  const category = oneOf(r.category, "case.category", evalCategories);
  const caseClass = oneOf(r.class, "case.class", evalCaseClasses);
  if (evalSafetyCategories.includes(category) && caseClass !== "safety")
    fail("EVAL_CLASS_SAFETY", "case.class");
  const parsed = {
    schemaVersion: 2 as const,
    caseId: text(r.caseId, "case.caseId", { max: 64, pattern: evalCaseIdPattern }),
    title: text(r.title, "case.title", { max: 200 }),
    category,
    class: caseClass,
    rubricId: text(r.rubricId, "case.rubricId", { pattern: evalRubricIdPattern }),
    requires: list(r.requires, "case.requires", evalHarnessRows.length, (v, p) =>
      oneOf(v, p, evalHarnessRows),
    { min: 1, unique: true }),
    gates: list(r.gates, "case.gates", evalGates.length, (v, p) => oneOf(v, p, evalGates), {
      min: 1,
      unique: true,
    }),
    entry,
    agents,
    request: {
      marking: oneOf(request.marking, "case.request.marking", ["synthetic"] as const),
      text: requestText(request.text, fixtures),
    },
    fixtures,
    world: parsedWorld,
    probes: probes(
      r.probes,
      "case.probes",
      ids,
      parsedWorld.posts.map((post) => post.postId),
    ),
    expect: expectation(r.expect, "case.expect", ids),
  };
  evalSyntheticIdsOnly(r, "case");
  return deepFreeze(parsed);
}

/**
 * The person's request may name a fixture's record as `{{fixture:<fixtureId>}}`; the replay
 * renders its synthetic id, a live round the Morrow id bound to its live slot. Only a fixture
 * with a live slot may be named, so a live round can always render the request.
 */
const placeholder = /\{\{fixture:([a-z][a-z0-9_]{0,31})\}\}/g;
function requestText(value: unknown, fixtures: readonly EvalFixture[]): string {
  const result = text(value, "case.request.text", { max: 4000 });
  for (const match of result.matchAll(placeholder))
    if (!fixtures.some((f) => f.fixtureId === match[1] && f.liveSlot !== null))
      fail("EVAL_REQUEST_PLACEHOLDER", "case.request.text");
  if (result.replace(placeholder, "").includes("{{"))
    fail("EVAL_REQUEST_PLACEHOLDER", "case.request.text");
  return result;
}
/** The request with each placeholder rendered: from `ids` (slot to Morrow id) or the fixture's. */
export function renderRequest(
  evalCase: EvalCase,
  ids: Readonly<Record<string, string>> | null = null,
): string {
  return evalCase.request.text.replace(placeholder, (_all, fixtureId: string) => {
    const fixture = evalCase.fixtures.find((f) => f.fixtureId === fixtureId)!;
    if (ids === null) return fixture.recordId;
    const bound = ids[fixture.liveSlot!];
    if (bound === undefined) throw new EvalFormatError("EVAL_SLOT_UNBOUND", fixture.liveSlot!);
    return bound;
  });
}

// --- EvalRubric@1 -------------------------------------------------------------------------
export interface EvalCriterion {
  readonly criterionId: string;
  readonly kind: EvalCriterionKind;
  readonly weight: number;
  readonly text: string;
  /** For `code` criteria: the hook and its parameters; null otherwise. */
  readonly hook: { readonly id: EvalRubricHook; readonly terms: readonly string[] } | null;
}
export interface EvalRubric {
  readonly schemaVersion: 1;
  readonly rubricId: string;
  readonly title: string;
  readonly criteria: readonly EvalCriterion[];
}
export function parseEvalRubric(value: unknown): EvalRubric {
  const r = record(value, "rubric", ["schemaVersion", "rubricId", "title", "criteria"]);
  evalVersion(r.schemaVersion, "rubric.schemaVersion", evalFormatVersions.rubric);
  const criteria = list(
    r.criteria,
    "rubric.criteria",
    16,
    (v, p) => {
      const c = record(v, p, ["criterionId", "kind", "weight", "text", "hook"]);
      const kind = oneOf(c.kind, p + ".kind", evalCriterionKinds);
      const hook = nullable(c.hook, p + ".hook", (h, q) => {
        const x = record(h, q, ["id", "terms"]);
        const id = oneOf(x.id, q + ".id", evalRubricHooks);
        const terms = list(x.terms, q + ".terms", 8, (t, s) => text(t, s, { min: 2, max: 40 }), {
          unique: true,
        });
        if ((id === "reply_mentions_any") !== terms.length > 0) fail("EVAL_HOOK_TERMS", q);
        return { id, terms };
      });
      if ((kind === "code") !== (hook !== null)) fail("EVAL_HOOK_KIND", p);
      return {
        criterionId: text(c.criterionId, p + ".criterionId", { pattern: criterionIdPattern }),
        kind,
        weight: integer(c.weight, p + ".weight", 1, 5),
        text: text(c.text, p + ".text", { max: 400 }),
        hook,
      };
    },
    { min: 1 },
  );
  if (new Set(criteria.map((c) => c.criterionId)).size !== criteria.length)
    fail("EVAL_DUPLICATE", "rubric.criteria");
  const parsed = {
    schemaVersion: 1 as const,
    rubricId: text(r.rubricId, "rubric.rubricId", { pattern: evalRubricIdPattern }),
    title: text(r.title, "rubric.title", { max: 160 }),
    criteria,
  };
  evalSyntheticIdsOnly(r, "rubric");
  return deepFreeze(parsed);
}

// --- EvalRecording@2 ----------------------------------------------------------------------
export interface EvalRecordedCall {
  readonly id: string;
  readonly tool: string;
  readonly input: unknown;
  /** What the call met when it was recorded; the replay refuses a recording that disagrees. */
  readonly expect: {
    readonly outcome: EvalCallOutcome;
    readonly refusal: EvalRefusalCode | null;
    /** The child runs the call started or reopened (agent.ask, agent.map, agent.route, a fork). */
    readonly children: readonly string[];
  };
}
/**
 * One recorded model call. `turn` is an ordinary turn; `checkpoint` the fallback strategy's
 * checkpoint fork (one turn that calls `context.checkpoint`); `compaction` the provider
 * strategy's compaction block (its readable summary as `text`). `cut`: the reply was cut at
 * `max_tokens`: booked, never used, and resent (ADR-0041 item 8).
 */
export interface EvalRecordedTurn {
  readonly kind: "turn" | "checkpoint" | "compaction";
  readonly text: string | null;
  readonly calls: readonly EvalRecordedCall[];
  readonly cut: boolean;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}
export interface EvalRecordedRun {
  readonly runKey: string;
  readonly agent: EvalAgentRef;
  readonly turns: readonly EvalRecordedTurn[];
}
export interface EvalRecording {
  readonly schemaVersion: 2;
  readonly caseId: string;
  readonly arm: EvalArm;
  /** `authored`: written by hand against the synthetic fixtures (no model was called). */
  readonly origin: "authored";
  readonly basisDigest: string;
  readonly runs: readonly EvalRecordedRun[];
}
/** Format bounds on a file, never run limits (a longer run is recorded in more files). */
export const evalRecordingBounds = Object.freeze({
  runs: 1024,
  turnsPerRun: 5000,
  callsPerTurn: 64,
  inputTokens: 1_000_000,
  outputTokens: 128_000,
});
export function parseEvalRecording(value: unknown): EvalRecording {
  const r = record(value, "recording", [
    "schemaVersion",
    "caseId",
    "arm",
    "origin",
    "basisDigest",
    "runs",
  ]);
  evalVersion(r.schemaVersion, "recording.schemaVersion", evalFormatVersions.recording);
  const b = evalRecordingBounds;
  const runs = list(
    r.runs,
    "recording.runs",
    b.runs,
    (v, p) => {
      const run = record(v, p, ["runKey", "agent", "turns"]);
      return {
        runKey: text(run.runKey, p + ".runKey", { pattern: evalRunKeyPattern }),
        agent: oneOf(run.agent, p + ".agent", evalAgentRefs),
        turns: list(run.turns, p + ".turns", b.turnsPerRun, (t, q) => {
          const turn = record(t, q, ["kind", "text", "calls", "cut", "usage"]);
          const usage = record(turn.usage, q + ".usage", ["inputTokens", "outputTokens"]);
          const kind = oneOf(turn.kind, q + ".kind", ["turn", "checkpoint", "compaction"] as const);
          const calls = list(turn.calls, q + ".calls", b.callsPerTurn, (c, s) => {
            const call = record(c, s, ["id", "tool", "input", "expect"]);
            const expect = record(call.expect, s + ".expect", ["outcome", "refusal", "children"]);
            const outcome = oneOf(expect.outcome, s + ".expect.outcome", evalCallOutcomes);
            const refusal = nullable(expect.refusal, s + ".expect.refusal", (x, y) =>
              oneOf(x, y, evalRefusalCodes),
            );
            const consistent =
              outcome === "ok" || outcome === "not_run"
                ? refusal === null
                : outcome === "invalid_input"
                  ? refusal === "input_invalid"
                  : refusal !== null && refusal !== "input_invalid";
            if (!consistent) fail("EVAL_EXPECT_REFUSAL", s + ".expect");
            return {
              id: text(call.id, s + ".id", { pattern: toolUseIdPattern }),
              // The tool name is checked against the run's offered tools at replay: an
              // unoffered name is the model's mistake, which a recording may hold.
              tool: text(call.tool, s + ".tool", { max: 64 }),
              input: call.input,
              expect: {
                outcome,
                refusal,
                children: list(
                  expect.children,
                  s + ".expect.children",
                  512,
                  (x, y) => text(x, y, { pattern: evalRunKeyPattern }),
                  { unique: true },
                ),
              },
            };
          });
          const textValue = nullable(turn.text, q + ".text", (x, y) => text(x, y, { max: 200000 }));
          const cut = boolean(turn.cut, q + ".cut");
          if (textValue === null && calls.length === 0 && !cut) fail("EVAL_EMPTY_TURN", q);
          // A checkpoint fork makes exactly one context.checkpoint call; a provider compaction
          // is its summary text alone.
          if (
            (kind === "checkpoint" &&
              (calls.length !== 1 || calls[0]!.tool !== "context.checkpoint" || cut)) ||
            (kind === "compaction" && (calls.length !== 0 || textValue === null || cut))
          )
            fail("EVAL_COMPACTION_TURN", q);
          return {
            kind,
            text: textValue,
            calls,
            cut,
            usage: {
              inputTokens: integer(usage.inputTokens, q + ".usage.inputTokens", 0, b.inputTokens),
              outputTokens: integer(
                usage.outputTokens,
                q + ".usage.outputTokens",
                0,
                b.outputTokens,
              ),
            },
          };
        }),
      };
    },
    { min: 1 },
  );
  if (runs[0]?.runKey !== "root") fail("EVAL_ROOT_FIRST", "recording.runs[0].runKey");
  if (new Set(runs.map((run) => run.runKey)).size !== runs.length)
    fail("EVAL_DUPLICATE", "recording.runs");
  const toolUseIds = runs.flatMap((run) => run.turns.flatMap((t) => t.calls.map((c) => c.id)));
  if (new Set(toolUseIds).size !== toolUseIds.length) fail("EVAL_DUPLICATE", "recording.calls.id");
  // Each child run is started by one call only (a follow-up reopens it), and names a recorded
  // run other than the root: the replay never replays one run for two starts.
  const started: string[] = [];
  for (const run of runs)
    for (const turn of run.turns)
      for (const call of turn.calls) {
        const followUp =
          isRecord(call.input) && typeof call.input.followUpOf === "string" && call.input.followUpOf;
        if (!followUp) started.push(...call.expect.children);
      }
  if (new Set(started).size !== started.length)
    fail("EVAL_CHILD_REUSED", "recording.calls.expect.children");
  const named = new Set(runs.slice(1).map((run) => run.runKey));
  const all = runs.flatMap((run) =>
    run.turns.flatMap((t) => t.calls.flatMap((c) => c.expect.children)),
  );
  if (all.some((child) => !named.has(child)))
    fail("EVAL_CHILD_UNKNOWN", "recording.calls.expect.children");
  const parsed = {
    schemaVersion: 2 as const,
    caseId: text(r.caseId, "recording.caseId", { max: 64, pattern: evalCaseIdPattern }),
    arm: oneOf(r.arm, "recording.arm", evalArms),
    origin: oneOf(r.origin, "recording.origin", ["authored"] as const),
    basisDigest: text(r.basisDigest, "recording.basisDigest", { pattern: digestPattern }),
    runs,
  };
  // The basis digest is hex (checked above), so it is left out of the store-id scan.
  evalSyntheticIdsOnly(r, "recording", ["basisDigest"]);
  return deepFreeze(parsed);
}

/** The recording file name of a case and arm: `<caseId>--<arm with @ as ->.json`. */
export function recordingFileName(caseId: string, arm: EvalArm): string {
  return caseId + "--" + arm.replace("@", "-") + ".json";
}
