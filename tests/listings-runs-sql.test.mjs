// M3 PR-2: static checks of migration listings-runs (located by slug, never by number: it is
// renumbered at the final rebase) for rules a single-threaded lab cannot see. The behaviour
// is proved against PostgreSQL 17 by lab:listings-runs (D1-D2 drive the lock order with two
// sessions).
//   * One lock order, as every API command's prelude takes it: the workspace stream, then
//     the run's advisory lock, then the rest. The runtime definers that append an event or
//     settle take the stream before the run; run_end takes it before any credit or cost
//     row; the stale close never waits on a run's lock while its caller holds the stream.
//   * FOUND is read straight after the SELECT INTO it reports on: a PERFORM between them
//     resets it (an unknown fence or lease would read as found).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const file = manifest.migrations.find((m) => m.file.endsWith(".listings-runs.sql")).file;
const sql = readFileSync("migrations/" + file, "utf8").replace(/--.*$/gm, "");
/** The body of one function of the migration, from CREATE FUNCTION to its closing $$. */
function body(name) {
  const start = sql.indexOf("CREATE FUNCTION " + name + "(");
  assert.ok(start >= 0, name);
  const end = sql.indexOf("END $$;", start);
  assert.ok(end > start, name);
  return sql.slice(start, end);
}
const streamLock = /PERFORM 1 FROM morrow_work\.workspace_streams w WHERE [^;]* FOR UPDATE;/;
const runLock =
  "pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.run'";
const at = (text, pattern) => {
  const i = typeof pattern === "string" ? text.indexOf(pattern) : text.search(pattern);
  assert.ok(i >= 0, String(pattern));
  return i;
};

test("one lock order: the workspace stream, then the run, then the rest", () => {
  for (const name of [
    "morrow_work.run_start",
    "morrow_work.submit_agent_proposal",
    "morrow_work.run_finish",
  ]) {
    const text = body(name);
    // The stream right after the lease, before the run's lock, and only once.
    assert.ok(at(text, streamLock) < at(text, runLock), name);
    assert.ok(at(text, "current_lease()") < at(text, streamLock), name);
    assert.equal(text.match(new RegExp(streamLock.source, "g")).length, 1, name);
  }
  // run_end takes the stream before any unrecovered accrual, settlement or event.
  const end = body("morrow_work.run_end");
  for (const later of ["run_product_unrecovered", "run_settle", "append_event"])
    assert.ok(at(end, streamLock) < at(end, later), later);
  // The stale close runs under the caller's stream: it never waits on a run's lock (a busy
  // run is skipped) and rechecks the run once it holds it.
  const stale = body("morrow_work.runs_close_stale");
  assert.ok(stale.includes("pg_try_advisory_xact_lock("), "try-lock");
  assert.ok(!/[^_]pg_advisory_xact_lock\(/.test(stale), "no waiting lock");
  assert.ok(
    at(stale, "pg_try_advisory_xact_lock(") < at(stale, "status IN ('queued','running')) THEN"),
  );
});

test("the model definers read FOUND before any PERFORM resets it", () => {
  for (const name of ["morrow_vault.model_call_begin", "morrow_vault.model_call_end"]) {
    const text = body(name);
    // The first lookup: SELECT ... INTO, then v_found:=FOUND, then the settings PERFORM.
    const select = text.search(
      / INTO (lz|c) FROM morrow_work\.(work_leases|run_model_calls) x WHERE x\.id=/,
    );
    assert.ok(select >= 0, name);
    const captured = at(text, "v_found:=FOUND;");
    const reset = text.indexOf("PERFORM pg_catalog.set_config(", select);
    assert.ok(select < captured && captured < reset, name);
    assert.ok(at(text, "IF NOT v_found") > reset, name);
  }
});

test("the daily cap counts that day's overflow bookings (run_reserve revised)", () => {
  const reserve = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION morrow_billing.run_reserve("));
  const text = reserve.slice(0, reserve.indexOf("END $$;"));
  assert.ok(text.length > 0);
  const daily = at(text, "INTO v_today");
  const overflow = at(text, "b.kind='overflow'");
  const capped = at(text, "workspace_daily_cost_cap_usd THEN");
  assert.ok(daily < overflow && overflow < capped);
});

/** The body of one CREATE OR REPLACE FUNCTION of the migration (a revised owner helper). */
function replaced(name) {
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION " + name + "(");
  assert.ok(start >= 0, name);
  const end = sql.indexOf("END $$;", start);
  assert.ok(end > start, name);
  return sql.slice(start, end);
}

// M2 PR-3 (0035) left run_product_readable refusing every run-lease product read (no run
// table existed); this migration revises it in place (same signature, the ACL restated).
test("M2 PR-3's run-lease product check: its own setting, a running run's in-progress product", () => {
  const text = replaced("morrow_work.run_product_readable");
  assert.match(
    text,
    /^CREATE OR REPLACE FUNCTION morrow_work\.run_product_readable\(p_org text,p_ws text,p_run_id text,p_product_id text\) RETURNS boolean\nLANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS \$\$/,
  );
  // Closed inputs, then its own setting before the one read, cleared straight after.
  const set = at(text, "set_config('morrow.vault_read_run',p_org||'|'||p_ws||'|'||p_run_id,true)");
  const read = at(
    text,
    "SELECT EXISTS(SELECT 1 FROM morrow_work.runs r JOIN morrow_work.run_products q",
  );
  const clear = at(text, "set_config('morrow.vault_read_run','',true)");
  assert.ok(at(text, "RETURN false;") < set && set < read && read < clear);
  assert.ok(text.includes("r.status='running'") && text.includes("q.status='in_progress'"));
  assert.ok(text.includes("q.product_id=p_product_id") && text.includes("r.id=p_run_id"));
  // Not SECURITY DEFINER: it runs as its caller, the read resolution's command role.
  assert.ok(!text.includes("SECURITY DEFINER"));
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION morrow_work\.run_product_readable\(text,text,text,text\) FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION morrow_work\.run_product_readable\(text,text,text,text\) TO morrow_work_command;/,
  );
  // Its two policies read only, for the broker's login and that setting alone.
  for (const [policy, table, column] of [
    ["broker_read_run", "runs", "id"],
    ["broker_read_run_product", "run_products", "run_id"],
  ])
    assert.ok(
      sql.includes(
        `CREATE POLICY ${policy} ON morrow_work.${table} FOR SELECT TO morrow_work_command\n USING (session_user='morrow_vault_broker'\n  AND organization_id::text||'|'||workspace_id::text||'|'||${column}::text=pg_catalog.current_setting('morrow.vault_read_run',true));`,
      ),
      policy,
    );
  // Only this helper writes the setting.
  assert.equal(sql.match(/'morrow\.vault_read_run',p_/g).length, 1);
});
