import { pathToFileURL } from "node:url";
import {
  claimWorkosSessionStatusRun,
  inspectWorkosSessionStatusRun,
  isWorkosSessionStatusSourceDirectory,
  prepareWorkosSessionStatusActivation,
} from "./workos-session-status-input.mjs";
const held = (reason) =>
  Object.freeze({
    outcome: "held",
    reason,
    clientBinding: "expected_only",
    sessionLiveness: "not_guaranteed",
  });
export async function runWorkosSessionStatusCommand(command, root) {
  if (
    process.version !== "v24.13.0" ||
    !["prepare", "inspect", "observe"].includes(command) ||
    typeof root !== "string"
  )
    return held("input_denied");
  if (command === "prepare") return prepareWorkosSessionStatusActivation(root);
  if (command === "inspect") return inspectWorkosSessionStatusRun(root);
  if (!isWorkosSessionStatusSourceDirectory()) return held("source_directory_required");
  const permit = claimWorkosSessionStatusRun(root);
  if (permit === null) return held("owner_key_approval_required");
  const { createNativeWorkosSessionStatusTransport } = await import(
    "./workos-session-status-transport.mjs"
  );
  const transport = createNativeWorkosSessionStatusTransport(permit);
  try {
    const { createWorkosSessionStatusReader } = await import(
      "../packages/identity/src/workos-session-status.ts"
    );
    const reader = createWorkosSessionStatusReader(transport.observerProfileJson, {
      readPage: transport.readPage,
      currentProfile: transport.currentProfile,
      now: Date.now,
    });
    const result = await reader.observe(transport.queryJson);
    const fact = result.outcome === "held" ? null : reader.readObservation(result.handle);
    const outcome = fact ? result.outcome : "held";
    transport.record(outcome);
    const status = transport.status();
    return Object.freeze({
      outcome,
      reason: outcome === "held" ? status.category : "complete",
      statusClass: status.statusClass,
      getCount: status.getCount,
      clientBinding: "expected_only",
      sessionLiveness: "not_guaranteed",
    });
  } finally {
    transport.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw Error();
    const result = await runWorkosSessionStatusCommand(process.argv[2], process.argv[3]);
    console.log(JSON.stringify(result));
    if (result.outcome === "held") process.exitCode = 1;
  } catch {
    console.log(JSON.stringify(held("operator_unavailable")));
    process.exitCode = 1;
  }
}
