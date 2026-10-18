// Synthetic builders for the P01.T02a review library tests. Digests use an
// independent oracle (the canonicalize package and node:crypto), never the
// library under test.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
export const catalogue = json("docs/contracts/capabilities.json");
export const defaults = json("docs/contracts/review-policy-defaults.json");
export const oracle = (value) => createHash("sha256").update(canonicalize(value)).digest("hex");
export const T0 = "2026-10-18T09:00:00Z";
export const tenant = Object.freeze({ organizationId: "org_a", workspaceId: "workspace_a" });
export const human = (name, overrides = {}) => ({
  kind: "human",
  principalId: `human_${name}`,
  ...tenant,
  membershipId: `membership_${name}`,
  installationId: null,
  mandateId: null,
  ...overrides,
});
export const agent = {
  kind: "agent",
  principalId: "agent_coordinator",
  ...tenant,
  membershipId: null,
  installationId: "installation_a",
  mandateId: null,
};
export const policy = (rules = {}, revision = 1) => ({
  schemaVersion: 1,
  id: "policy_a",
  ...tenant,
  storeId: null,
  revision,
  createdAt: T0,
  updatedAt: T0,
  rules: { ...structuredClone(defaults.rules), ...structuredClone(rules) },
});
export const policyRef = (p) => ({
  ...tenant,
  storeId: null,
  kind: "policy",
  id: p.id,
  revision: p.revision,
  digest: oracle(p),
});
export const resource = (kind, id, overrides = {}) => ({
  ...tenant,
  storeId: "store_a",
  connectionId: null,
  kind,
  id,
  ...overrides,
});
const kinds = {
  "catalog.content.publish": "product",
  "ads.budget.change": "campaign",
  "orders.refund.create": "order",
  "orders.cancel": "order",
  "governance.grants.revise": "member",
  "lifecycle.campaign.send": "campaign",
};
const micros = (amount) => {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
};
/** The exact decimal sum, written with the largest scale among the amounts. */
export function sumAmounts(amounts) {
  const digits = Math.max(...amounts.map((a) => a.split(".")[1]?.length ?? 0));
  const total = amounts.reduce((sum, a) => sum + micros(a), 0n);
  const whole = (total / 1000000n).toString();
  return digits
    ? `${whole}.${(total % 1000000n).toString().padStart(6, "0").slice(0, digits)}`
    : whole;
}
export function seal(p) {
  const { proposalDigest: _omitted, ...content } = p;
  return { ...p, proposalDigest: oracle(content) };
}
export const ref = (p) => ({
  organizationId: p.organizationId,
  workspaceId: p.workspaceId,
  storeId: p.storeId,
  kind: "proposal",
  id: p.id,
  revision: p.revision,
  digest: p.proposalDigest,
});
/** A sealed Proposal@2 whose server-derived fields match its catalogue entry. */
export function proposal({
  id = "proposal_a",
  capabilityId = "catalog.content.publish",
  credits = ["10", "10", "5"],
  costs = credits.map(() => null),
  currency = "USD",
  fields = ["title"],
  proposedBy = agent,
  requestedBy = human("maya"),
  beneficiaryPrincipalIds = [],
  contextTaint = "none",
  partialApproval = "allowed",
  reviewPolicy = policy(),
  expiresAt = "2026-10-25T09:00:00Z",
  taskId = "task_a",
} = {}) {
  const capability = catalogue.capabilities.find((c) => c.id === capabilityId);
  const kind = kinds[capabilityId];
  const targets = credits.map((maximumCredits, i) => ({
    resource: resource(kind, `${kind}_${i}`),
    expectedSourceRevision: `source_revision_${i}`,
    fields: [...fields],
    maximumCredits,
    maximumCost: costs[i] === null ? null : { amount: costs[i], currency },
  }));
  const present = costs.filter((c) => c !== null);
  return seal({
    schemaVersion: 2,
    id,
    ...tenant,
    storeId: "store_a",
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    taskId,
    capabilityId,
    scope: {
      ...tenant,
      storeIds: ["store_a"],
      accountIds: [],
      resources: targets.map((t) => structuredClone(t.resource)),
      fields: [...fields],
    },
    targets,
    parametersRef: {
      ...tenant,
      storeId: "store_a",
      kind: "artifact",
      id: `parameters_${id}`,
      revision: 1,
      digest: "c".repeat(64),
    },
    parametersDigest: "c".repeat(64),
    maximumCredits: credits.reduce((sum, c) => sum + BigInt(c), 0n).toString(),
    maximumCost: present.length ? { amount: sumAmounts(present), currency } : null,
    risk: defaults.riskClassByEffect[capability.effect],
    irreversible: capability.irreversible,
    reviewPolicyRef: policyRef(reviewPolicy),
    proposedBy: structuredClone(proposedBy),
    requestedBy: structuredClone(requestedBy),
    beneficiaryPrincipalIds: [...beneficiaryPrincipalIds],
    contextTaint,
    partialApproval,
    derivedFrom: null,
    proposalDigest: "0".repeat(64),
    expiresAt,
  });
}
/** Ownership of a team workspace owned by Maya, or of a solo workspace owned by Olivia. */
export const team = (count = 3, overrides = {}) => ({
  ownerPrincipalId: "human_maya",
  ownerMembershipId: "membership_maya",
  activeHumanMembershipCount: count,
  lastMembershipChangeAt: null,
  ...overrides,
});
export const solo = (overrides = {}) => ({
  ownerPrincipalId: "human_olivia",
  ownerMembershipId: "membership_olivia",
  activeHumanMembershipCount: 1,
  lastMembershipChangeAt: "2026-10-01T00:00:00Z",
  ...overrides,
});
/** ProposalFacts matching a proposal built above; no task has no requester (ADR-0018). */
export const facts = (p, overrides = {}) => ({
  ...tenant,
  storeId: "store_a",
  proposedBy: structuredClone(p.proposedBy),
  taskId: p.taskId,
  requestedBy: p.taskId === null ? null : structuredClone(p.requestedBy),
  beneficiaryPrincipalIds: [...p.beneficiaryPrincipalIds],
  contextTaint: p.contextTaint,
  reviewPolicy: policy(),
  eligibleReviewerPrincipalIds: ["human_maya", "human_leo", "human_ana"],
  ownership: team(),
  at: T0,
  ...overrides,
});
