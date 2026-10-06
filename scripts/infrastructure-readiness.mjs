import { readFileSync, writeFileSync } from "node:fs";
import { environmentNames } from "../packages/infrastructure/src/environments.ts";
import { inspectProvisioningReadiness } from "../packages/infrastructure/src/readiness.ts";
const synthesis = JSON.parse(readFileSync("docs/evidence/P04.T01/synthesis.json", "utf8"));
const rows = environmentNames.map((name) => {
  const config = JSON.parse(readFileSync(`infra/environments/${name}.json`, "utf8"));
  const template = synthesis.templates.find((entry) => entry.name === name);
  const source = JSON.parse(readFileSync("infra/providers/cloudflare.json", "utf8"));
  const reasons = inspectProvisioningReadiness(
    {
      environment: config.environment,
      region: config.aws.region,
      accountId: config.aws.account_id,
      sourceCommit: null,
      templateDigest: null,
      engineVersion: config.aws.aurora_minor,
      maximumAcu: config.aws.maximum_acu,
      cloudflarePrivateProcessing: source.private_processing,
      checks: {},
      quote: config.quote,
      ownerAuthorization: config.owner_cost_authorization,
    },
    {
      environment: name,
      sourceCommit: "unqualified-source",
      templateDigest: template.template_sha256,
      now: new Date().toISOString(),
    },
  );
  if (
    !reasons.includes("ACCOUNT_UNQUALIFIED") ||
    !reasons.includes("COMPLETE_REGIONAL_QUOTE_REQUIRED") ||
    !reasons.includes("BOUND_OWNER_COST_AUTHORIZATION_REQUIRED")
  )
    throw Error("UNEXPECTED_CURRENT_READINESS:" + name);
  return { environment: name, status: "pending", reasons, paid_creation_authorized: false };
});
writeFileSync(
  "docs/evidence/P04.T01/readiness.json",
  JSON.stringify(
    {
      scope:
        "Diagnostic completeness inventory for current pending configs; no deployment port or authentication of evidence",
      environments: rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "PASS: all actual environment configs remain pending without bound account, qualification, complete quote and owner authorization.",
);
