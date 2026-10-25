// v1 PR 5, "Keep the store connection healthy" (ADR-0025 items 9 and 10; ADR-0031 item 3;
// docs/briefs/v1-connection-health.md), without a database: the TypeScript twins pinned to the
// SQL of migrations connection-health-identity and connection-health-work (the scopes each
// agent release needs, the system installation stops' codes and reasons, the Reconnect read's
// columns), the Reconnect plan, the Inbox seam's strict decoder, the broker protocol's
// read-back result and launch states, the broker's AccessScopes read and read-back checker over
// a faked vault and a faked Shopify, the connector's launch of a reinstall and a reconnect, the
// clean-up switch's committed record and var, and the migrations' static rules (FORCE RLS,
// every connector definer clearing its settings, no customer table). The PostgreSQL behaviour
// is lab:connection-health's.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  connectionCleanupOn,
  connectionCleanupVar,
  decodeShopifyConnectionCheck,
  decodeShopifyLaunchVerdict,
  encodeShopifyConnectionCheck,
  encodeShopifyLaunchVerdict,
  shopifyConnectionCheckOutcomes,
  shopifyInstallationStates,
} from "../packages/identity/src/broker-protocol.ts";
import {
  agentReleaseShopifyScopes,
  connectionHealthStatements,
  connectionRequiredScopes,
  decodeReconnectNotices,
  decodeReinstalledStore,
  planReconnect,
  readReconnectNotices,
  reconnectNoticeFixtures,
} from "../packages/work/src/connection-health/notices.ts";
import { workStatements } from "../packages/work/src/sql.ts";
import { stopReasonCodes, systemInstallationStopReasons } from "../packages/work/src/stops.ts";
import {
  readShopifyAccessScopes,
  shopifyAccessScopesDocument,
} from "../apps/broker/src/shopify.ts";
import { createShopifyHealthChecker } from "../apps/broker/src/shopify-health.ts";
import {
  VaultError,
  createVaultKeyring,
  sealVaultRecord,
  vaultBytesHex,
  vaultStatements,
} from "../apps/broker/src/vault.ts";
import { createConnectorHandler } from "../apps/shopify-connector/worker/connector.ts";
import { connectorSql } from "../apps/shopify-connector/worker/database.ts";
import {
  edgeCleanupVarNames,
  edgeVarNames,
  edgeWorkers,
  reviewedCleanupRecord,
  verifyEdgeConfig,
} from "../scripts/edge.mjs";

const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const migration = (slug) => {
  const entry = manifest.migrations.find((m) => m.file.endsWith(slug));
  assert.ok(entry, slug);
  return { entry, text: readFileSync("migrations/" + entry.file, "utf8") };
};
const identity = migration(".connection-health-identity.sql");
const work = migration(".connection-health-work.sql");
// The body of one CREATE [OR REPLACE] FUNCTION, from its header to the next "$$;".
const functionText = (text, name) => {
  const start = text.search(
    new RegExp(`CREATE (OR REPLACE )?FUNCTION ${name.replace(".", "\\.")}\\(`),
  );
  assert.ok(start >= 0, name);
  const end = text.indexOf("$$;", text.indexOf("$$", start) + 2);
  return text.slice(start, end + 3);
};

test("the migrations are registered after 0051 with their owners and this brief", () => {
  assert.equal(identity.entry.sequence + 1, work.entry.sequence);
  assert.ok(identity.entry.sequence >= 52);
  assert.equal(identity.entry.executeAs, "morrow_identity_owner");
  assert.equal(work.entry.executeAs, "morrow_work_owner");
  for (const { entry } of [identity, work])
    assert.equal(entry.reviewRef, "docs/briefs/v1-connection-health.md");
  assert.ok(readFileSync("docs/briefs/v1-connection-health.md", "utf8").length > 1000);
});

