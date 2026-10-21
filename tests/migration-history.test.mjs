import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { scanSqlScript } from "../scripts/migration-sql.mjs";

// Applied migrations are immutable. This frozen list pins every published migration
// independently of migrations/manifest.json, so a coordinated edit of a migration file
// and its manifest row still fails. Append a row here when a new migration is published.
// Rows 5-15 carry their ADR-0020 rebaseline digests; the digests they replaced are in
// the one `rebaselines` record below and may never come back.
const published = [
  [
    1,
    "0001.identity-foundation.sql",
    "09e047173c39bff3d4ce1d0e16efeff3f423848f40e2c2e012ae6aa620d52491",
  ],
  [
    2,
    "0002.identity-grants.sql",
    "0d7561075037d354980a33ddd005688f5e73597011c5423f54c9ca9164f871a7",
  ],
  [
    3,
    "0003.authentication-challenges.sql",
    "72acd69951b379bf1af2ac7731a6d00b3b8b674c00aa7ded49e49a3f1571c83f",
  ],
  [
    4,
    "0004.workspace-access-revocation.sql",
    "19f0d6e09079540020992c054719fe7e5c461c6e4e4b07d431e29d8274e8e038",
  ],
  [
    5,
    "0005.workspace-store-linking.sql",
    "ef8bf098ba9343b939f1f100c152bb0654a673d0cdcf14c4d8966f5f3db0aa0c",
  ],
  [
    6,
    "0006.authentication-exchange-admission.sql",
    "02714ef64cb6c4d441d8cc1aab9bae83bdf085397302dec4fdbc5ef65e00b7df",
  ],
  [
    7,
    "0007.provider-subject-resolution.sql",
    "0b2b4cdba87d695ff028c6a10de1e81716f7bf151dd11b41c7055f27545fc863",
  ],
  [
    8,
    "0008.browser-session-admission.sql",
    "5f3260819280540bfba1ac8a4df11b9514fac88f5e935cf43a46df2d49942cf1",
  ],
  [
    9,
    "0009.workspace-linking-read-boundaries.sql",
    "deb34bdd227ba4f4b027c53319581336a2f2923fc0016895f35acba72b8ac994",
  ],
  [
    10,
    "0010.login-flow-custody.sql",
    "b993a9f8fc265700b3ef42ca6ac22379c145702bd922a31cf2230500814ccf99",
  ],
  [
    11,
    "0011.self-browser-family-logout.sql",
    "61200c4c931355ec2ebbd8fb7841bcc17a45699807f8de2c61c62b7c562be02f",
  ],
  [
    12,
    "0012.login-protocol-v1.sql",
    "138c453a303eadc57f0fd0c1faf44d560d38cfce72888c056897bfbd028df886",
  ],
  [
    13,
    "0013.account-onboarding.sql",
    "dbc05d0ca507d672c0f4a18591ee59a56aad685dde47a695e2fdbdf2f5873b00",
  ],
  [
    14,
    "0014.work-identity-bridge.sql",
    "19de8b5be63e47a0144f1bcfdd7c5548f8a9a38269eaa1604f098bfd5087691d",
  ],
  [15, "0015.work-state.sql", "bd5d1c48dfdabceac3fdd6ce7b829b9b1a25ebd56e1d689bcbd9dbaeba7f983a"],
  [
    16,
    "0016.browser-session-lifecycle.sql",
    "db8111c78e3f6d2a56aa3724a85afdc8f6c078d087a8edd8ee750281818a7b85",
  ],
  [
    17,
    "0017.approval-identity-bridge.sql",
    "f069cf9ceeabe828b52e12648020609bc50e62dcf4bd82d0811aaf402d90d672",
  ],
  [
    18,
    "0018.approval-records.sql",
    "6ca433edded2bc8590623bb30a6a51fe30b62215ad57dc0e4f7abdb7fecbadea",
  ],
  [
    19,
    "0019.spine-identity-bridge.sql",
    "e7e8a0ac95b1f85adbebfd78242e90310ea8a01c0e926355330ee0b8585f376e",
  ],
  [
    20,
    "0020.spine-foundation.sql",
    "dad347120c5d1a1c8c329c66f079a6982cb50b326e66a75a65d8e893e2da6459",
  ],
  [
    21,
    "0021.signup-billing-route.sql",
    "5ea67667a852d03caecced11c73f6a6ad3caeef19d4c211c3f5609ab52ea7d7b",
  ],
  [
    22,
    "0022.signup-route-identity-check.sql",
    "c4821e3980a67144f567f9c70d1560b55ca06c6cd3d86496615e21a14f450220",
  ],
  [
    23,
    "0023.member-lease-revocation.sql",
    "0cacc1326ad0283c7fcc92de4e3a9c9cc01fab66bc06809cc4a05f8f08856686",
  ],
  [
    24,
    "0024.membership-lease-revocation.sql",
    "00c64ae0bbb21fc245cf5e3521bdedbd7cbfeb33aec442b1b684426b06b6902b",
  ],
  // M2 PR-2: the Shopify install and link (0025 and 0027 by the work owner).
  [
    25,
    "0025.shopify-link-route-read.sql",
    "638644700bdee4471af801475515aa4562da7ffef285425cc5b450318d6fbcfa",
  ],
  [
    26,
    "0026.shopify-install-identity.sql",
    "b93538595f502d6cc7e3ce1ecfcf4c5c9c7986a80578c555db1afd7b20e40957",
  ],
  [
    27,
    "0027.shopify-vault-install.sql",
    "c056d8f7f0dba9f6769b13f4c1d19733413f5a7b79e5f745f855b60c18cd5147",
  ],
  // M5 PR-1: billing (0028 by the identity owner, 0029 by the work owner).
  [
    28,
    "0028.billing-identity-bridge.sql",
    "dee383f50ac1279fa1fe671d2469b86f65d5e4888b2a965548a34c506e5b7cc2",
  ],
  [
    29,
    "0029.billing-records.sql",
    "73f9ef9749baeddb15d57c846db7b5e63d7bd546e20ab80605d28a8ffa5cbf03",
  ],
].map(([sequence, file, sha256]) => ({ sequence, file, sha256 }));
// From now on administrator prerequisites are frozen like migrations (P03.T04e §3.1): each
// published row keeps exactly these pinned files, and a later role goes in a new file on its
// new row. The pins are the bytes as they stand, not each row's original setup: before this
// rule, the roles of migrations 0004-0008 (lifecycle, linking, preauth, resolution, sessions)
// were appended to row 1's file next to their migrations. Row 1's file is therefore
// cumulative and valid only on a fresh database, applied before row 1; applying
// prerequisites row by row to a database already past row 1 is unsupported (input to P04.T01i).
const publishedPrerequisites = new Map([
  [
    1,
    [
      {
        file: "infra/identity-role-prerequisites.sql",
        sha256: "25bc4de4b968ef51b696a0f9e85c8f482bfa6f4ad1b77114a865d210969ee581",
      },
    ],
  ],
  [
    10,
    [
      {
        file: "infra/identity-login-role-prerequisites.sql",
        sha256: "17c25b456d85d6b0a70fe312be885f4543339da9ebaf04122b585ccc2d4c541b",
      },
    ],
  ],
  [
    11,
    [
      {
        file: "infra/identity-logout-role-prerequisites.sql",
        sha256: "1eb98c94b51d4d2b1c2580fc402234110536ae6a84c185116676766460a0193d",
      },
    ],
  ],
  // P05.T01x Part B: the onboarding role, before 0013.
  [
    13,
    [
      {
        file: "infra/identity-onboarding-role-prerequisites.sql",
        sha256: "2baa597ab15f6c64957204071dccb96b2ca85bdc24eb2f482c5a9d8a7dd40e53",
      },
    ],
  ],
  // P06.T01a: the work roles, before 0014, the first migration that names them.
  [
    14,
    [
      {
        file: "infra/work-role-prerequisites.sql",
        sha256: "dbe05f09aa860e5e5e73de9358b5ca15e37c55cf74aec5a9d56571754e3f0b1c",
      },
    ],
  ],
  // M2 PR-1: the three membership-free executor logins (ADR-0022 item 8), before 0019.
  [
    19,
    [
      {
        file: "infra/spine-executor-role-prerequisites.sql",
        sha256: "9de904e5d954da5c48506f961d5c6f3884909276af5a022eedfcc9118e77a90b",
      },
    ],
  ],
]);
// The role each published migration was applied under: the identity owner, except the
// work-state tables (P06.T01a), the approval records (P06.T01b), the spine foundation and
// its member-lease revocation (M2 PR-1), the Shopify link route read and vault install
// definers (M2 PR-2), and the billing records (M5 PR-1), which the work owner creates.
const publishedExecuteAs = (sequence) =>
  [15, 18, 20, 23, 25, 27, 29].includes(sequence) ? "morrow_work_owner" : "morrow_identity_owner";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));

