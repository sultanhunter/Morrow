// The model catalogue generator (ADR-0022 items 10, 11 and 16; M3 PR-1). It reads the
// reviewed catalogue in docs/decisions/model-policy.json, refuses it unless
// `inspectModelPolicy` passes (pinned digests, adaptive thinking, margins, caps), and
// writes packages/policy/src/generated/model-catalogue.ts: data only, for the api's
// checks and, in M3 PR-2, the broker. Keys stay opaque strings; nothing here becomes a
// contract enum. Every money value is an exact integer count of 10^-8 USD (the
// numeric(20,8) of the run-credit tables): a rate that does not divide exactly refuses.
// `--check` compares the committed file byte for byte (verify:boundaries).
// M3 PR-2 (ADR-0022 item 2): it also writes packages/policy/src/generated/listing-draft-schema.ts,
// ListingDraft_v1, the strict model output schema derived from the v1.1 core definition
// ListingDraft@1 (listingDraftModelSchema below), and its digest, which the run manifest binds.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { repositoryRoot } from "./artifacts.mjs";
import { catalogueVersionDigest, inspectModelPolicy } from "./provider-checks.mjs";

export const modelCataloguePath = "packages/policy/src/generated/model-catalogue.ts";
export const listingDraftSchemaPath = "packages/policy/src/generated/listing-draft-schema.ts";
const coreSchemaPath = "docs/contracts/schemas/v1.1/core.schema.json";
const policyPath = "docs/decisions/model-policy.json";
const registryPath = "docs/decisions/providers.json";
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,8})?$/;

const refuse = (code) => {
  throw Error("MODEL_CATALOGUE_" + code);
};
// A decimal string as an exact integer count of 10^-places units, or a refusal.
function scaled(text, places) {
  if (typeof text !== "string" || !DECIMAL.test(text)) refuse("DECIMAL_INVALID");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > places) refuse("DECIMAL_INEXACT");
  return BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, "0") || "0");
}
const count = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) refuse("COUNT_INVALID");
  return value;
};

/**
 * The generated data of one catalogue version. Rates become exact 10^-8 USD per token
 * (a per-million rate has at most two decimals, so `rate * 100` is whole); caps become
 * exact 10^-8 USD. Throws MODEL_CATALOGUE_* for anything it cannot represent exactly.
 */
export function catalogueVersionData(entry) {
  if (!["active", "retired", "proposed"].includes(entry.status)) refuse("STATUS_INVALID");
  const limits = entry.limits ?? {};
  const efforts = (entry.efforts ?? []).map((effort) => {
    if (!KEY.test(effort.key ?? "")) refuse("KEY_INVALID");
    return { key: effort.key, maxOutputTokens: count(effort.max_output_tokens) };
  });
  const models = (entry.models ?? []).map((model) => {
    if (!KEY.test(model.key ?? "")) refuse("KEY_INVALID");
    const rates = model.rates_usd_per_million_tokens ?? {};
    // Per token in 10^-8 USD is the per-million rate times 100: exact only for a rate with
    // at most two decimals, which `scaled` enforces (DECIMAL_INEXACT otherwise).
    const perToken = (text) => Number(scaled(text, 2));
    const credits = {};
    for (const effort of efforts)
      credits[effort.key] = count(model.credits_per_product?.[effort.key]);
    if (Object.keys(model.credits_per_product ?? {}).length !== efforts.length)
      refuse("CREDITS_INVALID");
    return {
      key: model.key,
      provider: model.provider,
      providerModelId: model.provider_model_id,
      inputUsd8PerToken: perToken(rates.input),
      outputUsd8PerToken: perToken(rates.output),
      creditsPerProduct: credits,
    };
  });
  const usd8 = (text) => {
    const units = scaled(text, 8);
    if (units > BigInt(Number.MAX_SAFE_INTEGER)) refuse("CAP_TOO_LARGE");
    return Number(units);
  };
  return {
    version: count(entry.version),
    status: entry.status,
    digest: catalogueVersionDigest(entry),
    effectiveFrom: entry.effective_from ?? null,
    defaultSelection: {
      model: entry.default_selection.model,
      effort: entry.default_selection.effort,
    },
    defaultMemberCreditCeiling: count(entry.default_member_credit_ceiling),
    limits: {
      maxInputTokensPerCall: count(limits.max_input_tokens_per_call),
      maxAttemptsPerProduct: count(limits.max_attempts_per_product),
      maxProductsPerRun: count(limits.max_products_per_run),
      maxConsecutiveFailedProducts: count(limits.max_consecutive_failed_products),
      runCostCapUsd8: usd8(limits.run_cost_cap_usd),
      workspaceDailyCostCapUsd8: usd8(limits.workspace_daily_cost_cap_usd),
      workspacePeriodUnrecoveredCostCapUsd8: usd8(limits.workspace_period_unrecovered_cost_cap_usd),
    },
    efforts,
    models,
  };
}

