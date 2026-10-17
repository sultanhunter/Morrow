// P01.T02a PR-B: review policy, exact proposals and the review library
// (AC12-AC25) in packages/policy/src/review.ts, through the typed library and
// docs/contracts/fixtures/P01.T02a.json. ADR-0011.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  checkProposal,
  previewSelection,
  effectiveRule,
  confirmationPhrase,
  foldDecisions,
  dispatchCheck,
  reviewerEligible,
  pendingApproval,
  proposalDigest,
  reviewPolicyRef,
  approvalRef,
  reviewError,
  riskClassFor,
  ReviewBoundaryError,
} from "../packages/policy/src/review.ts";
import { checkKillSwitchTarget } from "../packages/policy/src/kill-switch.ts";
import { createHumanPolicyService } from "../packages/policy/src/index.ts";
import {
  validateCurrentDefinition,
  validateDefinition,
  validateCapabilityInput,
  validateCapabilityOutput,
} from "../packages/contracts/src/validation.ts";
import { checkFixture, inspectTransition } from "../scripts/contract-checks.mjs";
import {
  T0,
  tenant,
  human,
  agent,
  policy,
  policyRef,
  proposal,
  seal,
  ref,
  team,
  solo,
  facts,
  oracle,
  defaults,
  catalogue,
} from "./fixtures/review-policy.mjs";

const fixtures = JSON.parse(readFileSync("docs/contracts/fixtures/P01.T02a.json", "utf8"));
const fixture = (id) => structuredClone(fixtures.find((f) => f.id === id).value);
const at = (minutes) =>
  new Date(Date.parse("2026-10-18T10:00:00Z") + minutes * 60000).toISOString();
const plus = (time, seconds) => new Date(Date.parse(time) + seconds * 1000).toISOString();
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
// Every transition any fold emits, for AC25.
const emitted = [];
function family(p, pol = policy()) {
  return {
    revision: 1,
    members: [
      {
        proposal: p,
        approval: pendingApproval(p, pol, { id: "approval_a", createdAt: T0, policyRevision: 1 }),
      },
    ],
    commands: [],
  };
}
let sequence = 0;
function attempt(state, reviewer, decision = {}, overrides = {}) {
  const root = state.members[0].proposal;
  const n = ++sequence;
  return {
    commandId: `command_${n}`,
    requestDigest: oracle({ n }),
    reviewer,
    input: {
      proposalRef: ref(root),
      decision: {
        decision: "approve",
        selectedTargetIndexes: null,
        expectedDecisionDigest: root.proposalDigest,
        soloOwnerConfirmation: null,
        comment: null,
        ...decision,
      },
      expectedRevision: state.revision,
    },
    at: at(0),
    reviewerEligible: true,
    ownership: team(),
    currentPolicy: policy(),
    ...overrides,
  };
}
function fold(state, ...attempts) {
  const result = foldDecisions(state, attempts);
  for (const r of result.results) if (r.ok) emitted.push(...r.transitions);
  return result;
}
const one = (state, ...args) => {
  const r = fold(state, attempt(state, ...args));
  return { state: r.state, result: r.results[0], invalidate: r.invalidate };
};
const code = (step) => (step.result.ok ? step.result.status : step.result.code);
const approvalOf = (state, id) => state.members.find((m) => m.approval.id === id)?.approval;

test("the P01.T02a.json Proposal@2 fixture passes checkProposal with matching trusted facts", () => {
  const p = fixture("P01.T02a.proposal.valid");
  assert.equal(validateCurrentDefinition("Proposal", p), true);
  assert.equal(proposalDigest(p), p.proposalDigest);
  assert.deepEqual(checkProposal(p, facts(p)), []);
  assert.equal(validateCurrentDefinition("Proposal", fixture("P01.T02a.proposal.v1_shape")), false);
  const approval = fixture("P01.T02a.approval.pending");
  assert.equal(validateCurrentDefinition("Approval", approval), true);
  assert.deepEqual(
    approval,
    pendingApproval(p, policy(), { id: approval.id, createdAt: T0, policyRevision: 1 }),
  );
});

test("AC12: ceilings are non-negative integer credits and exact cash sums inside the digest", () => {
  const p = proposal();
  const changed = structuredClone(p);
  changed.targets[0].maximumCredits = "11";
  assert.notEqual(proposalDigest(changed), p.proposalDigest);
  assert.notEqual(proposalDigest(seal({ ...changed, maximumCredits: "26" })), p.proposalDigest);
  for (const credits of ["1.5", "-1", "01", 20]) {
    assert.equal(validateDefinition("billing", "CreditUnits", credits), false, String(credits));
    assert.equal(
      validateCurrentDefinition("ProposalTarget", { ...p.targets[0], maximumCredits: credits }),
      false,
    );
  }
  assert.equal(
    validateCurrentDefinition("ProposalTarget", {
      ...p.targets[0],
      maximumCost: { amount: "-90.00", currency: "USD" },
    }),
    false,
  );
  const two = proposal({ credits: ["10", "10"] });
  assert.deepEqual(checkProposal(seal({ ...two, maximumCredits: "25" }), facts(two)), [
    "CREDITS_SUM_MISMATCH",
  ]);
  // BigInt, not floating point: 2^53 + 1 survives the sum exactly.
  const big = proposal({ credits: ["9007199254740993", "1"] });
  assert.equal(big.maximumCredits, "9007199254740994");
  assert.deepEqual(checkProposal(big, facts(big)), []);
  const mixed = proposal({ credits: ["10", "5"], costs: ["10.00", "5.00"] });
  mixed.targets[1].maximumCost.currency = "EUR";
  assert.deepEqual(checkProposal(seal(mixed), facts(mixed)), ["COST_SUM_MISMATCH"]);
  const nullTotal = proposal({ credits: ["10", "5"], costs: ["10.00", null] });
  assert.deepEqual(checkProposal(seal({ ...nullTotal, maximumCost: null }), facts(nullTotal)), [
    "COST_SUM_MISMATCH",
  ]);
  // The exact decimal sum: 10.005 + 2.5 = 12.505, never 12.50.
  const exact = proposal({ credits: ["1", "1"], costs: ["10.005", "2.5"] });
  assert.deepEqual(exact.maximumCost, { amount: "12.505", currency: "USD" });
  assert.deepEqual(checkProposal(exact, facts(exact)), []);
  assert.deepEqual(
    checkProposal(
      seal({ ...exact, maximumCost: { amount: "12.50", currency: "USD" } }),
      facts(exact),
    ),
    ["COST_SUM_MISMATCH"],
  );
});

