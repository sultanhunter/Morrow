import { Aws, CfnParameter, Fn } from "aws-cdk-lib";
import type { Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { EnvironmentName } from "./environments.js";

export const serviceProfiles = [
  "api",
  "workers",
  "connector",
  "credential-broker",
  "task-execution",
  "deployment",
  "recovery",
] as const;
export type ServiceProfile = (typeof serviceProfiles)[number];
export interface Statement {
  Sid: string;
  Effect: "Allow";
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}
export interface ServiceResources {
  bucketArn: string;
  artifactKeyArn: string;
  credentialKeyArn: string;
  transportKeyArn: string;
  queueArns: string[];
  databaseResourceId: string;
  accountId: string;
}
const statement = (Sid: string, Action: string[], Resource: string | string[]): Statement => ({
  Sid,
  Effect: "Allow",
  Action,
  Resource,
});
export function serviceStatements(
  name: EnvironmentName,
  resources: ServiceResources,
): Record<ServiceProfile, Statement[]> {
  const account = resources.accountId;
  const prefix = `morrow-${name}`;
  const logArn = `arn:aws:logs:us-east-1:${account}:log-group:/morrow/${name}/redacted:log-stream:*`;
  const logs = statement(
    "RedactedLogDelivery",
    ["logs:CreateLogStream", "logs:PutLogEvents"],
    logArn,
  );
  const database = (user: string) =>
    statement(
      "ScopedDatabasePrincipal",
      ["rds-db:connect"],
      `arn:aws:rds-db:us-east-1:${account}:dbuser:${resources.databaseResourceId}/${user}`,
    );
  const signal = statement(
    "OpaqueDeliverySignals",
    ["sqs:SendMessage", "sqs:GetQueueAttributes"],
    resources.queueArns,
  );
  const poll = statement(
    "OpaqueDeliveryConsumption",
    [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ],
    resources.queueArns,
  );
  const signalKey: Statement = {
    ...statement(
      "EncryptedDelivery",
      ["kms:Decrypt", "kms:GenerateDataKey"],
      resources.transportKeyArn,
    ),
    Condition: { StringEquals: { "kms:ViaService": "sqs.us-east-1.amazonaws.com" } },
  };
  const bucket = statement(
    "PrivateArtifactListing",
    ["s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketLocation"],
    resources.bucketArn,
  );
  const object = statement(
    "AuthorizedArtifactOperations",
    [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:AbortMultipartUpload",
    ],
    resources.bucketArn + "/*",
  );
  const artifactKey: Statement = {
    ...statement(
      "OwnedArtifactEncryption",
      ["kms:Decrypt", "kms:GenerateDataKey"],
      resources.artifactKeyArn,
    ),
    Condition: {
      StringEquals: {
        "kms:ViaService": "s3.us-east-1.amazonaws.com",
        "kms:EncryptionContext:aws:s3:arn": resources.bucketArn,
      },
    },
  };
  const secretArn = `arn:aws:secretsmanager:us-east-1:${account}:secret:morrow/${name}/*`;
  const credentials: Statement = {
    ...statement(
      "BrokerCredentialRetrieval",
      ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      secretArn,
    ),
    Condition: { StringEquals: { "aws:RequestedRegion": "us-east-1" } },
  };
  const credentialKey: Statement = {
    ...statement("BrokerCredentialDecryption", ["kms:Decrypt"], resources.credentialKeyArn),
    Condition: {
      StringEquals: { "kms:ViaService": "secretsmanager.us-east-1.amazonaws.com" },
      StringLike: { "kms:EncryptionContext:SecretARN": secretArn },
    },
  };
  const images = ["api", "workers", "connector", "credential-broker"].map(
    (app) => `arn:aws:ecr:us-east-1:${account}:repository/${prefix}/${app}`,
  );
  const registry = statement(
    "PinnedRegistryPull",
    ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"],
    images,
  );
  const registryToken: Statement = {
    ...statement("RegistryAuthenticationOnly", ["ecr:GetAuthorizationToken"], "*"),
    Condition: { StringEquals: { "aws:RequestedRegion": "us-east-1" } },
  };
  const stackArn = `arn:aws:cloudformation:us-east-1:${account}:stack/Morrow-${name}/*`;
  const inspectDeployment = statement(
    "ReviewedStackInspection",
    [
      "cloudformation:DescribeStacks",
      "cloudformation:DescribeStackEvents",
      "cloudformation:DescribeStackResources",
      "cloudformation:GetTemplate",
    ],
    stackArn,
  );
  const inspectRecovery: Statement = {
    ...statement(
      "RecoveryInventoryOnly",
      ["rds:DescribeDBClusters", "rds:DescribeDBInstances", "rds:DescribeDBClusterSnapshots"],
      "*",
    ),
    Condition: { StringEquals: { "aws:RequestedRegion": "us-east-1" } },
  };
  return {
    api: [logs, database("morrow_api"), bucket, object, artifactKey, signal, signalKey],
    workers: [logs, database("morrow_workers"), poll, { ...signalKey, Action: ["kms:Decrypt"] }],
    connector: [logs, database("morrow_connector"), signal, signalKey],
    "credential-broker": [logs, database("morrow_broker"), credentials, credentialKey],
    "task-execution": [logs, registry, registryToken],
    deployment: [inspectDeployment],
    recovery: [inspectDeployment, inspectRecovery, bucket],
  };
}

export function defineServiceIdentities(
  stack: Stack,
  name: EnvironmentName,
  resources: ServiceResources,
): Record<ServiceProfile, iam.CfnRole> {
  const profiles = serviceStatements(name, resources);
  const roles = {} as Record<ServiceProfile, iam.CfnRole>;
  for (const profile of serviceProfiles) {
    const id = profile
      .split("-")
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join("");
    const document = { Version: "2012-10-17", Statement: profiles[profile] };
    const boundary = new iam.CfnManagedPolicy(stack, `${id}PermissionBoundary`, {
      managedPolicyName: `morrow-${name}-${profile}-boundary`,
      policyDocument: document,
    });
    let trust: object;
    if (profile === "deployment" || profile === "recovery") {
      const issuer = new CfnParameter(stack, `${id}IssuerRolePath`, {
        type: "String",
        allowedPattern: "^[A-Za-z0-9+=,.@_-]+(?:/[A-Za-z0-9+=,.@_-]+)*$",
        description: `Required qualified same-account owner issuer for ${profile}; not a model/task principal`,
      });
      trust = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            // Same account by construction; no unsupported rule-time ARN parsing.
            Principal: {
              AWS: Fn.sub("arn:aws:iam::${AWS::AccountId}:role/${IssuerRolePath}", {
                IssuerRolePath: issuer.valueAsString,
              }),
            },
            Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
            Condition: { StringEquals: { "sts:SourceIdentity": `morrow-${name}-${profile}` } },
          },
        ],
      };
    } else {
      trust = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ecs-tasks.amazonaws.com" },
            Action: "sts:AssumeRole",
            Condition: {
              StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID },
              ArnLike: { "aws:SourceArn": Fn.sub("arn:aws:ecs:us-east-1:${AWS::AccountId}:*") },
            },
          },
        ],
      };
    }
    roles[profile] = new iam.CfnRole(stack, `${id}Role`, {
      roleName: `morrow-${name}-${profile}`,
      assumeRolePolicyDocument: trust,
      permissionsBoundary: boundary.ref,
      policies: [{ policyName: `morrow-${name}-${profile}-minimum`, policyDocument: document }],
      tags: [
        { key: "morrow:environment", value: name },
        { key: "morrow:profile", value: profile },
      ],
    });
  }
  return roles;
}
