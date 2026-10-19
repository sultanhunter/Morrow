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
  platformSeedRows,
  provisioningSql,
  runMigrations,
  scramVerifier,
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
// Role controls (D3, AC07): only verifiers reach SQL.
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

test("provisioning SQL: LOGIN, the limit, both timeouts, REVOKE TEMP, verifiers only", () => {
  const password = "p".repeat(43);
  const verifier = scramVerifier(password);
  const statements = provisioningSql({
    roles: ["morrow_api", "morrow_api_worker"],
    verifiers: new Map([["morrow_api", verifier]]),
    database: "morrow",
  });
  assert.deepEqual(statements, [
    "BEGIN",
    `ALTER ROLE morrow_api WITH LOGIN CONNECTION LIMIT 10 PASSWORD '${verifier}'`,
    "ALTER ROLE morrow_api SET statement_timeout = '5s'",
    "ALTER ROLE morrow_api SET idle_in_transaction_session_timeout = '10s'",
    "ALTER ROLE morrow_api_worker WITH LOGIN CONNECTION LIMIT 10",
    "ALTER ROLE morrow_api_worker SET statement_timeout = '5s'",
    "ALTER ROLE morrow_api_worker SET idle_in_transaction_session_timeout = '10s'",
    "REVOKE TEMP ON DATABASE morrow FROM PUBLIC",
    "COMMIT",
  ]);
  assert.ok(statements.every((s) => !s.includes(password)));
  assert.equal(
    codeOf(() =>
      provisioningSql({
        roles: ["morrow_api"],
        verifiers: new Map([["morrow_api", password]]),
        database: "morrow",
      }),
    ),
    "STAGING_PASSWORD_INVALID",
  );
  assert.equal(
    codeOf(() =>
      provisioningSql({ roles: ["morrow_api; DROP"], verifiers: new Map(), database: "morrow" }),
    ),
    "STAGING_ROLE_INVALID",
  );
  assert.equal(
    codeOf(() =>
      provisioningSql({ roles: ["morrow_api"], verifiers: new Map(), database: "morrow; x" }),
    ),
    "STAGING_DATABASE_MISMATCH",
  );
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
    const mismatched = await fakeContext({
      home: planted.home,
      tools: fakeTools().tools,
      staging: {
        ...committed,
        neon: { ...committed.neon, project_id: "another-project", branch_id: labBinding.branchId },
      },
    });
    assert.equal(await main(["migrate"], mismatched.ctx), 1);
    assert.equal(JSON.parse(mismatched.err.at(-1)).code, "STAGING_BINDING_INVALID");
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
test("staging.json: the D1 shape with every identifier still null", () => {
  const staging = JSON.parse(read("infra/environments/staging.json"));
  for (const value of [
    staging.cloudflare.account_id,
    staging.cloudflare.workers_dev_subdomain,
    staging.cloudflare.origin,
    staging.neon.project_id,
    staging.neon.root_branch_id,
    staging.neon.branch_id,
    staging.neon.region_id,
  ])
    assert.equal(value, null);
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

test("fake database: provisioning through the CLI sends only verifiers", async () => {
  const planted = plantedHome({
    "neon-owner-url": `postgresql://neondb_owner:${"o".repeat(24)}@${labBinding.hostname}/morrow?sslmode=require`,
    "workos-api-key": "sk_test_" + "W".repeat(24),
    "turnstile-secret": "0x4AAAAAAA" + "t".repeat(26),
  });
  try {
    const { ctx, out, constants } = await fakeContext({
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
    const passwords = constants.roles.map((r) => secrets[constants.passwordSecret(r)]);
    assert.ok(passwords.every((p) => /^[A-Za-z0-9_-]{43}$/.test(p)));
    const sent = JSON.stringify(db.statements);
    assert.ok(passwords.every((p) => !sent.includes(p)));
    assert.equal((sent.match(/SCRAM-SHA-256\$4096:/g) ?? []).length, 8);
    assert.ok(passwords.every((p) => !out.join().includes(p)));
    // A second --first refuses: the file exists, and nothing was sent.
    const before = db.statements.length;
    assert.equal(await main(["provision-roles", "--first"], ctx), 1);
    assert.equal(db.statements.length, before);
  } finally {
    planted.cleanup();
  }
});
