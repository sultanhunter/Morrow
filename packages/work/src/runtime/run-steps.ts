import type { FixedSqlQuery } from "../../../identity/src/fixed-sql-transaction.js";

// The run steps' SQL (M3 PR-2; migration listings-runs; mvp-architecture §2 steps 8, 9 and
// 15), sent inside one entered run lease (runLeaseStep): source-fixed statements, values only
// as bind parameters (an absent optional value is the empty string, which the statement turns
// into NULL), every selected column text. Each decoder accepts only its definer's closed
// shape; anything else is RUNTIME_RUN_HELD, so the step fails and the Workflow retries it.
// Content (the request text, a product as read, a draft's change set) passes through here in
// memory only; the Workflow's step results carry ids and codes.

export const runStepSql = Object.freeze({
  start:
    "SELECT outcome,run_id,task_id,child_task_id,envelope_id,installation_id,agent_principal_id,store_id,connection_id,product_count,fields,lease_expires_at_ms,status,catalogue_version,model_key,effort_key FROM morrow_work.run_start()",
  billingFacts: "SELECT morrow_work.run_billing_facts() AS facts",
  productBegin:
    "SELECT outcome,reason,product_id,attempts,snapshot_digest,fields,objective FROM morrow_work.run_product_begin($1)",
  snapshotPut: "SELECT outcome,digest FROM morrow_work.run_snapshot_put($1,$2)",
  productFinish:
    "SELECT outcome,stop::text AS stop,reason,draft_id FROM morrow_work.run_product_finish($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),NULLIF($6,''))",
  draftsPending:
    "SELECT draft_id,product_index,product_id,snapshot_digest,fields,set_canonical,flags FROM morrow_work.run_drafts_pending()",
  reviewContext:
    "SELECT policy_revision,policy_canonical,policy_digest,database_now FROM morrow_work.run_review_context()",
  submitProposal:
    "SELECT outcome,result FROM morrow_work.submit_agent_proposal($1,NULLIF($2,''),$3,$4,$5,$6,$7,$8,$9)",
  finish: "SELECT outcome,status,credits_settled FROM morrow_work.run_finish(NULLIF($1,''))",
} as const);

export type RunEndReason =
  | "breaker"
  | "unrecovered_cost_cap"
  | "spend_limit"
  | "provider_error"
  | "cost_overflow"
  | "reservation_exhausted"
  | "time_budget"
  | "delegation_denied"
  | "entitlement"
  | "broker_held"
  | "read_unavailable";
export const runEndReasons: readonly RunEndReason[] = Object.freeze([
  "breaker",
  "unrecovered_cost_cap",
  "spend_limit",
  "provider_error",
  "cost_overflow",
  "reservation_exhausted",
  "time_budget",
  "delegation_denied",
  "entitlement",
  "broker_held",
  "read_unavailable",
]);
export type ProductFailureCode =
  | "validation"
  | "product_mismatch"
  | "incomplete"
  | "refusal"
  | "invalid_output"
  | "uncertain"
  | "input_over_cap"
  | "read_failed"
  | "too_large"
  | "provider_error"
  | "spend_limit"
  | "reservation_exhausted";
export interface RunStart {
  readonly outcome: "started" | "running" | "ended";
  readonly runId: string;
  readonly taskId: string;
  readonly childTaskId: string;
  readonly envelopeId: string;
  readonly installationId: string;
  readonly agentPrincipalId: string;
  readonly storeId: string;
  readonly connectionId: string;
  readonly productCount: number;
  readonly fields: readonly string[];
  readonly leaseExpiresAtMs: number;
  readonly status: string;
  /** The run's catalogue version and selection keys (codes): the Workflow's budget sizing. */
  readonly catalogueVersion: number;
  readonly model: string;
  readonly effort: string;
}
export type ProductBegin =
  | {
      readonly outcome: "begun";
      readonly productId: string;
      readonly attempts: number;
      readonly snapshotDigest: string | null;
      readonly fields: readonly string[];
      /** The merchant's request text: in memory, within the step only. */
      readonly objective: string;
    }
  | { readonly outcome: "done"; readonly status: string }
  | { readonly outcome: "stop"; readonly reason: RunEndReason }
  | { readonly outcome: "denied" | "invalid" };
