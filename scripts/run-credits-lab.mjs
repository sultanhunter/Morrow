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
//   C4 the unrecovered-cost ledger accrues failed and uncertain bookings and caps nothing
//      (ADR-0036, migration 0047): past the former US$4.50, admission still reserves,
//      while the US$7 run limit and the US$25 daily cap still refuse;
//   C5 Opus high reserves 6 credits per product and admits at most 9 products;
//   C6 a reservation keeps its catalogue version after a newer one is active;
//   C12 after 0047, version 3 is active (Opus 5.5 at medium, ceiling 4, no cap), version 1
//      is retired and refused for new runs, and no later version may carry a cap;
//   C7 refusals: duplicate, no wallet, no billing period, another tenant;
//   C8 the lease context: a run step books and settles its own run only;
//   C9 a booking is recorded by its entry id before any total changes: a repeat replays
//      its recorded result (also after settlement), anything else under the id conflicts,
//      and every booking needs an id;
//   C10 a wallet the settling context cannot see is a refusal that leaves the reservation
//      open, never a settlement that strands the reserved credits;
//   C11 a lease context cannot create a wallet (0033 adds no INSERT policy), and its UPDATE
//      that raises available without a credit grant or lowers consumed is refused by M5's
//      wallet_guard; a sum-preserving move of its own wallet passes, another tenant's
//      wallet is invisible; with no lease, the UPDATE itself matches no row. Relaxing 0033's
//      tenant_lease_read alone (sim) shows the wallet and still moves nothing; relaxing
//      tenant_lease_update with it lets the move through (PostgreSQL applies a table's
//      SELECT policies to the rows an UPDATE reads, so both must admit the row); restored.
// The wallets are M5 PR-1's (0029): one Morrow-direct billing account and wallet per
// workspace, so each scenario reserves from its own synthetic workspace's wallet. Each wallet
// is born empty through wallet_guard; its funding (M5's grant-funded increase from a verified
// payment, proved by lab:billing) is superuser maintenance with that guard disabled for the
// one update (sim). Every run move then goes through M5's guard. Owner-seeded synthetic
// fixtures only; no provider, credential or merchant data. CI pg-linking.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
-- C11: direct wallet writes in the entered lease context (no helper), the shapes a run step
-- definer could attempt.
CREATE FUNCTION lab_credits.wallet_insert(p_account text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE l record;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND THEN RETURN 'denied'; END IF;
 INSERT INTO morrow_billing.credit_wallets(organization_id,workspace_id,billing_account_id,available,reserved,consumed,rate_revision,
  terms_revision,revision,created_at,updated_at)
  SELECT l.organization_id,l.workspace_id,p_account,0,0,0,1,1,1,t,t FROM (SELECT date_trunc('milliseconds',clock_timestamp()) AS t) x;
 RETURN 'inserted';
END $$;
CREATE FUNCTION lab_credits.wallet_move(p_org text,p_ws text,p_account text,p_available bigint,p_reserved bigint,p_consumed bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE l record; n integer;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND THEN RETURN 'denied'; END IF;
 UPDATE morrow_billing.credit_wallets x SET available=x.available+p_available,reserved=x.reserved+p_reserved,consumed=x.consumed+p_consumed,
  revision=x.revision+1,updated_at=greatest(date_trunc('milliseconds',clock_timestamp()),x.updated_at)
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.billing_account_id=p_account;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN 'moved|'||n;
END $$;
-- C11: the same UPDATE, and a read of the wallet, with no lease check of their own, so
-- that without a lease nothing but the wallet's row policies (0033's tenant_lease_read and
-- tenant_lease_update) stands between them and the row.
CREATE FUNCTION lab_credits.wallet_seen(p_org text,p_ws text,p_account text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 RETURN 'seen|'||(SELECT count(*) FROM morrow_billing.credit_wallets x WHERE x.organization_id=p_org AND x.workspace_id=p_ws
  AND x.billing_account_id=p_account);
END $$;
CREATE FUNCTION lab_credits.wallet_move_unchecked(p_org text,p_ws text,p_account text,p_available bigint,p_reserved bigint,
 p_consumed bigint) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE n integer;
BEGIN
 UPDATE morrow_billing.credit_wallets x SET available=x.available+p_available,reserved=x.reserved+p_reserved,consumed=x.consumed+p_consumed,
  revision=x.revision+1,updated_at=greatest(date_trunc('milliseconds',clock_timestamp()),x.updated_at)
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.billing_account_id=p_account;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN 'moved|'||n;
END $$;
ALTER FUNCTION lab_credits.book(text,text,numeric,text) OWNER TO morrow_work_command;
ALTER FUNCTION lab_credits.settle(text,integer) OWNER TO morrow_work_command;
ALTER FUNCTION lab_credits.foreign_settle(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION lab_credits.wallet_insert(text) OWNER TO morrow_work_command;
ALTER FUNCTION lab_credits.wallet_move(text,text,text,bigint,bigint,bigint) OWNER TO morrow_work_command;
ALTER FUNCTION lab_credits.wallet_move_unchecked(text,text,text,bigint,bigint,bigint) OWNER TO morrow_work_command;
ALTER FUNCTION lab_credits.wallet_seen(text,text,text) OWNER TO morrow_work_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lab_credits FROM PUBLIC;
GRANT USAGE ON SCHEMA lab_credits TO morrow_runtime_executor;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lab_credits TO morrow_runtime_executor;`;

export async function runCreditsLab(db) {
  phase("fixtures");
  const P = seedWorkFixtures(db);
  db.sql(probes);
  // 0033's two lease policies on the wallet as migrated: C10 and C11 relax them (sim) and
  // C11 proves they are restored exactly.
  const leasePolicies = () =>
    db.rows(
      "SELECT policyname,cmd,roles::text AS roles,qual,with_check FROM pg_policies WHERE schemaname='morrow_billing' AND tablename='credit_wallets' AND policyname IN ('tenant_lease_read','tenant_lease_update') ORDER BY policyname",
    );
  const migrated = leasePolicies();
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
  // M5 PR-1's billing terms (the wallet's terms revision) and one workspace per account.
  const terms = JSON.parse(readFileSync("docs/decisions/billing-terms.json", "utf8")).environments
    .development[0];
  db.workOwner(
    `INSERT INTO morrow_billing.billing_terms VALUES(1,${literal(JSON.stringify(terms.terms))}::jsonb,${literal(JSON.stringify(terms.offers))}::jsonb,${literal(terms.digest)},${ms});`,
  );
  const accounts = new Map();
  const runs = new Map();
  const accountOf = (account) => accounts.get(account) ?? { p: P.A, org: O, ws: W };
  // The principal in the workspace of a run (or of the default tenant).
  const runTenant = (run) => {
    const ws = runs.get(run) ?? W;
    const owner = [...accounts.values()].find((a) => a.ws === ws)?.p ?? P.A;
    return { p: owner, org: owner.org, ws };
  };
  const fund = (account, credits, p = P.A) => {
    const ws = "ws_" + account;
    db.admin(`INSERT INTO morrow_identity.workspaces VALUES(${literal(ws)},${literal(p.org)},'Synthetic credits',true);
INSERT INTO morrow_identity.workspace_memberships VALUES(${literal(p.org)},${literal(ws)},${literal(p.membership)},true);`);
    db.workOwner(`INSERT INTO morrow_billing.billing_accounts(organization_id,workspace_id,id,route,mode,currency,status,revision,created_at,updated_at)
 SELECT ${literal(p.org)},${literal(ws)},${literal(account)},'morrow_direct','test','USD','active',1,t,t FROM (SELECT ${ms} AS t) x;
INSERT INTO morrow_billing.credit_wallets(organization_id,workspace_id,billing_account_id,available,reserved,consumed,rate_revision,terms_revision,revision,created_at,updated_at)
 SELECT ${literal(p.org)},${literal(ws)},${literal(account)},0,0,0,1,1,1,t,t FROM (SELECT ${ms} AS t) x;`);
    // sim: M5's grant-funded increase, as superuser maintenance with the guard disabled.
    db.sql(`BEGIN; ALTER TABLE morrow_billing.credit_wallets DISABLE TRIGGER wallet_guard;
UPDATE morrow_billing.credit_wallets SET available=${credits},revision=revision+1 WHERE organization_id=${literal(p.org)} AND workspace_id=${literal(ws)} AND billing_account_id=${literal(account)};
ALTER TABLE morrow_billing.credit_wallets ENABLE TRIGGER wallet_guard; COMMIT;`);
    accounts.set(account, { p: { ...p, workspace: ws }, org: p.org, ws });
  };
  const wallet = (account) => {
    const a = accountOf(account);
    return db.rows(
      `SELECT available::int,reserved::int,consumed::int,revision::int FROM morrow_billing.credit_wallets WHERE organization_id=${literal(a.org)} AND workspace_id=${literal(a.ws)} AND billing_account_id=${literal(account)}`,
    )[0];
  };
  const period = "timestamptz '2026-10-01T00:00:00Z'";
  const nextPeriod = "timestamptz '2026-11-01T00:00:00Z'";
  // C6-C8 run in later periods: C4 leaves October's unrecovered cost past the former cap.
  const laterPeriod = "timestamptz '2027-01-01T00:00:00Z'";
  const reserveCall = (account, run, model, effort, products, o = {}) => {
    const a = accountOf(account);
    if (!runs.has(run)) runs.set(run, o.ws ?? a.ws);
    return `SELECT outcome||'|'||coalesce(credits_reserved,'')||'|'||coalesce(vendor_maximum_usd,'') FROM morrow_billing.run_reserve(${literal(o.org ?? a.org)},${literal(o.ws ?? a.ws)},${literal(account)},${literal(run)},${literal("credit_" + run)},${literal("vendor_" + run)},${literal("allocation_" + run)},${literal("a".repeat(64))},${o.version ?? 3},${literal(model)},${literal(effort)},${products},${o.period === undefined ? period : o.period});`;
  };
  const reserve = (account, run, model, effort, products, o = {}) =>
    last(
      cmd(
        o.p ?? accountOf(account).p,
        reserveCall(account, run, model, effort, products, o),
        o.end ?? "COMMIT",
      ),
    );
  const book = (run, amount, kind, entry = "entry_" + randomUUID()) => {
    const t = runTenant(run);
    return last(
      cmd(
        t.p,
        `SELECT outcome||'|'||coalesce(booked_usd,'')||'|'||coalesce(unrecovered_usd,'') FROM morrow_billing.run_book_cost(${literal(t.org)},${literal(t.ws)},${literal(run)},${literal(entry)},${amount}::numeric,${literal(kind)});`,
      ),
    );
  };
  const settle = (run, drafted) => {
    const t = runTenant(run);
    return last(
      cmd(
        t.p,
        `SELECT outcome||'|'||coalesce(credits_settled,'') FROM morrow_billing.run_settle(${literal(t.org)},${literal(t.ws)},${literal(run)},${drafted});`,
      ),
    );
  };
  const release = (run) => {
    const t = runTenant(run);
    return last(
      cmd(
        t.p,
        `SELECT outcome||'|'||coalesce(credits_settled,'') FROM morrow_billing.run_release(${literal(t.org)},${literal(t.ws)},${literal(run)});`,
      ),
    );
  };
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
            accountOf(account).p,
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
        asCommandRole(
          accountOf(account).p,
          reserveCall(account, second, "claude_opus_5_5", "high", 1),
          {
            end: "COMMIT",
          },
        ),
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
    // The CHECK and the guards hold even against the command role's own writes (M5's
    // wallet_guard: an increase needs the credit grant that funds it).
    const main = accountOf("account_main").p;
    check(
      "C2:guards_refuse_direct_writes",
      refused(
        asCommandRole(
          main,
          `UPDATE morrow_billing.credit_reservations SET credits_settled=credits_reserved+1,status='settled',settled_at=${ms},revision=revision+1 WHERE root_run_id='run_settle_cap';`,
        ),
        "CREDIT_RESERVATION_INVALID|check constraint",
      ) &&
        refused(
          asCommandRole(
            main,
            `UPDATE morrow_billing.credit_wallets SET available=available+5,revision=revision+1 WHERE billing_account_id='account_main';`,
          ),
          "BILLING_WALLET_INVALID",
        ) &&
        refused(
          asCommandRole(
            main,
            `UPDATE morrow_billing.credit_wallets SET reserved=reserved+1,consumed=consumed-1,revision=revision+1 WHERE billing_account_id='account_main';`,
          ),
          "BILLING_WALLET_INVALID",
        ) &&
        refused(
          asCommandRole(
            main,
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
    const booked = book("run_opus_9", "0.50000000", "drafted");
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
    // C4: failed products and uncertain attempts accrue to the period's unrecovered cost.
    // Drafted cost is not unrecovered. A booking never exceeds the reservation. ADR-0036
    // removed the cap: past the former US$4.50, admission still reserves; the per-run and
    // per-day backstops still refuse.
    fund("account_unrecovered", 1000);
    const run = "run_failing";
    const r = reserve("account_unrecovered", run, "claude_opus_5_5", "high", 9);
    const failed = [];
    for (let i = 0; i < 5; i++) failed.push(book(run, "0.70400000", "failed_product"));
    const uncertain = book(run, "0.35200000", "uncertain_attempt");
    const drafted = book(run, "0.10000000", "drafted");
    const tooMuch = book(run, "5.00000000", "failed_product");
    const total = db.rows(
      `SELECT amount_usd::text,revision::int FROM morrow_billing.unrecovered_costs WHERE organization_id=${literal(O)} AND workspace_id=${literal(accountOf("account_unrecovered").ws)} AND period_start=${period}`,
    )[0];
    const entries = db.rows(
      `SELECT kind,count(*)::int AS n FROM morrow_billing.unrecovered_cost_entries WHERE root_run_id=${literal(run)} GROUP BY kind ORDER BY kind`,
    );
    // 3.872 unrecovered: Opus high (0.704 more) would have passed the former 4.50.
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
    // One more failure takes the period past US$4.50: Haiku and Opus are still admitted.
    const past = book(run, "0.70400000", "failed_product");
    const haiku = reserve("account_unrecovered", "run_after_haiku", "claude_haiku_5_5", "low", 1);
    const opusAgain = reserve(
      "account_unrecovered",
      "run_after_opus_again",
      "claude_opus_5_5",
      "high",
      1,
    );
    const pastTotal = db.rows(
      `SELECT amount_usd::text FROM morrow_billing.unrecovered_costs WHERE organization_id=${literal(O)} AND workspace_id=${literal(accountOf("account_unrecovered").ws)} AND period_start=${period}`,
    )[0]?.amount_usd;
    const lost = accountOf("account_unrecovered");
    // unrecovered_allows (0047) is true for a known version, a period and a non-negative worst
    // case, whatever the period's total; false for an unknown version, no period or a negative.
    const allows = last(
      cmd(
        lost.p,
        `SELECT concat_ws('|',morrow_billing.unrecovered_allows(${literal(O)},${literal(lost.ws)},${period},3,0.70400000)::text,morrow_billing.unrecovered_allows(${literal(O)},${literal(lost.ws)},${period},1,99.00000000)::text,morrow_billing.unrecovered_allows(${literal(O)},${literal(lost.ws)},${period},9,0.00660000)::text,morrow_billing.unrecovered_allows(${literal(O)},${literal(lost.ws)},NULL,3,0.00660000)::text,morrow_billing.unrecovered_allows(${literal(O)},${literal(lost.ws)},${period},3,-1)::text,coalesce(morrow_billing.unrecovered_allows(${literal(O)},${literal(lost.ws)},${period},3,NULL)::text,'null'));`,
      ),
    );
    // The backstops still refuse past the former cap: more than the run limit (9 Opus high
    // products, US$7) and, with open reservations, the US$25 daily cap.
    const overRun = reserve("account_unrecovered", "run_over_limit", "claude_opus_5_5", "high", 10);
    const day1 = reserve("account_unrecovered", "run_day_1", "claude_opus_5_5", "high", 9);
    const day2 = reserve("account_unrecovered", "run_day_2", "claude_opus_5_5", "high", 9);
    const day3 = reserve("account_unrecovered", "run_day_3", "claude_opus_5_5", "high", 9);
    check(
      "C4:unrecovered_ledger_without_cap",
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
        opus.startsWith("reserved|6|") &&
        sonnet.startsWith("reserved|") &&
        nextPeriodRun.startsWith("reserved|") &&
        past.startsWith("booked|") &&
        pastTotal === "4.57600000" &&
        haiku.startsWith("reserved|1|") &&
        opusAgain.startsWith("reserved|6|") &&
        allows === "true|true|false|false|false|false" &&
        overRun === "run_product_limit||" &&
        day1.startsWith("reserved|54|") &&
        day2.startsWith("reserved|54|") &&
        day3 === "daily_cap||",
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
        past,
        pastTotal,
        haiku,
        opusAgain,
        allows,
        overRun,
        day1,
        day2,
        day3,
      },
    );
    // The ledger is append-only and monotone.
    check(
      "C4:ledger_append_only",
      refused(
        asCommandRole(
          lost.p,
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
    for (const id of [
      "run_after_sonnet",
      "run_next_period",
      "run_after_opus",
      "run_after_haiku",
      "run_after_opus_again",
      "run_day_1",
      "run_day_2",
    ])
      release(id);
    // Settling the failing run charges only drafted products (none here): nothing consumed.
    check("C4:failed_products_not_charged", release(run) === "released|0");
  }

  // -------------------------------------------------------------------------
  phase("catalogue_version");
  {
    // C6: a reservation keeps its catalogue version; after version 4 is active (sim: the
    // shape of a future catalogue migration, as 0047 published version 3), version 3 is
    // refused for new runs but the open run books and settles at its own version.
    fund("account_version", 100);
    const before = reserve("account_version", "run_v3", "claude_sonnet_5_5", "low", 2, {
      period: laterPeriod,
    });
    db.sql(`BEGIN; SET LOCAL ROLE morrow_work_owner;
ALTER TABLE morrow_work.model_catalogue_versions DISABLE TRIGGER append_only;
UPDATE morrow_work.model_catalogue_versions SET status='retired' WHERE version=3;
ALTER TABLE morrow_work.model_catalogue_versions ENABLE TRIGGER append_only;
INSERT INTO morrow_work.model_catalogue_versions VALUES(4,'active','${"b".repeat(64)}','claude_sonnet_5_5','low',1,25,7.00000000,25.00000000,NULL);
INSERT INTO morrow_work.model_catalogue_entries VALUES(4,'claude_sonnet_5_5','low',2,0.26400000,0.13200000,25);
COMMIT;`);
    const retired = reserve("account_version", "run_v3_late", "claude_sonnet_5_5", "low", 2, {
      period: laterPeriod,
    });
    const v4 = reserve("account_version", "run_v4", "claude_sonnet_5_5", "low", 2, {
      period: laterPeriod,
      version: 4,
    });
    const bookOld = book("run_v3", "0.13200000", "drafted");
    const settleOld = settle("run_v3", 2);
    check(
      "C6:booked_at_the_runs_recorded_version",
      before === "reserved|2|0.26400000" &&
        retired === "catalogue_inactive||" &&
        v4 === "reserved|4|0.52800000" &&
        bookOld === "booked|0.13200000|0.00000000" &&
        settleOld === "settled|2" &&
        reservation("run_v3").catalogue_version === 3 &&
        reservation("run_v4").catalogue_version === 4,
      { before, retired, v4, bookOld, settleOld },
    );
    release("run_v4");
    db.sql(`BEGIN; SET LOCAL ROLE morrow_work_owner;
ALTER TABLE morrow_work.model_catalogue_versions DISABLE TRIGGER append_only;
UPDATE morrow_work.model_catalogue_versions SET status='retired' WHERE version=4;
UPDATE morrow_work.model_catalogue_versions SET status='active' WHERE version=3;
ALTER TABLE morrow_work.model_catalogue_versions ENABLE TRIGGER append_only;
COMMIT;`);
  }

  // -------------------------------------------------------------------------
  phase("adr_0036_catalogue");
  {
    // C12: migration 0047 (ADR-0036). Version 3 is the active version with Opus 5.5 at medium
    // as its default, the default member ceiling 4 and no unrecovered-cost cap; version 1 is
    // retired with its published US$4.50 kept, and a reservation at version 1 is refused. No
    // version but 1 may carry a cap, and version 1 may not lose its own.
    const versions = db.rows(
      "SELECT version::int,status,default_model,default_effort,default_member_credit_ceiling::int AS ceiling,coalesce(workspace_period_unrecovered_cost_cap_usd::text,'none') AS cap FROM morrow_work.model_catalogue_versions WHERE version IN (1,3) ORDER BY version",
    );
    const entries = db.rows(
      "SELECT count(*)::int AS n FROM morrow_work.model_catalogue_entries a JOIN morrow_work.model_catalogue_entries b USING (model_key,effort_key) WHERE a.version=1 AND b.version=3 AND a.credits_per_product=b.credits_per_product AND a.worst_case_per_product_usd=b.worst_case_per_product_usd AND a.worst_case_per_attempt_usd=b.worst_case_per_attempt_usd AND a.run_product_limit=b.run_product_limit",
    )[0]?.n;
    fund("account_adr_0036", 100);
    const atV1 = reserve("account_adr_0036", "run_at_v1", "claude_opus_5_5", "medium", 1, {
      period: laterPeriod,
      version: 1,
    });
    const atDefault = reserve("account_adr_0036", "run_at_v3", "claude_opus_5_5", "medium", 12, {
      period: laterPeriod,
    });
    const overDefault = reserve(
      "account_adr_0036",
      "run_over_v3",
      "claude_opus_5_5",
      "medium",
      13,
      { period: laterPeriod },
    );
    check(
      "C12:version_3_active_without_a_cap",
      JSON.stringify(versions) ===
        JSON.stringify([
          {
            version: 1,
            status: "retired",
            default_model: "claude_sonnet_5_5",
            default_effort: "low",
            ceiling: 1,
            cap: "4.50000000",
          },
          {
            version: 3,
            status: "active",
            default_model: "claude_opus_5_5",
            default_effort: "medium",
            ceiling: 4,
            cap: "none",
          },
        ]) &&
        entries === 9 &&
        atV1 === "catalogue_inactive||" &&
        atDefault === "reserved|48|6.52800000" &&
        overDefault === "run_product_limit||" &&
        // Each attempt rolls back whatever happens, so a missing CHECK cannot leave a row.
        refused(
          `BEGIN; SET LOCAL ROLE morrow_work_owner; INSERT INTO morrow_work.model_catalogue_versions VALUES(5,'retired','${"c".repeat(64)}','claude_sonnet_5_5','low',1,25,7.00000000,25.00000000,4.50000000); ROLLBACK;`,
          "model_catalogue_versions_unrecovered_cap",
        ) &&
        refused(
          `BEGIN; SET LOCAL ROLE morrow_work_owner; ALTER TABLE morrow_work.model_catalogue_versions DISABLE TRIGGER append_only; UPDATE morrow_work.model_catalogue_versions SET workspace_period_unrecovered_cost_cap_usd=NULL WHERE version=1; ROLLBACK;`,
          "model_catalogue_versions_unrecovered_cap",
        ),
      { versions, entries, atV1, atDefault, overDefault },
    );
    release("run_at_v3");
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
      prefix: asApi(accountOf("account_refusals").p, "").replace(/\nROLLBACK;$/, "\n"),
      suffix: "\nROLLBACK;",
    });
    check(
      "C7:api_reads_reservations_only",
      apiRows[0]?.n >= 1 &&
        refused(
          asApi(
            accountOf("account_refusals").p,
            "SELECT count(*) FROM morrow_billing.unrecovered_costs;",
          ),
          "permission denied",
          "morrow_api_worker",
        ) &&
        refused(
          asApi(
            accountOf("account_refusals").p,
            reserveCall("account_refusals", "run_api", "claude_haiku_5_5", "low", 1),
          ),
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
    });
    const [line] = cmd(
      accountOf("account_lease").p,
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
      `SELECT lab_credits.foreign_settle(${literal(P.Y.org)},${literal(accountOf("account_lease_y").ws)},'run_lease_y');`,
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

  // -------------------------------------------------------------------------
  phase("replay");
  {
    // C9: a retried run step repeats its booking: the recorded result comes back and the
    // totals move once; the same entry id with another amount or kind, or on another run,
    // is a conflict; a booking without an id is invalid. After settlement, a repeat still
    // learns the earlier outcome (never `ended`).
    fund("account_replay", 100);
    reserve("account_replay", "run_replay", "claude_sonnet_5_5", "low", 2, { period: laterPeriod });
    reserve("account_replay", "run_replay_b", "claude_sonnet_5_5", "low", 2, {
      period: laterPeriod,
    });
    const first = book("run_replay", "0.05000000", "failed_product", "entry_replay_1");
    const repeat = book("run_replay", "0.05000000", "failed_product", "entry_replay_1");
    const drafted = book("run_replay", "0.02000000", "drafted", "entry_replay_2");
    const draftedRepeat = book("run_replay", "0.02000000", "drafted", "entry_replay_2");
    const otherAmount = book("run_replay", "0.06000000", "failed_product", "entry_replay_1");
    const otherKind = book("run_replay", "0.05000000", "uncertain_attempt", "entry_replay_1");
    const otherRun = book("run_replay_b", "0.05000000", "failed_product", "entry_replay_1");
    const noEntry = last(
      cmd(
        accountOf("account_replay").p,
        `SELECT outcome FROM morrow_billing.run_book_cost(${literal(O)},${literal(accountOf("account_replay").ws)},'run_replay',NULL,0.01000000::numeric,'drafted');`,
      ),
    );
    const r = reservation("run_replay");
    const entries = db.rows(
      `SELECT id,kind,amount_usd::text FROM morrow_billing.run_cost_bookings WHERE root_run_id='run_replay' ORDER BY id`,
    );
    const lost = db.rows(
      `SELECT count(*)::int AS n FROM morrow_billing.unrecovered_cost_entries WHERE root_run_id='run_replay'`,
    )[0].n;
    const settled = settle("run_replay", 1);
    const afterSettle = book("run_replay", "0.02000000", "drafted", "entry_replay_2");
    const lateNew = book("run_replay", "0.01000000", "drafted", "entry_replay_3");
    check(
      "C9:bookings_replay_by_entry_id",
      first === "booked|0.05000000|0.05000000" &&
        repeat === first &&
        drafted === "booked|0.07000000|0.05000000" &&
        draftedRepeat === drafted &&
        otherAmount === "conflict||" &&
        otherKind === "conflict||" &&
        otherRun === "conflict||" &&
        noEntry === "invalid" &&
        r.booked_cost_usd === "0.07000000" &&
        r.unrecovered_cost_usd === "0.05000000" &&
        entries.length === 2 &&
        lost === 1 &&
        settled === "settled|1" &&
        afterSettle === drafted &&
        lateNew === "ended||",
      {
        first,
        repeat,
        drafted,
        draftedRepeat,
        otherAmount,
        otherKind,
        otherRun,
        noEntry,
        r,
        entries,
        lost,
        settled,
        afterSettle,
        lateNew,
      },
    );
    check(
      "C9:bookings_append_only",
      refused(
        `SET ROLE morrow_work_owner; UPDATE morrow_billing.run_cost_bookings SET amount_usd=0;`,
        "BILLING_RECORD_IMMUTABLE",
      ) &&
        refused(
          asCommandRole(
            accountOf("account_replay").p,
            `DELETE FROM morrow_billing.run_cost_bookings;`,
          ),
          "permission denied",
        ),
    );
    release("run_replay_b");
  }

  // -------------------------------------------------------------------------
  phase("hidden_wallet");
  {
    // C10: the wallet hidden from the settling context (sim: the wallet's lease policies
    // admit nothing, the shape of a missing or revised policy on M5's wallet; restored
    // after): run_settle refuses with wallet_not_found, and the reservation and the wallet
    // keep their state, so the credits are never stranded.
    fund("account_hidden", 100);
    reserve("account_hidden", "run_hidden", "claude_sonnet_5_5", "low", 2, { period: laterPeriod });
    const [line] = cmd(
      accountOf("account_hidden").p,
      "SELECT concat_ws('|',outcome,lease_id,generation) FROM morrow_work.lease_open('run','run_hidden','store_1','connection_1','installation_1');",
    );
    const [opened, leaseId] = line.split("|");
    const before = wallet("account_hidden");
    const policy =
      "(organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c)";
    db.sql(
      "ALTER POLICY tenant_lease_read ON morrow_billing.credit_wallets USING (false); ALTER POLICY tenant_lease_update ON morrow_billing.credit_wallets USING (false) WITH CHECK (false);",
    );
    let hidden;
    try {
      hidden = last(
        db.sql(
          `BEGIN; SELECT outcome FROM morrow_work.enter_lease(${literal(leaseId)},'1'); SELECT lab_credits.settle('run_hidden',1); COMMIT;`,
          { user: "morrow_runtime_executor" },
        ),
      );
    } finally {
      db.sql(
        `ALTER POLICY tenant_lease_read ON morrow_billing.credit_wallets USING (${policy}); ALTER POLICY tenant_lease_update ON morrow_billing.credit_wallets USING (${policy}) WITH CHECK (${policy});`,
      );
    }
    const after = wallet("account_hidden");
    check(
      "C10:hidden_wallet_refuses_settlement",
      opened === "opened" &&
        hidden === "wallet_not_found|" &&
        reservation("run_hidden").status === "reserved" &&
        after.reserved === before.reserved &&
        after.available === before.available &&
        after.revision === before.revision &&
        release("run_hidden") === "released|0",
      { opened, hidden, before, after },
    );
  }

  // -------------------------------------------------------------------------
  phase("lease_wallet");
  {
    // C11: the lease twins of 0029's wallet policies (0033) read and update, never insert,
    // and M5's wallet_guard holds in the lease context. A workspace with a billing account
    // and no wallet (owner-seeded) cannot get one from its run lease. Under the funded
    // workspace's run lease, after a settlement (consumed 1): raising available without a
    // credit grant, or a sum-preserving move that lowers consumed, is BILLING_WALLET_INVALID;
    // a sum-preserving reserve passes (rolled back); another tenant's wallet matches no row.
    // No lease: definers with no lease check of their own read the wallet and update it
    // directly, and neither sees the row (the same update under the lease moves it, rolled
    // back). Negative control (sim: 0033's two lease policies relaxed to the wallet's tenant
    // with no lease, then restored to their migrated text): with tenant_lease_read relaxed
    // alone the wallet is visible and still not updated, and with tenant_lease_update
    // relaxed too it moves (rolled back), so the refusal is tenant_lease_update's. The two
    // are relaxed together for the move because PostgreSQL also applies the SELECT policies
    // to the rows an UPDATE reads (its WHERE and SET name the wallet's columns): relaxing
    // tenant_lease_update alone would still match no row. The wallet ends as the settlement
    // left it.
    fund("account_wallet", 100);
    const a = accountOf("account_wallet");
    reserve("account_wallet", "run_wallet", "claude_sonnet_5_5", "low", 2, { period: laterPeriod });
    const leaseOf = (p, run) => {
      const [line] = cmd(
        p,
        `SELECT concat_ws('|',outcome,lease_id,generation) FROM morrow_work.lease_open('run',${literal(run)},'store_1','connection_1','installation_1');`,
      );
      return line.split("|");
    };
    const [opened, leaseId] = leaseOf(a.p, "run_wallet");
    const bare = { ...P.A, workspace: "ws_account_bare" };
    db.admin(`INSERT INTO morrow_identity.workspaces VALUES(${literal(bare.workspace)},${literal(bare.org)},'Synthetic credits',true);
INSERT INTO morrow_identity.workspace_memberships VALUES(${literal(bare.org)},${literal(bare.workspace)},${literal(bare.membership)},true);`);
    db.workOwner(`INSERT INTO morrow_billing.billing_accounts(organization_id,workspace_id,id,route,mode,currency,status,revision,created_at,updated_at)
 SELECT ${literal(bare.org)},${literal(bare.workspace)},'account_bare','morrow_direct','test','USD','active',1,t,t FROM (SELECT ${ms} AS t) x;`);
    const [bareOpened, bareLease] = leaseOf(bare, "run_bare");
    const underLease = (lease, statements, end = "COMMIT") =>
      attempt(
        `BEGIN; SELECT outcome FROM morrow_work.enter_lease(${literal(lease)},'1'); ${statements} ${end};`,
        "morrow_runtime_executor",
      );
    const move = (o, available, reserved, consumed, end) =>
      underLease(
        o.lease ?? leaseId,
        `SELECT lab_credits.wallet_move(${literal(o.org)},${literal(o.ws)},${literal(o.account)},${available},${reserved},${consumed});`,
        end,
      );
    const own = { org: a.org, ws: a.ws, account: "account_wallet" };
    const insert = underLease(bareLease, "SELECT lab_credits.wallet_insert('account_bare');");
    const bareWallets = () =>
      db.rows(
        "SELECT count(*)::int AS n FROM morrow_billing.credit_wallets WHERE billing_account_id='account_bare'",
      )[0].n;
    const settled = underLease(leaseId, "SELECT lab_credits.settle('run_wallet',1);");
    const settledWallet = wallet("account_wallet");
    const raise = move(own, 5, 0, 0);
    const lower = move(own, 1, 0, -1);
    const control = move(own, -1, 1, 0, "ROLLBACK");
    const y = accountOf("account_lease_y");
    const foreign = move({ org: y.org, ws: y.ws, account: "account_lease_y" }, -1, 1, 0);
    const uncheckedMove = `SELECT lab_credits.wallet_move_unchecked(${literal(a.org)},${literal(a.ws)},'account_wallet',-1,1,0);`;
    // With no lease: whether the wallet is visible, then the UPDATE (rolled back).
    const noLeaseMove = () =>
      attempt(
        `BEGIN; SELECT lab_credits.wallet_seen(${literal(a.org)},${literal(a.ws)},'account_wallet'); ${uncheckedMove} ROLLBACK;`,
        "morrow_runtime_executor",
      );
    const leaseMove = underLease(leaseId, uncheckedMove, "ROLLBACK");
    const noLease = noLeaseMove();
    const leasePolicy =
      "(organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c)";
    const tenantOnly = `(organization_id::text,workspace_id::text)=(${literal(a.org)},${literal(a.ws)})`;
    let readRelaxed, bothRelaxed;
    try {
      db.sql(
        `ALTER POLICY tenant_lease_read ON morrow_billing.credit_wallets USING (${tenantOnly});`,
      );
      readRelaxed = noLeaseMove();
      db.sql(
        `ALTER POLICY tenant_lease_update ON morrow_billing.credit_wallets USING (${tenantOnly}) WITH CHECK (${tenantOnly});`,
      );
      bothRelaxed = noLeaseMove();
    } finally {
      db.sql(
        `ALTER POLICY tenant_lease_read ON morrow_billing.credit_wallets USING (${leasePolicy}); ALTER POLICY tenant_lease_update ON morrow_billing.credit_wallets USING (${leasePolicy}) WITH CHECK (${leasePolicy});`,
      );
    }
    const restored = JSON.stringify(leasePolicies()) === JSON.stringify(migrated);
    const noLeaseAgain = noLeaseMove();
    const after = wallet("account_wallet");
    const out = (r) =>
      r.ok ? last(r.stdout) : "error:" + (r.stderr.match(/ERROR:\s*([^\n]*)/)?.[1] ?? "");
    const both = (r) => (r.ok ? r.stdout.split("\n").join("|") : out(r));
    check(
      "C11:lease_context_cannot_create_or_inflate_a_wallet",
      opened === "opened" &&
        bareOpened === "opened" &&
        !insert.ok &&
        /row-level security/.test(insert.stderr) &&
        bareWallets() === 0 &&
        out(settled) === "settled|1" &&
        settledWallet.consumed === 1 &&
        !raise.ok &&
        /BILLING_WALLET_INVALID/.test(raise.stderr) &&
        !lower.ok &&
        /BILLING_WALLET_INVALID/.test(lower.stderr) &&
        out(control) === "moved|1" &&
        out(foreign) === "moved|0" &&
        out(leaseMove) === "moved|1" &&
        both(noLease) === "seen|0|moved|0" &&
        both(readRelaxed) === "seen|1|moved|0" &&
        both(bothRelaxed) === "seen|1|moved|1" &&
        migrated.length === 2 &&
        restored &&
        both(noLeaseAgain) === "seen|0|moved|0" &&
        JSON.stringify(after) === JSON.stringify(settledWallet),
      {
        opened,
        bareOpened,
        insert: out(insert),
        settled: out(settled),
        settledWallet,
        raise: out(raise),
        lower: out(lower),
        control: out(control),
        foreign: out(foreign),
        leaseMove: out(leaseMove),
        noLease: both(noLease),
        readRelaxed: both(readRelaxed),
        bothRelaxed: both(bothRelaxed),
        restored,
        noLeaseAgain: both(noLeaseAgain),
        after,
      },
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
      "The wallets are M5 PR-1's (one billing account per synthetic workspace); funding is superuser maintenance with wallet_guard disabled for that one update (sim), where M5 PR-1 funds them from verified payments (lab:billing).",
      "The run steps are stood in for by lab-only command-owned definers (lab_credits); M3 PR-2 lands the runtime definers.",
      "Catalogue version 4 is installed by superuser maintenance (sim), the shape of a future catalogue migration such as 0047.",
    ],
  });
  if (result.failures.length) {
    console.log("FAILED: " + result.failures.join(", "));
    process.exitCode = 1;
  } else console.log(`PASS: ${result.checks.length} M3 PR-1 run credit checks.`);
}

await main();
