import { validateCurrentDefinition } from "@morrow/contracts/validation";
import type { CapabilityId } from "@morrow/contracts";
import { workPermissions } from "@morrow/contracts/work-permissions";
import {
  entitlementFor,
  parseWorkspaceBillingFacts,
  workspaceBillingState,
} from "@morrow/policy/billing-state";
import {
  defaultMemberCreditCeiling,
  findCatalogueEntry,
  activeCatalogueVersion,
  resolveSelection,
} from "@morrow/policy/model-catalogue";
import { storeResource, type StoreResource } from "@morrow/policy/store-resource";
import { decideOn, reviseAllowed } from "../agents/commands.js";
import { createBillingFactsReader } from "../billing/facts.js";
import { WorkReject, type WorkRejection, type WorkTx } from "../connection.js";
import { enterWorkContext, WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { canonicalJson, sha256Hex } from "../digest.js";
import type { GuardedWorkspaceRequest, WorkspaceRouteSpec } from "../http-guard.js";
import { decideWork } from "../permissions.js";
import { coordinatorRoute, listingsWorkflowVersion } from "./coordinator.js";
import { runFieldsValid, type ListingField } from "./drafting.js";

// Run admission and the run reads (M3 PR-2; mvp-architecture §2 step 7 and §9; ADR-0022
// items 3, 9, 11 and 16). Admission runs in one api transaction, every check before the
// definer, and cmd_run_admit rechecks every data rule under the P06.T01a prelude and derives
// the billing account, period and allocation itself:
//   * the human kernel on the store resource: execute on catalog.content.propose, view on
//     catalog.products.read, delegate on both, propose and delegate on catalog.content.publish
//     (the requester delegates to the Coordinator and the installation; an agent never
//     exceeds the requester);
//   * entitlement through entitlementFor over M5's billing facts (drafting is not paid work
//     under isPaidWork, so createBillingConstraintsReader would skip it: ADR-0022 item 11);
//   * the selection resolved against the active catalogue within the member's ceiling
//     (governance.model_default.revise exempts; a provider model string, an unknown or
//     retired key and xhigh are refused, a missing selection is the workspace default);
//   * the products: 1..the entry's run limit distinct product ids (25 for every entry from
//     catalogue version 4, ADR-0039 item 4); the fields: the run's listing fields with the
//     SEO pair;
//   * the parent task is the actor's own; the store's Listings installation is active.
// The code Coordinator writes CoordinatorRoute@1. Every refusal persists nothing; an unknown
// outcome is never reported as success or refusal.

export type RunCommandType = "run.admit" | "run.reconcile";
export type RunRead = "run.get" | "run.list_of_task";
export interface RunResult {
  readonly status: 200 | 201;
  readonly body: Readonly<Record<string, unknown>>;
  readonly outcome: string;
}
/** The refusals admission names, beyond the work API's own (runs/http.ts maps them). */
export type RunRefusal =
  | "runs_unavailable"
  | "entitlement"
  | "insufficient_credits"
  // Never returned since migration 0055 (ADR-0039: credits are the only spend limit, so
  // run_reserve has no daily cap); kept for the closed set.
  | "daily_cap"
  // Never returned since migration 0051 (ADR-0036 removed the cap); kept for the closed set.
  | "unrecovered_cost_cap"
  | "run_product_limit"
  | "selection_invalid"
  | "selection_above_ceiling"
  | "stopped"
  | "installation_inactive"
  | "approvals_limit";
export class RunReject extends Error {
  constructor(readonly reason: RunRefusal) {
    super("RUN_REJECTED");
    this.name = "RunReject";
  }
}
type Guarded = GuardedWorkspaceRequest<WorkspaceRouteSpec>;
export interface AdmitBody {
  readonly storeId: string;
  readonly products: readonly string[];
  readonly fields: readonly ListingField[];
  readonly selection: unknown;
}
export interface PreparedRunCommand {
  readonly type: RunCommandType;
  readonly parsed: AdmitBody | Record<string, never>;
  readonly digest: string;
}
const productPattern = /^product:[1-9][0-9]{0,19}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || !own.every((key) => keys.includes(key))) return null;
  return value as Record<string, unknown>;
}
/**
 * POST /work/tasks/:taskId/runs: {storeId, products, fields, selection}. The selection is
 * ModelSelection@1 or null (the workspace default); never a provider, price or credit value.
 */