test("AC13: each server-derived field has its own mismatch code", () => {
  const refund = () =>
    proposal({ capabilityId: "orders.refund.create", credits: ["10"], requestedBy: human("maya") });
  const base = refund();
  assert.equal(base.risk, "financial");
  assert.equal(base.irreversible, true);
  assert.deepEqual(checkProposal(base, facts(base)), []);
  const only = (p, f, expected) => assert.deepEqual(checkProposal(seal(p), f), [expected]);
  only({ ...refund(), risk: "internal" }, facts(base), "RISK_CLASS_MISMATCH");
  only({ ...refund(), irreversible: false }, facts(base), "IRREVERSIBLE_MISMATCH");
  only({ ...refund(), requestedBy: human("leo") }, facts(base), "REQUESTED_BY_MISMATCH");
  only(refund(), facts(base, { beneficiaryPrincipalIds: ["human_ana"] }), "BENEFICIARIES_MISMATCH");
  only(refund(), facts(base, { contextTaint: "untrusted_external" }), "CONTEXT_TAINT_MISMATCH");
  only({ ...refund(), proposedBy: human("leo") }, facts(base), "PROPOSED_BY_MISMATCH");
  // An older policy revision, or a store-scoped policy, is not the workspace's current policy.
  only(refund(), facts(base, { reviewPolicy: policy({}, 2) }), "REVIEW_POLICY_NOT_CURRENT");
  only(
    { ...refund(), reviewPolicyRef: { ...base.reviewPolicyRef, storeId: "store_a" } },
    facts(base),
    "REVIEW_POLICY_NOT_CURRENT",
  );
  const foreign = refund();
  foreign.targets[0].resource.workspaceId = "workspace_b";
  foreign.scope.resources[0].workspaceId = "workspace_b";
  only(foreign, facts(base), "TENANT_MISMATCH");
  const unscoped = refund();
  unscoped.targets[0].fields = ["amount"];
  only(unscoped, facts(base), "TARGET_SCOPE_MISMATCH");
  // A stored digest that does not cover the content.
  assert.deepEqual(checkProposal({ ...refund(), proposalDigest: "d".repeat(64) }, facts(base)), [
    "PROPOSAL_DIGEST_MISMATCH",
  ]);
  // An agent requester is schema-invalid; the library refuses it at its boundary.
  const agentRequested = seal({ ...refund(), requestedBy: { ...agent } });
  assert.equal(validateCurrentDefinition("Proposal", agentRequested), false);
  assert.throws(() => checkProposal(agentRequested, facts(base)), ReviewBoundaryError);
  assert.throws(() => checkProposal(base, { ...facts(base), extra: true }), ReviewBoundaryError);
  // The fixed effect-to-risk table (ADR-0011 Q9).
  for (const c of catalogue.capabilities)
    assert.equal(riskClassFor(c.id), defaults.riskClassByEffect[c.effect], c.id);
});

test("AC14: partial approval derives a deterministic proposal and digest", () => {
  const parent = proposal();
  assert.equal(parent.maximumCredits, "25");
  assert.equal(parent.maximumCost, null);
  const first = previewSelection(parent, [0, 1]);
  const { proposal: derived } = first;
  assert.deepEqual(previewSelection(parent, [0, 1]), first);
  assert.deepEqual(previewSelection(parent, null), { proposal: parent });
  const derivedFrom = { parentRef: ref(parent), selectedTargetIndexes: [0, 1] };
  assert.deepEqual(derived, {
    ...parent,
    id: "derived_" + oracle(derivedFrom),
    revision: 1,
    targets: parent.targets.slice(0, 2),
    maximumCredits: "20",
    maximumCost: null,
    derivedFrom,
    partialApproval: "all_or_nothing",
    proposalDigest: derived.proposalDigest,
  });
  assert.equal(derived.proposalDigest, seal(derived).proposalDigest);
  for (const key of ["createdAt", "updatedAt", "expiresAt", "requestedBy", "proposedBy"])
    assert.deepEqual(derived[key], parent[key], key);
  assert.equal(validateCurrentDefinition("Proposal", derived), true);
  assert.equal(
    validateCapabilityOutput("governance.approval.preview", { proposal: derived }),
    true,
  );
  // A derived proposal passes the same server checks as its parent.
  assert.deepEqual(checkProposal(derived, facts(parent)), []);
  for (const selection of [[0, 1, 2], [1, 0], [3], [0, 0], [], [-1], [0.5], ["0"]])
    assert.deepEqual(
      previewSelection(parent, selection),
      { code: "SELECTION_INVALID" },
      JSON.stringify(selection),
    );
  assert.deepEqual(previewSelection(derived, [0]), { code: "SELECTION_INVALID" });
  assert.deepEqual(previewSelection(proposal({ partialApproval: "all_or_nothing" }), [0]), {
    code: "PARTIAL_APPROVAL_NOT_ALLOWED",
  });
  // A derived proposal can never be marked partially approvable.
  assert.equal(
    validateCurrentDefinition("Proposal", { ...derived, partialApproval: "allowed" }),
    false,
  );
});

