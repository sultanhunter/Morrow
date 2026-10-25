// v1 build order PR 6, "Credits for your own workspace" (ADR-0035 items 3 and 4;
// docs/briefs/v1-renew-test-credits.md): `staging:test-credits -- renew` over fakes. The
// workspace and its grant come only from the committed record at verified main; the runner
// checks the live-store app's workspace first and commits only `renewed` or `current`; the
// CLI is refused in CI, without the standing approval, off main and on any database but
// the staging binding, prints one closed JSON line and the activity-log line, and never the
// owner database URL. PostgreSQL behaviour of migration 0052 is qualified by
// lab:test-entitlement (N cases); this file also pins the migration's shape.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commands,
  main,
  requireTestCreditsRaiseRecord,
  testCreditsActivityLine,
  testCreditsRecord,
  testCreditsRecordPath,
} from "../scripts/staging.mjs";
import {
  liveStoreWorkspaceStatement,
  renewTestCredits,
  testCreditsOutcomes,
  testCreditsRenewInput,
  testCreditsRenewStatement,
  testCreditsReport,
} from "../scripts/staging-runner.mjs";
import {
  approvedCard,
  fakeContext,
  fakeDatabase,
  fakeSha,
  fakeTools,
  labBinding,
  plantedHome,
  standingApproval,
} from "./fixtures/staging-fakes.mjs";

const read = (path) => readFileSync(path, "utf8");
const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code ?? error.message;
  }
};
const administrator = Object.freeze({ name: "neondb_owner", mode: "createrole" });
const ownerUrl = `postgresql://neondb_owner:${"p".repeat(24)}@${labBinding.hostname}/morrow?sslmode=require`;
const sent = (db) => JSON.stringify(db.statements);
const afterBegin = (db) => {
  const texts = db.statements.map((s) => s.text);
  return texts.slice(texts.indexOf("BEGIN"));
};
const standingEvidence = ["docs/evidence/live/2026-10-23-standing-approval", "md"].join(".");
const raiseEvidence = ["docs/evidence/live/2026-11-25-test-credits-raise", "md"].join(".");
const grantRef = "adr-0035.e13.2026-10-24.1";
const input = Object.freeze({
  operatorId: "operator_claude",
  workspaceId: "ws_owner",
  grantApprovalRef: grantRef,
  standingApproval: "adr-0035",
  evidenceRef: standingEvidence,
  creditUnits: null,
  raiseEvidenceRef: null,
});
const renewed = Object.freeze({
  entitlementId: "00000000-0000-4000-8000-0000000000e1",
  organizationId: "org_owner",
  workspaceId: "ws_owner",
  billingAccountId: "00000000-0000-4000-8000-0000000000a1",
  renewalId: "00000000-0000-4000-8000-0000000000f1",
  period: "1",
  periodStart: "2026-11-23T12:00:00.000Z",
  periodEnd: "2026-12-23T12:00:00.000Z",
  creditUnits: "300",
  addedUnits: "120",
  available: "300",
  snapshotRevision: "2",
  walletRevision: "6",
});
const current = Object.freeze({
  ...renewed,
  renewalId: null,
  period: "0",
  periodStart: "2026-10-24T12:00:00.000Z",
  periodEnd: "2026-11-23T12:00:00.000Z",
  addedUnits: "300",
  available: "212",
  snapshotRevision: "1",
});