test("static: new tables are FORCE RLS, append-only or guarded, and content-free", () => {
  for (const [text, table] of [
    [identity.text, "morrow_identity.store_data_deletions"],
    [work.text, "morrow_work.connection_notices"],
  ]) {
    assert.match(
      text,
      new RegExp(`ALTER TABLE ${table.replace(".", "\\.")} ENABLE ROW LEVEL SECURITY;`),
    );
    assert.match(
      text,
      new RegExp(`ALTER TABLE ${table.replace(".", "\\.")} FORCE ROW LEVEL SECURITY;`),
    );
    assert.match(text, new RegExp(`REVOKE ALL ON ${table.replace(".", "\\.")} FROM PUBLIC;`));
  }
  // The deletion record is guarded by the Shopify record guard; the notice by its own guard and
  // the work schema's append-only triggers.
  assert.match(
    identity.text,
    /CREATE TRIGGER shopify_record_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_identity\.store_data_deletions/,
  );
  assert.match(
    identity.text,
    /CREATE TRIGGER shopify_record_no_truncate BEFORE TRUNCATE ON morrow_identity\.store_data_deletions/,
  );
  assert.match(
    work.text,
    /CREATE TRIGGER append_only BEFORE DELETE ON morrow_work\.connection_notices/,
  );
  assert.match(
    work.text,
    /CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work\.connection_notices/,
  );
  // No customer value: no email, phone, address, name or note column in either migration's
  // new tables (customer data never enters, ADR-0031 item 2).
  for (const text of [identity.text, work.text]) {
    const tables = [...text.matchAll(/CREATE TABLE [^(]+\(([^;]+)\);/g)].map((m) => m[1]);
    assert.ok(tables.length >= 1);
    for (const body of tables)
      assert.doesNotMatch(body, /\b(email|phone|address|first_name|last_name|customer|note)\b/i);
  }
  // The deletion's evidence is shop/redact's closed shape (one handler list for both
  // deletions: a new store-content table extends privacy_evidence_valid once).
  assert.match(
    functionText(identity.text, "morrow_identity.store_deletion_evidence_valid"),
    /morrow_identity\.privacy_evidence_valid\('shop\/redact',jsonb_set\(p_evidence,'\{kind\}','"shop_redacted"'::jsonb\)\)/,
  );
  // The deletion's evidence is content-free and closed; its clock is 365 days, set in code.
  assert.match(identity.text, /CHECK \(expires_at=opened_at\+interval '365 days'\)/);
  assert.match(identity.text, /CHECK \(due_at=uninstalled_at\+interval '48 hours'\)/);
  assert.match(identity.text, /installation_id morrow_identity\.record_id NOT NULL UNIQUE/);
});

test("static: every connector definer clears every connector setting on entry and checks its login", () => {
  const settings = [
    "morrow.connector_stop",
    "morrow.connector_redact",
    "morrow.connector_health",
    "morrow.connector_agent_stop",
    "morrow.connector_sweep",
  ];
  const definers = [
    "connector_inbox_apply_v2",
    "connector_health_reconcile",
    "connector_checks_due",
    "connector_notices_due",
    "connector_deletions_due",
    "connector_deletion_apply",
    "connector_inbox_stuck",
  ];
  for (const name of definers) {
    const body = functionText(work.text, "morrow_work." + name);
    assert.match(body, /SECURITY DEFINER/, name);
    const begin = body.slice(body.indexOf("BEGIN"));
    for (const setting of settings)
      assert.ok(
        begin.indexOf(`set_config('${setting}','',true)`) <
          begin.indexOf("work_executor_safe('morrow_connector_ingress')"),
        name + " " + setting,
      );
    assert.match(body, /work_executor_safe\('morrow_connector_ingress'\)/, name);
    assert.match(
      work.text,
      new RegExp(`ALTER FUNCTION morrow_work\\.${name}\\([a-z,]*\\) OWNER TO morrow_work_command;`),
      name,
    );
  }
  for (const name of [
    "shopify_install_prepare_v2",
    "shopify_check_resolve",
    "shopify_check_record",
  ])
    assert.match(
      functionText(work.text, "morrow_vault." + name),
      /work_executor_safe\('morrow_vault_broker'\)/,
      name,
    );
  // The cron's open-notice list reads under its own setting only while it runs.
  const sweep = functionText(work.text, "morrow_work.connector_notices_due");
  assert.match(
    sweep,
    /set_config\('morrow\.connector_sweep','open',true\)[^]*set_config\('morrow\.connector_sweep','',true\)/,
  );
  // Nothing in the work migration deletes a row itself: the store content goes through
  // 0038's store_content_redact, as shop/redact's does.
  assert.doesNotMatch(work.text, /\bDELETE FROM\b/i);
  assert.doesNotMatch(identity.text, /\bDELETE FROM\b/i);
  assert.match(
    functionText(work.text, "morrow_work.connector_deletion_apply"),
    /morrow_work\.store_content_redact\(/,
  );
});

// PR 5 review finding F1: shop/redact and the 48-hour deletion run one identity redaction,
// which keeps the app's install link while the app has a live (reinstalled) installation.
test("static: one identity redaction for shop/redact and the 48-hour deletion keeps a live reinstall's install link", () => {
  const redact = functionText(identity.text, "morrow_identity.work_shopify_redact_identity");
  assert.match(
    redact,
    /^CREATE OR REPLACE FUNCTION morrow_identity\.work_shopify_redact_identity\(p_org text,p_ws text,p_installation_id text\)\nRETURNS TABLE\(outcome text,installations integer,candidates integer,apps integer\)/,
  );
  // The install link is cleared only when no installation of the app is live.
  assert.match(
    redact,
    /v_live:=EXISTS\(SELECT 1 FROM morrow_identity\.store_installations x WHERE x\.app_key=i\.app_key AND x\.status<>'uninstalled'\);\n IF NOT v_live THEN\n  UPDATE morrow_identity\.shopify_apps a SET install_url=NULL/,
  );
  assert.equal(redact.match(/SET install_url=NULL/g)?.length, 1);
  // 0036's text is pinned, so a missed merge fails the migration's prerequisites.
  assert.match(
    identity.text,
    /to_regprocedure\('morrow_identity\.work_shopify_redact_identity\(text,text,text\)'\)\)\n  IS DISTINCT FROM '07a5f45bf50c3bae986c1de9784d5ba9'/,
  );
  // No second copy that could disagree: the 48-hour deletion calls shop/redact's function.
  assert.doesNotMatch(identity.text + work.text, /work_shopify_deletion_redact_identity/);
  assert.match(
    functionText(work.text, "morrow_work.connector_deletion_apply"),
    /FROM morrow_identity\.work_shopify_redact_identity\(d\.organization_id,d\.workspace_id,p_installation_id\)/,
  );
});

// PR 5 review finding F2: a read-back that began before a narrowing delivery is stale.
test("static: the read-back's record is stale once the installation changed after its resolution", () => {
  const target = functionText(identity.text, "morrow_identity.work_shopify_check_target");
  assert.match(target, /credential_version text,\n revision text\)/);
  assert.match(target, /i\.credential_version::text,\n  i\.revision::text;/);
  const record = functionText(identity.text, "morrow_identity.work_shopify_scopes_record");
  assert.match(record, /p_credential_version text,p_revision text\)/);
  assert.match(record, /\(p_mode='narrow'\)<>\(p_revision IS NULL\)/);
  assert.match(
    record,
    /IF p_mode<>'narrow' AND \(p_credential_version::bigint<>i\.credential_version OR p_revision::bigint<>i\.revision\) THEN\n  RETURN QUERY SELECT 'stale'/,
  );
  // The vault definers carry the revision from the resolution to the record.
  const resolve = functionText(work.text, "morrow_vault.shopify_check_resolve");
  const columns = /RETURNS TABLE\(([^)]*)\)/
    .exec(resolve)[1]
    .split(",")
    .map((c) => c.trim().split(/\s+/)[0]);
  assert.deepEqual(
    columns,
    /^SELECT (.*) FROM morrow_vault\.shopify_check_resolve\(\$1\)$/
      .exec(vaultStatements.shopifyCheckResolve)[1]
      .split(","),
  );
  assert.ok(columns.includes("revision"));
  assert.match(
    functionText(work.text, "morrow_vault.shopify_check_record"),
    /work_shopify_scopes_record\(t\.organization_id,t\.workspace_id,p_installation_id,p_result,p_scopes,\n  p_credential_version,p_revision\)/,
  );
  assert.equal(
    vaultStatements.shopifyCheckRecord,
    "SELECT morrow_vault.shopify_check_record($1,$2,$3,$4,NULLIF($5,'')) AS outcome",
  );
  // A delivery's narrowing names no token version and no revision.
  assert.match(
    functionText(work.text, "morrow_work.connector_inbox_apply_v2"),
    /'narrow',\n  \(v_body->'current'\)::text,NULL,NULL\);/,
  );
});

