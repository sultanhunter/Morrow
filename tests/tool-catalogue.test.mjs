// PR 10: ToolCatalogue@1 (ADR-0027 items 2, 3 and 8) and the committed-off agent switches
// (ADR-0027 item 11); ADR-0037 PR 2 and plan row H5 (ADR-0041 item 24): catalogue version 4
// (Morrow's orchestration tools agent.ask, agent.map, agent.message, agent.cancel, agent.route
// and agent.propose for Morrow only; structured briefs without a character cap; the call
// context; the memory tools memory.search, memory.read and memory.suggest and the harness tools
// run.plan, run.complete, run.wait, result.write and context.checkpoint, which hold no
// capability and are offered by context) and the teammate-call and agent-card switches, with
// the Specialist ceiling and its switch retired. The safety tests of the build order's PR 10:
// no tool takes SQL, a URL, a store, a recipient, a credential or a model; validators are
// generated ahead of time; the old formats stay unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  cardToolsException,
  coordinatorToolNames,
  everyContextToolNames,
  forbiddenInputName,
  generateAgentPlatform,
  generatedToolCataloguePath,
  inspectAgentPlatformSwitches,
  inspectToolCatalogue,
  jcs,
  strictModelSchema,
  teammateItemToolName,
  toolModelInputName,
} from "../scripts/generate-agent-platform.mjs";
import {
  checkToolInput,
  completionTool,
  contextToolsForContext,
  grantToolsForContext,
  isContextTool,
  modelToolDefinitions,
  offeredTools,
  isAgentTool,
  runContext,
  teammateItemTool,
  toolByWireName,
  toolCatalogue,
  toolCatalogueDigest,
  toolCatalogueVersion,
  toolEntry,
  ToolCatalogueError,
  toolsForContext,
} from "../packages/policy/src/tool-catalogue.ts";
import {
  fakeIds,
  fakeListingsPackage,
  fakeMemoryReadInput,
  fakeTeammateBriefInput,
} from "../packages/policy/src/agent-platform-fakes.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const catalogue = read("docs/contracts/tool-catalogue.json");
const capabilities = read("docs/contracts/capabilities.json").capabilities;
const schemas = [
  read("docs/contracts/schemas/v1/core.schema.json"),
  read("docs/contracts/schemas/v1.1/core.schema.json"),
];
const validate = (value) => validateCurrentDefinition("ToolCatalogue", value);
const inspect = (c = catalogue, s = schemas) =>
  inspectToolCatalogue({ catalogue: c, capabilities, schemas: s, validate });
const switches = () => [
  read("docs/decisions/agent-loop-staging.json"),
  read("docs/decisions/teammate-calls-staging.json"),
  read("docs/decisions/agent-cards-staging.json"),
];
const tool = (c, name) => c.tools.find((t) => t.name === name);

test("the generator reproduces the committed modules, which are data only", async () => {
  const first = await generateAgentPlatform();
  const second = await generateAgentPlatform();
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first), [generatedToolCataloguePath]);
  for (const path of [generatedToolCataloguePath]) {
    assert.equal(readFileSync(path, "utf8"), first[path], path);
    assert.doesNotMatch(first[path], /\bimport\b|\bfunction\b|=>|\beval\b|new Function/);
  }
});

test("the committed catalogue and switches inspect clean; the specialist files are gone", () => {
  assert.deepEqual(inspect(), []);
  assert.deepEqual(inspectAgentPlatformSwitches(...switches()), []);
  assert.ok(validate(catalogue));
  // Version 3 is PR 20's (knowledge.propose and notebook.write); ADR-0037's tools are version 4.
  assert.equal(catalogue.version, 4);
  for (const path of [
    "docs/contracts/specialist-ceiling.json",
    "docs/decisions/specialists-staging.json",
    "packages/policy/src/generated/specialist-ceiling.ts",
  ])
    assert.equal(existsSync(path), false, path);
});

test("the digest a run manifest pins is sha256 of the RFC 8785 text of the catalogue", () => {
  const content = JSON.parse(
    JSON.stringify({ schemaVersion: 1, version: toolCatalogueVersion, tools: toolCatalogue }),
  );
  assert.equal(createHash("sha256").update(jcs(content)).digest("hex"), toolCatalogueDigest);
  // Any change to a tool moves the digest.
  content.tools[0].description += " ";
  assert.notEqual(createHash("sha256").update(jcs(content)).digest("hex"), toolCatalogueDigest);
});

