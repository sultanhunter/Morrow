import { readFileSync } from "node:fs";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import {
  appliedLegacyLoginControllerProtocol,
  createStandaloneLoginFixtureHarness,
  loginControllerProtocol,
} from "./fixtures/standalone-login-fixture.mjs";
import { standaloneSqlLiteral as lit } from "./standalone-session-fixtures.mjs";
import { localStandaloneSqlPool } from "./local-standalone-sql.mjs";
import {
  createLoginFlowCustody,
  createLoginFlowMaintenance,
  loginFlowCustodySql as sql,
} from "../packages/identity/src/login-flow-custody.ts";
import { authenticationExchangeAdmissionSql as preauthSql } from "../packages/identity/src/authentication-exchange-admission.ts";
import { runControlledPreauth } from "../packages/identity/src/login-preauth-control.ts";
import { createLoginAttempt } from "../packages/identity/src/standalone-login-protocol.ts";
import { createStandaloneWorkspaceBootstrap } from "../packages/identity/src/standalone-workspace-bootstrap.ts";
import { identitySql } from "../packages/identity/src/index.ts";
import { writeArtifact } from "./artifacts.mjs";

// P05.T01x Part A (AC01-AC04): migration 0012 on a database that already holds 0010
// configurations, flows and an admitted browser family. Synthetic owner-seeded identities
// in a fresh network-none PostgreSQL 17 container only; no provider or hosted effect.
const hash = (v) => createHash("sha256").update(v).digest("hex");
const checks = [];
const check = (name, passed) => {
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(name) || checks.some((c) => c.name === name))
    throw Error("LOGIN_PROTOCOL_LAB_CHECK_NAME");
  if (passed !== true) {
    console.error("LOGIN_PROTOCOL_LAB_FAILED_CHECK " + JSON.stringify({ check: name }));
    throw Error("LOGIN_PROTOCOL_LAB_FAILED:" + name);
  }
  checks.push({ name, passed: true });
  console.log(JSON.stringify({ check: name, passed: true }));
};
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
// The login fixture applies 0001-0012; later manifest entries are not applied here.
const appliedMigrations = manifest.migrations.slice(0, 12);
if (
  appliedMigrations.length !== 12 ||
  appliedMigrations[11].file !== "0012.login-protocol-v1.sql" ||
  appliedMigrations.some(
    (m, i) => m.sequence !== i + 1 || hash(readFileSync("migrations/" + m.file)) !== m.sha256,
  )
)
  throw Error("LOGIN_PROTOCOL_LAB_MIGRATIONS_REQUIRED");
const protocolMigration = readFileSync("migrations/0012.login-protocol-v1.sql", "utf8");
const legacy = appliedLegacyLoginControllerProtocol();
const sourcePaths = [
  "scripts/login-protocol-v1-lab.mjs",
  "scripts/local-postgres-lab.mjs",
  "scripts/local-login-flow-sql.mjs",
  "scripts/local-browser-session-sql.mjs",
  "scripts/local-standalone-sql.mjs",
  "scripts/standalone-session-fixtures.mjs",
  "scripts/fixtures/standalone-login-fixture.mjs",
  "packages/identity/src/login-flow-custody.ts",
  "packages/identity/src/executor-role-preflight.ts",
  "packages/identity/src/login-preauth-control.ts",
  "packages/identity/src/standalone-login-protocol.ts",
  "packages/identity/src/standalone-workspace-bootstrap.ts",
  "packages/identity/src/authentication-exchange-admission.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/index.ts",
  "infra/identity-role-prerequisites.sql",
  "infra/identity-login-role-prerequisites.sql",
  "infra/identity-logout-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  ...appliedMigrations.map((m) => "migrations/" + m.file),
];
const sourceHashes = Object.fromEntries(sourcePaths.map((p) => [p, hash(readFileSync(p))]));
const loginMetrics = [],
  readMetrics = [],
  secrets = [];
