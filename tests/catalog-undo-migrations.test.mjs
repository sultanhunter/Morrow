// v1 PR 4: static checks of the catalog-undo migration (located by slug, never by number:
// integration renumbers it): its manifest row, the runner contract, ENABLE and FORCE RLS and
// append-only triggers on both new tables, explicit per-function ACLs, definers owned by the
// command role, the broker's definers guarded by work_executor_safe, and the conformance
// registry. The behaviour is proved against PostgreSQL 17 by lab:catalog-undo and
// lab:tenant-conformance.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrationSqlViolations } from "../scripts/migration-sql.mjs";
import { executorLogins, vaultFunctions, workFunctions, workTables } from "./tenant-conformance/registry.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const code = (text) => text.replace(/--.*$/gm, "");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const slug = "catalog-undo";
const row = manifest.migrations.find((m) => m.file.endsWith("." + slug + ".sql"));
const text = readFileSync("migrations/" + row.file, "utf8");
const sql = code(text);
const tables = ["operation_undo_checks", "catalog_undos"];
const functions = {
  "morrow_work.catalog_undo_set(jsonb,text[])": [],
  "morrow_work.catalog_undo_state(text,text,text)": [],
  "morrow_work.catalog_undo_states(text)": ["morrow_work_api"],
  "morrow_work.catalog_undo_source(text)": ["morrow_work_api"],
  "morrow_work.cmd_catalog_undo(text,text,text,text,text,text,text,text,text,text,text)": [
    "morrow_work_api",
  ],
  "morrow_vault.catalog_undo_resolve(text)": ["morrow_vault_broker"],
  "morrow_vault.catalog_undo_record(text,text,text,text,text)": ["morrow_vault_broker"],
};

test("manifest: its row after catalog-apply, the work owner, its brief and digest", () => {
  assert.ok(row);
  assert.equal(row.file, String(row.sequence).padStart(4, "0") + "." + slug + ".sql");
  assert.deepEqual(
    [row.executeAs, row.reviewRef],
    ["morrow_work_owner", "docs/briefs/v1-undo-history-picker.md"],
  );
  assert.equal(row.sha256, sha(text));
  assert.equal(row.prerequisites, undefined);
  const apply = manifest.migrations.find((m) => m.file.endsWith(".catalog-apply.sql"));
  assert.ok(apply.sequence < row.sequence);
  assert.match(text, /RAISE EXCEPTION 'CATALOG_UNDO_PREREQUISITES_INVALID'/);
});

test("the runner contract: one transaction, no role or RLS escape", () => {
  assert.deepEqual(migrationSqlViolations(text), []);
  assert.match(text, /^BEGIN;\n/);
  assert.match(text, /\nCOMMIT;\n?$/);
  assert.doesNotMatch(sql, /\b(?:SET ROLE|BYPASSRLS|NO FORCE|DISABLE ROW LEVEL SECURITY)\b/i);
});

test("both tables: tenant keys, ENABLE and FORCE RLS, append-only, never updated or deleted", () => {
  for (const t of tables) {
    assert.match(sql, new RegExp(`CREATE TABLE morrow_work\\.${t} \\(\\n organization_id`), t);
    assert.ok(workTables[t], t);
    assert.equal(workTables[t].content, "none", t);
  }
  assert.match(sql, /FOREACH t IN ARRAY ARRAY\['operation_undo_checks','catalog_undos'\] LOOP\n {2}EXECUTE format\('ALTER TABLE morrow_work\.%I ENABLE ROW LEVEL SECURITY',t\);\n {2}EXECUTE format\('ALTER TABLE morrow_work\.%I FORCE ROW LEVEL SECURITY',t\);/);
  assert.match(sql, /CREATE TRIGGER append_only BEFORE UPDATE OR DELETE/);
  assert.match(sql, /GRANT SELECT,INSERT ON morrow_work\.operation_undo_checks,morrow_work\.catalog_undos TO morrow_work_command;/);
  assert.doesNotMatch(sql, /GRANT[^;]*\b(?:UPDATE|DELETE|TRUNCATE)\b[^;]*ON morrow_work\.(?:operation_undo_checks|catalog_undos)/);
  // The only new product_snapshots policy is the broker's INSERT of its own setting's product.
  assert.match(
    sql,
    /CREATE POLICY broker_undo_snapshot ON morrow_work\.product_snapshots FOR INSERT TO morrow_work_command\n WITH CHECK \(session_user='morrow_vault_broker'/,
  );
});

test("every function: an explicit ACL, owned by the command role, in the registry", () => {
  const revoke = /REVOKE ALL ON FUNCTION ([^;]+) FROM PUBLIC;/.exec(sql)[1];
  for (const [signature, grantees] of Object.entries(functions)) {
    assert.ok(revoke.includes(signature), signature);
    assert.match(sql, new RegExp(`ALTER FUNCTION ${signature.replace(/[.()[\]]/g, "\\$&")} OWNER TO morrow_work_command;`), signature);
    const [schema, name] = signature.split(".");
    const registry = schema === "morrow_vault" ? vaultFunctions : workFunctions;
    assert.deepEqual(registry[name]?.grantees, grantees, signature);
  }
  // The api reaches only its three; the broker's login only its two, each guarded.
  assert.match(sql, /GRANT EXECUTE ON FUNCTION morrow_vault\.catalog_undo_resolve\(text\),morrow_vault\.catalog_undo_record\(text,text,text,text,text\)\n TO morrow_vault_broker;/);
  for (const name of ["catalog_undo_resolve", "catalog_undo_record"]) {
    const start = sql.indexOf("CREATE FUNCTION morrow_vault." + name + "(");
    const end = sql.indexOf("END $$;", start);
    assert.match(sql.slice(start, end), /SECURITY DEFINER/);
    assert.match(sql.slice(start, end), /IF NOT morrow_identity\.work_executor_safe\('morrow_vault_broker'\) THEN v_outcome:='denied'/);
    assert.ok(executorLogins.morrow_vault_broker.some((f) => f.includes(name)), name);
  }
  // Tenant and actor come only from the session (the prelude and current_tenant()).
  for (const name of ["catalog_undo_states", "catalog_undo_source", "cmd_catalog_undo"]) {
    const start = sql.indexOf("CREATE FUNCTION morrow_work." + name + "(");
    const end = sql.indexOf("END $$;", start);
    assert.match(sql.slice(start, end), /current_tenant\(\)|command_prelude\(/, name);
    assert.doesNotMatch(sql.slice(start, end).split("RETURNS")[0], /p_org|p_ws|organization/, name);
  }
});
