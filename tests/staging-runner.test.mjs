// P04.T01i PR-B: the pure parts of the staging runner and its CLI (AC06 refusals that
// need no database, the chain module, the card, the census, the tool parsers, token
// isolation). PostgreSQL behaviour is qualified by lab:staging-runner (pg-http).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  loadMigrationChain,
  migrationBody,
  prerequisiteRoles,
  schemaHead,
  topLevelStatements,
} from "../scripts/migration-chain.mjs";
import {
  checkAdministrator,
  checkIdentity,
  ledgerDrift,
  morrowSetRowsQuery,
  neonConnector,
  passwordDigest,
  passwordLiteral,
  platformSeedRows,
  provisioningSql,
  runMigrations,
  provisionRoles,
  scramVerifier,
  statementLoggingRefusal,
  statementStatsFacts,
  statementStatsVerificationQuery,
  wipeStatementStats,
} from "../scripts/staging-runner.mjs";
import {
  d4Transaction,
  migrationBody as fixtureMigrationBody,
  morrowSetRowsSql,
} from "../scripts/fixtures/createrole-administrator.mjs";
import {
  cardState,
  censusFindings,
  closedReport,
  commands,
  connectAttemptTimeoutMs,
  main,
  mainPreconditions,
} from "../scripts/staging.mjs";
import { parseOwnerUrl } from "../scripts/staging-files.mjs";
import {
  cloudflareApi,
  githubNames,
  newestVersionId,
  secretNames,
} from "../scripts/staging-tools.mjs";
import { syntheticCredential } from "../scripts/staging-token.mjs";
import { ledgerRecord } from "../scripts/migration-chain.mjs";
import {
  approvedCard,
  fakeCloudflare,
  fakeContext,
  fakeDatabase,
  fakeSha,
  fakeTools,
  labBinding,
  plantedHome,
} from "./fixtures/staging-fakes.mjs";

const read = (path) => readFileSync(path, "utf8");
const sha = (text) => createHash("sha256").update(text).digest("hex");
const manifest = JSON.parse(read("migrations/manifest.json"));
const chain = loadMigrationChain();
const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code ?? error.message;
  }
};

// ---------------------------------------------------------------------------
// The chain module (D3 "Chain module").
test("chain: the manifest's rows, digests, executeAs and pinned prerequisites", () => {
  assert.deepEqual(
    chain.map((e) => [e.sequence, e.file, e.sha256, e.executeAs]),
    manifest.migrations.map((m) => [m.sequence, m.file, m.sha256, m.executeAs]),
  );
  for (const [i, entry] of chain.entries()) {
    assert.deepEqual(
      entry.prerequisites.map((p) => ({ file: p.file, sha256: p.sha256 })),
      manifest.migrations[i].prerequisites ?? [],
    );
    for (const p of entry.prerequisites) assert.equal(sha(p.text), p.sha256);
    assert.equal(entry.text, read("migrations/" + entry.file));
    assert.equal(
      "BEGIN;\n" + entry.body + "COMMIT;\n",
      entry.text.endsWith("\n") ? entry.text : entry.text + "\n",
    );
  }
  assert.deepEqual(chain[13].prerequisites[0].roles, [
    "morrow_work_owner",
    "morrow_work_command",
    "morrow_work_api",
    "morrow_api_worker",
  ]);
  assert.equal(chain[0].prerequisites[0].roles.length, 7);
});

test("chain: transaction control and identity changes are refused in a body", () => {
  for (const body of [
    "COMMIT;\nSELECT 1;",
    "END;",
    "ROLLBACK;",
    "SAVEPOINT a;",
    "SET ROLE morrow_api;",
    "SET LOCAL ROLE morrow_api;",
    "RESET ROLE;",
    "SET SESSION AUTHORIZATION postgres;",
    "RESET ALL;",
    "DISCARD ALL;",
    "PREPARE TRANSACTION 'x';",
    "\\connect other",
    "SELECT 1; begin;",
    "SELECT set_config('role', 'neondb_owner', true);",
    "SELECT pg_catalog.set_config( 'ROLE' , 'neondb_owner', false);",
    "SELECT set_config('session_authorization', 'postgres', true);",
    "DO $$ BEGIN PERFORM set_config($q$role$q$, 'neondb_owner', true); END $$;",
  ])
    assert.equal(
      codeOf(() => migrationBody("BEGIN;\n" + body + "\nCOMMIT;\n")),
      "MIGRATION_TRANSACTION_CONTROL",
      body,
    );
  for (const text of [
    "SELECT 1;\nCOMMIT;\n",
    "BEGIN;\nSELECT 1;\n",
    "BEGIN;\nCOMMIT;\n",
    " BEGIN;\nx;\nCOMMIT;\n",
  ])
    assert.equal(
      codeOf(() => migrationBody(text)),
      "MIGRATION_TRANSACTION_ENVELOPE",
      text,
    );
  assert.equal(
    codeOf(() => migrationBody("BEGIN;\nSELECT 'open;\nCOMMIT;\n")),
    "MIGRATION_TRANSACTION_CONTROL",
  );
  // Quoted, dollar-quoted, commented and BEGIN ATOMIC text is not top-level control.
  const body = migrationBody(
    [
      "BEGIN;",
      "DO $$ BEGIN COMMIT; END $$;",
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 END; SELECT 2; END;",
      "CREATE OR REPLACE PROCEDURE p() LANGUAGE sql BEGIN ATOMIC SELECT 1; END;",
      "SELECT $tag$ COMMIT; $tag$, 'it''s; COMMIT', E'\\' ROLLBACK;', \"COMMIT;\";",
      "-- COMMIT; SET ROLE x;",
      "/* COMMIT; /* nested */ RESET ROLE; */ SELECT 1;",
      "SELECT pg_catalog.set_config('morrow.role', 'role', true);",
      "COMMIT;",
    ].join("\n") + "\n",
  );
  assert.equal(topLevelStatements(body).length, 6);
});

test("chain: prerequisite roles are parsed exactly, and transaction control denies", () => {
  assert.deepEqual(
    prerequisiteRoles("CREATE ROLE morrow_a NOLOGIN;\nCREATE ROLE morrow_b NOLOGIN;\n"),
    ["morrow_a", "morrow_b"],
  );
  assert.equal(
    codeOf(() => prerequisiteRoles("GRANT x TO y;")),
    "PREREQUISITE_ROLES_INVALID",
  );
  assert.equal(
    codeOf(() => prerequisiteRoles("CREATE ROLE morrow_a;\nCREATE ROLE morrow_a;")),
    "PREREQUISITE_ROLES_INVALID",
  );
  assert.equal(
    codeOf(() => prerequisiteRoles("CREATE ROLE morrow_a;\nCOMMIT;\nCREATE ROLE morrow_b;")),
    "PREREQUISITE_TRANSACTION_CONTROL",
  );
});

