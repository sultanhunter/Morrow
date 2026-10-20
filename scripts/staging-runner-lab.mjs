// lab:staging-runner (P04.T01i AC06, the SQL half of AC07, the hosted-shape replay, and
// P04.T01j-AC14; pg-http group). Two isolated, network-none PostgreSQL 17.11 containers.
// The staging CLI (`node scripts/staging.mjs migrate | provision-roles`) runs through its
// real code with fake git and gh, a planted temporary HOME and a psql connector in place
// of the Neon driver.
// - Container 1, superuser mode: the real chain with the hosted-shape replay, the
//   refusals, drift, and the D4 SET-row protocol on synthetic chains (kill before COMMIT,
//   lost acknowledgement, partial prerequisite, concurrency, a role changed by dynamic SQL).
// - Container 2, createrole mode (ADR-0020, P04.T01j D4 and AC14): the real chain applied
//   by a Neon-shaped non-superuser CREATEROLE `neondb_owner` (scripts/fixtures/
//   createrole-administrator.mjs), the hosted-shape provisioning, then the last entry
//   through a kill before COMMIT and a lost acknowledgement, a superseded digest, and a
//   planted SET row; zero Morrow SET rows and closed memberships at rest.
// The chain runs through its head (M2 PR-1: 0019-0024), so provisioning covers the eleven
// broker logins, the vault login included, and the first-deploy file the fourteen broker
// names, with the owner's vault KEK read from its planted file (`vault-kek-v1`).
// No provider, credential, host port or merchant data; every secret is a synthetic marker.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, writeArtifact } from "./artifacts.mjs";
import { localPostgresLab } from "./local-postgres-lab.mjs";
import { loadMigrationChain, schemaHead } from "./migration-chain.mjs";
import { identityConstants, main } from "./staging.mjs";
import { runMigrations, runnerSetRows, scramVerifier } from "./staging-runner.mjs";
import { psqlConnector } from "./fixtures/staging-psql-connection.mjs";
import {
  createAdministrator,
  morrowMembershipCensusSql,
  morrowRoles,
  morrowSetRows,
  psqlAs,
} from "./fixtures/createrole-administrator.mjs";
import {
  approvedCard,
  fakeContext,
  fakeTools,
  labBinding,
  plantedHome,
} from "../tests/fixtures/staging-fakes.mjs";

const checks = [];
const check = (name, condition) => {
  if (!condition) throw Error("STAGING_RUNNER_LAB_CHECK_FAILED:" + name);
  checks.push({ name, passed: true });
};
const sha = (text) => createHash("sha256").update(text).digest("hex");
const hex = (n) => randomBytes(n).toString("hex");
// Synthetic markers: never real credentials, each unique to this run.
const markers = {
  ownerPassword: "labowner" + hex(12),
  workos: "sk_test_" + hex(12).toUpperCase() + "LAB",
  turnstile: "0x4AAAAAAA" + hex(14),
  // M2 PR-1: the owner's vault KEK file holds 64 lowercase hex characters.
  kek: hex(32),
};
const ownerUrl = (user, { host = labBinding.hostname, database = "morrow" } = {}) =>
  `postgresql://${user}:${markers.ownerPassword}@${host}/${database}?sslmode=require`;
const superuser = Object.freeze({ name: "postgres", mode: "superuser" });
const homes = [];
const temporary = [];
const home = (files) => {
  const planted = plantedHome(files);
  homes.push(planted);
  return planted;
};
const parse = (lines) => lines.map((line) => JSON.parse(line));