// The forbidden fields (ADR-0027 item 3), each added to a real tool's input in turn.
for (const field of [
  "sql",
  "query",
  "url",
  "href",
  "domain",
  "role",
  "storeId",
  "shop",
  "workspaceId",
  "recipient",
  "to",
  "bcc",
  "sender",
  "senderIdentityId",
  "email",
  "credential",
  "token",
  "apiKey",
  "model",
  "effort",
  "capabilityId",
  "scope",
  "tools",
])
  test(`a tool input that takes ${field} is refused`, () => {
    assert.ok(forbiddenInputName.test(field), field);
    const s = structuredClone(schemas);
    const def = s[1].$defs.ToolInputMessagePost;
    def.properties[field] = { type: "string" };
    def.required.push(field);
    assert.match(inspect(catalogue, s).join("\n"), /message\.post: input takes a forbidden field/);
  });

test("a tool input that takes a URL by format is refused", () => {
  const s = structuredClone(schemas);
  const def = s[1].$defs.ToolInputMessagePost;
  def.properties.body = { type: "string", format: "uri" };
  assert.match(inspect(catalogue, s).join("\n"), /forbidden field format:uri/);
});

for (const [name, change, expected] of [
  [
    "executing an external effect",
    (c) => (tool(c, "proposal.listing").verb = "execute"),
    /proposal\.listing: an external effect is only ever proposed/,
  ],
  [
    "approving",
    (c) => (tool(c, "message.post").verb = "approve"),
    /message\.post: no tool approves or administers/,
  ],
  [
    "a human_only capability",
    (c) => (tool(c, "task.create").capabilityId = "workspace.task.takeover"),
    /task\.create: no tool uses a human_only capability/,
  ],
  [
    "a read tool on a write capability",
    (c) => (tool(c, "products.read").capabilityId = "catalog.content.propose"),
    /products\.read: a read tool views/,
  ],
  [
    "a read replayed as a write",
    (c) => (tool(c, "work.read").replayClass = "internal_write"),
    /work\.read: a read tool/,
  ],
  [
    "a proposal on an unreviewed capability",
    (c) => (tool(c, "proposal.listing").capabilityId = "catalog.content.propose"),
    /proposal\.listing: a proposal tool proposes a reviewed/,
  ],
  [
    "a coordination tool for installed agents",
    (c) => tool(c, "agent.route").contexts.push("routed"),
    /agent\.route: coordination tools belong to the Coordinator only/,
  ],
  [
    // ADR-0034 item 2 (PR 18, catalogue version 2): plan.draft is the Coordinator's only.
    "a plan card drafted by an installed agent",
    (c) => tool(c, "plan.draft").contexts.push("routed"),
    /plan\.draft: coordination tools belong to the Coordinator only/,
  ],
  [
    "a plan card that executes something other than a post",
    (c) => (tool(c, "plan.draft").capabilityId = "workspace.project.create"),
    /plan\.draft: (an internal tool executes|no tool uses a human_only)/,
  ],
  [
    "a proposal in look-for-work",
    (c) => tool(c, "proposal.listing").contexts.push("look_for_work"),
    /proposal\.listing: look-for-work offers only reads and suggestions/,
  ],
  [
    "customer mail in look-for-work",
    (c) => tool(c, "support.thread.read").contexts.push("look_for_work"),
    /support\.thread\.read: support tools only/,
  ],
  [
    // ADR-0037 item 3(a): a called teammate never reads customer mail, asks or posts.
    "customer mail for a called teammate",
    (c) => tool(c, "support.thread.read").contexts.push("call"),
    /support\.thread\.read: support tools only/,
  ],
  [
    "a question to the person in a teammate call",
    (c) => tool(c, "inbox.ask").contexts.push("call"),
    /inbox\.ask: a called teammate never asks or posts to the person/,
  ],
  [
    "a post to the person in a teammate call",
    (c) => tool(c, "message.post").contexts.push("call"),
    /message\.post: a called teammate never asks or posts to the person/,
  ],
  [
    // ADR-0037 item 2: depth 1, agent.* for Morrow only.
    "agent.ask for an installed agent",
    (c) => tool(c, "agent.ask").contexts.push("routed"),
    /agent\.ask: agent tools belong to the Coordinator only \(depth 1\)/,
  ],
  [
    "agent.message for a called teammate",
    (c) => tool(c, "agent.message").contexts.push("call"),
    /agent\.message: agent tools belong to the Coordinator only/,
  ],
  [
    "agent.map in a hand-off",
    (c) => tool(c, "agent.map").contexts.push("routed"),
    /agent\.map: agent tools belong to the Coordinator only/,
  ],
  [
    "agent.propose in a mandate run",
    (c) => tool(c, "agent.propose").contexts.push("mandate"),
    /agent\.propose: agent tools belong to the Coordinator only/,
  ],
  [
    "a hand-off from a called teammate",
    (c) => tool(c, "agent.route").contexts.push("call"),
    /agent\.route: agent tools belong to the Coordinator only/,
  ],
  [
    // ADR-0041 item 24: result items are a called teammate's, written with result.write.
    "result items written outside a call",
    (c) => tool(c, "result.write").contexts.unshift("routed"),
    /result\.write: result items are written by called teammates only/,
  ],
  [
    "no result.write in the catalogue's harness",
    (c) => (tool(c, "result.write").family = "internal"),
    /the catalogue must offer result\.write as a memory or harness tool/,
  ],
  [
    "a call-only tool that is not result.write",
    (c) => (tool(c, "proposal.listing").contexts = ["call"]),
    /proposal\.listing: only result\.write is offered in the call context alone/,
  ],
  [
    // ADR-0041 item 24: a memory or harness tool grants nothing and holds no capability.
    "a harness tool with a capability",
    (c) => {
      tool(c, "run.plan").capabilityId = "workspace.artifact.edit";
      tool(c, "run.plan").verb = "execute";
    },
    /run\.plan: a memory or harness tool holds no capability or verb/,
  ],
  [
    "a memory tool with a capability",
    (c) => {
      tool(c, "memory.read").capabilityId = "workspace.artifact.read";
      tool(c, "memory.read").verb = "view";
    },
    /memory\.read: a memory or harness tool holds no capability or verb/,
  ],
  [
    "a grant tool without a capability",
    (c) => {
      tool(c, "work.read").capabilityId = null;
      tool(c, "work.read").verb = null;
    },
    /work\.read: only a memory or harness tool holds no capability/,
  ],
  [
    "a harness tool replayed as a read",
    (c) => (tool(c, "run.plan").replayClass = "read"),
    /run\.plan: a harness tool writes only its run's own rows/,
  ],
  [
    "a memory suggestion in a teammate call",
    (c) => tool(c, "memory.suggest").contexts.push("call"),
    /memory\.suggest: a called teammate never asks or posts to the person/,
  ],
  [
    "a memory suggestion in a mandate run",
    (c) => (tool(c, "memory.suggest").contexts = ["coordinator", "routed", "mandate"]),
    /memory\.suggest: a memory suggestion goes only to the person a job works for/,
  ],
  [
    "a memory suggestion in look-for-work",
    (c) => tool(c, "memory.suggest").contexts.push("look_for_work"),
    /memory\.suggest: look-for-work offers only reads and suggestions/,
  ],
  [
    "a wait in look-for-work",
    (c) => tool(c, "run.wait").contexts.push("look_for_work"),
    /run\.wait: look-for-work offers only reads and suggestions/,
  ],
  [
    "a completion some context lacks",
    (c) => (tool(c, "run.complete").contexts = ["coordinator", "call"]),
    /run\.complete: offered in every context, in context order/,
  ],
  [
    "a memory read some context lacks",
    (c) => tool(c, "memory.read").contexts.pop(),
    /memory\.read: offered in every context, in context order/,
  ],
  [
    "store reads for the Coordinator",
    (c) => tool(c, "products.read").contexts.push("coordinator"),
    /exactly ADR-0027 item 8's fixed set/,
  ],
  [
    "a 16 KiB result",
    (c) => (tool(c, "work.read").resultMaxBytes = 16384),
    /work\.read: result bound must be 8 KiB/,
  ],
  [
    "a renamed wire name",
    (c) => (tool(c, "work.read").wireName = "read_anything"),
    /work\.read: wire name drift/,
  ],
  ["a tool outside the enum", (c) => c.tools.pop(), /exactly the ToolName enum/],
  [
    "an unknown capability",
    (c) => (tool(c, "message.post").capabilityId = "workspace.message.shout"),
    /unknown capability/,
  ],
  [
    "an input that is not a ToolInput definition",
    (c) => (tool(c, "message.post").inputDefinition = "ToolInputUnknown"),
    /unknown input definition/,
  ],
  [
    "an input definition outside the ToolInput names",
    (c) => (tool(c, "agent.propose").inputDefinition = "AgentProposal"),
    /agent\.propose: input definition must be a ToolInput definition/,
  ],
])
  test(`the tool catalogue refuses ${name}`, () => {
    const c = structuredClone(catalogue);
    change(c);
    assert.match(inspect(c).join("\n"), expected);
  });

