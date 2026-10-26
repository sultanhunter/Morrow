import type { Current_ReadTag, Current_ReadTagCapability } from "@morrow/contracts";

// The memory foundation's code rules (H12a, docs/briefs/memory-foundation.md; ADR-0041 items 25
// to 30). Pure functions and closed data: no I/O, no model, no request body as authority.
// Migration 0057 holds the same rules in SQL and is the authority; these are its oracle (the
// tests compare the two) and the closed shapes the agent loop hands the memory definers. A model
// never sets any of these values: the loop computes them from the run's lease, its envelope and
// the tool results that entered its context.
//   * Every derived row carries an audience (the workspace, a subject, or one principal) and its
//     source subjects (ADR-0041 item 25). A read passes only if the reader may view every read
//     tag, every source subject is in the reader's subject view, and the audience is readable
//     by the reader's output audience; private-Ask content (audience: its owner) reaches only
//     that same owner's private runs.
//   * Taint is sticky and follows lineage: a union never drops a kind or a source (256 sources
//     inline, the rest counted, as ADR-0041 item 34 keeps RunTaint whole).
//   * Notebooks are an agent principal's (item 27): kinds, titles, a 90-day clock from the last
//     write or re-affirmation, and never written from a private Ask, by a run that read customer
//     data or by one that loaded person memory.
// H6 brings the client contracts (RunTaint, NotebookEntry@2, MemorySearchHit@1); until then these
// types stay inside the server.

const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const isId = (value: unknown): value is string => typeof value === "string" && id.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));

/** The bounds code and SQL (0057) hold alike. */
export const memoryLimits = Object.freeze({
  notebookLiveEntries: 1000,
  notebookShownEntries: 100,
  notebookTitleChars: 120,
  notebookTextChars: 2000,
  notebookDays: 90,
  sourceSubjects: 32,
  derivedFrom: 64,
  taintSources: 256,
  viewableTags: 256,
  scopeIds: 256,
  searchQueries: 5,
  searchQueryChars: 200,
  searchResults: 20,
  snippetChars: 280,
});

export type MemorySubjectKind = "goal" | "task" | "conversation";
export const memorySubjectKinds: readonly MemorySubjectKind[] = Object.freeze([
  "goal",
  "task",
  "conversation",
]);
/** One subject a derived row came from or is shown in: a project (its goal), a task or a conversation. */
export interface MemorySubject {
  readonly kind: MemorySubjectKind;
  readonly id: string;
}
export type MemoryAudience =
  | { readonly kind: "workspace" }
  | { readonly kind: "subject"; readonly subject: MemorySubject }
  | { readonly kind: "principal"; readonly principalId: string };
export type MemoryTaintKind = "other_member" | "untrusted_external";
/** ModelUntrustedSource with ADR-0041 item 34's and ADR-0040's additions (0057's list). */
export const memoryTaintSources = Object.freeze([
  "product",
  "inventory",
  "order_summary",
  "support_mail",
  "knowledge_page",
  "artifact",
  "report",
  "upload",
  "sandbox_output",
  "tool_result",
  "message",
  "teammate_result",
  "result_item",
  "notebook_entry",
  "conversation_summary",
  "person_memory",
  "context_checkpoint",
  "thread_post",
  "other_member",
] as const);
export type MemoryTaintSourceKind = (typeof memoryTaintSources)[number];
export interface MemoryTaintSource {
  readonly source: MemoryTaintSourceKind;
  readonly sourceId: string | null;
}
/** A row's or a run's taint: its kinds (sorted), its sources and how many more were counted. */
export interface MemoryTaint {
  readonly kinds: readonly MemoryTaintKind[];
  readonly sources: readonly MemoryTaintSource[];
  readonly omitted: number;
}
export const cleanTaint: MemoryTaint = Object.freeze({
  kinds: Object.freeze([]),
  sources: Object.freeze([]),
  omitted: 0,
});
/** A reader's subject view, decided in code under live grants: whole kinds, and named subjects. */
export interface MemorySubjectScope {
  readonly kinds: readonly MemorySubjectKind[];
  readonly ids: readonly MemorySubject[];
}
/** A read tag a reader may view (ReadTag@1's shape; the customer tag included, as a viewer may hold it). */
export interface MemoryViewableTag {
  readonly storeId: string | null;
  readonly capability: Current_ReadTagCapability;
}
export type MemoryLayer = "knowledge" | "notebook";
export const memoryLayers: readonly MemoryLayer[] = Object.freeze(["knowledge", "notebook"]);
export type NotebookEntryKind =
  | "lesson"
  | "correction"
  | "procedure"
  | "shop_fact"
  | "open_question";
