import type { Core_ApprovalRef, Core_ProposalRef, Current_Proposal } from "@morrow/contracts";
import { confirmationPhrase, effectiveRule } from "@morrow/policy/review";
import {
  decideApproval,
  proposalStore,
  readProposal,
  storeLinkCurrent,
  type ApprovalRefusal,
} from "../approvals/index.js";
import { readContext, readProposalRow, type ReviewContext } from "../approvals/family.js";
import { beginApprovalCommand } from "../approvals/outcomes.js";
import { viewerRole } from "../approvals/reads.js";
import type { WorkTx } from "../connection.js";
import { WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { canonicalJson, sha256Hex, workRequestDigest } from "../digest.js";

// "Approve several at once" (v1 PR 4; ADR-0024 item 9; ADR-0011): one confirmation over a
// server-built document of the pending changes waiting on one task, all of one capability and
// store. The document lists each proposal's exact digest and approval revision, is bound to
// the person and their session, and lasts 5 minutes; its digest is what the person confirms.
// The decision rebuilds the document from the records at that moment and must reach the same
// digest (a change added, edited, decided or expired since means a new review), then records
// one exact approval per proposal, each through the ordinary decide path (the reviewer's
// eligibility, the digest, the revision, the policy and every counted reviewer rechecked), all
// in one transaction: one refusal refuses them all. Single use: once decided, each approval's
// revision has moved on, so the same document never decides again (the same Idempotency-Key
// replays the recorded decisions). Each approved change is still claimed and applied on its
// own, and the gateway rechecks it before any write.
//
// A solo owner types ONE phrase for the whole batch (ADR-0024 item 9, amending ADR-0011 Q3):
// "approve N changes for C credits", N and C summed over the members (the document carries
// it; the person types it exactly, NFC, case-sensitive). The decision checks it against the
// rebuilt document in code before any member is decided; each member is then decided through
// the ordinary path with its own phrase (the library rechecks it, and the decision records
// that member's phrase digest, as a single approval does). A batch in which a member that
// needs the phrase carries a money cost is not offered (cost_confirmation: summing amounts
// across currencies is not defined here), nor one where some members need the phrase and
// others don't (mixed_confirmation). Teams batch without a phrase. The members' cool-down
// times are each decision's own time plus the policy's cool-down, milliseconds apart in one
// transaction (ADR-0024 says one effectiveAt; noted in the brief). It takes 2 to 10
// proposals (ADR-0024 allows up to 50; ten keeps the decisions inside one short transaction
// until measured on Neon).

export const batchLimits = Object.freeze({ min: 2, max: 10, lifetimeMs: 300_000 });
const capability = "catalog.content.publish";

export interface BatchItem {
  readonly proposalId: string;
  readonly digest: string;
  readonly approvalId: string;
  readonly revision: number;
  readonly targetCount: number;
  readonly expiresAt: string;
}
/** A member as the server decides it: its own phrase when this person must type one. */
interface BatchMember extends BatchItem {
  readonly phrase: string | null;
  readonly credits: bigint;
  readonly cost: boolean;
}
export interface BatchDocument {
  readonly proposalId: string;
  readonly taskId: string;
  readonly storeId: string;
  readonly items: readonly BatchItem[];
  /**
   * Why no batch is offered, or null when it is: too_few (fewer than 2), cost_confirmation (a
   * member needing the phrase has a money cost) or mixed_confirmation (only some need it).
   */
  readonly unavailable: "too_few" | "cost_confirmation" | "mixed_confirmation" | null;
  /** The solo owner's one phrase for the whole batch (ADR-0024 item 9), when required. */
  readonly confirmation: { readonly required: boolean; readonly phrase: string | null };
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly documentDigest: string;
}
export type BatchRefusal = ApprovalRefusal | "batch_changed" | "batch_expired";

/** The batch's one phrase: N changes (every member's targets) for C credits (their sum). */
export function batchPhrase(members: readonly { targetCount: number; credits: bigint }[]): string {
  const n = members.reduce((sum, m) => sum + m.targetCount, 0);
  const c = members.reduce((sum, m) => sum + m.credits, 0n);
  return `approve ${n} ${n === 1 ? "change" : "changes"} for ${c} credits`.normalize("NFC");
}
/** The document's confirmation and availability, from its members (pure). */
export function batchConfirmation(
  members: readonly {
    targetCount: number;
    credits: bigint;
    phrase: string | null;
    cost: boolean;
  }[],
): Pick<BatchDocument, "unavailable" | "confirmation"> {
  const needing = members.filter((m) => m.phrase !== null);
  const required = needing.length > 0;
  const unavailable =
    members.length < batchLimits.min
      ? "too_few"
      : required && needing.length !== members.length
        ? "mixed_confirmation"
        : needing.some((m) => m.cost)
          ? "cost_confirmation"
          : null;
  return {
    unavailable,
    confirmation: {
      required,
      phrase: required && unavailable === null ? batchPhrase(members) : null,
    },
  };
}
export class BatchReject extends Error {
  constructor(readonly reason: BatchRefusal | "not_found" | "invalid" | "link_changed") {
    super("BATCH_REJECTED");
    this.name = "BatchReject";
  }
}

/** The document's digest: the person, their session, its time and each item's exact refs. */
export function batchDigest(
  workspaceId: string,
  a: WorkAuthority,
  sessionDigest: string,
  issuedAt: string,
  items: readonly BatchItem[],
): Promise<string> {
  return sha256Hex(
    canonicalJson([
      "morrow.approval.batch",
      1,
      workspaceId,
      a.actor.principalId,
      a.actor.membershipId,
      sessionDigest,
      issuedAt,
      items.map((i) => [i.proposalId, i.digest, i.approvalId, i.revision]),
    ]),
  );
}

/**
 * The batch document of the changes waiting on `proposalId`'s task: every pending, unexpired
 * root proposal of the same task, capability and store that this person may approve now
 * (reviewer role, an exact approval reference, the store still linked), in creation order, at
 * most ten. `issuedAt` is the database's time (a decision passes the document's own).
 */
export async function buildBatch(
  tx: WorkTx,
  a: WorkAuthority,
  sessionDigest: string,
  proposalId: string,
  issuedAt: string | null,
): Promise<BatchDocument> {
  const built = await buildMembers(tx, a, sessionDigest, proposalId, issuedAt);
  return built.document;
}
/** The solo owner's typed confirmation of one proposal (ADR-0011 Q3), as review decides it. */
function memberPhrase(
  a: WorkAuthority,
  policy: ReviewContext["policy"],
  p: Current_Proposal,
): string | null {
  const conflicted = [
    p.proposedBy.principalId,
    p.requestedBy.principalId,
    ...p.beneficiaryPrincipalIds,
  ].includes(a.actor.principalId);
  return policy !== null &&
    conflicted &&
    effectiveRule(policy.rules, p.risk, p.irreversible).selfApproval ===
      "solo_owner_typed_confirmation"
    ? confirmationPhrase(p)
    : null;
}
async function buildMembers(
  tx: WorkTx,
  a: WorkAuthority,
  sessionDigest: string,
  proposalId: string,
  issuedAt: string | null,
): Promise<{ readonly document: BatchDocument; readonly members: readonly BatchMember[] }> {
  const anchor = await readProposalRow(tx, a, proposalId);
  if (!anchor) throw new BatchReject("not_found");
  const anchorView = await readProposal(tx, a, proposalId, null);
  if (anchorView === "not_found" || anchorView === "invalid") throw new BatchReject("not_found");
  const store = proposalStore(anchor.proposal);
  if (
    anchor.proposal.capabilityId !== capability ||
    store === null ||
    store === "invalid" ||
    anchor.proposal.taskId === null
  )
    throw new BatchReject("not_found");
  if (!(await storeLinkCurrent(tx, store))) throw new BatchReject("link_changed");
  const ctx = await readContext(tx, a, capability, null);
  const at = issuedAt ?? ctx.databaseNow;
  const rows = await tx.run("pendingOfTask", [anchor.proposal.taskId, capability, store.storeId]);
  const items: BatchMember[] = [];
  for (const row of rows) {
    if (typeof row.id !== "string") throw new WorkContextUnavailable();
    if (items.length >= batchLimits.max) break;
    const view = await readProposal(tx, a, row.id, null);
    if (view === "not_found" || view === "invalid") continue;
    const p = view.proposal;
    if (
      view.viewerRole !== "reviewer" ||
      view.approval === null ||
      view.approval.status !== "pending" ||
      view.approvalRef === null ||
      p.derivedFrom !== null ||
      p.storeId !== store.storeId
    )
      continue;
    let credits: bigint;
    try {
      credits = BigInt(p.maximumCredits);
    } catch {
      throw new WorkContextUnavailable();
    }
    items.push(
      Object.freeze({
        proposalId: p.id,
        digest: p.proposalDigest,
        approvalId: view.approval.id,
        revision: view.approval.revision,
        targetCount: p.targets.length,
        expiresAt: view.approval.expiresAt,
        phrase: memberPhrase(a, ctx.policy, p),
        credits,
        cost: p.maximumCost !== null,
      }),
    );
  }
  const expiresAt = new Date(Date.parse(at) + batchLimits.lifetimeMs).toISOString();
  const shown = items.map(
    ({ proposalId: id, digest, approvalId, revision, targetCount, expiresAt: until }) =>
      Object.freeze({
        proposalId: id,
        digest,
        approvalId,
        revision,
        targetCount,
        expiresAt: until,
      }),
  );
  const document: BatchDocument = Object.freeze({
    proposalId,
    taskId: anchor.proposal.taskId,
    storeId: store.storeId,
    items: Object.freeze(shown),
    ...batchConfirmation(items),
    issuedAt: at,
    expiresAt,
    documentDigest: await batchDigest(a.resource.workspaceId, a, sessionDigest, at, shown),
  });
  return Object.freeze({ document, members: Object.freeze(items) });
}

/** A command id per batch member, derived from the batch's own key (a replay repeats it). */
async function memberCommandId(batchKey: string, proposalId: string): Promise<string> {
  const h = await sha256Hex(canonicalJson(["morrow.approval.batch.member", batchKey, proposalId]));
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join(
    "-",
  );
}

export interface BatchDecided {
  readonly replayed: boolean;
  readonly decided: readonly {
    readonly proposalRef: Core_ProposalRef;
    readonly approvalRef: Core_ApprovalRef;
    readonly status: string;
    readonly expiresAt: string;
  }[];
}
/**
 * The confirmed document as the decision names it: its digest, time, members' refs and the
 * solo owner's one typed phrase (null when the document needs none).
 */
export interface BatchDecisionBody {
  readonly documentDigest: string;
  readonly issuedAt: string;
  readonly soloOwnerConfirmation: string | null;
  readonly items: readonly {
    readonly proposalId: string;
    readonly digest: string;
    readonly approvalId: string;
    readonly revision: number;
  }[];
}
const hex64 = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const utc = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
/**
 * Exactly {documentDigest, issuedAt, items, soloOwnerConfirmation}: 2 to 10 distinct members'
 * exact refs, and the typed phrase or null (at most 256 characters, as a single decision's).
 */
export function parseBatchDecision(body: unknown): BatchDecisionBody | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).sort().join(",") !== "documentDigest,issuedAt,items,soloOwnerConfirmation")
    return null;
  if (typeof b.documentDigest !== "string" || !hex64.test(b.documentDigest)) return null;
  if (typeof b.issuedAt !== "string" || !utc.test(b.issuedAt)) return null;
  if (
    !(
      b.soloOwnerConfirmation === null ||
      (typeof b.soloOwnerConfirmation === "string" &&
        b.soloOwnerConfirmation.length >= 1 &&
        b.soloOwnerConfirmation.length <= 256)
    )
  )
    return null;
  if (
    !Array.isArray(b.items) ||
    b.items.length < batchLimits.min ||
    b.items.length > batchLimits.max
  )
    return null;
  const items = [];
  for (const raw of b.items as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const i = raw as Record<string, unknown>;
    if (Object.keys(i).sort().join(",") !== "approvalId,digest,proposalId,revision") return null;
    if (
      typeof i.proposalId !== "string" ||
      !idPattern.test(i.proposalId) ||
      typeof i.digest !== "string" ||
      !hex64.test(i.digest) ||
      typeof i.approvalId !== "string" ||
      !idPattern.test(i.approvalId) ||
      !Number.isSafeInteger(i.revision) ||
      (i.revision as number) < 1
    )
      return null;
    items.push(
      Object.freeze({
        proposalId: i.proposalId,
        digest: i.digest,
        approvalId: i.approvalId,
        revision: i.revision as number,
      }),
    );
  }
  if (new Set(items.map((i) => i.proposalId)).size !== items.length) return null;
  return Object.freeze({
    documentDigest: b.documentDigest,
    issuedAt: b.issuedAt,
    soloOwnerConfirmation: b.soloOwnerConfirmation as string | null,
    items: Object.freeze(items),
  });
}

