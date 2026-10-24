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
import {
  executorLogins,
  vaultFunctions,
  workFunctions,
  workTables,
} from "./tenant-conformance/registry.mjs";

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
  "morrow_work.catalog_undo_proposer_facts(text,text,text,text)": [],
  "morrow_work.catalog_undo_states(text)": ["morrow_work_api"],
  "morrow_work.catalog_undo_source(text)": ["morrow_work_api"],
  "morrow_work.catalog_undo_proposer(text)": ["morrow_work_api"],
  "morrow_work.cmd_catalog_undo(text,text,text,text,text,text,text,text,text,text,text,text)": [
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
  assert.match(
    sql,
    /FOREACH t IN ARRAY ARRAY\['operation_undo_checks','catalog_undos'\] LOOP\n {2}EXECUTE format\('ALTER TABLE morrow_work\.%I ENABLE ROW LEVEL SECURITY',t\);\n {2}EXECUTE format\('ALTER TABLE morrow_work\.%I FORCE ROW LEVEL SECURITY',t\);/,
  );
  assert.match(sql, /CREATE TRIGGER append_only BEFORE UPDATE OR DELETE/);
  assert.match(
    sql,
    /GRANT SELECT,INSERT ON morrow_work\.operation_undo_checks,morrow_work\.catalog_undos TO morrow_work_command;/,
  );
  assert.doesNotMatch(
    sql,
    /GRANT[^;]*\b(?:UPDATE|DELETE|TRUNCATE)\b[^;]*ON morrow_work\.(?:operation_undo_checks|catalog_undos)/,
  );
  // The only new product_snapshots policy is the broker's INSERT of its own setting's product.
  assert.match(
    sql,
    /CREATE POLICY broker_undo_snapshot ON morrow_work\.product_snapshots FOR INSERT TO morrow_work_command\n WITH CHECK \(session_user='morrow_vault_broker'/,
  );
});

test("every function: an explicit ACL, owned by the command role, in the registry", () => {
  // Every REVOKE ... FROM PUBLIC in the file (the CHECK helper's first, then the definers').
  const revoke = [...sql.matchAll(/REVOKE ALL ON FUNCTION ([^;]+) FROM PUBLIC;/g)]
    .map((m) => m[1])
    .join(",");
  assert.match(revoke, /morrow_work\.undo_verdicts_valid\(jsonb\)/);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION morrow_work\.undo_verdicts_valid\(jsonb\) TO morrow_work_command;/,
  );
  assert.deepEqual(workFunctions["undo_verdicts_valid(jsonb)"], {
    kind: "check",
    grantees: ["morrow_work_command"],
  });
  for (const [signature, grantees] of Object.entries(functions)) {
    assert.ok(revoke.includes(signature), signature);
    assert.match(
      sql,
      new RegExp(
        `ALTER FUNCTION ${signature.replace(/[.()[\]]/g, "\\$&")} OWNER TO morrow_work_command;`,
      ),
      signature,
    );
    const [schema, name] = signature.split(".");
    const registry = schema === "morrow_vault" ? vaultFunctions : workFunctions;
    assert.deepEqual(registry[name]?.grantees, grantees, signature);
  }
  // The api reaches only its four; the broker's login only its two, each guarded.
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION morrow_vault\.catalog_undo_resolve\(text\),morrow_vault\.catalog_undo_record\(text,text,text,text,text\)\n TO morrow_vault_broker;/,
  );
  for (const name of ["catalog_undo_resolve", "catalog_undo_record"]) {
    const start = sql.indexOf("CREATE FUNCTION morrow_vault." + name + "(");
    const end = sql.indexOf("END $$;", start);
    assert.match(sql.slice(start, end), /SECURITY DEFINER/);
    assert.match(
      sql.slice(start, end),
      /IF NOT morrow_identity\.work_executor_safe\('morrow_vault_broker'\) THEN v_outcome:='denied'/,
    );
    assert.ok(
      executorLogins.morrow_vault_broker.some((f) => f.includes(name)),
      name,
    );
  }
  // Tenant and actor come only from the session (the prelude and current_tenant()).
  for (const name of [
    "catalog_undo_states",
    "catalog_undo_source",
    "catalog_undo_proposer",
    "cmd_catalog_undo",
  ]) {
    const start = sql.indexOf("CREATE FUNCTION morrow_work." + name + "(");
    const end = sql.indexOf("END $$;", start);
    assert.match(sql.slice(start, end), /current_tenant\(\)|command_prelude\(/, name);
    assert.doesNotMatch(sql.slice(start, end).split("RETURNS")[0], /p_org|p_ws|organization/, name);
  }
});