export const notebookEntryKinds: readonly NotebookEntryKind[] = Object.freeze([
  "lesson",
  "correction",
  "procedure",
  "shop_fact",
  "open_question",
]);
/** One memory row a derived row came from (0057: a notebook entry or a knowledge page). */
export interface MemoryRef {
  readonly kind: "notebook_entry" | "knowledge_page";
  readonly id: string;
}
/**
 * What the loop knows about a run's memory (server-held, never model output): its taint, the
 * audience its output goes to and the subjects it works on (ADR-0041 item 25), whether it loaded
 * person memory (item 29), and what it may read: the tags it may view and its subject view, both
 * decided under live grants before the call.
 */
export interface MemoryRunFacts {
  readonly taint: MemoryTaint;
  readonly audience: MemoryAudience;
  readonly sourceSubjects: readonly MemorySubject[];
  readonly personMemoryLoaded: boolean;
  readonly viewableTags: readonly MemoryViewableTag[];
  readonly subjectScope: MemorySubjectScope;
}

const capabilities: readonly Current_ReadTagCapability[] = Object.freeze([
  "catalog.products.read",
  "inventory.levels.read",
  "orders.read",
  "support.case.read",
  "workspace.knowledge.read",
  "workspace.artifact.read",
]);
const distinctBy = <T>(items: readonly T[], key: (item: T) => string) =>
  new Set(items.map(key)).size === items.length;
const subjectKey = (s: MemorySubject) => s.kind + "\u0000" + s.id;

