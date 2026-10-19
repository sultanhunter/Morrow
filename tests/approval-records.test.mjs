// P06.T01b unit tests (no I/O): producer parsing, the proposal a submit builds
// against the review library, digest vectors against an independent oracle,
// projectApproval, the outcome→HTTP mapping, visibility through the policy
// kernel, the vocabulary deviation marker, and the migration's catalogue,
// defaults and transition rows against the contracts. The PostgreSQL behaviour
// itself is qualified by lab:approval-records (pg-work group).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import canonicalize from "canonicalize";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import {
  approvalPermissions,
  proposerVerb,
  workPermissions,
} from "../packages/contracts/src/work-permissions.ts";
import {
  canonicalDigest,
  checkProposal,
  confirmationPhrase,
  previewSelection,
  proposalDigest,
  proposalRef,
} from "../packages/policy/src/review.ts";
import { isPaidWork } from "../packages/policy/src/paid-work.ts";
import {
  approvalCaps,
  approvalErrors,
  approvalRefDigest,
  derivedProposalId,
  productionProducers,
  projectApproval,
  scopeDigest,
  submitProposal,
  utcText,
  viewerRole,
} from "../packages/work/src/approvals/index.ts";
import { approvalStatements } from "../packages/work/src/approvals/sql.ts";
import { workStatements } from "../packages/work/src/sql.ts";
import { workRequestDigest } from "../packages/work/src/digest.ts";
import { inspectImports } from "../scripts/boundary-checks.mjs";
import {
  approvalProducers,
  grantsReviseProducer,
  privacyEraseProducer,
} from "./fixtures/approval-producers.mjs";

const read = (path) => readFileSync(path, "utf8");
const oracle = (value) => createHash("sha256").update(canonicalize(value)).digest("hex");
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const catalogue = JSON.parse(read("docs/contracts/capabilities.json"));
const defaults = JSON.parse(read("docs/contracts/review-policy-defaults.json"));
const transitions = JSON.parse(read("docs/contracts/state-transitions.json"));
const records = read("migrations/0018.approval-records.sql");
const bridge = read("migrations/0017.approval-identity-bridge.sql");
const O = "org_o",
  WS = "ws_w";
const W = {
  organizationId: O,
  workspaceId: WS,
  storeId: null,
  connectionId: null,
  kind: "workspace",
  id: WS,
};
const actor = (name) => ({
  kind: "human",
  principalId: "person_" + name,
  organizationId: O,
  workspaceId: WS,
  membershipId: "membership_" + name,
  installationId: null,
  mandateId: null,
});
function grant(name, capabilityId, verbs, fields, overrides = {}) {
  return {
    id: "grant_" + name + "_" + capabilityId.replaceAll(".", "_"),
    principal: actor(name),
    capabilityId,
    verbs,
    scope: {
      organizationId: O,
      workspaceId: WS,
      storeIds: [],
      accountIds: [],
      resources: [W],
      fields,
    },
    issuedBy: actor(name),
    validFrom: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
    ...overrides,
  };
}
const templateV1 = {
  "governance.grants.revise": [
    ["execute", "approve"],
    ["proposalRef", "approvalRef"],
  ],
  "governance.approval.decide": [["approve"], ["proposalRef", "decision", "expectedRevision"]],
  "governance.approval.preview": [["view"], ["proposalRef", "selectedTargetIndexes"]],
};
const reviewer = {
  "governance.approval.decide": templateV1["governance.approval.decide"],
  "governance.approval.preview": templateV1["governance.approval.preview"],
  "governance.grants.revise": [["approve"], ["proposalRef", "approvalRef"]],
};
const authority = (name, set) =>
  Object.freeze({
    actor: actor(name),
    policyRevision: 1,
    grants: Object.entries(set).map(([c, [verbs, fields]]) => grant(name, c, verbs, fields)),
    databaseNowMs: Date.parse("2026-10-19T10:00:00.000Z"),
    resource: W,
  });
const NOW = "2026-10-19T10:00:00.000Z";
const policy = {
  schemaVersion: 1,
  id: "review-policy",
  organizationId: O,
  workspaceId: WS,
  storeId: null,
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
  rules: structuredClone(defaults.rules),
};

