// Plan row SD12, the routine part (docs/briefs/sd12-schedules-shop-zone.md; ADR-0043 items 7, 8
// and 9's recurring schedules), without a database: Schedule@1's contract and checks, the
// closed IANA zone list, the slot arithmetic's daylight-saving and catch-up rules, the
// TypeScript twins pinned to migration schedules-shop-zone's SQL (the zone list and its
// aliases, the windows, the key), the migration's static rules (FORCE RLS, append-only or
// guarded rows, every runtime and vault definer overwriting its settings first, the grants),
// the orchestrator's statements and strict decoders, its cron run over a fake pool, and the
// schedules-v2 switch's committed record and edge:check guard. The PostgreSQL behaviour is
// lab:mandates'.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import {
  canonicalTimeZone,
  ianaTimeZoneAliases,
  ianaTimeZones,
  isIanaTimeZone,
} from "../packages/contracts/src/time-zones.ts";
import { checkSchedule } from "../packages/work/src/schedules/schedule.ts";
import {
  daysFromCivil,
  firePlan,
  nextSlotAfter,
  resolveLocalMinute,
  scheduleMinimumGapMinutes,
  scheduleOnTimeMs,
  scheduleReplayHorizonMs,
  scheduleTriggerKey,
  slotText,
} from "../packages/work/src/schedules/slots.ts";
import {
  decodeScheduleFire,
  decodeScheduleTenantsDue,
  scheduleFireSql,
} from "../packages/work/src/schedules/fire.ts";
import { runtimeExecutorSql } from "../packages/work/src/runtime/leases.ts";
import {
  fireSchedulesOnCron,
  scheduleFireBudget,
  schedulesSwitchOn,
} from "../apps/workers/src/schedule-fire.ts";
import { schedulesV2On, schedulesV2Var } from "../packages/identity/src/broker-protocol.ts";
import {
  edgeSchedulesVar,
  edgeVarNames,
  edgeWorkers,
  reviewedSchedulesRecord,
  verifyEdgeConfig,
} from "../scripts/edge.mjs";

const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const entry = manifest.migrations.find((m) => m.file.endsWith(".schedules-shop-zone.sql"));
const sql = readFileSync("migrations/" + entry.file, "utf8");
const functionText = (name) => {
  const start = sql.search(new RegExp(`CREATE FUNCTION ${name.replace(".", "\\.")}\\(`));
  assert.ok(start >= 0, name);
  const end = sql.indexOf("$$;", sql.indexOf("$$", start) + 2);
  return sql.slice(start, end + 3);
};
const iso = (text) => new Date(text).getTime();
const body = (fields) => ({
  schemaVersion: 1,
  missedRun: "skip",
  startDate: null,
  endDate: null,
  timeZone: "America/Toronto",
  ...fields,
});
const local = (y, m, d, h, mi) => daysFromCivil(y, m, d) * 1440 + h * 60 + mi;
const series = (b, from, n) => {
  const out = [];
  let at = iso(from);
  for (let i = 0; i < n && at !== null; i++) {
    at = nextSlotAfter(b, at);
    out.push(at === null ? null : slotText(at));
  }
  return out;
};

test("Schedule@1: the contract is closed, four kinds, and replaces v1's cron Schedule", () => {
  assert.ok(validateCurrentDefinition("Schedule", body({ kind: "daily", times: ["09:00"] })));
  for (const bad of [
    body({ kind: "once", at: "2026-11-01T00:00:00Z" }),
    body({ kind: "daily", times: ["09:00"], extra: 1 }),
    body({ kind: "daily", times: ["9:00"] }),
    body({ kind: "every", everyMinutes: 5 }),
    { ...body({ kind: "daily", times: ["09:00"] }), schemaVersion: 2 },
    {
      timezone: "America/Toronto",
      expression: "0 9 * * *",
      overlap: "skip",
      missedRun: "skip",
      maximumParallel: 1,
      mandateRef: null,
    },
  ])
    assert.equal(validateCurrentDefinition("Schedule", bad), false, JSON.stringify(bad));
  const changes = JSON.parse(readFileSync("docs/contracts/schemas/v1.1/changes.json", "utf8"));
  const change = changes.changes.find((c) => c.name === "Schedule");
  assert.deepEqual(
    [change.kind, change.replaces, change.adr],
    ["definition", "core:Schedule", "ADR-0043"],
  );
});

