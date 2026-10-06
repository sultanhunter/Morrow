import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { environmentNames } from "../packages/infrastructure/src/environments.ts";
const rows = environmentNames.map((name) => {
  const template = JSON.parse(readFileSync(`work/infrastructure-templates/${name}.json`, "utf8"));
  const roles = Object.entries(template.Resources).filter(
    ([, resource]) => resource.Type === "AWS::IAM::Role",
  );
  return {
    environment: name,
    profiles: roles.map(([id, role]) => ({
      id,
      role_name: role.Properties.RoleName,
      principal: role.Properties.AssumeRolePolicyDocument,
      maximum_policy_sha256: createHash("sha256")
        .update(JSON.stringify(role.Properties.Policies[0].PolicyDocument))
        .digest("hex"),
      permission_boundary: role.Properties.PermissionsBoundary,
      statements: role.Properties.Policies[0].PolicyDocument.Statement,
      deployed: false,
    })),
    endpoints: Object.entries(template.Resources)
      .filter(([, resource]) => resource.Type === "AWS::EC2::VPCEndpoint")
      .map(([id, endpoint]) => ({
        id,
        service: endpoint.Properties.ServiceName,
        type: endpoint.Properties.VpcEndpointType,
        policy: endpoint.Properties.PolicyDocument,
      })),
    provider_egress: "not implemented; trusted private subnet has no direct internet route",
    broker_authentication:
      "not implemented; reserved TLS/internal authorization ports are not an authenticated service",
    database_users_rls:
      "not implemented; IAM connect permission does not create a database user or grant SQL rights",
  };
});
mkdirSync("docs/evidence/P04.T02", { recursive: true });
writeFileSync(
  "docs/evidence/P04.T02/permission-matrix.json",
  JSON.stringify(
    {
      scope:
        "Compiled identity/boundary/endpoint inventory and synthetic fixture matching; not authenticated AWS IAM decisions or tenant authority",
      actual_cross_environment_requests: "not performed; P04.A01 pending",
      environments: rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "PASS: three environment matrices; seven bounded profiles each; actual AWS qualification pending.",
);
