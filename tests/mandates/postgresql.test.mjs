// lab:mandates (plan row SD12, the routine part; docs/briefs/sd12-schedules-shop-zone.md;
// ADR-0043 items 7, 8 and 9's recurring schedules) against PostgreSQL 17 with the whole
// migration manifest applied by the Neon-shaped createrole administrator. It proves:
//   M1 the slot arithmetic in SQL (the authority) equals packages/work/src/schedules/slots.ts
//      over daylight-saving weeks in six zones (a 30-minute change, a 45-minute offset, changes
//      at midnight, no daylight saving), for every kind;
//   M2 a daylight-saving week, minute by minute: every slot fires exactly once; a local time
//      that does not exist fires once, at the next valid minute; a repeated hour fires once,
//      at its first occurrence; two local times that land on one instant fire once;
//   M3 a missed slot under each missedRun: skip drops a slot outside its 5-minute window and
//      fires one inside it; run_latest_once fires the latest missed slot once inside the
//      24-hour replay horizon and drops the rest; after a long outage nothing bursts;
//   M4 fire_due_schedules (the runtime executor's login, the orchestrator's own statements and
//      decoders): a missed daily slot under run_latest_once fires once and under skip is
//      dropped; the next slot moves past now; an every-15 schedule fires its latest slot;
//   M5 a duplicate fire is refused: a second pass writes nothing, two concurrent passes write
//      one row, a forced second row of a key is refused by its unique key, a slot cannot be
//      moved back, and a key that is not the schedule's own slot is refused;
//   M6 a zone change moves nothing until a tap: Shopify's zone recorded through the vault
//      broker's definer (an old spelling mapped, an unknown name refused); a change raises one
//      Inbox item for the Owner and each schedule's owner and leaves every schedule as it was;
//      the same zone read again changes nothing; only a recipient who is the Owner or the
//      schedule's owner moves a schedule, at the revision they saw; the slot is computed again
//      in the new zone; the item clears when nothing is left; the Owner's override raises the
//      same item, and nobody else may set it;
//   M7 tenancy and logins: a pass fires only the tenant of the schedule it names; the cross-
//      tenant list carries one id per tenant and nothing else; no other login reaches these
//      definers or tables; forged settings in a session that is not the runtime's read nothing;
//   M8 Schedule@1's SQL check equals the TypeScript check on valid and invalid bodies, and every
//      zone of the closed list is one PostgreSQL knows.
// Synthetic fixtures only; no provider, credential or merchant data. Run by `npm run
// lab:mandates` (CI's postgres `work` leg, last).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ianaTimeZones } from "../../packages/contracts/src/time-zones.ts";
import { checkSchedule } from "../../packages/work/src/schedules/schedule.ts";
import {
  daysFromCivil,
  firePlan,
  nextSlotAfter,
  resolveLocalMinute,
  scheduleTriggerKey,
  slotText,
  zoneOffsetMinutes,
} from "../../packages/work/src/schedules/slots.ts";
import { fireSchedulesOnCron } from "../../apps/workers/src/schedule-fire.ts";
import {
  asApi,
  literal,
  seedWorkFixtures,
  sha,
  storeInstallationSql,
  withWorkDatabase,
} from "../tenant-conformance/harness.mjs";

let db, release, started, P;
const A_STORE = "store_m",
  A_CONNECTION = "connection_m",
  A_STORE_INSTALLATION = "storeinst_m",
  A_INSTALLATION = "installation_m",
  Z_STORE = "store_mz",
  Z_CONNECTION = "connection_mz",
  Z_STORE_INSTALLATION = "storeinst_mz",
  Z_INSTALLATION = "installation_mz",
  Y_STORE = "store_my",
  Y_CONNECTION = "connection_my",
  Y_STORE_INSTALLATION = "storeinst_my",
  Y_INSTALLATION = "installation_my";
const ms = "date_trunc('milliseconds',clock_timestamp())";
const body = (fields) => ({
  schemaVersion: 1,
  missedRun: "skip",
  startDate: null,
  endDate: null,
  timeZone: "America/Toronto",
  ...fields,
});
const last = (out) => out.split("\n").at(-1);
const iso = (text) => new Date(text).getTime();