// PR 5 review finding F3: the cron's reconcile list rotates through every open item.
test("static: the cron's reconcile list takes the least recently reconciled first and never hides an item", () => {
  const due = functionText(work.text, "morrow_work.connector_notices_due");
  assert.match(due, /SELECT n\.installation_id::text AS id,n\.reconciled_at AS at FROM/);
  assert.match(
    due,
    /FROM morrow_identity\.work_shopify_reconnect_due\(\) d\n    WHERE NOT EXISTS\(SELECT 1 FROM morrow_work\.connection_notices n WHERE n\.cleared_at IS NULL AND n\.installation_id::text=d\.installation_id\)\) u/,
  );
  assert.match(due, /ORDER BY min\(u\.at\) NULLS FIRST,u\.id LIMIT 20;/);
  // The identity list is not cut before that filter.
  assert.doesNotMatch(
    functionText(identity.text, "morrow_identity.work_shopify_reconnect_due"),
    /LIMIT/,
  );
  // Every reconcile pass marks reconciled_at, the unchanged pass included.
  const reconcile = functionText(work.text, "morrow_work.connection_health_reconcile");
  assert.equal(reconcile.match(/reconciled_at=greatest\(v_at,x\.reconciled_at\)/g)?.length, 4);
  assert.match(
    reconcile,
    /ELSE\n   UPDATE morrow_work\.connection_notices x SET reconciled_at=greatest\(v_at,x\.reconciled_at\)\n[^\n]*\n   v_notice:='unchanged';/,
  );
  // The guard admits that mark alone, forward only, without a revision.
  const guard = functionText(work.text, "morrow_work.connection_notice_guard");
  assert.match(
    guard,
    /OLD\.cleared_at IS NULL AND NEW\.reconciled_at>=OLD\.reconciled_at\n  AND \(to_jsonb\(NEW\)-'reconciled_at'\)=\(to_jsonb\(OLD\)-'reconciled_at'\) THEN/,
  );
  assert.match(
    work.text,
    /CREATE INDEX connection_notices_open ON morrow_work\.connection_notices \(reconciled_at,id\) WHERE cleared_at IS NULL;/,
  );
});

test("twin: the scopes each agent release needs are release_shopify_scopes's", () => {
  const body = functionText(work.text, "morrow_work.release_shopify_scopes");
  const cases = [...body.matchAll(/WHEN '([a-z.]+)' THEN ARRAY\[([^\]]*)\]::text\[\]/g)].map(
    (m) => [m[1], [...m[2].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])],
  );
  assert.deepEqual(
    Object.fromEntries(cases),
    Object.fromEntries(Object.entries(agentReleaseShopifyScopes).map(([k, v]) => [k, [...v]])),
  );
  // The connection's own required scope: the reconcile adds read_products to every release.
  assert.deepEqual([...connectionRequiredScopes], ["read_products"]);
  assert.match(
    functionText(work.text, "morrow_work.connection_health_reconcile"),
    /COALESCE\(morrow_work\.release_shopify_scopes\(a\.release_id\),v_requested\)\|\|ARRAY\['read_products'\]::text\[\]/,
  );
});