export function parseAdmitBody(body: unknown): AdmitBody | null {
  const r = record(body, ["storeId", "products", "fields", "selection"]);
  if (!r || typeof r.storeId !== "string" || !idPattern.test(r.storeId)) return null;
  const products = r.products;
  if (
    !Array.isArray(products) ||
    products.length < 1 ||
    products.length > 25 ||
    !products.every((p) => typeof p === "string" && productPattern.test(p)) ||
    new Set(products).size !== products.length
  )
    return null;
  const fields = Array.isArray(r.fields) ? [...(r.fields as unknown[])].sort() : null;
  if (!fields || !runFieldsValid(fields)) return null;
  if (r.selection !== null && !validateCurrentDefinition("ModelSelection", r.selection))
    return null;
  return {
    storeId: r.storeId,
    products: [...(products as string[])],
    fields: fields as ListingField[],
    selection: r.selection,
  };
}
export async function prepareRunCommand(
  type: RunCommandType,
  g: Guarded,
): Promise<PreparedRunCommand> {
  const parsed = type === "run.admit" ? parseAdmitBody(g.body) : record(g.body, []) ? {} : null;
  if (parsed === null) throw new WorkReject("invalid");
  const pathIds = g.params.taskId === undefined ? [] : [g.params.taskId];
  const digest = await sha256Hex(
    canonicalJson(["morrow.work.command", 1, type, g.workspaceId, pathIds, g.body]),
  );
  return Object.freeze({ type, parsed: parsed as AdmitBody | Record<string, never>, digest });
}

const text = (row: Record<string, unknown>, key: string) => {
  const value = row[key];
  if (typeof value !== "string") throw new WorkContextUnavailable();
  return value;
};
const optional = (row: Record<string, unknown>, key: string) =>
  row[key] === null ? null : text(row, key);
