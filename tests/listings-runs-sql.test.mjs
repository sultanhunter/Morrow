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
//   * The billing period: run admission and the run's billing facts read the same two
//     sources as the api's billingPeriodLatest (a granted subscription period, or a staging
//     operator test entitlement's snapshot), so a test-entitled workspace is not refused.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { billingStatements } from "../packages/work/src/billing/sql.ts";

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

// M2 PR-3 (0037) left run_product_readable refusing every run-lease product read (no run
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
  // Only this helper writes the setting (review: counting writes whose value starts with p_
  // missed any other value). Every mention of the setting, however written, is one of four:
  // the helper's set and clear, inside its body, and the two policies' current_setting reads.
  const helper = [
    sql.indexOf("CREATE OR REPLACE FUNCTION morrow_work.run_product_readable("),
    sql.indexOf(
      "END $$;",
      sql.indexOf("CREATE OR REPLACE FUNCTION morrow_work.run_product_readable("),
    ),
  ];
  const mentions = [...sql.matchAll(/morrow\.vault_read_run/g)].map((m) => m.index);
  const writer = "set_config('";
  const reader = "pg_catalog.current_setting('";
  const writes = mentions.filter((i) => sql.slice(i - writer.length, i) === writer);
  const reads = mentions.filter((i) => sql.slice(i - reader.length, i) === reader);
  assert.equal(mentions.length, 4);
  assert.equal(writes.length, 2);
  assert.ok(writes.every((i) => i > helper[0] && i < helper[1]));
  assert.equal(reads.length, 2);
  for (const i of reads) {
    const policy = sql.lastIndexOf("CREATE POLICY ", i);
    assert.ok(
      /^CREATE POLICY broker_read_run(_product)? ON /.test(sql.slice(policy)) &&
        !sql.slice(policy, i).includes(";"),
      String(i),
    );
  }
  // No other migration names the setting at all.
  for (const other of readdirSync("migrations").filter((f) => f.endsWith(".sql") && f !== file))
    assert.ok(
      !readFileSync("migrations/" + other, "utf8")
        .replace(/--.*$/gm, "")
        .includes("vault_read_run"),
      other,
    );
});

// M2 PR-3 review (the redaction race): a run step that entered its lease before shop/redact
// commits the system connection stop must not write store content after store_content_redact
// ran. The three store-content writers take the stop keys shared, as lease_open and
// model_call_begin do (the platform key, then the store's), before the run's lock, and read
// the lease again as a new statement; connector_inbox_apply holds the store's key exclusively
// from the stop through the redaction (lab:listings-runs R-cases race them).
test("the store-content writers take the stop keys shared before the run's lock, then re-read the lease", () => {
  const platform =
    "pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')";
  const store =
    "pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',\n  l.organization_id,l.workspace_id,l.store_id)";
  for (const [name, write] of [
    ["morrow_work.run_snapshot_put", "INSERT INTO morrow_work.product_snapshots"],
    ["morrow_work.run_product_finish", "INSERT INTO morrow_work.run_drafts"],
    ["morrow_work.submit_agent_proposal", "INSERT INTO morrow_work.proposal_parameters"],
  ]) {
    const text = body(name);
    const first = at(text, "SELECT * INTO l FROM morrow_work.current_lease();");
    const again = text.indexOf("SELECT * INTO l FROM morrow_work.current_lease();", first + 1);
    assert.ok(
      first < at(text, platform) &&
        at(text, platform) < at(text, store) &&
        at(text, store) < again &&
        again < at(text, runLock) &&
        at(text, runLock) < at(text, write),
      name,
    );
    // The lease re-read is checked at once (FOUND before any PERFORM).
    assert.ok(
      text
        .slice(again)
        .startsWith(
          "SELECT * INTO l FROM morrow_work.current_lease();\n IF NOT FOUND OR l.kind<>'run' THEN",
        ),
      name,
    );
  }
  // The agent submit keeps the stream first (every API command's prelude, a person's stop
  // included, takes the stream before its stop key).
  const submit = body("morrow_work.submit_agent_proposal");
  assert.ok(at(submit, streamLock) < at(submit, platform));
});