test("AC14 property: derivation never raises a ceiling or extends expiry", () => {
  let seed = 20261018;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let run = 0; run < 200; run++) {
    const size = 2 + random(8);
    const credits = Array.from({ length: size }, () => String(random(1000)));
    const withCost = random(2) === 1;
    const costs = credits.map(() =>
      withCost && random(3) > 0 ? `${random(500)}.${String(random(100)).padStart(2, "0")}` : null,
    );
    const parent = proposal({ credits, costs });
    const selection = Array.from({ length: size }, (_, i) => i).filter(() => random(2) === 1);
    if (selection.length === 0 || selection.length === size) continue;
    const { proposal: derived } = previewSelection(parent, selection);
    assert.ok(BigInt(derived.maximumCredits) <= BigInt(parent.maximumCredits));
    if (derived.maximumCost !== null)
      assert.ok(Number(derived.maximumCost.amount) <= Number(parent.maximumCost.amount));
    assert.equal(derived.expiresAt, parent.expiresAt);
    assert.deepEqual(checkProposal(derived, facts(parent)), []);
  }
});

test("AC15: a decision bound to another selection's digest changes nothing", () => {
  const parent = proposal();
  const state = family(parent);
  const pair = previewSelection(parent, [0, 1]).proposal;
  const step = one(state, human("leo"), {
    selectedTargetIndexes: [0],
    expectedDecisionDigest: pair.proposalDigest,
  });
  assert.equal(code(step), "DIGEST_MISMATCH");
  assert.deepEqual(step.state, state);
  assert.deepEqual(step.invalidate, []);
  assert.equal(step.result.category, "conflict");
  assert.equal(step.result.retry, "recheck_before_retry");
});

test("AC16: at most one member of a family is approved", () => {
  const parent = proposal();
  const state = family(parent);
  const pair = previewSelection(parent, [0, 1]).proposal;
  const approved = one(state, human("leo"), {
    selectedTargetIndexes: [0, 1],
    expectedDecisionDigest: pair.proposalDigest,
  });
  assert.equal(code(approved), "approved");
  assert.deepEqual(approved.result.output, {
    approvalId: "approval_" + pair.id,
    proposalDigest: pair.proposalDigest,
  });
  assert.equal(
    validateCapabilityOutput("governance.approval.decide", approved.result.output),
    true,
  );
  assert.deepEqual(approved.invalidate, [approvalRef(state.members[0].approval)]);
  assert.equal(approvalOf(approved.state, "approval_a").status, "invalidated");
  const derivedApproval = approvalOf(approved.state, "approval_" + pair.id);
  assert.equal(validateCurrentDefinition("Approval", derivedApproval), true);
  assert.equal(derivedApproval.createdAt, state.members[0].approval.createdAt);
  const s = approved.state;
  assert.equal(code(one(s, human("ana"))), "FAMILY_CONFLICT");
  const sibling = previewSelection(parent, [2]).proposal;
  assert.equal(
    code(
      one(s, human("ana"), {
        selectedTargetIndexes: [2],
        expectedDecisionDigest: sibling.proposalDigest,
      }),
    ),
    "FAMILY_CONFLICT",
  );
  // Target 2 returns to draft; a fresh proposal for it can be approved.
  const fresh = proposal({ id: "proposal_b", credits: ["5"] });
  assert.equal(code(one(family(fresh), human("ana"))), "approved");
});

test("AC17: in a team, the requester cannot approve a financial change; another member can", () => {
  const financial = proposal({
    capabilityId: "ads.budget.change",
    credits: ["10"],
    requestedBy: human("maya"),
  });
  assert.equal(financial.risk, "financial");
  const state = family(financial);
  const ownership = team(2);
  assert.equal(code(one(state, human("maya"), {}, { ownership })), "SELF_APPROVAL_DENIED");
  const leo = one(state, human("leo"), {}, { ownership });
  assert.equal(code(leo), "approved");
  const approval = leo.state.members[0].approval;
  assert.equal(approval.effectiveAt, approval.decidedAt);
  assert.equal(
    dispatchCheck(leo.state, { now: approval.effectiveAt, currentPolicy: policy(), ownership }),
    "ok",
  );
  const external = proposal({ requestedBy: human("maya") });
  assert.equal(external.risk, "external");
  assert.equal(code(one(family(external), human("maya"), {}, { ownership })), "approved");
});

