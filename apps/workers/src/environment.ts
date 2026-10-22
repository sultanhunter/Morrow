import {
  modelProviderAnthropic,
  modelProviderVar,
  parseBrokerDatabaseBinding,
  type BrokerDatabaseBinding,
  type RuntimeBrokerRpc,
} from "../../../packages/identity/src/broker-protocol.js";

// Synchronous Worker env -> the orchestrator's configuration (M3 PR-2; spine §3 and §5). It
// never throws; any problem keeps dispatch disabled: ListingsRunWorkflow throws
// dispatch_disabled before any step, the cron starts nothing and the Queue consumer never
// acks. The orchestrator binds no secret and no provider credential (every name that looks
// like one is refused). Dispatch is enabled only when the reviewed model-provider switch is
// on (MORROW_MODEL_PROVIDER exactly "anthropic", development or staging), with the reviewed
// database binding of this environment (MORROW_DATABASE_BINDING_JSON, byte-equal to the api's
// and the broker's, through the P04.T01i PR-D path), the RuntimeBroker service binding with
// modelRespond and shopifyRead, and the LISTINGS_RUN Workflow binding. The binding is typed as
// RuntimeBrokerRpc alone, so the product read is M2 PR-3's six-argument
// shopifyRead(leaseId, generation, subjectId, queryName, variablesJson, budgetMs). An RPC stub
// answers every method name, so the method check documents the binding's shape and the
// read's presence is a reviewed constant (orchestrator.ts productReadAvailable, true since
// M2 PR-3), not a probe.
// Production never maps (its database binding waits for ADR-0007 item 9).

export type OrchestratorEnvironmentCode =
  | "ORCHESTRATOR_ENV_RECORD_INVALID"
  | "ORCHESTRATOR_ENV_PROCESS_ENV_POPULATED"
  | "ORCHESTRATOR_ENV_FORBIDDEN_CREDENTIAL_BINDING"
  | "ORCHESTRATOR_ENV_ENVIRONMENT_INVALID"
  | "ORCHESTRATOR_ENV_DISPATCH_DISABLED"
  | "ORCHESTRATOR_ENV_VALUE_INVALID"
  | "ORCHESTRATOR_ENV_CROSS_BINDING_MISMATCH"
  | "ORCHESTRATOR_ENV_BROKER_BINDING_INVALID"
  | "ORCHESTRATOR_ENV_WORKFLOW_BINDING_INVALID";
export interface WorkflowBinding {
  create(options: { id: string; params: unknown }): Promise<unknown>;
}
export type OrchestratorEnvironmentMapping =
  | Readonly<{
      ok: true;
      environment: "development" | "staging";
      binding: Readonly<BrokerDatabaseBinding>;
      broker: RuntimeBrokerRpc;
      workflow: WorkflowBinding;
    }>
  | Readonly<{ ok: false; code: OrchestratorEnvironmentCode }>;

const environments: readonly string[] = ["development", "staging", "production"];
const providerPrefix =
  /^(WORKOS_|MORROW_DB_PASSWORD_|MORROW_VAULT_|SHOPIFY_|ANTHROPIC_|OPENAI_|STRIPE_|E2B_|NEON_|PG)/i;
const credentialWord = /KEY|SECRET|PASSWORD|TOKEN/i;
const fail = (code: OrchestratorEnvironmentCode): OrchestratorEnvironmentMapping =>
  Object.freeze({ ok: false, code });
function own(record: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw Error("ORCHESTRATOR_ENV_ACCESSOR");
  return descriptor.value;
}
const callable = (value: unknown, method: string) =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as Record<string, unknown>)[method] === "function";

export function mapOrchestratorEnvironment(env: unknown): OrchestratorEnvironmentMapping {
  let keys: string[];
  try {
    if (env === null || typeof env !== "object" || Array.isArray(env))
      return fail("ORCHESTRATOR_ENV_RECORD_INVALID");
    const all = Reflect.ownKeys(env);
    if (all.some((key) => typeof key !== "string")) return fail("ORCHESTRATOR_ENV_RECORD_INVALID");
    keys = all as string[];
  } catch {
    return fail("ORCHESTRATOR_ENV_RECORD_INVALID");
  }
  try {
    const processEnv = (globalThis as { process?: { env?: unknown } }).process?.env;
    if (processEnv && typeof processEnv === "object" && Object.keys(processEnv).length > 0)
      return fail("ORCHESTRATOR_ENV_PROCESS_ENV_POPULATED");
  } catch {
    return fail("ORCHESTRATOR_ENV_PROCESS_ENV_POPULATED");
  }
  if (keys.some((key) => providerPrefix.test(key) || credentialWord.test(key)))
    return fail("ORCHESTRATOR_ENV_FORBIDDEN_CREDENTIAL_BINDING");
  const record = env as object;
  try {
    const environment = own(record, "MORROW_ENVIRONMENT");
    if (typeof environment !== "string" || !environments.includes(environment))
      return fail("ORCHESTRATOR_ENV_ENVIRONMENT_INVALID");
    if (environment === "production" || own(record, modelProviderVar) !== modelProviderAnthropic)
      return fail("ORCHESTRATOR_ENV_DISPATCH_DISABLED");
    let binding: Readonly<BrokerDatabaseBinding>;
    try {
      binding = parseBrokerDatabaseBinding(own(record, "MORROW_DATABASE_BINDING_JSON"));
    } catch {
      return fail("ORCHESTRATOR_ENV_VALUE_INVALID");
    }
    if (binding.environment !== environment) return fail("ORCHESTRATOR_ENV_CROSS_BINDING_MISMATCH");
    const broker = own(record, "BROKER");
    if (
      !callable(broker, "fetch") ||
      !callable(broker, "modelRespond") ||
      !callable(broker, "neonLease") ||
      !callable(broker, "shopifyRead")
    )
      return fail("ORCHESTRATOR_ENV_BROKER_BINDING_INVALID");
    const workflow = own(record, "LISTINGS_RUN");
    if (!callable(workflow, "create")) return fail("ORCHESTRATOR_ENV_WORKFLOW_BINDING_INVALID");
    return Object.freeze({
      ok: true,
      environment: binding.environment,
      binding,
      broker: broker as RuntimeBrokerRpc,
      workflow: workflow as WorkflowBinding,
    });
  } catch {
    return fail("ORCHESTRATOR_ENV_VALUE_INVALID");
  }
}
