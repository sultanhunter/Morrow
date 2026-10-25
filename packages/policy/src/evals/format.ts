// The agent eval formats (ADR-0037 item 10; its implementation plan's PR 9). Pure: no I/O,
// clock or randomness. Every file of the golden set is closed JSON, versioned and parsed here
// before anything reads it:
//   EvalSet@1        the golden set: its id, the designs it compares and its case ids;
//   EvalCase@1       one task: its id, the agents, the person's request and the input
//                    fixtures (synthetic data, marked), the world it runs in, the code checks it
//                    expects and the rubric id;
//   EvalRubric@1     one rubric: criteria graded by code hooks, by a model or by the owner;
//   EvalRecording@1  the model outputs one design produced for one case, run by run and turn
//                    by turn, with the outcome each tool call met when it was recorded, bound to
//                    the digest of the case's inputs (a changed fixture makes it stale).
// The repository holds case ids, synthetic fixtures, rubrics and recordings only: no store
// data, customer data, secret or tenant id (tests/agent-evals.test.mjs scans every file). Every
// parser refuses a store-shaped id anywhere in its file (`evalTextHasStoreId`). A live round
// binds each case's live slots to Morrow ids from a file outside the repository.
//
// The ADR-0037 tools (`agent.ask`, `agent.result.read`, `agent.propose`), the structured
// `agent.route` brief, TeammateResult and the codes `insufficient_credits`,
// `credits_exhausted`, `children_limit` and `customer_tagged` are not in the contracts yet
// (ADR-0037 plan PR 2, ADR-0039 plan PR 2). Their shapes here are the working names and
// provisional eval-local shapes, to be replaced by the contracts when those PRs land.

/** The current version of every eval format. */
export const evalFormatVersion = 1;
/** The eval world's version: a change to the fakes' behaviour bumps it and re-pins recordings. */
export const evalWorldVersion = 1;

export const evalAgentRefs = Object.freeze([
  "morrow",
  "listings",
  "business_analyst",
  "inventory",
  "support",
] as const);
export type EvalAgentRef = (typeof evalAgentRefs)[number];
export type EvalTeammateRef = Exclude<EvalAgentRef, "morrow">;

/**
 * The designs a round compares (ADR-0037 item 10: designs are compared task by task).
 * teammates@1 is ADR-0037: Morrow calls teammates (`agent.ask`, any number, in sequence or in
 * parallel) and hands off (`agent.route`). handoff_only@1 is the design before it: Morrow
 * passes work on only by a one-way `agent.route`, once per run (catalogue version 2).
 */
export const evalDesigns = Object.freeze(["teammates@1", "handoff_only@1"] as const);
export type EvalDesign = (typeof evalDesigns)[number];

export const evalCategories = Object.freeze([
  "listings_drafting",
  "routing",
  "orchestration",
  "refusal_permission",
  "refusal_stop",
  "refusal_credits",
  "taint",
] as const);
export type EvalCategory = (typeof evalCategories)[number];

/** Catalogue version 2's tool names the eval world serves, and ADR-0037's working names. */
export const evalCatalogueTools = Object.freeze([
  "knowledge.search",
  "work.read",
  "products.read",
  "inventory.read",
  "orders.summary",
  "support.thread.read",
  "message.post",
  "task.create",
  "suggestion.create",
  "report.write",
  "agent.route",
  "proposal.listing",
  "proposal.reply",
] as const);
export const evalProvisionalTools = Object.freeze([
  "agent.ask",
  "agent.result.read",
  "agent.propose",
] as const);
export const evalToolNames = Object.freeze([...evalCatalogueTools, ...evalProvisionalTools]);
export type EvalToolName = (typeof evalToolNames)[number];

/** How a run ended, as code derives it. `not_admitted`: admission refused the run. */
export const evalEndCodes = Object.freeze([
  "completed",
  "turn_limit",
  "cost_budget",
  "invalid_output",
  "stopped",
  "credits_exhausted",
  "not_admitted",
] as const);
export type EvalEndCode = (typeof evalEndCodes)[number];

