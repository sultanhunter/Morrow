// M3 PR-1 PostgreSQL 17 laboratory: run credits (the run-credits migration, P11.T04a
// minimum; ADR-0022 item 11) on an isolated network-none engine, the full manifest applied
// by the Neon-shaped non-superuser CREATEROLE administrator. The reservation helpers run
// as morrow_work_command in a session context (run admission, M3 PR-2) and under a run
// lease (the run steps), and prove:
//   C1 two reservations racing for a balance for one: exactly one is admitted, both orders;
//   C2 release restores the wallet; settlement never exceeds the reservation; the wallet
//      conserves available+reserved+consumed;
//   C3 the US$25 daily cap counts open reservations at their maximum and settled ones at
//      their booked cost;
//   C4 the unrecovered-cost ledger accrues failed and uncertain bookings; admission
//      refuses with unrecovered_cost_cap until the next billing period;
//   C5 Opus high reserves 6 credits per product and admits at most 9 products;
//   C6 a reservation keeps its catalogue version after a newer one is active;
//   C7 refusals: duplicate, no wallet, no billing period, another tenant;
//   C8 the lease context: a run step books and settles its own run only.
// Owner-seeded synthetic fixtures only (the wallet is funded as the owner; M5 PR-1 funds
// it from verified payments). No provider, credential or merchant data. CI pg-linking.
import { randomUUID } from "node:crypto";
import {
  asApi,
  asCommandRole,
  literal,
  seedWorkFixtures,
  sleep,
  withWorkDatabase,
} from "../tests/tenant-conformance/harness.mjs";
import { writeArtifact } from "./artifacts.mjs";

