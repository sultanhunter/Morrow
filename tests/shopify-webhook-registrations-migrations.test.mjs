// The shop-specific webhook subscriptions' migrations (shopify-webhook-registrations-identity
// and -vault, located by slug): the runner contract and fixed prerequisite codes; the
// registrations table's FORCE RLS, its guard and its content-free columns; the identity
// bridges executable by the work command only and the vault definers by the broker's login
// only, each guarded first; and the constants SQL shares with TypeScript (the statuses, the
// batch, the id shapes and the vault statements). lab:shopify-install (H cases),
// lab:shopify-connect-workers (H1-H2) and the tenant-conformance probes run them in
// PostgreSQL 17.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { migrationSqlViolations } from "../scripts/migration-sql.mjs";
import {
  shopifyWebhookRegistrationStatuses,
  shopifyWebhookSyncLimits,
} from "../packages/identity/src/broker-protocol.ts";
import { shopifyVaultStatements } from "../apps/broker/src/vault-statements-shopify.ts";

const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const slugs = ["shopify-webhook-registrations-identity", "shopify-webhook-registrations-vault"];
const rowOf = (slug) => manifest.migrations.find((m) => m.file.endsWith("." + slug + ".sql"));
const [identity, vault] = slugs.map((slug) =>
  readFileSync("migrations/" + rowOf(slug).file, "utf8"),
);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const code = (text) => text.replace(/--[^\n]*/g, "");
const body = (text, signature) => {
  const start = text.indexOf("CREATE FUNCTION " + signature);
  assert.ok(start >= 0, signature);
  const end = text.indexOf("\n$$;", start);
  return text.slice(
    start,
    end >= 0 && end < text.indexOf("END $$;", start) ? end : text.indexOf("END $$;", start),
  );
};

test("manifest: two contiguous rows, the identity owner then the work owner, digests", () => {
  const rows = slugs.map(rowOf);
  assert.equal(rows[1].sequence, rows[0].sequence + 1);
  assert.deepEqual(
    rows.map((r) => [r.executeAs, r.reviewRef, r.prerequisites]),
    [
      ["morrow_identity_owner", "docs/briefs/shopify-shop-specific-webhooks.md", undefined],
      ["morrow_work_owner", "docs/briefs/shopify-shop-specific-webhooks.md", undefined],
    ],
  );
  for (const row of rows) assert.equal(row.sha256, sha(readFileSync("migrations/" + row.file)));
  // Forward only: they follow every applied migration.
  assert.equal(rows[0].sequence, manifest.migrations.at(-2).sequence);
});