// ---------------------------------------------------------------------------
// The migration (0052): its manifest row, the replaced guards' pinned 0035 bodies, the
// table's shape and the operator function's grants.
const migrationFile = "0052.staging-test-credits-renewal.sql";
const migration = read("migrations/" + migrationFile);
const body = (text, header) => {
  const at = text.indexOf(header);
  assert.ok(at >= 0, header);
  const open = text.indexOf("$$", at) + 2;
  return text.slice(open, text.indexOf("$$", open));
};
test("migration 0052: a forward work-owner migration that replaces 0035's guards only from their pinned bodies", () => {
  const manifest = JSON.parse(read("migrations/manifest.json"));
  const row = manifest.migrations.find((m) => m.file === migrationFile);
  assert.equal(row.sequence, 52);
  assert.equal(row.executeAs, "morrow_work_owner");
  assert.equal(row.reviewRef, "docs/briefs/v1-renew-test-credits.md");
  assert.equal(row.sha256, createHash("sha256").update(migration).digest("hex"));
  assert.match(migration, /current_user<>'morrow_work_owner'/);
  const entitlement = read("migrations/0035.staging-test-entitlement.sql");
  for (const name of ["wallet_guard", "snapshot_guard"]) {
    const header = `CREATE OR REPLACE FUNCTION morrow_billing.${name}()`;
    const pinned = new RegExp(
      `to_regprocedure\\('morrow_billing\\.${name}\\(\\)'\\)\\)\\n  IS DISTINCT FROM '([a-f0-9]{32})'`,
    ).exec(migration)?.[1];
    assert.equal(createHash("md5").update(body(entitlement, header)).digest("hex"), pinned, name);
    // Same signature, INVOKER and search path.
    assert.match(
      migration,
      new RegExp(
        `CREATE OR REPLACE FUNCTION morrow_billing\\.${name}\\(\\) RETURNS trigger\\nLANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS \\$\\$`,
      ),
    );
  }
  // The wallet guard keeps every 0035 rule and adds only the renewal's funding, owner only.
  const before = body(entitlement, "CREATE OR REPLACE FUNCTION morrow_billing.wallet_guard()");
  const after = body(migration, "CREATE OR REPLACE FUNCTION morrow_billing.wallet_guard()");
  const added = after.replace(before.slice(0, before.indexOf("  END IF;\n END IF;\n RAISE")), "");
  assert.ok(after.startsWith(before.slice(0, before.indexOf("  END IF;\n END IF;\n RAISE"))));
  assert.match(added, /operator_test_entitlement_renewals r/);
  assert.match(added, /r\.funded_wallet_revision=NEW\.revision\s+AND r\.added_units=v_delta/);
  assert.ok(after.indexOf("operator_test_entitlement_renewals") > after.indexOf("IF current_user='morrow_work_owner' THEN"));
  // The snapshot guard keeps 0035's grant check for revision 1 and refuses any successor
  // of an operator snapshot that is not the same grant's renewal.
  const snapshot = body(migration, "CREATE OR REPLACE FUNCTION morrow_billing.snapshot_guard()");
  assert.match(
    snapshot,
    /p\.subscription_key ~ '\^morrow:operator_entitlement:' AND NEW\.subscription_key IS DISTINCT FROM p\.subscription_key/,
  );
  assert.match(snapshot, /NEW\.verified_at<p\.valid_until/);
  assert.match(snapshot, /r\.snapshot_revision=NEW\.revision/);
  assert.match(snapshot, /g\.period_start=NEW\.verified_at AND g\.period_end=NEW\.valid_until/);
  // The table: owner only, FORCE RLS, append-only; the function: INVOKER, granted to nobody.
  assert.match(migration, /ALTER TABLE morrow_billing\.operator_test_entitlement_renewals FORCE ROW LEVEL SECURITY;/);
  assert.match(migration, /CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON morrow_billing\.operator_test_entitlement_renewals/);
  assert.match(migration, /UNIQUE \(organization_id,workspace_id,entitlement_id,period_number\)/);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION morrow_billing\.operator_test_entitlement_renew\(text,text,text,text,text,text,text\) FROM PUBLIC;/,
  );
  assert.doesNotMatch(migration, /SECURITY DEFINER|GRANT |OWNER TO|\bDROP (TABLE|FUNCTION|TRIGGER)\b/);
  // No payment row: the function never writes a receipt, a payment event or a credit grant.
  const renew = body(migration, "CREATE FUNCTION morrow_billing.operator_test_entitlement_renew(");
  assert.doesNotMatch(
    renew,
    /INSERT INTO morrow_billing\.(credit_grants|verified_payment_events|stripe_event_receipts|receipt_applications|billing_accounts|operator_test_entitlements)\b|UPDATE morrow_billing\.(workspace_billing_routes|billing_accounts|operator_test_entitlements)\b/,
  );
  assert.equal(renew.match(/INSERT INTO /g).length, 2);
  assert.equal(renew.match(/UPDATE morrow_billing\./g).length, 1);
  assert.match(renew, /v_environment IS DISTINCT FROM 'staging'/);
  assert.match(renew, /v_added:=greatest\(0,v_units-\(w\.available\+w\.reserved\)\)/);
});

