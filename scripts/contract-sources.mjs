// The one source of the contract version and of the schema files that make up
// the contract set (docs/contracts/contract-versions.md). The generators,
// contract checks and labs read this module; packages/contracts re-exports the
// version from the generated domain types, so no other file declares it.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const contractVersion = "morrow.contracts.v1.1";

// Append-only. Generated validator export names (v0, v1, ...) and type prefixes
// follow this order, so appending a source keeps every existing name stable.
export const schemaSources = Object.freeze(
  [
    { kind: "core", path: "docs/contracts/schemas/v1/core.schema.json", prefix: "Core" },
    {
      kind: "capabilities",
      path: "docs/contracts/schemas/v1/capabilities.schema.json",
      prefix: "Capability",
    },
    { kind: "billing", path: "docs/contracts/schemas/v1/billing.schema.json", prefix: "Billing" },
    {
      kind: "core-v1.1",
      path: "docs/contracts/schemas/v1.1/core.schema.json",
      prefix: "CoreV1_1",
    },
    {
      kind: "capabilities-v1.1",
      path: "docs/contracts/schemas/v1.1/capabilities.schema.json",
      prefix: "CapabilityV1_1",
    },
  ].map((source) => Object.freeze(source)),
);

// Declared replacements of v1 definitions and capability bodies.
export const changesPath = "docs/contracts/schemas/v1.1/changes.json";

// Effective selection, highest precedence first: a definition resolves to the
// newest core layer that defines it, a capability body to the newest
// capabilities layer. Billing is not layered; it stays at v1.
export const definitionLayers = Object.freeze(["core-v1.1", "core"]);
export const bodyLayers = Object.freeze(["capabilities-v1.1", "capabilities"]);

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Reads every source, in source order, as text and parsed JSON. */
export function readSchemaSources(root = repositoryRoot) {
  return schemaSources.map((source) => {
    const text = readFileSync(resolve(root, source.path), "utf8");
    return { ...source, text, schema: JSON.parse(text) };
  });
}

/** Keys parsed sources by kind. */
export const schemasByKind = (sources) =>
  Object.fromEntries(sources.map((source) => [source.kind, source.schema]));

/** Maps schemas keyed by source kind to effective `Name -> "kind:Name"` selectors. */
export function currentDefinitionSelectors(byKind) {
  const selectors = {};
  for (const kind of [...definitionLayers].reverse())
    for (const name of Object.keys(byKind[kind].$defs)) selectors[name] = `${kind}:${name}`;
  return Object.fromEntries(Object.entries(selectors).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Maps capability IDs to effective `"<id>.<io>" -> "kind:<id>.<io>"` body selectors. */
export function capabilityBodySelectors(byKind, capabilityIds) {
  const selectors = {};
  for (const id of capabilityIds)
    for (const io of ["input", "output"]) {
      const name = `${id}.${io}`;
      const kind = bodyLayers.find((layer) => Object.hasOwn(byKind[layer].$defs, name));
      if (!kind) throw Error("Missing capability body " + name);
      selectors[name] = `${kind}:${name}`;
    }
  return selectors;
}

/**
 * Returns the effective body schemas, `"<id>.<io>" -> schema`, for catalogue
 * checks. A missing body is left out, so the catalogue check reports it.
 */
export function effectiveBodies(byKind, capabilityIds) {
  const bodies = {};
  for (const id of capabilityIds)
    for (const io of ["input", "output"]) {
      const name = `${id}.${io}`;
      const kind = bodyLayers.find((layer) => Object.hasOwn(byKind[layer].$defs, name));
      if (kind) bodies[name] = byKind[kind].$defs[name];
    }
  return bodies;
}

/** The effective bodies for the catalogue on disk. */
export function readEffectiveBodies(capabilityIds, root = repositoryRoot) {
  return effectiveBodies(schemasByKind(readSchemaSources(root)), capabilityIds);
}
