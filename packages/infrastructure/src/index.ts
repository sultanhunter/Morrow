import {
  App,
  Aws,
  BootstraplessSynthesizer,
  CfnOutput,
  CfnParameter,
  CfnRule,
  Fn,
  RemovalPolicy,
  Stack,
} from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elb from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as waf from "aws-cdk-lib/aws-wafv2";
import { Template } from "aws-cdk-lib/assertions";
import { environment } from "./environments.js";
import { defineServiceIdentities, serviceStatements } from "./service-identities.js";
export { environment, environmentNames, environments } from "./environments.js";
export type { EnvironmentDefinition, EnvironmentName } from "./environments.js";

// No context lookups, asset publication, account calls or deployment entrypoint.
export function foundationTemplate(name: string): Record<string, unknown> {
  const config = environment(name);
  const app = new App({
    analyticsReporting: false,
    context: { "@aws-cdk/core:validateAgainstDefaultRules": true },
  });
  const synthesis = new BootstraplessSynthesizer();
  const stack = new Stack(app, `Morrow-${config.name}`, {
    env: { region: config.region },
    // CDK's class exposes optional getters as undefined. Forward the required
    // interface methods to preserve our exact-optional typing without a cast.
    synthesizer: {
      bind: (target) => synthesis.bind(target),
      addFileAsset: (asset) => synthesis.addFileAsset(asset),
      addDockerImageAsset: (asset) => synthesis.addDockerImageAsset(asset),
      synthesize: (session) => synthesis.synthesize(session),
    },
    description: `Morrow ${config.name} P04 foundation candidate; ingress closed, no dispatch/workloads`,
  });
  const prefix = `morrow-${config.name}`;
  new CfnRule(stack, "RegionalBoundary", {
    assertions: [
      {
        assert: Fn.conditionEquals(Aws.REGION, "us-east-1"),
        assertDescription: "Merchant data foundation must be deployed in the qualified US region",
      },
    ],
  });
  const engine = new CfnParameter(stack, "AuroraEngineVersion", {
    type: "String",
    allowedPattern: "^17\\.[0-9]+$",
    description:
      "Required regional/account-preflighted Aurora PostgreSQL 17 minor; no assumed default",
  });
  const maximumAcu = new CfnParameter(stack, "AuroraMaximumAcu", {
    type: "Number",
    minValue: 0.5,
    maxValue: 256,
    description: "Required costed and load-qualified maximum ACUs per instance",
  });
  const certificate = new CfnParameter(stack, "IngressCertificateArn", {
    type: "String",
    allowedPattern: "^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[a-f0-9-]+$",
    description:
      "Required certificate in this environment account and us-east-1; preflight verifies ownership",
  });
  const s3PrefixList = new CfnParameter(stack, "S3RegionalPrefixListId", {
    type: "String",
    allowedPattern: "^pl-[a-f0-9]+$",
    description:
      "Required preflighted AWS-managed us-east-1 S3 prefix-list ID; no account lookup or invented default",
  });
  const retain = <T extends { applyRemovalPolicy: (policy: RemovalPolicy) => void }>(
    resource: T,
  ): T => {
    resource.applyRemovalPolicy(RemovalPolicy.RETAIN);
    return resource;
  };
  function key(id: string, logGroupName?: string): kms.CfnKey {
    const statements: object[] = [
      {
        Sid: "AccountIAMAdministration",
        Effect: "Allow",
        Principal: { AWS: Fn.sub("arn:aws:iam::${AWS::AccountId}:root") },
        Action: "kms:*",
        Resource: "*",
      },
    ];
    if (logGroupName)
      statements.push({
        Sid: "RegionalEncryptedLogs",
        Effect: "Allow",
        Principal: { Service: "logs.us-east-1.amazonaws.com" },
        Action: [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ],
        Resource: "*",
        Condition: {
          ArnEquals: {
            "kms:EncryptionContext:aws:logs:arn": Fn.sub(
              `arn:aws:logs:us-east-1:\${AWS::AccountId}:log-group:${logGroupName}`,
            ),
          },
        },
      });
    return retain(
      new kms.CfnKey(stack, id, {
        enableKeyRotation: true,
        keyPolicy: { Version: "2012-10-17", Statement: statements },
        description: `${prefix} ${id}; app grants are separate, not administrative`,
      }),
    );
  }
  const artifactKey = key("ArtifactKey");
  const databaseKey = key("DatabaseKey");
  const databaseSecretKey = key("DatabaseSecretKey");
  const credentialKey = key("CredentialKey");
  const transportKey = key("TransportKey");
  const logName = `/morrow/${config.name}/redacted`;
  const logKey = key("LogKey", logName);
  const logGroup = retain(
    new logs.CfnLogGroup(stack, "RedactedLogs", {
      logGroupName: logName,
      retentionInDays: config.logDays,
      kmsKeyId: logKey.attrArn,
    }),
  );
  const vpc = new ec2.CfnVPC(stack, "TrustedVpc", {
    cidrBlock: "10.40.0.0/16",
    enableDnsSupport: true,
    enableDnsHostnames: true,
    tags: [{ key: "Name", value: prefix + "-trusted" }],
  });
  const gateway = new ec2.CfnInternetGateway(stack, "IngressGateway");
  const attachment = new ec2.CfnVPCGatewayAttachment(stack, "IngressGatewayAttachment", {
    internetGatewayId: gateway.ref,
    vpcId: vpc.ref,
  });
  const ingressSubnets: ec2.CfnSubnet[] = [];
  const trustedSubnets: ec2.CfnSubnet[] = [];
  const trustedRoutes: ec2.CfnRouteTable[] = [];
  const databaseSubnets: ec2.CfnSubnet[] = [];
  for (let az = 0; az < config.availabilityZones; az++) {
    for (const [tier, segment, target] of [
      ["Ingress", az, ingressSubnets],
      ["Trusted", az + 10, trustedSubnets],
      ["Database", az + 20, databaseSubnets],
    ] as const) {
      const subnet = new ec2.CfnSubnet(stack, `${tier}Subnet${az}`, {
        vpcId: vpc.ref,
        cidrBlock: `10.40.${segment}.0/24`,
        availabilityZone: Fn.select(az, Fn.getAzs("us-east-1")),
        mapPublicIpOnLaunch: false,
        tags: [{ key: "Name", value: `${prefix}-${tier.toLowerCase()}-${az}` }],
      });
      target.push(subnet);
      const routes = new ec2.CfnRouteTable(stack, `${tier}Routes${az}`, { vpcId: vpc.ref });
      if (tier === "Trusted") trustedRoutes.push(routes);
      new ec2.CfnSubnetRouteTableAssociation(stack, `${tier}Association${az}`, {
        subnetId: subnet.ref,
        routeTableId: routes.ref,
      });
      if (tier === "Ingress") {
        const route = new ec2.CfnRoute(stack, `IngressInternetRoute${az}`, {
          routeTableId: routes.ref,
          destinationCidrBlock: "0.0.0.0/0",
          gatewayId: gateway.ref,
        });
        route.addResourceDependency(attachment);
      }
    }
  }
  // Explicit inert egress prevents EC2's default allow-all outbound rule.
  const noEgress = [
    { ipProtocol: "icmp", fromPort: 252, toPort: 86, cidrIp: "255.255.255.255/32" },
  ];
  const ingressGroup = new ec2.CfnSecurityGroup(stack, "IngressSecurityGroup", {
    vpcId: vpc.ref,
    groupDescription: "HTTPS-only private application ingress",
    securityGroupIngress: [{ ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: "0.0.0.0/0" }],
    securityGroupEgress: noEgress,
  });
  const apiGroup = new ec2.CfnSecurityGroup(stack, "ApiSecurityGroup", {
    vpcId: vpc.ref,
    groupDescription: "Reserved API identity boundary; no workload activated",
    securityGroupEgress: noEgress,
  });
  const workerGroup = new ec2.CfnSecurityGroup(stack, "WorkerSecurityGroup", {
    vpcId: vpc.ref,
    groupDescription: "Reserved trusted worker boundary; no workload activated",
    securityGroupEgress: noEgress,
  });
  const brokerGroup = new ec2.CfnSecurityGroup(stack, "BrokerSecurityGroup", {
    vpcId: vpc.ref,
    groupDescription: "Reserved credential broker boundary; no workload activated",
    securityGroupEgress: noEgress,
    securityGroupIngress: [apiGroup, workerGroup].map((group) => ({
      ipProtocol: "tcp",
      fromPort: 8443,
      toPort: 8443,
      sourceSecurityGroupId: group.attrGroupId,
    })),
  });
  for (const [id, group] of [
    ["Api", apiGroup],
    ["Worker", workerGroup],
  ] as const) {
    new ec2.CfnSecurityGroupEgress(stack, `${id}BrokerEgress`, {
      groupId: group.attrGroupId,
      ipProtocol: "tcp",
      fromPort: 8443,
      toPort: 8443,
      destinationSecurityGroupId: brokerGroup.attrGroupId,
    });
  }
  const dbGroup = new ec2.CfnSecurityGroup(stack, "DatabaseSecurityGroup", {
    vpcId: vpc.ref,
    groupDescription: "Database only from reserved trusted API/worker groups",
    securityGroupEgress: noEgress,
    securityGroupIngress: [apiGroup, workerGroup, brokerGroup].map((group) => ({
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: group.attrGroupId,
    })),
  });
  const dbSubnetGroup = new rds.CfnDBSubnetGroup(stack, "DatabaseSubnetGroup", {
    dbSubnetGroupDescription: `${prefix} isolated database subnets`,
    subnetIds: databaseSubnets.map((subnet) => subnet.ref),
  });
  const dbParameters = new rds.CfnDBClusterParameterGroup(stack, "DatabaseParameters", {
    description: `${prefix} encrypted connections and suppressed statement telemetry`,
    family: "aurora-postgresql17",
    parameters: { "rds.force_ssl": "1", log_statement: "none", log_min_duration_statement: "-1" },
  });
  const cluster = new rds.CfnDBCluster(stack, "Database", {
    dbClusterIdentifier: `${prefix}-records`,
    engine: "aurora-postgresql",
    engineMode: "provisioned",
    engineVersion: engine.valueAsString,
    dbSubnetGroupName: dbSubnetGroup.ref,
    dbClusterParameterGroupName: dbParameters.ref,
    vpcSecurityGroupIds: [dbGroup.attrGroupId],
    storageEncrypted: true,
    kmsKeyId: databaseKey.attrArn,
    manageMasterUserPassword: true,
    masterUsername: "morrow_admin",
    masterUserSecret: { kmsKeyId: databaseSecretKey.attrArn },
    enableIamDatabaseAuthentication: true,
    port: 5432,
    backupRetentionPeriod: config.backupDays,
    deletionProtection: true,
    // Database statement/error logs may contain merchant data. P04.T03 must
    // qualify a redaction path before enabling content-bearing exports.
    copyTagsToSnapshot: true,
    serverlessV2ScalingConfiguration: {
      minCapacity: config.minimumAcu,
      maxCapacity: maximumAcu.valueAsNumber,
    },
  });
  cluster.applyRemovalPolicy(RemovalPolicy.SNAPSHOT);
  for (let i = 0; i < config.databaseInstances; i++) {
    const instance = new rds.CfnDBInstance(stack, i === 0 ? "Writer" : "Reader", {
      dbClusterIdentifier: cluster.ref,
      dbInstanceClass: "db.serverless",
      engine: "aurora-postgresql",
      availabilityZone: Fn.select(i, Fn.getAzs("us-east-1")),
      publiclyAccessible: false,
      promotionTier: i,
      autoMinorVersionUpgrade: false,
    });
    instance.applyRemovalPolicy(RemovalPolicy.RETAIN);
  }
  const artifacts = retain(
    new s3.CfnBucket(stack, "Artifacts", {
      bucketName: Fn.sub(`${prefix}-artifacts-\${AWS::AccountId}-us-east-1`),
      versioningConfiguration: { status: "Enabled" },
      ownershipControls: { rules: [{ objectOwnership: "BucketOwnerEnforced" }] },
      publicAccessBlockConfiguration: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      bucketEncryption: {
        serverSideEncryptionConfiguration: [
          {
            bucketKeyEnabled: true,
            serverSideEncryptionByDefault: {
              sseAlgorithm: "aws:kms",
              kmsMasterKeyId: artifactKey.attrArn,
            },
          },
        ],
      },
      lifecycleConfiguration: {
        rules: [
          {
            id: "AbandonedMultipart",
            status: "Enabled",
            abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
          },
          {
            id: "ClosedWorkingFiles",
            status: "Enabled",
            prefix: "closed-working/",
            expirationInDays: 7,
            noncurrentVersionExpiration: { noncurrentDays: 7 },
          },
        ],
      },
    }),
  );
  new s3.CfnBucketPolicy(stack, "ArtifactPolicy", {
    bucket: artifacts.ref,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "TransportEncryption",
          Effect: "Deny",
          Principal: "*",
          Action: "s3:*",
          Resource: [artifacts.attrArn, Fn.join("", [artifacts.attrArn, "/*"])],
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        },
        {
          Sid: "RejectEncryptionOverride",
          Effect: "Deny",
          Principal: "*",
          Action: "s3:PutObject",
          Resource: Fn.join("", [artifacts.attrArn, "/*"]),
          Condition: {
            Null: { "s3:x-amz-server-side-encryption": "false" },
            StringNotEquals: { "s3:x-amz-server-side-encryption": "aws:kms" },
          },
        },
        {
          Sid: "RejectDifferentKey",
          Effect: "Deny",
          Principal: "*",
          Action: "s3:PutObject",
          Resource: Fn.join("", [artifacts.attrArn, "/*"]),
          Condition: {
            Null: { "s3:x-amz-server-side-encryption-aws-kms-key-id": "false" },
            StringNotEquals: {
              "s3:x-amz-server-side-encryption-aws-kms-key-id": artifactKey.attrArn,
            },
          },
        },
        {
          Sid: "ExplicitEncryptionRequiresOwnedKey",
          Effect: "Deny",
          Principal: "*",
          Action: "s3:PutObject",
          Resource: Fn.join("", [artifacts.attrArn, "/*"]),
          Condition: {
            Null: {
              "s3:x-amz-server-side-encryption": "false",
              "s3:x-amz-server-side-encryption-aws-kms-key-id": "true",
            },
          },
        },
      ],
    },
  });
  const deadLetters = retain(
    new sqs.CfnQueue(stack, "DeliveryDeadLetters", {
      queueName: `${prefix}-delivery-dlq`,
      kmsMasterKeyId: transportKey.attrArn,
      messageRetentionPeriod: 1209600,
    }),
  );
  const queue = retain(
    new sqs.CfnQueue(stack, "DeliverySignals", {
      queueName: `${prefix}-delivery-signals`,
      kmsMasterKeyId: transportKey.attrArn,
      messageRetentionPeriod: 345600,
      visibilityTimeout: 60,
      receiveMessageWaitTimeSeconds: 20,
      redrivePolicy: { deadLetterTargetArn: deadLetters.attrArn, maxReceiveCount: 5 },
    }),
  );
  // Signals contain opaque outbox IDs; PostgreSQL remains authoritative, not this queue.
  new sqs.CfnQueuePolicy(stack, "DeliveryPolicy", {
    queues: [queue.ref, deadLetters.ref],
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Deny",
          Principal: "*",
          Action: "sqs:*",
          Resource: [queue.attrArn, deadLetters.attrArn],
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        },
      ],
    },
  });
  const identityResources = {
    accountId: Aws.ACCOUNT_ID,
    databaseResourceId: cluster.attrDbClusterResourceId,
    bucketArn: artifacts.attrArn,
    artifactKeyArn: artifactKey.attrArn,
    credentialKeyArn: credentialKey.attrArn,
    transportKeyArn: transportKey.attrArn,
    queueArns: [queue.attrArn, deadLetters.attrArn],
  };
  const roles = defineServiceIdentities(stack, config.name, identityResources);
  const permissions = serviceStatements(config.name, identityResources);
  const endpointGroup = new ec2.CfnSecurityGroup(stack, "PrivateEndpointSecurityGroup", {
    vpcId: vpc.ref,
    groupDescription: "AWS private dependency endpoints from trusted workload groups only",
    securityGroupEgress: noEgress,
    securityGroupIngress: [apiGroup, workerGroup, brokerGroup].map((group) => ({
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      sourceSecurityGroupId: group.attrGroupId,
    })),
  });
  for (const [id, group] of [
    ["Api", apiGroup],
    ["Worker", workerGroup],
    ["Broker", brokerGroup],
  ] as const) {
    new ec2.CfnSecurityGroupEgress(stack, `${id}DatabaseEgress`, {
      groupId: group.attrGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      destinationSecurityGroupId: dbGroup.attrGroupId,
    });
    new ec2.CfnSecurityGroupEgress(stack, `${id}PrivateDependencyEgress`, {
      groupId: group.attrGroupId,
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      destinationSecurityGroupId: endpointGroup.attrGroupId,
    });
  }
  const profilePolicy = (
    profiles: (keyof typeof roles)[],
    select: (action: string) => boolean,
  ) => ({
    Version: "2012-10-17",
    Statement: profiles.flatMap((profile) => {
      return permissions[profile]
        .filter((statement) => statement.Action.some(select))
        .map((statement) => ({ ...statement, Principal: { AWS: roles[profile].attrArn } }));
    }),
  });
  const interfaces = [
    ["RegistryApiEndpoint", "ecr.api", ["task-execution"], "ecr:"],
    ["RegistryDockerEndpoint", "ecr.dkr", ["task-execution"], "ecr:"],
    [
      "LogEndpoint",
      "logs",
      ["api", "workers", "connector", "credential-broker", "task-execution"],
      "logs:",
    ],
    ["SecretEndpoint", "secretsmanager", ["credential-broker"], "secretsmanager:"],
    ["SignalEndpoint", "sqs", ["api", "workers", "connector"], "sqs:"],
  ] as const;
  for (const [id, service, profiles, actionPrefix] of interfaces) {
    new ec2.CfnVPCEndpoint(stack, id, {
      vpcId: vpc.ref,
      vpcEndpointType: "Interface",
      serviceName: `com.amazonaws.us-east-1.${service}`,
      subnetIds: trustedSubnets.map((subnet) => subnet.ref),
      securityGroupIds: [endpointGroup.attrGroupId],
      privateDnsEnabled: true,
      policyDocument: profilePolicy([...profiles], (action) => action.startsWith(actionPrefix)),
    });
  }
  const storageEndpoint = new ec2.CfnVPCEndpoint(stack, "StorageGatewayEndpoint", {
    vpcId: vpc.ref,
    vpcEndpointType: "Gateway",
    serviceName: "com.amazonaws.us-east-1.s3",
    routeTableIds: trustedRoutes.map((routes) => routes.ref),
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        ...profilePolicy(["api", "recovery"], (action) => action.startsWith("s3:")).Statement,
        {
          Sid: "RegionalRegistryLayersOnly",
          Effect: "Allow",
          Principal: "*",
          Action: ["s3:GetObject"],
          Resource: "arn:aws:s3:::prod-us-east-1-starport-layer-bucket/*",
        },
      ],
    },
  });
  // Gateway prefix lists are regional, but the endpoint policy also restricts
  // buckets/principals; this is not arbitrary S3 or internet access.
  for (const [id, group] of [
    ["Api", apiGroup],
    ["Worker", workerGroup],
    ["Broker", brokerGroup],
  ] as const) {
    new ec2.CfnSecurityGroupEgress(stack, `${id}StorageEndpointEgress`, {
      groupId: group.attrGroupId,
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      destinationPrefixListId: s3PrefixList.valueAsString,
    });
  }
  const loadBalancer = new elb.CfnLoadBalancer(stack, "PrivateApplicationIngress", {
    type: "application",
    scheme: "internet-facing",
    subnets: ingressSubnets.map((s) => s.ref),
    securityGroups: [ingressGroup.attrGroupId],
    loadBalancerAttributes: [
      { key: "routing.http.drop_invalid_header_fields.enabled", value: "true" },
      { key: "routing.http.desync_mitigation_mode", value: "strictest" },
      { key: "deletion_protection.enabled", value: "true" },
    ],
  });
  loadBalancer.addResourceDependency(attachment);
  new elb.CfnListener(stack, "ClosedHttpsIngress", {
    loadBalancerArn: loadBalancer.ref,
    protocol: "HTTPS",
    port: 443,
    sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
    certificates: [{ certificateArn: certificate.valueAsString }],
    defaultActions: [
      {
        type: "fixed-response",
        fixedResponseConfig: {
          statusCode: "503",
          contentType: "application/json",
          messageBody: '{"status":"not_activated"}',
        },
      },
    ],
  });
  const firewall = new waf.CfnWebACL(stack, "RegionalFirewall", {
    scope: "REGIONAL",
    defaultAction: { allow: {} },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      metricName: `${prefix}-ingress`,
      sampledRequestsEnabled: false,
    },
    rules: [
      {
        name: "CommonIngressRules",
        priority: 0,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: "AWS",
            name: "AWSManagedRulesCommonRuleSet",
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `${prefix}-common`,
          sampledRequestsEnabled: false,
        },
      },
    ],
  });
  new waf.CfnWebACLAssociation(stack, "RegionalFirewallAssociation", {
    resourceArn: loadBalancer.ref,
    webAclArn: firewall.attrArn,
  });
  const trustedCluster = new ecs.CfnCluster(stack, "TrustedCompute", {
    clusterName: `${prefix}-trusted`,
    capacityProviders: ["FARGATE"],
    clusterSettings: [{ name: "containerInsights", value: "disabled" }],
  });
  // A separate unrouted VPC is reserved only. There are no task definitions,
  // task roles, peering, endpoints, gateways or execution services here.
  const sandboxVpc = new ec2.CfnVPC(stack, "UntrustedVpc", {
    cidrBlock: "10.41.0.0/16",
    // Unrouted subnets alone do not block Amazon's resolver. Reserve this pool
    // without DNS; P12 must qualify explicit broker/proxy discovery and egress.
    enableDnsSupport: false,
    enableDnsHostnames: false,
    tags: [{ key: "Name", value: `${prefix}-untrusted-reserved` }],
  });
  for (let i = 0; i < 2; i++) {
    const subnet = new ec2.CfnSubnet(stack, `UntrustedSubnet${i}`, {
      vpcId: sandboxVpc.ref,
      availabilityZone: Fn.select(i, Fn.getAzs("us-east-1")),
      cidrBlock: `10.41.${i}.0/24`,
      mapPublicIpOnLaunch: false,
    });
    const routes = new ec2.CfnRouteTable(stack, `UntrustedRoutes${i}`, { vpcId: sandboxVpc.ref });
    new ec2.CfnSubnetRouteTableAssociation(stack, `UntrustedAssociation${i}`, {
      subnetId: subnet.ref,
      routeTableId: routes.ref,
    });
  }
  new ec2.CfnSecurityGroup(stack, "UntrustedSecurityGroup", {
    vpcId: sandboxVpc.ref,
    groupDescription: "Reserved untrusted runtime; no ingress or egress",
    securityGroupEgress: noEgress,
  });
  for (const [id, value] of Object.entries({
    Environment: config.name,
    Region: config.region,
    Dispatch: "disabled",
    DatabaseEndpoint: cluster.attrEndpointAddress,
    ArtifactBucket: artifacts.ref,
    SignalQueueUrl: queue.ref,
    LogGroup: logGroup.ref,
    TrustedComputeArn: trustedCluster.attrArn,
    UntrustedVpcId: sandboxVpc.ref,
  }))
    new CfnOutput(stack, id, { value });
  return Template.fromStack(stack).toJSON() as Record<string, unknown>;
}