test("ADR-0027 item 8: the Coordinator's tools are exactly its fixed set; no store reads, proposals or support", () => {
  assert.deepEqual([...toolsForContext("coordinator")].sort(), [...coordinatorToolNames].sort());
  for (const name of toolsForContext("coordinator")) {
    const entry = toolEntry(name);
    assert.notEqual(entry.family, "proposal", name);
    for (const prefix of ["catalog.", "support.", "orders."])
      assert.ok(!String(entry.capabilityId).startsWith(prefix), name);
  }
  // ADR-0041 items 24 and 33: Morrow's memory and harness tools; it builds no result items.
  assert.deepEqual(contextToolsForContext("coordinator"), [
    "memory.search",
    "memory.read",
    "memory.suggest",
    "run.plan",
    "run.complete",
    "run.wait",
    "context.checkpoint",
  ]);
  assert.ok(toolsForContext("coordinator").includes("knowledge.propose"), "question 15");
});

test("ADR-0024 item 6: look-for-work is reads and suggestions only", () => {
  const names = toolsForContext("look_for_work");
  assert.ok(names.includes("suggestion.create"));
  for (const name of grantToolsForContext("look_for_work"))
    assert.ok(toolEntry(name).family === "read" || name === "suggestion.create", name);
  // ADR-0041 item 24: its memory reads, and the harness tools that touch only its own run's
  // plan, completion and checkpoint; never a wait, a result item or a memory suggestion.
  assert.deepEqual(contextToolsForContext("look_for_work"), [
    "memory.search",
    "memory.read",
    "run.plan",
    "run.complete",
    "context.checkpoint",
  ]);
  assert.equal(runContext("mandate", true), "look_for_work");
  assert.throws(() => runContext("routed", true), ToolCatalogueError);
  assert.throws(() => runContext("operator", false), ToolCatalogueError);
});