const checks = [];
const failures = [];
const labStarted = Date.now();
let stage = "start";
const phase = (value) => {
  stage = value;
  console.error(
    "CREDITS_LAB_PHASE:" + value + " t=" + Math.round((Date.now() - labStarted) / 1000) + "s",
  );
};
function check(name, passed, detail) {
  if (!/^C[0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("CREDITS_LAB_CHECK_NAME:" + name);
  checks.push({ name, passed: passed === true });
  if (passed !== true) {
    failures.push(name);
    console.error(
      "CHECK_FAILED " + name + (detail === undefined ? "" : " " + JSON.stringify(detail)),
    );
  }
  return passed === true;
}
const last = (out) => (Array.isArray(out) ? out : out.split("\n")).at(-1);
const ms = "date_trunc('milliseconds',clock_timestamp())";

// Lab-only definers, created by the local superuser as scaffolding (not migration objects):
// they stand in for M3 PR-2's runtime definers, owned by the command role, acting only
// through the tenant_lease policies of the entered run lease.
const probes = `CREATE SCHEMA lab_credits;
CREATE FUNCTION lab_credits.book(p_run text,p_entry text,p_amount numeric,p_kind text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE l record; r record;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND THEN RETURN 'denied'; END IF;
 SELECT * INTO r FROM morrow_billing.run_book_cost(l.organization_id,l.workspace_id,p_run,p_entry,p_amount,p_kind);
 RETURN r.outcome;
END $$;
CREATE FUNCTION lab_credits.settle(p_run text,p_drafted integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE l record; r record;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND THEN RETURN 'denied'; END IF;
 SELECT * INTO r FROM morrow_billing.run_settle(l.organization_id,l.workspace_id,p_run,p_drafted);
 RETURN r.outcome||'|'||coalesce(r.credits_settled,'');
END $$;
CREATE FUNCTION lab_credits.foreign_settle(p_org text,p_ws text,p_run text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r record;
BEGIN
 SELECT * INTO r FROM morrow_billing.run_settle(p_org,p_ws,p_run,1);
 RETURN r.outcome;
END $$;
ALTER FUNCTION lab_credits.book(text,text,numeric,text) OWNER TO morrow_work_command;
ALTER FUNCTION lab_credits.settle(text,integer) OWNER TO morrow_work_command;
ALTER FUNCTION lab_credits.foreign_settle(text,text,text) OWNER TO morrow_work_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lab_credits FROM PUBLIC;
GRANT USAGE ON SCHEMA lab_credits TO morrow_runtime_executor;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lab_credits TO morrow_runtime_executor;`;

export async function runCreditsLab(db) {
  phase("fixtures");
  const P = seedWorkFixtures(db);
  db.sql(probes);
  const O = P.A.org,
    W = P.A.workspace;
  const attempt = (text, user = "postgres") => db.tryRun(text, { user });
  const refused = (text, code, user = "postgres") => {
    const r = attempt(text, user);
    return !r.ok && new RegExp(code).test(r.stderr);
  };
  const cmd = (p, statements, end = "COMMIT") =>
    db
      .sql(asCommandRole(p, statements, { end }))
      .split("\n")
      .slice(1);
  const fund = (account, credits, p = P.A) =>
    db.workOwner(
      `INSERT INTO morrow_billing.credit_wallets VALUES(${literal(p.org)},${literal(p.workspace)},${literal(account)},${credits},0,0,1,1,1,${ms});`,
    );
  const wallet = (account, p = P.A) =>
    db.rows(
      `SELECT available::int,reserved::int,consumed::int,revision::int FROM morrow_billing.credit_wallets WHERE organization_id=${literal(p.org)} AND workspace_id=${literal(p.workspace)} AND billing_account_id=${literal(account)}`,
    )[0];
  const period = "timestamptz '2026-10-01T00:00:00Z'";
  const nextPeriod = "timestamptz '2026-11-01T00:00:00Z'";
  // C6-C8 run in later periods: C4 leaves October past its unrecovered-cost cap.
  const laterPeriod = "timestamptz '2027-01-01T00:00:00Z'";
  const reserveCall = (account, run, model, effort, products, o = {}) =>
    `SELECT outcome||'|'||coalesce(credits_reserved,'')||'|'||coalesce(vendor_maximum_usd,'') FROM morrow_billing.run_reserve(${literal(o.org ?? O)},${literal(o.ws ?? W)},${literal(account)},${literal(run)},${literal("credit_" + run)},${literal("vendor_" + run)},${literal("allocation_" + run)},${literal("a".repeat(64))},${o.version ?? 1},${literal(model)},${literal(effort)},${products},${o.period === undefined ? period : o.period});`;
  const reserve = (account, run, model, effort, products, o = {}) =>
    last(cmd(o.p ?? P.A, reserveCall(account, run, model, effort, products, o), o.end ?? "COMMIT"));
  const book = (run, amount, kind, entry = "entry_" + randomUUID(), p = P.A) =>
    last(
      cmd(
        p,
        `SELECT outcome||'|'||coalesce(booked_usd,'')||'|'||coalesce(unrecovered_usd,'') FROM morrow_billing.run_book_cost(${literal(O)},${literal(W)},${literal(run)},${literal(entry)},${amount}::numeric,${literal(kind)});`,
      ),
    );
  const settle = (run, drafted, p = P.A) =>
    last(
      cmd(
        p,
        `SELECT outcome||'|'||coalesce(credits_settled,'') FROM morrow_billing.run_settle(${literal(O)},${literal(W)},${literal(run)},${drafted});`,
      ),
    );
  const release = (run) =>
    last(
      cmd(
        P.A,
        `SELECT outcome||'|'||coalesce(credits_settled,'') FROM morrow_billing.run_release(${literal(O)},${literal(W)},${literal(run)});`,
      ),
    );
  const reservation = (run) =>
    db.rows(
      `SELECT c.status,c.credits_reserved::int,c.credits_settled::int,c.credits_per_product,c.product_count,c.catalogue_version,v.maximum_cost_usd::text,v.booked_cost_usd::text,v.unrecovered_cost_usd::text,v.status AS vendor_status FROM morrow_billing.credit_reservations c JOIN morrow_billing.vendor_cost_reservations v ON v.organization_id=c.organization_id AND v.workspace_id=c.workspace_id AND v.credit_reservation_id=c.id WHERE c.root_run_id=${literal(run)}`,
    )[0];

  // -------------------------------------------------------------------------
  phase("race");
  {
    // C1: a balance for one Opus-high product (6 credits), two runs racing for it. The first
    // session reserves and holds its transaction open; the second waits on the workspace
    // interlock, then sees the debited wallet. Both orders.
    for (const [round, [first, second]] of [
      ["ab", ["race_a1", "race_b1"]],
      ["ba", ["race_b2", "race_a2"]],
    ]) {
      const account = "account_race_" + round;
      fund(account, 6);
      const hold = (run, app) =>
        db.runAsync(
          asCommandRole(
            P.A,
            reserveCall(account, run, "claude_opus_5_5", "high", 1) + "\nSELECT pg_sleep(1.5);",
            {
              end: "COMMIT",
            },
          ),
          { applicationName: app },
        );
      const appA = "credits_race_" + round + "_1";
      const appB = "credits_race_" + round + "_2";
      const one = hold(first, appA);
      // Wait until the first session holds its reservation (it is sleeping).
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const r = await db.runAsync(
          `SELECT count(*) FROM pg_stat_activity WHERE application_name=${literal(appA)} AND wait_event='PgSleep';`,
        );
        if (r.ok && last(r.stdout) === "1") break;
        await sleep(25);
      }
      const two = db.runAsync(
        asCommandRole(P.A, reserveCall(account, second, "claude_opus_5_5", "high", 1), {
          end: "COMMIT",
        }),
        {
          applicationName: appB,
        },
      );
      const waited = await db.waitForLockWait(`application_name=${literal(appB)}`);
      const [a, b] = await Promise.all([one, two]);
      const outcomes = [a, b].map((r) =>
        r.ok ? last(r.stdout.split("\n").filter((l) => l.includes("|"))) : "error",
      );
      const w = wallet(account);
      check(
        "C1:race_admits_exactly_one_" + round,
        waited &&
          outcomes[0].startsWith("reserved|6|") &&
          outcomes[1] === "insufficient_credits||" &&
          w.available === 0 &&
          w.reserved === 6 &&
          w.consumed === 0,
        { waited, outcomes, w },
      );
    }
  }

  // -------------------------------------------------------------------------
  phase("settlement");
  {
    fund("account_main", 1000);
    // C2: a failed run releases everything; settlement is capped at the reservation and
    // charges only drafted products; the sum is conserved at every step.
    const before = wallet("account_main");
    const r1 = reserve("account_main", "run_release", "claude_sonnet_5_5", "medium", 3);
    const mid = wallet("account_main");
    const released = release("run_release");
    const after = wallet("account_main");
    check(
      "C2:release_restores_the_wallet",
      r1.startsWith("reserved|6|0.81600000") &&
        mid.available === before.available - 6 &&
        mid.reserved === 6 &&
        released === "released|0" &&
        after.available === before.available &&
        after.reserved === 0 &&
        after.consumed === 0 &&
        reservation("run_release").status === "released" &&
        reservation("run_release").vendor_status === "released",
      { r1, mid, released, after },
    );
    reserve("account_main", "run_settle_cap", "claude_sonnet_5_5", "medium", 3);
    const capped = settle("run_settle_cap", 5);
    reserve("account_main", "run_settle_part", "claude_sonnet_5_5", "medium", 3);
    const partial = settle("run_settle_part", 1);
    const ended = settle("run_settle_part", 3);
    const w = wallet("account_main");
    check(
      "C2:settlement_never_exceeds_the_reservation",
      capped === "settled|6" &&
        partial === "settled|2" &&
        ended === "ended|" &&
        w.consumed === 8 &&
        w.reserved === 0 &&
        w.available + w.reserved + w.consumed === 1000,
      { capped, partial, ended, w },
    );
    // The CHECK and the guards hold even against the command role's own writes.
    check(
      "C2:guards_refuse_direct_writes",
      refused(
        asCommandRole(
          P.A,
          `UPDATE morrow_billing.credit_reservations SET credits_settled=credits_reserved+1,status='settled',settled_at=${ms},revision=revision+1 WHERE root_run_id='run_settle_cap';`,
        ),
        "CREDIT_RESERVATION_INVALID|check constraint",
      ) &&
        refused(
          asCommandRole(
            P.A,
            `UPDATE morrow_billing.credit_wallets SET available=available+5,revision=revision+1 WHERE billing_account_id='account_main';`,
          ),
          "CREDIT_WALLET_INVALID",
        ) &&
        refused(
          asCommandRole(
            P.A,
            `DELETE FROM morrow_billing.credit_reservations WHERE root_run_id='run_release';`,
          ),
          "permission denied",
        ) &&
        refused(
          `SET ROLE morrow_work_owner; DELETE FROM morrow_billing.credit_reservations WHERE root_run_id='run_release';`,
          "BILLING_RECORD_IMMUTABLE",
        ),
    );
  }

  // -------------------------------------------------------------------------
  phase("opus_and_daily_cap");
  {
    // C5: Opus high: 6 credits per product, at most 9 products (the run cost cap).
    fund("account_daily", 10000);
    const ten = reserve("account_daily", "run_opus_10", "claude_opus_5_5", "high", 10);
    const nine = reserve("account_daily", "run_opus_9", "claude_opus_5_5", "high", 9);
    const r = reservation("run_opus_9");
    check(
      "C5:opus_high_six_credits_nine_products",
      ten === "run_product_limit||" &&
        nine === "reserved|54|6.33600000" &&
        r.credits_per_product === 6 &&
        r.product_count === 9 &&
        r.maximum_cost_usd === "6.33600000",
      { ten, nine, r },
    );
    // C3: the daily cap (US$25): open reservations count at their maximum. Two more 9-product
    // Opus-high runs reach 19.008; a fourth (25.344) is refused. Settling one at its booked
    // cost (0.50) frees the difference, and the fourth is admitted.
    const two = reserve("account_daily", "run_daily_2", "claude_opus_5_5", "high", 9);
    const three = reserve("account_daily", "run_daily_3", "claude_opus_5_5", "high", 9);
    const four = reserve("account_daily", "run_daily_4", "claude_opus_5_5", "high", 9);
    const booked = book("run_opus_9", "0.50000000", "drafted", null);
    const settled = settle("run_opus_9", 1);
    const fourAgain = reserve("account_daily", "run_daily_4b", "claude_opus_5_5", "high", 9);
    // Small runs still fit under the cap while it has room.
    check(
      "C3:daily_cap_counts_open_and_settled",
      two.startsWith("reserved|") &&
        three.startsWith("reserved|") &&
        four === "daily_cap||" &&
        booked === "booked|0.50000000|0.00000000" &&
        settled === "settled|6" &&
        fourAgain.startsWith("reserved|54|"),
      { two, three, four, booked, settled, fourAgain },
    );
    for (const run of ["run_daily_2", "run_daily_3", "run_daily_4b"]) release(run);
  }

  // -------------------------------------------------------------------------
  phase("unrecovered");
  {
    // C4: failed products and uncertain attempts accrue to the period's unrecovered cost;
    // once the next product's worst case would pass US$4.50, admission refuses until the
    // next billing period. Drafted cost is not unrecovered. A booking never exceeds the
    // reservation.
    fund("account_unrecovered", 1000);
    const run = "run_failing";
    const r = reserve("account_unrecovered", run, "claude_opus_5_5", "high", 9);
    const failed = [];
    for (let i = 0; i < 5; i++) failed.push(book(run, "0.70400000", "failed_product"));
    const uncertain = book(run, "0.35200000", "uncertain_attempt");
    const drafted = book(run, "0.10000000", "drafted", null);
    const tooMuch = book(run, "5.00000000", "failed_product");
    const total = db.rows(
      `SELECT amount_usd::text,revision::int FROM morrow_billing.unrecovered_costs WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} AND period_start=${period}`,
    )[0];
    const entries = db.rows(
      `SELECT kind,count(*)::int AS n FROM morrow_billing.unrecovered_cost_entries WHERE root_run_id=${literal(run)} GROUP BY kind ORDER BY kind`,
    );
    // 3.872 unrecovered: Opus high (0.704 more) passes 4.50; Haiku low (0.0066) does not.
    const opus = reserve("account_unrecovered", "run_after_opus", "claude_opus_5_5", "high", 1);
    const sonnet = reserve(
      "account_unrecovered",
      "run_after_sonnet",
      "claude_sonnet_5_5",
      "low",
      1,
    );
    const nextPeriodRun = reserve(
      "account_unrecovered",
      "run_next_period",
      "claude_opus_5_5",
      "high",
      1,
      { period: nextPeriod },
    );
    // One more failure pushes past the cap: even Haiku is refused in this period.
    book(run, "0.70400000", "failed_product");
    const haiku = reserve("account_unrecovered", "run_after_haiku", "claude_haiku_5_5", "low", 1);
    const allows = last(
      cmd(
        P.A,
        `SELECT morrow_billing.unrecovered_allows(${literal(O)},${literal(W)},${period},1,0.00660000)::text||'|'||morrow_billing.unrecovered_allows(${literal(O)},${literal(W)},${nextPeriod},1,0.70400000)::text;`,
      ),
    );
    check(
      "C4:unrecovered_ledger_and_cap",
      r.startsWith("reserved|54|") &&
        failed.every((f) => f.startsWith("booked|")) &&
        uncertain === "booked|3.87200000|3.87200000" &&
        drafted === "booked|3.97200000|3.87200000" &&
        tooMuch === "reservation_exceeded||" &&
        total?.amount_usd === "3.87200000" &&
        JSON.stringify(entries) ===
          JSON.stringify([
            { kind: "failed_product", n: 5 },
            { kind: "uncertain_attempt", n: 1 },
          ]) &&
        opus === "unrecovered_cost_cap||" &&
        sonnet.startsWith("reserved|") &&
        nextPeriodRun.startsWith("reserved|") &&
        haiku === "unrecovered_cost_cap||" &&
        allows === "false|true",
      {
        r,
        failed,
        uncertain,
        drafted,
        tooMuch,
        total,
        entries,
        opus,
        sonnet,
        nextPeriodRun,
        haiku,
        allows,
      },
    );
    // The ledger is append-only and monotone.
    check(
      "C4:ledger_append_only",
      refused(
        asCommandRole(
          P.A,
          `UPDATE morrow_billing.unrecovered_costs SET amount_usd=0,revision=revision+1 WHERE period_start=${period};`,
        ),
        "UNRECOVERED_COST_INVALID",
      ) &&
        refused(
          `SET ROLE morrow_work_owner; UPDATE morrow_billing.unrecovered_cost_entries SET amount_usd=1;`,
          "BILLING_RECORD_IMMUTABLE",
        ) &&
        refused(
          `SET ROLE morrow_work_owner; DELETE FROM morrow_billing.unrecovered_costs;`,
          "BILLING_RECORD_IMMUTABLE",
        ),
    );
    for (const id of ["run_after_sonnet", "run_next_period"]) release(id);
    // Settling the failing run charges only drafted products (none here): nothing consumed.
    check("C4:failed_products_not_charged", release(run) === "released|0");
  }

  // -------------------------------------------------------------------------
  phase("catalogue_version");
  {
    // C6: a reservation keeps its catalogue version; after version 2 is active (sim: the
    // shape of a future catalogue migration), version 1 is refused for new runs but the
    // open run books and settles at its own version.
    fund("account_version", 100);
    const before = reserve("account_version", "run_v1", "claude_sonnet_5_5", "low", 2, {
      period: laterPeriod,
    });
    db.sql(`BEGIN; SET LOCAL ROLE morrow_work_owner;
ALTER TABLE morrow_work.model_catalogue_versions DISABLE TRIGGER append_only;
UPDATE morrow_work.model_catalogue_versions SET status='retired' WHERE version=1;
ALTER TABLE morrow_work.model_catalogue_versions ENABLE TRIGGER append_only;
INSERT INTO morrow_work.model_catalogue_versions VALUES(2,'active','${"b".repeat(64)}','claude_sonnet_5_5','low',1,25,7.00000000,25.00000000,4.50000000);
INSERT INTO morrow_work.model_catalogue_entries VALUES(2,'claude_sonnet_5_5','low',2,0.26400000,0.13200000,25);
COMMIT;`);
    const retired = reserve("account_version", "run_v1_late", "claude_sonnet_5_5", "low", 2, {
      period: laterPeriod,
    });
    const v2 = reserve("account_version", "run_v2", "claude_sonnet_5_5", "low", 2, {
      period: laterPeriod,
      version: 2,
    });
    const bookOld = book("run_v1", "0.13200000", "drafted", null);
    const settleOld = settle("run_v1", 2);
    check(
      "C6:booked_at_the_runs_recorded_version",
      before === "reserved|2|0.26400000" &&
        retired === "catalogue_inactive||" &&
        v2 === "reserved|4|0.52800000" &&
        bookOld === "booked|0.13200000|0.00000000" &&
        settleOld === "settled|2" &&
        reservation("run_v1").catalogue_version === 1 &&
        reservation("run_v2").catalogue_version === 2,
      { before, retired, v2, bookOld, settleOld },
    );
    release("run_v2");
    db.sql(`BEGIN; SET LOCAL ROLE morrow_work_owner;
ALTER TABLE morrow_work.model_catalogue_versions DISABLE TRIGGER append_only;
UPDATE morrow_work.model_catalogue_versions SET status='retired' WHERE version=2;
UPDATE morrow_work.model_catalogue_versions SET status='active' WHERE version=1;
ALTER TABLE morrow_work.model_catalogue_versions ENABLE TRIGGER append_only;
COMMIT;`);
  }

  // -------------------------------------------------------------------------
  phase("refusals");
  {
    // C7: a duplicate run, no wallet, no billing period, an unknown key, another tenant.
    fund("account_refusals", 100);
    reserve("account_refusals", "run_dup", "claude_haiku_5_5", "low", 1, { period: laterPeriod });
    const results = {
      duplicate: reserve("account_refusals", "run_dup", "claude_haiku_5_5", "low", 1, {
        period: laterPeriod,
      }),
      noWallet: reserve("account_missing", "run_nw", "claude_haiku_5_5", "low", 1, {
        period: laterPeriod,
      }),
      noPeriod: reserve("account_refusals", "run_np", "claude_haiku_5_5", "low", 1, {
        period: "NULL",
      }),
      unknownKey: reserve("account_refusals", "run_uk", "claude_opus_9", "low", 1, {
        period: laterPeriod,
      }),
      xhigh: reserve("account_refusals", "run_xh", "claude_opus_5_5", "xhigh", 1, {
        period: laterPeriod,
      }),
      zero: reserve("account_refusals", "run_zero", "claude_haiku_5_5", "low", 0, {
        period: laterPeriod,
      }),
      // Y (another organization) names A's tenant: its policies hide A's wallet.
      otherTenant: reserve("account_refusals", "run_y", "claude_haiku_5_5", "low", 1, {
        period: laterPeriod,
        p: P.Y,
      }),
    };
    check(
      "C7:refusals",
      results.duplicate === "duplicate||" &&
        results.noWallet === "wallet_not_found||" &&
        results.noPeriod === "no_billing_period||" &&
        results.unknownKey === "catalogue_inactive||" &&
        results.xhigh === "catalogue_inactive||" &&
        results.zero === "run_product_limit||" &&
        results.otherTenant === "wallet_not_found||" &&
        wallet("account_refusals").reserved === 1,
      results,
    );
    // The api reads its tenant's reservations column by column, never the ledger, and
    // cannot call a helper.
    const apiRows = db.rows("SELECT count(*)::int AS n FROM morrow_billing.credit_reservations", {
      user: "morrow_api_worker",
      prefix: asApi(P.A, "").replace(/\nROLLBACK;$/, "\n"),
      suffix: "\nROLLBACK;",
    });
    check(
      "C7:api_reads_reservations_only",
      apiRows[0]?.n >= 1 &&
        refused(
          asApi(P.A, "SELECT count(*) FROM morrow_billing.unrecovered_costs;"),
          "permission denied",
          "morrow_api_worker",
        ) &&
        refused(
          asApi(P.A, reserveCall("account_refusals", "run_api", "claude_haiku_5_5", "low", 1)),
          "permission denied",
          "morrow_api_worker",
        ),
      apiRows,
    );
  }

  // -------------------------------------------------------------------------
  phase("lease");
  {
    // C8: under a run lease, a run step books and settles its own run (tenant_lease); with
    // no lease, nothing; and the lease's tenant never reaches another tenant's rows.
    fund("account_lease", 100);
    reserve("account_lease", "run_lease", "claude_sonnet_5_5", "low", 2, { period: laterPeriod });
    fund("account_lease_y", 100, P.Y);
    reserve("account_lease_y", "run_lease_y", "claude_sonnet_5_5", "low", 2, {
      period: laterPeriod,
      p: P.Y,
      org: P.Y.org,
      ws: P.Y.workspace,
    });
    const [line] = cmd(
      P.A,
      "SELECT concat_ws('|',outcome,lease_id,generation) FROM morrow_work.lease_open('run','run_lease','store_1','connection_1','installation_1');",
    );
    const [opened, leaseId] = line.split("|");
    const runtime = (statements) =>
      last(
        db.sql(
          `BEGIN; SELECT outcome FROM morrow_work.enter_lease(${literal(leaseId)},'1'); ${statements} COMMIT;`,
          {
            user: "morrow_runtime_executor",
          },
        ),
      );
    const booked = runtime(
      "SELECT lab_credits.book('run_lease','entry_lease',0.10000000,'failed_product');",
    );
    const settled = runtime("SELECT lab_credits.settle('run_lease',1);");
    const noLease = last(
      db.sql("BEGIN; SELECT lab_credits.settle('run_lease',1); ROLLBACK;", {
        user: "morrow_runtime_executor",
      }),
    );
    const foreign = runtime(
      `SELECT lab_credits.foreign_settle(${literal(P.Y.org)},${literal(P.Y.workspace)},'run_lease_y');`,
    );
    check(
      "C8:lease_context_books_and_settles_its_own_run",
      opened === "opened" &&
        booked === "booked" &&
        settled === "settled|1" &&
        noLease === "denied" &&
        foreign === "not_found" &&
        reservation("run_lease_y").status === "reserved",
      { opened, booked, settled, noLease, foreign },
    );
  }
  return { checks, failures };
}

async function main() {
  const started = Date.now();
  let result;
  phase("engine_and_migrations");
  try {
    await withWorkDatabase(
      "M3.PR1.run-credits",
      async (db) => {
        result = await runCreditsLab(db);
      },
      { administrator: "createrole" },
    );
  } catch (error) {
    console.error("CREDITS_LAB_FAILED_IN:" + stage);
    throw error;
  }
  phase("report");
  writeArtifact("labs/run-credits.json", {
    task: "M3 PR-1",
    qualification: "local_postgresql17_network_none_run_credits",
    observedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    administrator: "createrole",
    checks: result.checks,
    providerRequests: 0,
    limitations: [
      "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, provider, payment or merchant data.",
      "The wallet is M5 PR-1's, stubbed in this branch and funded as the owner; M5 PR-1 funds it from verified payments.",
      "The run steps are stood in for by lab-only command-owned definers (lab_credits); M3 PR-2 lands the runtime definers.",
      "Catalogue version 2 is installed by superuser maintenance (sim), the shape of a future catalogue migration.",
    ],
  });
  if (result.failures.length) {
    console.log("FAILED: " + result.failures.join(", "));
    process.exitCode = 1;
  } else console.log(`PASS: ${result.checks.length} M3 PR-1 run credit checks.`);
}

await main();