export function memorySubjectValid(value: unknown): value is MemorySubject {
  return (
    record(value) &&
    exactKeys(value, ["kind", "id"]) &&
    memorySubjectKinds.includes(value.kind as MemorySubjectKind) &&
    isId(value.id)
  );
}
/** At most 32 distinct subjects (any order: the definer sorts them). */
export function memorySubjectsValid(value: unknown): value is MemorySubject[] {
  return (
    Array.isArray(value) &&
    value.length <= memoryLimits.sourceSubjects &&
    value.every(memorySubjectValid) &&
    distinctBy(value as MemorySubject[], subjectKey)
  );
}
export function memoryAudienceValid(value: unknown): value is MemoryAudience {
  if (!record(value)) return false;
  if (value.kind === "workspace") return exactKeys(value, ["kind"]);
  if (value.kind === "subject")
    return exactKeys(value, ["kind", "subject"]) && memorySubjectValid(value.subject);
  if (value.kind === "principal")
    return exactKeys(value, ["kind", "principalId"]) && isId(value.principalId);
  return false;
}
function taintSourceValid(value: unknown): value is MemoryTaintSource {
  return (
    record(value) &&
    exactKeys(value, ["source", "sourceId"]) &&
    (memoryTaintSources as readonly string[]).includes(value.source as string) &&
    (value.sourceId === null || isId(value.sourceId))
  );
}
const taintSourceKey = (s: MemoryTaintSource) => s.source + "\u0000" + (s.sourceId ?? "\u0001");
/** 0057's memory_taint_valid: kinds sorted and distinct, no kind exactly when nothing is named. */
export function memoryTaintValid(value: unknown): value is MemoryTaint {
  if (!record(value) || !exactKeys(value, ["kinds", "sources", "omitted"])) return false;
  const { kinds, sources, omitted } = value;
  if (
    !Array.isArray(kinds) ||
    !Array.isArray(sources) ||
    typeof omitted !== "number" ||
    !Number.isSafeInteger(omitted) ||
    omitted < 0 ||
    omitted > 2147483647 ||
    kinds.length > 2 ||
    sources.length > memoryLimits.taintSources
  )
    return false;
  if (!kinds.every((k) => k === "other_member" || k === "untrusted_external")) return false;
  if (kinds.join(",") !== [...new Set(kinds)].sort().join(",")) return false;
  if (!sources.every(taintSourceValid) || !distinctBy(sources, taintSourceKey)) return false;
  return (kinds.length === 0) === (sources.length === 0 && omitted === 0);
}
export function memorySubjectScopeValid(value: unknown): value is MemorySubjectScope {
  return (
    record(value) &&
    exactKeys(value, ["kinds", "ids"]) &&
    Array.isArray(value.kinds) &&
    Array.isArray(value.ids) &&
    value.kinds.length <= memorySubjectKinds.length &&
    value.kinds.every((k) => memorySubjectKinds.includes(k as MemorySubjectKind)) &&
    new Set(value.kinds).size === value.kinds.length &&
    value.ids.length <= memoryLimits.scopeIds &&
    value.ids.every(memorySubjectValid)
  );
}
export function memoryViewableTagsValid(value: unknown): value is MemoryViewableTag[] {
  return (
    Array.isArray(value) &&
    value.length <= memoryLimits.viewableTags &&
    value.every(
      (t) =>
        record(t) &&
        exactKeys(t, ["storeId", "capability"]) &&
        capabilities.includes(t.capability as Current_ReadTagCapability) &&
        (t.storeId === null || isId(t.storeId)),
    ) &&
    distinctBy(value as MemoryViewableTag[], (t) => JSON.stringify([t.storeId, t.capability]))
  );
}
export function memoryRefValid(value: unknown): value is MemoryRef {
  return (
    record(value) &&
    exactKeys(value, ["kind", "id"]) &&
    (value.kind === "notebook_entry" || value.kind === "knowledge_page") &&
    isId(value.id)
  );
}
export function memoryRefsValid(value: unknown): value is MemoryRef[] {
  return (
    Array.isArray(value) &&
    value.length <= memoryLimits.derivedFrom &&
    value.every(memoryRefValid) &&
    distinctBy(value as MemoryRef[], (r) => r.kind + "\u0000" + r.id)
  );
}
export function memoryRunFactsValid(value: unknown): value is MemoryRunFacts {
  return (
    record(value) &&
    exactKeys(value, [
      "taint",
      "audience",
      "sourceSubjects",
      "personMemoryLoaded",
      "viewableTags",
      "subjectScope",
    ]) &&
    memoryTaintValid(value.taint) &&
    memoryAudienceValid(value.audience) &&
    memorySubjectsValid(value.sourceSubjects) &&
    typeof value.personMemoryLoaded === "boolean" &&
    memoryViewableTagsValid(value.viewableTags) &&
    memorySubjectScopeValid(value.subjectScope)
  );
}
export const memoryTainted = (taint: MemoryTaint): boolean => taint.kinds.length > 0;

// ---------------------------------------------------------------------------
// The read predicates and lineage rules (0057's memory_audience_readable,
// memory_subjects_viewable, memory_audience_narrow and memory_taint_union): oracles for the
// tests, and what H9c's people-facing reads apply in code.

/**
 * Whether a reader whose output goes to `reader` may read a row shown to `row`: workspace rows
 * to anyone; a subject's rows to that subject's work or to a person's private work (whose
 * source-subject check still applies); a person's rows only to that same person's private work.
 */
