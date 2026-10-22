// M3 PR-1 (ADR-0022 item 15; ADR-0005): the owner-run platform stop,
// `npm run staging:platform-stop -- set|lift --operator <id> --reason <text>`, over a fake
// database. It runs 0020's operator functions as morrow_work_owner inside the
// administrator's own transaction (a SET-only grant revoked before COMMIT), with fixed
// statements; the reason is a parameter and is never echoed. `set` needs no card and no
// deploy gate; `lift` needs the active card. lab:listings-authority runs the same function
// against PostgreSQL 17 through the Neon-shaped createrole administrator.
import test from "node:test";
import assert from "node:assert/strict";
import { commands, main } from "../scripts/staging.mjs";
import {
  checkPlatformStopInput,
  morrowSetRowsQuery,
  platformStop,
  platformStopStatements,
} from "../scripts/staging-runner.mjs";
import { StagingError } from "../scripts/staging-common.mjs";
import {
  approvedCard,
  fakeContext,
  fakeDatabase,
  fakeTools,
  labBinding,
  plantedHome,
} from "./fixtures/staging-fakes.mjs";

const ownerUrl = `postgresql://neondb_owner:${"o".repeat(24)}@${labBinding.hostname}/morrow?sslmode=require`;
const reason = "Model provider incident: stop every run";
const stopRow = (outcome, stop_id = "0b6f2c1e-5d4a-4f8e-9c3b-2a1d0e9f8c7b") => [
  { outcome, stop_id },
];
async function run(argv, { card = approvedCard(), rows, execError, administrator } = {}) {
  const planted = plantedHome({ "neon-owner-url": ownerUrl });
  try {
    const fake = fakeTools();
    const { ctx, out, err } = await fakeContext({
      home: planted.home,
      tools: fake.tools,
      card,
      ...(administrator ? { administrator } : {}),
    });
    const db = fakeDatabase({
      rules: rows === undefined ? [] : [[/FROM morrow_work\.platform_stop_(set|lift)\(/, rows]],
      execError,
    });
    ctx.database = db.connector;
    const code = await main(argv, ctx);
    return { code, out, err, db, calls: fake.calls };
  } finally {
    planted.cleanup();
  }
}

test("usage: set|lift, an Id-shaped operator and a person's reason, nothing else", async () => {
  assert.ok(commands.has("platform-stop"));
  for (const argv of [
    ["platform-stop"],
    ["platform-stop", "set"],
    ["platform-stop", "set", "--operator", "owner_1"],
    ["platform-stop", "pause", "--operator", "owner_1", "--reason", reason],
    ["platform-stop", "set", "--reason", reason, "--operator", "owner_1"],
    ["platform-stop", "set", "--operator", "bad id", "--reason", reason],
    ["platform-stop", "set", "--operator", "owner_1", "--reason", "   "],
    ["platform-stop", "set", "--operator", "owner_1", "--reason", "a\u0000b"],
    ["platform-stop", "set", "--operator", "owner_1", "--reason", "line\u001b[31m"],
    ["platform-stop", "set", "--operator", "owner_1", "--reason", "x".repeat(1025)],
    ["platform-stop", "set", "--operator", "owner_1", "--reason", reason, "--now"],
  ]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.equal(JSON.parse(r.err.at(-1)).code, "STAGING_USAGE");
    assert.deepEqual(r.db.statements, [], argv.join(" ") + ": no SQL");
  }
  assert.deepEqual(
    checkPlatformStopInput({ action: "lift", operatorId: "owner_1", reason: "Resolved\nok" }),
    { action: "lift", operatorId: "owner_1", reason: "Resolved\nok" },
  );
  assert.throws(() => checkPlatformStopInput(null), StagingError);
});

test("set needs no card or deploy gate; lift needs the active card", async () => {
  const proposed = { ...approvedCard(), status: "proposed", approvedOn: null, expiresOn: null };
  const set = await run(["platform-stop", "set", "--operator", "owner_1", "--reason", reason], {
    card: proposed,
    rows: stopRow("applied"),
  });
  assert.equal(set.code, 0, set.err.join());
  assert.deepEqual(JSON.parse(set.out.at(-1)), {
    command: "platform-stop",
    action: "set",
    outcome: "applied",
    stopId: "0b6f2c1e-5d4a-4f8e-9c3b-2a1d0e9f8c7b",
  });
  // No git, gh or wrangler call: a stop is never held behind main or the foundation check.
  assert.deepEqual(set.calls, []);
  const lift = await run(["platform-stop", "lift", "--operator", "owner_1", "--reason", reason], {
    card: proposed,
    rows: stopRow("applied"),
  });
  assert.equal(lift.code, 1);
  assert.deepEqual(JSON.parse(lift.err.at(-1)), {
    command: "platform-stop",
    code: "STAGING_CARD_INACTIVE",
    reason: "proposed",
  });
  assert.deepEqual(lift.db.statements, []);
  const lifted = await run(["platform-stop", "lift", "--operator", "owner_1", "--reason", reason], {
    rows: stopRow("applied"),
  });
  assert.equal(lifted.code, 0);
  assert.equal(JSON.parse(lifted.out.at(-1)).outcome, "applied");
});

test("the admin transaction: fixed statements, a SET-only grant revoked before COMMIT", async () => {
  const r = await run(["platform-stop", "set", "--operator", "owner_1", "--reason", reason], {
    rows: stopRow("applied"),
  });
  assert.equal(r.code, 0);
  const texts = r.db.statements.map((s) => s.text);
  const from = texts.indexOf("BEGIN");
  assert.deepEqual(texts.slice(from), [
    "BEGIN",
    "GRANT morrow_work_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
    "SET LOCAL ROLE morrow_work_owner",
    platformStopStatements.set,
    "RESET ROLE",
    "REVOKE morrow_work_owner FROM neondb_owner GRANTED BY neondb_owner",
    "COMMIT",
    morrowSetRowsQuery,
  ]);
  assert.deepEqual(r.db.statements[from + 3].params, ["owner_1", reason]);
  // The reason is a parameter only: in no statement text and never in the output.
  assert.ok(texts.every((text) => !text.includes(reason)));
  assert.ok(!r.out.join().includes(reason) && !r.err.join().includes(reason));
  assert.equal(
    platformStopStatements.lift,
    "SELECT outcome, stop_id::text AS stop_id FROM morrow_work.platform_stop_lift($1::text, $2::text)",
  );
  // A superuser administrator (the local lab shape) needs no grant.
  const db = fakeDatabase({
    identity: { superuser: true, session_role: "postgres_lab", current_role: "postgres_lab" },
    rules: [[/platform_stop_lift/, stopRow("not_stopped", null)]],
  });
  const result = await platformStop({
    connect: db.connector().connect,
    binding: labBinding,
    administrator: { name: "postgres_lab", mode: "superuser" },
    action: "lift",
    operatorId: "owner_1",
    reason,
  });
  assert.deepEqual(result, { action: "lift", outcome: "not_stopped", stopId: null });
  assert.ok(!db.statements.some((s) => /GRANT|REVOKE/.test(s.text)));
});

test("outcomes: idempotent ones are reported; any refusal or failure is a fixed code, no COMMIT", async () => {
  for (const [action, rows, outcome] of [
    ["set", stopRow("already_stopped"), "already_stopped"],
    ["lift", stopRow("not_stopped", null), "not_stopped"],
  ]) {
    const r = await run(["platform-stop", action, "--operator", "owner_1", "--reason", reason], {
      rows,
    });
    assert.equal(r.code, 0, action);
    assert.equal(JSON.parse(r.out.at(-1)).outcome, outcome);
  }
  for (const [action, rows, detail] of [
    ["set", stopRow("denied", null), "denied"],
    ["set", stopRow("invalid", null), "invalid"],
    ["set", stopRow("not_stopped", null), "not_stopped"],
    ["lift", stopRow("already_stopped"), "already_stopped"],
    ["set", stopRow("applied", "not-a-uuid"), "other"],
    ["set", stopRow("applied", null), "other"],
    ["lift", stopRow("not_stopped", "0b6f2c1e-5d4a-4f8e-9c3b-2a1d0e9f8c7b"), "other"],
    ["set", [], "other"],
    ["set", [...stopRow("applied"), ...stopRow("applied")], "other"],
    ["set", [{ outcome: "Some server text with spaces", stop_id: null }], "other"],
  ]) {
    const r = await run(["platform-stop", action, "--operator", "owner_1", "--reason", reason], {
      rows,
    });
    assert.equal(r.code, 1, JSON.stringify(rows));
    assert.deepEqual(JSON.parse(r.err.at(-1)), {
      command: "platform-stop",
      code: "STAGING_PLATFORM_STOP_REFUSED",
      outcome: detail,
    });
    assert.ok(!r.db.statements.some((s) => s.text === "COMMIT"), JSON.stringify(rows));
  }
  const failed = await run(["platform-stop", "set", "--operator", "owner_1", "--reason", reason], {
    rows: Object.assign(new Error("connection reset"), { code: "08006" }),
  });
  assert.equal(failed.code, 1);
  assert.deepEqual(JSON.parse(failed.err.at(-1)), {
    command: "platform-stop",
    code: "STAGING_PLATFORM_STOP_FAILED",
    sqlstate: "08006",
    server: null,
  });
  assert.ok(!failed.db.statements.some((s) => s.text === "COMMIT"));
});