const one = (rows: readonly Record<string, unknown>[]) => {
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0]) throw new WorkContextUnavailable();
  return rows[0];
};
async function context(tx: WorkTx, g: Guarded): Promise<WorkAuthority> {
  const a = await enterWorkContext(tx, g.sessionDigest, g.workspaceId);
  if (a === "ineligible") throw new WorkReject("unauthenticated");
  if (a === "grant_overflow") throw new WorkReject("grant_overflow");
  return a;
}
async function begin(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedRunCommand,
): Promise<RunResult | null> {
  if (g.commandId === null) throw new WorkReject("invalid");
  const b = one(await tx.run("beginRunCommand", [prepared.type, g.commandId, prepared.digest]));
  if (!b || typeof b.outcome !== "string") throw new WorkContextUnavailable();
  if (b.outcome === "conflict") throw new WorkReject("command_conflict");
  if (b.outcome === "ineligible") throw new WorkReject("unauthenticated");
  if (b.outcome === "replay") {
    tx.rollbackOnly();
    return {
      status: 200,
      body: { ...decodeResult(b.result), replayed: true },
      outcome: "replayed",
    };
  }
  if (b.outcome !== "new") throw new WorkReject("invalid");
  return null;
}
function decodeResult(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new WorkContextUnavailable();
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new WorkContextUnavailable();
  return parsed as Record<string, unknown>;
}
// cmd_run_admit's refusals: the work API's own kinds, or the run refusals.
const workOutcomes: Readonly<Record<string, WorkRejection>> = Object.freeze({
  invalid: "invalid",
  ineligible: "unauthenticated",
  not_found: "not_found",
  state_conflict: "state_conflict",
  stale_authority: "stale_authority",
  command_conflict: "command_conflict",
  denied: "denied",
  duplicate: "state_conflict",
});
const runOutcomes: Readonly<Record<string, RunRefusal>> = Object.freeze({
  stopped: "stopped",
  entitlement: "entitlement",
  no_billing_period: "entitlement",
  wallet_not_found: "entitlement",
  insufficient_credits: "insufficient_credits",
  daily_cap: "daily_cap",
  unrecovered_cost_cap: "unrecovered_cost_cap",
  run_product_limit: "run_product_limit",
  catalogue_inactive: "selection_invalid",
  approvals_limit: "approvals_limit",
});
async function submit(
  tx: WorkTx,
  statement: "cmdRunAdmit" | "cmdRunsReconcile",
  values: (string | null)[],
): Promise<Record<string, unknown>> {
  tx.markSubmitted();
  const row = one(await tx.run(statement, values));
  if (!row || typeof row.outcome !== "string") throw new WorkContextUnavailable();
  if (row.outcome !== "applied") {
    tx.rollbackOnly();
    if (Object.hasOwn(runOutcomes, row.outcome)) throw new RunReject(runOutcomes[row.outcome]!);
    throw new WorkReject(workOutcomes[row.outcome] ?? "unavailable");
  }
  return decodeResult(row.result);
}
/** The kernel grants run admission needs on the store resource (spine §2 step 7). */
export async function admissionAllowed(
  a: WorkAuthority,
  store: StoreResource,
  fields: readonly string[],
) {
  const checks: readonly (readonly [CapabilityId, "view" | "execute" | "propose" | "delegate"])[] =
    [
      ["catalog.content.propose", "execute"],
      ["catalog.products.read", "view"],
      ["catalog.content.propose", "delegate"],
      ["catalog.products.read", "delegate"],
      ["catalog.content.publish", "propose"],
      ["catalog.content.publish", "delegate"],
    ];
  for (const [capabilityId, verb] of checks) {
    const decided = await decideOn(a, store, capabilityId, verb, fields);
    if (!decided.decision.allowed) return false;
  }
  return true;
}
const randomUuid = () => crypto.randomUUID();
// The admission's reply body, the same for a new run and a replay of its recorded result:
// ids, the selection and counts, numbers as numbers.
function admittedBody(result: Record<string, unknown>) {
  const count = (v: unknown) => {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
      throw new WorkContextUnavailable();
    return n;
  };
  const id = (v: unknown) => {
    if (typeof v !== "string") throw new WorkContextUnavailable();
    return v;
  };
  return {
    runId: id(result.runId),
    status: id(result.status),
    childTaskId: id(result.childTaskId),
    productCount: count(result.productCount),
    creditsReserved: count(result.creditsReserved),
    catalogueVersion: count(result.catalogueVersion),
    selection: { model: id(result.model), effort: id(result.effort) },
  };
}

