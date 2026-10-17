// Target rules for the five ADR-0005 kill switches (P01.T02a §5). Pure: no I/O,
// clock or randomness. It runs after the human policy evaluator allowed
// `execute` and before any effect. It decides only whether the named targets
// exist in the trusted tenant, fit the actor's grant and may be stopped; the
// KillSwitchRecord, owner notification and the effect itself belong to
// P05.T01z and P11.T05.
import type { CapabilityInput, Core_ProposalRef } from "@morrow/contracts";
import { validateCapabilityInput, validateDefinition } from "@morrow/contracts/validation";
import catalogue from "../../../docs/contracts/capabilities.json";
import { plainJson, closed, freezeJson } from "./json-boundary";
import type {
  KillSwitchTargetFacts,
  KillSwitchTargetKey,
  KillSwitchTargetKind,
  KillSwitchTargetRecord,
} from "./review-facts";
export type * from "./review-facts";

const targetKinds = {
  "ads.campaign.pause": "campaign",
  "agents.installation.disable": "installation",
  "governance.membership.revoke": "membership",
  "governance.connection.disconnect": "connection",
  "agents.release.revoke": "release",
} as const satisfies Record<string, KillSwitchTargetKind>;
export type KillSwitchCapabilityId = keyof typeof targetKinds;
export type KillSwitchTargetRequest = {
  [K in KillSwitchCapabilityId]: { readonly capabilityId: K; readonly input: CapabilityInput<K> };
}[KillSwitchCapabilityId];
export type KillSwitchDenialCode = "TARGET_NOT_FOUND" | "OWNER_MEMBERSHIP_PROTECTED";
export type KillSwitchTargetResult =
  | {
      readonly allowed: true;
      readonly capabilityId: KillSwitchCapabilityId;
      readonly targets: readonly KillSwitchTargetKey[];
      /** A revocation: the owner record's lastMembershipChangeAt must advance with it. */
      readonly membershipChange: boolean;
    }
  | {
      readonly allowed: false;
      readonly code: KillSwitchDenialCode;
      readonly category: "denied";
      readonly retry: "never";
      readonly safeMessage: string;
    };
export class KillSwitchBoundaryError extends Error {
  constructor(readonly code: "KILL_SWITCH_INPUT_INVALID" | "KILL_SWITCH_FACTS_INVALID") {
    super(code);
    this.name = "KillSwitchBoundaryError";
  }
}

// The catalogue decides which capabilities are kill switches; a kill switch
// without target rules here is never checked as one.
export const killSwitchCapabilityIds: readonly KillSwitchCapabilityId[] = Object.freeze(
  catalogue.capabilities
    .filter((c) => c.kill_switch && Object.hasOwn(targetKinds, c.id))
    .map((c) => c.id as KillSwitchCapabilityId),
);
const kinds: readonly string[] = Object.values(targetKinds);
const deny = (code: KillSwitchDenialCode, safeMessage: string): KillSwitchTargetResult =>
  Object.freeze({ allowed: false, code, category: "denied", retry: "never", safeMessage });
// Unknown, foreign-tenant and ungranted targets get this one identical result.
const notFound = deny("TARGET_NOT_FOUND", "The requested target is not available.");
const ownerProtected = deny(
  "OWNER_MEMBERSHIP_PROTECTED",
  "The workspace owner's membership cannot be revoked by a stop. Transfer ownership first.",
);

const id = (value: unknown) => validateDefinition("core", "Id", value);
const ids = (value: unknown) =>
  Array.isArray(value) &&
  value.length <= 1000 &&
  new Set(value).size === value.length &&
  value.every(id);
const nullableId = (value: unknown) => value === null || id(value);
const targetKey = (value: unknown) =>
  closed(value, ["kind", "id"]) && kinds.includes(value.kind as string) && id(value.id);
function record(value: unknown) {
  if (
    !closed(value, [
      "kind",
      "id",
      "organizationId",
      "workspaceId",
      "storeId",
      "connectionId",
      "revision",
      "digest",
    ]) ||
    !kinds.includes(value.kind as string) ||
    ![value.id, value.organizationId, value.workspaceId].every(id) ||
    !nullableId(value.storeId) ||
    !nullableId(value.connectionId)
  )
    return false;
  return value.kind === "release"
    ? validateDefinition("core", "Revision", value.revision) &&
        validateDefinition("core", "Digest", value.digest)
    : value.revision === null && value.digest === null;
}
const coverage = (value: unknown) =>
  closed(value, ["storeIds", "connectionIds"]) && ids(value.storeIds) && ids(value.connectionIds);
const sourceProposal = (value: unknown) =>
  value === null ||
  (closed(value, ["ref", "capabilityId", "targets"]) &&
    validateDefinition("core", "ProposalRef", value.ref) &&
    validateDefinition("core", "CapabilityId", value.capabilityId) &&
    Array.isArray(value.targets) &&
    value.targets.length >= 1 &&
    value.targets.length <= 1000 &&
    value.targets.every(targetKey));
const ownership = (value: unknown) =>
  closed(value, [
    "ownerPrincipalId",
    "ownerMembershipId",
    "activeHumanMembershipCount",
    "lastMembershipChangeAt",
  ]) &&
  id(value.ownerPrincipalId) &&
  id(value.ownerMembershipId) &&
  validateDefinition("core", "Count", value.activeHumanMembershipCount) &&
  (value.lastMembershipChangeAt === null ||
    validateDefinition("core", "UtcTime", value.lastMembershipChangeAt));

