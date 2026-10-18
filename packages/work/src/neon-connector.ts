import { Client } from "@neondatabase/serverless";
import {
  brokerPasswordValid,
  neonLeaseNamespace,
  parseBrokerDatabaseBinding,
} from "../../identity/src/broker-protocol.js";
import type { ManagedWorkspaceNeonBinding } from "../../identity/src/managed-workspace-binding.js";
import type { WorkSqlConnection, WorkSqlConnector } from "./connection.js";

// One Neon WebSocket Client per request, never reused (ADR-0010 item 2), logged in
// as morrow_api_worker with a password leased from the broker for this request
// only (ADR-0007, B1). Deadline = min(request, lease.expiresAtMs); the lease's
// revocationSignal aborts the socket; close() then hands lease.release() to
// waitUntil. The password never appears in an Error, log line or return value:
// every driver failure becomes WORK_SQL_UNAVAILABLE.

type Control = Readonly<{ deadlineMs: number; signal: AbortSignal }>;
export interface WorkCredentialBroker {
  borrow(namespaceJson: string, control: Control): Promise<unknown>;
}
interface Lease {
  readonly password: string;
  readonly expiresAtMs: number;
  readonly revocationSignal: AbortSignal;
  readonly release: (control: Control) => Promise<void>;
}
type SocketConstructor = new (url: string) => unknown;
export interface WorkDriverClient {
  connect(): Promise<unknown>;
  query(text: string, values?: readonly (string | null)[]): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "error", listener: () => void): unknown;
}
export interface WorkDriverConfig {
  readonly hostname: string;
  readonly database: string;
  readonly user: "morrow_api_worker";
  readonly password: string;
  readonly applicationName: string;
  readonly connectTimeoutMs: number;
  readonly socket: SocketConstructor;
}
export type WorkDriverFactory = (config: WorkDriverConfig) => WorkDriverClient;

const unavailable = () => Error("WORK_SQL_UNAVAILABLE");
const time = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function lease(value: unknown, namespaceJson: string): Lease {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const own = (key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw unavailable();
    return descriptor.value as unknown;
  };
  const password = own("password"),
    expiresAtMs = own("expiresAtMs"),
    revocationSignal = own("revocationSignal"),
    release = own("release");
  if (
    own("namespaceJson") !== namespaceJson ||
    !brokerPasswordValid(password) ||
    !time(expiresAtMs) ||
    !(revocationSignal instanceof AbortSignal) ||
    typeof release !== "function"
  )
    throw unavailable();
  return Object.freeze({
    password,
    expiresAtMs,
    revocationSignal,
    release: (control: Control) =>
      Promise.resolve(Reflect.apply(release as Function, value, [control])) as Promise<void>,
  });
}

// Every operation races the request deadline and every abort source; a loser is
// left to settle unobserved and its value is never used.
function race<T>(
  pending: Promise<T>,
  signals: readonly AbortSignal[],
  deadlineMs: number,
  now: () => number,
) {
  void pending.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(unavailable());
    for (const signal of signals) {
      if (signal.aborted) stop();
      signal.addEventListener("abort", stop, { once: true });
    }
    timer = setTimeout(stop, Math.max(0, deadlineMs - now()));
  });
  void stopped.catch(() => {});
  return Promise.race([pending, stopped]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    for (const signal of signals) if (stop) signal.removeEventListener("abort", stop);
  });
}

const neonDriver: WorkDriverFactory = (config) => {
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
  return client as unknown as WorkDriverClient;
};

