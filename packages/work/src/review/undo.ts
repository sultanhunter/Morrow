import type {
  CapabilityId,
  Core_ActorRef,
  Current_Grant,
  Current_ResourceRef,
  Current_Scope,
} from "@morrow/contracts";
import { validateCurrentDefinition, validateDefinition } from "@morrow/contracts/validation";
import {
  listingFieldPaths,
  storeResource,
  type StoreResource,
} from "@morrow/policy/store-resource";
import { decideOn } from "../agents/commands.js";
import { readContext, readProposalRow } from "../approvals/family.js";
import type { WorkTx } from "../connection.js";
import { decodeGrants, WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { canonicalJson, sha256Hex } from "../digest.js";
import { listingFields, type ListingField } from "../runs/drafting.js";
import type { ListingFieldsRead } from "../runs/listing-canonical.js";
import { packListingProposals } from "../runs/producer.js";
import { decodeOperation, operationVisible, type OperationRow } from "./apply.js";

// Undo (v1 PR 4; ADR-0011; ADR-0022 items 3 and 9; ADR-0024 item 8; migration catalog-undo).
// An undo of one applied product change is a NEW exact change, never a shortcut: Morrow builds
// a catalog.content.publish proposal that sets each field the change wrote back to the value
// the draft's own snapshot holds (the values read before the apply: the gateway's pre-send
// read proved the product equal to that snapshot when it wrote), on the product as Shopify
// holds it now (the broker's undo check read it, found every listing field still as the apply
// left it and stored that read as a snapshot, whose digest is the undo's
// expectedSourceRevision). A person approves it like any other change (its own digest-bound
// approval) and the gateway applies it the same way: if the product changed in between, the
// pre-send read refuses it (source_changed) and nothing is written.
//   * prepareUndo: the person may read the change's proposal, holds `view` on
//     catalog.products.read (the before values are store content) and `propose` and
//     `delegate` on catalog.content.publish on the store resource with the change's fields
//     (the Listings agent proposes it on their behalf, as a run's proposals are); the
//     installation that proposes it may still propose there (review F1: undoProposerRefusal,
//     what decideDelegation requires of a Listings run's propose step: an active installation
//     whose owner is a live member holding `propose` on catalog.content.publish over the store
//     resource with the fields, whose scope covers them and whose own grant set is exact, with
//     no stop on its runs); and the change is available to undo (catalog_undo_state:
//     verified, within 90 days, the before values held, no open, uncertain or applied undo of
//     it, no later write). All of it before the broker's read.
//   * admitUndo: after the broker's check, the proposal built by the Listings producer from a
//     one-product "draft" of the before values, stored by cmd_catalog_undo, which rebuilds and
//     rechecks every part of it in SQL.
// Nothing here reads or writes Shopify; the broker's check is the route's.

export type UndoRefusal =
  | "not_found"
  | "denied"
  | "invalid"
  | "not_applied"
  | "already_requested"
  | "already_undone"
  | "changed_since_apply"
  | "unavailable"
  | "check_stale"
  | "product_missing"
  | "not_reversible"
  | "link_changed"
  | "installation_inactive"
  // Review F1: a stop blocks the Listings installation's runs on this store.
  | "stopped"
  | "limit_reached"
  | "stale_authority"
  | "command_conflict"
  // The broker's undo check: no readable token now.
  | "credential_unavailable";
export class UndoReject extends Error {
  constructor(
    readonly reason: UndoRefusal,
    /** The fields that changed since the apply (changed_since_apply after a check), if known. */
    readonly fields: readonly string[] = [],
  ) {
    super("UNDO_REJECTED");
    this.name = "UndoReject";
  }
}

export type UndoState = "none" | "available" | "requested" | "undone" | "changed" | "unavailable";
const undoStates: readonly string[] = [
  "none",
  "available",
  "requested",
  "undone",
  "changed",
  "unavailable",
];
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const utc = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const nullable = (value: unknown, pattern: RegExp): value is string | null =>
  value === null || (typeof value === "string" && pattern.test(value));

/** One change's undo state in the task history (ids, codes and times). */
export interface UndoStateRow {
  readonly operationId: string;
  readonly state: UndoState;
  readonly availableUntil: string | null;
  readonly undoProposalId: string | null;
  readonly undoOfOperationId: string | null;
}
export async function undoStatesOfTask(
  tx: WorkTx,
  taskId: string,
): Promise<ReadonlyMap<string, UndoStateRow>> {
  const out = new Map<string, UndoStateRow>();
  for (const r of await tx.run("catalogUndoStates", [taskId])) {
    if (
      typeof r.operation_id !== "string" ||
      !uuid.test(r.operation_id) ||
      typeof r.state !== "string" ||
      !undoStates.includes(r.state) ||
      !nullable(r.available_until, utc) ||
      !nullable(r.undo_proposal_id, idPattern) ||
      !nullable(r.undo_of_operation_id, uuid) ||
      out.has(r.operation_id)
    )
      throw new WorkContextUnavailable();
    out.set(
      r.operation_id,
      Object.freeze({
        operationId: r.operation_id,
        state: r.state as UndoState,
        availableUntil: r.available_until as string | null,
        undoProposalId: r.undo_proposal_id as string | null,
        undoOfOperationId: r.undo_of_operation_id as string | null,
      }),
    );
  }
  return out;
}

interface UndoSource {
  readonly state: UndoState;
  readonly availableUntil: string | null;
  readonly undoProposalId: string | null;
  readonly before: string | null;
  readonly check: {
    readonly sequence: number;
    readonly digest: string | null;
    readonly verdict: "unchanged" | "changed" | "missing";
    /** The listing fields the check found changed since the apply (empty when none). */
    readonly changed: readonly string[];
    readonly observedAt: string;
  } | null;
}
/** The check's per-field codes (a closed object of the listing fields), or null. */
function checkChanged(value: unknown): readonly string[] | null {
  if (value === null) return [];
  if (typeof value !== "string") return null;
  let codes: unknown;
  try {
    codes = JSON.parse(value);
  } catch {
    return null;
  }
  if (!codes || typeof codes !== "object" || Array.isArray(codes)) return null;
  const entries = Object.entries(codes as Record<string, unknown>);
  if (
    !entries.every(
      ([k, v]) =>
        (listingFields as readonly string[]).includes(k) && (v === "unchanged" || v === "changed"),
    )
  )
    return null;
  return Object.freeze(entries.filter(([, v]) => v === "changed").map(([k]) => k));
}
async function undoSource(tx: WorkTx, operationId: string): Promise<UndoSource | null> {
  const rows = await tx.run("catalogUndoSource", [operationId]);
  if (rows.length === 0) return null;
  const r = rows[0]!;
  const changed = checkChanged(r.check_fields ?? null);
  if (
    changed === null ||
    rows.length !== 1 ||
    typeof r.state !== "string" ||
    !undoStates.includes(r.state) ||
    !nullable(r.available_until, utc) ||
    !nullable(r.undo_proposal_id, idPattern) ||
    !(r.before_snapshot === null || typeof r.before_snapshot === "string") ||
    !nullable(r.check_sequence, /^[1-9][0-9]{0,8}$/) ||
    !nullable(r.check_digest, /^[a-f0-9]{64}$/) ||
    !(
      r.check_verdict === null ||
      ["unchanged", "changed", "missing"].includes(r.check_verdict as string)
    ) ||
    !nullable(r.check_observed_at, utc)
  )
    throw new WorkContextUnavailable();
  return Object.freeze({
    state: r.state as UndoState,
    availableUntil: r.available_until as string | null,
    undoProposalId: r.undo_proposal_id as string | null,
    before: r.before_snapshot as string | null,
    check:
      r.check_sequence === null
        ? null
        : Object.freeze({
            sequence: Number(r.check_sequence),
            digest: r.check_digest as string | null,
            verdict: r.check_verdict as "unchanged" | "changed" | "missing",
            changed,
            observedAt: r.check_observed_at as string,
          }),
  });
}

/** The refusal of an undo state other than available. */
export function undoStateRefusal(state: UndoState): UndoRefusal {
  switch (state) {
    case "none":
      return "not_applied";
    case "requested":
      return "already_requested";
    case "undone":
      return "already_undone";
    case "changed":
      return "changed_since_apply";
    default:
      return "unavailable";
  }
}

/** The kernel checks of an undo request on the store resource (in code, before any SQL). */
export async function undoAllowed(
  a: WorkAuthority,
  store: StoreResource,
  fields: readonly string[],
): Promise<boolean> {
  const checks: readonly (readonly [
    CapabilityId,
    "view" | "propose" | "delegate",
    readonly string[],
  ])[] = [
    ["catalog.products.read", "view", listingFieldPaths],
    ["catalog.content.publish", "propose", fields],
    ["catalog.content.publish", "delegate", fields],
  ];
  for (const [capabilityId, verb, on] of checks)
    if (!(await decideOn(a, store, capabilityId, verb, on)).decision.allowed) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Review F1: the proposing installation. An undo is stored as proposed by the store's
// Listings installation (0032's catalog_proposal_bind), so it needs what the agent kernel
// (decideDelegation) requires of a Listings run's propose step on that store, beyond the
// person's own grants: the installation is active through the change's connection, its agent
// principal is active with exactly its document's grant set (installedBound), its scope covers
// the store resource and the fields, its owner is still a live member whose own grants cover
// `propose` on catalog.content.publish (grantCovers(owner)), and no stop blocks its runs
// (providerAllowed). Decided here before the broker's read; cmd_catalog_undo rechecks the
// liveness, the grant set, the stop and the owner's grants digest under its lock.
// Entitlement stays the gateway's: an undo costs no credits, and its apply is paid work that
// claimantMayApply decides with entitlement before any write.

/** catalog_undo_proposer's row, decoded closed: null when there is no active installation. */
export interface UndoProposer {
  readonly installationId: string;
  readonly agentPrincipalId: string;
  readonly scope: Current_Scope;
  readonly owner: Core_ActorRef;
  readonly ownerLive: boolean;
  readonly ownerGrants: readonly Current_Grant[] | "overflow";
  readonly ownerGrantsDigest: string;
  readonly agentGrantSet: "exact" | "differs" | "invalid" | "denied";
  readonly stopped: boolean;
}
const proposerKeys = [
  "agent_grant_set",
  "agent_principal_id",
  "installation_id",
  "owner_grant_count",
  "owner_grants",
  "owner_grants_digest",
  "owner_live",
  "owner_membership_id",
  "owner_principal_id",
  "scope",
  "stopped",
].join(",");
const flag = (value: unknown): boolean => {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new WorkContextUnavailable();
};
export function decodeUndoProposer(
  rows: readonly Record<string, unknown>[],
  a: WorkAuthority,
): UndoProposer | null {
  if (rows.length === 0) return null;
  const r = rows[0]!;
  if (rows.length !== 1 || Object.keys(r).sort().join(",") !== proposerKeys)
    throw new WorkContextUnavailable();
  const ids = [
    r.installation_id,
    r.agent_principal_id,
    r.owner_principal_id,
    r.owner_membership_id,
  ];
  if (
    !ids.every((v) => typeof v === "string" && idPattern.test(v)) ||
    typeof r.owner_grants_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.owner_grants_digest) ||
    !["exact", "differs", "invalid", "denied"].includes(r.agent_grant_set as string) ||
    typeof r.scope !== "string"
  )
    throw new WorkContextUnavailable();
  let scope: unknown;
  try {
    scope = JSON.parse(r.scope);
  } catch {
    throw new WorkContextUnavailable();
  }
  if (!validateCurrentDefinition("Scope", scope)) throw new WorkContextUnavailable();
  const owner: Core_ActorRef = Object.freeze({
    kind: "human",
    principalId: r.owner_principal_id as string,
    organizationId: a.actor.organizationId,
    workspaceId: a.resource.workspaceId,
    membershipId: r.owner_membership_id as string,
    installationId: null,
    mandateId: null,
  });
  if (!validateDefinition("core", "ActorRef", owner)) throw new WorkContextUnavailable();
  return Object.freeze({
    installationId: r.installation_id as string,
    agentPrincipalId: r.agent_principal_id as string,
    scope: scope as Current_Scope,
    owner,
    ownerLive: flag(r.owner_live),
    ownerGrants: decodeGrants(r.owner_grants, r.owner_grant_count),
    ownerGrantsDigest: r.owner_grants_digest,
    agentGrantSet: r.agent_grant_set as UndoProposer["agentGrantSet"],
    stopped: flag(r.stopped),
  });
}
const sameResource = (r: Current_ResourceRef, s: StoreResource) =>
  r.organizationId === s.organizationId &&
  r.workspaceId === s.workspaceId &&
  r.storeId === s.storeId &&
  r.connectionId === s.connectionId &&
  r.kind === s.kind &&
  r.id === s.id;
/**
 * Whether that installation may propose the undo, in the kernel's order (origin, capability,
 * provider): null when it may, else the refusal. Pure over the decoded facts (the owner's
 * grants decided by the human kernel at the request's database time).
 */
export async function undoProposerRefusal(
  a: WorkAuthority,
  store: StoreResource,
  fields: readonly string[],
  proposer: UndoProposer | null,
): Promise<"installation_inactive" | "denied" | "stopped" | null> {
  if (proposer === null || !proposer.ownerLive || proposer.agentGrantSet !== "exact")
    return "installation_inactive";
  const s = proposer.scope;
  if (
    fields.length < 1 ||
    s.organizationId !== store.organizationId ||
    s.workspaceId !== store.workspaceId ||
    !s.storeIds.includes(store.storeId) ||
    s.accountIds.length !== 0 ||
    !s.resources.some((r) => sameResource(r, store)) ||
    !fields.every((f) => s.fields.includes(f))
  )
    return "denied";
  if (proposer.ownerGrants === "overflow") return "denied";
  const owner: WorkAuthority = { ...a, actor: proposer.owner, grants: proposer.ownerGrants };
  const decided = await decideOn(owner, store, "catalog.content.publish", "propose", fields);
  if (!decided.decision.allowed) return "denied";
  if (proposer.stopped) return "stopped";
  return null;
}

export interface PreparedUndo {
  readonly operation: OperationRow;
  readonly store: StoreResource;
  readonly fields: readonly ListingField[];
  /** The installation that proposes it, as the kernel allowed it in this transaction. */
  readonly proposer: UndoProposer;
}
/**
 * The person's checks of one undo request, in their own session: the change is visible to
 * them (its proposal's read rule), the kernel allows the request, and the change is available
 * to undo. Anything not visible is not_found, like an absent operation.
 */
export async function prepareUndo(
  tx: WorkTx,
  a: WorkAuthority,
  operationId: string,
): Promise<PreparedUndo> {
  if (!uuid.test(operationId)) throw new UndoReject("not_found");
  const rows = await tx.run("operationById", [operationId]);
  if (rows.length !== 1) throw new UndoReject("not_found");
  const op = decodeOperation(rows[0]!);
  if (!(await operationVisible(tx, a, op))) throw new UndoReject("not_found");
  const stored = await readProposalRow(tx, a, op.proposalId);
  if (!stored) throw new UndoReject("not_found");
  const selected = stored.proposal.derivedFrom?.selectedTargetIndexes ?? null;
  const at = selected === null ? op.targetIndex : selected.indexOf(op.targetIndex);
  const target = stored.proposal.targets[at];
  if (!target || target.resource.id !== op.productId) throw new WorkContextUnavailable();
  const fields = target.fields.filter((f): f is ListingField =>
    (listingFields as readonly string[]).includes(f),
  );
  if (fields.length !== target.fields.length || fields.length < 1)
    throw new WorkContextUnavailable();
  let store: StoreResource;
  try {
    store = storeResource(
      a.actor.organizationId,
      a.resource.workspaceId,
      op.storeId,
      op.connectionId,
    );
  } catch {
    throw new WorkContextUnavailable();
  }
  if (!(await undoAllowed(a, store, fields))) throw new UndoReject("denied");
  // Review F1: the installation that proposes it may still propose there.
  const proposer = decodeUndoProposer(await tx.run("catalogUndoProposer", [operationId]), a);
  const refused = await undoProposerRefusal(a, store, fields, proposer);
  if (refused !== null || proposer === null)
    throw new UndoReject(refused ?? "installation_inactive");
  const source = await undoSource(tx, operationId);
  if (!source) throw new UndoReject("not_found");
  if (source.state !== "available") throw new UndoReject(undoStateRefusal(source.state));
  return Object.freeze({ operation: op, store, fields: Object.freeze([...fields]), proposer });
}

/** The undo command's request digest: the work API's command digest of its (empty) body. */
export function undoRequestDigest(workspaceId: string, operationId: string): Promise<string> {
  return sha256Hex(
    canonicalJson(["morrow.work.command", 1, "catalog.undo", workspaceId, [operationId], {}]),
  );
}

/** The undo item's `set`: each of the change's fields back to its value before the apply. */
export function undoSet(
  before: ListingFieldsRead,
  fields: readonly ListingField[],
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (fields.includes("title")) set.title = before.title;
  if (fields.includes("descriptionHtml")) set.descriptionHtml = before.descriptionHtml;
  if (fields.includes("seo.title") || fields.includes("seo.description"))
    set.seo = { title: before.seo.title ?? "", description: before.seo.description ?? "" };
  if (fields.includes("tags")) set.tags = [...before.tags];
  return set;
}
const characters = (text: string) => [...text].length;
/**
 * Whether Morrow can write that set: the bounds every drafted change keeps (migration
 * listings-runs' draft_set_valid; spine §7). A value outside them (a longer SEO title, more
 * than 50 tags) cannot be undone automatically.
 */
export function undoSetWritable(set: Record<string, unknown>): boolean {
  const title = set.title;
  if (
    title !== undefined &&
    (typeof title !== "string" || characters(title) < 1 || characters(title) > 255)
  )
    return false;
  const html = set.descriptionHtml;
  if (
    html !== undefined &&
    (typeof html !== "string" || new TextEncoder().encode(html).byteLength > 10000)
  )
    return false;
  const seo = set.seo as { title?: unknown; description?: unknown } | undefined;
  if (
    seo !== undefined &&
    (typeof seo.title !== "string" ||
      typeof seo.description !== "string" ||
      characters(seo.title) > 70 ||
      characters(seo.description) > 320)
  )
    return false;
  const tags = set.tags;
  if (
    tags !== undefined &&
    (!Array.isArray(tags) ||
      tags.length > 50 ||
      new Set(tags).size !== tags.length ||
      !tags.every((t) => typeof t === "string" && characters(t) >= 1 && characters(t) <= 64))
  )
    return false;
  return new TextEncoder().encode(canonicalJson(set)).byteLength <= 16000;
}
function parseBefore(text: string, productId: string): ListingFieldsRead {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new WorkContextUnavailable();
  }
  const seo = s.seo as Record<string, unknown> | undefined;
  if (
    s.productId !== productId ||
    typeof s.title !== "string" ||
    typeof s.descriptionHtml !== "string" ||
    !seo ||
    !(seo.title === null || typeof seo.title === "string") ||
    !(seo.description === null || typeof seo.description === "string") ||
    !Array.isArray(s.tags) ||
    !s.tags.every((t) => typeof t === "string")
  )
    throw new WorkContextUnavailable();
  return {
    productId,
    title: s.title,
    descriptionHtml: s.descriptionHtml,
    seo: { title: seo.title as string | null, description: seo.description as string | null },
    tags: s.tags as string[],
  };
}

