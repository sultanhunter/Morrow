import type {
  CapabilityId,
  Current_KnowledgeAuthor,
  Current_KnowledgePage,
  Current_KnowledgePageKind,
  Current_KnowledgePageSummary,
  Current_KnowledgeProposal,
  Current_KnowledgeSource,
  Current_KnowledgeVersion,
  Current_NotebookEntry,
  Current_ReadTag,
  Current_ResourceRef,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { createHumanPolicyService, type HumanAuthority, type PermissionVerb } from "@morrow/policy";
import { knowledgeLimits, viewable, type TagViewer } from "@morrow/policy/knowledge";
import { storeResource } from "@morrow/policy/store-resource";
import { WorkReject, type WorkRejection, type WorkTx } from "../connection.js";
import { enterWorkContext, WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { canonicalJson, sha256Hex } from "../digest.js";
import type { GuardedWorkspaceRequest, WorkspaceRouteSpec } from "../http-guard.js";
import {
  parseClearBody,
  parseDecisionBody,
  parseDeleteBody,
  parsePageCreateBody,
  parseVersionBody,
  searchText,
  type DecisionBody,
  type DeleteBody,
  type PageCreateBody,
  type VersionBody,
} from "./bodies.js";

// The knowledge and notebook commands and reads (PR 20; docs/briefs/shop-knowledge.md). Each
// runs the human kernel (packages/policy) under the request's own enter_context() snapshot
// before its definer; the definer rechecks the session's authority under lock (the P06.T01a
// prelude) and every data rule. Denials and conflicts persist nothing; an unknown outcome is
// never reported as success or denial.
//   * workspace.knowledge.approve is human_only: {execute} writes a version (a new page or the
//     next version) and accepts or rejects an agent's proposal (ADR-0024: a person decides,
//     never an agent or a mandate); {administer} deletes a page (the deletion path).
//   * workspace.notebook.write {administer} clears an agent's notebook (agents only ever hold
//     execute, and only through their run).
//   * Reads (ADR-0031 item 6): a page, version, proposal, search hit or notebook entry is
//     returned only when the viewer holds view on every one of its read tags under live
//     grants; otherwise it is left out of lists, counts and search, and a direct read is 404.
export type KnowledgeCommandType =
  | "knowledge.create"
  | "knowledge.version"
  | "knowledge.delete"
  | "knowledge.accept"
  | "knowledge.reject"
  | "notebook.clear";
export type KnowledgeRead =
  | "knowledge.pages"
  | "knowledge.page"
  | "knowledge.version_read"
  | "knowledge.proposals"
  | "knowledge.search"
  | "notebook.read";
export type KnowledgeRefusal = "stale" | "hidden_entries";
export class KnowledgeReject extends Error {
  constructor(readonly reason: KnowledgeRefusal) {
    super("KNOWLEDGE_REJECTED");
    this.name = "KnowledgeReject";
  }
}
type Guarded = GuardedWorkspaceRequest<WorkspaceRouteSpec>;
export interface KnowledgeResult {
  readonly status: 200 | 201;
  readonly body: Readonly<Record<string, unknown>>;
  readonly outcome: string;
}
export interface PreparedKnowledgeCommand {
  readonly type: KnowledgeCommandType;
  readonly parsed: unknown;
  readonly digest: string;
}
/** The request digest: canonical JSON of the command, its workspace, path ids and body. */
export function knowledgeRequestDigest(
  type: KnowledgeCommandType,
  workspaceId: string,
  pathIds: readonly string[],
  body: unknown,
): Promise<string> {
  return sha256Hex(
    canonicalJson(["morrow.work.command", 1, type, workspaceId, [...pathIds], body]),
  );
}
/** Step 1, with no I/O: the strict body and the request digest. */
export async function prepareKnowledgeCommand(
  type: KnowledgeCommandType,
  g: Guarded,
): Promise<PreparedKnowledgeCommand> {
  const parsed =
    type === "knowledge.create"
      ? parsePageCreateBody(g.body)
      : type === "knowledge.version"
        ? parseVersionBody(g.body)
        : type === "knowledge.delete"
          ? parseDeleteBody(g.body)
          : type === "notebook.clear"
            ? parseClearBody(g.body)
            : parseDecisionBody(g.body);
  if (parsed === null) throw new WorkReject("invalid");
  const pathIds = [g.params.pageId, g.params.proposalId, g.params.installationId].filter(
    (x): x is string => x !== undefined,
  );
  const digest = await knowledgeRequestDigest(type, g.workspaceId, pathIds, g.body);
  return Object.freeze({ type, parsed, digest });
}

// ---------------------------------------------------------------------------
// The kernel on one resource. Internal writes and reads, never paid work, so entitlement is
// the literal false every builder but the billing reader passes.
async function decideOn(
  a: WorkAuthority,
  resource: Current_ResourceRef,
  capabilityId: CapabilityId,
  verb: PermissionVerb,
  fields: readonly string[],
): Promise<{ readonly allowed: boolean; readonly reason: string }> {
  const authority: HumanAuthority = {
    actor: a.actor,
    policyRevision: a.policyRevision,
    grantsRevision: a.policyRevision,
    principalActive: true,
    organizationActive: true,
    workspaceActive: true,
    membershipActive: true,
    sessionCurrent: true,
    resource,
    accountId: null,
    providerAllowed: true,
    entitlementAllowed: false,
    grants: a.grants,
  };
  const service = createHumanPolicyService(
    { readCurrent: async () => authority },
    () => new Date(a.databaseNowMs),
  );
  const r = await service.decide({
    capabilityId,
    verb,
    resource,
    accountId: null,
    fields: [...fields],
  });
  return { allowed: r.decision.allowed, reason: r.decision.reason };
}
/** The fields a decision names: the capability's own input fields (v1 and v1.1 bodies). */
export const knowledgeFields = Object.freeze({
  approve: Object.freeze(["expectedRevision", "recordId", "sourceRefs"]),
  notebook: Object.freeze(["text"]),
});
async function allow(
  a: WorkAuthority,
  capabilityId: CapabilityId,
  verb: PermissionVerb,
  fields: readonly string[],
): Promise<void> {
  const decided = await decideOn(a, a.resource, capabilityId, verb, fields);
  if (!decided.allowed)
    throw new WorkReject(decided.reason === "field_denied" ? "field_denied" : "denied");
}

// ---------------------------------------------------------------------------
// Read tags per viewer (ADR-0031 item 6): the kernel's view on each (store, read capability),
// decided once per request. A tag with a null store (ReadTag@1 allows it for the workspace
// capabilities, before any store is linked) is decided on the workspace resource; a store tag
// on that store's resource, and a store with no current association is never viewable. The
// kernel needs the fields a request names, and a read tag names none of its own: each distinct
// field list one of the viewer's view grants on that capability holds is asked in turn (as the
// goal reads do, PR 18). With no such grant nothing is viewable.
function viewFieldLists(a: WorkAuthority, capabilityId: string): readonly string[][] {
  const lists = new Map<string, string[]>();
  for (const g of a.grants)
    if (g.capabilityId === capabilityId && g.verbs.includes("view") && g.scope.fields.length > 0) {
      const fields = [...new Set(g.scope.fields)].sort();
      lists.set(JSON.stringify(fields), fields);
    }
  return [...lists.values()];
}
const tagKey = (tag: Current_ReadTag) => JSON.stringify([tag.storeId, tag.capability]);
export async function knowledgeViewer(
  tx: WorkTx,
  a: WorkAuthority,
  tags: Iterable<Current_ReadTag>,
): Promise<TagViewer> {
  const decisions = new Map<string, boolean>();
  const resources = new Map<string | null, Current_ResourceRef | null>();
  for (const tag of tags) {
    const key = tagKey(tag);
    if (decisions.has(key)) continue;
    if (tag.capability === "support.case.read") {
      decisions.set(key, false);
      continue;
    }
    let resource = resources.get(tag.storeId);
    if (resource === undefined) {
      if (tag.storeId === null) resource = a.resource;
      else {
        const row = one(await tx.run("storeAssociation", [tag.storeId]));
        resource =
          row === null
            ? null
            : storeResource(
                a.actor.organizationId,
                a.resource.workspaceId,
                tag.storeId,
                text(row, "connection_id"),
              );
      }
      resources.set(tag.storeId, resource);
    }
    let allowed = false;
    if (resource !== null)
      for (const fields of viewFieldLists(a, tag.capability))
        if ((await decideOn(a, resource, tag.capability as CapabilityId, "view", fields)).allowed) {
          allowed = true;
          break;
        }
    decisions.set(key, allowed);
  }
  return Object.freeze({ mayView: (tag: Current_ReadTag) => decisions.get(tagKey(tag)) === true });
}

// ---------------------------------------------------------------------------
// Fixed row decoders. Any other shape is WorkContextUnavailable (a 503, never a guess).
type Row = Readonly<Record<string, unknown>>;
const text = (row: Row, key: string) => {
  const value = row[key];
  if (typeof value !== "string") throw new WorkContextUnavailable();
  return value;
};
const optional = (row: Row, key: string) => (row[key] === null ? null : text(row, key));
function one(rows: readonly Row[]): Row | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0]) throw new WorkContextUnavailable();
  return rows[0];
}
const integer = (value: string) => {
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new WorkContextUnavailable();
  return Number(value);
};
const parsedJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new WorkContextUnavailable();
  }
};
function tagsOf(row: Row, key = "read_tags"): readonly Current_ReadTag[] {
  const tags = parsedJson(text(row, key));
  if (!validateCurrentDefinition("ReadTags", tags)) throw new WorkContextUnavailable();
  return tags as Current_ReadTag[];
}
function sourcesOf(row: Row): readonly Current_KnowledgeSource[] {
  const sources = parsedJson(text(row, "sources"));
  if (!validateCurrentDefinition("KnowledgeSources", sources)) throw new WorkContextUnavailable();
  return sources as Current_KnowledgeSource[];
}
function checked<T>(definition: "KnowledgePage" | "KnowledgeVersion", value: T): T;
function checked<T>(
  definition: "KnowledgePageSummary" | "KnowledgeProposal" | "NotebookEntry" | "KnowledgeAuthor",
  value: T,
): T;
function checked<T>(definition: string, value: T): T {
  if (!validateCurrentDefinition(definition as "KnowledgePage", value))
    throw new WorkContextUnavailable();
  return value;
}
function authorOf(row: Row): Current_KnowledgeAuthor {
  const kind = text(row, "author_kind");
  return checked("KnowledgeAuthor", {
    kind: kind === "agent" ? "agent" : "person",
    principalId: text(row, "author_principal_id"),
    installationId: optional(row, "author_installation_id"),
  } as Current_KnowledgeAuthor);
}
function versionOf(row: Row): Current_KnowledgeVersion {
  return checked("KnowledgeVersion", {
    schemaVersion: 1,
    pageId: text(row, "page_id"),
    version: integer(text(row, "version")),
    title: text(row, "title"),
    text: text(row, "body"),
    sources: sourcesOf(row),
    author: authorOf(row),
    acceptedByPrincipalId: text(row, "accepted_by_principal_id"),
    proposalId: optional(row, "proposal_id"),
    createdAt: text(row, "created_at"),
  } as Current_KnowledgeVersion);
}
function proposalOf(row: Row): Current_KnowledgeProposal {
  const base = optional(row, "base_version");
  return checked("KnowledgeProposal", {
    schemaVersion: 1,
    id: text(row, "id"),
    pageId: optional(row, "page_id"),
    baseVersion: base === null ? null : integer(base),
    kind: text(row, "kind") as Current_KnowledgePageKind,
    title: text(row, "title"),
    text: text(row, "body"),
    sources: sourcesOf(row),
    installationId: text(row, "installation_id"),
    contextTaint:
      text(row, "context_taint") === "untrusted_external" ? "untrusted_external" : "none",
    digest: text(row, "digest"),
    createdAt: text(row, "created_at"),
  } as Current_KnowledgeProposal);
}

