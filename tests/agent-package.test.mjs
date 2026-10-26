// PR 10: AgentPackage@1 and SkillManifest@1 (ADR-0023 decisions 6 and 11d) and the package
// checks CI and install run: tools by kind, capabilities asked for, Support's customer data,
// no customer reads with the computer, pinned skills that add no tool, offered model entries.
// ADR-0037 PR 2: one kind with two origins (a workspace package carries its instructions and
// skill text), depth 1 (no agent.*, delegation or agents.* outside the Coordinator) and item
// 5's exclusions for workspace packages; the specialist kind retired. Review F1 and F3: a
// workspace package asks for exactly the grants its tools derive, its roleTextDigest binds its
// instructions and skill text, and it pins only skills eligible for workspace agents.
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalDigest } from "../packages/policy/src/review.ts";
import { inspectAgentPackage, skillDigest } from "../packages/policy/src/agent-package.ts";
import {
  fakeListingsPackage,
  fakeSkillManifest,
  fakeWorkspacePackage,
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
  // ADR-0037 item 2: depth 1. A teammate never holds an agent.* tool, delegation or agents.*.
  ["a teammate call", (p) => p.tools.push("agent.ask"), "AGENT_AUTHORITY_OUTSIDE_COORDINATOR"],
  [
    "guidance to a teammate",
    (p) => p.tools.push("agent.message"),
    "AGENT_AUTHORITY_OUTSIDE_COORDINATOR",
  ],
  [
    "a batch of teammate calls",
    (p) => p.tools.push("agent.map"),
    "AGENT_AUTHORITY_OUTSIDE_COORDINATOR",
  ],
  // ADR-0041 item 24: a memory or harness tool is the context's to offer, never declared.
  ["a declared completion tool", (p) => p.tools.push("run.complete"), "TOOL_NOT_FOR_KIND"],
  ["a declared result writer", (p) => p.tools.push("result.write"), "TOOL_NOT_FOR_KIND"],
  ["a declared memory read", (p) => p.tools.push("memory.read"), "TOOL_NOT_FOR_KIND"],
  ["an agent card", (p) => p.tools.push("agent.propose"), "AGENT_AUTHORITY_OUTSIDE_COORDINATOR"],
  [
    "delegation without a tool",
    (p) => p.capabilities.push({ capabilityId: "workspace.task.delegate", verbs: ["delegate"] }),
    "AGENT_AUTHORITY_OUTSIDE_COORDINATOR",
  ],
  [
    "an agents.* capability",
    (p) => p.capabilities.push({ capabilityId: "agents.builder.describe", verbs: ["execute"] }),
    "AGENT_AUTHORITY_OUTSIDE_COORDINATOR",
  ],
  ["the retired specialist id", (p) => (p.id = "morrow.specialist"), "PACKAGE_ID_KIND_MISMATCH"],
  ["a workspace id", (p) => (p.id = "workspace.listings"), "PACKAGE_ID_ORIGIN_MISMATCH"],
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
    // ADR-0036: the installed agents' default is Opus 5.5 at medium.
    (p) => {
      p.offeredProfiles = p.offeredProfiles.filter((s) => s.model !== "claude_opus_5_5");
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
      "agent.ask",
      "agent.map",
      "agent.message",
      "agent.cancel",
      "agent.propose",
      "plan.draft",
      "knowledge.propose",
    ];
    p.capabilities = [
      { capabilityId: "workspace.knowledge.read", verbs: ["view"] },
      { capabilityId: "workspace.knowledge.propose", verbs: ["execute"] },
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
  // Its memory and harness tools come with its context (ADR-0041 item 24), never declared.
  assert.ok(
    check({ ...coordinator, tools: [...coordinator.tools, "run.plan"] }).includes(
      "TOOL_NOT_FOR_KIND",
    ),
  );
  assert.deepEqual(check({ ...coordinator, triggerKinds: ["schedule"] }), ["PACKAGE_INVALID"]);
  assert.deepEqual(check({ ...coordinator, computer: true }), ["PACKAGE_INVALID"]);
  // The specialist kind retired with ADR-0037; a workspace Coordinator fails the schema.
  assert.deepEqual(check({ ...coordinator, id: "morrow.specialist", kind: "specialist" }), [
    "PACKAGE_INVALID",
  ]);
  assert.deepEqual(check({ ...coordinator, origin: "workspace" }), ["PACKAGE_INVALID"]);
});