export interface DraftRow {
  readonly draftId: string;
  readonly productIndex: number;
  readonly productId: string;
  readonly snapshotDigest: string;
  readonly fields: readonly string[];
  readonly setCanonical: string;
}
export interface ReviewContextRow {
  readonly policy: {
    readonly revision: number;
    readonly canonical: string;
    readonly digest: string;
  } | null;
  readonly databaseNow: string;
}
export interface RunSteps {
  start(): Promise<RunStart | "denied">;
  /** The billing rows of the lease's workspace, keyed by the api's billing statement names. */
  billingFacts(): Promise<Readonly<Record<string, readonly Record<string, unknown>[]>>>;
  productBegin(index: number): Promise<ProductBegin>;
  snapshotPut(
    index: number,
    canonical: string,
  ): Promise<
    | { readonly outcome: "stored"; readonly digest: string }
    | { readonly outcome: "too_large" | "conflict" | "denied" | "invalid" }
  >;
  productFinish(
    index: number,
    result:
      | {
          readonly outcome: "drafted";
          readonly setCanonical: string;
          readonly fields: readonly string[];
          readonly flags: Readonly<{
            newUrls: number;
            newEmails: number;
            newPhones: number;
            tagsAdded: number;
            tagsRemoved: number;
          }>;
        }
      | { readonly outcome: "failed"; readonly code: ProductFailureCode },
  ): Promise<
    | {
        readonly outcome: "recorded" | "done";
        readonly stop: boolean;
        readonly reason: string | null;
      }
    | { readonly outcome: "denied" | "invalid" | "call_open" }
  >;
  draftsPending(): Promise<readonly DraftRow[]>;
  reviewContext(): Promise<ReviewContextRow>;
  submitProposal(p: {
    readonly approvalId: string;
    readonly policyCanonical: string | null;
    readonly policyDigest: string;
    readonly parametersCanonical: string;
    readonly parametersDigest: string;
    readonly proposalCanonical: string;
    readonly proposalDigest: string;
    readonly scopeCanonical: string;
    readonly draftIds: readonly string[];
  }): Promise<string>;
  finish(reason: RunEndReason | null): Promise<
    | { readonly outcome: "ended"; readonly status: string; readonly creditsSettled: string | null }
    | {
        readonly outcome:
          | "call_open"
          | "drafts_pending"
          | "products_pending"
          | "denied"
          | "invalid";
      }
  >;
}

const held = () => Error("RUNTIME_RUN_HELD");
const recordId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const selectionKey = /^[a-z][a-z0-9_]{0,39}$/;
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;
function one(rows: readonly Record<string, unknown>[], names: readonly string[]) {
  if (!Array.isArray(rows) || rows.length !== 1) throw held();
  const r = rows[0];
  if (
    !r ||
    typeof r !== "object" ||
    Object.keys(r).sort().join(",") !== [...names].sort().join(",")
  )
    throw held();
  return r;
}
const nullable = (value: unknown) =>
  value === null
    ? null
    : typeof value === "string"
      ? value
      : (() => {
          throw held();
        })();
const integer = (value: unknown, max: number) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value)) throw held();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > max) throw held();
  return n;
};
const jsonArray = (value: unknown): string[] => {
  if (typeof value !== "string") throw held();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw held();
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) throw held();
  return parsed as string[];
};
const reasons: readonly string[] = runEndReasons;
const productFailureCodes: readonly string[] = [
  "validation",
  "product_mismatch",
  "incomplete",
  "refusal",
  "invalid_output",
  "uncertain",
  "input_over_cap",
  "read_failed",
  "too_large",
  "provider_error",
  "spend_limit",
  "reservation_exhausted",
];
const billingKeys: Readonly<Record<string, string>> = Object.freeze({
  route: "workspaceBillingRoute",
  associations: "billingAssociations",
  account: "billingAccount",
  snapshot: "billingSnapshotLatest",
  wallet: "billingWallet",
  conflicts: "billingConflicts",
  intent: "billingIntentCurrent",
  period: "billingPeriodLatest",
  hold: "billingSetupHold",
});