// A copy of the reviewed chain with one byte changed in `path` (a wrong sha256).
function tamperedRoot(path) {
  const root = mkdtempSync(join(tmpdir(), "morrow-staging-lab-root-"));
  temporary.push(root);
  cpSync(join(repositoryRoot, "migrations"), join(root, "migrations"), { recursive: true });
  mkdirSync(join(root, "infra"));
  for (const name of readFileSync(join(repositoryRoot, "migrations/manifest.json"), "utf8").match(
    /infra\/[a-z-]+-prerequisites\.sql/g,
  ))
    cpSync(join(repositoryRoot, name), join(root, name));
  writeFileSync(join(root, path), readFileSync(join(root, path), "utf8") + "\n-- tampered\n");
  return root;
}
// Three synthetic entries under `morrow_<prefix>_owner`, the first pinning one
// prerequisite that creates two roles. `second` replaces the second entry's body.
function syntheticRoot(prefix, database, second = null) {
  const root = mkdtempSync(join(tmpdir(), "morrow-staging-lab-syn-"));
  temporary.push(root);
  mkdirSync(join(root, "migrations"));
  mkdirSync(join(root, "infra"));
  const owner = `morrow_${prefix}_owner`;
  const reader = `morrow_${prefix}_reader`;
  const prerequisite = `CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;\nCREATE ROLE ${reader} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;\nGRANT CREATE ON DATABASE ${database} TO ${owner};\n`;
  const files = {
    [`0001.${prefix}-one.sql`]: `BEGIN;\nCREATE SCHEMA morrow_${prefix};\nCREATE TABLE morrow_${prefix}.one(id int);\nCOMMIT;\n`,
    [`0002.${prefix}-two.sql`]:
      second ??
      `BEGIN;\nCREATE TABLE morrow_${prefix}.two(id int);\nSELECT pg_catalog.pg_sleep(0.3);\nCOMMIT;\n`,
    [`0003.${prefix}-three.sql`]: `BEGIN;\nCREATE TABLE morrow_${prefix}.three(id int);\nCOMMIT;\n`,
  };
  const prerequisitePath = `infra/${prefix}-role-prerequisites.sql`;
  writeFileSync(join(root, prerequisitePath), prerequisite);
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, "migrations", name), text);
  const manifest = {
    schema_version: 1,
    engine: "postgresql17",
    status: "laboratory",
    migrations: Object.entries(files).map(([file, text], index) => ({
      sequence: index + 1,
      file,
      sha256: sha(text),
      reviewRef: "lab:staging-runner",
      executeAs: owner,
      ...(index === 0
        ? { prerequisites: [{ file: prerequisitePath, sha256: sha(prerequisite) }] }
        : {}),
    })),
  };
  writeFileSync(join(root, "migrations/manifest.json"), JSON.stringify(manifest, null, 2));
  return { chain: loadMigrationChain({ root }), owner, reader, schema: "morrow_" + prefix };
}
const rejection = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};
// Triggers on the runner's ledger INSERT for `sequence`, then acts on that connection's
// COMMIT: `kill` before it is sent, or `lose` its reply after the server committed.
function commitFault(sequence, action) {
  const hit = { count: 0 };
  const hooks = {
    async before(text, session) {
      if (new RegExp(`EXECUTE staging_lab_q\\('${sequence}',`).test(text)) session.target = true;
      if (action === "kill" && text === "COMMIT;" && session.target) {
        hit.count++;
        session.kill();
      }
    },
    async after(text, session) {
      if (action === "lose" && text === "COMMIT;" && session.target) {
        hit.count++;
        session.loseReply();
      }
    },
  };
  return { hooks, hit };
}

