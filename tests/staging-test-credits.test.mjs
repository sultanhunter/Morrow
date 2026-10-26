// v1 build order PR 6, "Credits for your own workspace" (ADR-0035 items 3 and 4;
// docs/briefs/v1-renew-test-credits.md): `staging:test-credits -- renew` over fakes. The
// workspace and its grant come only from the committed record at verified main; the runner
// checks the live-store app's workspace first and commits only `renewed` or `current`; the
// CLI is refused in CI, without the standing approval, off main and on any database but
// the staging binding, prints one closed JSON line and the activity-log line, and never the
// owner database URL. No input names an amount: the credits are the current terms'
// operator entry (P01.T04a R10), read as 0035's grant reads it, and a raise is a new
// staging BillingTerms revision (review F1). PostgreSQL behaviour of migration 0053 is
// qualified by lab:test-entitlement (N cases); this file also pins the migration's shape.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as stagingTools from "../scripts/staging.mjs";
import {
  billingTermsPath,
  commands,
  main,
  requireTermsRaiseRecords,
  testCreditsActivityLine,
  testCreditsRecord,
  testCreditsRecordPath,
} from "../scripts/staging.mjs";
import { operatorRaise, raiseRecordPath, raiseRecordProblem } from "../scripts/terms-raise.mjs";
import {
  billingTermsSeedRows,
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
  termsRevision: "1",
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
// The migration (0053): its manifest row, the replaced guards' pinned 0035 bodies, the
// table's shape and the operator function's grants.
const migrationFile = "0053.staging-test-credits-renewal.sql";
const migration = read("migrations/" + migrationFile);
const body = (text, header) => {
  const at = text.indexOf(header);
  assert.ok(at >= 0, header);
  const open = text.indexOf("$$", at) + 2;
  return text.slice(open, text.indexOf("$$", open));
};
test("migration 0053: a forward work-owner migration that replaces 0035's guards only from their pinned bodies", () => {
  const manifest = JSON.parse(read("migrations/manifest.json"));
  const row = manifest.migrations.find((m) => m.file === migrationFile);
  assert.equal(row.sequence, 53);
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
  assert.ok(
    after.indexOf("operator_test_entitlement_renewals") >
      after.indexOf("IF current_user='morrow_work_owner' THEN"),
  );
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
  assert.match(
    migration,
    /ALTER TABLE morrow_billing\.operator_test_entitlement_renewals FORCE ROW LEVEL SECURITY;/,
  );
  assert.match(
    migration,
    /CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON morrow_billing\.operator_test_entitlement_renewals/,
  );
  assert.match(migration, /UNIQUE \(organization_id,workspace_id,entitlement_id,period_number\)/);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION morrow_billing\.operator_test_entitlement_renew\(text,text,text,text,text\) FROM PUBLIC;/,
  );
  assert.doesNotMatch(
    migration,
    /SECURITY DEFINER|GRANT |OWNER TO|\bDROP (TABLE|FUNCTION|TRIGGER)\b/,
  );
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

test("migration 0053: credits come only from the current terms' operator entry, read as 0035's grant reads it (R10; review F1)", () => {
  const renew = body(migration, "CREATE FUNCTION morrow_billing.operator_test_entitlement_renew(");
  const grant = body(
    read("migrations/0035.staging-test-entitlement.sql"),
    "CREATE FUNCTION morrow_billing.operator_test_entitlement_grant(",
  );
  // The five closed text values: none is an amount or a raise record.
  assert.match(
    migration,
    /CREATE FUNCTION morrow_billing\.operator_test_entitlement_renew\(p_operator_id text,p_workspace_id text,p_grant_approval_ref text,\n p_standing_approval text,p_evidence_ref text\)\n/,
  );
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION morrow_billing\.operator_test_entitlement_renew\(text,text,text,text,text\) FROM PUBLIC;/,
  );
  assert.doesNotMatch(migration, /p_credit_units|p_raise_evidence_ref|raise_evidence_ref/);
  // The terms read is 0035's, statement for statement, and it is the only source of units.
  const termsRead = grant.slice(
    grant.indexOf(" SELECT x.terms_revision::bigint AS terms_revision,x.terms INTO v_terms"),
    grant.indexOf(" v_at:=greatest("),
  );
  assert.match(termsRead, /ORDER BY x\.terms_revision DESC LIMIT 1/);
  assert.match(termsRead, /v_units:=\(v_entry->>'creditUnits'\)::bigint;/);
  assert.ok(renew.includes(termsRead), "the renewal reads the terms exactly as the grant does");
  assert.equal(renew.match(/v_units:=/g).length, 1);
  assert.doesNotMatch(renew, /v_units:=[^;]*g\.credit_units/);
  // The renewal records the terms revision its credits came from, in its row, its digest
  // and its result.
  assert.match(
    migration,
    / terms_revision morrow_work\.revision NOT NULL REFERENCES morrow_billing\.billing_terms\(terms_revision\),\n/,
  );
  assert.match(renew, /'test',v_units,v_terms\.terms_revision,v_added/);
  assert.match(renew, /v_k::text,v_units::text,v_terms\.terms_revision::text,v_added::text/);
  assert.match(renew, /'termsRevision',v_terms\.terms_revision::text/);
  assert.match(renew, /'termsRevision',COALESCE\(n\.terms_revision,g\.terms_revision\)::text/);
  assert.match(migration, /to_regclass\('morrow_billing\.billing_terms'\) IS NULL/);
});

test("migration 0053: a renewal record by hand must be the one the renewal would write now (review R1)", () => {
  // A BEFORE INSERT guard on the record, owned with the table, granted to nobody.
  assert.match(
    migration,
    /CREATE TRIGGER renewal_guard BEFORE INSERT ON morrow_billing\.operator_test_entitlement_renewals\n FOR EACH ROW EXECUTE FUNCTION morrow_billing\.renewal_guard\(\);/,
  );
  assert.match(migration, /REVOKE ALL ON FUNCTION morrow_billing\.renewal_guard\(\) FROM PUBLIC;/);
  assert.match(migration, /to_regprocedure\('morrow_billing\.renewal_guard\(\)'\) IS NOT NULL/);
  const guard = body(migration, "CREATE FUNCTION morrow_billing.renewal_guard()");
  const renew = body(migration, "CREATE FUNCTION morrow_billing.operator_test_entitlement_renew(");
  // Its recorded time is the database's clock, whatever the writer gave.
  assert.match(
    guard,
    /v_now:=date_trunc\('milliseconds',clock_timestamp\(\)\);\n NEW\.recorded_at:=v_now;/,
  );
  // Its period is recomputed from the grant's grid, as the renewal computes it.
  const grid = "1+floor((extract(epoch FROM v_now)-extract(epoch FROM g.period_end))/2592000)";
  assert.ok(renew.includes("v_k:=" + grid + "::integer;"));
  assert.ok(guard.includes("v_k:=" + grid + ";"));
  assert.ok(guard.includes("v_start:=g.period_end+(v_k-1)*interval '720 hours';"));
  // The current terms' one operator entry, read as the renewal reads it.
  assert.match(
    guard,
    /FROM morrow_billing\.billing_terms x\n  ORDER BY x\.terms_revision DESC LIMIT 1;/,
  );
  assert.match(
    guard,
    /WHERE e->>'kind'='operator_test_entitlement' AND e->>'route'='morrow_direct' AND e->>'mode'='test';/,
  );
  for (const rule of [
    // The grant's own account, and the function's route_conflict rules.
    /g\.billing_account_id IS DISTINCT FROM NEW\.billing_account_id::text/,
    /rt\.fixing_payment_key IS DISTINCT FROM v_key/,
    /rt\.shopify_bound_at IS NOT NULL/,
    /a\.status IS DISTINCT FROM 'active'/,
    /s\.subscription_key IS DISTINCT FROM v_key/,
    /v_environment IS DISTINCT FROM 'staging'/,
    // The period that contains the clock, after the latest snapshot's.
    /NEW\.period_number IS DISTINCT FROM v_k/,
    /NEW\.period_start IS DISTINCT FROM v_start/,
    /COALESCE\(v_start<s\.valid_until,true\)/,
    /NEW\.snapshot_revision IS DISTINCT FROM s\.revision\+1/,
    // The current terms' credits and revision.
    /v_count IS DISTINCT FROM 1/,
    /NEW\.terms_revision IS DISTINCT FROM t\.terms_revision/,
    /NEW\.credit_units IS DISTINCT FROM v_units/,
    // Exactly the room below them, funding the wallet's next revision.
    /v_room:=v_units::numeric-\(w\.available::numeric\+w\.reserved\);/,
    /NEW\.added_units IS DISTINCT FROM greatest\(0,v_room\)/,
    /NEW\.funded_wallet_revision IS DISTINCT FROM \(CASE WHEN v_room>0 THEN w\.revision\+1 END\) THEN/,
  ])
    assert.match(guard, rule, String(rule));
  assert.match(guard, /RAISE EXCEPTION 'BILLING_RENEWAL_INVALID'/);
  // The wallet's renewal funding: the units added are the room below the renewal's
  // credits, which are the current terms revision's operator entry.
  const wallet = body(migration, "CREATE OR REPLACE FUNCTION morrow_billing.wallet_guard()");
  const funding = wallet.slice(wallet.indexOf("operator_test_entitlement_renewals r"));
  assert.match(
    funding,
    /r\.added_units=v_delta AND v_delta=r\.credit_units-\(OLD\.available::numeric\+OLD\.reserved\)/,
  );
  assert.match(
    funding,
    /FROM morrow_billing\.billing_terms x\n      ORDER BY x\.terms_revision DESC LIMIT 1\) t/,
  );
  assert.match(funding, /AND r\.terms_revision=t\.terms_revision/);
  assert.match(
    funding,
    /AND r\.credit_units=\(SELECT CASE WHEN count\(\*\)=1 THEN max\(\(e->>'creditUnits'\)::bigint\) END\n      FROM jsonb_array_elements\(t\.terms->'entries'\) e\n      WHERE e->>'kind'='operator_test_entitlement' AND e->>'route'='morrow_direct' AND e->>'mode'='test'\)\) THEN/,
  );
});