async function context(tx: WorkTx, g: Guarded): Promise<WorkAuthority> {
  const a = await enterWorkContext(tx, g.sessionDigest, g.workspaceId);
  if (a === "ineligible") throw new WorkReject("unauthenticated");
  if (a === "grant_overflow") throw new WorkReject("grant_overflow");
  return a;
}
const sqlOutcomes: Readonly<Record<string, WorkRejection | KnowledgeRefusal>> = Object.freeze({
  invalid: "invalid",
  ineligible: "unauthenticated",
  not_found: "not_found",
  revision_conflict: "revision_conflict",
  state_conflict: "state_conflict",
  stale_authority: "stale_authority",
  command_conflict: "command_conflict",
  limit_reached: "limit_reached",
  stale: "stale",
});
function decodeResult(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new WorkContextUnavailable();
  const result = parsedJson(value);
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw new WorkContextUnavailable();
  return result as Record<string, unknown>;
}
const sqlType: Readonly<Record<KnowledgeCommandType, string>> = Object.freeze({
  "knowledge.create": "knowledge.write",
  "knowledge.version": "knowledge.write",
  "knowledge.delete": "knowledge.delete",
  "knowledge.accept": "knowledge.accept",
  "knowledge.reject": "knowledge.reject",
  "notebook.clear": "notebook.clear",
});
/** Replay first: a recorded command returns its recorded result and changes nothing. */
async function begin(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedKnowledgeCommand,
): Promise<KnowledgeResult | null> {
  if (g.commandId === null) throw new WorkReject("invalid");
  const b = one(
    await tx.run("beginKnowledgeCommand", [sqlType[prepared.type], g.commandId, prepared.digest]),
  );
  if (!b || typeof b.outcome !== "string") throw new WorkContextUnavailable();
  if (b.outcome === "conflict") throw new WorkReject("command_conflict");
  if (b.outcome === "ineligible") throw new WorkReject("unauthenticated");
  if (b.outcome === "replay") {
    tx.rollbackOnly();
    return {
      status: 200,
      body: { ...decodeResult(b.result), replayed: true },
      outcome: "replayed",
    };
  }
  if (b.outcome !== "new") throw new WorkReject("invalid");
  return null;
}
/** Sends the definer: from here a lost reply is an unknown outcome. */
async function submit(
  tx: WorkTx,
  statement:
    | "cmdKnowledgeWrite"
    | "cmdKnowledgeAccept"
    | "cmdKnowledgeReject"
    | "cmdKnowledgeDelete"
    | "cmdNotebookClear",
  values: (string | null)[],
): Promise<Record<string, unknown>> {
  tx.markSubmitted();
  const row = one(await tx.run(statement, values));
  if (!row || typeof row.outcome !== "string") throw new WorkContextUnavailable();
  if (row.outcome !== "applied") {
    tx.rollbackOnly();
    const reason = sqlOutcomes[row.outcome] ?? "unavailable";
    if (reason === "stale") throw new KnowledgeReject("stale");
    throw new WorkReject(reason as WorkRejection);
  }
  return decodeResult(row.result);
}

