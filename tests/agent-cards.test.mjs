// ADR-0037 PR 2 (docs/briefs/adr-0037-contracts.md): agent cards in code (items 4 and 5).
// Morrow drafts with agent.propose; code derives every grant, scope, data class, limit and the
// model, refuses what no card may hold, keeps the taint through edits, binds the Add to team
// document to the exact digest for 5 minutes, and builds the workspace package an approved card
// becomes. Pure: no database, no provider.
import assert from "node:assert/strict";
import test from "node:test";
import {
  addToTeamDocument,
  addToTeamDocumentLive,
  agentCardDigest,
  cardCapabilityAllowed,
  cardGrantsDerived,
  cardSkillsWithinTools,
  cardToolAllowed,
  cardTriggerKinds,
  deriveCardGrants,
  draftAgentCard,
  heldGrantsDerived,
  reviseAgentCard,
  workspaceAgentLimit,
  workspacePackageFromCard,
  workspaceRoleText,
} from "../packages/policy/src/agent-cards.ts";
import { inspectAgentPackage, skillDigest } from "../packages/policy/src/agent-package.ts";
import {
  fakeAddToTeamDocument,
  fakeAgentProposal,
  fakeAgentProposeInput,
  fakeCardFacts,
  fakeDigest,
  fakeIds,
  fakeOwner,
  fakeSkillManifest,
  fakeTaint,
} from "../packages/policy/src/agent-platform-fakes.ts";
import { canonicalDigest } from "../packages/policy/src/review.ts";
import { toolCatalogue } from "../packages/policy/src/tool-catalogue.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";

const input = () => structuredClone(fakeAgentProposeInput());
const facts = (change = () => {}) => {
  const f = structuredClone(fakeCardFacts());
  change(f);
  return f;
};
const draft = (i = input(), f = facts()) => draftAgentCard(i, f);
const member = () => ({
  ...fakeOwner(),
  principalId: fakeIds.memberPrincipalId,
  membershipId: fakeIds.memberMembershipId,
});