export interface UndoAdmitted {
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly approvalId: string;
  readonly status: string;
  readonly expiresAt: string;
  readonly operationId: string;
  readonly replayed: boolean;
}
const text = (row: Record<string, unknown>, key: string) => {
  const value = row[key];
  if (typeof value !== "string") throw new WorkContextUnavailable();
  return value;
};
function admittedOf(result: unknown, replayed: boolean): UndoAdmitted {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(result as string) as Record<string, unknown>;
  } catch {
    throw new WorkContextUnavailable();
  }
  if (
    !v ||
    typeof v !== "object" ||
    Object.keys(v).sort().join(",") !==
      "approvalId,expiresAt,operationId,proposalDigest,proposalId,status" ||
    typeof v.proposalId !== "string" ||
    !idPattern.test(v.proposalId) ||
    typeof v.proposalDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.proposalDigest) ||
    typeof v.approvalId !== "string" ||
    !idPattern.test(v.approvalId) ||
    typeof v.status !== "string" ||
    typeof v.expiresAt !== "string" ||
    !utc.test(v.expiresAt) ||
    typeof v.operationId !== "string" ||
    !uuid.test(v.operationId)
  )
    throw new WorkContextUnavailable();
  return Object.freeze({
    proposalId: v.proposalId,
    proposalDigest: v.proposalDigest,
    approvalId: v.approvalId,
    status: v.status,
    expiresAt: v.expiresAt,
    operationId: v.operationId,
    replayed,
  });
}