/** The run steps over one entered lease's query (runLeaseStep passes its own). */
export function createRunSteps(query: FixedSqlQuery): RunSteps {
  const steps: RunSteps = {
    async start() {
      const r = one(await query(runStepSql.start), [
        "outcome",
        "run_id",
        "task_id",
        "child_task_id",
        "envelope_id",
        "installation_id",
        "agent_principal_id",
        "store_id",
        "connection_id",
        "product_count",
        "fields",
        "lease_expires_at_ms",
        "status",
        "catalogue_version",
        "model_key",
        "effort_key",
      ]);
      if (r.outcome === "denied") return "denied" as const;
      if (
        !["started", "running", "ended"].includes(r.outcome as string) ||
        !exact(uuid, r.run_id) ||
        ![
          r.task_id,
          r.child_task_id,
          r.envelope_id,
          r.installation_id,
          r.agent_principal_id,
          r.store_id,
          r.connection_id,
        ].every((v) => exact(recordId, v)) ||
        typeof r.status !== "string" ||
        !exact(selectionKey, r.model_key) ||
        !exact(selectionKey, r.effort_key)
      )
        throw held();
      return Object.freeze({
        outcome: r.outcome as RunStart["outcome"],
        runId: r.run_id,
        taskId: r.task_id as string,
        childTaskId: r.child_task_id as string,
        envelopeId: r.envelope_id as string,
        installationId: r.installation_id as string,
        agentPrincipalId: r.agent_principal_id as string,
        storeId: r.store_id as string,
        connectionId: r.connection_id as string,
        productCount: integer(r.product_count, 25),
        fields: Object.freeze(jsonArray(r.fields)),
        leaseExpiresAtMs: integer(r.lease_expires_at_ms, Number.MAX_SAFE_INTEGER),
        status: r.status,
        catalogueVersion: integer(r.catalogue_version, 999),
        model: r.model_key as string,
        effort: r.effort_key as string,
      });
    },
    async billingFacts() {
      const r = one(await query(runStepSql.billingFacts), ["facts"]);
      if (typeof r.facts !== "string") throw held();
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.facts);
      } catch {
        throw held();
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw held();
      const out: Record<string, readonly Record<string, unknown>[]> = {};
      for (const [key, name] of Object.entries(billingKeys)) {
        const rows = (parsed as Record<string, unknown>)[key];
        if (
          !Array.isArray(rows) ||
          rows.length > 101 ||
          !rows.every((x) => x && typeof x === "object" && !Array.isArray(x))
        )
          throw held();
        out[name] = Object.freeze(rows as Record<string, unknown>[]);
      }
      if (Object.keys(parsed as object).length !== Object.keys(billingKeys).length) throw held();
      return Object.freeze(out);
    },
    async productBegin(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index > 24) throw held();
      const r = one(await query(runStepSql.productBegin, [String(index)]), [
        "outcome",
        "reason",
        "product_id",
        "attempts",
        "snapshot_digest",
        "fields",
        "objective",
      ]);
      if (r.outcome === "begun") {
        if (
          !exact(/^product:[1-9][0-9]{0,19}$/, r.product_id) ||
          (r.snapshot_digest !== null && !exact(digest, r.snapshot_digest)) ||
          typeof r.objective !== "string" ||
          r.objective.length < 1 ||
          r.objective.length > 8192
        )
          throw held();
        return Object.freeze({
          outcome: "begun" as const,
          productId: r.product_id,
          attempts: integer(r.attempts, 2),
          snapshotDigest: r.snapshot_digest as string | null,
          fields: Object.freeze(jsonArray(r.fields)),
          objective: r.objective,
        });
      }
      if (r.outcome === "done") {
        if (!["drafted", "failed", "skipped"].includes(r.reason as string)) throw held();
        return Object.freeze({ outcome: "done" as const, status: r.reason as string });
      }
      if (r.outcome === "stop") {
        if (!reasons.includes(r.reason as string)) throw held();
        return Object.freeze({ outcome: "stop" as const, reason: r.reason as RunEndReason });
      }
      if (r.outcome === "denied" || r.outcome === "invalid")
        return Object.freeze({ outcome: r.outcome as "denied" | "invalid" });
      throw held();
    },
    async snapshotPut(index, canonical) {
      if (!Number.isSafeInteger(index) || index < 0 || index > 24 || typeof canonical !== "string")
        throw held();
      const r = one(await query(runStepSql.snapshotPut, [String(index), canonical]), [
        "outcome",
        "digest",
      ]);
      if (r.outcome === "stored") {
        if (!exact(digest, r.digest)) throw held();
        return Object.freeze({ outcome: "stored" as const, digest: r.digest });
      }
      if (
        ["too_large", "conflict", "denied", "invalid"].includes(r.outcome as string) &&
        r.digest === null
      )
        return Object.freeze({
          outcome: r.outcome as "too_large" | "conflict" | "denied" | "invalid",
        });
      throw held();
    },
    async productFinish(index, result) {
      if (!Number.isSafeInteger(index) || index < 0 || index > 24) throw held();
      const values =
        result.outcome === "drafted"
          ? [
              String(index),
              "drafted",
              "",
              result.setCanonical,
              JSON.stringify(result.fields),
              JSON.stringify(result.flags),
            ]
          : [String(index), "failed", result.code, "", "", ""];
      if (result.outcome === "failed" && !productFailureCodes.includes(result.code)) throw held();
      const r = one(await query(runStepSql.productFinish, values), [
        "outcome",
        "stop",
        "reason",
        "draft_id",
      ]);
      if (r.outcome === "recorded" || r.outcome === "done") {
        if ((r.stop !== "true" && r.stop !== "false") || nullable(r.reason) === undefined)
          throw held();
        return Object.freeze({
          outcome: r.outcome as "recorded" | "done",
          stop: r.stop === "true",
          reason: r.reason as string | null,
        });
      }
      if (["denied", "invalid", "call_open"].includes(r.outcome as string))
        return Object.freeze({ outcome: r.outcome as "denied" | "invalid" | "call_open" });
      throw held();
    },
    async draftsPending() {
      const rows = await query(runStepSql.draftsPending);
      if (!Array.isArray(rows) || rows.length > 25) throw held();
      return Object.freeze(
        rows.map((r) => {
          const row = one(
            [r],
            [
              "draft_id",
              "product_index",
              "product_id",
              "snapshot_digest",
              "fields",
              "set_canonical",
              "flags",
            ],
          );
          if (
            !exact(uuid, row.draft_id) ||
            !exact(/^product:[1-9][0-9]{0,19}$/, row.product_id) ||
            !exact(digest, row.snapshot_digest) ||
            typeof row.set_canonical !== "string"
          )
            throw held();
          return Object.freeze({
            draftId: row.draft_id,
            productIndex: integer(row.product_index, 24),
            productId: row.product_id,
            snapshotDigest: row.snapshot_digest,
            fields: Object.freeze(jsonArray(row.fields)),
            setCanonical: row.set_canonical,
          });
        }),
      );
    },
    async reviewContext() {
      const r = one(await query(runStepSql.reviewContext), [
        "policy_revision",
        "policy_canonical",
        "policy_digest",
        "database_now",
      ]);
      if (typeof r.database_now !== "string") throw held();
      if (r.policy_revision === null) {
        if (r.policy_canonical !== null || r.policy_digest !== null) throw held();
        return Object.freeze({ policy: null, databaseNow: r.database_now });
      }
      if (typeof r.policy_canonical !== "string" || !exact(digest, r.policy_digest)) throw held();
      return Object.freeze({
        policy: Object.freeze({
          revision: integer(r.policy_revision, Number.MAX_SAFE_INTEGER),
          canonical: r.policy_canonical,
          digest: r.policy_digest,
        }),
        databaseNow: r.database_now,
      });
    },
    async submitProposal(p) {
      const r = one(
        await query(runStepSql.submitProposal, [
          p.approvalId,
          p.policyCanonical ?? "",
          p.policyDigest,
          p.parametersCanonical,
          p.parametersDigest,
          p.proposalCanonical,
          p.proposalDigest,
          p.scopeCanonical,
          JSON.stringify(p.draftIds),
        ]),
        ["outcome", "result"],
      );
      if (typeof r.outcome !== "string") throw held();
      return r.outcome;
    },
    async finish(reason) {
      if (reason !== null && !reasons.includes(reason)) throw held();
      const r = one(await query(runStepSql.finish, [reason ?? ""]), [
        "outcome",
        "status",
        "credits_settled",
      ]);
      if (r.outcome === "ended") {
        if (typeof r.status !== "string" || nullable(r.credits_settled) === undefined) throw held();
        return Object.freeze({
          outcome: "ended" as const,
          status: r.status,
          creditsSettled: r.credits_settled as string | null,
        });
      }
      if (
        ["call_open", "drafts_pending", "products_pending", "denied", "invalid"].includes(
          r.outcome as string,
        )
      )
        return Object.freeze({
          outcome: r.outcome as
            | "call_open"
            | "drafts_pending"
            | "products_pending"
            | "denied"
            | "invalid",
        });
      throw held();
    },
  };
  return Object.freeze(steps);
}
