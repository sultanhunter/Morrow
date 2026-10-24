import type {
  Current_KnowledgePageKind,
  Current_KnowledgeSource,
  Current_ReadTag,
} from "@morrow/contracts";
import { validateCurrentDefinition, validateDefinition } from "@morrow/contracts/validation";
import shopKnowledgeSwitch from "../../../../docs/decisions/shop-knowledge-staging.json";

// Shop knowledge and notebooks (PR 20, docs/briefs/shop-knowledge.md; ADR-0031 items 1, 2, 4
// and 6). Pure rules and closed data: no I/O, no model, no request body as authority.
//   * A page has a closed kind, a title and typed text in versions, each with up to five
//     sources. Every version is a person's act (written, or an agent's proposal accepted).
//   * Read tags are computed by the server (SQL knowledge_read_tags, mirrored here as the
//     test oracle): one workspace.knowledge.read tag per linked store (a null store before
//     any store is linked, as ReadTag@1 allows for the workspace capabilities), and for a
//     product_fact page also the store's catalogue tag. A version accepted from a proposal
//     adds the proposing run's tags. Nothing in knowledge carries the customer tag.
//   * The switch (docs/decisions/shop-knowledge-staging.json) is committed off.

export const knowledgeKinds: readonly Current_KnowledgePageKind[] = Object.freeze([
  "brand_voice",
  "policy",
  "product_fact",
  "supplier",
  "decision",
]);
export const isKnowledgeKind = (value: unknown): value is Current_KnowledgePageKind =>
  typeof value === "string" && (knowledgeKinds as readonly string[]).includes(value);

/** The bounds code and SQL hold alike. */
export const knowledgeLimits = Object.freeze({
  titleChars: 120,
  textChars: 8000,
  sources: 5,
  sourceChars: 200,
  versionsPerPage: 1000,
  pagesPerWorkspace: 500,
  pendingProposalsPerWorkspace: 50,
  notebookTextChars: 2000,
  notebookLiveEntries: 100,
  notebookDays: 90,
  searchTextChars: 200,
  searchResults: 20,
  readTags: 24,
});

/**
 * Typed text PostgreSQL can hold: a NUL character never reaches SQL (a text value cannot carry
 * one, so a definer would fail on it instead of refusing it). The contract's patterns allow it,
 * so code refuses it at every trust boundary: the routes' bodies and the agent tools' inputs.
 */
export const storableText = (value: string): boolean => !value.includes("\u0000");

const productId = /^product:[1-9][0-9]{0,19}$/;
/** One source's value against its kind: a product id, a Morrow id, or a short note. */
export function sourceValid(source: unknown): source is Current_KnowledgeSource {
  if (!validateCurrentDefinition("KnowledgeSource", source)) return false;
  const s = source as Current_KnowledgeSource;
  if (!storableText(s.value)) return false;
  if (s.kind === "product") return productId.test(s.value);
  if (s.kind === "task") return validateDefinition("core", "Id", s.value);
  return true;
}
/** A version's sources: KnowledgeSources@1 and each value valid for its kind. */
export function sourcesValid(sources: unknown): sources is Current_KnowledgeSource[] {
  return (
    validateCurrentDefinition("KnowledgeSources", sources) &&
    (sources as unknown[]).every((s) => sourceValid(s))
  );
}

/** The customer tag (ADR-0031 Terms): never on knowledge, a proposal or a notebook entry. */
export const customerTag = "support.case.read";
export const customerTagged = (tags: readonly Current_ReadTag[]): boolean =>
  tags.some((tag) => tag.capability === customerTag);

/**
 * The read tags the server computes for a page of `kind` in a workspace whose linked stores
 * are `storeIds` (SQL knowledge_read_tags; this is its oracle). Sorted by store then
 * capability, as SQL aggregates them.
 */
export function knowledgeTagsFor(
  kind: Current_KnowledgePageKind,
  storeIds: readonly string[],
): readonly Current_ReadTag[] {
  if (storeIds.length === 0)
    return Object.freeze([
      Object.freeze({ storeId: null, capability: "workspace.knowledge.read" as const }),
    ]);
  const tags: Current_ReadTag[] = [];
  for (const storeId of [...new Set(storeIds)].sort()) {
    if (kind === "product_fact") tags.push({ storeId, capability: "catalog.products.read" });
    tags.push({ storeId, capability: "workspace.knowledge.read" });
  }
  return Object.freeze(tags.map((t) => Object.freeze(t)));
}
const tagKey = (t: Current_ReadTag) => JSON.stringify([t.storeId, t.capability]);
/** The union of tag lists, distinct; null when it would exceed ReadTags' 24. */
export function unionTags(
  ...lists: readonly (readonly Current_ReadTag[])[]
): readonly Current_ReadTag[] | null {
  const seen = new Map<string, Current_ReadTag>();
  for (const list of lists) for (const tag of list) seen.set(tagKey(tag), tag);
  if (seen.size > knowledgeLimits.readTags) return null;
  return Object.freeze([...seen.values()]);
}

/** A viewer's decision on one read tag (the work API asks the kernel; the loop, the run's authority). */
export interface TagViewer {
  mayView(tag: Current_ReadTag): boolean;
}
/** ADR-0031 item 6: an item is shown only when the viewer may view every one of its tags. */
export const viewable = (viewer: TagViewer, tags: readonly Current_ReadTag[]): boolean =>
  tags.length > 0 && tags.every((tag) => viewer.mayView(tag));

/** docs/decisions/shop-knowledge-staging.json, read once (committed off). */
export const shopKnowledgeRecord: Readonly<{
  switch: "on" | "off";
  agent_tools: "on" | "off";
}> = Object.freeze({
  switch: shopKnowledgeSwitch.switch === "on" ? "on" : "off",
  agent_tools: shopKnowledgeSwitch.agent_tools === "on" ? "on" : "off",
});
/**
 * The switch rule edge:check enforces (scripts/edge.mjs reviewedShopKnowledgeRecord): the
 * person routes go on only once a reviewed grant template issues the workspace.knowledge.*
 * grants (none does yet), and the agent tools only once the routes are on (a proposal
 * needs a person to accept it) and the agent loop is on (ADR-0027 item 11).
 */
export function shopKnowledgeSwitchAllowed(input: {
  readonly routes: "on" | "off";
  readonly agentTools: "on" | "off";
  readonly grantsIssued: boolean;
  readonly agentLoop: "on" | "off";
}): boolean {
  if (input.routes === "on" && !input.grantsIssued) return false;
  if (input.agentTools === "on" && (input.routes !== "on" || input.agentLoop !== "on"))
    return false;
  return true;
}