test("AC18: proposer, requester and beneficiary of an access change cannot approve it", () => {
  const grant = proposal({
    capabilityId: "governance.grants.revise",
    credits: ["0"],
    fields: ["status"],
    proposedBy: human("leo"),
    requestedBy: human("maya"),
    beneficiaryPrincipalIds: ["human_maya"],
  });
  assert.equal(grant.risk, "access_change");
  assert.deepEqual(checkProposal(grant, facts(grant)), []);
  const state = family(grant);
  assert.equal(code(one(state, human("maya"))), "SELF_APPROVAL_DENIED");
  assert.equal(code(one(state, human("leo"))), "SELF_APPROVAL_DENIED");
  assert.equal(code(one(state, human("ana"))), "approved");
  // A pure beneficiary is conflicted too.
  const forAna = proposal({
    capabilityId: "governance.grants.revise",
    credits: ["0"],
    fields: ["status"],
    beneficiaryPrincipalIds: ["human_ana"],
  });
  assert.equal(code(one(family(forAna), human("ana"))), "SELF_APPROVAL_DENIED");
});

test("AC19: the solo owner approves with the exact phrase after a cool-down, and may cancel before it", () => {
  const olivia = human("olivia");
  const p = proposal({
    capabilityId: "ads.budget.change",
    credits: ["10", "10"],
    requestedBy: olivia,
  });
  const phrase = confirmationPhrase(p);
  assert.equal(phrase, "approve 2 changes for 20 credits");
  assert.equal(
    confirmationPhrase(
      proposal({ capabilityId: "ads.budget.change", credits: ["10"], requestedBy: olivia }),
    ),
    "approve 1 change for 10 credits",
  );
  const costed = proposal({
    capabilityId: "ads.budget.change",
    credits: ["10", "10"],
    costs: ["10.00", "2.50"],
    requestedBy: olivia,
  });
  assert.ok(confirmationPhrase(costed).endsWith(" and 12.50 USD"));
  const state = family(p);
  const ownership = solo();
  const decide = (overrides = {}, decision = { soloOwnerConfirmation: phrase }) =>
    one(state, olivia, decision, { ownership, ...overrides });
  const approved = decide();
  assert.equal(code(approved), "approved");
  const approval = approved.state.members[0].approval;
  assert.equal(approval.effectiveAt, plus(approval.decidedAt, 300));
  assert.deepEqual(approval.decisions[0].soloOwnerConfirmation, {
    phraseDigest: sha(phrase),
    coolDownSeconds: 300,
  });
  assert.deepEqual(approved.result.transitions[0], {
    aggregate: "approval",
    approvalId: "approval_a",
    from: "pending",
    to: "approved",
    actor: "solo_owner",
    guard: "typed_confirmation_recorded_cool_down_scheduled",
  });
  const dispatch = (now) =>
    dispatchCheck(approved.state, { now, currentPolicy: policy(), ownership });
  assert.equal(dispatch(plus(approval.effectiveAt, -1)), "APPROVAL_NOT_EFFECTIVE");
  assert.equal(dispatch(approval.effectiveAt), "ok");
  for (const wrong of [
    "Approve 2 changes for 20 credits",
    "approve 2 changes for 20 credits ",
    "approve 2 change for 20 credits",
    null,
  ])
    assert.equal(
      code(decide({}, { soloOwnerConfirmation: wrong })),
      "CONFIRMATION_MISMATCH",
      String(wrong),
    );
  const cancel = (s, minutes, reviewer = olivia) =>
    one(
      s,
      reviewer,
      { decision: "cancel_before_effective", expectedDecisionDigest: p.proposalDigest },
      { ownership, at: at(minutes) },
    );
  const cancelled = cancel(approved.state, 4);
  assert.equal(code(cancelled), "cancelled");
  assert.equal(cancelled.result.transitions[0].to, "cancelled");
  assert.equal(
    dispatchCheck(cancelled.state, { now: at(6), currentPolicy: policy(), ownership }),
    "NOT_APPROVED",
  );
  assert.equal(code(cancel(approved.state, 5)), "CANCEL_NOT_ALLOWED");
  assert.equal(code(cancel(approved.state, 6)), "CANCEL_NOT_ALLOWED");
  assert.equal(code(cancel(approved.state, 1, human("leo"))), "CANCEL_NOT_ALLOWED");
  assert.equal(code(cancel(state, 1)), "CANCEL_NOT_ALLOWED");
  // A financial rule can never allow self-approval.
  assert.equal(
    validateCurrentDefinition("ReviewPolicyRules", {
      ...defaults.rules,
      financial: { ...defaults.rules.financial, selfApproval: "allowed" },
    }),
    false,
  );
});

