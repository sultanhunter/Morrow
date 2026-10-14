import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  snapshotE2BDevelopmentDiagnostics,
  markE2BDevelopmentCleanup,
} from "../packages/runtime-adapters/src/e2b/development-native.ts";
import {
  compileSyntheticLabProfile,
  prepareSyntheticLabOperation,
  runSyntheticLab,
} from "../packages/infrastructure/src/synthetic-runtime-lab.ts";
import {
  e2bLabSourceBinding,
  e2bLabSha,
  inspectE2BLabAccount,
  loadE2BLabInput,
  openE2BLabJournal,
} from "./e2b-development-input.mjs";

export async function mainE2BLab(argv = process.argv.slice(2), testing = {}) {
  const allocate = argv.length === 2 && argv[0] === "--run";
  const cleanup = argv.length === 3 && argv[0] === "--cleanup";
  if (argv.length && !allocate && !cleanup) {
    console.log("E2B_LAB_USAGE_DENIED");
    return 2;
  }
  const readFile = testing.readFile ?? readFileSync;
  let draft, plan, source, accountBytes, account;
  if (cleanup) {
    // Current allocation manifests must not strand the original resource.
    try {
      plan = JSON.parse(readFile("docs/plan/source.json", "utf8"));
    } catch {
      plan = null;
    }
    try {
      source = (testing.sourceBinding ?? e2bLabSourceBinding)(".");
    } catch {
      source = null;
    }
  } else {
    draft = JSON.parse(readFile("infra/labs/e2b-development.json", "utf8"));
    plan = JSON.parse(readFile("docs/plan/source.json", "utf8"));
    source = (testing.sourceBinding ?? e2bLabSourceBinding)(".");
    accountBytes = readFile("infra/labs/e2b-development-account.json");
    account = JSON.parse(accountBytes);
  }
  const destination = testing.evidenceDirectory ?? "docs/evidence/P04.T01h";
  mkdirSync(destination, { recursive: true });
  const base = {
    task: "P04.T01h",
    plan_sequence: plan?.sources?.plan?.sequence ?? null,
    scope: "Synthetic operator microVM lab only",
    sdk: "e2b2.56.0",
    source_sha256: source?.sourceSha256 ?? null,
    source_digests: source?.digests ?? null,
    production_qualified: false,
    merchant_dispatch: false,
    memory_persistence_claimed: false,
    effective_egress_verified: false,
  };
  let compiled;
  const blockers = [];
  if (!cleanup) {
    try {
      compiled = compileSyntheticLabProfile(draft);
    } catch {
      blockers.push("E2B_LAB_PROFILE_UNBOUND");
    }
    if (draft.providerId !== "e2b" || draft.planSequence !== plan.sources.plan.sequence)
      blockers.push("E2B_LAB_SELECTED_PLAN_DENIED");
    blockers.push(...inspectE2BLabAccount(account, draft));
    if (compiled && account.profile_sha256 !== compiled.profileSha256)
      blockers.push("E2B_LAB_QUOTE_PROFILE_DENIED");
  }
  const report = (name, value) =>
    writeFileSync(
      resolve(destination, name),
      JSON.stringify({ ...base, ...value }, null, 2) + "\n",
    );
  if (!argv.length) {
    report("preparation.json", {
      status: "prepared",
      live_ready: blockers.length === 0,
      provider_calls: false,
      private_input_read: false,
      profile_sha256: compiled?.profileSha256 ?? null,
      blockers,
    });
    console.log("Prepared E2B synthetic laboratory; no credentials or provider calls.");
    return 0;
  }
  // New allocations require the current plan/account/quote. Cleanup retains original bindings.
  if (allocate && blockers.length) {
    report("live.json", {
      status: "blocked",
      provider_calls: false,
      private_input_read: false,
      blockers,
    });
    console.log("E2B_LAB_LIVE_PREREQUISITES_UNQUALIFIED");
    return 2;
  }
  if (
    (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined &&
      process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "1") ||
    existsSync(".env") ||
    existsSync(".env.local") ||
    Object.keys(process.env).some(
      (key) => key.startsWith("E2B_") || /^(HTTPS?_PROXY|ALL_PROXY|NODE_USE_ENV_PROXY)$/i.test(key),
    )
  )
    throw Error("E2B_LAB_IMPLICIT_CONFIGURATION_DENIED");
  const privateRoot = testing.privateRoot ?? resolve("../../morrow-private-staging");
  let journal, input, envelope;
  if (cleanup) {
    journal = openE2BLabJournal(privateRoot, argv[1], true);
    try {
      envelope = journal.envelope;
      compiled = compileSyntheticLabProfile(envelope.profile);
      if (compiled.profile.providerId !== "e2b") throw Error("E2B_LAB_ORIGINAL_PROVIDER_DENIED");
      input = loadE2BLabInput(argv[2], privateRoot, {
        projectId: compiled.profile.projectId,
        profileSha256: compiled.profileSha256,
        sourceSha256: envelope.record.operation.sourceSha256,
        accountObservationSha256: envelope.accountObservationSha256,
      });
      if (input.operationId !== argv[1]) throw Error("E2B_LAB_ORIGINAL_OPERATION_DENIED");
      Object.assign(base, {
        plan_sequence: compiled.profile.planSequence,
        controller_plan_sequence: plan?.sources?.plan?.sequence ?? null,
        controller_source_sha256: source?.sourceSha256 ?? null,
        source_sha256: envelope.record.operation.sourceSha256,
        source_digests: envelope.sourceDigests,
      });
    } catch {
      journal.closeController();
      throw Error("E2B_LAB_CLEANUP_INPUT_DENIED");
    }
  } else {
    input = loadE2BLabInput(argv[1], privateRoot, {
      projectId: compiled.profile.projectId,
      profileSha256: compiled.profileSha256,
      sourceSha256: source.sourceSha256,
      accountObservationSha256: e2bLabSha(accountBytes),
    });
    journal = openE2BLabJournal(privateRoot, input.operationId);
    envelope = {
      schemaVersion: 1,
      profile: compiled.profile,
      accountObservationSha256: input.accountObservationSha256,
      sourceDigests: source.digests,
      record: {
        operation: prepareSyntheticLabOperation(
          compiled.profile,
          input.operationId,
          Date.now(),
          input.sourceSha256,
        ),
        createAttempted: false,
        sandboxId: null,
        phase: "prepared",
      },
    };
  }
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let providerAttempted = false,
    transport,
    terminalReceiptSaved = false,
    heldSlot = true,
    result,
    exitCode = 1;
  const persist = async (record) => {
    envelope = { ...envelope, record };
    await journal.persist(envelope);
  };
  try {
    await journal.persist(envelope); // Original profile/metadata/deadline durable before provider effects.
    const createOfficialE2BDevelopmentTransport =
      testing.transportFactory ??
      (await import("../packages/runtime-adapters/src/e2b/development-transport.ts"))
        .createOfficialE2BDevelopmentTransport;
    providerAttempted = true;
    transport = await createOfficialE2BDevelopmentTransport({
      apiKey: input.apiKey,
      profile: compiled.profile,
      operation: envelope.record.operation,
      mode: cleanup ? "cleanup" : "allocate",
    });
    const options = {
      startedAtMs: envelope.record.operation.startedAtMs,
      sourceSha256: envelope.record.operation.sourceSha256,
      signal: controller.signal,
      onCleanup: () => markE2BDevelopmentCleanup(transport),
      persist,
    };
    if (cleanup) Object.assign(options, { cleanupOnly: true, resume: envelope.record });
    result = await runSyntheticLab(compiled.profile, input.operationId, transport, options);
    const cleanupCompleted =
      cleanup &&
      result.status !== "unresolved" &&
      ["not_needed", "verified_deleted"].includes(result.cleanup);
    if (result.status !== "unresolved") {
      heldSlot = null;
      terminalReceiptSaved = journal.release(result);
      heldSlot = !terminalReceiptSaved;
    }
    report("live.json", {
      terminal_receipt_saved: terminalReceiptSaved,
      held_slot: heldSlot,
      native_diagnostics: snapshotE2BDevelopmentDiagnostics(transport),
      status: !terminalReceiptSaved
        ? "unresolved"
        : cleanupCompleted
          ? "cleanup_completed"
          : result.status,
      provider_calls: true,
      operation_id: input.operationId,
      original_source_sha256: envelope.record.operation.sourceSha256,
      profile_sha256: compiled.profileSha256,
      code: result.code,
      cleanup: result.cleanup,
      deletion_observation: result.deletionObservation,
      sandbox_id: result.record.sandboxId,
      provider_qualification: transport.qualification ?? null,
    });
    exitCode = terminalReceiptSaved && (result.status === "passed" || cleanupCompleted) ? 0 : 1;
    console.log(
      cleanupCompleted && terminalReceiptSaved
        ? "E2B_LAB_CLEANUP_COMPLETED"
        : result.status === "passed" && terminalReceiptSaved
          ? "E2B_LAB_PASSED"
          : "E2B_LAB_NOT_PASSED",
    );
  } catch {
    exitCode = 1;
    // A failed read-only factory has no allocation; an attempted create retains its journal.
    if (!cleanup && envelope.record.createAttempted === false) {
      const noEffect = {
        status: "failed",
        code: "E2B_LAB_ACCESS_PREFLIGHT_FAILED",
        cleanup: "not_needed",
        deletionObservation: "not_observed",
        record: envelope.record,
        productionQualified: false,
        memoryPersistenceClaimed: false,
      };
      try {
        heldSlot = null;
        terminalReceiptSaved = journal.release(noEffect);
        heldSlot = !terminalReceiptSaved;
      } catch {
        /* Keep the operation slot if receipt persistence fails. */
      }
    }
    report("live.json", {
      status: terminalReceiptSaved ? "failed" : "unresolved",
      code: "E2B_LAB_CONTROLLER_FAILED",
      terminal_receipt_saved: terminalReceiptSaved,
      held_slot: heldSlot,
      native_diagnostics: snapshotE2BDevelopmentDiagnostics(transport),
      cleanup: result?.cleanup ?? null,
      deletion_observation: result?.deletionObservation ?? "not_observed",
      operation_id: input.operationId,
      provider_calls_attempted: providerAttempted,
    });
    console.log("E2B_LAB_CONTROLLER_FAILED");
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    // SDK has no public dispose method. Process exit is separate from verified sandbox deletion.
    try {
      journal.closeController();
    } catch {
      exitCode = 1;
      console.log("E2B_LAB_CONTROLLER_JOURNAL_FAILED");
    }
  }
  return exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await mainE2BLab();
  } catch {
    console.log("E2B_LAB_CONTROLLER_DENIED");
    process.exitCode = 2;
  }
}
