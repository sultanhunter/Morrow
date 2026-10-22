// M3 PR-2 (ADR-0022 item 2; spine section 9): ListingDraft_v1, the strict model output schema
// generated from the v1.1 core definition ListingDraft@1, stays inside Anthropic's structured
// output subset and its limits, and the contract definitions the gateway carries are closed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  listingDraftModelSchema as derive,
  generateListingDraftSchema,
} from "../scripts/generate-model-catalogue.mjs";
import {
  listingDraftModelSchema,
  listingDraftSchemaDigest,
} from "../packages/policy/src/generated/listing-draft-schema.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";

const core = JSON.parse(readFileSync("docs/contracts/schemas/v1.1/core.schema.json", "utf8"));
const jcs = (value) =>
  Array.isArray(value)
    ? "[" + value.map(jcs).join(",") + "]"
    : value && typeof value === "object"
      ? "{" +
        Object.keys(value)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + jcs(value[k]))
          .join(",") +
        "}"
      : JSON.stringify(value);

// Walks every schema node with its path.
function nodes(schema, at = "$", out = []) {
  out.push([at, schema]);
  if (schema.properties)
    for (const [k, v] of Object.entries(schema.properties)) nodes(v, at + "." + k, out);
  if (schema.items) nodes(schema.items, at + "[]", out);
  for (const [i, v] of (schema.anyOf ?? []).entries()) nodes(v, at + "|" + i, out);
  return out;
}

test("ListingDraft_v1 is the committed derivation of ListingDraft@1 and its digest is its JCS text's", async () => {
  assert.deepEqual(derive(core), JSON.parse(JSON.stringify(listingDraftModelSchema)));
  assert.equal(
    listingDraftSchemaDigest,
    createHash("sha256").update(jcs(listingDraftModelSchema)).digest("hex"),
  );
  assert.equal(
    await generateListingDraftSchema(),
    readFileSync("packages/policy/src/generated/listing-draft-schema.ts", "utf8"),
  );
});

test("ListingDraft_v1 stays inside the structured-output subset: closed objects, all required, no bounds", () => {
  const allowed = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "anyOf",
    "enum",
    "const",
  ]);
  for (const [at, node] of nodes(listingDraftModelSchema)) {
    for (const key of Object.keys(node)) assert.ok(allowed.has(key), at + " uses " + key);
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, at);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), at);
    }
    assert.equal(node.$ref, undefined, at);
  }
  // Anthropic's limits: at most 16 union-typed and 24 optional parameters per schema.
  const unions = nodes(listingDraftModelSchema).filter(([, n]) => Array.isArray(n.anyOf)).length;
  const optional = nodes(listingDraftModelSchema).filter(
    ([, n]) => n.type === "object" && Object.keys(n.properties).length !== n.required.length,
  ).length;
  assert.ok(unions <= 16, "union-typed " + unions);
  assert.equal(optional, 0);
  assert.equal(unions, 4);
  // Every top-level field is required; the four the contract leaves optional are nullable.
  assert.deepEqual(listingDraftModelSchema.required, [
    "productId",
    "title",
    "descriptionHtml",
    "seo",
    "tags",
  ]);
});

test("the derivation refuses a definition outside the subset", () => {
  const bad = structuredClone(core);
  bad.$defs.ListingDraft.properties.extra = { oneOf: [{ type: "string" }] };
  assert.throws(() => derive(bad), /MODEL_CATALOGUE_SCHEMA/);
  const open = structuredClone(core);
  open.$defs.ListingDraft.additionalProperties = true;
  assert.throws(() => derive(open), /MODEL_CATALOGUE_SCHEMA_OBJECT/);
  const remote = structuredClone(core);
  remote.$defs.ListingDraft.properties.productId = {
    $ref: "urn:morrow:contracts:core:v1#/$defs/Id",
  };
  assert.throws(() => derive(remote), /MODEL_CATALOGUE_SCHEMA_REF/);
});

