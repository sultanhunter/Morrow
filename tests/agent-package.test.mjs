// PR 10: AgentPackage@1 and SkillManifest@1 (ADR-0023 decisions 6 and 11d) and the package
// checks CI and install run: tools by kind, capabilities asked for, Support's customer data,
// no customer reads with the computer, pinned skills that add no tool, offered model entries.
import assert from "node:assert/strict";
import test from "node:test";
import { inspectAgentPackage, skillDigest } from "../packages/policy/src/agent-package.ts";
import {
  fakeListingsPackage,
  fakeSkillManifest,
} from "../packages/policy/src/agent-platform-fakes.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";

const skill = fakeSkillManifest();
const pinned = () => {
  const pkg = structuredClone(fakeListingsPackage());
  pkg.skills = [{ id: skill.id, digest: skillDigest(skill) }];
  return pkg;
};
const check = (pkg, skills = [skill]) => inspectAgentPackage(pkg, skills, 2);
const changed = (change) => {
  const pkg = pinned();
  change(pkg);
  return pkg;
};

test("the Listings package and its skill pass", () => {
  assert.ok(validateCurrentDefinition("SkillManifest", skill));
  assert.ok(validateCurrentDefinition("AgentPackage", fakeListingsPackage()));
  assert.deepEqual(check(pinned()), []);
});

for (const [name, change, expected] of [
  ["a coordination tool", (p) => p.tools.push("agent.route"), "TOOL_NOT_FOR_KIND"],
  ["the built-in specialist id", (p) => (p.id = "morrow.specialist"), "PACKAGE_ID_KIND_MISMATCH"],
  [
    "a tool whose capability it does not ask for",
    (p) =>
      (p.capabilities = p.capabilities.filter((c) => c.capabilityId !== "catalog.products.read")),
    "TOOL_CAPABILITY_NOT_REQUESTED",
  ],
  [
    "an unknown capability",
    (p) => p.capabilities.push({ capabilityId: "shop.everything.do", verbs: ["execute"] }),
    "CAPABILITY_UNKNOWN",
  ],
  [
    "a capability twice",
    // An identical row already fails the schema's uniqueness; a second row with other verbs
    // is the code's check.
    (p) =>
      p.capabilities.push({ capabilityId: "catalog.products.read", verbs: ["view", "propose"] }),
    "CAPABILITY_REPEATED",
  ],
  [
    "executing a human_only stop",
    (p) => p.capabilities.push({ capabilityId: "agents.installation.disable", verbs: ["execute"] }),
    "HUMAN_ONLY_REQUESTED",
  ],
  [
    "support capabilities outside Support",
    (p) => p.capabilities.push({ capabilityId: "support.case.read", verbs: ["view"] }),
    "SUPPORT_OUTSIDE_SUPPORT",
  ],
  [
    "Level 2 outside Support",
    (p) => {
      p.customerData = "level2";
      p.optionalScopes.push("read_orders");
    },
    "LEVEL2_OUTSIDE_SUPPORT",
  ],
  [
    "order reads without read_orders",
    (p) => p.capabilities.push({ capabilityId: "orders.read", verbs: ["view"] }),
    "ORDERS_WITHOUT_SCOPE",
  ],
  ["a missing skill.json", (p) => (p.skills[0].id = "brand-voice"), "SKILL_MANIFEST_MISSING"],
  ["an edited skill", (p) => (p.skills[0].digest = "b".repeat(64)), "SKILL_DIGEST_MISMATCH"],
  [
    "an offered entry outside the catalogue",
    (p) => p.offeredProfiles.push({ model: "claude_opus_5_5", effort: "xhigh" }),
    "PROFILE_NOT_IN_CATALOGUE",
  ],
  [
    "a default it does not offer",
    (p) => (p.defaultProfile = { model: "claude_opus_5_5", effort: "high" }),
    "PROFILE_DEFAULT_NOT_OFFERED",
  ],
  [
    "no installed-agent default on offer",
    (p) => {
      p.offeredProfiles = p.offeredProfiles.filter((s) => s.model !== "claude_sonnet_5_5");
      p.defaultProfile = { model: "claude_haiku_5_5", effort: "low" };
    },
    "KIND_DEFAULT_NOT_OFFERED",
  ],
])
  test(`a package is refused for ${name}`, () =>
    assert.ok(check(changed(change)).includes(expected), JSON.stringify(check(changed(change)))));