before(async () => {
  let ready;
  const opened = new Promise((resolve) => (ready = resolve));
  started = withWorkDatabase(
    "SD12.mandates",
    (context) => {
      db = context;
      ready();
      return new Promise((resolve) => (release = resolve));
    },
    { administrator: "createrole" },
  );
  await Promise.race([opened, started]);
  P = seedWorkFixtures(db);
  const profile = "profile_mandates";
  db.admin(
    [
      `INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state) VALUES(${literal(profile)},'workos','environment_${"C".repeat(26)}','app_${"C".repeat(26)}','client_${"C".repeat(26)}','https://api.workos.com/user_management/client_${"C".repeat(26)}',1,${literal("a".repeat(64))},1,'active');`,
      // A and Y are their organizations' Owners (their founding principals).
      ...[P.A, P.Y].map(
        (p) =>
          `INSERT INTO morrow_identity.organization_signups VALUES(${literal(p.principal)},${literal(randomUUID())},${literal(sha(p.principal))},${literal(profile)},${literal(p.org)},${literal(p.workspace)},${literal(p.membership)},'owner-bootstrap-v1',clock_timestamp());`,
      ),
      storeInstallationSql({
        org: P.A.org,
        workspace: P.A.workspace,
        principal: P.A.principal,
        storeId: A_STORE,
        connectionId: A_CONNECTION,
        installationId: A_STORE_INSTALLATION,
      }),
      storeInstallationSql({
        org: P.A.org,
        workspace: P.A.workspace,
        principal: P.A.principal,
        storeId: Z_STORE,
        connectionId: Z_CONNECTION,
        installationId: Z_STORE_INSTALLATION,
      }),
      storeInstallationSql({
        org: P.Y.org,
        workspace: P.Y.workspace,
        principal: P.Y.principal,
        storeId: Y_STORE,
        connectionId: Y_CONNECTION,
        installationId: Y_STORE_INSTALLATION,
      }),
    ].join("\n"),
  );
  // One agent installation per store (owner-seeded, as lab:shop-knowledge does).
  for (const [p, store, connection, installation] of [
    [P.A, A_STORE, A_CONNECTION, A_INSTALLATION],
    [P.A, Z_STORE, Z_CONNECTION, Z_INSTALLATION],
    [P.Y, Y_STORE, Y_CONNECTION, Y_INSTALLATION],
  ]) {
    const agent = "agent_" + randomUUID();
    db.admin(`INSERT INTO morrow_identity.principals VALUES(${literal(agent)},'agent',true);
INSERT INTO morrow_identity.agent_principals VALUES(${literal(agent)},'agent',${literal(p.org)},${literal(p.workspace)},'installation',${literal(installation)},date_trunc('milliseconds',clock_timestamp()));`);
    db.workOwner(`BEGIN; INSERT INTO morrow_work.agent_installations(organization_id,workspace_id,id,revision,release_id,release_revision,release_digest,store_id,connection_id,agent_principal_id,owner_principal_id,owner_membership_id,status,scope,grant_refs,configuration_digest,created_at,updated_at)
SELECT ${literal(p.org)},${literal(p.workspace)},${literal(installation)},1,r.id,r.revision,r.digest,${literal(store)},${literal(connection)},${literal(agent)},${literal(p.principal)},${literal(p.membership)},'active',morrow_work.listings_scope(${literal(p.org)},${literal(p.workspace)},${literal(store)},${literal(connection)}),(SELECT jsonb_agg(jsonb_build_object('organizationId',${literal(p.org)},'workspaceId',${literal(p.workspace)},'storeId',${literal(store)},'kind','grant','id','g_ref_'||n,'revision',1,'digest',repeat('a',64))) FROM generate_series(1,3) n),repeat('b',64),t,t FROM morrow_work.agent_releases r, (SELECT ${ms} AS t) x WHERE r.id='morrow.listings' AND r.revision=1; COMMIT;`);
  }
  // Lab-only scaffolding (the local superuser; not a migration object): the cron, minute by
  // minute over a window, through the migration's own fire plan, returning each fired slot.
  db.sql(`CREATE SCHEMA lab_mandates;
CREATE FUNCTION lab_mandates.simulate(b jsonb,p_from timestamptz,p_to timestamptz,p_step interval,p_down_from timestamptz,p_down_to timestamptz)
RETURNS TABLE(slot text) LANGUAGE plpgsql AS $$
DECLARE v_next timestamptz; v_now timestamptz:=p_from; p record;
BEGIN
 v_next:=morrow_work.schedule_next_slot(b,p_from);
 WHILE v_now<=p_to AND v_next IS NOT NULL LOOP
  IF v_next<=v_now AND NOT (v_now>=p_down_from AND v_now<p_down_to) THEN
   SELECT * INTO p FROM morrow_work.schedule_fire_plan(b,v_next,v_now);
   IF p.fire IS NOT NULL THEN slot:=morrow_work.utc_text(p.fire); RETURN NEXT; END IF;
   v_next:=p.next;
  END IF;
  v_now:=v_now+p_step;
 END LOOP;
END $$;`);
});
after(async () => {
  release?.();
  await started;
});

// A schedule of A's (or Y's) installation, owner-seeded (a routine's writer arrives with build
// order PR 21); its next slot is computed by the schedule's guard from created_at.
function createSchedule({
  p = P.A,
  store = A_STORE,
  connection = A_CONNECTION,
  installation = A_INSTALLATION,
  owner = P.A.principal,
  fields,
  createdAt = ms,
  status = "active",
}) {
  const id = randomUUID();
  db.workOwner(`INSERT INTO morrow_work.schedules(organization_id,workspace_id,id,revision,store_id,connection_id,installation_id,owner_principal_id,purpose,body,time_zone,status,revision_reason,revised_by_kind,created_at,updated_at)
SELECT ${literal(p.org)},${literal(p.workspace)},${literal(id)},1,${literal(store)},${literal(connection)},${literal(installation)},${literal(owner)},'mandate_routine',b,b->>'timeZone',${literal(status)},'created','system',t,t FROM (SELECT ${literal(JSON.stringify(body(fields)))}::jsonb AS b,${createdAt} AS t) x;`);
  return id;
}
const scheduleRow = (id) =>
  db.rows(
    `SELECT revision::int AS revision,time_zone,status,morrow_work.utc_text(next_slot_at) AS next,morrow_work.utc_text(last_slot_at) AS last FROM morrow_work.schedules WHERE id=${literal(id)}`,
  )[0];
const triggers = (id) =>
  db.rows(
    `SELECT trigger_key,status,morrow_work.utc_text(due_at) AS due,morrow_work.utc_text(expires_at) AS expires,schedule_revision::int AS revision FROM morrow_work.mandate_triggers WHERE schedule_id=${literal(id)} ORDER BY due_at`,
  );
const fire = (id, user = "morrow_runtime_executor") =>
  db.rows(`SELECT * FROM morrow_work.fire_due_schedules(${literal(id)})`, { user })[0];
const api = (p, statement) =>
  last(db.sql(asApi(p, statement, { end: "COMMIT" }), { user: "morrow_api_worker" }));
const vaultZone = (installation, zone, source) =>
  last(
    db.sql(
      `SELECT morrow_vault.shopify_zone_record(${literal(installation)},${literal(zone)},${literal(source)});`,
      { user: "morrow_vault_broker" },
    ),
  );