test("the manifest keeps every published migration as an unchanged prefix", () => {
  assert.ok(manifest.migrations.length >= published.length);
  for (const [index, row] of published.entries()) {
    const { sequence, file, sha256 } = manifest.migrations[index];
    assert.deepEqual({ sequence, file, sha256 }, row);
  }
});

test("every published migration file still hashes to its pinned digest", () => {
  for (const row of published)
    assert.equal(sha(readFileSync("migrations/" + row.file)), row.sha256, row.file);
});

test("published rows keep their executeAs role and pinned prerequisites", () => {
  for (const [index, row] of published.entries()) {
    const { executeAs, prerequisites } = manifest.migrations[index];
    assert.equal(executeAs, publishedExecuteAs(row.sequence), row.file);
    assert.deepEqual(prerequisites, publishedPrerequisites.get(row.sequence), row.file);
  }
});

test("every published prerequisite file still hashes to its pinned digest", () => {
  const pinned = [...publishedPrerequisites.values()].flat();
  assert.equal(pinned.length, 6);
  for (const { file, sha256 } of pinned) assert.equal(sha(readFileSync(file)), sha256, file);
});

// The manifest is append-only: published rows are an unchanged, index-aligned
// prefix (above) and every row continues the sequence with no gap, so a new
// migration can never be inserted ahead of a published one.
test("migrations after the published prefix continue the sequence", () => {
  for (const [index, row] of manifest.migrations.entries()) {
    assert.equal(row.sequence, index + 1);
    assert.equal(row.file.startsWith(String(index + 1).padStart(4, "0") + "."), true);
  }
});