test("chain: a wrong sha256 on a prerequisite or a migration, or unreviewed bytes, refuse the chain", () => {
  const variant = (change) => {
    const root = mkdtempSync(join(tmpdir(), "morrow-chain-test-"));
    try {
      cpSync("migrations", join(root, "migrations"), { recursive: true });
      mkdirSync(join(root, "infra"));
      for (const m of manifest.migrations)
        for (const p of m.prerequisites ?? []) cpSync(p.file, join(root, p.file));
      change(root);
      try {
        loadMigrationChain({ root });
        return [];
      } catch (error) {
        assert.equal(error.code, "MIGRATION_CHAIN_INVALID");
        assert.doesNotMatch(error.message, /\//);
        return error.codes;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  assert.deepEqual(
    variant(() => {}),
    [],
  );
  assert.deepEqual(
    variant((root) =>
      writeFileSync(join(root, "infra/work-role-prerequisites.sql"), "-- changed\n"),
    ),
    ["PREREQUISITE_CHECKSUM"],
  );
  assert.deepEqual(
    variant((root) =>
      writeFileSync(
        join(root, "migrations/0002.identity-grants.sql"),
        "BEGIN;\nSELECT 1;\nCOMMIT;\n",
      ),
    ),
    ["MIGRATION_CHECKSUM"],
  );
  assert.deepEqual(
    variant((root) =>
      writeFileSync(join(root, "migrations/0099.unreviewed.sql"), "BEGIN;\nCOMMIT;\n"),
    ),
    ["UNREVIEWED_MIGRATION_FILE"],
  );
  assert.deepEqual(
    variant((root) =>
      writeFileSync(join(root, "infra/extra-role-prerequisites.sql"), "CREATE ROLE morrow_x;\n"),
    ),
    ["UNREVIEWED_PREREQUISITE_FILE"],
  );
});

// P04.T01j D4 is the runner's contract (P04.T01j-AC14, P04.md): each entry's statements
// are d4Transaction's, in order, with the end-of-body role check before RESET ROLE and the
// ledger INSERT before COMMIT; the body is the fixture's migrationBody for every manifest
// row; and the catalog check reads every Morrow SET row but the two reviewed ones, as the
// fixture's morrowSetRowsSql does.
test("D4: one entry is P04.T01j's d4Transaction, plus the role check and the ledger row", async () => {
  for (const entry of chain) assert.equal(entry.body, fixtureMigrationBody(entry), entry.file);
  const entry = chain.find((e) => e.prerequisites.length === 0);
  const admin = "neondb_owner";
  const rows = [];
  const db = fakeDatabase({
    rules: [
      [/pg_advisory_(un)?lock/, () => [{ locked: "" }]],
      [
        /^SELECT n\.nspowner = r\.oid/,
        () => [
          {
            owned: true,
            schema_private: true,
            table_private: true,
            columns:
              "sequence:integer,file:text,sha256:text,execute_as:name,prerequisites:jsonb,source_commit:text,applied_at:timestamp with time zone,applied_by:name",
          },
        ],
      ],
      [/FROM morrow_migrations\.applied ORDER BY sequence$/, () => rows.map((r) => ({ ...r }))],
      [/nspname <> 'morrow_migrations'/, () => [{ n: 0 }]],
      [/pg_backend_pid/, () => [{ pid: 4242 }]],
      [/coalesce\(max\(sequence\), 0\)/, () => [{ n: rows.length, last: 0 }]],
      [
        /^SELECT current_user::text AS current_role, session_user/,
        () => [{ current_role: entry.executeAs, session_role: admin }],
      ],
      [
        /^INSERT INTO morrow_migrations\.applied/,
        () => {
          rows.push({
            sequence: entry.sequence,
            file: entry.file,
            sha256: entry.sha256,
            execute_as: entry.executeAs,
            prerequisites: "[]",
            source_commit: "4".repeat(40),
          });
          return [];
        },
      ],
    ],
  });
  const result = await runMigrations({
    connect: db.connector().connect,
    chain: [entry],
    binding: labBinding,
    administrator: { name: admin, mode: "createrole" },
    sourceCommit: "4".repeat(40),
  });
  assert.deepEqual(result.applied, [entry.sequence]);
  const sent = db.statements.map((s) => s.text);
  const begin = sent.indexOf("BEGIN");
  const x = entry.executeAs;
  const d4 = [
    "BEGIN",
    `GRANT ${x} TO ${admin} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
    `SET LOCAL ROLE ${x}`,
    entry.body,
    "RESET ROLE",
    `REVOKE ${x} FROM ${admin} GRANTED BY ${admin}`,
    "COMMIT",
  ];
  // The fixture's script is exactly these statements.
  assert.equal(d4Transaction(entry, admin), d4.map((s, i) => (i === 3 ? s : s + ";\n")).join(""));
  const transaction = sent.slice(begin, sent.indexOf("COMMIT", begin) + 1);
  assert.deepEqual(
    transaction.filter((s) => d4.includes(s)),
    d4,
  );
  const at = (prefix) => transaction.findIndex((s) => s.startsWith(prefix));
  assert.ok(at("SELECT current_user::text") > transaction.indexOf(entry.body));
  assert.ok(at("SELECT current_user::text") < transaction.indexOf("RESET ROLE"));
  assert.ok(at("INSERT INTO morrow_migrations.applied") > at("REVOKE "));
  assert.ok(at("INSERT INTO morrow_migrations.applied") < transaction.indexOf("COMMIT"));
  // The catalog check: before the run and after the entry, with the fixture's reading.
  assert.ok(sent.filter((s) => s === morrowSetRowsQuery).length >= 2);
  const normalise = (sql) =>
    sql
      .replace(/^SELECT count\(\*\)(::int AS n)?/, "SELECT count(*)")
      .replace(/\s+/g, "")
      .toLowerCase();
  assert.equal(normalise(morrowSetRowsQuery), normalise(morrowSetRowsSql));
});

test("schema head: the ordered (sequence, file, sha256, executeAs, prerequisites) list", () => {
  const head = schemaHead(chain);
  assert.match(head, /^[0-9a-f]{64}$/);
  assert.equal(schemaHead(loadMigrationChain()), head);
  const changed = (entryChange) =>
    schemaHead(chain.map((e, i) => (i === 4 ? { ...e, ...entryChange(e) } : e)));
  assert.notEqual(
    changed(() => ({ sha256: "0".repeat(64) })),
    head,
  );
  assert.notEqual(
    changed(() => ({ executeAs: "morrow_work_owner" })),
    head,
  );
  assert.notEqual(
    changed(() => ({ file: "0005.renamed.sql" })),
    head,
  );
  assert.notEqual(
    changed(() => ({
      prerequisites: [
        { file: "infra/x-prerequisites.sql", sha256: "1".repeat(64), roles: ["morrow_x"] },
      ],
    })),
    head,
  );
  assert.notEqual(schemaHead(chain.slice(0, -1)), head);
});

// ---------------------------------------------------------------------------
// Ledger drift (D3 step 2; P04.T01j AC14).
const ledgerRow = (entry, change = {}) => {
  const r = ledgerRecord(entry);
  return {
    sequence: r.sequence,
    file: r.file,
    sha256: r.sha256,
    execute_as: r.executeAs,
    prerequisites: JSON.stringify(r.prerequisites),
    source_commit: "a".repeat(40),
    ...change,
  };
};
test("ledger drift: a prefix passes; any changed record, superseded digest or extra row is drift", () => {
  assert.equal(ledgerDrift([], chain), null);
  assert.equal(
    ledgerDrift(
      chain.slice(0, 7).map((e) => ledgerRow(e)),
      chain,
    ),
    null,
  );
  assert.equal(
    ledgerDrift(
      chain.map((e) => ledgerRow(e)),
      chain,
    ),
    null,
  );
  const rows = chain.slice(0, 6).map((e) => ledgerRow(e));
  const at = (i, change) =>
    ledgerDrift(
      rows.map((r, j) => (j === i ? { ...r, ...change } : r)),
      chain,
    );
  // The digest P04.T01j records as superseded for 0005 reads as drift once 0005 changes.
  assert.deepEqual(at(4, { sha256: "0".repeat(64) }), { reason: "digest", sequence: 5 });
  assert.deepEqual(at(2, { file: "0003.renamed.sql" }), { reason: "record", sequence: 3 });
  assert.deepEqual(at(1, { sequence: 9 }), { reason: "record", sequence: 9 });
  assert.deepEqual(at(3, { execute_as: "morrow_work_owner" }), { reason: "record", sequence: 4 });
  assert.deepEqual(at(0, { prerequisites: "[]" }), { reason: "record", sequence: 1 });
  assert.deepEqual(at(0, { prerequisites: "not json" }), { reason: "record", sequence: 1 });
  assert.deepEqual(
    at(0, {
      prerequisites: JSON.stringify([{ ...ledgerRecord(chain[0]).prerequisites[0], runAs: "x" }]),
    }),
    { reason: "record", sequence: 1 },
  );
  assert.deepEqual(
    ledgerDrift(
      [...chain.map((e) => ledgerRow(e)), { ...ledgerRow(chain[0]), sequence: 99 }],
      chain,
    ),
    { reason: "ahead", sequence: 99 },
  );
});

// ---------------------------------------------------------------------------
// Identity refusals (D3 "Refusal"; ADR-0020 item 1).
const identity = (change = {}) => ({
  session_role: "neondb_owner",
  current_role: "neondb_owner",
  database: "morrow",
  version: 170011,
  superuser: false,
  createrole: true,
  login: true,
  ...change,
});
const hosted = { name: "neondb_owner", mode: "createrole" };
test("identity: database, server major, session role, no SET ROLE, administrator shape", () => {
  assert.equal(
    codeOf(() => checkIdentity(identity(), labBinding, hosted)),
    null,
  );
  for (const [change, code] of [
    [{ database: "postgres" }, "STAGING_DATABASE_MISMATCH"],
    [{ version: 160004 }, "STAGING_SERVER_VERSION"],
    [{ version: 180000 }, "STAGING_SERVER_VERSION"],
    [{ session_role: "morrow_api" }, "STAGING_SESSION_ROLE"],
    [{ current_role: "morrow_identity_owner" }, "STAGING_SESSION_ROLE"],
    [{ superuser: true }, "STAGING_ADMINISTRATOR_SHAPE"],
    [{ createrole: false }, "STAGING_ADMINISTRATOR_SHAPE"],
    [{ login: false }, "STAGING_ADMINISTRATOR_SHAPE"],
  ])
    assert.equal(
      codeOf(() => checkIdentity(identity(change), labBinding, hosted)),
      code,
      JSON.stringify(change),
    );
  assert.equal(
    codeOf(() => checkIdentity(undefined, labBinding, hosted)),
    "STAGING_SESSION_ROLE",
  );
  const lab = { name: "postgres", mode: "superuser" };
  assert.equal(
    codeOf(() =>
      checkIdentity(
        identity({ session_role: "postgres", current_role: "postgres", superuser: true }),
        labBinding,
        lab,
      ),
    ),
    null,
  );
  assert.equal(
    codeOf(() =>
      checkIdentity(
        identity({ session_role: "postgres", current_role: "postgres" }),
        labBinding,
        lab,
      ),
    ),
    "STAGING_ADMINISTRATOR_SHAPE",
  );
  for (const bad of [
    { name: "morrow_identity_owner", mode: "createrole" },
    { name: "neondb_owner", mode: "owner" },
    { name: "Neon", mode: "createrole" },
    null,
  ])
    assert.equal(
      codeOf(() => checkAdministrator(bad)),
      "STAGING_ADMINISTRATOR_INVALID",
    );
});

// ---------------------------------------------------------------------------
// Role controls (D3, AC07; M-N3 as amended 2026-10-20): each generated plaintext reaches
// SQL once, in its own ALTER ROLE statement, after the statement-statistics check.
// The verifier form stays for neon-probe (it records Neon's refusal) and the lab.
test("scram verifier: PostgreSQL's SCRAM-SHA-256 stored form, independent of the plaintext", async () => {
  const salt = Buffer.alloc(16, 7);
  const password = "A".repeat(43);
  const verifier = scramVerifier(password, { salt });
  assert.equal(scramVerifier(password, { salt }), verifier);
  assert.match(
    verifier,
    /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/,
  );
  assert.ok(!verifier.includes(password));
  // An independent derivation through WebCrypto (PBKDF2, HMAC, SHA-256).
  const subtle = webcrypto.subtle;
  const key = await subtle.importKey("raw", Buffer.from(password), "PBKDF2", false, ["deriveBits"]);
  const salted = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 4096 },
    key,
    256,
  );
  const hmacKey = await subtle.importKey("raw", salted, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const clientKey = await subtle.sign("HMAC", hmacKey, Buffer.from("Client Key"));
  const storedKey = Buffer.from(await subtle.digest("SHA-256", clientKey)).toString("base64");
  const serverKey = Buffer.from(
    await subtle.sign("HMAC", hmacKey, Buffer.from("Server Key")),
  ).toString("base64");
  assert.equal(verifier, `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`);
  assert.notEqual(scramVerifier(password), scramVerifier(password));
  for (const bad of ["short", "has space in it ok", "x".repeat(1025), 42])
    assert.equal(
      codeOf(() => scramVerifier(bad)),
      "STAGING_PASSWORD_INVALID",
    );
});

test("provisioning SQL: LOGIN with the plaintext, the limit, both timeouts, REVOKE TEMP", () => {
  const password = "p".repeat(21) + "_-" + "Q9".repeat(10);
  const statements = provisioningSql({
    roles: ["morrow_api", "morrow_api_worker"],
    passwords: new Map([["morrow_api", password]]),
    database: "morrow",
  });
  assert.deepEqual(statements, [
    "BEGIN",
    `ALTER ROLE morrow_api WITH LOGIN CONNECTION LIMIT 10 PASSWORD '${password}'`,
    "ALTER ROLE morrow_api SET statement_timeout = '5s'",
    "ALTER ROLE morrow_api SET idle_in_transaction_session_timeout = '10s'",
    "ALTER ROLE morrow_api_worker WITH LOGIN CONNECTION LIMIT 10",
    "ALTER ROLE morrow_api_worker SET statement_timeout = '5s'",
    "ALTER ROLE morrow_api_worker SET idle_in_transaction_session_timeout = '10s'",
    "REVOKE TEMP ON DATABASE morrow FROM PUBLIC",
    "COMMIT",
  ]);
  // The plaintext appears once, in its own role's statement.
  assert.equal(statements.filter((s) => s.includes(password)).length, 1);
  // Only the generated shape reaches the literal: 43 base64url characters, nothing that
  // could close or escape the string (no bind parameters exist for ALTER ROLE).
  for (const bad of [
    "p".repeat(42),
    "p".repeat(44),
    "p".repeat(42) + "'",
    "p".repeat(42) + "\\",
    "p".repeat(42) + " ",
    "p".repeat(42) + "=",
    "p".repeat(42) + "é",
    "SCRAM-SHA-256$4096:" + "A".repeat(24),
    42,
    null,
  ]) {
    assert.equal(
      codeOf(() =>
        provisioningSql({
          roles: ["morrow_api"],
          passwords: new Map([["morrow_api", bad]]),
          database: "morrow",
        }),
      ),
      "STAGING_PASSWORD_INVALID",
      String(bad),
    );
    assert.equal(
      codeOf(() => passwordLiteral(bad)),
      "STAGING_PASSWORD_INVALID",
    );
  }
  assert.equal(passwordLiteral(password), `'${password}'`);
  assert.equal(
    codeOf(() =>
      provisioningSql({ roles: ["morrow_api; DROP"], passwords: new Map(), database: "morrow" }),
    ),
    "STAGING_ROLE_INVALID",
  );
  assert.equal(
    codeOf(() =>
      provisioningSql({ roles: ["morrow_api"], passwords: new Map(), database: "morrow; x" }),
    ),
    "STAGING_DATABASE_MISMATCH",
  );
});

// pg_stat_statements keeps a utility statement's text with its literals, in every
// database once the module is loaded; the server log keeps it under any statement
// logging. The facts are closed values; anything unreadable or unexpected counts as
// recording, or as a logging value that refuses.
const statsRow = (change = {}) => ({
  extension: false,
  track: null,
  track_utility: null,
  password_encryption: "scram-sha-256",
  log_statement: "none",
  log_min_duration_statement: "-1",
  log_min_duration_sample: "-1",
  log_statement_sample_rate: "1",
  log_min_error_statement: "panic",
  log_duration: "off",
  debug_print_parse: "off",
  debug_print_rewritten: "off",
  debug_print_plan: "off",
  ...change,
});
test("statement statistics: the facts that let a password statement through, and nothing else", () => {
  assert.deepEqual(statementStatsFacts(statsRow()), {
    checked: true,
    extension: false,
    module: false,
    track: null,
    trackUtility: null,
    recording: false,
    passwordEncryption: "scram-sha-256",
    logStatement: "none",
    logMinDurationStatement: "disabled",
    logMinDurationSample: "disabled",
    logStatementSampleRate: "1",
    logMinErrorStatement: "panic",
    logDuration: "off",
    debugPrintParse: "off",
    debugPrintRewritten: "off",
    debugPrintPlan: "off",
  });
  for (const [label, change, recording, module] of [
    ["extension in the target database", { extension: true }, true, false],
    ["module loaded, default tracking", { track: "top", track_utility: "on" }, true, true],
    ["module loaded, all statements", { track: "all", track_utility: "on" }, true, true],
    ["module loaded, tracking off", { track: "none", track_utility: "on" }, false, true],
    ["module loaded, utility off", { track: "top", track_utility: "off" }, false, true],
    ["module half-read", { track: "top", track_utility: null }, true, true],
    [
      "extension with tracking off",
      { extension: true, track: "none", track_utility: "off" },
      true,
      true,
    ],
  ]) {
    const facts = statementStatsFacts(statsRow(change));
    assert.equal(facts.checked, true, label);
    assert.equal(facts.recording, recording, label);
    assert.equal(facts.module, module, label);
  }
  for (const unreadable of [
    null,
    undefined,
    {},
    statsRow({ extension: "f" }),
    statsRow({ extension: null }),
    statsRow({ track: "some" }),
    statsRow({ track_utility: "true" }),
    statsRow({ track: undefined }),
  ]) {
    const facts = statementStatsFacts(unreadable);
    assert.equal(facts.checked, false, JSON.stringify(unreadable));
    assert.equal(facts.recording, true, JSON.stringify(unreadable));
    assert.equal(facts.module, null);
  }
  const fact = (change, key) => statementStatsFacts(statsRow(change))[key];
  assert.equal(fact({ password_encryption: "md5" }, "passwordEncryption"), "md5");
  assert.equal(fact({ password_encryption: "x" }, "passwordEncryption"), null);
  assert.equal(fact({ log_statement: "ddl" }, "logStatement"), "ddl");
  assert.equal(fact({ log_statement: "x" }, "logStatement"), null);
  for (const [value, closed] of [
    ["-1", "disabled"],
    ["0", "enabled"],
    ["250ms", "enabled"],
    ["1s", "enabled"],
    ["-2", null],
    ["1 s", null],
    [null, null],
  ]) {
    assert.equal(fact({ log_min_duration_statement: value }, "logMinDurationStatement"), closed);
    assert.equal(fact({ log_min_duration_sample: value }, "logMinDurationSample"), closed);
  }
  for (const [value, closed] of [
    ["1", "1"],
    ["0", "0"],
    ["0.5", "0.5"],
    ["1e-05", null],
    ["2", null],
    ["1.5", null],
  ])
    assert.equal(fact({ log_statement_sample_rate: value }, "logStatementSampleRate"), closed);
  assert.equal(fact({ log_min_error_statement: "error" }, "logMinErrorStatement"), "error");
  assert.equal(fact({ log_min_error_statement: "PANIC" }, "logMinErrorStatement"), null);
  assert.equal(fact({ log_duration: "on" }, "logDuration"), "on");
  for (const [setting, key] of [
    ["debug_print_parse", "debugPrintParse"],
    ["debug_print_rewritten", "debugPrintRewritten"],
    ["debug_print_plan", "debugPrintPlan"],
  ]) {
    assert.equal(fact({ [setting]: "on" }, key), "on");
    assert.equal(fact({ [setting]: "true" }, key), null);
    assert.equal(fact({ [setting]: null }, key), null);
  }
});

// The server log must never be able to write a password statement's text: no statement
// logging, no duration threshold (or a sample rate of 0), log_min_error_statement at
// panic, and no debug_print output (parse and rewritten print the PASSWORD string). The
// debug_print settings are USERSET, so a database or role owner can turn them on.
// log_duration alone logs no text. Neon's staging values (measured 2026-10-20) pass.
test("statement logging: only settings that never write a statement's text pass", () => {
  const refusal = (change) => statementLoggingRefusal(statementStatsFacts(statsRow(change)));
  assert.equal(refusal({}), null);
  assert.equal(refusal({ log_duration: "on" }), null);
  assert.equal(refusal({ log_min_duration_sample: "0", log_statement_sample_rate: "0" }), null);
  for (const [change, reason] of [
    [{ log_statement: "ddl" }, "log_statement"],
    [{ log_statement: "mod" }, "log_statement"],
    [{ log_statement: "all" }, "log_statement"],
    [{ log_statement: null }, "log_statement"],
    [{ log_min_duration_statement: "0" }, "log_min_duration_statement"],
    [{ log_min_duration_statement: "5s" }, "log_min_duration_statement"],
    [{ log_min_duration_statement: "x" }, "log_min_duration_statement"],
    [{ log_min_duration_sample: "0" }, "log_min_duration_sample"],
    [{ log_min_duration_sample: "0", log_statement_sample_rate: "0.1" }, "log_min_duration_sample"],
    [
      { log_min_duration_sample: "0", log_statement_sample_rate: "1e-05" },
      "log_min_duration_sample",
    ],
    [{ log_min_duration_sample: null }, "log_min_duration_sample"],
    [{ log_min_error_statement: "error" }, "log_min_error_statement"],
    [{ log_min_error_statement: "log" }, "log_min_error_statement"],
    [{ log_min_error_statement: "fatal" }, "log_min_error_statement"],
    [{ log_min_error_statement: null }, "log_min_error_statement"],
    [{ debug_print_parse: "on" }, "debug_print_parse"],
    [{ debug_print_parse: null }, "debug_print_parse"],
    [{ debug_print_rewritten: "on" }, "debug_print_rewritten"],
    [{ debug_print_rewritten: "yes" }, "debug_print_rewritten"],
    [{ debug_print_plan: "on" }, "debug_print_plan"],
    [{ debug_print_plan: undefined }, "debug_print_plan"],
  ])
    assert.equal(refusal(change), reason, JSON.stringify(change));
  assert.equal(statementLoggingRefusal(statementStatsFacts(null)), "log_statement");
});

// ---------------------------------------------------------------------------
// The Neon connector: explicit parameters and a WebSocket bound to one URL.
test("neon connector: exact host, explicit parameters, no pipelined password, one socket URL", async () => {
  const ownerUrl = parseOwnerUrl(
    `postgresql://neondb_owner:${"s".repeat(24)}@${labBinding.hostname}/morrow?sslmode=require`,
  );
  assert.equal(
    codeOf(() =>
      neonConnector({
        ownerUrl: { ...ownerUrl, host: "ep-other-1.us-east-1.aws.neon.tech" },
        binding: labBinding,
      }),
    ),
    "STAGING_HOST_MISMATCH",
  );
  const seen = {};
  class FakeClient {
    constructor(options) {
      seen.options = options;
      this.neonConfig = {};
      seen.client = this;
    }
    on() {}
    async connect() {
      if (seen.fail) throw Error("password authentication failed for marker-" + ownerUrl.password);
    }
    async query() {
      return { rows: [] };
    }
    async end() {}
  }
  const connector = neonConnector({
    ownerUrl,
    binding: labBinding,
    driver: { Client: FakeClient },
  });
  await (await connector.connect()).close();
  assert.equal(seen.options.host, labBinding.hostname);
  assert.equal(seen.options.database, "morrow");
  assert.equal(seen.options.user, "neondb_owner");
  assert.equal(seen.options.ssl, false);
  assert.deepEqual(
    [
      seen.client.neonConfig.useSecureWebSocket,
      seen.client.neonConfig.pipelineConnect,
      seen.client.neonConfig.forceDisablePgSSL,
    ],
    [true, false, true],
  );
  const Guard = seen.client.neonConfig.webSocketConstructor;
  assert.throws(
    () =>
      new Guard(`wss://ep-other-1.us-east-1.aws.neon.tech/v2?address=${labBinding.hostname}:5432`),
  );
  seen.fail = true;
  await assert.rejects(connector.connect(), (error) => {
    assert.equal(error.code, "STAGING_DATABASE_UNAVAILABLE");
    assert.ok(!JSON.stringify({ ...error, message: error.message }).includes(ownerUrl.password));
    return true;
  });
});

test(
  "neon connector: a connect, and its cleanup, that never settle fail closed at their deadlines",
  { timeout: 10000 },
  async () => {
    const ownerUrl = parseOwnerUrl(
      `postgresql://neondb_owner:${"s".repeat(24)}@${labBinding.hostname}/morrow?sslmode=require`,
    );
    let ended = false;
    let options = null;
    class NeverClient {
      constructor(given) {
        options = given;
        this.neonConfig = {};
      }
      on() {}
      connect() {
        return new Promise(() => {});
      }
      end() {
        ended = true;
        return new Promise(() => {});
      }
    }
    await assert.rejects(
      neonConnector({
        ownerUrl,
        binding: labBinding,
        driver: { Client: NeverClient },
        connectDeadlineMs: 50,
        endDeadlineMs: 50,
      }).connect(),
      (error) => {
        assert.equal(error.code, "STAGING_DATABASE_UNAVAILABLE");
        assert.ok(
          !JSON.stringify({ ...error, message: error.message }).includes(ownerUrl.password),
        );
        return true;
      },
    );
    assert.equal(ended, true);
    // The driver's own timeout stays inside the outer deadline (at least 1 s).
    assert.equal(options.connectionTimeoutMillis, 1000);
    const defaults = neonConnector({
      ownerUrl,
      binding: labBinding,
      driver: { Client: NeverClient },
    });
    assert.ok(defaults);
  },
);

test("owner URL: closed grammar, direct host only, and parse errors never quote the input", () => {
  const good = `postgresql://neondb_owner:${"q".repeat(20)}@${labBinding.hostname}/morrow?sslmode=require&channel_binding=require`;
  assert.equal(parseOwnerUrl(good).host, labBinding.hostname);
  const marker = "markerurlsecret" + "9".repeat(10);
  for (const [text, code] of [
    [
      `postgresql://neondb_owner:${marker}@ep-a-1-pooler.us-east-1.aws.neon.tech/morrow`,
      "STAGING_OWNER_URL_POOLER",
    ],
    [`postgresql://neondb_owner:${marker}@[bad/morrow`, "STAGING_OWNER_URL_INVALID"],
    [`https://neondb_owner:${marker}@${labBinding.hostname}/morrow`, "STAGING_OWNER_URL_INVALID"],
    [`postgresql://neondb_owner:${marker}@db.example.com/morrow`, "STAGING_OWNER_URL_INVALID"],
    [
      `postgresql://neondb_owner:${marker}@${labBinding.hostname}/morrow?options=-c%20role%3Dx`,
      "STAGING_OWNER_URL_INVALID",
    ],
    [
      `postgresql://neondb_owner:${marker}@${labBinding.hostname}:6543/morrow`,
      "STAGING_OWNER_URL_INVALID",
    ],
    [`postgresql://neondb_owner@${labBinding.hostname}/morrow`, "STAGING_OWNER_URL_INVALID"],
    [
      `postgresql://neondb_owner:${marker}@${labBinding.hostname}/morrow \n`,
      "STAGING_OWNER_URL_INVALID",
    ],
  ]) {
    try {
      parseOwnerUrl(text);
      assert.fail("accepted " + code);
    } catch (error) {
      assert.equal(error.code, code);
      assert.ok(!(error.message + JSON.stringify(error.details)).includes(marker));
      assert.equal(error.cause, undefined);
    }
  }
});

// ---------------------------------------------------------------------------
// The card (D8) and its record.
test("card: only an approved, unexpired, pre-production card is active", () => {
  const now = Date.parse("2026-10-25T00:00:00Z");
  assert.deepEqual(cardState(approvedCard("2026-10-19"), now), { active: true, reason: null });
  assert.equal(
    cardState(approvedCard("2026-10-19"), Date.parse("2026-11-19T00:00:00Z")).active,
    false,
  );
  assert.equal(
    cardState(approvedCard("2026-10-19"), Date.parse("2026-11-18T23:59:59Z")).active,
    true,
  );
  assert.equal(cardState({ ...approvedCard(), status: "proposed" }, now).reason, "proposed");
  assert.equal(cardState({ ...approvedCard(), expiresOn: "2026-12-31" }, now).reason, "invalid");
  assert.equal(
    cardState({ ...approvedCard(), productionResourceCreated: true }, now).reason,
    "production",
  );
  assert.equal(cardState({ ...approvedCard(), id: "other" }, now).reason, "invalid");
  assert.equal(cardState(null, now).active, false);
});
test("card record: staging-card.json agrees with docs/decisions/approvals/staging.md", () => {
  const card = JSON.parse(read("docs/decisions/approvals/staging-card.json"));
  const record = read(card.record);
  assert.equal(card.id, "staging-card-1");
  assert.match(record, /`staging-card-1`/);
  const status = /^- \*\*Status:\*\* (\w+)/m.exec(record)?.[1];
  if (card.status === "approved") {
    assert.equal(status, "Approved");
    assert.match(record, new RegExp(card.approvedOn));
    assert.equal(cardState(card, Date.parse(card.approvedOn + "T12:00:00Z")).active, true);
  } else {
    assert.equal(card.status, "proposed");
    assert.equal(status, "Proposed");
    assert.equal(card.approvedOn, null);
  }
});

// ---------------------------------------------------------------------------
// Preconditions (D2/D3): clean tree, origin/main, a green foundation run on that sha.
test("preconditions: dirty tree, HEAD not main, foundation", async () => {
  const run = async (options) => {
    const { tools, calls } = fakeTools(options);
    try {
      return { result: await mainPreconditions({ tools }, "sultanhunter/Morrow"), calls };
    } catch (error) {
      return { code: error.code, calls };
    }
  };
  const ok = await run({});
  assert.equal(ok.result.sourceCommit, fakeSha("main"));
  assert.deepEqual(ok.calls[0].args, ["fetch", "--quiet", "--no-tags", "origin", "main"]);
  assert.equal((await run({ git: { status: "?? stray\n" } })).code, "STAGING_TREE_DIRTY");
  // An unmerged commit is refused even when migrations/ equals main: the runner, the
  // chain module and the grant protocol must be reviewed code too.
  const branch = await run({ git: { head: fakeSha("other") } });
  assert.equal(branch.code, "STAGING_NOT_MAIN");
  assert.ok(!branch.calls.some((c) => c.tool === "gh"), "refused before the foundation read");
  assert.equal((await run({ gh: { checkRuns: [] } })).code, "STAGING_FOUNDATION_MISSING");
  assert.equal(
    (
      await run({
        gh: {
          checkRuns: [
            {
              name: "foundation",
              head_sha: fakeSha("main"),
              status: "in_progress",
              conclusion: null,
            },
          ],
        },
      })
    ).code,
    "STAGING_FOUNDATION_NOT_GREEN",
  );
  assert.equal(
    (
      await run({
        gh: {
          checkRuns: [
            {
              name: "foundation",
              head_sha: fakeSha("other"),
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      })
    ).code,
    "STAGING_FOUNDATION_MISSING",
  );
  assert.equal((await run({ fail: { git: true } })).code, "STAGING_GIT_FAILED");
});

// ---------------------------------------------------------------------------
// The CLI: closed usage, refusals before any effect, closed output.
test("cli: unknown subcommands and arguments are usage errors (exit 2)", async () => {
  const planted = plantedHome();
  try {
    const { ctx, err } = await fakeContext({ home: planted.home, tools: fakeTools().tools });
    assert.equal(await main(["deploy-everything"], ctx), 2);
    assert.equal(JSON.parse(err.at(-1)).code, "STAGING_USAGE");
    for (const argv of [
      ["migrate", "--force"],
      ["provision-roles"],
      ["provision-roles", "--rotate"],
      ["provision-roles", "--rotate", "postgres"],
      ["put-secret", "MORROW_DB_PASSWORD_MORROW_API"],
      ["seed-platform", "--self-service", "--now"],
      ["schema-head", "x"],
    ]) {
      assert.equal(await main(argv, ctx), 2, argv.join(" "));
      assert.equal(JSON.parse(err.at(-1)).code, "STAGING_USAGE");
    }
    // The full list, with the deploy and bring-up commands, is in staging-deploy.test.mjs.
    for (const name of [
      "census",
      "connections",
      "keyring",
      "migrate",
      "provision-roles",
      "put-secret",
      "schema-head",
      "secrets-status",
      "seed-platform",
    ])
      assert.ok(commands.has(name), name);
  } finally {
    planted.cleanup();
  }
});

test("cli: schema-head prints the head; effects refuse without the card or identifiers", async () => {
  const planted = plantedHome();
  try {
    const { ctx, out, err } = await fakeContext({ home: planted.home, tools: fakeTools().tools });
    assert.equal(await main(["schema-head"], ctx), 0);
    assert.deepEqual(JSON.parse(out.at(-1)), {
      command: "schema-head",
      schemaHead: schemaHead(chain),
      entries: chain.length,
    });
    for (const argv of [
      ["migrate"],
      ["provision-roles", "--first"],
      ["put-secret", "WORKOS_API_KEY"],
      ["put-secret", "MORROW_VAULT_KEK_V1"],
      ["seed-platform"],
    ]) {
      const proposed = await fakeContext({
        home: planted.home,
        tools: fakeTools().tools,
        card: { ...approvedCard(), status: "proposed", approvedOn: null, expiresOn: null },
      });
      assert.equal(await main(argv, proposed.ctx), 1);
      assert.deepEqual(JSON.parse(proposed.err.at(-1)), {
        command: argv[0],
        code: "STAGING_CARD_INACTIVE",
        reason: "proposed",
      });
    }
    const unset = await fakeContext({
      home: planted.home,
      tools: fakeTools().tools,
      binding: null,
    });
    assert.equal(await main(["migrate"], unset.ctx), 1);
    assert.equal(JSON.parse(unset.err.at(-1)).code, "STAGING_IDENTIFIERS_UNSET");
    const committed = JSON.parse(read("infra/environments/staging.json"));
    const bound = {
      project_id: labBinding.projectId,
      branch_id: labBinding.branchId,
      endpoint_host: labBinding.hostname,
    };
    // The binding resolves only to staging.json's project, branch and direct endpoint:
    // another project, another well-formed `ep-` host (the root branch's, as the PR-D review
    // names it, or a one-character change), or no endpoint recorded, fails before any read.
    for (const neon of [
      { ...bound, project_id: "another-project" },
      { ...bound, endpoint_host: "ep-falling-math-b78o6uzn.c-13.us-east-1.aws.neon.tech" },
      { ...bound, endpoint_host: labBinding.hostname.replace("000001", "000002") },
      { ...bound, endpoint_host: null },
    ]) {
      const mismatched = await fakeContext({
        home: planted.home,
        tools: fakeTools().tools,
        staging: { ...committed, neon: { ...committed.neon, ...neon } },
      });
      for (const argv of [["migrate"], ["connections"]]) {
        assert.equal(await main(argv, mismatched.ctx), 1);
        assert.equal(JSON.parse(mismatched.err.at(-1)).code, "STAGING_BINDING_INVALID");
      }
    }
    assert.equal(err.length, 0);
  } finally {
    planted.cleanup();
  }
});

test("cli: every database or broker-secret effect refuses an unmerged HEAD before any effect", async () => {
  const planted = plantedHome({
    "neon-owner-url": `postgresql://neondb_owner:${"o".repeat(24)}@${labBinding.hostname}/morrow?sslmode=require`,
    "workos-api-key": "sk_test_" + "W".repeat(24),
    "turnstile-secret": "0x4AAAAAAA" + "t".repeat(26),
  });
  try {
    for (const argv of [
      ["migrate"],
      ["provision-roles", "--first"],
      ["provision-roles", "--rotate", "all"],
      ["put-secret", "WORKOS_API_KEY"],
      ["put-secret", "MORROW_VAULT_KEK_V1"],
      ["seed-platform"],
    ]) {
      for (const [label, options, code] of [
        ["branch", { git: { head: fakeSha("branch") } }, "STAGING_NOT_MAIN"],
        ["dirty", { git: { status: " M scripts/staging-runner.mjs\n" } }, "STAGING_TREE_DIRTY"],
        ["foundation", { gh: { checkRuns: [] } }, "STAGING_FOUNDATION_MISSING"],
      ]) {
        const fake = fakeTools(options);
        const { ctx, err, constants } = await fakeContext({
          home: planted.home,
          tools: fake.tools,
          overrides: {
            loginConfiguration: async () => ({ origin: "https://x.example" }),
          },
        });
        const db = fakeDatabase({ roles: constants.roles });
        ctx.database = db.connector;
        const name = argv.join(" ") + " " + label;
        assert.equal(await main(argv, ctx), 1, name);
        assert.equal(JSON.parse(err.at(-1)).code, code, name);
        assert.deepEqual(db.statements, [], name + ": no SQL");
        assert.deepEqual(
          fake.calls.filter((c) => c.tool === "wrangler"),
          [],
          name + ": no wrangler call",
        );
        assert.ok(
          !fake.calls.some((c) => c.tool === "gh" && c.args[0] === "variable"),
          name + ": no variable written",
        );
        assert.equal(existsSync(join(planted.directory, "tmp/broker-secrets.json")), false, name);
      }
    }
  } finally {
    planted.cleanup();
  }
});

test("cli: seed-platform refuses self-service without the recorded E7 confirmation", async () => {
  const planted = plantedHome();
  try {
    for (const e7 of [
      null,
      { confirmedOn: "2026-10-20", record: "docs/evidence/live/2026-10-20-workos-settings.md" },
      { confirmedOn: "soon", record: "docs/decisions/approvals/staging.md" },
    ]) {
      const { ctx, err } = await fakeContext({
        home: planted.home,
        tools: fakeTools().tools,
        card: { ...approvedCard(), e7 },
      });
      assert.equal(await main(["seed-platform", "--self-service"], ctx), 1);
      assert.equal(JSON.parse(err.at(-1)).code, "STAGING_SELF_SERVICE_UNCONFIRMED");
    }
  } finally {
    planted.cleanup();
  }
});

test("seed rows: derived from the login configuration, digest-bound", () => {
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
  const verificationProfileJson = JSON.stringify(profile);
  const configuration = {
    origin: "https://morrow-staging-api.lab.workers.dev",
    retentionTier: "staging",
    verificationProfileJson,
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
  const rows = platformSeedRows(configuration, profile);
  assert.equal(rows.profile[7], sha(verificationProfileJson));
  assert.equal(rows.configuration[15], sha(verificationProfileJson));
  assert.deepEqual(rows.profile.slice(6, 10), ["3", sha(verificationProfileJson), "2", "active"]);
  assert.deepEqual(rows.authenticationBinding, [
    "binding_staging",
    profile.environmentId,
    client,
    configuration.binding.redirectUri,
    "/",
    "true",
  ]);
  assert.equal(rows.configuration[0], configuration.configurationDigest);
  assert.equal(rows.configuration.length, 16);
});

// ---------------------------------------------------------------------------
// Census (M-C2): only Morrow's four scripts, workers.dev on the api only, no preview,
// no other binding of the broker, no Pages, no dispatch namespace, one member.
test("census: findings for anything that is not exactly Morrow's staging", async () => {
  const staging = JSON.parse(read("infra/environments/staging.json"));
  const clean = {
    scripts: [
      { name: "morrow-staging-api", workersDev: true, previews: false, bindsBroker: true },
      { name: "morrow-staging-broker", workersDev: false, previews: false, bindsBroker: false },
    ],
    pages: [],
    dispatchNamespaces: 0,
    members: 1,
  };
  assert.deepEqual(censusFindings(clean, staging), []);
  const findings = censusFindings(
    {
      scripts: [
        ...clean.scripts,
        { name: "morrow-staging-broker", workersDev: true, previews: true, bindsBroker: false },
        { name: "side-project", workersDev: true, previews: false, bindsBroker: true },
      ],
      pages: [{ name: "site", bindsBroker: true }],
      dispatchNamespaces: 1,
      members: 2,
    },
    staging,
  ).map((f) => f.code);
  assert.deepEqual(findings, [
    "WORKERS_DEV_EXPOSED",
    "PREVIEWS_ENABLED",
    "NOT_MORROW_SCRIPT",
    "WORKERS_DEV_EXPOSED",
    "BROKER_BOUND_ELSEWHERE",
    "PAGES_PROJECT",
    "BROKER_BOUND_ELSEWHERE",
    "DISPATCH_NAMESPACES",
    "ACCOUNT_MEMBERS",
  ]);
  const planted = plantedHome();
  try {
    const good = fakeCloudflare();
    const { ctx, out } = await fakeContext({
      home: planted.home,
      tools: fakeTools().tools,
      cloudflare: good.api,
    });
    assert.equal(await main(["census"], ctx), 0);
    const report = JSON.parse(out.at(-1));
    assert.equal(report.scripts.length, 4);
    assert.deepEqual(report.findings, []);
    const bad = fakeCloudflare({
      pages: [
        {
          name: "site",
          deployment_configs: {
            production: { services: { B: { service: "morrow-staging-broker" } } },
          },
        },
      ],
    });
    const second = await fakeContext({
      home: planted.home,
      tools: fakeTools().tools,
      cloudflare: bad.api,
    });
    assert.equal(await main(["census"], second.ctx), 1);
    assert.deepEqual(
      JSON.parse(second.out.at(-1)).findings.map((f) => f.code),
      ["PAGES_PROJECT", "BROKER_BOUND_ELSEWHERE"],
    );
    // An account without Workers for Platforms: 403 with Cloudflare error 10121 alone is
    // reported as `unavailable_10121`, no namespace (2026-10-20, the staging account; the
    // packet's PR-B notes, deviation 17). Any other status or code, or 10121 beside
    // another code, fails the census.
    const noWfp = await fakeContext({
      home: planted.home,
      tools: fakeTools().tools,
      cloudflare: fakeCloudflare({ namespacesError: { status: 403, codes: [10121] } }).api,
    });
    assert.equal(await main(["census"], noWfp.ctx), 0);
    assert.deepEqual(JSON.parse(noWfp.out.at(-1)).findings, []);
    assert.equal(JSON.parse(noWfp.out.at(-1)).dispatchNamespaces, "unavailable_10121");
    assert.equal(JSON.parse(out.at(-1)).dispatchNamespaces, 0);
    for (const namespacesError of [
      { status: 403, codes: [10000] },
      { status: 403, codes: [10000, 10121] },
      { status: 403, codes: [10121, 10121] },
      { status: 403, codes: [] },
      { status: 403 },
      { status: 401, codes: [10121] },
      { status: 500, codes: [10121] },
    ]) {
      const refused = await fakeContext({
        home: planted.home,
        tools: fakeTools().tools,
        cloudflare: fakeCloudflare({ namespacesError }).api,
      });
      assert.notEqual(await main(["census"], refused.ctx), 0, JSON.stringify(namespacesError));
      assert.equal(
        JSON.parse(refused.err.at(-1)).code,
        "STAGING_CLOUDFLARE_REQUEST_FAILED",
        JSON.stringify(namespacesError),
      );
    }
    // Any other count is a finding; so is a reply that is not a list.
    for (const namespaces of [[{ id: "ns" }], { result: [] }]) {
      const listed = await fakeContext({
        home: planted.home,
        tools: fakeTools().tools,
        cloudflare: fakeCloudflare({ namespaces }).api,
      });
      assert.equal(await main(["census"], listed.ctx), 1);
      assert.deepEqual(
        JSON.parse(listed.out.at(-1)).findings.map((f) => f.code),
        ["DISPATCH_NAMESPACES"],
      );
    }
  } finally {
    planted.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tool parsers and the Cloudflare client: names and ids out, fixed codes otherwise.
test("parsers: secret names, newest version id, GitHub names; anything else is a fixed code", () => {
  assert.deepEqual(secretNames([{ name: "B", type: "secret_text" }, { name: "A" }]), ["A", "B"]);
  assert.equal(
    codeOf(() => secretNames([{ name: "lower" }])),
    "STAGING_WRANGLER_OUTPUT_INVALID",
  );
  assert.equal(
    codeOf(() => secretNames({ secrets: [] })),
    "STAGING_WRANGLER_OUTPUT_INVALID",
  );
  const v = (id, created_on) => ({
    id,
    metadata: { created_on, author_email: "owner@example.com" },
  });
  assert.equal(
    newestVersionId([
      v("00000000-0000-4000-8000-000000000002", "2026-10-19T11:00:00Z"),
      v("00000000-0000-4000-8000-000000000001", "2026-10-19T10:00:00Z"),
    ]),
    "00000000-0000-4000-8000-000000000002",
  );
  assert.equal(
    codeOf(() => newestVersionId([])),
    "STAGING_WRANGLER_OUTPUT_INVALID",
  );
  assert.equal(
    codeOf(() => newestVersionId([{ id: "x" }])),
    "STAGING_WRANGLER_OUTPUT_INVALID",
  );
  assert.deepEqual(
    githubNames([{ name: "STAGING_SCHEMA_HEAD", updatedAt: "2026-10-19T10:00:00Z", value: "x" }]),
    [{ name: "STAGING_SCHEMA_HEAD", updatedAt: "2026-10-19T10:00:00Z" }],
  );
  assert.equal(
    codeOf(() => githubNames([{ name: "has space" }])),
    "STAGING_GH_OUTPUT_INVALID",
  );
});

test("cloudflare client: fixed base, bearer header, no redirects, bounded closed failures", async () => {
  const token = "T".repeat(39) + "z";
  const credential = syntheticCredential(token);
  const seen = [];
  const reply = (status, body) => async (url, init) => {
    seen.push({ url, init });
    return { status, text: async () => body };
  };
  const api = cloudflareApi({
    credential,
    accountId: "a".repeat(32),
    fetchImpl: reply(200, JSON.stringify({ success: true, result: [{ id: "x" }] })),
  });
  assert.deepEqual(await api.get(["workers", "scripts"]), [{ id: "x" }]);
  assert.equal(
    seen[0].url,
    "https://api.cloudflare.com/client/v4/accounts/" + "a".repeat(32) + "/workers/scripts",
  );
  assert.equal(seen[0].init.redirect, "error");
  assert.equal(seen[0].init.headers.Authorization, "Bearer " + token);
  const marker = "cfmarker" + "8".repeat(12);
  for (const [fetchImpl, code, status] of [
    [
      reply(403, JSON.stringify({ success: false, errors: [{ message: marker }] })),
      "STAGING_CLOUDFLARE_REQUEST_FAILED",
      403,
    ],
    [reply(200, "<html>" + marker), "STAGING_CLOUDFLARE_RESPONSE_INVALID", undefined],
    [
      async () => {
        throw Error("connect " + marker);
      },
      "STAGING_CLOUDFLARE_UNAVAILABLE",
      undefined,
    ],
  ]) {
    const failing = cloudflareApi({ credential, accountId: "a".repeat(32), fetchImpl });
    await assert.rejects(failing.get(["workers", "scripts"]), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.details.status, status);
      assert.ok(!JSON.stringify({ m: error.message, d: error.details }).includes(marker));
      assert.ok(!JSON.stringify({ m: error.message, d: error.details }).includes(token));
      return true;
    });
  }
  await assert.rejects(api.get(["workers", "../tokens"]), {
    code: "STAGING_CLOUDFLARE_REQUEST_INVALID",
  });
  assert.throws(() => cloudflareApi({ credential: null, accountId: "a".repeat(32) }), {
    code: "STAGING_CLOUDFLARE_UNCONFIGURED",
  });
  assert.throws(() => cloudflareApi({ credential, accountId: "not-an-account" }), {
    code: "STAGING_CLOUDFLARE_UNCONFIGURED",
  });
});

test("output: closedReport keeps closed values and omits everything else", () => {
  assert.deepEqual(
    closedReport({
      code: "STAGING_X",
      n: 3,
      ok: true,
      none: null,
      name: "morrow-staging-api",
      long: "x".repeat(200),
      spaced: "has a space",
      nested: { list: ["a", 1, { bad: "with\nnewline" }] },
      fn: () => 1,
      "bad key": 1,
    }),
    {
      code: "STAGING_X",
      n: 3,
      ok: true,
      none: null,
      name: "morrow-staging-api",
      long: "[omitted]",
      spaced: "[omitted]",
      nested: { list: ["a", 1, { bad: "[omitted]" }] },
      fn: "[omitted]",
    },
  );
});

// ---------------------------------------------------------------------------
// Token isolation (D2, ADR-0019 item 14).
test("token: staging-token.mjs is the first import and removes the token before any other module", () => {
  const source = read("scripts/staging.mjs");
  const firstImport = /^import [^;]+;/m.exec(source)[0];
  assert.equal(firstImport, 'import "./staging-token.mjs";');
  assert.doesNotMatch(
    read("scripts/staging-token.mjs"),
    /^import (?!\{ inspect \} from "node:util";)/m,
  );
  const marker = "Q".repeat(36) + "tokn";
  const ghMarker = "ghs_" + "G".repeat(32) + "tokn";
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'const { cloudflareCredential, githubCredential } = await import("./scripts/staging.mjs").then(() => import("./scripts/staging-token.mjs"));',
        "const leaked = Object.entries(process.env).filter(([k, v]) => /^(CLOUDFLARE_|CF_API_|CF_EMAIL|GH_TOKEN$)/.test(k) || v.includes(process.argv[1]) || v.includes(process.argv[2]));",
        'const c = cloudflareCredential({ source: "environment" });',
        "const g = githubCredential();",
        "const child = c.childEnvironment({ PATH: 'x' });",
        "const ghChild = g.childEnvironment({ PATH: 'x' });",
        "const util = await import('node:util');",
        "console.log(JSON.stringify({ leaked: leaked.map(([k]) => k), childHasToken: child.CLOUDFLARE_API_TOKEN === process.argv[1], ghChildHasToken: ghChild.GH_TOKEN === process.argv[2] && !('CLOUDFLARE_API_TOKEN' in ghChild), json: JSON.stringify({ c, g }), inspected: util.inspect(c) + util.inspect(g), text: String(c) + String(g) }));",
      ].join("\n"),
      marker,
      ghMarker,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, CLOUDFLARE_API_TOKEN: marker, GH_TOKEN: ghMarker },
      encoding: "utf8",
    },
  );
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  assert.deepEqual(result.leaked, []);
  assert.equal(result.childHasToken, true);
  assert.equal(result.ghChildHasToken, true);
  for (const text of [result.json, result.inspected, result.text])
    assert.ok(!text.includes(marker) && !text.includes(ghMarker));
  assert.ok(!probe.stderr.includes(marker) && !probe.stderr.includes(ghMarker));
  // Locally the token comes only from the operator file; an environment token, or any
  // other Cloudflare credential variable, is refused rather than used.
  for (const [env, code] of [
    [{ CLOUDFLARE_API_TOKEN: marker }, "STAGING_TOKEN_IN_ENVIRONMENT"],
    [{ CLOUDFLARE_API_KEY: marker }, "STAGING_CLOUDFLARE_VARIABLE_REFUSED"],
    [{}, "accepted"],
  ]) {
    const run = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { cloudflareCredential } from "./scripts/staging-token.mjs"; try { cloudflareCredential({ source: "operator-file", readOperatorToken: () => "R".repeat(40) }); console.log("accepted"); } catch (e) { console.log(e.code); }',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_API_KEY: "", ...env },
        encoding: "utf8",
      },
    );
    assert.equal(run.stdout.trim(), code);
    assert.ok(!run.stdout.includes(marker) && !run.stderr.includes(marker));
  }
  assert.throws(() => syntheticCredential("short"), { code: "STAGING_TOKEN_FORMAT" });
});

// ---------------------------------------------------------------------------
// Shapes the rest of PR-B and PR-D build on.
test("staging.json: the D1 shape; every identifier is set and well-formed (PR-D part 1)", () => {
  const staging = JSON.parse(read("infra/environments/staging.json"));
  const { cloudflare, neon } = staging;
  for (const [value, shape] of [
    [cloudflare.account_id, /^[0-9a-f]{32}$/],
    [cloudflare.workers_dev_subdomain, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/],
    [neon.project_id, /^[a-z]+-[a-z]+-[0-9]{8}$/],
    [neon.root_branch_id, /^br-[a-z]+-[a-z]+-[a-z0-9]{8}$/],
    [neon.branch_id, /^br-[a-z]+-[a-z]+-[a-z0-9]{8}$/],
    [neon.region_id, /^aws-[a-z]+-[a-z]+-[0-9]$/],
  ])
    assert.match(value, shape);
  // The origin is derived from the subdomain, and the bound branch is never the root.
  assert.equal(
    cloudflare.origin,
    `https://${cloudflare.workers.api}.${cloudflare.workers_dev_subdomain}.workers.dev`,
  );
  assert.notEqual(neon.branch_id, neon.root_branch_id);
  assert.equal(staging.neon.plan, "Free");
  assert.equal(staging.neon.branch_name, "staging");
  assert.equal(staging.neon.history_window_hours, 6);
  assert.deepEqual(staging.github, {
    repository: "sultanhunter/Morrow",
    scope: "environment",
    environment: "staging",
  });
  const policy = JSON.parse(read("docs/decisions/deployment-policy.json"));
  assert.equal(policy.staging_database.plan, "Free");
  assert.match(policy.staging_database.amended_by, /ADR-0019 item 10/);
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.devDependencies.neonctl, /^\d+\.\d+\.\d+$/);
  assert.ok(statSync("node_modules/neonctl/bin/cli.js").isFile());
});

// M2 PR-1: the owner's vault KEK file (`npm run vault -- kek`), 64 lowercase hex characters.
const plantedKek = "c0ffee".repeat(10) + "abcd";

const provisionPlant = () => ({
  "neon-owner-url": `postgresql://neondb_owner:${"o".repeat(24)}@${labBinding.hostname}/morrow?sslmode=require`,
  "workos-api-key": "sk_test_" + "W".repeat(24),
  "turnstile-secret": "0x4AAAAAAA" + "t".repeat(26),
  "vault-kek-v1": plantedKek,
});
// The one place a role password appears outside the broker's file or stdin: its own
// role's ALTER ROLE statement, sent once (M-N3 as amended 2026-10-20).
const passwordStatement =
  /^ALTER ROLE (morrow_[a-z0-9_]+) WITH LOGIN CONNECTION LIMIT 10 PASSWORD '([A-Za-z0-9_-]{43})'$/;

test("fake database: provisioning sends each plaintext once, in its own role's ALTER ROLE", async () => {
  const planted = plantedHome(provisionPlant());
  try {
    const { ctx, out, err, constants } = await fakeContext({
      home: planted.home,
      tools: fakeTools().tools,
    });
    const db = fakeDatabase({ roles: constants.roles });
    ctx.database = db.connector;
    assert.equal(await main(["provision-roles", "--first"], ctx), 0, out.join());
    const secrets = JSON.parse(
      readFileSync(join(planted.directory, "tmp/broker-secrets.json"), "utf8"),
    );
    assert.equal(statSync(join(planted.directory, "tmp/broker-secrets.json")).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(secrets).sort(), constants.brokerSecrets);
    assert.equal(constants.brokerSecrets.length, 14);
    // Eleven logins: the ten leased roles and the broker's own vault login (M2 PR-1).
    assert.equal(constants.roles.length, 11);
    assert.ok(constants.roles.includes("morrow_vault_broker"));
    const passwords = constants.roles.map((r) => secrets[constants.passwordSecret(r)]);
    assert.ok(passwords.every((p) => /^[A-Za-z0-9_-]{43}$/.test(p)));
    assert.equal(new Set(passwords).size, passwords.length);
    // The KEK is the owner's file, unchanged; the tool generates no KEK.
    assert.equal(secrets.MORROW_VAULT_KEK_V1, plantedKek);
    const texts = db.statements.map((s) => s.text + JSON.stringify(s.params));
    for (const role of constants.roles) {
      const password = secrets[constants.passwordSecret(role)];
      const carrying = db.statements.filter((s) => (s.text + s.params.join()).includes(password));
      assert.equal(carrying.length, 1, role);
      const [, named, sent] = passwordStatement.exec(carrying[0].text) ?? [];
      assert.deepEqual([named, sent, carrying[0].params], [role, password, []], role);
    }
    assert.equal(db.statements.filter((s) => / PASSWORD /.test(s.text)).length, 11);
    assert.ok(!texts.join().includes(plantedKek));
    assert.ok(!texts.join().includes("SCRAM-SHA-256$"));
    // The statement-statistics check runs before the first password statement.
    const check = db.statements.findIndex((s) => /extname = 'pg_stat_statements'/.test(s.text));
    const first = db.statements.findIndex((s) => / PASSWORD /.test(s.text));
    assert.ok(check >= 0 && check < first);
    // No plaintext or KEK in the output; this fake's pg_authid is unreadable.
    assert.ok([...passwords, plantedKek].every((p) => !out.join().includes(p)));
    assert.equal(JSON.parse(out.at(-1)).passwordStorage, "unreadable");
    // No module loaded: nothing records the statements, so no scratch session is opened.
    assert.deepEqual(JSON.parse(out.at(-1)).statementStats, { recording: false });
    assert.ok(db.statements.every((s) => s.database === "morrow"));
    assert.equal(err.length, 0);
    // A second --first refuses: the file exists, and nothing was sent.
    const before = db.statements.length;
    assert.equal(await main(["provision-roles", "--first"], ctx), 1);
    assert.equal(db.statements.length, before);
  } finally {
    planted.cleanup();
  }
});

// The owner's conditions (2026-10-20): before any password statement, any broker file or
// any secret placement, the tool refuses statistics it cannot read, the extension in the
// binding's database, storage other than SCRAM-SHA-256, statement logging in either
// session, and a loaded module it cannot wipe from a scratch database.
const bulkCalls = (f) => f.calls.filter((c) => c.tool === "wrangler" && c.args[1] === "bulk");
const recordingModule = { track: "top", track_utility: "on" };
async function provisionWorld(argv, database) {
  const planted = plantedHome(provisionPlant());
  const constants = (await fakeContext({ home: planted.home, tools: fakeTools().tools })).constants;
  const fake = fakeTools({ wrangler: { secrets: { broker: constants.brokerSecrets } } });
  const { ctx, out, err } = await fakeContext({ home: planted.home, tools: fake.tools });
  const db = fakeDatabase({ roles: constants.roles, ...database });
  ctx.database = db.connector;
  const code = await main(argv, ctx);
  const file = join(planted.directory, "tmp/broker-secrets.json");
  const secrets = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  planted.cleanup();
  return { code, out, err, db, fake, constants, secrets };
}
const provisionModes = [
  ["provision-roles", "--first"],
  ["provision-roles", "--rotate", "all"],
];
test("provision-roles: unreadable statistics, the extension, non-SCRAM storage, statement logging or no usable scratch database refuse before any password statement", async () => {
  const stats = (details) => ({ code: "STAGING_STATEMENT_STATS_PRESENT", ...details });
  const logging = (reason, database) => ({ code: "STAGING_STATEMENT_LOGGING", reason, database });
  const moduleRefusal = (scratch) =>
    stats({ reason: "module", extension: false, module: true, scratch });
  for (const [label, database, expected] of [
    [
      "extension",
      { statementStats: { extension: true } },
      stats({ reason: "extension", extension: true, module: false }),
    ],
    [
      "extension with the module loaded",
      { statementStats: { extension: true, ...recordingModule } },
      stats({ reason: "extension", extension: true, module: true }),
    ],
    [
      "unchecked (error)",
      { rules: [[/extname = 'pg_stat_statements'/, Error("permission denied")]] },
      stats({ reason: "unchecked", extension: null, module: null }),
    ],
    [
      "unchecked (no row)",
      { rules: [[/extname = 'pg_stat_statements'/, []]] },
      stats({ reason: "unchecked", extension: null, module: null }),
    ],
    [
      "md5",
      { statementStats: { password_encryption: "md5" } },
      { code: "STAGING_PASSWORD_ENCRYPTION" },
    ],
    [
      "log_statement",
      { statementStats: { log_statement: "ddl" } },
      logging("log_statement", "binding"),
    ],
    [
      "log_min_duration_statement",
      { statementStats: { log_min_duration_statement: "0" } },
      logging("log_min_duration_statement", "binding"),
    ],
    [
      "log_min_duration_sample",
      { statementStats: { log_min_duration_sample: "100ms" } },
      logging("log_min_duration_sample", "binding"),
    ],
    [
      "log_min_error_statement",
      { statementStats: { log_min_error_statement: "error" } },
      logging("log_min_error_statement", "binding"),
    ],
    ...["debug_print_parse", "debug_print_rewritten", "debug_print_plan"].map((setting) => [
      setting,
      { statementStats: { ...recordingModule, [setting]: "on" } },
      logging(setting, "binding"),
    ]),
    [
      "scratch database absent",
      { statementStats: recordingModule, scratchPresent: false },
      moduleRefusal("absent"),
    ],
    [
      "scratch database unreachable",
      { statementStats: recordingModule, scratchConnectError: Error("unreachable") },
      moduleRefusal("unavailable"),
    ],
    [
      "scratch session logs statements",
      { statementStats: recordingModule, scratchStats: { log_statement: "all" } },
      logging("log_statement", "scratch"),
    ],
    [
      "scratch session logs errors",
      { statementStats: recordingModule, scratchStats: { log_min_error_statement: "error" } },
      logging("log_min_error_statement", "scratch"),
    ],
    [
      "scratch session prints parse trees",
      { statementStats: recordingModule, scratchStats: { debug_print_parse: "on" } },
      logging("debug_print_parse", "scratch"),
    ],
    [
      "scratch session on another instance",
      { statementStats: recordingModule, instance: { neondb: "1792526999.5/10.0.0.2/5432" } },
      moduleRefusal("other_instance"),
    ],
    [
      "the binding's instance unreadable",
      { statementStats: recordingModule, instance: { morrow: null } },
      moduleRefusal("other_instance"),
    ],
    [
      "the scratch session's instance unreadable",
      {
        statementStats: recordingModule,
        rules: [
          [
            / AS instance$/,
            (text, params, db) => (db === "neondb" ? Error("x") : [{ instance: "1/-/-" }]),
          ],
        ],
      },
      moduleRefusal("other_instance"),
    ],
  ]) {
    for (const argv of provisionModes) {
      const name = label + " " + argv.join(" ");
      const { code, out, err, db, fake, secrets } = await provisionWorld(argv, database);
      assert.equal(code, 1, name);
      assert.deepEqual(JSON.parse(err.at(-1)), { command: "provision-roles", ...expected }, name);
      assert.deepEqual(
        db.statements.filter((s) => /PASSWORD|^BEGIN|^ALTER ROLE|EXTENSION/.test(s.text)),
        [],
        name,
      );
      assert.equal(secrets, null, name);
      assert.deepEqual(bulkCalls(fake), [], name);
      assert.equal(out.length, 0, name);
    }
  }
  // Tracking switched off, or a module that keeps no utility text, needs no wipe.
  for (const statementStats of [
    { track: "none", track_utility: "on" },
    { track: "top", track_utility: "off" },
  ]) {
    const { code, out, db } = await provisionWorld(["provision-roles", "--first"], {
      statementStats,
    });
    assert.equal(code, 0, JSON.stringify(statementStats));
    assert.deepEqual(JSON.parse(out.at(-1)).statementStats, { recording: false });
    assert.ok(db.statements.every((s) => s.database === "morrow"));
  }
});

// Owner decision 2026-10-20, "Plaintext, then wipe stats": with the module loaded and
// tracking utility statements (Neon's staging values), the scratch session is opened and
// checked first; after the password statements the statistics are fully reset from it,
// verified to hold no password, and the extension it created is dropped. The binding's
// database never gains the extension; each plaintext reaches SQL text once, in its own
// ALTER ROLE, and nowhere else: the verification receives only SHA-256 digests and the
// instance identity both sessions read before the password statements.
test("provision-roles: a recording module is wiped and verified from the scratch database", async () => {
  for (const [argv, scratchExtension] of [
    [["provision-roles", "--first"], false],
    [["provision-roles", "--rotate", "all"], false],
    [["provision-roles", "--first"], true],
  ]) {
    const name = argv.join(" ") + (scratchExtension ? " (extension already there)" : "");
    const { code, out, err, db, fake, constants, secrets } = await provisionWorld(argv, {
      statementStats: recordingModule,
      scratchExtension,
    });
    assert.equal(code, 0, name + " " + err.join());
    const report = JSON.parse(out.at(-1));
    assert.deepEqual(
      report.statementStats,
      { recording: true, wiped: true, entriesRemaining: 0 },
      name,
    );
    const delivered = secrets ?? JSON.parse(bulkCalls(fake)[0].input);
    const passwords = constants.roles.map((role) => delivered[constants.passwordSecret(role)]);
    assert.ok(
      passwords.every((p) => /^[A-Za-z0-9_-]{43}$/.test(p)),
      name,
    );
    // The order: the binding's facts, the scratch database's presence, the scratch
    // session and its facts, the password statements, then the wipe.
    const at = (pattern, database) =>
      db.statements.findIndex(
        (s) => pattern.test(s.text) && (database === undefined || s.database === database),
      );
    const order = [
      at(/AS extension, current_setting/, "morrow"),
      at(/FROM pg_catalog\.pg_database WHERE datname/, "morrow"),
      at(/session_user::text AS session_role/, "neondb"),
      at(/AS extension, current_setting/, "neondb"),
      at(/ AS instance$/, "morrow"),
      at(/ AS instance$/, "neondb"),
      at(/^BEGIN$/, "morrow"),
      at(/^COMMIT$/, "morrow"),
      at(/pg_catalog\.pg_extension e JOIN/, "neondb"),
      at(/clock_timestamp/, "neondb"),
      at(/pg_stat_statements_reset\(\)/, "neondb"),
      at(/pg_stat_statements_info/, "neondb"),
    ];
    assert.ok(
      order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])),
      name + " " + order,
    );
    assert.deepEqual(db.statements[at(/pg_database WHERE/)].params, ["neondb"], name);
    // Only the scratch session ever names the extension in a statement.
    assert.ok(
      db.statements.filter((s) => /EXTENSION/.test(s.text)).every((s) => s.database === "neondb"),
      name,
    );
    assert.deepEqual(
      [db.scratch.created, db.scratch.dropped],
      scratchExtension ? [0, 0] : [1, 1],
      name,
    );
    // The verification query: the reset time read before it, every password's SHA-256
    // digest as one JSON bind parameter, and the instance read in both sessions before the
    // password statements. Each plaintext is in exactly one statement, its own ALTER ROLE.
    const verify = db.statements[at(/pg_stat_statements_info/)];
    assert.equal(verify.text, statementStatsVerificationQuery("public"), name);
    assert.equal(verify.params.length, 3, name);
    assert.equal(verify.params[0], "2026-10-20 12:00:00.000001+00", name);
    assert.deepEqual(
      JSON.parse(verify.params[1]).sort(),
      passwords.map((p) => createHash("sha256").update(p).digest("hex")).sort(),
      name,
    );
    assert.equal(verify.params[2], "1792526146.012127/10.0.0.1/5432", name);
    for (const password of passwords) {
      const carrying = db.statements.filter((s) =>
        (s.text + JSON.stringify(s.params)).includes(password),
      );
      assert.equal(carrying.length, 1, name);
      assert.match(carrying[0].text, passwordStatement, name);
      assert.equal(carrying[0].database, "morrow", name);
    }
    assert.ok(
      passwords.every((p) => !out.join().includes(p) && !err.join().includes(p)),
      name,
    );
  }
});

