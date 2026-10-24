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
  decideNotebookWrite,
  knowledgeLimits,
  viewable,
  type BrandVoicePage,
  type KnowledgeRunFacts,
  type TagViewer,
} from "@morrow/policy/knowledge";

// The agent side of shop knowledge (PR 20): the server-side commands of knowledge.propose and
// notebook.write, the brand voice for Listings and knowledge.search's candidates, each sent
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
  notebookWrite: "SELECT outcome,entry_id,sequence FROM morrow_work.run_notebook_write($1,$2,$3)",
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
        readonly kind: "knowledge_proposal" | "notebook_entry";
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

/** notebook.write's dispatch: the code checks, then run_notebook_write (its own notebook only). */
export async function notebookWriteStep(
  query: FixedSqlQuery,
  call: KnowledgeToolCall,
): Promise<KnowledgeToolResult> {
  if (!toolUseId(call.toolUseId)) throw held();
  const decided = decideNotebookWrite(call.input, call.run);
  if (!decided.ok)
    return Object.freeze({
      outcome: decided.outcome,
      refusal: decided.refusal,
    }) as KnowledgeToolResult;
  const r = exactRow(
    await query(knowledgeRunSql.notebookWrite, [
      call.toolUseId,
      decided.args.text,
      JSON.stringify(decided.args.readTags),
    ]),
    ["outcome", "entry_id", "sequence"],
  );
  const outcome = str(r, "outcome");
  if (outcome === "applied" || outcome === "replay") {
    positive(str(r, "sequence"));
    return Object.freeze({
      outcome: "ok",
      record: Object.freeze({ kind: "notebook_entry" as const, id: str(r, "entry_id") }),
      replayed: outcome === "replay",
    });
  }
  if (r.entry_id !== null) throw held();
  const refusal = definerRefusals[outcome];
  if (refusal) return refusedWith(refusal);
  throw held();
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
