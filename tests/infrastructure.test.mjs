import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foundationTemplate,
  environmentNames,
  environment,
} from "../packages/infrastructure/src/index.ts";
import {
  costCategories,
  qualificationChecks,
  inspectProvisioningReadiness,
  deploymentConfigurationDigest,
  deploymentParameterNames,
} from "../packages/infrastructure/src/readiness.ts";
import { inspectRepairTrees } from "../scripts/repair-cdk-bundle.mjs";
import { lockedBundleAncestor } from "../scripts/delivery-checks.mjs";
const templates = Object.fromEntries(
  environmentNames.map((name) => [name, foundationTemplate(name)]),
);
const resources = (template, type) =>
  Object.entries(template.Resources).filter(([, r]) => r.Type === type);
for (const name of environmentNames) {
  const template = templates[name];
  test(`${name}: reproducible templates need qualified engine/capacity/TLS parameters`, () => {
    assert.deepEqual(foundationTemplate(name), template);
    assert.equal(template.Parameters.AuroraEngineVersion.Default, undefined);
    assert.equal(template.Parameters.AuroraMaximumAcu.Default, undefined);
    assert.equal(template.Parameters.IngressCertificateArn.Default, undefined);
    assert.deepEqual(Object.keys(template.Parameters).sort(), [...deploymentParameterNames].sort());
    assert.deepEqual(template.Rules.RegionalBoundary.Assertions[0].Assert, {
      "Fn::Equals": [{ Ref: "AWS::Region" }, "us-east-1"],
    });
  });
  test(`${name}: merchant artifacts private/encrypted/versioned; no blanket revision expiry`, () => {
    const bucket = template.Resources.Artifacts;
    assert.equal(bucket.DeletionPolicy, "Retain");
    assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    assert.equal(bucket.Properties.VersioningConfiguration.Status, "Enabled");
    assert.equal(
      bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0]
        .ServerSideEncryptionByDefault.SSEAlgorithm,
      "aws:kms",
    );
    const expiration = bucket.Properties.LifecycleConfiguration.Rules.filter(
      (r) => r.ExpirationInDays,
    );
    assert.deepEqual(
      expiration.map((r) => [r.Prefix, r.ExpirationInDays]),
      [["closed-working/", 7]],
    );
    const policy = template.Resources.ArtifactPolicy.Properties.PolicyDocument.Statement;
    assert.ok(policy.every((s) => s.Effect === "Deny"));
    assert.equal(
      policy.find((s) => s.Sid === "TransportEncryption").Condition.Bool["aws:SecureTransport"],
      "false",
    );
    assert.ok(policy.some((s) => s.Sid === "RejectDifferentKey"));
    assert.ok(policy.some((s) => s.Sid === "ExplicitEncryptionRequiresOwnedKey"));
  });
  test(`${name}: private Aurora snapshots protected; master credentials not exported`, () => {
    const db = template.Resources.Database;
    assert.equal(db.DeletionPolicy, "Snapshot");
    assert.equal(db.Properties.Engine, "aurora-postgresql");
    assert.equal(db.Properties.StorageEncrypted, true);
    assert.equal(db.Properties.DeletionProtection, true);
    assert.equal(db.Properties.ManageMasterUserPassword, true);
    assert.equal(db.Properties.EnableCloudwatchLogsExports, undefined);
    assert.equal(db.Properties.BackupRetentionPeriod, name === "production" ? 35 : 7);
    assert.equal(db.Properties.ServerlessV2ScalingConfiguration.MinCapacity, 0.5);
    const instances = resources(template, "AWS::RDS::DBInstance");
    assert.equal(instances.length, name === "production" ? 2 : 1);
    for (const [, instance] of instances) {
      assert.equal(instance.Properties.PubliclyAccessible, false);
      assert.equal(instance.Properties.AutoMinorVersionUpgrade, false);
    }
    if (name === "production")
      assert.notDeepEqual(
        template.Resources.Writer.Properties.AvailabilityZone,
        template.Resources.Reader.Properties.AvailabilityZone,
      );
    assert.ok(Object.keys(template.Outputs).every((id) => !/password|secret/i.test(id)));
    assert.ok(!JSON.stringify(template).includes("SecretString"));
  });
  test(`${name}: only ingress subnet routes reach internet; sandbox cannot reach DB`, () => {
    const routes = resources(template, "AWS::EC2::Route");
    assert.equal(routes.length, 2);
    assert.ok(
      routes.every(([id, route]) => /^IngressInternetRoute/.test(id) && route.Properties.GatewayId),
    );
    assert.equal(resources(template, "AWS::EC2::NatGateway").length, 0);
    assert.equal(resources(template, "AWS::EC2::VPCPeeringConnection").length, 0);
    assert.equal(template.Resources.UntrustedVpc.Properties.EnableDnsSupport, false);
    assert.equal(template.Resources.UntrustedVpc.Properties.EnableDnsHostnames, false);
    const sandbox = resources(template, "AWS::EC2::Subnet").filter(([id]) => /^Untrusted/.test(id));
    assert.equal(sandbox.length, 2);
    assert.ok(
      sandbox.every(
        ([, s]) =>
          s.Properties.VpcId.Ref === "UntrustedVpc" && s.Properties.MapPublicIpOnLaunch === false,
      ),
    );
    const dbIngress = template.Resources.DatabaseSecurityGroup.Properties.SecurityGroupIngress;
    assert.equal(dbIngress.length, 3);
    assert.ok(
      dbIngress.every((rule) =>
        /ApiSecurityGroup|WorkerSecurityGroup|BrokerSecurityGroup/.test(JSON.stringify(rule)),
      ),
    );
    assert.ok(!JSON.stringify(dbIngress).includes("Untrusted"));
    assert.equal(resources(template, "AWS::ECS::TaskDefinition").length, 0);
    assert.equal(resources(template, "AWS::ECS::Service").length, 0);
    assert.equal(resources(template, "AWS::IAM::Role").length, 7);
  });
  test(`${name}: regional HTTPS/WAF closes ingress; no sampled private requests`, () => {
    const listeners = resources(template, "AWS::ElasticLoadBalancingV2::Listener");
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0][1].Properties.Protocol, "HTTPS");
    assert.equal(
      listeners[0][1].Properties.DefaultActions[0].FixedResponseConfig.StatusCode,
      "503",
    );
    const firewall = template.Resources.RegionalFirewall.Properties;
    assert.equal(firewall.Scope, "REGIONAL");
    assert.equal(firewall.VisibilityConfig.SampledRequestsEnabled, false);
    assert.ok(
      firewall.Rules.every((rule) => rule.VisibilityConfig.SampledRequestsEnabled === false),
    );
    assert.equal(template.Outputs.Dispatch.Value, "disabled");
  });
  test(`${name}: bounded encrypted transport/logs; separate rotated keys retained`, () => {
    for (const [, queue] of resources(template, "AWS::SQS::Queue")) {
      assert.ok(queue.Properties.KmsMasterKeyId);
      assert.ok(queue.Properties.MessageRetentionPeriod <= 1209600);
    }
    assert.equal(template.Resources.RedactedLogs.Properties.RetentionInDays, 14);
    assert.equal(template.Resources.RedactedLogs.DeletionPolicy, "Retain");
    const keys = resources(template, "AWS::KMS::Key");
    assert.equal(keys.length, 6);
    assert.ok(
      keys.every(([, key]) => key.Properties.EnableKeyRotation && key.DeletionPolicy === "Retain"),
    );
  });
}
test("bundle integrity requires an integrity-checked registry ancestor", () => {
  const path = "node_modules/example/node_modules/embedded";
  const bundled = { [path]: { inBundle: true } };
  assert.equal(lockedBundleAncestor(path, bundled), false);
  assert.equal(
    lockedBundleAncestor(path, {
      ...bundled,
      "node_modules/example": {
        integrity: "sha512-example",
        resolved: "https://registry.npmjs.org/example.tgz",
      },
    }),
    true,
  );
  assert.equal(
    lockedBundleAncestor(path, {
      ...bundled,
      "node_modules/example": {
        integrity: "sha512-example",
        resolved: "https://untrusted.invalid/example.tgz",
      },
    }),
    false,
  );
});
test("bundle repair rejects altered original or fixed source", () => {
  const manifest = { original_tree_sha256: "original", fixed_tree_sha256: "fixed" };
  assert.deepEqual(inspectRepairTrees(manifest, "original", "fixed"), []);
  assert.deepEqual(inspectRepairTrees(manifest, "fixed", "fixed"), []);
  assert.ok(inspectRepairTrees(manifest, "tampered", "fixed").includes("UNREVIEWED_BUNDLED_TREE"));
  assert.ok(inspectRepairTrees(manifest, "original", "tampered").includes("UNREVIEWED_FIXED_TREE"));
});
test("unknown environment fails rather than defaulting to production", () => {
  assert.throws(() => environment("prod"), /UNKNOWN_ENVIRONMENT/);
});
test("environment artifact/log/queue names do not alias across environments", () => {
  for (const resource of ["Artifacts", "RedactedLogs", "DeliverySignals"]) {
    const names = environmentNames.map((name) =>
      JSON.stringify(templates[name].Resources[resource].Properties),
    );
    assert.equal(new Set(names).size, 3);
  }
});
const expected = {
  environment: "staging",
  sourceCommit: "a".repeat(40),
  templateDigest: "b".repeat(64),
  now: "2026-10-06T12:00:00Z",
};
function syntheticReadiness() {
  const candidate = {
    environment: "staging",
    region: "us-east-1",
    accountId: "000000000000",
    sourceCommit: expected.sourceCommit,
    templateDigest: expected.templateDigest,
    engineVersion: "17.999",
    maximumAcu: 2,
    ingressCertificateArn:
      "arn:aws:acm:us-east-1:000000000000:certificate/aabbccdd-0011-2233-4455-66778899aabb",
    s3RegionalPrefixListId: "pl-00000000",
    deploymentIssuerRolePath: "synthetic/DeploymentOwner",
    recoveryIssuerRolePath: "synthetic/RecoveryOwner",
    cloudflarePrivateProcessing: false,
    checks: Object.fromEntries(
      qualificationChecks.map((check) => [
        check,
        { status: "qualified", reference: "synthetic-not-real-evidence", ...expected },
      ]),
    ),
    quote: {
      currency: "USD",
      region: "us-east-1",
      validUntil: "2026-10-07T12:00:00Z",
      totalMonthlyEstimate: costCategories.length,
      estimateReference: "synthetic-not-a-price",
      categories: Object.fromEntries(
        costCategories.map((c) => [c, { monthlyEstimate: 1, basis: "synthetic" }]),
      ),
    },
    ownerAuthorization: {
      status: "authorized",
      accountId: "000000000000",
      environment: "staging",
      sourceCommit: expected.sourceCommit,
      templateDigest: expected.templateDigest,
      estimateReference: "synthetic-not-a-price",
      reference: "synthetic-not-user-approval",
    },
  };
  const configurationDigest = deploymentConfigurationDigest(candidate);
  for (const evidence of Object.values(candidate.checks))
    evidence.configurationDigest = configurationDigest;
  candidate.quote.configurationDigest = configurationDigest;
  candidate.ownerAuthorization.configurationDigest = configurationDigest;
  return candidate;
}
test("readiness schema can inspect complete synthetic receipts, not authorize provisioning", () => {
  assert.deepEqual(inspectProvisioningReadiness(syntheticReadiness(), expected), []);
});
for (const check of qualificationChecks)
  test(`missing ${check} receipt keeps provisioning pending`, () => {
    const candidate = syntheticReadiness();
    delete candidate.checks[check];
    assert.ok(inspectProvisioningReadiness(candidate, expected).includes("PENDING:" + check));
  });