/**
 * The person's own earlier undo command with this key (a replay): its recorded undo, or
 * command_conflict when the key was used for another request. Null when the key is new.
 */
export async function replayedUndo(
  tx: WorkTx,
  a: WorkAuthority,
  commandId: string,
  requestDigest: string,
): Promise<UndoAdmitted | null> {
  const rows = await tx.run("undoOfCommand", [a.actor.principalId, commandId]);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new WorkContextUnavailable();
  const u = rows[0]!;
  if (text(u, "request_digest") !== requestDigest) throw new UndoReject("command_conflict");
  const approvals = await tx.run("undoProposalApproval", [text(u, "proposal_id")]);
  if (approvals.length !== 1) throw new WorkContextUnavailable();
  const p = approvals[0]!;
  return Object.freeze({
    proposalId: text(u, "proposal_id"),
    proposalDigest: text(p, "digest"),
    approvalId: text(p, "approval_id"),
    status: text(p, "status"),
    expiresAt: text(p, "expires_at"),
    operationId: text(u, "operation_id"),
    replayed: true,
  });
}

/**
 * The undo proposal, after the broker's check recorded `checkSequence` with every field
 * unchanged: built from the change's before values and the check's read by the Listings
 * producer (one target, one item), then cmd_catalog_undo, which rebuilds and rechecks it.
 *
 * `checkSequence` null: the broker found a check of this change recorded less than 10
 * seconds ago (too_soon: this request's own, sent again after its reply was lost, or another
 * person's) and read nothing. The change's latest check then stands in, only while it is at
 * most `undoLimits.recentCheckMs` old by the database's clock; cmd_catalog_undo still requires
 * it to be the latest, every field unchanged and its read stored. It is a read of the product,
 * never an authority: every check of the person's own runs here again, and the gateway's
 * pre-send read guards the write.
 */