test("migration 0053: an operator snapshot's successor needs an active account (review R3)", () => {
  const snapshot = body(migration, "CREATE OR REPLACE FUNCTION morrow_billing.snapshot_guard()");
  assert.match(
    snapshot,
    /SELECT x\.route,x\.mode,x\.status INTO a FROM morrow_billing\.billing_accounts x/,
  );
  const successor = snapshot.slice(snapshot.indexOf("  ELSE\n"));
  assert.match(
    successor,
    /NEW\.verified_at<p\.valid_until\n    OR a\.status IS DISTINCT FROM 'active'\n    OR NOT EXISTS/,
  );
  // Revision 1 (the grant's own snapshot) is checked exactly as 0035 checks it.
  assert.ok(snapshot.indexOf("a.status") > snapshot.indexOf("  ELSE\n"));
});

// ---------------------------------------------------------------------------
// Review R2: a raise of the operator credits needs the owner's committed record.
const raiseRecord = ["docs/evidence/live/2026-11-20-test-credits-raise", "md"].join(".");
const raiseText = ({
  revision = "staging.2",
  credits = "1000",
  words = '"Yes, raise my test credits to 1,000 a period."',
  extra = "",
} = {}) =>
  `# Raise of the owner's test credits\n\n- Terms revision: \`${revision}\`\n- Credits per period: \`${credits}\`\n- Owner's words: ${words}\n${extra}`;