test("changed source or template invalidates all historical qualification receipts", () => {
  assert.equal(
    inspectProvisioningReadiness(syntheticReadiness(), {
      ...expected,
      templateDigest: "c".repeat(64),
    }).filter((e) => e.startsWith("PENDING:")).length,
    qualificationChecks.length,
  );
});
for (const mutation of [
  "missing_category",
  "expired_quote",
  "wrong_region",
  "nonfinite_cost",
  "wrong_total",
  "unbound_authorization",
]) {
  test(`readiness rejects ${mutation}`, () => {
    const candidate = syntheticReadiness();
    if (mutation === "missing_category") delete candidate.quote.categories.kms;
    if (mutation === "expired_quote") candidate.quote.validUntil = expected.now;
    if (mutation === "wrong_region") candidate.quote.region = "eu-west-1";
    if (mutation === "nonfinite_cost") candidate.quote.categories.kms.monthlyEstimate = NaN;
    if (mutation === "wrong_total") candidate.quote.totalMonthlyEstimate = 1;
    if (mutation === "unbound_authorization") candidate.ownerAuthorization.templateDigest = "wrong";
    assert.ok(inspectProvisioningReadiness(candidate, expected).length > 0);
  });
}
for (const [field, changed] of [
  ["engineVersion", "17.998"],
  ["maximumAcu", 256],
  ["ingressCertificateArn", "arn:aws:acm:us-east-1:000000000000:certificate/abcdef"],
  ["s3RegionalPrefixListId", "pl-abcdef"],
  ["deploymentIssuerRolePath", "synthetic/OtherOwner"],
  ["recoveryIssuerRolePath", "synthetic/OtherRecovery"],
])
  test(`changed ${field} invalidates qualification, quote and owner cost receipts`, () => {
    const candidate = syntheticReadiness();
    candidate[field] = changed;
    const errors = inspectProvisioningReadiness(candidate, expected);
    assert.equal(
      errors.filter((error) => error.startsWith("PENDING:")).length,
      qualificationChecks.length,
    );
    assert.ok(errors.includes("COMPLETE_REGIONAL_QUOTE_REQUIRED"));
    assert.ok(errors.includes("BOUND_OWNER_COST_AUTHORIZATION_REQUIRED"));
  });
test("invalid capacity and foreign certificate cannot qualify even after receipt restamping", () => {
  const candidate = syntheticReadiness();
  candidate.maximumAcu = 0.25;
  candidate.ingressCertificateArn = "arn:aws:acm:us-east-1:111111111111:certificate/abcdef";
  const digest = deploymentConfigurationDigest(candidate);
  for (const evidence of Object.values(candidate.checks)) evidence.configurationDigest = digest;
  candidate.quote.configurationDigest = digest;
  candidate.ownerAuthorization.configurationDigest = digest;
  const errors = inspectProvisioningReadiness(candidate, expected);
  assert.ok(errors.includes("ENGINE_CAPACITY_UNQUALIFIED"));
  assert.ok(errors.includes("DEPLOYMENT_PARAMETERS_UNQUALIFIED"));
});
test("malformed account input produces denial instead of throwing during certificate inspection", () => {
  const candidate = syntheticReadiness();
  candidate.accountId = "[";
  const errors = inspectProvisioningReadiness(candidate, expected);
  assert.ok(errors.includes("ACCOUNT_UNQUALIFIED"));
  assert.ok(errors.includes("DEPLOYMENT_PARAMETERS_UNQUALIFIED"));
});
