// Teammate calls in code (ADR-0037 items 3(a), 8 and 9; ADR-0041 items 19 to 24 and 34, merged
// by plan row H5). Pure: no I/O, clock or randomness, and no node:* import, so the same rules
// run in Node and in the Workers. The loop builds on them; nothing here admits, dispatches or
// stores anything.
//
// - Switches: teammate calls and agent cards, each committed off (docs/decisions/*.json).
// - Briefs: Morrow writes TeammateBriefInput; code builds the TeammateBrief a teammate
//   receives, filling request with the requester's own words (never the model) and setting the
//   mode and followUpOf from the call.
// - TeammateResult@1 is closed and structured with no character cap. buildTeammateResult
//   assembles it from run.complete's child form (null when the run ended without one) and the
//   run's facts, for every end reason: a run that ended without run.complete but produced
//   records, items or findings is partial and keeps them all. Nothing is cut: a summary,
//   detail, table, question, evidence list, created list or unresolved list too large for the
//   record is stored whole as a result item and shown by id.
// - Code checks first (ADR-0041 item 19): created comes from run_tool_calls, a criterion met
//   on evidence that does not resolve becomes unverified, and next is code's, never the
//   model's. A retry over subjects with unknown outcomes is refused (retry_blocked).
// - Result items open page by page, each page inside one tool result; text is cut only
//   between characters, a table only between rows. Morrow opens an item (memory.read) only
//   when it belongs to a result its own run received; a called teammate only when it is also
//   named in its brief. Nothing customer-tagged enters Morrow's context. A model-written id is
//   never authority to read.
// - Taint only joins and never truncates (ADR-0041 item 34): every kind, the first 256 distinct
//   sources and a count of the rest. Read tags only join too (joinReadTags): a child's
//   follow-up keeps every tag its context already holds.
import type {
  Current_AgentRunEndReason,
  Current_ModelUntrustedSource,
  Current_ReadTag,
  Current_ResultItemPage,
  Current_ResultItemRef,
  Current_RunTaint,
  Current_TaintSource,
  Current_TeammateBrief,
  Current_TeammateBriefInput,
  Current_TeammateBriefMode,
  Current_TeammateCreated,
  Current_TeammateCreatedRecord,
  Current_TeammateCriterion,
  Current_TeammateCriterionReport,
  Current_TeammateEvidence,
  Current_TeammateFinding,
  Current_TeammateFindingInput,
  Current_TeammateNext,
  Current_TeammateOutcome,
  Current_TeammatePlanProgress,
  Current_TeammateRecordRef,
  Current_TeammateRequest,
  Current_TeammateResult,
  Current_TeammateResultInput,
  Current_TeammateResultMode,
  Current_TeammateText,
  Current_TeammateUnresolved,
  Current_TeammateUnresolvedSubject,
  Current_TeammateVerdict,
  Current_TeammateVerification,
  Current_ToolInputAgentAsk,
  Current_ToolInputAgentMap,
  Current_ToolInputRunComplete,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import agentCardsSwitch from "../../../docs/decisions/agent-cards-staging.json";
import teammateCallsSwitch from "../../../docs/decisions/teammate-calls-staging.json";

// --- Switches (ADR-0037 item 9) -------------------------------------------------------------
export interface TeamSwitchState {
  readonly teammateCalls: "on" | "off";
  readonly agentCards: "on" | "off";
}
/** The committed records, read once: anything but exactly "on" is off. */
export function teamSwitchState(): TeamSwitchState {
  return Object.freeze({
    teammateCalls: teammateCallsSwitch.switch === "on" ? "on" : "off",
    agentCards: agentCardsSwitch.switch === "on" ? "on" : "off",
  });
}

// --- Bounds -----------------------------------------------------------------------------------
/** ADR-0027 item 3's bound on one tool result (ADR-0041 item 11 moves it with ToolCatalogue@1). */
export const toolResultMaxBytes = 8192;
/** One page of an item: room for the page's frame inside one tool result. */
export const resultItemPageBytes = 6144;
/**
 * The bound on one stored TeammateResult@1 (ADR-0041 items 21 and 22): the full result opens
 * with memory.read and Morrow's turn gets a compact form code renders, so the record need not
 * fit one tool result; it fits one 256 KiB step read, and anything larger is a result item.
 */
export const teammateResultMaxBytes = 262144;
/** ADR-0031 item 6: support.case.read is the customer tag. */
export const customerReadTag = "support.case.read";

export class TeammateResultError extends Error {
  constructor(
    readonly code:
      | "TEAMMATE_RESULT_INPUT_INVALID"
      | "TEAMMATE_RESULT_TOO_LARGE"
      | "TEAMMATE_RESULT_INVALID",
  ) {
    super(code);
    this.name = "TeammateResultError";
  }
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const jsonBytes = (value: unknown) => bytes(JSON.stringify(value));
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

// --- Taint (ADR-0027 item 5, ADR-0034 item 3, ADR-0037 item 3(a), ADR-0041 item 34) ----------
/** RunTaint's sources listed inline; the rest are counted (run_taint_sources holds them all). */
export const runTaintSourceLimit = 256;
/** An untainted RunTaint. */
export const cleanTaint = (): Current_RunTaint => ({
  contextTaint: "none",
  kinds: [],
  sources: [],
  omittedSources: 0,
});
const sourceTaint = (s: Current_TaintSource): Current_RunTaint => ({
  contextTaint: "untrusted_external",
  kinds: [s.source],
  sources: [{ source: s.source, sourceId: s.sourceId }],
  omittedSources: 0,
});
/** A RunTaint consuming the given sources (distinct, in order); untainted when there are none. */
export function taintFrom(sources: readonly Current_TaintSource[]): Current_RunTaint {
  return sources.length === 0 ? cleanTaint() : joinRunTaint(...sources.map(sourceTaint));
}
/**
 * The join of taints: untrusted_external when any is, never cleared; every kind any input
 * holds, in order of first appearance; the first 256 distinct sources (the first taint's
 * first); and omittedSources, the inputs' counts added to the distinct sources past 256 (a
 * source two inputs both omitted may count twice: never fewer than there are).
 */
export function joinRunTaint(...taints: readonly Current_RunTaint[]): Current_RunTaint {
  if (!taints.some((t) => t.contextTaint === "untrusted_external")) return cleanTaint();
  const kinds: Current_ModelUntrustedSource[] = [];
  const sources: Current_TaintSource[] = [];
  const seen = new Set<string>();
  let omitted = 0;
  const kind = (k: Current_ModelUntrustedSource) => {
    if (!kinds.includes(k)) kinds.push(k);
  };
  for (const taint of taints) {
    for (const k of taint.kinds) kind(k);
    omitted += taint.omittedSources;
    for (const s of taint.sources) {
      kind(s.source);
      const key = JSON.stringify([s.source, s.sourceId]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (sources.length < runTaintSourceLimit)
        sources.push({ source: s.source, sourceId: s.sourceId });
      else omitted += 1;
    }
  }
  return { contextTaint: "untrusted_external", kinds, sources, omittedSources: omitted };
}
/** ReadTags' bound (ADR-0031 item 6): a run's tags are distinct, at most 24. */
export const readTagLimit = 24;
/**
 * The join of read tags (ADR-0031 item 6): everything a context holds keeps its tags, so a
 * child's tags only join across its sequences (ADR-0041 item 21: a follow-up keeps everything
 * it read) and never narrow. Distinct, in order of first appearance. Null past ReadTags' 24,
 * which code refuses rather than cut.
 */
export function joinReadTags(
  ...lists: readonly (readonly Current_ReadTag[])[]
): readonly Current_ReadTag[] | null {
  const tags = new Map<string, Current_ReadTag>();
  for (const list of lists)
    for (const t of list) {
      const key = JSON.stringify([t.storeId, t.capability]);
      if (!tags.has(key)) tags.set(key, { storeId: t.storeId, capability: t.capability });
    }
  return tags.size > readTagLimit ? null : [...tags.values()];
}
/** RunTaint's code rule beyond its schema: every listed source's kind is among kinds. */
export function runTaintValid(value: unknown): value is Current_RunTaint {
  if (!validateCurrentDefinition("RunTaint", value)) return false;
  const taint = value as Current_RunTaint;
  return taint.sources.every((s) => taint.kinds.includes(s.source));
}

// --- Paging -----------------------------------------------------------------------------------
/** A table as stored: column headings and rows of text cells, one cell per column. */
export interface TeammateTableContent {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}
export type ResultItemContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "table"; readonly table: TeammateTableContent };

// The bytes one code point takes inside a JSON string (UTF-8, with JSON.stringify's escapes),
// so a page stays inside one tool result however its text is escaped.
const charCost = (char: string): number => {
  const cp = char.codePointAt(0)!;
  if (cp === 0x22 || cp === 0x5c) return 2;
  if (cp < 0x20) return [8, 9, 10, 12, 13].includes(cp) ? 2 : 6;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp >= 0xd800 && cp <= 0xdfff) return 6;
  return cp < 0x10000 ? 3 : 4;
};
/**
 * A text's pages, each at most resultItemPageBytes bytes as JSON string content, cut only
 * between code points (never inside a surrogate pair). An empty text is one empty page.
 * Joined, the pages are the text exactly.
 */
export function textPages(text: string): readonly string[] {
  if (typeof text !== "string") throw new TeammateResultError("TEAMMATE_RESULT_INPUT_INVALID");
  const pages: string[] = [];
  let page = "";
  let size = 0;
  for (const char of text) {
    const n = charCost(char);
    if (size + n > resultItemPageBytes && page !== "") {
      pages.push(page);
      page = "";
      size = 0;
    }
    page += char;
    size += n;
  }
  pages.push(page);
  return Object.freeze(pages);
}
const tableWellFormed = (table: TeammateTableContent) =>
  Array.isArray(table.columns) &&
  table.columns.length >= 1 &&
  Array.isArray(table.rows) &&
  table.rows.every((row) => Array.isArray(row) && row.length === table.columns.length);
/**
 * A table's pages as runs of rows, each page's columns and rows within resultItemPageBytes.
 * Null when one row alone does not fit a page: such a table is stored as CSV text instead,
 * which pages by characters, so nothing is cut.
 */
export function tablePages(
  table: TeammateTableContent,
): readonly { readonly firstRow: number; readonly rows: readonly (readonly string[])[] }[] | null {
  if (!tableWellFormed(table)) throw new TeammateResultError("TEAMMATE_RESULT_INPUT_INVALID");
  const frame = jsonBytes({ columns: table.columns, firstRow: 999999, rows: [] });
  if (frame > resultItemPageBytes) return null;
  const pages: { firstRow: number; rows: (readonly string[])[] }[] = [];
  let current: { firstRow: number; rows: (readonly string[])[] } = { firstRow: 1, rows: [] };
  let size = frame;
  for (const [index, row] of table.rows.entries()) {
    const n = jsonBytes(row) + 1;
    if (frame + n > resultItemPageBytes) return null;
    if (size + n > resultItemPageBytes && current.rows.length) {
      pages.push(current);
      current = { firstRow: index + 1, rows: [] };
      size = frame;
    }
    current.rows.push(row);
    size += n;
  }
  pages.push(current);
  return Object.freeze(pages.map((p) => Object.freeze({ ...p, rows: Object.freeze(p.rows) })));
}
const fitsTable = (table: TeammateTableContent) => tablePages(table) !== null;
const csvCell = (cell: string) =>
  /[",\r\n]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell;
/** RFC 4180 text of a table, for a table whose rows do not fit a page one by one. */
export const csvText = (table: TeammateTableContent): string =>
  [table.columns, ...table.rows].map((row) => row.map(csvCell).join(",")).join("\r\n");

/** The stored form of one item's content and its size and page count. */
export interface ResultItemDraft {
  readonly kind: "text" | "table" | "file";
  readonly mediaType: "text/plain" | "text/markdown" | "text/csv" | "application/json";
  readonly title: string;
  readonly content: ResultItemContent;
  readonly sizeBytes: number;
  readonly pageCount: number;
}
const label = (title: string) => {
  const chars = [...title.replace(/\s+/gu, " ").trim()];
  const text = chars.length > 200 ? chars.slice(0, 199).join("") + "…" : chars.join("");
  return text === "" ? "Untitled" : text;
};
/** A text item's draft. */
export function textItemDraft(
  title: string,
  text: string,
  mediaType: ResultItemDraft["mediaType"] = "text/plain",
  kind: "text" | "file" = "text",
): ResultItemDraft {
  return Object.freeze({
    kind,
    mediaType,
    title: label(title),
    content: Object.freeze({ kind: "text" as const, text }),
    sizeBytes: bytes(text),
    pageCount: textPages(text).length,
  });
}
/** A table item's draft, or a CSV text item's when a row alone exceeds a page. */
export function tableItemDraft(title: string, table: TeammateTableContent): ResultItemDraft {
  if (!tableWellFormed(table)) throw new TeammateResultError("TEAMMATE_RESULT_INPUT_INVALID");
  if (!fitsTable(table)) return textItemDraft(title, csvText(table), "text/csv");
  const pages = tablePages(table)!;
  return Object.freeze({
    kind: "table" as const,
    mediaType: "text/csv" as const,
    title: label(title),
    content: Object.freeze({ kind: "table" as const, table }),
    sizeBytes: jsonBytes({ columns: table.columns, rows: table.rows }),
    pageCount: pages.length,
  });
}
const jsonItemDraft = (title: string, value: unknown) =>
  textItemDraft(title, JSON.stringify(value, null, 2), "application/json");

/**
 * One page of an item (ResultItemPage@1), 1-based, or "page_out_of_range". The caller has
 * already decided the item may be opened (coordinatorMayOpen or teammateMayOpen).
 */
export function resultItemPage(
  item: {
    readonly itemId: string;
    readonly kind: "text" | "table" | "file";
    readonly title: string;
    readonly content: ResultItemContent;
  },
  page: number,
): Current_ResultItemPage | "page_out_of_range" {
  if (!Number.isInteger(page) || page < 1) return "page_out_of_range";
  if (item.content.kind === "text") {
    const pages = textPages(item.content.text);
    if (page > pages.length) return "page_out_of_range";
    return Object.freeze({
      schemaVersion: 1 as const,
      itemId: item.itemId,
      kind: item.kind,
      title: item.title,
      page,
      pageCount: pages.length,
      content: Object.freeze({ kind: "text" as const, text: pages[page - 1]! }),
    });
  }
  const pages = tablePages(item.content.table);
  if (pages === null) throw new TeammateResultError("TEAMMATE_RESULT_INVALID");
  if (page > pages.length) return "page_out_of_range";
  const chosen = pages[page - 1]!;
  return Object.freeze({
    schemaVersion: 1 as const,
    itemId: item.itemId,
    kind: item.kind,
    title: item.title,
    page,
    pageCount: pages.length,
    content: Object.freeze({
      kind: "table" as const,
      columns: [...item.content.table.columns],
      firstRow: chosen.firstRow,
      rows: chosen.rows.map((row) => [...row]),
    }),
  });
}

// --- Briefs (ADR-0041 item 21) ----------------------------------------------------------------
/**
 * The brief a teammate receives: Morrow's TeammateBriefInput as written, with request filled
 * by code from the requester's own message (null for a mandate episode) and the mode and
 * followUpOf from the call. Null when either part is outside its contract.
 */
export function teammateBrief(
  input: Current_TeammateBriefInput,
  code: {
    readonly request: Current_TeammateRequest | null;
    readonly mode: Current_TeammateBriefMode;
    readonly followUpOf: string | null;
  },
): Current_TeammateBrief | null {
  if (!validateCurrentDefinition("TeammateBriefInput", input)) return null;
  const brief: Current_TeammateBrief = {
    ...structuredClone(input),
    request: code.request === null ? null : structuredClone(code.request),
    mode: code.mode,
    followUpOf: code.followUpOf,
  };
  return validateCurrentDefinition("TeammateBrief", brief) ? deepFreeze(brief) : null;
}

// --- Orchestration inputs (ADR-0041 items 21 and 22) -----------------------------------------
/** agent.ask's code rule beyond its schema: an installation exactly when it is no follow-up. */
export function agentAskValid(input: unknown): input is Current_ToolInputAgentAsk {
  if (!validateCurrentDefinition("ToolInputAgentAsk", input)) return false;
  const ask = input as Current_ToolInputAgentAsk;
  return (ask.installationId === null) === (ask.followUpOf !== null);
}
/** agent.map's code rule beyond its schema: exactly one source, records or an item's rows. */
export function agentMapValid(input: unknown): input is Current_ToolInputAgentMap {
  if (!validateCurrentDefinition("ToolInputAgentMap", input)) return false;
  const map = input as Current_ToolInputAgentMap;
  return (map.source.records === null) !== (map.source.itemId === null);
}
const refKey = (r: { readonly kind: string; readonly id: string }) => r.kind + "\u0000" + r.id;
/**
 * ADR-0041 item 23: a dispatch naming a subject whose outcome is unknown is refused until the
 * reconciler settles it; the records a brief names are its subjects.
 */
export function retryBlocked(
  records: readonly Current_TeammateRecordRef[],
  unresolved: readonly Current_TeammateUnresolvedSubject[],
): "ok" | "retry_blocked" {
  const blocked = new Set(unresolved.map((u) => refKey(u.subject)));
  return records.some((r) => blocked.has(refKey(r))) ? "retry_blocked" : "ok";
}

// --- run.complete's child form and TeammateResult@1 ------------------------------------------
const metricOnly = (f: { kind: string; value: unknown; unit: unknown }) =>
  f.kind === "metric" || (f.value === null && f.unit === null);
const tableOnly = (f: { kind: string; table: unknown }) =>
  (f.kind === "table") === (f.table !== null);
const findingsValid = (findings: readonly Current_TeammateFindingInput[]) =>
  findings.every(
    (f) => metricOnly(f) && tableOnly(f) && (f.table === null || tableWellFormed(f.table)),
  );
const distinctIndexes = (rows: readonly { readonly index: number }[]) =>
  new Set(rows.map((r) => r.index)).size === rows.length;
/**
 * The child form's code rules beyond its schema (the tool-call step's validation): a metric
 * alone has a value or a unit, a table finding alone has a table, and every row has one cell
 * per column; one verdict per criterion at most. A breach is the call's invalid_input.
 */
export function teammateResultInputValid(input: unknown): input is Current_TeammateResultInput {
  if (!validateCurrentDefinition("TeammateResultInput", input)) return false;
  const result = input as Current_TeammateResultInput;
  return findingsValid(result.findings) && distinctIndexes(result.verdicts);
}

/** End reasons a person, a switch or authority caused: the work was stopped, not failed. */
const stoppedEnds: readonly Current_AgentRunEndReason[] = [
  "stopped",
  "switch_off",
  "lease_ended",
  "task_closed",
  "mandate_ended",
  "deadline",
  "question_unanswered",
  "spend_limit",
];
/** End reasons from a broken output or the provider: the run failed. */
const failedEnds: readonly Current_AgentRunEndReason[] = [
  "invalid_output",
  "provider_error",
  "prefix_mismatch",
  "refusal",
];
/**
 * The outcome code sets when a run ends without run.complete (never model text): partial when
 * it created records, wrote items or recorded findings, so nothing is lost (ADR-0041 item 23);
 * otherwise stopped or failed by its end reason, and no_result for every other end.
 */
export function codeOutcome(
  endReason: Current_AgentRunEndReason,
  produced: boolean,
): Current_TeammateOutcome {
  if (produced) return "partial";
  if (stoppedEnds.includes(endReason)) return "stopped";
  if (failedEnds.includes(endReason)) return "failed";
  return "no_result";
}
/**
 * Code's next hint (ADR-0041 item 23), from SQL facts and code checks, never model text.
 * Unknown outcomes come first: nothing is retried over them.
 */
export function nextFor(
  outcome: Current_TeammateOutcome,
  endReason: Current_AgentRunEndReason,
  criteria: readonly Current_TeammateCriterion[],
  hasUnresolved: boolean,
): Current_TeammateNext {
  if (hasUnresolved) return "do_not_retry";
  switch (outcome) {
    case "done":
      return criteria.every((c) => c.status === "met") ? "none" : "follow_up";
    case "nothing_found":
      return "none";
    case "partial":
      return "follow_up";
    case "blocked":
      return "ask_person";
    case "cannot_do":
      return "reroute";
    case "stopped":
      return "do_not_retry";
    case "failed":
    case "no_result":
      return endReason === "provider_error" ? "retry_later" : "rebrief";
  }
}

/** The facts of a called teammate's run, all from code and SQL. */
export interface TeammateRunFacts {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly parentRunId: string;
  readonly toolUseId: string;
  readonly callId: string;
  /** 1 for the call's first result, 2 for its first follow-up's, and so on. */
  readonly sequence: number;
  readonly mode: Current_TeammateResultMode;
  readonly runId: string;
  readonly taskId: string;
  readonly installationId: string;
  readonly endReason: Current_AgentRunEndReason;
  /** The brief's done criteria, by count: every one is reported once. */
  readonly doneCriteria: number;
  /** The records the brief named: evidence may cite them. */
  readonly given: readonly Current_TeammateRecordRef[];
  /** From run_tool_calls, never model text. */
  readonly created: readonly Current_TeammateCreatedRecord[];
  /** The result items the run wrote with result.write. */
  readonly written: readonly Current_ResultItemRef[];
  /** Findings the run recorded in its plan's notes, kept when it ends without run.complete. */
  readonly recordedFindings: readonly Current_TeammateFindingInput[];
  /** Subjects whose outcome is unknown (gateway operations, computer steps). */
  readonly unresolved: readonly Current_TeammateUnresolvedSubject[];
  readonly plan: Current_TeammatePlanProgress | null;
  readonly checkpointId: string | null;
  /** The review run's overall verdict on this result, or not_run. */
  readonly verifierVerdict: Current_TeammateVerification["verifierVerdict"];
  readonly readTags: readonly Current_ReadTag[];
  readonly taint: Current_RunTaint;
  readonly completedAt: string;
}
/** Stores one item for the run (its read tags and taint) and returns the item's id. */
export type ResultItemSink = (draft: ResultItemDraft) => Promise<string>;

// A placeholder id as long as an Id may be, so a plan that fits still fits with real ids.
const placeholderId = "x".repeat(128);
// About the bytes a reference adds (an item marker and its listed ref with a long title).
const movableBytes = 512;

/** One part of a result that may move whole into an item, in the fixed store order. */
interface Part {
  readonly key: string;
  readonly size: number;
  readonly draft: () => ResultItemDraft;
}

const criterionChecked = (
  report: Current_TeammateCriterionReport | undefined,
  resolvable: ReadonlySet<string>,
): { status: Current_TeammateCriterion["status"]; refs: readonly Current_TeammateRecordRef[] } => {
  if (!report) return { status: "unknown", refs: [] };
  const refs = report.evidence.map((r) => ({ kind: r.kind, id: r.id }));
  if (report.status === "met" && refs.some((r) => !resolvable.has(refKey(r))))
    return { status: "unverified", refs };
  return { status: report.status, refs };
};

/**
 * TeammateResult@1 from a called teammate's run.complete input (null when its run ended
 * without one) and the run's facts, for every end reason (ADR-0041 item 23).
 *
 * - The outcome is the teammate's when it completed; one it gave and its run then ended
 *   otherwise (a stop before the close) keeps everything as partial. Without run.complete,
 *   codeOutcome decides, and a run that produced anything is partial with all of it.
 * - Every done criterion appears once: unreported is unknown; met on evidence that does not
 *   resolve to records or items the run produced or was given is unverified (code only).
 * - In review mode every criterion has a verdict (unreported is unknown); in any other mode a
 *   verdict is an invalid input.
 * - Nothing is cut: while the record exceeds teammateResultMaxBytes, the largest movable part
 *   moves whole into a result item; then every finding moves into one JSON item, then the
 *   summary. A record that cannot fit even then throws TEAMMATE_RESULT_TOO_LARGE (a defect:
 *   every other field has a count bound). Items are stored in a fixed order, so the same
 *   input stores the same items.
 */
export async function buildTeammateResult(
  facts: TeammateRunFacts,
  completion: Current_ToolInputRunComplete | null,
  store: ResultItemSink,
): Promise<Current_TeammateResult> {
  if (
    !Number.isInteger(facts.doneCriteria) ||
    facts.doneCriteria < 1 ||
    facts.doneCriteria > 64 ||
    !runTaintValid(facts.taint)
  )
    throw new TeammateResultError("TEAMMATE_RESULT_INPUT_INVALID");
  const child = completion?.result ?? null;
  if (
    completion !== null &&
    (!validateCurrentDefinition("ToolInputRunComplete", completion) ||
      child === null ||
      completion.reply !== null ||
      completion.outcome === "waiting" ||
      !teammateResultInputValid(child) ||
      !distinctIndexes(completion.criteria) ||
      completion.criteria.some((c) => c.index >= facts.doneCriteria) ||
      child.verdicts.some((v) => v.index >= facts.doneCriteria) ||
      (facts.mode !== "review" && child.verdicts.length > 0) ||
      (child.needs !== null && !["blocked", "partial"].includes(completion.outcome)) ||
      child.items.some((id) => !facts.written.some((w) => w.itemId === id)))
  )
    throw new TeammateResultError("TEAMMATE_RESULT_INPUT_INVALID");
  const findingsIn: readonly Current_TeammateFindingInput[] =
    child?.findings ?? facts.recordedFindings;
  if (!findingsValid(findingsIn)) throw new TeammateResultError("TEAMMATE_RESULT_INPUT_INVALID");
  const produced =
    facts.created.length > 0 || facts.written.length > 0 || facts.recordedFindings.length > 0;
  const given = completion === null ? null : (completion.outcome as Current_TeammateOutcome);
  const outcome: Current_TeammateOutcome =
    given === null
      ? codeOutcome(facts.endReason, produced)
      : facts.endReason !== "completed" && ["done", "nothing_found", "cannot_do"].includes(given)
        ? "partial"
        : given;
  const nothing = ["no_result", "stopped", "failed"].includes(outcome);
  // Code checks first (ADR-0041 item 19).
  const resolvable = new Set<string>([
    ...facts.given.map(refKey),
    ...facts.created.map(refKey),
    ...facts.written.map((w) => refKey({ kind: "result_item", id: w.itemId })),
  ]);
  const reports = new Map((completion?.criteria ?? []).map((c) => [c.index, c]));
  const checked = Array.from({ length: facts.doneCriteria }, (_, index) =>
    criterionChecked(reports.get(index), resolvable),
  );
  const verdictsIn =
    facts.mode === "review" && !nothing && child !== null
      ? Array.from({ length: facts.doneCriteria }, (_, index) => {
          const v = child.verdicts.find((x) => x.index === index);
          return {
            index,
            verdict: v?.verdict ?? ("unknown" as const),
            refs: (v?.evidence ?? []).map((r) => ({ kind: r.kind, id: r.id })),
            note: v?.note ?? null,
          };
        })
      : [];
  const verification: Current_TeammateVerification = {
    codeChecksPassed: checked.filter((c) => c.status === "met").length,
    codeChecksFailed: checked.filter((c) => c.status === "unverified").length,
    verifierVerdict: facts.verifierVerdict,
  };
  const summaryText = nothing ? null : (child?.summary ?? null);
  const needsIn = nothing || child === null ? null : child.needs;
  const findings = nothing ? [] : findingsIn;
  const counts = child === null ? { checked: 0, missing: 0, questions: 0 } : { ...child.counts };
  const nextSteps = nothing || child === null ? [] : [...child.nextSteps];
  const created = facts.created.map((r) => ({ kind: r.kind, id: r.id }));
  const unresolved = facts.unresolved.map((u) => ({
    subject: { kind: u.subject.kind, id: u.subject.id },
    operation: { kind: u.operation.kind, id: u.operation.id },
  }));
  const written = nothing ? [] : facts.written.map((w) => ({ ...w }));

  // The movable parts, in the fixed store order.
  const parts: Part[] = [];
  const text = (key: string, title: string, value: string) =>
    parts.push({ key, size: bytes(value), draft: () => textItemDraft(title, value) });
  const json = (key: string, title: string, value: unknown) =>
    parts.push({ key, size: jsonBytes(value), draft: () => jsonItemDraft(title, value) });
  if (summaryText !== null) text("summary", "Summary", summaryText);
  findings.forEach((f, i) => {
    text(`detail:${i}`, f.title, f.detail);
    if (f.table !== null) {
      const table = f.table;
      parts.push({
        key: `table:${i}`,
        size: jsonBytes(table),
        draft: () => tableItemDraft(f.title + " (table)", table),
      });
    }
  });
  if (needsIn?.question != null) text("needs", "Question", needsIn.question);
  checked.forEach((c, i) => json(`evidence:${i}`, `Evidence for criterion ${i + 1}`, c.refs));
  verdictsIn.forEach((v, i) => {
    json(`verdict:${i}`, `Review evidence for criterion ${i + 1}`, v.refs);
    if (v.note !== null) text(`note:${i}`, `Review note for criterion ${i + 1}`, v.note);
  });
  json("created", `Records created (${created.length})`, created);
  json("unresolved", `Unknown outcomes (${unresolved.length})`, unresolved);

  const moved = new Set<string>();
  let allFindings = false;
  const allFindingsDraft = () => jsonItemDraft(`Findings (${findings.length})`, findings);
  const shape = (idOf: (key: string) => string): Current_TeammateResult => {
    const items: Current_ResultItemRef[] = written.map((w) => ({ ...w }));
    const refs = new Map<string, string>();
    const stored = (key: string, draft: () => ResultItemDraft): string => {
      const existing = refs.get(key);
      if (existing !== undefined) return existing;
      const itemId = idOf(key);
      const d = draft();
      items.push({
        itemId,
        kind: d.kind,
        title: d.title,
        sizeBytes: d.sizeBytes,
        pageCount: d.pageCount,
      });
      refs.set(key, itemId);
      return itemId;
    };
    const partOf = (key: string) => parts.find((p) => p.key === key)!;
    const textOf = (key: string, value: string): Current_TeammateText =>
      moved.has(key)
        ? { kind: "item", itemId: stored(key, partOf(key).draft) }
        : { kind: "text", text: value };
    const evidenceOf = (
      key: string,
      refsIn: readonly Current_TeammateRecordRef[],
    ): Current_TeammateEvidence =>
      moved.has(key) && refsIn.length > 0
        ? { kind: "item", itemId: stored(key, partOf(key).draft), count: refsIn.length }
        : { kind: "list", refs: refsIn.map((r) => ({ ...r })) };
    const summary = summaryText === null ? null : textOf("summary", summaryText);
    const shownFindings: Current_TeammateFinding[] = [];
    if (allFindings) {
      if (findings.length > 0) stored("findings", allFindingsDraft);
    } else
      findings.forEach((f, i) => {
        shownFindings.push({
          kind: f.kind,
          title: f.title,
          detail: textOf(`detail:${i}`, f.detail),
          records: f.records.map((r) => ({ kind: r.kind, id: r.id })),
          value: f.value,
          unit: f.unit,
          table:
            f.table === null
              ? null
              : moved.has(`table:${i}`)
                ? { kind: "item", itemId: stored(`table:${i}`, partOf(`table:${i}`).draft) }
                : {
                    kind: "table",
                    columns: [...f.table.columns],
                    rows: f.table.rows.map((r) => [...r]),
                  },
        });
      });
    const needs =
      needsIn === null
        ? null
        : {
            kind: needsIn.kind,
            question: needsIn.question === null ? null : textOf("needs", needsIn.question),
          };
    const criteria: Current_TeammateCriterion[] = checked.map((c, i) => ({
      index: i,
      status: c.status,
      evidence: evidenceOf(`evidence:${i}`, c.refs),
    }));
    const verdicts: Current_TeammateVerdict[] = verdictsIn.map((v, i) => ({
      index: v.index,
      verdict: v.verdict,
      evidence: evidenceOf(`verdict:${i}`, v.refs),
      note: v.note === null ? null : textOf(`note:${i}`, v.note),
    }));
    const createdShown: Current_TeammateCreated =
      moved.has("created") && created.length > 0
        ? {
            kind: "item",
            itemId: stored("created", partOf("created").draft),
            count: created.length,
          }
        : { kind: "list", records: created.map((r) => ({ ...r })) };
    const unresolvedShown: Current_TeammateUnresolved =
      moved.has("unresolved") && unresolved.length > 0
        ? {
            kind: "item",
            itemId: stored("unresolved", partOf("unresolved").draft),
            count: unresolved.length,
          }
        : { kind: "list", subjects: unresolved.map((u) => structuredClone(u)) };
    return {
      schemaVersion: 1,
      organizationId: facts.organizationId,
      workspaceId: facts.workspaceId,
      parentRunId: facts.parentRunId,
      toolUseId: facts.toolUseId,
      callId: facts.callId,
      sequence: facts.sequence,
      mode: facts.mode,
      runId: facts.runId,
      taskId: facts.taskId,
      installationId: facts.installationId,
      outcome,
      endReason: facts.endReason,
      counts,
      nextSteps,
      created: createdShown,
      criteria,
      verdicts,
      next: nextFor(outcome, facts.endReason, criteria, unresolved.length > 0),
      needs,
      unresolved: unresolvedShown,
      plan: facts.plan === null ? null : { ...facts.plan },
      verification,
      checkpointId: facts.checkpointId,
      summary,
      findings: shownFindings,
      items,
      readTags: facts.readTags.map((t) => ({ storeId: t.storeId, capability: t.capability })),
      taint: structuredClone(facts.taint),
      completedAt: facts.completedAt,
    };
  };
  const measure = () => jsonBytes(shape(() => placeholderId));
  const movable = parts
    // A part smaller than a reference to it never makes the result smaller by moving.
    .filter((part) => part.size > movableBytes)
    .sort((a, b) => b.size - a.size);
  for (const part of movable) {
    if (measure() <= teammateResultMaxBytes) break;
    moved.add(part.key);
  }
  if (measure() > teammateResultMaxBytes) {
    // Every finding, whole, in one JSON item; the summary moves too only if it must.
    for (const key of [...moved])
      if (key.startsWith("detail:") || key.startsWith("table:")) moved.delete(key);
    allFindings = true;
    if (measure() > teammateResultMaxBytes && summaryText !== null) moved.add("summary");
    if (measure() > teammateResultMaxBytes)
      throw new TeammateResultError("TEAMMATE_RESULT_TOO_LARGE");
  }
  // Store in the fixed order, then build with the real ids. An empty list never moves: it is
  // smaller than a reference to it.
  const ids = new Map<string, string>();
  for (const part of parts)
    if (moved.has(part.key) && !(allFindings && /^(detail|table):/.test(part.key)))
      ids.set(part.key, await store(part.draft()));
  if (allFindings && findings.length > 0) ids.set("findings", await store(allFindingsDraft()));
  return finish(shape((key) => ids.get(key)!));
}
function finish(result: Current_TeammateResult): Current_TeammateResult {
  if (!teammateResultValid(result)) throw new TeammateResultError("TEAMMATE_RESULT_INVALID");
  if (jsonBytes(result) > teammateResultMaxBytes)
    throw new TeammateResultError("TEAMMATE_RESULT_TOO_LARGE");
  return deepFreeze(result);
}

const itemIdsOf = (result: Current_TeammateResult) => {
  const referenced: string[] = [];
  const text = (t: Current_TeammateText | null) => {
    if (t?.kind === "item") referenced.push(t.itemId);
  };
  text(result.summary);
  for (const f of result.findings) {
    text(f.detail);
    if (f.table?.kind === "item") referenced.push(f.table.itemId);
  }
  text(result.needs?.question ?? null);
  for (const c of result.criteria)
    if (c.evidence.kind === "item") referenced.push(c.evidence.itemId);
  for (const v of result.verdicts) {
    if (v.evidence.kind === "item") referenced.push(v.evidence.itemId);
    text(v.note);
  }
  if (result.created.kind === "item") referenced.push(result.created.itemId);
  if (result.unresolved.kind === "item") referenced.push(result.unresolved.itemId);
  return referenced;
};
/**
 * TeammateResult@1's code rules beyond its schema: items listed once; every item the result
 * names is listed; a metric alone has a value or a unit and a table finding alone a table;
 * inline rows have one cell per column; criteria and verdicts once per index; the taint's
 * sources among its kinds.
 */
export function teammateResultValid(value: unknown): value is Current_TeammateResult {
  if (!validateCurrentDefinition("TeammateResult", value)) return false;
  const result = value as Current_TeammateResult;
  const listed = result.items.map((i) => i.itemId);
  if (new Set(listed).size !== listed.length) return false;
  if (itemIdsOf(result).some((id) => !listed.includes(id))) return false;
  if (!distinctIndexes(result.criteria) || !distinctIndexes(result.verdicts)) return false;
  if (!runTaintValid(result.taint)) return false;
  return result.findings.every(
    (f) =>
      metricOnly(f) &&
      tableOnly(f) &&
      (f.table === null || f.table.kind === "item" || tableWellFormed(f.table)),
  );
}

/** Whether any read tag is the customer tag. */
export const customerTagged = (readTags: readonly Current_ReadTag[]): boolean =>
  readTags.some((t) => t.capability === customerReadTag);
/**
 * Whether a result may enter Morrow's job (ADR-0037 item 3(a)): valid, and never with a
 * customer read tag (ADR-0031 items 2 and 6).
 */
export function acceptTeammateResult(
  value: unknown,
): "ok" | "result_customer_tagged" | "result_invalid" {
  if (!teammateResultValid(value)) return "result_invalid";
  return customerTagged(value.readTags) ? "result_customer_tagged" : "ok";
}
/** The subjects a result left with unknown outcomes, when they are inline (code reads an item). */
export const unresolvedSubjects = (
  result: Current_TeammateResult,
): readonly Current_TeammateUnresolvedSubject[] | null =>
  result.unresolved.kind === "list" ? result.unresolved.subjects : null;

// --- Opening items (memory.read, ADR-0041 item 24) ---------------------------------------------
export type ItemOpenRefusal = "item_not_received" | "result_customer_tagged";
/** The ids of the items a set of results listed: what a run "received". */
export function receivedItemIds(results: readonly Current_TeammateResult[]): ReadonlySet<string> {
  return new Set(results.flatMap((r) => r.items.map((i) => i.itemId)));
}
/**
 * memory.read of a result item for Morrow (ADR-0037 item 3(a)): only when it belongs to a
 * result its own run received, and never one with a customer read tag.
 */
export function coordinatorMayOpen(
  item: { readonly itemId: string; readonly readTags: readonly Current_ReadTag[] },
  receivedByRun: ReadonlySet<string>,
): "ok" | ItemOpenRefusal {
  if (!receivedByRun.has(item.itemId)) return "item_not_received";
  return customerTagged(item.readTags) ? "result_customer_tagged" : "ok";
}
/**
 * memory.read of a result item for a called or handed-off teammate: only when its brief names
 * it and it belongs to a result the calling Morrow run received; its own grants and the item's
 * read tags are checked as for any read (the loop).
 */
export function teammateMayOpen(
  item: { readonly itemId: string; readonly readTags: readonly Current_ReadTag[] },
  brief: Current_TeammateBrief,
  receivedByCallingRun: ReadonlySet<string>,
): "ok" | ItemOpenRefusal {
  if (!brief.records.some((r) => r.kind === "result_item" && r.id === item.itemId))
    return "item_not_received";
  return coordinatorMayOpen(item, receivedByCallingRun);
}