/** The generated module text (prettier-formatted), from the reviewed policy files. */
export async function generateModelCatalogue(root = repositoryRoot) {
  const policy = JSON.parse(readFileSync(resolve(root, policyPath), "utf8"));
  const registry = JSON.parse(readFileSync(resolve(root, registryPath), "utf8"));
  const inspected = inspectModelPolicy(policy, registry);
  if (inspected.errors.length) refuse("POLICY_INVALID: " + inspected.errors.join("; "));
  const catalogue = policy.catalogue;
  // Per-product versions only (listings-run@1); loop versions are loop-catalogue.ts's (PR 10).
  const versions = catalogue.versions
    .filter((entry) => entry.run_shape === undefined)
    .map(catalogueVersionData);
  // Published versions carry their pinned digest; the generator never moves one.
  for (const version of versions)
    if (
      version.status !== "proposed" &&
      catalogue.published_digests[String(version.version)] !== version.digest
    )
      refuse("DIGEST_DRIFT");
  const data = { id: catalogue.id, activeVersion: catalogue.active_version ?? null, versions };
  const text =
    "// Generated by scripts/generate-model-catalogue.mjs from docs/decisions/model-policy.json\n" +
    "// (ADR-0022 items 10, 11 and 16). Do not edit; run `npm run contracts:generate`.\n" +
    "// Data only: opaque keys, exact 10^-8 USD integers, pinned version digests. Provider\n" +
    "// model IDs are for the broker (M3 PR-2) and never reach an api response.\n" +
    "export const generatedModelCatalogue = " +
    JSON.stringify(data, null, 2) +
    " as const;\n";
  const options = (await prettier.resolveConfig(resolve(root, modelCataloguePath))) ?? {};
  return prettier.format(text, { ...options, parser: "typescript" });
}

export const loopCataloguePath = "packages/policy/src/generated/loop-catalogue.ts";
const usd12 = (text) => {
  const units = scaled(text, 12);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) refuse("CAP_TOO_LARGE");
  return Number(units);
};
/**
 * The generated data of one loop version (ADR-0027 items 6 and 12; PR 10). Money is exact
 * 10^-12 USD: a per-million rate times 10^6 per token (Haiku 5.5's US$0.125 cache write is
 * 0.125 of a 10^-6 USD, so the 10^-8 unit of version 1 cannot hold it).
 */
