// The agent-platform generator (PR 10; ADR-0027 items 3 and 11, ADR-0028 items 2 and 8).
// It reads the reviewed data files, refuses them unless every inspection below passes, and
// writes data-only TypeScript modules for the loop (PR 11), the specialist Start and the
// screens:
//   docs/contracts/tool-catalogue.json   -> packages/policy/src/generated/tool-catalogue.ts
//     ToolCatalogue@1 with each tool's strict model input schema (derived from its v1.1 core
//     definition the way ListingDraft_v1 is) and the catalogue digest a run manifest pins.
//   docs/contracts/specialist-ceiling.json -> packages/policy/src/generated/specialist-ceiling.ts
//     The Specialist ceiling's fixed ids (ADR-0028 item 2: "T2 fixes the exact ids").
// It also checks that docs/decisions/agent-loop-staging.json and specialists-staging.json are
// committed off (no Worker reads them before PR 11; edge:check takes them over then).
// `--check` compares the committed files byte for byte and runs the inspections
// (verify:boundaries). Nothing here compiles a schema at runtime.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { repositoryRoot } from "./artifacts.mjs";

export const toolCataloguePath = "docs/contracts/tool-catalogue.json";
export const specialistCeilingPath = "docs/contracts/specialist-ceiling.json";
export const agentLoopSwitchPath = "docs/decisions/agent-loop-staging.json";
export const specialistSwitchPath = "docs/decisions/specialists-staging.json";
export const generatedToolCataloguePath = "packages/policy/src/generated/tool-catalogue.ts";
export const generatedSpecialistCeilingPath = "packages/policy/src/generated/specialist-ceiling.ts";
const coreV1Path = "docs/contracts/schemas/v1/core.schema.json";
const coreV11Path = "docs/contracts/schemas/v1.1/core.schema.json";
const capabilitiesPath = "docs/contracts/capabilities.json";
const validatorsPath = "packages/contracts/src/generated/runtime-validators.mjs";

const refuse = (code) => {
  throw Error("AGENT_PLATFORM_" + code);
};
const readJson = (root, path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
// RFC 8785 (JCS) text of plain JSON data: sorted keys, no whitespace.
export const jcs = (value) =>
  Array.isArray(value)
    ? "[" + value.map(jcs).join(",") + "]"
    : value && typeof value === "object"
      ? "{" +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + jcs(value[key]))
          .join(",") +
        "}"
      : JSON.stringify(value);
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// ADR-0027 item 8: the Coordinator's fixed grant set, as tools.
export const coordinatorToolNames = Object.freeze([
  "knowledge.search",
  "work.read",
  "message.post",
  "inbox.ask",
  "task.create",
  "agent.route",
  "specialist.draft",
]);
// ADR-0027 item 3: no tool takes SQL, a URL, a role, a store, a recipient, a sender, a
// credential or a model. Field names that would carry one, anywhere in a tool's input.
export const forbiddenInputName =
  /^(sql|query|url|uri|urls|href|link|links|endpoint|domain|host|role|roles|store|stores|storeid|storeids|shop|shopdomain|connectionid|organizationid|workspaceid|tenant|recipient|recipients|to|cc|bcc|from|replyto|sender|senders|senderidentityid|email|emails|address|credential|credentials|token|tokens|secret|secrets|apikey|key|password|model|models|effort|provider|capabilityid|capabilities|grant|grants|scope|tools|caps|budget|reservation)$/i;
// ADR-0028 item 2: never in the Specialist ceiling at launch.
const neverForSpecialists = (capability, verb) =>
  capability.id === "orders.read" ||
  capability.id.startsWith("support.") ||
  capability.id === "workspace.task.delegate" ||
  capability.id === "workspace.task.create" ||
  capability.id === "workspace.task.assign" ||
  capability.executor === "human_only" ||
  (capability.id.endsWith(".publish") && (verb === "approve" || verb === "execute")) ||
  ["approve", "delegate", "administer"].includes(verb);

