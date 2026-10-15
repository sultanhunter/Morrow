import { createHash, randomBytes, randomUUID } from "node:crypto";
import canonicalize from "canonicalize";
import {
  validateDefinition,
  validateCapabilityInput,
} from "../../packages/contracts/src/validation.ts";
import { createHumanPolicyService } from "../../packages/policy/src/index.ts";
import { standaloneSqlLiteral as lit } from "../standalone-session-fixtures.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const json = (v) => lit(JSON.stringify(v)) + "::jsonb";

// Private owner-seeded synthetic records in one freshly owned local database.
// This helper neither verifies Shopify nor issues a production review/handoff.
export async function seedStandaloneLinkingFixture(harness, admitted, options = {}) {
  const f = admitted.f,
    credential = admitted.result.credential;
  if (!credential || admitted.result.outcome !== "newly_admitted")
    throw Error("STANDALONE_LINKING_SESSION_REQUIRED");
  const suffix = randomUUID().replaceAll("-", ""),
    handoffToken = randomBytes(32).toString("base64url"),
    nonceDigest = hash(handoffToken),
    sessionDigest = hash(credential.secret),
    commandId = randomUUID(),
    handoffId = "handoff_" + suffix,
    candidateId = "candidate_" + suffix,
    installationId = "installation_" + suffix,
    reviewId = "review_" + suffix,
    grantId = "grant_" + suffix;
  harness.secrets.push(handoffToken, nonceDigest, sessionDigest);
  const actor = {
    kind: "human",
    principalId: f.principal,
    organizationId: f.organization,
    workspaceId: f.workspace,
    membershipId: f.membership,
    installationId: null,
    mandateId: null,
  };
  const resource = {
    organizationId: f.organization,
    workspaceId: f.workspace,
    storeId: null,
    connectionId: null,
    kind: "workspace",
    id: f.workspace,
  };
  const scope = {
    organizationId: f.organization,
    workspaceId: f.workspace,
    storeIds: [],
    accountIds: [],
    resources: [resource],
    fields: ["providerId", "installationProof", "scope"],
  };
  const grant = {
    id: grantId,
    principal: actor,
    capabilityId: "governance.connection.connect",
    verbs: ["administer"],
    scope: structuredClone(scope),
    issuedBy: actor,
    validFrom: "2020-01-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
  };
  const operation = {
    capabilityId: grant.capabilityId,
    verb: "administer",
    resource,
    accountId: null,
    fields: scope.fields,
  };
  const decision = await createHumanPolicyService({
    readCurrent: async () => ({
      actor,
      policyRevision: 1,
      grantsRevision: 1,
      principalActive: true,
      organizationActive: true,
      workspaceActive: true,
      membershipActive: true,
      sessionCurrent: true,
      resource,
      accountId: null,
      providerAllowed: true,
      entitlementAllowed: true,
      grants: [grant],
    }),
  }).decide(operation);
  const proofPayload = {
    providerId: "shopify",
    applicationId: "synthetic_app",
    environmentId: "synthetic_env",
    shopId: "shop_" + suffix,
    installationId,
    generation: 1,
    eligiblePrincipalId: f.principal,
  };
  const proof = { id: "proof_" + suffix, revision: 1, digest: hash(canonicalize(proofPayload)) };
  const proofRef = {
    organizationId: f.organization,
    workspaceId: f.workspace,
    storeId: null,
    kind: "proof",
    ...proof,
  };
  const scopeRef = {
    organizationId: f.organization,
    workspaceId: f.workspace,
    storeId: null,
    kind: "scope",
    id: "scope_" + suffix,
    revision: 1,
    digest: hash(canonicalize(scope)),
  };
  const capabilityInput = { providerId: "shopify", installationProof: proofRef, scope: scopeRef };
  if (
    !validateDefinition("core", "Grant", grant) ||
    !validateDefinition("core", "Scope", scope) ||
    !validateDefinition("core", "ProofRef", proofRef) ||
    !validateDefinition("core", "ScopeRef", scopeRef) ||
    !validateCapabilityInput("governance.connection.connect", capabilityInput) ||
    !decision.decision.allowed ||
    !decision.obligations.includes("exact_approval")
  )
    throw Error("STANDALONE_LINKING_POLICY_FIXTURE_INVALID");
  const input = {
    handoffId,
    commandId,
    requestDigest: hash(
      canonicalize({
        operation,
        capabilityInput,
        requestedScope: scope,
        actor,
        sessionDigest,
        nonceDigest,
        organizationId: f.organization,
        workspaceId: f.workspace,
        installationId,
        purpose: options.purpose ?? "workspace_first",
        expectedPolicyRevision: 1,
        expectedOwnershipRevision: 1,
        commandId,
        handoffId,
      }),
    ),
    sessionDigest,
    nonceDigest,
    organizationId: f.organization,
    workspaceId: f.workspace,
    installationId,
    purpose: options.purpose ?? "workspace_first",
    expectedPolicyRevision: 1,
    expectedOwnershipRevision: 1,
  };
  for (const field of ["handoffSeconds", "reviewSeconds", "proofSeconds"])
    if (
      options[field] !== undefined &&
      (!Number.isInteger(options[field]) || options[field] < 1 || options[field] > 299)
    )
      throw Error("STANDALONE_LINKING_TTL_INVALID");
  harness.admin(`INSERT INTO morrow_identity.grants VALUES(${lit(grantId)},${lit(f.organization)},${lit(f.workspace)},${lit(f.membership)},${lit(f.principal)},${json(grant)});
INSERT INTO morrow_identity.linking_candidates VALUES(${lit(candidateId)},'shopify','synthetic_app','synthetic_env',${lit(proofPayload.shopId)},${lit("synthetic-" + suffix + ".myshopify.com")},${lit(installationId)},1,true,1,'controlled_fixture',${lit(proof.id)},1,${lit(proof.digest)},${lit(f.principal)},clock_timestamp()-interval '1 second',clock_timestamp()+interval '${options.proofSeconds ?? 299} seconds',NULL);
INSERT INTO morrow_identity.linking_reviews(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,session_digest,nonce_digest,handoff_id,candidate_id,installation_id,generation,command_id,request_digest,purpose,expected_policy_revision,expected_ownership_revision,proof_id,proof_revision,proof_digest,scope_snapshot,evidence_kind,created_at,expires_at)
VALUES(${lit(reviewId)},${lit(f.organization)},${lit(f.workspace)},${lit(f.principal)},${lit(f.membership)},${lit(sessionDigest)},${lit(nonceDigest)},${lit(handoffId)},${lit(candidateId)},${lit(installationId)},1,${lit(commandId)},${lit(input.requestDigest)},${lit(input.purpose)},1,1,${lit(proof.id)},1,${lit(proof.digest)},${json(scope)},'controlled_review',clock_timestamp(),clock_timestamp()+interval '${options.reviewSeconds ?? 299} seconds');
INSERT INTO morrow_identity.linking_handoffs(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,session_digest,nonce_digest,candidate_id,installation_id,generation,command_id,request_digest,purpose,expected_policy_revision,expected_ownership_revision,proof_id,proof_revision,proof_digest,review_id,authorizing_grant_id,authorizing_grant_snapshot,requested_scope_snapshot,created_at,expires_at)
VALUES(${lit(handoffId)},${lit(f.organization)},${lit(f.workspace)},${lit(f.principal)},${lit(f.membership)},${lit(sessionDigest)},${lit(nonceDigest)},${lit(candidateId)},${lit(installationId)},1,${lit(commandId)},${lit(input.requestDigest)},${lit(input.purpose)},1,1,${lit(proof.id)},1,${lit(proof.digest)},${lit(reviewId)},${lit(grantId)},${json(grant)},${json(scope)},clock_timestamp(),clock_timestamp()+interval '${options.handoffSeconds ?? 299} seconds');`);
  return Object.freeze({
    handoffToken,
    commandId,
    workspaceId: f.workspace,
    installationId,
    input: Object.freeze(input),
    selectorJson: JSON.stringify({
      sessionDigest,
      workspaceId: f.workspace,
      nonceDigest,
      commandId,
    }),
    candidateId,
    reviewId,
    grantId,
    proof,
    scope,
    actor,
    grant,
    admitted,
  });
}