test("AC20: no takeover through the kill switch or a manufactured solo status", () => {
  const control = { reason: "Remove the owner", sourceProposalRef: null };
  const owner = solo();
  // (a) Mallory holds a revoke grant and tries to revoke the owner.
  assert.deepEqual(
    checkKillSwitchTarget(
      {
        capabilityId: "governance.membership.revoke",
        input: { membershipId: "membership_olivia", control },
      },
      {
        ...tenant,
        records: [
          {
            kind: "member",
            id: "membership_olivia",
            ...tenant,
            storeId: null,
            connectionId: null,
            revision: null,
            digest: null,
          },
        ],
        grants: [{ storeIds: [], connectionIds: [] }],
        sourceProposal: null,
        ownership: { ...owner, activeHumanMembershipCount: 2 },
      },
    ).code,
    "OWNER_MEMBERSHIP_PROTECTED",
  );
  // (b) Mallory is the only active member but not the designated owner.
  const mallory = human("mallory");
  const forMallory = proposal({
    capabilityId: "ads.budget.change",
    credits: ["10"],
    requestedBy: mallory,
  });
  assert.equal(
    code(
      one(
        family(forMallory),
        mallory,
        { soloOwnerConfirmation: confirmationPhrase(forMallory) },
        { ownership: owner },
      ),
    ),
    "SELF_APPROVAL_DENIED",
  );
  // (c) The owner approves 10 minutes after revoking Ana: inside the quiet period.
  const olivia = human("olivia");
  const p = proposal({ capabilityId: "ads.budget.change", credits: ["10"], requestedBy: olivia });
  const phrase = { soloOwnerConfirmation: confirmationPhrase(p) };
  assert.equal(
    code(one(family(p), olivia, phrase, { ownership: solo({ lastMembershipChangeAt: at(-10) }) })),
    "SELF_APPROVAL_DENIED",
  );
  assert.equal(
    code(
      one(family(p), olivia, phrase, { ownership: solo({ lastMembershipChangeAt: at(-24 * 60) }) }),
    ),
    "approved",
  );
  // (d) A member joins, or a revocation happens, after the solo decision.
  const approved = one(family(p), olivia, phrase, { ownership: owner });
  const effectiveAt = approved.state.members[0].approval.effectiveAt;
  const check = (ownership) =>
    dispatchCheck(approved.state, { now: effectiveAt, currentPolicy: policy(), ownership });
  assert.equal(check(owner), "ok");
  assert.equal(check({ ...owner, activeHumanMembershipCount: 2 }), "SOLO_OWNER_STATUS_LOST");
  assert.equal(check({ ...owner, lastMembershipChangeAt: at(1) }), "SOLO_OWNER_STATUS_LOST");
  assert.equal(check({ ...owner, ownerPrincipalId: "human_ana" }), "SOLO_OWNER_STATUS_LOST");
  // A change after the decision loses solo status even once a short quiet period has passed.
  const short = policy({
    financial: { ...defaults.rules.financial, approvedValiditySeconds: 86400 },
    soloOwner: { coolDownSeconds: 300, quietPeriodSeconds: 3600 },
  });
  const q = proposal({
    capabilityId: "ads.budget.change",
    credits: ["10"],
    requestedBy: olivia,
    reviewPolicy: short,
  });
  const shortApproved = one(
    family(q, short),
    olivia,
    { soloOwnerConfirmation: confirmationPhrase(q) },
    { ownership: owner, currentPolicy: short },
  );
  assert.equal(code(shortApproved), "approved");
  const later = (ownership) =>
    dispatchCheck(shortApproved.state, { now: at(90), currentPolicy: short, ownership });
  assert.equal(later(owner), "ok");
  assert.equal(later({ ...owner, lastMembershipChangeAt: at(1) }), "SOLO_OWNER_STATUS_LOST");
  // A rule that denies self-approval refuses even the solo owner's exact phrase.
  const denied = policy({ financial: { ...defaults.rules.financial, selfApproval: "denied" } });
  const d = proposal({
    capabilityId: "ads.budget.change",
    credits: ["10"],
    requestedBy: olivia,
    reviewPolicy: denied,
  });
  assert.equal(
    code(
      one(
        family(d, denied),
        olivia,
        { soloOwnerConfirmation: confirmationPhrase(d) },
        { ownership: owner, currentPolicy: denied },
      ),
    ),
    "SELF_APPROVAL_DENIED",
  );
});

test("AC21: quorum, idempotent replay, command conflicts and duplicate reviewers", () => {
  const two = policy({ external: { ...defaults.rules.external, requiredApprovals: 2 } });
  const p = proposal({ reviewPolicy: two });
  const state = family(p, two);
  assert.equal(state.members[0].approval.requiredApprovals, 2);
  const leo = attempt(state, human("leo"), {}, { currentPolicy: two });
  const first = fold(state, leo);
  assert.equal(first.results[0].status, "pending");
  assert.deepEqual(first.results[0].transitions, []);
  const s = first.state;
  assert.equal(s.revision, 2);
  // A replay of (commandId, requestDigest) returns the recorded result and changes nothing.
  const replay = fold(s, leo);
  assert.deepEqual(replay.results[0], first.results[0]);
  assert.deepEqual(replay.state, s);
  assert.equal(
    fold(s, { ...leo, requestDigest: "e".repeat(64) }).results[0].code,
    "COMMAND_CONFLICT",
  );
  const again = (reviewer, decision = {}, overrides = {}) =>
    fold(s, attempt(s, reviewer, decision, { currentPolicy: two, ...overrides }));
  assert.equal(again(human("leo")).results[0].code, "DUPLICATE_REVIEWER");
  const ana = again(human("ana"));
  assert.equal(ana.results[0].status, "approved");
  assert.equal(ana.state.members[0].approval.decisions.length, 2);
  assert.equal(ana.state.members[0].approval.effectiveAt, at(0));
  assert.equal(again(human("ana"), { decision: "reject" }).results[0].status, "rejected");
  const stale = attempt(s, human("ana"), {}, { currentPolicy: two });
  stale.input.expectedRevision = 1;
  const staleResult = fold(s, stale).results[0];
  assert.equal(staleResult.code, "STALE_REVISION");
  assert.equal(staleResult.category, "conflict");
  // Folding the ordered attempts at once gives the same state.
  assert.deepEqual(
    fold(state, leo, attempt(s, human("ana"), {}, { currentPolicy: two, commandId: "command_x" }))
      .state.members[0].approval.status,
    "approved",
  );
  // Quorum 3 with two eligible non-conflicted reviewers cannot be met.
  const three = policy({ financial: { ...defaults.rules.financial, requiredApprovals: 3 } });
  const financial = proposal({
    capabilityId: "ads.budget.change",
    credits: ["10"],
    reviewPolicy: three,
  });
  assert.deepEqual(checkProposal(financial, facts(financial, { reviewPolicy: three })), [
    "QUORUM_UNREACHABLE",
  ]);
  assert.deepEqual(
    checkProposal(
      financial,
      facts(financial, {
        reviewPolicy: three,
        eligibleReviewerPrincipalIds: ["human_maya", "human_leo", "human_ana", "human_ben"],
      }),
    ),
    [],
  );
});