const termsFile = JSON.parse(read("docs/decisions/billing-terms.json"));
const raisedRevision = (creditUnits = "1000", ownerRecord = raiseRecord) => {
  const revision = structuredClone(termsFile.environments.staging[0]);
  revision.terms.termsRevision = 2;
  revision.terms.entries[0].creditUnits = creditUnits;
  // The digest is not checked by these rules (verify:billing and the seed check it).
  revision.digest = "e".repeat(64);
  return ownerRecord === null ? revision : { ...revision, ownerRecord };
};

test("terms raise: only credits other than 300 are a raise, and its record names the revision, the credits and the owner's words (review R2)", () => {
  assert.equal(operatorRaise(termsFile.environments.staging[0]), null);
  assert.equal(operatorRaise(termsFile.environments.development[0]), null);
  assert.equal(operatorRaise(raisedRevision()), "1000");
  assert.equal(operatorRaise(raisedRevision("100")), "100");
  const expected = { environment: "staging", termsRevision: 2, creditUnits: "1000" };
  for (const text of [
    raiseText(),
    raiseText({ words: '"Yes, 1000."' }),
    raiseText({ words: "\u201cYes, raise it to 1 000 credits.\u201d" }),
    raiseText().replace("- Terms revision:", "- **Terms revision:**"),
    raiseText().replace("Owner's words", "Owner\u2019s words"),
    raiseText({ revision: "staging.2" }).replace("`staging.2`", "staging.2"),
  ])
    assert.equal(raiseRecordProblem(text, expected), null, text);
  for (const [text, reason] of [
    [null, "missing"],
    ["", "revision"],
    [raiseText({ revision: "staging.3" }), "revision"],
    [raiseText({ revision: "development.2" }), "revision"],
    [raiseText({ extra: "- Terms revision: `staging.2`\n" }), "revision"],
    [raiseText({ revision: "`staging.2` and more" }), "revision"],
    [raiseText({ credits: "1,000" }), "credits"],
    [raiseText({ credits: "2000" }), "credits"],
    [raiseText({ extra: "- Credits per period: `1000`\n" }), "credits"],
    [raiseText({ words: "Yes, 1,000." }), "words"],
    [raiseText({ words: '"Yes, raise them."' }), "words"],
    [raiseText({ words: '"Yes to 10000."' }), "words"],
    [raiseText({ words: '"Yes to 1,0000."' }), "words"],
    [raiseText({ words: '"Yes, 2,000."' }), "words"],
    [raiseText({ extra: '- Owner\'s words: "No."\n' }), "words"],
  ])
    assert.equal(raiseRecordProblem(text, expected), reason, String(text));
  assert.equal(raiseRecordProblem(raiseText(), { ...expected, creditUnits: "01" }), "invalid");
  assert.equal(
    raiseRecordProblem(raiseText(), { ...expected, environment: "production" }),
    "invalid",
  );
  assert.ok(raiseRecordPath.test(raiseRecord));
  assert.ok(
    raiseRecordPath.test(["docs/evidence/live/2026-11-20-test-credits-raise-2", "md"].join(".")),
  );
  for (const path of [
    ["docs/evidence/live/2026-11-20-standing-approval", "md"].join("."),
    ["docs/evidence/live/test-credits-raise", "md"].join("."),
    ["docs/evidence/other/2026-11-20-test-credits-raise", "md"].join("."),
    "docs/evidence/live/2026-11-20-test-credits-raise.txt",
  ])
    assert.ok(!raiseRecordPath.test(path), path);
});

