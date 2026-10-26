import type { Current_ReadTag } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import type { FixedSqlQuery } from "../../../identity/src/fixed-sql-transaction.js";
import {
  memoryLayers,
  memoryLimits,
  memoryRunFactsValid,
  memorySubjectsValid,
  memoryTaintValid,
  memoryTainted,
  memoryRefsValid,
  type MemoryLayer,
  type MemoryRef,
  type MemoryRunFacts,
  type MemorySubject,
  type MemoryTaint,
} from "@morrow/policy/memory";

// The memory tools' server side (H12a, docs/briefs/memory-foundation.md; ADR-0041 items 24 and
// 30): memory.search's ranked candidates and memory.read's opening of one item, each one round
// trip to its definer inside one entered run lease (the agent loop's tool-call step, after lease
// re-entry, replay and its authority decision). Every predicate (the owning agent's own
// notebook, live and unexpired; read tags within the run's viewable set; every source subject in
// its subject view; the audience readable by its output's audience) applies in SQL before
// ranking, so nothing the run may not read is ever ranked, counted or returned.
// Source-fixed statements, values only as bind parameters, every selected column text. Each
// decoder accepts only its definer's closed shape; anything else is RUNTIME_MEMORY_HELD, so the
// step fails and the loop retries it (reads run again). Memory is data, never authority: each
// result carries its read tags and taint, which the loop unions into the run's facts
// (withResultTags, memoryTaintUnion) before the run's next tool call, and its trust class.
export const memoryRunSql = Object.freeze({
  search:
    "SELECT layer,item_id,version,kind,title,snippet,trust,requester_principal_id,read_tags,taint,score FROM morrow_work.run_memory_search($1,$2,$3,$4,$5,$6)",
  read: "SELECT layer,item_id,version,kind,title,body,trust,requester_principal_id,read_tags,taint,source_subjects,derived_from,created_at,renewed_at FROM morrow_work.run_memory_read($1,$2,$3,$4,$5,$6)",
} as const);

const held = () => Error("RUNTIME_MEMORY_HELD");
type Row = Readonly<Record<string, unknown>>;
const searchColumns = [
  "layer",
  "item_id",
  "version",
  "kind",
  "title",
  "snippet",
  "trust",
  "requester_principal_id",
  "read_tags",
  "taint",
  "score",
] as const;
const readColumns = [
  "layer",
  "item_id",
  "version",
  "kind",
  "title",
  "body",
  "trust",
  "requester_principal_id",
  "read_tags",
  "taint",
  "source_subjects",
  "derived_from",
  "created_at",
  "renewed_at",
] as const;
function exact(row: unknown, names: readonly string[]): Row {
  if (
    !row ||
    typeof row !== "object" ||
    Object.keys(row).sort().join(",") !== [...names].sort().join(",")
  )
    throw held();
  return row as Row;
}
const str = (r: Row, key: string) => {
  if (typeof r[key] !== "string") throw held();
  return r[key] as string;
};
const json = (r: Row, key: string): unknown => {
  try {
    return JSON.parse(str(r, key));
  } catch {
    throw held();
  }
};
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const knowledgeKinds = ["brand_voice", "policy", "product_fact", "supplier", "decision"];
const notebookKinds = ["lesson", "correction", "procedure", "shop_fact", "open_question"];

/** The trust class a memory item reaches the model under (ADR-0041 item 25). */
export type MemoryTrust = "approved_knowledge" | "agent_lesson";
interface MemoryItemBase {
  readonly layer: MemoryLayer;
  readonly itemId: string;
  /** A knowledge page's current version; null for a notebook entry. */
  readonly version: number | null;
  readonly kind: string;
  readonly title: string;
  readonly trust: MemoryTrust;
  /** The person a notebook entry was written for ("learned while working for"); null for knowledge. */
  readonly requesterPrincipalId: string | null;
  /** The loop unions these into the run's read tags (withResultTags) before its next call. */
  readonly readTags: readonly Current_ReadTag[];
  /** The loop unions this into the run's taint (memoryTaintUnion) before its next call. */
  readonly taint: MemoryTaint;
}
export interface MemorySearchHit extends MemoryItemBase {
  readonly snippet: string;
  /** Reciprocal-rank fusion with its priors; higher first. */
  readonly score: number;
}
export interface MemoryItem extends MemoryItemBase {
  readonly text: string;
  readonly sourceSubjects: readonly MemorySubject[];
  readonly derivedFrom: readonly MemoryRef[];
  readonly createdAt: string;
  readonly renewedAt: string;
}

