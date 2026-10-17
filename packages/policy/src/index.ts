import { withIdentityRead } from "@morrow/identity";
import type { IdentitySqlPool } from "@morrow/identity";
import { randomUUID } from "node:crypto";
import type {
  Core_ActorRef,
  Core_Grant,
  Core_PolicyDecision,
  Core_ResourceRef,
  CapabilityId,
} from "@morrow/contracts";
import { validateDefinition } from "@morrow/contracts/validation";
import catalogue from "../../../docs/contracts/capabilities.json";
import { plainJson, closed, freezeJson } from "./json-boundary";
export type PermissionVerb = Core_Grant["verbs"][number];
export interface PermissionRequest {
  readonly capabilityId: CapabilityId;
  readonly verb: PermissionVerb;
  readonly resource: Core_ResourceRef;
  readonly accountId: string | null;
  readonly fields: readonly string[];
}
// Trusted backend reader only. Never decode these facts from HTTP/model inputs.
// T02a does not supply a DB/WorkOS reader; fixtures are explicitly local-only.
export interface HumanAuthority {
  readonly actor: Core_ActorRef;
  readonly policyRevision: number;
  readonly grantsRevision: number;
  readonly principalActive: boolean;
  readonly organizationActive: boolean;
  readonly workspaceActive: boolean;
  readonly membershipActive: boolean;
  readonly sessionCurrent: boolean;
  readonly resource: Core_ResourceRef;
  readonly accountId: string | null;
  readonly providerAllowed: boolean;
  readonly entitlementAllowed: boolean;
  readonly grants: readonly Core_Grant[];
}
export interface AuthorityReader {
  readCurrent(request: PermissionRequest): Promise<HumanAuthority>;
}
// kill_switch_record: the executor must record the reason in an append-only
// KillSwitchRecord committed with the effect, and notify the owner from it
// (ADR-0005; P05.T01z and P11.T05 implement it). A dispatcher that does not
// implement an obligation denies dispatch.
export type ExecutionObligation =
  | "recheck_at_dispatch"
  | "exact_approval"
  | "kill_switch_record"
  | "budget_reservation"
  | "provider_effect_verification";
export interface PermissionResult {
  readonly decision: Core_PolicyDecision;
  readonly obligations: readonly ExecutionObligation[];
}
export class PolicyBoundaryError extends Error {
  constructor(readonly code: "POLICY_INPUT_INVALID" | "POLICY_AUTHORITY_UNAVAILABLE") {
    super(code);
    this.name = "PolicyBoundaryError";
  }
}
const verbs = ["view", "propose", "approve", "execute", "delegate", "administer"];
const capabilities = new Map(catalogue.capabilities.map((c) => [c.id, c]));
const valid = (type: string, value: unknown) => validateDefinition("core", type, value);
const sameResource = (a: Core_ResourceRef, b: Core_ResourceRef) =>
  a.organizationId === b.organizationId &&
  a.workspaceId === b.workspaceId &&
  a.storeId === b.storeId &&
  a.connectionId === b.connectionId &&
  a.kind === b.kind &&
  a.id === b.id;
const sameActor = (a: Core_ActorRef, b: Core_ActorRef) =>
  a.kind === b.kind &&
  a.principalId === b.principalId &&
  a.organizationId === b.organizationId &&
  a.workspaceId === b.workspaceId &&
  a.membershipId === b.membershipId &&
  a.installationId === b.installationId &&
  a.mandateId === b.mandateId;