function parseRequest(value: unknown): KillSwitchTargetRequest {
  if (
    !plainJson(value) ||
    !closed(value, ["capabilityId", "input"]) ||
    typeof value.capabilityId !== "string" ||
    !killSwitchCapabilityIds.includes(value.capabilityId as KillSwitchCapabilityId) ||
    !validateCapabilityInput(value.capabilityId as KillSwitchCapabilityId, value.input)
  )
    throw new KillSwitchBoundaryError("KILL_SWITCH_INPUT_INVALID");
  return freezeJson(JSON.parse(JSON.stringify(value))) as KillSwitchTargetRequest;
}
function parseFacts(value: unknown): KillSwitchTargetFacts {
  if (
    !plainJson(value) ||
    !closed(value, [
      "organizationId",
      "workspaceId",
      "records",
      "grants",
      "sourceProposal",
      "ownership",
    ]) ||
    !id(value.organizationId) ||
    !id(value.workspaceId) ||
    !Array.isArray(value.records) ||
    value.records.length > 1000 ||
    !value.records.every(record) ||
    // One record per requested target; an ambiguous reader result fails closed.
    new Set(value.records.map((r: { kind: string; id: string }) => `${r.kind}\u0000${r.id}`))
      .size !== value.records.length ||
    !Array.isArray(value.grants) ||
    value.grants.length > 1000 ||
    !value.grants.every(coverage) ||
    !sourceProposal(value.sourceProposal) ||
    !ownership(value.ownership)
  )
    throw new KillSwitchBoundaryError("KILL_SWITCH_FACTS_INVALID");
  return freezeJson(JSON.parse(JSON.stringify(value))) as KillSwitchTargetFacts;
}
const sameProposalRef = (a: Core_ProposalRef, b: Core_ProposalRef) =>
  a.organizationId === b.organizationId &&
  a.workspaceId === b.workspaceId &&
  a.storeId === b.storeId &&
  a.kind === b.kind &&
  a.id === b.id &&
  a.revision === b.revision &&
  a.digest === b.digest;
interface Claim {
  readonly key: KillSwitchTargetKey;
  readonly matches: (record: KillSwitchTargetRecord) => boolean;
}

/**
 * Checks the targets of a kill switch the human policy evaluator already
 * allowed. Throws KillSwitchBoundaryError for a malformed request or facts.
 */
export function checkKillSwitchTarget(
  request: KillSwitchTargetRequest,
  facts: KillSwitchTargetFacts,
): KillSwitchTargetResult {
  // Fixed boundary errors only: a throwing trap or getter never leaks its message.
  let r: KillSwitchTargetRequest, f: KillSwitchTargetFacts;
  try {
    r = parseRequest(request);
  } catch {
    throw new KillSwitchBoundaryError("KILL_SWITCH_INPUT_INVALID");
  }
  try {
    f = parseFacts(facts);
  } catch {
    throw new KillSwitchBoundaryError("KILL_SWITCH_FACTS_INVALID");
  }
  const inTenant = (x: { organizationId: string; workspaceId: string }) =>
    x.organizationId === f.organizationId && x.workspaceId === f.workspaceId;
  const any = () => true;
  let claims: readonly Claim[];
  switch (r.capabilityId) {
    case "ads.campaign.pause":
      claims = r.input.campaigns.map((c) => ({
        key: { kind: "campaign", id: c.id },
        // The named store and connection must be the record's, and fit one grant.
        matches: (record) =>
          inTenant(c) &&
          record.storeId === c.storeId &&
          record.connectionId === c.connectionId &&
          f.grants.some(
            (g) =>
              (c.storeId === null ? g.storeIds.length === 0 : g.storeIds.includes(c.storeId)) &&
              g.connectionIds.includes(c.connectionId),
          ),
      }));
      break;
    case "agents.installation.disable":
      claims = [{ key: { kind: "installation", id: r.input.installationId }, matches: any }];
      break;
    case "governance.membership.revoke":
      claims = [{ key: { kind: "membership", id: r.input.membershipId }, matches: any }];
      break;
    case "governance.connection.disconnect":
      claims = [{ key: { kind: "connection", id: r.input.connectionId }, matches: any }];
      break;
    case "agents.release.revoke": {
      const ref = r.input.releaseRef;
      claims = [
        {
          key: { kind: "release", id: ref.id },
          matches: (record) =>
            inTenant(ref) &&
            record.storeId === ref.storeId &&
            record.revision === ref.revision &&
            record.digest === ref.digest,
        },
      ];
      break;
    }
  }
  for (const claim of claims) {
    const found = f.records.find((x) => x.kind === claim.key.kind && x.id === claim.key.id);
    if (!found || !inTenant(found) || !claim.matches(found)) return notFound;
  }
  const keys = claims.map((claim) => claim.key);
  const source = r.input.control.sourceProposalRef;
  if (source === null) {
    if (f.sourceProposal !== null) throw new KillSwitchBoundaryError("KILL_SWITCH_FACTS_INVALID");
  } else {
    // A source proposal confers nothing: same tenant, same capability, and its
    // targets must include every target being stopped.
    const p = f.sourceProposal;
    if (
      !inTenant(source) ||
      p === null ||
      !sameProposalRef(p.ref, source) ||
      p.capabilityId !== r.capabilityId ||
      !keys.every((k) => p.targets.some((t) => t.kind === k.kind && t.id === k.id))
    )
      return notFound;
  }
  // The designated owner's membership is never revoked by a stop (ADR-0011 Q2).
  if (
    r.capabilityId === "governance.membership.revoke" &&
    r.input.membershipId === f.ownership.ownerMembershipId
  )
    return ownerProtected;
  return freezeJson({
    allowed: true,
    capabilityId: r.capabilityId,
    targets: keys,
    membershipChange: r.capabilityId === "governance.membership.revoke",
  }) as KillSwitchTargetResult;
}
