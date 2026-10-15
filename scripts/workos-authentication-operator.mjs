// Scripts-only staging qualification. This is never a merchant login service.
import { pathToFileURL } from "node:url";
import {
  prepareWorkosAuthenticationOperatorActivation,
  inspectWorkosAuthenticationOperatorRun,
  claimWorkosAuthenticationOperatorRun,
  releaseWorkosAuthenticationOperatorRun,
  readWorkosAuthenticationOperatorRun,
  isWorkosAuthenticationOperatorSourceDirectory,
} from "./workos-authentication-operator-input.mjs";

const held = (reason) =>
  Object.freeze({
    state: "held",
    reason,
    providerSessionCleanup: "unknown",
    evidenceUse: "historical_observation_only",
  });
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const unknownCleanup = () =>
  Object.freeze({
    hostChildClosure: "unverified",
    backendNamespace: "unverified",
    containerFence: "unverified",
  });

export async function runWorkosAuthenticationOperatorCommand(command, root, bindingPath) {
  if (
    process.version !== "v24.13.0" ||
    !["prepare", "inspect", "start"].includes(command) ||
    typeof root !== "string" ||
    (command === "prepare" ? typeof bindingPath !== "string" : bindingPath !== undefined)
  )
    return held("input_denied");
  if (command === "prepare")
    return prepareWorkosAuthenticationOperatorActivation(root, bindingPath);
  if (command === "inspect") return inspectWorkosAuthenticationOperatorRun(root);
  if (!isWorkosAuthenticationOperatorSourceDirectory()) return held("source_directory_required");

  // Claim and lock before importing/allocating the database or listening socket.
  const ownedRun = claimWorkosAuthenticationOperatorRun(root);
  if (ownedRun === null) return held("owner_activation_required");
  let cancelled = false,
    activeController = null;
  const cancel = () => {
    cancelled = true;
    // Close synchronously aborts native work before any delayed send gate can
    // resume. The awaited finally below retains ownership through teardown.
    try {
      void Promise.resolve(activeController?.close()).catch(() => {});
    } catch {
      /* Cleanup is awaited again and reported by the owned finally. */
    }
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let result = held("operator_unavailable"),
    cleanup = unknownCleanup(),
    privateCleanup = Object.freeze({ credentialRemoved: false, lockReleased: false });
  try {
    const context = readWorkosAuthenticationOperatorRun(ownedRun);
    if (context.mode !== "native" || context.current() !== true) throw Error();
    const { withWorkosAuthenticationOperatorDatabase, WorkosAuthenticationOperatorDatabaseError } =
      await import("./workos-authentication-operator-database.mjs");
    if (cancelled) throw Error();
    try {
      const completed = await withWorkosAuthenticationOperatorDatabase(
        ownedRun,
        async ({ admission }) => {
          if (cancelled) return held("operator_cancelled");
          const { createWorkosAuthenticationOperatorController } = await import(
            "./workos-authentication-operator-controller.mjs"
          );
          const { createNativeWorkosAuthenticationOperatorTransport } = await import(
            "./workos-authentication-operator-native.mjs"
          );
          const { createWorkosAuthenticationOperatorListener } = await import(
            "./workos-authentication-operator-listener.mjs"
          );
          const controller = await createWorkosAuthenticationOperatorController({
            ownedRun,
            admission,
            transportFactory: createNativeWorkosAuthenticationOperatorTransport,
          });
          activeController = controller;
          let listener;
          try {
            if (cancelled) return held("operator_cancelled");
            if (controller.status().state !== "ready") return controller.status();
            listener = createWorkosAuthenticationOperatorListener(ownedRun, controller);
            await listener.listen();
            console.log(
              JSON.stringify({
                state: "operator_ready",
                startUrl: "http://127.0.0.1:4110/operator/workos/start",
                providerSessionCleanup: "unknown",
              }),
            );
            while (Date.now() < context.expiresAtMs) {
              if (cancelled) return held("operator_cancelled");
              const status = controller.status();
              if (
                ["verified_active_evidence", "authorization_not_completed", "held"].includes(
                  status.state,
                )
              ) {
                // The recorded result is historical; this delay grants no evidence lease.
                await pause(1000);
                return cancelled ? held("operator_cancelled") : status;
              }
              if (context.current() !== true) return held("source_or_activation_changed");
              await pause(Math.min(250, Math.max(1, context.expiresAtMs - Date.now())));
            }
            return held("operator_deadline");
          } finally {
            try {
              await controller.close();
            } finally {
              await listener?.close();
              activeController = null;
            }
          }
        },
      );
      result = completed.result;
      cleanup = completed.cleanup;
    } catch (error) {
      if (error instanceof WorkosAuthenticationOperatorDatabaseError) cleanup = error.cleanup;
      result = held("operator_unavailable");
    }
  } catch {
    result = held("operator_unavailable");
  } finally {
    // Keep the process lock through listener/controller and database teardown.
    try {
      privateCleanup = releaseWorkosAuthenticationOperatorRun(ownedRun);
    } catch {
      /* Retain the explicit unverified private cleanup result. */
    }
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  return Object.freeze({
    ...result,
    evidenceUse: "historical_observation_only",
    cleanup,
    privateCleanup,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, root, bindingPath, ...extra] = process.argv.slice(2);
    if (extra.length) throw Error();
    const result = await runWorkosAuthenticationOperatorCommand(command, root, bindingPath);
    console.log(JSON.stringify(result));
    if (
      result.state === "held" ||
      result.outcome === "held" ||
      (result.cleanup &&
        (result.cleanup.hostChildClosure !== "observed" ||
          result.cleanup.backendNamespace !== "absent" ||
          result.cleanup.containerFence !== "absent")) ||
      (result.privateCleanup &&
        (!result.privateCleanup.credentialRemoved || !result.privateCleanup.lockReleased))
    )
      process.exitCode = 1;
  } catch {
    console.log(JSON.stringify(held("operator_unavailable")));
    process.exitCode = 1;
  }
}