test("a run is offered its release's declared tools inside its context, then its context's tools, in catalogue order", () => {
  assert.deepEqual(offeredTools("routed", ["proposal.listing", "products.read", "agent.route"]), [
    "products.read",
    "proposal.listing",
    "memory.search",
    "memory.read",
    "memory.suggest",
    "run.plan",
    "run.complete",
    "run.wait",
    "context.checkpoint",
  ]);
  assert.deepEqual(offeredTools("look_for_work", ["proposal.listing", "products.read"]), [
    "products.read",
    ...contextToolsForContext("look_for_work"),
  ]);
  assert.deepEqual(offeredTools("coordinator", null), toolsForContext("coordinator"));
  // A context tool is the context's to offer: a release that declares one is refused.
  for (const declared of [
    ["sql.run"],
    ["products.read", "products.read"],
    null,
    ["products.read", "run.complete"],
    ["memory.read"],
  ])
    assert.throws(() => offeredTools("routed", declared), ToolCatalogueError, String(declared));
  assert.throws(() => offeredTools("coordinator", ["products.read"]), ToolCatalogueError);
});

test("ADR-0041 item 24: memory and harness tools hold no capability, grant nothing and are offered by context", () => {
  assert.equal(toolCatalogue.length, 30);
  const context = toolCatalogue.filter((t) => isContextTool(t.name)).map((t) => t.name);
  assert.deepEqual(context, [
    "memory.search",
    "memory.read",
    "memory.suggest",
    "run.plan",
    "run.complete",
    "run.wait",
    "result.write",
    "context.checkpoint",
  ]);
  for (const entry of toolCatalogue) {
    const held = entry.capabilityId !== null && entry.verb !== null;
    assert.equal(held, !isContextTool(entry.name), entry.name);
    if (isContextTool(entry.name)) assert.ok(["memory", "harness"].includes(entry.family));
    if (entry.family === "harness") assert.equal(entry.replayClass, "internal_write", entry.name);
  }
  // Every context offers a completion, its memory reads and a checkpoint, so a fork or a
  // follow-up keeps the same tool prefix.
  for (const ctx of ["coordinator", "routed", "mandate", "look_for_work", "call"]) {
    for (const name of everyContextToolNames) assert.ok(toolsForContext(ctx).includes(name), ctx);
    assert.deepEqual(
      [...grantToolsForContext(ctx), ...contextToolsForContext(ctx)].sort(),
      [...toolsForContext(ctx)].sort(),
      ctx,
    );
  }
  assert.equal(completionTool, "run.complete");
  assert.equal(teammateItemTool, teammateItemToolName);
  assert.equal(isContextTool("products.read"), false);
  assert.equal(isContextTool("result.submit"), false, "retired: not a tool");
  // The retired tools are gone from the catalogue and the enum.
  for (const retired of ["agent.result.read", "result.submit", "specialist.draft"]) {
    assert.equal(toolEntry(retired), null, retired);
    assert.ok(!schemas[1].$defs.ToolName.enum.includes(retired), retired);
  }
  // The contract holds the rule too: a harness tool with a capability, or a grant tool
  // without one, is no ToolDefinition.
  const withCapability = { ...toolEntry("run.plan"), capabilityId: "workspace.artifact.edit" };
  delete withCapability.inputSchema;
  assert.equal(validateCurrentDefinition("ToolDefinition", withCapability), false);
  const without = { ...toolEntry("work.read"), capabilityId: null, verb: null };
  delete without.inputSchema;
  assert.equal(validateCurrentDefinition("ToolDefinition", without), false);
});

