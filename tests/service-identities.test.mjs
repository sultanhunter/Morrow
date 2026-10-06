import { test } from "node:test";
import assert from "node:assert/strict";
import { foundationTemplate, environmentNames } from "../packages/infrastructure/src/index.ts";
import {
  serviceStatements,
  serviceProfiles,
} from "../packages/infrastructure/src/service-identities.ts";
const templates = Object.fromEntries(
  environmentNames.map((name) => [name, foundationTemplate(name)]),
);
function scope(name) {
  const accountId = "000000000000";
  return {
    accountId,
    databaseResourceId: `synthetic-${name}`,
    bucketArn: `arn:aws:s3:::morrow-${name}-artifacts-${accountId}-us-east-1`,
    artifactKeyArn: `arn:aws:kms:us-east-1:${accountId}:key/${name}-artifact`,
    credentialKeyArn: `arn:aws:kms:us-east-1:${accountId}:key/${name}-credential`,
    transportKeyArn: `arn:aws:kms:us-east-1:${accountId}:key/${name}-transport`,
    queueArns: [`arn:aws:sqs:us-east-1:${accountId}:morrow-${name}-delivery-signals`],
  };
}
const wildcard = (pattern, value) =>
  new RegExp(
    "^" +
      pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  ).test(value);
// Synthetic fixture matching of only the operators emitted by this compiler.
// Not an AWS IAM simulator, identity authenticator or production authorizer.
function fixtureAllows(statements, action, resource, context = {}) {
  return statements.some(
    (statement) =>
      statement.Effect === "Allow" &&
      statement.Action.includes(action) &&
      [statement.Resource].flat().some((pattern) => wildcard(pattern, resource)) &&
      Object.entries(statement.Condition ?? {}).every(([operator, fields]) =>
        Object.entries(fields).every(
          ([key, value]) =>
            typeof context[key] === "string" &&
            [value]
              .flat()
              .some((expected) =>
                operator === "StringEquals"
                  ? context[key] === expected
                  : operator === "StringLike" && wildcard(expected, context[key]),
              ),
        ),
      ),
  );
}
for (const name of environmentNames) {
  const template = templates[name];
  const own = scope(name);
  const profiles = serviceStatements(name, own);
  test(`${name}: seven distinct role identities bounded by their exact maximum policy`, () => {
    const roles = Object.values(template.Resources).filter(
      (resource) => resource.Type === "AWS::IAM::Role",
    );
    assert.equal(roles.length, 7);
    assert.equal(new Set(roles.map((role) => role.Properties.RoleName)).size, 7);
    for (const role of roles) {
      const boundary = template.Resources[role.Properties.PermissionsBoundary.Ref];
      assert.equal(boundary.Type, "AWS::IAM::ManagedPolicy");
      assert.deepEqual(
        boundary.Properties.PolicyDocument,
        role.Properties.Policies[0].PolicyDocument,
      );
      assert.ok(role.Properties.RoleName.startsWith(`morrow-${name}-`));
    }
  });
  test(`${name}: task principals cannot assume owner deployment/recovery identities`, () => {
    for (const id of ["Deployment", "Recovery"]) {
      const statement =
        template.Resources[id + "Role"].Properties.AssumeRolePolicyDocument.Statement[0];
      assert.deepEqual(statement.Principal.AWS["Fn::Sub"], [
        "arn:aws:iam::${AWS::AccountId}:role/${IssuerRolePath}",
        { IssuerRolePath: { Ref: id + "IssuerRolePath" } },
      ]);
      assert.ok(!JSON.stringify(statement).includes("ecs-tasks"));
      assert.equal(
        statement.Condition.StringEquals["sts:SourceIdentity"],
        `morrow-${name}-${id.toLowerCase()}`,
      );
      assert.equal(template.Parameters[id + "IssuerRolePath"].Default, undefined);
    }
    for (const id of ["Api", "Workers", "Connector", "CredentialBroker", "TaskExecution"]) {
      const statement =
        template.Resources[id + "Role"].Properties.AssumeRolePolicyDocument.Statement[0];
      assert.equal(statement.Principal.Service, "ecs-tasks.amazonaws.com");
      assert.deepEqual(statement.Condition.StringEquals["aws:SourceAccount"], {
        Ref: "AWS::AccountId",
      });
      assert.ok(statement.Condition.ArnLike["aws:SourceArn"]);
    }
  });
  test(`${name}: app/worker/connector/execution profiles cannot read any provider secret`, () => {
    for (const profile of [
      "api",
      "workers",
      "connector",
      "task-execution",
      "deployment",
      "recovery",
    ]) {
      assert.equal(
        fixtureAllows(
          profiles[profile],
          "secretsmanager:GetSecretValue",
          `arn:aws:secretsmanager:us-east-1:${own.accountId}:secret:morrow/${name}/provider/token`,
          { "aws:RequestedRegion": "us-east-1" },
        ),
        false,
      );
      assert.ok(!profiles[profile].some((statement) => statement.Action.includes("iam:PassRole")));
    }
  });
  test(`${name}: broker only retrieves/decrypts owned environment credentials through Secrets Manager`, () => {
    const arn = `arn:aws:secretsmanager:us-east-1:${own.accountId}:secret:morrow/${name}/providers/token`;
    const broker = profiles["credential-broker"];
    assert.equal(
      fixtureAllows(broker, "secretsmanager:GetSecretValue", arn, {
        "aws:RequestedRegion": "us-east-1",
      }),
      true,
    );
    assert.equal(
      fixtureAllows(broker, "secretsmanager:GetSecretValue", arn, {
        "aws:RequestedRegion": "eu-west-1",
      }),
      false,
    );
    assert.equal(
      fixtureAllows(broker, "kms:Decrypt", own.credentialKeyArn, {
        "kms:ViaService": "secretsmanager.us-east-1.amazonaws.com",
        "kms:EncryptionContext:SecretARN": arn,
      }),
      true,
    );
    assert.equal(fixtureAllows(broker, "kms:Decrypt", own.credentialKeyArn), false);
    assert.equal(
      fixtureAllows(broker, "kms:Decrypt", own.artifactKeyArn, {
        "kms:ViaService": "secretsmanager.us-east-1.amazonaws.com",
        "kms:EncryptionContext:SecretARN": arn,
      }),
      false,
    );
    assert.equal(fixtureAllows(broker, "secretsmanager:DeleteSecret", arn), false);
  });
  test(`${name}: only API gets private artifact contents; direct workers/execution/broker denied`, () => {
    const object = own.bucketArn + "/org-synthetic/artifact/revision";
    assert.equal(fixtureAllows(profiles.api, "s3:GetObject", object), true);
    for (const profile of [
      "workers",
      "connector",
      "credential-broker",
      "task-execution",
      "deployment",
      "recovery",
    ])
      assert.equal(fixtureAllows(profiles[profile], "s3:GetObject", object), false);
    assert.equal(fixtureAllows(profiles.api, "kms:Decrypt", own.artifactKeyArn), false);
    assert.equal(
      fixtureAllows(profiles.api, "kms:Decrypt", own.artifactKeyArn, {
        "kms:ViaService": "s3.us-east-1.amazonaws.com",
        "kms:EncryptionContext:aws:s3:arn": own.bucketArn,
      }),
      true,
    );
  });
  test(`${name}: private endpoint policies scope principals/services; no untrusted attachment`, () => {
    const endpoints = Object.values(template.Resources).filter(
      (resource) => resource.Type === "AWS::EC2::VPCEndpoint",
    );
    assert.equal(endpoints.length, 6);
    assert.ok(endpoints.every((endpoint) => endpoint.Properties.VpcId.Ref === "TrustedVpc"));
    assert.equal(
      endpoints.filter((endpoint) => endpoint.Properties.VpcEndpointType === "Interface").length,
      5,
    );
    for (const endpoint of endpoints.filter(
      (endpoint) => endpoint.Properties.VpcEndpointType === "Interface",
    )) {
      assert.equal(endpoint.Properties.PrivateDnsEnabled, true);
      assert.ok(endpoint.Properties.PolicyDocument.Statement.length > 0);
      assert.ok(
        endpoint.Properties.PolicyDocument.Statement.every((statement) => statement.Principal.AWS),
      );
    }
    const secrets = template.Resources.SecretEndpoint.Properties.PolicyDocument.Statement;
    assert.ok(
      secrets.every(
        (statement) => statement.Principal.AWS["Fn::GetAtt"][0] === "CredentialBrokerRole",
      ),
    );
    const storage = template.Resources.StorageGatewayEndpoint.Properties.PolicyDocument.Statement;
    assert.ok(
      storage
        .filter((statement) => statement.Principal === "*")
        .every(
          (statement) =>
            statement.Resource === "arn:aws:s3:::prod-us-east-1-starport-layer-bucket/*" &&
            statement.Action.length === 1 &&
            statement.Action[0] === "s3:GetObject",
        ),
    );
    assert.equal(template.Parameters.S3RegionalPrefixListId.Default, undefined);
  });
  test(`${name}: database enforces TLS; registry task execution has no DB/secret/artifact authority`, () => {
    assert.equal(template.Resources.DatabaseParameters.Properties.Parameters["rds.force_ssl"], "1");
    assert.equal(template.Resources.DatabaseParameters.Properties.Parameters.log_statement, "none");
    const actions = profiles["task-execution"].flatMap((statement) => statement.Action);
    assert.ok(actions.every((action) => action.startsWith("logs:") || action.startsWith("ecr:")));
    const token = profiles["task-execution"].find(
      (statement) => statement.Sid === "RegistryAuthenticationOnly",
    );
    assert.equal(token.Resource, "*");
    assert.deepEqual(token.Action, ["ecr:GetAuthorizationToken"]);
  });
  for (const other of environmentNames.filter((other) => other !== name))
    test(`${name} profiles deny ${other} private objects, secrets, keys and database principals in fixtures`, () => {
      const target = scope(other);
      const secret = `arn:aws:secretsmanager:us-east-1:${target.accountId}:secret:morrow/${other}/providers/token`;
      for (const profile of serviceProfiles) {
        assert.equal(
          fixtureAllows(profiles[profile], "s3:GetObject", target.bucketArn + "/private"),
          false,
        );
        assert.equal(
          fixtureAllows(profiles[profile], "secretsmanager:GetSecretValue", secret, {
            "aws:RequestedRegion": "us-east-1",
          }),
          false,
        );
        assert.equal(
          fixtureAllows(profiles[profile], "kms:Decrypt", target.credentialKeyArn, {
            "kms:ViaService": "secretsmanager.us-east-1.amazonaws.com",
            "kms:EncryptionContext:SecretARN": secret,
          }),
          false,
        );
        assert.equal(
          fixtureAllows(
            profiles[profile],
            "rds-db:connect",
            `arn:aws:rds-db:us-east-1:${target.accountId}:dbuser:${target.databaseResourceId}/morrow_api`,
          ),
          false,
        );
      }
    });
}
