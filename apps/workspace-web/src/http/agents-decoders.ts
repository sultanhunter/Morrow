// M3 PR-1: closed decoders of the agents routes' replies (internal JSON between the api
// Worker and this SPA; docs/contracts/work-api.md "Agents routes"). A body that does not
// match exactly decodes to null, which the work outcome mapping turns into an unconfirmed
// read or an uncertain command, never a guess. No provider string, price or token count is
// ever read from these bodies.
import type {
  ListingsAgentView,
  ListingsChangeView,
  ListingsDocumentView,
  ModelCatalogueView,
  ModelEntryView,
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
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const hex64 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
/** An opaque catalogue key (ModelSelection@1): never an enum, never a provider string. */
export const isModelKey = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value);
const listingFields = ["descriptionHtml", "seo.description", "seo.title", "tags", "title"];
const installationStatuses = ["active", "disabled"];

/** GET /workspace/:ws/stores/:storeId/agents/listings. */
export function decodeListingsStatus(body: unknown, storeId: string): ListingsAgentView | null {
  if (
    !record(body) ||
    !keysOf(body, ["schemaVersion", "storeId", "linked", "blocked", "installation", "actions"])
  )
    return null;
  if (
    body.schemaVersion !== 1 ||
    body.storeId !== storeId ||
    typeof body.linked !== "boolean" ||
    typeof body.blocked !== "boolean"
  )
    return null;
  const a = body.actions;
  if (!record(a) || !keysOf(a, ["enable", "resume", "stop"])) return null;
  if (![a.enable, a.resume, a.stop].every((v) => typeof v === "boolean")) return null;
  let installation: ListingsAgentView["installation"] = null;
  if (body.installation !== null) {
    const i = body.installation;
    if (
      !record(i) ||
      !keysOf(i, ["installationId", "status", "revision", "stopped", "updatedAt"]) ||
      !isId(i.installationId) ||
      typeof i.status !== "string" ||
      !installationStatuses.includes(i.status) ||
      !integer(i.revision, 1, Number.MAX_SAFE_INTEGER) ||
      typeof i.stopped !== "boolean" ||
      !isUtcTime(i.updatedAt)
    )
      return null;
    installation = {
      installationId: i.installationId,
      status: i.status,
      revision: i.revision,
      stopped: i.stopped,
      updatedAt: i.updatedAt,
    };
  }
  // Only an installation can be stopped or resumed; only no installation can be enabled.
  if ((a.stop || a.resume) && installation === null) return null;
  if (a.enable && installation !== null) return null;
  return {
    storeId,
    linked: body.linked,
    blocked: body.blocked,
    installation,
    actions: { enable: a.enable as boolean, resume: a.resume as boolean, stop: a.stop as boolean },
  };
}