test("billing terms seed: a revision may name its owner record, outside its row and digest (review R2)", () => {
  const first = termsFile.environments.staging[0];
  assert.deepEqual(
    billingTermsSeedRows([first, raisedRevision()]),
    billingTermsSeedRows([first, raisedRevision("1000", null)]),
  );
  for (const ownerRecord of [["docs/evidence/live/2026-11-20-other", "md"].join("."), 7, null])
    assert.equal(
      codeOf(() => billingTermsSeedRows([first, { ...raisedRevision("1000", null), ownerRecord }])),
      "STAGING_TERMS_INVALID",
      String(ownerRecord),
    );
});

// The committed billing-terms.json with staging's revision 1 and a raise to 1,000 as
// revision 2 (naming `ownerRecord` unless null), and its seed rows.
const raisedTerms = (revision = raisedRevision()) => {
  const document = structuredClone(termsFile);
  document.environments.staging = [termsFile.environments.staging[0], revision];
  return JSON.stringify(document, null, 2);
};
const raisedRows = (revision = raisedRevision()) =>
  billingTermsSeedRows([termsFile.environments.staging[0], revision]);

test("seed-platform: a raise of the operator credits needs the owner's record, committed at verified main (review R2)", async () => {
  const commit = fakeSha("main");
  const gate = async (files, rows = raisedRows()) => {
    const fake = fakeTools({ git: { files } });
    const outcome = await requireTermsRaiseRecords({ tools: fake.tools }, commit, rows).then(
      (checked) => checked,
      (error) => error.code,
    );
    return { outcome, fake };
  };
  // No raise: nothing is read.
  const plain = await gate({}, billingTermsSeedRows([termsFile.environments.staging[0]]));
  assert.deepEqual(plain.outcome, []);
  assert.deepEqual(plain.fake.calls, []);
  // The owner's record of revision 2 and its 1,000 credits.
  const recorded = await gate({
    [billingTermsPath]: { text: raisedTerms() },
    [raiseRecord]: { text: raiseText() },
  });
  assert.deepEqual(recorded.outcome, [
    { termsRevision: 2, creditUnits: "1000", record: raiseRecord },
  ]);
  for (const [label, files, rows, code] of [
    [
      "no committed terms",
      { [raiseRecord]: { text: raiseText() } },
      undefined,
      "STAGING_TERMS_RAISE_UNRECORDED",
    ],
    [
      "no owner record named",
      { [billingTermsPath]: { text: raisedTerms(raisedRevision("1000", null)) } },
      undefined,
      "STAGING_TERMS_RAISE_UNRECORDED",
    ],
    [
      "a committed revision that is not the one seeded",
      {
        [billingTermsPath]: { text: raisedTerms(raisedRevision("2000")) },
        [raiseRecord]: { text: raiseText() },
      },
      undefined,
      "STAGING_TERMS_RAISE_UNRECORDED",
    ],
    [
      "a malformed record path",
      {
        [billingTermsPath]: {
          text: raisedTerms(
            raisedRevision("1000", ["docs/evidence/live/2026-11-20-yes", "md"].join(".")),
          ),
        },
      },
      undefined,
      "STAGING_TERMS_RAISE_UNRECORDED",
    ],
    [
      "the record not committed",
      { [billingTermsPath]: { text: raisedTerms() } },
      undefined,
      "STAGING_EVIDENCE_MISSING",
    ],
    [
      "a record of another amount",
      {
        [billingTermsPath]: { text: raisedTerms() },
        [raiseRecord]: { text: raiseText({ credits: "2000", words: '"Yes, 2,000."' }) },
      },
      undefined,
      "STAGING_EVIDENCE_MISMATCH",
    ],
    [
      "a record of another revision",
      {
        [billingTermsPath]: { text: raisedTerms() },
        [raiseRecord]: { text: raiseText({ revision: "staging.3" }) },
      },
      undefined,
      "STAGING_EVIDENCE_MISMATCH",
    ],
    [
      "the owner's words without the amount",
      {
        [billingTermsPath]: { text: raisedTerms() },
        [raiseRecord]: { text: raiseText({ words: '"Sure."' }) },
      },
      undefined,
      "STAGING_EVIDENCE_MISMATCH",
    ],
    [
      "a symbolic link for the record",
      {
        [billingTermsPath]: { text: raisedTerms() },
        [raiseRecord]: { text: raiseText(), mode: "120000" },
      },
      undefined,
      "STAGING_EVIDENCE_MISSING",
    ],
  ]) {
    const { outcome } = await gate(files, rows);
    assert.equal(outcome, code, label);
  }
});

