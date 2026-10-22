import type { CapabilityId, Current_HumanActorRef, Current_ResourceRef } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import {
  createHumanPolicyService,
  isCurrentGrant,
  type HumanAuthority,
  type PermissionResult,
  type PermissionVerb,
} from "@morrow/policy";
import type { KillSwitchTargetFacts, KillSwitchTargetRequest } from "@morrow/policy/kill-switch";
import {
  activeCatalogueVersion,
  catalogueListing,
  checkWorkspaceDefault,
  defaultMemberCreditCeiling,
  defaultSelection,
  findCatalogueEntry,
  memberMayPick,
} from "@morrow/policy/model-catalogue";
import {
  listingFieldPaths,
  storeResource,
  type StoreResource,
} from "@morrow/policy/store-resource";
import { WorkReject, type WorkRejection, type WorkTx } from "../connection.js";
import { enterWorkContext, WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { canonicalJson, sha256Hex } from "../digest.js";
import { planStopAiWork, stopAiWorkRecord } from "../stops.js";
import {
  parseDocumentBody,
  parseEnableBody,
  parseModelDefaultBody,
  parseStopBody,
  type EnableBody,
  type ModelDefaultBody,
  type StopBody,
} from "./bodies.js";
import {
  buildInstallationDocument,
  disableFields,
  enableRequestFields,
  installationGrants,
  installationResource,
  listingsRelease,
  listingsReleaseDigest,
  ownerDisableGrant,
  parseInstallationDocument,
  resumeDocumentMatches,
  type PinnedInstallation,
} from "./listings.js";
import type {
  GuardedWorkspaceRequest as GuardedRequest,
  WorkspaceRouteSpec,
} from "../http-guard.js";
// Any guarded agents request (the route family does not matter to the commands).
type GuardedWorkspaceRequest = GuardedRequest<WorkspaceRouteSpec>;

// The agents commands and reads (M3 PR-1; ADR-0022 items 3, 15 and 16 with the item 3
// amendment of 2026-10-20). Each runs the human kernel (packages/policy) on the exact
// resource it acts on, with the database clock of its own enter_context() snapshot, before
// its definer; the definer rechecks authority under lock (the P06.T01a prelude) and every
// data rule. Denials and conflicts persist nothing; an unknown outcome is never reported
// as success or denial.
//   * "Enable Listings agent" is two commands: the server builds the installation document
//     (release, store resource, exact grant set, the owner's disable grant), bound to the
//     actor, the session, five minutes and a single-use nonce; the owner's confirmation of
//     that document's digest and nonce creates (or, after the owner's own "Stop AI work",
//     resumes) the installation. agents.installation.activate is review_required: the
//     confirmed document is the exact approval its kernel obligation names. A resume
//     document must be exactly the installation it reactivates (its release digest, its
//     store resource with the connection, its grant set), at both steps; any difference is
//     a state conflict (the installation is then uninstalled and enabled afresh).
//   * "Stop AI work" is the human-only kill switch agents.installation.disable: kernel,
//     then checkKillSwitchTarget (planStopAiWork), then the KillSwitchRecord commits with
//     the stop. It never reads entitlement or credits.
//   * The model default is governance.model_default.revise; GET /models lists the active
//     catalogue entries with what the member may pick (the member ceiling).
import type { AgentCommandType, AgentRead } from "./types.js";
export type { AgentCommandType, AgentRead } from "./types.js";
export interface AgentResult {
  readonly status: 200 | 201;
  readonly body: Readonly<Record<string, unknown>>;
  readonly outcome: string;
}
export interface PreparedAgentCommand {
  readonly type: AgentCommandType;
  readonly parsed: unknown;
  readonly digest: string;
}

/** The request digest: canonical JSON of the command, its workspace, path ids and body. */
export function agentRequestDigest(
  type: AgentCommandType,
  workspaceId: string,
  pathIds: readonly string[],
  body: unknown,
): Promise<string> {
  return sha256Hex(
    canonicalJson(["morrow.work.command", 1, type, workspaceId, [...pathIds], body]),
  );
}
const parsers: Readonly<Record<AgentCommandType, (body: unknown) => unknown>> = Object.freeze({
  "installation.document": parseDocumentBody,
  "installation.enable": parseEnableBody,
  "installation.stop": parseStopBody,
  "model_default.revise": parseModelDefaultBody,
});
const pathIdsOf = (g: GuardedWorkspaceRequest) =>
  g.params.storeId === undefined ? [] : [g.params.storeId];
/** Step 1, with no I/O: the strict body and the request digest. */
export async function prepareAgentCommand(
  type: AgentCommandType,
  g: GuardedWorkspaceRequest,
): Promise<PreparedAgentCommand> {
  const parsed = parsers[type](g.body);
  if (parsed === null) throw new WorkReject("invalid");
  const digest = await agentRequestDigest(type, g.workspaceId, pathIdsOf(g), g.body);
  return Object.freeze({ type, parsed, digest });
}

// ---------------------------------------------------------------------------
// The kernel on one resource. Agents commands are never paid work, so entitlement is the
// literal false every builder but the billing reader passes (inspectEntitlementWriters).
export async function decideOn(
  a: WorkAuthority,
  resource: Current_ResourceRef,
  capabilityId: CapabilityId,
  verb: PermissionVerb,
  fields: readonly string[],
): Promise<PermissionResult> {
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
  return service.decide({ capabilityId, verb, resource, accountId: null, fields: [...fields] });
}
/**
 * May this actor enable (or resume) the Listings agent on this store? agents.installation.
 * activate {execute} on the store resource (review_required: its exact_approval obligation
 * is met by the confirmed document), and the actor holds every verb the installation's
 * grants carry, on the same resource and fields (an installation never exceeds its owner).
 */
export async function enableAllowed(a: WorkAuthority, store: StoreResource): Promise<boolean> {
  const activate = await decideOn(
    a,
    store,
    "agents.installation.activate",
    "execute",
    enableRequestFields,
  );
  if (!activate.decision.allowed || !activate.obligations.includes("exact_approval")) return false;
  for (const [capabilityId, verb] of [
    ["catalog.products.read", "view"],
    ["catalog.content.propose", "execute"],
    ["catalog.content.publish", "propose"],
  ] as const) {
    const held = await decideOn(a, store, capabilityId, verb, listingFieldPaths);
    if (!held.decision.allowed) return false;
  }
  return true;
}
export async function stopAllowed(
  a: WorkAuthority,
  installation: Current_ResourceRef,
): Promise<boolean> {
  const decided = await decideOn(
    a,
    installation,
    "agents.installation.disable",
    "execute",
    disableFields,
  );
  return decided.decision.allowed && decided.obligations.includes("kill_switch_record");
}
const reviseFields = Object.freeze(["effort", "expectedRevision", "maxCreditsPerProduct", "model"]);
export async function reviseAllowed(a: WorkAuthority): Promise<boolean> {
  const decided = await decideOn(
    a,
    a.resource,
    "governance.model_default.revise",
    "execute",
    reviseFields,
  );
  return decided.decision.allowed;
}

// ---------------------------------------------------------------------------
// Fixed row decoders. Any other shape is WorkContextUnavailable (a 503, never a guess).
const text = (row: Record<string, unknown>, key: string) => {
  const value = row[key];
  if (typeof value !== "string") throw new WorkContextUnavailable();
  return value;
};
const optional = (row: Record<string, unknown>, key: string) =>
  row[key] === null ? null : text(row, key);
const one = (rows: readonly Record<string, unknown>[]) => {
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0]) throw new WorkContextUnavailable();
  return rows[0];
};
export interface InstallationRow extends PinnedInstallation {
  readonly revision: number;
  readonly agentPrincipalId: string;
  readonly status: "active" | "disabled";
  readonly updatedAt: string;
}
async function context(tx: WorkTx, g: GuardedWorkspaceRequest): Promise<WorkAuthority> {
  const a = await enterWorkContext(tx, g.sessionDigest, g.workspaceId);
  if (a === "ineligible") throw new WorkReject("unauthenticated");
  if (a === "grant_overflow") throw new WorkReject("grant_overflow");
  return a;
}
/** The store resource of the path's store, from its current association (else null). */
async function storeOf(
  tx: WorkTx,
  a: WorkAuthority,
  storeId: string,
): Promise<StoreResource | null> {
  const row = one(await tx.run("storeAssociation", [storeId]));
  if (!row) return null;
  if (text(row, "store_id") !== storeId) throw new WorkContextUnavailable();
  return storeResource(
    a.actor.organizationId,
    a.resource.workspaceId,
    storeId,
    text(row, "connection_id"),
  );
}
async function installationOf(tx: WorkTx, storeId: string): Promise<InstallationRow | null> {
  const row = one(await tx.run("listingsInstallation", [storeId]));
  if (!row) return null;
  const status = text(row, "status");
  const revision = Number(text(row, "revision"));
  const releaseRevision = Number(text(row, "release_revision"));
  if (
    (status !== "active" && status !== "disabled") ||
    !Number.isSafeInteger(revision) ||
    !Number.isSafeInteger(releaseRevision)
  )
    throw new WorkContextUnavailable();
  if (text(row, "store_id") !== storeId) throw new WorkContextUnavailable();
  let scope: unknown;
  try {
    scope = JSON.parse(text(row, "scope"));
  } catch {
    throw new WorkContextUnavailable();
  }
  return Object.freeze({
    id: text(row, "id"),
    revision,
    storeId,
    connectionId: text(row, "connection_id"),
    agentPrincipalId: text(row, "agent_principal_id"),
    status,
    release: Object.freeze({
      id: text(row, "release_id"),
      revision: releaseRevision,
      digest: text(row, "release_digest"),
    }),
    scope,
    updatedAt: text(row, "updated_at"),
  });
}
/**
 * Whether this installation could resume on this store: its connection is the store's
 * current one and its release is the current Listings release (a document names both).
 */