test("the model sees strict, closed schemas under wire names, in a stable order", () => {
  const defs = modelToolDefinitions(["proposal.listing", "knowledge.search"]);
  assert.deepEqual(
    defs.map((d) => d.name),
    ["knowledge_search", "proposal_listing"],
  );
  for (const def of modelToolDefinitions(toolCatalogue.map((t) => t.name))) {
    assert.equal(def.strict, true);
    assert.match(def.name, /^[a-z][a-z0-9_]{0,63}$/);
    assert.equal(toolByWireName(def.name).wireName, def.name);
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      for (const key of [
        "pattern",
        "format",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "$ref",
      ])
        assert.equal(node[key], undefined, `${def.name} ${key}`);
      if (node.type === "object") {
        assert.equal(node.additionalProperties, false, def.name);
        assert.deepEqual(node.required, Object.keys(node.properties), def.name);
      }
      Object.values(node).forEach(walk);
    };
    walk(def.input_schema);
  }
  assert.equal(toolByWireName("knowledge.search"), null, "the model names wire names");
  assert.equal(toolByWireName("drop_table"), null);
});

// Review F1: the reply the model sends and the schema it is given agree, so a limit the
// strict schema cannot carry is the call's invalid_input, never the run's invalid_output.
test("each tool_use branch takes exactly the strict shape the model is given", () => {
  const core = schemas[1].$defs;
  const branches = core.ModelToolUseBlock.oneOf;
  assert.equal(branches.length, toolCatalogue.length);
  for (const [index, entry] of toolCatalogue.entries()) {
    const name = toolModelInputName(entry.inputDefinition);
    assert.equal(name, entry.inputDefinition.replace("ToolInput", "ToolModelInput"));
    assert.equal(branches[index].properties.name.const, entry.name);
    assert.equal(branches[index].properties.input.$ref, "#/$defs/" + name);
    const { description, ...shape } = core[name];
    assert.match(description, new RegExp("^" + entry.name.replace(".", "\\.") + " as the model"));
    assert.equal(jcs(shape), jcs(entry.inputSchema), entry.name);
  }
});