// ---------------------------------------------------------------------------
// The runner.
test("test-credits: closed input; a raise needs both its credits and its record", () => {
  assert.deepEqual(testCreditsRenewInput(input), Object.values(input));
  const raised = { ...input, creditUnits: "1000", raiseEvidenceRef: raiseEvidence };
  assert.deepEqual(testCreditsRenewInput(raised), Object.values(raised));
  for (const change of [
    { operatorId: "" },
    { operatorId: "has space" },
    { workspaceId: "ws owner" },
    { workspaceId: 7 },
    { grantApprovalRef: "adr-0035.e13.2026-10-24" },
    { grantApprovalRef: "adr-0035" },
    { standingApproval: "ADR-0035" },
    { evidenceRef: "docs/evidence/activity-log.md" },
    { creditUnits: "1000" },
    { raiseEvidenceRef: raiseEvidence },
    { creditUnits: "0", raiseEvidenceRef: raiseEvidence },
    { creditUnits: 1000, raiseEvidenceRef: raiseEvidence },
    { creditUnits: "1000", raiseEvidenceRef: "docs/raise.md" },
    { creditUnits: undefined },
  ])
    assert.equal(
      codeOf(() => testCreditsRenewInput({ ...input, ...change })),
      "STAGING_USAGE",
      JSON.stringify(change),
    );
});

test("test-credits: the definer's result is closed, period 0 only as current, a renewal 720 hours long", () => {
  const json = (value) => JSON.stringify(value);
  assert.deepEqual(testCreditsReport("renewed", json(renewed), "ws_owner"), renewed);
  assert.deepEqual(testCreditsReport("current", json(renewed), "ws_owner"), renewed);
  assert.deepEqual(testCreditsReport("current", json(current), "ws_owner"), current);
  for (const [outcome, value] of [
    ["renewed", current],
    ["renewed", { ...renewed, extra: "1" }],
    ["renewed", { ...renewed, workspaceId: "ws_other" }],
    ["renewed", { ...renewed, renewalId: null }],
    ["renewed", { ...renewed, period: "01" }],
    ["renewed", { ...renewed, addedUnits: "301" }],
    ["renewed", { ...renewed, creditUnits: "0" }],
    ["renewed", { ...renewed, snapshotRevision: "1" }],
    ["renewed", { ...renewed, periodEnd: "2026-12-24T12:00:00.000Z" }],
    ["renewed", { ...renewed, periodStart: "2026-11-23T12:00:00Z" }],
    ["renewed", { ...renewed, available: "-1" }],
    ["renewed", { ...renewed, walletRevision: 6 }],
    ["current", { ...current, renewalId: renewed.renewalId }],
    ["current", { ...current, snapshotRevision: "2" }],
  ])
    assert.equal(
      codeOf(() => testCreditsReport(outcome, json(value), "ws_owner")),
      "STAGING_TEST_CREDITS_RESULT_INVALID",
      json(value),
    );
  assert.equal(
    codeOf(() => testCreditsReport("renewed", "not json", "ws_owner")),
    "STAGING_TEST_CREDITS_RESULT_INVALID",
  );
});

const renewWorld = ({ n = 1, outcome = "renewed", result = renewed, commitError = null } = {}) =>
  fakeDatabase({
    rules: [
      [/FROM morrow_identity\.shopify_apps WHERE live_store/, [{ n }]],
      [
        /operator_test_entitlement_renew/,
        [{ outcome, result: result === null ? null : JSON.stringify(result) }],
      ],
    ],
    execError: commitError ? { pattern: /^COMMIT$/, error: commitError } : undefined,
  });