// The keywords strict tool use does not take (as for ListingDraft_v1, S156): string-length,
// numeric and array bounds, patterns and formats. Code validates every input again with the
// full v1.1 definition before the tool runs.
const droppedKeywords = new Set([
  "description",
  "$comment",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "uniqueItems",
  "pattern",
  "minProperties",
  "format",
]);
/**
 * The strict model input schema of one v1.1 core definition: references inlined (core v1
 * and v1.1), every object closed with all its properties required and the optional ones
 * nullable, the keywords above dropped. Throws on anything else (a non-null union, allOf,
 * oneOf, a conditional), so a tool input stays expressible exactly.
 */
export function strictModelSchema(definition, schemas) {
  const byId = new Map(schemas.map((schema) => [schema.$id, schema]));
  const resolveRef = (pointer, base) => {
    const match = /^(?:(urn:morrow:contracts:core:v1(?:\.1)?))?#\/\$defs\/([A-Za-z0-9_]+)$/.exec(
      pointer,
    );
    if (!match) refuse("SCHEMA_REF:" + pointer);
    const id = match[1] ?? base;
    const node = byId.get(id)?.$defs?.[match[2]];
    if (!node) refuse("SCHEMA_REF:" + pointer);
    return { node, base: id };
  };
  const convert = (node, base, depth) => {
    if (depth > 12 || !node || typeof node !== "object" || Array.isArray(node))
      refuse("SCHEMA_SHAPE");
    if (node.$ref !== undefined) {
      if (Object.keys(node).some((key) => key !== "$ref" && key !== "description"))
        refuse("SCHEMA_REF_SIBLINGS");
      const target = resolveRef(node.$ref, base);
      return convert(target.node, target.base, depth + 1);
    }
    if (node.anyOf !== undefined) {
      const branches = node.anyOf;
      const nullIndex = branches.findIndex((b) => b && b.type === "null");
      if (
        branches.length !== 2 ||
        nullIndex === -1 ||
        Object.keys(branches[nullIndex]).length !== 1 ||
        Object.keys(node).some((key) => key !== "anyOf" && !droppedKeywords.has(key))
      )
        refuse("SCHEMA_UNION");
      return {
        anyOf: [convert(branches[1 - nullIndex], base, depth + 1), { type: "null" }],
      };
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (droppedKeywords.has(key)) continue;
      if (["properties", "required", "items"].includes(key)) continue;
      if (!["type", "enum", "const", "additionalProperties"].includes(key))
        refuse("SCHEMA_KEYWORD:" + key);
      out[key] = value;
    }
    if (node.type === "object") {
      if (node.additionalProperties !== false || !node.properties) refuse("SCHEMA_OBJECT");
      const required = new Set(node.required ?? []);
      out.properties = {};
      for (const [name, child] of Object.entries(node.properties)) {
        const converted = convert(child, base, depth + 1);
        out.properties[name] = required.has(name)
          ? converted
          : { anyOf: [converted, { type: "null" }] };
      }
      out.required = Object.keys(node.properties);
      out.additionalProperties = false;
    } else if (node.type === "array") {
      out.items = convert(node.items, base, depth + 1);
    } else if (node.const !== undefined || node.enum !== undefined) {
      // A const or enum keeps its type when it has one.
    } else if (!["string", "integer", "boolean", "number", "null"].includes(node.type)) {
      refuse("SCHEMA_TYPE");
    }
    return out;
  };
  return convert(definition, "urn:morrow:contracts:core:v1.1", 0);
}

/** Every property name in a schema, through references (for the forbidden-name rule). */
function propertyNames(
  definition,
  schemas,
  seen = new Set(),
  base = "urn:morrow:contracts:core:v1.1",
) {
  const names = [];
  const byId = new Map(schemas.map((schema) => [schema.$id, schema]));
  const walk = (node, at) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, at));
    if (typeof node.$ref === "string") {
      const match = /^(?:(urn:[^#]+))?#\/\$defs\/(.+)$/.exec(node.$ref);
      const id = match?.[1] ?? at;
      const key = id + "#" + match?.[2];
      if (match && !seen.has(key)) {
        seen.add(key);
        walk(byId.get(id)?.$defs?.[match[2]], id);
      }
    }
    if (node.format !== undefined) names.push("format:" + node.format);
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && value && typeof value === "object")
        for (const [name, child] of Object.entries(value)) {
          names.push(name);
          walk(child, at);
        }
      else if (key !== "$ref") walk(value, at);
    }
  };
  walk(definition, base);
  return names;
}

