// The "Reconnect" item of a store connection (v1 PR 5; ADR-0025 item 10): the narrow seam the
// Inbox reads. Migration connection-health-work keeps one open morrow_work.connection_notices
// row per connection while the app lacks a scope it requests (or Shopify refused the token),
// naming the missing scopes and the agent installations stopped for it, for the connection
// steward and the Owner only. GET /work/inbox (inbox/read.ts, main's Sunrise Inbox) reads
// them through readReconnectNotices and shows each open one as a connection problem
// (`scopes_changed`) to a recipient who holds the store's disconnect right (PR 5 review
// finding F1, after integration with main); a `reconnect` item kind with the missing scopes
// and the stopped agents is PR 10b's. Pure: the statement texts, strict decoders, the
// scopes each agent release needs (the twin of morrow_work.release_shopify_scopes), the plan
// the reconcile follows (the twin of morrow_work.connection_health_reconcile's decisions) and
// fixtures. Nothing here resumes an agent: only a person does.

/** The read definers' statements (session only). */
export const connectionHealthStatements = Object.freeze({
  // The viewer's open Reconnect items, at most 20.
  connectionNoticesOpen:
    "SELECT notice_id,kind,cause,store_id,connection_id,installation_id,missing_scopes,stopped_installations,revision,created_at,updated_at,still_open FROM morrow_work.connection_notices_open()",
  // The store a reinstall of the same app linked in place of the session tenant's ended
  // store $1 (at most one; PR 5 review finding F3, after integration with main).
  storeReinstalled: "SELECT store_id,connection_id FROM morrow_work.store_reinstalled($1)",
} as const);

