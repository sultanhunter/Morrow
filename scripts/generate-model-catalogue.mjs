// The model catalogue generator (ADR-0022 items 10, 11 and 16; M3 PR-1). It reads the
// reviewed catalogue in docs/decisions/model-policy.json, refuses it unless
// `inspectModelPolicy` passes (pinned digests, adaptive thinking, margins, caps), and
// writes packages/policy/src/generated/model-catalogue.ts: data only, for the api's
// checks and, in M3 PR-2, the broker. Keys stay opaque strings; nothing here becomes a
// contract enum. Every money value is an exact integer count of 10^-8 USD (the
// numeric(20,8) of the run-credit tables): a rate that does not divide exactly refuses.
// `--check` compares the committed file byte for byte (verify:boundaries).
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { repositoryRoot } from "./artifacts.mjs";
import { catalogueVersionDigest, inspectModelPolicy } from "./provider-checks.mjs";

export const modelCataloguePath = "packages/policy/src/generated/model-catalogue.ts";
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
  const versions = catalogue.versions.map(catalogueVersionData);
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

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = await generateModelCatalogue();
  const target = resolve(repositoryRoot, modelCataloguePath);
  if (process.argv.includes("--check")) {
    if (!existsSync(target) || readFileSync(target, "utf8") !== text)
      throw Error("MODEL_CATALOGUE_DRIFT: " + modelCataloguePath);
    console.log("PASS: the generated model catalogue reproduces exactly.");
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    console.log("Generated " + modelCataloguePath + ".");
  }
}