// A wipe that cannot be verified stops the run before any password is delivered: a
// residue, a reset that was not full, a failed reset, create or drop. The extension this
// run created is dropped on the way out where possible. A failure of the password
// statements still runs the wipe; a residue then wins over the statement's own failure.
test("provision-roles: a wipe that cannot be verified refuses with the stage reached, and delivers nothing", async () => {
  const residue = (stage, entriesRemaining, fullReset = null, sameInstance = null) => ({
    code: "STAGING_STATEMENT_STATS_RESIDUE",
    stage,
    entriesRemaining,
    fullReset,
    sameInstance,
  });
  for (const [label, database, expected, dropped] of [
    ["an entry remains", { residue: 1 }, residue("verify", 1, true, true), 1],
    ["a partial reset", { partialReset: true }, residue("verify", 0, false, true), 1],
    [
      "the instance changed (a restart or another server)",
      { instanceChanged: true },
      residue("verify", 0, true, false),
      1,
    ],
    [
      "the reset fails",
      { rules: [[/pg_stat_statements_reset\(\)/, Error("permission denied")]] },
      residue("reset", null),
      1,
    ],
    [
      "the verification fails",
      { rules: [[/pg_stat_statements_info/, Error("permission denied")]] },
      residue("verify", null),
      1,
    ],
    [
      "the extension cannot be created",
      { execError: { pattern: /^CREATE EXTENSION/, error: Error("permission denied") } },
      residue("extension", null),
      0,
    ],
    [
      "the drop fails",
      { execError: { pattern: /^DROP EXTENSION/, error: Error("dependent objects") } },
      residue("drop", 0, true, true),
      0,
    ],
    [
      "a password statement fails, then an entry remains",
      {
        residue: 2,
        execError: { pattern: /^ALTER ROLE morrow_api /, error: Error("refused") },
      },
      residue("verify", 2, true, true),
      1,
    ],
    [
      "a password statement fails, then the wipe succeeds",
      { execError: { pattern: /^ALTER ROLE morrow_api /, error: Error("refused") } },
      { code: "STAGING_PROVISION_FAILED", sqlstate: null, server: null },
      1,
    ],
  ]) {
    for (const argv of provisionModes) {
      const name = label + " " + argv.join(" ");
      const { code, out, err, db, fake, secrets } = await provisionWorld(argv, {
        statementStats: recordingModule,
        ...database,
      });
      assert.equal(code, 1, name);
      assert.deepEqual(JSON.parse(err.at(-1)), { command: "provision-roles", ...expected }, name);
      assert.equal(secrets, null, name);
      assert.deepEqual(bulkCalls(fake), [], name);
      assert.equal(out.length, 0, name);
      assert.equal(db.scratch.dropped, dropped, name);
      // The wipe ran after the password statements, whatever their outcome.
      const begin = db.statements.findIndex((s) => s.text === "BEGIN");
      const wipe = db.statements.findIndex((s) => /pg_catalog\.pg_extension e JOIN/.test(s.text));
      assert.ok(begin >= 0 && wipe > begin, name);
      assert.ok(
        db.statements.filter((s) => /EXTENSION/.test(s.text)).every((s) => s.database === "neondb"),
        name,
      );
    }
  }
});