async function resumable(installation: InstallationRow, store: StoreResource | null) {
  return (
    store !== null &&
    installation.connectionId === store.connectionId &&
    installation.release.id === listingsRelease.id &&
    installation.release.revision === listingsRelease.revision &&
    installation.release.digest === (await listingsReleaseDigest())
  );
}
async function openStopOf(tx: WorkTx, installationId: string) {
  const row = one(await tx.run("installationStop", [installationId]));
  if (!row) return null;
  const kind = text(row, "set_by_kind");
  if (kind !== "human" && kind !== "system" && kind !== "operator")
    throw new WorkContextUnavailable();
  return {
    id: text(row, "id"),
    setByKind: kind,
    reasonCode: text(row, "reason_code"),
    recordId: optional(row, "kill_switch_record_id"),
  };
}
/** A person's own "Stop AI work" (with its KillSwitchRecord): the only stop a resume lifts. */
const ownStop = (stop: Awaited<ReturnType<typeof openStopOf>>) =>
  stop !== null &&
  stop.setByKind === "human" &&
  stop.reasonCode === "human_stop_ai_work" &&
  stop.recordId !== null;

// ---------------------------------------------------------------------------
// Command plumbing.
const sqlOutcomes: Readonly<Record<string, WorkRejection>> = Object.freeze({
  invalid: "invalid",
  ineligible: "unauthenticated",
  not_found: "not_found",
  revision_conflict: "revision_conflict",
  state_conflict: "state_conflict",
  stopped: "state_conflict",
  guard_failed: "guard_failed",
  stale_authority: "stale_authority",
  command_conflict: "command_conflict",
  limit_reached: "limit_reached",
});
function decodeResult(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new WorkContextUnavailable();
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new WorkContextUnavailable();
  return parsed as Record<string, unknown>;
}
/** Replay first: a recorded command returns its recorded result and changes nothing. */
async function begin(
  tx: WorkTx,
  g: GuardedWorkspaceRequest,
  prepared: PreparedAgentCommand,
): Promise<AgentResult | null> {
  if (g.commandId === null) throw new WorkReject("invalid");
  const b = one(await tx.run("beginAgentCommand", [prepared.type, g.commandId, prepared.digest]));
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
    | "cmdListingsEnableDocument"
    | "cmdListingsEnable"
    | "cmdStopAiWork"
    | "cmdModelDefaultRevise",
  values: (string | null)[],
): Promise<Record<string, unknown>> {
  tx.markSubmitted();
  const row = one(await tx.run(statement, values));
  if (!row || typeof row.outcome !== "string") throw new WorkContextUnavailable();
  if (row.outcome !== "applied") {
    tx.rollbackOnly();
    throw new WorkReject(sqlOutcomes[row.outcome] ?? "unavailable");
  }
  return decodeResult(row.result);
}
const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const humanActor = (a: WorkAuthority): Current_HumanActorRef => {
  const actor = {
    kind: "human",
    principalId: a.actor.principalId,
    organizationId: a.actor.organizationId,
    workspaceId: a.resource.workspaceId,
    membershipId: a.actor.membershipId,
    installationId: null,
    mandateId: null,
  };
  if (!validateCurrentDefinition("HumanActorRef", actor)) throw new WorkContextUnavailable();
  return actor as Current_HumanActorRef;
};