// ADR-0037 items 4 and 5: a workspace package, as an approved card becomes.
const workspace = () => {
  const pkg = structuredClone(fakeWorkspacePackage());
  pkg.roleTextDigest = canonicalDigest({
    instructions: pkg.instructions,
    skillTexts: pkg.skillTexts,
  });
  return pkg;
};
const workspaceChanged = (change) => {
  const pkg = workspace();
  change(pkg);
  return pkg;
};
test("ADR-0037 item 4: a workspace package passes with its role text's digest and one offered model", () => {
  assert.ok(validateCurrentDefinition("AgentPackage", workspace()));
  assert.deepEqual(inspectAgentPackage(workspace(), [], 2), []);
  // Its model is the workspace's default for new teammates, even when that is not the kind's.
  assert.deepEqual(
    inspectAgentPackage(
      workspaceChanged((p) => {
        p.offeredProfiles = [{ model: "claude_sonnet_5_5", effort: "low" }];
        p.defaultProfile = { model: "claude_sonnet_5_5", effort: "low" };
      }),
      [],
      2,
    ),
    [],
  );
});
for (const [name, change, expected] of [
  [
    "edited instructions",
    (p) => (p.instructions += " Also change prices."),
    "ROLE_TEXT_DIGEST_MISMATCH",
  ],
  // Review F3: skill text is bound too; a change or an addition after approval fails.
  [
    "edited skill text",
    (p) => (p.skillTexts[0].body += " Also change prices."),
    "ROLE_TEXT_DIGEST_MISMATCH",
  ],
  [
    "added skill text",
    (p) => p.skillTexts.push({ title: "Prices", body: "Lower every price by half." }),
    "ROLE_TEXT_DIGEST_MISMATCH",
  ],
  [
    "the instructions' digest alone",
    (p) => (p.roleTextDigest = canonicalDigest(p.instructions)),
    "ROLE_TEXT_DIGEST_MISMATCH",
  ],
  // Review F1: exactly the grants the tools derive (item 4), no wider.
  [
    "a scope no tool needs (read_customers)",
    (p) => p.optionalScopes.push("read_customers"),
    "WORKSPACE_GRANTS_NOT_DERIVED",
  ],
  [
    "a capability no tool needs",
    (p) => p.capabilities.push({ capabilityId: "catalog.products.read", verbs: ["view"] }),
    "WORKSPACE_GRANTS_NOT_DERIVED",
  ],
  [
    "a verb no tool needs",
    (p) =>
      (p.capabilities.find((c) => c.capabilityId === "inventory.levels.read").verbs = [
        "view",
        "propose",
      ]),
    "WORKSPACE_GRANTS_NOT_DERIVED",
  ],
  [
    "a customer-data level no tool needs",
    (p) => {
      p.tools = p.tools.filter((t) => t !== "orders.summary");
      p.capabilities = p.capabilities.filter((c) => c.capabilityId !== "orders.read");
    },
    "WORKSPACE_GRANTS_NOT_DERIVED",
  ],
  [
    "the computer with no computer tool",
    (p) => (p.computer = true),
    "WORKSPACE_GRANTS_NOT_DERIVED",
  ],
  [
    // ADR-0041 item 24: a called teammate needs no declared tool to return its result.
    "a declared harness tool",
    (p) => p.tools.push("result.write"),
    "TOOL_NOT_FOR_KIND",
  ],
  ["a first-party id", (p) => (p.id = "morrow.restock"), "PACKAGE_ID_ORIGIN_MISMATCH"],
  [
    "a human_only capability, even to propose",
    (p) => p.capabilities.push({ capabilityId: "agents.installation.disable", verbs: ["propose"] }),
    "WORKSPACE_EXCLUDED",
  ],
  [
    "support.*",
    (p) => p.capabilities.push({ capabilityId: "support.case.read", verbs: ["view"] }),
    "WORKSPACE_EXCLUDED",
  ],
  ["customer mail as a trigger", (p) => p.triggerKinds.push("inbound_mail"), "WORKSPACE_EXCLUDED"],
  ["a teammate call", (p) => p.tools.push("agent.ask"), "AGENT_AUTHORITY_OUTSIDE_COORDINATOR"],
  [
    "delegation",
    (p) => p.capabilities.push({ capabilityId: "workspace.task.delegate", verbs: ["delegate"] }),
    "AGENT_AUTHORITY_OUTSIDE_COORDINATOR",
  ],
])
  test(`ADR-0037 item 5: a workspace package is refused for ${name}`, () => {
    const codes = inspectAgentPackage(workspaceChanged(change), [], 2);
    assert.ok(codes.includes(expected), JSON.stringify(codes));
  });