test("checkSchedule: the zone exactly on the list, ascending times 15 minutes apart, days in order, real dates", () => {
  const cases = [
    [body({ kind: "daily", times: ["09:00"] }), true],
    [body({ kind: "daily", times: ["00:00", "06:00", "12:00", "23:45"] }), true],
    [body({ kind: "daily", times: ["00:05", "23:55"] }), "times_too_close"],
    [body({ kind: "daily", times: ["09:00", "09:10"] }), "times_too_close"],
    [body({ kind: "daily", times: ["09:00", "08:00"] }), "times_out_of_order"],
    [body({ kind: "weekly", daysOfWeek: ["fri", "mon"], time: "08:30" }), "days_out_of_order"],
    [body({ kind: "monthly", dayOfMonth: "last", time: "08:30" }), true],
    [body({ kind: "monthly", dayOfMonth: 29, time: "08:30" }), "schedule_invalid"],
    [body({ kind: "every", everyMinutes: 720 }), true],
    [body({ kind: "daily", times: ["09:00"], timeZone: "Asia/Calcutta" }), "zone_unknown"],
    [body({ kind: "daily", times: ["09:00"], startDate: "2026-02-30" }), "dates_invalid"],
    [body({ kind: "daily", times: ["09:00"], startDate: "2028-02-29" }), true],
    [
      body({ kind: "daily", times: ["09:00"], startDate: "2026-03-02", endDate: "2026-03-01" }),
      "dates_invalid",
    ],
  ];
  for (const [value, expected] of cases) {
    const r = checkSchedule(value);
    assert.equal(r.ok ? true : r.refusal, expected, JSON.stringify(value));
  }
  assert.equal(scheduleMinimumGapMinutes, 15);
});

test("the closed zone list: sorted, unique, Intl's zones covered, aliases mapped onto it", () => {
  assert.deepEqual([...ianaTimeZones].sort(), [...ianaTimeZones]);
  assert.equal(new Set(ianaTimeZones).size, ianaTimeZones.length);
  for (const zone of ianaTimeZones) new Intl.DateTimeFormat("en", { timeZone: zone });
  for (const [alias, zone] of Object.entries(ianaTimeZoneAliases)) {
    assert.ok(isIanaTimeZone(zone), alias);
    assert.ok(!isIanaTimeZone(alias), alias);
    assert.equal(canonicalTimeZone(alias), zone);
  }
  for (const zone of Intl.supportedValuesOf("timeZone"))
    assert.ok(canonicalTimeZone(zone) !== null, zone);
  assert.ok(ianaTimeZones.includes("America/Toronto") && ianaTimeZones.includes("UTC"));
  for (const bad of ["US/Eastern", "EST5EDT", "Etc/GMT+5", "toronto", "", null, 1, "../x"])
    assert.equal(canonicalTimeZone(bad), null, String(bad));
  // The four Canadian zones the notification settings offered are all on it.
  for (const zone of [
    "America/Toronto",
    "America/Winnipeg",
    "America/Edmonton",
    "America/Vancouver",
  ])
    assert.ok(isIanaTimeZone(zone));
});