async function admit(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedRunCommand,
  correlationId: string,
  environment: "development" | "staging" | "production",
): Promise<RunResult> {
  const body = prepared.parsed as AdmitBody;
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay)
    return {
      ...replay,
      body: { ...admittedBody(replay.body), replayed: true },
    };
  const taskId = g.params.taskId!;
  const O = a.actor.organizationId;
  const W = a.resource.workspaceId;
  // The parent task: the actor's own, open.
  const task = one(await tx.run("taskById", [taskId]));
  if (!task) throw new WorkReject("not_found");
  if (
    text(task, "initiator_principal_id") !== a.actor.principalId ||
    text(task, "initiator_membership_id") !== a.actor.membershipId ||
    !["draft", "ready"].includes(text(task, "status"))
  )
    throw new WorkReject("state_conflict");
  // The store's current association and its active Listings installation.
  const association = one(await tx.run("storeAssociation", [body.storeId]));
  if (!association || text(association, "store_id") !== body.storeId)
    throw new WorkReject("not_found");
  const store = storeResource(O, W, body.storeId, text(association, "connection_id"));
  const installation = one(await tx.run("listingsInstallation", [body.storeId]));
  if (
    !installation ||
    text(installation, "status") !== "active" ||
    text(installation, "connection_id") !== store.connectionId
  )
    throw new RunReject("installation_inactive");
  // The human kernel on the store resource.
  if (!(await admissionAllowed(a, store, body.fields))) throw new WorkReject("denied");
  // Entitlement, only through entitlementFor over M5's billing facts.
  const scope = { organizationId: O, workspaceId: W };
  const billing = await createBillingFactsReader((name, values) => tx.run(name, values)).read(
    scope,
  );
  const at = new Date(a.databaseNowMs).toISOString();
  const state = workspaceBillingState(
    parseWorkspaceBillingFacts(billing.facts, scope, environment),
    at,
    environment,
  );
  const request = {
    capabilityId: "catalog.content.propose" as CapabilityId,
    verb: "execute" as const,
    resource: store,
    accountId: null,
    fields: [...body.fields],
  };
  if (!entitlementFor(state, request, at) || billing.billingPeriod === null)
    throw new RunReject("entitlement");
  // The selection within the member's ceiling.
  const defaults = one(await tx.run("workspaceModelDefault", []));
  const version = activeCatalogueVersion();
  const fallbackCeiling = defaultMemberCreditCeiling();
  if (version === null || fallbackCeiling === null) throw new RunReject("selection_invalid");
  const stored = defaults
    ? { model: text(defaults, "model_key"), effort: text(defaults, "effort_key") }
    : null;
  const ceiling = defaults ? Number(text(defaults, "max_credits_per_product")) : fallbackCeiling;
  if (!Number.isSafeInteger(ceiling)) throw new WorkContextUnavailable();
  const holdsRevise = await reviseAllowed(a);
  const resolved = resolveSelection({
    selection: body.selection,
    workspaceDefault:
      stored && findCatalogueEntry(version, stored.model, stored.effort) ? stored : null,
    ceiling,
    holdsRevise,
  });
  if (!resolved.ok)
    throw new RunReject(
      resolved.code === "selection_above_ceiling" ? "selection_above_ceiling" : "selection_invalid",
    );
  const entry = resolved.entry;
  if (body.products.length > entry.runProductLimit) throw new RunReject("run_product_limit");
  // The code Coordinator's route.
  const runId = randomUuid();
  const childTaskId = randomUuid();
  const route = coordinatorRoute({
    organizationId: O,
    workspaceId: W,
    runId,
    taskId,
    childTaskId,
    installationId: text(installation, "id"),
    storeId: body.storeId,
    connectionId: store.connectionId,
    products: body.products,
    fields: body.fields,
  });
  const result = await submit(tx, "cmdRunAdmit", [
    g.commandId,
    prepared.digest,
    correlationId,
    taskId,
    body.storeId,
    runId,
    childTaskId,
    randomUuid(),
    randomUuid(),
    String(entry.catalogueVersion),
    entry.model,
    entry.effort,
    holdsRevise ? "true" : "false",
    JSON.stringify(body.products),
    JSON.stringify(body.fields),
    route.canonical,
    await sha256Hex(route.canonical),
    "agent_" + randomUuid(),
    randomUuid(),
    listingsWorkflowVersion,
  ]);
  return {
    status: 201,
    body: admittedBody(result),
    outcome: "applied",
  };
}

async function reconcile(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedRunCommand,
  correlationId: string,
): Promise<RunResult> {
  // Default deny: the reconcile is offered on the task screen, so the actor must view tasks;
  // cmd_runs_reconcile then closes only the actor's own stale runs.
  await taskView(await context(tx, g), "list");
  const replay = await begin(tx, g, prepared);
  if (replay) return replay;
  const result = await submit(tx, "cmdRunsReconcile", [
    g.commandId,
    prepared.digest,
    correlationId,
  ]);
  return { status: 200, body: result, outcome: "applied" };
}

export function runRunCommand(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedRunCommand,
  correlationId: string,
  environment: "development" | "staging" | "production",
): Promise<RunResult> {
  return prepared.type === "run.admit"
    ? admit(tx, g, prepared, correlationId, environment)
    : reconcile(tx, g, prepared, correlationId);
}