test("AC22: reviewer eligibility composes the human evaluator and the rule's reviewer list", async () => {
  // An agent reviewer is schema-invalid.
  const agentAsHuman = { ...agent, kind: "human" };
  assert.equal(validateCurrentDefinition("HumanActorRef", agent), false);
  assert.equal(validateCurrentDefinition("HumanActorRef", agentAsHuman), false);
  const approved = fixture("P01.T02a.approval.approved");
  assert.equal(validateCurrentDefinition("Approval", approved), true);
  assert.equal(validateCurrentDefinition("Approval", { ...approved, reviewer: agent }), false);
  const p = proposal();
  const state = family(p);
  assert.throws(() => fold(state, attempt(state, agent)), ReviewBoundaryError);
  // The human evaluator, bound to Leo's session.
  const leo = human("leo");
  const workspace = {
    ...tenant,
    storeId: null,
    connectionId: null,
    kind: "workspace",
    id: "workspace_a",
  };
  const grant = (id, capabilityId, resources, fields, storeIds) => ({
    id,
    principal: structuredClone(leo),
    capabilityId,
    verbs: ["approve"],
    scope: { ...tenant, storeIds, accountIds: [], resources, fields },
    issuedBy: structuredClone(leo),
    validFrom: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
  });
  const grants = () => [
    grant(
      "grant_decide",
      "governance.approval.decide",
      [workspace],
      ["proposalRef", "decision", "expectedRevision"],
      [],
    ),
    grant(
      "grant_publish",
      p.capabilityId,
      p.targets.map((t) => structuredClone(t.resource)),
      ["title"],
      ["store_a"],
    ),
  ];
  const port = (held) =>
    createHumanPolicyService(
      {
        async readCurrent(request) {
          return {
            actor: structuredClone(leo),
            policyRevision: 1,
            grantsRevision: 1,
            principalActive: true,
            organizationActive: true,
            workspaceActive: true,
            membershipActive: true,
            sessionCurrent: true,
            resource: structuredClone(request.resource),
            accountId: request.accountId,
            providerAllowed: true,
            entitlementAllowed: true,
            grants: held,
          };
        },
      },
      () => new Date("2026-10-18T10:00:00Z"),
    );
  const accounts = p.targets.map(() => null);
  assert.equal(await reviewerEligible(port(grants()), p, null, accounts), true);
  assert.equal(await reviewerEligible(port(grants()), p, [0, 1], accounts), true);
  assert.equal(await reviewerEligible(port(grants().slice(1)), p, null, accounts), false);
  const noApprove = grants();
  noApprove[0].verbs = ["view"];
  assert.equal(await reviewerEligible(port(noApprove), p, null, accounts), false);
  // A proposal whose targets need a field the approve grant does not cover.
  const twoFields = proposal({ fields: ["title", "body_html"] });
  assert.equal(await reviewerEligible(port(grants()), twoFields, null, accounts), false);
  // The fold denies an ineligible reviewer and one outside the rule's list.
  assert.equal(code(one(state, leo, {}, { reviewerEligible: false })), "REVIEWER_DENIED");
  const listed = policy({
    external: { ...defaults.rules.external, eligibleReviewerPrincipalIds: ["human_ana"] },
  });
  const narrowed = proposal({ reviewPolicy: listed });
  const narrowedState = family(narrowed, listed);
  assert.equal(code(one(narrowedState, leo, {}, { currentPolicy: listed })), "REVIEWER_DENIED");
  assert.equal(code(one(narrowedState, human("ana"), {}, { currentPolicy: listed })), "approved");
  assert.equal(code(one(state, human("zoe", { workspaceId: "workspace_b" }))), "REVIEWER_DENIED");
  // An empty reviewer list is schema-invalid; null applies no narrowing.
  assert.equal(
    validateCurrentDefinition("ReviewRule", {
      ...defaults.rules.external,
      eligibleReviewerPrincipalIds: [],
    }),
    false,
  );
});

