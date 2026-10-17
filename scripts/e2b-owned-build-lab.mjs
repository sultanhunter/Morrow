import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compileE2BOwnedBuildRecipe,
  createE2BOwnedBuildNativePort,
  prepareE2BOwnedBuildOperation,
  runE2BOwnedBuild,
  validateE2BOwnedBuildAuthorization,
  validateE2BOwnedBuildRecord,
} from "../packages/runtime-adapters/src/e2b/owned-build.ts";
import { e2bActivationProfile, loadE2BReadOnlyAccess } from "./e2b-development-input.mjs";
import {
  loadOwnedBuildAuthorization,
  openOwnedBuildJournal,
  ownedBuildSha,
  ownedBuildSourceBinding,
} from "./e2b-owned-build-input.mjs";
import { E2B_OWNED_BASE_IMAGE } from "../packages/runtime-adapters/src/e2b/owned-image.ts";

export function ownedManifestProofValid(proof, sourceSha256) {
  const closed = (value, fields) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...fields].sort().join(",");
  return (
    closed(proof, [
      "schemaVersion",
      "task",
      "planSequence",
      "sourceSha256",
      "scope",
      "verifiedAt",
      "image",
      "index",
      "platform",
      "ownedTemplateQualified",
      "rootfsAttested",
      "nativeResourcesQualified",
      "productionQualified",
      "providerCompute",
    ]) &&
    proof.schemaVersion === 1 &&
    proof.task === "P04.T01h" &&
    proof.planSequence === 67 &&
    proof.sourceSha256 === sourceSha256 &&
    proof.scope === "public_oci_manifest_provenance_only" &&
    Number.isFinite(Date.parse(proof.verifiedAt)) &&
    proof.image === E2B_OWNED_BASE_IMAGE.image &&
    [
      "ownedTemplateQualified",
      "rootfsAttested",
      "nativeResourcesQualified",
      "productionQualified",
      "providerCompute",
    ].every((key) => proof[key] === false) &&
    closed(proof.index, ["digest", "headerDigest", "byteLength", "mediaType"]) &&
    proof.index.digest === E2B_OWNED_BASE_IMAGE.indexDigest &&
    proof.index.headerDigest === proof.index.digest &&
    proof.index.byteLength === 1609 &&
    proof.index.mediaType === "application/vnd.oci.image.index.v1+json" &&
    closed(proof.platform, [
      "os",
      "architecture",
      "digest",
      "headerDigest",
      "byteLength",
      "descriptorByteLength",
      "mediaType",
      "configDigest",
      "configDeclaredBytes",
      "layerCount",
      "declaredCompressedLayerBytes",
    ]) &&
    proof.platform.os === "linux" &&
    proof.platform.architecture === "amd64" &&
    proof.platform.digest === E2B_OWNED_BASE_IMAGE.amd64Digest &&
    proof.platform.headerDigest === proof.platform.digest &&
    proof.platform.byteLength === 2595 &&
    proof.platform.descriptorByteLength === 2595 &&
    proof.platform.mediaType === "application/vnd.oci.image.manifest.v1+json" &&
    /^sha256:[a-f0-9]{64}$/.test(proof.platform.configDigest) &&
    Number.isSafeInteger(proof.platform.configDeclaredBytes) &&
    proof.platform.configDeclaredBytes > 0 &&
    proof.platform.configDeclaredBytes <= 65536 &&
    Number.isSafeInteger(proof.platform.layerCount) &&
    proof.platform.layerCount > 0 &&
    proof.platform.layerCount <= 128 &&
    Number.isSafeInteger(proof.platform.declaredCompressedLayerBytes) &&
    proof.platform.declaredCompressedLayerBytes > 0 &&
    proof.platform.declaredCompressedLayerBytes <= 4294967296
  );
}

const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const keyRoot = () => resolve("../../morrow-private-staging");
const envDenied = () =>
  (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined &&
    process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "1") ||
  existsSync(".env") ||
  existsSync(".env.local") ||
  Object.keys(process.env).some(
    (n) => n.startsWith("E2B_") || /^(HTTPS?_PROXY|ALL_PROXY|NODE_USE_ENV_PROXY)$/i.test(n),
  );