test("cli: seed-platform refuses a raise without the owner's committed record before any database statement (review R2)", async () => {
  const planted = plantedHome({ "neon-owner-url": ownerUrl });
  const client = "client_" + "C".repeat(26);
  const profile = {
    schemaVersion: 1,
    providerId: "workos",
    environmentId: "environment_" + "E".repeat(26),
    applicationId: "app_" + "A".repeat(26),
    clientId: client,
    issuer: "https://api.workos.com/user_management/" + client,
    revision: 3,
    audiencePolicy: "absent",
  };
  const configuration = {
    origin: "https://morrow-staging-api.lab.workers.dev",
    retentionTier: "staging",
    verificationProfileJson: JSON.stringify(profile),
    profileId: "profile_staging",
    profileRecordRevision: 2,
    configurationDigest: "d".repeat(64),
    binding: {
      bindingId: "binding_staging",
      bindingRevision: 1,
      environmentId: profile.environmentId,
      applicationId: profile.applicationId,
      clientId: client,
      redirectUri: "https://morrow-staging-api.lab.workers.dev/auth/workos/callback",
      returnPath: "/",
    },
  };
  const world = async (files) => {
    const fake = fakeTools({ git: { files } });
    const { ctx, err } = await fakeContext({
      home: planted.home,
      tools: fake.tools,
      card: standingApproval(),
      now: Date.parse("2026-11-25T12:00:00Z"),
      overrides: {
        loginConfiguration: async () => configuration,
        billingTerms: async () => raisedRows(),
      },
    });
    const db = fakeDatabase();
    ctx.database = db.connector;
    return { ctx, err, db, fake };
  };
  try {
    const unrecorded = await world({
      [billingTermsPath]: { text: raisedTerms(raisedRevision("1000", null)) },
    });
    assert.equal(await main(["seed-platform"], unrecorded.ctx), 1);
    assert.deepEqual(JSON.parse(unrecorded.err.at(-1)), {
      command: "seed-platform",
      code: "STAGING_TERMS_RAISE_UNRECORDED",
      termsRevision: 2,
    });
    assert.deepEqual(unrecorded.db.statements, []);
    const mismatched = await world({
      [billingTermsPath]: { text: raisedTerms() },
      [raiseRecord]: { text: raiseText({ words: '"Sure."' }) },
    });
    assert.equal(await main(["seed-platform"], mismatched.ctx), 1);
    assert.equal(JSON.parse(mismatched.err.at(-1)).code, "STAGING_EVIDENCE_MISMATCH");
    assert.deepEqual(mismatched.db.statements, []);
    // With the owner's record the seed goes on to the database.
    const recorded = await world({
      [billingTermsPath]: { text: raisedTerms() },
      [raiseRecord]: { text: raiseText() },
    });
    await main(["seed-platform"], recorded.ctx);
    assert.ok(recorded.db.statements.length > 0, recorded.err.join("\n"));
    assert.ok(recorded.fake.calls.some((c) => c.tool === "git" && c.args.at(-1) === raiseRecord));
  } finally {
    planted.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The runner.
test("test-credits: closed input of five values, none an amount (review F1)", () => {
  assert.deepEqual(testCreditsRenewInput(input), Object.values(input));
  assert.equal(Object.values(input).length, 5);
  for (const given of [null, undefined, "ws_owner", [], Object.values(input)])
    assert.equal(
      codeOf(() => testCreditsRenewInput(given)),
      "STAGING_USAGE",
      String(given),
    );
  for (const change of [
    { operatorId: "" },
    { operatorId: "has space" },
    { workspaceId: "ws owner" },
    { workspaceId: 7 },
    { grantApprovalRef: "adr-0035.e13.2026-10-24" },
    { grantApprovalRef: "adr-0035" },
    { standingApproval: "ADR-0035" },
    { evidenceRef: "docs/evidence/activity-log.md" },
    // No caller value can name the credits, with or without a record of the owner's yes.
    { creditUnits: "1000" },
    { creditUnits: null },
    { raiseEvidenceRef: raiseEvidence },
    { creditUnits: "1000", raiseEvidenceRef: raiseEvidence },
    { credits: "1000" },
    { termsRevision: "2" },
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
    ["renewed", { ...renewed, termsRevision: "0" }],
    ["renewed", { ...renewed, termsRevision: 2 }],
    ["renewed", (({ termsRevision, ...rest }) => rest)(renewed)],
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
  for (const outcome of [
    ...testCreditsOutcomes.filter((o) => !["renewed", "current"].includes(o)),
    "other",
  ]) {
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
  const quiet = await runRenew(
    renewWorld({ outcome: "current", result: current, commitError: lost }),
  );
  assert.equal(quiet.code, "STAGING_TEST_CREDITS_FAILED");
  assert.equal(quiet.details.sqlstate, "08006");
});

// ---------------------------------------------------------------------------
// The committed record.
const recordText = (overrides = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    kind: "test_credits",
    environment: "staging",
    standingApproval: "adr-0035",
    workspace: "ws_owner",
    grantApproval: grantRef,
    ...overrides,
  });
const now = Date.parse("2026-11-25T12:00:00Z");
test("test-credits: the committed record is closed, unset until the owner's grant exists, and names a grant of this approval", () => {
  assert.equal(testCreditsRecordPath, "docs/decisions/test-credits-staging.json");
  // As committed: closed, of the standing approval, unset (the grant has not run yet).
  const committed = read(testCreditsRecordPath);
  assert.deepEqual(
    JSON.parse(committed),
    JSON.parse(recordText({ workspace: null, grantApproval: null })),
  );
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
  });
  const raise = { credits: "1000", approvedOn: "2026-11-25", evidence: raiseEvidence };
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
    // The record names no amount (review F1): a raise is a new staging terms revision.
    [recordText({ raise }), "a raise"],
    [recordText({ raise: null }), "a raise member, even unset"],
    [recordText({ credits: "1000" }), "credits"],
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

test("test-credits: the staging tools have no raise reader (review F1)", () => {
  assert.equal(stagingTools.requireTestCreditsRaiseRecord, undefined);
});

test("test-credits: the activity-log line is one table row of closed values, with no workspace id", () => {
  const commit = fakeSha("main");
  const line = testCreditsActivityLine({
    now,
    report: renewed,
    outcome: "renewed",
    standingApproval: "adr-0035",
    commit,
  });
  assert.equal(
    line,
    `| 2026-11-25 | \`staging:test-credits -- renew\` for the owner's workspace under the standing approval \`adr-0035\` (main \`${commit.slice(0, 8)}\`) | renewed period 1: 300 test credits (terms revision 1) for 2026-11-23 to 2026-12-23, 120 added, 300 available | US$0 | none |`,
  );
  assert.ok(!line.includes("ws_owner") && !line.includes("org_owner"));
  // A raise shows as the terms revision the credits came from.
  assert.match(
    testCreditsActivityLine({
      now,
      report: { ...renewed, creditUnits: "1000", termsRevision: "2" },
      outcome: "renewed",
      standingApproval: "adr-0035",
      commit,
    }),
    /\| renewed period 1: 1000 test credits \(terms revision 2\) for /,
  );
  assert.match(
    testCreditsActivityLine({
      now,
      report: current,
      outcome: "current",
      standingApproval: "adr-0035",
      commit,
    }),
    /\| current: period 0 \(2026-10-24 to 2026-11-23, terms revision 1\) already renewed, nothing written \| US\$0 \| none \|$/,
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
      record: testCreditsRecordPath,
      recordCommit: fakeSha("main"),
    });
    assert.deepEqual(
      w.db.statements.find((s) => s.text === testCreditsRenewStatement).params,
      Object.values(input),
    );
    assert.equal(w.notices.length, 1);
    assert.match(
      w.notices[0],
      /^\| 2026-11-25 \| `staging:test-credits -- renew` .* \| renewed period 1: 300 test credits/,
    );
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

test("cli: a committed record that names an amount is refused before any database statement (review F1)", async () => {
  const raise = { credits: "1000", approvedOn: "2026-11-25", evidence: raiseEvidence };
  for (const record of [recordText({ raise }), recordText({ raise: null })]) {
    const w = await cliWorld({
      files: {
        [standingEvidence]: { text: standingText },
        [testCreditsRecordPath]: { text: record },
        [raiseEvidence]: {
          text: "- **Workspace:** `ws_owner`\n- **Credits per period:** `1000`\n",
        },
      },
    });
    try {
      assert.equal(await main(argv, w.ctx), 1);
      assert.equal(JSON.parse(w.err.at(-1)).code, "STAGING_TEST_CREDITS_RECORD_INVALID");
      assert.equal(w.db.statements.length, 0);
      // The raise's record is never read.
      assert.ok(!w.fake.calls.some((c) => c.args.includes(raiseEvidence)));
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
    [
      { record: recordText({ workspace: null, grantApproval: null }) },
      "STAGING_TEST_CREDITS_UNSET",
    ],
    [
      { record: recordText({ standingApproval: "staging-card-1" }) },
      "STAGING_TEST_CREDITS_RECORD_INVALID",
    ],
    [{ files: { [testCreditsRecordPath]: { text: recordText() } } }, "STAGING_EVIDENCE_MISSING"],
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
    [{ outcome: "terms_missing" }, "STAGING_TEST_CREDITS_REFUSED", "terms_missing"],
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
    assert.match(
      again.notices[0],
      /\| current: period 0 \(.*, terms revision 1\) already renewed, nothing written \| US\$0 \| none \|$/,
    );
  } finally {
    again.cleanup();
  }
});
