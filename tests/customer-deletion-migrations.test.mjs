// SD3 and SD4 (P09.T05b, P09.T05c): the customer deletion pair, statically. Forward only, each
// as its owner, every replaced function pinned to the exact text the chain holds before it,
// every new function revoked from PUBLIC, and nothing deleted but the inbox's 7-day purge.
// lab:shopify-privacy (phases L and X) and lab:tenant-conformance prove them on PostgreSQL 17.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const rowOf = (slug) => manifest.migrations.find((m) => m.file.endsWith(slug));
const identity = rowOf(".customer-deletion-identity.sql");
const work = rowOf(".customer-deletion-work.sql");
const text = (row) => readFileSync("migrations/" + row.file, "utf8");
// The text PostgreSQL stores for a function (prosrc): its body between the dollar quotes, as
// the last migration before `before` defined it.
function prosrcBefore(name, before) {
  let found = null;
  for (const m of manifest.migrations) {
    if (m.sequence >= before) break;
    const sql = readFileSync("migrations/" + m.file, "utf8");
    const pattern = new RegExp(
      "CREATE (?:OR REPLACE )?FUNCTION " + name.replace(".", "\\.") + "\\(",
      "g",
    );
    let match;
    while ((match = pattern.exec(sql))) {
      const open = sql.indexOf("$$", match.index);
      found = sql.slice(open + 2, sql.indexOf("$$", open + 2));
    }
  }
  return found;
}
const md5 = (value) => createHash("md5").update(value).digest("hex");
// The SQL without its comment lines.
const code = (row) =>
  text(row)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

test("the pair: consecutive forward rows, each as its owner, with its packet and digest", () => {
  assert.ok(identity && work);
  assert.equal(work.sequence, identity.sequence + 1);
  // The reserved pair 0059 and 0060, after 0057 (pull request 92) and 0058 (pull request 64);
  // the lead renumbers at merge if the order differs.
  assert.ok(identity.sequence >= 57);
  assert.equal(identity.executeAs, "morrow_identity_owner");
  assert.equal(work.executeAs, "morrow_work_owner");
  for (const row of [identity, work]) {
    assert.equal(row.reviewRef, "docs/packets/P09.T05c.md");
    assert.equal(row.sha256, createHash("sha256").update(text(row)).digest("hex"));
    assert.match(text(row), /^BEGIN;\n/);
    assert.match(text(row), /\nCOMMIT;\n$/);
    assert.doesNotMatch(code(row), /BYPASSRLS|SET (LOCAL )?ROLE|SECURITY INVOKER|^TRUNCATE /m);
  }
  assert.match(text(identity), /current_user<>'morrow_identity_owner'/);
  assert.match(
    text(identity),
    /RAISE EXCEPTION 'CUSTOMER_DELETION_IDENTITY_PREREQUISITES_INVALID'/,
  );
  assert.match(text(work), /current_user<>'morrow_work_owner'/);
  assert.match(text(work), /RAISE EXCEPTION 'CUSTOMER_DELETION_WORK_PREREQUISITES_INVALID'/);
});

test("every replaced function is pinned to the exact text the chain holds before the pair", () => {
  const pins = (sql) =>
    [
      ...sql.matchAll(
        /to_regprocedure\('([a-z0-9_]+\.[a-z0-9_]+)\([^)]*\)'\)\)\n\s+IS DISTINCT FROM '([a-f0-9]{32})'/g,
      ),
    ].map((m) => [m[1], m[2]]);
  const identityPins = pins(text(identity));
  const workPins = pins(text(work));
  assert.deepEqual(identityPins.map(([name]) => name).sort(), [
    "morrow_identity.privacy_evidence_valid",
    "morrow_identity.shopify_preserve_record",
    "morrow_identity.shopify_webhook_body_valid",
    "morrow_identity.work_privacy_request_complete",
    "morrow_identity.work_shopify_webhook_record",
  ]);
  assert.deepEqual(workPins.map(([name]) => name).sort(), [
    "morrow_work.connector_inbox_apply_v2",
    "morrow_work.store_content_redact",
  ]);
  for (const [name, pin] of [...identityPins, ...workPins])
    assert.equal(md5(prosrcBefore(name, identity.sequence)), pin, name);
  // Each replaced function is replaced in the file that pins it, and nothing else is.
  const replaced = (sql) =>
    [...sql.matchAll(/CREATE OR REPLACE FUNCTION ([a-z0-9_]+\.[a-z0-9_]+)\(/g)]
      .map((m) => m[1])
      .sort();
  assert.deepEqual(replaced(text(identity)), [
    "morrow_identity.privacy_evidence_valid",
    "morrow_identity.shopify_webhook_body_valid",
    "morrow_identity.work_privacy_request_complete",
    "morrow_identity.work_shopify_webhook_record",
  ]);
  assert.deepEqual(replaced(text(work)), ["morrow_work.store_content_redact"]);
  // The shared guard is pinned (so a missed merge fails) but kept: the inbox gets its own.
  assert.match(
    text(identity),
    /DROP TRIGGER shopify_record_guard ON morrow_identity\.shopify_webhook_inbox;\nCREATE TRIGGER shopify_record_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_identity\.shopify_webhook_inbox\n FOR EACH ROW EXECUTE FUNCTION morrow_identity\.shopify_inbox_guard\(\);/,
  );
});