// ---------------------------------------------------------------------------
// "Enable Listings agent", step 1: the installation document.
async function enableDocument(
  tx: WorkTx,
  g: GuardedWorkspaceRequest,
  prepared: PreparedAgentCommand,
  correlationId: string,
): Promise<AgentResult> {
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return { ...replay, body: { ...replay.body, nonce: null } };
  const storeId = g.params.storeId!;
  const store = await storeOf(tx, a, storeId);
  if (!store) throw new WorkReject("not_found");
  if (!(await enableAllowed(a, store))) throw new WorkReject("denied");
  const installation = await installationOf(tx, storeId);
  let purpose: "enable" | "resume";
  let installationId: string;
  if (!installation) {
    purpose = "enable";
    installationId = crypto.randomUUID();
  } else {
    const stop = installation.status === "disabled" ? await openStopOf(tx, installation.id) : null;
    // Only the owner's own "Stop AI work" (a person's installation stop) resumes this way.
    if (!ownStop(stop)) throw new WorkReject("state_conflict");
    purpose = "resume";
    installationId = installation.id;
  }
  const nonce = randomHex(32);
  const built = await buildInstallationDocument({
    id: crypto.randomUUID(),
    purpose,
    store,
    installationId,
    actor: a.actor,
    createdAtMs: a.databaseNowMs,
  });
  // A resume document names the store's current resource and the current release; the
  // installation it reactivates must be exactly that (its own release, connection and
  // grant scope), or the owner would confirm something other than what resumes.
  if (installation && !resumeDocumentMatches(installation, built.document))
    throw new WorkReject("state_conflict");
  const result = await submit(tx, "cmdListingsEnableDocument", [
    g.commandId,
    prepared.digest,
    correlationId,
    storeId,
    purpose,
    installationId,
    built.document.id,
    built.canonical,
    built.digest,
    await sha256Hex(nonce),
  ]);
  if (result.documentDigest !== built.digest) throw new WorkContextUnavailable();
  return {
    status: 201,
    body: { ...result, document: built.document, nonce },
    outcome: "applied",
  };
}