function parseRequest(value: unknown): PermissionRequest {
  if (
    !plainJson(value) ||
    !closed(value, ["capabilityId", "verb", "resource", "accountId", "fields"]) ||
    !valid("CapabilityId", value.capabilityId) ||
    typeof value.verb !== "string" ||
    !verbs.includes(value.verb) ||
    !valid("ResourceRef", value.resource) ||
    !(value.accountId === null || valid("Id", value.accountId)) ||
    !Array.isArray(value.fields) ||
    value.fields.length < 1 ||
    value.fields.length > 1000 ||
    new Set(value.fields).size !== value.fields.length ||
    !value.fields.every((f) => valid("FieldPath", f))
  )
    throw new PolicyBoundaryError("POLICY_INPUT_INVALID");
  // Isolate a caller mutating selectors while fresh server facts are loading.
  return freezeJson(JSON.parse(JSON.stringify(value))) as PermissionRequest;
}
function parseAuthority(value: unknown): HumanAuthority {
  const flags = [
    "principalActive",
    "organizationActive",
    "workspaceActive",
    "membershipActive",
    "sessionCurrent",
    "providerAllowed",
    "entitlementAllowed",
  ];
  if (
    !plainJson(value) ||
    !closed(value, [
      "actor",
      "policyRevision",
      "grantsRevision",
      "resource",
      "accountId",
      "grants",
      ...flags,
    ]) ||
    !valid("ActorRef", value.actor) ||
    !valid("Revision", value.policyRevision) ||
    !valid("Revision", value.grantsRevision) ||
    !valid("ResourceRef", value.resource) ||
    !(value.accountId === null || valid("Id", value.accountId)) ||
    flags.some((k) => typeof value[k] !== "boolean") ||
    !Array.isArray(value.grants) ||
    value.grants.length > 1000 ||
    !value.grants.every((g) => valid("Grant", g)) ||
    new Set(value.grants.map((g) => g.id)).size !== value.grants.length
  )
    throw new PolicyBoundaryError("POLICY_AUTHORITY_UNAVAILABLE");
  return value as unknown as HumanAuthority;
}
const safeMessages: Record<Core_PolicyDecision["reason"], string> = {
  allowed: "Permission is eligible; execution controls still apply.",
  membership_revoked: "Current membership or session does not permit this request.",
  capability_denied: "This operation is not permitted.",
  scope_denied: "This resource scope is not permitted.",
  field_denied: "The requested fields are not permitted.",
  origin_denied: "This request requires qualified delegated authority.",
  provider_denied: "Current provider constraints do not permit this request.",
  mandate_expired: "Current automation authority does not permit this request.",
  approval_expired: "Current approval does not permit this request.",
  budget_exhausted: "Current budget does not permit this request.",
  missing_input: "Required input is missing.",
  precondition_conflict: "Current authority must be refreshed.",
  source_conflict: "Current source authority conflicts.",
  entitlement_denied: "Current service entitlement does not permit this request.",
};
function evaluate(request: PermissionRequest, a: HumanAuthority, at: string): PermissionResult {
  const capability = capabilities.get(request.capabilityId);
  let reason: Core_PolicyDecision["reason"] = "allowed";
  const now = Date.parse(at);
  if (a.actor.kind !== "human" || a.actor.installationId !== null || a.actor.mandateId !== null)
    reason = "origin_denied";
  else if (
    !a.principalActive ||
    !a.organizationActive ||
    !a.workspaceActive ||
    !a.membershipActive ||
    !a.sessionCurrent ||
    a.actor.membershipId === null ||
    a.actor.workspaceId === null
  )
    reason = "membership_revoked";
  else if (a.grantsRevision !== a.policyRevision) reason = "precondition_conflict";
  else if (
    !sameResource(request.resource, a.resource) ||
    request.accountId !== a.accountId ||
    request.resource.organizationId !== a.actor.organizationId ||
    request.resource.workspaceId !== a.actor.workspaceId
  )
    reason = "scope_denied";
  else if (
    !capability ||
    capability.eligible_principal.startsWith("operator_") ||
    (request.capabilityId === "governance.connection.connect" && request.verb !== "administer")
  )
    reason = "capability_denied";
  else {
    const eligible = a.grants.filter(
      (g) =>
        sameActor(g.principal, a.actor) &&
        g.capabilityId === request.capabilityId &&
        g.verbs.includes(request.verb) &&
        g.revokedAt === null &&
        Date.parse(g.validFrom) <= now &&
        (g.expiresAt === null || Date.parse(g.expiresAt) > now) &&
        g.policyRevision <= a.policyRevision &&
        g.issuedBy.organizationId === a.actor.organizationId &&
        (g.issuedBy.workspaceId === null || g.issuedBy.workspaceId === a.actor.workspaceId),
    );
    const scoped = eligible.filter(
      (g) =>
        g.scope.organizationId === a.actor.organizationId &&
        g.scope.workspaceId === a.actor.workspaceId &&
        (request.resource.storeId === null
          ? g.scope.storeIds.length === 0
          : g.scope.storeIds.includes(request.resource.storeId)) &&
        (request.accountId === null
          ? g.scope.accountIds.length === 0
          : g.scope.accountIds.includes(request.accountId)) &&
        g.scope.resources.some((r) => sameResource(r, request.resource)),
    );
    if (!eligible.length) reason = "capability_denied";
    else if (!scoped.length) reason = "scope_denied";
    else if (!scoped.some((g) => request.fields.every((f) => g.scope.fields.includes(f))))
      reason = "field_denied";
    else if (!a.providerAllowed) reason = "provider_denied";
    else if (!a.entitlementAllowed) reason = "entitlement_denied";
  }
  const obligations: ExecutionObligation[] = [];
  if (reason === "allowed") {
    obligations.push("recheck_at_dispatch");
    // Kill switches are unreviewed (ADR-0005): no exact approval. validateCatalogue R7
    // keeps their effect to external_write or control, so they never reserve budget.
    if (capability?.kill_switch && request.verb === "execute")
      obligations.push("kill_switch_record");
    else if (
      capability?.review_required &&
      (request.verb === "execute" ||
        (request.capabilityId === "governance.connection.connect" && request.verb === "administer"))
    )
      obligations.push("exact_approval");
    if (request.verb === "execute" && capability) {
      if (["spend", "billable_job"].includes(capability.effect))
        obligations.push("budget_reservation");
      if (["external_write", "spend", "communication", "billable_job"].includes(capability.effect))
        obligations.push("provider_effect_verification");
    }
  }
  const decision: Core_PolicyDecision = {
    decisionId: randomUUID(),
    allowed: reason === "allowed",
    reason,
    policyRevision: a.policyRevision,
    evaluatedAt: at,
    safeMessage: safeMessages[reason],
    requiredInputIds: [],
  };
  Object.freeze(decision.requiredInputIds);
  if (!valid("PolicyDecision", decision))
    throw new PolicyBoundaryError("POLICY_AUTHORITY_UNAVAILABLE");
  return Object.freeze({
    decision: Object.freeze(decision),
    obligations: Object.freeze(obligations),
  });
}
export function createHumanPolicyService(
  reader: AuthorityReader,
  clock: () => Date = () => new Date(),
) {
  return Object.freeze({
    async decide(value: unknown): Promise<PermissionResult> {
      let request: PermissionRequest;
      try {
        request = parseRequest(value);
      } catch {
        throw new PolicyBoundaryError("POLICY_INPUT_INVALID");
      }
      let authority: HumanAuthority;
      try {
        authority = parseAuthority(await reader.readCurrent(request));
      } catch {
        throw new PolicyBoundaryError("POLICY_AUTHORITY_UNAVAILABLE");
      }
      let at: string;
      try {
        at = clock().toISOString();
      } catch {
        throw new PolicyBoundaryError("POLICY_AUTHORITY_UNAVAILABLE");
      }
      return evaluate(request, authority, at);
    },
  });
}