const slotsSql = (b, from, n) =>
  db
    .rows(
      `WITH RECURSIVE s(n,at) AS (SELECT 0,${literal(from)}::timestamptz UNION ALL SELECT n+1,morrow_work.schedule_next_slot(${literal(JSON.stringify(b))}::jsonb,at) FROM s WHERE n<${n} AND at IS NOT NULL) SELECT morrow_work.utc_text(at) AS at FROM s WHERE n>0 ORDER BY n`,
    )
    .map((r) => (r.at === null ? null : slotText(iso(r.at))));
const slotsTs = (b, from, n) => {
  const out = [];
  let at = iso(from);
  for (let i = 0; i < n && at !== null; i++) {
    at = nextSlotAfter(b, at);
    out.push(at === null ? null : slotText(at));
  }
  return out;
};

test("M1: SQL slots equal the TypeScript twin over daylight-saving weeks in six zones", () => {
  const zones = {
    "America/Toronto": ["2026-03-05T00:00:00Z", "2026-10-29T00:00:00Z"],
    "Europe/London": ["2026-03-26T00:00:00Z", "2026-10-22T00:00:00Z"],
    "Australia/Lord_Howe": ["2026-04-01T00:00:00Z", "2026-09-30T00:00:00Z"],
    "Pacific/Chatham": ["2026-04-01T00:00:00Z", "2026-09-23T00:00:00Z"],
    "America/Havana": ["2026-03-05T00:00:00Z", "2026-10-29T00:00:00Z"],
    "Asia/Kolkata": ["2026-03-05T00:00:00Z", "2026-10-29T00:00:00Z"],
  };
  const kinds = [
    { kind: "daily", times: ["00:00", "01:30", "02:30", "03:00"] },
    { kind: "every", everyMinutes: 15 },
    { kind: "every", everyMinutes: 120 },
    { kind: "weekly", daysOfWeek: ["sat", "sun"], time: "02:15" },
    { kind: "monthly", dayOfMonth: "last", time: "01:45" },
    { kind: "monthly", dayOfMonth: 4, time: "02:30" },
  ];
  let compared = 0;
  for (const [zone, starts] of Object.entries(zones))
    for (const start of starts)
      for (const k of kinds) {
        const b = body({ ...k, timeZone: zone });
        const n = k.kind === "every" && k.everyMinutes === 15 ? 480 : 40;
        assert.deepEqual(slotsSql(b, start, n), slotsTs(b, start, n), zone + " " + k.kind);
        compared += n;
      }
  // Bounded schedules end on their last local date in both.
  const bounded = body({
    kind: "daily",
    times: ["09:00"],
    startDate: "2026-11-02",
    endDate: "2026-11-04",
  });
  assert.deepEqual(
    slotsSql(bounded, "2026-10-01T00:00:00Z", 4),
    slotsTs(bounded, "2026-10-01T00:00:00Z", 4),
  );
  assert.deepEqual(slotsTs(bounded, "2026-10-01T00:00:00Z", 4), [
    "2026-11-02T14:00:00Z",
    "2026-11-03T14:00:00Z",
    "2026-11-04T14:00:00Z",
    null,
  ]);
  assert.equal(compared, 12 * (480 + 5 * 40));
});

test("M2: a daylight-saving week, minute by minute, fires every slot once", () => {
  const simulate = (b, from, to, downFrom = from, downTo = from) =>
    db
      .rows(
        `SELECT slot FROM lab_mandates.simulate(${literal(JSON.stringify(b))}::jsonb,${literal(from)},${literal(to)},interval '1 minute',${literal(downFrom)},${literal(downTo)})`,
      )
      .map((r) => slotText(iso(r.slot)));
  // Spring forward in Toronto (2026-03-08, 02:00 EST becomes 03:00 EDT): 02:30 does not exist
  // and fires once at 03:00 EDT (07:00Z), and 03:00 lands on the same instant: one fire.
  const spring = body({ kind: "daily", times: ["01:30", "02:30", "03:00"] });
  const springFired = simulate(spring, "2026-03-05T00:00:00Z", "2026-03-12T00:00:00Z");
  assert.equal(springFired.length, 7 * 3 - 1);
  assert.deepEqual(springFired, slotsTs(spring, "2026-03-05T00:00:00Z", springFired.length));
  assert.deepEqual(
    springFired.filter((s) => s.startsWith("2026-03-08")),
    ["2026-03-08T06:30:00Z", "2026-03-08T07:00:00Z"],
  );
  assert.equal(new Set(springFired).size, springFired.length);
  // Fall back (2026-11-01, 02:00 EDT becomes 01:00 EST): 01:30 happens twice and fires once, at
  // its first occurrence (05:30Z); an every-15 schedule fires 01:00 to 01:45 once each.
  const fall = body({ kind: "daily", times: ["01:30"] });
  const fallFired = simulate(fall, "2026-10-31T00:00:00Z", "2026-11-03T00:00:00Z");
  assert.deepEqual(fallFired, [
    "2026-10-31T05:30:00Z",
    "2026-11-01T05:30:00Z",
    "2026-11-02T06:30:00Z",
  ]);
  const quarter = body({ kind: "every", everyMinutes: 15 });
  const quarterFired = simulate(quarter, "2026-11-01T04:00:00Z", "2026-11-01T08:00:00Z");
  assert.deepEqual(
    quarterFired.filter((s) => s >= "2026-11-01T05:00:00Z" && s < "2026-11-01T07:15:00Z"),
    [
      "2026-11-01T05:00:00Z",
      "2026-11-01T05:15:00Z",
      "2026-11-01T05:30:00Z",
      "2026-11-01T05:45:00Z",
      "2026-11-01T07:00:00Z",
    ],
  );
  // Every slot of an every-15 schedule over three days around the spring change fires once,
  // and no two fires are less than 15 minutes apart: 02:00 to 02:45 do not exist and land on
  // 03:00 with it, so the fires stay 15 real minutes apart, 288 in 72 hours.
  const week = simulate(quarter, "2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z");
  assert.equal(week.length, 288);
  assert.deepEqual(
    week.filter((s) => s >= "2026-03-08T06:30:00Z" && s <= "2026-03-08T07:15:00Z"),
    [
      "2026-03-08T06:30:00Z",
      "2026-03-08T06:45:00Z",
      "2026-03-08T07:00:00Z",
      "2026-03-08T07:15:00Z",
    ],
  );
  assert.deepEqual(week, slotsTs(quarter, "2026-03-07T00:00:00Z", week.length));
  for (let i = 1; i < week.length; i++) assert.ok(iso(week[i]) - iso(week[i - 1]) >= 15 * 60_000);
  // Lord Howe's 30-minute change: 02:15 does not exist on 2026-10-04 and fires at 02:30 LHDT.
  const howe = body({ kind: "daily", times: ["02:15"], timeZone: "Australia/Lord_Howe" });
  assert.ok(
    simulate(howe, "2026-10-02T00:00:00Z", "2026-10-05T00:00:00Z").includes("2026-10-03T15:30:00Z"),
  );
});