// "Enable Listings agent", step 2: the owner confirms the document's digest with its nonce.
async function enable(
  tx: WorkTx,
  g: GuardedWorkspaceRequest,
  prepared: PreparedAgentCommand,
  correlationId: string,
): Promise<AgentResult> {
  const body = prepared.parsed as EnableBody;
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return replay;
  const storeId = g.params.storeId!;
  const store = await storeOf(tx, a, storeId);
  if (!store) throw new WorkReject("not_found");
  // The kernel against current authority, again at confirmation (the amendment).
  if (!(await enableAllowed(a, store))) throw new WorkReject("denied");
  const row = one(await tx.run("agentEnableDocument", [body.documentDigest]));
  if (!row) throw new WorkReject("not_found");
  const document = parseInstallationDocument(text(row, "canonical"));
  if (
    document.store.storeId !== storeId ||
    document.organizationId !== a.actor.organizationId ||
    document.workspaceId !== a.resource.workspaceId
  )
    throw new WorkReject("not_found");
  let values: (string | null)[];
  if (document.purpose === "enable") {
    // The installation's grants, issued by this owner at database time; the definer checks
    // each against the document's grant set and the identity bridge's allowlist.
    const agentPrincipalId = "agent_" + crypto.randomUUID();
    const validFrom = new Date(a.databaseNowMs).toISOString();
    const grants = installationGrants({
      store: document.store,
      installationId: document.installationId,
      agentPrincipalId,
      issuer: a.actor,
      validFrom,
      policyRevision: a.policyRevision,
      ids: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
    });
    const owner = ownerDisableGrant({
      store: document.store,
      installationId: document.installationId,
      owner: a.actor,
      validFrom,
      policyRevision: a.policyRevision,
      id: crypto.randomUUID(),
    });
    values = [
      agentPrincipalId,
      "agent_" + crypto.randomUUID(),
      JSON.stringify(grants.map((grant) => canonicalJson(grant))),
      canonicalJson(owner),
    ];
  } else {
    // The installation the confirmation reactivates is still exactly the document.
    const installation = await installationOf(tx, storeId);
    if (
      !installation ||
      installation.status !== "disabled" ||
      !resumeDocumentMatches(installation, document)
    )
      throw new WorkReject("state_conflict");
    values = [null, null, null, null];
  }
  const result = await submit(tx, "cmdListingsEnable", [
    g.commandId,
    prepared.digest,
    correlationId,
    storeId,
    body.documentDigest,
    body.nonce,
    ...values,
  ]);
  return { status: 200, body: result, outcome: "applied" };
}