/**
 * The inspections of ToolCatalogue@1 (ADR-0027 items 2, 3 and 8; ADR-0024 item 6; ADR-0028
 * item 2). Returns every problem as a string; an empty list passes.
 */
export function inspectToolCatalogue({ catalogue, capabilities, schemas, ceiling, validate }) {
  const errors = [];
  const fail = (message) => errors.push("tool catalogue: " + message);
  if (typeof validate === "function" && !validate(catalogue))
    fail("not a valid ToolCatalogue@1 (v1.1 core ToolCatalogue)");
  const core = schemas.find((s) => s.$id === "urn:morrow:contracts:core:v1.1");
  const byId = new Map(capabilities.map((c) => [c.id, c]));
  const tools = Array.isArray(catalogue?.tools) ? catalogue.tools : [];
  const names = tools.map((t) => t.name);
  const enumNames = core?.$defs?.ToolName?.enum ?? [];
  if (JSON.stringify(names) !== JSON.stringify(enumNames))
    fail("tools must be exactly the ToolName enum, in its order");
  const wires = new Set();
  const ceilingPairs = new Set(
    (ceiling?.capabilities ?? []).flatMap((c) => c.verbs.map((v) => c.capabilityId + ":" + v)),
  );
  for (const tool of tools) {
    const at = (message) => fail(`${tool.name}: ${message}`);
    if (tool.wireName !== String(tool.name).replaceAll(".", "_")) at("wire name drift");
    if (wires.has(tool.wireName)) at("duplicate wire name");
    wires.add(tool.wireName);
    if (tool.resultMaxBytes !== 8192) at("result bound must be 8 KiB");
    const capability = byId.get(tool.capabilityId);
    if (!capability) {
      at("unknown capability " + tool.capabilityId);
      continue;
    }
    // No tool has an external effect (ADR-0027 item 3): nothing executes an external_write,
    // spend or communication capability, and no tool approves or administers.
    if (
      ["external_write", "spend", "communication"].includes(capability.effect) &&
      tool.verb !== "propose"
    )
      at("an external effect is only ever proposed");
    if (["approve", "administer"].includes(tool.verb)) at("no tool approves or administers");
    if (capability.executor === "human_only") at("no tool uses a human_only capability");
    switch (tool.family) {
      case "read":
        if (
          capability.effect !== "read" ||
          capability.executor !== "agent_direct_read" ||
          tool.verb !== "view" ||
          tool.replayClass !== "read"
        )
          at("a read tool views an agent_direct_read capability and is replayed as a read");
        break;
      case "internal":
      case "coordination":
        if (
          capability.effect !== "internal_write" ||
          capability.executor !== "agent_direct_write" ||
          tool.replayClass !== "internal_write" ||
          !(
            tool.verb === "execute" ||
            (tool.verb === "delegate" && tool.capabilityId === "workspace.task.delegate")
          )
        )
          at("an internal tool executes an agent_direct_write capability");
        if (
          tool.family === "coordination" &&
          JSON.stringify(tool.contexts) !== JSON.stringify(["coordinator"])
        )
          at("coordination tools belong to the Coordinator only");
        break;
      case "proposal":
        if (
          tool.verb !== "propose" ||
          capability.review_required !== true ||
          capability.executor !== "agent_after_approval" ||
          tool.replayClass !== "internal_write"
        )
          at("a proposal tool proposes a reviewed agent_after_approval capability");
        break;
      case "computer":
        if (tool.replayClass !== "computer") at("a computer tool replays as unknown");
        break;
      default:
        at("unknown family");
    }
    const contexts = Array.isArray(tool.contexts) ? tool.contexts : [];
    // Look-for-work is read-only: reads and suggestions, never proposals or the computer
    // (ADR-0024 item 6), and never customer mail.
    if (
      contexts.includes("look_for_work") &&
      !(tool.family === "read" || tool.name === "suggestion.create")
    )
      at("look-for-work offers only reads and suggestions");
    if (tool.capabilityId === "support.case.read" || tool.capabilityId.startsWith("support.")) {
      if (contexts.some((c) => !["routed", "mandate"].includes(c)))
        at("support tools only in Support's routed and mandate runs");
    }
    if (contexts.includes("specialist")) {
      if (!ceilingPairs.has(tool.capabilityId + ":" + tool.verb))
        at("a specialist tool must be inside the Specialist ceiling");
      if (neverForSpecialists(capability, tool.verb)) at("never offered to a specialist");
    }
    // Input: a v1.1 core definition, expressible as a strict schema, naming nothing forbidden.
    const definition = core?.$defs?.[tool.inputDefinition];
    if (!definition) {
      at("unknown input definition " + tool.inputDefinition);
      continue;
    }
    try {
      strictModelSchema(definition, schemas);
    } catch (error) {
      at("input is not strict-expressible: " + error.message);
    }
    for (const name of propertyNames(definition, schemas))
      if (name.startsWith("format:") || forbiddenInputName.test(name))
        at("input takes a forbidden field " + name);
  }
  const coordinator = tools.filter((t) => t.contexts?.includes("coordinator")).map((t) => t.name);
  if (JSON.stringify([...coordinator].sort()) !== JSON.stringify([...coordinatorToolNames].sort()))
    fail("the Coordinator's tools must be exactly ADR-0027 item 8's fixed set");
  return errors;
}