const runRenew = (db, given = input) =>
  renewTestCredits({
    connect: db.connector().connect,
    binding: labBinding,
    administrator,
    input: given,
  }).then(
    (done) => done,
    (error) => error,
  );

test("test-credits: the live-store app's workspace first, then the renewal as the work owner under D4; commits only renewed or current", async () => {
  const db = renewWorld();
  assert.deepEqual(await runRenew(db), { outcome: "renewed", ...renewed });
  assert.deepEqual(afterBegin(db).slice(0, 12), [
    "BEGIN",
    "GRANT morrow_identity_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
    "SET LOCAL ROLE morrow_identity_owner",
    liveStoreWorkspaceStatement,
    "RESET ROLE",
    "REVOKE morrow_identity_owner FROM neondb_owner GRANTED BY neondb_owner",
    "GRANT morrow_work_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
    "SET LOCAL ROLE morrow_work_owner",
    testCreditsRenewStatement,
    "RESET ROLE",
    "REVOKE morrow_work_owner FROM neondb_owner GRANTED BY neondb_owner",
    "COMMIT",
  ]);
  assert.deepEqual(db.statements.find((s) => s.text === liveStoreWorkspaceStatement).params, [
    "staging",
    "ws_owner",
  ]);
  assert.deepEqual(
    db.statements.find((s) => s.text === testCreditsRenewStatement).params,
    Object.values(input),
  );
  // current commits too (it wrote nothing); a superuser administrator takes no grants.
  const same = renewWorld({ outcome: "current", result: current });
  assert.deepEqual(await runRenew(same), { outcome: "current", ...current });
  assert.ok(afterBegin(same).includes("COMMIT"));
  // Another workspace: refused before the renewal statement, nothing committed.
  for (const n of [0, 2]) {
    const other = renewWorld({ n });
    assert.equal((await runRenew(other)).code, "STAGING_TEST_CREDITS_NOT_OWNER_WORKSPACE");
    assert.ok(!sent(other).includes("operator_test_entitlement_renew"));
    assert.ok(!afterBegin(other).includes("COMMIT"));
  }
  // Every refusal and an unknown or malformed answer commits nothing.
  for (const outcome of [...testCreditsOutcomes.filter((o) => !["renewed", "current"].includes(o)), "other"]) {
    const refused = renewWorld({ outcome, result: null });
    const error = await runRenew(refused);
    assert.equal(error.code, "STAGING_TEST_CREDITS_REFUSED", outcome);
    assert.equal(error.details.outcome, outcome === "other" ? "unknown" : outcome);
    assert.ok(!afterBegin(refused).includes("COMMIT"), outcome);
  }
  const malformed = renewWorld({ result: { ...renewed, workspaceId: "ws_other" } });
  assert.equal((await runRenew(malformed)).code, "STAGING_TEST_CREDITS_RESULT_INVALID");
  assert.ok(!afterBegin(malformed).includes("COMMIT"));
  // A malformed input never connects.
  const unused = renewWorld();
  assert.equal(
    (await runRenew(unused, { ...input, workspaceId: "ws owner" })).code,
    "STAGING_USAGE",
  );
  assert.equal(unused.statements.length, 0);
});

test("test-credits: a COMMIT that fails after renewed is an unknown outcome, never success", async () => {
  const lost = Object.assign(new Error("connection terminated"), { code: "08006" });
  const unknown = await runRenew(renewWorld({ commitError: lost }));
  assert.equal(unknown.code, "STAGING_TEST_CREDITS_OUTCOME_UNKNOWN");
  assert.deepEqual(unknown.details, { period: "1" });
  const quiet = await runRenew(renewWorld({ outcome: "current", result: current, commitError: lost }));
  assert.equal(quiet.code, "STAGING_TEST_CREDITS_FAILED");
  assert.equal(quiet.details.sqlstate, "08006");
});