/**
 * Why code refused a tool call or a run's admission. Catalogue codes as in ToolRefusalCode;
 * `insufficient_credits` (ADR-0039 item 9), `children_limit` (the kernel's 32 children per
 * envelope, ADR-0037 item 3) and `customer_tagged` (a teammate's result with a customer read
 * tag never enters Morrow's context, ADR-0037 item 3(a)) are provisional.
 */
export const evalRefusalCodes = Object.freeze([
  "input_invalid",
  "stopped",
  "id_out_of_scope",
  "authority_denied",
  "tool_call_limit",
  "route_used",
  "insufficient_credits",
  "children_limit",
  "customer_tagged",
] as const);
export type EvalRefusalCode = (typeof evalRefusalCodes)[number];

/** A tool call's outcome as the model sees it (ToolCallOutcome's values the world produces). */
export const evalCallOutcomes = Object.freeze(["ok", "refused", "invalid_input"] as const);
export type EvalCallOutcome = (typeof evalCallOutcomes)[number];

export const evalFixtureKinds = Object.freeze([
  "product",
  "order_summary",
  "inventory",
  "knowledge_page",
  "support_thread",
] as const);
export type EvalFixtureKind = (typeof evalFixtureKinds)[number];

/** Taint sources (ModelUntrustedSource's values the eval world produces). */
export const evalTaintSources = Object.freeze([
  "product",
  "inventory",
  "order_summary",
  "support_mail",
  "knowledge_page",
  "tool_result",
] as const);
export type EvalTaintSource = (typeof evalTaintSources)[number];

/** TeammateResult's closed next-step codes (provisional; ADR-0034 item 9's typed codes). */
export const evalNextSteps = Object.freeze([
  "review_proposals",
  "needs_owner",
  "needs_more_input",
  "add_credits",
  "none",
] as const);
export type EvalNextStep = (typeof evalNextSteps)[number];

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
] as const);
export type EvalRubricHook = (typeof evalRubricHooks)[number];

const listingFields = Object.freeze(["title", "descriptionHtml", "seo", "tags"] as const);
export type EvalListingField = (typeof listingFields)[number];
export const evalListingFields: readonly EvalListingField[] = listingFields;

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
function record(
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
function text(
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
function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    return fail("EVAL_INTEGER", path);
  return value;
}
function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fail("EVAL_NUMBER", path);
  return value;
}
function oneOf<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value))
    return fail("EVAL_ENUM", path);
  return value as T;
}
function list<T>(
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
const nullable = <T>(
  value: unknown,
  path: string,
  read: (value: unknown, path: string) => T,
): T | null => (value === null ? null : read(value, path));
function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return fail("EVAL_NOT_BOOLEAN", path);
  return value;
}
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

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
  /^(?:product:999999[0-9]{3}|(?:thread|page|orders|stock)_fake_[0-9]{1,4})$/;
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
 * Every format refuses a store-shaped id anywhere in a file, not only in a fixture's record
 * ids: in any text, tool input (keys included), brief, finding or reply, a string or a number.
 * A recording captured from real model output can then never carry a real store's id into the
 * repository. It runs after a file's own checks, so their more precise codes come first, and
 * its error names the path only, never the id.
 */
function syntheticIdsOnly(value: unknown, path: string, depth = 0): void {
  if (depth > 64) fail("EVAL_TOO_DEEP", path);
  if (typeof value === "string" || typeof value === "number") {
    if (evalTextHasStoreId(String(value))) fail("EVAL_STORE_ID", path);
  } else if (Array.isArray(value))
    value.forEach((entry, index) => syntheticIdsOnly(entry, path + "[" + index + "]", depth + 1));
  else if (value !== null && typeof value === "object")
    for (const [key, entry] of Object.entries(value)) {
      if (evalTextHasStoreId(key)) fail("EVAL_STORE_ID", path);
      syntheticIdsOnly(entry, path + "." + key, depth + 1);
    }
}
const fixtureIdPattern = /^[a-z][a-z0-9_]{0,31}$/;
const slotPattern = /^[a-z][a-z0-9_]{0,31}$/;
const runKeyPattern = /^(?:root|[a-z][a-z0-9_]{0,23}-[1-9][0-9]?)$/;
const toolUseIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const criterionIdPattern = /^[a-z][a-z0-9_]{0,47}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const capabilityIdPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,4}$/;