// ---------------------------------------------------------------------------
// ADR-0020 item 7 (P04.T01j D6): the one-time rebaseline of 0005-0015, so that a
// non-superuser CREATEROLE administrator can apply the chain. Exactly one record exists;
// a second needs a new owner-approved ADR. `closedBy` stays null until a persistent
// database first applies any of 0005-0015, and then names that live record (P04.T01i
// PR-D part 2). After closure every fix is a forward migration. The superseded digests
// are the bytes of `main` f8314e8.
const rebaselines = Object.freeze([
  Object.freeze({
    adr: "ADR-0020",
    sequences: Object.freeze([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    superseded: Object.freeze({
      5: "e42e91b7cbb2de9c59591346212fb250aed0c8cdba6edb6bd787dcceda78de92",
      6: "1f67f961c778ec6c67b9050b7c6290fe8a3c0072f1bc8126e974ee243fae6d87",
      7: "f176659d8b9eac84df4f4f427949f3edd2b878091c94e8b1918e6d5f41e4e103",
      8: "a4325cb7bf8b90fc0084f95de2e1317c344e3b6187ccd91f3a431cacb1243fa0",
      9: "9ab7fbaba7629c88034b1002b880601c322b405396e8fa824a585b6a2e9f37a2",
      10: "51c6d7ca9e31a897352c4a8b2e85824eb4a7b58506629246bce63c9d92070475",
      11: "089ff5487030df8f085045f37f523522540759752b7fde25abf91629396f28c4",
      12: "52e9f699956ec8932056b22b2dc5294e540225562730666e0a87d00dfe857579",
      13: "df215e288e6dda31fb62cb70b86354507d054a6e9f1df481891a4a5552e5d763",
      14: "efd6112f419df1b5270b5a7a308f00816cfc14900a7c28b6e25ae56aa38b5201",
      15: "06b0457b93a211866d981ade631f29618f34ff58f6bba309008886e1cfbdcfd9",
    }),
    closedBy: null,
  }),
]);
const supersededDigests = new Set(rebaselines.flatMap((r) => Object.values(r.superseded)));
const publishedText = (sequence) =>
  readFileSync("migrations/" + published[sequence - 1].file, "utf8");

// The bounded diff (P04.T01j D3). Each "no membership row" conjunct the rebaseline
// replaced, in file order: [apply or run time, row alias, catalog-qualified]. Apply-time
// sites became memberships_closed(alias.rolname); run-time executor guards became
// executor_memberships_closed(alias.rolname). Every other byte of each guard is unchanged.
const genericSites = Object.freeze({
  5: [["run", "x", false]],
  6: [
    ["apply", "r", false],
    ["run", "r", false],
  ],
  7: [
    ["apply", "r", true],
    ["run", "r", true],
  ],
  8: [
    ["apply", "r", true],
    ["run", "r", true],
    ["run", "x", false],
  ],
  9: [
    ["apply", "r", true],
    ["run", "x", true],
  ],
  10: [
    ["apply", "r", false],
    ["run", "r", false],
  ],
  11: [
    ["apply", "r", false],
    ["run", "r", false],
    ["run", "r", false],
    ["run", "r", false],
  ],
  12: [["apply", "r", false]],
  13: [
    ["apply", "r", false],
    ["run", "r", false],
  ],
  14: [["run", "x", false]],
  15: [],
});
const oldConjunct = (alias, qualified) =>
  `NOT EXISTS(SELECT 1 FROM ${qualified ? "pg_catalog." : ""}pg_auth_members m WHERE m.member=${alias}.oid OR m.roleid=${alias}.oid)`;
// The other exact changes, as [rebaselined bytes, superseded bytes]: the 0005 apply-time
// check, the comment lines that cited the immutability rule (0012, 0013) or that the new
// grant made inaccurate (0014), the 0014 check and grant, and the 0015 block.
const exactChanges = Object.freeze({
  5: [
    [
      "    OR NOT morrow_identity.memberships_closed('morrow_identity_linking') OR NOT morrow_identity.morrow_memberships_closed()\n",
      "    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='morrow_identity_linking') OR roleid=(SELECT oid FROM pg_roles WHERE rolname='morrow_identity_linking'))\n",
    ],
  ],
  12: [
    [
      "-- 0001-0004 stay byte-identical; 0005-0015 were rebaselined once under ADR-0020. Legacy\n-- configuration rows stay readable and\n",
      "-- Applied 0001-0011 bytes stay unchanged. Legacy configuration rows stay readable and\n",
    ],
  ],
  13: [
    [
      "-- Part B, ADR-0009). 0001-0004 stay byte-identical; 0005-0015 were rebaselined once\n-- under ADR-0020. Enrollment confers no tenant\n",
      "-- Part B, ADR-0009). Applied 0001-0012 bytes stay unchanged. Enrollment confers no tenant\n",
    ],
  ],
  14: [
    [
      "-- It changes no identity table. It adds four definer functions that only\n-- morrow_work_command may execute, plus the schema usage and column REFERENCES the\n-- work tables' composite foreign keys need; it lets morrow_work_owner execute three\n-- read-only ADR-0020 membership helpers, which 0015 checks; and it gives the three identity\n",
      "-- It changes no identity table or grant. It adds four definer functions that only\n-- morrow_work_command may execute, plus the schema usage and column REFERENCES the\n-- work tables' composite foreign keys need, and it gives the three identity\n",
    ],
    [
      " OR NOT morrow_identity.morrow_memberships_closed()\n OR to_regprocedure(",
      " OR to_regprocedure(",
    ],
    [
      "-- ADR-0020: 0015 checks the closed membership set while it runs as the work owner.\nGRANT EXECUTE ON FUNCTION morrow_identity.recorded_administrator(),morrow_identity.memberships_closed(name),morrow_identity.morrow_memberships_closed() TO morrow_work_owner;\n",
      "",
    ],
  ],
  15: [
    [
      " -- true), and every membership row naming a Morrow role is in the ADR-0020 closed set.\n",
      " -- true), plus at most one PG16+ CREATEROLE provisioning row per role whose\n -- member is not a Morrow role (admin true, inherit false, set false).\n",
    ],
    [
      " OR NOT morrow_identity.morrow_memberships_closed()\n OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles w,pg_catalog.pg_roles i\n",
      " OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid=m.roleid JOIN pg_catalog.pg_roles u ON u.oid=m.member\n" +
        "   WHERE (g.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker') OR u.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker'))\n" +
        "   AND (g.rolname,u.rolname) NOT IN (('morrow_work_api','morrow_api_worker'),('morrow_work_command','morrow_work_owner'))\n" +
        "   AND NOT (u.rolname NOT LIKE 'morrow\\_%' AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option))\n" +
        " OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles w,pg_catalog.pg_roles i\n",
    ],
  ],
});
// The D1-D2 preamble of 0005, right after its BEGIN: one table, its policy and trigger,
// five functions and the administrator check; no GRANT. It is new text, so the undo below
// removes it whole; these exact bytes bound it instead, like the exact 0014 and 0015
// inserts above. A pre-closure correction (ADR-0020 item 7) changes this pin in review,
// and the statement list below still refuses any statement outside D1 and D2.
const preambleSha256 = "e44f092dff788b8c7b6c37504540a51f2979eff633757d7df31c62fc9628c2a0";
const preambleStart = "BEGIN;\n-- ADR-0020 (P04.T01j D1-D2): ";
const preambleEnd = "END $$;\n-- Controlled local linking only.";
function splitPreamble(text) {
  assert.ok(text.startsWith(preambleStart));
  assert.equal(text.split(preambleEnd).length, 2);
  const end = text.indexOf(preambleEnd) + "END $$;\n".length;
  return { preamble: text.slice("BEGIN;\n".length, end), rest: "BEGIN;\n" + text.slice(end) };
}
const helperCall = /morrow_identity\.(executor_)?memberships_closed\(([rx])\.rolname\)/g;
// Undoes the D3 substitutions with function replacements: in a JavaScript replacement
// string "$$" collapses to "$" (measured in M-J0), and these bytes are full of "$$".
function undoRebaseline(sequence, text) {
  if (sequence === 5) text = splitPreamble(text).rest;
  for (const [now, before] of exactChanges[sequence] ?? []) {
    assert.equal(text.split(now).length, 2, `${sequence}: ${now.slice(0, 40)}`);
    text = text.replace(now, () => before);
  }
  const sites = genericSites[sequence];
  const found = [...text.matchAll(helperCall)].map((m) => [m[1] ? "run" : "apply", m[2]]);
  assert.deepEqual(
    found,
    sites.map(([time, alias]) => [time, alias]),
    `${sequence}: helper call sites`,
  );
  let index = 0;
  return text.replace(helperCall, () => {
    const [, alias, qualified] = sites[index++];
    return oldConjunct(alias, qualified);
  });
}

// ADR-0020 item 7 makes the exception conditional on the owner's confirmation that no
// database they know of applied 0005 or later. The ADR's Approval section must quote it.
const confirmationLine =
  /^Item 7 confirmation, [0-9]{4}-[0-9]{2}-[0-9]{2}, in chat\. .*the owner answered "[^"]+"/m;
test("ADR-0020: exactly one rebaseline record, and only while its ADR is Accepted", () => {
  assert.equal(rebaselines.length, 1);
  const index = readFileSync("docs/decisions/adr/README.md", "utf8").split("\n");
  for (const record of rebaselines) {
    const number = /^ADR-([0-9]{4})$/.exec(record.adr)?.[1];
    assert.ok(number, record.adr);
    const rows = index.filter((line) => line.startsWith(`| [${number}](ADR-${number}-`));
    assert.equal(rows.length, 1, record.adr);
    const cells = rows[0].split("|").map((cell) => cell.trim());
    assert.match(cells.at(-2), /^Accepted /, record.adr + " must be Accepted in the index");
    const file = /\]\((ADR-[0-9]{4}-[a-z0-9-]+\.md)\)/.exec(rows[0])?.[1];
    assert.ok(file, record.adr);
    const approval = readFileSync("docs/decisions/adr/" + file, "utf8").split("\n## Approval\n");
    assert.equal(approval.length, 2, record.adr + " has one Approval section");
    assert.match(approval[1], confirmationLine, record.adr + " item 7 confirmation is quoted");
    assert.doesNotMatch(approval[1], /not quoted in this record/);
    assert.deepEqual(
      Object.keys(record.superseded).map(Number),
      [...record.sequences],
      "superseded digests cover exactly the rebaselined sequences",
    );
    for (const sequence of record.sequences) {
      assert.ok(sequence >= 5 && sequence <= published.length, String(sequence));
      assert.match(record.superseded[sequence], /^[a-f0-9]{64}$/);
      assert.notEqual(record.superseded[sequence], published[sequence - 1].sha256);
    }
    if (record.closedBy !== null) {
      assert.match(
        record.closedBy,
        /^docs\/evidence\/live\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\.md$/,
      );
      assert.ok(existsSync(record.closedBy), record.closedBy);
    }
  }
});