for (const [name, change, expected] of [
  [
    "a tool_use branch on the full input",
    (s) =>
      (s[1].$defs.ModelToolUseBlock.oneOf[0].properties.input.$ref =
        "#/$defs/ToolInputKnowledgeSearch"),
    /knowledge\.search: its ModelToolUseBlock branch must name it and take ToolModelInputKnowledgeSearch/,
  ],
  [
    "a strict shape that carries a limit",
    (s) => (s[1].$defs.ToolModelInputKnowledgeSearch.properties.limit.maximum = 10),
    /knowledge\.search: ToolModelInputKnowledgeSearch must be exactly the strict shape/,
  ],
  [
    "a full input that gains a field its strict shape lacks",
    (s) => {
      s[1].$defs.ToolInputMessagePost.properties.pinned = { type: "boolean" };
      s[1].$defs.ToolInputMessagePost.required.push("pinned");
    },
    /message\.post: ToolModelInputMessagePost must be exactly the strict shape/,
  ],
  [
    "a missing strict shape",
    (s) => delete s[1].$defs.ToolModelInputWorkRead,
    /work\.read: no ToolModelInputWorkRead definition/,
  ],
  [
    "tool_use branches out of catalogue order",
    (s) => s[1].$defs.ModelToolUseBlock.oneOf.reverse(),
    /knowledge\.search: its ModelToolUseBlock branch/,
  ],
  [
    "a missing tool_use branch",
    (s) => s[1].$defs.ModelToolUseBlock.oneOf.pop(),
    /ModelToolUseBlock must have one branch per tool/,
  ],
  [
    "an optional input property",
    (s) => s[1].$defs.ToolInputMessagePost.required.pop(),
    /message\.post: input is not strict-expressible: AGENT_PLATFORM_SCHEMA_OPTIONAL/,
  ],
])
  test(`the tool catalogue refuses ${name}`, () => {
    const s = structuredClone(schemas);
    change(s);
    assert.match(inspect(catalogue, s).join("\n"), expected);
  });

test("ADR-0027 item 2: the tool-call step validates the input with the full definition", () => {
  // Inside the strict shape, so a valid reply; outside ToolInputKnowledgeSearch's limits.
  for (const [tool, input] of [
    ["knowledge.search", { searchText: "returns", limit: 20 }],
    ["knowledge.search", { searchText: "   ", limit: 5 }],
    ["work.read", { target: "task", id: "has space" }],
    ["products.read", { productIds: [], titleContains: null, limit: 5 }],
  ]) {
    assert.ok(
      validateCurrentDefinition(toolModelInputName(toolEntry(tool).inputDefinition), input),
      tool,
    );
    assert.deepEqual(
      checkToolInput(tool, input),
      { ok: false, outcome: "invalid_input", refusal: "input_invalid" },
      JSON.stringify(input),
    );
  }
  assert.deepEqual(checkToolInput("knowledge.search", { searchText: "returns", limit: 5 }), {
    ok: true,
  });
  assert.deepEqual(checkToolInput("work.read", { target: "thread", id: null }), { ok: true });
  // An unknown tool never reaches the tool-call step: its reply was an invalid output.
  for (const unknown of ["sql.run", "knowledge_search", null])
    assert.throws(() => checkToolInput(unknown, {}), ToolCatalogueError, String(unknown));
});

test("a strict schema refuses what strict tool use cannot carry exactly", () => {
  assert.throws(
    () => strictModelSchema({ oneOf: [{ type: "string" }, { type: "integer" }] }, schemas),
    /AGENT_PLATFORM_SCHEMA_KEYWORD:oneOf/,
  );
  assert.throws(
    () => strictModelSchema({ type: "object", properties: {} }, schemas),
    /AGENT_PLATFORM_SCHEMA_OBJECT/,
  );
  assert.throws(
    () => strictModelSchema({ anyOf: [{ type: "string" }, { type: "integer" }] }, schemas),
    /AGENT_PLATFORM_SCHEMA_UNION/,
  );
  // An optional property would arrive as a null its full definition refuses.
  assert.throws(
    () =>
      strictModelSchema(
        {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: ["a"],
          additionalProperties: false,
        },
        schemas,
      ),
    /AGENT_PLATFORM_SCHEMA_OPTIONAL/,
  );
});

test("ADR-0027 item 11, ADR-0037 item 9: the switches are committed off; on or extra keys fail", () => {
  const [loop, calls, cards] = switches();
  for (const record of [loop, calls, cards]) assert.equal(record.switch, "off");
  assert.equal(calls.feature, "teammate_calls");
  assert.equal(cards.feature, "agent_cards");
  assert.equal(inspectAgentPlatformSwitches({ ...loop, switch: "on" }, calls, cards).length, 1);
  assert.equal(inspectAgentPlatformSwitches(loop, { ...calls, switch: "on" }, cards).length, 1);
  assert.equal(inspectAgentPlatformSwitches(loop, calls, { ...cards, switch: "on" }).length, 1);
  assert.equal(
    inspectAgentPlatformSwitches(loop, calls, { ...cards, observed_on: "2026-10-26" }).length,
    1,
  );
  assert.equal(inspectAgentPlatformSwitches(loop, { ...calls, key: "x" }, cards).length, 1);
  // Each record names its own feature: swapped files fail.
  assert.equal(inspectAgentPlatformSwitches(loop, cards, calls).length, 2);
  assert.equal(inspectAgentPlatformSwitches({ ...loop, key: "x" }, calls, cards).length, 1);
});