test("the runner contract: one transaction, no role switch, fixed codes, every function revoked from PUBLIC", () => {
  for (const [slug, text] of [
    [slugs[0], identity],
    [slugs[1], vault],
  ]) {
    assert.deepEqual(migrationSqlViolations(text), [], slug);
    assert.match(text, /^BEGIN;\n/, slug);
    assert.match(text, /\nCOMMIT;\n$/, slug);
    assert.match(
      text,
      /RAISE EXCEPTION 'SHOPIFY_WEBHOOK_REGISTRATIONS_[A-Z]+_PREREQUISITES_INVALID'/,
    );
    assert.doesNotMatch(
      code(text),
      /CREATE ROLE|ALTER ROLE|GRANT morrow_[a-z_]+ TO|BYPASSRLS|DISABLE ROW LEVEL|SET ROLE/,
      slug,
    );
    for (const [, schema, name] of text.matchAll(/CREATE FUNCTION ([a-z_]+)\.([a-z_]+)\(/g))
      assert.match(text, new RegExp(`REVOKE ALL ON FUNCTION[^;]*${schema}\\.${name}\\(`), name);
    // Every SECURITY DEFINER pins its search path.
    for (const [definer] of code(text).matchAll(
      /CREATE FUNCTION[^$]*SECURITY DEFINER[^$]*AS \$\$/g,
    ))
      assert.match(definer, /SET search_path=pg_catalog,morrow_(identity|vault),pg_temp/, definer);
  }
});

test("the table: FORCE RLS with the identity owner's policy only, a guard, ids and codes only", () => {
  const table = identity.slice(
    identity.indexOf("CREATE TABLE morrow_identity.shopify_webhook_registrations"),
    identity.indexOf("ALTER TABLE morrow_identity.shopify_webhook_registrations ENABLE"),
  );
  const columns = [...table.matchAll(/^ ([a-z_]+) [a-z]/gm)].map((m) => m[1]);
  assert.deepEqual(columns, [
    "organization_id",
    "workspace_id",
    "installation_id",
    "credential_version",
    "status",
    "uninstalled_subscription_id",
    "scopes_update_subscription_id",
    "attempts",
    "revision",
    "created_at",
    "updated_at",
  ]);
  // No shop, URL, token or provider text is kept.
  assert.doesNotMatch(columns.join(","), /shop|domain|uri|url|token|secret|message/i);
  // The tenant is the installation's own (composite foreign key).
  assert.match(
    table,
    /FOREIGN KEY \(organization_id,workspace_id,installation_id\)\n  REFERENCES morrow_identity\.store_installations\(organization_id,workspace_id,id\)/,
  );
  assert.match(
    identity,
    /ALTER TABLE morrow_identity\.shopify_webhook_registrations ENABLE ROW LEVEL SECURITY;/,
  );
  assert.match(
    identity,
    /ALTER TABLE morrow_identity\.shopify_webhook_registrations FORCE ROW LEVEL SECURITY;/,
  );
  assert.deepEqual(
    [
      ...identity.matchAll(
        /CREATE POLICY ([a-z_]+) ON morrow_identity\.shopify_webhook_registrations ([^;]*);/g,
      ),
    ].map((m) => [m[1], m[2]]),
    [["identity_owner", "TO morrow_identity_owner USING(true) WITH CHECK(true)"]],
  );
  assert.match(
    identity,
    /REVOKE ALL ON morrow_identity\.shopify_webhook_registrations FROM PUBLIC;/,
  );
  assert.doesNotMatch(
    code(identity),
    /GRANT [A-Z, ]+ ON morrow_identity\.shopify_webhook_registrations/,
  );
  // The guard: on insert, update and delete, and on truncate; no delete is ever admitted.
  assert.match(
    identity,
    /CREATE TRIGGER shopify_webhook_registration_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_identity\.shopify_webhook_registrations/,
  );
  assert.match(
    identity,
    /CREATE TRIGGER shopify_webhook_registration_no_truncate BEFORE TRUNCATE ON morrow_identity\.shopify_webhook_registrations/,
  );
  const guard = body(identity, "morrow_identity.shopify_webhook_registration_guard(");
  assert.doesNotMatch(guard, /TG_OP='DELETE'/);
  assert.match(guard, /NEW\.credential_version>=OLD\.credential_version/);
});

test("authority: bridges for the work command only, vault definers for the broker's login only, guarded first", () => {
  const bridges = [
    "morrow_identity.work_shopify_webhook_target(text)",
    "morrow_identity.work_shopify_webhook_registration_record(text,text,text,text,text)",
    "morrow_identity.work_shopify_webhook_registrations_pending()",
  ];
  const grants = [...code(identity).matchAll(/GRANT EXECUTE ON FUNCTION ([^;]*) TO ([a-z_, ]+);/g)];
  assert.equal(grants.length, 1);
  assert.equal(grants[0][2], "morrow_work_command");
  for (const bridge of bridges)
    assert.ok(grants[0][1].replace(/\s+/g, " ").includes(bridge), bridge);
  assert.doesNotMatch(grants[0][1], /guard/);
  const definers = [
    "morrow_vault.shopify_webhook_registrations_pending()",
    "morrow_vault.shopify_webhook_target(text)",
    "morrow_vault.shopify_webhook_registration_record(text,text,text,text,text)",
  ];
  const vaultGrants = [
    ...code(vault).matchAll(/GRANT EXECUTE ON FUNCTION ([^;]*) TO ([a-z_, ]+);/g),
  ];
  assert.equal(vaultGrants.length, 1);
  assert.equal(vaultGrants[0][2], "morrow_vault_broker");
  for (const definer of definers) {
    assert.ok(vaultGrants[0][1].replace(/\s+/g, " ").includes(definer), definer);
    assert.match(
      vault,
      new RegExp(
        `ALTER FUNCTION ${definer.replace(/[().]/g, "\\$&")} OWNER TO morrow_work_command;`,
      ),
    );
    // The broker login's guard is the first statement of each definer.
    const b = body(vault, definer.slice(0, definer.indexOf("(") + 1));
    assert.match(
      b.slice(b.indexOf("BEGIN\n")),
      /^BEGIN\n IF NOT morrow_identity\.work_executor_safe\('morrow_vault_broker'\) THEN/,
      definer,
    );
  }
  // The schema's CREATE is given and taken back around the ownership transfer.
  assert.match(
    vault,
    /GRANT CREATE ON SCHEMA morrow_vault TO morrow_work_command;[\s\S]*REVOKE CREATE ON SCHEMA morrow_vault FROM morrow_work_command;\nCOMMIT;/,
  );
  // The tenant always comes from the installation row, never from a caller: no bridge or
  // definer takes an organization or workspace.
  for (const text of [identity, vault])
    for (const [, params] of code(text).matchAll(/CREATE FUNCTION [a-z_.]+\(([^)]*)\)/g))
      assert.doesNotMatch(params, /p_org|p_ws|p_organization|p_workspace/, params);
});

