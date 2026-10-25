// The vault login's database transport (M2 PR-2; the "Broker vault-login transport"
// interface of integration.json; ADR-0022 items 7-8). The broker's own login,
// morrow_vault_broker, is never leased: its password lives only in broker secrets
// (BrokerVault), and this module is the one place it is used.
//
// runVaultTransaction opens exactly one @neondatabase/serverless Client per call, as
// morrow_vault_broker, to the host and database of MORROW_DATABASE_BINDING_JSON over the
// one pinned WebSocket endpoint of that binding. It runs, in order: BEGIN ISOLATION LEVEL
// READ COMMITTED READ WRITE; the ADR-0020 D5 role preflight (the session and current user
// are exactly the vault login, every attribute is off and it is a member of nothing,
// executorRoleMemberSql); SET LOCAL statement, lock and idle timeouts; the caller's body,
// which may send only statements of the frozen vaultStatements registry with text values;
// COMMIT. Every failure is one fixed VaultError code. A COMMIT that was sent but whose
// acknowledgement was lost is VAULT_OUTCOME_UNKNOWN: never retried, the caller reconciles
// by its own ids. Nothing is logged; the password never appears in an error.
// fix-shopify-install-live: an optional observer receives, once and after the close, where
// the transaction ended (its phase, a closed cause, the statements acknowledged and two
// durations). It carries no text, value or identifier, its throw is swallowed, and it never
// changes the order, the deadline or the outcome.
import { Client } from "@neondatabase/serverless";
import { executorRoleMemberSql } from "../../../packages/identity/src/executor-role-preflight.js";
import { brokerVaultRole } from "../../../packages/identity/src/broker-protocol.js";
import type { BrokerVault } from "./capabilities.js";
import { VaultError, vaultStatements, type VaultQuery } from "./vault.js";

