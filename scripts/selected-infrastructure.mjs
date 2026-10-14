import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  selectedEnvironments,
  compileSelectedConfiguration,
  selectedPermissionProfiles,
  selectedStack,
} from "../packages/infrastructure/src/selected-stack.ts";

const mode = process.argv[2] ?? "synth";
if (!["synth", "readiness", "permissions"].includes(mode)) throw Error("UNKNOWN_LOCAL_MODE");
const planSequence = JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan
  .sequence;
const configurations = selectedEnvironments.map((name) => {
  const config = JSON.parse(readFileSync(`infra/environments/${name}.json`, "utf8"));
  if (config.plan_sequence !== planSequence) throw Error("STALE_OR_UNRECORDED_CONFIGURATION");
  return compileSelectedConfiguration(config);
});
const destination = "docs/evidence/P04.T01a";
mkdirSync(destination, { recursive: true });
const payload = {
  scope:
    "Selected-stack local design inventory; not provider deployment, identity/network proof or authenticated approval",
  stack: selectedStack,
  runtime_provider: "e2b",
  mode,
  paid_resources_created: false,
  deployment_entrypoint: false,
  environments: configurations.map((entry) => ({
    environment: entry.configuration.environment,
    configuration_sha256: entry.configuration_sha256,
    ...(mode === "synth" ? { configuration: entry.configuration } : {}),
    ...(mode === "permissions"
      ? { profiles: selectedPermissionProfiles, effective_provider_permissions: "not_tested" }
      : {}),
    ...(mode === "readiness"
      ? {
          status: "pending",
          paid_creation_authorized: false,
          reasons: [
            "OWNED_PROVIDER_BINDINGS_REQUIRED",
            "ACTUAL_PROVIDER_QUALIFICATION_REQUIRED",
            "COMPLETE_BOUND_QUOTE_REQUIRED",
            "BOUND_OWNER_COST_AUTHORIZATION_REQUIRED",
            "AUTHENTICATED_DEPLOYMENT_PORT_NOT_IMPLEMENTED",
          ],
        }
      : {}),
  })),
};
writeFileSync(`${destination}/${mode}.json`, JSON.stringify(payload, null, 2) + "\n");
console.log(
  `PASS: selected Cloudflare/Neon/E2B ${mode}; three isolated design inventories; no provider calls or activation.`,
);
