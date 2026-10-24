// PR 20 shop knowledge: closed decoders of the knowledge routes' replies (internal JSON between
// the api Worker and this SPA; docs/contracts/work-api.md "Shop knowledge and notebooks"). A
// body that does not match exactly decodes to null, which the work outcome mapping turns into
// an unconfirmed read or an uncertain command, never a guess. The server already left out every
// page and suggestion this person may not see; no read tag ever reaches this side.
import {
  knowledgePageKinds,
  type KnowledgeItemView,
  type KnowledgePageKind,
  type KnowledgePageView,
  type KnowledgeView,
} from "@morrow/workspace-ui";
import { isId } from "./client";
import { isUtcTime } from "./work-decoders";

type Json = Readonly<Record<string, unknown>>;
const record = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keysOf = (value: Json, required: readonly string[], optional: readonly string[] = []) => {
  const keys = Object.keys(value);
  return (
    required.every((k) => keys.includes(k)) &&
    keys.every((k) => required.includes(k) || optional.includes(k))
  );
};
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && [...value].length <= max && /\S/.test(value);
const version = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 1000;
const kind = (value: unknown): value is KnowledgePageKind =>
  typeof value === "string" && (knowledgePageKinds as readonly string[]).includes(value);
const hex64 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const day = (utc: string) => utc.slice(0, 10);
interface Source {
  readonly kind: "product" | "task" | "note";
  readonly value: string;
}
function sources(value: unknown): readonly Source[] | null {
  if (!Array.isArray(value) || value.length > 5) return null;
  const out: Source[] = [];
  for (const s of value) {
    if (
      !record(s) ||
      !keysOf(s, ["kind", "value"]) ||
      (s.kind !== "product" && s.kind !== "task" && s.kind !== "note") ||
      !text(s.value, 200)
    )
      return null;
    out.push({ kind: s.kind, value: s.value });
  }
  return out;
}

/** GET /work/knowledge/pages: the viewer's pages (an excerpt each) and what they may do. */
export function decodeKnowledgePages(body: unknown): {
  readonly facts: readonly KnowledgeItemView[];
  readonly may: KnowledgeView["may"];
} | null {
  if (
    !record(body) ||
    !keysOf(body, ["schemaVersion", "pages", "pendingProposals", "may"]) ||
    body.schemaVersion !== 1 ||
    !Array.isArray(body.pages) ||
    body.pages.length > 500 ||
    typeof body.pendingProposals !== "number" ||
    !record(body.may) ||
    !keysOf(body.may, ["write", "delete"]) ||
    typeof body.may.write !== "boolean" ||
    typeof body.may.delete !== "boolean"
  )
    return null;
  const facts: KnowledgeItemView[] = [];
  const seen = new Set<string>();
  for (const p of body.pages) {
    if (
      !record(p) ||
      !keysOf(p, ["id", "kind", "title", "version", "excerpt", "updatedAt"]) ||
      !isId(p.id) ||
      seen.has(p.id) ||
      !kind(p.kind) ||
      !text(p.title, 120) ||
      !version(p.version) ||
      !text(p.excerpt, 280) ||
      !isUtcTime(p.updatedAt)
    )
      return null;
    seen.add(p.id);
    facts.push({
      id: p.id,
      kind: "fact",
      title: p.title,
      text: p.excerpt,
      source: "Updated " + day(p.updatedAt),
      pageKind: p.kind,
      version: p.version,
      digest: null,
      untrusted: false,
    });
  }
  return { facts, may: { write: body.may.write, delete: body.may.delete } };
}

/** GET /work/knowledge/proposals: pending suggestions the viewer may see. */
export function decodeKnowledgeProposals(body: unknown): readonly KnowledgeItemView[] | null {
  if (
    !record(body) ||
    !keysOf(body, ["schemaVersion", "proposals"]) ||
    body.schemaVersion !== 1 ||
    !Array.isArray(body.proposals) ||
    body.proposals.length > 50
  )
    return null;
  const out: KnowledgeItemView[] = [];
  for (const p of body.proposals) {
    if (
      !record(p) ||
      !keysOf(p, [
        "schemaVersion",
        "id",
        "pageId",
        "baseVersion",
        "kind",
        "title",
        "text",
        "sources",
        "installationId",
        "contextTaint",
        "digest",
        "createdAt",
      ]) ||
      p.schemaVersion !== 1 ||
      !isId(p.id) ||
      !(p.pageId === null || isId(p.pageId)) ||
      !(p.baseVersion === null || version(p.baseVersion)) ||
      (p.pageId === null) !== (p.baseVersion === null) ||
      !kind(p.kind) ||
      !text(p.title, 120) ||
      !text(p.text, 8000) ||
      sources(p.sources) === null ||
      !isId(p.installationId) ||
      (p.contextTaint !== "none" && p.contextTaint !== "untrusted_external") ||
      !hex64(p.digest) ||
      !isUtcTime(p.createdAt)
    )
      return null;
    out.push({
      id: p.id,
      kind: "suggested",
      title: p.title,
      text: p.text,
      source: "Suggested by an agent · " + day(p.createdAt),
      pageKind: p.kind,
      version: p.baseVersion as number | null,
      digest: p.digest,
      untrusted: p.contextTaint === "untrusted_external",
    });
  }
  return out;
}