// Review F1: the undo is proposed by the store's Listings installation, so it needs what the
// agent kernel requires of a Listings run proposing there, rechecked under the command's lock.
const body = (schema, name) => {
  const start = sql.indexOf("CREATE FUNCTION " + schema + "." + name + "(");
  return sql.slice(start, sql.indexOf("END $$;", start));
};

test("F1: the proposing installation's facts: owner, grants, grant set and stops", () => {
  const facts = body("morrow_work", "catalog_undo_proposer_facts");
  assert.doesNotMatch(facts, /SECURITY DEFINER/);
  // The active Listings installation through exactly the change's store and connection.
  assert.match(
    facts,
    /x\.status='active' AND x\.release_id='morrow\.listings' AND x\.store_id=p_store\n {3}AND x\.connection_id=p_connection;/,
  );
  // The owner: that installation's own membership, live (work_member_authority), and only its
  // catalog.content.publish grants with their digest; more than 1,000 grants overflow.
  assert.match(
    facts,
    /morrow_identity\.work_member_authority\(p_org,p_ws,i\.owner_principal_id\) a;\n IF FOUND AND m\.membership_id=i\.owner_membership_id THEN\n {2}v_live:=true;/,
  );
  assert.match(facts, /WHERE q\.g->>'capabilityId'='catalog\.content\.publish';/);
  assert.match(facts, /IF m\.grant_count>1000 THEN v_count:=1001; END IF;/);
  // The agent principal's grant set is still exactly the installation's document.
  assert.match(
    facts,
    /morrow_identity\.work_agent_grant_set_current\(p_org,p_ws,i\.id,i\.agent_principal_id,i\.grant_refs,\n {2}morrow_work\.listings_grant_set\(p_org,p_ws,p_store,p_connection\)\)/,
  );
  // Any stop on runs of the connection or the installation.
  assert.match(facts, /morrow_work\.stop_active\(p_org,p_ws,'run',p_connection,i\.id\)/);
  // The api's read: the tenant's own operation only, then those facts.
  const read = body("morrow_work", "catalog_undo_proposer");
  assert.match(read, /SECURITY DEFINER/);
  assert.match(read, /current_tenant\(\)/);
  assert.match(
    read,
    /catalog_undo_proposer_facts\(t\.organization_id,t\.workspace_id,o\.store_id,o\.connection_id\)/,
  );
});

test("F1: cmd_catalog_undo refuses a stopped, ownerless or changed installation under its lock", () => {
  const cmd = body("morrow_work", "cmd_catalog_undo");
  const at = (pattern) => {
    const i = cmd.search(pattern);
    assert.ok(i > 0, String(pattern));
    return i;
  };
  const lock = at(
    /WHERE x\.organization_id=pre\.organization_id AND x\.workspace_id=pre\.workspace_id AND x\.id=p_operation_id FOR UPDATE;/,
  );
  const stopKey = at(
    /pg_advisory_xact_lock_shared\(pg_catalog\.hashtextextended\(pg_catalog\.jsonb_build_array\('morrow\.work\.stop',\n {2}pre\.organization_id/,
  );
  const facts = at(
    /FROM morrow_work\.catalog_undo_proposer_facts\(pre\.organization_id,pre\.workspace_id,o\.store_id,o\.connection_id\) f;/,
  );
  const stopped = at(
    /IF ins\.stopped THEN RETURN QUERY SELECT 'stopped'::text,NULL::text; RETURN; END IF;/,
  );
  const owner = at(
    /IF NOT ins\.owner_live OR ins\.agent_grant_set IS DISTINCT FROM 'exact' THEN\n {2}RETURN QUERY SELECT 'installation_inactive'::text/,
  );
  const digest = at(
    /IF ins\.owner_grants_digest IS DISTINCT FROM p_owner_grants_digest THEN RETURN QUERY SELECT 'stale_authority'::text/,
  );
  const expired = at(/IF v_expired IS NOT FALSE THEN RETURN QUERY SELECT 'stale_authority'::text/);
  const write = at(/INSERT INTO morrow_work\.proposal_parameters/);
  assert.ok(stopKey < lock && lock < facts, "under the stop key and the row lock");
  assert.ok(facts < stopped && stopped < owner && owner < digest && digest < expired);
  assert.ok(expired < write, "before anything is written");
  // The proposal names that same installation (0032's document check and the insert).
  assert.match(cmd, /'allowed',1,0,ins\.agent_principal_id,ins\.id,pre\.principal_id,/);
  assert.match(cmd, /'agent',ins\.id\);/);
  // The owner's grants digest is a closed parameter.
  assert.match(
    cmd,
    /OR p_owner_grants_digest IS NULL OR p_owner_grants_digest !~ '\^\[a-f0-9\]\{64\}\$'/,
  );
});