export function ownedBuildRecipe(profile) {
  if (
    profile?.schemaVersion !== 1 ||
    profile.task !== "P04.T01h" ||
    profile.planSequence !== 67 ||
    profile.scope !== "builtin_synthetic_operator" ||
    profile.estimatedCreditCeilingUsd !== "0.25" ||
    profile.retainReadyTemplate !== true ||
    profile.merchantRouting !== false
  )
    throw Error("E2B_OWNED_BUILD_PROFILE_DENIED");
  return compileE2BOwnedBuildRecipe({
    schemaVersion: 1,
    task: "P04.T01h",
    planSequence: 67,
    projectId: profile.projectId,
    workspaceId: profile.workspaceId,
    imageRef: profile.image,
    cpu: profile.cpu,
    memoryMiB: profile.memoryMiB,
    minFreeDiskMiB: profile.minFreeDiskMiB,
    maximumObservationMs: profile.maximumObservationMs,
  });
}
export function ownedBuildPriceSourceValid(quote, now = Date.now(), read = readFileSync) {
  try {
    if (
      !quote ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(quote.verifiedAtMs) ||
      !Number.isSafeInteger(quote.expiresAtMs) ||
      quote.verifiedAtMs < 0 ||
      quote.verifiedAtMs > now ||
      quote.expiresAtMs <= now ||
      quote.expiresAtMs <= quote.verifiedAtMs ||
      quote.expiresAtMs - quote.verifiedAtMs > 86400000 ||
      typeof quote.priceSourceRef !== "string" ||
      !/^docs\/evidence\/P04\.T01h\/[a-z0-9-]+\.json$/.test(quote.priceSourceRef) ||
      typeof quote.priceSourceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(quote.priceSourceSha256)
    )
      return false;
    return ownedBuildSha(read(quote.priceSourceRef)) === quote.priceSourceSha256;
  } catch {
    return false;
  }
}
export function inspectOwnedBuildPrerequisites(
  profile,
  account,
  manifestReport,
  source,
  now = Date.now(),
) {
  const reasons = [];
  let recipe;
  try {
    recipe = ownedBuildRecipe(profile);
  } catch {
    reasons.push("E2B_OWNED_BUILD_PROFILE_DENIED");
  }
  const observed = Date.parse(account?.observed_at ?? "");
  if (
    account?.plan_sequence !== 67 ||
    account.workspace_id !== profile?.workspaceId ||
    account.project_id !== profile?.projectId ||
    account.workspace !== "Personal Workspace" ||
    account.project_name !== "Sultanibne's Project" ||
    account.plan !== "Hobby" ||
    account.region !== "US-WEST-1" ||
    !Number.isFinite(observed) ||
    now < observed ||
    now - observed > 1800000 ||
    account.operator_access_authorized !== true ||
    account.private_access_receipt !== "owner_explicit"
  )
    reasons.push("E2B_OWNED_BUILD_ACCOUNT_UNQUALIFIED");
  if (
    !/^\d{1,7}\.\d{2}$/.test(account?.free_credit_usd ?? "") ||
    Number(account.free_credit_usd) < 0.25 ||
    account.paid_credit_usd !== "0.00" ||
    account.payment_method_on_file !== false ||
    account.automatic_charge_enabled !== false ||
    account.trial_eligibility_confirmed !== true
  )
    reasons.push("E2B_OWNED_BUILD_FREE_CREDIT_UNQUALIFIED");
  if (
    manifestReport?.plan_sequence !== 67 ||
    manifestReport.provider_calls !== true ||
    manifestReport.injected_transport !== false ||
    manifestReport.source_sha256 !== source.sourceSha256 ||
    manifestReport.public_manifest_verified !== true ||
    manifestReport.owned_runtime_image_qualified !== false ||
    manifestReport.private_input_read !== false ||
    !ownedManifestProofValid(manifestReport.result, source.sourceSha256)
  )
    reasons.push("E2B_OWNED_BUILD_MANIFEST_UNQUALIFIED");
  const quote = profile?.buildQuote;
  const fields = [
    "schemaVersion",
    "recipeSha256",
    "quoteVerified",
    "allMetersQualified",
    "recoveryQualified",
    "buildExpectedUsd",
    "readyRetentionExpectedUsd",
    "otherExpectedUsd",
    "estimatedCreditCeilingUsd",
    "priceSourceRef",
    "priceSourceSha256",
    "verifiedAtMs",
    "expiresAtMs",
  ];
  const decimal = (x) => typeof x === "string" && /^\d{1,3}\.\d{6}$/.test(x);
  if (
    !quote ||
    Object.keys(quote).sort().join(",") !== fields.sort().join(",") ||
    quote.schemaVersion !== 1 ||
    quote.recipeSha256 !== recipe?.recipeSha256 ||
    quote.quoteVerified !== true ||
    quote.allMetersQualified !== true ||
    quote.recoveryQualified !== true ||
    quote.estimatedCreditCeilingUsd !== "0.25" ||
    !ownedBuildPriceSourceValid(quote, now) ||
    ![quote.buildExpectedUsd, quote.readyRetentionExpectedUsd, quote.otherExpectedUsd].every(
      decimal,
    ) ||
    Number(quote.buildExpectedUsd) +
      Number(quote.readyRetentionExpectedUsd) +
      Number(quote.otherExpectedUsd) >
      0.25 ||
    typeof quote.priceSourceRef !== "string" ||
    !/^docs\/evidence\/P04\.T01h\/[a-z0-9-]+\.json$/.test(quote.priceSourceRef)
  )
    reasons.push("E2B_OWNED_BUILD_QUOTE_UNQUALIFIED");
  if (profile?.buildAuthorization !== "owner_explicit")
    reasons.push("E2B_OWNED_BUILD_WRITE_RECEIPT_UNQUALIFIED");
  return reasons;
}
export async function mainE2BOwnedBuild(argv = process.argv.slice(2)) {
  const mode =
    argv[0] === "--build" && argv.length === 2
      ? "build"
      : argv[0] === "--reconcile" && argv.length === 3
        ? "reconcile"
        : argv.length === 0
          ? "prepare"
          : null;
  if (!mode) {
    console.log("E2B_OWNED_BUILD_USAGE_DENIED");
    return 2;
  }
  // The committed activation gate is tolerant: a missing or malformed gate is null,
  // which denies new builds and leaves read-only reconciliation available.
  const currentPlan = e2bActivationProfile();
  if ((mode !== "reconcile" && currentPlan !== 67) || envDenied())
    throw Error("E2B_OWNED_BUILD_CONTROLLER_DENIED");
  mkdirSync(".artifacts/e2b", { recursive: true });
  const writeReport = (name, base, value) =>
    writeFileSync(
      `.artifacts/e2b/${name}.json`,
      JSON.stringify({ ...base, ...value }, null, 2) + "\n",
    );
  let journal = null,
    timer = null,
    lastPersisted = null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    let source,
      recipe,
      record,
      access,
      authorization = null;
    let base = {
      task: "P04.T01h",
      plan_sequence: 67,
      scope: "synthetic_owned_image_only",
      production_qualified: false,
      sandbox_allocated: false,
    };
    if (mode === "reconcile") {
      // Load original bindings before current quote/account/image manifests.
      journal = openOwnedBuildJournal(keyRoot(), argv[1], true);
      record = validateE2BOwnedBuildRecord(journal.envelope.record);
      recipe = record.recipe;
      source = {
        digests: journal.envelope.sourceDigests,
        sourceSha256: record.operation.sourceSha256,
      };
      let controllerSource = null;
      try {
        controllerSource = ownedBuildSourceBinding(".");
      } catch {
        /* Original read-only recovery remains available. */
      }
      base = {
        ...base,
        plan_sequence: recipe.planSequence,
        controller_source_sha256: controllerSource?.sourceSha256 ?? null,
        controller_source_digests: controllerSource?.digests ?? null,
        controller_plan_sequence: currentPlan,
        source_sha256: source.sourceSha256,
        source_digests: source.digests,
        read_only: true,
      };
    } else {
      source = ownedBuildSourceBinding(".");
      const profile = json("infra/labs/e2b-owned-build.json"),
        account = json("infra/labs/e2b-development-account.json");
      const manifest = existsSync(".artifacts/e2b/owned-image-qualification.json")
        ? json(".artifacts/e2b/owned-image-qualification.json")
        : null;
      const blockers = inspectOwnedBuildPrerequisites(profile, account, manifest, source);
      base = { ...base, source_sha256: source.sourceSha256, source_digests: source.digests };
      if (mode === "prepare" || blockers.length) {
        writeReport(mode === "prepare" ? "owned-build-preparation" : "owned-build-blocked", base, {
          status: mode === "prepare" ? "prepared" : "blocked",
          provider_calls: false,
          private_input_read: false,
          build_registered: false,
          build_started: false,
          blockers,
        });
        console.log(
          mode === "prepare" ? "E2B_OWNED_BUILD_PREPARED" : "E2B_OWNED_BUILD_PREREQUISITES_DENIED",
        );
        return mode === "prepare" ? 0 : 2;
      }
      const compiled = ownedBuildRecipe(profile);
      recipe = compiled.recipe;
      const receipt = loadOwnedBuildAuthorization(argv[1], keyRoot());
      record = prepareE2BOwnedBuildOperation(
        recipe,
        receipt.operationId,
        Date.now(),
        source.sourceSha256,
        ownedBuildSha(JSON.stringify(account)),
        ownedBuildSha(JSON.stringify(manifest.result)),
      );
      authorization = validateE2BOwnedBuildAuthorization(receipt, record, Date.now());
      if (authorization.quoteSha256 !== ownedBuildSha(JSON.stringify(profile.buildQuote)))
        throw Error("E2B_OWNED_BUILD_QUOTE_BINDING_DENIED");
      if (
        authorization.expiresAtMs > profile.buildQuote.expiresAtMs ||
        !ownedBuildPriceSourceValid(profile.buildQuote)
      )
        throw Error("E2B_OWNED_BUILD_PRICE_SOURCE_DENIED");
      access = loadE2BReadOnlyAccess(resolve(keyRoot(), "e2b-trial-key.json"), keyRoot(), {
        projectId: recipe.projectId,
        consoleProjectId: "prj_124860ddvd8ys9hnx10tep27mf",
        workspaceId: recipe.workspaceId,
      });
      journal = openOwnedBuildJournal(keyRoot(), record.operation.operationId);
      await journal.persist({ schemaVersion: 1, sourceDigests: source.digests, record });
      lastPersisted = record;
    }
    // Same protected key, independently qualified write receipt; no credential expansion or new key.
    if (mode === "reconcile")
      access = loadE2BReadOnlyAccess(argv[2], keyRoot(), {
        projectId: recipe.projectId,
        consoleProjectId: "prj_124860ddvd8ys9hnx10tep27mf",
        workspaceId: recipe.workspaceId,
      });
    const port = createE2BOwnedBuildNativePort({
      apiKey: access.apiKey,
      record,
      authorization,
      mode,
    });
    timer = setTimeout(
      cancel,
      mode === "build" ? Math.max(1, record.operation.deadlineMs - Date.now()) : 30000,
    );
    const result = await runE2BOwnedBuild(record, port, {
      mode,
      authorization,
      signal: controller.signal,
      persist: async (next) => {
        await journal.persist({ schemaVersion: 1, sourceDigests: source.digests, record: next });
        lastPersisted = next;
      },
      pollWait: () => new Promise((resolveWait) => setTimeout(resolveWait, 2000)),
      maximumPolls: 120,
    });
    const noEffect = !result.record.registrationAttempted && !result.record.startAttempted;
    const retained = noEffect
      ? journal.releaseNoEffect(result.record)
      : journal.retainTerminal(result);
    if (retained) lastPersisted = null;
    writeReport(
      mode === "build" ? "owned-build-qualification" : "owned-build-reconciliation",
      base,
      {
        status: result.status,
        provider_calls: true,
        private_input_read: true,
        terminal_receipt_saved: retained,
        remote_effects: noEffect ? "none" : "registration_or_build",
        result,
      },
    );
    if (noEffect && retained) {
      console.log("E2B_OWNED_BUILD_NO_EFFECT");
      return 1;
    }
    console.log(
      result.status === "ready_retained" && retained
        ? "E2B_OWNED_BUILD_READY_RETAINED"
        : "E2B_OWNED_BUILD_HELD",
    );
    return result.status === "ready_retained" && retained ? 0 : 1;
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    if (journal) {
      try {
        if (lastPersisted && !lastPersisted.registrationAttempted && !lastPersisted.startAttempted)
          journal.releaseNoEffect(lastPersisted);
      } finally {
        journal.closeController();
      }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await mainE2BOwnedBuild();
  } catch {
    console.log("E2B_OWNED_BUILD_CONTROLLER_DENIED");
    process.exitCode = 2;
  }
}