test("ADR-0020: no superseded digest appears in the manifest or in any migration file", () => {
  for (const row of manifest.migrations)
    assert.ok(!supersededDigests.has(row.sha256), row.file + " manifest row");
  for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")))
    assert.ok(!supersededDigests.has(sha(readFileSync("migrations/" + file))), file);
});

test("ADR-0020: undoing the D3 substitutions reproduces every superseded digest", () => {
  const [record] = rebaselines;
  let generic = 0;
  for (const sequence of record.sequences) {
    const restored = undoRebaseline(sequence, publishedText(sequence));
    assert.equal(sha(restored), record.superseded[sequence], published[sequence - 1].file);
    generic += genericSites[sequence].length;
  }
  // 20 generic substitutions, plus 0005:8 and the 0015 block (P04.T01j D3 "Totals").
  assert.equal(generic, 20);
  assert.deepEqual(
    record.sequences.map((s) => genericSites[s].length),
    [1, 2, 2, 3, 2, 2, 4, 1, 2, 1, 0],
  );
});

// The preamble's top-level statements, in order, with whitespace collapsed. Routine and DO
// bodies are bound by the digest; their heads, and every other statement, are exact.
const preambleStatements = Object.freeze([
  /^CREATE TABLE morrow_identity\.migration_administrator\(singleton boolean PRIMARY KEY DEFAULT true CHECK\(singleton\), role_oid oid NOT NULL, role_name name NOT NULL, recorded_at timestamptz NOT NULL DEFAULT statement_timestamp\(\)\)$/,
  /^INSERT INTO morrow_identity\.migration_administrator\(role_oid,role_name\) SELECT r\.oid,r\.rolname FROM pg_catalog\.pg_roles r WHERE r\.rolname=session_user AND r\.rolcanlogin AND \(r\.rolsuper OR r\.rolcreaterole\) AND r\.rolname NOT LIKE 'morrow\\_%'$/,
  /^CREATE FUNCTION morrow_identity\.preserve_migration_administrator\(\) RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS \$\$[^$]*\$\$$/,
  /^CREATE TRIGGER migration_administrator_immutable BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON morrow_identity\.migration_administrator FOR EACH STATEMENT EXECUTE FUNCTION morrow_identity\.preserve_migration_administrator\(\)$/,
  /^REVOKE ALL ON morrow_identity\.migration_administrator FROM PUBLIC$/,
  /^ALTER TABLE morrow_identity\.migration_administrator ENABLE ROW LEVEL SECURITY$/,
  /^ALTER TABLE morrow_identity\.migration_administrator FORCE ROW LEVEL SECURITY$/,
  /^CREATE POLICY identity_owner ON morrow_identity\.migration_administrator FOR SELECT TO morrow_identity_owner USING\(true\)$/,
  /^CREATE FUNCTION morrow_identity\.recorded_administrator\(\) RETURNS oid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS \$\$[^$]*\$\$$/,
  /^CREATE FUNCTION morrow_identity\.memberships_closed\(p_role name\) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS \$\$[^$]*\$\$$/,
  /^CREATE FUNCTION morrow_identity\.morrow_memberships_closed\(\) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS \$\$[^$]*\$\$$/,
  /^CREATE FUNCTION morrow_identity\.executor_memberships_closed\(p_executor name\) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS \$\$[^$]*\$\$$/,
  /^REVOKE ALL ON FUNCTION morrow_identity\.preserve_migration_administrator\(\),morrow_identity\.recorded_administrator\(\), morrow_identity\.memberships_closed\(name\),morrow_identity\.morrow_memberships_closed\(\), morrow_identity\.executor_memberships_closed\(name\) FROM PUBLIC$/,
  /^DO \$\$ BEGIN IF current_user<>'morrow_identity_owner' OR [^$]* THEN RAISE EXCEPTION 'MIGRATION_ADMINISTRATOR_INVALID'; END IF; END \$\$$/,
]);
// Never in the preamble, in any statement or body: a grant, a drop, an owner or default
// privilege change, disabling or weakening row-level security or a trigger, or a
// redefinition.
const preambleForbidden =
  /\b(GRANT|DROP|OWNER\s+TO|DEFAULT\s+PRIVILEGES|NO\s+FORCE|DISABLE|OR\s+REPLACE|SECURITY\s+INVOKER|BYPASSRLS|SET\s+ROLE)\b/i;