export function memoryAudienceReadable(row: MemoryAudience, reader: MemoryAudience): boolean {
  if (row.kind === "workspace") return true;
  if (row.kind === "subject")
    return (
      reader.kind === "principal" ||
      (reader.kind === "subject" && subjectKey(reader.subject) === subjectKey(row.subject))
    );
  return reader.kind === "principal" && reader.principalId === row.principalId;
}
/** Every source subject within the reader's subject view. */
export function memorySubjectsViewable(
  subjects: readonly MemorySubject[],
  scope: MemorySubjectScope,
): boolean {
  const named = new Set(scope.ids.map(subjectKey));
  return subjects.every((s) => scope.kinds.includes(s.kind) || named.has(subjectKey(s)));
}
/** Whether every read tag is one the reader may view (an empty list passes: 0057's `<@`). */
export function memoryTagsViewable(
  tags: readonly Current_ReadTag[],
  viewable: readonly MemoryViewableTag[],
): boolean {
  const keys = new Set(viewable.map((t) => JSON.stringify([t.storeId, t.capability])));
  return tags.every((t) => keys.has(JSON.stringify([t.storeId, t.capability])));
}
/** The narrower of two audiences, or null when no one audience covers both. */
export function memoryAudienceNarrow(a: MemoryAudience, b: MemoryAudience): MemoryAudience | null {
  if (a.kind === "workspace") return b;
  if (b.kind === "workspace") return a;
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  if (a.kind === "subject" && b.kind === "principal") return b;
  if (a.kind === "principal" && b.kind === "subject") return a;
  return null;
}
// PostgreSQL's COLLATE "C" order with NULLS FIRST, as memory_taint_union sorts sources.
const utf8 = new TextEncoder();
const byteCompare = (x: string, y: string) => {
  const a = utf8.encode(x),
    b = utf8.encode(y);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
};
/** The union of two taints: every kind, the sources distinct and ordered, 256 inline, the rest counted. */
export function memoryTaintUnion(a: MemoryTaint, b: MemoryTaint): MemoryTaint {
  const kinds = [...new Set([...a.kinds, ...b.kinds])].sort() as MemoryTaintKind[];
  const seen = new Map<string, MemoryTaintSource>();
  for (const s of [...a.sources, ...b.sources]) seen.set(taintSourceKey(s), s);
  const sorted = [...seen.values()].sort(
    (x, y) =>
      byteCompare(x.source, y.source) ||
      (x.sourceId === y.sourceId
        ? 0
        : x.sourceId === null
          ? -1
          : y.sourceId === null
            ? 1
            : byteCompare(x.sourceId, y.sourceId)),
  );
  const inline = sorted.slice(0, memoryLimits.taintSources);
  return Object.freeze({
    kinds: Object.freeze(kinds),
    sources: Object.freeze(inline.map((s) => Object.freeze({ ...s }))),
    omitted: Math.min(2147483647, a.omitted + b.omitted + (sorted.length - inline.length)),
  });
}

// ---------------------------------------------------------------------------
// Text a notebook never keeps (0057's memory_text_refused, the definer's backstop): an email
// address or a Shopify customer id. H9a's customer identifier screen runs in code first and
// covers more; this mirrors the SQL exactly so the two never disagree on what reaches it.
const email = /[A-Z0-9._%+-]+@[A-Z0-9-]+(\.[A-Z0-9-]+)*\.[A-Z]{2,}/i;
const customerGid = /gid:\/\/shopify\/Customer\//i;
export const memoryTextRefused = (text: string): boolean =>
  email.test(text) || customerGid.test(text);

/**
 * A notebook entry's title for an input that has none (the v1.1 notebook.write input carries
 * only its text; tool catalogue version 4 adds the title): the text's first non-blank line with
 * its spaces collapsed, cut at 120 characters with an ellipsis. Computed in code, never asked of
 * a model.
 */
export function notebookTitleFrom(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .find((l) => l.length > 0) ?? "";
  const chars = [...line];
  if (chars.length <= memoryLimits.notebookTitleChars) return line;
  return (
    chars
      .slice(0, memoryLimits.notebookTitleChars - 1)
      .join("")
      .trimEnd() + "…"
  );
}
