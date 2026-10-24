import { executorRoleMemberSql } from "../../../identity/src/executor-role-preflight.js";
import {
  runFixedSqlTransaction,
  type FixedSqlAttempt,
  type FixedSqlControl,
  type FixedSqlOutcome,
  type FixedSqlPool,
  type FixedSqlTransactionProfile,
} from "../../../identity/src/fixed-sql-transaction.js";
import { createRunSteps, type RunSteps } from "./run-steps.js";
import { createAgentRunSteps, type AgentRunSteps } from "../loop/steps.js";

// The orchestrator's lease steps (mvp-architecture §5; ADR-0022 item 9; migration 0020).
// One connection per transaction, logged in as morrow_runtime_executor with the password
// RuntimeBroker.neonLease returns: BEGIN, the ADR-0020 D5 role preflight (an executor
// login that is a member of anything, or not exactly this login, is refused before any
// definer), the timeouts, then the step. Every step's first statement is enter_lease; a
// Workflow's first step also marks its lease started and its last step releases it. A
// lease selects the tenant and fences its generation; it grants nothing, so every step
// still reruns its policy checks. Statements are source-fixed, values travel only as
// bind parameters, and every selected column is text. The cron lists pending starts
// (ids only) in a transaction of its own.

export const runtimeExecutorLogin = "morrow_runtime_executor";
export const runtimeExecutorSql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
  role: `SELECT current_user AS role,session_user AS login,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,${executorRoleMemberSql} FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  statementTimeout: "SET LOCAL statement_timeout='2s'",
  lockTimeout: "SET LOCAL lock_timeout='1s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout='5s'",
  transactionTimeout: "SET LOCAL transaction_timeout='5s'",
  enterLease:
    "SELECT outcome,organization_id,workspace_id,kind,subject_id,store_id,connection_id,installation_id,initiator_principal_id,initiator_membership_id,expires_at_ms FROM morrow_work.enter_lease($1,$2)",
  pendingStarts: "SELECT kind,subject_id,lease_id,generation FROM morrow_work.pending_starts()",
  markStarted: "SELECT morrow_work.lease_mark_started() AS outcome",
  release: "SELECT morrow_work.lease_release() AS outcome",
  // M3 PR-1: the agent kernel's facts for one step under the entered run lease.
  delegationFacts:
    "SELECT lease,envelope,hops,installations,actors,store_current FROM morrow_work.delegation_facts($1,$2,$3)",
  commit: "COMMIT",
  rollback: "ROLLBACK",
});
// Lease terms, as the 0020 work_leases_term CHECK fixes them.
export const leaseTermsMs = Object.freeze({ read: 60_000, run: 1_800_000, operation: 900_000 });
export type LeaseKind = keyof typeof leaseTermsMs;
export type LeaseRefusal =
  | "denied"
  | "not_found"
  | "ended"
  | "expired"
  | "member_inactive"
  | "stopped";
export interface LeaseRef {
  readonly leaseId: string;
  readonly generation: number;
}
export interface EnteredLease extends LeaseRef {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly kind: LeaseKind;
  /** The read's request id, the run id or the claim id. */
  readonly subjectId: string;
  readonly storeId: string;
  readonly connectionId: string;
  /** Null only for a read lease. */
  readonly installationId: string | null;
  readonly initiatorPrincipalId: string;
  readonly initiatorMembershipId: string;
  readonly expiresAtMs: number;
}
/** One delegation_facts row (M3 PR-1): JSON texts the agent fact reader decodes. */
export interface DelegationFactsRow {
  readonly lease: string;
  readonly envelope: string;
  readonly hops: string;
  readonly installations: string;
  readonly actors: string;
  readonly storeCurrent: boolean;
}
export interface LeaseStep {
  readonly lease: EnteredLease;
  /** The Workflow's first step: sets started_at once. */
  markStarted(): Promise<"started" | "already_started">;
  /** The Workflow's last step: the context resolves nothing afterwards. */
  release(): Promise<"released">;
  /**
   * The agent kernel's facts under this run lease (M3 PR-1; createLeaseDelegationReader):
   * null when the lease is not a run lease of exactly this installation or the envelope is
   * not the lease's tenant's.
   */
  delegationFacts(
    envelopeId: string,
    installationId: string,
    capabilityId: string,
  ): Promise<DelegationFactsRow | null>;
  /** M3 PR-2: the run's own definers under this run lease (run-steps.ts). */
  readonly run: RunSteps;
  /** Build order PR 11: an agent run's definers under its run lease (loop/steps.ts). */
  readonly loop: AgentRunSteps;
}
export type LeaseStepResult<T> =
  | { readonly entered: true; readonly lease: EnteredLease; readonly value: T }
  | { readonly entered: false; readonly refusal: LeaseRefusal };
export interface PendingStart extends LeaseRef {
  readonly kind: "run" | "operation";
  readonly subjectId: string;
}

const held = () => Error("RUNTIME_LEASE_HELD");
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const recordId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;
const generationText = (value: unknown): value is string =>
  exact(/^[1-9][0-9]{0,15}$/, value) && Number.isSafeInteger(Number(value));
const refusals: readonly string[] = [
  "denied",
  "not_found",
  "ended",
  "expired",
  "member_inactive",
  "stopped",
];

function row(rows: readonly Record<string, unknown>[], names: readonly string[]) {
  if (!Array.isArray(rows) || rows.length !== 1) throw held();
  const r = rows[0];
  if (!r || typeof r !== "object" || Array.isArray(r)) throw held();
  if (Object.keys(r).sort().join(",") !== [...names].sort().join(",")) throw held();
  return r;
}
const roleNames = [
  "role",
  "login",
  "rolsuper",
  "rolbypassrls",
  "rolcreatedb",
  "rolcreaterole",
  "rolreplication",
  "rolinherit",
  "role_member",
] as const;
export const runtimeExecutorProfile: Readonly<FixedSqlTransactionProfile> = Object.freeze({
  begin: runtimeExecutorSql.begin,
  role: runtimeExecutorSql.role,
  settings: Object.freeze([
    runtimeExecutorSql.statementTimeout,
    runtimeExecutorSql.lockTimeout,
    runtimeExecutorSql.idleTimeout,
    runtimeExecutorSql.transactionTimeout,
  ]),
  commit: runtimeExecutorSql.commit,
  rollback: runtimeExecutorSql.rollback,
  requireRole(rows: readonly Record<string, unknown>[]) {
    const r = row(rows, roleNames);
    if (
      r.role !== runtimeExecutorLogin ||
      r.login !== runtimeExecutorLogin ||
      roleNames.slice(2).some((name) => r[name] !== false)
    )
      throw held();
  },
});

const enterNames = [
  "outcome",
  "organization_id",
  "workspace_id",
  "kind",
  "subject_id",
  "store_id",
  "connection_id",
  "installation_id",
  "initiator_principal_id",
  "initiator_membership_id",
  "expires_at_ms",
] as const;
/** Decodes one enter_lease row: a refusal carries nothing, an entry every id. */
export function decodeEnteredLease(
  rows: readonly Record<string, unknown>[],
  ref: LeaseRef,
): EnteredLease | LeaseRefusal {
  const r = row(rows, enterNames);
  if (r.outcome !== "entered") {
    if (
      typeof r.outcome !== "string" ||
      !refusals.includes(r.outcome) ||
      enterNames.slice(1).some((name) => r[name] !== null)
    )
      throw held();
    return r.outcome as LeaseRefusal;
  }
  const kind = r.kind;
  if (
    (kind !== "read" && kind !== "run" && kind !== "operation") ||
    ![
      r.organization_id,
      r.workspace_id,
      r.subject_id,
      r.store_id,
      r.connection_id,
      r.initiator_principal_id,
      r.initiator_membership_id,
    ].every((value) => exact(recordId, value)) ||
    (kind === "read" ? r.installation_id !== null : !exact(recordId, r.installation_id)) ||
    !exact(/^[1-9][0-9]{0,15}$/, r.expires_at_ms) ||
    !Number.isSafeInteger(Number(r.expires_at_ms))
  )
    throw held();
  return Object.freeze({
    leaseId: ref.leaseId,
    generation: ref.generation,
    organizationId: r.organization_id as string,
    workspaceId: r.workspace_id as string,
    kind,
    subjectId: r.subject_id as string,
    storeId: r.store_id as string,
    connectionId: r.connection_id as string,
    installationId: kind === "read" ? null : (r.installation_id as string),
    initiatorPrincipalId: r.initiator_principal_id as string,
    initiatorMembershipId: r.initiator_membership_id as string,
    expiresAtMs: Number(r.expires_at_ms),
  });
}

/** A lease reference as a Workflow carries it: a lowercase UUID and a positive generation. */
export function parseLeaseRef(value: unknown): LeaseRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "generation,leaseId") return null;
  if (
    !exact(uuid, v.leaseId) ||
    typeof v.generation !== "number" ||
    !Number.isSafeInteger(v.generation) ||
    v.generation < 1
  )
    return null;
  return Object.freeze({ leaseId: v.leaseId, generation: v.generation });
}

/**
 * One Workflow step under a lease. A refused lease (`entered: false`) runs no body and
 * writes nothing; `{ok: false}` means the transaction failed and its effect, if the body
 * sent a write, is unknown to the caller, which reconciles by its own ids.
 */
export async function runLeaseStep<T>(
  pool: FixedSqlPool,
  attempt: FixedSqlAttempt,
  ref: unknown,
  body: (step: LeaseStep) => Promise<T>,
): Promise<FixedSqlOutcome<LeaseStepResult<T>>> {
  const lease = parseLeaseRef(ref);
  if (!lease) {
    const refused: LeaseStepResult<T> = Object.freeze({ entered: false, refusal: "denied" });
    return Object.freeze({ ok: true, value: refused });
  }
  return runFixedSqlTransaction(pool, attempt, runtimeExecutorProfile, async (query) => {
    const entered = decodeEnteredLease(
      await query(runtimeExecutorSql.enterLease, [lease.leaseId, String(lease.generation)]),
      lease,
    );
    if (typeof entered === "string")
      return Object.freeze({ entered: false, refusal: entered }) as LeaseStepResult<T>;
    const outcome = async (text: string, allowed: readonly string[]) => {
      const r = row(await query(text), ["outcome"]);
      if (typeof r.outcome !== "string" || !allowed.includes(r.outcome)) throw held();
      return r.outcome;
    };
    const step: LeaseStep = Object.freeze({
      lease: entered,
      run: createRunSteps(query),
      loop: createAgentRunSteps(query),
      markStarted: async () =>
        (await outcome(runtimeExecutorSql.markStarted, ["started", "already_started"])) as
          | "started"
          | "already_started",
      release: async () => (await outcome(runtimeExecutorSql.release, ["released"])) as "released",
      delegationFacts: async (envelopeId: string, installationId: string, capabilityId: string) => {
        if (
          !exact(recordId, envelopeId) ||
          !exact(recordId, installationId) ||
          !exact(/^[a-z]+(\.[a-z_]+)+$/, capabilityId)
        )
          throw held();
        const rows = await query(runtimeExecutorSql.delegationFacts, [
          envelopeId,
          installationId,
          capabilityId,
        ]);
        if (!Array.isArray(rows) || rows.length > 1) throw held();
        if (rows.length === 0) return null;
        const r = row(rows, [
          "lease",
          "envelope",
          "hops",
          "installations",
          "actors",
          "store_current",
        ]);
        if (
          !["lease", "envelope", "hops", "installations", "actors"].every(
            (name) => typeof r[name] === "string",
          ) ||
          (r.store_current !== "true" && r.store_current !== "false")
        )
          throw held();
        return Object.freeze({
          lease: r.lease as string,
          envelope: r.envelope as string,
          hops: r.hops as string,
          installations: r.installations as string,
          actors: r.actors as string,
          storeCurrent: r.store_current === "true",
        });
      },
    });
    const value = await body(step);
    return Object.freeze({ entered: true, lease: entered, value }) as LeaseStepResult<T>;
  });
}

const pendingNames = ["kind", "subject_id", "lease_id", "generation"] as const;
/**
 * The cron's one cross-tenant read: the ids of at most 100 committed, unexpired run and
 * operation leases whose Workflow has not started, oldest first. Ids only.
 */
export async function listPendingStarts(
  pool: FixedSqlPool,
  attempt: FixedSqlAttempt,
): Promise<FixedSqlOutcome<readonly PendingStart[]>> {
  return runFixedSqlTransaction(pool, attempt, runtimeExecutorProfile, async (query) => {
    const rows = await query(runtimeExecutorSql.pendingStarts);
    if (!Array.isArray(rows) || rows.length > 100) throw held();
    const seen = new Set<string>();
    return Object.freeze(
      rows.map((r) => {
        if (
          !r ||
          typeof r !== "object" ||
          Object.keys(r).sort().join(",") !== [...pendingNames].sort().join(",") ||
          (r.kind !== "run" && r.kind !== "operation") ||
          !exact(recordId, r.subject_id) ||
          !exact(uuid, r.lease_id) ||
          !generationText(r.generation) ||
          seen.has(r.lease_id)
        )
          throw held();
        seen.add(r.lease_id);
        return Object.freeze({
          kind: r.kind,
          subjectId: r.subject_id,
          leaseId: r.lease_id,
          generation: Number(r.generation),
        }) as PendingStart;
      }),
    );
  });
}

/**
 * The request-owned attempt of one runtime transaction: one deadline and one abort
 * signal. `check` throws once the deadline passes or the signal aborts; `wait` races a
 * pending statement against both.
 */
export function createRuntimeAttempt(
  budgetMs: number,
  signal: AbortSignal,
  now: () => number = Date.now,
): FixedSqlAttempt & { end(): void } {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 30_000) throw held();
  const deadlineMs = now() + budgetMs;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(cancel, budgetMs);
  const control: Readonly<FixedSqlControl> = Object.freeze({ deadlineMs, signal: abort.signal });
  const check = () => {
    const at = now();
    if (abort.signal.aborted || at >= deadlineMs) {
      cancel();
      throw held();
    }
    return at;
  };
  return Object.freeze({
    control,
    check,
    async wait<V>(pending: Promise<V>): Promise<V> {
      void pending.catch(() => {});
      check();
      let stop: (() => void) | undefined;
      const interrupted = new Promise<never>((_, reject) => {
        stop = () => reject(held());
        abort.signal.addEventListener("abort", stop, { once: true });
      });
      try {
        const value = await Promise.race([pending, interrupted]);
        check();
        return value;
      } finally {
        if (stop) abort.signal.removeEventListener("abort", stop);
      }
    },
    end() {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      cancel();
    },
  });
}