// ---------------------------------------------------------------------------
// Rows as this viewer may see them.
interface PageRow {
  readonly id: string;
  /** The current version's first 280 characters (the pages list only). */
  readonly excerpt: string | null;
  readonly kind: Current_KnowledgePageKind;
  readonly title: string;
  readonly version: number;
  readonly readTags: readonly Current_ReadTag[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
function pageRowOf(row: Row): PageRow {
  return {
    id: text(row, "id"),
    excerpt: "excerpt" in row ? text(row, "excerpt") : null,
    kind: text(row, "kind") as Current_KnowledgePageKind,
    title: text(row, "title"),
    version: integer(text(row, "version")),
    readTags: tagsOf(row),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}
/** A live page the viewer may see; absent, deleted or hidden is the same 404. */
async function viewablePage(tx: WorkTx, a: WorkAuthority, pageId: string): Promise<PageRow> {
  const row = one(await tx.run("knowledgePage", [pageId]));
  if (!row) throw new WorkReject("not_found");
  const page = pageRowOf(row);
  if (!viewable(await knowledgeViewer(tx, a, page.readTags), page.readTags))
    throw new WorkReject("not_found");
  return page;
}
/** A pending proposal the viewer may see (404 otherwise), with its tags. */
async function viewableProposal(
  tx: WorkTx,
  a: WorkAuthority,
  proposalId: string,
): Promise<Current_KnowledgeProposal> {
  const row = one(await tx.run("knowledgeProposal", [proposalId]));
  if (!row) throw new WorkReject("not_found");
  const tags = tagsOf(row);
  if (!viewable(await knowledgeViewer(tx, a, tags), tags)) throw new WorkReject("not_found");
  if (text(row, "status") !== "pending") throw new WorkReject("state_conflict");
  return proposalOf(row);
}

// ---------------------------------------------------------------------------
// Commands.
async function pageCreate(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedKnowledgeCommand,
  correlationId: string,
): Promise<KnowledgeResult> {
  const body = prepared.parsed as PageCreateBody;
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return replay;
  await allow(a, "workspace.knowledge.approve", "execute", knowledgeFields.approve);
  const result = await submit(tx, "cmdKnowledgeWrite", [
    g.commandId,
    prepared.digest,
    correlationId,
    null,
    crypto.randomUUID(),
    body.kind,
    null,
    body.title,
    body.text,
    JSON.stringify(body.sources),
  ]);
  return { status: 201, body: result, outcome: "applied" };
}
async function pageVersion(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedKnowledgeCommand,
  correlationId: string,
): Promise<KnowledgeResult> {
  const body = prepared.parsed as VersionBody;
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return replay;
  await allow(a, "workspace.knowledge.approve", "execute", knowledgeFields.approve);
  const page = await viewablePage(tx, a, g.params.pageId!);
  const result = await submit(tx, "cmdKnowledgeWrite", [
    g.commandId,
    prepared.digest,
    correlationId,
    page.id,
    null,
    null,
    String(body.expectedVersion),
    body.title,
    body.text,
    JSON.stringify(body.sources),
  ]);
  return { status: 201, body: result, outcome: "applied" };
}
async function pageDelete(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedKnowledgeCommand,
  correlationId: string,
): Promise<KnowledgeResult> {
  const body = prepared.parsed as DeleteBody;
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return replay;
  await allow(a, "workspace.knowledge.approve", "administer", knowledgeFields.approve);
  const page = await viewablePage(tx, a, g.params.pageId!);
  const result = await submit(tx, "cmdKnowledgeDelete", [
    g.commandId,
    prepared.digest,
    correlationId,
    page.id,
    String(body.expectedVersion),
  ]);
  return { status: 200, body: result, outcome: "applied" };
}
async function proposalDecide(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedKnowledgeCommand,
  correlationId: string,
): Promise<KnowledgeResult> {
  const body = prepared.parsed as DecisionBody;
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return replay;
  await allow(a, "workspace.knowledge.approve", "execute", knowledgeFields.approve);
  const proposal = await viewableProposal(tx, a, g.params.proposalId!);
  // The page it changes must still be one this person may see (its tags may have grown).
  if (proposal.pageId !== null) await viewablePage(tx, a, proposal.pageId);
  if (proposal.digest !== body.digest) throw new KnowledgeReject("stale");
  const result =
    prepared.type === "knowledge.accept"
      ? await submit(tx, "cmdKnowledgeAccept", [
          g.commandId,
          prepared.digest,
          correlationId,
          proposal.id,
          body.digest,
          crypto.randomUUID(),
        ])
      : await submit(tx, "cmdKnowledgeReject", [
          g.commandId,
          prepared.digest,
          correlationId,
          proposal.id,
          body.digest,
        ]);
  return {
    status: prepared.type === "knowledge.accept" ? 201 : 200,
    body: result,
    outcome: "applied",
  };
}
/** An installation of this workspace that was not uninstalled; 404 otherwise. */
async function installationOf(tx: WorkTx, installationId: string): Promise<void> {
  const row = one(await tx.run("knowledgeInstallation", [installationId]));
  if (!row || text(row, "status") === "uninstalled") throw new WorkReject("not_found");
}
async function notebookEntryRows(tx: WorkTx, installationId: string) {
  const rows = await tx.run("notebookEntries", [installationId]);
  if (rows.length > knowledgeLimits.notebookLiveEntries) throw new WorkContextUnavailable();
  return rows.map((row) => ({ row, tags: tagsOf(row) }));
}
async function notebookClear(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedKnowledgeCommand,
  correlationId: string,
): Promise<KnowledgeResult> {
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return replay;
  await allow(a, "workspace.notebook.write", "administer", knowledgeFields.notebook);
  const installationId = g.params.installationId!;
  await installationOf(tx, installationId);
  // No blind deletion: a person clears only a notebook whose every live entry they may see.
  // The revision is read first and the definer erases only at it: each statement here reads
  // what was committed when it ran (READ COMMITTED), so an entry a run commits after this read
  // bumps the revision and the clear is a revision_conflict, never an unseen entry erased.
  const revision = one(await tx.run("notebookRevision", [installationId]));
  if (!revision) throw new WorkReject("not_found");
  const expectedRevision = String(integer(text(revision, "revision")));
  const entries = await notebookEntryRows(tx, installationId);
  const viewer = await knowledgeViewer(
    tx,
    a,
    entries.flatMap((e) => e.tags),
  );
  if (entries.some((e) => !viewable(viewer, e.tags))) throw new KnowledgeReject("hidden_entries");
  await submit(tx, "cmdNotebookClear", [
    g.commandId,
    prepared.digest,
    correlationId,
    installationId,
    expectedRevision,
  ]);
  return { status: 200, body: { installationId, cleared: true }, outcome: "applied" };
}
export function runKnowledgeCommand(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedKnowledgeCommand,
  correlationId: string,
): Promise<KnowledgeResult> {
  switch (prepared.type) {
    case "knowledge.create":
      return pageCreate(tx, g, prepared, correlationId);
    case "knowledge.version":
      return pageVersion(tx, g, prepared, correlationId);
    case "knowledge.delete":
      return pageDelete(tx, g, prepared, correlationId);
    case "knowledge.accept":
    case "knowledge.reject":
      return proposalDecide(tx, g, prepared, correlationId);
    case "notebook.clear":
      return notebookClear(tx, g, prepared, correlationId);
  }
}

// ---------------------------------------------------------------------------
// Reads. Everything is decided per viewer; a read never commits anything.
async function pagesRead(tx: WorkTx, a: WorkAuthority): Promise<Record<string, unknown>> {
  const rows = await tx.run("knowledgePages", []);
  if (rows.length > knowledgeLimits.pagesPerWorkspace) throw new WorkContextUnavailable();
  const pages = rows.map(pageRowOf);
  const proposals = await tx.run("knowledgeProposalsPending", []);
  if (proposals.length > knowledgeLimits.pendingProposalsPerWorkspace)
    throw new WorkContextUnavailable();
  const proposalTags = proposals.map((row) => tagsOf(row));
  const viewer = await knowledgeViewer(tx, a, [
    ...pages.flatMap((p) => p.readTags),
    ...proposalTags.flat(),
  ]);
  const shown: Current_KnowledgePageSummary[] = pages
    .filter((p) => viewable(viewer, p.readTags))
    .map((p) =>
      checked("KnowledgePageSummary", {
        id: p.id,
        kind: p.kind,
        title: p.title,
        version: p.version,
        excerpt: p.excerpt ?? "",
        updatedAt: p.updatedAt,
      }),
    );
  // What this person may do, for the screen only (each command decides again).
  const may = async (capabilityId: CapabilityId, verb: PermissionVerb, fields: readonly string[]) =>
    (await decideOn(a, a.resource, capabilityId, verb, fields)).allowed;
  return {
    pages: shown,
    pendingProposals: proposalTags.filter((tags) => viewable(viewer, tags)).length,
    may: {
      write: await may("workspace.knowledge.approve", "execute", knowledgeFields.approve),
      delete: await may("workspace.knowledge.approve", "administer", knowledgeFields.approve),
    },
  };
}
async function pageRead(tx: WorkTx, a: WorkAuthority, pageId: string) {
  const page = await viewablePage(tx, a, pageId);
  const current = one(await tx.run("knowledgeVersion", [page.id, String(page.version)]));
  if (!current) throw new WorkContextUnavailable();
  const list = await tx.run("knowledgeVersionList", [page.id]);
  const full: Current_KnowledgePage = checked("KnowledgePage", {
    schemaVersion: 1,
    id: page.id,
    kind: page.kind,
    current: versionOf(current),
    versionCount: page.version,
    createdAt: page.createdAt,
  } as Current_KnowledgePage);
  return {
    page: full,
    versions: list.map((row) => ({
      version: integer(text(row, "version")),
      author: authorOf(row),
      acceptedByPrincipalId: text(row, "accepted_by_principal_id"),
      proposalId: optional(row, "proposal_id"),
      createdAt: text(row, "created_at"),
    })),
  };
}
async function versionRead(tx: WorkTx, a: WorkAuthority, pageId: string, version: string) {
  const page = await viewablePage(tx, a, pageId);
  if (!/^[1-9][0-9]{0,3}$/.test(version) || Number(version) > page.version)
    throw new WorkReject("not_found");
  const row = one(await tx.run("knowledgeVersion", [page.id, version]));
  if (!row || row.body === null) throw new WorkReject("not_found");
  return { version: versionOf(row) };
}
async function proposalsRead(tx: WorkTx, a: WorkAuthority) {
  const rows = await tx.run("knowledgeProposalsPending", []);
  if (rows.length > knowledgeLimits.pendingProposalsPerWorkspace)
    throw new WorkContextUnavailable();
  const tagged = rows.map((row) => ({ row, tags: tagsOf(row) }));
  const viewer = await knowledgeViewer(
    tx,
    a,
    tagged.flatMap((t) => t.tags),
  );
  return {
    proposals: tagged.filter((t) => viewable(viewer, t.tags)).map((t) => proposalOf(t.row)),
  };
}
async function searchRead(tx: WorkTx, a: WorkAuthority, query: string | undefined) {
  const term = searchText(query);
  if (term === null) throw new WorkReject("invalid");
  const rows = await tx.run("knowledgeSearch", [term]);
  if (rows.length > 200) throw new WorkContextUnavailable();
  const tagged = rows.map((row) => ({ row, tags: tagsOf(row) }));
  const viewer = await knowledgeViewer(
    tx,
    a,
    tagged.flatMap((t) => t.tags),
  );
  return {
    results: tagged
      .filter((t) => viewable(viewer, t.tags))
      .slice(0, knowledgeLimits.searchResults)
      .map((t) => ({
        pageId: text(t.row, "id"),
        kind: text(t.row, "kind"),
        title: text(t.row, "title"),
        version: integer(text(t.row, "version")),
        snippet: text(t.row, "snippet"),
      })),
  };
}
async function notebookRead(tx: WorkTx, a: WorkAuthority, installationId: string) {
  await installationOf(tx, installationId);
  const entries = await notebookEntryRows(tx, installationId);
  const viewer = await knowledgeViewer(
    tx,
    a,
    entries.flatMap((e) => e.tags),
  );
  const shown: Current_NotebookEntry[] = entries
    .slice(0, knowledgeLimits.notebookLiveEntries)
    .filter((e) => viewable(viewer, e.tags))
    .map((e) =>
      checked("NotebookEntry", {
        schemaVersion: 1,
        id: text(e.row, "id"),
        installationId,
        sequence: integer(text(e.row, "sequence")),
        text: text(e.row, "body"),
        createdAt: text(e.row, "created_at"),
      } as Current_NotebookEntry),
    );
  return { installationId, entries: shown };
}
export async function runKnowledgeRead(
  tx: WorkTx,
  g: Guarded,
  op: KnowledgeRead,
): Promise<KnowledgeResult> {
  const a = await context(tx, g);
  let body: Record<string, unknown>;
  switch (op) {
    case "knowledge.pages":
      body = await pagesRead(tx, a);
      break;
    case "knowledge.page":
      body = await pageRead(tx, a, g.params.pageId!);
      break;
    case "knowledge.version_read":
      body = await versionRead(tx, a, g.params.pageId!, g.params.version!);
      break;
    case "knowledge.proposals":
      body = await proposalsRead(tx, a);
      break;
    case "knowledge.search":
      body = await searchRead(tx, a, g.query.get("text"));
      break;
    case "notebook.read":
      body = await notebookRead(tx, a, g.params.installationId!);
      break;
  }
  tx.rollbackOnly();
  return { status: 200, body, outcome: "read" };
}
