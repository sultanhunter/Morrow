import { pathToFileURL } from "node:url";
import {
  loadPublicWorkosOperatorScope,
  isWorkosOperatorSourceDirectory,
  prepareWorkosOperatorActivation,
  readWorkosOperatorActivation,
  requirePrivateWorkosOperatorRoot,
} from "./workos-operator-input.mjs";

const held = (reason) =>
  Object.freeze({ state: "held", reason, providerSessionCleanup: "unknown" });
export async function runWorkosOperatorCommand(command, journalRoot) {
  if (!["prepare", "inspect", "start"].includes(command) || typeof journalRoot !== "string")
    throw Error("WORKOS_OPERATOR_INPUT_INVALID");
  if (process.version !== "v24.13.0") throw Error("WORKOS_OPERATOR_RUNTIME_UNQUALIFIED");
  if (command === "prepare") return prepareWorkosOperatorActivation(journalRoot);
  requirePrivateWorkosOperatorRoot(journalRoot);
  if (command === "inspect") {
    const { inspectWorkosOperatorJournal } = await import("./workos-operator-journal.mjs");
    return inspectWorkosOperatorJournal(journalRoot);
  }
  // The unapproved preparation must stop before allocating even a local test DB,
  // claiming an operation, starting a listener or constructing a provider call.
  const scopeJson = loadPublicWorkosOperatorScope();
  const activationJson = readWorkosOperatorActivation(journalRoot);
  const { validateWorkosOperatorActivation, createWorkosOperatorController } = await import(
    "./workos-operator-controller.mjs"
  );
  const { activation, qualified } = validateWorkosOperatorActivation(scopeJson, activationJson);
  if (!qualified || activation.mode !== "native") return held("owner_activation_required");
  if (!isWorkosOperatorSourceDirectory()) return held("source_directory_required");
  const metadata = requirePrivateWorkosOperatorRoot(journalRoot);
  if (
    metadata.ownerUid !== activation.ownerUid ||
    metadata.rootDevice !== activation.rootDevice ||
    metadata.rootInode !== activation.rootInode ||
    Date.parse(activation.expiresAt) <= Date.now() ||
    Date.parse(activation.expiresAt) > Date.now() + 3600000
  )
    return held("activation_invalid");
  const { createWorkosOperatorTransport, workosOperatorEnvironmentAllowed } = await import(
    "./workos-operator-transport.mjs"
  );
  if (!workosOperatorEnvironmentAllowed()) return held("ambient_configuration_denied");
  const { withWorkosOperatorDatabase } = await import("./workos-operator-lab.mjs");
  const { createWorkosOperatorListener } = await import("./workos-operator-listener.mjs");
  const { profileJson } = JSON.parse(scopeJson);
  return withWorkosOperatorDatabase(async ({ admission }) => {
    const transport = createWorkosOperatorTransport(profileJson, { mode: "native" });
    const controller = await createWorkosOperatorController({
      scopeJson,
      activationJson,
      journalRoot,
      admission,
      transport,
      currentScope: async () => {
        if (readWorkosOperatorActivation(journalRoot) !== activationJson)
          throw Error("WORKOS_OPERATOR_ACTIVATION_CHANGED");
        return loadPublicWorkosOperatorScope();
      },
    });
    if (controller.status().state !== "ready") {
      try {
        return controller.status();
      } finally {
        await controller.close();
      }
    }
    let listener;
    const deadline = Math.min(Date.parse(activation.expiresAt), Date.now() + 330000);
    try {
      listener = createWorkosOperatorListener(profileJson, controller);
      await listener.listen();
      console.log(
        JSON.stringify({
          state: "operator_ready",
          startUrl: "http://127.0.0.1:4110/operator/workos/start",
          providerSessionCleanup: "unknown",
        }),
      );
      while (Date.now() < deadline) {
        const status = controller.status();
        if (
          ["cryptographically_verified_candidate", "authorization_not_completed", "held"].includes(
            status.state,
          )
        ) {
          // Let the owner's browser read the clean result. No provider polling.
          await new Promise((resolve) => setTimeout(resolve, 3000));
          return status;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return held("operator_deadline");
    } finally {
      try {
        await listener?.close();
      } finally {
        await controller.close();
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw Error();
    const result = await runWorkosOperatorCommand(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(result));
    if (result.state === "held") process.exitCode = 1;
  } catch {
    console.log(JSON.stringify(held("operator_unavailable")));
    process.exitCode = 1;
  }
}
