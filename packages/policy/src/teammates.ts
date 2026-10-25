// Teammate calls in code (ADR-0037 items 3(a), 8 and 9; its implementation plan's PR 2). Pure:
// no I/O, clock or randomness, and no node:* import, so the same rules run in Node and in the
// Workers. The loop (PR 4) builds on them; nothing here admits, dispatches or stores anything.
//
// - Switches: teammate calls and agent cards, each committed off (docs/decisions/*.json).
// - TeammateResult@1 is closed and structured with no character cap. buildTeammateResult
//   assembles it from a called teammate's result.submit input and the run's facts, and keeps
//   nothing out: a summary, detail or table too large for one 8 KiB tool result is stored
//   whole as a result item and shown by id, kind, size, pages and title.
// - Result items open page by page, each page inside one tool result; text is cut only
//   between characters, a table only between rows.
// - Morrow opens an item only when it belongs to a result its own run received; a called
//   teammate only when it is also named in its brief. Nothing customer-tagged enters Morrow's
//   context. A model-written id is never authority to read.
import type {
  Current_AgentRunEndReason,
  Current_ReadTag,
  Current_ResultItemPage,
  Current_ResultItemRef,
  Current_RunTaint,
  Current_TeammateBrief,
  Current_TeammateCreatedRecord,
  Current_TeammateFinding,
  Current_TeammateOutcome,
  Current_TeammateResult,
  Current_TeammateText,
  Current_ToolInputResultSubmit,
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
/** ADR-0027 item 3's bound on one tool result, unchanged by ADR-0037. */
export const toolResultMaxBytes = 8192;
/** One page of an item: room for the page's frame inside one tool result. */
export const resultItemPageBytes = 6144;
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

// --- result.submit and TeammateResult@1 -------------------------------------------------------
const metricOnly = (f: { kind: string; value: unknown; unit: unknown }) =>
  f.kind === "metric" || (f.value === null && f.unit === null);
const tableOnly = (f: { kind: string; table: unknown }) =>
  (f.kind === "table") === (f.table !== null);
/**
 * result.submit's code rules beyond its schema (the tool-call step's validation): a metric
 * alone has a value or a unit, a table finding alone has a table, and every row has one cell
 * per column. A breach is the call's invalid_input.
 */
export function resultSubmitValid(input: unknown): input is Current_ToolInputResultSubmit {
  if (!validateCurrentDefinition("ToolInputResultSubmit", input)) return false;
  const submit = input as Current_ToolInputResultSubmit;
  return submit.findings.every(
    (f) => metricOnly(f) && tableOnly(f) && (f.table === null || tableWellFormed(f.table)),
  );
}

/** The outcome code sets when a run ends without result.submit (never model text). */
export function codeOutcome(endReason: Current_AgentRunEndReason): Current_TeammateOutcome {
  switch (endReason) {
    case "stopped":
    case "switch_off":
    case "lease_ended":
    case "task_closed":
    case "mandate_ended":
      return "stopped";
    case "invalid_output":
    case "provider_error":
    case "prefix_mismatch":
    case "refusal":
      return "failed";
    default:
      return "no_result";
  }
}

/** The facts of a called teammate's run, all from code. */
export interface TeammateRunFacts {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly parentRunId: string;
  readonly toolUseId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly installationId: string;
  readonly endReason: Current_AgentRunEndReason;
  readonly created: readonly Current_TeammateCreatedRecord[];
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
type Part =
  | { readonly at: "summary"; readonly size: number }
  | { readonly at: "detail" | "table"; readonly finding: number; readonly size: number };

/**
 * TeammateResult@1 from a called teammate's result.submit input (null when its run ended
 * without one) and the run's facts. Nothing is cut: when the result does not fit one tool
 * result, the largest summary, detail or table moves whole into a result item first, and so
 * on until it fits; if it still does not fit, every finding moves into one JSON item. A
 * result that cannot fit even then throws TEAMMATE_RESULT_TOO_LARGE (the call's
 * result_too_large). Items are stored in a fixed order (summary, then each finding's detail
 * and table), so the same input stores the same items.
 */
export async function buildTeammateResult(
  facts: TeammateRunFacts,
  submit: Current_ToolInputResultSubmit | null,
  store: ResultItemSink,
): Promise<Current_TeammateResult> {
  if (submit !== null && (!resultSubmitValid(submit) || facts.endReason !== "completed"))
    throw new TeammateResultError("TEAMMATE_RESULT_INPUT_INVALID");
  const base = {
    schemaVersion: 1 as const,
    organizationId: facts.organizationId,
    workspaceId: facts.workspaceId,
    parentRunId: facts.parentRunId,
    toolUseId: facts.toolUseId,
    runId: facts.runId,
    taskId: facts.taskId,
    installationId: facts.installationId,
    endReason: facts.endReason,
    created: facts.created.map((r) => ({ kind: r.kind, id: r.id })),
    readTags: facts.readTags.map((t) => ({ storeId: t.storeId, capability: t.capability })),
    taint: {
      contextTaint: facts.taint.contextTaint,
      sources: facts.taint.sources.map((s) => ({ ...s })),
    },
    completedAt: facts.completedAt,
  };
  if (submit === null) {
    const result: Current_TeammateResult = {
      ...base,
      outcome: codeOutcome(facts.endReason),
      counts: { checked: 0, missing: 0, questions: 0 },
      nextSteps: [],
      summary: null,
      findings: [],
      items: [],
    };
    return finish(result);
  }
  // The plan, measured with placeholder refs; then the stores, in a fixed order.
  const drafts = {
    summary: textItemDraft("Summary", submit.summary),
    details: submit.findings.map((f) => textItemDraft(f.title, f.detail)),
    tables: submit.findings.map((f) =>
      f.table === null ? null : tableItemDraft(f.title + " (table)", f.table),
    ),
  };
  const moved = { summary: false, details: new Set<number>(), tables: new Set<number>() };
  const refOf = (draft: ResultItemDraft, itemId: string): Current_ResultItemRef => ({
    itemId,
    kind: draft.kind,
    title: draft.title,
    sizeBytes: draft.sizeBytes,
    pageCount: draft.pageCount,
  });
  const shape = (ids: (draft: ResultItemDraft) => string, allFindings: ResultItemDraft | null) => {
    const items: Current_ResultItemRef[] = [];
    const stored = (draft: ResultItemDraft): string => {
      const itemId = ids(draft);
      items.push(refOf(draft, itemId));
      return itemId;
    };
    const as = (draft: ResultItemDraft): Current_TeammateText => ({
      kind: "item",
      itemId: stored(draft),
    });
    const summary: Current_TeammateText = moved.summary
      ? as(drafts.summary)
      : { kind: "text", text: submit.summary };
    const findings: Current_TeammateFinding[] = [];
    if (allFindings === null)
      submit.findings.forEach((f, i) => {
        const detail: Current_TeammateText = moved.details.has(i)
          ? as(drafts.details[i]!)
          : { kind: "text", text: f.detail };
        const table =
          f.table === null
            ? null
            : moved.tables.has(i)
              ? ({ kind: "item", itemId: stored(drafts.tables[i]!) } as const)
              : {
                  kind: "table" as const,
                  columns: [...f.table.columns],
                  rows: f.table.rows.map((r) => [...r]),
                };
        findings.push({
          kind: f.kind,
          title: f.title,
          detail,
          records: f.records.map((r) => ({ kind: r.kind, id: r.id })),
          value: f.value,
          unit: f.unit,
          table,
        });
      });
    else stored(allFindings);
    return {
      ...base,
      outcome: submit.outcome,
      counts: { ...submit.counts },
      nextSteps: [...submit.nextSteps],
      summary,
      findings,
      items,
    } satisfies Current_TeammateResult;
  };
  const measure = (allFindings: ResultItemDraft | null) =>
    jsonBytes(shape(() => placeholderId, allFindings));
  const parts: Part[] = [
    { at: "summary" as const, size: bytes(submit.summary) },
    ...submit.findings.map((f, i) => ({
      at: "detail" as const,
      finding: i,
      size: bytes(f.detail),
    })),
    ...submit.findings.flatMap((f, i) =>
      f.table === null ? [] : [{ at: "table" as const, finding: i, size: jsonBytes(f.table) }],
    ),
  ]
    // A part smaller than a reference to it never makes the result smaller by moving.
    .filter((part) => part.size > movableBytes)
    .sort((a, b) => b.size - a.size);
  let allFindings: ResultItemDraft | null = null;
  for (const part of parts) {
    if (measure(null) <= toolResultMaxBytes) break;
    if (part.at === "summary") moved.summary = true;
    else (part.at === "detail" ? moved.details : moved.tables).add(part.finding);
  }
  if (measure(null) > toolResultMaxBytes) {
    // Every finding, whole, in one JSON item; the summary moves too only if it must.
    moved.details.clear();
    moved.tables.clear();
    moved.summary = false;
    allFindings = textItemDraft(
      `Findings (${submit.findings.length})`,
      JSON.stringify(submit.findings, null, 2),
      "application/json",
    );
    if (measure(allFindings) > toolResultMaxBytes) moved.summary = true;
    if (measure(allFindings) > toolResultMaxBytes)
      throw new TeammateResultError("TEAMMATE_RESULT_TOO_LARGE");
  }
  // Store in the fixed order, then build with the real ids.
  const ids = new Map<ResultItemDraft, string>();
  const order: ResultItemDraft[] = [];
  if (moved.summary) order.push(drafts.summary);
  submit.findings.forEach((_, i) => {
    if (moved.details.has(i)) order.push(drafts.details[i]!);
    if (moved.tables.has(i)) order.push(drafts.tables[i]!);
  });
  if (allFindings !== null) order.push(allFindings);
  for (const draft of order) ids.set(draft, await store(draft));
  return finish(shape((draft) => ids.get(draft)!, allFindings));
}
function finish(result: Current_TeammateResult): Current_TeammateResult {
  if (!teammateResultValid(result)) throw new TeammateResultError("TEAMMATE_RESULT_INVALID");
  if (jsonBytes(result) > toolResultMaxBytes)
    throw new TeammateResultError("TEAMMATE_RESULT_TOO_LARGE");
  return deepFreeze(result);
}
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const itemIdsOf = (result: Current_TeammateResult) => {
  const referenced: string[] = [];
  if (result.summary?.kind === "item") referenced.push(result.summary.itemId);
  for (const f of result.findings) {
    if (f.detail.kind === "item") referenced.push(f.detail.itemId);
    if (f.table?.kind === "item") referenced.push(f.table.itemId);
  }
  return referenced;
};
/**
 * TeammateResult@1's code rules beyond its schema: items listed once; every item a summary,
 * detail or table names is listed; a metric alone has a value or a unit and a table finding
 * alone a table; inline rows have one cell per column.
 */
export function teammateResultValid(value: unknown): value is Current_TeammateResult {
  if (!validateCurrentDefinition("TeammateResult", value)) return false;
  const result = value as Current_TeammateResult;
  const listed = result.items.map((i) => i.itemId);
  if (new Set(listed).size !== listed.length) return false;
  if (itemIdsOf(result).some((id) => !listed.includes(id))) return false;
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
 * Whether a result may enter Morrow's turn (ADR-0037 item 3(a)): valid, and never with a
 * customer read tag (ADR-0031 items 2 and 6).
 */
export function acceptTeammateResult(
  value: unknown,
): "ok" | "result_customer_tagged" | "result_invalid" {
  if (!teammateResultValid(value)) return "result_invalid";
  return customerTagged(value.readTags) ? "result_customer_tagged" : "ok";
}

// --- Opening items ----------------------------------------------------------------------------
export type ItemOpenRefusal = "item_not_received" | "result_customer_tagged";
/** The ids of the items a set of results listed: what a run "received". */
export function receivedItemIds(results: readonly Current_TeammateResult[]): ReadonlySet<string> {
  return new Set(results.flatMap((r) => r.items.map((i) => i.itemId)));
}
/**
 * agent.result.read (ADR-0037 item 3(a)): Morrow opens an item only when it belongs to a
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
 * A called or handed-off teammate opens an item only when its brief names it and it belongs
 * to a result the calling Morrow run received; its own grants and the item's read tags are
 * checked as for any read (the loop, PR 4).
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