test("drops, deletes and grants: only what the packet names", () => {
  const statements = (sql, pattern) => [...sql.matchAll(pattern)].map((m) => m[0]);
  assert.deepEqual(statements(text(identity), /^DROP [^\n]+$/gm), [
    "DROP TRIGGER shopify_record_guard ON morrow_identity.shopify_webhook_inbox;",
  ]);
  // The command-owned applier is dropped and created again (the schema owner may), as 0056
  // did for runtime_operation_begin, with its one grant and owner restored.
  assert.deepEqual(statements(text(work), /^DROP [^\n]+$/gm), [
    "DROP FUNCTION morrow_work.connector_inbox_apply_v2(text);",
  ]);
  assert.match(
    text(work),
    /GRANT EXECUTE ON FUNCTION morrow_work\.connector_inbox_apply_v2\(text\),morrow_work\.connector_privacy_purge\(\) TO morrow_connector_ingress;/,
  );
  assert.match(
    text(work),
    /ALTER FUNCTION morrow_work\.connector_inbox_apply_v2\(text\) OWNER TO morrow_work_command;/,
  );
  // The one DELETE: the inbox's 7-day purge (and its guard's rule for it). Exports and keys
  // are never deleted, only erased in place.
  assert.deepEqual(statements(text(identity), /\bDELETE FROM [a-z_.]+/g), [
    "DELETE FROM morrow_identity.shopify_webhook_inbox",
  ]);
  // In the work file, only 0038's two shop/redact deletions, kept unchanged in the revised
  // store_content_redact; exports and keys are erased in place.
  assert.deepEqual(statements(code(work), /\bDELETE FROM [a-z_.]+/g), [
    "DELETE FROM morrow_work.run_drafts",
    "DELETE FROM morrow_work.product_snapshots",
  ]);
  assert.doesNotMatch(text(work), /GRANT [A-Z, ]*DELETE/);
  // Every new function is revoked from PUBLIC.
  for (const row of [identity, work]) {
    const sql = text(row);
    for (const [, name] of sql.matchAll(/CREATE FUNCTION ([a-z0-9_]+\.[a-z0-9_]+)\(/g))
      assert.match(
        sql,
        new RegExp("REVOKE ALL ON FUNCTION[^;]*" + name.replace(".", "\\.") + "\\("),
        name,
      );
  }
  // The digest keys: the broker's login only; no key material is ever returned but sealed.
  assert.match(
    text(work),
    /GRANT EXECUTE ON FUNCTION morrow_vault\.customer_digest_keys_get\(text,text\),\n morrow_vault\.customer_digest_key_create\(text,text,text,text,text\) TO morrow_vault_broker;/,
  );
  assert.match(
    text(work),
    /GRANT SELECT,INSERT ON morrow_vault\.customer_digest_keys TO morrow_work_command;/,
  );
  assert.match(
    text(work),
    /GRANT EXECUTE ON FUNCTION morrow_work\.customer_data_exports_open\(\) TO morrow_work_api;/,
  );
});

test("the clocks and the closed lists are the records'", () => {
  // ADR-0031 item 1: inbox receipts 7 days (0036's CHECK, unchanged), exports 30 days.
  assert.match(text(work), /CHECK \(expires_at=created_at\+interval '30 days'\)/);
  // The broker's 20,000-id cap and the body's 512 KiB room agree with the minimiser.
  assert.match(text(identity), /jsonb_array_length\(p_list\)>20000/);
  assert.match(text(identity), /octet_length\(p_body\)>524288/);
  const minimiser = readFileSync("apps/broker/src/shopify.ts", "utf8");
  assert.match(minimiser, /export const shopifyComplianceOrdersMax = 20000;/);
  // The evidence's closed customer list is the registry's (S8 compares the live function).
  assert.match(
    text(identity),
    /CREATE FUNCTION morrow_identity\.customer_handler_tables\(\) RETURNS text\[\]\nLANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS \$\$\n SELECT ARRAY\['morrow_work\.customer_data_exports'\]::text\[\]\n\$\$;/,
  );
});