test("AC23: review policy shape, defaults and the effective rule", () => {
  const rules = structuredClone(defaults.rules);
  assert.equal(validateCurrentDefinition("ReviewPolicyRules", rules), true);
  assert.equal(validateCurrentDefinition("ReviewPolicy", policy()), true);
  const invalid = [
    { ...rules, internal: { ...rules.internal, requiredApprovals: 0 } },
    { ...rules, internal: { ...rules.internal, requiredApprovals: 6 } },
    { ...rules, external: { ...rules.external, pendingExpirySeconds: 299 } },
    (({ financial: _, ...rest }) => rest)(rules),
    { ...rules, spend: rules.financial },
    { ...rules, financial: { ...rules.financial, selfApproval: "allowed" } },
  ];
  for (const value of invalid)
    assert.equal(
      validateCurrentDefinition("ReviewPolicyRules", value),
      false,
      JSON.stringify(value).slice(0, 80),
    );
  assert.equal(
    validateCurrentDefinition("ReviewPolicy", { ...policy(), storeId: "store_a" }),
    false,
  );
  for (const id of ["P01.T02a.policy.defaults", "P01.T02a.policy.store_scoped"])
    assert.equal(checkFixture(fixtures.find((f) => f.id === id)), true, id);
  // The defaults table (ADR-0011 Q3).
  assert.deepEqual(effectiveRule(rules, "internal", false), {
    requiredApprovals: 1,
    selfApproval: "allowed",
    pendingExpirySeconds: 604800,
    approvedValiditySeconds: 86400,
    eligibleReviewerPrincipalIds: null,
  });
  // For an irreversible external proposal every field takes the stricter value.
  const merged = {
    ...rules,
    external: {
      requiredApprovals: 1,
      selfApproval: "allowed",
      pendingExpirySeconds: 3600,
      approvedValiditySeconds: 86400,
      eligibleReviewerPrincipalIds: ["human_ana", "human_ben", "human_leo"],
    },
    irreversible: {
      requiredApprovals: 2,
      selfApproval: "solo_owner_typed_confirmation",
      pendingExpirySeconds: 86400,
      approvedValiditySeconds: 3600,
      eligibleReviewerPrincipalIds: ["human_leo", "human_ana", "human_zoe"],
    },
  };
  assert.deepEqual(effectiveRule(merged, "external", true), {
    requiredApprovals: 2,
    selfApproval: "solo_owner_typed_confirmation",
    pendingExpirySeconds: 3600,
    approvedValiditySeconds: 3600,
    eligibleReviewerPrincipalIds: ["human_ana", "human_leo"],
  });
  assert.deepEqual(effectiveRule(merged, "external", false), merged.external);
  assert.equal(
    effectiveRule(
      { ...merged, external: { ...merged.external, selfApproval: "denied" } },
      "external",
      true,
    ).selfApproval,
    "denied",
  );
  // The irreversible overlay applies through the catalogue flag: orders.cancel is external and irreversible.
  const cancelOrder = proposal({
    capabilityId: "orders.cancel",
    credits: ["1"],
    requestedBy: human("maya"),
  });
  assert.equal(cancelOrder.risk, "external");
  assert.equal(code(one(family(cancelOrder), human("maya"))), "SELF_APPROVAL_DENIED");
  // A policy revision makes a pending approval, and an approved one at dispatch, stale.
  const p = proposal();
  const state = family(p);
  const revised = policy({}, 2);
  assert.equal(
    code(one(state, human("leo"), {}, { currentPolicy: revised })),
    "REVIEW_POLICY_NOT_CURRENT",
  );
  const approved = one(state, human("leo"));
  assert.equal(
    dispatchCheck(approved.state, { now: at(1), currentPolicy: revised, ownership: team() }),
    "REVIEW_POLICY_NOT_CURRENT",
  );
  assert.deepEqual(reviewPolicyRef(policy()), policyRef(policy()));
});

test("AC24: pending and approved expiry take the earlier deadline; dispatch at expiresAt is expired", () => {
  const pol = policy();
  const later = proposal({ expiresAt: "2026-11-30T00:00:00Z" });
  // External: pending 72 h, approved 24 h.
  assert.equal(
    pendingApproval(later, pol, { id: "approval_a", createdAt: T0, policyRevision: 1 }).expiresAt,
    plus(T0, 259200),
  );
  const sooner = proposal({ expiresAt: "2026-10-19T00:00:00Z" });
  assert.equal(
    pendingApproval(sooner, pol, { id: "approval_a", createdAt: T0, policyRevision: 1 }).expiresAt,
    "2026-10-19T00:00:00Z",
  );
  const approvedLater = one(family(later), human("leo"));
  const a = approvedLater.state.members[0].approval;
  assert.equal(a.expiresAt, plus(a.effectiveAt, 86400));
  const approvedSooner = one(family(sooner), human("leo"));
  assert.equal(approvedSooner.state.members[0].approval.expiresAt, "2026-10-19T00:00:00Z");
  const dispatch = (state, now) =>
    dispatchCheck(state, { now, currentPolicy: pol, ownership: team() });
  assert.equal(dispatch(approvedLater.state, a.expiresAt), "APPROVAL_EXPIRED");
  assert.equal(dispatch(approvedLater.state, plus(a.expiresAt, -1)), "ok");
  assert.equal(dispatch(family(later), at(1)), "NOT_APPROVED");
  // A decision at or after the pending deadline is expired.
  const pending = family(later).members[0].approval;
  const late = one(family(later), human("leo"), {}, { at: pending.expiresAt });
  assert.equal(code(late), "APPROVAL_EXPIRED");
  assert.equal(late.result.category, "approval_expired");
  // A derived approval shares the root approval's pending window.
  const pair = previewSelection(later, [0, 1]).proposal;
  const derived = one(
    family(later),
    human("leo"),
    { selectedTargetIndexes: [0, 1], expectedDecisionDigest: pair.proposalDigest },
    { at: pending.expiresAt },
  );
  assert.equal(code(derived), "APPROVAL_EXPIRED");
});