test("M3: a missed slot under each missedRun, and no burst after an outage", () => {
  const plan = (b, next, now) =>
    db.rows(
      `SELECT morrow_work.utc_text(fire) AS fire,morrow_work.utc_text(next) AS next,missed FROM morrow_work.schedule_fire_plan(${literal(JSON.stringify(b))}::jsonb,${literal(next)},${literal(now)})`,
    )[0];
  const skip = body({ kind: "daily", times: ["09:00"], timeZone: "UTC" });
  const latest = body({
    kind: "daily",
    times: ["09:00"],
    timeZone: "UTC",
    missedRun: "run_latest_once",
  });
  // Three hours late: skip drops it, run_latest_once fires it; both move to tomorrow.
  assert.deepEqual(plan(skip, "2026-07-01T09:00:00Z", "2026-07-01T12:00:00Z"), {
    fire: null,
    next: "2026-07-02T09:00:00.000Z",
    missed: true,
  });
  assert.deepEqual(plan(latest, "2026-07-01T09:00:00Z", "2026-07-01T12:00:00Z"), {
    fire: "2026-07-01T09:00:00.000Z",
    next: "2026-07-02T09:00:00.000Z",
    missed: false,
  });
  // Four minutes late is on time for skip.
  assert.equal(
    plan(skip, "2026-07-01T09:00:00Z", "2026-07-01T09:04:00Z").fire,
    "2026-07-01T09:00:00.000Z",
  );
  // Five days down: run_latest_once fires only the latest slot (inside 24 hours), once.
  assert.deepEqual(plan(latest, "2026-07-01T09:00:00Z", "2026-07-06T10:00:00Z"), {
    fire: "2026-07-06T09:00:00.000Z",
    next: "2026-07-07T09:00:00.000Z",
    missed: true,
  });
  // A weekly slot older than the replay horizon is dropped, not replayed.
  const weekly = body({
    kind: "weekly",
    daysOfWeek: ["mon"],
    time: "09:00",
    timeZone: "UTC",
    missedRun: "run_latest_once",
  });
  assert.equal(plan(weekly, "2026-07-06T09:00:00Z", "2026-07-08T09:00:00Z").fire, null);
  // The TypeScript twin agrees on each.
  assert.equal(
    firePlan(latest, iso("2026-07-01T09:00:00Z"), iso("2026-07-06T10:00:00Z")).fire,
    iso("2026-07-06T09:00:00Z"),
  );
  assert.equal(firePlan(skip, iso("2026-07-01T09:00:00Z"), iso("2026-07-01T12:00:00Z")).fire, null);
  // The cron down from 06:00 to 11:30 over an every-hour schedule: skip replays nothing and
  // resumes at 12:00; run_latest_once fires the latest missed slot (11:00) once at 11:30.
  const hourly = (missedRun) =>
    body({ kind: "every", everyMinutes: 60, timeZone: "UTC", missedRun });
  const simulate = (b) =>
    db
      .rows(
        `SELECT slot FROM lab_mandates.simulate(${literal(JSON.stringify(b))}::jsonb,'2026-07-01T04:30:00Z','2026-07-01T12:30:00Z',interval '1 minute','2026-07-01T06:00:00Z','2026-07-01T11:30:00Z')`,
      )
      .map((r) => slotText(iso(r.slot)));
  assert.deepEqual(simulate(hourly("skip")), ["2026-07-01T05:00:00Z", "2026-07-01T12:00:00Z"]);
  assert.deepEqual(simulate(hourly("run_latest_once")), [
    "2026-07-01T05:00:00Z",
    "2026-07-01T11:00:00Z",
    "2026-07-01T12:00:00Z",
  ]);
});

