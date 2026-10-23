import type { BrokerVault } from "./capabilities.js";
import type {
  RuntimeBegin,
  RuntimeBeginRefusal,
  RuntimeLedger,
  RuntimeOpenOperation,
  RuntimeUnknownReason,
} from "./runtime-gateway.js";
import { sandboxRefPattern } from "./runtime-provider.js";
import { vaultStatements, type VaultQuery } from "./vault.js";

// The runtime operation ledger on the vault login (build order PR 7; migration 0039). Each
// method is one transaction of its own through the vault transport, so begin's send mark is
// committed before the gateway lets any create leave the broker. Rows are checked column by
// column: anything unexpected is a refusal (begin) or false (the writes), never a guess.

export type VaultTransaction = <T>(
  vault: Readonly<BrokerVault>,
  budgetMs: number,
  body: (query: VaultQuery) => Promise<T>,
) => Promise<T>;

const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const instant = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const refusals: readonly RuntimeBeginRefusal[] = [
  "runtime_held",
  "monthly_budget",
  "concurrency_limit",
  "workspace_limit",
  "reservation_exhausted",
  "capability_missing",
];
const one = (rows: readonly Record<string, unknown>[], names: string): Record<string, unknown> | null =>
  Array.isArray(rows) && rows.length === 1 && rows[0] && Object.keys(rows[0]).sort().join(",") === names
    ? rows[0]
    : null;
const ledgerBudgetMs = 10_000;

export function createVaultRuntimeLedger(
  vault: Readonly<BrokerVault>,
  transaction: VaultTransaction,
): RuntimeLedger {
  const run = async <T>(body: (query: VaultQuery) => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await transaction(vault, ledgerBudgetMs, body);
    } catch {
      return fallback;
    }
  };
  const write = (text: (typeof vaultStatements)[keyof typeof vaultStatements], values: readonly string[], accepted: readonly string[]) =>
    run(async (query) => {
      const r = one(await query(text, values), "outcome,status");
      return r !== null && typeof r.outcome === "string" && accepted.includes(r.outcome);
    }, false);
  const ledger: RuntimeLedger = {
    async begin(request): Promise<RuntimeBegin> {
      // A begin that cannot commit (or whose commit is unknown) is never a send mark: the
      // gateway holds, and a row it may have left is stale for the sweep to reconcile.
      const rows = await transaction(vault, ledgerBudgetMs, (query) =>
        query(vaultStatements.runtimeOperationBegin, [
          request.leaseId,
          String(request.generation),
          request.callKey,
          request.jobDigest,
          request.provider,
        ]),
      );
      const r = one(rows, "deadline_at,operation_id,outcome");
      if (r === null || typeof r.outcome !== "string") return { outcome: "lease_refused" };
      if (r.outcome === "begun") {
        if (
          typeof r.operation_id !== "string" ||
          !uuid.test(r.operation_id) ||
          typeof r.deadline_at !== "string" ||
          !instant.test(r.deadline_at)
        )
          return { outcome: "lease_refused" };
        return { outcome: "begun", operationId: r.operation_id, deadlineAtMs: Date.parse(r.deadline_at) };
      }
      if (r.outcome === "replay") {
        if (typeof r.operation_id !== "string" || !uuid.test(r.operation_id)) return { outcome: "lease_refused" };
        return { outcome: "replay", operationId: r.operation_id };
      }
      if ((refusals as readonly string[]).includes(r.outcome))
        return { outcome: "refused", code: r.outcome as RuntimeBeginRefusal };
      return { outcome: "lease_refused" };
    },
    created(operationId, sandboxRef) {
      if (!uuid.test(operationId) || !sandboxRefPattern.test(sandboxRef)) return Promise.resolve(false);
      return write(vaultStatements.runtimeOperationCreated, [operationId, sandboxRef], ["recorded"]);
    },
    settle(operationId, status) {
      if (!uuid.test(operationId)) return Promise.resolve(false);
      return write(vaultStatements.runtimeOperationSettle, [operationId, status, ""], ["settled"]);
    },
    unknown(operationId, reason: RuntimeUnknownReason) {
      if (!uuid.test(operationId)) return Promise.resolve(false);
      return write(vaultStatements.runtimeOperationSettle, [operationId, "unknown_effect", reason], [
        "settled",
        "already_unknown",
      ]);
    },
    async open(limit) {
      return run(async (query) => {
        const rows = await query(vaultStatements.runtimeOperationsOpen, [String(limit)]);
        const names = "deadline_at,operation_id,past_grace,provider,sandbox_ref,stale,status";
        const open: RuntimeOpenOperation[] = [];
        for (const row of Array.isArray(rows) ? rows : []) {
          const r = one([row], names);
          if (
            r === null ||
            typeof r.operation_id !== "string" ||
            !uuid.test(r.operation_id) ||
            typeof r.provider !== "string" ||
            !/^[a-z][a-z0-9_]{1,31}$/.test(r.provider) ||
            !(r.sandbox_ref === null || (typeof r.sandbox_ref === "string" && sandboxRefPattern.test(r.sandbox_ref))) ||
            !(r.status === "sending" || r.status === "created" || r.status === "unknown_effect") ||
            typeof r.deadline_at !== "string" ||
            !instant.test(r.deadline_at) ||
            !(r.stale === "true" || r.stale === "false") ||
            !(r.past_grace === "true" || r.past_grace === "false")
          )
            continue;
          open.push(
            Object.freeze({
              operationId: r.operation_id,
              provider: r.provider,
              sandboxRef: r.sandbox_ref as string | null,
              status: r.status,
              deadlineAtMs: Date.parse(r.deadline_at),
              stale: r.stale === "true",
              pastGrace: r.past_grace === "true",
            }),
          );
        }
        return Object.freeze(open);
      }, Object.freeze([]) as readonly RuntimeOpenOperation[]);
    },
  };
  return Object.freeze(ledger);
}
