// PR 10: ToolCatalogue@1 (ADR-0027 items 2, 3 and 8), the Specialist ceiling (ADR-0028 item
// 2) and the committed-off agent switches (ADR-0027 item 11, ADR-0028 item 8). The safety tests
// of the build order's PR 10: no tool takes SQL, a URL, a store, a recipient, a credential or a
// model; validators are generated ahead of time; the old formats stay unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  coordinatorToolNames,
  forbiddenInputName,
  generateAgentPlatform,
  generatedSpecialistCeilingPath,
  generatedToolCataloguePath,
  inspectAgentPlatformSwitches,
  inspectSpecialistCeiling,
  inspectToolCatalogue,
  jcs,
  strictModelSchema,
  toolModelInputName,
} from "../scripts/generate-agent-platform.mjs";
import {
  checkToolInput,
  modelToolDefinitions,
  offeredTools,
  runContext,
  specialistCapabilities,
  specialistCeiling,
  toolByWireName,
  toolCatalogue,
  toolCatalogueDigest,
  toolCatalogueVersion,
  toolEntry,
  ToolCatalogueError,
  toolsForContext,
  withinSpecialistCeiling,
} from "../packages/policy/src/tool-catalogue.ts";
import { fakeSpecialistSpec } from "../packages/policy/src/agent-platform-fakes.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const catalogue = read("docs/contracts/tool-catalogue.json");
const ceiling = read("docs/contracts/specialist-ceiling.json");
const capabilities = read("docs/contracts/capabilities.json").capabilities;
const schemas = [
  read("docs/contracts/schemas/v1/core.schema.json"),
  read("docs/contracts/schemas/v1.1/core.schema.json"),
];
const validate = (value) => validateCurrentDefinition("ToolCatalogue", value);
const inspect = (c = catalogue, s = schemas, l = ceiling) =>
  inspectToolCatalogue({ catalogue: c, capabilities, schemas: s, ceiling: l, validate });
const tool = (c, name) => c.tools.find((t) => t.name === name);

test("the generator reproduces the committed modules, which are data only", async () => {
  const first = await generateAgentPlatform();
  const second = await generateAgentPlatform();
  assert.deepEqual(first, second);
  for (const path of [generatedToolCataloguePath, generatedSpecialistCeilingPath]) {
    assert.equal(readFileSync(path, "utf8"), first[path], path);
    assert.doesNotMatch(first[path], /\bimport\b|\bfunction\b|=>|\beval\b|new Function/);
  }
});

test("the committed catalogue, ceiling and switches inspect clean", () => {
  assert.deepEqual(inspect(), []);
  assert.deepEqual(inspectSpecialistCeiling(ceiling, capabilities), []);
  assert.deepEqual(
    inspectAgentPlatformSwitches(
      read("docs/decisions/agent-loop-staging.json"),
      read("docs/decisions/specialists-staging.json"),
    ),
    [],
  );
  assert.ok(validate(catalogue));
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
    "customer mail for a specialist",
    (c) => tool(c, "support.thread.read").contexts.push("specialist"),
    /support\.thread\.read: (support tools only|a specialist tool must be inside)/,
  ],
  [
    "order reads for a specialist",
    (c) => tool(c, "orders.summary").contexts.push("specialist"),
    /orders\.summary: a specialist tool must be inside the Specialist ceiling/,
  ],
  [
    "task creation for a specialist",
    (c) => tool(c, "task.create").contexts.push("specialist"),
    /task\.create: a specialist tool must be inside the Specialist ceiling/,
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
    (c) => (tool(c, "specialist.draft").inputDefinition = "SpecialistBrief"),
    /specialist\.draft: input definition must be a ToolInput definition/,
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
    assert.ok(!entry.capabilityId.startsWith("catalog."), name);
    assert.ok(!entry.capabilityId.startsWith("support."), name);
    assert.ok(!entry.capabilityId.startsWith("orders."), name);
  }
});

test("ADR-0024 item 6: look-for-work is reads and suggestions only", () => {
  const names = toolsForContext("look_for_work");
  assert.ok(names.includes("suggestion.create"));
  for (const name of names)
    assert.ok(toolEntry(name).family === "read" || name === "suggestion.create", name);
  assert.equal(runContext("mandate", true), "look_for_work");
  assert.throws(() => runContext("routed", true), ToolCatalogueError);
  assert.throws(() => runContext("operator", false), ToolCatalogueError);
});