// "Stop AI work": the human-only kill switch on the store's Listings installation. It does
// not need the store's association to be current: a stop is always possible.
async function stop(
  tx: WorkTx,
  g: GuardedWorkspaceRequest,
  prepared: PreparedAgentCommand,
  correlationId: string,
): Promise<AgentResult> {
  const body = prepared.parsed as StopBody;
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return replay;
  const storeId = g.params.storeId!;
  const installation = await installationOf(tx, storeId);
  if (!installation) throw new WorkReject("not_found");
  const store = storeResource(
    a.actor.organizationId,
    a.resource.workspaceId,
    installation.storeId,
    installation.connectionId,
  );
  const target = installationResource(store, installation.id);
  if (!(await stopAllowed(a, target))) throw new WorkReject("denied");
  const actor = humanActor(a);
  const now = a.databaseNowMs;
  const request = {
    capabilityId: "agents.installation.disable",
    input: { installationId: installation.id, control: body.control },
  } as KillSwitchTargetRequest;
  const owner = one(await tx.run("reviewContext", ["agents.installation.disable", null]));
  if (!owner) throw new WorkReject("unauthenticated");
  // The kill-switch target facts: the installation record and the actor's current execute
  // grants' coverage. Ownership is part of the facts' shape; "Stop AI work" never consults
  // it (only a membership revocation does).
  const coverage = a.grants
    .filter((grant) =>
      isCurrentGrant(
        grant,
        a.actor,
        "agents.installation.disable",
        "execute",
        a.policyRevision,
        now,
      ),
    )
    .map((grant) => ({
      storeIds: [...grant.scope.storeIds],
      connectionIds: [
        ...new Set(
          grant.scope.resources.map((r) => r.connectionId).filter((c): c is string => c !== null),
        ),
      ],
    }));
  const facts: KillSwitchTargetFacts = {
    organizationId: a.actor.organizationId,
    workspaceId: a.resource.workspaceId,
    records: [
      {
        kind: "installation",
        id: installation.id,
        organizationId: a.actor.organizationId,
        workspaceId: a.resource.workspaceId,
        storeId: installation.storeId,
        connectionId: installation.connectionId,
        revision: null,
        digest: null,
      },
    ],
    grants: coverage,
    sourceProposal: null,
    ownership: {
      ownerPrincipalId: optional(owner, "owner_principal_id") ?? actor.principalId,
      ownerMembershipId: optional(owner, "owner_membership_id") ?? actor.membershipId,
      activeHumanMembershipCount: Number(text(owner, "active_human_membership_count")),
      lastMembershipChangeAt: optional(owner, "last_membership_change_at"),
    },
  };
  const planned = planStopAiWork(actor, request, facts);
  if (!planned.allowed) throw new WorkReject("not_found");
  const open = await openStopOf(tx, installation.id);
  const record = stopAiWorkRecord(actor, request, planned, {
    id: crypto.randomUUID(),
    createdAt: new Date(now).toISOString(),
    commandId: g.commandId!,
    requestDigest: prepared.digest,
    priorStateObserved: open ? "already_stopped" : "active",
  });
  const canonical = canonicalJson(record);
  const result = await submit(tx, "cmdStopAiWork", [
    g.commandId,
    prepared.digest,
    correlationId,
    storeId,
    installation.id,
    canonical,
    await sha256Hex(canonical),
  ]);
  return { status: 200, body: result, outcome: "applied" };
}

// The workspace's default selection and member ceiling (governance.model_default.revise).
async function reviseModelDefault(
  tx: WorkTx,
  g: GuardedWorkspaceRequest,
  prepared: PreparedAgentCommand,
  correlationId: string,
): Promise<AgentResult> {
  const body = prepared.parsed as ModelDefaultBody;
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return replay;
  if (!(await reviseAllowed(a))) throw new WorkReject("denied");
  const version = activeCatalogueVersion();
  const checked = checkWorkspaceDefault(
    { model: body.model, effort: body.effort },
    body.maxCreditsPerProduct,
  );
  if (version === null || !checked.ok) throw new WorkReject("invalid");
  const result = await submit(tx, "cmdModelDefaultRevise", [
    g.commandId,
    prepared.digest,
    correlationId,
    String(version),
    body.model,
    body.effort,
    String(body.maxCreditsPerProduct),
    body.expectedRevision === null ? null : String(body.expectedRevision),
  ]);
  // The definer's recorded result names the revision and what was set, so a replay
  // returns this same body.
  return { status: 200, body: result, outcome: "applied" };
}

