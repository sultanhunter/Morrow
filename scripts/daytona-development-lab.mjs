import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compileDevelopmentLabConfiguration,
  prepareDevelopmentLabOperation,
  runDevelopmentLab,
} from "../packages/infrastructure/src/daytona-development-lab.ts";
import {
  developmentLabSourceBinding,
  inspectDevelopmentLabAccount,
  labSha,
  loadDevelopmentLabInput,
  openDevelopmentLabJournal,
} from "./daytona-development-input.mjs";

// This archive is an explicit reviewed recipe, not permission to choose an
// arbitrary old source or rewrite the original operation during cleanup.
const originalProfileSha256 = "f1d77ebc18ae056f83e873abc73627e8b35256904c103760d7a3a561e4d84595";
const originalSourceSha256 = "dd30f664e1c32e69b3760470ec4c1c0e475c8d184466652ad58eafcfd8c2da32";
export function archivedDevelopmentLabBinding(config, plan, receipt) {
  try {
    const compiled = compileDevelopmentLabConfiguration(config);
    if (
      !Number.isSafeInteger(plan?.sources?.plan?.sequence) ||
      plan.sources.plan.sequence < 55 ||
      receipt?.schema_version !== 1 ||
      receipt.task !== "P04.T01f" ||
      receipt.original_plan_sequence !== 54 ||
      receipt.original_source_commit !== "f58f2902001a0735294aceb02bb4a11258991e1d" ||
      receipt.original_profile_sha256 !== originalProfileSha256 ||
      receipt.original_source_sha256 !== originalSourceSha256 ||
      labSha(JSON.stringify(receipt.original_source_digests)) !== originalSourceSha256 ||
      compiled.profileSha256 !== originalProfileSha256 ||
      receipt.new_allocation_authorized !== false ||
      receipt.production_qualified !== false
    )
      throw Error("DEVELOPMENT_LAB_ARCHIVE_BINDING_DENIED");
    return Object.freeze({
      originalPlanSequence: 54,
      profileSha256: originalProfileSha256,
      sourceSha256: originalSourceSha256,
      currentPlanSequence: plan.sources.plan.sequence,
    });
  } catch {
    throw Error("DEVELOPMENT_LAB_ARCHIVE_BINDING_DENIED");
  }
}