test("producers: closed parameters, W targets and input-name fields; production registry empty", () => {
  assert.equal(productionProducers.size, 0);
  assert.equal(grantsReviseProducer.parse({ beneficiaryPrincipalId: "person_c", extra: 1 }), null);
  assert.equal(grantsReviseProducer.parse({ beneficiaryPrincipalId: "bad id" }), null);
  const parsed = grantsReviseProducer.parse({ beneficiaryPrincipalId: "person_c" });
  const plan = grantsReviseProducer.plan(parsed, { organizationId: O, workspaceId: WS });
  assert.deepEqual(plan.beneficiaryPrincipalIds, ["person_c"]);
  assert.deepEqual(plan.targets[0].resource, W);
  const inputs = (id) => Object.keys(catalogue.capabilities.find((c) => c.id === id).input.fields);
  for (const [producer, value] of [
    [grantsReviseProducer, { beneficiaryPrincipalId: "person_c" }],
    [privacyEraseProducer, { subjects: ["s1", "s2", "s3"] }],
  ]) {
    const p = producer.plan(producer.parse(value), { organizationId: O, workspaceId: WS });
    for (const t of p.targets) {
      assert.ok(validateCurrentDefinition("ProposalTarget", t));
      for (const field of t.fields) assert.ok(inputs(producer.capabilityId).includes(field), field);
    }
  }
  const erase = privacyEraseProducer.plan(
    privacyEraseProducer.parse({ subjects: ["s1", "s2", "s3"] }),
    {
      organizationId: O,
      workspaceId: WS,
    },
  );
  assert.equal(new Set(erase.targets.map((t) => t.expectedSourceRevision)).size, 3);
  assert.equal(privacyEraseProducer.partialApproval, "allowed");
  assert.equal(grantsReviseProducer.partialApproval, "all_or_nothing");
});