test("M4: fire_due_schedules fires a missed slot once under run_latest_once and drops it under skip", async () => {
  // A daily slot two hours ago (UTC, on a 5-minute mark), schedules created three days ago.
  const time = last(
    db.sql(
      "SELECT to_char(date_trunc('hour',(now()-interval '2 hours') AT TIME ZONE 'UTC')+floor(extract(minute FROM (now()-interval '2 hours') AT TIME ZONE 'UTC')/5)*interval '5 minutes','HH24:MI');",
    ),
  );
  const created = `${ms}-interval '3 days'`;
  const latest = createSchedule({
    fields: { kind: "daily", times: [time], timeZone: "UTC", missedRun: "run_latest_once" },
    createdAt: created,
  });
  const skipped = createSchedule({
    fields: { kind: "daily", times: [time], timeZone: "UTC" },
    createdAt: created,
  });
  const before = scheduleRow(latest);
  assert.equal(before.status, "active");
  assert.ok(iso(before.next) < Date.now() - 2 * 86_400_000);
  const r = fire(latest);
  assert.equal(r.outcome, "fired");
  assert.ok(Number(r.examined) >= 2);
  const fired = triggers(latest);
  assert.equal(fired.length, 1);
  const slot = iso(fired[0].due);
  assert.ok(slot < Date.now() - 115 * 60_000 && slot > Date.now() - 130 * 60_000, fired[0].due);
  assert.equal(fired[0].trigger_key, scheduleTriggerKey(latest, slot));
  assert.equal(fired[0].status, "pending");
  assert.equal(iso(fired[0].expires) - slot, 86_400_000);
  assert.equal(triggers(skipped).length, 0);
  for (const id of [latest, skipped]) {
    const row = scheduleRow(id);
    assert.ok(iso(row.next) > Date.now() && iso(row.next) - slot === 86_400_000, row.next);
  }
  assert.equal(scheduleRow(latest).last, fired[0].due);
  assert.equal(scheduleRow(skipped).last, null);
  // An every-15 schedule created an hour ago fires its latest quarter hour, through the
  // orchestrator's own transactions, statements and decoders.
  const quarter = createSchedule({
    fields: { kind: "every", everyMinutes: 15, timeZone: "UTC", missedRun: "run_latest_once" },
    createdAt: `${ms}-interval '1 hour'`,
  });
  const t0 = Date.now();
  const run = await fireSchedulesOnCron(runtimePool());
  const t1 = Date.now();
  assert.equal(run.outcome, "fired");
  assert.equal(run.unavailable, 0);
  const quarterFired = triggers(quarter);
  assert.equal(quarterFired.length, 1);
  const floor15 = (t) => Math.floor(t / 900_000) * 900_000;
  assert.ok([floor15(t0), floor15(t1)].includes(iso(quarterFired[0].due)), quarterFired[0].due);
});

// The runtime executor's pool, as the orchestrator builds it (one connection per transaction).
function runtimePool() {
  const connector = db.connector({ user: "morrow_runtime_executor" });
  return {
    async connect(control) {
      const connection = await connector.open({
        signal: control.signal,
        deadlineMs: control.deadlineMs,
        waitUntil() {},
      });
      return {
        query: (text, values, c) => connection.query(text, [...values], c.signal),
        release: () => connection.close(),
      };
    },
  };
}

test("M5: a duplicate fire is refused", async () => {
  const created = `${ms}-interval '2 days'`;
  const fields = { kind: "every", everyMinutes: 60, timeZone: "UTC", missedRun: "run_latest_once" };
  const id = createSchedule({ fields, createdAt: created });
  assert.equal(fire(id).outcome, "fired");
  assert.equal(triggers(id).length, 1);
  // A second pass at once finds the schedule not due and writes nothing for it.
  assert.equal(fire(id).outcome, "fired");
  assert.equal(triggers(id).length, 1);
  // Two passes racing over a fresh schedule: one row.
  const raced = createSchedule({ fields, createdAt: created });
  const [x, y] = await Promise.all(
    [0, 1].map(() =>
      db.runAsync(`SELECT fired FROM morrow_work.fire_due_schedules(${literal(raced)});`, {
        user: "morrow_runtime_executor",
      }),
    ),
  );
  assert.ok(x.ok && y.ok);
  assert.ok(Number(last(x.stdout)) + Number(last(y.stdout)) >= 1);
  assert.equal(triggers(raced).length, 1);
  // Even the owner cannot write a second row of a key, move a slot back or forge a key.
  const row = triggers(id)[0];
  const forced = db.tryRun(
    `SET ROLE morrow_work_owner; INSERT INTO morrow_work.mandate_triggers SELECT organization_id,workspace_id,gen_random_uuid()::text,store_id,installation_id,kind,trigger_key,'pending',due_at,expires_at,schedule_id,schedule_revision,created_at FROM morrow_work.mandate_triggers WHERE trigger_key=${literal(row.trigger_key)};`,
  );
  assert.equal(forced.ok, false);
  assert.match(forced.stderr, /mandate_triggers_organization_id_workspace_id_trigger_key_key/);
  const back = db.tryRun(
    `SET ROLE morrow_work_owner; UPDATE morrow_work.schedules SET next_slot_at=next_slot_at-interval '1 hour' WHERE id=${literal(id)};`,
  );
  assert.equal(back.ok, false);
  assert.match(back.stderr, /WORK_SCHEDULE_IMMUTABLE/);
  const offSlot = db.tryRun(
    `SET ROLE morrow_work_owner; UPDATE morrow_work.schedules SET next_slot_at=next_slot_at+interval '7 minutes' WHERE id=${literal(id)};`,
  );
  assert.equal(offSlot.ok, false);
  const forged = db.tryRun(
    `SET ROLE morrow_work_owner; INSERT INTO morrow_work.mandate_triggers SELECT organization_id,workspace_id,gen_random_uuid()::text,store_id,installation_id,kind,trigger_key||'x','pending',due_at,expires_at,schedule_id,schedule_revision,created_at FROM morrow_work.mandate_triggers WHERE trigger_key=${literal(row.trigger_key)};`,
  );
  assert.equal(forged.ok, false);
  assert.match(forged.stderr, /mandate_triggers_schedule_key/);
  const admittedTwice = db.tryRun(
    `SET ROLE morrow_work_owner; UPDATE morrow_work.mandate_triggers SET due_at=due_at+interval '1 hour',expires_at=expires_at+interval '1 hour' WHERE trigger_key=${literal(row.trigger_key)};`,
  );
  assert.equal(admittedTwice.ok, false);
  assert.match(admittedTwice.stderr, /WORK_TRIGGER_IMMUTABLE|mandate_triggers_schedule_key/);
});