// ---------------------------------------------------------------------------
// Reads: ids, statuses, counts and credits. No content, provider id or cost of a call.
// Gated as every work read (P06.T01a §4.7): a run belongs to its task, whose read lists
// activeRunId, so view on task.read first (a single run the actor may not view is 404,
// identical to an absent one; a list is 403); then view on catalog.products.read on the
// run's own store resource with the run's fields, since a run names that store's products
// (a single run is 404; a list leaves the run out).
async function taskView(a: WorkAuthority, kind: "list" | "single"): Promise<void> {
  const rule = workPermissions["task.read"];
  const decision = await decideWork(a, rule.capabilityId, "view", rule.fields);
  if (decision.allowed) return;
  if (decision.reason === "field_denied") throw new WorkReject("field_denied");
  throw new WorkReject(kind === "list" ? "denied" : "not_found");
}
async function storeView(a: WorkAuthority, row: Record<string, unknown>): Promise<boolean> {
  let fields: unknown;
  try {
    fields = JSON.parse(text(row, "fields"));
  } catch {
    throw new WorkContextUnavailable();
  }
  if (!Array.isArray(fields) || !fields.every((f) => typeof f === "string"))
    throw new WorkContextUnavailable();
  const store = storeResource(
    a.actor.organizationId,
    a.resource.workspaceId,
    text(row, "store_id"),
    text(row, "connection_id"),
  );
  const decided = await decideOn(a, store, "catalog.products.read", "view", fields as string[]);
  return decided.decision.allowed;
}
const integer = (value: string | null) => {
  if (value === null) return null;
  const n = Number(value);
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(n))
    throw new WorkContextUnavailable();
  return n;
};
function runView(row: Record<string, unknown>) {
  let fields: unknown;
  try {
    fields = JSON.parse(text(row, "fields"));
  } catch {
    throw new WorkContextUnavailable();
  }
  return {
    runId: text(row, "id"),
    revision: integer(text(row, "revision")),
    taskId: text(row, "task_id"),
    childTaskId: text(row, "child_task_id"),
    storeId: text(row, "store_id"),
    status: text(row, "status"),
    endedReason: optional(row, "ended_reason"),
    selection: { model: text(row, "model_key"), effort: text(row, "effort_key") },
    catalogueVersion: integer(text(row, "catalogue_version")),
    creditsPerProduct: integer(text(row, "credits_per_product")),
    productCount: integer(text(row, "product_count")),
    fields,
    productsDrafted: integer(text(row, "products_drafted")),
    productsFailed: integer(text(row, "products_failed")),
    createdAt: text(row, "created_at"),
    startedAt: optional(row, "started_at"),
    endedAt: optional(row, "ended_at"),
    updatedAt: text(row, "updated_at"),
  };
}
async function runGet(tx: WorkTx, g: Guarded): Promise<RunResult> {
  const a = await context(tx, g);
  await taskView(a, "single");
  const runId = g.params.runId!;
  const row = one(await tx.run("runById", [runId]));
  if (!row || !(await storeView(a, row))) throw new WorkReject("not_found");
  const products = (await tx.run("runProductsOfRun", [runId])).map((p) => {
    let flags: unknown = null;
    const raw = optional(p, "flags");
    if (raw !== null)
      try {
        flags = JSON.parse(raw);
      } catch {
        throw new WorkContextUnavailable();
      }
    return {
      index: integer(text(p, "product_index")),
      productId: text(p, "product_id"),
      status: text(p, "status"),
      attempts: integer(text(p, "attempts")),
      failureCode: optional(p, "failure_code"),
      proposalId: optional(p, "proposal_id"),
      flags,
    };
  });
  const interrupted = one(await tx.run("runInterrupted", [runId]));
  return {
    status: 200,
    body: {
      run: runView(row),
      credits: {
        reserved: integer(optional(row, "credits_reserved")),
        settled: integer(optional(row, "credits_settled")),
        status: optional(row, "credit_status"),
      },
      usage: {
        attempts: integer(optional(row, "attempts")),
        inputTokens: integer(optional(row, "input_tokens")),
        outputTokens: integer(optional(row, "output_tokens")),
      },
      products,
      interrupted: interrupted ? optional(interrupted, "interrupted") === "true" : false,
    },
    outcome: "read",
  };
}
async function runsOfTask(tx: WorkTx, g: Guarded): Promise<RunResult> {
  const a = await context(tx, g);
  await taskView(a, "list");
  const rows = await tx.run("runsOfTask", [g.params.taskId!]);
  const visible: Record<string, unknown>[] = [];
  for (const row of rows) if (await storeView(a, row)) visible.push(row);
  return { status: 200, body: { runs: visible.map(runView) }, outcome: "read" };
}
export function runRunRead(tx: WorkTx, g: Guarded, read: RunRead): Promise<RunResult> {
  return read === "run.get" ? runGet(tx, g) : runsOfTask(tx, g);
}
