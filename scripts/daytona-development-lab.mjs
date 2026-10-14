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

export async function mainDevelopmentLab(argv = process.argv.slice(2)) {
  if (argv.length && !(argv.length === 2 && ["--run", "--resume"].includes(argv[0]))) {
    console.log("DEVELOPMENT_LAB_USAGE_DENIED");
    return 2;
  }
  const config = JSON.parse(readFileSync("infra/labs/daytona-development.json", "utf8"));
  const compiled = compileDevelopmentLabConfiguration(config);
  const plan = JSON.parse(readFileSync("docs/plan/source.json", "utf8"));
  if (config.planSequence !== plan.sources.plan.sequence)
    throw Error("DEVELOPMENT_LAB_PLAN_DENIED");
  const accountBytes = readFileSync("infra/labs/daytona-development-account.json");
  const account = JSON.parse(accountBytes);
  const source = developmentLabSourceBinding(".");
  const mode = argv[0] === "--resume" ? "cleanup" : "allocate";
  const blockers = inspectDevelopmentLabAccount(account, Date.now(), mode);
  const destination = "docs/evidence/P04.T01f";
  mkdirSync(destination, { recursive: true });
  const base = {
    task: "P04.T01f",
    plan_sequence: config.planSequence,
    scope: "Synthetic operator container lab only; no merchant/VM/production qualification",
    profile_sha256: compiled.profileSha256,
    source_sha256: source.sourceSha256,
    source_digests: source.digests,
    account_observation_sha256: labSha(accountBytes),
    sdk: "@daytona/sdk0.224.0",
    production_qualified: false,
    merchant_dispatch: false,
  };
  if (!argv.length) {
    writeFileSync(
      resolve(destination, "preparation.json"),
      JSON.stringify(
        {
          ...base,
          status: "prepared",
          provider_calls: false,
          private_input_read: false,
          live_ready: blockers.length === 0,
          blockers,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("Prepared synthetic container laboratory; no credentials or provider calls.");
    return 0;
  }
  // Deny before opening private material or constructing the SDK.
  if (blockers.length) {
    writeFileSync(
      resolve(destination, "live.json"),
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
    profileSha256: compiled.profileSha256,
    sourceSha256: source.sourceSha256,
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
      resolve(destination, "live.json"),
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
