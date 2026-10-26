// The connector's own database login (M2 PR-2; ADR-0022 item 8): one Neon Client per
// request as morrow_connector_ingress, with the password ConnectorBroker.neonLease returns
// for this request only, over the one pinned WebSocket endpoint of the binding. Each
// transaction is BEGIN, the ADR-0020 D5 role preflight (the session and current user are
// exactly the connector login, every attribute is off, it is a member of nothing), the
// timeouts, one fixed statement and COMMIT. The login executes exactly five definers:
// morrow_identity.connector_oauth_state_open (M2 PR-2) and, since M2 PR-3 (migration
// 0037), the inbox applier morrow_work.connector_inbox_apply, the two ids-only re-drives
// connector_inbox_pending and connector_credentials_pending, and the count-only privacy
// deadline check connector_privacy_overdue. Every failure is CONNECTOR_SQL_UNAVAILABLE;
// nothing is logged and the password never appears in an error.
// fix-connector-cron-latency: a failed transaction's error carries where it ended
// (connectorSqlObservation: the step in progress, a closed cause, the statements
// acknowledged and two durations; the vault transport's observation for this login), so
// the caller's fixed-code line can tell a deadline far from the database from a refusal
// near it. No text, value or identifier; it never changes the order, the deadline or the
// outcome.
import { Client } from "@neondatabase/serverless";
import {
  brokerLimits,
  decodeNeonLeaseGrant,
  neonLeaseNamespace,
  type BrokerDatabaseBinding,
  type ConnectorBrokerRpc,
} from "../../../packages/identity/src/broker-protocol.js";
import { executorRoleMemberSql } from "../../../packages/identity/src/executor-role-preflight.js";
import {
  shopifyCredentialReasons,
  shopifyInstallationIdPattern,
  shopifyWebhookTopics,
  type ShopifyCredentialReason,
} from "../../../packages/identity/src/broker-protocol.js";