test("the pending list: new or changed versions, retries past their backoff, then 24-hour re-checks of registered rows", () => {
  const pending = code(
    identity.slice(
      identity.indexOf(
        "CREATE FUNCTION morrow_identity.work_shopify_webhook_registrations_pending()",
      ),
      identity.indexOf(
        "REVOKE ALL ON FUNCTION morrow_identity.shopify_webhook_registration_guard()",
      ),
    ),
  );
  // Due: no row or an older version at once; any other outcome after its backoff; a
  // registered row again 24 hours after its last record (Shopify removes a shop-specific
  // subscription whose deliveries keep failing, and only a new create brings it back).
  assert.match(
    pending,
    /AND \(w\.installation_id IS NULL OR w\.credential_version<>i\.credential_version\n {4}OR \(w\.status<>'registered'\n {5}AND w\.updated_at<=pg_catalog\.clock_timestamp\(\)-least\(interval '4 minutes'\*w\.attempts,interval '6 hours'\)\)\n {4}OR \(w\.status='registered' AND w\.updated_at<=pg_catalog\.clock_timestamp\(\)-interval '24 hours'\)\)\n/,
  );
  // Re-checks come last, after new or changed versions and retries; oldest first in each.
  assert.match(
    pending,
    /ORDER BY CASE WHEN w\.installation_id IS NULL OR w\.credential_version<>i\.credential_version THEN 0\n {3}WHEN w\.status<>'registered' THEN 1 ELSE 2 END,COALESCE\(w\.updated_at,i\.updated_at\),i\.id\n/,
  );
  // The record of a re-check moves the row's time, so the next re-check is 24 hours later.
  const record = body(identity, "morrow_identity.work_shopify_webhook_registration_record(");
  assert.match(record, /revision=x\.revision\+1,updated_at=greatest\(v_at,x\.updated_at\)/);
});

test("constants SQL shares with TypeScript", () => {
  const record = body(identity, "morrow_identity.work_shopify_webhook_registration_record(");
  const statuses = /p_status NOT IN \(([^)]*)\)/.exec(record)[1];
  assert.deepEqual(
    [...statuses.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    [...shopifyWebhookRegistrationStatuses],
  );
  assert.match(
    identity,
    new RegExp(
      `status IN \\(${shopifyWebhookRegistrationStatuses.map((s) => `'${s}'`).join(",")}\\)`,
    ),
  );
  const pending = identity.slice(
    identity.indexOf(
      "CREATE FUNCTION morrow_identity.work_shopify_webhook_registrations_pending()",
    ),
  );
  assert.match(pending, new RegExp(`LIMIT ${shopifyWebhookSyncLimits.batch}\\n`));
  // The subscription id is the numeric tail of Shopify's gid (the broker's pattern).
  assert.equal((identity.match(/'\^\[1-9\]\[0-9\]\{0,19\}\$'/g) ?? []).length, 4);
  // The broker's statements call exactly these definers, with their arity.
  assert.equal(
    shopifyVaultStatements.shopifyWebhookRegistrationsPending,
    "SELECT installation_id FROM morrow_vault.shopify_webhook_registrations_pending()",
  );
  assert.match(
    shopifyVaultStatements.shopifyWebhookTarget,
    /FROM morrow_vault\.shopify_webhook_target\(\$1\)$/,
  );
  assert.match(
    shopifyVaultStatements.shopifyWebhookRegistrationRecord,
    /morrow_vault\.shopify_webhook_registration_record\(\$1,\$2,\$3,NULLIF\(\$4,''\),NULLIF\(\$5,''\)\) AS outcome$/,
  );
  const targetColumns = /RETURNS TABLE\(([^)]*)\)/.exec(
    body(vault, "morrow_vault.shopify_webhook_target("),
  )[1];
  assert.deepEqual(
    [...targetColumns.matchAll(/([a-z_]+) text/g)].map((m) => m[1]),
    /^SELECT ([a-z_,]+) FROM/.exec(shopifyVaultStatements.shopifyWebhookTarget)[1].split(","),
  );
});