test("Morrow's draft becomes the card the fake shows: code writes every grant, scope and limit", () => {
  const result = draft();
  assert.equal(result.ok, true);
  assert.deepEqual(result.card, fakeAgentProposal());
  assert.ok(validateCurrentDefinition("AgentProposal", result.card));
  assert.ok(Object.isFrozen(result.card) && Object.isFrozen(result.card.capabilities[0].verbs));
  // Order reads: the read_orders scope, level 1 aggregates and the Owner as requester or
  // approver (item 5); the teammate result tool is added so the teammate can be called.
  assert.deepEqual(result.card.optionalScopes, ["read_orders"]);
  assert.equal(result.card.customerData, "level1");
  assert.deepEqual(result.card.ownerOnly, ["orders_or_customer"]);
  assert.ok(result.card.tools.includes("result.submit"));
  // No money anywhere on a card (item 6, ADR-0039).
  assert.doesNotMatch(JSON.stringify(result.card), /usd|credit|cap"|budget|hold/i);
});

test("ADR-0037 item 5: the fixed catalogue only; agent.*, support, delegation and human_only never on a card", () => {
  for (const tool of [
    "agent.route",
    "agent.ask",
    "agent.result.read",
    "agent.propose",
    "plan.draft",
    "support.thread.read",
    "proposal.reply",
    "result.submit",
    "specialist.draft",
    "sql.run",
  ]) {
    assert.equal(cardToolAllowed(tool), false, tool);
    const i = input();
    i.tools.push(tool);
    const result = draft(i);
    assert.equal(result.ok, false, tool);
    assert.ok(["card_tool_excluded", "input_invalid"].includes(result.refusal), tool);
  }
  for (const capability of [
    "workspace.task.delegate",
    "agents.installation.activate",
    "agents.builder.describe",
    "support.case.read",
    "agents.installation.disable",
    "governance.membership.revoke",
    "workspace.project.create",
  ])
    assert.equal(cardCapabilityAllowed(capability), false, capability);
  // Every tool an installed agent may hold, less the exclusions, is allowed.
  const allowed = toolCatalogue.filter((t) => cardToolAllowed(t.name)).map((t) => t.name);
  assert.deepEqual(allowed, [
    "knowledge.search",
    "work.read",
    "products.read",
    "inventory.read",
    "orders.summary",
    "message.post",
    "inbox.ask",
    "task.create",
    "suggestion.create",
    "report.write",
    "proposal.listing",
  ]);
  // Customer mail never arrives by trigger either.
  assert.ok(!cardTriggerKinds.includes("inbound_mail"));
  const mail = input();
  mail.triggerKinds = ["inbound_mail"];
  assert.deepEqual(draft(mail), { ok: false, refusal: "input_invalid" });
  assert.equal(workspaceAgentLimit, 10);
});

test("ADR-0037 item 4: the model never names a capability, scope, store, model or limit", () => {
  for (const [field, value] of [
    ["capabilities", [{ capabilityId: "orders.read", verbs: ["view"] }]],
    ["storeId", "store_other"],
    ["modelProfile", { model: "claude_opus_5_5", effort: "max", catalogueVersion: 2 }],
    ["runLimits", { maxTurns: 16 }],
    ["optionalScopes", ["write_discounts"]],
  ])
    assert.deepEqual(draft({ ...input(), [field]: value }), {
      ok: false,
      refusal: "input_invalid",
    });
  // The store and model are the server's, whatever the text says.
  const text = input();
  text.instructions = "Use store store_other and the model claude_opus_5_5 at max effort.";
  const result = draft(text);
  assert.equal(result.card.storeId, fakeIds.storeId);
  assert.deepEqual(result.card.modelProfile, fakeCardFacts().modelProfile);
});

test("a store change is the Owner's: a proposal tool marks store_effect; grants come from tools alone", () => {
  const grants = deriveCardGrants(["products.read", "proposal.listing"]);
  assert.deepEqual([...grants.tools], ["products.read", "proposal.listing", "result.submit"]);
  assert.deepEqual(
    grants.capabilities.map((c) => [c.capabilityId, [...c.verbs]]),
    [
      ["catalog.content.publish", ["propose"]],
      ["catalog.products.read", ["view"]],
      ["workspace.artifact.edit", ["execute"]],
    ],
  );
  assert.deepEqual([...grants.ownerOnly], ["store_effect"]);
  assert.equal(grants.customerData, "none");
  assert.deepEqual([...grants.optionalScopes], []);
  // report.write and result.submit share one capability: one row, one verb.
  const shared = deriveCardGrants(["report.write"]);
  assert.deepEqual(
    shared.capabilities.map((c) => c.capabilityId),
    ["workspace.artifact.edit"],
  );
  for (const bad of [[], ["products.read", "products.read"], "products.read"])
    assert.throws(() => deriveCardGrants(bad), /input_invalid/);
});

test("skills: only eligible first-party skills by id, pinned by digest, adding no tool", () => {
  const withSkill = input();
  withSkill.skillIds = ["seo-audit"];
  // seo-audit declares tools this card does not pick: a skill never adds a tool.
  assert.deepEqual(draft(withSkill), { ok: false, refusal: "input_invalid" });
  withSkill.tools = ["knowledge.search", "products.read", "report.write", "proposal.listing"];
  const result = draft(withSkill);
  assert.equal(result.ok, true);
  assert.deepEqual(result.card.skills, [
    { id: "seo-audit", digest: fakeDigest("seo-audit skill") },
  ]);
  assert.ok(cardSkillsWithinTools(result.card, fakeCardFacts().skills));
  const unknown = { ...withSkill, skillIds: ["brand-voice"] };
  assert.deepEqual(draft(unknown), { ok: false, refusal: "input_invalid" });
  const ineligible = facts((f) => (f.skills[0].eligibleForWorkspaceAgents = false));
  assert.deepEqual(draft(withSkill, ineligible), { ok: false, refusal: "input_invalid" });
});

test("the digest binds every field; an edit is a new revision that keeps the taint and only narrows", async () => {
  const tainted = draft(
    input(),
    facts((f) => (f.taint = structuredClone(fakeTaint()))),
  ).card;
  const digest = await agentCardDigest(tainted);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(await agentCardDigest(structuredClone(tainted)), digest);
  for (const change of [
    (c) => (c.name = "Restock Watcher"),
    (c) => (c.revision = 2),
    (c) => (c.taint.sources = []),
    (c) => c.tools.pop(),
  ]) {
    const copy = structuredClone(tainted);
    change(copy);
    assert.notEqual(await agentCardDigest(copy), digest);
  }
  const skills = fakeCardFacts().skills;
  const at = "2026-10-26T09:02:00.000Z";
  const edited = reviseAgentCard(
    tainted,
    { name: "Restock Watcher", removeTools: ["orders.summary"], removeTriggerKinds: ["schedule"] },
    member(),
    at,
    skills,
  );
  assert.equal(edited.ok, true);
  assert.equal(edited.card.revision, 2);
  assert.deepEqual(edited.card.editedBy, member());
  assert.deepEqual(edited.card.taint, tainted.taint, "approval or edit never clears taint");
  assert.equal(edited.card.customerData, "none");
  assert.deepEqual(edited.card.ownerOnly, []);
  assert.deepEqual(edited.card.optionalScopes, []);
  assert.ok(!edited.card.capabilities.some((c) => c.capabilityId === "orders.read"));
  assert.deepEqual(edited.card.triggerKinds, []);
  assert.equal(edited.card.revisedAt, "2026-10-26T09:02:00.000Z");
  assert.equal(edited.card.draftedAt, tainted.draftedAt);
  assert.notEqual(await agentCardDigest(edited.card), digest);
  for (const [name, edit] of [
    ["a tool the card lacks", { removeTools: ["products.read"] }],
    ["the result tool", { removeTools: ["result.submit"] }],
    [
      "every picked tool",
      {
        removeTools: ["knowledge.search", "inventory.read", "orders.summary", "suggestion.create"],
      },
    ],
    ["a trigger it lacks", { removeTriggerKinds: ["monitor"] }],
    ["a skill text it lacks", { removeSkillTexts: [3] }],
    ["instructions past the bound", { instructions: "x".repeat(16001) }],
    // There is no edit that adds: an addition is a new card and a new approval (item 4).
    ["an added tool", { addTools: ["products.read"] }],
    ["an added grant", { capabilities: [{ capabilityId: "orders.read", verbs: ["view"] }] }],
    ["a new skill text", { skillTexts: [{ title: "More", body: "Do more." }] }],
    ["a removal list that is not a list", { removeTools: "orders.summary" }],
  ])
    assert.deepEqual(
      reviseAgentCard(tainted, edit, member(), at, skills),
      { ok: false, refusal: "input_invalid" },
      name,
    );
  // Review F5: an editor outside the card's organization or workspace is never recorded
  // (editors join item 5's conflict set), the same tenancy rule as the Add to team document.
  for (const foreign of [
    { ...member(), workspaceId: "ws_other" },
    { ...member(), organizationId: "org_other" },
  ])
    assert.deepEqual(reviseAgentCard(tainted, { name: "Restock Watcher" }, foreign, at, skills), {
      ok: false,
      refusal: "input_invalid",
    });
  // A kept skill still declares only tools the card holds.
  const withSkill = input();
  withSkill.skillIds = ["seo-audit"];
  withSkill.tools = ["knowledge.search", "products.read", "report.write", "proposal.listing"];
  const skilled = draft(withSkill).card;
  assert.deepEqual(
    reviseAgentCard(skilled, { removeTools: ["products.read"] }, member(), at, skills),
    { ok: false, refusal: "input_invalid" },
  );
  const both = reviseAgentCard(
    skilled,
    { removeTools: ["products.read"], removeSkillIds: ["seo-audit"] },
    member(),
    at,
    skills,
  );
  assert.equal(both.ok, true);
  assert.deepEqual(both.card.skills, []);
});

test("Add to team: a document bound to the digest, actor and session, for five minutes", async () => {
  const card = fakeAgentProposal();
  const digest = await agentCardDigest(card);
  const binding = {
    documentId: fakeIds.documentId,
    actor: fakeOwner(),
    sessionDigest: fakeDigest("session"),
    review: "solo_owner_phrase",
    issuedAt: "2026-10-26T09:00:00.000Z",
  };
  const bound = await addToTeamDocument(card, binding);
  // The fake's digest is a placeholder; code computes the card's own (review F2).
  assert.deepEqual({ ...bound, cardDigest: fakeDigest("card") }, fakeAddToTeamDocument());
  assert.equal(bound.cardDigest, digest);
  assert.equal(bound.expiresAt, "2026-10-26T09:05:00.000Z");
  assert.ok(addToTeamDocumentLive(bound, "2026-10-26T09:04:59.999Z"));
  assert.equal(addToTeamDocumentLive(bound, "2026-10-26T09:05:00.000Z"), false);
  assert.equal(addToTeamDocumentLive(bound, "2026-10-26T08:59:59.000Z"), false);
  // A person of another workspace, or an unreadable time, gets no document.
  assert.equal(
    await addToTeamDocument(card, {
      ...binding,
      actor: { ...fakeOwner(), workspaceId: "ws_other" },
    }),
    null,
  );
  assert.equal(await addToTeamDocument(card, { ...binding, issuedAt: "soon" }), null);
  // The tainted card's document shows the taint above Add to team, under its own digest: the
  // binding and the grants it lists come from one card and cannot drift apart (review F2).
  const tainted = draft(
    input(),
    facts((f) => (f.taint = structuredClone(fakeTaint()))),
  ).card;
  const taintedDocument = await addToTeamDocument(tainted, binding);
  assert.deepEqual(taintedDocument.taint, fakeTaint());
  assert.equal(taintedDocument.cardDigest, await agentCardDigest(tainted));
  assert.notEqual(taintedDocument.cardDigest, digest);
  // A card whose grants are not those its tools derive, or outside AgentProposal@1, gets none.
  for (const change of [
    (c) => c.capabilities.push({ capabilityId: "catalog.products.read", verbs: ["view"] }),
    (c) => c.optionalScopes.push("read_customers"),
    (c) => (c.ownerOnly = []),
    (c) => (c.dataClasses = ["inventory.levels.read"]),
    (c) => (c.customerData = "none"),
  ]) {
    const widened = structuredClone(card);
    change(widened);
    assert.equal(cardGrantsDerived(widened), false);
    assert.equal(await addToTeamDocument(widened, binding), null);
  }
  assert.ok(cardGrantsDerived(card));
  assert.equal(await addToTeamDocument({ ...structuredClone(card), cardId: "" }, binding), null);
});

test("an approved card becomes a workspace package that passes the package checks", async () => {
  const card = fakeAgentProposal();
  const pkg = await workspacePackageFromCard(card, "workspace.restock_watch");
  assert.ok(validateCurrentDefinition("AgentPackage", pkg));
  assert.equal(pkg.origin, "workspace");
  // Review F3: the digest binds the instructions and the skill text.
  assert.equal(pkg.roleTextDigest, canonicalDigest(workspaceRoleText(card)));
  assert.equal(
    pkg.roleTextDigest,
    canonicalDigest({ instructions: card.instructions, skillTexts: card.skillTexts }),
  );
  assert.equal(pkg.evalDigest, null);
  assert.deepEqual(inspectAgentPackage(pkg, [], 2), []);
  assert.equal(heldGrantsDerived(pkg), "ok");
  for (const id of ["morrow.restock", "workspace.", "workspace.Restock", "store_fake"])
    assert.equal(await workspacePackageFromCard(card, id), null, id);
  const widened = structuredClone(card);
  widened.optionalScopes.push("read_customers");
  assert.equal(await workspacePackageFromCard(widened, "workspace.restock_watch"), null);
});

test("review F3: a workspace package pins only skills eligible for workspace agents", async () => {
  const eligible = fakeSkillManifest();
  const ineligible = { ...structuredClone(eligible), eligibleForWorkspaceAgents: false };
  const withSkill = input();
  withSkill.skillIds = ["seo-audit"];
  withSkill.tools = ["knowledge.search", "products.read", "report.write", "proposal.listing"];
  for (const [manifest, expected] of [
    [eligible, []],
    [ineligible, ["SKILL_NOT_FOR_WORKSPACE"]],
  ]) {
    // The server's facts pin the manifest's digest; an ineligible skill.json still fails the
    // package check even when stale facts let a card pick it.
    const pinnedFacts = facts((f) => (f.skills[0].digest = skillDigest(manifest)));
    const card = draft(structuredClone(withSkill), pinnedFacts).card;
    const pkg = await workspacePackageFromCard(card, "workspace.seo_watch");
    assert.deepEqual(inspectAgentPackage(pkg, [manifest], 2), expected);
  }
});
