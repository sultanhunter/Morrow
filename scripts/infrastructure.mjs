import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  foundationTemplate,
  environmentNames,
  environments,
} from "../packages/infrastructure/src/index.ts";
import { costCategories, qualificationChecks } from "../packages/infrastructure/src/readiness.ts";
const destination = "work/infrastructure-templates";
mkdirSync(destination, { recursive: true });
const outputs = [];
for (const name of environmentNames) {
  const first = JSON.stringify(foundationTemplate(name), null, 2) + "\n";
  const second = JSON.stringify(foundationTemplate(name), null, 2) + "\n";
  if (first !== second) throw Error("NONDETERMINISTIC_TEMPLATE:" + name);
  const template = JSON.parse(first);
  const digest = createHash("sha256").update(first).digest("hex");
  writeFileSync(`${destination}/${name}.json`, first);
  outputs.push({
    ...environments[name],
    template_sha256: digest,
    resource_count: Object.keys(template.Resources).length,
    required_parameters: Object.keys(template.Parameters),
    resources: Object.fromEntries(
      Object.entries(template.Resources).map(([id, value]) => [id, value.Type]),
    ),
    workloads:
      "absent; foundation ingress fixed 503; reserved role definitions do not activate a service",
    trusted_egress:
      "private AWS endpoints/gateway and reserved database/broker paths only; provider internet egress unimplemented",
    untrusted_runtime: "separate unrouted VPC reserved; no task IAM role/service; P12 required",
    database_pause: "disabled; staging idle pause requires exact minor/capacity qualification",
    external_services: {
      cloudflare: "public assets/DNS only",
      temporal: "opaque IDs/enums; namespace not provisioned",
      workos: "identity service, not Morrow grants; account/terms not qualified",
    },
  });
}
mkdirSync("docs/evidence/P04.T01", { recursive: true });
writeFileSync(
  "docs/evidence/P04.T01/synthesis.json",
  JSON.stringify(
    {
      scope:
        "Structural no-lookup CDK templates only; no deployed IAM/network/engine/restore/availability qualification",
      templates: outputs,
      cost_categories_required: costCategories,
      qualification_checks_required: qualificationChecks,
      paid_resources_created: false,
      deployment_entrypoint: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(`PASS: ${outputs.length} deterministic environment templates; no provisioning.`);