// shop/redact's work-schema handlers (M2 PR-3's store_content_redact, revised): the
// parameters emptied, the store's snapshots and drafts deleted, one evidence entry each.
test("store_content_redact deletes the store's snapshots and drafts, with per-pass evidence", () => {
  const text = replaced("morrow_work.store_content_redact");
  const empty = at(text, "parameters_redact_for_store(p_org,p_ws,p_store_id)");
  const drafts = at(
    text,
    "DELETE FROM morrow_work.run_drafts d WHERE d.organization_id=p_org AND d.workspace_id=p_ws AND d.store_id=p_store_id;",
  );
  const snapshots = at(
    text,
    "DELETE FROM morrow_work.product_snapshots x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.store_id=p_store_id;",
  );
  assert.ok(empty < drafts && drafts < snapshots);
  for (const [table, action] of [
    ["proposal_parameters", "empty_keep_digest"],
    ["product_snapshots", "delete_rows"],
    ["run_drafts", "delete_rows"],
  ])
    assert.ok(
      text.includes(
        `jsonb_build_object('table','morrow_work.${table}','action','${action}','rows',`,
      ),
      table,
    );
  assert.ok(!text.includes("SECURITY DEFINER"));
  // DELETE on exactly the two tables, for the command role, and only the connector's
  // redaction context admits it (a restrictive policy on each).
  assert.match(
    sql,
    /\nGRANT DELETE ON morrow_work\.product_snapshots,morrow_work\.run_drafts TO morrow_work_command;\n/,
  );
  assert.equal(sql.match(/GRANT [A-Z, ]*DELETE/g).length, 1);
  assert.ok(
    sql.includes(
      "EXECUTE format('CREATE POLICY connector_content_delete_only ON morrow_work.%I AS RESTRICTIVE FOR DELETE TO morrow_work_command",
    ),
  );
  assert.ok(sql.includes("FOREACH t IN ARRAY ARRAY['product_snapshots','run_drafts'] LOOP"));
});

// Review (AI review, separate context, same model family): shop/redact deletes a store's
// run_drafts while a run it stopped is still open, so the run's later close must settle from
// content-free rows. run_end and run_finish read run_products (drafted, with or without the
// proposal that packed it), which the agent submit marks with the drafts it packs; lab
// listings-runs X8-X9 prove it on PostgreSQL 17.
test("the settlement reads the content-free run_products, never the drafts shop/redact deletes", () => {
  for (const name of ["morrow_work.run_end", "morrow_work.run_finish"])
    assert.ok(!body(name).includes("morrow_work.run_drafts"), name);
  const end = body("morrow_work.run_end");
  const pending = at(
    end,
    "AND q.status='drafted' AND q.proposal_id IS NULL ORDER BY q.product_index LOOP",
  );
  const packed = at(end, "AND q.status='drafted' AND q.proposal_id IS NOT NULL;");
  // The pending drafts' products accrue, then the packed ones are counted for the settlement.
  const accrued = end.indexOf("run_product_unrecovered(", pending);
  assert.ok(pending < accrued && accrued < packed && packed < at(end, "run_settle("));
  const finish = body("morrow_work.run_finish");
  assert.ok(
    at(
      finish,
      "x.status='drafted' AND x.proposal_id IS NULL) THEN RETURN QUERY SELECT 'drafts_pending'",
    ) < at(finish, "x.status='drafted' AND x.proposal_id IS NOT NULL) THEN v_status:='succeeded'"),
  );
  // The agent submit marks exactly the products of the drafts it packs, in the same block.
  const submit = body("morrow_work.submit_agent_proposal");
  const drafts = at(submit, "UPDATE morrow_work.run_drafts x SET status='packed',proposal_id=v_id");
  const products = at(submit, "UPDATE morrow_work.run_products x SET proposal_id=v_id");
  assert.ok(
    drafts < products && products < submit.indexOf(" EXCEPTION WHEN check_violation", drafts),
  );
  assert.ok(
    submit
      .slice(products)
      .startsWith(
        "UPDATE morrow_work.run_products x SET proposal_id=v_id,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)\n   WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.draft_id=ANY(v_ids)\n    AND x.status='drafted' AND x.proposal_id IS NULL;\n  GET DIAGNOSTICS n=ROW_COUNT;\n  IF n<>cardinality(v_ids) THEN RAISE EXCEPTION 'WORK_RUN_DRAFT_INVALID'; END IF;",
      ),
  );
  // The column is set once, for a drafted product only, and the command role may update it.
  assert.ok(sql.includes("AND (proposal_id IS NULL OR status='drafted'))"));
  assert.match(
    sql,
    /GRANT UPDATE \(revision,status,attempts,snapshot_digest,draft_id,proposal_id,failure_code,updated_at\) ON morrow_work\.run_products TO morrow_work_command;/,
  );
});

