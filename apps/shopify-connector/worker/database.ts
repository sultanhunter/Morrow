// The connector's own database login (M2 PR-2; ADR-0022 item 8): one Neon Client per
// request as morrow_connector_ingress, with the password ConnectorBroker.neonLease returns
// for this request only, over the one pinned WebSocket endpoint of the binding. Each
// transaction is BEGIN, the ADR-0020 D5 role preflight (the session and current user are
// exactly the connector login, every attribute is off, it is a member of nothing), the
// timeouts, one fixed statement and COMMIT. The login calls these definers:
// morrow_identity.connector_oauth_state_open (M2 PR-2); since M2 PR-3 (migration 0037) the
// two ids-only re-drives connector_inbox_pending and connector_credentials_pending and the
// count-only privacy deadline check connector_privacy_overdue; and since v1 PR 5
// (connection-health-work) the inbox applier morrow_work.connector_inbox_apply_v2 (0037's
// connector_inbox_apply stays executable, and _v2 calls it for every topic but a scope
// change), connector_health_reconcile, the ids-only lists connector_checks_due,
// connector_notices_due and connector_deletions_due, connector_deletion_apply and the
// count-only connector_inbox_stuck. Every failure is CONNECTOR_SQL_UNAVAILABLE; nothing is
// logged and the password never appears in an error.
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
  // M2 PR-3 (0037): the inbox applier and the two re-drives (ids only). v1 PR 5
  // (connection-health-work): the applier is connector_inbox_apply_v2 (a scope change keeps
  // the connection and its token; every other topic is 0037's applier, unchanged).
  inboxApply:
    "SELECT outcome,topic,installation_id,credential,reason FROM morrow_work.connector_inbox_apply_v2($1)",
  inboxPending: "SELECT inbox_id FROM morrow_work.connector_inbox_pending()",
  credentialsPending:
    "SELECT installation_id,reason FROM morrow_work.connector_credentials_pending()",
  // M2 PR-3 review: open privacy requests past their target and their due time (counts).
  privacyOverdue: "SELECT target_missed,due_missed FROM morrow_work.connector_privacy_overdue()",
  // v1 PR 5 (connection-health-work): the reconcile of one installation (agent stops and the
  // Reconnect item, from its recorded state), the clean-up jobs' ids-only lists, the 48-hour
  // deletion of one installation and the stuck-delivery close (counts).
  healthReconcile:
    "SELECT outcome,notice,stopped,newly FROM morrow_work.connector_health_reconcile($1)",
  checksDue: "SELECT installation_id FROM morrow_work.connector_checks_due()",
  noticesDue: "SELECT installation_id FROM morrow_work.connector_notices_due()",
  deletionsDue: "SELECT installation_id FROM morrow_work.connector_deletions_due()",
  deletionApply:
    "SELECT outcome,installation_id,credential,reason FROM morrow_work.connector_deletion_apply($1)",
  inboxStuck: "SELECT closed,stuck FROM morrow_work.connector_inbox_stuck()",
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
  // v1 PR 5 (connection-health-work).
  healthReconcile(installationId: string, budgetMs: number): Promise<HealthReconcileResult>;
  checksDue(budgetMs: number): Promise<readonly string[]>;
  noticesDue(budgetMs: number): Promise<readonly string[]>;
  deletionsDue(budgetMs: number): Promise<readonly string[]>;
  deletionApply(installationId: string, budgetMs: number): Promise<DeletionApplyResult>;
  inboxStuck(budgetMs: number): Promise<InboxStuck>;
}
/** Open privacy requests past their target and past their due time, across tenants. */
export type PrivacyOverdue = Readonly<{ targetMissed: number; dueMissed: number }>;
/**
 * v1 PR 5: one reconcile of an installation's agent stops and Reconnect item: what it did to
 * the item (raised, revised, unchanged, cleared, none) and how many agents it names as
 * stopped (and how many it stopped now).
 */
