// The connector's own database login (M2 PR-2; ADR-0022 item 8): one Neon Client per
// request as morrow_connector_ingress, with the password ConnectorBroker.neonLease returns
// for this request only, over the one pinned WebSocket endpoint of the binding. Each
// transaction is BEGIN, the ADR-0020 D5 role preflight (the session and current user are
// exactly the connector login, every attribute is off, it is a member of nothing), the
// timeouts, one fixed statement and COMMIT. The login executes exactly one definer,
// morrow_identity.connector_oauth_state_open. Every failure is CONNECTOR_SQL_UNAVAILABLE;
// nothing is logged and the password never appears in an error.
import { Client } from "@neondatabase/serverless";
import {
  brokerLimits,
  decodeNeonLeaseGrant,
  neonLeaseNamespace,
  type BrokerDatabaseBinding,
  type ConnectorBrokerRpc,
} from "../../../packages/identity/src/broker-protocol.js";
import { executorRoleMemberSql } from "../../../packages/identity/src/executor-role-preflight.js";

export const connectorLogin = "morrow_connector_ingress";
export const connectorSql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
  role: `SELECT current_user AS role,session_user AS login,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,${executorRoleMemberSql} FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  statementTimeout: "SET LOCAL statement_timeout='2s'",
  lockTimeout: "SET LOCAL lock_timeout='1s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout='5s'",
  stateOpen:
    "SELECT outcome,client_id,scopes FROM morrow_identity.connector_oauth_state_open($1,$2,$3)",
  commit: "COMMIT",
  rollback: "ROLLBACK",
});
type SocketConstructor = new (url: string) => unknown;
export interface ConnectorDriverClient {
  connect(): Promise<unknown>;
  query(text: string, values?: readonly string[]): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "error", listener: () => void): unknown;
}
export interface ConnectorDriverConfig {
  readonly hostname: string;
  readonly database: string;
  readonly user: typeof connectorLogin;
  readonly password: string;
  readonly applicationName: string;
  readonly connectTimeoutMs: number;
  readonly socket: SocketConstructor;
}
export type ConnectorDriverFactory = (config: ConnectorDriverConfig) => ConnectorDriverClient;
export type StateOpenOutcome =
  | Readonly<{ outcome: "opened"; clientId: string; scopes: string }>
  | Readonly<{ outcome: "limited" | "not_found" | "invalid" | "denied" }>;
export interface ConnectorDatabase {
  stateOpen(
    appKey: string,
    shop: string,
    stateDigest: string,
    budgetMs: number,
  ): Promise<StateOpenOutcome>;
}

const unavailable = () => Error("CONNECTOR_SQL_UNAVAILABLE");
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

export const neonConnectorDriver: ConnectorDriverFactory = (config) => {
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
  return client as unknown as ConnectorDriverClient;
};

function within<T>(pending: Promise<T>, deadlineMs: number, now: () => number): Promise<T> {
  void pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(unavailable()), Math.max(0, deadlineMs - now()));
  });
  void stopped.catch(() => {});
  return Promise.race([pending, stopped]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
function rowsOf(reply: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(reply)) return [];
  const rows = (reply as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw unavailable();
  return rows as Record<string, unknown>[];
}

export function createConnectorDatabase(
  binding: Readonly<BrokerDatabaseBinding>,
  broker: Pick<ConnectorBrokerRpc, "neonLease">,
  driver: ConnectorDriverFactory = neonConnectorDriver,
  now: () => number = Date.now,
  nativeSocket?: SocketConstructor,
): ConnectorDatabase {
  const namespaceJson = neonLeaseNamespace(binding, connectorLogin);
  if (new TextEncoder().encode(namespaceJson).length > brokerLimits.namespaceMaxBytes)
    throw unavailable();
  const expectedUrl = `wss://${binding.hostname}/v2?address=${binding.hostname}:5432`;
  async function transaction<T>(
    budgetMs: number,
    body: (
      send: (
        text: string,
        values?: readonly string[],
      ) => Promise<readonly Record<string, unknown>[]>,
    ) => Promise<T>,
  ): Promise<T> {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 10000) throw unavailable();
    const deadline = now() + budgetMs;
    let password: string;
    try {
      password = decodeNeonLeaseGrant(
        await within(
          Promise.resolve().then(() => broker.neonLease(namespaceJson)),
          deadline,
          now,
        ),
      );
    } catch {
      throw unavailable();
    }
    const native = nativeSocket ?? (globalThis.WebSocket as unknown as SocketConstructor);
    const sockets: { close(): void }[] = [];
    let shut = false;
    const Pinned = function (this: unknown, url: string) {
      if (url !== expectedUrl || shut || typeof native !== "function") throw unavailable();
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
    let client: ConnectorDriverClient;
    try {
      client = driver({
        hostname: binding.hostname,
        database: binding.database,
        user: connectorLogin,
        password,
        applicationName: "morrow_connector_" + crypto.randomUUID().replaceAll("-", ""),
        connectTimeoutMs: Math.max(1, deadline - now()),
        socket: Pinned,
      });
    } catch {
      shutdown();
      throw unavailable();
    }
    password = "";
    client.on("error", shutdown);
    let open = false,
      inFlight = false;
    const send = async (text: string, values: readonly string[] = []) => {
      if (shut || inFlight || now() >= deadline) throw unavailable();
      inFlight = true;
      try {
        const reply = await within(
          Promise.resolve().then(() =>
            values.length ? client.query(text, [...values]) : client.query(text),
          ),
          deadline,
          now,
        );
        inFlight = false;
        return rowsOf(reply);
      } catch {
        shutdown();
        throw unavailable();
      }
    };
    try {
      await within(
        Promise.resolve().then(() => client.connect()),
        deadline,
        now,
      );
      await send(connectorSql.begin);
      open = true;
      const role = await send(connectorSql.role);
      const r = role.length === 1 ? role[0] : undefined;
      if (
        !r ||
        Object.keys(r).sort().join(",") !== [...roleNames].sort().join(",") ||
        r.role !== connectorLogin ||
        r.login !== connectorLogin ||
        roleNames.slice(2).some((name) => r[name] !== false)
      )
        throw unavailable();
      for (const setting of [
        connectorSql.statementTimeout,
        connectorSql.lockTimeout,
        connectorSql.idleTimeout,
      ])
        await send(setting);
      const value = await body(send);
      await send(connectorSql.commit);
      open = false;
      return value;
    } catch {
      if (open && !inFlight && !shut)
        try {
          await send(connectorSql.rollback);
        } catch {
          /* Discarded with the connection. */
        }
      throw unavailable();
    } finally {
      try {
        await within(
          Promise.resolve().then(() => client.end()),
          now() + 1000,
          now,
        );
      } catch {
        /* Closed below either way. */
      }
      shutdown();
    }
  }
  return Object.freeze({
    stateOpen(appKey: string, shop: string, stateDigest: string, budgetMs: number) {
      return transaction(budgetMs, async (send) => {
        const rows = await send(connectorSql.stateOpen, [appKey, shop, stateDigest]);
        const r = rows.length === 1 ? rows[0]! : undefined;
        if (!r || Object.keys(r).sort().join(",") !== "client_id,outcome,scopes")
          throw unavailable();
        if (r.outcome === "opened") {
          if (
            typeof r.client_id !== "string" ||
            !/^[a-f0-9]{32}$/.test(r.client_id) ||
            r.scopes !== "read_products,write_products"
          )
            throw unavailable();
          return Object.freeze({
            outcome: "opened" as const,
            clientId: r.client_id,
            scopes: r.scopes,
          });
        }
        if (
          !["limited", "not_found", "invalid", "denied"].includes(r.outcome as string) ||
          r.client_id !== null ||
          r.scopes !== null
        )
          throw unavailable();
        return Object.freeze({
          outcome: r.outcome as "limited" | "not_found" | "invalid" | "denied",
        });
      });
    },
  });
}
