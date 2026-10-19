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
    // Billing routes by origin (ADR-0015; P01.T04a).
    {
      kind: "billing-v1.1",
      path: "docs/contracts/schemas/v1.1/billing.schema.json",
      prefix: "BillingV1_1",
    },
  ].map((source) => Object.freeze(source)),
);

// Declared replacements of v1 definitions and capability bodies.
export const changesPath = "docs/contracts/schemas/v1.1/changes.json";

// Effective selection, highest precedence first: a definition resolves to the
// newest core layer that defines it, a capability body to the newest
// capabilities layer, and a billing definition to the newest billing layer.
export const definitionLayers = Object.freeze(["core-v1.1", "core"]);
export const bodyLayers = Object.freeze(["capabilities-v1.1", "capabilities"]);
export const billingLayers = Object.freeze(["billing-v1.1", "billing"]);

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

function layeredSelectors(byKind, layers) {
  const selectors = {};
  for (const kind of [...layers].reverse())
    for (const name of Object.keys(byKind[kind].$defs)) selectors[name] = `${kind}:${name}`;
  return Object.fromEntries(Object.entries(selectors).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Maps schemas keyed by source kind to effective `Name -> "kind:Name"` selectors. */
export const currentDefinitionSelectors = (byKind) => layeredSelectors(byKind, definitionLayers);

/** Effective billing `Name -> "kind:Name"` selectors: the newest billing layer that defines it. */
export const currentBillingDefinitionSelectors = (byKind) =>
  layeredSelectors(byKind, billingLayers);

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

// The additive event registry of EventEnvelope@2 (ADR-0016 item 6; P01.T02c §8).
export const eventRegistryPath = "docs/contracts/event-registry.json";

/** Reads the event registry as parsed JSON. */
export const readEventRegistry = (root = repositoryRoot) =>
  JSON.parse(readFileSync(resolve(root, eventRegistryPath), "utf8"));

const eventTypePattern = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const aggregateTypePattern = /^[a-z][a-z_]{0,63}$/;
const registryRowKeys = "aggregateType,eventType,payloadDefinition,producer,since";
// A row's `since`: a contract minor from 1.1 (the registry's first) through the
// current contract version, so a later v1.x minor appends rows without editing
// this check; release-baseline.json pins the rows themselves.
export const eventRegistrySince = Object.freeze(
  (() => {
    const [, major, minor] = /v(\d+)\.(\d+)$/.exec(contractVersion);
    return Array.from({ length: Number(minor) }, (_, i) => `${major}.${i + 1}`);
  })(),
);

/**
 * Maps each registered event type to its aggregate type and the exact selector
 * of its payload definition (the newest core layer that defines it). Throws on
 * a malformed row: a closed row of five strings, a well-formed and unique event
 * type, an aggregate type equal to its first segment, a payload definition that
 * exists and ends in "Payload", and a `since` in `eventRegistrySince`.
 */
export function eventPayloadSelectors(byKind, registry) {
  if (
    registry === null ||
    typeof registry !== "object" ||
    registry.schema_version !== 1 ||
    !Array.isArray(registry.events)
  )
    throw Error("EVENT_REGISTRY_INVALID");
  const current = currentDefinitionSelectors(byKind);
  const rows = {};
  for (const row of registry.events) {
    const valid =
      row !== null &&
      typeof row === "object" &&
      Object.keys(row).sort().join() === registryRowKeys &&
      Object.values(row).every((value) => typeof value === "string" && value.trim() !== "") &&
      eventTypePattern.test(row.eventType) &&
      row.eventType.length <= 128 &&
      aggregateTypePattern.test(row.aggregateType) &&
      row.aggregateType === row.eventType.split(".")[0] &&
      /Payload$/.test(row.payloadDefinition) &&
      Object.hasOwn(current, row.payloadDefinition) &&
      eventRegistrySince.includes(row.since) &&
      !Object.hasOwn(rows, row.eventType);
    if (!valid) throw Error("EVENT_REGISTRY_INVALID:" + JSON.stringify(row?.eventType ?? row));
    rows[row.eventType] = {
      aggregateType: row.aggregateType,
      selector: current[row.payloadDefinition],
    };
  }
  return rows;
}
