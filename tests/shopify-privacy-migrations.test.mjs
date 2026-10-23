// M2 PR-3: the text of migrations shopify-privacy-identity and shopify-privacy-work (located
// by slug; numbers change at the final rebase). The runner contract and fixed prerequisite
// codes; every new function's explicit PUBLIC revoke; the connector context's settings
// written only by the applier and overwritten on entry by every connector definer; the
// constants SQL shares with TypeScript (the five topics, the read queries, the system stop
// reasons, the handler tables of the evidence, shop/redact's pseudonym); the fail-closed
// run-lease product check; and every vault and connector definer's guard.
// lab:shopify-privacy and the tenant-conformance probes run the same objects in PostgreSQL 17.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { migrationSqlViolations } from "../scripts/migration-sql.mjs";
import {
  shopifyCredentialReasons,
  shopifyReadQueries,
  shopifyWebhookTopics,
} from "../packages/identity/src/broker-protocol.ts";
import { storeContentHandlers } from "../packages/work/src/redaction.ts";
import { stopReasonCodes, systemStopReasons } from "../packages/work/src/stops.ts";

const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const rowOf = (slug) => manifest.migrations.find((m) => m.file.endsWith("." + slug + ".sql"));
const texts = Object.fromEntries(
  ["shopify-privacy-identity", "shopify-privacy-work"].map((slug) => [
    slug,
    readFileSync("migrations/" + rowOf(slug).file, "utf8"),
  ]),
);
const identity = texts["shopify-privacy-identity"];
const work = texts["shopify-privacy-work"];
const sha = (text) => createHash("sha256").update(text).digest("hex");
// Comment-free code (the -- comments only; these files have no block comments).
const code = (text) => text.replace(/--[^\n]*/g, "");
const body = (text, signature) => {
  const start = text.indexOf("CREATE FUNCTION " + signature);
  assert.ok(start >= 0, signature);
  return text.slice(start, text.indexOf("END $$;", start));
};

test("manifest: two contiguous rows after M3 PR-1 and the test entitlement, owners and digests", () => {
  const rows = ["shopify-privacy-identity", "shopify-privacy-work"].map(rowOf);
  assert.equal(rows[1].sequence, rows[0].sequence + 1);
  // M3 PR-2's listings-runs is the first migration after the pair (it revises 0037's
  // helpers); later PRs' migrations (v1 PR 3's catalog-review and catalog-apply) follow it.
  assert.deepEqual(
    manifest.migrations
      .slice(rows[1].sequence, rows[1].sequence + 1)
      .map((m) => m.file.replace(/^\d{4}\./, "")),
    ["listings-runs.sql"],
  );
  // The merge train (2026-10-22) put the staging test entitlement's two rows between M3
  // PR-1's run-credits and these (by slug, never by number).
  assert.deepEqual(
    manifest.migrations
      .slice(rows[0].sequence - 4, rows[0].sequence - 1)
      .map((m) => m.file.replace(/^\d{4}\./, "")),
    ["run-credits.sql", "staging-entitlement-identity-bridge.sql", "staging-test-entitlement.sql"],
  );
  assert.deepEqual(
    rows.map((r) => [r.executeAs, r.reviewRef, r.prerequisites]),
    [
      ["morrow_identity_owner", "docs/briefs/M2-shopify-connect.md", undefined],
      ["morrow_work_owner", "docs/briefs/M2-shopify-connect.md", undefined],
    ],
  );
  for (const row of rows) assert.equal(row.sha256, sha(readFileSync("migrations/" + row.file)));
});