test("daylight saving: a missing local time fires at the next valid minute; a repeated one at its first occurrence", () => {
  const tz = "America/Toronto";
  assert.equal(slotText(resolveLocalMinute(tz, local(2026, 3, 8, 2, 30))), "2026-03-08T07:00:00Z");
  assert.equal(slotText(resolveLocalMinute(tz, local(2026, 11, 1, 1, 30))), "2026-11-01T05:30:00Z");
  assert.equal(slotText(resolveLocalMinute(tz, local(2026, 7, 1, 9, 0))), "2026-07-01T13:00:00Z");
  // Lord Howe's 30-minute change and Chatham's 45-minute offset.
  assert.equal(
    slotText(resolveLocalMinute("Australia/Lord_Howe", local(2026, 10, 4, 2, 15))),
    "2026-10-03T15:30:00Z",
  );
  assert.equal(
    slotText(resolveLocalMinute("Australia/Lord_Howe", local(2026, 4, 5, 1, 45))),
    "2026-04-04T14:45:00Z",
  );
  assert.equal(
    slotText(resolveLocalMinute("Pacific/Chatham", local(2026, 3, 8, 0, 0))),
    "2026-03-07T10:15:00Z",
  );
  // Two local times that land on one instant fire once.
  assert.deepEqual(
    series(body({ kind: "daily", times: ["01:30", "02:30", "03:00"] }), "2026-03-08T00:00:00Z", 4),
    [
      "2026-03-08T06:30:00Z",
      "2026-03-08T07:00:00Z",
      "2026-03-09T05:30:00Z",
      "2026-03-09T06:30:00Z",
    ],
  );
  // Every 15 minutes through the fall-back hour: 01:00 to 01:45 once, then 02:00 EST.
  assert.deepEqual(series(body({ kind: "every", everyMinutes: 15 }), "2026-11-01T05:00:00Z", 4), [
    "2026-11-01T05:15:00Z",
    "2026-11-01T05:30:00Z",
    "2026-11-01T05:45:00Z",
    "2026-11-01T07:00:00Z",
  ]);
  // Monthly on the last day, in a leap February; bounded dates end the series.
  assert.deepEqual(
    series(
      body({ kind: "monthly", dayOfMonth: "last", time: "09:00", timeZone: "UTC" }),
      "2028-01-31T10:00:00Z",
      2,
    ),
    ["2028-02-29T09:00:00Z", "2028-03-31T09:00:00Z"],
  );
  assert.deepEqual(
    series(
      body({
        kind: "weekly",
        daysOfWeek: ["mon"],
        time: "09:00",
        timeZone: "UTC",
        startDate: "2026-11-03",
        endDate: "2026-11-16",
      }),
      "2026-10-01T00:00:00Z",
      3,
    ),
    ["2026-11-09T09:00:00Z", "2026-11-16T09:00:00Z", null],
  );
});

test("catch-up: skip fires only inside 5 minutes, run_latest_once the latest within 24 hours, never a burst", () => {
  assert.equal(scheduleOnTimeMs, 5 * 60_000);
  assert.equal(scheduleReplayHorizonMs, 24 * 3_600_000);
  const skip = body({ kind: "daily", times: ["09:00"], timeZone: "UTC" });
  const latest = { ...skip, missedRun: "run_latest_once" };
  const at = (text) => iso(text);
  assert.deepEqual(firePlan(skip, at("2026-07-01T09:00:00Z"), at("2026-07-01T08:00:00Z")), {
    fire: null,
    next: at("2026-07-01T09:00:00Z"),
    missed: false,
  });
  assert.equal(
    firePlan(skip, at("2026-07-01T09:00:00Z"), at("2026-07-01T09:05:00Z")).fire,
    at("2026-07-01T09:00:00Z"),
  );
  assert.deepEqual(firePlan(skip, at("2026-07-01T09:00:00Z"), at("2026-07-01T09:06:00Z")), {
    fire: null,
    next: at("2026-07-02T09:00:00Z"),
    missed: true,
  });
  assert.deepEqual(firePlan(latest, at("2026-07-01T09:00:00Z"), at("2026-07-06T10:00:00Z")), {
    fire: at("2026-07-06T09:00:00Z"),
    next: at("2026-07-07T09:00:00Z"),
    missed: true,
  });
  const weekly = body({
    kind: "weekly",
    daysOfWeek: ["mon"],
    time: "09:00",
    timeZone: "UTC",
    missedRun: "run_latest_once",
  });
  assert.equal(firePlan(weekly, at("2026-07-06T09:00:00Z"), at("2026-07-08T09:00:00Z")).fire, null);
});

