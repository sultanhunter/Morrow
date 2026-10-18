import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  contractVersion,
  changesPath,
  readSchemaSources,
  repositoryRoot,
  schemasByKind,
  currentDefinitionSelectors,
  currentBillingDefinitionSelectors,
  capabilityBodySelectors,
} from "./contract-sources.mjs";

const identifier = (n) => n.replace(/[^A-Za-z0-9_]/g, "_");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const domainPath = "packages/contracts/src/generated/domain.ts";
export const manifestPath = "packages/contracts/src/generated/manifest.json";

// Pure: reads the reviewed sources and returns the generated files. Writing and
// drift checks live in the command below. Generation never writes the
// compatibility baseline (docs/contracts/release-baseline.json).
export function generateContracts(root = repositoryRoot) {
  const sources = readSchemaSources(root);
  const byKind = schemasByKind(sources);
  const names = new Map();
  for (const source of sources)
    for (const key of Object.keys(source.schema.$defs)) {
      const name = source.prefix + "_" + identifier(key);
      if ([...names.values()].includes(name)) throw Error("Generated name collision");
      names.set(source.schema.$id + "#/$defs/" + key, name);
    }
  const nameOf = (selector) => {
    const separator = selector.indexOf(":");
    const source = sources.find((s) => s.kind === selector.slice(0, separator));
    const name = names.get(source.schema.$id + "#/$defs/" + selector.slice(separator + 1));
    if (!name) throw Error("Unknown selector " + selector);
    return name;
  };
  function localRefs(value, base) {
    if (Array.isArray(value)) return value.map((v) => localRefs(v, base));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          k === "$ref" && typeof v === "string" && v.startsWith("#")
            ? base + v
            : localRefs(v, base),
        ]),
      );
    return value;
  }
  function type(s) {
    if (s === true) return "unknown";
    if (s === false) return "never";
    if (s.$ref) {
      const name = names.get(s.$ref);
      if (!name) throw Error("Unknown schema ref " + s.$ref);
      return name;
    }
    if ("const" in s) return JSON.stringify(s.const);
    if (s.enum) return s.enum.map((x) => JSON.stringify(x)).join(" | ");
    if (s.anyOf) return "(" + s.anyOf.map(type).join(" | ") + ")";
    if (s.oneOf) return "(" + s.oneOf.map(type).join(" | ") + ")";
    if (s.allOf)
      return (
        "(" +
        [
          ...s.allOf.map(type),
          type(Object.fromEntries(Object.entries(s).filter(([k]) => k !== "allOf"))),
        ].join(" & ") +
        ")"
      );
    if (Array.isArray(s.type))
      return "(" + s.type.map((t) => type({ ...s, type: t })).join(" | ") + ")";
    if (s.type === "null") return "null";
    if (["string", "boolean"].includes(s.type)) return s.type;
    if (["integer", "number"].includes(s.type)) return "number";
    if (s.type === "array") {
      if (!s.items) throw Error("Unspecified items");
      return `Array<${type(s.items)}>`;
    }
    if (s.type === "object" || s.properties) {
      if (s.additionalProperties !== false)
        throw Error("Object is not closed; review generator semantics");
      return (
        "{ " +
        Object.entries(s.properties ?? {})
          .map(([k, v]) => `${JSON.stringify(k)}${s.required?.includes(k) ? "" : "?"}: ${type(v)};`)
          .join(" ") +
        " }"
      );
    }
    // Conditional constraints refine runtime validity but have no independent base structural type.
    if (s.if && s.then) return "unknown";
    const metadata = ["title", "description", "$comment", "default"];
    if (Object.keys(s).every((k) => metadata.includes(k))) return "unknown";
    throw Error("Unsupported structural schema: " + JSON.stringify(s).slice(0, 200));
  }
  const catalogue = JSON.parse(
    readFileSync(resolve(root, "docs/contracts/capabilities.json"), "utf8"),
  );
  const changes = JSON.parse(readFileSync(resolve(root, changesPath), "utf8"));
  const current = currentDefinitionSelectors(byKind);
  const currentBilling = currentBillingDefinitionSelectors(byKind);
  const bodies = capabilityBodySelectors(
    byKind,
    catalogue.capabilities.map((c) => c.id),
  );
  let output =
    "// Generated from reviewed JSON Schema; do not edit. Runtime schemas enforce conditional/format/range/exactness rules.\n";
  output += `export const contractVersion = ${JSON.stringify(contractVersion)} as const;\n`;
  for (const source of sources)
    for (const [key, value] of Object.entries(source.schema.$defs))
      output += `export type ${names.get(source.schema.$id + "#/$defs/" + key)} = ${type(localRefs(value, source.schema.$id))};\n`;
  // Effective definitions: product code uses these, never a replaced v1 shape.
  output += "export interface CurrentDefinitions {\n";
  for (const [name, selector] of Object.entries(current))
    output += `  ${JSON.stringify(name)}: ${nameOf(selector)};\n`;
  output += "}\nexport type CurrentDefinitionName = keyof CurrentDefinitions;\n";
  for (const [name, selector] of Object.entries(current))
    output += `export type Current_${identifier(name)} = ${nameOf(selector)};\n`;
  // Effective billing definitions (newest billing layer; ADR-0015).
  output += "export interface CurrentBillingDefinitions {\n";
  for (const [name, selector] of Object.entries(currentBilling))
    output += `  ${JSON.stringify(name)}: ${nameOf(selector)};\n`;
  output += "}\nexport type CurrentBillingDefinitionName = keyof CurrentBillingDefinitions;\n";
  for (const [name, selector] of Object.entries(currentBilling))
    output += `export type CurrentBilling_${identifier(name)} = ${nameOf(selector)};\n`;
  output += "export interface CapabilityBodies {\n";
  for (const c of catalogue.capabilities)
    output += `  ${JSON.stringify(c.id)}: { input: ${nameOf(bodies[c.id + ".input"])}; output: ${nameOf(bodies[c.id + ".output"])}; };\n`;
  output +=
    '}\nexport type CapabilityId = keyof CapabilityBodies;\nexport type CapabilityInput<K extends CapabilityId> = CapabilityBodies[K]["input"];\nexport type CapabilityOutput<K extends CapabilityId> = CapabilityBodies[K]["output"];\n';
  if (output.includes("undefined")) throw Error("Unresolved capability type");
  const manifest = {
    schema_version: 2,
    contract_version: contractVersion,
    schemas: Object.fromEntries(sources.map((s) => [s.path, sha256(s.text)])),
    replacements: changes.changes.map(({ kind, name, replaces, adr }) => ({
      kind,
      name,
      replaces,
      adr,
    })),
    definitions: names.size,
    definitions_by_source: Object.fromEntries(
      sources.map((s) => [s.kind, Object.keys(s.schema.$defs).length]),
    ),
    current_definitions: Object.keys(current).length,
    current_billing_definitions: Object.keys(currentBilling).length,
    capabilities: catalogue.capabilities.length,
    capability_body_overrides: Object.values(bodies).filter(
      (selector) => !selector.startsWith("capabilities:"),
    ).length,
    generated_sha256: sha256(output),
  };
  return {
    files: { [domainPath]: output, [manifestPath]: JSON.stringify(manifest, null, 2) + "\n" },
    manifest,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, manifest } = generateContracts();
  if (process.argv.includes("--check")) {
    for (const [path, text] of Object.entries(files))
      if (readFileSync(resolve(repositoryRoot, path), "utf8") !== text)
        throw Error("Generated contract drift; regenerate and review");
  } else {
    mkdirSync(resolve(repositoryRoot, "packages/contracts/src/generated"), { recursive: true });
    for (const [path, text] of Object.entries(files))
      writeFileSync(resolve(repositoryRoot, path), text);
  }
  console.log(
    `PASS: ${manifest.definitions} generated definitions (${manifest.current_definitions} current) and ${manifest.capabilities} capability pairs (${manifest.capability_body_overrides} v1.1 body overrides); ${manifest.contract_version}.`,
  );
}