test("ADR-0037 item 2: no context but the Coordinator's offers an agent.* tool (depth 1)", () => {
  const agentTools = toolCatalogue.filter((t) => t.name.startsWith("agent.")).map((t) => t.name);
  assert.deepEqual(agentTools, [
    "agent.route",
    "agent.ask",
    "agent.map",
    "agent.message",
    "agent.cancel",
    "agent.propose",
  ]);
  for (const name of agentTools) {
    assert.ok(isAgentTool(name), name);
    assert.deepEqual([...toolEntry(name).contexts], ["coordinator"], name);
  }
  for (const context of ["routed", "mandate", "look_for_work", "call"])
    for (const name of toolsForContext(context)) {
      assert.ok(!isAgentTool(name), `${context} ${name}`);
      assert.notEqual(toolEntry(name).capabilityId, "workspace.task.delegate", name);
      assert.ok(!String(toolEntry(name).capabilityId).startsWith("agents."), name);
    }
  assert.equal(isAgentTool("agent.anything"), false);
  assert.equal(toolEntry("specialist.draft"), null, "retired in version 4");
  // Calls, maps, guidance, cancels and hand-offs are delegations on workspace.task.delegate;
  // agent.propose a draft on agents.builder.describe. Reading a result is memory.read's.
  assert.deepEqual(
    agentTools.map((n) => {
      const t = toolEntry(n);
      return [t.family, t.capabilityId, t.verb];
    }),
    [
      ...Array.from({ length: 5 }, () => ["coordination", "workspace.task.delegate", "delegate"]),
      ["coordination", "agents.builder.describe", "execute"],
    ],
  );
});

test("ADR-0037 item 3(a), ADR-0041 item 24: a called teammate cannot talk to the person, writes result items and ends with run.complete", () => {
  const call = toolsForContext("call");
  assert.ok(call.includes(teammateItemTool) && call.includes(completionTool));
  for (const name of [
    "inbox.ask",
    "message.post",
    "support.thread.read",
    "proposal.reply",
    "memory.suggest",
    "run.wait",
    "knowledge.propose",
  ])
    assert.ok(!call.includes(name), name);
  assert.deepEqual([...toolEntry(teammateItemTool).contexts], ["call"]);
  assert.equal(runContext("routed", false, true), "call");
  assert.equal(runContext("routed", false), "routed");
  for (const [kind, lookForWork, called] of [
    ["mandate", false, true],
    ["coordinator", false, true],
    ["mandate", true, true],
    ["specialist", false, false],
  ])
    assert.throws(() => runContext(kind, lookForWork, called), ToolCatalogueError, kind);
  // A package declares grant tools only; every call of it is offered the call context's
  // memory and harness tools, and nothing that reaches the person.
  assert.deepEqual(offeredTools("call", fakeListingsPackage().tools), [
    "knowledge.search",
    "work.read",
    "products.read",
    "suggestion.create",
    "report.write",
    "proposal.listing",
    "memory.search",
    "memory.read",
    "run.plan",
    "run.complete",
    "result.write",
    "context.checkpoint",
  ]);
  assert.ok(!offeredTools("routed", fakeListingsPackage().tools).includes(teammateItemTool));
});

