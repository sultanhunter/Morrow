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

// Races one operation against the deadline; the loser settles unobserved.
function within<T>(pending: Promise<T>, deadlineMs: number, now: () => number): Promise<T> {
  void pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(fail("VAULT_DATABASE_UNAVAILABLE")),
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
  const deadline = now() + budgetMs;
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
    shutdown();
    throw fail("VAULT_DATABASE_UNAVAILABLE");
  }
  client.on("error", shutdown);
  let open = false,
    inFlight = false,
    commitSent = false;
  const send = async (text: string, values: readonly string[] = []) => {
    if (shut || inFlight || now() >= deadline) throw fail("VAULT_DATABASE_UNAVAILABLE");
    inFlight = true;
    try {
      const pending = Promise.resolve().then(() =>
        values.length ? client.query(text, [...values]) : client.query(text),
      );
      const reply = await within(pending, deadline, now);
      inFlight = false;
      return rowsOf(reply);
    } catch (error) {
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
    );
    await send(vaultTransactionSql.begin);
    open = true;
    const role = await send(vaultTransactionSql.role);
    const r = role.length === 1 ? role[0] : undefined;
    if (
      !r ||
      Object.keys(r).sort().join(",") !== [...roleNames].sort().join(",") ||
      r.role !== brokerVaultRole ||
      r.login !== brokerVaultRole ||
      roleNames.slice(2).some((name) => r[name] !== false)
    )
      throw fail("VAULT_DATABASE_UNAVAILABLE");
    for (const setting of [
      vaultTransactionSql.statementTimeout,
      vaultTransactionSql.lockTimeout,
      vaultTransactionSql.idleTimeout,
    ])
      await send(setting);
    const value = await body(query);
    commitSent = true;
    await send(vaultTransactionSql.commit);
    open = false;
    return value;
  } catch (error) {
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
    try {
      await within(
        Promise.resolve().then(() => client.end()),
        now() + 1000,
        now,
      );
    } catch {
      /* The socket is closed below either way. */
    }
    shutdown();
  }
}

/**
 * One transaction on the broker's own login. `body` receives the registry-checked query;
 * its result is returned after COMMIT. Throws a VaultError on every failure.
 */
export function runVaultTransaction<T>(
  vault: Readonly<BrokerVault>,
  budgetMs: number,
  body: (query: VaultQuery) => Promise<T>,
): Promise<T> {
  return runVaultTransactionWithDriver(neonDriver, vault, budgetMs, body);
}