test("twin: the system installation stops' codes and reasons are the reconcile's, and a scope change no longer writes the connection stop", () => {
  const reconcile = functionText(work.text, "morrow_work.connection_health_reconcile");
  assert.equal(stopReasonCodes.scopeMissing, "shopify_scope_missing");
  assert.equal(stopReasonCodes.tokenRefused, "shopify_token_refused");
  assert.deepEqual(Object.keys(systemInstallationStopReasons).sort(), [
    "shopify_scope_missing",
    "shopify_token_refused",
  ]);
  for (const [code, reason] of Object.entries(systemInstallationStopReasons)) {
    assert.ok(reconcile.includes(`'${code}'`), code);
    assert.ok(reconcile.includes(`'${reason.replace(/'/g, "''")}'`), reason);
  }
  // Only those two codes, set by the system, on an installation, never lifted: the policies.
  assert.match(
    work.text,
    /CREATE POLICY connector_health_stop_set ON morrow_work\.stop_controls FOR INSERT TO morrow_work_command\s+WITH CHECK \(session_user='morrow_connector_ingress' AND scope='installation' AND set_by_kind='system' AND lifted_at IS NULL\s+AND kill_switch_record_id IS NULL AND reason_code IN \('shopify_scope_missing','shopify_token_refused'\)/,
  );
  assert.doesNotMatch(
    work.text,
    /FOR UPDATE TO morrow_work_command[^;]*stop_controls|stop_controls FOR UPDATE/,
  );
  // The applier keeps the token on a scope change: v2 never names scopes_changed or a
  // credential destruction for that topic.
  const v2 = functionText(work.text, "morrow_work.connector_inbox_apply_v2");
  assert.doesNotMatch(
    v2,
    /scopes_changed|shopify_credential_destroy|work_shopify_installation_end\(/,
  );
  // 0052's installation end refuses scopes_changed.
  const end = functionText(identity.text, "morrow_identity.work_shopify_installation_end");
  assert.match(end, /p_reason NOT IN \('uninstalled','disconnected'\)/);
});

test("planReconnect: only the agents that need a missing scope stop; a refused token stops every one", () => {
  const requested = ["read_products", "write_products"];
  const agents = [
    { id: "agent_listings", releaseId: "morrow.listings" },
    { id: "agent_future", releaseId: "morrow.unknown" },
  ];
  // Every scope granted: nothing stops, the item clears.
  assert.deepEqual(
    { ...planReconnect({ requested, granted: requested, tokenRefused: false, agents }) },
    { cause: "scopes_missing", missingScopes: [], stoppedAgentInstallations: [], notice: "clear" },
  );
  // write_products lost: Listings (and the unknown release, which needs every requested scope).
  assert.deepEqual(
    {
      ...planReconnect({ requested, granted: ["read_products"], tokenRefused: false, agents }),
    },
    {
      cause: "scopes_missing",
      missingScopes: ["write_products"],
      stoppedAgentInstallations: ["agent_listings", "agent_future"],
      notice: "open",
    },
  );
  // A refused token: every agent, every scope, the token cause.
  const refused = planReconnect({ requested, granted: requested, tokenRefused: true, agents });
  assert.equal(refused.cause, "token_refused");
  assert.deepEqual([...refused.missingScopes], requested);
  assert.deepEqual([...refused.stoppedAgentInstallations], ["agent_listings", "agent_future"]);
  // No agents and a missing scope: the item stays open (the store needs reconnecting).
  assert.equal(
    planReconnect({ requested, granted: [], tokenRefused: false, agents: [] }).notice,
    "open",
  );
  // A release that needs only what is granted keeps running (selectivity, by a twin entry).
  const narrow = planReconnect({
    requested: ["read_products", "write_products", "read_orders"],
    granted: ["read_products", "write_products"],
    tokenRefused: false,
    agents: [{ id: "agent_listings", releaseId: "morrow.listings" }],
  });
  assert.deepEqual([...narrow.stoppedAgentInstallations], []);
  assert.deepEqual([...narrow.missingScopes], ["read_orders"]);
});

const row = (overrides = {}) => ({
  notice_id: "6f1c2e0a-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
  kind: "reconnect",
  cause: "scopes_missing",
  store_id: "store_1",
  connection_id: "connection_1",
  installation_id: "installation_1",
  missing_scopes: "write_products",
  stopped_installations: '["agentinst_1"]',
  revision: "2",
  created_at: "2026-10-24T09:00:00.000Z",
  updated_at: "2026-10-24T09:30:00.000Z",
  still_open: "true",
  ...overrides,
});

test("the Inbox seam: one fixed read, its columns the definer's, a strict decoder and a fixture", async () => {
  // The statement's columns are exactly the definer's RETURNS TABLE.
  const definer = functionText(work.text, "morrow_work.connection_notices_open");
  const returns = /RETURNS TABLE\(([^)]*)\)/.exec(definer)[1];
  const definerColumns = returns.split(",").map((c) => c.trim().split(/\s+/)[0]);
  const statementColumns = /^SELECT (.*) FROM morrow_work\.connection_notices_open\(\)$/
    .exec(connectionHealthStatements.connectionNoticesOpen)[1]
    .split(",");
  assert.deepEqual(statementColumns, definerColumns);
  assert.equal(
    workStatements.connectionNoticesOpen,
    connectionHealthStatements.connectionNoticesOpen,
  );
  // Session only, recipients only: the definer reads the session tenant and its principal.
  assert.match(definer, /FROM morrow_work\.current_tenant\(\) c/);
  assert.match(definer, /n\.recipients \? t\.principal_id/);
  assert.match(
    work.text,
    /GRANT EXECUTE ON FUNCTION morrow_work\.connection_notices_open\(\),morrow_work\.store_reinstalled\(text\) TO morrow_work_api;/,
  );
  const [notice] = decodeReconnectNotices([row()]);
  assert.deepEqual(
    {
      ...notice,
      missingScopes: [...notice.missingScopes],
      stoppedAgentInstallations: [...notice.stoppedAgentInstallations],
    },
    {
      noticeId: "6f1c2e0a-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
      kind: "reconnect",
      cause: "scopes_missing",
      storeId: "store_1",
      connectionId: "connection_1",
      installationId: "installation_1",
      missingScopes: ["write_products"],
      stoppedAgentInstallations: ["agentinst_1"],
      revision: 2,
      createdAt: "2026-10-24T09:00:00.000Z",
      updatedAt: "2026-10-24T09:30:00.000Z",
      open: true,
    },
  );
  assert.deepEqual(
    [
      ...decodeReconnectNotices([
        row({ missing_scopes: "", cause: "token_refused", still_open: "false" }),
      ])[0].missingScopes,
    ],
    [],
  );
  for (const bad of [
    row({ kind: "exception" }),
    row({ cause: "other" }),
    row({ still_open: true }),
    row({ stopped_installations: "not json" }),
    row({ stopped_installations: '["bad id"]' }),
    row({ missing_scopes: "Write-Products" }),
    row({ missing_scopes: Array(9).fill("read_x").join(",") }),
    row({ revision: "0" }),
    row({ created_at: "2026-10-24" }),
    { ...row(), extra: 1 },
    (() => {
      const r = row();
      delete r.cause;
      return r;
    })(),
  ])
    assert.throws(() => decodeReconnectNotices([bad]), /RECONNECT_NOTICE_INVALID/);
  assert.throws(() => decodeReconnectNotices(Array(21).fill(row())), /RECONNECT_NOTICE_INVALID/);
  // The port: exactly the one statement name, no values.
  const calls = [];
  const read = await readReconnectNotices({
    async run(name, values) {
      calls.push([name, values]);
      return [row()];
    },
  });
  assert.equal(read.length, 1);
  assert.deepEqual(calls, [["connectionNoticesOpen", []]]);
  // The fixtures decode as the definer would answer.
  assert.ok(reconnectNoticeFixtures.length >= 2);
  for (const f of reconnectNoticeFixtures) assert.equal(f.kind, "reconnect");
});

test("the Inbox's reinstall read (review F3 after the merge): session only, the same app and shop, linked", () => {
  // The api's definer: the session tenant only, through the identity bridge; its statement's
  // columns are the definer's.
  const definer = functionText(work.text, "morrow_work.store_reinstalled");
  const returns = /RETURNS TABLE\(([^)]*)\)/.exec(definer)[1];
  assert.deepEqual(
    returns.split(",").map((c) => c.trim().split(/\s+/)[0]),
    /^SELECT (.*) FROM morrow_work\.store_reinstalled\(\$1\)$/
      .exec(connectionHealthStatements.storeReinstalled)[1]
      .split(","),
  );
  assert.equal(workStatements.storeReinstalled, connectionHealthStatements.storeReinstalled);
  assert.match(definer, /SECURITY DEFINER/);
  assert.match(definer, /FROM morrow_work\.current_tenant\(\) c/);
  assert.match(
    definer,
    /morrow_identity\.work_shopify_store_successor\(t\.organization_id,t\.workspace_id,p_store_id\)/,
  );
  assert.match(
    work.text,
    /ALTER FUNCTION morrow_work\.store_reinstalled\(text\) OWNER TO morrow_work_command;/,
  );
  assert.match(
    work.text,
    /has_function_privilege\('morrow_work_command','morrow_identity\.work_shopify_store_successor\(text,text,text\)','EXECUTE'\)/,
  );
  // The identity bridge: EXECUTE for the command role only; an uninstalled installation of the
  // tenant's store, and a later installation of the same app and shop in the same tenant that
  // is linked through its own link row.
  const bridge = functionText(identity.text, "morrow_identity.work_shopify_store_successor");
  for (const rule of [
    /n\.organization_id=o\.organization_id AND n\.workspace_id=o\.workspace_id/,
    /n\.app_key=o\.app_key AND n\.shop_id=o\.shop_id AND n\.id<>o\.id AND n\.created_at>o\.created_at/,
    /JOIN morrow_identity\.workspace_store_links l ON l\.id=n\.link_id AND l\.installation_id=n\.id/,
    /o\.organization_id=p_org AND o\.workspace_id=p_ws AND o\.store_id=p_store_id AND o\.status='uninstalled'/,
    /n\.status='linked' AND n\.linked_at<=pg_catalog\.clock_timestamp\(\)/,
    /LIMIT 1/,
  ])
    assert.match(bridge, rule);
  assert.match(
    identity.text,
    /morrow_identity\.work_shopify_store_successor\(text,text,text\) TO morrow_work_command;/,
  );
  // The strict decoder: none, or one other store.
  assert.equal(decodeReinstalledStore([], "store_old"), null);
  assert.deepEqual(
    decodeReinstalledStore(
      [{ store_id: "store_new", connection_id: "connection_new" }],
      "store_old",
    ),
    { storeId: "store_new", connectionId: "connection_new" },
  );
  for (const bad of [
    [{ store_id: "store_old", connection_id: "connection_new" }],
    [{ store_id: "store_new" }],
    [{ store_id: "store_new", connection_id: "connection_new", extra: "x" }],
    [{ store_id: "store new", connection_id: "connection_new" }],
    [
      { store_id: "store_new", connection_id: "connection_new" },
      { store_id: "store_new2", connection_id: "connection_new2" },
    ],
  ])
    assert.throws(() => decodeReinstalledStore(bad, "store_old"), /RECONNECT_NOTICE_INVALID/);
});

