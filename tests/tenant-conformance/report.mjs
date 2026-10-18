// Conformance evidence (ADR-0012): each test file writes its passed check names to
// .artifacts/labs/ (or MORROW_ARTIFACTS_DIR) when its process exits.
import { writeArtifact } from "../../scripts/artifacts.mjs";

const results = [];
let name = null;
export function recordConformance(check, passed, detail = undefined) {
  results.push(detail === undefined ? { check, passed } : { check, passed, detail });
}
export function conformanceReport(file) {
  name = file;
}
process.once("exit", () => {
  if (!name) return;
  writeArtifact("labs/tenant-conformance-" + name + ".json", {
    task: "P06.T01a",
    qualification: "local_postgresql17_network_none_tenant_conformance",
    observedAt: new Date().toISOString(),
    checks: results,
    limitations: [
      "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, provider or merchant data.",
    ],
  });
});