/** POST .../agents/listings/document (201): the document and its one nonce. */
export function decodeListingsDocument(
  body: unknown,
  storeId: string,
): ListingsDocumentView | null {
  if (
    !record(body) ||
    !keysOf(body, [
      "schemaVersion",
      "documentId",
      "documentDigest",
      "installationId",
      "purpose",
      "expiresAt",
      "document",
      "nonce",
    ])
  )
    return null;
  const { documentDigest, nonce, purpose, installationId, expiresAt, document } = body;
  if (
    body.schemaVersion !== 1 ||
    !hex64(documentDigest) ||
    !hex64(nonce) ||
    (purpose !== "enable" && purpose !== "resume") ||
    !isId(installationId) ||
    !isUtcTime(expiresAt) ||
    !record(document) ||
    document.kind !== "morrow.agent_installation_document" ||
    document.purpose !== purpose ||
    document.installationId !== installationId ||
    document.expiresAt !== expiresAt ||
    !record(document.store) ||
    document.store.storeId !== storeId ||
    !record(document.release) ||
    !integer(document.release.revision, 1, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(document.grants) ||
    document.grants.length < 1 ||
    document.grants.length > 8
  )
    return null;
  const grants: { capabilityId: string; verbs: string[] }[] = [];
  let fields: string[] | null = null;
  for (const g of document.grants as unknown[]) {
    if (
      !record(g) ||
      typeof g.capabilityId !== "string" ||
      !/^[a-z]+(\.[a-z_]+)+$/.test(g.capabilityId) ||
      !Array.isArray(g.verbs) ||
      !g.verbs.every((v) => typeof v === "string" && /^[a-z]{1,16}$/.test(v)) ||
      !record(g.scope) ||
      !Array.isArray(g.scope.fields) ||
      !g.scope.fields.every((f) => typeof f === "string" && listingFields.includes(f))
    )
      return null;
    // Never approve or execute on publish: a document that says so is not shown.
    if (g.capabilityId === "catalog.content.publish" && g.verbs.some((v) => v !== "propose"))
      return null;
    grants.push({ capabilityId: g.capabilityId, verbs: [...(g.verbs as string[])] });
    fields ??= [...(g.scope.fields as string[])];
  }
  return {
    documentDigest,
    nonce,
    purpose,
    installationId,
    expiresAt,
    releaseRevision: document.release.revision as number,
    grants,
    fields: fields ?? [],
  };
}

/** POST .../agents/listings (enable or resume) and .../stop: the installation's change. */
export function decodeListingsChange(body: unknown): ListingsChangeView | null {
  if (!record(body) || body.schemaVersion !== 1) return null;
  const { installationId, status, revision } = body;
  if (
    !isId(installationId) ||
    typeof status !== "string" ||
    !installationStatuses.includes(status) ||
    !integer(revision, 1, Number.MAX_SAFE_INTEGER)
  )
    return null;
  return { installationId, status, revision };
}

/** GET /workspace/:ws/models. */
export function decodeModels(body: unknown): ModelCatalogueView | null {
  if (
    !record(body) ||
    !keysOf(body, [
      "schemaVersion",
      "catalogueVersion",
      "entries",
      "workspaceDefault",
      "ceiling",
      "revision",
      "canRevise",
      "draftingAvailable",
    ]) ||
    body.schemaVersion !== 1 ||
    !integer(body.catalogueVersion, 1, 999) ||
    !Array.isArray(body.entries) ||
    body.entries.length < 1 ||
    body.entries.length > 64 ||
    !integer(body.ceiling, 1, 99) ||
    !(body.revision === null || integer(body.revision, 1, Number.MAX_SAFE_INTEGER)) ||
    typeof body.canRevise !== "boolean" ||
    typeof body.draftingAvailable !== "boolean"
  )
    return null;
  const d = body.workspaceDefault;
  if (
    !record(d) ||
    !keysOf(d, ["model", "effort"]) ||
    !isModelKey(d.model) ||
    !isModelKey(d.effort)
  )
    return null;
  const entries: ModelEntryView[] = [];
  for (const e of body.entries as unknown[]) {
    if (
      !record(e) ||
      !keysOf(e, ["model", "effort", "creditsPerProduct", "runProductLimit", "allowedForMember"]) ||
      !isModelKey(e.model) ||
      !isModelKey(e.effort) ||
      !integer(e.creditsPerProduct, 1, 99) ||
      !integer(e.runProductLimit, 1, 1000) ||
      typeof e.allowedForMember !== "boolean"
    )
      return null;
    entries.push({
      model: e.model,
      effort: e.effort,
      creditsPerProduct: e.creditsPerProduct,
      runProductLimit: e.runProductLimit,
      allowedForMember: e.allowedForMember,
    });
  }
  if (!entries.some((e) => e.model === d.model && e.effort === d.effort)) return null;
  return {
    catalogueVersion: body.catalogueVersion as number,
    entries,
    workspaceDefault: { model: d.model, effort: d.effort },
    ceiling: body.ceiling as number,
    revision: body.revision as number | null,
    canRevise: body.canRevise,
    draftingAvailable: body.draftingAvailable,
  };
}

/** PUT /workspace/:ws/settings/model-default. */
export function decodeModelDefaultRevised(body: unknown): { readonly revision: number } | null {
  if (
    !record(body) ||
    body.schemaVersion !== 1 ||
    !integer(body.revision, 1, Number.MAX_SAFE_INTEGER)
  )
    return null;
  return { revision: body.revision };
}