// ---------------------------------------------------------------------------
// The committed record and the raise record.
const recordText = (overrides = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    kind: "test_credits",
    environment: "staging",
    standingApproval: "adr-0035",
    workspace: "ws_owner",
    grantApproval: grantRef,
    raise: null,
    ...overrides,
  });
const now = Date.parse("2026-11-25T12:00:00Z");
test("test-credits: the committed record is closed, unset until the owner's grant exists, and names a grant of this approval", () => {
  assert.equal(testCreditsRecordPath, "docs/decisions/test-credits-staging.json");
  // As committed: closed, of the standing approval, unset (the grant has not run yet).
  const committed = read(testCreditsRecordPath);
  assert.deepEqual(JSON.parse(committed), JSON.parse(recordText({ workspace: null, grantApproval: null })));
  assert.equal(
    codeOf(() => testCreditsRecord(committed, standingApproval(), now)),
    "STAGING_TEST_CREDITS_UNSET",
  );
  assert.equal(
    codeOf(() => testCreditsRecord(recordText({ grantApproval: null }), standingApproval(), now)),
    "STAGING_TEST_CREDITS_UNSET",
  );
  assert.deepEqual(testCreditsRecord(recordText(), standingApproval(), now), {
    workspaceId: "ws_owner",
    grantApprovalRef: grantRef,
    raise: null,
  });
  const raise = { credits: "1000", approvedOn: "2026-11-25", evidence: raiseEvidence };
  assert.deepEqual(testCreditsRecord(recordText({ raise }), standingApproval(), now).raise, raise);
  for (const [text, label] of [
    ["not json", "json"],
    ["[]", "array"],
    [recordText({ extra: 1 }), "extra key"],
    [recordText({ schemaVersion: 2 }), "schema"],
    [recordText({ kind: "test_entitlement" }), "kind"],
    [recordText({ environment: "production" }), "environment"],
    [recordText({ standingApproval: "staging-card-1" }), "another approval"],
    [recordText({ workspace: "ws owner" }), "workspace grammar"],
    [recordText({ workspace: 7 }), "workspace type"],
    [recordText({ grantApproval: "staging-card-1.e13.2026-10-22.1" }), "another approval's grant"],
    [recordText({ grantApproval: "adr-0035.e7.2026-10-24.1" }), "another effect"],
    [recordText({ grantApproval: "adr-0035.e13.2026-10-22.1" }), "before E13"],
    [recordText({ grantApproval: "adr-0035.e13.2026-11-26.1" }), "after today"],
    [recordText({ grantApproval: "adr-0035.e13.2026-02-30.1" }), "no such day"],
    [recordText({ raise: { ...raise, credits: "0" } }), "raise zero"],
    [recordText({ raise: { ...raise, credits: 1000 } }), "raise number"],
    [recordText({ raise: { ...raise, approvedOn: "2026-11-26" } }), "raise after today"],
    [recordText({ raise: { ...raise, approvedOn: "2026-10-22" } }), "raise before the approval"],
    [recordText({ raise: { ...raise, evidence: "docs/raise.md" } }), "raise record path"],
    [recordText({ raise: { ...raise, extra: true } }), "raise extra key"],
    [recordText({ raise: "1000" }), "raise shape"],
  ])
    assert.equal(
      codeOf(() => testCreditsRecord(text, standingApproval(), now)),
      "STAGING_TEST_CREDITS_RECORD_INVALID",
      label,
    );
  assert.equal(
    codeOf(() => testCreditsRecord(recordText(), standingApproval({ e13: null }), now)),
    "STAGING_CARD_EFFECT_MISSING",
  );
});