test("M6: a zone change moves nothing until a tap", () => {
  // Shopify's zone at the install: Toronto. Unknown names and other logins record nothing.
  assert.equal(vaultZone(Z_STORE_INSTALLATION, "America/Toronto", "install"), "recorded");
  assert.equal(vaultZone(Z_STORE_INSTALLATION, "Mars/Olympus_Mons", "health"), "unrecognised");
  assert.equal(vaultZone("storeinst_absent", "America/Toronto", "health"), "not_found");
  assert.equal(vaultZone(Z_STORE_INSTALLATION, "America/Toronto", "nightly"), "invalid");
  // A's routine (owner A) and B's report (owner B), both in the shop's zone.
  const onZ = { store: Z_STORE, connection: Z_CONNECTION, installation: Z_INSTALLATION };
  const s1 = createSchedule({ ...onZ, fields: { kind: "daily", times: ["09:00"] } });
  const s2 = createSchedule({
    ...onZ,
    owner: P.B.principal,
    fields: { kind: "weekly", daysOfWeek: ["mon"], time: "08:00", missedRun: "run_latest_once" },
  });
  const before1 = scheduleRow(s1),
    before2 = scheduleRow(s2);
  // The same zone read again changes nothing.
  assert.equal(vaultZone(Z_STORE_INSTALLATION, "America/Toronto", "health"), "unchanged");
  // The shop moves to India; Shopify's old spelling is mapped.
  assert.equal(vaultZone(Z_STORE_INSTALLATION, "Asia/Calcutta", "health"), "recorded");
  const zone = db.rows(
    `SELECT shopify_zone,shopify_source,override_zone,revision::int AS revision FROM morrow_work.store_time_zones WHERE store_id=${literal(Z_STORE)}`,
  )[0];
  assert.deepEqual(zone, {
    shopify_zone: "Asia/Kolkata",
    shopify_source: "health",
    override_zone: null,
    revision: 2,
  });
  // Nothing moved by itself.
  assert.deepEqual(scheduleRow(s1), before1);
  assert.deepEqual(scheduleRow(s2), before2);
  // One Inbox item, for the Owner (A) first and each schedule's owner.
  const notices = db.rows(
    `SELECT id::text AS id,from_zone,to_zone,schedule_count,schedule_ids,recipients FROM morrow_work.schedule_zone_notices WHERE store_id=${literal(Z_STORE)} AND cleared_at IS NULL`,
  );
  assert.equal(notices.length, 1);
  const notice = notices[0];
  assert.equal(notice.from_zone, "America/Toronto");
  assert.equal(notice.to_zone, "Asia/Kolkata");
  assert.equal(notice.schedule_count, 2);
  assert.deepEqual(new Set(notice.schedule_ids), new Set([s1, s2]));
  assert.deepEqual(notice.recipients, [P.A.principal, P.B.principal]);
  // Recipients see it; others (C, and Y in another tenant) do not.
  const open = (p) =>
    db
      .sql(
        asApi(
          p,
          "SELECT notice_id||'|'||pending||'|'||to_zone FROM morrow_work.schedule_zone_notices_open();",
        ),
        {
          user: "morrow_api_worker",
        },
      )
      .split("\n")
      .slice(1)
      .filter(Boolean);
  assert.deepEqual(open(P.A), [notice.id + "|2|Asia/Kolkata"]);
  assert.deepEqual(open(P.B), [notice.id + "|2|Asia/Kolkata"]);
  assert.deepEqual(open(P.C), []);
  assert.deepEqual(open(P.Y), []);
  const move = (p, schedule, revision) =>
    api(
      p,
      `SELECT outcome FROM morrow_work.schedule_zone_move(${literal(notice.id)},${literal(schedule)},${literal(String(revision))});`,
    );
  // C is not a recipient; B is neither the Owner nor s1's owner; Y is another tenant.
  assert.equal(move(P.C, s1, 1), "forbidden");
  assert.equal(move(P.B, s1, 1), "forbidden");
  assert.equal(move(P.Y, s1, 1), "not_found");
  assert.equal(move(P.B, s2, 2), "stale");
  // B moves their own report.
  assert.equal(move(P.B, s2, 1), "moved");
  const moved2 = scheduleRow(s2);
  assert.equal(moved2.time_zone, "Asia/Kolkata");
  assert.equal(moved2.revision, 2);
  const revision = db.rows(
    `SELECT reason,actor_kind,actor_principal_id,body->>'timeZone' AS zone FROM morrow_work.schedule_revisions WHERE schedule_id=${literal(s2)} AND revision=2`,
  )[0];
  assert.deepEqual(revision, {
    reason: "zone_moved",
    actor_kind: "human",
    actor_principal_id: P.B.principal,
    zone: "Asia/Kolkata",
  });
  // The next slot is Monday 08:00 in Kolkata (02:30Z), computed in the new zone.
  assert.match(moved2.next, /T02:30:00\.000Z$/);
  assert.equal(new Date(moved2.next).getUTCDay(), 1);
  assert.equal(move(P.B, s2, 2), "unchanged");
  assert.deepEqual(open(P.A), [notice.id + "|1|Asia/Kolkata"]);
  // The Owner moves A's routine; the item clears.
  assert.equal(move(P.A, s1, 1), "moved");
  assert.equal(scheduleRow(s1).time_zone, "Asia/Kolkata");
  assert.match(scheduleRow(s1).next, /T03:30:00\.000Z$/);
  assert.deepEqual(open(P.A), []);
  assert.equal(
    db.rows(
      `SELECT cleared_reason FROM morrow_work.schedule_zone_notices WHERE id=${literal(notice.id)}`,
    )[0].cleared_reason,
    "moved",
  );
  // The Owner's override (and nobody else's) raises the same item and moves nothing.
  const set = (p, value, revision) =>
    api(
      p,
      `SELECT outcome||'|'||COALESCE(effective_zone,'') FROM morrow_work.store_time_zone_set(${literal(Z_STORE)},${literal(value)},${literal(String(revision))});`,
    );
  assert.equal(set(P.B, "Europe/London", 2), "forbidden|");
  assert.equal(set(P.A, "Europe/London", 1), "stale|Asia/Kolkata");
  assert.equal(set(P.A, "Mars/Olympus_Mons", 2), "invalid|");
  assert.equal(set(P.A, "Europe/London", 2), "set|Europe/London");
  assert.equal(scheduleRow(s1).time_zone, "Asia/Kolkata");
  assert.equal(open(P.A).length, 1);
  assert.match(open(P.A)[0], /\|2\|Europe\/London$/);
  // Shopify reads the same zone again: the override still applies; nothing changes.
  assert.equal(vaultZone(Z_STORE_INSTALLATION, "Asia/Kolkata", "health"), "unchanged");
  // Following Shopify's zone again leaves nothing to move: the item clears.
  assert.equal(set(P.A, "", 3), "set|Asia/Kolkata");
  assert.deepEqual(open(P.A), []);
  assert.equal(
    last(
      db.sql(
        `SELECT count(*) FROM morrow_work.schedule_zone_notices WHERE store_id=${literal(Z_STORE)} AND cleared_reason='nothing_to_move';`,
      ),
    ),
    "1",
  );
  // A's read of the store's zone; Y reads nothing of A's.
  assert.equal(
    api(
      P.A,
      `SELECT shopify_zone||'|'||COALESCE(override_zone,'')||'|'||effective_zone||'|'||revision FROM morrow_work.store_time_zone(${literal(Z_STORE)});`,
    ),
    "Asia/Kolkata||Asia/Kolkata|4",
  );
  assert.equal(
    api(P.Y, `SELECT count(*) FROM morrow_work.store_time_zone(${literal(Z_STORE)});`),
    "0",
  );
});