test("ADR-0037 item 3, ADR-0041 item 21: briefs and results are structured with no character cap", () => {
  const long = "Long material. ".repeat(20000);
  const brief = {
    ...fakeTeammateBriefInput(),
    objective: long,
    details: long,
    doneCriteria: [long],
    approach: [long],
  };
  for (const name of ["agent.ask", "agent.route"]) {
    const input =
      name === "agent.ask"
        ? { installationId: fakeIds.listingsInstallationId, mode: "ask", followUpOf: null, brief }
        : { installationId: fakeIds.listingsInstallationId, brief };
    assert.deepEqual(checkToolInput(name, input), { ok: true }, name);
    // Structured and closed: a brief as plain text, or with an extra field, is refused.
    assert.equal(checkToolInput(name, { ...input, brief: "do it" }).ok, false, name);
    assert.equal(
      checkToolInput(name, { ...input, brief: { ...brief, extra: ["orders.summary"] } }).ok,
      false,
      name,
    );
    assert.doesNotMatch(toolEntry(name).description, /once per/i, name);
    // A brief names no tool, capability, scope, store, model or limit; the model never
    // writes the requester's words (request is code's).
    for (const field of ["request", "tools", "model", "storeId"])
      assert.equal(
        checkToolInput(name, { ...input, brief: { ...brief, [field]: null } }).ok,
        false,
        `${name} ${field}`,
      );
  }
  // At least one done criterion (ADR-0041 item 21).
  assert.equal(
    checkToolInput("agent.route", {
      installationId: fakeIds.listingsInstallationId,
      brief: { ...brief, doneCriteria: [] },
    }).ok,
    false,
  );
  const core = schemas[1].$defs;
  for (const name of [
    "TeammateBrief",
    "TeammateBriefInput",
    "TeammateBriefLines",
    "TeammateDoneCriteria",
    "TeammateRequest",
    "TeammateResultInput",
    "TeammateFindingInput",
    "TeammateTableInput",
    "TeammateText",
    "TeammateTable",
    "TeammateNeedsInput",
    "TeammateVerdictInput",
    "ResultItemPageContent",
    "ToolInputRunComplete",
    "ToolInputAgentMessage",
  ]) {
    const { unit: _unit, ...rest } = core[name].properties ?? {};
    assert.doesNotMatch(JSON.stringify({ ...core[name], properties: rest }), /maxLength/, name);
  }
  // memory.read opens a result item or a teammate's full result page by page, in place of
  // agent.result.read.
  assert.deepEqual(checkToolInput("memory.read", fakeMemoryReadInput()), { ok: true });
  assert.equal(checkToolInput("memory.read", { ...fakeMemoryReadInput(), page: 0 }).ok, false);
});

const proposeInput = () => ({
  name: "Restock Watch",
  purpose: "Watch stock levels.",
  instructions: "Suggest restocks.",
  skillTexts: [],
  skillIds: [],
  tools: ["inventory.read"],
  triggerKinds: [],
});
test("ADR-0037 item 4: agent.propose is the one input that names tools, by ToolName only", () => {
  assert.deepEqual(
    { ...cardToolsException },
    {
      tool: "agent.propose",
      property: "tools",
      items: "#/$defs/ToolName",
    },
  );
  assert.deepEqual(checkToolInput("agent.propose", proposeInput()), { ok: true });
  const s = structuredClone(schemas);
  s[1].$defs.ToolInputAgentPropose.properties.tools.items = { type: "string" };
  assert.match(
    inspect(catalogue, s).join("\n"),
    /agent\.propose: input takes a forbidden field tools/,
  );
  const c = structuredClone(catalogue);
  tool(c, "agent.ask").inputDefinition = "ToolInputAgentPropose";
  assert.match(inspect(c).join("\n"), /agent\.ask: input takes a forbidden field tools/);
  // The model names no capability, scope, store, model or limit on a card.
  for (const field of ["capabilities", "optionalScopes", "storeId", "model", "runLimits"])
    assert.equal(
      checkToolInput("agent.propose", { ...proposeInput(), [field]: [] }).ok,
      false,
      field,
    );
});

test("the old formats stay: ModelCall@1, ModelResult@1 and the per-product catalogue are unchanged", async () => {
  const { generatedModelCatalogue } = await import(
    "../packages/policy/src/generated/model-catalogue.ts"
  );
  // The per-product shape holds versions 1 and 3 (retired) and version 4 (ADR-0039), never a
  // loop version.
  assert.deepEqual(
    generatedModelCatalogue.versions.map((v) => [v.version, v.status]),
    [
      [1, "retired"],
      [3, "retired"],
      [4, "active"],
    ],
  );
  const core = schemas[1].$defs;
  assert.equal(core.ModelCall.properties.schemaVersion.const, 1);
  assert.equal(core.ModelCall.properties.purpose.const, "listing_draft");
  assert.equal(core.ModelResult.properties.schemaVersion.const, 1);
  assert.equal(core.CoordinatorRoute.properties.specialist.const, "morrow.listings");
});
