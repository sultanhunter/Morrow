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