export type ReconnectCause = "scopes_missing" | "token_refused";
export interface ReconnectNotice {
  readonly noticeId: string;
  readonly kind: "reconnect";
  readonly cause: ReconnectCause;
  readonly storeId: string;
  readonly connectionId: string;
  /** The store installation (StoreInstallation@1) whose connection needs reconnecting. */
  readonly installationId: string;
  /** Scopes the app requests that the connection lacks (empty when only a token refusal). */
  readonly missingScopes: readonly string[];
  /** Agent installations stopped for it; a person resumes each one. */
  readonly stoppedAgentInstallations: readonly string[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Whether the connection still needs reconnecting against its current state (false once a
   * re-authorisation restored the scopes, before the cron clears the item).
   */
  readonly open: boolean;
}

export class ReconnectNoticeInvalid extends Error {
  constructor() {
    super("RECONNECT_NOTICE_INVALID");
    this.name = "ReconnectNoticeInvalid";
  }
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const uuidPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const scopePattern = /^[a-z][a-z_]{0,63}$/;
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const columns = [
  "cause",
  "connection_id",
  "created_at",
  "installation_id",
  "kind",
  "missing_scopes",
  "notice_id",
  "revision",
  "still_open",
  "stopped_installations",
  "store_id",
  "updated_at",
].join(",");
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;

/** The read definer's rows, strictly: anything else is ReconnectNoticeInvalid. */
export function decodeReconnectNotices(
  rows: readonly Record<string, unknown>[],
): readonly ReconnectNotice[] {
  if (!Array.isArray(rows) || rows.length > 20) throw new ReconnectNoticeInvalid();
  return Object.freeze(
    rows.map((row) => {
      if (!row || Object.keys(row).sort().join(",") !== columns) throw new ReconnectNoticeInvalid();
      const missing = typeof row.missing_scopes === "string" ? row.missing_scopes : null;
      const scopes: string[] = missing === null || missing === "" ? [] : missing.split(",");
      let stopped: unknown;
      try {
        stopped =
          typeof row.stopped_installations === "string"
            ? JSON.parse(row.stopped_installations)
            : null;
      } catch {
        stopped = null;
      }
      if (
        !exact(uuidPattern, row.notice_id) ||
        row.kind !== "reconnect" ||
        (row.cause !== "scopes_missing" && row.cause !== "token_refused") ||
        !exact(idPattern, row.store_id) ||
        !exact(idPattern, row.connection_id) ||
        !exact(idPattern, row.installation_id) ||
        missing === null ||
        scopes.length > 8 ||
        !scopes.every((s) => exact(scopePattern, s)) ||
        !Array.isArray(stopped) ||
        stopped.length > 32 ||
        !stopped.every((id) => exact(idPattern, id)) ||
        !exact(/^[1-9][0-9]{0,15}$/, row.revision) ||
        !exact(utcPattern, row.created_at) ||
        !exact(utcPattern, row.updated_at) ||
        (row.still_open !== "true" && row.still_open !== "false")
      )
        throw new ReconnectNoticeInvalid();
      return Object.freeze({
        noticeId: row.notice_id,
        kind: "reconnect" as const,
        cause: row.cause as ReconnectCause,
        storeId: row.store_id,
        connectionId: row.connection_id,
        installationId: row.installation_id,
        missingScopes: Object.freeze(scopes),
        stoppedAgentInstallations: Object.freeze([...(stopped as string[])]),
        revision: Number(row.revision),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        open: row.still_open === "true",
      });
    }),
  );
}

/** The narrow port the Inbox reads through (a WorkTx in the api; the fake below elsewhere). */
export interface ReconnectNoticeSource {
  run(
    name: "connectionNoticesOpen",
    values: readonly [],
  ): Promise<readonly Record<string, unknown>[]>;
}
/** The session viewer's open Reconnect items, newest first. */
export async function readReconnectNotices(
  source: ReconnectNoticeSource,
): Promise<readonly ReconnectNotice[]> {
  return decodeReconnectNotices(await source.run("connectionNoticesOpen", []));
}

/** The store a reinstall linked in place of an ended one, as store_reinstalled answers it. */
export interface ReinstalledStore {
  readonly storeId: string;
  readonly connectionId: string;
}
/**
 * store_reinstalled's rows for the ended store `endedStoreId`, strictly: none, or one new
 * store (never the ended one itself); anything else is ReconnectNoticeInvalid.
 */
export function decodeReinstalledStore(
  rows: readonly Record<string, unknown>[],
  endedStoreId: string,
): ReinstalledStore | null {
  if (!Array.isArray(rows) || rows.length > 1) throw new ReconnectNoticeInvalid();
  if (rows.length === 0) return null;
  const row = rows[0];
  if (
    !row ||
    Object.keys(row).sort().join(",") !== "connection_id,store_id" ||
    !exact(idPattern, row.store_id) ||
    !exact(idPattern, row.connection_id) ||
    row.store_id === endedStoreId
  )
    throw new ReconnectNoticeInvalid();
  return Object.freeze({ storeId: row.store_id, connectionId: row.connection_id });
}

// ---------------------------------------------------------------------------
// The twin of morrow_work.release_shopify_scopes and of the reconcile's decisions
// (tests/connection-health.test.mjs pins both to the SQL text).
/** The Shopify scopes each agent release needs; an unknown release needs every requested one. */
export const agentReleaseShopifyScopes: Readonly<Record<string, readonly string[]>> = Object.freeze(
  { "morrow.listings": Object.freeze(["read_products", "write_products"]) },
);
/** The connection's own required scope: losing it stops every agent of the store. */
export const connectionRequiredScopes: readonly string[] = Object.freeze(["read_products"]);

export interface ReconnectPlanInput {
  /** The scopes the app requests (shopify_apps.scopes). */
  readonly requested: readonly string[];
  /** The scopes the installation records. */
  readonly granted: readonly string[];
  readonly tokenRefused: boolean;
  /** The store's agent installations that are not uninstalled, oldest first. */
  readonly agents: readonly Readonly<{ id: string; releaseId: string }>[];
}
export interface ReconnectPlan {
  readonly cause: ReconnectCause;
  readonly missingScopes: readonly string[];
  /** The agents that need a scope not granted: each gets a system stop unless one stands. */
  readonly stoppedAgentInstallations: readonly string[];
  /** Whether the connection's Reconnect item is open (raised or kept) or cleared. */
  readonly notice: "open" | "clear";
}
/** What the reconcile does for a live connection, from its recorded state. */
export function planReconnect(input: ReconnectPlanInput): ReconnectPlan {
  const granted = input.tokenRefused ? [] : [...input.granted];
  const missing = [...new Set(input.requested.filter((s) => !granted.includes(s)))].sort();
  const stopped = input.agents
    .filter((a) => {
      const needs = [
        ...(agentReleaseShopifyScopes[a.releaseId] ?? input.requested),
        ...connectionRequiredScopes,
      ];
      return !needs.every((s) => granted.includes(s));
    })
    .map((a) => a.id);
  return Object.freeze({
    cause: input.tokenRefused ? "token_refused" : "scopes_missing",
    missingScopes: Object.freeze(missing),
    stoppedAgentInstallations: Object.freeze(stopped),
    notice: missing.length > 0 || stopped.length > 0 ? "open" : "clear",
  });
}

/** A fake for the Inbox screens (PR 15) until their item kind lands: plain data. */
export const reconnectNoticeFixtures: readonly ReconnectNotice[] = Object.freeze([
  Object.freeze({
    noticeId: "6f1c2e0a-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
    kind: "reconnect" as const,
    cause: "scopes_missing" as const,
    storeId: "store_fixture",
    connectionId: "connection_fixture",
    installationId: "storeinst_fixture",
    missingScopes: Object.freeze(["write_products"]),
    stoppedAgentInstallations: Object.freeze(["agentinst_listings_fixture"]),
    revision: 1,
    createdAt: "2026-10-24T09:00:00.000Z",
    updatedAt: "2026-10-24T09:00:00.000Z",
    open: true,
  }),
  Object.freeze({
    noticeId: "7a2d3f1b-4c5e-4f60-9b0c-1d2e3f4a5b6c",
    kind: "reconnect" as const,
    cause: "token_refused" as const,
    storeId: "store_fixture_2",
    connectionId: "connection_fixture_2",
    installationId: "storeinst_fixture_2",
    missingScopes: Object.freeze(["read_products", "write_products"]),
    stoppedAgentInstallations: Object.freeze([]),
    revision: 2,
    createdAt: "2026-10-24T08:00:00.000Z",
    updatedAt: "2026-10-24T08:30:00.000Z",
    open: true,
  }),
]);