test("M7: tenancy and logins", () => {
  const created = `${ms}-interval '2 days'`;
  const fields = { kind: "every", everyMinutes: 60, timeZone: "UTC", missedRun: "run_latest_once" };
  const a = createSchedule({ fields, createdAt: created });
  const y = createSchedule({
    p: P.Y,
    store: Y_STORE,
    connection: Y_CONNECTION,
    installation: Y_INSTALLATION,
    owner: P.Y.principal,
    fields,
    createdAt: created,
  });
  // The cross-tenant list: exactly one id column, one id per tenant.
  const listed = db.rows("SELECT * FROM morrow_work.schedule_tenants_due()", {
    user: "morrow_runtime_executor",
  });
  assert.ok(listed.every((r) => Object.keys(r).join() === "schedule_id"));
  const tenants = db.rows(
    `SELECT DISTINCT organization_id||'|'||workspace_id AS t FROM morrow_work.schedules WHERE id IN (${listed.map((r) => literal(r.schedule_id)).join(",")})`,
  );
  assert.equal(tenants.length, listed.length);
  assert.equal(listed.length, 2);
  // A pass naming A's schedule fires A's tenant only.
  fire(a);
  assert.equal(triggers(a).length, 1);
  assert.equal(triggers(y).length, 0);
  fire(y);
  assert.equal(triggers(y).length, 1);
  assert.deepEqual(
    db.rows(
      `SELECT organization_id,store_id,installation_id FROM morrow_work.mandate_triggers WHERE schedule_id=${literal(y)}`,
    )[0],
    { organization_id: P.Y.org, store_id: Y_STORE, installation_id: Y_INSTALLATION },
  );
  assert.equal(fire(randomUUID()).outcome, "not_found");
  assert.equal(fire("not-a-uuid").outcome, "invalid");
  // No other login reaches the runtime's definers, the vault's or the tables.
  for (const user of ["morrow_api_worker", "morrow_vault_broker", "morrow_connector_ingress"])
    for (const call of [
      `SELECT * FROM morrow_work.fire_due_schedules(${literal(a)});`,
      "SELECT * FROM morrow_work.schedule_tenants_due();",
    ]) {
      const r = db.tryRun(call, { user });
      assert.equal(r.ok, false, user + " " + call);
      assert.match(r.stderr, /permission denied/);
    }
  for (const user of ["morrow_api_worker", "morrow_runtime_executor", "morrow_connector_ingress"]) {
    const r = db.tryRun(
      `SELECT morrow_vault.shopify_zone_record(${literal(A_STORE_INSTALLATION)},'UTC','health');`,
      { user },
    );
    assert.equal(r.ok, false, user);
    assert.match(r.stderr, /permission denied/);
  }
  for (const table of [
    "schedules",
    "mandate_triggers",
    "store_time_zones",
    "schedule_zone_notices",
    "schedule_revisions",
  ])
    for (const user of ["morrow_runtime_executor", "morrow_vault_broker", "morrow_api_worker"]) {
      const r = db.tryRun(`SELECT count(*) FROM morrow_work.${table};`, { user });
      assert.equal(r.ok, false, user + " " + table);
      assert.match(r.stderr, /permission denied/);
    }
  // The command role with every schedule setting forged, in a session that is not the runtime's
  // or the vault's, reads nothing.
  const forged = last(
    db.sql(
      `BEGIN; SET LOCAL ROLE morrow_work_command; SELECT set_config('morrow.schedule_sweep','due',true),set_config('morrow.schedule_target',${literal(y)},true),set_config('morrow.schedule_fire',${literal(P.Y.org + "|" + P.Y.workspace)},true),set_config('morrow.schedule_zone',${literal(P.Y.org + "|" + P.Y.workspace + "|" + Y_STORE)},true) IS NOT NULL; SELECT (SELECT count(*) FROM morrow_work.schedules)+(SELECT count(*) FROM morrow_work.mandate_triggers)+(SELECT count(*) FROM morrow_work.store_time_zones)+(SELECT count(*) FROM morrow_work.schedule_zone_notices); ROLLBACK;`,
    ),
  );
  assert.equal(forged, "0");
  // The runtime's own login with a forged firing setting: the definer overwrites it, and the
  // tenant comes from the schedule named.
  const fresh = createSchedule({ fields, createdAt: created });
  const r = last(
    db.sql(
      `BEGIN; SELECT set_config('morrow.schedule_fire',${literal(P.Y.org + "|" + P.Y.workspace)},true) IS NOT NULL; SELECT fired FROM morrow_work.fire_due_schedules(${literal(fresh)}); COMMIT;`,
      { user: "morrow_runtime_executor" },
    ),
  );
  assert.ok(Number(r) >= 1);
  assert.equal(triggers(fresh).length, 1);
});