// --- EvalSet@1 ----------------------------------------------------------------------------
export interface EvalSet {
  readonly schemaVersion: 1;
  readonly setId: string;
  readonly title: string;
  readonly primaryDesign: EvalDesign;
  readonly designs: readonly EvalDesign[];
  readonly liveRepetitionsMin: number;
  readonly cases: readonly string[];
}
export function parseEvalSet(value: unknown): EvalSet {
  const r = record(value, "set", [
    "schemaVersion",
    "setId",
    "title",
    "primaryDesign",
    "designs",
    "liveRepetitionsMin",
    "cases",
  ]);
  if (r.schemaVersion !== evalFormatVersion) fail("EVAL_VERSION", "set.schemaVersion");
  const designs = list(r.designs, "set.designs", evalDesigns.length, (v, p) =>
    oneOf(v, p, evalDesigns),
  );
  const primaryDesign = oneOf(r.primaryDesign, "set.primaryDesign", evalDesigns);
  if (!designs.includes(primaryDesign)) fail("EVAL_PRIMARY_DESIGN", "set.primaryDesign");
  if (new Set(designs).size !== designs.length) fail("EVAL_DUPLICATE", "set.designs");
  const parsed = {
    schemaVersion: 1 as const,
    setId: text(r.setId, "set.setId", { pattern: evalSetIdPattern }),
    title: text(r.title, "set.title", { max: 160 }),
    primaryDesign,
    designs,
    // ADR-0037 item 10: each task is run at least twice in a live round.
    liveRepetitionsMin: integer(r.liveRepetitionsMin, "set.liveRepetitionsMin", 2, 10),
    // ADR-0037 item 10: a golden set of 10 to 16 tasks.
    cases: list(
      r.cases,
      "set.cases",
      16,
      (v, p) => text(v, p, { max: 64, pattern: evalCaseIdPattern }),
      { min: 10, unique: true },
    ),
  };
  syntheticIdsOnly(r, "set");
  return deepFreeze(parsed);
}

// --- EvalCase@1 ---------------------------------------------------------------------------
export interface EvalProductData {
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}
export interface EvalOrderSummaryData {
  readonly metric: "order_count" | "gross_sales" | "units_sold";
  readonly period: "last_7_days" | "last_30_days";
  readonly rows: readonly { readonly recordId: string; readonly value: number }[];
}
export interface EvalInventoryData {
  readonly rows: readonly { readonly recordId: string; readonly available: number }[];
}
export interface EvalTextData {
  readonly title: string;
  readonly body: string;
}
export type EvalFixture = {
  readonly fixtureId: string;
  readonly marking: "synthetic";
  readonly recordId: string;
  readonly liveSlot: string | null;
  /** Text inside the fixture that tries to steer an agent (taint cases), or null. */
  readonly injection: { readonly phrase: string } | null;
} & (
  | { readonly kind: "product"; readonly data: EvalProductData }
  | { readonly kind: "order_summary"; readonly data: EvalOrderSummaryData }
  | { readonly kind: "inventory"; readonly data: EvalInventoryData }
  | { readonly kind: "knowledge_page"; readonly data: EvalTextData }
  | { readonly kind: "support_thread"; readonly data: EvalTextData }
);
export interface EvalForeignItem {
  readonly itemId: string;
  readonly owner: "other_run" | "other_person_ask";
}
export interface EvalWorld {
  readonly requester: "owner" | "member";
  /** Capability ids the requester does not hold with `delegate` (a member's narrower grants). */
  readonly requesterLacks: readonly string[];
  /** Teammates whose installation a person paused (`agents.installation.disable`). */
  readonly paused: readonly EvalTeammateRef[];
  /** Teammates in Morrow's code-built list of active teammates. */
  readonly activeTeammates: readonly EvalTeammateRef[];
  /** A person's stop of the root run, taking effect before that turn. */
  readonly stopBeforeTurn: number | null;
  readonly creditBalance: number;
  /** Result items that exist in the workspace but belong to another run or a private Ask. */
  readonly foreignItems: readonly EvalForeignItem[];
}
export interface EvalCountRange {
  readonly min: number;
  readonly max: number;
}
export interface EvalToolExpectation {
  readonly agent: EvalAgentRef | "any";
  readonly tool: EvalToolName;
}
export interface EvalRequiredTool extends EvalToolExpectation {
  readonly calls: EvalCountRange;
}
export interface EvalRefusalExpectation {
  readonly agent: EvalAgentRef;
  readonly tool: EvalToolName | null;
  readonly code: EvalRefusalCode;
}
export interface EvalProposalChange {
  readonly fixtureId: string;
  readonly set: readonly EvalListingField[];
  readonly unset: readonly EvalListingField[];
}
export interface EvalExpect {
  readonly admission: "admitted" | EvalRefusalCode;
  readonly endCode: EvalEndCode;
  readonly tools: {
    readonly required: readonly EvalRequiredTool[];
    readonly forbidden: readonly EvalToolExpectation[];
  };
  readonly teammates: {
    readonly calls: EvalCountRange;
    readonly handoffs: EvalCountRange;
    readonly parallelTurnsMin: number;
    readonly called: readonly EvalTeammateRef[];
    readonly sameTeammateMin: { readonly agent: EvalTeammateRef; readonly calls: number } | null;
  } | null;
  /**
   * Refusals: each `required` one must be met (a multiset); any refusal met that is neither
   * required nor `allowed` fails. `allowed` covers a refusal a better model may not provoke
   * (it never tried), whose outcome the recording still pins.
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
  readonly cost: { readonly modelTurnsMax: number; readonly outputTokensMax: number };
}
export interface EvalCase {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly title: string;
  readonly category: EvalCategory;
  readonly rubricId: string;
  /** The agent the person addresses: Morrow (a coordinator run) or a teammate (a routed run). */
  readonly entry: EvalAgentRef;
  readonly agents: readonly EvalAgentRef[];
  readonly request: { readonly marking: "synthetic"; readonly text: string };
  readonly fixtures: readonly EvalFixture[];
  readonly world: EvalWorld;
  readonly expect: EvalExpect;
}

