import type {
  Current_KnowledgePageKind,
  Current_ReadTag,
  Current_ToolRefusalCode,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import type { FixedSqlQuery } from "../../../identity/src/fixed-sql-transaction.js";
import {
  brandVoiceBlocks,
  decideKnowledgePropose,
  decideNotebookOperation,
  decideNotebookWrite,
  knowledgeLimits,
  viewable,
  type BrandVoicePage,
  type KnowledgeRunFacts,
  type NotebookWriteArgs,
  type TagViewer,
} from "@morrow/policy/knowledge";

// The agent side of shop knowledge (PR 20): the server-side commands of knowledge.propose and
// notebook.write (re-keyed by agent principal in H12a, migration 0057), the brand voice for Listings and knowledge.search's candidates, each sent
// inside one entered run lease (runLeaseStep's query; the agent loop, PR 11, owns the step and
// calls these as its tool-call step's dispatch, after lease re-entry, replay, its authority
// decision and the hold). Until the loop lands, the tests and lab:shop-knowledge drive them
// with a fake caller. Source-fixed statements, values only as bind parameters, every selected
// column text. Every decoder accepts only its definer's closed shape; anything else is
// RUNTIME_KNOWLEDGE_HELD, so the step fails and the loop retries it (reads run again; an
// internal write returns its first record, by run and tool_use id).
// Every read returns its content's read tags with it (each search hit's, the brand voice
// page's). The loop must union them into the run's KnowledgeRunFacts.readTags
// (withResultTags, @morrow/policy/knowledge) before any later tool call: a proposal or a
// notebook entry then carries at least the tags of the content it may be based on, so a
// viewer who may not see that content never reads it back through either (ADR-0031 item 6).
export const knowledgeRunSql = Object.freeze({
  page: "SELECT kind,version,read_tags FROM morrow_work.run_knowledge_page($1)",
  brandVoice: "SELECT page_id,version,body,read_tags FROM morrow_work.run_brand_voice()",
  search:
    "SELECT page_id,kind,version,title,body,read_tags FROM morrow_work.run_knowledge_search($1)",
  propose:
    "SELECT outcome,proposal_id FROM morrow_work.run_knowledge_propose($1,NULLIF($2,''),$3,$4,$5,$6,$7,$8)",
  // H12a (0057): notebook.write in the lease's own agent's notebook, with the run's memory facts.
  notebookWrite:
    "SELECT outcome,entry_id,sequence FROM morrow_work.run_notebook_write_v2($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),$7,$8,$9,$10,$11,$12,$13,$14)",
} as const);

const held = () => Error("RUNTIME_KNOWLEDGE_HELD");
type Row = Readonly<Record<string, unknown>>;
function exactRow(rows: readonly Row[], names: readonly string[]): Row {
  if (!Array.isArray(rows) || rows.length !== 1) throw held();
  const r = rows[0];
  if (
    !r ||
    typeof r !== "object" ||
    Object.keys(r).sort().join(",") !== [...names].sort().join(",")
  )
    throw held();
  return r;
}
const str = (r: Row, key: string) => {
  if (typeof r[key] !== "string") throw held();
  return r[key] as string;
};
function tags(r: Row): readonly Current_ReadTag[] {
  let value: unknown;
  try {
    value = JSON.parse(str(r, "read_tags"));
  } catch {
    throw held();
  }
  if (!validateCurrentDefinition("ReadTags", value)) throw held();
  return value as Current_ReadTag[];
}
const positive = (text: string) => {
  if (!/^[1-9][0-9]{0,6}$/.test(text)) throw held();
  return Number(text);
};
const toolUseId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** One tool call as the loop's step hands it over (server-held facts, never model output). */
export interface KnowledgeToolCall {
  readonly toolUseId: string;
  /** The recorded tool_use input (the model's, inside the tool's strict shape). */
  readonly input: unknown;
  readonly run: KnowledgeRunFacts;
  /** The run's decision on each read tag under its effective authority (the loop's). */
  readonly viewer: TagViewer;
}
export type KnowledgeToolResult =
  | {
      readonly outcome: "ok";
      readonly record: {
        readonly kind: "knowledge_proposal";
        readonly id: string;
      };
      readonly replayed: boolean;
    }
  | {
      readonly outcome: "refused";
      readonly refusal: Current_ToolRefusalCode;
    }
  | { readonly outcome: "invalid_input"; readonly refusal: "input_invalid" };
const refusedWith = (refusal: Current_ToolRefusalCode): KnowledgeToolResult =>
  Object.freeze({ outcome: "refused", refusal });
const definerRefusals: Readonly<Record<string, Current_ToolRefusalCode>> = Object.freeze({
  customer_data: "customer_data",
  pending_limit: "pending_limit",
  id_out_of_scope: "id_out_of_scope",
  lease_ended: "lease_ended",
  stopped: "stopped",
});

/**
 * knowledge.propose's dispatch: the code checks (decideKnowledgePropose), a page target the run
 * may see under its read tags (id_out_of_scope otherwise, the same as an absent or deleted
 * page), then run_knowledge_propose. The proposal grants nothing and changes no page.
 */
export async function knowledgeProposeStep(
  query: FixedSqlQuery,
  call: KnowledgeToolCall,
): Promise<KnowledgeToolResult> {
  if (!toolUseId(call.toolUseId)) throw held();
  const decided = decideKnowledgePropose(call.input, call.run);
  if (!decided.ok)
    return Object.freeze({
      outcome: decided.outcome,
      refusal: decided.refusal,
    }) as KnowledgeToolResult;
  const args = decided.args;
  if (args.pageId !== null) {
    const rows = await query(knowledgeRunSql.page, [args.pageId]);
    if (!Array.isArray(rows) || rows.length > 1) throw held();
    if (rows.length === 0) return refusedWith("id_out_of_scope");
    const page = exactRow(rows, ["kind", "version", "read_tags"]);
    if (str(page, "kind") !== args.kind || !viewable(call.viewer, tags(page)))
      return refusedWith("id_out_of_scope");
  }
  const r = exactRow(
    await query(knowledgeRunSql.propose, [
      call.toolUseId,
      args.pageId ?? "",
      args.kind,
      args.title,
      args.text,
      JSON.stringify(args.sources),
      JSON.stringify(args.readTags),
      args.taint,
    ]),
    ["outcome", "proposal_id"],
  );
  const outcome = str(r, "outcome");
  if (outcome === "applied" || outcome === "replay") {
    const id = str(r, "proposal_id");
    return Object.freeze({
      outcome: "ok",
      record: Object.freeze({ kind: "knowledge_proposal" as const, id }),
      replayed: outcome === "replay",
    });
  }
  if (r.proposal_id !== null) throw held();
  const refusal = definerRefusals[outcome];
  if (refusal) return refusedWith(refusal);
  // invalid or conflict: the code checks above passed, so the definer's own refusal of the
  // same input is a defect, never a result the model sees.
  throw held();
}

/**
 * What notebook.write did: `applied` (an entry added or replaced, or the target retired),
 * `renewed` (an identical live entry re-affirmed instead of duplicated) or `flagged` (a tainted
 * run named an untainted target, so the target stays and a repair flag records it; a replace
 * still adds its new, tainted entry). `record` is the entry written or renewed; a retire has none.
 */
export type NotebookWriteResult =
  | {
      readonly outcome: "ok";
      readonly effect: "applied" | "renewed" | "flagged";
      readonly record: { readonly kind: "notebook_entry"; readonly id: string } | null;
      readonly replayed: boolean;
    }
  | { readonly outcome: "refused"; readonly refusal: Current_ToolRefusalCode }
  | { readonly outcome: "invalid_input"; readonly refusal: "input_invalid" };
// The definer's outcomes past the code checks: each ok effect, its replay, and the refusals of
// state the code cannot see (the lease, the installation, a source or target out of reach, the
// notebook's room, and what the sources' unions carry).
const notebookEffects: Readonly<
  Record<string, { effect: "applied" | "renewed" | "flagged"; replayed: boolean }>
> = Object.freeze({
  applied: { effect: "applied", replayed: false },
  renewed: { effect: "renewed", replayed: false },
  flagged: { effect: "flagged", replayed: false },
  replay: { effect: "applied", replayed: true },
  replay_renewed: { effect: "renewed", replayed: true },
  replay_flagged: { effect: "flagged", replayed: true },
});
const notebookRefusals: Readonly<Record<string, Current_ToolRefusalCode>> = Object.freeze({
  customer_data: "customer_data",
  id_out_of_scope: "id_out_of_scope",
  // Sources whose audiences no one audience covers (two subjects, or two people).
  audience_conflict: "id_out_of_scope",
  lease_ended: "lease_ended",
  stopped: "stopped",
  // No room the run may make: the notebook holds 1,000 live entries and this tainted run has no
  // tainted one to supersede (it never erases an untainted entry), or the notebook's million
  // sequences are used. A capacity limit; H5's contract edit adds precise codes.
  notebook_full: "pending_limit",
  notebook_exhausted: "pending_limit",
});
// What the write would carry past an entry's bounds once the definer unions the run with every
// source it names (their subjects, their lineage closed over pages with a replace's target, their
// read tags with the store's artifact tag): state the code cannot see, so the model's input as
// composed is refused (input_invalid until H5 adds precise codes), never a held step the loop
// would retry forever.
const notebookOverflows: ReadonlySet<string> = new Set([
  "too_many_subjects",
  "lineage_too_large",
  "tags_overflow",
]);
async function notebookDispatch(
  query: FixedSqlQuery,
  toolUseIdValue: string,
  args: NotebookWriteArgs,
): Promise<NotebookWriteResult> {
  const o = args.operation;
  const m = args.memory;
  const content = o.op === "retire" ? null : o;
  const r = exactRow(
    await query(knowledgeRunSql.notebookWrite, [
      toolUseIdValue,
      o.op,
      o.op === "add" ? "" : o.targetId,
      content?.kind ?? "",
      content?.title ?? "",
      content?.text ?? "",
      JSON.stringify(args.readTags),
      JSON.stringify(m.taint),
      JSON.stringify(m.audience),
      JSON.stringify(m.sourceSubjects),
      JSON.stringify(content?.derivedFrom ?? []),
      JSON.stringify(m.viewableTags),
      JSON.stringify(m.subjectScope),
      m.personMemoryLoaded ? "true" : "false",
    ]),
    ["outcome", "entry_id", "sequence"],
  );
  const outcome = str(r, "outcome");
  const effect = notebookEffects[outcome];
  if (effect) {
    // An add, a replace or a renewal names its entry; a retire (and its flag) names none.
    const named = r.entry_id !== null;
    if (named !== (o.op !== "retire")) throw held();
    if (named) positive(str(r, "sequence"));
    else if (r.sequence !== null) throw held();
    return Object.freeze({
      outcome: "ok",
      effect: effect.effect,
      record: named
        ? Object.freeze({ kind: "notebook_entry" as const, id: str(r, "entry_id") })
        : null,
      replayed: effect.replayed,
    });
  }
  if (r.entry_id !== null || r.sequence !== null) throw held();
  const refusal = notebookRefusals[outcome];
  if (refusal) return Object.freeze({ outcome: "refused", refusal });
  if (notebookOverflows.has(outcome))
    return Object.freeze({ outcome: "invalid_input", refusal: "input_invalid" });
  // invalid, ask_bound or person_memory_loaded: the code checks above ruled each out (the
  // input's shape, the private Ask, person memory), and conflict is the same call id sent with
  // other content: each a defect, never a result the model sees.
  throw held();
}

/**
 * notebook.write's dispatch for the v1.1 input ({text}): the code checks
 * (decideNotebookWrite), then run_notebook_write_v2 in the lease's own agent's notebook.
 */
export async function notebookWriteStep(
  query: FixedSqlQuery,
  call: KnowledgeToolCall,
): Promise<NotebookWriteResult> {
  if (!toolUseId(call.toolUseId)) throw held();
  const decided = decideNotebookWrite(call.input, call.run);
  if (!decided.ok)
    return Object.freeze({
      outcome: decided.outcome,
      refusal: decided.refusal,
    }) as NotebookWriteResult;
  return notebookDispatch(query, call.toolUseId, decided.args);
}

/**
 * One full notebook operation (add, replace or retire, with its sources): decideNotebookOperation,
 * then the same definer. Tool catalogue version 4 (H5) dispatches notebook.write {op} here.
 */
export async function notebookOperationStep(
  query: FixedSqlQuery,
  call: Omit<KnowledgeToolCall, "input"> & { readonly operation: unknown },
): Promise<NotebookWriteResult> {
  if (!toolUseId(call.toolUseId)) throw held();
  const decided = decideNotebookOperation(call.operation, call.run);
  if (!decided.ok)
    return Object.freeze({
      outcome: decided.outcome,
      refusal: decided.refusal,
    }) as NotebookWriteResult;
  return notebookDispatch(query, call.toolUseId, decided.args);
}

/** The accepted brand voice for a Listings run (marked data), or null. */
export async function brandVoiceForRun(query: FixedSqlQuery): Promise<BrandVoicePage | null> {
  const rows = await query(knowledgeRunSql.brandVoice, []);
  if (!Array.isArray(rows) || rows.length > 1) throw held();
  if (rows.length === 0) return null;
  const r = exactRow(rows, ["page_id", "version", "body", "read_tags"]);
  const text = str(r, "body");
  if (!validateCurrentDefinition("KnowledgeText", text)) throw held();
  return Object.freeze({
    pageId: str(r, "page_id"),
    version: positive(str(r, "version")),
    text,
    readTags: tags(r),
  });
}
/** The brand voice of one Listings turn, with the read tags of the content it carries. */
export interface ListingsBrandVoice {
  readonly blocks: ReturnType<typeof brandVoiceBlocks>;
  /**
   * The page's read tags when `blocks` carry its text, [] otherwise. The loop unions them into
   * the run's KnowledgeRunFacts.readTags (withResultTags) before any later tool call.
   */
  readonly readTags: readonly Current_ReadTag[];
}
const noBrandVoice: ListingsBrandVoice = Object.freeze({
  blocks: Object.freeze([]),
  readTags: Object.freeze([]),
});
/**
 * The brand voice blocks of a Listings turn: the accepted page as marked data, if viewable,
 * with the page's read tags. `agentTools` is the shop-knowledge switch's (committed off): while
 * it is off, Listings gets no brand voice and nothing is read.
 */
export async function listingsBrandVoice(
  query: FixedSqlQuery,
  viewer: TagViewer,
  agentTools: "on" | "off",
): Promise<ListingsBrandVoice> {
  if (agentTools !== "on") return noBrandVoice;
  const page = await brandVoiceForRun(query);
  const blocks = brandVoiceBlocks(page, viewer);
  if (page === null || blocks.length === 0) return noBrandVoice;
  return Object.freeze({ blocks, readTags: page.readTags });
}

export interface KnowledgeSearchHit {
  readonly pageId: string;
  readonly kind: Current_KnowledgePageKind;
  readonly version: number;
  readonly title: string;
  readonly text: string;
  /** The page's read tags: the loop unions them into the run's (withResultTags). */
  readonly readTags: readonly Current_ReadTag[];
}
/**
 * knowledge.search's candidates for one run: the full-text hits whose every read tag the run
 * may view (ADR-0031 item 6), at most `limit` (1 to 10), each with those tags. Page text is
 * data, never instructions.
 */
export async function knowledgeSearchForRun(
  query: FixedSqlQuery,
  viewer: TagViewer,
  searchText: string,
  limit: number,
): Promise<readonly KnowledgeSearchHit[]> {
  if (
    typeof searchText !== "string" ||
    !validateCurrentDefinition("ToolInputKnowledgeSearch", { searchText, limit })
  )
    throw held();
  const rows = await query(knowledgeRunSql.search, [searchText]);
  if (!Array.isArray(rows) || rows.length > 200) throw held();
  const hits: KnowledgeSearchHit[] = [];
  for (const row of rows) {
    const r = exactRow([row], ["page_id", "kind", "version", "title", "body", "read_tags"]);
    const readTags = tags(r);
    if (!viewable(viewer, readTags)) continue;
    hits.push(
      Object.freeze({
        pageId: str(r, "page_id"),
        kind: str(r, "kind") as Current_KnowledgePageKind,
        version: positive(str(r, "version")),
        title: str(r, "title"),
        text: str(r, "body"),
        readTags: Object.freeze(readTags),
      }),
    );
    if (hits.length >= Math.min(limit, knowledgeLimits.searchResults)) break;
  }
  return Object.freeze(hits);
}