/** The Specialist ceiling (ADR-0028 item 2): at most 16 ids, none of the never-list. */
export function inspectSpecialistCeiling(ceiling, capabilities) {
  const errors = [];
  const fail = (message) => errors.push("specialist ceiling: " + message);
  const byId = new Map(capabilities.map((c) => [c.id, c]));
  if (
    ceiling?.schemaVersion !== 1 ||
    ceiling.release !== "morrow.specialist" ||
    ceiling.maxCapabilities !== 16 ||
    !Array.isArray(ceiling.capabilities)
  )
    return [...errors, "specialist ceiling: malformed"];
  if (ceiling.capabilities.length < 1 || ceiling.capabilities.length > 16)
    fail("between 1 and 16 capability ids");
  const seen = new Set();
  for (const row of ceiling.capabilities) {
    const capability = byId.get(row?.capabilityId);
    if (!capability || seen.has(row.capabilityId)) {
      fail("unknown or repeated " + row?.capabilityId);
      continue;
    }
    seen.add(row.capabilityId);
    if (
      !Array.isArray(row.verbs) ||
      row.verbs.length < 1 ||
      new Set(row.verbs).size !== row.verbs.length
    )
      fail(row.capabilityId + ": verbs");
    for (const verb of row.verbs ?? []) {
      if (neverForSpecialists(capability, verb))
        fail(`${row.capabilityId} ${verb} is never a specialist's at launch`);
      if (capability.effect === "read" && verb !== "view")
        fail(`${row.capabilityId}: a read is only viewed`);
      if (
        ["external_write", "spend", "communication"].includes(capability.effect) &&
        verb !== "propose"
      )
        fail(`${row.capabilityId}: an external effect is only proposed`);
    }
  }
  return errors;
}

/** The two switches stay committed off until their reviewed commits (ADR-0027 item 11, ADR-0028 item 8). */
export function inspectAgentPlatformSwitches(loop, specialists) {
  const errors = [];
  const keys = (value) =>
    Object.keys(value ?? {})
      .sort()
      .join(",");
  if (
    keys(loop) !== "environment_kind,observed_on,schema_version,scope,switch,workflow" ||
    loop.schema_version !== 1 ||
    loop.environment_kind !== "staging" ||
    loop.workflow !== "agent-run@1" ||
    loop.switch !== "off" ||
    loop.observed_on !== null
  )
    errors.push("agent-loop-staging.json must be committed off (ADR-0027 item 11)");
  if (
    keys(specialists) !== "environment_kind,observed_on,release,schema_version,scope,switch" ||
    specialists.schema_version !== 1 ||
    specialists.environment_kind !== "staging" ||
    specialists.release !== "morrow.specialist" ||
    specialists.switch !== "off" ||
    specialists.observed_on !== null
  )
    errors.push("specialists-staging.json must be committed off (ADR-0028 item 8)");
  return errors;
}

