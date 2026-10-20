// Credential-free design inventory. No provider SDK, network or activation path.
import { createHash } from "node:crypto";

export const selectedStack = "cloudflare-neon-runtime";
export const selectedEnvironments = ["development", "staging", "production"] as const;
export type SelectedEnvironment = (typeof selectedEnvironments)[number];

// Staging (P04.T01i D1, ADR-0019 items 2 and 10): the workers.dev origin, the Neon Free
// root and `staging` branches with the observed history window instead of Launch PITR,
// and the GitHub environment that holds the CI deploy token (OQ-2 answer A). Every
// identifier stays null until P04.T01i PR-D commits the reviewed values here.
const stagingCloudflare = { workers_dev_subdomain: null, origin: null };
const stagingNeon = {
  root_branch_id: null,
  branch_name: "staging",
  history_window_hours: 6,
  recovery: "owner_reset_from_root_branch",
  recovery_requirement: "seven_day_staging_recovery_open_in_P04.T04",
};
const stagingGithub = {
  repository: "sultanhunter/Morrow",
  scope: "environment",
  environment: "staging",
};

export function selectedConfiguration(environment: SelectedEnvironment) {
  if (!selectedEnvironments.includes(environment)) throw Error("UNKNOWN_ENVIRONMENT");
  const prefix = `morrow-${environment}`;
  const staging = environment === "staging";
  return {
    schema_version: 1,
    stack: selectedStack,
    environment,
    status: "design_candidate",
    global_processing: "permitted_under_approved_data_policy",
    cloudflare: {
      account_id: null,
      ...(staging ? { ...stagingCloudflare } : {}),
      workers: {
        api: `${prefix}-api`,
        connector: `${prefix}-connector`,
        broker: `${prefix}-broker`,
        orchestrator: `${prefix}-orchestrator`,
      },
      buckets: {
        artifacts: `${prefix}-artifacts`,
        working: `${prefix}-working`,
        recovery: `${prefix}-recovery`,
      },
      primary_storage_country: "US",
      private_processing: true,
      private_response_cache: false,
      broker_public_route: false,
      raw_provider_keys_in_api: false,
      artifact_revisions: "unique_keys_checksums_conditional_create",
    },
    neon: {
      project_id: null,
      branch_id: null,
      region_id: null,
      primary_storage_country: "US",
      major_version: 17,
      minor_version: null,
      plan: environment === "production" ? "Scale" : staging ? "Free" : "Launch",
      maximum_cu: null,
      pitr_days: environment === "production" ? 30 : staging ? null : 7,
      daily_recovery_days: environment === "production" ? 35 : staging ? null : 7,
      ...(staging ? { ...stagingNeon } : {}),
      tenant_context: "SET_LOCAL_in_interactive_transaction",
      authority_cache: false,
    },
    runtime: {
      provider: "e2b",
      project_id: null,
      region: null,
      sandbox_class: "linux_microvm",
      template_id: null,
      template_build_id: null,
      image_digest: null,
      direct_internet: false,
      direct_database: false,
      raw_provider_keys: false,
      public_preview: false,
      single_writer_generation: true,
      effective_network_tests: "not_run",
      dispatch: "disabled",
    },
    workflow: {
      provider: "cloudflare_workflows",
      transport: "cloudflare_queues",
      business_state: "postgresql",
      payload: "opaque_references_and_safe_enums",
      closed_retention_days: environment === "production" ? 30 : 7,
      version_qualification: "not_run",
    },
    quote: null,
    owner_cost_authorization: null,
    provider_qualification: null,
    deployed_revision: null,
    dispatch: "disabled",
    ...(staging ? { github: { ...stagingGithub } } : {}),
  };
}

export type SelectedConfiguration = ReturnType<typeof selectedConfiguration>;

function canonical(value: unknown, depth = 0): string {
  if (depth > 16 || ["undefined", "bigint", "symbol", "function"].includes(typeof value))
    throw Error("INVALID_CONFIGURATION_VALUE");
  if (typeof value === "number" && !Number.isFinite(value))
    throw Error("INVALID_CONFIGURATION_VALUE");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((child) => canonical(child, depth + 1)).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child, depth + 1)}`)
    .join(",")}}`;
}

// Deliberately accepts only the current unbound local design. Provider account
// binding and activation need a separately qualified adapter, not edited JSON.
export function inspectSelectedConfiguration(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["INVALID_CONFIGURATION"];
  const input = value as Partial<SelectedConfiguration>;
  if (!selectedEnvironments.includes(input.environment as SelectedEnvironment))
    return ["UNKNOWN_ENVIRONMENT"];
  const expected = selectedConfiguration(input.environment as SelectedEnvironment);
  try {
    return canonical(value) === canonical(expected) ? [] : ["UNREVIEWED_CONFIGURATION_DELTA"];
  } catch {
    return ["INVALID_CONFIGURATION_VALUE"];
  }
}

export function compileSelectedConfiguration(value: unknown) {
  const errors = inspectSelectedConfiguration(value);
  if (errors.length) throw Error(errors.join(","));
  const config = value as SelectedConfiguration;
  const serialized = canonical(config);
  return {
    configuration: config,
    configuration_sha256: createHash("sha256").update(serialized).digest("hex"),
    resource_creation: false,
    deployment_entrypoint: false,
    provider_calls: false,
    qualification: "local_design_inventory_only",
  };
}

export const selectedPermissionProfiles = {
  api: [
    "current_identity_and_policy_reads",
    "authorized_artifact_gateway",
    "submit_bounded_commands",
  ],
  connector: ["verify_install_webhook_origin", "submit_scoped_connector_commands"],
  orchestrator: ["opaque_queue_workflow_references", "request_current_authority_and_budget"],
  credential_broker: [
    "tenant_environment_bound_credential_records",
    "approved_provider_calls_only",
  ],
  execution: ["leased_broker_artifact_capabilities_only"],
  deployment: ["reviewed_environment_configuration_only"],
  recovery: ["quarantined_restore_and_marker_replay_only"],
} as const;
