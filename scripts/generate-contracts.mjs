import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
const paths = ["core", "capabilities", "billing"].map(
  (n) => `docs/contracts/schemas/v1/${n}.schema.json`,
);
const schemas = paths.map((p) => JSON.parse(readFileSync(p, "utf8")));
const prefixes = ["Core", "Capability", "Billing"];
const names = new Map(),
  ids = new Map();
const identifier = (n) => n.replace(/[^A-Za-z0-9_]/g, "_");
schemas.forEach((s, i) => {
  ids.set(s.$id, i);
  for (const key of Object.keys(s.$defs)) {
    const name = prefixes[i] + "_" + identifier(key);
    if ([...names.values()].includes(name)) throw Error("Generated name collision");
    names.set(s.$id + "#/$defs/" + key, name);
  }
});
function localRefs(value, base) {
  if (Array.isArray(value)) return value.map((v) => localRefs(v, base));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === "$ref" && typeof v === "string" && v.startsWith("#") ? base + v : localRefs(v, base),
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
const hashes = Object.fromEntries(
  paths.map((p) => [p, createHash("sha256").update(readFileSync(p)).digest("hex")]),
);
let output =
  "// Generated from reviewed JSON Schema; do not edit. Runtime schemas enforce conditional/format/range/exactness rules.\n";
schemas.forEach((s) => {
  for (const [key, value] of Object.entries(s.$defs))
    output += `export type ${names.get(s.$id + "#/$defs/" + key)} = ${type(localRefs(value, s.$id))};\n`;
});
const catalogue = JSON.parse(readFileSync("docs/contracts/capabilities.json", "utf8"));
output += "export interface CapabilityBodies {\n";
for (const c of catalogue.capabilities) {
  const id = c.id;
  output += `  ${JSON.stringify(id)}: { input: ${names.get(schemas[1].$id + "#/$defs/" + id + ".input")}; output: ${names.get(schemas[1].$id + "#/$defs/" + id + ".output")}; };\n`;
}
output +=
  '}\nexport type CapabilityId = keyof CapabilityBodies;\nexport type CapabilityInput<K extends CapabilityId> = CapabilityBodies[K]["input"];\nexport type CapabilityOutput<K extends CapabilityId> = CapabilityBodies[K]["output"];\n';
if (output.includes("undefined")) throw Error("Unresolved capability type");
mkdirSync("packages/contracts/src/generated", { recursive: true });
const manifest = {
  schema_version: 1,
  schemas: hashes,
  definitions: names.size,
  capabilities: catalogue.capabilities.length,
  generated_sha256: createHash("sha256").update(output).digest("hex"),
};
const manifestText = JSON.stringify(manifest, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (
    readFileSync("packages/contracts/src/generated/domain.ts", "utf8") !== output ||
    readFileSync("packages/contracts/src/generated/manifest.json", "utf8") !== manifestText
  )
    throw Error("Generated contract drift; regenerate and review");
} else {
  writeFileSync("packages/contracts/src/generated/domain.ts", output);
  writeFileSync("packages/contracts/src/generated/manifest.json", manifestText);
}
if (!existsSync("docs/contracts/release-baseline.json"))
  writeFileSync(
    "docs/contracts/release-baseline.json",
    JSON.stringify(
      {
        status: "unreleased_v1_documentary_freeze",
        schemas: hashes,
        change_policy:
          "Any schema delta requires reviewed compatibility/migration evidence and deliberate baseline update; generation never updates this baseline.",
      },
      null,
      2,
    ) + "\n",
  );
console.log(
  `PASS: ${names.size} generated definitions and ${catalogue.capabilities.length} capability pairs.`,
);