export const connectorLogin = "morrow_connector_ingress";
export const connectorSql = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
  role: `SELECT current_user AS role,session_user AS login,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,${executorRoleMemberSql} FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  statementTimeout: "SET LOCAL statement_timeout='2s'",
  lockTimeout: "SET LOCAL lock_timeout='1s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout='5s'",
  stateOpen:
    "SELECT outcome,client_id,scopes FROM morrow_identity.connector_oauth_state_open($1,$2,$3)",
  // M2 PR-3 (0037): the inbox applier and the two re-drives (ids only).
  inboxApply:
    "SELECT outcome,topic,installation_id,credential,reason FROM morrow_work.connector_inbox_apply($1)",
  inboxPending: "SELECT inbox_id FROM morrow_work.connector_inbox_pending()",
  credentialsPending:
    "SELECT installation_id,reason FROM morrow_work.connector_credentials_pending()",
  // M2 PR-3 review: open privacy requests past their target and their due time (counts).
  privacyOverdue: "SELECT target_missed,due_missed FROM morrow_work.connector_privacy_overdue()",
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
/**
 * One inbox row applied (connector_inbox_apply): its outcome, topic and installation, and
 * whether the installation's token is still to be destroyed (credential "pending", with
 * the end reason the destruction must name). "pending" as the outcome is shop/redact
 * waiting for that destruction before its privacy request completes.
 */
export type InboxApplyResult = Readonly<{
  outcome: "applied" | "pending" | "settled" | "not_found" | "invalid" | "denied";
  topic: string | null;
  installationId: string | null;
  credential: "pending" | "destroyed" | "none" | null;
  reason: ShopifyCredentialReason | null;
}>;
export interface ConnectorDatabase {
  stateOpen(
    appKey: string,
    shop: string,
    stateDigest: string,
    budgetMs: number,
  ): Promise<StateOpenOutcome>;
  inboxApply(inboxId: string, budgetMs: number): Promise<InboxApplyResult>;
  inboxPending(budgetMs: number): Promise<readonly string[]>;
  credentialsPending(
    budgetMs: number,
  ): Promise<readonly Readonly<{ installationId: string; reason: ShopifyCredentialReason }>[]>;
  privacyOverdue(budgetMs: number): Promise<PrivacyOverdue>;
}
/** Open privacy requests past their target and past their due time, across tenants. */
export type PrivacyOverdue = Readonly<{ targetMissed: number; dueMissed: number }>;
const inboxIdPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const applyOutcomes: readonly string[] = [
  "applied",
  "pending",
  "settled",
  "not_found",
  "invalid",
  "denied",
];
const nullableOf = (value: unknown, check: (v: unknown) => boolean) =>
  value === null || check(value);
const isReason = (value: unknown): value is ShopifyCredentialReason =>
  (shopifyCredentialReasons as readonly unknown[]).includes(value);

const unavailable = () => Error("CONNECTOR_SQL_UNAVAILABLE");
// Where a failed transaction ended: the step in progress (the broker's lease of the
// password, the connection, BEGIN, the role preflight, the timeouts, the statement,
// COMMIT), and why: the budget ran out (before a send, or while one waited), the lease
// failed, the driver failed or closed, the role preflight refused the session, a reply had
// no rows array, or the statement's reply was refused.
export const connectorTransactionPhases = Object.freeze([
  "lease",
  "connect",
  "begin",
  "role",
  "settings",
  "body",
  "commit",
] as const);
export type ConnectorTransactionPhase = (typeof connectorTransactionPhases)[number];
export const connectorTransactionCauses = Object.freeze([
  "deadline",
  "lease",
  "driver",
  "role_check",
  "rows_shape",
  "body",
] as const);
export type ConnectorTransactionCause = (typeof connectorTransactionCauses)[number];
export interface ConnectorTransactionObservation {
  readonly phase: ConnectorTransactionPhase;
  readonly cause: ConnectorTransactionCause;
  /** Statements acknowledged by the database, BEGIN included. */
  readonly statements: number;
  /** From the start until the connection was open; null when it never opened. */
  readonly connectMs: number | null;
  /** From the start until the failure was fixed (before any rollback or close). */
  readonly txMs: number;
}
class ConnectorSqlUnavailable extends Error {
  readonly observation: Readonly<ConnectorTransactionObservation>;
  constructor(observation: Readonly<ConnectorTransactionObservation>) {
    super("CONNECTOR_SQL_UNAVAILABLE");
    this.observation = observation;
  }
}
/** Where a transaction that threw ended, or null for any other error. */
export function connectorSqlObservation(
  error: unknown,
): Readonly<ConnectorTransactionObservation> | null {
  return error instanceof ConnectorSqlUnavailable ? error.observation : null;
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
        reject(unavailable());
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
    const started = now();
    const deadline = started + budgetMs;
    // The observation: set as the transaction goes, fixed by the first failure (`endedAt`),
    // so the rollback and the close never change it.
    let phase: ConnectorTransactionPhase = "lease";
    let cause: ConnectorTransactionCause | null = null;
    let statements = 0;
    let connectMs: number | null = null;
    let endedAt: number | null = null;
    const note = (why: ConnectorTransactionCause) => {
      if (cause === null && endedAt === null) cause = why;
    };
    const failed = (fallback: ConnectorTransactionCause) => {
      note(fallback);
      if (endedAt === null) endedAt = now();
      return new ConnectorSqlUnavailable(
        Object.freeze({
          phase,
          cause: cause ?? fallback,
          statements,
          connectMs,
          txMs: endedAt - started,
        }),
      );
    };
    let password: string;
    try {
      password = decodeNeonLeaseGrant(
        await within(
          Promise.resolve().then(() => broker.neonLease(namespaceJson)),
          deadline,
          now,
          () => note("deadline"),
        ),
      );
    } catch {
      throw failed("lease");
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
    phase = "connect";
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
      throw failed("driver");
    }
    password = "";
    client.on("error", shutdown);
    let open = false,
      inFlight = false;
    const send = async (text: string, values: readonly string[] = []) => {
      if (shut || inFlight || now() >= deadline) {
        note(shut || inFlight ? "driver" : "deadline");
        throw unavailable();
      }
      inFlight = true;
      try {
        const reply = await within(
          Promise.resolve().then(() =>
            values.length ? client.query(text, [...values]) : client.query(text),
          ),
          deadline,
          now,
          () => note("deadline"),
        );
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
      } catch {
        note("driver");
        shutdown();
        throw unavailable();
      }
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
      await send(connectorSql.begin);
      open = true;
      phase = "role";
      const role = await send(connectorSql.role);
      const r = role.length === 1 ? role[0] : undefined;
      if (
        !r ||
        Object.keys(r).sort().join(",") !== [...roleNames].sort().join(",") ||
        r.role !== connectorLogin ||
        r.login !== connectorLogin ||
        roleNames.slice(2).some((name) => r[name] !== false)
      ) {
        note("role_check");
        throw unavailable();
      }
      phase = "settings";
      for (const setting of [
        connectorSql.statementTimeout,
        connectorSql.lockTimeout,
        connectorSql.idleTimeout,
      ])
        await send(setting);
      phase = "body";
      const value = await body(send);
      phase = "commit";
      await send(connectorSql.commit);
      open = false;
      return value;
    } catch {
      // The connect's own failure, or the body's refusal of a reply.
      const error = failed(phase === "body" ? "body" : "driver");
      if (open && !inFlight && !shut)
        try {
          await send(connectorSql.rollback);
        } catch {
          /* Discarded with the connection. */
        }
      throw error;
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
  const columns = (row: Record<string, unknown> | undefined, names: string) => {
    if (!row || Object.keys(row).sort().join(",") !== names) throw unavailable();
    return row;
  };
  return Object.freeze({
    inboxApply(inboxId: string, budgetMs: number): Promise<InboxApplyResult> {
      if (!inboxIdPattern.test(inboxId)) return Promise.reject(unavailable());
      return transaction(budgetMs, async (send) => {
        const rows = await send(connectorSql.inboxApply, [inboxId]);
        const r = columns(
          rows.length === 1 ? rows[0] : undefined,
          "credential,installation_id,outcome,reason,topic",
        );
        if (
          !applyOutcomes.includes(r.outcome as string) ||
          !nullableOf(r.topic, (v) => (shopifyWebhookTopics as readonly unknown[]).includes(v)) ||
          !nullableOf(
            r.installation_id,
            (v) => typeof v === "string" && shopifyInstallationIdPattern.test(v),
          ) ||
          !nullableOf(r.credential, (v) => v === "pending" || v === "destroyed" || v === "none") ||
          !nullableOf(r.reason, isReason) ||
          (r.credential === "pending" && (r.installation_id === null || r.reason === null))
        )
          throw unavailable();
        return Object.freeze({
          outcome: r.outcome as InboxApplyResult["outcome"],
          topic: r.topic as string | null,
          installationId: r.installation_id as string | null,
          credential: r.credential as InboxApplyResult["credential"],
          reason: r.reason as ShopifyCredentialReason | null,
        });
      });
    },
    inboxPending(budgetMs: number) {
      return transaction(budgetMs, async (send) => {
        const rows = await send(connectorSql.inboxPending);
        if (rows.length > 20) throw unavailable();
        return Object.freeze(
          rows.map((row) => {
            const r = columns(row, "inbox_id");
            if (typeof r.inbox_id !== "string" || !inboxIdPattern.test(r.inbox_id))
              throw unavailable();
            return r.inbox_id;
          }),
        );
      });
    },
    credentialsPending(budgetMs: number) {
      return transaction(budgetMs, async (send) => {
        const rows = await send(connectorSql.credentialsPending);
        if (rows.length > 20) throw unavailable();
        return Object.freeze(
          rows.map((row) => {
            const r = columns(row, "installation_id,reason");
            if (
              typeof r.installation_id !== "string" ||
              !shopifyInstallationIdPattern.test(r.installation_id) ||
              !isReason(r.reason)
            )
              throw unavailable();
            return Object.freeze({ installationId: r.installation_id, reason: r.reason });
          }),
        );
      });
    },
    privacyOverdue(budgetMs: number): Promise<PrivacyOverdue> {
      return transaction(budgetMs, async (send) => {
        const rows = await send(connectorSql.privacyOverdue);
        const r = columns(rows.length === 1 ? rows[0] : undefined, "due_missed,target_missed");
        const count = (v: unknown): v is number =>
          typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
        if (!count(r.target_missed) || !count(r.due_missed) || r.due_missed > r.target_missed)
          throw unavailable();
        return Object.freeze({ targetMissed: r.target_missed, dueMissed: r.due_missed });
      });
    },
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