test("protocol: the read-back's closed result and the launch's reconnect state", () => {
  assert.deepEqual(
    [...shopifyConnectionCheckOutcomes],
    ["observed", "token_refused", "stale", "not_applicable", "unavailable"],
  );
  for (const outcome of shopifyConnectionCheckOutcomes)
    assert.equal(decodeShopifyConnectionCheck(encodeShopifyConnectionCheck(outcome)), outcome);
  for (const bad of [
    '{"schemaVersion":1,"outcome":"applied"}',
    '{"schemaVersion":2,"outcome":"observed"}',
    '{"schemaVersion":1,"outcome":"observed","scopes":[]}',
    "observed",
    null,
  ])
    assert.throws(() => decodeShopifyConnectionCheck(bad));
  assert.throws(() => encodeShopifyConnectionCheck("applied"));
  assert.deepEqual(
    [...shopifyInstallationStates],
    ["none", "unlinked", "linked", "suspended", "uninstalled", "reconnect"],
  );
  const verdict = {
    verdict: "verified",
    shop: "dev-1.myshopify.com",
    installation: "reconnect",
    workspaceId: "ws_1",
  };
  assert.deepEqual(decodeShopifyLaunchVerdict(encodeShopifyLaunchVerdict(verdict)), verdict);
  assert.equal(connectionCleanupVar, "MORROW_CONNECTION_CLEANUP");
  assert.equal(connectionCleanupOn, "on");
  // The connector's statements name the new definers exactly.
  assert.equal(
    connectorSql.inboxApply,
    "SELECT outcome,topic,installation_id,credential,reason FROM morrow_work.connector_inbox_apply_v2($1)",
  );
  assert.equal(
    vaultStatements.shopifyInstallPrepare,
    "SELECT outcome,organization_id,workspace_id,installation_id,store_id,connection_id,credential_id,credential_version FROM morrow_vault.shopify_install_prepare_v2($1,$2,$3,$4)",
  );
});