const commands: Readonly<
  Record<
    AgentCommandType,
    (
      tx: WorkTx,
      g: GuardedWorkspaceRequest,
      p: PreparedAgentCommand,
      c: string,
    ) => Promise<AgentResult>
  >
> = Object.freeze({
  "installation.document": enableDocument,
  "installation.enable": enable,
  "installation.stop": stop,
  "model_default.revise": reviseModelDefault,
});
export function runAgentCommand(
  tx: WorkTx,
  g: GuardedWorkspaceRequest,
  prepared: PreparedAgentCommand,
  correlationId: string,
): Promise<AgentResult> {
  return commands[prepared.type](tx, g, prepared, correlationId);
}

// ---------------------------------------------------------------------------
// Reads.
/** GET /stores/:storeId/agents/listings: the store's Listings agent and what may be done. */
async function listingsStatus(tx: WorkTx, g: GuardedWorkspaceRequest): Promise<AgentResult> {
  const a = await context(tx, g);
  const storeId = g.params.storeId!;
  const store = await storeOf(tx, a, storeId);
  const installation = await installationOf(tx, storeId);
  if (!store && !installation) throw new WorkReject("not_found");
  const open = installation ? await openStopOf(tx, installation.id) : null;
  const may = store ? await enableAllowed(a, store) : false;
  // A platform stop, or a stop on the store's connection, blocks AI work although the
  // installation itself is active: only their own paths lift them.
  const connectionId = installation?.connectionId ?? store?.connectionId ?? null;
  const blocked = connectionId !== null && (await tx.run("storeStops", [connectionId])).length > 0;
  const target = installation
    ? installationResource(
        storeResource(
          a.actor.organizationId,
          a.resource.workspaceId,
          storeId,
          installation.connectionId,
        ),
        installation.id,
      )
    : null;
  const canStop = target ? await stopAllowed(a, target) : false;
  return {
    status: 200,
    body: {
      storeId,
      linked: store !== null,
      blocked,
      installation: installation
        ? {
            installationId: installation.id,
            status: installation.status,
            revision: installation.revision,
            stopped: open !== null,
            updatedAt: installation.updatedAt,
          }
        : null,
      actions: {
        enable: may && installation === null,
        resume:
          may &&
          installation?.status === "disabled" &&
          ownStop(open) &&
          (await resumable(installation, store)),
        stop: canStop && installation !== null,
      },
    },
    outcome: "read",
  };
}

/** GET /models: the active catalogue's entries, the workspace default and the ceiling. */
async function modelsList(tx: WorkTx, g: GuardedWorkspaceRequest): Promise<AgentResult> {
  const a = await context(tx, g);
  const listing = catalogueListing();
  const version = activeCatalogueVersion();
  const fallback = defaultSelection();
  const fallbackCeiling = defaultMemberCreditCeiling();
  if (!listing || version === null || !fallback || fallbackCeiling === null)
    throw new WorkReject("unavailable");
  const canRevise = await reviseAllowed(a);
  const row = one(await tx.run("workspaceModelDefault", []));
  let workspaceDefault = fallback;
  let ceiling = fallbackCeiling;
  let revision: number | null = null;
  if (row) {
    revision = Number(text(row, "revision"));
    ceiling = Number(text(row, "max_credits_per_product"));
    if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(ceiling))
      throw new WorkContextUnavailable();
    const stored = { model: text(row, "model_key"), effort: text(row, "effort_key") };
    // A default from a retired version falls back to the active catalogue's default.
    if (findCatalogueEntry(version, stored.model, stored.effort)) workspaceDefault = stored;
  }
  return {
    status: 200,
    body: {
      catalogueVersion: listing.catalogueVersion,
      entries: listing.entries.map((entry) => ({
        ...entry,
        allowedForMember: memberMayPick(entry.creditsPerProduct, ceiling, canRevise),
      })),
      workspaceDefault,
      ceiling,
      revision,
      canRevise,
    },
    outcome: "read",
  };
}
export function runAgentRead(
  tx: WorkTx,
  g: GuardedWorkspaceRequest,
  read: AgentRead,
): Promise<AgentResult> {
  return read === "listings.status" ? listingsStatus(tx, g) : modelsList(tx, g);
}