/**
 * The billing period's sources in one statement: each UNION ALL branch's selected columns,
 * table and filters (tenant predicates apart), and the ordering. Whitespace and aliases are
 * normalised, so 0038's definers compare equal to the api's statement.
 */
function periodSources(text) {
  const flat = text.replace(/\s+/g, " ");
  const m = flat.match(
    /\(SELECT (\w)\.(\w+),\1\.(\w+),\1\.(\w+) FROM (morrow_billing\.\w+) \1 WHERE (.*?) UNION ALL SELECT (\w)\.(\w+),\7\.(\w+),\7\.(\w+) FROM (morrow_billing\.\w+) \7 WHERE (.*?)\) (\w) ORDER BY \13\.(\w+) DESC,\13\.(\w+) DESC LIMIT 1/,
  );
  assert.ok(m, "no period union in: " + flat.slice(0, 120));
  const branch = (alias, columns, table, where) => {
    const conditions = where.split(" AND ").map((c) => c.replaceAll(alias + ".", ""));
    const tenant = conditions.filter((c) => /^(organization_id|workspace_id)=/.test(c));
    return {
      columns,
      table,
      filters: conditions.filter((c) => !tenant.includes(c)).sort(),
      tenant: tenant.map((c) => c.split("=")[0]).sort(),
    };
  };
  return {
    sources: [
      branch(m[1], [m[2], m[3], m[4]], m[5], m[6]),
      branch(m[7], [m[8], m[9], m[10]], m[11], m[12]),
    ],
    order: [m[14], m[15]],
  };
}

test("run admission and the run's billing facts read the billing period as billingPeriodLatest does", () => {
  const api = periodSources(billingStatements.billingPeriodLatest);
  // The api's statement: the granted subscription period, or an operator entitlement's
  // snapshot (verified_at to valid_until); the later end wins.
  assert.deepEqual(
    api.sources.map((s) => s.table),
    ["morrow_billing.verified_payment_events", "morrow_billing.entitlement_snapshots"],
  );
  assert.deepEqual(api.sources[1].columns, ["verified_at", "valid_until", "recorded_at"]);
  assert.deepEqual(api.sources[1].filters, ["subscription_key ~ '^morrow:operator_entitlement:'"]);
  assert.deepEqual(api.order, ["period_end", "recorded_at"]);
  const strip = (x) => ({
    sources: x.sources.map(({ tenant: _tenant, ...rest }) => rest),
    order: x.order,
  });
  for (const name of ["morrow_work.cmd_run_admit", "morrow_work.run_billing_facts"]) {
    const definer = periodSources(body(name));
    assert.deepEqual(strip(definer), strip(api), name);
    // Each branch is scoped to the tenant by both keys (the api's by its session policies).
    for (const source of definer.sources)
      assert.deepEqual(source.tenant, ["organization_id", "workspace_id"], name);
  }
});