// Workspace ownership comes from SQL, while provider/entitlement constraints
// stay a separate qualified server reader. This is not an HTTP authenticator.
export interface CurrentConstraintsReader {
  readCurrent(
    request: PermissionRequest,
    actor: Core_ActorRef,
  ): Promise<{ providerAllowed: boolean; entitlementAllowed: boolean }>;
}
export function createWorkspacePermissionBoundary(
  pool: IdentitySqlPool,
  constraints: CurrentConstraintsReader,
  clock: () => Date = () => new Date(),
) {
  return Object.freeze({
    async decide(
      serverSessionDigest: string,
      workspaceId: string,
      value: unknown,
    ): Promise<PermissionResult> {
      let request: PermissionRequest;
      try {
        request = parseRequest(value);
      } catch {
        throw new PolicyBoundaryError("POLICY_INPUT_INVALID");
      }
      return withIdentityRead(pool, serverSessionDigest, workspaceId, async (scope) => {
        const reader: AuthorityReader = {
          async readCurrent(currentRequest) {
            const before = await scope.readWorkspaceAuthority();
            const facts = (
              current: typeof before,
              providerAllowed: boolean,
              entitlementAllowed: boolean,
              grantsRevision = current.identity.policyRevision,
            ): HumanAuthority => ({
              actor: current.identity.actor,
              policyRevision: current.identity.policyRevision,
              grantsRevision,
              principalActive: true,
              organizationActive: true,
              workspaceActive: true,
              membershipActive: true,
              sessionCurrent: true,
              resource: current.resource,
              accountId: null,
              providerAllowed,
              entitlementAllowed,
              grants: current.grants,
            });
            // Reject selectors/grants before any external constraint reader sees
            // them. This temporary permission check is never returned/dispatchable.
            let at: string;
            try {
              at = clock().toISOString();
            } catch {
              throw new PolicyBoundaryError("POLICY_AUTHORITY_UNAVAILABLE");
            }
            const preliminary = evaluate(
              currentRequest,
              parseAuthority(facts(before, true, true)),
              at,
            );
            if (!preliminary.decision.allowed) return facts(before, false, false);
            const conditions = await constraints.readCurrent(currentRequest, before.identity.actor);
            // Constraint lookup may wait: reload SQL authority and reject a changed
            // policy rather than returning a stale allow after revocation.
            const after = await scope.readWorkspaceAuthority();
            return facts(
              after,
              conditions.providerAllowed,
              conditions.entitlementAllowed,
              before.identity.policyRevision,
            );
          },
        };
        return createHumanPolicyService(reader, clock).decide(request);
      });
    },
  });
}