test("M8: Schedule@1's SQL check equals the TypeScript check; every listed zone is PostgreSQL's", () => {
  const bodies = [
    body({ kind: "daily", times: ["09:00"] }),
    body({ kind: "daily", times: ["00:00", "06:00", "12:00", "23:45"] }),
    body({ kind: "daily", times: ["23:55", "00:05"] }),
    body({ kind: "daily", times: ["00:05", "23:55"] }),
    body({ kind: "daily", times: ["09:00", "09:10"] }),
    body({ kind: "daily", times: ["09:00", "08:00"] }),
    body({ kind: "daily", times: ["09:03"] }),
    body({ kind: "daily", times: [] }),
    body({ kind: "daily", times: ["01:00", "02:00", "03:00", "04:00", "05:00"] }),
    body({ kind: "weekly", daysOfWeek: ["mon", "fri"], time: "08:30" }),
    body({ kind: "weekly", daysOfWeek: ["fri", "mon"], time: "08:30" }),
    body({ kind: "weekly", daysOfWeek: ["mon", "mon"], time: "08:30" }),
    body({ kind: "monthly", dayOfMonth: 28, time: "08:30" }),
    body({ kind: "monthly", dayOfMonth: 29, time: "08:30" }),
    body({ kind: "monthly", dayOfMonth: "last", time: "08:30" }),
    body({ kind: "monthly", dayOfMonth: "first", time: "08:30" }),
    body({ kind: "every", everyMinutes: 15 }),
    body({ kind: "every", everyMinutes: 720 }),
    body({ kind: "every", everyMinutes: 45 }),
    body({ kind: "every", everyMinutes: 10 }),
    body({ kind: "once", at: "2026-11-01T00:00:00Z" }),
    body({ kind: "daily", times: ["09:00"], timeZone: "Asia/Calcutta" }),
    body({ kind: "daily", times: ["09:00"], timeZone: "Mars/Olympus_Mons" }),
    body({ kind: "daily", times: ["09:00"], startDate: "2026-02-28", endDate: "2026-03-01" }),
    body({ kind: "daily", times: ["09:00"], startDate: "2026-02-30", endDate: null }),
    body({ kind: "daily", times: ["09:00"], startDate: "2028-02-29", endDate: null }),
    body({ kind: "daily", times: ["09:00"], startDate: "2026-03-02", endDate: "2026-03-01" }),
    { ...body({ kind: "daily", times: ["09:00"] }), extra: true },
    { ...body({ kind: "daily", times: ["09:00"] }), schemaVersion: 2 },
    (({ missedRun, ...rest }) => rest)(body({ kind: "daily", times: ["09:00"] })),
  ];
  const sql = db
    .rows(
      `SELECT morrow_work.schedule_body_valid(b) AS v FROM jsonb_array_elements(${literal(JSON.stringify(bodies))}::jsonb) WITH ORDINALITY x(b,n) ORDER BY n`,
    )
    .map((r) => r.v);
  assert.deepEqual(
    sql,
    bodies.map((b) => checkSchedule(b).ok),
  );
  assert.equal(sql.filter(Boolean).length, 9);
  // Every zone of the closed list is one PostgreSQL knows, and the SQL list is the TypeScript one.
  assert.equal(
    last(
      db.sql(
        `SELECT count(*) FROM unnest(morrow_work.iana_time_zones()) z WHERE NOT EXISTS(SELECT 1 FROM pg_timezone_names n WHERE n.name=z);`,
      ),
    ),
    "0",
  );
  assert.deepEqual(
    db
      .rows("SELECT z FROM unnest(morrow_work.iana_time_zones()) WITH ORDINALITY x(z,n) ORDER BY n")
      .map((r) => r.z),
    [...ianaTimeZones],
  );
  // The resolution of a local minute agrees for one sample of every zone whose rules the two
  // tz databases (PostgreSQL's system tzdata, Node's ICU) agree on around it; a zone whose
  // predicted rules differ between their releases (Morocco's, for one) is data, not
  // arithmetic, and is counted. The database is the authority either way.
  const local = daysFromCivil(2026, 11, 1) * 1440 + 90;
  const wall = local * 60_000;
  const rows = db.rows(
    `SELECT z,morrow_work.utc_text(morrow_work.schedule_resolve_local(z,'2026-11-01 01:30')) AS at,morrow_work.schedule_offset_minutes(z,'2026-10-31T01:30:00Z') AS before,morrow_work.schedule_offset_minutes(z,'2026-11-02T01:30:00Z') AS after FROM unnest(morrow_work.iana_time_zones()) z`,
  );
  const differing = [];
  for (const { z, at, before, after } of rows) {
    if (
      zoneOffsetMinutes(z, wall - 86_400_000) !== before ||
      zoneOffsetMinutes(z, wall + 86_400_000) !== after
    ) {
      differing.push(z);
      continue;
    }
    assert.equal(iso(at), resolveLocalMinute(z, local), z);
  }
  assert.equal(rows.length, ianaTimeZones.length);
  assert.ok(differing.length <= 5, differing.join());
});