test("test-credits: a raise's record names the workspace and the credits exactly, once each", () => {
  const named = { workspaceId: "ws_owner", credits: "1000" };
  requireTestCreditsRaiseRecord(
    "- **Approval.** yes\n- **Workspace:** `ws_owner`\n- **Credits per period:** `1000`\n",
    named,
  );
  requireTestCreditsRaiseRecord("Workspace: ws_owner\nCredits per period: 1000\n", named);
  for (const text of [
    "- Workspace: `ws_owner`\n",
    "- Credits per period: `1000`\n",
    "- Workspace: `ws_owner_2`\n- Credits per period: `1000`\n",
    "- Workspace: `ws_owner`\n- Credits per period: `10000`\n",
    "- Workspace: `ws_owner`\n- Credits per period: `100`\n",
    "- Workspace: `ws_owner`\n- Credits per period: `1000` a month\n",
    "- Workspace: `ws_owner`\n- Workspace: `ws_owner`\n- Credits per period: `1000`\n",
    "- Workspace: `ws_owner`\n- Credits per period: `1000`\n- Credits per period: `1000`\n",
  ])
    assert.equal(
      codeOf(() => requireTestCreditsRaiseRecord(text, named)),
      "STAGING_EVIDENCE_MISMATCH",
      text,
    );
});

test("test-credits: the activity-log line is one table row of closed values, with no workspace id", () => {
  const commit = fakeSha("main");
  const line = testCreditsActivityLine({
    now,
    report: renewed,
    outcome: "renewed",
    standingApproval: "adr-0035",
    commit,
    raise: null,
  });
  assert.equal(
    line,
    `| 2026-11-25 | \`staging:test-credits -- renew\` for the owner's workspace under the standing approval \`adr-0035\` (main \`${commit.slice(0, 8)}\`) | renewed period 1: 300 test credits for 2026-11-23 to 2026-12-23, 120 added, 300 available | US$0 | none |`,
  );
  assert.ok(!line.includes("ws_owner") && !line.includes("org_owner"));
  const raised = testCreditsActivityLine({
    now,
    report: { ...renewed, creditUnits: "1000" },
    outcome: "renewed",
    standingApproval: "adr-0035",
    commit,
    raise: { credits: "1000", approvedOn: "2026-11-25", evidence: raiseEvidence },
  });
  assert.match(raised, new RegExp("raise record `" + raiseEvidence.replaceAll(".", "\\.") + "`"));
  assert.match(
    testCreditsActivityLine({
      now,
      report: current,
      outcome: "current",
      standingApproval: "adr-0035",
      commit,
      raise: null,
    }),
    /\| current: period 0 \(2026-10-24 to 2026-11-23\) already renewed, nothing written \| US\$0 \| none \|$/,
  );
  // A value outside the closed grammar never reaches the line.
  assert.equal(
    codeOf(() =>
      testCreditsActivityLine({
        now,
        report: { ...renewed, period: "1 | x" },
        outcome: "renewed",
        standingApproval: "adr-0035",
        commit,
        raise: null,
      }),
    ),
    "STAGING_TEST_CREDITS_RESULT_INVALID",
  );
});

// ---------------------------------------------------------------------------
// The CLI.
test("cli: test-credits is one subcommand of the staging tools with its npm script", () => {
  assert.ok(commands.has("test-credits"));
  assert.equal(
    JSON.parse(read("package.json")).scripts["staging:test-credits"],
    "node scripts/staging.mjs test-credits",
  );
});