/** The generated catalogue data: each tool with its strict input schema, and the digest. */
export function toolCatalogueData(catalogue, schemas) {
  const tools = catalogue.tools.map((tool) => ({
    ...tool,
    inputSchema: strictModelSchema(
      schemas.find((s) => s.$id === "urn:morrow:contracts:core:v1.1").$defs[tool.inputDefinition],
      schemas,
    ),
  }));
  const content = { schemaVersion: catalogue.schemaVersion, version: catalogue.version, tools };
  return { ...content, digest: sha256(jcs(content)) };
}

async function format(root, path, text) {
  const options = (await prettier.resolveConfig(resolve(root, path))) ?? {};
  return prettier.format(text, { ...options, parser: "typescript" });
}

/** Inspects every input and returns the generated files; throws with every problem. */
export async function generateAgentPlatform(root = repositoryRoot) {
  const catalogue = readJson(root, toolCataloguePath);
  const ceiling = readJson(root, specialistCeilingPath);
  const capabilities = readJson(root, capabilitiesPath).capabilities;
  const schemas = [readJson(root, coreV1Path), readJson(root, coreV11Path)];
  const { validators, currentDefinitionSelectors } = await import(resolve(root, validatorsPath));
  const validate = (value) =>
    validators[currentDefinitionSelectors.ToolCatalogue]?.(value) === true;
  const errors = [
    ...inspectToolCatalogue({ catalogue, capabilities, schemas, ceiling, validate }),
    ...inspectSpecialistCeiling(ceiling, capabilities),
    ...inspectAgentPlatformSwitches(
      readJson(root, agentLoopSwitchPath),
      readJson(root, specialistSwitchPath),
    ),
  ];
  if (errors.length) refuse("INVALID: " + errors.join("; "));
  const data = toolCatalogueData(catalogue, schemas);
  const tools = await format(
    root,
    generatedToolCataloguePath,
    "// Generated by scripts/generate-agent-platform.mjs from docs/contracts/tool-catalogue.json\n" +
      "// (ToolCatalogue@1; ADR-0027 item 3). Do not edit; run `npm run contracts:generate`.\n" +
      "// Data only: each tool's capability, verb, replay class, result bound, contexts and strict\n" +
      "// model input schema (from its v1.1 core definition; code validates every input again with\n" +
      "// the full definition). The digest is sha256 of the RFC 8785 text of everything but itself;\n" +
      "// a run manifest pins it.\n" +
      "export const generatedToolCatalogue = " +
      JSON.stringify(data, null, 2) +
      " as const;\n",
  );
  const specialist = await format(
    root,
    generatedSpecialistCeilingPath,
    "// Generated by scripts/generate-agent-platform.mjs from docs/contracts/specialist-ceiling.json\n" +
      "// (ADR-0028 item 2). Do not edit; run `npm run contracts:generate`. The most a\n" +
      "// task_specialist installation may hold at launch, as fixed ids.\n" +
      "export const generatedSpecialistCeiling = " +
      JSON.stringify(
        {
          release: ceiling.release,
          maxCapabilities: ceiling.maxCapabilities,
          capabilities: ceiling.capabilities,
          digest: sha256(jcs(ceiling.capabilities)),
        },
        null,
        2,
      ) +
      " as const;\n",
  );
  return {
    [generatedToolCataloguePath]: tools,
    [generatedSpecialistCeilingPath]: specialist,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputs = await generateAgentPlatform();
  for (const [path, text] of Object.entries(outputs)) {
    const target = resolve(repositoryRoot, path);
    if (process.argv.includes("--check")) {
      if (!existsSync(target) || readFileSync(target, "utf8") !== text)
        throw Error("AGENT_PLATFORM_DRIFT: " + path);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      console.log("Generated " + path + ".");
    }
  }
  if (process.argv.includes("--check"))
    console.log(
      "PASS: the tool catalogue, the Specialist ceiling and the committed-off agent switches reproduce and inspect clean.",
    );
}