const snapshot = {
  productId: "product:42",
  title: "Linen shirt",
  descriptionHtml: "<p>Soft.</p>",
  seo: { title: null, description: null },
  tags: ["linen"],
};
test("ModelCall@1 is closed and names no selection, catalogue version or provider", () => {
  const call = {
    schemaVersion: 1,
    purpose: "listing_draft",
    productIndex: 0,
    attempt: 1,
    sequence: 1,
    request: "Make it warmer",
    fields: ["descriptionHtml", "title"],
    product: snapshot,
  };
  assert.equal(validateCurrentDefinition("ModelCall", call), true);
  for (const extra of [
    { model: "claude_opus_5_5" },
    { selection: { model: "claude_opus_5_5", effort: "high" } },
    { catalogueVersion: 1 },
    { provider: "anthropic" },
    { maxTokens: 16000 },
  ])
    assert.equal(validateCurrentDefinition("ModelCall", { ...call, ...extra }), false);
  assert.equal(validateCurrentDefinition("ModelCall", { ...call, attempt: 3 }), false);
  assert.equal(validateCurrentDefinition("ModelCall", { ...call, fields: ["price"] }), false);
});

test("ModelResult@1 is closed: no provider request id, model id or raw stop reason", () => {
  const result = {
    schemaVersion: 1,
    outcome: "completed",
    output: { productId: "product:42", title: "Linen shirt, relaxed fit" },
    usage: { inputTokens: 1200, outputTokens: 300 },
    traceRef: { kind: "model_call", id: "0b7f1f4e-8f5c-4a35-9c1a-1d6f0f3d2a11" },
    retryAfterMs: null,
  };
  assert.equal(validateCurrentDefinition("ModelResult", result), true);
  for (const extra of [
    { providerRequestId: "req_1" },
    { providerModelId: "claude-sonnet-5-5" },
    { stopReason: "end_turn" },
  ])
    assert.equal(validateCurrentDefinition("ModelResult", { ...result, ...extra }), false);
  assert.equal(
    validateCurrentDefinition("ModelResult", { ...result, outcome: "fallback_used" }),
    false,
  );
});

test("CoordinatorRoute@1 and CatalogContentChangeSet@1 are closed records of ids and exact changes", () => {
  const route = {
    schemaVersion: 1,
    dispatcher: "builtin_coordinator",
    specialist: "morrow.listings",
    organizationId: "org_o",
    workspaceId: "ws_w",
    runId: "run_1",
    taskId: "task_1",
    childTaskId: "task_2",
    installationId: "inst_1",
    storeId: "store_1",
    connectionId: "conn_1",
    products: ["product:1", "product:2"],
    fields: ["descriptionHtml", "title"],
  };
  assert.equal(validateCurrentDefinition("CoordinatorRoute", route), true);
  assert.equal(
    validateCurrentDefinition("CoordinatorRoute", {
      ...route,
      products: ["product:1", "product:1"],
    }),
    false,
  );
  assert.equal(validateCurrentDefinition("CoordinatorRoute", { ...route, model: "x" }), false);
  const changes = {
    schemaVersion: 1,
    storeId: "store_1",
    items: [{ targetIndex: 0, productId: "product:1", set: { title: "New" } }],
  };
  assert.equal(validateCurrentDefinition("CatalogContentChangeSet", changes), true);
  for (const set of [{}, { note: "x" }, { title: "x".repeat(256) }, { seo: { title: "t" } }])
    assert.equal(
      validateCurrentDefinition("CatalogContentChangeSet", {
        ...changes,
        items: [{ ...changes.items[0], set }],
      }),
      false,
      JSON.stringify(set),
    );
  assert.equal(
    validateCurrentDefinition("ListingDraft", {
      productId: "product:1",
      tags: Array(51).fill("a"),
    }),
    false,
  );
});