test("decision inputs: cancel takes no selection or phrase, and rejection is whole", () => {
  const decision = {
    decision: "cancel_before_effective",
    selectedTargetIndexes: [0],
    expectedDecisionDigest: "a".repeat(64),
    soloOwnerConfirmation: null,
    comment: null,
  };
  assert.equal(validateCurrentDefinition("ReviewDecisionInput", decision), false);
  assert.equal(
    validateCurrentDefinition("ReviewDecisionInput", { ...decision, selectedTargetIndexes: null }),
    true,
  );
  assert.equal(
    validateCurrentDefinition("ReviewDecisionInput", {
      ...decision,
      selectedTargetIndexes: null,
      soloOwnerConfirmation: "x",
    }),
    false,
  );
  const p = proposal();
  const state = family(p);
  assert.equal(
    code(one(state, human("leo"), { decision: "reject", selectedTargetIndexes: [0] })),
    "SELECTION_INVALID",
  );
  assert.equal(
    code(one(state, human("leo"), { decision: "reject", soloOwnerConfirmation: "approve" })),
    "CONFIRMATION_MISMATCH",
  );
  // A non-conflicted reviewer never types a phrase.
  assert.equal(
    code(one(state, human("leo"), { soloOwnerConfirmation: confirmationPhrase(p) })),
    "CONFIRMATION_MISMATCH",
  );
  // The v1 DecisionRef body is replaced.
  assert.equal(
    validateCapabilityInput("governance.approval.decide", {
      proposalRef: ref(p),
      decision: { ...ref(p), kind: "decision" },
      expectedRevision: 1,
    }),
    false,
  );
  const rejected = one(state, human("leo"), { decision: "reject" });
  assert.equal(code(rejected), "rejected");
  assert.equal(code(one(rejected.state, human("ana"))), "APPROVAL_NOT_PENDING");
  // Errors map to existence-free envelopes (§7 item 13).
  assert.deepEqual(reviewError("SELF_APPROVAL_DENIED"), {
    category: "denied",
    retry: "never",
    safeMessage: "This review action is not permitted.",
  });
  assert.equal(reviewError("FAMILY_CONFLICT").category, "conflict");
  assert.equal(reviewError("REVIEW_POLICY_NOT_CURRENT").retry, "recheck_before_retry");
  assert.equal(reviewError("APPROVAL_EXPIRED").category, "approval_expired");
  // Trusted state is self-consistent: a forged derived member is refused.
  const forged = structuredClone(state);
  const pair = previewSelection(p, [0, 1]).proposal;
  forged.members.push({
    proposal: seal({
      ...pair,
      maximumCredits: "1",
      targets: pair.targets.map((t) => ({ ...t, maximumCredits: "0" })),
    }),
    approval: { ...state.members[0].approval, id: "approval_forged" },
  });
  assert.throws(() => foldDecisions(forged, []), ReviewBoundaryError);
});

test("AC25: transition rows are versioned and every emitted transition exists at v1.1", () => {
  const row = (to, actor, guard) => ({
    aggregate: "approval",
    from: "pending",
    to,
    actor,
    guard,
    guardPassed: true,
  });
  const old = row("approved", "eligible_human_reviewer", "exact_digest_scope_and_current_policy");
  assert.equal(inspectTransition(old, "1.1"), false);
  assert.equal(inspectTransition(old, "1"), true);
  assert.equal(
    inspectTransition(
      row("rejected", "eligible_human_reviewer", "exact_digest_scope_and_current_policy"),
      "1.1",
    ),
    false,
  );
  const quorum = row(
    "approved",
    "eligible_human_reviewer",
    "quorum_met_exact_digest_scope_and_current_policy",
  );
  assert.equal(inspectTransition(quorum, "1.1"), true);
  assert.equal(inspectTransition(quorum, "1"), false);
  assert.equal(inspectTransition(quorum), true);
  for (const from of ["draft", "ready"]) {
    const cancel = {
      aggregate: "task",
      from,
      to: "cancelled",
      actor: "owner",
      guard: "no_dispatch",
      capability: "workspace.task.cancel",
      guardPassed: true,
    };
    assert.equal(inspectTransition(cancel, "1.1"), true);
    assert.equal(inspectTransition(cancel, "1"), false);
    assert.equal(
      inspectTransition({ ...cancel, capability: "workspace.task.create" }, "1.1"),
      false,
    );
  }
  assert.ok(emitted.length > 0);
  for (const t of emitted)
    assert.equal(inspectTransition({ ...t, guardPassed: true }, "1.1"), true, JSON.stringify(t));
  assert.deepEqual(
    [...new Set(emitted.map((t) => `${t.from}>${t.to}:${t.actor}:${t.guard}`))].sort(),
    [
      "approved>cancelled:solo_owner:before_effective_at",
      "pending>approved:eligible_human_reviewer:quorum_met_exact_digest_scope_and_current_policy",
      "pending>approved:solo_owner:typed_confirmation_recorded_cool_down_scheduled",
      "pending>invalidated:work_service:superseded_by_partial_approval",
      "pending>rejected:eligible_human_reviewer:eligible_rejection_exact_digest_and_current_policy",
    ],
  );
});