// A faked Shopify for one shop: AccessScopes' answer by `reply`.
const shopifyFake = (reply) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), token: init.headers["x-shopify-access-token"] });
    const r = typeof reply === "function" ? reply() : reply;
    if (r instanceof Error) throw r;
    if (typeof r === "number") return new Response(null, { status: r });
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch };
};
const scopesReply = (handles) => ({
  data: { currentAppInstallation: { accessScopes: handles.map((handle) => ({ handle })) } },
});

test("readShopifyAccessScopes: one fixed document; sorted unique handles, a 401 refused, anything else unavailable", async () => {
  const shop = "dev-1.myshopify.com";
  const read = (reply) => {
    const s = shopifyFake(reply);
    return readShopifyAccessScopes(s.fetch, shop, "shpat_x", Date.now() + 5000).then((r) => ({
      r,
      calls: s.calls,
    }));
  };
  const ok = await read(scopesReply(["write_products", "read_products", "write_products"]));
  assert.deepEqual(ok.r, { kind: "scopes", scopes: ["read_products", "write_products"] });
  assert.deepEqual(ok.calls[0].body, { query: shopifyAccessScopesDocument });
  assert.equal(ok.calls[0].url, `https://${shop}/admin/api/2026-10/graphql.json`);
  assert.deepEqual((await read(scopesReply([]))).r, { kind: "scopes", scopes: [] });
  assert.deepEqual((await read(401)).r, { kind: "refused" });
  for (const reply of [
    403,
    500,
    new Error("network"),
    { errors: [{ message: "denied" }] },
    { data: { currentAppInstallation: null } },
    { data: { currentAppInstallation: { accessScopes: [{ handle: 1 }] } } },
    { data: { currentAppInstallation: { accessScopes: [{ handle: "Write Products" }] } } },
    scopesReply(
      Array.from({ length: 65 }, (_, i) => "read_x" + "abcdefghijklmnopqrstuvwxyz"[i % 26]),
    ),
  ])
    assert.deepEqual((await read(reply)).r, { kind: "unavailable" }, JSON.stringify(reply));
});

// The read-back over a faked vault login: the resolution and the record by statement.
const kek = randomBytes(32).toString("hex");
const binding = {
  schemaVersion: 1,
  environment: "development",
  projectId: "morrow-health-unit",
  branchId: "br-health-unit",
  hostname: "ep-health-unit.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const brokerEnv = () => ({
  MORROW_ENVIRONMENT: "development",
  MORROW_DATABASE_BINDING_JSON: JSON.stringify(binding),
  MORROW_DB_PASSWORD_MORROW_VAULT_BROKER: "vault-" + randomBytes(12).toString("hex"),
  MORROW_VAULT_KEK_V1: kek,
});
const installationId = "8f1c2e0a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
async function checkerHarness({
  resolve = "resolved",
  record = "applied",
  reply,
  lost,
  revision = "7",
} = {}) {
  const keyring = await createVaultKeyring("development", new Map([[1, kek]]));
  const token = "shpat_" + randomBytes(16).toString("hex");
  const sealed = await sealVaultRecord(
    keyring,
    {
      kind: "shopify_offline_token",
      organizationId: "org_1",
      workspaceId: "ws_1",
      credentialId: "cred_1",
      subjectId: installationId,
      provider: "shopify",
      version: 3,
    },
    new TextEncoder().encode(token),
  );
  const statements = [];
  const transaction = async (_vault, budgetMs, body) => {
    assert.ok(budgetMs >= 1 && budgetMs <= 3000);
    return body(async (text, values) => {
      statements.push([text, values]);
      if (lost === text) throw new VaultError("VAULT_OUTCOME_UNKNOWN");
      if (text === vaultStatements.shopifyCheckResolve)
        return [
          resolve === "resolved"
            ? {
                outcome: "resolved",
                organization_id: "org_1",
                workspace_id: "ws_1",
                shop_domain: "dev-1.myshopify.com",
                credential_id: "cred_1",
                credential_version: "3",
                revision,
                kek_version: "1",
                wrapped_key: vaultBytesHex(sealed.wrappedKey),
                sealed_value: vaultBytesHex(sealed.sealedValue),
              }
            : {
                outcome: resolve,
                organization_id: null,
                workspace_id: null,
                shop_domain: null,
                credential_id: null,
                credential_version: null,
                revision: null,
                kek_version: null,
                wrapped_key: null,
                sealed_value: null,
              },
        ];
      if (text === vaultStatements.shopifyCheckRecord) return [{ outcome: record }];
      throw Error("unexpected statement");
    });
  };
  const shopify = shopifyFake(reply ?? scopesReply(["read_products", "write_products"]));
  const checker = createShopifyHealthChecker({ transaction, fetch: shopify.fetch, now: Date.now });
  return { checker, statements, shopify, token };
}

