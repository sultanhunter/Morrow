import type { Current_KnowledgePageKind, Current_KnowledgeSource } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { isKnowledgeKind, sourcesValid } from "@morrow/policy/knowledge";

// Closed request bodies of the knowledge and notebook routes (PR 20). Each parser returns a
// fresh plain object or null. Tenant, workspace, actor, grant, role, read tags, author and
// version numbers the server assigns are never body fields: the server computes the read tags
// and the next version, and an accept names only the proposal digest the person saw.
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || !own.every((key) => keys.includes(key))) return null;
  return value as Record<string, unknown>;
}
const version = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 1000;
const hex64 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

interface Content {
  readonly title: string;
  readonly text: string;
  readonly sources: readonly Current_KnowledgeSource[];
}
function content(r: Record<string, unknown>): Content | null {
  if (
    !validateCurrentDefinition("KnowledgeTitle", r.title) ||
    !validateCurrentDefinition("KnowledgeText", r.text) ||
    !sourcesValid(r.sources)
  )
    return null;
  return {
    title: r.title as string,
    text: r.text as string,
    sources: (r.sources as Current_KnowledgeSource[]).map((s) => ({
      kind: s.kind,
      value: s.value,
    })),
  };
}

export interface PageCreateBody extends Content {
  readonly kind: Current_KnowledgePageKind;
}
/** POST /knowledge/pages: a new page's kind and its first version (typed text only). */
export function parsePageCreateBody(body: unknown): PageCreateBody | null {
  const r = record(body, ["kind", "title", "text", "sources"]);
  if (!r || !isKnowledgeKind(r.kind)) return null;
  const c = content(r);
  return c ? Object.freeze({ kind: r.kind, ...c }) : null;
}
export interface VersionBody extends Content {
  readonly expectedVersion: number;
}
/** POST /knowledge/pages/:pageId/versions: the next version, at the version the person read. */
export function parseVersionBody(body: unknown): VersionBody | null {
  const r = record(body, ["expectedVersion", "title", "text", "sources"]);
  if (!r || !version(r.expectedVersion)) return null;
  const c = content(r);
  return c ? Object.freeze({ expectedVersion: r.expectedVersion, ...c }) : null;
}
export interface DeleteBody {
  readonly expectedVersion: number;
}
/** POST /knowledge/pages/:pageId/delete: the version the person read. */
export function parseDeleteBody(body: unknown): DeleteBody | null {
  const r = record(body, ["expectedVersion"]);
  return r && version(r.expectedVersion)
    ? Object.freeze({ expectedVersion: r.expectedVersion })
    : null;
}
export interface DecisionBody {
  readonly digest: string;
}
/** POST /knowledge/proposals/:proposalId/(accept|reject): the digest the person saw. */
export function parseDecisionBody(body: unknown): DecisionBody | null {
  const r = record(body, ["digest"]);
  return r && hex64(r.digest) ? Object.freeze({ digest: r.digest }) : null;
}
/** POST /agents/:installationId/notebook/clear: an empty object. */
export function parseClearBody(body: unknown): Record<string, never> | null {
  return record(body, []) ? Object.freeze({}) : null;
}
/** GET /knowledge/search?text=: 1 to 200 characters with a non-space, no control character. */
export function searchText(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length < 1 || [...text].length > 200 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}