test("the trigger key is MandateTrigger@1's: sched:<schedule id>:<slot UTC>", () => {
  const id = "0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b";
  const key = scheduleTriggerKey(id, iso("2026-03-08T07:00:00.000Z"));
  assert.equal(key, "sched:" + id + ":2026-03-08T07:00:00Z");
  const core = JSON.parse(readFileSync("docs/contracts/schemas/v1.1/core.schema.json", "utf8"));
  const pattern = new RegExp(core.$defs.MandateTrigger.properties.triggerKey.pattern);
  assert.ok(pattern.test(key) && key.length <= 200);
  // The SQL twin renders the same text.
  assert.match(
    functionText("morrow_work.schedule_trigger_key"),
    /'sched:'\|\|p_schedule_id\|\|':'\|\|to_char\(p_slot AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'\)/,
  );
});

test("the SQL twins: the zone list and aliases, the windows and the 15-minute spacing", () => {
  const listText =
    /CREATE FUNCTION morrow_work\.iana_time_zones\(\)[\s\S]*?ARRAY\[([\s\S]*?)\]::text\[\]/.exec(
      sql,
    )[1];
  assert.deepEqual(
    [...listText.matchAll(/'([^']+)'/g)].map((m) => m[1]),
    [...ianaTimeZones],
  );
  const aliasText = functionText("morrow_work.time_zone_canonical");
  assert.deepEqual(
    Object.fromEntries(
      [...aliasText.matchAll(/WHEN '([^']+)' THEN '([^']+)'/g)].map((m) => [m[1], m[2]]),
    ),
    { ...ianaTimeZoneAliases },
  );
  const plan = functionText("morrow_work.schedule_fire_plan");
  assert.match(
    plan,
    /CASE WHEN b->>'missedRun'='skip' THEN interval '5 minutes' ELSE interval '24 hours' END/,
  );
  const valid = functionText("morrow_work.schedule_body_valid");
  assert.match(valid, /v_minutes\[i\]-v_minutes\[i-1\]<15/);
  assert.match(valid, /v_minutes\[1\]\+1440-v_minutes\[v_n\]<15/);
  assert.match(valid, /\('15','30','60','120','180','240','360','720'\)/);
  assert.match(functionText("morrow_work.schedule_time_minutes"), /\[0-5\]\[05\]\$/);
});

test("migration schedules-shop-zone: registered, FORCE RLS, append-only or guarded, settings overwritten first", () => {
  assert.equal(entry.executeAs, "morrow_work_owner");
  assert.ok(entry.sequence >= 57);
  assert.equal(entry.reviewRef, "docs/briefs/sd12-schedules-shop-zone.md");
  assert.ok(readFileSync(entry.reviewRef, "utf8").length > 2000);
  for (const table of [
    "store_time_zones",
    "schedules",
    "schedule_revisions",
    "mandate_triggers",
    "schedule_zone_notices",
  ]) {
    assert.match(
      sql,
      new RegExp(`CREATE TRIGGER (append_only|no_truncate) BEFORE[^;]*ON morrow_work\\.${table} `),
    );
    assert.match(sql, new RegExp(`FOREACH t IN ARRAY ARRAY\\[[^\\]]*'${table}'`));
  }
  assert.match(sql, /EXECUTE format\('ALTER TABLE morrow_work\.%I FORCE ROW LEVEL SECURITY',t\)/);
  assert.doesNotMatch(
    sql,
    /DELETE FROM|TRUNCATE morrow|DROP TABLE|ALTER TABLE morrow_work\.(?!%I)/,
  );
  // No customer column (CLAUDE.md: customer data never enters before its deletion path).
  assert.doesNotMatch(sql, /\b(email|phone|address|customer_[a-z_]+|first_name|last_name)\b text/i);
  // Only kind schedule is written here; admission's transitions only.
  assert.match(sql, /kind text NOT NULL CHECK \(kind='schedule'\)/);
  // Every runtime and vault definer overwrites all four settings before anything else.
  const settings = ["schedule_sweep", "schedule_target", "schedule_fire", "schedule_zone"];
  for (const name of [
    "morrow_work.schedule_tenants_due",
    "morrow_work.fire_due_schedules",
    "morrow_vault.shopify_zone_record",
  ]) {
    const text = functionText(name);
    const begin = text.indexOf("BEGIN");
    const safe = text.indexOf("work_executor_safe");
    for (const s of settings) {
      const at = text.indexOf(`set_config('morrow.${s}','',true)`);
      assert.ok(at > begin && at < safe, name + " " + s);
    }
  }
  // Each context's policy names its login.
  for (const policy of sql.matchAll(/CREATE POLICY (schedule_[a-z_]+) ON[\s\S]*?;\n/g))
    assert.match(policy[0], /session_user='morrow_(runtime_executor|vault_broker)'/, policy[1]);
  // The grants: the runtime's two, the vault's one, the api's four.
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION morrow_work\.schedule_tenants_due\(\),morrow_work\.fire_due_schedules\(text\) TO morrow_runtime_executor;/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION morrow_vault\.shopify_zone_record\(text,text,text\) TO morrow_vault_broker;/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION morrow_work\.store_time_zone\(text\),morrow_work\.store_time_zone_set\(text,text,text\),\n morrow_work\.schedule_zone_notices_open\(\),morrow_work\.schedule_zone_move\(text,text,text\) TO morrow_work_api;/,
  );
  // A person's writes recheck the session's authority under the organization's lock.
  for (const name of ["morrow_work.store_time_zone_set", "morrow_work.schedule_zone_move"])
    assert.match(functionText(name), /morrow_identity\.work_lock_and_recheck\(/, name);
});

test("the orchestrator's statements and strict decoders", () => {
  assert.deepEqual(scheduleFireSql, {
    tenantsDue: "SELECT schedule_id FROM morrow_work.schedule_tenants_due()",
    fire: "SELECT outcome,examined,fired,duplicate,dropped,ended,more FROM morrow_work.fire_due_schedules($1)",
  });
  const a = "0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b",
    b = "1f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b";
  assert.deepEqual(decodeScheduleTenantsDue([{ schedule_id: a }, { schedule_id: b }]), [a, b]);
  assert.deepEqual(decodeScheduleTenantsDue([]), []);
  for (const bad of [
    [{ schedule_id: a }, { schedule_id: a }],
    [{ schedule_id: "x" }],
    [{ schedule_id: a, organization_id: "o" }],
    Array.from({ length: 51 }, (_, i) => ({
      schedule_id: a.slice(0, -2) + String(i).padStart(2, "0"),
    })),
    null,
  ])
    assert.throws(() => decodeScheduleTenantsDue(bad), /SCHEDULE_FIRE_HELD/);
  const row = (o) => ({
    outcome: "fired",
    examined: "3",
    fired: "2",
    duplicate: "1",
    dropped: "1",
    ended: "0",
    more: "false",
    ...o,
  });
  assert.deepEqual(decodeScheduleFire([row({})]), {
    outcome: "fired",
    examined: 3,
    fired: 2,
    duplicate: 1,
    dropped: 1,
    ended: 0,
    more: false,
  });
  assert.deepEqual(
    decodeScheduleFire([
      row({ outcome: "not_found", examined: "0", fired: "0", duplicate: "0", dropped: "0" }),
    ]),
    { outcome: "not_found" },
  );
  for (const bad of [
    [row({ fired: "3", duplicate: "1" })],
    [row({ examined: "26" })],
    [row({ more: "yes" })],
    [row({ outcome: "moved" })],
    [row({ fired: "-1" })],
    [row({ outcome: "denied" })],
    [{ ...row({}), extra: "1" }],
    [row({}), row({})],
  ])
    assert.throws(() => decodeScheduleFire(bad), /SCHEDULE_FIRE_HELD/, JSON.stringify(bad));
});

// A FixedSqlPool that answers the runtime profile and the two statements from a script.
function fakePool(script) {
  const statements = [];
  return {
    statements,
    pool: {
      async connect() {
        return {
          async query(text, values) {
            statements.push([text, values]);
            if (text === runtimeExecutorSql.role)
              return {
                rows: [
                  {
                    role: "morrow_runtime_executor",
                    login: "morrow_runtime_executor",
                    rolsuper: false,
                    rolbypassrls: false,
                    rolcreatedb: false,
                    rolcreaterole: false,
                    rolreplication: false,
                    rolinherit: false,
                    role_member: false,
                  },
                ],
              };
            if (text === scheduleFireSql.tenantsDue) return { rows: script.tenants() };
            if (text === scheduleFireSql.fire) return { rows: script.fire(values[0]) };
            return { rows: [] };
          },
          async release() {},
        };
      },
    },
  };
}

test("the cron run: due tenants, then passes per tenant until none remain or the budget ends; counts only", async () => {
  const a = "0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b",
    b = "1f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b";
  const passes = { [a]: 0, [b]: 0 };
  const { pool, statements } = fakePool({
    tenants: () => [{ schedule_id: a }, { schedule_id: b }],
    fire: (id) => {
      passes[id] += 1;
      const more = id === a ? passes[id] < 2 : true;
      return [
        {
          outcome: "fired",
          examined: "25",
          fired: "20",
          duplicate: "1",
          dropped: "4",
          ended: "1",
          more: String(more),
        },
      ];
    },
  });
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  let run;
  try {
    run = await fireSchedulesOnCron(pool);
  } finally {
    console.log = original;
  }
  // a needed two passes; b was still busy after the per-tenant limit (unfinished).
  assert.equal(passes[a], 2);
  assert.equal(passes[b], scheduleFireBudget.passesPerTenant);
  assert.deepEqual(run, {
    outcome: "fired",
    tenants: 2,
    passes: 2 + scheduleFireBudget.passesPerTenant,
    fired: 20 * 6,
    duplicate: 6,
    dropped: 24,
    ended: 6,
    unavailable: 0,
    unfinished: 1,
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), [
    "dropped",
    "duplicate",
    "ended",
    "event",
    "fired",
    "outcome",
    "passes",
    "tenants",
    "unavailable",
    "unfinished",
  ]);
  assert.ok(!lines[0].includes(a) && !lines[0].includes(b));
  // Each pass is its own transaction under the leases' profile.
  assert.equal(
    statements.filter(([t]) => t === runtimeExecutorSql.begin).length,
    1 + passes[a] + passes[b],
  );
  assert.equal(
    statements.filter(([t]) => t === runtimeExecutorSql.commit).length,
    1 + passes[a] + passes[b],
  );
  // A list that cannot be read fires nothing and says so.
  const down = {
    async connect() {
      throw Error("RUNTIME_SQL_UNAVAILABLE");
    },
  };
  console.log = () => {};
  try {
    const r = await fireSchedulesOnCron(down);
    assert.equal(r.outcome, "unavailable");
    assert.equal(r.passes, 0);
  } finally {
    console.log = original;
  }
});

test("the schedules-v2 switch: committed off, the orchestrator's var exactly on, refused on before admission", async () => {
  assert.equal(schedulesV2Var, "MORROW_SCHEDULES_V2");
  assert.equal(schedulesV2On, "on");
  assert.equal(edgeSchedulesVar, schedulesV2Var);
  assert.ok(schedulesSwitchOn({ MORROW_SCHEDULES_V2: "on" }));
  for (const env of [
    {},
    null,
    { MORROW_SCHEDULES_V2: "On" },
    { MORROW_SCHEDULES_V2: true },
    Object.defineProperty({}, "MORROW_SCHEDULES_V2", { get: () => "on", enumerable: true }),
  ])
    assert.equal(schedulesSwitchOn(env), false);
  const committed = JSON.parse(readFileSync("docs/decisions/schedules-v2-staging.json", "utf8"));
  assert.equal(committed.switch, "off");
  assert.deepEqual(reviewedSchedulesRecord(committed), { switch: "off" });
  assert.throws(
    () => reviewedSchedulesRecord({ ...committed, switch: "on" }),
    /EDGE_SCHEDULES_BEFORE_ADMISSION/,
  );
  assert.deepEqual(
    reviewedSchedulesRecord({ ...committed, switch: "on" }, { mandateAdmission: true }),
    { switch: "on" },
  );
  for (const bad of [{ ...committed, switch: "maybe" }, { ...committed, extra: 1 }, null])
    assert.throws(() => reviewedSchedulesRecord(bad), /EDGE_STAGING_SCHEDULES_RECORD/);
  const on = (worker, environment) =>
    edgeVarNames(worker, environment, "off", "off", "off", "off", "off", "on");
  assert.ok(on("orchestrator", "staging").includes(edgeSchedulesVar));
  assert.ok(!edgeVarNames("orchestrator", "staging").includes(edgeSchedulesVar));
  for (const [worker, environment] of [
    ["orchestrator", "development"],
    ["orchestrator", "production"],
    ["api", "staging"],
    ["broker", "staging"],
    ["connector", "staging"],
  ])
    assert.ok(!on(worker, environment).includes(edgeSchedulesVar), worker + " " + environment);
  for (const worker of ["api", "broker", "workers", "shopify-connector"])
    assert.ok(!readFileSync(`apps/${worker}/wrangler.jsonc`, "utf8").includes(edgeSchedulesVar));
  // edge:check over copied configurations: a var without the switch is a mixed state, and an
  // on record is refused before admission exists.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "morrow-schedules-switch-")));
  try {
    const parseConfig = (text) =>
      JSON.parse(
        text
          .split("\n")
          .filter((line) => !line.trim().startsWith("//"))
          .join("\n")
          .replace(/,(\s*[}\]])/g, "$1"),
      );
    let copies = 0;
    const check = async (mutate, value) => {
      const root = join(scratch, "tree-" + ++copies);
      for (const worker of edgeWorkers) {
        mkdirSync(join(root, worker.dir), { recursive: true });
        const config = parseConfig(readFileSync(join(worker.dir, "wrangler.jsonc"), "utf8"));
        mutate[worker.key]?.(config);
        writeFileSync(join(root, worker.dir, "wrangler.jsonc"), JSON.stringify(config, null, 2));
      }
      const schedulesPath = join(scratch, "schedules-" + copies + ".json");
      writeFileSync(schedulesPath, JSON.stringify({ ...committed, switch: value }));
      const verdict = await verifyEdgeConfig({ root, schedulesPath });
      return {
        codes: [...new Set(verdict.problems.map((problem) => problem.split(":")[0]))].sort(),
        schedulesSwitch: verdict.schedulesSwitch,
      };
    };
    const set = (value) => (c) => (c.env.staging.vars.MORROW_SCHEDULES_V2 = value);
    assert.deepEqual(await check({}, "off"), { codes: [], schedulesSwitch: "off" });
    assert.deepEqual((await check({ orchestrator: set("on") }, "off")).codes, ["EDGE_VARS"]);
    assert.deepEqual(await check({}, "on"), {
      codes: ["EDGE_SCHEDULES_BEFORE_ADMISSION"],
      schedulesSwitch: "off",
    });
    assert.deepEqual((await check({ orchestrator: set("on") }, "on")).codes, [
      "EDGE_SCHEDULES_BEFORE_ADMISSION",
      "EDGE_VARS",
    ]);
    assert.deepEqual(await check({}, "maybe"), {
      codes: ["EDGE_STAGING_SCHEDULES_RECORD"],
      schedulesSwitch: "off",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