test("the runner contract: one transaction, no role switch, no membership catalog, fixed codes", () => {
  for (const [slug, text] of Object.entries(texts)) {
    assert.deepEqual(migrationSqlViolations(text), [], slug);
    assert.equal(text.includes("pg_auth_" + "members"), false, slug);
    assert.match(text, /RAISE EXCEPTION '[A-Z_]+_PREREQUISITES_INVALID'/, slug);
    assert.doesNotMatch(
      code(text),
      /CREATE ROLE|ALTER ROLE|GRANT morrow_[a-z_]+ TO|BYPASSRLS|DISABLE ROW LEVEL/,
      slug,
    );
    // Every function created here has an explicit PUBLIC revoke.
    for (const [, schema, name] of text.matchAll(/CREATE FUNCTION ([a-z_]+)\.([a-z_]+)\(/g))
      assert.match(text, new RegExp(`REVOKE ALL ON FUNCTION[^;]*${schema}\\.${name}\\(`), name);
  }
  // Both tables FORCE row-level security with the identity owner's policy only.
  for (const table of ["shopify_webhook_inbox", "privacy_requests"])
    assert.match(
      identity,
      new RegExp(`ARRAY\\['shopify_webhook_inbox','privacy_requests'\\]`),
      table,
    );
  assert.match(identity, /FORCE ROW LEVEL SECURITY/);
});

test("the connector context: settings written only by the applier, overwritten on entry everywhere", () => {
  // Only connector_inbox_apply sets a connector setting to a value; every connector definer
  // first clears both (before its guard and any table), and the applier clears each after use.
  const writes = [
    ...code(work).matchAll(/set_config\('morrow\.connector_(stop|redact)',([^,]+),true\)/g),
  ];
  const valued = writes.filter((m) => m[2] !== "''");
  const apply = body(work, "morrow_work.connector_inbox_apply(");
  for (const m of valued) assert.ok(apply.includes(m[0]), m[0]);
  for (const signature of [
    "morrow_work.connector_inbox_apply(",
    "morrow_work.connector_inbox_pending(",
    "morrow_work.connector_credentials_pending(",
    "morrow_work.connector_privacy_overdue(",
  ]) {
    const b = body(work, signature);
    const begin = b.indexOf("BEGIN\n");
    assert.ok(
      b
        .slice(begin)
        .trimStart()
        .startsWith(
          "BEGIN\n PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true);\n IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress')",
        ),
      signature,
    );
  }
  assert.equal((apply.match(/set_config\('morrow\.connector_stop','',true\)/g) ?? []).length, 2);
  assert.equal((apply.match(/set_config\('morrow\.connector_redact','',true\)/g) ?? []).length, 2);
  // Every policy that reads a connector setting also requires the connector's session user.
  for (const [, policy] of work.matchAll(/CREATE POLICY (connector_[a-z_]+) ON/g)) {
    const text = work.slice(
      work.indexOf("CREATE POLICY " + policy),
      work.indexOf(";", work.indexOf("CREATE POLICY " + policy)),
    );
    assert.match(text, /session_user='morrow_connector_ingress'/, policy);
    assert.match(text, /current_setting\('morrow\.connector_(stop|redact)',true\)/, policy);
    assert.doesNotMatch(text, /FOR (ALL|DELETE)/, policy);
  }
  // No lift, no update of a stop and no lease change but revoked with reason stop.
  assert.doesNotMatch(work, /ON morrow_work\.stop_controls FOR UPDATE/);
  assert.match(work, /WITH CHECK \(status='revoked' AND revoked_reason='stop'/);
  // The vault and connector definers each run their login's guard first.
  for (const [signature, login] of [
    ["morrow_vault.shopify_webhook_record(", "morrow_vault_broker"],
    ["morrow_vault.shopify_credential_destroy(", "morrow_vault_broker"],
    ["morrow_vault.shopify_read_resolve(", "morrow_vault_broker"],
  ])
    assert.match(
      body(work, signature),
      new RegExp(`work_executor_safe\\('${login}'\\)`),
      signature,
    );
});

test("constants SQL shares with TypeScript", () => {
  const list = (text) => [...text.matchAll(/'([a-z_]+\/[a-z_]+)'/g)].map((m) => m[1]);
  const inboxTopics = /topic IN \(([^)]*)\)\),\n webhook_id/.exec(identity);
  assert.deepEqual(list(inboxTopics[1]).sort(), [...shopifyWebhookTopics].sort());
  const recordTopics = /p_topic NOT IN \(([^)]*)\)/.exec(
    body(identity, "morrow_identity.work_shopify_webhook_record("),
  );
  assert.deepEqual(list(recordTopics[1]).sort(), [...shopifyWebhookTopics].sort());
  // The read queries the vault resolution accepts are the two entrypoints' union.
  const queries = /p_query NOT IN \(([^)]*)\)/.exec(
    body(work, "morrow_vault.shopify_read_resolve("),
  );
  assert.deepEqual(
    [...queries[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]).sort(),
    [...shopifyReadQueries.api, ...shopifyReadQueries.runtime].sort(),
  );
  // The end reasons the credential destruction accepts.
  const reasons = /p_reason NOT IN \(([^)]*)\)/.exec(
    body(identity, "morrow_identity.work_shopify_credential_end("),
  );
  assert.deepEqual(
    [...reasons[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    [...shopifyCredentialReasons],
  );
  // The system stops the applier writes, and the codes its policies admit.
  const apply = body(work, "morrow_work.connector_inbox_apply(");
  for (const [codeName, reason] of Object.entries(systemStopReasons)) {
    assert.ok(
      apply.includes(`v_reason_code:='${codeName}'; v_reason:='${reason.replaceAll("'", "''")}'`),
      codeName,
    );
    assert.match(
      work,
      new RegExp(`reason_code IN \\('shopify_app_uninstalled','shopify_scopes_changed'\\)`),
    );
  }
  assert.equal(stopReasonCodes.uninstalled, "shopify_app_uninstalled");
  assert.equal(stopReasonCodes.scopesChanged, "shopify_scopes_changed");
  // The evidence admits exactly the handler tables (M3 PR-2's two among them), and its
  // actions.
  const evidence = body(identity, "morrow_identity.privacy_evidence_valid(");
  const tables = /\(h->>'table'\) NOT IN \(([^)]*)\)/.exec(evidence)[1];
  assert.deepEqual(
    [...tables.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).sort(),
    [
      ...new Set([
        ...storeContentHandlers.map((h) => h.table),
        "morrow_work.product_snapshots",
        "morrow_work.run_drafts",
      ]),
    ].sort(),
  );
  // shop/redact's pseudonym: derived from the installation id, the *.myshopify.com shape.
  const pseudonym = (id) =>
    "redacted-" + sha("morrow.shopify.redacted.v1|" + id).slice(0, 24) + ".myshopify.com";
  assert.match(
    identity,
    /SELECT 'redacted-'\|\|substr\(encode\(sha256\(convert_to\('morrow\.shopify\.redacted\.v1\|'\|\|p_installation_id,'UTF8'\)\),'hex'\),1,24\)\|\|'\.myshopify\.com'/,
  );
  assert.match(pseudonym("installation_1"), /^redacted-[a-f0-9]{24}\.myshopify\.com$/);
});