test("the broker's read-back: closed inputs, the token for one fixed document, the record for the version read", async () => {
  const env = brokerEnv();
  const ok = await checkerHarness();
  assert.equal(
    decodeShopifyConnectionCheck(await ok.checker.check(env, installationId, 8000)),
    "observed",
  );
  assert.deepEqual(
    ok.statements.map(([text, values]) => [
      text === vaultStatements.shopifyCheckResolve ? "resolve" : "record",
      values,
    ]),
    [
      ["resolve", [installationId]],
      // The record names the token version and the installation's revision that the
      // resolution read (PR 5 review finding F2: a narrowing in between makes it stale).
      ["record", [installationId, "3", "7", "observed", '["read_products","write_products"]']],
    ],
  );
  assert.equal(ok.shopify.calls.length, 1);
  assert.equal(ok.shopify.calls[0].token, ok.token);
  // A 401 records the refusal (no scopes).
  const refused = await checkerHarness({ reply: 401 });
  assert.equal(
    decodeShopifyConnectionCheck(await refused.checker.check(env, installationId, 8000)),
    "token_refused",
  );
  assert.deepEqual(refused.statements.at(-1)[1], [installationId, "3", "7", "refused", ""]);
  // A resolution without a well-formed revision is refused before Shopify is asked.
  for (const revision of [null, "0", "07", "x"]) {
    const bad = await checkerHarness({ revision });
    await assert.rejects(bad.checker.check(env, installationId, 8000), /VAULT_RECORD_INVALID/);
    assert.equal(bad.shopify.calls.length, 0, String(revision));
  }
  // An unclear answer records nothing.
  const unclear = await checkerHarness({ reply: 500 });
  assert.equal(
    decodeShopifyConnectionCheck(await unclear.checker.check(env, installationId, 8000)),
    "unavailable",
  );
  assert.equal(unclear.statements.length, 1);
  // Not live, or no active token: nothing sent.
  for (const outcome of ["ineligible", "credential_unavailable", "not_found"]) {
    const h = await checkerHarness({ resolve: outcome });
    assert.equal(
      decodeShopifyConnectionCheck(await h.checker.check(env, installationId, 8000)),
      "not_applicable",
    );
    assert.equal(h.shopify.calls.length, 0);
  }
  // Another token since (a re-authorisation meanwhile): stale; the installation ended: n/a.
  const stale = await checkerHarness({ record: "stale" });
  assert.equal(
    decodeShopifyConnectionCheck(await stale.checker.check(env, installationId, 8000)),
    "stale",
  );
  const ended = await checkerHarness({ record: "ineligible" });
  assert.equal(
    decodeShopifyConnectionCheck(await ended.checker.check(env, installationId, 8000)),
    "not_applicable",
  );
  // A lost COMMIT acknowledgement is unavailable, never assumed recorded.
  const lost = await checkerHarness({ lost: vaultStatements.shopifyCheckRecord });
  assert.equal(
    decodeShopifyConnectionCheck(await lost.checker.check(env, installationId, 8000)),
    "unavailable",
  );
  // Closed inputs: nothing reaches the vault.
  const closed = await checkerHarness();
  for (const [id, budget] of [
    ["bad id!", 8000],
    [installationId, 0],
    [installationId, 1.5],
    [installationId, 10 ** 9],
    [installationId, "8000"],
  ])
    await assert.rejects(closed.checker.check(env, id, budget));
  assert.equal(closed.statements.length, 0);
  // The token never appears in a result.
  assert.ok(!JSON.stringify(ok.statements).includes(ok.token));
});

test("the connector's launch: an uninstalled app reinstalls, a reconnect re-authorises, a disconnect stays ineligible", async () => {
  const launches = [];
  const handlerFor = (installation) =>
    createConnectorHandler({
      configuration: {
        origin: "https://connector.morrow.test",
        apiOrigin: "https://api.morrow.test",
      },
      broker: {
        async shopifyLaunchVerify() {
          launches.push(installation);
          return encodeShopifyLaunchVerdict({
            verdict: "verified",
            shop: "dev-1.myshopify.com",
            installation,
            workspaceId: "ws_1",
          });
        },
      },
      database: {
        async stateOpen() {
          return {
            outcome: "opened",
            clientId: "c".repeat(32),
            scopes: "read_products,write_products",
          };
        },
      },
    });
  for (const [installation, status] of [
    ["uninstalled", 302],
    ["reconnect", 302],
    ["none", 302],
    ["suspended", 409],
  ]) {
    const r = await handlerFor(installation).fetch(
      new Request(
        "https://connector.morrow.test/shopify/a/dev-app/launch?shop=dev-1.myshopify.com&hmac=x",
      ),
    );
    assert.equal(r.status, status, installation);
    if (status === 302)
      assert.equal(
        new URL(r.headers.get("location")).searchParams.get("scope"),
        "read_products,write_products",
      );
  }
  assert.equal(launches.length, 4);
});

test("the connector's Reconnect page promises no self-service resume (review F4 after the merge)", async () => {
  // Morrow's resume lifts only a person's own "Stop AI work" (agents/commands.ts; 0031 lifts
  // set_by_kind human only), so an agent a system scope stop holds cannot be restarted in the
  // product yet: the page that a status launch of a connection needing reconnecting shows
  // says so, and points to support instead of "resume them in Morrow".
  const handler = createConnectorHandler({
    configuration: {
      origin: "https://connector.morrow.test",
      apiOrigin: "https://api.morrow.test",
    },
    broker: {
      async shopifyLaunchVerify() {
        return encodeShopifyLaunchVerdict({
          verdict: "verified",
          shop: "dev-1.myshopify.com",
          installation: "reconnect",
          workspaceId: "ws_1",
        });
      },
    },
    database: {},
  });
  const page = await handler.fetch(
    new Request(
      "https://connector.morrow.test/shopify/a/dev-app/status?shop=dev-1.myshopify.com&hmac=x",
    ),
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<h1>Reconnect<\/h1>/);
  assert.match(html, /Open the app again from your Shopify admin to reconnect it/);
  assert.match(html, /stay paused after you reconnect/);
  assert.match(html, /contact Morrow support/);
  assert.doesNotMatch(html, /resume them in Morrow|until you resume/);
  assert.ok(html.includes('href="https://api.morrow.test/w/ws_1/connections"'));
});