export async function mainDevelopmentLab(argv = process.argv.slice(2)) {
  if (argv.length && !(argv.length === 2 && ["--run", "--resume"].includes(argv[0]))) {
    console.log("DEVELOPMENT_LAB_USAGE_DENIED");
    return 2;
  }
  // E2B selection archives Daytona allocation permanently in this controller.
  // Deny before config/source/account/credential reads or SDK construction.
  if (argv[0] === "--run") {
    console.log("DEVELOPMENT_LAB_PROVIDER_ARCHIVED");
    return 2;
  }
  const config = JSON.parse(readFileSync("infra/labs/daytona-development.json", "utf8"));
  const plan = JSON.parse(readFileSync("docs/plan/source.json", "utf8"));
  const binding = archivedDevelopmentLabBinding(
    config,
    plan,
    JSON.parse(readFileSync("docs/evidence/P04.T01f/archive-binding.json", "utf8")),
  );
  const accountBytes = readFileSync("infra/labs/daytona-development-account.json");
  const account = JSON.parse(accountBytes);
  const source = developmentLabSourceBinding(".");
  const mode = "cleanup";
  const blockers = inspectDevelopmentLabAccount(account, Date.now(), mode);
  const destination = "docs/evidence/P04.T01f";
  mkdirSync(destination, { recursive: true });
  const base = {
    task: "P04.T01f",
    plan_sequence: binding.originalPlanSequence,
    current_plan_sequence: binding.currentPlanSequence,
    scope: "Synthetic operator container lab only; no merchant/VM/production qualification",
    profile_sha256: binding.profileSha256,
    source_sha256: binding.sourceSha256,
    controller_source_sha256: source.sourceSha256,
    controller_source_digests: source.digests,
    account_observation_sha256: labSha(accountBytes),
    sdk: "@daytona/sdk0.224.0",
    production_qualified: false,
    merchant_dispatch: false,
  };
  if (!argv.length) {
    writeFileSync(
      resolve(destination, "archive.json"),
      JSON.stringify(
        {
          ...base,
          status: "archived_cleanup_only",
          provider_calls: false,
          private_input_read: false,
          live_ready: false,
          cleanup_ready: blockers.length === 0,
          blockers: ["DEVELOPMENT_LAB_PROVIDER_ARCHIVED", ...blockers],
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "Archived synthetic Daytona laboratory; cleanup only, no credentials or provider calls.",
    );
    return 0;
  }
  // Deny before opening private material or constructing the SDK.
  if (blockers.length) {
    writeFileSync(
      resolve(destination, "cleanup.json"),
      JSON.stringify({ ...base, status: "blocked", provider_calls: false, blockers }, null, 2) +
        "\n",
    );
    console.log("DEVELOPMENT_LAB_LIVE_PREREQUISITES_UNQUALIFIED");
    return 2;
  }
  if (
    existsSync(".env") ||
    existsSync(".env.local") ||
    Object.keys(process.env).some((key) => key.startsWith("DAYTONA_"))
  )
    throw Error("DEVELOPMENT_LAB_IMPLICIT_CONFIGURATION_DENIED");
  const privateRoot = resolve("../../morrow-private-staging");
  const input = loadDevelopmentLabInput(argv[1], privateRoot, {
    profileSha256: binding.profileSha256,
    sourceSha256: binding.sourceSha256,
    accountObservationSha256: base.account_observation_sha256,
  });
  const journal = openDevelopmentLabJournal(privateRoot, input.operationId, argv[0] === "--resume");
  let transport;
  let exitCode = 1;
  let result;
  let disposalSucceeded = true;
  let providerAttempted = false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const report = (status, data = {}) =>
    writeFileSync(
      resolve(destination, "cleanup.json"),
      JSON.stringify({ ...base, observed_at: new Date().toISOString(), status, ...data }, null, 2) +
        "\n",
    );
  try {
    const prepared = journal.record ?? {
      operation: prepareDevelopmentLabOperation(config, input.operationId, Date.now()),
      createAttempted: false,
      sandboxId: null,
      phase: "prepared",
    };
    await journal.persist(prepared);
    const { createOfficialDaytonaDevelopmentTransport } = await import(
      "./daytona-development-transport.mjs"
    );
    providerAttempted = true;
    report("running", { provider_calls: true, provider_calls_attempted: true });
    transport = await createOfficialDaytonaDevelopmentTransport({
      apiKey: input.apiKey,
      organizationId: input.organizationId,
      region: "us",
      mode,
    });
    result = await runDevelopmentLab(config, input.operationId, transport, {
      startedAtMs: prepared.operation.startedAtMs,
      signal: controller.signal,
      resume: prepared,
      cleanupOnly: mode === "cleanup",
      persist: journal.persist,
    });
    const cleanupCompleted =
      mode === "cleanup" &&
      result.code === "DEVELOPMENT_LAB_CLEANUP_ONLY" &&
      result.status !== "unresolved" &&
      ["not_needed", "verified_deleted"].includes(result.cleanup);
    report(cleanupCompleted ? "cleanup_completed" : result.status, {
      provider_calls: true,
      operation_id: input.operationId,
      code: result.code,
      cleanup: result.cleanup,
      deletion_observation: result.deletionObservation,
      sandbox_id: result.record.sandboxId,
      memory_persistence_claimed: false,
    });
    console.log(
      cleanupCompleted
        ? "DEVELOPMENT_LAB_CLEANUP_COMPLETED"
        : result.status === "passed"
          ? "DEVELOPMENT_LAB_PASSED"
          : "DEVELOPMENT_LAB_NOT_PASSED",
    );
    exitCode = result.status === "passed" || cleanupCompleted ? 0 : 1;
  } catch {
    report("unresolved", {
      code: "DEVELOPMENT_LAB_CONTROLLER_FAILED",
      provider_calls: providerAttempted,
      provider_calls_attempted: providerAttempted,
    });
    console.log("DEVELOPMENT_LAB_CONTROLLER_FAILED");
    exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    try {
      await transport?.dispose();
    } catch {
      disposalSucceeded = false;
      report("unresolved", {
        code: "DEVELOPMENT_LAB_CONTROLLER_DISPOSAL_FAILED",
        provider_calls: true,
      });
      exitCode = 1;
    }
    try {
      if (result && result.status !== "unresolved" && disposalSucceeded) journal.release(result);
      journal.closeController();
    } catch {
      report("unresolved", {
        code: "DEVELOPMENT_LAB_CONTROLLER_JOURNAL_FAILED",
        provider_calls: providerAttempted,
        provider_calls_attempted: providerAttempted,
      });
      exitCode = 1;
    }
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await mainDevelopmentLab();
  } catch {
    console.log("DEVELOPMENT_LAB_CONTROLLER_DENIED");
    process.exitCode = 2;
  }
}