test("digests: scopeDigest, ApprovalRef.digest, derived ids and utc_text equal the oracle", () => {
  const scope = {
    organizationId: O,
    workspaceId: WS,
    storeIds: [],
    accountIds: [],
    resources: [W],
    fields: ["approvalRef", "proposalRef"],
  };
  assert.equal(scopeDigest(scope), oracle(scope));
  for (const effectiveAt of [null, "2026-10-19T10:00:00.001Z"]) {
    const fields = {
      organizationId: O,
      workspaceId: WS,
      id: "approval_1",
      revision: 2,
      proposalDigest: "a".repeat(64),
      scopeDigest: "b".repeat(64),
      status: "approved",
      effectiveAt,
      expiresAt: "2026-10-19T11:00:00.999Z",
    };
    const expected = sha(
      `{"effectiveAt":${effectiveAt === null ? "null" : JSON.stringify(effectiveAt)},"expiresAt":"2026-10-19T11:00:00.999Z","id":"approval_1","kind":"approval","organizationId":"org_o","proposalDigest":"${"a".repeat(64)}","revision":2,"scopeDigest":"${"b".repeat(64)}","status":"approved","workspaceId":"ws_w"}`,
    );
    assert.equal(approvalRefDigest(fields), expected);
    assert.equal(approvalRefDigest(fields), oracle({ ...fields, kind: "approval" }));
  }
  const parentRef = {
    organizationId: O,
    workspaceId: WS,
    storeId: null,
    kind: "proposal",
    id: "p1",
    revision: 1,
    digest: "c".repeat(64),
  };
  for (const indexes of [[0], [0, 1], Array.from({ length: 999 }, (_, i) => i)]) {
    const id = derivedProposalId(parentRef, indexes);
    assert.equal(id, "derived_" + oracle({ parentRef, selectedTargetIndexes: indexes }));
    // The SQL template (morrow_work.derived_proposal_id) renders exactly this JCS text.
    assert.equal(
      id,
      "derived_" +
        sha(
          `{"parentRef":{"digest":"${"c".repeat(64)}","id":"p1","kind":"proposal","organizationId":"org_o","revision":1,"storeId":null,"workspaceId":"ws_w"},"selectedTargetIndexes":[${indexes.join(",")}]}`,
        ),
    );
  }
  for (const ms of [0, 1, 999, 1760000000000, 1760000000001])
    assert.equal(utcText(ms), new Date(ms).toISOString());
  assert.match(utcText(Date.parse(NOW)), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("projectApproval: claim, expiry, policy and solo-owner conditions in order, monotone", () => {
  const at = Date.parse("2026-10-19T10:00:00.000Z");
  const row = (o = {}) => ({
    status: "approved",
    expiresAt: "2026-10-19T11:00:00.000Z",
    boundPolicyRevision: 1,
    soloReviewerPrincipalId: null,
    soloDecidedAt: null,
    quietPeriodSeconds: 3600,
    ...o,
  });
  const facts = (o = {}) => ({
    hasClaim: false,
    currentPolicyRevision: 1,
    ownerPrincipalId: "person_s",
    activeHumanMembershipCount: 1,
    lastMembershipChangeAt: null,
    ...o,
  });
  assert.deepEqual(projectApproval(row(), facts(), at), { status: "approved", code: null });
  assert.deepEqual(projectApproval(row(), facts({ hasClaim: true }), at), {
    status: "approved",
    code: "APPROVAL_ALREADY_CLAIMED",
  });
  const expiry = Date.parse(row().expiresAt);
  assert.equal(projectApproval(row(), facts(), expiry - 1).code, null);
  assert.deepEqual(projectApproval(row(), facts(), expiry), {
    status: "expired",
    code: "APPROVAL_EXPIRED",
  });
  assert.deepEqual(projectApproval(row(), facts({ currentPolicyRevision: 2 }), at), {
    status: "invalidated",
    code: "REVIEW_POLICY_NOT_CURRENT",
  });
  const solo = row({
    soloReviewerPrincipalId: "person_s",
    soloDecidedAt: "2026-10-19T09:00:00.000Z",
  });
  assert.equal(projectApproval(solo, facts(), at).code, null);
  for (const lost of [
    facts({ activeHumanMembershipCount: 2 }),
    facts({ ownerPrincipalId: null }),
    facts({ ownerPrincipalId: "person_t" }),
    // A membership change after the decision, before or after effectiveAt.
    facts({ lastMembershipChangeAt: "2026-10-19T09:30:00.000Z" }),
  ])
    assert.deepEqual(projectApproval(solo, lost, at), {
      status: "invalidated",
      code: "SOLO_OWNER_STATUS_LOST",
    });
  // A change long before the decision, outside the quiet period, keeps solo status.
  assert.equal(
    projectApproval(solo, facts({ lastMembershipChangeAt: "2026-10-18T00:00:00.000Z" }), at).code,
    null,
  );
  for (const status of ["rejected", "expired", "invalidated", "cancelled"])
    assert.deepEqual(
      projectApproval(
        row({ status }),
        facts({ hasClaim: true, currentPolicyRevision: 9 }),
        expiry + 1,
      ),
      {
        status,
        code: null,
      },
    );
  // Pending is projected the same way.
  assert.equal(projectApproval(row({ status: "pending" }), facts(), expiry).status, "expired");
});

test("errors: every refusal maps to one fixed ErrorEnvelope class (§7)", () => {
  const expect = {
    not_found: [404, "denied", "never"],
    REVIEWER_DENIED: [403, "denied", "never"],
    SELF_APPROVAL_DENIED: [403, "denied", "never"],
    CONFIRMATION_MISMATCH: [403, "denied", "never"],
    CANCEL_NOT_ALLOWED: [403, "denied", "never"],
    denied: [403, "denied", "never"],
    SELECTION_INVALID: [400, "missing_input", "never"],
    PARTIAL_APPROVAL_NOT_ALLOWED: [400, "missing_input", "never"],
    invalid: [400, "missing_input", "never"],
    DIGEST_MISMATCH: [409, "conflict", "recheck_before_retry"],
    STALE_REVISION: [409, "conflict", "recheck_before_retry"],
    revision_conflict: [409, "conflict", "recheck_before_retry"],
    FAMILY_CONFLICT: [409, "conflict", "recheck_before_retry"],
    REVIEW_POLICY_NOT_CURRENT: [409, "conflict", "recheck_before_retry"],
    COMMAND_CONFLICT: [409, "conflict", "recheck_before_retry"],
    DUPLICATE_REVIEWER: [409, "conflict", "recheck_before_retry"],
    REVIEWER_AUTHORITY_LOST: [409, "conflict", "recheck_before_retry"],
    state_conflict: [409, "conflict", "recheck_before_retry"],
    stale_authority: [409, "conflict", "recheck_before_retry"],
    SOLO_OWNER_STATUS_LOST: [409, "conflict", "never"],
    quorum_unreachable: [409, "conflict", "never"],
    limit_reached: [409, "conflict", "never"],
    APPROVAL_EXPIRED: [409, "approval_expired", "never"],
    unauthenticated: [401, "denied", "never"],
  };
  for (const [code, [status, category, retry]] of Object.entries(expect))
    assert.deepEqual(
      { ...approvalErrors[code] },
      { status, code: category, retryClass: retry },
      code,
    );
  for (const mapping of Object.values(approvalErrors)) assert.ok(Object.isFrozen(mapping));
});

test("vocabulary: approval rows carry the governance-input-fields deviation; work rows never do", () => {
  const capabilities = new Map(catalogue.capabilities.map((c) => [c.id, c]));
  for (const rule of Object.values(workPermissions)) assert.equal("deviation" in rule, false);
  for (const [key, rule] of Object.entries(approvalPermissions)) {
    assert.ok(["governance-input-fields", null].includes(rule.deviation), key);
    for (const r of rule.requirements) {
      if (r.capabilityId === "proposal") {
        assert.equal(r.fields, "targets", key);
        assert.equal(rule.deviation, "governance-input-fields", key);
        continue;
      }
      const capability = capabilities.get(r.capabilityId);
      assert.ok(capability, key);
      for (const field of r.fields) assert.ok(validateCurrentDefinition("FieldPath", field), field);
      if (r.capabilityId.startsWith("governance.")) {
        assert.equal(rule.deviation, "governance-input-fields", key);
        // Grant fields of governance capabilities are input names (ADR-0009 item 7).
        assert.deepEqual([...r.fields].sort(), Object.keys(capability.input.fields).sort(), key);
      } else assert.equal(rule.deviation, null, key);
    }
  }
  assert.equal(proposerVerb("governance.grants.revise"), "execute");
  assert.equal(proposerVerb("governance.connection.connect"), "administer");
  // Approvals and claims of control capabilities are never paid work.
  for (const verb of ["view", "approve", "execute"])
    for (const c of [
      "governance.grants.revise",
      "governance.privacy.erase",
      "governance.approval.decide",
    ])
      assert.equal(isPaidWork(c, verb), false, c + " " + verb);
});

test("visibility: reviewers and the proposal's own proposer read; others are not found", async () => {
  const proposal = {
    capabilityId: "governance.grants.revise",
    targets: [
      {
        resource: W,
        expectedSourceRevision: "x",
        fields: ["approvalRef", "proposalRef"],
        maximumCredits: "0",
        maximumCost: null,
      },
    ],
  };
  const stored = (p) => ({
    proposal: {
      ...proposal,
      organizationId: O,
      workspaceId: WS,
      storeId: null,
      derivedFrom: null,
      id: "p1",
    },
    proposer: { principalId: "person_" + p, membershipId: "membership_" + p },
    requester: { principalId: "person_" + p, membershipId: "membership_" + p },
  });
  // reviewerEligible validates a full Proposal@2, so use a real one from the library.
  const full = buildProposal();
  const s = { proposal: full, proposer: stored("a").proposer, requester: stored("a").requester };
  assert.equal(await viewerRole(authority("b", reviewer), s), "reviewer");
  const ownerSet = { ...templateV1 };
  assert.equal(await viewerRole(authority("a", ownerSet), s), "reviewer");
  // A proposer without reviewer verbs reads its own proposal; another such member cannot.
  const proposerOnly = {
    "governance.grants.revise": [["execute"], ["proposalRef", "approvalRef"]],
  };
  assert.equal(await viewerRole(authority("a", proposerOnly), s), "proposer");
  assert.equal(await viewerRole(authority("e", proposerOnly), s), null);
  // No grants; decide verbs without preview view; preview without the capability verb.
  assert.equal(await viewerRole(authority("x", {}), s), null);
  const blind = { ...reviewer };
  delete blind["governance.approval.preview"];
  assert.equal(await viewerRole(authority("v", blind), s), null);
  const noCapability = { ...reviewer };
  delete noCapability["governance.grants.revise"];
  assert.equal(await viewerRole(authority("v", noCapability), s), null);
});

function buildProposal(overrides = {}) {
  const content = {
    schemaVersion: 2,
    id: "p1",
    organizationId: O,
    workspaceId: WS,
    storeId: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    taskId: "task_a",
    capabilityId: "governance.grants.revise",
    scope: {
      organizationId: O,
      workspaceId: WS,
      storeIds: [],
      accountIds: [],
      resources: [W],
      fields: ["approvalRef", "proposalRef"],
    },
    targets: [
      {
        resource: W,
        expectedSourceRevision: "grants:person_c",
        fields: ["approvalRef", "proposalRef"],
        maximumCredits: "0",
        maximumCost: null,
      },
    ],
    parametersRef: {
      organizationId: O,
      workspaceId: WS,
      storeId: null,
      kind: "artifact",
      id: "params_1",
      revision: 1,
      digest: "d".repeat(64),
    },
    parametersDigest: "d".repeat(64),
    maximumCredits: "0",
    maximumCost: null,
    risk: "access_change",
    irreversible: false,
    reviewPolicyRef: {
      organizationId: O,
      workspaceId: WS,
      storeId: null,
      kind: "policy",
      id: "review-policy",
      revision: 1,
      digest: oracle(policy),
    },
    proposedBy: actor("a"),
    requestedBy: actor("a"),
    beneficiaryPrincipalIds: ["person_c"],
    contextTaint: "none",
    partialApproval: "all_or_nothing",
    derivedFrom: null,
    proposalDigest: "0".repeat(64),
    expiresAt: "2026-10-20T11:05:00.000Z",
    ...overrides,
  };
  return { ...content, proposalDigest: proposalDigest(content) };
}

// A scripted WorkTx: canned rows per statement, recording what was sent.
function scriptedTx(script) {
  const sent = [];
  let submitted = false,
    rolledBack = false;
  return {
    sent,
    get submitted() {
      return submitted;
    },
    get rolledBack() {
      return rolledBack;
    },
    async run(name, values) {
      assert.ok(Object.hasOwn(workStatements, name), name);
      sent.push({ name, values: [...values] });
      const reply = script[name];
      if (!reply) throw Error("UNSCRIPTED_" + name);
      return typeof reply === "function" ? reply(values) : reply;
    },
    markSubmitted() {
      submitted = true;
    },
    rollbackOnly() {
      rolledBack = true;
    },
  };
}
const contextRow = (o = {}) => ({
  policy_revision: null,
  policy_canonical: null,
  policy_digest: null,
  defaults_digest: canonicalDigest(defaults.rules),
  capability_effect: "control",
  capability_irreversible: "false",
  capability_review_required: "true",
  capability_kill_switch: "false",
  risk: "access_change",
  owner_principal_id: "person_a",
  owner_membership_id: "membership_a",
  active_human_membership_count: "6",
  last_membership_change_at: null,
  claimed_approval_id: null,
  database_now: NOW,
  ...o,
});
const candidate = (name, set) => {
  const grants = Object.entries(set).map(([c, [verbs, fields]]) => grant(name, c, verbs, fields));
  return {
    principal_id: "person_" + name,
    membership_id: "membership_" + name,
    grants: JSON.stringify(grants),
    grant_count: String(grants.length),
    grants_digest: sha(JSON.stringify(grants)),
    evaluated_at: NOW,
  };
};

test("submit: the built Proposal@2 passes checkProposal and the SQL arguments bind it exactly (AC01 shape)", async () => {
  const a = authority("a", {
    ...templateV1,
    "workspace.task.create": [["view", "execute"], ["status"]],
  });
  const body = {
    capabilityId: "governance.grants.revise",
    taskId: "task_a",
    parameters: { beneficiaryPrincipalId: "person_c" },
  };
  let call;
  const tx = scriptedTx({
    beginApprovalCommand: [
      { outcome: "new", aggregate_type: null, aggregate_id: null, result: null },
    ],
    proposalTask: [
      {
        status: "draft",
        initiator_principal_id: "person_a",
        initiator_membership_id: "membership_a",
      },
    ],
    reviewContext: [contextRow()],
    // The owner A is conflicted under the solo rule: judged first, but not solo (six members).
    reviewerSnapshot: [candidate("a", templateV1)],
    reviewCandidates: [candidate("b", reviewer)],
    cmdProposalSubmit: (values) => {
      call = values;
      return [
        {
          outcome: "applied",
          result: JSON.stringify({
            proposalId: JSON.parse(values[10]).id,
            proposalDigest: values[11],
            approvalId: values[5],
            approvalRevision: 1,
            approvalDigest: "e".repeat(64),
            status: "pending",
            effectiveAt: null,
            expiresAt: "2026-10-20T10:00:00.000Z",
          }),
        },
      ];
    },
  });
  const commandId = crypto.randomUUID();
  const requestDigest = await workRequestDigest("proposal.submit", WS, [], body);
  const result = await submitProposal(tx, a, approvalProducers, {
    commandId,
    requestDigest,
    ...body,
  });
  assert.equal(result.outcome, "applied", JSON.stringify(result));
  assert.ok(tx.submitted);
  const [
    cmd,
    digest,
    ,
    task,
    basis,
    approvalId,
    policyCanonical,
    policyDigest,
    paramsCanonical,
    paramsDigest,
    canonical,
    proposalDigestValue,
    scopeCanonical,
  ] = call;
  assert.equal(cmd, commandId);
  assert.equal(digest, requestDigest);
  assert.equal(task, "task_a");
  assert.equal(basis, "own");
  assert.match(approvalId, /^[a-f0-9-]{36}$/);
  // Revision 1 is seeded from the defaults with the proposal's createdAt.
  const seeded = JSON.parse(policyCanonical);
  assert.deepEqual(seeded.rules, defaults.rules);
  assert.equal(seeded.revision, 1);
  assert.equal(seeded.createdAt, NOW);
  assert.equal(sha(policyCanonical), policyDigest);
  assert.equal(canonicalize(seeded), policyCanonical);
  assert.equal(sha(paramsCanonical), paramsDigest);
  assert.deepEqual(JSON.parse(paramsCanonical), { beneficiaryPrincipalId: "person_c" });
  // The canonical text is RFC 8785 of the proposal without proposalDigest.
  const content = JSON.parse(canonical);
  assert.equal(canonicalize(content), canonical);
  assert.equal(sha(canonical), proposalDigestValue);
  assert.equal("proposalDigest" in content, false);
  const proposal = { ...content, proposalDigest: proposalDigestValue };
  assert.ok(validateCurrentDefinition("Proposal", proposal));
  assert.equal(proposal.risk, "access_change");
  assert.equal(proposal.irreversible, false);
  assert.deepEqual(proposal.requestedBy, actor("a"));
  assert.deepEqual(proposal.beneficiaryPrincipalIds, ["person_c"]);
  assert.equal(proposal.contextTaint, "none");
  assert.deepEqual(proposal.scope, {
    organizationId: O,
    workspaceId: WS,
    storeIds: [],
    accountIds: [],
    resources: [W],
    fields: ["approvalRef", "proposalRef"],
  });
  assert.equal(canonicalize(proposal.scope), scopeCanonical);
  assert.equal(Date.parse(proposal.expiresAt) - Date.parse(proposal.createdAt), 90300 * 1000);
  assert.equal(proposal.reviewPolicyRef.digest, policyDigest);
  const codes = checkProposal(proposal, {
    organizationId: O,
    workspaceId: WS,
    storeId: null,
    proposedBy: actor("a"),
    taskId: "task_a",
    requestedBy: actor("a"),
    beneficiaryPrincipalIds: ["person_c"],
    contextTaint: "none",
    reviewPolicy: seeded,
    eligibleReviewerPrincipalIds: ["person_b"],
    ownership: {
      ownerPrincipalId: "person_a",
      ownerMembershipId: "membership_a",
      activeHumanMembershipCount: 6,
      lastMembershipChangeAt: null,
    },
    at: NOW,
  });
  assert.deepEqual(codes, []);
  // The quorum scan excluded the conflict set (proposer, requester, beneficiary).
  const scan = tx.sent.find((s) => s.name === "reviewCandidates");
  assert.deepEqual(JSON.parse(scan.values[1]).sort(), ["person_a", "person_c"]);
});

test("submit: refusals persist nothing and never reach the command function", async () => {
  const a = authority("a", {
    ...templateV1,
    "workspace.task.create": [["view", "execute"], ["status"]],
  });
  const base = { commandId: crypto.randomUUID(), requestDigest: "f".repeat(64), taskId: "task_a" };
  const run = async (input, script, set = null) => {
    const tx = scriptedTx(script);
    const result = await submitProposal(tx, set ?? a, approvalProducers, { ...base, ...input });
    assert.ok(!tx.submitted, JSON.stringify(result));
    assert.ok(tx.rolledBack);
    return result.outcome;
  };
  const begin = { beginApprovalCommand: [{ outcome: "new" }] };
  assert.equal(
    await run({ capabilityId: "governance.membership.invite", parameters: {} }, {}),
    "producer_missing",
  );
  assert.equal(
    await run(
      { capabilityId: "governance.grants.revise", parameters: { beneficiaryPrincipalId: "x y" } },
      {},
    ),
    "invalid",
  );
  assert.equal(
    await run(
      {
        capabilityId: "governance.grants.revise",
        parameters: { beneficiaryPrincipalId: "person_c" },
      },
      begin,
      authority("x", {}),
    ),
    "denied",
  );
  // Another's task without administer on workspace.task.create.
  assert.equal(
    await run(
      {
        capabilityId: "governance.grants.revise",
        parameters: { beneficiaryPrincipalId: "person_c" },
        taskId: "task_b",
      },
      {
        ...begin,
        proposalTask: [
          {
            status: "draft",
            initiator_principal_id: "person_b",
            initiator_membership_id: "membership_b",
          },
        ],
      },
    ),
    "denied",
  );
  // A target outside W.
  assert.equal(
    await run(
      { capabilityId: "governance.budget.revise", parameters: { workspaceId: "ws_other" } },
      begin,
    ),
    "invalid",
  );
  // 101 targets: over the published cap, before any SQL.
  const many = Array.from({ length: approvalCaps.targets + 1 }, (_, i) => "s" + i);
  assert.equal(
    await run({ capabilityId: "governance.privacy.erase", parameters: { subjects: many } }, {}),
    "invalid",
  );
  // No reachable quorum: the only candidate is ineligible.
  assert.equal(
    await run(
      {
        capabilityId: "governance.grants.revise",
        parameters: { beneficiaryPrincipalId: "person_c" },
      },
      {
        ...begin,
        proposalTask: [
          {
            status: "draft",
            initiator_principal_id: "person_a",
            initiator_membership_id: "membership_a",
          },
        ],
        reviewContext: [contextRow()],
        reviewerSnapshot: [candidate("a", templateV1)],
        reviewCandidates: [candidate("x", {})],
      },
    ),
    "quorum_unreachable",
  );
  // ADR-0018: no task only for a governance capability (the library's TASK_REQUIRED).
  const replay = { beginApprovalCommand: [{ outcome: "conflict" }] };
  assert.equal(
    await run(
      {
        capabilityId: "governance.grants.revise",
        parameters: { beneficiaryPrincipalId: "person_c" },
      },
      replay,
    ),
    "command_conflict",
  );
});

test("partial approval: the derived proposal and its id are the library's preview", () => {
  const erase = privacyEraseProducer.plan(
    privacyEraseProducer.parse({ subjects: ["s1", "s2", "s3"] }),
    { organizationId: O, workspaceId: WS },
  );
  const parent = buildProposal({
    capabilityId: "governance.privacy.erase",
    targets: erase.targets,
    scope: {
      organizationId: O,
      workspaceId: WS,
      storeIds: [],
      accountIds: [],
      resources: [W],
      fields: ["subjectRef"],
    },
    maximumCredits: "6",
    irreversible: true,
    partialApproval: "allowed",
    beneficiaryPrincipalIds: [],
  });
  const preview = previewSelection(parent, [0, 1]);
  assert.ok("proposal" in preview);
  assert.equal(preview.proposal.id, derivedProposalId(proposalRef(parent), [0, 1]));
  assert.equal(preview.proposal.maximumCredits, "3");
  assert.equal(preview.proposal.expiresAt, parent.expiresAt);
  assert.equal(scopeDigest(preview.proposal.scope), oracle(preview.proposal.scope));
  for (const bad of [[1, 0], [0, 0], [3], [0, 1, 2]])
    assert.ok("code" in previewSelection(parent, bad), JSON.stringify(bad));
  assert.equal(confirmationPhrase(preview.proposal), "approve 2 changes for 3 credits");
});

test("migration 0018: catalogue, risk table, defaults and approval transitions equal the contracts (AC19)", () => {
  const block = (start) => {
    const from = records.indexOf(start);
    assert.ok(from >= 0, start);
    return records.slice(from + start.length, records.indexOf(";\n", from));
  };
  const rows = block(
    "INSERT INTO morrow_work.review_capabilities(capability_id,effect,irreversible,review_required,kill_switch,executor) VALUES\n",
  )
    .trim()
    .split(",\n")
    .map((line) => {
      const m =
        /^\('([a-z_.]+)','([a-z_]+)',(true|false),(true|false),(true|false),'([a-z_]+)'\)$/.exec(
          line.trim(),
        );
      assert.ok(m, line);
      return {
        id: m[1],
        effect: m[2],
        irreversible: m[3] === "true",
        review_required: m[4] === "true",
        kill_switch: m[5] === "true",
        executor: m[6],
      };
    });
  assert.deepEqual(
    rows,
    catalogue.capabilities.map((c) => ({
      id: c.id,
      effect: c.effect,
      irreversible: c.irreversible,
      review_required: c.review_required,
      kill_switch: c.kill_switch,
      executor: c.executor,
    })),
  );
  const risks = Object.fromEntries(
    [
      ...block("INSERT INTO morrow_work.review_risk_by_effect(effect,risk) VALUES\n").matchAll(
        /\('([a-z_]+)','([a-z_]+)'\)/g,
      ),
    ].map((m) => [m[1], m[2]]),
  );
  assert.deepEqual(risks, defaults.riskClassByEffect);
  const defaultsRow =
    /INSERT INTO morrow_work\.review_policy_defaults\(version,rules,rules_digest\) VALUES \('review-policy-defaults@1',\n '([^']+)',\n '([a-f0-9]{64})'\);/.exec(
      records,
    );
  assert.ok(defaultsRow);
  assert.deepEqual(JSON.parse(defaultsRow[1]), defaults.rules);
  assert.equal(defaultsRow[1], canonicalize(defaults.rules));
  assert.equal(defaultsRow[2], canonicalDigest(defaults.rules));
  const persisted = [
    ...block(
      "INSERT INTO morrow_work.transition_rules(machine,from_status,to_status,actor,guard) VALUES\n",
    ).matchAll(/\('approval','([a-z_]+)','([a-z_]+)','([a-z_]+)','([a-z_]+)'\)/g),
  ].map((m) => m.slice(1).join("|"));
  const effective = transitions.transitions.approval
    .filter((r) => r.superseded_in === undefined)
    .map((r) => [r.from, r.to, r.actor, r.guard].join("|"));
  assert.deepEqual(persisted.sort(), effective.sort());
  assert.equal(persisted.length, 11);
  // Both pending→invalidated work_service rows that differ only by guard, and family_rejected.
  assert.equal(
    persisted.filter((r) => r.startsWith("pending|invalidated|work_service|")).length,
    3,
  );
});

test("migrations 0017-0018: envelope, executeAs, fixed search paths and no execution path", () => {
  const manifest = JSON.parse(read("migrations/manifest.json"));
  const rows = manifest.migrations.filter((m) => m.reviewRef === "docs/packets/P06.T01b.md");
  assert.deepEqual(
    rows.map((m) => [m.sequence, m.file, m.executeAs]),
    [
      [17, "0017.approval-identity-bridge.sql", "morrow_identity_owner"],
      [18, "0018.approval-records.sql", "morrow_work_owner"],
    ],
  );
  for (const m of rows) assert.equal(sha(read("migrations/" + m.file)), m.sha256);
  for (const text of [bridge, records]) {
    assert.match(text, /^BEGIN;/);
    assert.match(text, /COMMIT;\s*$/);
    for (const fn of text.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION [^\n]+\n(?:[^\n]*\n)*?LANGUAGE [^\n]*/g,
    ))
      assert.match(fn[0], /SET search_path=pg_catalog/, fn[0].slice(0, 80));
  }
  // The bridge executes for the command role only; four functions.
  assert.equal(
    [
      ...bridge.matchAll(
        /GRANT EXECUTE ON FUNCTION morrow_identity\.work_[a-z_]+\([^)]*\) TO morrow_work_command;/g,
      ),
    ].length,
    4,
  );
  assert.doesNotMatch(bridge.replace(/--.*$/gm, ""), /TO morrow_work_api|TO PUBLIC/);
  // No ledger, operation or dispatch, and the claim primitive is granted to nobody.
  assert.doesNotMatch(
    records,
    /CREATE TABLE morrow_work\.(operations|operation_ledger|runs|dispatch)/,
  );
  assert.doesNotMatch(
    records.replace(/--.*$/gm, ""),
    /GRANT EXECUTE ON FUNCTION[^;]*approval_claim/,
  );
  assert.doesNotMatch(
    records.replace(/--.*$/gm, ""),
    /GRANT[^;]*\b(DELETE|TRUNCATE)\b[^;]*TO morrow_work_(api|command)/,
  );
  assert.match(
    records,
    /GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;[\s\S]*REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;\s*COMMIT;\s*$/,
  );
});

test("statements: the approval statements are fixed SELECTs merged into workStatements", () => {
  for (const [name, text] of Object.entries(approvalStatements)) {
    assert.equal(workStatements[name], text, name);
    assert.match(text, /^SELECT /, name);
    assert.doesNotMatch(text, /SET ROLE|set_config|\bINSERT\b|\bUPDATE\b|\bDELETE\b/, name);
  }
  for (const f of ["submit", "decide", "withdraw", "claim", "reads", "family", "kernel", "mapping"])
    assert.doesNotMatch(
      read("packages/work/src/approvals/" + f + ".ts"),
      /SET (LOCAL )?ROLE|morrow_work\.cmd_|SELECT /,
      f,
    );
});

test("boundaries: product code cannot import the test-only producers", () => {
  const errors = inspectImports(
    "packages/work/src/approvals/example.ts",
    'import { approvalProducers } from "../../../../tests/fixtures/approval-producers.mjs";',
  );
  assert.ok(errors.includes("TEST_FIXTURE_IMPORT"), JSON.stringify(errors));
  assert.deepEqual(
    inspectImports(
      "tests/example.test.mjs",
      'import { approvalProducers } from "./fixtures/approval-producers.mjs";',
    ),
    [],
  );
});