export const vaultTransactionSql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
  role: `SELECT current_user AS role,session_user AS login,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,${executorRoleMemberSql} FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  statementTimeout: "SET LOCAL statement_timeout='3s'",
  lockTimeout: "SET LOCAL lock_timeout='2s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout='10s'",
  commit: "COMMIT",
  rollback: "ROLLBACK",
});
export const vaultTransactionLimits = Object.freeze({ budgetMinMs: 1, budgetMaxMs: 10000 });
// Where a transaction ended: the step in progress, or "done" once COMMIT was acknowledged.
export const vaultTransactionPhases = Object.freeze([
  "connect",
  "begin",
  "role",
  "settings",
  "body",
  "commit",
  "done",
] as const);
export type VaultTransactionPhase = (typeof vaultTransactionPhases)[number];
// Why it ended early: the budget ran out (before a send, or while one waited), the driver
// failed or closed, the role preflight refused the session, a reply had no rows array, or
// the body threw something that is not a VaultError. A VaultError the body throws itself
// (a registry refusal, a record shape) has no cause: its code says it.
export const vaultTransactionCauses = Object.freeze([
  "deadline",
  "driver",
  "role_check",
  "rows_shape",
  "body",
] as const);
export type VaultTransactionCause = (typeof vaultTransactionCauses)[number];
export interface VaultTransactionObservation {
  readonly phase: VaultTransactionPhase;
  readonly cause: VaultTransactionCause | null;
  /** Statements acknowledged by the database, BEGIN and COMMIT included. */
  readonly statements: number;
  /** From the start until the connection was open; null when it never opened. */
  readonly connectMs: number | null;
  /** From the start until the outcome was fixed (before the close). */
  readonly txMs: number;
}
export type VaultTransactionObserver = (observation: Readonly<VaultTransactionObservation>) => void;

type SocketConstructor = new (url: string) => unknown;
/** The driver seam: the Neon Client in Workers, a fake or a pg-wire bridge in tests. */
export interface VaultDriverClient {
  connect(): Promise<unknown>;
  query(text: string, values?: readonly string[]): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "error", listener: () => void): unknown;
}
export interface VaultDriverConfig {
  readonly hostname: string;
  readonly database: string;
  readonly user: typeof brokerVaultRole;
  readonly password: string;
  readonly applicationName: string;
  readonly connectTimeoutMs: number;
  readonly socket: SocketConstructor;
}
export type VaultDriverFactory = (config: VaultDriverConfig) => VaultDriverClient;

const fail = (code: ConstructorParameters<typeof VaultError>[0]) => new VaultError(code);
const registered: ReadonlySet<string> = new Set(Object.values(vaultStatements));
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

const neonDriver: VaultDriverFactory = (config) => {
  const client = new Client({
    host: config.hostname,
    port: 5432,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: false,
    connectionTimeoutMillis: config.connectTimeoutMs,
    query_timeout: 0,
    application_name: config.applicationName,
    options: "",
    client_encoding: "UTF8",
  });
  client.neonConfig.useSecureWebSocket = true;
  client.neonConfig.forceDisablePgSSL = true;
  client.neonConfig.pipelineConnect = false;
  client.neonConfig.coalesceWrites = false;
  client.neonConfig.wsProxy = `${config.hostname}/v2`;
  client.neonConfig.webSocketConstructor = config.socket as never;
  return client as unknown as VaultDriverClient;
};

// Races one operation against the deadline; the loser settles unobserved. `expired` runs
// when the deadline wins.
function within<T>(
  pending: Promise<T>,
  deadlineMs: number,
  now: () => number,
  expired: () => void = () => {},
): Promise<T> {
  void pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        expired();
        reject(fail("VAULT_DATABASE_UNAVAILABLE"));
      },
      Math.max(0, deadlineMs - now()),
    );
  });
  void stopped.catch(() => {});
  return Promise.race([pending, stopped]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
function rowsOf(reply: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(reply)) return [];
  const rows = (reply as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw fail("VAULT_DATABASE_UNAVAILABLE");
  return rows as Record<string, unknown>[];
}

/** Test seam: the transport over an injected driver, clock and socket. */
export async function runVaultTransactionWithDriver<T>(
  driver: VaultDriverFactory,
  vault: Readonly<BrokerVault>,
  budgetMs: number,
  body: (query: VaultQuery) => Promise<T>,
  now: () => number = Date.now,
  nativeSocket?: SocketConstructor,
  observe?: VaultTransactionObserver,
): Promise<T> {
  if (
    !Number.isSafeInteger(budgetMs) ||
    budgetMs < vaultTransactionLimits.budgetMinMs ||
    budgetMs > vaultTransactionLimits.budgetMaxMs ||
    !vault ||
    typeof vault.databasePassword !== "string" ||
    !vault.binding ||
    typeof body !== "function"
  )
    throw fail("VAULT_INPUT_INVALID");
  const started = now();
  const deadline = started + budgetMs;
  // The observation (fix-shopify-install-live): set as the transaction goes, frozen once
  // its outcome is fixed (`endedAt`), so the rollback and the close never change it.
  let phase: VaultTransactionPhase = "connect";
  let cause: VaultTransactionCause | null = null;
  let statements = 0;
  let connectMs: number | null = null;
  let endedAt: number | null = null;
  const note = (why: VaultTransactionCause) => {
    if (cause === null && endedAt === null) cause = why;
  };
  const end = () => {
    if (endedAt === null) endedAt = now();
  };
  // Called once, after the close; its throw is swallowed.
  const emit = () => {
    end();
    if (typeof observe !== "function") return;
    try {
      observe(
        Object.freeze({ phase, cause, statements, connectMs, txMs: (endedAt as number) - started }),
      );
    } catch {
      /* The observation never changes the outcome. */
    }
  };
  const { hostname, database } = vault.binding;
  const expectedUrl = `wss://${hostname}/v2?address=${hostname}:5432`;
  const native = nativeSocket ?? (globalThis.WebSocket as unknown as SocketConstructor);
  const sockets: { close(): void }[] = [];
  let shut = false;
  // Pinned: the driver may open exactly the binding's own endpoint.
  const Pinned = function (this: unknown, url: string) {
    if (url !== expectedUrl || shut || typeof native !== "function")
      throw fail("VAULT_DATABASE_UNAVAILABLE");
    const socket = new native(url) as { close(): void };
    sockets.push(socket);
    return socket;
  } as unknown as SocketConstructor;
  const shutdown = () => {
    shut = true;
    for (const socket of sockets)
      try {
        socket.close();
      } catch {
        /* Fixed failure only. */
      }
  };
  let client: VaultDriverClient;
  try {
    client = driver({
      hostname,
      database,
      user: brokerVaultRole,
      password: vault.databasePassword,
      applicationName: "morrow_vault_" + crypto.randomUUID().replaceAll("-", ""),
      connectTimeoutMs: Math.max(1, deadline - now()),
      socket: Pinned,
    });
  } catch {
    note("driver");
    shutdown();
    emit();
    throw fail("VAULT_DATABASE_UNAVAILABLE");
  }
  client.on("error", shutdown);
  let open = false,
    inFlight = false,
    commitSent = false;
  const send = async (text: string, values: readonly string[] = []) => {
    if (shut || inFlight || now() >= deadline) {
      note(shut || inFlight ? "driver" : "deadline");
      throw fail("VAULT_DATABASE_UNAVAILABLE");
    }
    inFlight = true;
    try {
      const pending = Promise.resolve().then(() =>
        values.length ? client.query(text, [...values]) : client.query(text),
      );
      const reply = await within(pending, deadline, now, () => note("deadline"));
      inFlight = false;
      let rows: readonly Record<string, unknown>[];
      try {
        rows = rowsOf(reply);
      } catch (error) {
        note("rows_shape");
        throw error;
      }
      if (endedAt === null) statements++;
      return rows;
    } catch (error) {
      note("driver");
      shutdown();
      throw error instanceof VaultError ? error : fail("VAULT_DATABASE_UNAVAILABLE");
    }
  };
  const query: VaultQuery = async (text, values) => {
    if (typeof text !== "string" || !registered.has(text)) throw fail("VAULT_STATEMENT_DENIED");
    if (!Array.isArray(values) || !values.every((v) => typeof v === "string"))
      throw fail("VAULT_STATEMENT_DENIED");
    const indexes = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    if ((indexes.length ? Math.max(...indexes) : 0) !== values.length)
      throw fail("VAULT_STATEMENT_DENIED");
    return send(text, values);
  };
  try {
    await within(
      Promise.resolve().then(() => client.connect()),
      deadline,
      now,
      () => note("deadline"),
    );
    connectMs = now() - started;
    phase = "begin";
    await send(vaultTransactionSql.begin);
    open = true;
    phase = "role";
    const role = await send(vaultTransactionSql.role);
    const r = role.length === 1 ? role[0] : undefined;
    if (
      !r ||
      Object.keys(r).sort().join(",") !== [...roleNames].sort().join(",") ||
      r.role !== brokerVaultRole ||
      r.login !== brokerVaultRole ||
      roleNames.slice(2).some((name) => r[name] !== false)
    ) {
      note("role_check");
      throw fail("VAULT_DATABASE_UNAVAILABLE");
    }
    phase = "settings";
    for (const setting of [
      vaultTransactionSql.statementTimeout,
      vaultTransactionSql.lockTimeout,
      vaultTransactionSql.idleTimeout,
    ])
      await send(setting);
    phase = "body";
    const value = await body(query);
    phase = "commit";
    commitSent = true;
    await send(vaultTransactionSql.commit);
    open = false;
    end();
    phase = "done";
    return value;
  } catch (error) {
    // The connect's own failure, or a body's throw that is not a VaultError.
    if (!(error instanceof VaultError)) note(phase === "body" ? "body" : "driver");
    end();
    // A COMMIT sent without its acknowledgement: the outcome is unknown, never retried.
    if (commitSent && open) throw fail("VAULT_OUTCOME_UNKNOWN");
    if (open && !inFlight && !shut)
      try {
        await send(vaultTransactionSql.rollback);
      } catch {
        // Unknown work is discarded with the connection.
      }
    throw error instanceof VaultError ? error : fail("VAULT_DATABASE_UNAVAILABLE");
  } finally {
    // The orderly close waits at most 1 s and never past the caller's deadline, so a
    // committed value is returned within the budget rather than after it (M2 PR-2 review:
    // a commit acknowledged near the deadline must not reach the caller as a timeout).
    try {
      await within(
        Promise.resolve().then(() => client.end()),
        Math.min(now() + 1000, deadline),
        now,
      );
    } catch {
      /* The socket is closed below either way. */
    }
    shutdown();
    emit();
  }
}

/**
 * One transaction on the broker's own login. `body` receives the registry-checked query;
 * its result is returned after COMMIT. Throws a VaultError on every failure. `observe`, when
 * given, receives where it ended (VaultTransactionObservation) once, after the close.
 */
export function runVaultTransaction<T>(
  vault: Readonly<BrokerVault>,
  budgetMs: number,
  body: (query: VaultQuery) => Promise<T>,
  observe?: VaultTransactionObserver,
): Promise<T> {
  return runVaultTransactionWithDriver(
    neonDriver,
    vault,
    budgetMs,
    body,
    Date.now,
    undefined,
    observe,
  );
}