test("a skill never adds a tool the package does not declare", () => {
  const wider = { ...skill, tools: [...skill.tools, "inventory.read"] };
  const pkg = pinned();
  pkg.skills = [{ id: wider.id, digest: skillDigest(wider) }];
  assert.deepEqual(check(pkg, [wider]), ["SKILL_ADDS_TOOL"]);
});

test("Support may hold support.* and Level 2, never with the computer", () => {
  const support = changed((p) => {
    p.id = "morrow.support";
    p.tools = ["work.read", "support.thread.read", "message.post", "proposal.reply"];
    p.capabilities = [
      { capabilityId: "workspace.artifact.read", verbs: ["view"] },
      { capabilityId: "support.case.read", verbs: ["view"] },
      { capabilityId: "workspace.conversation.post", verbs: ["execute"] },
      { capabilityId: "support.reply.propose", verbs: ["execute"] },
      { capabilityId: "support.reply.send", verbs: ["propose"] },
    ];
    p.skills = [];
    p.optionalScopes = ["read_orders", "read_customers", "read_returns"];
    p.triggerKinds = ["inbound_mail"];
    p.customerData = "level2";
  });
  assert.deepEqual(check(support), []);
  // Level 2 with the computer fails the schema itself; support.case.read with it fails the check.
  assert.deepEqual(check({ ...support, computer: true }), ["PACKAGE_INVALID"]);
  assert.ok(
    check({ ...support, customerData: "level1", computer: true }).includes(
      "CUSTOMER_READS_WITH_COMPUTER",
    ),
  );
});

test("built-in kinds: the Coordinator holds exactly its tools; neither built-in has triggers or scopes", () => {
  const coordinator = changed((p) => {
    p.id = "morrow.coordinator";
    p.kind = "coordinator";
    p.skills = [];
    p.optionalScopes = [];
    p.triggerKinds = [];
    p.tools = [
      "knowledge.search",
      "work.read",
      "message.post",
      "inbox.ask",
      "task.create",
      "agent.route",
      "specialist.draft",
    ];
    p.capabilities = [
      { capabilityId: "workspace.knowledge.read", verbs: ["view"] },
      { capabilityId: "workspace.artifact.read", verbs: ["view"] },
      { capabilityId: "workspace.conversation.post", verbs: ["execute"] },
      { capabilityId: "workspace.question.request", verbs: ["execute"] },
      { capabilityId: "workspace.task.create", verbs: ["execute"] },
      { capabilityId: "workspace.task.delegate", verbs: ["delegate"] },
      { capabilityId: "agents.builder.describe", verbs: ["execute"] },
    ];
    p.offeredProfiles = [{ model: "claude_opus_5_5", effort: "high" }];
    p.defaultProfile = { model: "claude_opus_5_5", effort: "high" };
  });
  assert.deepEqual(check(coordinator), []);
  assert.ok(
    check({ ...coordinator, tools: coordinator.tools.slice(1) }).includes(
      "COORDINATOR_TOOLS_NOT_FIXED",
    ),
  );
  assert.deepEqual(check({ ...coordinator, triggerKinds: ["schedule"] }), ["PACKAGE_INVALID"]);
  assert.deepEqual(check({ ...coordinator, computer: true }), ["PACKAGE_INVALID"]);
  const specialist = { ...coordinator, id: "morrow.specialist", kind: "specialist" };
  assert.deepEqual(check({ ...specialist, optionalScopes: ["read_orders"] }), ["PACKAGE_INVALID"]);
  assert.ok(check(specialist).includes("TOOL_NOT_FOR_KIND"), "no task.create or route");
});