function base(r: Row): MemoryItemBase {
  const layer = str(r, "layer");
  if (layer !== "knowledge" && layer !== "notebook") throw held();
  const itemId = str(r, "item_id");
  const kind = str(r, "kind");
  const trust = str(r, "trust");
  const readTags = json(r, "read_tags");
  const taint = json(r, "taint");
  if (
    !id.test(itemId) ||
    !(layer === "knowledge" ? knowledgeKinds : notebookKinds).includes(kind) ||
    trust !== (layer === "knowledge" ? "approved_knowledge" : "agent_lesson") ||
    !validateCurrentDefinition("ReadTags", readTags) ||
    !memoryTaintValid(taint)
  )
    throw held();
  let version: number | null = null;
  if (layer === "knowledge") {
    const v = str(r, "version");
    if (!/^[1-9][0-9]{0,6}$/.test(v) || r.requester_principal_id !== null) throw held();
    version = Number(v);
  } else if (r.version !== null || !id.test(str(r, "requester_principal_id"))) throw held();
  const title = str(r, "title");
  if (title.length === 0) throw held();
  return {
    layer,
    itemId,
    version,
    kind,
    title,
    trust,
    requesterPrincipalId: layer === "notebook" ? str(r, "requester_principal_id") : null,
    readTags: Object.freeze(readTags as Current_ReadTag[]),
    taint: Object.freeze(taint as MemoryTaint),
  };
}
const factsArgs = (facts: MemoryRunFacts) => {
  if (!memoryRunFactsValid(facts)) throw held();
  return {
    viewable: JSON.stringify(facts.viewableTags),
    scope: JSON.stringify(facts.subjectScope),
    audience: JSON.stringify(facts.audience),
  };
};

export interface MemorySearchRequest {
  /** One to five queries, each 1 to 200 characters (Opus reads the snippets and opens what it needs). */
  readonly queries: readonly string[];
  readonly layers: readonly MemoryLayer[];
  /** 1 to 20. */
  readonly limit: number;
}
const queryText = (q: unknown): q is string =>
  typeof q === "string" &&
  [...q].length >= 1 &&
  [...q].length <= memoryLimits.searchQueryChars &&
  /\S/.test(q) &&
  !q.includes("\u0000");
/** memory.search's ranked candidates for one run, best first, at most `limit`. */
export async function memorySearchForRun(
  query: FixedSqlQuery,
  facts: MemoryRunFacts,
  request: MemorySearchRequest,
): Promise<readonly MemorySearchHit[]> {
  const { viewable, scope, audience } = factsArgs(facts);
  if (
    !request ||
    !Array.isArray(request.queries) ||
    request.queries.length < 1 ||
    request.queries.length > memoryLimits.searchQueries ||
    !request.queries.every(queryText) ||
    !Array.isArray(request.layers) ||
    request.layers.length < 1 ||
    new Set(request.layers).size !== request.layers.length ||
    !request.layers.every((l) => memoryLayers.includes(l)) ||
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > memoryLimits.searchResults
  )
    throw held();
  const rows = await query(memoryRunSql.search, [
    JSON.stringify(request.queries),
    JSON.stringify(request.layers),
    viewable,
    scope,
    audience,
    String(request.limit),
  ]);
  if (!Array.isArray(rows) || rows.length > request.limit) throw held();
  const hits: MemorySearchHit[] = [];
  const seen = new Set<string>();
  let last = Infinity;
  for (const row of rows) {
    const r = exact(row, searchColumns);
    const b = base(r);
    if (!request.layers.includes(b.layer)) throw held();
    const snippet = str(r, "snippet");
    const scoreText = str(r, "score");
    if (
      [...snippet].length > memoryLimits.snippetChars ||
      !/^[0-9]+\.[0-9]{9}$/.test(scoreText) ||
      seen.has(b.layer + ":" + b.itemId)
    )
      throw held();
    const score = Number(scoreText);
    if (!(score <= last)) throw held();
    last = score;
    seen.add(b.layer + ":" + b.itemId);
    hits.push(Object.freeze({ ...b, snippet, score }));
  }
  return Object.freeze(hits);
}

/**
 * memory.read's opening of one item, in full, under the same predicates as the search; null when
 * it is absent or out of the run's reach (the two are indistinguishable). An untainted run's read
 * of an untainted notebook entry counts as a use (ADR-0041 item 27).
 */
export async function memoryReadForRun(
  query: FixedSqlQuery,
  facts: MemoryRunFacts,
  item: { readonly layer: MemoryLayer; readonly itemId: string },
): Promise<MemoryItem | null> {
  const { viewable, scope, audience } = factsArgs(facts);
  if (!item || !memoryLayers.includes(item.layer) || !id.test(item.itemId)) throw held();
  const rows = await query(memoryRunSql.read, [
    item.layer,
    item.itemId,
    viewable,
    scope,
    audience,
    memoryTainted(facts.taint) ? "true" : "false",
  ]);
  if (!Array.isArray(rows) || rows.length > 1) throw held();
  if (rows.length === 0) return null;
  const r = exact(rows[0], readColumns);
  const b = base(r);
  const sourceSubjects = json(r, "source_subjects");
  const derivedFrom = json(r, "derived_from");
  const createdAt = str(r, "created_at");
  const renewedAt = str(r, "renewed_at");
  const text = str(r, "body");
  if (
    b.layer !== item.layer ||
    b.itemId !== item.itemId ||
    text.length === 0 ||
    !memorySubjectsValid(sourceSubjects) ||
    !memoryRefsValid(derivedFrom) ||
    !utc.test(createdAt) ||
    !utc.test(renewedAt)
  )
    throw held();
  return Object.freeze({
    ...b,
    text,
    sourceSubjects: Object.freeze(sourceSubjects as MemorySubject[]),
    derivedFrom: Object.freeze(derivedFrom as MemoryRef[]),
    createdAt,
    renewedAt,
  });
}