const argv = ["test-credits", "renew", "--operator", "operator_claude"];
const standingText = "- **Standing approval:** `adr-0035`\n";
const raiseText = "- **Workspace:** `ws_owner`\n- **Credits per period:** `1000`\n";
async function cliWorld({
  record = recordText(),
  files,
  card = standingApproval(),
  n = 1,
  outcome = "renewed",
  result = renewed,
  git = {},
  environment = {},
  binding,
  at = now,
} = {}) {
  const planted = plantedHome({ "neon-owner-url": ownerUrl });
  const root = mkdtempSync(join(tmpdir(), "morrow-test-credits-root-"));
  const committed = files ?? {
    [standingEvidence]: { text: standingText },
    ...(record === null ? {} : { [testCreditsRecordPath]: { text: record } }),
  };
  const fake = fakeTools({ git: { files: committed, ...git } });
  const { ctx, out, err, notices } = await fakeContext({
    home: planted.home,
    root,
    tools: fake.tools,
    card,
    now: at,
    environment,
    ...(binding === undefined ? {} : { binding }),
  });
  const db = fakeDatabase({
    rules: [
      [/FROM morrow_identity\.shopify_apps WHERE live_store/, [{ n }]],
      [/operator_test_entitlement_renew/, [{ outcome, result: JSON.stringify(result) }]],
    ],
  });
  ctx.database = db.connector;
  return {
    ctx,
    out,
    err,
    notices,
    db,
    fake,
    cleanup() {
      planted.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("cli: test-credits renew takes the workspace and grant from the committed record and prints the result and the log line", async () => {
  const w = await cliWorld();
  try {
    assert.equal(await main(argv, w.ctx), 0, w.err.join("\n"));
    assert.equal(w.out.length, 1);
    assert.deepEqual(JSON.parse(w.out[0]), {
      command: "test-credits",
      action: "renew",
      outcome: "renewed",
      ...renewed,
      grantApprovalRef: grantRef,
      standingApproval: "adr-0035",
      raiseRecord: null,
      record: testCreditsRecordPath,
      recordCommit: fakeSha("main"),
    });
    assert.deepEqual(
      w.db.statements.find((s) => s.text === testCreditsRenewStatement).params,
      Object.values(input),
    );
    assert.equal(w.notices.length, 1);
    assert.match(w.notices[0], /^\| 2026-11-25 \| `staging:test-credits -- renew` .* \| renewed period 1: 300 test credits/);
    // The record, the standing record and nothing else were read from main's tree by blob
    // id; the owner URL and its password never reach any output.
    const lsTree = w.fake.calls.filter((c) => c.tool === "git" && c.args[0] === "ls-tree");
    assert.deepEqual(
      lsTree.map((c) => c.args.at(-1)),
      [standingEvidence, testCreditsRecordPath],
    );
    const printed = [...w.out, ...w.err, ...w.notices].join("\n");
    assert.ok(!printed.includes("p".repeat(24)) && !printed.includes("postgresql://"));
  } finally {
    w.cleanup();
  }
});

test("cli: a raise is passed to the database only with its committed record naming the workspace and the credits", async () => {
  const raise = { credits: "1000", approvedOn: "2026-11-25", evidence: raiseEvidence };
  const files = (text) => ({
    [standingEvidence]: { text: standingText },
    [testCreditsRecordPath]: { text: recordText({ raise }) },
    ...(text === null ? {} : { [raiseEvidence]: { text } }),
  });
  const ok = await cliWorld({ files: files(raiseText), result: { ...renewed, creditUnits: "1000" } });
  try {
    assert.equal(await main(argv, ok.ctx), 0, ok.err.join("\n"));
    assert.deepEqual(ok.db.statements.find((s) => s.text === testCreditsRenewStatement).params, [
      ...Object.values(input).slice(0, 5),
      "1000",
      raiseEvidence,
    ]);
    assert.equal(JSON.parse(ok.out[0]).raiseRecord, raiseEvidence);
  } finally {
    ok.cleanup();
  }
  for (const [text, code] of [
    [null, "STAGING_EVIDENCE_MISSING"],
    ["- **Workspace:** `ws_owner`\n- **Credits per period:** `2000`\n", "STAGING_EVIDENCE_MISMATCH"],
  ]) {
    const w = await cliWorld({ files: files(text) });
    try {
      assert.equal(await main(argv, w.ctx), 1);
      assert.equal(JSON.parse(w.err.at(-1)).code, code);
      assert.equal(w.db.statements.length, 0, code);
    } finally {
      w.cleanup();
    }
  }
});

test("cli: test-credits is refused before any database statement without its preconditions", async () => {
  // Usage: only `renew --operator <id>`; never a workspace, grant or amount argument.
  for (const args of [
    ["test-credits"],
    ["test-credits", "renew"],
    ["test-credits", "grant", "--operator", "operator_claude"],
    ["test-credits", "renew", "--workspace", "ws_owner"],
    ["test-credits", "renew", "--operator", "operator_claude", "--workspace", "ws_owner"],
    ["test-credits", "renew", "--operator", "operator_claude", "--credits", "1000"],
    ["test-credits", "renew", "--operator", "has space"],
  ]) {
    const w = await cliWorld();
    try {
      assert.equal(await main(args, w.ctx), 2, args.join(" "));
      assert.equal(JSON.parse(w.err.at(-1)).code, "STAGING_USAGE");
      assert.equal(w.db.statements.length, 0);
    } finally {
      w.cleanup();
    }
  }
  const cardWithE13 = { ...approvedCard("2026-11-10"), e13: { amendedOn: "2026-11-10" } };
  for (const [options, code] of [
    [{ environment: { ci: true } }, "STAGING_TEST_CREDITS_CI_REFUSED"],
    [{ card: standingApproval({ status: "withdrawn" }) }, "STAGING_CARD_INACTIVE"],
    [{ card: cardWithE13 }, "STAGING_APPROVAL_INVALID"],
    [{ card: standingApproval({ e13: null }) }, "STAGING_CARD_EFFECT_MISSING"],
    [{ binding: null }, "STAGING_IDENTIFIERS_UNSET"],
    [{ binding: { ...labBinding, environment: "production" } }, "STAGING_BINDING_INVALID"],
    [{ git: { head: fakeSha("feature") } }, "STAGING_NOT_MAIN"],
    [{ git: { status: " M docs/decisions/test-credits-staging.json\n" } }, "STAGING_TREE_DIRTY"],
    [{ record: null }, "STAGING_TEST_CREDITS_RECORD_MISSING"],
    [{ record: recordText({ workspace: null, grantApproval: null }) }, "STAGING_TEST_CREDITS_UNSET"],
    [{ record: recordText({ standingApproval: "staging-card-1" }) }, "STAGING_TEST_CREDITS_RECORD_INVALID"],
    [
      { files: { [testCreditsRecordPath]: { text: recordText() } } },
      "STAGING_EVIDENCE_MISSING",
    ],
    [
      {
        files: {
          [standingEvidence]: { text: "- **Approval.** yes\n" },
          [testCreditsRecordPath]: { text: recordText() },
        },
      },
      "STAGING_EVIDENCE_MISMATCH",
    ],
    [
      {
        files: {
          [standingEvidence]: { text: standingText },
          [testCreditsRecordPath]: { text: recordText(), mode: "120000" },
        },
      },
      "STAGING_TEST_CREDITS_RECORD_MISSING",
    ],
  ]) {
    const w = await cliWorld(options);
    try {
      assert.equal(await main(argv, w.ctx), 1, code);
      assert.equal(JSON.parse(w.err.at(-1)).code, code, code);
      assert.equal(w.db.statements.length, 0, code);
    } finally {
      w.cleanup();
    }
  }
});

test("cli: the database refuses another workspace and every refusal outcome, printing no log line", async () => {
  for (const [options, code, outcome] of [
    [{ n: 0 }, "STAGING_TEST_CREDITS_NOT_OWNER_WORKSPACE", undefined],
    [{ outcome: "grant_missing" }, "STAGING_TEST_CREDITS_REFUSED", "grant_missing"],
    [{ outcome: "not_staging" }, "STAGING_TEST_CREDITS_REFUSED", "not_staging"],
  ]) {
    const w = await cliWorld(options);
    try {
      assert.equal(await main(argv, w.ctx), 1, code);
      const error = JSON.parse(w.err.at(-1));
      assert.equal(error.code, code);
      assert.equal(error.outcome, outcome);
      assert.equal(w.notices.length, 0);
      assert.ok(!afterBegin(w.db).includes("COMMIT"));
    } finally {
      w.cleanup();
    }
  }
  // The same period again: current, nothing written, and its own log line.
  const again = await cliWorld({ outcome: "current", result: current });
  try {
    assert.equal(await main(argv, again.ctx), 0);
    assert.equal(JSON.parse(again.out[0]).outcome, "current");
    assert.match(again.notices[0], /\| current: period 0 .* nothing written \| US\$0 \| none \|$/);
  } finally {
    again.cleanup();
  }
});
