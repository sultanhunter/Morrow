import { Client } from "@neondatabase/serverless";
import {
  brokerLimits,
  decodeNeonLeaseGrant,
  neonLeaseNamespace,
  type BrokerDatabaseBinding,
} from "../../../packages/identity/src/broker-protocol.js";
import type {
  FixedSqlClient,
  FixedSqlControl,
  FixedSqlPool,
} from "../../../packages/identity/src/fixed-sql-transaction.js";

// The orchestrator's database login (M3 PR-2; ADR-0022 items 8 and 9; spine §5): one Neon
// Client per Workflow step transaction, logged in as morrow_runtime_executor with the
// password RuntimeBroker.neonLease returns for that transaction only, over the one pinned
// WebSocket endpoint of the binding. runLeaseStep (packages/work/src/runtime/leases.ts) runs
// the transaction protocol on it: BEGIN, the ADR-0020 D5 role preflight, the timeouts,
// enter_lease and the step's fixed statements, COMMIT. Every failure is
// RUNTIME_SQL_UNAVAILABLE; nothing is logged and the password never appears in an error.

export const runtimeLogin = "morrow_runtime_executor";
type SocketConstructor = new (url: string) => unknown;
export interface RuntimeDriverClient {
  connect(): Promise<unknown>;
  query(text: string, values?: readonly string[]): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "error", listener: () => void): unknown;
}
export interface RuntimeDriverConfig {
  readonly hostname: string;
  readonly database: string;
  readonly user: typeof runtimeLogin;
  readonly password: string;
  readonly applicationName: string;
  readonly connectTimeoutMs: number;
  readonly socket: SocketConstructor;
}
export type RuntimeDriverFactory = (config: RuntimeDriverConfig) => RuntimeDriverClient;
const unavailable = () => Error("RUNTIME_SQL_UNAVAILABLE");

export const neonRuntimeDriver: RuntimeDriverFactory = (config) => {
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
  return client as unknown as RuntimeDriverClient;
};

function rowsOf(reply: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(reply)) return [];
  const rows = (reply as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw unavailable();
  return rows as Record<string, unknown>[];
}

/** A FixedSqlPool of one fresh, pinned connection per transaction. */
export function createRuntimePool(
  binding: Readonly<BrokerDatabaseBinding>,
  broker: { neonLease(namespaceJson: string): Promise<string> },
  driver: RuntimeDriverFactory = neonRuntimeDriver,
  nativeSocket?: SocketConstructor,
): FixedSqlPool {
  const namespaceJson = neonLeaseNamespace(binding, runtimeLogin);
  if (new TextEncoder().encode(namespaceJson).length > brokerLimits.namespaceMaxBytes)
    throw unavailable();
  const expectedUrl = `wss://${binding.hostname}/v2?address=${binding.hostname}:5432`;
  return Object.freeze({
    async connect(control: Readonly<FixedSqlControl>): Promise<FixedSqlClient> {
      let password: string;
      try {
        password = decodeNeonLeaseGrant(await broker.neonLease(namespaceJson));
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
      let client: RuntimeDriverClient;
      try {
        client = driver({
          hostname: binding.hostname,
          database: binding.database,
          user: runtimeLogin,
          password,
          applicationName: "morrow_runtime_" + crypto.randomUUID().replaceAll("-", ""),
          connectTimeoutMs: Math.max(1, control.deadlineMs - Date.now()),
          socket: Pinned,
        });
      } catch {
        shutdown();
        throw unavailable();
      }
      password = "";
      client.on("error", shutdown);
      try {
        await client.connect();
      } catch {
        shutdown();
        throw unavailable();
      }
      return Object.freeze({
        async query(text: string, values: readonly string[]) {
          if (shut) throw unavailable();
          try {
            return {
              rows: rowsOf(
                await (values.length ? client.query(text, [...values]) : client.query(text)),
              ),
            };
          } catch {
            shutdown();
            throw unavailable();
          }
        },
        async release() {
          try {
            await client.end();
          } catch {
            /* Closed below either way. */
          }
          shutdown();
        },
      });
    },
  });
}