const report = await localPostgresLab("P04.T01i", async ({ id, sql, image, version }) => {
  const db = (text, database = "morrow") => sql(text, database);
  sql("CREATE DATABASE morrow;");
  const chain = loadMigrationChain();
  // Hosted-shape replay (D3): apply up to the last sequence on origin/main, provision the
  // roles in hosted shape, then apply the rest. A PR that adds no migration replays N.
  // Provisioning needs every broker login, so the baseline also reaches the entry whose
  // pinned prerequisite creates the last of them (M2 PR-1: 0019, the spine logins).
  const brokerLogins = (await identityConstants()).roles;
  const created = new Set();
  let loginsReady = chain.length;
  for (const [index, entry] of chain.entries()) {
    for (const prerequisite of entry.prerequisites)
      for (const role of prerequisite.roles) created.add(role);
    if (brokerLogins.every((role) => created.has(role))) {
      loginsReady = index + 1;
      break;
    }
  }
  const mainManifest = spawnSync("git", ["show", "origin/main:migrations/manifest.json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  let mainLength = null;
  try {
    mainLength =
      mainManifest.status === 0 ? JSON.parse(mainManifest.stdout).migrations.length : null;
  } catch {
    mainLength = null;
  }
  const baseline = Math.min(
    Math.max(
      mainLength !== null && mainLength < chain.length ? mainLength : chain.length - 1,
      loginsReady,
    ),
    chain.length - 1,
  );
  check("baseline_creates_every_broker_login", loginsReady <= baseline);

  const planted = home({
    "neon-owner-url": ownerUrl("postgres"),
    "workos-api-key": markers.workos,
    "turnstile-secret": markers.turnstile,
    "vault-kek-v1": markers.kek,
  });
  const connector = psqlConnector(id, { user: "postgres", database: "morrow" });
  const fakes = fakeTools();
  const base = await fakeContext({
    home: planted.home,
    tools: fakes.tools,
    administrator: superuser,
    database: () => connector,
  });
  const ctx = base.ctx;
  const run = async (argv, context = ctx) => {
    const before = { out: base.out.length, err: base.err.length };
    const code = await main(argv, context);
    return {
      code,
      out: parse(base.out.slice(before.out)),
      err: parse(base.err.slice(before.err)),
    };
  };

  // --- Refusals before any SQL (AC06).
  const refusals = [
    [
      "card_inactive",
      { card: { ...approvedCard(), status: "proposed", approvedOn: null, expiresOn: null } },
      "STAGING_CARD_INACTIVE",
    ],
    [
      "dirty_tree",
      { tools: fakeTools({ git: { status: " M scripts/staging.mjs\n" } }).tools },
      "STAGING_TREE_DIRTY",
    ],
    [
      "head_not_main",
      { tools: fakeTools({ git: { head: "b".repeat(40) } }).tools },
      "STAGING_NOT_MAIN",
    ],
    [
      "foundation_not_green",
      {
        tools: fakeTools({
          gh: {
            checkRuns: [
              {
                name: "foundation",
                head_sha: fakeTools().state.main,
                status: "completed",
                conclusion: "failure",
              },
            ],
          },
        }).tools,
      },
      "STAGING_FOUNDATION_NOT_GREEN",
    ],
    [
      "pooler_host",
      {
        home: home({
          "neon-owner-url": ownerUrl("postgres", {
            host: "ep-lab-runner-000001-pooler.us-east-1.aws.neon.tech",
          }),
        }).home,
      },
      "STAGING_OWNER_URL_POOLER",
    ],
    [
      "wrong_host",
      {
        home: home({
          "neon-owner-url": ownerUrl("postgres", {
            host: "ep-lab-other-000002.us-east-1.aws.neon.tech",
          }),
        }).home,
      },
      "STAGING_HOST_MISMATCH",
    ],
    [
      "wrong_database",
      { home: home({ "neon-owner-url": ownerUrl("postgres", { database: "morrow_other" }) }).home },
      "STAGING_DATABASE_MISMATCH",
    ],
    [
      "wrong_url_role",
      { home: home({ "neon-owner-url": ownerUrl("neondb_owner") }).home },
      "STAGING_SESSION_ROLE",
    ],
    [
      "wrong_prerequisite_sha256",
      { root: tamperedRoot("infra/work-role-prerequisites.sql") },
      "MIGRATION_CHAIN_INVALID",
      "PREREQUISITE_CHECKSUM",
    ],
    [
      "wrong_migration_sha256",
      { root: tamperedRoot("migrations/0015.work-state.sql") },
      "MIGRATION_CHAIN_INVALID",
      "MIGRATION_CHECKSUM",
    ],
  ];
  for (const [name, change, code, inner] of refusals) {
    const sent = connector.statements.length;
    const variant = await fakeContext({
      home: change.home ?? planted.home,
      root: change.root,
      tools: change.tools ?? fakeTools().tools,
      card: change.card ?? approvedCard(),
      administrator: superuser,
      database: () => connector,
    });
    const code1 = await main(["migrate"], variant.ctx);
    const error = parse(variant.err)[0];
    check(
      "refuses_" + name,
      code1 === 1 &&
        error?.code === code &&
        (!inner || error.codes?.includes(inner)) &&
        variant.out.length === 0,
    );
    check("refuses_" + name + "_before_any_sql", connector.statements.length === sent);
  }
  // Server-side refusals: the connected session itself is checked.
  db("CREATE ROLE lab_intruder LOGIN NOSUPERUSER NOCREATEROLE;", "morrow_lab");
  for (const [name, user, database, code] of [
    ["wrong_session_role", "lab_intruder", "morrow", "STAGING_SESSION_ROLE"],
    ["wrong_server_database", "postgres", "morrow_lab", "STAGING_DATABASE_MISMATCH"],
  ]) {
    const variant = await fakeContext({
      home: planted.home,
      tools: fakeTools().tools,
      administrator: superuser,
      database: () => psqlConnector(id, { user, database }),
    });
    const exit = await main(["migrate"], variant.ctx);
    check("refuses_" + name, exit === 1 && parse(variant.err)[0]?.code === code);
  }
  check(
    "refusals_left_no_ledger",
    db("SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname='morrow_migrations';") === "0",
  );

  // --- Baseline apply 1..N-1 in superuser mode with pinned prerequisites and executeAs.
  ctx.chain = () => chain.slice(0, baseline);
  const first = await run(["migrate"]);
  const firstResult = first.out[0];
  check(
    "baseline_applies_in_order",
    first.code === 0 &&
      JSON.stringify(firstResult.applied) ===
        JSON.stringify(chain.slice(0, baseline).map((e) => e.sequence)),
  );
  check(
    "baseline_runs_each_pinned_prerequisite_once",
    JSON.stringify(firstResult.prerequisites.map((p) => p.file)) ===
      JSON.stringify(chain.slice(0, baseline).flatMap((e) => e.prerequisites.map((p) => p.file))) &&
      firstResult.prerequisites.every((p) => p.outcome === "applied"),
  );
  check(
    "baseline_publishes_schema_head",
    fakes.state.variables.STAGING_SCHEMA_HEAD === schemaHead(chain.slice(0, baseline)),
  );
  const ledgerRows = JSON.parse(
    db(
      "SELECT json_agg(json_build_object('s',sequence,'f',file,'h',sha256,'x',execute_as,'p',prerequisites,'c',source_commit) ORDER BY sequence) FROM morrow_migrations.applied;",
    ),
  );
  check(
    "ledger_records_each_entry",
    ledgerRows.length === baseline &&
      ledgerRows.every(
        (r, i) =>
          r.s === chain[i].sequence &&
          r.f === chain[i].file &&
          r.h === chain[i].sha256 &&
          r.x === chain[i].executeAs &&
          JSON.stringify(r.p) ===
            JSON.stringify(
              chain[i].prerequisites.map((p) => ({ file: p.file, sha256: p.sha256 })),
            ) &&
          r.c === fakes.state.main,
      ),
  );
  check(
    "ledger_owned_by_administrator_and_private",
    db(
      `SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname LIKE 'morrow\\_%' AND (has_schema_privilege(r.oid,'morrow_migrations','USAGE') OR has_table_privilege(r.oid,'morrow_migrations.applied','SELECT,INSERT,UPDATE,DELETE'));`,
    ) === "0" &&
      db(
        "SELECT count(*) FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a WHERE c.oid='morrow_migrations.applied'::regclass AND a.grantee<>c.relowner;",
      ) === "0" &&
      db(
        "SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='morrow_migrations.applied'::regclass;",
      ) === "postgres",
  );
  check(
    "superuser_mode_leaves_no_set_rows",
    db(
      "SELECT count(*) FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid=m.roleid WHERE g.rolname LIKE 'morrow\\_%' AND m.set_option AND m.member=(SELECT oid FROM pg_roles WHERE rolname='postgres');",
    ) === "0",
  );

  // --- Hosted-shape provisioning (D3, AC07 SQL half). Every statement is logged by the
  // server from here on, so the log can show that only verifiers reached SQL.
  db("ALTER DATABASE morrow SET log_statement = 'all';", "morrow_lab");
  const provision = await run(["provision-roles", "--first"]);
  check(
    "provision_first_succeeds",
    provision.code === 0 && provision.out[0]?.controls === "verified",
  );
  const constants = base.constants;
  const secretsFile = join(planted.directory, "tmp/broker-secrets.json");
  const mode = statSync(secretsFile).mode & 0o777;
  const secrets = JSON.parse(readFileSync(secretsFile, "utf8"));
  check("first_deploy_file_is_owner_only", mode === 0o600);
  check(
    "first_deploy_file_holds_exactly_the_broker_secrets",
    Object.keys(secrets).sort().join() === constants.brokerSecrets.join() &&
      constants.brokerSecrets.length === 14 &&
      secrets.WORKOS_API_KEY === markers.workos &&
      secrets.TURNSTILE_SECRET_KEY === markers.turnstile,
  );
  // M2 PR-1: the KEK is the owner's file, byte for byte; the tool never generates one.
  check("first_deploy_file_carries_the_owner_kek", secrets.MORROW_VAULT_KEK_V1 === markers.kek);
  const passwords = constants.roles.map((role) => secrets[constants.passwordSecret(role)]);
  check(
    "passwords_are_32_random_bytes",
    passwords.every((p) => /^[A-Za-z0-9_-]{43}$/.test(p)) &&
      new Set(passwords).size === passwords.length,
  );
  const facts = JSON.parse(
    db(
      `SELECT json_agg(json_build_object('r',r.rolname,'l',r.rolcanlogin,'c',r.rolconnlimit,'s',(SELECT array_to_string(array(SELECT unnest(s.setconfig) ORDER BY 1),',') FROM pg_db_role_setting s WHERE s.setrole=r.oid AND s.setdatabase=0),'v',a.rolpassword) ORDER BY r.rolname) FROM pg_roles r JOIN pg_authid a ON a.oid=r.oid WHERE r.rolname IN (${constants.roles.map((r) => `'${r}'`).join(",")});`,
    ),
  );
  check(
    "all_roles_have_login_limit_and_timeouts",
    facts.length === constants.roles.length &&
      constants.roles.length === 11 &&
      constants.roles.includes("morrow_vault_broker") &&
      facts.every(
        (f) =>
          f.l === true &&
          f.c === 10 &&
          f.s === "idle_in_transaction_session_timeout=10s,statement_timeout=5s",
      ),
  );
  check(
    "stored_verifiers_match_the_generated_passwords",
    facts.every((f) => {
      const password = secrets[constants.passwordSecret(f.r)];
      const salt = Buffer.from(/^SCRAM-SHA-256\$4096:([^$]+)\$/.exec(f.v)?.[1] ?? "", "base64");
      return salt.length === 16 && scramVerifier(password, { salt }) === f.v;
    }),
  );
  check(
    "public_has_no_temp",
    db(
      "SELECT count(*) FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname='morrow' AND a.grantee=0 AND a.privilege_type='TEMPORARY';",
    ) === "0",
  );
  // A real SCRAM login with a generated password over the socket; then the old trust.
  const hba = (text) => {
    const r = spawnSync(
      "docker",
      ["exec", "--interactive", id, "sh", "-c", 'cat > "$PGDATA/pg_hba.conf"'],
      { input: text, encoding: "utf8", timeout: 30000 },
    );
    if (r.status !== 0) throw Error("STAGING_RUNNER_LAB_HBA");
    sql("SELECT pg_catalog.pg_reload_conf();");
  };
  const login = (role, password) => {
    spawnSync(
      "docker",
      ["exec", "--interactive", id, "sh", "-c", "umask 077; cat > /tmp/lab.pgpass"],
      { input: `*:*:*:${role}:${password}\n`, timeout: 30000 },
    );
    const r = spawnSync(
      "docker",
      [
        "exec",
        "--env",
        "PGPASSFILE=/tmp/lab.pgpass",
        id,
        "psql",
        "-X",
        "-qAt",
        "-w",
        "-U",
        role,
        "-d",
        "morrow",
        "-c",
        "SELECT current_user || ':' || current_setting('statement_timeout') || ':' || current_setting('idle_in_transaction_session_timeout');",
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    spawnSync("docker", ["exec", id, "rm", "-f", "/tmp/lab.pgpass"], { timeout: 30000 });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  hba("local all postgres trust\nlocal all all scram-sha-256\n");
  try {
    check(
      "generated_password_logs_in_with_scram",
      login("morrow_api", secrets.MORROW_DB_PASSWORD_MORROW_API) === "morrow_api:5s:10s",
    );
    check(
      "other_password_is_refused",
      login("morrow_api", secrets.MORROW_DB_PASSWORD_MORROW_API_WORKER) === null,
    );
  } finally {
    hba("local all all trust\n");
  }

  // --- The rest of the chain after hosted-shape provisioning: the replay.
  ctx.chain = () => chain;
  const rest = await run(["migrate"]);
  check(
    "replay_applies_the_remaining_entries_after_provisioning",
    rest.code === 0 &&
      JSON.stringify(rest.out[0].applied) ===
        JSON.stringify(chain.slice(baseline).map((e) => e.sequence)),
  );
  check(
    "schema_head_published_for_the_full_chain",
    fakes.state.variables.STAGING_SCHEMA_HEAD === schemaHead(chain),
  );
  check(
    "schema_head_withdrawn_before_the_run_and_published_after",
    fakes.calls
      .filter(
        (c) => c.tool === "gh" && c.args[0] === "variable" && c.args[2] === "STAGING_SCHEMA_HEAD",
      )
      .slice(-2)
      .map((c) => c.args[c.args.indexOf("--body") + 1])
      .join() ===
      "0," + schemaHead(chain),
  );
  const again = await run(["migrate"]);
  check(
    "rerun_is_a_no_op",
    again.code === 0 &&
      again.out[0].applied.length === 0 &&
      again.out[0].reconciled.length === 0 &&
      again.out[0].ledger === chain.length,
  );

  // --- Drift: a superseded digest (P04.T01j AC14) and a ledger ahead of the manifest.
  const superseded = "e42e91b7cbb2de9c59591346212fb250aed0c8cdba6edb6bd787dcceda78de92";
  const row5 = db("SELECT sha256 FROM morrow_migrations.applied WHERE sequence=5;");
  db(
    `UPDATE morrow_migrations.applied SET sha256='${superseded === row5 ? "0".repeat(64) : superseded}' WHERE sequence=5;`,
  );
  const drift = await run(["migrate"]);
  check(
    "superseded_digest_is_ledger_drift",
    drift.code === 1 &&
      drift.err[0].code === "MIGRATION_LEDGER_DRIFT" &&
      drift.err[0].reason === "digest" &&
      drift.err[0].sequence === 5,
  );
  db(`UPDATE morrow_migrations.applied SET sha256='${row5}' WHERE sequence=5;`);
  db(
    `INSERT INTO morrow_migrations.applied(sequence,file,sha256,execute_as,prerequisites,source_commit) VALUES(${chain.length + 1},'9999.unreviewed.sql','${"1".repeat(64)}','morrow_work_owner','[]','${"2".repeat(40)}');`,
  );
  const ahead = await run(["migrate"]);
  check(
    "ledger_ahead_of_manifest_is_drift",
    ahead.code === 1 &&
      ahead.err[0].code === "MIGRATION_LEDGER_DRIFT" &&
      ahead.err[0].reason === "ahead",
  );
  db(`DELETE FROM morrow_migrations.applied WHERE sequence=${chain.length + 1};`);

  // --- Synthetic chains: crash before COMMIT, lost acknowledgement, partial
  // prerequisite, concurrency (superuser), then the D4 SET-row protocol (createrole).
  const synthetic = async (prefix, owner = "postgres", second = null) => {
    const database = "morrow_" + prefix + "_db";
    sql(`CREATE DATABASE ${database}${owner === "postgres" ? "" : " OWNER " + owner};`);
    return { ...syntheticRoot(prefix, database, second), binding: { ...labBinding, database } };
  };
  const options = (s, administrator, hooks) => ({
    connect: psqlConnector(id, { user: administrator.name, database: s.binding.database, hooks })
      .connect,
    chain: s.chain,
    binding: s.binding,
    administrator,
    sourceCommit: "3".repeat(40),
    reconcileWaitMs: 15000,
  });
  const ledgerOf = (s) =>
    db(
      "SELECT coalesce(string_agg(sequence::text, ',' ORDER BY sequence), '') FROM morrow_migrations.applied;",
      s.binding.database,
    );
  const exists = (s, table) =>
    db(`SELECT to_regclass('${s.schema}.${table}') IS NOT NULL;`, s.binding.database) === "t";

  const s1 = await synthetic("sa");
  const kill = commitFault(2, "kill");
  const killed = await rejection(runMigrations(options(s1, superuser, kill.hooks)));
  check(
    "kill_before_commit_reports_not_committed",
    kill.hit.count === 1 &&
      killed?.code === "MIGRATION_NOT_COMMITTED" &&
      killed.details.sequence === 2,
  );
  check(
    "kill_before_commit_leaves_neither_row_nor_migration",
    ledgerOf(s1) === "1" && !exists(s1, "two"),
  );
  const resumed = await runMigrations(options(s1, superuser));
  check(
    "rerun_after_kill_applies_the_rest",
    JSON.stringify(resumed.applied) === "[2,3]" && ledgerOf(s1) === "1,2,3" && exists(s1, "two"),
  );

  const s2 = await synthetic("sb");
  const lose = commitFault(2, "lose");
  const lost = await runMigrations(options(s2, superuser, lose.hooks));
  check(
    "lost_ack_is_resolved_by_reading_the_ledger",
    lose.hit.count === 1 &&
      JSON.stringify(lost.reconciled) === "[2]" &&
      JSON.stringify(lost.applied) === "[1,3]",
  );
  check("lost_ack_entry_committed_exactly_once", ledgerOf(s2) === "1,2,3" && exists(s2, "two"));

  const s3 = await synthetic("sc");
  sql(`CREATE ROLE ${s3.owner} NOLOGIN NOINHERIT;`);
  const partial = await rejection(runMigrations(options(s3, superuser)));
  check(
    "partial_prerequisite_stops_the_run",
    partial?.code === "PREREQUISITE_PARTIAL" &&
      ledgerOf(s3) === "" &&
      db(`SELECT count(*) FROM pg_namespace WHERE nspname='${s3.schema}';`, s3.binding.database) ===
        "0" &&
      db(`SELECT count(*) FROM pg_roles WHERE rolname='${s3.reader}';`) === "0",
  );

  const s4 = await synthetic("sd");
  const both = await Promise.allSettled([
    runMigrations(options(s4, superuser)),
    runMigrations(options(s4, superuser)),
  ]);
  const applied = both.map((r) =>
    r.status === "fulfilled" ? JSON.stringify(r.value.applied) : "rejected",
  );
  check(
    "concurrent_runs_serialize",
    applied.sort().join("|") === "[1,2,3]|[]" && ledgerOf(s4) === "1,2,3",
  );

  // A Neon-shaped administrator: LOGIN CREATEROLE, not a superuser, owning the database.
  sql("CREATE ROLE lab_admin LOGIN CREATEROLE NOSUPERUSER NOINHERIT;");
  const createrole = Object.freeze({ name: "lab_admin", mode: "createrole" });
  const s5 = await synthetic("se", "lab_admin");
  const setRows = () =>
    db(
      "SELECT count(*) FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid=m.roleid WHERE g.rolname LIKE 'morrow\\_%' AND m.set_option AND m.member=(SELECT oid FROM pg_roles WHERE rolname='lab_admin');",
    );
  const shape = await rejection(
    runMigrations(options(s5, { name: "lab_admin", mode: "superuser" })),
  );
  check(
    "createrole_administrator_refused_in_superuser_mode",
    shape?.code === "STAGING_ADMINISTRATOR_SHAPE",
  );
  const kill5 = commitFault(2, "kill");
  const killed5 = await rejection(runMigrations(options(s5, createrole, kill5.hooks)));
  check(
    "d4_kill_before_commit_leaves_no_set_row",
    killed5?.code === "MIGRATION_NOT_COMMITTED" && ledgerOf(s5) === "1" && setRows() === "0",
  );
  const lose5 = commitFault(3, "lose");
  const lost5 = await runMigrations(options(s5, createrole, lose5.hooks));
  check(
    "d4_lost_ack_reconciled_with_no_set_row",
    JSON.stringify(lost5.applied) === "[2]" &&
      JSON.stringify(lost5.reconciled) === "[3]" &&
      setRows() === "0",
  );
  check(
    "d4_rows_at_rest_are_the_creation_rows_only",
    db(
      `SELECT count(*) FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid WHERE g.rolname IN ('${s5.owner}','${s5.reader}');`,
    ) === "2" &&
      db(
        `SELECT count(*) FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE g.rolname IN ('${s5.owner}','${s5.reader}') AND u.rolname='lab_admin' AND m.grantor=10 AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option;`,
      ) === "2",
  );
  check(
    "d4_ledger_owned_by_the_createrole_administrator",
    db(
      "SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='morrow_migrations.applied'::regclass;",
      s5.binding.database,
    ) === "lab_admin",
  );
  check(
    "d4_runner_set_rows_helper_agrees",
    (await (async () => {
      const c = await psqlConnector(id, {
        user: "lab_admin",
        database: s5.binding.database,
      }).connect();
      try {
        return await runnerSetRows(c);
      } finally {
        await c.close();
      }
    })()) === 0,
  );

  // A body that leaves its executeAs through dynamic SQL, which the static guard cannot
  // see: the runner's end-of-body role check refuses it before COMMIT, so the escaped
  // DDL, the ledger row and the SET row all roll back.
  const s6 = await synthetic(
    "sf",
    "lab_admin",
    "BEGIN;\nDO $$ BEGIN EXECUTE 'RESET ' || 'ROLE'; END $$;\nCREATE TABLE public.escaped(id int);\nCOMMIT;\n",
  );
  const changed = await rejection(runMigrations(options(s6, createrole)));
  check(
    "role_changed_by_dynamic_sql_is_refused_and_rolled_back",
    changed?.code === "MIGRATION_ROLE_CHANGED" &&
      changed.details.sequence === 2 &&
      ledgerOf(s6) === "1" &&
      db("SELECT to_regclass('public.escaped') IS NULL;", s6.binding.database) === "t" &&
      setRows() === "0",
  );

  // --- AC07: no marker in the tool's output, the statements it sent, or the server log.
  const logs = spawnSync("docker", ["logs", id], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 64 << 20,
  });
  const serverLog = (logs.stdout ?? "") + (logs.stderr ?? "");
  const secretsSeen = [
    markers.ownerPassword,
    markers.workos,
    markers.turnstile,
    markers.kek,
    ...passwords,
  ];
  check(
    "server_log_recorded_the_provisioning_verifiers",
    serverLog.includes("SCRAM-SHA-256$4096:"),
  );
  check(
    "no_plaintext_or_marker_in_server_log",
    secretsSeen.every((m) => !serverLog.includes(m)),
  );
  check(
    "no_plaintext_or_marker_in_statements_sent",
    secretsSeen.every((m) => connector.statements.every((s) => !s.includes(m))),
  );
  check(
    "no_plaintext_or_marker_in_tool_output",
    secretsSeen.every((m) => ![...base.out, ...base.err].some((line) => line.includes(m))),
  );
  check(
    "no_secret_in_any_tool_argv",
    secretsSeen.every((m) => fakes.calls.every((call) => !call.args.some((a) => a.includes(m)))),
  );
  return {
    image,
    version,
    baseline,
    loginsReady,
    mainManifest: mainLength === null ? "unavailable" : "origin/main",
    sentinels: secretsSeen.length,
  };
});

// --- Container 2: the real chain as a Neon-shaped CREATEROLE administrator (ADR-0020;
// P04.T01j D4 and AC14). Roles are cluster-wide, so this needs a fresh cluster.
const createroleReport = await localPostgresLab("P04.T01i.createrole", async ({ id, sql }) => {
  createAdministrator(id, { bypassrls: false });
  const db = (text) => sql(text, "morrow");
  const neon = Object.freeze({ name: "neondb_owner", mode: "createrole" });
  const chain = loadMigrationChain();
  const last = chain.at(-1).sequence;
  const planted = home({
    "neon-owner-url": ownerUrl("neondb_owner"),
    "workos-api-key": markers.workos,
    "turnstile-secret": markers.turnstile,
    "vault-kek-v1": markers.kek,
  });
  const connector = psqlConnector(id, { user: "neondb_owner", database: "morrow" });
  const fakes = fakeTools();
  const base = await fakeContext({
    home: planted.home,
    tools: fakes.tools,
    administrator: neon,
    database: () => connector,
  });
  const run = async (argv) => {
    const before = { out: base.out.length, err: base.err.length };
    const code = await main(argv, base.ctx);
    return {
      code,
      out: parse(base.out.slice(before.out)),
      err: parse(base.err.slice(before.err)),
    };
  };
  const ledger = () =>
    db(
      "SELECT coalesce(string_agg(sequence::text, ',' ORDER BY sequence), '') FROM morrow_migrations.applied;",
    );
  const through = (n) =>
    chain
      .filter((e) => e.sequence <= n)
      .map((e) => e.sequence)
      .join(",");
  // The ADR-0020 closed set, read by the identity owner, as the conformance suite does.
  const closed = () =>
    psqlAs(
      id,
      "SET ROLE morrow_identity_owner;\nSELECT morrow_identity.morrow_memberships_closed();",
    ) === "t";
  const recorded = () =>
    psqlAs(
      id,
      "SET ROLE morrow_identity_owner;\nSELECT r.rolname FROM pg_catalog.pg_roles r WHERE r.oid = morrow_identity.recorded_administrator();",
    );
  const census = () =>
    psqlAs(id, morrowMembershipCensusSql + ";")
      .split("\n")
      .filter(Boolean);
  const direct = (hooks) => ({
    connect: psqlConnector(id, { user: "neondb_owner", database: "morrow", hooks }).connect,
    chain,
    binding: labBinding,
    administrator: neon,
    sourceCommit: "4".repeat(40),
    reconcileWaitMs: 15000,
  });

  // The chain up to the entry before the last, through the CLI, in createrole mode.
  base.ctx.chain = () => chain.filter((e) => e.sequence < last);
  const first = await run(["migrate"]);
  check(
    "createrole_applies_the_chain_in_order_with_d4",
    first.code === 0 &&
      JSON.stringify(first.out[0]?.applied) ===
        JSON.stringify(chain.filter((e) => e.sequence < last).map((e) => e.sequence)) &&
      first.out[0].prerequisites.every((p) => p.outcome === "applied"),
  );
  check("createrole_leaves_no_morrow_set_row", morrowSetRows(id) === 0);
  check("createrole_memberships_closed_and_recorded", closed() && recorded() === "neondb_owner");
  check(
    "createrole_ledger_owned_and_written_by_the_administrator",
    db(
      "SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='morrow_migrations.applied'::regclass;",
    ) === "neondb_owner" &&
      db("SELECT string_agg(DISTINCT applied_by::text, ',') FROM morrow_migrations.applied;") ===
        "neondb_owner",
  );

  // Hosted-shape provisioning by the CREATEROLE administrator (it holds ADMIN on each
  // role through its creation row), then the replay of the last entry.
  const provision = await run(["provision-roles", "--first"]);
  check(
    "createrole_provisions_roles_in_hosted_shape",
    provision.code === 0 &&
      provision.out[0]?.controls === "verified" &&
      db(
        `SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN (${base.constants.roles.map((r) => `'${r}'`).join(",")}) AND rolcanlogin AND rolconnlimit = 10;`,
      ) === String(base.constants.roles.length),
  );
  check("createrole_provisioning_keeps_memberships_closed", closed() && morrowSetRows(id) === 0);

  // AC14: the last entry through a kill before COMMIT, then a lost acknowledgement.
  base.ctx.chain = () => chain;
  const kill = commitFault(last, "kill");
  const killed = await rejection(runMigrations(direct(kill.hooks)));
  check(
    "createrole_kill_before_commit_leaves_no_set_row",
    kill.hit.count === 1 &&
      killed?.code === "MIGRATION_NOT_COMMITTED" &&
      killed.details.sequence === last &&
      ledger() === through(last - 1) &&
      morrowSetRows(id) === 0 &&
      closed(),
  );
  const lose = commitFault(last, "lose");
  const lost = await runMigrations(direct(lose.hooks));
  check(
    "createrole_lost_ack_reconciled_with_no_set_row",
    lose.hit.count === 1 &&
      JSON.stringify(lost.reconciled) === JSON.stringify([last]) &&
      lost.applied.length === 0 &&
      ledger() === through(last) &&
      morrowSetRows(id) === 0 &&
      closed(),
  );

  // AC14: a ledger row with the superseded 0005 digest is drift.
  const superseded = "e42e91b7cbb2de9c59591346212fb250aed0c8cdba6edb6bd787dcceda78de92";
  const row5 = db("SELECT sha256 FROM morrow_migrations.applied WHERE sequence=5;");
  check("createrole_ledger_holds_the_rebaselined_0005", row5 !== superseded);
  db(`UPDATE morrow_migrations.applied SET sha256='${superseded}' WHERE sequence=5;`);
  const drift = await rejection(runMigrations(direct()));
  check(
    "createrole_superseded_digest_is_ledger_drift",
    drift?.code === "MIGRATION_LEDGER_DRIFT" &&
      drift.details.reason === "digest" &&
      drift.details.sequence === 5,
  );
  db(`UPDATE morrow_migrations.applied SET sha256='${row5}' WHERE sequence=5;`);

  // The catalog check, not a REVOKE's exit status: a committed runner SET row (the
  // administrator's own grant, as a D4 transaction would make it) stops the run before
  // any entry, and the runner and the fixture count it alike.
  const asAdministrator = (text) => psqlAs(id, text, { user: "neondb_owner" });
  asAdministrator(
    "GRANT morrow_identity_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;",
  );
  const planted1 = await rejection(runMigrations(direct()));
  const counted = await (async () => {
    const c = await psqlConnector(id, { user: "neondb_owner", database: "morrow" }).connect();
    try {
      return await runnerSetRows(c);
    } finally {
      await c.close();
    }
  })();
  check(
    "createrole_planted_set_row_stops_the_run",
    planted1?.code === "MIGRATION_SET_ROW_PERSISTED" && counted === 1 && morrowSetRows(id) === 1,
  );
  asAdministrator("REVOKE morrow_identity_owner FROM neondb_owner GRANTED BY neondb_owner;");

  // A rerun through the CLI is a no-op and publishes the full head.
  const again = await run(["migrate"]);
  check(
    "createrole_rerun_is_a_no_op",
    again.code === 0 &&
      again.out[0].applied.length === 0 &&
      again.out[0].reconciled.length === 0 &&
      again.out[0].ledger === chain.length &&
      fakes.state.variables.STAGING_SCHEMA_HEAD === schemaHead(chain),
  );
  // At rest: no SET row on or by a Morrow role, the closed set holds, and the census is
  // the creation rows plus the two reviewed work memberships (P04.T01j AC04).
  check(
    "createrole_at_rest_census_is_creation_rows_and_reviewed_rows",
    morrowSetRows(id) === 0 && closed() && census().length === morrowRoles.length + 2,
  );
  const secretsSeen = [markers.ownerPassword, markers.workos, markers.turnstile, markers.kek];
  check(
    "createrole_no_marker_in_statements_or_output",
    secretsSeen.every(
      (m) =>
        connector.statements.every((s) => !s.includes(m)) &&
        ![...base.out, ...base.err].some((line) => line.includes(m)),
    ),
  );
  return { administrator: "neondb_owner", entries: chain.length, faultEntry: last };
});

for (const planted of homes) planted.cleanup();
for (const root of temporary) rmSync(root, { recursive: true, force: true });
const reportText =
  JSON.stringify(
    {
      task: "P04.T01i",
      observed_at: new Date().toISOString(),
      scope:
        "Two isolated PostgreSQL 17.11 containers (network none): the staging migration runner in superuser mode over the real chain with the hosted-shape replay, hosted-shape role provisioning with SCRAM verifiers, and the P04.T01j D4 SET-row protocol on synthetic chains; then the real chain applied by a Neon-shaped non-superuser CREATEROLE administrator with D4, hosted-shape provisioning, a kill before COMMIT, a lost acknowledgement, a superseded digest and a planted SET row (P04.T01j-AC14). Fake git and gh; no provider, credential or network.",
      ...report,
      createrole: createroleReport,
      checks,
      limitations: [
        "The Neon serverless driver, WebSocket transport, Neon's own administrator and catalog, and the GitHub and Cloudflare tools are not exercised; Phase B qualifies them under the staging card.",
      ],
    },
    null,
    2,
  ) + "\n";
for (const secret of Object.values(markers))
  if (reportText.includes(secret)) throw Error("STAGING_RUNNER_LAB_REPORT_LEAK");
writeArtifact("labs/staging-runner.json", reportText);
console.log(
  `PASS: ${checks.length} staging runner checks on isolated PostgreSQL 17; hosted Phase B pending.`,
);