export function loopCatalogueVersionData(entry) {
  if (entry.run_shape !== "agent_loop") refuse("RUN_SHAPE_INVALID");
  if (!["active", "retired", "proposed"].includes(entry.status)) refuse("STATUS_INVALID");
  const limits = entry.limits ?? {};
  const perToken = (text) => {
    const units = scaled(text, 6);
    if (units > BigInt(Number.MAX_SAFE_INTEGER)) refuse("RATE_TOO_LARGE");
    return Number(units);
  };
  const profile = (kind) => ({
    model: entry.default_profiles[kind].model,
    effort: entry.default_profiles[kind].effort,
  });
  return {
    version: count(entry.version),
    status: entry.status,
    digest: catalogueVersionDigest(entry),
    effectiveFrom: entry.effective_from ?? null,
    defaultProfiles: {
      coordinator: profile("coordinator"),
      specialist: profile("specialist"),
      installed: profile("installed"),
    },
    limits: {
      maxInputTokensPerTurn: count(limits.max_input_tokens_per_turn),
      maxTurnsPerRun: count(limits.max_turns_per_run),
      maxTurnsPerCoordinatorRun: count(limits.max_turns_per_coordinator_run),
      maxToolCallsPerTurn: count(limits.max_tool_calls_per_turn),
      maxToolCallsPerRun: count(limits.max_tool_calls_per_run),
      maxQuestionsPerRun: limits.max_questions_per_run,
      questionWaitHours: count(limits.question_wait_hours),
      wallTimeMinutes: count(limits.wall_time_minutes),
      specialistDefaultRunMinutes: count(limits.specialist_default_run_minutes),
      specialistMaxRunMinutes: count(limits.specialist_max_run_minutes),
      toolResultMaxBytes: count(limits.tool_result_max_bytes),
      runCostCapUsd12: usd12(limits.run_cost_cap_usd),
      workspaceDailyCostCapUsd12: usd12(limits.workspace_daily_cost_cap_usd),
      workspacePeriodUnrecoveredCostCapUsd12: usd12(
        limits.workspace_period_unrecovered_cost_cap_usd,
      ),
    },
    expectedTurn: {
      inputTokens: count(entry.expected_turn.input_tokens),
      cachedPrefixTokens: count(entry.expected_turn.cached_prefix_tokens),
    },
    efforts: entry.efforts.map((effort) => ({
      key: effort.key,
      maxOutputTokens: count(effort.max_output_tokens),
      expectedOutputTokens: count(effort.expected_output_tokens),
    })),
    models: entry.models.map((model) => {
      const rates = model.rates_usd_per_million_tokens;
      return {
        key: model.key,
        provider: model.provider,
        providerModelId: model.provider_model_id,
        usd12PerToken: {
          input: perToken(rates.input),
          output: perToken(rates.output),
          cacheWrite: perToken(rates.cache_write_5m),
          cacheRead: perToken(rates.cache_read),
        },
      };
    }),
  };
}

/** The generated loop catalogue module text (PR 10), from the reviewed policy files. */
export async function generateLoopCatalogue(root = repositoryRoot) {
  const policy = JSON.parse(readFileSync(resolve(root, policyPath), "utf8"));
  const registry = JSON.parse(readFileSync(resolve(root, registryPath), "utf8"));
  const inspected = inspectModelPolicy(policy, registry);
  if (inspected.errors.length) refuse("POLICY_INVALID: " + inspected.errors.join("; "));
  const catalogue = policy.catalogue;
  const versions = catalogue.versions
    .filter((entry) => entry.run_shape === "agent_loop")
    .map(loopCatalogueVersionData);
  for (const version of versions)
    if (
      version.status !== "proposed" &&
      catalogue.published_digests[String(version.version)] !== version.digest
    )
      refuse("DIGEST_DRIFT");
  const data = { id: catalogue.id, activeVersion: catalogue.active_version ?? null, versions };
  const text =
    "// Generated by scripts/generate-model-catalogue.mjs from docs/decisions/model-policy.json\n" +
    "// (ADR-0027 items 6 and 12; PR 10). Do not edit; run `npm run contracts:generate`.\n" +
    "// The agent-loop versions only: opaque keys, exact 10^-12 USD integers, pinned version\n" +
    "// digests. A proposed version is data for previews and tests; admission takes only a\n" +
    "// published one. Provider model IDs are for the broker and never reach an api response.\n" +
    "export const generatedLoopCatalogue = " +
    JSON.stringify(data, null, 2) +
    " as const;\n";
  const options = (await prettier.resolveConfig(resolve(root, loopCataloguePath))) ?? {};
  return prettier.format(text, { ...options, parser: "typescript" });
}

// The keywords Anthropic's structured outputs do not accept (S156): string-length, numeric
// and array bounds and patterns. Code checks them again with the full contract definition.
const unsupportedKeywords = new Set([
  "description",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "uniqueItems",
  "pattern",
  "minProperties",
]);
/**
 * ListingDraft_v1 (ADR-0022 item 2; spine section 9): the strict model output schema of the
 * v1.1 core definition ListingDraft@1. Local references are inlined; every object lists
 * all its properties as required with additionalProperties false, and a property the
 * contract leaves optional becomes nullable (anyOf with null); the keywords structured
 * outputs refuse are dropped. Throws on anything else (another $ref, a nested union).
 */