test("fail closed: a run lease reads no product until M3 PR-2's runs exist; customers keep no digest", () => {
  // 0037's text; listings-runs revises it once the runs exist (tests/listings-runs-sql.test.mjs).
  assert.match(
    work,
    /CREATE FUNCTION morrow_work\.run_product_readable\(p_org text,p_ws text,p_run_id text,p_product_id text\) RETURNS boolean\nLANGUAGE sql STABLE SET search_path=pg_catalog,morrow_work,pg_temp AS \$\$\n SELECT false\n\$\$;/,
  );
  // privacy_requests (365 days) keeps no customer digest; only the 7-day inbox body does.
  const requests = identity.slice(
    identity.indexOf("CREATE TABLE morrow_identity.privacy_requests"),
    identity.indexOf("CREATE UNIQUE INDEX privacy_requests_one_data_request"),
  );
  assert.doesNotMatch(requests.replaceAll("'customers/", "'topic/"), /customer/i);
  // A completed request has evidence with nothing outstanding (the validator requires []).
  assert.match(
    body(identity, "morrow_identity.privacy_evidence_valid("),
    /p_evidence->'outstanding'<>'\[\]'::jsonb/,
  );
  // The read resolution never writes resolve_call's lease setting itself (0031's rule).
  assert.doesNotMatch(work, /morrow\.vault_resolve_lease'\s*,\s*p_/);
});