let container;
const observed = await localPostgresLab("P05.T01x-protocol", async (context) => {
  container = context.id;
  // Stops after 0011; login executors already hold LOGIN, as on an upgraded database.
  const h = createStandaloneLoginFixtureHarness(context, { deferProtocolV1: true }),
    count = (text) => Number(h.admin(text)),
    control = () => ({ deadlineMs: Date.now() + 5000, signal: new AbortController().signal });
  const readPools = [];
  const owned = (role) => {
    const p = h.pool(role, [...Object.values(sql), ...Object.values(preauthSql)]);
    loginMetrics.push(p.metrics);
    return p;
  };
  const custody = () =>
    createLoginFlowCustody({ pool: owned("morrow_identity_login"), now: Date.now });
  const maintain = (x) =>
    createLoginFlowMaintenance({
      pool: owned("morrow_identity_login_maintenance"),
      now: Date.now,
    }).maintain(
      JSON.stringify({ schemaVersion: 1, configurationDigest: x.configurationDigest }),
      control(),
    );
  // A psql run expected to fail: only the exit status and verbose stderr are read.
  const attempt = (statement, asOwner = true) =>
    containerCommand(
      [
        "exec",
        "--interactive",
        context.id,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "VERBOSITY=verbose",
        "-U",
        "postgres",
        "-d",
        "morrow",
      ],
      (asOwner ? "SET ROLE morrow_identity_owner;\n" : "") + statement,
      true,
    );
  const refused = (r, code, text) =>
    r.status !== 0 && r.stderr.includes(code) && r.stderr.includes(text);
  const protocolConstraints = () =>
    h.admin(
      "SELECT coalesce(string_agg(conname||'|'||convalidated||'|'||pg_get_constraintdef(oid),',' ORDER BY conname),'') FROM pg_constraint WHERE conrelid='morrow_identity.login_controller_configurations'::regclass AND conname IN ('login_controller_configurations_controller_protocol_check','login_controller_protocol_v1')",
    );
  const catalogMentions = (value) =>
    count(
      `SELECT (SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace WHERE n.nspname='morrow_identity' AND position(${lit(value)} IN pg_get_constraintdef(k.oid))>0)+(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_identity' AND position(${lit(value)} IN p.prosrc)>0)`,
    );
  const currentFunction = () =>
    h.admin(
      "SELECT p.proowner::regrole::text||'|'||coalesce(p.proacl::text,'')||'|'||p.prosecdef||'|'||p.provolatile::text||'|'||coalesce(array_to_string(p.proconfig,','),'') FROM pg_proc p WHERE p.oid='morrow_identity.login_configuration_current(text,text)'::regprocedure",
    );
  const familyState = () =>
    h.admin(
      "SELECT md5(coalesce(string_agg(to_jsonb(f)::text,',' ORDER BY f.id),'')) FROM morrow_identity.browser_session_families f",
    );
  const executes = (role) =>
    count(
      `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_identity' AND has_function_privilege(${lit(role)},p.oid,'EXECUTE')`,
    );
  const v1Constraint =
    "login_controller_protocol_v1|false|CHECK ((controller_protocol = 'morrow-login-v1'::text)) NOT VALID";
  const flowState = (v) =>
    h.admin(
      `SELECT phase||'|'||revision||'|'||(ciphertext IS NULL)||'|'||(capsule_erased_at IS NULL) FROM morrow_identity.login_flows WHERE id=${lit(v.selected.flowId)}`,
    );
  // Same tuple as the fixture's configuration digest, with a chosen protocol and origin.
  const configurationInsert = (x, protocol, origin) => {
    const redirect = origin + "/auth/workos/callback",
      digest = hash(
        JSON.stringify([
          "morrow.login.configuration",
          "1",
          protocol,
          origin,
          "development",
          x.bindingId,
          "1",
          x.f.environment,
          x.f.application,
          x.f.client,
          redirect,
          "/",
          x.f.profile,
          "1",
          hash(x.verificationProfileJson),
        ]),
      );
    return {
      digest,
      text: `INSERT INTO morrow_identity.login_controller_configurations VALUES(${lit(digest)},${lit(protocol)},${lit(origin)},'development',${lit(x.bindingId)},1,${lit(x.f.environment)},${lit(x.f.application)},${lit(x.f.client)},${lit(redirect)},'/',${lit(x.f.profile)},1,${lit(x.f.issuer)},1,${lit(hash(x.f.profileJson))});`,
    };
  };
  const ageFlow = (v, interval) =>
    context.sql(
      `ALTER TABLE morrow_identity.login_flows DISABLE TRIGGER USER;UPDATE morrow_identity.login_flows SET created_at=t.at-${interval}-interval '300 seconds',expires_at=t.at-${interval} FROM (SELECT clock_timestamp() AS at) t WHERE id=${lit(v.selected.flowId)};ALTER TABLE morrow_identity.login_flows ENABLE TRIGGER USER;`,
      "morrow",
    );
  async function intent(x) {
    const selected = {
      schemaVersion: 1,
      configurationDigest: x.configurationDigest,
      flowId: randomUUID(),
      beginCommandId: randomUUID(),
      admissionCommandId: randomUUID(),
      issuerCommandId: randomUUID(),
      workspaceId: x.f.workspace,
    };
    const service = custody(),
      created = await service.createIntent(JSON.stringify(selected), control());
    return { x, selected, service, created };
  }
  async function begun(v) {
    const a = createLoginAttempt(Date.now, new AbortController().signal, 5000);
    try {
      const begin = await runControlledPreauth(
        owned("morrow_identity_preauth"),
        v.x.authenticationBindingJson,
        a,
        (s) => s.begin(JSON.stringify({ commandId: v.selected.beginCommandId })),
      );
      secrets.push(begin.state, begin.browserProof, begin.verifier);
      return begin;
    } finally {
      a.end();
    }
  }
  function bindInput(v, begin) {
    const key = randomUUID(),
      state = hash(begin.state),
      cookie = hash(randomBytes(32)),
      browser = hash(begin.browserProof),
      verifier = hash(begin.verifier);
    const aad = hash(
      JSON.stringify([
        "morrow.login.capsule",
        "1",
        v.x.configurationDigest,
        v.selected.flowId,
        begin.challengeId,
        v.selected.beginCommandId,
        v.selected.admissionCommandId,
        v.selected.issuerCommandId,
        v.x.f.workspace,
        v.created.expires_at_ms,
        state,
        cookie,
        browser,
        verifier,
        key,
      ]),
    );
    return {
      bind: {
        schemaVersion: 1,
        configurationDigest: v.x.configurationDigest,
        flowId: v.selected.flowId,
        expectedRevision: "1",
        challengeId: begin.challengeId,
        stateDigest: state,
        cookieDigest: cookie,
        browserProofDigest: browser,
        verifierDigest: verifier,
        ciphertext: randomBytes(48).toString("base64url"),
        encryptionNonce: randomBytes(12).toString("base64url"),
        keyId: key,
        aadDigest: aad,
      },
      claim: {
        schemaVersion: 1,
        configurationDigest: v.x.configurationDigest,
        cookieDigest: cookie,
        stateDigest: state,
        codeDigest: hash(randomBytes(32)),
      },
    };
  }
  async function ready(x) {
    const v = await intent(x);
    if (v.created.outcome !== "newly_created") throw Error("LOGIN_PROTOCOL_LAB_SEED_INTENT");
    const input = bindInput(v, await begun(v));
    const bound = await v.service.bindBegin(JSON.stringify(input.bind), control());
    return { ...v, ...input, bound };
  }
  const reconcile = (v) =>
    v.service.reconcile(
      JSON.stringify({
        schemaVersion: 1,
        configurationDigest: v.x.configurationDigest,
        flowId: v.selected.flowId,
        beginCommandId: v.selected.beginCommandId,
        admissionCommandId: v.selected.admissionCommandId,
        issuerCommandId: v.selected.issuerCommandId,
      }),
      control(),
    );
  const eligibility = (v) =>
    v.service.observeEligibility(
      JSON.stringify({
        schemaVersion: 1,
        flowId: v.selected.flowId,
        configurationDigest: v.x.configurationDigest,
      }),
      control(),
    );
  const bootstrapOrigin = "http://127.0.0.1:4443";
  async function bootstrap(workspace, secret) {
    const pool = localStandaloneSqlPool(context.id, "morrow_api", Object.values(identitySql));
    readPools.push(pool);
    readMetrics.push(pool.metrics);
    const service = createStandaloneWorkspaceBootstrap({
      configurationJson: JSON.stringify({
        schemaVersion: 1,
        mode: "loopback_qualification",
        origin: bootstrapOrigin,
      }),
      pool,
      now: Date.now,
    });
    const response = await service.fetch(
      new Request(`${bootstrapOrigin}/workspace/${workspace}/bootstrap`, {
        headers: { Cookie: "__Host-morrow_session=" + secret },
      }),
    );
    return { status: response.status, body: await response.json() };
  }
  try {
    // State held before 0012: legacy configuration, flows in every phase, one family.
    check("legacy_protocol_read_from_applied_0010", legacy !== loginControllerProtocol);
    const constraintsBefore = protocolConstraints();
    check(
      "legacy_constraint_present_before_0012",
      constraintsBefore ===
        `login_controller_configurations_controller_protocol_check|true|CHECK ((controller_protocol = '${legacy}'::text))`,
    );
    check("catalog_probe_sees_legacy_before_0012", catalogMentions(legacy) === 1);
    const functionBefore = currentFunction();
    const x = h.configured();
    check("legacy_configuration_seeded", x.controllerProtocol === legacy);
    const intentFlow = await intent(x);
    check("legacy_intent_seeded", intentFlow.created.outcome === "newly_created");
    const awaitingFlow = await ready(x);
    check("legacy_awaiting_callback_seeded", awaitingFlow.bound.outcome === "newly_ready");
    const claimedFlow = await ready(x);
    check(
      "legacy_claimed_seeded",
      claimedFlow.bound.outcome === "newly_ready" &&
        (await claimedFlow.service.claimCallback(JSON.stringify(claimedFlow.claim), control()))
          .outcome === "newly_claimed",
    );
    const member = h.fixture();
    const admitted = await h.admitted(member);
    check(
      "family_admitted_before_0012",
      admitted.result.outcome === "newly_admitted" && admitted.result.credential !== null,
    );
    const secret = admitted.result.credential.secret;
    const before = await bootstrap(member.workspace, secret);
    check(
      "family_bootstraps_before_0012",
      before.status === 200 && before.body.workspace?.id === member.workspace,
    );
    const familiesBefore = familyState(),
      loginExecutesBefore = executes("morrow_identity_login"),
      maintenanceExecutesBefore = executes("morrow_identity_login_maintenance");

    // AC01: prerequisites refuse before any change; then 0012 commits as the owner.
    check(
      "non_owner_application_refused",
      refused(attempt(protocolMigration, false), "P0001", "LOGIN_PROTOCOL_PREREQUISITES_INVALID"),
    );
    context.sql("ALTER ROLE morrow_identity_login INHERIT;", "morrow");
    const inheriting = attempt(protocolMigration);
    context.sql("ALTER ROLE morrow_identity_login NOINHERIT;", "morrow");
    check(
      "inheriting_login_executor_refused",
      refused(inheriting, "P0001", "LOGIN_PROTOCOL_PREREQUISITES_INVALID"),
    );
    check("refused_applications_change_nothing", protocolConstraints() === constraintsBefore);
    h.applyProtocolV1();
    // Committed: the 0010 column constraint is gone and the v1 constraint exists.
    check("migration_0012_commits_as_owner", protocolConstraints() === v1Constraint);
    check(
      "migration_0012_reapplication_refused",
      refused(attempt(protocolMigration), "P0001", "LOGIN_PROTOCOL_PREREQUISITES_INVALID"),
    );
    check(
      "applied_migrations_0001_0011_unchanged",
      appliedMigrations
        .slice(0, 11)
        .every((m) => hash(readFileSync("migrations/" + m.file)) === m.sha256),
    );
    // AC03 (catalog half): no constraint or function body names the retired protocol.
    check("catalog_has_no_legacy_protocol", catalogMentions(legacy) === 0);
    check(
      "current_function_requires_v1",
      count(
        "SELECT count(*) FROM pg_proc WHERE oid='morrow_identity.login_configuration_current(text,text)'::regprocedure AND position('''morrow-login-v1''' IN prosrc)>0",
      ) === 1,
    );
    check("current_function_owner_acl_and_settings_kept", currentFunction() === functionBefore);
    check(
      "executor_privileges_unchanged",
      executes("morrow_identity_login") === loginExecutesBefore &&
        executes("morrow_identity_login_maintenance") === maintenanceExecutesBefore,
    );

    // AC02: legacy rows stay readable and immutable, and every legacy flow fails closed.
    check(
      "legacy_rows_readable",
      count(
        `SELECT count(*) FROM morrow_identity.login_controller_configurations WHERE configuration_digest=${lit(x.configurationDigest)} AND controller_protocol=${lit(legacy)}`,
      ) === 1 &&
        flowState(intentFlow) === "intent|1|true|true" &&
        flowState(awaitingFlow) === "awaiting_callback|2|false|true" &&
        flowState(claimedFlow) === "claimed|3|true|false",
    );
    check(
      "legacy_configuration_immutable",
      refused(
        attempt(
          `UPDATE morrow_identity.login_controller_configurations SET retention_tier='staging' WHERE configuration_digest=${lit(x.configurationDigest)}`,
        ),
        "P0001",
        "LOGIN_RECORD_IMMUTABLE",
      ) &&
        refused(
          attempt(
            `DELETE FROM morrow_identity.login_controller_configurations WHERE configuration_digest=${lit(x.configurationDigest)}`,
          ),
          "P0001",
          "LOGIN_RECORD_IMMUTABLE",
        ),
    );
    const legacyFlows = [intentFlow, awaitingFlow, claimedFlow],
      legacyFlowStates = legacyFlows.map(flowState).join(",");
    check(
      "legacy_flows_immutable",
      legacyFlows.every(
        (v) =>
          refused(
            attempt(
              `UPDATE morrow_identity.login_flows SET revision=revision+1 WHERE id=${lit(v.selected.flowId)}`,
            ),
            "P0001",
            "LOGIN_RECORD_IMMUTABLE",
          ) &&
          refused(
            attempt(`DELETE FROM morrow_identity.login_flows WHERE id=${lit(v.selected.flowId)}`),
            "P0001",
            "LOGIN_RECORD_IMMUTABLE",
          ),
      ) &&
        refused(
          attempt("TRUNCATE morrow_identity.login_flows"),
          "P0001",
          "LOGIN_RECORD_IMMUTABLE",
        ) &&
        legacyFlows.map(flowState).join(",") === legacyFlowStates,
    );
    const flowsBefore = count("SELECT count(*) FROM morrow_identity.login_flows");
    check(
      "legacy_intent_creation_denied",
      (await intent(x)).created.outcome === "denied" &&
        count("SELECT count(*) FROM morrow_identity.login_flows") === flowsBefore,
    );
    const legacyBind = bindInput(intentFlow, await begun(intentFlow));
    check(
      "legacy_bind_denied",
      (await intentFlow.service.bindBegin(JSON.stringify(legacyBind.bind), control())).outcome ===
        "denied" && flowState(intentFlow) === "intent|1|true|true",
    );
    check(
      "legacy_claim_denied",
      (await awaitingFlow.service.claimCallback(JSON.stringify(awaitingFlow.claim), control()))
        .outcome === "denied" && flowState(awaitingFlow) === "awaiting_callback|2|false|true",
    );
    check("legacy_claimed_flow_ineligible", (await eligibility(claimedFlow)).matches === false);
    const reconciled = await Promise.all(
      [intentFlow, awaitingFlow, claimedFlow].map((v) => reconcile(v)),
    );
    check(
      "legacy_flows_still_reconciled",
      reconciled.every((r) => r.outcome === "observed") &&
        reconciled.map((r) => r.phase).join(",") === "intent,awaiting_callback,claimed",
    );
    ageFlow(intentFlow, "interval '8 days'");
    ageFlow(awaitingFlow, "interval '1 second'");
    const swept = await maintain(x);
    check(
      "legacy_flows_still_erased_and_pruned",
      swept.outcome === "completed" &&
        swept.erased_capsules === "2" &&
        swept.pruned_closed_states === "1" &&
        swept.retained_unresolved === "1" &&
        count(
          `SELECT count(*) FROM morrow_identity.login_flows WHERE id=${lit(intentFlow.selected.flowId)}`,
        ) === 0 &&
        flowState(awaitingFlow) === "awaiting_callback|3|true|false",
    );
    const legacyInsert = configurationInsert(x, legacy, "https://localhost:4444");
    check(
      "new_legacy_configuration_fails_check",
      refused(attempt(legacyInsert.text), "23514", "login_controller_protocol_v1") &&
        count(
          `SELECT count(*) FROM morrow_identity.login_controller_configurations WHERE configuration_digest=${lit(legacyInsert.digest)}`,
        ) === 0,
    );
    const currentInsert = configurationInsert(x, loginControllerProtocol, "https://localhost:4445");
    h.admin(currentInsert.text);
    check(
      "new_v1_configuration_inserts",
      count(
        `SELECT count(*) FROM morrow_identity.login_controller_configurations WHERE configuration_digest=${lit(currentInsert.digest)} AND controller_protocol='morrow-login-v1'`,
      ) === 1,
    );

    // AC04: the family admitted before 0012 still bootstraps; a v1 flow completes.
    const after = await bootstrap(member.workspace, secret);
    check(
      "family_admitted_before_0012_still_bootstraps",
      after.status === 200 && JSON.stringify(after.body) === JSON.stringify(before.body),
    );
    check("family_records_untouched_by_0012", familyState() === familiesBefore);
    const y = h.configured();
    check("v1_configuration_seeded", y.controllerProtocol === loginControllerProtocol);
    const current = await ready(y);
    check(
      "v1_flow_binds",
      current.created.outcome === "newly_created" && current.bound.outcome === "newly_ready",
    );
    check(
      "v1_flow_claims",
      (await current.service.claimCallback(JSON.stringify(current.claim), control())).outcome ===
        "newly_claimed",
    );
    check("v1_claimed_flow_eligible", (await eligibility(current)).matches === true);
    check("v1_constraint_not_valid_and_never_validated", protocolConstraints() === v1Constraint);
    check(
      "no_secret_in_sql_observations",
      [...h.rolePools, ...readPools].every((p) => {
        const text = JSON.stringify(p.observed);
        return [...secrets, secret].every((s) => !text.includes(s));
      }),
    );
    return { version: context.version, image: context.image };
  } finally {
    const closed = await Promise.allSettled([h.close(), ...readPools.map((p) => p.close())]);
    if (closed.some((r) => r.status === "rejected"))
      throw Error("LOGIN_PROTOCOL_LAB_CLEANUP_UNVERIFIED");
  }
});
check(
  "all_source_bytes_stable",
  sourcePaths.every((p) => sourceHashes[p] === hash(readFileSync(p))),
);
check(
  "disposable_clients_physically_closed",
  [...loginMetrics, ...readMetrics].every(
    (m) =>
      m.connections === m.closed &&
      m.connections === m.backendCleanupVerified &&
      m.unverifiedHostClosures === 0,
  ),
);
const absent = containerCommand(["inspect", container], undefined, true).status !== 0;
check("owned_container_absent", absent);
const report = {
  schema_version: 1,
  packet: "P05.T01x",
  part: "A",
  acceptance: ["P05.T01x-AC01", "P05.T01x-AC02", "P05.T01x-AC03", "P05.T01x-AC04"],
  migrations: appliedMigrations.map((m) => ({ sequence: m.sequence, sha256: m.sha256 })),
  source_hashes: sourceHashes,
  checks,
  checks_passed: checks.length,
  login_cleanup: loginMetrics,
  read_cleanup: readMetrics,
  container_absent: absent,
  engine: observed,
  provider_requests: 0,
  limitations: [
    "Synthetic owner-seeded identities in a fresh local container only; no hosted migration, provider or merchant effect.",
    "The retired protocol value is read from the applied 0010 bytes; the HTTP login and logout journeys on the v1 protocol are covered by the existing login and logout laboratories.",
    "The application-name pattern is asserted at every startup by the PG-wire oracle of the Workers laboratories; its real PostgreSQL observation is in the PG-wire laboratories, which run on Linux CI only.",
  ],
};
writeArtifact("labs/login-protocol-v1.json", JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    packet: report.packet,
    checks: checks.length,
    passed: true,
    provider_requests: 0,
    container_absent: absent,
  }),
);
