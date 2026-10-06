import type { EnvironmentName } from "./environments.js";
import { createHash } from "node:crypto";
export const deploymentParameterNames = [
  "AuroraEngineVersion",
  "AuroraMaximumAcu",
  "IngressCertificateArn",
  "S3RegionalPrefixListId",
  "DeploymentIssuerRolePath",
  "RecoveryIssuerRolePath",
] as const;

export const costCategories = [
  "aurora_compute",
  "aurora_storage_io",
  "database_backups",
  "fargate_api",
  "fargate_workers",
  "fargate_untrusted",
  "load_balancer",
  "waf",
  "network_egress_endpoints",
  "s3_storage_requests",
  "sqs",
  "kms",
  "secrets_manager",
  "observability",
  "temporal",
  "workos",
  "cloudflare_dns_assets",
  "image_registry_storage",
] as const;
export const qualificationChecks = [
  "account_ownership",
  "regional_engine_capacity",
  "regional_certificate",
  "environment_access_denial",
  "service_network_identity",
  "secret_rotation",
  "restore_quarantine",
  "provider_data_terms",
  "repository_protection",
] as const;
export interface Evidence {
  status: "pending" | "qualified";
  reference: string;
  sourceCommit: string;
  templateDigest: string;
  configurationDigest: string;
}
export interface ProvisioningReadiness {
  environment: EnvironmentName;
  region: string;
  accountId: string | null;
  sourceCommit: string | null;
  templateDigest: string | null;
  engineVersion: string | null;
  maximumAcu: number | null;
  ingressCertificateArn: string | null;
  s3RegionalPrefixListId: string | null;
  deploymentIssuerRolePath: string | null;
  recoveryIssuerRolePath: string | null;
  cloudflarePrivateProcessing: boolean;
  checks: Partial<Record<(typeof qualificationChecks)[number], Evidence>>;
  quote: {
    currency: string;
    region: string;
    validUntil: string;
    totalMonthlyEstimate: number;
    estimateReference: string;
    configurationDigest: string;
    categories: Partial<
      Record<(typeof costCategories)[number], { monthlyEstimate: number; basis: string }>
    >;
  } | null;
  ownerAuthorization: {
    status: "pending" | "authorized";
    accountId: string;
    environment: EnvironmentName;
    sourceCommit: string;
    templateDigest: string;
    configurationDigest: string;
    estimateReference: string;
    reference: string;
  } | null;
}
// Fixed normalized non-secret fields; no keys, credentials or provider content.
export function deploymentConfigurationDigest(candidate: ProvisioningReadiness): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        environment: candidate.environment,
        accountId: candidate.accountId,
        region: candidate.region,
        parameters: {
          AuroraEngineVersion: candidate.engineVersion,
          AuroraMaximumAcu: candidate.maximumAcu,
          IngressCertificateArn: candidate.ingressCertificateArn,
          S3RegionalPrefixListId: candidate.s3RegionalPrefixListId,
          DeploymentIssuerRolePath: candidate.deploymentIssuerRolePath,
          RecoveryIssuerRolePath: candidate.recoveryIssuerRolePath,
        },
      }),
    )
    .digest("hex");
}
// Evidence inventory only. This does not execute deployments or authenticate an approver.
// A future privileged deployment port must verify these receipts independently.
export function inspectProvisioningReadiness(
  candidate: ProvisioningReadiness,
  expected: {
    environment: EnvironmentName;
    sourceCommit: string;
    templateDigest: string;
    now: string;
  },
): string[] {
  const errors: string[] = [];
  const configurationDigest = deploymentConfigurationDigest(candidate);
  if (candidate.environment !== expected.environment) errors.push("ENVIRONMENT_MISMATCH");
  if (candidate.region !== "us-east-1" || candidate.cloudflarePrivateProcessing !== false)
    errors.push("REGIONAL_BOUNDARY");
  if (!candidate.accountId || !/^[0-9]{12}$/.test(candidate.accountId))
    errors.push("ACCOUNT_UNQUALIFIED");
  if (
    !/^[a-f0-9]{40}$/.test(expected.sourceCommit) ||
    candidate.sourceCommit !== expected.sourceCommit
  )
    errors.push("SOURCE_MISMATCH");
  if (
    !/^[a-f0-9]{64}$/.test(expected.templateDigest) ||
    candidate.templateDigest !== expected.templateDigest
  )
    errors.push("TEMPLATE_MISMATCH");
  if (
    !candidate.engineVersion ||
    !/^17\.[0-9]+$/.test(candidate.engineVersion) ||
    candidate.maximumAcu === null ||
    !Number.isFinite(candidate.maximumAcu) ||
    candidate.maximumAcu < 0.5 ||
    candidate.maximumAcu > 256 ||
    !Number.isInteger(candidate.maximumAcu * 2)
  )
    errors.push("ENGINE_CAPACITY_UNQUALIFIED");
  const rolePath = /^[A-Za-z0-9+=,.@_-]+(?:\/[A-Za-z0-9+=,.@_-]+)*$/;
  const certificateAccount = /^arn:aws:acm:us-east-1:([0-9]{12}):certificate\/[a-f0-9-]+$/.exec(
    candidate.ingressCertificateArn ?? "",
  )?.[1];
  if (
    !certificateAccount ||
    certificateAccount !== candidate.accountId ||
    !candidate.s3RegionalPrefixListId ||
    !/^pl-[a-f0-9]+$/.test(candidate.s3RegionalPrefixListId) ||
    !candidate.deploymentIssuerRolePath ||
    !rolePath.test(candidate.deploymentIssuerRolePath) ||
    !candidate.recoveryIssuerRolePath ||
    !rolePath.test(candidate.recoveryIssuerRolePath)
  )
    errors.push("DEPLOYMENT_PARAMETERS_UNQUALIFIED");
  for (const check of qualificationChecks) {
    const evidence = candidate.checks[check];
    if (
      !evidence ||
      evidence.status !== "qualified" ||
      !evidence.reference.trim() ||
      evidence.sourceCommit !== expected.sourceCommit ||
      evidence.templateDigest !== expected.templateDigest ||
      evidence.configurationDigest !== configurationDigest
    )
      errors.push("PENDING:" + check);
  }
  const quote = candidate.quote;
  let quoteValid = !!quote;
  if (quote) {
    const now = Date.parse(expected.now);
    const until = Date.parse(quote.validUntil);
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(until) ||
      until <= now ||
      quote.currency !== "USD" ||
      quote.region !== "us-east-1" ||
      quote.configurationDigest !== configurationDigest ||
      !quote.estimateReference.trim() ||
      !Number.isFinite(quote.totalMonthlyEstimate) ||
      quote.totalMonthlyEstimate < 0
    )
      quoteValid = false;
    let total = 0;
    for (const category of costCategories) {
      const line = quote.categories[category];
      if (
        !line ||
        !Number.isFinite(line.monthlyEstimate) ||
        line.monthlyEstimate < 0 ||
        !line.basis.trim()
      )
        quoteValid = false;
      else total += line.monthlyEstimate;
    }
    if (Math.abs(total - quote.totalMonthlyEstimate) > 0.005) quoteValid = false;
  }
  if (!quoteValid) errors.push("COMPLETE_REGIONAL_QUOTE_REQUIRED");
  const authorization = candidate.ownerAuthorization;
  if (
    !authorization ||
    authorization.status !== "authorized" ||
    !authorization.reference.trim() ||
    authorization.accountId !== candidate.accountId ||
    authorization.environment !== expected.environment ||
    authorization.sourceCommit !== expected.sourceCommit ||
    authorization.templateDigest !== expected.templateDigest ||
    authorization.configurationDigest !== configurationDigest ||
    !quote ||
    authorization.estimateReference !== quote.estimateReference
  )
    errors.push("BOUND_OWNER_COST_AUTHORIZATION_REQUIRED");
  return errors;
}