test("a run is offered its release's declared tools inside its context, in catalogue order", () => {
  assert.deepEqual(offeredTools("routed", ["proposal.listing", "products.read", "agent.route"]), [
    "products.read",
    "proposal.listing",
  ]);
  assert.deepEqual(offeredTools("look_for_work", ["proposal.listing", "products.read"]), [
    "products.read",
  ]);
  assert.deepEqual(offeredTools("coordinator", null), toolsForContext("coordinator"));
  for (const declared of [["sql.run"], ["products.read", "products.read"], null])
    assert.throws(() => offeredTools("routed", declared), ToolCatalogueError, String(declared));
  assert.throws(() => offeredTools("coordinator", ["products.read"]), ToolCatalogueError);
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

test("ADR-0028 item 2: the Specialist ceiling is fixed ids, never the never-list", () => {
  assert.ok(specialistCeiling.length >= 1 && specialistCeiling.length <= 16);
  for (const [capabilityId, verb] of [
    ["orders.read", "view"],
    ["support.case.read", "view"],
    ["support.reply.send", "propose"],
    ["workspace.task.delegate", "delegate"],
    ["workspace.task.create", "execute"],
    ["workspace.task.assign", "execute"],
    ["catalog.content.publish", "execute"],
    ["catalog.content.publish", "approve"],
    ["agents.installation.disable", "execute"],
  ])
    assert.equal(withinSpecialistCeiling(capabilityId, verb), false, capabilityId + " " + verb);
  for (const [name, change] of [
    ["order reads", (l) => l.capabilities.push({ capabilityId: "orders.read", verbs: ["view"] })],
    [
      "customer mail",
      (l) => l.capabilities.push({ capabilityId: "support.case.read", verbs: ["view"] }),
    ],
    [
      "delegation",
      (l) => l.capabilities.push({ capabilityId: "workspace.task.delegate", verbs: ["delegate"] }),
    ],
    [
      "task creation",
      (l) => l.capabilities.push({ capabilityId: "workspace.task.create", verbs: ["execute"] }),
    ],
    [
      "executing a publish",
      (l) =>
        (l.capabilities.find((r) => r.capabilityId === "catalog.content.publish").verbs = [
          "propose",
          "execute",
        ]),
    ],
    [
      "a human_only stop",
      (l) =>
        l.capabilities.push({ capabilityId: "agents.installation.disable", verbs: ["execute"] }),
    ],
    [
      "17 ids",
      (l) => {
        while (l.capabilities.length < 17)
          l.capabilities.push({ capabilityId: "workspace.knowledge.read", verbs: ["view"] });
      },
    ],
  ]) {
    const l = structuredClone(ceiling);
    change(l);
    assert.ok(inspectSpecialistCeiling(l, capabilities).length > 0, name);
  }
});

test("ADR-0027 item 10: a specialist's capabilities come from its tools inside the ceiling", () => {
  const spec = fakeSpecialistSpec();
  const derived = specialistCapabilities(spec.tools);
  assert.deepEqual(
    [...derived].map((r) => r.capabilityId + ":" + r.verbs.join()).sort(),
    [...spec.capabilities].map((r) => r.capabilityId + ":" + r.verbs.join()).sort(),
  );
  assert.throws(() => specialistCapabilities(["orders.summary"]), ToolCatalogueError);
  assert.throws(() => specialistCapabilities(["agent.route"]), ToolCatalogueError);
  assert.throws(() => specialistCapabilities(["proposal.reply"]), ToolCatalogueError);
});

test("ADR-0027 item 11, ADR-0028 item 8: both switches are committed off; on or extra keys fail", () => {
  const loop = read("docs/decisions/agent-loop-staging.json");
  const specialists = read("docs/decisions/specialists-staging.json");
  assert.equal(loop.switch, "off");
  assert.equal(specialists.switch, "off");
  assert.equal(inspectAgentPlatformSwitches({ ...loop, switch: "on" }, specialists).length, 1);
  assert.equal(inspectAgentPlatformSwitches(loop, { ...specialists, switch: "on" }).length, 1);
  assert.equal(
    inspectAgentPlatformSwitches({ ...loop, observed_on: "2026-10-26" }, specialists).length,
    1,
  );
  assert.equal(inspectAgentPlatformSwitches({ ...loop, key: "x" }, specialists).length, 1);
});

test("the old formats stay: ModelCall@1, ModelResult@1 and the per-product catalogue are unchanged", async () => {
  const { generatedModelCatalogue } = await import(
    "../packages/policy/src/generated/model-catalogue.ts"
  );
  assert.deepEqual(
    generatedModelCatalogue.versions.map((v) => v.version),
    [1],
  );
  const core = schemas[1].$defs;
  assert.equal(core.ModelCall.properties.schemaVersion.const, 1);
  assert.equal(core.ModelCall.properties.purpose.const, "listing_draft");
  assert.equal(core.ModelResult.properties.schemaVersion.const, 1);
  assert.equal(core.CoordinatorRoute.properties.specialist.const, "morrow.listings");
});
