import type { BrokerVault } from "./capabilities.js";
import type {
  RuntimeBegin,
  RuntimeBeginRefusal,
  RuntimeLedger,
  RuntimeOpenOperation,
  RuntimeTokenRead,
  RuntimeUnknownReason,
} from "./runtime-gateway.js";
import { sandboxRefPattern } from "./runtime-provider.js";
import {
  openVaultRecord,
  sealVaultRecord,
  vaultBytesHex,
  vaultHexBytes,
  vaultLimits,
  vaultStatements,
  type VaultQuery,
  type VaultRecordRef,
} from "./vault.js";

// The runtime operation ledger on the vault login (build order PR 7; migration 0043). Each
// method is one transaction of its own through the vault transport, so begin's send mark is
// committed before the gateway lets any create leave the broker. Rows are checked column by
// column: anything unexpected is a refusal (begin) or false (the writes), never a guess.
// Build order PR 8 (migration 0047): the sandbox's envd token as a sealed vault record
// (tokenPut seals it with the vault's keyring and stores it once while the operation is
// `created`; tokenGet opens it for one call, or answers `stopped` once a stop covers the run;
// any settlement destroys it in SQL), and the sweep's `stopped` column.

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
const one = (
  rows: readonly Record<string, unknown>[],
  names: string,
): Record<string, unknown> | null =>
  Array.isArray(rows) &&
  rows.length === 1 &&
  rows[0] &&
  Object.keys(rows[0]).sort().join(",") === names
    ? rows[0]
    : null;
const ledgerBudgetMs = 10_000;
const tokenRef = (operationId: string): VaultRecordRef =>
  Object.freeze({ kind: "e2b_envd_token", operationId, provider: "e2b", version: 1 });
const tokenPattern = /^[\x21-\x7e]{16,1024}$/;

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
  const write = (
    text: (typeof vaultStatements)[keyof typeof vaultStatements],
    values: readonly string[],
    accepted: readonly string[],
  ) =>
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
        return {
          outcome: "begun",
          operationId: r.operation_id,
          deadlineAtMs: Date.parse(r.deadline_at),
        };
      }
      if (r.outcome === "replay") {
        if (typeof r.operation_id !== "string" || !uuid.test(r.operation_id))
          return { outcome: "lease_refused" };
        return { outcome: "replay", operationId: r.operation_id };
      }
      if ((refusals as readonly string[]).includes(r.outcome))
        return { outcome: "refused", code: r.outcome as RuntimeBeginRefusal };
      return { outcome: "lease_refused" };
    },
    created(operationId, sandboxRef) {
      if (!uuid.test(operationId) || !sandboxRefPattern.test(sandboxRef))
        return Promise.resolve(false);
      return write(
        vaultStatements.runtimeOperationCreated,
        [operationId, sandboxRef],
        ["recorded"],
      );
    },
    settle(operationId, status) {
      if (!uuid.test(operationId)) return Promise.resolve(false);
      return write(vaultStatements.runtimeOperationSettle, [operationId, status, ""], ["settled"]);
    },
    unknown(operationId, reason: RuntimeUnknownReason) {
      if (!uuid.test(operationId)) return Promise.resolve(false);
      return write(
        vaultStatements.runtimeOperationSettle,
        [operationId, "unknown_effect", reason],
        ["settled", "already_unknown"],
      );
    },
    async open(limit) {
      return run(
        async (query) => {
          const rows = await query(vaultStatements.runtimeOperationsSweep, [String(limit)]);
          const names =
            "deadline_at,operation_id,past_grace,provider,sandbox_ref,stale,status,stopped";
          const open: RuntimeOpenOperation[] = [];
          for (const row of Array.isArray(rows) ? rows : []) {
            const r = one([row], names);
            if (
              r === null ||
              typeof r.operation_id !== "string" ||
              !uuid.test(r.operation_id) ||
              typeof r.provider !== "string" ||
              !/^[a-z][a-z0-9_]{1,31}$/.test(r.provider) ||
              !(
                r.sandbox_ref === null ||
                (typeof r.sandbox_ref === "string" && sandboxRefPattern.test(r.sandbox_ref))
              ) ||
              !(
                r.status === "sending" ||
                r.status === "created" ||
                r.status === "unknown_effect"
              ) ||
              typeof r.deadline_at !== "string" ||
              !instant.test(r.deadline_at) ||
              !(r.stale === "true" || r.stale === "false") ||
              !(r.past_grace === "true" || r.past_grace === "false") ||
              !(r.stopped === "true" || r.stopped === "false")
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
                stopped: r.stopped === "true",
              }),
            );
          }
          return Object.freeze(open);
        },
        Object.freeze([]) as readonly RuntimeOpenOperation[],
      );
    },
    async tokenPut(operationId, token) {
      if (!uuid.test(operationId) || typeof token !== "string" || !tokenPattern.test(token))
        return false;
      let wrapped: string;
      let sealed: string;
      let kek: number;
      try {
        const envelope = await sealVaultRecord(
          vault.keyring,
          tokenRef(operationId),
          new TextEncoder().encode(token),
        );
        kek = envelope.kekVersion;
        wrapped = vaultBytesHex(envelope.wrappedKey);
        sealed = vaultBytesHex(envelope.sealedValue);
      } catch {
        return false;
      }
      return run(async (query) => {
        const r = one(
          await query(vaultStatements.runtimeTokenPut, [operationId, String(kek), wrapped, sealed]),
          "outcome",
        );
        return r !== null && r.outcome === "stored";
      }, false);
    },
    async tokenGet(operationId): Promise<RuntimeTokenRead> {
      const unavailable: RuntimeTokenRead = Object.freeze({ outcome: "unavailable" });
      if (!uuid.test(operationId)) return unavailable;
      const envelope = await run(async (query) => {
        const r = one(
          await query(vaultStatements.runtimeTokenGet, [operationId]),
          "kek_version,outcome,sealed_value,wrapped_key",
        );
        if (
          r !== null &&
          r.outcome === "stopped" &&
          r.kek_version === null &&
          r.wrapped_key === null &&
          r.sealed_value === null
        )
          return "stopped" as const;
        if (r === null || r.outcome !== "active") return null;
        if (typeof r.kek_version !== "string" || !/^[1-9][0-9]{0,2}$/.test(r.kek_version))
          return null;
        return {
          kekVersion: Number(r.kek_version),
          wrappedKey: vaultHexBytes(
            r.wrapped_key,
            vaultLimits.wrappedKeyBytes,
            vaultLimits.wrappedKeyBytes,
          ),
          sealedValue: vaultHexBytes(
            r.sealed_value,
            vaultLimits.sealedMinBytes,
            vaultLimits.sealedMaxBytes,
          ),
        };
      }, null);
      if (envelope === "stopped") return Object.freeze({ outcome: "stopped" });
      if (envelope === null) return unavailable;
      let plaintext: Uint8Array | null = null;
      try {
        plaintext = await openVaultRecord(vault.keyring, tokenRef(operationId), envelope);
        const token = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext);
        return tokenPattern.test(token)
          ? Object.freeze({ outcome: "active", token })
          : unavailable;
      } catch {
        return unavailable;
      } finally {
        plaintext?.fill(0);
      }
    },
  };
  return Object.freeze(ledger);
}