/** Test seam: the same connector over an injected driver and clock. */
export function neonWorkConnectorWithDriver(
  binding: Readonly<ManagedWorkspaceNeonBinding>,
  broker: WorkCredentialBroker,
  driver: WorkDriverFactory,
  now: () => number = Date.now,
  nativeSocket?: SocketConstructor,
): WorkSqlConnector {
  let b: ReturnType<typeof parseBrokerDatabaseBinding>;
  try {
    b = parseBrokerDatabaseBinding(JSON.stringify(binding));
  } catch {
    throw Error("WORK_CONNECTOR_CONFIGURATION_INVALID");
  }
  if (!broker || typeof broker.borrow !== "function")
    throw Error("WORK_CONNECTOR_CONFIGURATION_INVALID");
  const borrow = broker.borrow.bind(broker);
  const namespaceJson = neonLeaseNamespace(b, "morrow_api_worker");
  const expectedUrl = `wss://${b.hostname}/v2?address=${b.hostname}:5432`;
  return Object.freeze({
    async open(c: {
      signal: AbortSignal;
      deadlineMs: number;
      waitUntil(p: Promise<unknown>): void;
    }): Promise<WorkSqlConnection> {
      if (!c || !(c.signal instanceof AbortSignal) || !time(c.deadlineMs) || c.signal.aborted)
        throw unavailable();
      if (now() >= c.deadlineMs) throw unavailable();
      const control = Object.freeze({ deadlineMs: c.deadlineMs, signal: c.signal });
      let l: Lease;
      try {
        l = lease(
          await race(
            Promise.resolve().then(() => borrow(namespaceJson, control)),
            [c.signal],
            c.deadlineMs,
            now,
          ),
          namespaceJson,
        );
      } catch {
        // A broker failure is never echoed: it may carry anything.
        throw unavailable();
      }
      const deadline = Math.min(c.deadlineMs, l.expiresAtMs);
      const abort = new AbortController();
      const sockets: { close(): void }[] = [];
      let released = false,
        closed: Promise<void> | undefined;
      const releaseLease = () => {
        if (released) return;
        released = true;
        const pending = l
          .release(
            Object.freeze({ deadlineMs: now() + 1000, signal: new AbortController().signal }),
          )
          .catch(() => {});
        try {
          c.waitUntil(pending);
        } catch {
          void pending;
        }
      };
      const native = nativeSocket ?? (globalThis.WebSocket as unknown as SocketConstructor);
      // Pinned: the driver may open exactly the binding's own endpoint.
      const Pinned = function (this: unknown, url: string) {
        if (url !== expectedUrl || abort.signal.aborted || typeof native !== "function")
          throw unavailable();
        const socket = new native(url) as { close(): void };
        sockets.push(socket);
        return socket;
      } as unknown as SocketConstructor;
      const shutdown = () => {
        abort.abort();
        for (const socket of sockets)
          try {
            socket.close();
          } catch {
            /* Fixed failure only. */
          }
      };
      const signals = [c.signal, l.revocationSignal, abort.signal];
      for (const signal of [c.signal, l.revocationSignal])
        signal.addEventListener("abort", shutdown, { once: true });
      const lifetime = setTimeout(shutdown, Math.max(0, deadline - now()));
      let client: WorkDriverClient | undefined;
      const close = (): Promise<void> => {
        if (!closed)
          closed = (async () => {
            clearTimeout(lifetime);
            for (const signal of [c.signal, l.revocationSignal])
              signal.removeEventListener("abort", shutdown);
            try {
              const owned = client;
              if (owned)
                await race(
                  Promise.resolve().then(() => owned.end()),
                  [],
                  now() + 1000,
                  now,
                );
            } catch {
              /* The socket is closed below either way. */
            }
            shutdown();
            releaseLease();
          })();
        return closed;
      };
      try {
        if (now() >= deadline || l.revocationSignal.aborted) throw unavailable();
        const created = driver({
          hostname: b.hostname,
          database: b.database,
          user: "morrow_api_worker",
          password: l.password,
          applicationName: "morrow_work_" + crypto.randomUUID().replaceAll("-", ""),
          connectTimeoutMs: Math.max(1, deadline - now()),
          socket: Pinned,
        });
        client = created;
        created.on("error", shutdown);
        await race(
          Promise.resolve().then(() => created.connect()),
          signals,
          deadline,
          now,
        );
      } catch {
        await close();
        throw unavailable();
      }
      const connected = client;
      return Object.freeze({
        async query(text: string, values: readonly (string | null)[], signal: AbortSignal) {
          if (signal.aborted || abort.signal.aborted || now() >= deadline) throw unavailable();
          try {
            const reply = await race(
              Promise.resolve().then(() =>
                values.length ? connected.query(text, [...values]) : connected.query(text),
              ),
              [...signals, signal],
              deadline,
              now,
            );
            // A multi-statement simple-protocol reply (the prologue) has no rows.
            if (Array.isArray(reply)) return { rows: [] };
            const rows = (reply as { rows?: unknown }).rows;
            if (!Array.isArray(rows)) throw unavailable();
            return { rows: rows as Record<string, unknown>[] };
          } catch {
            shutdown();
            throw unavailable();
          }
        },
        close,
      });
    },
  });
}

export function createNeonWorkConnector(
  binding: Readonly<ManagedWorkspaceNeonBinding>,
  broker: WorkCredentialBroker,
): WorkSqlConnector {
  return neonWorkConnectorWithDriver(binding, broker, neonDriver);
}