export const undoLimits = Object.freeze({ recentCheckMs: 30_000 });
export async function admitUndo(
  tx: WorkTx,
  a: WorkAuthority,
  prepared: PreparedUndo,
  commandId: string,
  requestDigest: string,
  checkSequence: number | null,
): Promise<UndoAdmitted> {
  const op = prepared.operation;
  const source = await undoSource(tx, op.operationId);
  if (!source) throw new UndoReject("not_found");
  if (source.state !== "available") throw new UndoReject(undoStateRefusal(source.state));
  const check = source.check;
  if (
    !check ||
    (checkSequence !== null && check.sequence !== checkSequence) ||
    source.before === null
  )
    throw new UndoReject("check_stale");
  if (check.verdict === "missing") throw new UndoReject("product_missing");
  if (check.verdict !== "unchanged" || check.digest === null)
    throw new UndoReject("changed_since_apply", check.changed);
  const before = parseBefore(source.before, op.productId);
  const set = undoSet(before, prepared.fields);
  if (!undoSetWritable(set)) throw new UndoReject("not_reversible");
  // The store's active Listings installation, through the change's connection: the proposer
  // a catalog proposal must have (0032), as prepareUndo's kernel allowed it (review F1).
  const proposer = prepared.proposer;
  const policies = await tx.run("currentReviewPolicy", []);
  if (policies.length !== 1) throw new WorkContextUnavailable();
  const policy = policies[0]!;
  const revision = Number(text(policy, "revision"));
  if (!Number.isSafeInteger(revision) || revision < 1) throw new WorkContextUnavailable();
  const ctx = await readContext(tx, a, "catalog.content.publish", null);
  // A check this request did not record itself stands in only while it is recent.
  if (
    checkSequence === null &&
    !(Date.parse(ctx.databaseNow) - Date.parse(check.observedAt) <= undoLimits.recentCheckMs)
  )
    throw new UndoReject("check_stale");
  const membershipId = a.actor.membershipId;
  if (membershipId === null) throw new UndoReject("denied");
  let packed;
  try {
    packed = packListingProposals(
      {
        organizationId: a.actor.organizationId,
        workspaceId: a.resource.workspaceId,
        storeId: op.storeId,
        connectionId: op.connectionId,
        taskId: op.taskId,
        installationId: proposer.installationId,
        agentPrincipalId: proposer.agentPrincipalId,
        requesterPrincipalId: a.actor.principalId,
        requesterMembershipId: membershipId,
      },
      [
        {
          draftId: op.operationId,
          productIndex: 0,
          productId: op.productId,
          snapshotDigest: check.digest,
          fields: prepared.fields,
          setCanonical: canonicalJson(set),
        },
      ],
      {
        revision,
        canonical: text(policy, "canonical"),
        digest: text(policy, "digest"),
      },
      ctx.databaseNow,
      () => crypto.randomUUID(),
    );
  } catch {
    // The set was checked writable above, so only a stored policy that no longer decodes
    // fails here.
    throw new WorkContextUnavailable();
  }
  if (packed.length !== 1) throw new WorkContextUnavailable();
  const p = packed[0]!;
  tx.markSubmitted();
  const rows = await tx.run("cmdCatalogUndo", [
    commandId,
    requestDigest,
    op.operationId,
    String(check.sequence),
    p.approvalId,
    p.policyDigest,
    p.parametersCanonical,
    p.parametersDigest,
    p.proposalCanonical,
    p.proposalDigest,
    p.scopeCanonical,
    proposer.ownerGrantsDigest,
  ]);
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || typeof row.outcome !== "string") throw new WorkContextUnavailable();
  if (row.outcome === "applied" || row.outcome === "replayed")
    return admittedOf(row.result, row.outcome === "replayed");
  tx.rollbackOnly();
  const known: readonly string[] = [
    "not_found",
    "not_applied",
    "already_requested",
    "already_undone",
    "changed_since_apply",
    "unavailable",
    "check_stale",
    "product_missing",
    "not_reversible",
    "link_changed",
    "installation_inactive",
    "stopped",
    "limit_reached",
    "stale_authority",
    "command_conflict",
    "invalid",
  ];
  if (row.outcome === "ineligible") throw new UndoReject("stale_authority");
  if (known.includes(row.outcome)) throw new UndoReject(row.outcome as UndoRefusal);
  throw new WorkContextUnavailable();
}

/** Whether a proposal undoes a change: that change's ids and when it was applied. */
export interface UndoOfView {
  readonly operationId: string;
  readonly proposalId: string;
  readonly productId: string;
  readonly appliedAt: string | null;
}
export async function undoOfProposal(tx: WorkTx, familyRootId: string): Promise<UndoOfView | null> {
  const rows = await tx.run("undoOfProposal", [familyRootId]);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new WorkContextUnavailable();
  const r = rows[0]!;
  if (!nullable(r.applied_at, utc)) throw new WorkContextUnavailable();
  return Object.freeze({
    operationId: text(r, "operation_id"),
    proposalId: text(r, "proposal_id"),
    productId: text(r, "product_id"),
    appliedAt: r.applied_at as string | null,
  });
}