/** GET /work/knowledge/pages/:pageId: the current version, for the edit form. */
export function decodeKnowledgePage(body: unknown, pageId: string): KnowledgePageView | null {
  if (!record(body) || !keysOf(body, ["schemaVersion", "page", "versions"])) return null;
  const page = body.page;
  if (
    body.schemaVersion !== 1 ||
    !record(page) ||
    !keysOf(page, ["schemaVersion", "id", "kind", "current", "versionCount", "createdAt"]) ||
    page.id !== pageId ||
    !kind(page.kind) ||
    !version(page.versionCount) ||
    !isUtcTime(page.createdAt) ||
    !Array.isArray(body.versions)
  )
    return null;
  const c = page.current;
  if (
    !record(c) ||
    !keysOf(c, [
      "schemaVersion",
      "pageId",
      "version",
      "title",
      "text",
      "sources",
      "author",
      "acceptedByPrincipalId",
      "proposalId",
      "createdAt",
    ]) ||
    c.pageId !== pageId ||
    !version(c.version) ||
    c.version !== page.versionCount ||
    !text(c.title, 120) ||
    !text(c.text, 8000)
  )
    return null;
  const s = sources(c.sources);
  if (s === null) return null;
  return {
    id: pageId,
    pageKind: page.kind,
    title: c.title,
    text: c.text,
    note: s.find((x) => x.kind === "note")?.value ?? "",
    version: c.version,
  };
}

/** POST /work/knowledge/pages and /pages/:pageId/versions (201, or 200 on a replay). */
export function decodeKnowledgeWritten(
  body: unknown,
  pageId: string | null,
): { readonly pageId: string; readonly version: number } | null {
  if (
    !record(body) ||
    !keysOf(body, ["schemaVersion", "pageId", "version"], ["replayed"]) ||
    body.schemaVersion !== 1 ||
    !isId(body.pageId) ||
    (pageId !== null && body.pageId !== pageId) ||
    !version(body.version) ||
    ("replayed" in body && body.replayed !== true)
  )
    return null;
  return { pageId: body.pageId, version: body.version };
}

/** POST /work/knowledge/pages/:pageId/delete: the deletion and its counts. */
export function decodeKnowledgeDeleted(
  body: unknown,
  pageId: string,
): { readonly pageId: string } | null {
  if (
    !record(body) ||
    !keysOf(
      body,
      ["schemaVersion", "pageId", "versionsErased", "searchEntriesErased", "proposalsClosed"],
      ["replayed"],
    ) ||
    body.schemaVersion !== 1 ||
    body.pageId !== pageId ||
    !version(body.versionsErased) ||
    (body.searchEntriesErased !== 0 && body.searchEntriesErased !== 1) ||
    typeof body.proposalsClosed !== "number" ||
    ("replayed" in body && body.replayed !== true)
  )
    return null;
  return { pageId };
}

/** POST /work/knowledge/proposals/:id/(accept|reject). */
export function decodeSuggestionDecided(
  body: unknown,
  proposalId: string,
  decision: "accept" | "reject",
): { readonly decision: "accept" | "reject" } | null {
  if (!record(body) || body.schemaVersion !== 1 || body.proposalId !== proposalId) return null;
  if ("replayed" in body && body.replayed !== true) return null;
  if (decision === "accept")
    return keysOf(body, ["schemaVersion", "proposalId", "pageId", "version"], ["replayed"]) &&
      isId(body.pageId) &&
      version(body.version)
      ? { decision }
      : null;
  return keysOf(body, ["schemaVersion", "proposalId", "status"], ["replayed"]) &&
    body.status === "rejected"
    ? { decision }
    : null;
}