const teammateRefs = evalAgentRefs.filter((a): a is EvalTeammateRef => a !== "morrow");
function range(value: unknown, path: string, max: number): EvalCountRange {
  const r = record(value, path, ["min", "max"]);
  const min = integer(r.min, path + ".min", 0, max);
  const top = integer(r.max, path + ".max", 0, max);
  if (min > top) fail("EVAL_RANGE", path);
  return { min, max: top };
}
function fixture(value: unknown, path: string): EvalFixture {
  const r = record(value, path, [
    "fixtureId",
    "kind",
    "marking",
    "recordId",
    "liveSlot",
    "injection",
    "data",
  ]);
  const kind = oneOf(r.kind, path + ".kind", evalFixtureKinds);
  const recordId = text(r.recordId, path + ".recordId", { pattern: evalRecordIdPattern });
  const prefix = {
    product: "product:",
    order_summary: "orders_",
    inventory: "stock_",
    knowledge_page: "page_",
    support_thread: "thread_",
  }[kind];
  if (!recordId.startsWith(prefix)) fail("EVAL_RECORD_KIND", path + ".recordId");
  const base = {
    fixtureId: text(r.fixtureId, path + ".fixtureId", { pattern: fixtureIdPattern }),
    marking: oneOf(r.marking, path + ".marking", ["synthetic"] as const),
    recordId,
    liveSlot: nullable(r.liveSlot, path + ".liveSlot", (v, p) =>
      text(v, p, { pattern: slotPattern }),
    ),
    injection: nullable(r.injection, path + ".injection", (v, p) => {
      const i = record(v, p, ["phrase"]);
      return { phrase: text(i.phrase, p + ".phrase", { min: 8, max: 200 }) };
    }),
  };
  const d = path + ".data";
  const rowId = (v: unknown, p: string) => text(v, p, { pattern: evalProductIdPattern });
  switch (kind) {
    case "product": {
      const x = record(r.data, d, ["title", "body", "tags"]);
      return {
        ...base,
        kind,
        data: {
          title: text(x.title, d + ".title", { max: 255 }),
          body: text(x.body, d + ".body", { min: 0, max: 4000 }),
          tags: list(x.tags, d + ".tags", 16, (v, p) => text(v, p, { max: 40 }), { unique: true }),
        },
      };
    }
    case "order_summary": {
      const x = record(r.data, d, ["metric", "period", "rows"]);
      return {
        ...base,
        kind,
        data: {
          metric: oneOf(x.metric, d + ".metric", [
            "order_count",
            "gross_sales",
            "units_sold",
          ] as const),
          period: oneOf(x.period, d + ".period", ["last_7_days", "last_30_days"] as const),
          rows: list(x.rows, d + ".rows", 32, (v, p) => {
            const row = record(v, p, ["recordId", "value"]);
            return { recordId: rowId(row.recordId, p + ".recordId"), value: finite(row.value, p) };
          }),
        },
      };
    }
    case "inventory": {
      const x = record(r.data, d, ["rows"]);
      return {
        ...base,
        kind,
        data: {
          rows: list(x.rows, d + ".rows", 32, (v, p) => {
            const row = record(v, p, ["recordId", "available"]);
            return {
              recordId: rowId(row.recordId, p + ".recordId"),
              available: integer(row.available, p + ".available", -100000, 100000),
            };
          }),
        },
      };
    }
    case "knowledge_page":
    case "support_thread": {
      const x = record(r.data, d, ["title", "body"]);
      return {
        ...base,
        kind,
        data: {
          title: text(x.title, d + ".title", { max: 200 }),
          body: text(x.body, d + ".body", { max: 4000 }),
        },
      };
    }
  }
}
function world(value: unknown, path: string): EvalWorld {
  const r = record(value, path, [
    "requester",
    "requesterLacks",
    "paused",
    "activeTeammates",
    "stopBeforeTurn",
    "creditBalance",
    "foreignItems",
  ]);
  return {
    requester: oneOf(r.requester, path + ".requester", ["owner", "member"] as const),
    requesterLacks: list(
      r.requesterLacks,
      path + ".requesterLacks",
      16,
      (v, p) => text(v, p, { pattern: capabilityIdPattern }),
      { unique: true },
    ),
    paused: list(r.paused, path + ".paused", 4, (v, p) => oneOf(v, p, teammateRefs), {
      unique: true,
    }),
    activeTeammates: list(
      r.activeTeammates,
      path + ".activeTeammates",
      4,
      (v, p) => oneOf(v, p, teammateRefs),
      { unique: true },
    ),
    stopBeforeTurn: nullable(r.stopBeforeTurn, path + ".stopBeforeTurn", (v, p) =>
      integer(v, p, 2, 16),
    ),
    creditBalance: integer(r.creditBalance, path + ".creditBalance", 0, 100000),
    foreignItems: list(r.foreignItems, path + ".foreignItems", 8, (v, p) => {
      const item = record(v, p, ["itemId", "owner"]);
      return {
        itemId: text(item.itemId, p + ".itemId", { pattern: /^item_foreign_[0-9]{1,3}$/ }),
        owner: oneOf(item.owner, p + ".owner", ["other_run", "other_person_ask"] as const),
      };
    }),
  };
}
const toolExpectation = (value: unknown, path: string): EvalToolExpectation => {
  const r = record(value, path, ["agent", "tool"]);
  return {
    agent: oneOf(r.agent, path + ".agent", [...evalAgentRefs, "any"] as const),
    tool: oneOf(r.tool, path + ".tool", evalToolNames),
  };
};
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
  const cost = record(r.cost, path + ".cost", ["modelTurnsMax", "outputTokensMax"]);
  return {
    admission: oneOf(r.admission, path + ".admission", ["admitted", ...evalRefusalCodes] as const),
    endCode: oneOf(r.endCode, path + ".endCode", evalEndCodes),
    tools: {
      required: list(tools.required, path + ".tools.required", 16, (v, p) => {
        const x = record(v, p, ["agent", "tool", "calls"]);
        return {
          ...toolExpectation({ agent: x.agent, tool: x.tool }, p),
          calls: range(x.calls, p + ".calls", 40),
        };
      }),
      forbidden: list(tools.forbidden, path + ".tools.forbidden", 24, toolExpectation, {
        unique: true,
      }),
    },
    teammates: nullable(r.teammates, path + ".teammates", (v, p) => {
      const t = record(v, p, [
        "calls",
        "handoffs",
        "parallelTurnsMin",
        "called",
        "sameTeammateMin",
      ]);
      return {
        calls: range(t.calls, p + ".calls", 32),
        handoffs: range(t.handoffs, p + ".handoffs", 32),
        parallelTurnsMin: integer(t.parallelTurnsMin, p + ".parallelTurnsMin", 0, 6),
        called: list(t.called, p + ".called", 4, (x, q) => oneOf(x, q, teammateRefs), {
          unique: true,
        }),
        sameTeammateMin: nullable(t.sameTeammateMin, p + ".sameTeammateMin", (x, q) => {
          const s = record(x, q, ["agent", "calls"]);
          return {
            agent: oneOf(s.agent, q + ".agent", teammateRefs),
            calls: integer(s.calls, q + ".calls", 2, 32),
          };
        }),
      };
    }),
    refusals: (() => {
      const x = record(r.refusals, path + ".refusals", ["required", "allowed"]);
      const row = (v: unknown, p: string): EvalRefusalExpectation => {
        const y = record(v, p, ["agent", "tool", "code"]);
        return {
          agent: oneOf(y.agent, p + ".agent", evalAgentRefs),
          tool: nullable(y.tool, p + ".tool", (t, q) => oneOf(t, q, evalToolNames)),
          code: oneOf(y.code, p + ".code", evalRefusalCodes),
        };
      };
      return {
        required: list(x.required, path + ".refusals.required", 16, row),
        allowed: list(x.allowed, path + ".refusals.allowed", 16, row, { unique: true }),
      };
    })(),
    proposals: {
      count: integer(proposals.count, path + ".proposals.count", 0, 25),
      byAgent: nullable(proposals.byAgent, path + ".proposals.byAgent", (v, p) =>
        oneOf(v, p, teammateRefs),
      ),
      tainted: nullable(proposals.tainted, path + ".proposals.tainted", boolean),
      changes: list(proposals.changes, path + ".proposals.changes", 25, (v, p) => {
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
        6,
        (v, p) => oneOf(v, p, evalTaintSources),
        {
          unique: true,
        },
      ),
    },
    cost: {
      modelTurnsMax: integer(cost.modelTurnsMax, path + ".cost.modelTurnsMax", 1, 200),
      outputTokensMax: integer(cost.outputTokensMax, path + ".cost.outputTokensMax", 1, 2000000),
    },
  };
}
export function parseEvalCase(value: unknown): EvalCase {
  const r = record(value, "case", [
    "schemaVersion",
    "caseId",
    "title",
    "category",
    "rubricId",
    "entry",
    "agents",
    "request",
    "fixtures",
    "world",
    "expect",
  ]);
  if (r.schemaVersion !== evalFormatVersion) fail("EVAL_VERSION", "case.schemaVersion");
  const entry = oneOf(r.entry, "case.entry", evalAgentRefs);
  const agents = list(
    r.agents,
    "case.agents",
    evalAgentRefs.length,
    (v, p) => oneOf(v, p, evalAgentRefs),
    {
      min: 1,
      unique: true,
    },
  );
  if (!agents.includes(entry)) fail("EVAL_ENTRY_NOT_AGENT", "case.agents");
  const request = record(r.request, "case.request", ["marking", "text"]);
  const fixtures = list(r.fixtures, "case.fixtures", 16, fixture);
  const ids = fixtures.map((f) => f.fixtureId);
  if (new Set(ids).size !== ids.length) fail("EVAL_DUPLICATE", "case.fixtures");
  const recordIds = fixtures.map((f) => f.recordId);
  if (new Set(recordIds).size !== recordIds.length)
    fail("EVAL_DUPLICATE", "case.fixtures.recordId");
  const parsedWorld = world(r.world, "case.world");
  for (const teammate of [...parsedWorld.activeTeammates, ...parsedWorld.paused])
    if (!agents.includes(teammate)) fail("EVAL_WORLD_AGENT", "case.world");
  const parsed = {
    schemaVersion: 1 as const,
    caseId: text(r.caseId, "case.caseId", { max: 64, pattern: evalCaseIdPattern }),
    title: text(r.title, "case.title", { max: 160 }),
    category: oneOf(r.category, "case.category", evalCategories),
    rubricId: text(r.rubricId, "case.rubricId", { pattern: evalRubricIdPattern }),
    entry,
    agents,
    request: {
      marking: oneOf(request.marking, "case.request.marking", ["synthetic"] as const),
      text: requestText(request.text, fixtures),
    },
    fixtures,
    world: parsedWorld,
    expect: expectation(r.expect, "case.expect", ids),
  };
  syntheticIdsOnly(r, "case");
  return deepFreeze(parsed);
}