test("ADR-0020: the 0005 preamble is exactly the pinned D1 and D2 text", () => {
  const { preamble } = splitPreamble(publishedText(5));
  assert.equal(sha(preamble), preambleSha256);
  const { statements, code, metaCommand } = scanSqlScript(preamble);
  assert.equal(metaCommand, false);
  assert.doesNotMatch(code, preambleForbidden);
  const collapsed = statements.map((s) => s.replace(/\s+/g, " "));
  assert.equal(collapsed.length, preambleStatements.length, collapsed.join("\n"));
  for (const [index, statement] of collapsed.entries())
    assert.match(statement, preambleStatements[index], `preamble statement ${index + 1}`);
});

test("ADR-0020: the 0005 preamble defines only the D1 and D2 objects", () => {
  const { preamble } = splitPreamble(publishedText(5));
  const created = [
    ...preamble.matchAll(/^CREATE (TABLE|FUNCTION|TRIGGER|POLICY) ([a-z_.]+)/gm),
  ].map((m) => m[1] + " " + m[2]);
  assert.deepEqual(created, [
    "TABLE morrow_identity.migration_administrator",
    "FUNCTION morrow_identity.preserve_migration_administrator",
    "TRIGGER migration_administrator_immutable",
    "POLICY identity_owner",
    "FUNCTION morrow_identity.recorded_administrator",
    "FUNCTION morrow_identity.memberships_closed",
    "FUNCTION morrow_identity.morrow_memberships_closed",
    "FUNCTION morrow_identity.executor_memberships_closed",
  ]);
  assert.ok(!/^\s*GRANT /m.test(preamble), "the preamble grants nothing");
  assert.match(
    preamble,
    /FOR EACH STATEMENT EXECUTE FUNCTION morrow_identity\.preserve_migration_administrator\(\)/,
  );
  assert.match(preamble, /FOR SELECT TO morrow_identity_owner USING\(true\);/);
  assert.equal((preamble.match(/SECURITY DEFINER/g) ?? []).length, 1);
  assert.match(preamble, /RAISE EXCEPTION 'MIGRATION_ADMINISTRATOR_INVALID'/);
});