export type HealthReconcileResult = Readonly<{
  outcome: "reconciled" | "ended" | "not_found" | "invalid" | "denied";
  notice: "raised" | "revised" | "unchanged" | "cleared" | "none" | null;
  stopped: number | null;
  newly: number | null;
}>;
/** v1 PR 5: one 48-hour deletion step, with the token still to destroy (as inboxApply). */
export type DeletionApplyResult = Readonly<{
  outcome: "applied" | "pending" | "settled" | "ineligible" | "not_found" | "invalid" | "denied";
  installationId: string | null;
  credential: "pending" | "destroyed" | null;
  reason: "uninstalled" | null;
}>;
/** v1 PR 5: stuck scope-change deliveries closed, and every delivery still stuck. */
export type InboxStuck = Readonly<{ closed: number; stuck: number }>;
const reconcileOutcomes: readonly string[] = [
  "reconciled",
  "ended",
  "not_found",
  "invalid",
  "denied",
];
const noticeActions: readonly string[] = ["raised", "revised", "unchanged", "cleared", "none"];
const deletionOutcomes: readonly string[] = [
  "applied",
  "pending",
  "settled",
  "ineligible",
  "not_found",
  "invalid",
  "denied",
];
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
  const columns = (row: Record<string, unknown> | undefined, names: string) => {
    if (!row || Object.keys(row).sort().join(",") !== names) throw unavailable();
    return row;
  };
  // v1 PR 5: an ids-only list of installations (at most 20).
  const idList = (budgetMs: number, statement: string) =>
    transaction(budgetMs, async (send) => {
      const rows = await send(statement);
      if (rows.length > 20) throw unavailable();
      return Object.freeze(
        rows.map((row) => {
          const r = columns(row, "installation_id");
          if (
            typeof r.installation_id !== "string" ||
            !shopifyInstallationIdPattern.test(r.installation_id)
          )
            throw unavailable();
          return r.installation_id;
        }),
      );
    });
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
    healthReconcile(installationId: string, budgetMs: number): Promise<HealthReconcileResult> {
      if (!shopifyInstallationIdPattern.test(installationId)) return Promise.reject(unavailable());
      return transaction(budgetMs, async (send) => {
        const rows = await send(connectorSql.healthReconcile, [installationId]);
        const r = columns(rows.length === 1 ? rows[0] : undefined, "newly,notice,outcome,stopped");
        const count = (v: unknown) =>
          v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 32);
        const done = r.outcome === "reconciled" || r.outcome === "ended";
        if (
          !reconcileOutcomes.includes(r.outcome as string) ||
          (done
            ? !noticeActions.includes(r.notice as string) ||
              typeof r.stopped !== "number" ||
              typeof r.newly !== "number"
            : r.notice !== null || r.stopped !== null || r.newly !== null) ||
          !count(r.stopped) ||
          !count(r.newly)
        )
          throw unavailable();
        return Object.freeze({
          outcome: r.outcome as HealthReconcileResult["outcome"],
          notice: r.notice as HealthReconcileResult["notice"],
          stopped: r.stopped as number | null,
          newly: r.newly as number | null,
        });
      });
    },
    checksDue(budgetMs: number) {
      return idList(budgetMs, connectorSql.checksDue);
    },
    noticesDue(budgetMs: number) {
      return idList(budgetMs, connectorSql.noticesDue);
    },
    deletionsDue(budgetMs: number) {
      return idList(budgetMs, connectorSql.deletionsDue);
    },
    deletionApply(installationId: string, budgetMs: number): Promise<DeletionApplyResult> {
      if (!shopifyInstallationIdPattern.test(installationId)) return Promise.reject(unavailable());
      return transaction(budgetMs, async (send) => {
        const rows = await send(connectorSql.deletionApply, [installationId]);
        const r = columns(
          rows.length === 1 ? rows[0] : undefined,
          "credential,installation_id,outcome,reason",
        );
        const done = r.outcome === "applied" || r.outcome === "pending" || r.outcome === "settled";
        if (
          !deletionOutcomes.includes(r.outcome as string) ||
          (done
            ? r.installation_id !== installationId ||
              (r.credential !== "pending" && r.credential !== "destroyed") ||
              r.reason !== "uninstalled" ||
              (r.outcome !== "pending" && r.credential !== "destroyed")
            : r.installation_id !== null || r.credential !== null || r.reason !== null)
        )
          throw unavailable();
        return Object.freeze({
          outcome: r.outcome as DeletionApplyResult["outcome"],
          installationId: r.installation_id as string | null,
          credential: r.credential as DeletionApplyResult["credential"],
          reason: r.reason as DeletionApplyResult["reason"],
        });
      });
    },
    inboxStuck(budgetMs: number): Promise<InboxStuck> {
      return transaction(budgetMs, async (send) => {
        const rows = await send(connectorSql.inboxStuck);
        const r = columns(rows.length === 1 ? rows[0] : undefined, "closed,stuck");
        const count = (v: unknown): v is number =>
          typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
        if (!count(r.closed) || !count(r.stuck) || r.closed > 20) throw unavailable();
        return Object.freeze({ closed: r.closed, stuck: r.stuck });
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