/**
 * The person's request may name a fixture's record as `{{fixture:<fixtureId>}}`; the replay
 * renders its synthetic id, a live round the Morrow id bound to its live slot. Only a fixture
 * with a live slot may be named, so a live round can always render the request.
 */
const placeholder = /\{\{fixture:([a-z][a-z0-9_]{0,31})\}\}/g;
function requestText(value: unknown, fixtures: readonly EvalFixture[]): string {
  const result = text(value, "case.request.text", { max: 2000 });
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
  if (r.schemaVersion !== evalFormatVersion) fail("EVAL_VERSION", "rubric.schemaVersion");
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
  syntheticIdsOnly(r, "rubric");
  return deepFreeze(parsed);
}

// --- EvalRecording@1 ----------------------------------------------------------------------
export interface EvalRecordedCall {
  readonly id: string;
  readonly tool: string;
  readonly input: unknown;
  /** What the call met when it was recorded; the replay refuses a recording that disagrees. */
  readonly expect: {
    readonly outcome: EvalCallOutcome;
    readonly refusal: EvalRefusalCode | null;
    readonly child: string | null;
  };
}
/** The model's part of a teammate's result (provisional TeammateResult; code adds the rest). */
export interface EvalResultDraft {
  readonly outcome: "done" | "partial" | "blocked";
  readonly nextSteps: readonly EvalNextStep[];
  readonly summary: string;
  readonly findings: readonly {
    readonly kind: "fact" | "risk" | "suggestion";
    readonly text: string;
    readonly recordIds: readonly string[];
  }[];
  readonly items: readonly {
    readonly title: string;
    readonly kind: "table" | "text";
    readonly pages: number;
  }[];
}
export interface EvalRecordedTurn {
  readonly text: string | null;
  readonly calls: readonly EvalRecordedCall[];
  readonly result: EvalResultDraft | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}