export function listingDraftModelSchema(core) {
  const defs = core?.$defs;
  if (!defs || typeof defs !== "object" || !defs.ListingDraft) refuse("LISTING_DRAFT_MISSING");
  const convert = (node, depth) => {
    if (depth > 8 || !node || typeof node !== "object" || Array.isArray(node))
      refuse("SCHEMA_SHAPE");
    if (node.$ref !== undefined) {
      const match = /^#\/\$defs\/([A-Za-z0-9]+)$/.exec(node.$ref);
      if (!match || !defs[match[1]] || Object.keys(node).length !== 1) refuse("SCHEMA_REF");
      return convert(defs[match[1]], depth + 1);
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (unsupportedKeywords.has(key)) continue;
      if (key === "properties" || key === "required" || key === "items" || key === "anyOf")
        continue;
      if (!["type", "enum", "const", "additionalProperties"].includes(key))
        refuse("SCHEMA_KEYWORD:" + key);
      out[key] = value;
    }
    if (node.type === "object") {
      if (node.additionalProperties !== false || !node.properties) refuse("SCHEMA_OBJECT");
      const required = new Set(node.required ?? []);
      out.properties = {};
      for (const [name, child] of Object.entries(node.properties)) {
        const converted = convert(child, depth + 1);
        out.properties[name] = required.has(name)
          ? converted
          : { anyOf: [converted, { type: "null" }] };
      }
      out.required = Object.keys(node.properties);
      out.additionalProperties = false;
    } else if (node.type === "array") {
      out.items = convert(node.items, depth + 1);
    } else if (node.anyOf !== undefined || !["string", "integer", "boolean"].includes(node.type)) {
      refuse("SCHEMA_TYPE");
    }
    return out;
  };
  return convert(defs.ListingDraft, 0);
}
// RFC 8785 (JCS) text of plain JSON data: sorted keys, no whitespace.
const jcs = (value) =>
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
/** The generated ListingDraft_v1 module text (prettier-formatted). */
export async function generateListingDraftSchema(root = repositoryRoot) {
  const core = JSON.parse(readFileSync(resolve(root, coreSchemaPath), "utf8"));
  const schema = listingDraftModelSchema(core);
  const digest = createHash("sha256").update(jcs(schema), "utf8").digest("hex");
  const text =
    "// Generated by scripts/generate-model-catalogue.mjs from the v1.1 core definition\n" +
    "// ListingDraft@1 (ADR-0022 item 2). Do not edit; run `npm run contracts:generate`.\n" +
    "// ListingDraft_v1: the strict model output schema (every field required and nullable, no\n" +
    "// length keywords). The broker sends it as output_config.format and the run manifest binds\n" +
    "// its digest (sha256 of its RFC 8785 text); the full ListingDraft@1 checks the output again.\n" +
    "export const listingDraftSchemaDigest = " +
    JSON.stringify(digest) +
    ";\n" +
    "export const listingDraftModelSchema = " +
    JSON.stringify(schema, null, 2) +
    " as const;\n";
  const options = (await prettier.resolveConfig(resolve(root, listingDraftSchemaPath))) ?? {};
  return prettier.format(text, { ...options, parser: "typescript" });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputs = [
    [modelCataloguePath, await generateModelCatalogue()],
    [listingDraftSchemaPath, await generateListingDraftSchema()],
    [loopCataloguePath, await generateLoopCatalogue()],
  ];
  for (const [path, text] of outputs) {
    const target = resolve(repositoryRoot, path);
    if (process.argv.includes("--check")) {
      if (!existsSync(target) || readFileSync(target, "utf8") !== text)
        throw Error("MODEL_CATALOGUE_DRIFT: " + path);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      console.log("Generated " + path + ".");
    }
  }
  if (process.argv.includes("--check"))
    console.log(
      "PASS: the generated model catalogue, the loop catalogue and ListingDraft_v1 reproduce exactly.",
    );
}