// ADR-0020 item 6: migrations after 0015 call the helpers and carry no catalog membership
// text of their own. In 0005-0015 the only occurrences are the two D1-D2 helpers that
// read pg_auth_members, the unchanged 0006 owner check and 0015's reviewed-pair count.
test("ADR-0020: pg_auth_members appears only in the helpers and two reviewed checks", () => {
  for (const row of manifest.migrations.filter((r) => r.sequence > 15))
    assert.ok(
      !readFileSync("migrations/" + row.file, "utf8").includes("pg_auth_members"),
      row.file + " must use the ADR-0020 helpers",
    );
  const lines = (sequence) =>
    publishedText(sequence)
      .split("\n")
      .filter((l) => l.includes("pg_auth_members"));
  const { preamble } = splitPreamble(publishedText(5));
  // Two helper bodies (recorded_administrator, memberships_closed) and one comment line.
  assert.equal(lines(5).filter((l) => !l.startsWith("--")).length, 2);
  assert.equal(lines(5).length, 3);
  assert.ok(lines(5).every((l) => preamble.includes(l)));
  assert.deepEqual(lines(6), [
    " OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='morrow_identity_owner') AND member IN (SELECT oid FROM pg_roles WHERE rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth')))",
  ]);
  assert.deepEqual(lines(15), [
    " OR (SELECT count(*) FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid=m.roleid JOIN pg_catalog.pg_roles u ON u.oid=m.member",
  ]);
  for (const sequence of [7, 8, 9, 10, 11, 12, 13, 14]) assert.deepEqual(lines(sequence), []);
});