/**
 * The batch decision, in one transaction. The body's members must hash, with this person's
 * session and the document's time, to the confirmed digest. A key already used for this batch
 * replays every member's recorded decision. Otherwise the document rebuilt at its own time
 * must reach the same digest, within its 5 minutes of database time, be offered, and, when it
 * needs the solo owner's phrase, the typed phrase must be exactly its one phrase (and no
 * phrase is accepted where none is needed); then one approve decision per member through
 * decideApproval, each with that member's own phrase where it needs one. The first refusal
 * rolls every decision back.
 */
export async function decideBatch(
  tx: WorkTx,
  a: WorkAuthority,
  sessionDigest: string,
  proposalId: string,
  batchKey: string,
  body: BatchDecisionBody,
  correlationId: string,
): Promise<BatchDecided> {
  const ws = a.resource.workspaceId;
  // A proposal this person cannot read is not found, like an absent one.
  const anchor = await readProposalRow(tx, a, proposalId);
  if (!anchor || (await viewerRole(a, anchor)) === null) throw new BatchReject("not_found");
  const named = body.items.map((i) => ({ ...i, targetCount: 0, expiresAt: "" }));
  if ((await batchDigest(ws, a, sessionDigest, body.issuedAt, named)) !== body.documentDigest)
    throw new BatchReject("batch_changed");
  // Each member's own phrase, where this person must type one for it (the same rule as the
  // document's), so that a replay rebuilds the same member requests.
  const policy = (await readContext(tx, a, capability, null)).policy;
  const members: {
    readonly proposalId: string;
    readonly body: {
      readonly decision: {
        readonly decision: "approve";
        readonly selectedTargetIndexes: null;
        readonly expectedDecisionDigest: string;
        readonly soloOwnerConfirmation: string | null;
        readonly comment: null;
      };
      readonly expectedRevision: number;
    };
    readonly commandId: string;
    readonly requestDigest: string;
  }[] = [];
  for (const item of body.items) {
    const stored = await readProposalRow(tx, a, item.proposalId);
    if (!stored || (await viewerRole(a, stored)) === null) throw new BatchReject("not_found");
    const phrase =
      body.soloOwnerConfirmation === null ? null : memberPhrase(a, policy, stored.proposal);
    const decision = {
      decision: {
        decision: "approve" as const,
        selectedTargetIndexes: null,
        expectedDecisionDigest: item.digest,
        soloOwnerConfirmation: phrase,
        comment: null,
      },
      expectedRevision: item.revision,
    };
    members.push({
      proposalId: item.proposalId,
      body: decision,
      commandId: await memberCommandId(batchKey, item.proposalId),
      requestDigest: await workRequestDigest("approval.decide", ws, [item.proposalId], decision),
    });
  }
  const first = await beginApprovalCommand(
    tx,
    "approval.decide",
    members[0]!.commandId,
    members[0]!.requestDigest,
  );
  if (first.kind === "conflict") throw new BatchReject("COMMAND_CONFLICT");
  if (first.kind === "ineligible") throw new BatchReject("unauthenticated");
  if (first.kind === "invalid") throw new BatchReject("invalid");
  const replay = first.kind === "replay";
  if (!replay) {
    const ctx = await readContext(tx, a, capability, null);
    const now = Date.parse(ctx.databaseNow);
    const issued = Date.parse(body.issuedAt);
    if (!(issued <= now && now < issued + batchLimits.lifetimeMs))
      throw new BatchReject("batch_expired");
    const built = await buildMembers(tx, a, sessionDigest, proposalId, body.issuedAt);
    const document = built.document;
    if (document.documentDigest !== body.documentDigest) throw new BatchReject("batch_changed");
    if (document.unavailable !== null) throw new BatchReject("invalid");
    // ADR-0024 item 9: one typed phrase for the whole batch, exactly as the document says.
    const typed = body.soloOwnerConfirmation;
    if (
      document.confirmation.required
        ? typed === null || typed.normalize("NFC") !== document.confirmation.phrase
        : typed !== null
    )
      throw new BatchReject("CONFIRMATION_MISMATCH");
    if (
      built.members.some(
        (m, i) =>
          m.proposalId !== members[i]!.proposalId ||
          m.phrase !== members[i]!.body.decision.soloOwnerConfirmation,
      )
    )
      throw new BatchReject("batch_changed");
  }
  const decided: BatchDecided["decided"][number][] = [];
  for (const m of members) {
    const result = await decideApproval(tx, a, {
      commandId: m.commandId,
      requestDigest: m.requestDigest,
      proposalId: m.proposalId,
      body: m.body,
      correlationId,
    });
    if (result.outcome === "refused") {
      tx.rollbackOnly();
      throw new BatchReject(result.code);
    }
    // A replay replays every member; a new batch decides every member anew.
    if ((result.outcome === "replayed") !== replay) {
      tx.rollbackOnly();
      throw new BatchReject("batch_changed");
    }
    decided.push(
      Object.freeze({
        proposalRef: result.proposalRef,
        approvalRef: result.approvalRef,
        status: result.status,
        expiresAt: result.expiresAt,
      }),
    );
  }
  return Object.freeze({ replayed: replay, decided: Object.freeze(decided) });
}