test("the clean-up switch: committed off, the connector's var only on staging", () => {
  const record = JSON.parse(readFileSync("docs/decisions/connection-cleanup-staging.json", "utf8"));
  assert.deepEqual(reviewedCleanupRecord(record), { switch: "off" });
  for (const bad of [
    { ...record, switch: "maybe" },
    { ...record, environment_kind: "production" },
    { ...record, extra: true },
    { ...record, schema_version: 2 },
    null,
    [],
  ])
    assert.throws(() => reviewedCleanupRecord(bad), /EDGE_STAGING_CLEANUP_RECORD/);
  assert.deepEqual(edgeCleanupVarNames("connector", "staging"), ["MORROW_CONNECTION_CLEANUP"]);
  for (const [worker, environment] of [
    ["connector", "development"],
    ["connector", "production"],
    ["api", "staging"],
    ["broker", "staging"],
    ["orchestrator", "staging"],
  ])
    assert.deepEqual(edgeCleanupVarNames(worker, environment), [], worker + " " + environment);
  // The clean-up switch is edgeVarNames' seventh argument (after v1 PR 3's apply switch).
  assert.ok(
    edgeVarNames("connector", "staging", "off", "off", "off", "off", "on").includes(
      "MORROW_CONNECTION_CLEANUP",
    ),
  );
  assert.ok(
    !edgeVarNames("connector", "staging", "off", "off", "off", "off", "off").includes(
      "MORROW_CONNECTION_CLEANUP",
    ),
  );
  assert.ok(
    !edgeVarNames("api", "staging", "off", "off", "off", "on", "on").includes(
      "MORROW_CONNECTION_CLEANUP",
    ),
  );
  // No wrangler configuration carries the var while the record is off.
  for (const worker of ["api", "broker", "workers", "shopify-connector"])
    assert.ok(
      !readFileSync(`apps/${worker}/wrangler.jsonc`, "utf8").includes("MORROW_CONNECTION_CLEANUP"),
      worker,
    );
});

test("edge:check: the clean-up record and the staging connector's var agree, or it is a mixed state", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "morrow-cleanup-switch-")));
  try {
    const committed = JSON.parse(
      readFileSync("docs/decisions/connection-cleanup-staging.json", "utf8"),
    );
    // The committed configs are JSONC: whole-line comments and trailing commas only.
    const parseConfig = (text) =>
      JSON.parse(
        text
          .split("\n")
          .filter((line) => !line.trim().startsWith("//"))
          .join("\n")
          .replace(/,(\s*[}\]])/g, "$1"),
      );
    let copies = 0;
    const check = async (mutate, value) => {
      const root = join(scratch, "tree-" + ++copies);
      for (const worker of edgeWorkers) {
        mkdirSync(join(root, worker.dir), { recursive: true });
        const config = parseConfig(readFileSync(join(worker.dir, "wrangler.jsonc"), "utf8"));
        mutate[worker.key]?.(config);
        writeFileSync(join(root, worker.dir, "wrangler.jsonc"), JSON.stringify(config, null, 2));
      }
      const cleanupPath = join(scratch, "cleanup-" + copies + ".json");
      writeFileSync(cleanupPath, JSON.stringify({ ...committed, switch: value }));
      const verdict = await verifyEdgeConfig({ root, cleanupPath });
      return {
        codes: [...new Set(verdict.problems.map((problem) => problem.split(":")[0]))].sort(),
        cleanupSwitch: verdict.cleanupSwitch,
      };
    };
    const set =
      (value, where = (c) => c.env.staging.vars) =>
      (c) =>
        (where(c).MORROW_CONNECTION_CLEANUP = value);
    // Off, as committed: clean, and no Worker may carry the var.
    assert.deepEqual(await check({}, "off"), { codes: [], cleanupSwitch: "off" });
    assert.deepEqual((await check({ connector: set("on") }, "off")).codes, ["EDGE_VARS"]);
    // On: exactly the staging connector carries exactly "on".
    assert.deepEqual(await check({ connector: set("on") }, "on"), {
      codes: [],
      cleanupSwitch: "on",
    });
    assert.deepEqual((await check({}, "on")).codes, ["EDGE_VARS"]);
    assert.deepEqual((await check({ connector: set("yes") }, "on")).codes, ["EDGE_VARS"]);
    // Anywhere else is a mixed state (wrangler may add its own diagnostic for a var that a
    // named environment does not repeat).
    for (const [index, mutate] of [
      { connector: (c) => (set("on")(c), set("on", (x) => x.vars)(c)) },
      { connector: (c) => (set("on")(c), set("on", (x) => x.env.production.vars)(c)) },
      { connector: set("on"), broker: set("on") },
      { connector: set("on"), api: set("on") },
      { connector: set("on"), orchestrator: set("on") },
    ].entries()) {
      const { codes } = await check(mutate, "on");
      assert.ok(codes.includes("EDGE_VARS"), index + ": " + codes.join(","));
      assert.ok(
        codes.every((code) => code === "EDGE_VARS" || code === "EDGE_CONFIG_DIAGNOSTIC"),
        index + ": " + codes.join(","),
      );
    }
    // An unreadable or invalid record is a problem and counts as off.
    const invalid = await check({}, "maybe");
    assert.deepEqual(invalid, { codes: ["EDGE_STAGING_CLEANUP_RECORD"], cleanupSwitch: "off" });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