// The scratch database must be named and must not be the binding's own database; the
// CLI always passes `neondb`, so these are the library's refusals.
test("provisionRoles: an unnamed scratch database or the binding's own refuses before any password statement", async () => {
  const constants = (await fakeContext({ home: tmpdir(), tools: fakeTools().tools })).constants;
  for (const [scratch, expected] of [
    [null, "unnamed"],
    [{ database: "neondb" }, "unnamed"],
    [{ database: "Neon DB", connect: async () => null }, "unnamed"],
    [{ database: "morrow", connect: async () => null }, "same_database"],
  ]) {
    const db = fakeDatabase({ roles: constants.roles, statementStats: recordingModule });
    let failure = null;
    try {
      await provisionRoles({
        connect: db.connector({ binding: labBinding }).connect,
        binding: labBinding,
        administrator: { name: "neondb_owner", mode: "createrole" },
        roles: constants.roles,
        passwordRoles: constants.roles,
        scratch,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "STAGING_STATEMENT_STATS_PRESENT", expected);
    assert.deepEqual(
      failure.details,
      { reason: "module", extension: false, module: true, scratch: expected },
      expected,
    );
    assert.deepEqual(
      db.statements.filter((s) => /PASSWORD|^BEGIN|^ALTER ROLE|EXTENSION/.test(s.text)),
      [],
      expected,
    );
  }
});

test("wipeStatementStats: only generated passwords are digested, and a missing instance never verifies", async () => {
  for (const passwords of [[], ["short"], ["x".repeat(43) + "'"], "x".repeat(43), null]) {
    const db = fakeDatabase({ scratchExtension: true });
    const session = await db.connector({ binding: { database: "neondb" } }).connect();
    await assert.rejects(wipeStatementStats(session, passwords, "1/-/-"), {
      code: "STAGING_PASSWORD_INVALID",
    });
    assert.deepEqual(db.statements, []);
  }
  // Without the instance read before the password statements, the wipe still runs (the
  // reset is the point), and the verification cannot pass.
  const db = fakeDatabase({ scratchExtension: true });
  const session = await db.connector({ binding: { database: "neondb" } }).connect();
  await assert.rejects(wipeStatementStats(session, ["x".repeat(43)], undefined), {
    code: "STAGING_STATEMENT_STATS_RESIDUE",
    details: { stage: "verify", entriesRemaining: 0, fullReset: true, sameInstance: true },
  });
  assert.ok(db.statements.some((s) => /pg_stat_statements_reset\(\)/.test(s.text)));
  // The digest is SHA-256 over the password's bytes, lowercase hex.
  assert.equal(
    passwordDigest("a".repeat(43)),
    createHash("sha256").update("a".repeat(43)).digest("hex"),
  );
  assert.match(passwordDigest("a".repeat(43)), /^[0-9a-f]{64}$/);
  assert.throws(() => statementStatsVerificationQuery("public; x"));
});

test("provision-roles: the stored form is checked where pg_authid is readable", async () => {
  const superuser = { name: "postgres", mode: "superuser" };
  for (const [storedForm, code] of [
    ["all", 0],
    [3, 1],
  ]) {
    const planted = plantedHome({
      ...provisionPlant(),
      "neon-owner-url": `postgresql://postgres:${"o".repeat(24)}@${labBinding.hostname}/morrow?sslmode=require`,
    });
    try {
      const { ctx, out, err, constants } = await fakeContext({
        home: planted.home,
        tools: fakeTools().tools,
        administrator: superuser,
      });
      const db = fakeDatabase({
        roles: constants.roles,
        storedForm,
        identity: { session_role: "postgres", current_role: "postgres", superuser: true },
      });
      ctx.database = db.connector;
      assert.equal(await main(["provision-roles", "--first"], ctx), code, err.join());
      if (code === 0) assert.equal(JSON.parse(out.at(-1)).passwordStorage, "SCRAM-SHA-256");
      else {
        assert.deepEqual(JSON.parse(err.at(-1)), {
          command: "provision-roles",
          code: "STAGING_PASSWORD_STORAGE_MISMATCH",
        });
        // No secrets file: the roles hold passwords nobody keeps, and a rerun replaces them.
        assert.equal(existsSync(join(planted.directory, "tmp/broker-secrets.json")), false);
      }
      // Only a count leaves the server, never a stored verifier.
      const reads = db.statements.filter((s) => /pg_catalog\.pg_authid/.test(s.text));
      assert.equal(reads.length, 2);
      assert.match(reads[1].text, /^SELECT count\(\*\)::int AS n FROM pg_catalog\.pg_authid /);
    } finally {
      planted.cleanup();
    }
  }
});

// Node's happy-eyeballs default (250 ms per address attempt) failed every connection to
// Neon's us-east-1 endpoints from the operator's network (2026-10-20). The CLI entry sets
// 3000 ms before any network call; importing the module changes nothing global.
test("cli entry: the connect attempt timeout is set before the command runs", () => {
  assert.equal(connectAttemptTimeoutMs, 3000);
  const home = mkdtempSync(join(tmpdir(), "morrow-staging-entry-"));
  try {
    const probe =
      "data:text/javascript," +
      encodeURIComponent(
        'import net from "node:net";\n' +
          "const at = net.getDefaultAutoSelectFamilyAttemptTimeout();\n" +
          'process.on("exit", () => process.stdout.write(JSON.stringify({ at, exit: net.getDefaultAutoSelectFamilyAttemptTimeout() }) + "\\n"));\n',
      );
    const result = spawnSync(process.execPath, ["--import", probe, "scripts/staging.mjs"], {
      encoding: "utf8",
      timeout: 60000,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir() },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr.trim()).code, "STAGING_USAGE");
    const seen = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.notEqual(seen.at, connectAttemptTimeoutMs);
    assert.equal(seen.exit, connectAttemptTimeoutMs);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// One source of names: the first-deploy broker file must hold brokerRequiredSecrets
// exactly. A list that disagrees with the names the command would write stops before any
// credential file is read, the broker file is created or a role is touched.
test("provision-roles --first: broker file names other than brokerRequiredSecrets fail closed", async () => {
  const planted = plantedHome({
    "neon-owner-url": `postgresql://neondb_owner:${"o".repeat(24)}@${labBinding.hostname}/morrow?sslmode=require`,
    "workos-api-key": "sk_test_" + "W".repeat(24),
    "turnstile-secret": "0x4AAAAAAA" + "t".repeat(26),
    "vault-kek-v1": plantedKek,
  });
  try {
    const base = await fakeContext({ home: planted.home, tools: fakeTools().tools });
    const { ctx, err, constants } = base;
    const db = fakeDatabase({ roles: constants.roles });
    ctx.database = db.connector;
    for (const brokerSecrets of [
      [...constants.brokerSecrets, "EXTRA_SECRET"].sort(),
      constants.brokerSecrets.filter((name) => name !== "TURNSTILE_SECRET_KEY"),
      constants.brokerSecrets.filter((name) => name !== constants.passwordSecret("morrow_api")),
      [...constants.brokerSecrets.slice(1), constants.brokerSecrets[1]],
      constants.brokerSecrets.filter((name) => name !== "MORROW_VAULT_KEK_V1"),
      constants.brokerSecrets.filter(
        (name) => name !== constants.passwordSecret("morrow_vault_broker"),
      ),
    ]) {
      ctx.constants = async () => Object.freeze({ ...constants, brokerSecrets });
      assert.equal(await main(["provision-roles", "--first"], ctx), 1);
      assert.equal(JSON.parse(err.at(-1)).code, "STAGING_BROKER_FILE_NAMES_INVALID");
      assert.equal(existsSync(join(planted.directory, "tmp/broker-secrets.json")), false);
      assert.deepEqual(db.statements, []);
    }
  } finally {
    planted.cleanup();
  }
});

// M2 PR-1 (ADR-0022 item 7): the KEK comes only from the owner's `vault-kek-v1` file. A
// missing, malformed or loosely permitted file stops --first before the broker file is
// created or any role is touched, and the tool never generates a KEK in its place.
test("provision-roles --first: the vault KEK is read from the owner's file, never generated", async () => {
  for (const [label, plant, modes, code] of [
    ["missing", {}, {}, "STAGING_FILE_MISSING"],
    ["uppercase", { "vault-kek-v1": plantedKek.toUpperCase() }, {}, "STAGING_FILE_FORMAT"],
    ["short", { "vault-kek-v1": plantedKek.slice(2) }, {}, "STAGING_FILE_FORMAT"],
    ["mode", { "vault-kek-v1": plantedKek }, { "vault-kek-v1": 0o644 }, "STAGING_FILE_MODE"],
  ]) {
    const planted = plantedHome(
      {
        "neon-owner-url": `postgresql://neondb_owner:${"o".repeat(24)}@${labBinding.hostname}/morrow?sslmode=require`,
        "workos-api-key": "sk_test_" + "W".repeat(24),
        "turnstile-secret": "0x4AAAAAAA" + "t".repeat(26),
        ...plant,
      },
      { modes },
    );
    try {
      const { ctx, err, constants } = await fakeContext({
        home: planted.home,
        tools: fakeTools().tools,
      });
      const db = fakeDatabase({ roles: constants.roles });
      ctx.database = db.connector;
      assert.equal(await main(["provision-roles", "--first"], ctx), 1, label);
      assert.equal(JSON.parse(err.at(-1)).code, code, label);
      assert.equal(existsSync(join(planted.directory, "tmp/broker-secrets.json")), false, label);
      assert.deepEqual(db.statements, [], label);
      assert.ok(!err.join().includes(plantedKek.slice(4, 40)), label);
    } finally {
      planted.cleanup();
    }
  }
});