export interface EvalRecordedRun {
  readonly runKey: string;
  readonly agent: EvalAgentRef;
  readonly turns: readonly EvalRecordedTurn[];
}
export interface EvalRecording {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly design: EvalDesign;
  /** `authored`: written by hand against the synthetic fixtures (no model was called). */
  readonly origin: "authored";
  readonly basisDigest: string;
  readonly runs: readonly EvalRecordedRun[];
}
export function parseResultDraft(value: unknown, path: string): EvalResultDraft {
  const r = record(value, path, ["outcome", "nextSteps", "summary", "findings", "items"]);
  return {
    outcome: oneOf(r.outcome, path + ".outcome", ["done", "partial", "blocked"] as const),
    nextSteps: list(r.nextSteps, path + ".nextSteps", 5, (v, p) => oneOf(v, p, evalNextSteps), {
      min: 1,
      unique: true,
    }),
    // ADR-0037 item 3(a): structured, with no character cap; a larger output is an item.
    summary: text(r.summary, path + ".summary"),
    findings: list(r.findings, path + ".findings", 64, (v, p) => {
      const f = record(v, p, ["kind", "text", "recordIds"]);
      return {
        kind: oneOf(f.kind, p + ".kind", ["fact", "risk", "suggestion"] as const),
        text: text(f.text, p + ".text"),
        recordIds: list(f.recordIds, p + ".recordIds", 32, (x, q) => text(x, q, { max: 64 }), {
          unique: true,
        }),
      };
    }),
    items: list(r.items, path + ".items", 16, (v, p) => {
      const i = record(v, p, ["title", "kind", "pages"]);
      return {
        title: text(i.title, p + ".title", { max: 120 }),
        kind: oneOf(i.kind, p + ".kind", ["table", "text"] as const),
        pages: integer(i.pages, p + ".pages", 1, 50),
      };
    }),
  };
}
export function parseEvalRecording(value: unknown): EvalRecording {
  const r = record(value, "recording", [
    "schemaVersion",
    "caseId",
    "design",
    "origin",
    "basisDigest",
    "runs",
  ]);
  if (r.schemaVersion !== evalFormatVersion) fail("EVAL_VERSION", "recording.schemaVersion");
  const runs = list(
    r.runs,
    "recording.runs",
    33,
    (v, p) => {
      const run = record(v, p, ["runKey", "agent", "turns"]);
      return {
        runKey: text(run.runKey, p + ".runKey", { pattern: runKeyPattern }),
        agent: oneOf(run.agent, p + ".agent", evalAgentRefs),
        turns: list(run.turns, p + ".turns", 16, (t, q) => {
          const turn = record(t, q, ["text", "calls", "result", "usage"]);
          const usage = record(turn.usage, q + ".usage", ["inputTokens", "outputTokens"]);
          const calls = list(turn.calls, q + ".calls", 8, (c, s) => {
            const call = record(c, s, ["id", "tool", "input", "expect"]);
            const expect = record(call.expect, s + ".expect", ["outcome", "refusal", "child"]);
            const outcome = oneOf(expect.outcome, s + ".expect.outcome", evalCallOutcomes);
            const refusal = nullable(expect.refusal, s + ".expect.refusal", (x, y) =>
              oneOf(x, y, evalRefusalCodes),
            );
            const consistent =
              outcome === "ok"
                ? refusal === null
                : outcome === "invalid_input"
                  ? refusal === "input_invalid"
                  : refusal !== null && refusal !== "input_invalid";
            if (!consistent) fail("EVAL_EXPECT_REFUSAL", s + ".expect");
            return {
              id: text(call.id, s + ".id", { pattern: toolUseIdPattern }),
              // The tool name is checked against the run's offered tools at replay: an
              // unoffered name is the model's invalid output, which a recording may hold.
              tool: text(call.tool, s + ".tool", { max: 64 }),
              input: call.input,
              expect: {
                outcome,
                refusal,
                child: nullable(expect.child, s + ".expect.child", (x, y) =>
                  text(x, y, { pattern: runKeyPattern }),
                ),
              },
            };
          });
          const textValue = nullable(turn.text, q + ".text", (x, y) => text(x, y, { max: 32000 }));
          if (textValue === null && calls.length === 0 && turn.result === null)
            fail("EVAL_EMPTY_TURN", q);
          return {
            text: textValue,
            calls,
            result: nullable(turn.result, q + ".result", parseResultDraft),
            usage: {
              inputTokens: integer(usage.inputTokens, q + ".usage.inputTokens", 0, 64000),
              outputTokens: integer(usage.outputTokens, q + ".usage.outputTokens", 0, 16000),
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
  // Each child run is started by one call only, and names a recorded teammate run: the replay
  // never replays one run for two calls.
  const children = runs.flatMap((run) =>
    run.turns.flatMap((t) =>
      t.calls.flatMap((c) => (c.expect.child === null ? [] : [c.expect.child])),
    ),
  );
  if (new Set(children).size !== children.length)
    fail("EVAL_CHILD_REUSED", "recording.calls.expect.child");
  const teammateRuns = new Set(runs.slice(1).map((run) => run.runKey));
  if (children.some((child) => !teammateRuns.has(child)))
    fail("EVAL_CHILD_UNKNOWN", "recording.calls.expect.child");
  const parsed = {
    schemaVersion: 1 as const,
    caseId: text(r.caseId, "recording.caseId", { max: 64, pattern: evalCaseIdPattern }),
    design: oneOf(r.design, "recording.design", evalDesigns),
    origin: oneOf(r.origin, "recording.origin", ["authored"] as const),
    basisDigest: text(r.basisDigest, "recording.basisDigest", { pattern: digestPattern }),
    runs,
  };
  // The basis digest is hex (checked above), so it is left out of the store-id scan.
  for (const [key, entry] of Object.entries(r))
    if (key !== "basisDigest") syntheticIdsOnly(entry, "recording." + key);
  return deepFreeze(parsed);
}

/** The recording file name of a case and design: `<caseId>--<design with @ as ->.json`. */
export function recordingFileName(caseId: string, design: EvalDesign): string {
  return caseId + "--" + design.replace("@", "-") + ".json";
}
