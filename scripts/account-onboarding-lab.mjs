import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { createStandaloneLoginFixtureHarness } from "./fixtures/standalone-login-fixture.mjs";
import { standaloneSqlLiteral as lit } from "./standalone-session-fixtures.mjs";
import { localStandaloneSqlPool } from "./local-standalone-sql.mjs";
import { localBrowserSessionPool } from "./local-browser-session-sql.mjs";
import { localIdentityPool } from "./local-identity-sql.mjs";
import { localLifecyclePool } from "./local-lifecycle-sql.mjs";
import {
  createLoginFlowCustody,
  loginFlowCustodySql as loginSql,
} from "../packages/identity/src/login-flow-custody.ts";
import { authenticationExchangeAdmissionSql as preauthSql } from "../packages/identity/src/authentication-exchange-admission.ts";
import { runControlledPreauth } from "../packages/identity/src/login-preauth-control.ts";
import { createLoginAttempt } from "../packages/identity/src/standalone-login-protocol.ts";
import { createStandaloneWorkspaceBootstrap } from "../packages/identity/src/standalone-workspace-bootstrap.ts";
import { identitySql } from "../packages/identity/src/index.ts";
import {
  browserSessionAdmissionSql as sessionSql,
  createWorkosAccountAdmission,
} from "../packages/identity/src/workos-browser-session-admission.ts";
import { createWorkosAuthenticationEvidence } from "../packages/identity/src/workos-authentication-evidence.ts";
import {
  accountOnboardingSql,
  accountOverviewSql,
  executeAccountOverview,
  executeFirstOrganization,
} from "../packages/identity/src/account-onboarding.ts";
import { createWorkspaceAccessRevocations } from "../packages/identity/src/workspace-access-revocation.ts";
import { createWorkspacePermissionBoundary } from "../packages/policy/src/index.ts";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import { buildWorkosAuthenticationEvidenceFixture } from "../tests/fixtures/workos-authentication-evidence.mjs";
import {
  acceptedNames,
  invalidNames,
  sqlOnlyInvalidNames,
  typescriptOnlyInvalidNames,
} from "../tests/fixtures/account-display-names.mjs";
import { writeArtifact } from "./artifacts.mjs";

// P05.T01x Part B (ADR-0009): migration 0013, account admission and enrollment,
// first-owner signup, the workspace list and their privileges, on real PostgreSQL 17.
// Synthetic identities in a fresh network-none container only; no provider effect.
const hash = (v) => createHash("sha256").update(v).digest("hex");
const checks = [];
// `observed` is printed only when the check fails: closed values (SQLSTATEs, outcomes, counts)
// that say which condition failed. It is withheld if it contains a lab secret.
const check = (name, passed, observed) => {
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(name) || checks.some((c) => c.name === name))
    throw Error("ACCOUNT_ONBOARDING_LAB_CHECK_NAME:" + name);
  if (passed !== true) {
    const text = observed === undefined ? undefined : JSON.stringify(observed);
    console.error(
      "ACCOUNT_ONBOARDING_LAB_FAILED_CHECK " +
        JSON.stringify({
          check: name,
          ...(text === undefined
            ? {}
            : { observed: secrets.some((s) => text.includes(s)) ? "withheld" : observed }),
        }),
    );
    throw Error("ACCOUNT_ONBOARDING_LAB_FAILED:" + name);
  }
  checks.push({ name, passed: true });
  console.log(JSON.stringify({ check: name, passed: true }));
};
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
// 0001-0013 exactly; later manifest entries are not applied here.
const appliedMigrations = manifest.migrations.slice(0, 13);
if (
  appliedMigrations.length !== 13 ||
  appliedMigrations[12].file !== "0013.account-onboarding.sql" ||
  appliedMigrations.some(
    (m, i) => m.sequence !== i + 1 || hash(readFileSync("migrations/" + m.file)) !== m.sha256,
  )
)
  throw Error("ACCOUNT_ONBOARDING_LAB_MIGRATIONS_REQUIRED");
const onboardingMigration = readFileSync("migrations/0013.account-onboarding.sql", "utf8");
const catalogue = JSON.parse(readFileSync("docs/contracts/capabilities.json", "utf8"));
const sourcePaths = [
  "scripts/account-onboarding-lab.mjs",
  "tests/fixtures/account-display-names.mjs",
  "scripts/local-postgres-lab.mjs",
  "scripts/local-standalone-sql.mjs",
  "scripts/local-browser-session-sql.mjs",
  "scripts/local-identity-sql.mjs",
  "scripts/local-lifecycle-sql.mjs",
  "scripts/local-login-flow-sql.mjs",
  "scripts/standalone-session-fixtures.mjs",
  "scripts/fixtures/standalone-login-fixture.mjs",
  "packages/identity/src/account-onboarding.ts",
  "packages/identity/src/executor-role-preflight.ts",
  "packages/identity/src/fixed-sql-transaction.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/login-flow-custody.ts",
  "packages/identity/src/standalone-request-guard.ts",
  "packages/identity/src/index.ts",
  "packages/policy/src/index.ts",
  "infra/identity-role-prerequisites.sql",
  "infra/identity-login-role-prerequisites.sql",
  "infra/identity-logout-role-prerequisites.sql",
  "infra/identity-onboarding-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  ...appliedMigrations.map((m) => "migrations/" + m.file),
];
const sourceHashes = Object.fromEntries(sourcePaths.map((p) => [p, hash(readFileSync(p))]));
const wid = (prefix, n) => prefix + "_" + String(n).padStart(26, "0");
const metrics = [];
const secrets = [];
let container, primaryFailure;

// A long-lived raw psql connection for deliberate interleavings. Only fixed lab SQL.
function sqlConnection(id, role = "postgres") {
  const child = spawn(
    "docker",
    ["exec", "--interactive", id, "psql", "-X", "-qAt", "-U", role, "-d", "morrow"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "",
    pending = null,
    closed = false;
  const ended = new Promise((resolve) =>
    child.on("close", () => {
      closed = true;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(Error("ACCOUNT_LAB_CONNECTION_CLOSED"));
        pending = null;
      }
      resolve();
    }),
  );
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  // Drained, never read: stderr is a separate pipe with no ordering against the stdout
  // marker. Outcomes are read in-band on stdout (see waitBehind below).
  child.stderr.resume();
  child.stdout.on("data", (c) => {
    buffer += c;
    while (buffer.includes("\n")) {
      const i = buffer.indexOf("\n"),
        line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!pending) continue;
      if (line === pending.marker) {
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        p.resolve(p.lines.join("\n"));
      } else if (line) pending.lines.push(line);
    }
  });
  return {
    async query(text) {
      if (closed || pending) throw Error("ACCOUNT_LAB_CONNECTION_PROTOCOL");
      const marker = "ACCOUNT_LAB_" + randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error("ACCOUNT_LAB_CONNECTION_TIMEOUT"));
        }, 15000);
        pending = { marker, timer, resolve, reject, lines: [] };
        child.stdin.write(text + "\n\\echo " + marker + "\n");
      });
    },
    async close() {
      child.stdin.end();
      let timer;
      await Promise.race([
        ended,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 3000);
        }),
      ]);
      clearTimeout(timer);
      await ended;
    },
  };
}

const observed = await localPostgresLab("P05.T01x-account", async (context) => {
  container = context.id;
  // 0001-0012 first; 0013 is applied below after its prerequisite failures.
  const h = createStandaloneLoginFixtureHarness(context);
  const admin = h.admin,
    count = (text) => Number(admin(text)),
    rows = (table, where = "true") =>
      count(`SELECT count(*) FROM morrow_identity.${table} WHERE ${where}`);
  // A psql run whose failure is expected: only the exit status and verbose stderr are
  // read. A longer bound than the shared helper's keeps a loaded host from turning an
  // expected refusal into a timeout.
  const psql = (statement, role = "postgres", database = "morrow", owner = false) =>
    spawnSync(
      "docker",
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
        role,
        "-d",
        database,
      ],
      {
        encoding: "utf8",
        input: (owner ? "SET ROLE morrow_identity_owner;\n" : "") + statement,
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  const refused = (r, text) => r.status !== 0 && r.stderr.includes(text);
  const pools = [];
  const control = () => ({ deadlineMs: Date.now() + 5000, signal: new AbortController().signal });
  try {
    // ---------------------------------------------------------------- AC05
    const tablesAbsent = (database = "morrow") =>
      psql(
        "SELECT to_regclass('morrow_identity.account_enrollments') IS NULL AND to_regclass('morrow_identity.self_service_revisions') IS NULL AND to_regprocedure('morrow_identity.reconcile_workspace_login_flow(text,text,text,text,text)') IS NULL;",
        "postgres",
        database,
      ).stdout.trim() === "t";
    const apply0013 = (database = "morrow") =>
      psql(onboardingMigration, "postgres", database, true);
    check(
      "ac05_missing_role_raises_and_creates_nothing",
      refused(apply0013(), "ACCOUNT_ONBOARDING_PREREQUISITES_INVALID") && tablesAbsent(),
    );
    context.sql(readFileSync("infra/identity-onboarding-role-prerequisites.sql", "utf8"), "morrow");
    context.sql("ALTER ROLE morrow_identity_onboarding LOGIN;", "morrow");
    check(
      "ac05_login_role_raises_and_creates_nothing",
      refused(apply0013(), "ACCOUNT_ONBOARDING_PREREQUISITES_INVALID") && tablesAbsent(),
    );
    context.sql("ALTER ROLE morrow_identity_onboarding NOLOGIN;", "morrow");
    context.sql("CREATE ROLE onboarding_bridge NOLOGIN;", "morrow");
    for (const [name, grant, revoke] of [
      [
        "member_of_other_role",
        "GRANT onboarding_bridge TO morrow_identity_onboarding;",
        "REVOKE onboarding_bridge FROM morrow_identity_onboarding;",
      ],
      [
        "has_member",
        "GRANT morrow_identity_onboarding TO onboarding_bridge;",
        "REVOKE morrow_identity_onboarding FROM onboarding_bridge;",
      ],
    ]) {
      context.sql(grant, "morrow");
      check(
        "ac05_role_" + name + "_raises_and_creates_nothing",
        refused(apply0013(), "ACCOUNT_ONBOARDING_PREREQUISITES_INVALID") && tablesAbsent(),
      );
      context.sql(revoke, "morrow");
    }
    context.sql("DROP ROLE onboarding_bridge;", "morrow");
    // A non-UTF8 database with 0001-0012 applied. Executors are NOLOGIN while the earlier
    // migrations' own prerequisites run there, then restored.
    const loginRoles = context
      .sql(
        "SELECT string_agg(rolname,',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'morrow\\_%' AND rolcanlogin;",
        "morrow",
      )
      .split(",")
      .filter(Boolean);
    for (const role of loginRoles) context.sql(`ALTER ROLE ${role} NOLOGIN;`, "morrow");
    context.sql(
      "CREATE DATABASE morrow_ascii ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0; GRANT CREATE ON DATABASE morrow_ascii TO morrow_identity_owner;",
    );
    for (const m of appliedMigrations.slice(0, 12))
      context.sql(
        "SET ROLE morrow_identity_owner;\n" + readFileSync("migrations/" + m.file, "utf8"),
        "morrow_ascii",
      );
    check(
      "ac05_non_utf8_database_raises_and_creates_nothing",
      refused(apply0013("morrow_ascii"), "ACCOUNT_ONBOARDING_PREREQUISITES_INVALID") &&
        tablesAbsent("morrow_ascii"),
    );
    for (const role of loginRoles) context.sql(`ALTER ROLE ${role} LOGIN;`, "morrow");

    // State held across the cutover: a v1 configuration with a workspace flow in flight.
    const custody = () =>
      createLoginFlowCustody({
        pool: (() => {
          const p = h.pool("morrow_identity_login", [
            ...Object.values(loginSql),
            ...Object.values(preauthSql),
          ]);
          metrics.push(p.metrics);
          return p;
        })(),
        now: Date.now,
      });
    const preauthPool = () => {
      const p = h.pool("morrow_identity_preauth", [
        ...Object.values(loginSql),
        ...Object.values(preauthSql),
      ]);
      metrics.push(p.metrics);
      return p;
    };
    const begun = async (x, beginCommandId) => {
      const a = createLoginAttempt(Date.now, new AbortController().signal, 5000);
      try {
        const material = await runControlledPreauth(
          preauthPool(),
          x.authenticationBindingJson,
          a,
          (s) => s.begin(JSON.stringify({ commandId: beginCommandId })),
        );
        secrets.push(material.state, material.browserProof, material.verifier);
        return material;
      } finally {
        a.end();
      }
    };
    // Intent, preauth begin and bind. `workspace` is null for an account flow.
    async function readyFlow(x, workspace) {
      const selected = {
        schemaVersion: 1,
        configurationDigest: x.configurationDigest,
        flowId: randomUUID(),
        beginCommandId: randomUUID(),
        admissionCommandId: randomUUID(),
        issuerCommandId: randomUUID(),
        ...(workspace === null ? {} : { workspaceId: workspace }),
      };
      const service = custody();
      const created =
        workspace === null
          ? await service.createAccountIntent(JSON.stringify(selected), control())
          : await service.createIntent(JSON.stringify(selected), control());
      if (created.outcome !== "newly_created") return { created, selected, service, x };
      const begin = await begun(x, selected.beginCommandId);
      const key = randomUUID(),
        state = hash(begin.state),
        cookie = hash(randomBytes(32)),
        browser = hash(begin.browserProof),
        verifier = hash(begin.verifier);
      const aad = hash(
        JSON.stringify([
          "morrow.login.capsule",
          "1",
          x.configurationDigest,
          selected.flowId,
          begin.challengeId,
          selected.beginCommandId,
          selected.admissionCommandId,
          selected.issuerCommandId,
          workspace,
          created.expires_at_ms,
          state,
          cookie,
          browser,
          verifier,
          key,
        ]),
      );
      const bind = {
        schemaVersion: 1,
        configurationDigest: x.configurationDigest,
        flowId: selected.flowId,
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
      };
      const bound = await service.bindBegin(JSON.stringify(bind), control());
      const code = "synthetic-code-" + randomUUID();
      return {
        x,
        selected,
        service,
        created,
        begin,
        bound,
        code,
        claim: {
          schemaVersion: 1,
          configurationDigest: x.configurationDigest,
          cookieDigest: cookie,
          stateDigest: state,
          codeDigest: hash(code),
        },
      };
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
    const reserve = async (v) => {
      const a = createLoginAttempt(Date.now, new AbortController().signal, 5000);
      try {
        return await runControlledPreauth(preauthPool(), v.x.authenticationBindingJson, a, (s) =>
          s.admit(
            JSON.stringify({
              commandId: v.selected.admissionCommandId,
              challengeId: v.begin.challengeId,
              state: v.begin.state,
              browserProof: v.begin.browserProof,
              verifier: v.begin.verifier,
              code: v.code,
            }),
          ),
        );
      } finally {
        a.end();
      }
    };
    const base = h.configured();
    const inFlight = await readyFlow(base, base.f.workspace);
    check(
      "workspace_flow_in_flight_before_0013",
      inFlight.created.outcome === "newly_created" && inFlight.bound.outcome === "newly_ready",
    );
    const beforeWorkspaceReconcile = await reconcile(inFlight);

    // Apply 0013 as the owner, with the onboarding executor NOLOGIN, then enable it.
    const applied = apply0013();
    check("ac05_migration_0013_commits_on_0001_0012", applied.status === 0);
    context.sql(
      "ALTER ROLE morrow_identity_onboarding LOGIN; ALTER ROLE morrow_identity_lifecycle LOGIN;",
      "morrow",
    );
    check(
      "ac05_applied_bytes_unchanged",
      appliedMigrations.every((m) => hash(readFileSync("migrations/" + m.file)) === m.sha256),
    );

    // ---------------------------------------------------------------- AC06/AC07
    check(
      "ac06_login_role_denied_legacy_intent",
      refused(
        psql(
          `SELECT * FROM morrow_identity.create_login_flow_intent(${lit(base.configurationDigest)},${lit(randomUUID())},${lit(randomUUID())},${lit(randomUUID())},${lit(randomUUID())},${lit(base.f.workspace)});`,
          "morrow_identity_login",
        ),
        "42501",
      ),
    );
    check(
      "ac06_workspace_flow_in_flight_claim_denied",
      (await inFlight.service.claimCallback(JSON.stringify(inFlight.claim), control())).outcome ===
        "denied",
    );
    const afterWorkspaceReconcile = await reconcile(inFlight);
    check(
      "ac07_workspace_flow_reconcile_unchanged",
      JSON.stringify(afterWorkspaceReconcile) === JSON.stringify(beforeWorkspaceReconcile) &&
        afterWorkspaceReconcile.outcome === "observed",
    );
    const accountFlow = await readyFlow(base, null);
    check(
      "ac06_account_intent_and_null_aad_bind",
      accountFlow.created.outcome === "newly_created" &&
        accountFlow.bound.outcome === "newly_ready" &&
        rows("login_flows", `id=${lit(accountFlow.selected.flowId)} AND workspace_id IS NULL`) ===
          1,
    );
    let workspaceIntentRefused = false;
    try {
      await readyFlow(base, base.f.workspace);
    } catch {
      workspaceIntentRefused = true;
    }
    check("ac06_workspace_intent_no_longer_created", workspaceIntentRefused);

    // Evidence and account admission helpers.
    let subjectSerial = 0;
    const freshSubject = () => {
      subjectSerial++;
      return {
        subject: "user_9" + String(subjectSerial).padStart(25, "0"),
        sid: "session_9" + String(subjectSerial).padStart(25, "0"),
      };
    };
    async function evidence(profileJson, subject, sid, options = {}) {
      const at = Date.now(),
        fx = buildWorkosAuthenticationEvidenceFixture({
          profile: JSON.parse(profileJson),
          claims: {
            sub: subject,
            sid,
            iat: Math.floor(at / 1000) - 1,
            exp: Math.floor(at / 1000) + 120,
            ...options.claims,
          },
          snapshot: { observedAtMs: at - 1, expiresAtMs: at + 299000 },
        });
      const owner = createWorkosAuthenticationEvidence(fx.profileJson, fx.snapshotJson, {
        now: Date.now,
        currentProfile: () => fx.profileJson,
        readPage: async () =>
          fx.page([
            fx.session({
              created_at: new Date(at - 60000).toISOString(),
              updated_at: new Date(at - 1000).toISOString(),
              expires_at: new Date(at + 60000).toISOString(),
            }),
          ]),
      });
      secrets.push(fx.token);
      const verified = await owner.verify(fx.token);
      if (verified.outcome !== "verified_active_evidence") throw Error("ACCOUNT_LAB_EVIDENCE");
      return { owner, handle: verified.handle, evidence: owner.readEvidence(verified.handle) };
    }
    async function admit(profile, who, options = {}) {
      const e = await evidence(profile.f.profileJson, who.subject, who.sid, options);
      const pool = localBrowserSessionPool(context.id, options.pool);
      pools.push(pool);
      metrics.push(pool.metrics);
      const service = createWorkosAccountAdmission({
        pool,
        readEvidence: e.owner.readEvidence,
        now: Date.now,
      });
      const commandId = options.commandId ?? randomUUID();
      const result = await service.admit(
        e.handle,
        JSON.stringify({
          schemaVersion: 1,
          commandId,
          profileId: profile.f.profile,
          profileRecordRevision: options.profileRecordRevision ?? 1,
        }),
      );
      if (result.credential) secrets.push(result.credential.secret);
      return {
        result,
        commandId,
        secret: result.credential?.secret ?? null,
        digest: result.credential ? hash(result.credential.secret) : null,
        service,
      };
    }
    const reason = (commandId) =>
      admin(
        `SELECT a.reason FROM morrow_identity.browser_session_audits a WHERE a.command_id=${lit(commandId)};`,
      );
    const commandRow = (commandId) =>
      admin(
        `SELECT outcome||'|'||coalesce(enrollment,'') FROM morrow_identity.account_session_commands WHERE command_id=${lit(commandId)};`,
      );
    const revise = (profileId, enrollment, signup) =>
      admin(
        `INSERT INTO morrow_identity.self_service_revisions(profile_id,revision,enrollment,organization_signup,reason,approval_ref) SELECT ${lit(profileId)},coalesce(max(revision),0)+1,${lit(enrollment)},${lit(signup)},'Synthetic laboratory switch','approval_lab_1' FROM morrow_identity.self_service_revisions WHERE profile_id=${lit(profileId)};`,
      );
    const principalOf = (subject) =>
      admin(
        `SELECT principal_id FROM morrow_identity.provider_subject_mappings WHERE subject_id=${lit(subject)};`,
      );

    // AC07: account flow reconciliation (admitted and denied), and a held collision.
    const enabled = h.configured();
    revise(enabled.f.profile, "enabled", "enabled");
    async function claimedAccountFlow(x) {
      const v = await readyFlow(x, null);
      const claimed = await v.service.claimCallback(JSON.stringify(v.claim), control());
      const reservation = await reserve(v);
      return { ...v, claimed, reservation };
    }
    const flowA = await claimedAccountFlow(enabled);
    check(
      "ac07_account_flow_claimed_with_null_workspace",
      flowA.claimed.outcome === "newly_claimed" &&
        flowA.claimed.workspace_id === null &&
        flowA.reservation.outcome === "newly_reserved",
    );
    const admittedA = await admit(enabled, freshSubject(), {
      commandId: flowA.selected.issuerCommandId,
    });
    const recA = await reconcile(flowA);
    check(
      "ac07_reconcile_account_admitted",
      admittedA.result.outcome === "newly_admitted" &&
        recA.outcome === "observed" &&
        recA.issuer_outcome === "admitted" &&
        recA.family_id === admittedA.result.credential.familyId &&
        recA.generation_id === admittedA.result.credential.generationId &&
        recA.provider_binding_id === admittedA.result.credential.providerBindingId &&
        recA.issuer_request_digest === admittedA.result.correlation.requestDigest,
    );
    const disabled = h.configured();
    const flowB = await claimedAccountFlow(disabled);
    const deniedB = await admit(disabled, freshSubject(), {
      commandId: flowB.selected.issuerCommandId,
    });
    const recB = await reconcile(flowB);
    check(
      "ac07_reconcile_account_denied",
      deniedB.result.outcome === "held" &&
        recB.outcome === "observed" &&
        recB.issuer_outcome === "denied" &&
        recB.family_id === null,
    );
    const flowC = await claimedAccountFlow(enabled);
    const legacyAudit = randomUUID(),
      legacyDigest = hash("legacy-" + legacyAudit);
    admin(
      `INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at) VALUES(${lit(legacyAudit)},${lit(flowC.selected.issuerCommandId)},${lit(legacyDigest)},'admit',NULL,'denied','identity_ineligible',clock_timestamp());INSERT INTO morrow_identity.browser_session_commands(command_id,request_digest,request_tuple,outcome,audit_id,recorded_at) VALUES(${lit(flowC.selected.issuerCommandId)},${lit(legacyDigest)},to_jsonb(array_fill('x'::text,ARRAY[26])),'denied',${lit(legacyAudit)},clock_timestamp());`,
    );
    const heldC = await reconcile(flowC);
    const collision = await admit(enabled, freshSubject(), {
      commandId: flowC.selected.issuerCommandId,
    });
    check(
      "ac07_workspace_command_under_account_issuer_held",
      heldC.outcome === "held" &&
        collision.result.outcome === "held" &&
        rows("account_session_commands", `command_id=${lit(flowC.selected.issuerCommandId)}`) === 0,
    );

    // ---------------------------------------------------------------- AC08
    const p1 = h.configured();
    revise(p1.f.profile, "enabled", "enabled");
    const s1 = freshSubject();
    const counts = () =>
      admin(
        "SELECT (SELECT count(*) FROM morrow_identity.principals)||'|'||(SELECT count(*) FROM morrow_identity.provider_subject_mappings)||'|'||(SELECT count(*) FROM morrow_identity.provider_subject_profile_bindings)||'|'||(SELECT count(*) FROM morrow_identity.account_enrollments)||'|'||(SELECT count(*) FROM morrow_identity.organizations)||'|'||(SELECT count(*) FROM morrow_identity.memberships)||'|'||(SELECT count(*) FROM morrow_identity.grants)",
      );
    const beforeEnroll = counts().split("|").map(Number);
    const enrolled = await admit(p1, s1);
    const afterEnroll = counts().split("|").map(Number);
    const person1 = principalOf(s1.subject);
    check(
      "ac08_first_sign_in_enrolls_exactly_once",
      enrolled.result.outcome === "newly_admitted" &&
        afterEnroll[0] === beforeEnroll[0] + 1 &&
        afterEnroll[1] === beforeEnroll[1] + 1 &&
        afterEnroll[2] === beforeEnroll[2] + 1 &&
        afterEnroll[3] === beforeEnroll[3] + 1 &&
        commandRow(enrolled.commandId) === "admitted|enrolled" &&
        rows("principals", `id=${lit(person1)} AND kind='human' AND active`) === 1 &&
        rows(
          "provider_subject_mappings",
          `principal_id=${lit(person1)} AND state='active' AND record_revision=1`,
        ) === 1 &&
        rows(
          "provider_subject_profile_bindings b JOIN morrow_identity.provider_subject_mappings m ON m.id=b.mapping_id",
          `m.principal_id=${lit(person1)} AND b.profile_id=${lit(p1.f.profile)} AND b.state='active' AND b.record_revision=1`,
        ) === 1 &&
        rows("browser_session_families", `id=${lit(enrolled.result.credential.familyId)}`) === 1,
    );
    check(
      "ac08_enrollment_confers_no_tenant_authority",
      afterEnroll[4] === beforeEnroll[4] &&
        afterEnroll[5] === beforeEnroll[5] &&
        afterEnroll[6] === beforeEnroll[6] &&
        rows("memberships", `principal_id=${lit(person1)}`) === 0,
    );
    const again = await admit(p1, { subject: s1.subject, sid: wid("session", 777001) });
    check(
      "ac08_returning_sign_in_records_existing",
      again.result.outcome === "newly_admitted" &&
        commandRow(again.commandId) === "admitted|existing" &&
        rows("account_enrollments", `principal_id=${lit(person1)}`) === 1,
    );

    // ---------------------------------------------------------------- AC09
    const s2 = freshSubject();
    const [c1, c2] = await Promise.all([
      admit(p1, { subject: s2.subject, sid: wid("session", 777101) }),
      admit(p1, { subject: s2.subject, sid: wid("session", 777102) }),
    ]);
    const kinds = [commandRow(c1.commandId), commandRow(c2.commandId)].sort();
    check(
      "ac09_concurrent_first_sign_ins_one_principal",
      c1.result.outcome === "newly_admitted" &&
        c2.result.outcome === "newly_admitted" &&
        rows("provider_subject_mappings", `subject_id=${lit(s2.subject)}`) === 1 &&
        JSON.stringify(kinds) === JSON.stringify(["admitted|enrolled", "admitted|existing"]),
    );
    const sameEnv = h.configured({ environment: p1.f.environment });
    revise(sameEnv.f.profile, "enabled", "enabled");
    const s3 = freshSubject();
    const [d1, d2] = await Promise.all([admit(p1, s3), admit(sameEnv, s3)]);
    const outcomes = [d1, d2].map((d) => d.result.outcome).sort();
    const loser = d1.result.outcome === "newly_admitted" ? d2 : d1;
    check(
      "ac09_two_profiles_one_mapping_other_identity_ineligible",
      JSON.stringify(outcomes) === JSON.stringify(["held", "newly_admitted"]) &&
        rows("provider_subject_mappings", `subject_id=${lit(s3.subject)}`) === 1 &&
        reason(loser.commandId) === "identity_ineligible" &&
        rows(
          "provider_subject_profile_bindings b JOIN morrow_identity.provider_subject_mappings m ON m.id=b.mapping_id",
          `m.subject_id=${lit(s3.subject)}`,
        ) === 1,
    );

    // ---------------------------------------------------------------- AC10
    const off = h.configured();
    const s4 = freshSubject();
    const noRevision = await admit(off, s4);
    check(
      "ac10_no_revision_disables_enrollment",
      noRevision.result.outcome === "held" &&
        reason(noRevision.commandId) === "enrollment_disabled" &&
        commandRow(noRevision.commandId) === "denied|" &&
        rows("provider_subject_mappings", `subject_id=${lit(s4.subject)}`) === 0,
    );
    revise(off.f.profile, "disabled", "enabled");
    const disabledRevision = await admit(off, freshSubject());
    check(
      "ac10_disabled_revision_denies_enrollment",
      disabledRevision.result.outcome === "held" &&
        reason(disabledRevision.commandId) === "enrollment_disabled",
    );
    const seeded = await admit(off, { subject: off.f.subject, sid: wid("session", 777201) });
    check(
      "ac10_mapped_subject_still_signs_in",
      seeded.result.outcome === "newly_admitted" &&
        commandRow(seeded.commandId) === "admitted|existing",
    );

    // ---------------------------------------------------------------- AC11
    const reactivation = [
      [
        "revoked_mapping",
        (f) =>
          `UPDATE morrow_identity.provider_subject_mappings SET state='revoked',record_revision=record_revision+1 WHERE id=${lit(f.mapping)};`,
      ],
      [
        "inactive_mapping",
        (f) =>
          `UPDATE morrow_identity.provider_subject_mappings SET state='inactive',record_revision=record_revision+1 WHERE id=${lit(f.mapping)};`,
      ],
      [
        "revoked_binding",
        (f) =>
          `UPDATE morrow_identity.provider_subject_profile_bindings SET state='revoked',record_revision=record_revision+1 WHERE mapping_id=${lit(f.mapping)};`,
      ],
      [
        "inactive_binding",
        (f) =>
          `UPDATE morrow_identity.provider_subject_profile_bindings SET state='inactive',record_revision=record_revision+1 WHERE mapping_id=${lit(f.mapping)};`,
      ],
      [
        "inactive_principal",
        (f) => `UPDATE morrow_identity.principals SET active=false WHERE id=${lit(f.principal)};`,
      ],
      [
        "service_principal",
        (f) => `UPDATE morrow_identity.principals SET kind='service' WHERE id=${lit(f.principal)};`,
      ],
    ];
    for (const [name, change] of reactivation) {
      const x = h.configured();
      revise(x.f.profile, "enabled", "enabled");
      admin(change(x.f));
      const before = counts();
      const attempt = await admit(x, { subject: x.f.subject, sid: x.f.sid });
      check(
        "ac11_" + name + "_identity_ineligible_nothing_enrolled",
        attempt.result.outcome === "held" &&
          reason(attempt.commandId) === "identity_ineligible" &&
          counts() === before &&
          rows("account_enrollments", `principal_id=${lit(x.f.principal)}`) === 0,
      );
    }

    // ---------------------------------------------------------------- AC12
    const profileA = h.configured();
    const profileB = h.configured({ environment: profileA.f.environment });
    revise(profileB.f.profile, "enabled", "enabled");
    const bindingsBefore = rows(
      "provider_subject_profile_bindings",
      `mapping_id=${lit(profileA.f.mapping)}`,
    );
    const unbound = await admit(profileB, {
      subject: profileA.f.subject,
      sid: wid("session", 777301),
    });
    check(
      "ac12_unbound_profile_identity_ineligible_no_binding",
      unbound.result.outcome === "held" &&
        reason(unbound.commandId) === "identity_ineligible" &&
        rows("provider_subject_profile_bindings", `mapping_id=${lit(profileA.f.mapping)}`) ===
          bindingsBefore &&
        bindingsBefore === 1,
    );

    // ---------------------------------------------------------------- AC13
    // Seed enrollments directly (the window counts only rows); then real admissions.
    const seedEnrollments = (profileId, n, age) =>
      admin(
        `WITH s AS (SELECT gen_random_uuid()::text AS p,gen_random_uuid()::text AS m,i FROM generate_series(1,${n}) i),
         a AS (INSERT INTO morrow_identity.principals(id,kind,active) SELECT p,'human',true FROM s RETURNING id),
         b AS (INSERT INTO morrow_identity.provider_subject_mappings(id,provider_id,environment_id,subject_id,principal_id,record_revision,state)
           SELECT s.m,'workos',v.environment_id,'user_8'||lpad(floor(random()*1e15)::bigint::text,15,'0')||lpad(s.i::text,10,'0'),s.p,1,'active' FROM s,morrow_identity.identity_verification_profiles v WHERE v.id=${lit(profileId)} AND EXISTS(SELECT 1 FROM a WHERE a.id=s.p) RETURNING id)
         INSERT INTO morrow_identity.account_enrollments(principal_id,mapping_id,profile_id,command_id,recorded_at)
           SELECT s.p,s.m,${lit(profileId)},gen_random_uuid()::text,clock_timestamp()-interval '${age}' FROM s WHERE EXISTS(SELECT 1 FROM b WHERE b.id=s.m);`,
      );
    const windowed = h.configured();
    revise(windowed.f.profile, "enabled", "enabled");
    seedEnrollments(windowed.f.profile, 29, "1 minute");
    const thirtieth = await admit(windowed, freshSubject());
    const thirtyFirst = await admit(windowed, freshSubject());
    check(
      "ac13_thirty_first_enrollment_in_ten_minutes_limited",
      thirtieth.result.outcome === "newly_admitted" &&
        thirtyFirst.result.outcome === "held" &&
        reason(thirtyFirst.commandId) === "enrollment_limited",
    );
    const existingStill = await admit(windowed, {
      subject: windowed.f.subject,
      sid: wid("session", 777401),
    });
    check(
      "ac13_existing_principal_signs_in_at_limit",
      existingStill.result.outcome === "newly_admitted",
    );
    const daily = h.configured();
    revise(daily.f.profile, "enabled", "enabled");
    seedEnrollments(daily.f.profile, 500, "1 hour");
    const overDaily = await admit(daily, freshSubject());
    check(
      "ac13_daily_enrollment_window_limited",
      overDaily.result.outcome === "held" && reason(overDaily.commandId) === "enrollment_limited",
    );

    // ---------------------------------------------------------------- AC14
    // A raw executor call whose evidence closes while another backend holds the profile.
    const accountTuple = async (profile, who, profileRecordRevision = 1) => {
      const e = (await evidence(profile.f.profileJson, who.subject, who.sid)).evidence;
      const t = [
        randomUUID(),
        e.providerId,
        e.environmentId,
        e.applicationId,
        e.clientId,
        e.issuer,
        String(e.tokenProfileRevision),
        e.tokenProfileDigest,
        e.subjectId,
        e.providerSessionId,
        String(e.issuedAtMs),
        String(e.observedAtMs),
        String(e.expiresAtMs),
        e.keySetDigest,
        e.observationProfileDigest,
        hash(randomBytes(32)),
        profile.f.profile,
        String(profileRecordRevision),
        randomUUID(),
        randomUUID(),
      ];
      return t;
    };
    const directAdmit = (t) =>
      `SELECT COALESCE(json_agg(row_to_json(r)),'[]')::text FROM morrow_identity.admit_account_family(${[t[0], hash(JSON.stringify(t)), ...t.slice(1)].map(lit).join(",")}) r;`;
    {
      const x = h.configured();
      revise(x.f.profile, "enabled", "enabled");
      const holder = sqlConnection(context.id),
        consumer = sqlConnection(context.id, "morrow_identity_sessions"),
        observer = sqlConnection(context.id);
      try {
        const [hp, cp] = await Promise.all([
          holder.query("SELECT pg_backend_pid();"),
          consumer.query("SELECT pg_backend_pid();"),
        ]);
        await observer.query("SELECT 1;");
        const who = freshSubject();
        const t = await accountTuple(x, who);
        await holder.query(
          `BEGIN;SET ROLE morrow_identity_owner;SELECT id FROM morrow_identity.identity_verification_profiles WHERE id=${lit(x.f.profile)} FOR UPDATE;`,
        );
        const now = Number(
          await observer.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text;"),
        );
        t[11] = String(now);
        t[12] = String(now + 2000);
        const work = consumer.query(directAdmit(t));
        let witnessed = false,
          expired = false;
        const end = Date.now() + 5000;
        while (Date.now() < end && !witnessed) {
          witnessed =
            (await observer.query(
              `SELECT ${Number(hp)}=ANY(pg_blocking_pids(${Number(cp)})) AND floor(extract(epoch FROM clock_timestamp())*1000)<${t[12]};`,
            )) === "t";
          if (!witnessed) await new Promise((r) => setTimeout(r, 10));
        }
        check("ac14_admission_waits_on_profile_before_expiry", witnessed);
        while (Date.now() < end && !expired) {
          expired =
            (await observer.query(
              `SELECT floor(extract(epoch FROM clock_timestamp())*1000)>=${t[12]};`,
            )) === "t";
          if (!expired) await new Promise((r) => setTimeout(r, 20));
        }
        await holder.query("ROLLBACK;");
        const reply = JSON.parse(await work)[0];
        check(
          "ac14_evidence_expired_audit_and_nothing_written",
          expired &&
            reply.outcome === "denied" &&
            reason(t[0]) === "evidence_expired" &&
            rows("provider_subject_mappings", `subject_id=${lit(who.subject)}`) === 0 &&
            rows("browser_session_families", `id=${lit(t[18])}`) === 0 &&
            rows("account_enrollments", `command_id=${lit(t[0])}`) === 0,
        );
      } finally {
        await holder.close();
        await consumer.close();
        await observer.close();
      }
    }

    // ---------------------------------------------------------------- AC16
    const claims = {
      email: "same@example.test",
      org_id: wid("org", 4242).toUpperCase().replace("ORG", "org"),
      roles: ["admin"],
    };
    const t1 = freshSubject(),
      t2 = freshSubject();
    const e1 = await admit(p1, t1, { claims }),
      e2 = await admit(p1, t2, { claims });
    const pp1 = principalOf(t1.subject),
      pp2 = principalOf(t2.subject);
    const changed = await admit(
      p1,
      { subject: t1.subject, sid: wid("session", 777501) },
      {
        claims: {
          email: "other@example.test",
          org_id: wid("org", 9999).replace("org", "org"),
          roles: ["owner"],
        },
      },
    );
    check(
      "ac16_identical_claims_two_principals",
      e1.result.outcome === "newly_admitted" &&
        e2.result.outcome === "newly_admitted" &&
        pp1 !== pp2 &&
        changed.result.outcome === "newly_admitted" &&
        principalOf(t1.subject) === pp1 &&
        rows("memberships", `principal_id IN (${lit(pp1)},${lit(pp2)})`) === 0,
    );
    check(
      "ac16_no_email_column_or_parameter",
      count(
        "SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='morrow_identity' AND c.relname IN ('self_service_revisions','account_enrollments','account_session_commands','organization_signups') AND a.attnum>0 AND a.attname ILIKE '%mail%'",
      ) === 0 &&
        count(
          "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_identity' AND p.proname IN ('admit_account_family','reconcile_account_admission','account_overview','create_first_organization','create_account_login_flow_intent','reconcile_login_flow','account_session_principal','self_service_current','display_name_valid') AND (array_to_string(p.proargnames,',') ILIKE '%mail%' OR p.prosrc ILIKE '%mail%')",
        ) === 0,
    );

    // Pools and request contexts for the account routes.
    const apiPool = (options = {}) => {
      const p = localStandaloneSqlPool(
        context.id,
        "morrow_api",
        [...Object.values(identitySql), accountOverviewSql],
        options,
      );
      pools.push(p);
      metrics.push(p.metrics);
      return p;
    };
    const onboardingPool = (options = {}) => {
      const p = localStandaloneSqlPool(
        context.id,
        "morrow_identity_onboarding",
        Object.values(accountOnboardingSql),
        options,
      );
      pools.push(p);
      metrics.push(p.metrics);
      return p;
    };
    const guarded = (digest, commandId = null, bodyText = null) => {
      const a = createLoginAttempt(Date.now, new AbortController().signal, 5000);
      const state = { submitted: false };
      return {
        a,
        state,
        c: Object.freeze({
          sessionDigest: digest,
          commandId,
          bodyText,
          control: a.control(),
          check: a.check,
          wait: a.wait,
          markSubmitted() {
            state.submitted = true;
          },
        }),
      };
    };
    const read = async (response) => ({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.json(),
    });
    async function overview(digest, profileId, pool = apiPool()) {
      const g = guarded(digest);
      try {
        return await read(await executeAccountOverview(pool, profileId, g.c));
      } finally {
        g.a.end();
      }
    }
    const names = (o = "Synthetic Org", w = "Main") => ({
      schemaVersion: 1,
      organizationName: o,
      workspaceName: w,
    });
    async function signup(digest, profileId, key, body, pool = onboardingPool()) {
      const g = guarded(digest, key, typeof body === "string" ? body : JSON.stringify(body));
      try {
        const out = await read(await executeFirstOrganization(pool, profileId, g.c));
        return { ...out, submitted: g.state.submitted };
      } finally {
        g.a.end();
      }
    }
    const bootstrapOrigin = "http://127.0.0.1:4443";
    async function bootstrap(workspace, secret) {
      const pool = localStandaloneSqlPool(context.id, "morrow_api", Object.values(identitySql));
      pools.push(pool);
      metrics.push(pool.metrics);
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
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) };
    }
    // A fresh self-enrolled person. Each gets its own signup-enabled profile, so the
    // per-profile enrollment and signup windows are reached only where a case seeds them.
    const enabledProfile = () => {
      const x = h.configured();
      revise(x.f.profile, "enabled", "enabled");
      return x;
    };
    async function person(profile = enabledProfile()) {
      const who = freshSubject();
      const a = await admit(profile, who);
      if (a.result.outcome !== "newly_admitted") throw Error("ACCOUNT_LAB_PERSON");
      return {
        who,
        ...a,
        principal: principalOf(who.subject),
        profile,
        profileId: profile.f.profile,
      };
    }

    // ---------------------------------------------------------------- AC17
    const founder = await person();
    const emptyList = await overview(founder.digest, founder.profileId);
    check(
      "ac17_fresh_principal_empty_list_onboarding_available",
      emptyList.status === 200 &&
        JSON.stringify(emptyList.body) ===
          JSON.stringify({
            schemaVersion: 1,
            workspaces: [],
            truncated: false,
            onboarding: "available",
          }),
    );
    const founderKey = randomUUID();
    const created = await signup(
      founder.digest,
      founder.profileId,
      founderKey,
      names("Noor Labs", "Main"),
    );
    const W = created.body.workspaceId,
      O = created.body.organizationId;
    check(
      "ac17_signup_created",
      created.status === 201 &&
        created.body.outcome === "created" &&
        validateDefinition("core-v1.1", "OrganizationSignupResult", created.body),
    );
    check(
      "ac17_records_active_policy_revision_one",
      rows("organizations", `id=${lit(O)} AND active AND policy_revision=1`) === 1 &&
        rows("workspaces", `id=${lit(W)} AND organization_id=${lit(O)} AND active`) === 1 &&
        rows(
          "memberships",
          `organization_id=${lit(O)} AND principal_id=${lit(founder.principal)} AND active`,
        ) === 1 &&
        rows("workspace_memberships", `workspace_id=${lit(W)} AND active`) === 1 &&
        rows(
          "organization_signups",
          `principal_id=${lit(founder.principal)} AND organization_id=${lit(O)} AND workspace_id=${lit(W)} AND grant_template='owner-bootstrap-v2' AND command_id=${lit(founderKey)}`,
        ) === 1,
    );
    const grants = JSON.parse(
      admin(
        `SELECT coalesce(jsonb_agg(payload ORDER BY payload->>'capabilityId'),'[]')::text FROM morrow_identity.grants WHERE workspace_id=${lit(W)};`,
      ),
    );
    // M5 PR-1 (ADR-0022 item 3): signup issues and records owner-bootstrap-v2, the eight
    // v1 rows plus governance.billing.manage and governance.model_default.revise.
    const template = JSON.parse(
      admin(
        "SELECT jsonb_agg(jsonb_build_object('c',capability_id,'v',verbs,'f',fields) ORDER BY capability_id)::text FROM morrow_identity.owner_bootstrap_grants_v2();",
      ),
    );
    const templateV1 = JSON.parse(
      admin(
        "SELECT jsonb_agg(jsonb_build_object('c',capability_id,'v',verbs,'f',fields) ORDER BY capability_id)::text FROM morrow_identity.owner_bootstrap_grants_v1();",
      ),
    );
    const membershipId = admin(
      `SELECT id FROM morrow_identity.memberships WHERE organization_id=${lit(O)} AND principal_id=${lit(founder.principal)};`,
    );
    const workspaceRef = {
      organizationId: O,
      workspaceId: W,
      storeId: null,
      connectionId: null,
      kind: "workspace",
      id: W,
    };
    check(
      "ac17_grants_equal_template_v2_and_validate",
      grants.length === 10 &&
        template.length === 10 &&
        templateV1.length === 8 &&
        templateV1.every((t) => template.some((u) => isDeepStrictEqual(t, u))) &&
        template.some((t) => t.c === "governance.billing.manage") &&
        template.some((t) => t.c === "governance.model_default.revise") &&
        grants.every((g, i) => {
          const t = template[i];
          return (
            validateDefinition("core", "Grant", g) &&
            g.capabilityId === t.c &&
            isDeepStrictEqual(g.verbs, t.v) &&
            isDeepStrictEqual(g.scope, {
              organizationId: O,
              workspaceId: W,
              storeIds: [],
              accountIds: [],
              resources: [workspaceRef],
              fields: t.f,
            }) &&
            isDeepStrictEqual(g.principal, {
              kind: "human",
              principalId: founder.principal,
              organizationId: O,
              workspaceId: W,
              membershipId,
              installationId: null,
              mandateId: null,
            }) &&
            isDeepStrictEqual(g.issuedBy, {
              kind: "service",
              principalId: "morrow.onboarding",
              organizationId: O,
              workspaceId: W,
              membershipId: null,
              installationId: null,
              mandateId: null,
            }) &&
            g.expiresAt === null &&
            g.revokedAt === null &&
            g.policyRevision === 1
          );
        }),
    );
    const boot = await bootstrap(W, founder.secret);
    check(
      "ac17_bootstrap_returns_workspace_name",
      boot.status === 200 &&
        boot.body.workspace.id === W &&
        boot.body.workspace.displayName === "Main",
    );
    const listed = await overview(founder.digest, founder.profileId);
    check(
      "ac17_list_shows_workspace_onboarding_unavailable",
      listed.status === 200 &&
        JSON.stringify(listed.body) ===
          JSON.stringify({
            schemaVersion: 1,
            workspaces: [
              {
                organizationId: O,
                organizationName: "Noor Labs",
                workspaceId: W,
                workspaceName: "Main",
              },
            ],
            truncated: false,
            onboarding: "unavailable",
          }) &&
        validateDefinition("core-v1.1", "AccountOverview", listed.body),
    );

    // ---------------------------------------------------------------- AC18
    const reads = localIdentityPool(context.id);
    pools.push(reads);
    const boundary = createWorkspacePermissionBoundary(reads, {
      readCurrent: async () => ({ providerAllowed: true, entitlementAllowed: true }),
    });
    const capabilities = new Map(catalogue.capabilities.map((c) => [c.id, c]));
    const decide = (capabilityId, verb, fields, resource = workspaceRef, workspace = W) =>
      boundary.decide(founder.digest, workspace, {
        capabilityId,
        verb,
        resource,
        accountId: null,
        fields,
      });
    let allAllowed = true,
      approvalsMatch = true;
    for (const t of template)
      for (const verb of t.v) {
        const r = await decide(t.c, verb, t.f);
        allAllowed &&= r.decision.allowed === true && r.decision.reason === "allowed";
        const expectApproval =
          capabilities.get(t.c).review_required === true &&
          (verb === "execute" ||
            (t.c === "governance.connection.connect" && verb === "administer"));
        approvalsMatch &&= r.obligations.includes("exact_approval") === expectApproval;
      }
    check("ac18_every_template_verb_allowed", allAllowed);
    check("ac18_exact_approval_iff_review_required_execute", approvalsMatch);
    let delegateDenied = true;
    for (const t of template)
      delegateDenied &&=
        (await decide(t.c, "delegate", t.f)).decision.reason === "capability_denied";
    check("ac18_delegate_capability_denied", delegateDenied);
    check(
      "ac18_execute_on_connect_and_decide_denied",
      (await decide("governance.connection.connect", "execute", ["providerId"])).decision.reason ===
        "capability_denied" &&
        (await decide("governance.approval.decide", "execute", ["proposalRef"])).decision.reason ===
          "capability_denied",
    );
    check(
      "ac18_view_on_work_goal_denied",
      (await decide("workspace.goal.create", "view", ["objective"])).decision.reason ===
        "capability_denied",
    );
    check(
      "ac18_extra_email_field_denied",
      (await decide("governance.usage.read", "view", ["scope", "period", "email"])).decision
        .reason === "field_denied",
    );
    check(
      "ac18_store_scoped_resource_denied",
      (
        await decide("governance.usage.read", "view", ["scope"], {
          ...workspaceRef,
          storeId: "store_1",
          kind: "product",
          id: "product_1",
        })
      ).decision.reason === "scope_denied",
    );
    const otherOrgWorkspace = h.configured().f.workspace;
    let foreignThrows = false;
    try {
      await decide("governance.usage.read", "view", ["scope"], workspaceRef, otherOrgWorkspace);
    } catch (error) {
      foreignThrows = error?.code === "IDENTITY_DENIED";
    }
    check("ac18_foreign_workspace_identity_denied", foreignThrows);

    // ---------------------------------------------------------------- AC19
    const totals = () =>
      admin(
        "SELECT (SELECT count(*) FROM morrow_identity.organizations)||'|'||(SELECT count(*) FROM morrow_identity.workspaces)||'|'||(SELECT count(*) FROM morrow_identity.memberships)||'|'||(SELECT count(*) FROM morrow_identity.grants)||'|'||(SELECT count(*) FROM morrow_identity.organization_signups)",
      );
    const beforeReplay = totals();
    const replay = await signup(
      founder.digest,
      founder.profileId,
      founderKey,
      names("Noor Labs", "Main"),
    );
    check(
      "ac19_same_key_same_body_replayed",
      replay.status === 200 &&
        replay.body.outcome === "replayed" &&
        replay.body.organizationId === O &&
        replay.body.workspaceId === W &&
        totals() === beforeReplay,
    );
    const conflict = await signup(
      founder.digest,
      founder.profileId,
      founderKey,
      names("Other", "Main"),
    );
    check(
      "ac19_same_key_other_body_conflict",
      conflict.status === 409 &&
        JSON.stringify(conflict.body) ===
          JSON.stringify({ schemaVersion: 1, outcome: "idempotency_conflict" }) &&
        totals() === beforeReplay,
    );
    const second = await signup(
      founder.digest,
      founder.profileId,
      randomUUID(),
      names("Second", "Main"),
    );
    check(
      "ac19_new_key_after_success_already_onboarded",
      second.status === 409 &&
        second.body.outcome === "already_onboarded" &&
        totals() === beforeReplay,
    );
    const racer = await person();
    const [r1, r2] = await Promise.all([
      signup(racer.digest, racer.profileId, randomUUID(), names("Race A", "Main")),
      signup(racer.digest, racer.profileId, randomUUID(), names("Race B", "Main")),
    ]);
    check(
      "ac19_two_keys_at_once_one_created_one_conflict",
      JSON.stringify([r1.status, r2.status].sort()) === JSON.stringify([201, 409]) &&
        rows("organization_signups", `principal_id=${lit(racer.principal)}`) === 1 &&
        rows("memberships", `principal_id=${lit(racer.principal)}`) === 1,
    );

    // ---------------------------------------------------------------- AC20
    const other = await person();
    const reused = await signup(
      other.digest,
      other.profileId,
      founderKey,
      names("Noor Labs", "Main"),
    );
    check(
      "ac20_key_reuse_across_principals_own_outcome",
      reused.status === 201 &&
        reused.body.organizationId !== O &&
        reused.body.workspaceId !== W &&
        rows(
          "organization_signups",
          `principal_id=${lit(other.principal)} AND command_id=${lit(founderKey)}`,
        ) === 1,
    );

    // ---------------------------------------------------------------- AC21/AC26
    const seedSignups = (profileId, n, age) =>
      admin(
        `WITH s AS (SELECT gen_random_uuid()::text AS p,gen_random_uuid()::text AS o,gen_random_uuid()::text AS w,gen_random_uuid()::text AS m FROM generate_series(1,${n})),
         a AS (INSERT INTO morrow_identity.principals(id,kind,active) SELECT p,'human',true FROM s RETURNING id),
         b AS (INSERT INTO morrow_identity.organizations(id,display_name,active,policy_revision) SELECT o,'Seed',true,1 FROM s RETURNING id),
         c AS (INSERT INTO morrow_identity.workspaces(id,organization_id,display_name,active) SELECT w,o,'Seed',true FROM s WHERE EXISTS(SELECT 1 FROM b WHERE b.id=s.o) RETURNING id),
         d AS (INSERT INTO morrow_identity.memberships(id,organization_id,principal_id,active) SELECT m,o,p,true FROM s WHERE EXISTS(SELECT 1 FROM a WHERE a.id=s.p) AND EXISTS(SELECT 1 FROM b WHERE b.id=s.o) RETURNING id)
         INSERT INTO morrow_identity.organization_signups(principal_id,command_id,request_digest,profile_id,organization_id,workspace_id,membership_id,grant_template,recorded_at)
           SELECT p,gen_random_uuid()::text,encode(sha256(convert_to(p,'UTF8')),'hex'),${lit(profileId)},o,w,m,'owner-bootstrap-v1',clock_timestamp()-interval '${age}' FROM s WHERE EXISTS(SELECT 1 FROM c WHERE c.id=s.w) AND EXISTS(SELECT 1 FROM d WHERE d.id=s.m);`,
      );
    const p21 = h.configured();
    revise(p21.f.profile, "enabled", "enabled");
    const early = await person(p21);
    const earlyKey = randomUUID();
    const earlyCreated = await signup(
      early.digest,
      p21.f.profile,
      earlyKey,
      names("Early", "Main"),
    );
    revise(p21.f.profile, "enabled", "disabled");
    seedSignups(p21.f.profile, 25, "1 minute");
    const earlyReplay = await signup(early.digest, p21.f.profile, earlyKey, names("Early", "Main"));
    check(
      "ac21_replay_precedes_switch_and_window",
      earlyCreated.status === 201 &&
        earlyReplay.status === 200 &&
        earlyReplay.body.outcome === "replayed" &&
        earlyReplay.body.organizationId === earlyCreated.body.organizationId,
    );
    const p26 = h.configured();
    revise(p26.f.profile, "enabled", "enabled");
    seedSignups(p26.f.profile, 20, "1 minute");
    const limited = await person(p26);
    const tooMany = await signup(
      limited.digest,
      p26.f.profile,
      randomUUID(),
      names("Late", "Main"),
    );
    check(
      "ac26_signup_window_rate_limited",
      tooMany.status === 429 &&
        tooMany.headers["retry-after"] === "600" &&
        JSON.stringify(tooMany.body) ===
          JSON.stringify({ schemaVersion: 1, outcome: "rate_limited" }) &&
        rows("organization_signups", `principal_id=${lit(limited.principal)}`) === 0,
    );
    const p26d = h.configured();
    revise(p26d.f.profile, "enabled", "enabled");
    seedSignups(p26d.f.profile, 200, "2 hours");
    const limitedDaily = await person(p26d);
    check(
      "ac26_daily_signup_window_rate_limited",
      (await signup(limitedDaily.digest, p26d.f.profile, randomUUID(), names())).status === 429,
    );

    // ---------------------------------------------------------------- AC22
    {
      const lost = await person();
      const key = randomUUID();
      const afterSent = await signup(
        lost.digest,
        lost.profileId,
        key,
        names("Lost", "Main"),
        onboardingPool({
          afterQuery: async (text) => {
            if (text === accountOnboardingSql.create) throw Error("SYNTHETIC_LOSS");
          },
        }),
      );
      check(
        "ac22_loss_after_create_sent_outcome_unknown",
        afterSent.status === 503 &&
          afterSent.submitted &&
          JSON.stringify(afterSent.body) ===
            JSON.stringify({ schemaVersion: 1, outcome: "outcome_unknown" }),
      );
      const retry = await signup(lost.digest, lost.profileId, key, names("Lost", "Main"));
      check(
        "ac22_retry_after_uncommitted_loss_creates",
        retry.status === 201 &&
          rows("organization_signups", `principal_id=${lit(lost.principal)}`) === 1,
      );
      const lostCommit = await person();
      const commitKey = randomUUID();
      const afterCommit = await signup(
        lostCommit.digest,
        lostCommit.profileId,
        commitKey,
        names("Committed", "Main"),
        onboardingPool({ commitAckLoss: true }),
      );
      check(
        "ac22_loss_after_commit_sent_outcome_unknown",
        afterCommit.status === 503 &&
          JSON.stringify(afterCommit.body) ===
            JSON.stringify({ schemaVersion: 1, outcome: "outcome_unknown" }),
      );
      const retried = await signup(
        lostCommit.digest,
        lostCommit.profileId,
        commitKey,
        names("Committed", "Main"),
      );
      check(
        "ac22_retry_after_committed_loss_replayed_never_twice",
        retried.status === 200 &&
          retried.body.outcome === "replayed" &&
          rows("organization_signups", `principal_id=${lit(lostCommit.principal)}`) === 1 &&
          rows("memberships", `principal_id=${lit(lostCommit.principal)}`) === 1,
      );
    }

    // ---------------------------------------------------------------- AC23
    {
      const victim = await person();
      const unavailableBody = JSON.stringify({ code: "unavailable" });
      const noRows = () =>
        rows("organization_signups", `principal_id=${lit(victim.principal)}`) === 0;
      const connectFailure = await signup(
        victim.digest,
        victim.profileId,
        randomUUID(),
        names(),
        onboardingPool({
          beforeStartup: () => {
            throw Error("SYNTHETIC_CONNECT");
          },
        }),
      );
      check(
        "ac23_connect_failure_unavailable",
        connectFailure.status === 503 &&
          JSON.stringify(connectFailure.body) === unavailableBody &&
          !connectFailure.submitted &&
          noRows(),
      );
      const beginFailure = await signup(
        victim.digest,
        victim.profileId,
        randomUUID(),
        names(),
        onboardingPool({
          beforeQuery: async (text) => {
            if (text === accountOnboardingSql.begin) throw Error("SYNTHETIC_BEGIN");
          },
        }),
      );
      check(
        "ac23_begin_failure_unavailable",
        beginFailure.status === 503 &&
          JSON.stringify(beginFailure.body) === unavailableBody &&
          noRows(),
      );
      // The overview profile's morrow_api pool presented to the signup: its role row mismatches.
      const wrongRole = localStandaloneSqlPool(
        context.id,
        "morrow_api",
        Object.values(accountOnboardingSql),
      );
      pools.push(wrongRole);
      metrics.push(wrongRole.metrics);
      const roleMismatch = await signup(
        victim.digest,
        victim.profileId,
        randomUUID(),
        names(),
        wrongRole,
      );
      check(
        "ac23_role_row_mismatch_unavailable",
        roleMismatch.status === 503 &&
          JSON.stringify(roleMismatch.body) === unavailableBody &&
          !roleMismatch.submitted &&
          noRows(),
      );
      // A real `denied` reply: the definer refuses while an owner membership exists.
      context.sql("GRANT morrow_identity_owner TO morrow_identity_logout;", "morrow");
      const deniedReply = await signup(victim.digest, victim.profileId, randomUUID(), names());
      context.sql("REVOKE morrow_identity_owner FROM morrow_identity_logout;", "morrow");
      check(
        "ac23_denied_reply_unavailable",
        deniedReply.status === 503 &&
          JSON.stringify(deniedReply.body) === unavailableBody &&
          noRows(),
      );
    }

    // ---------------------------------------------------------------- AC24
    {
      const returning = await person();
      const key = randomUUID();
      const first = await signup(
        returning.digest,
        returning.profileId,
        key,
        names("Return", "Main"),
      );
      admin(
        `SELECT * FROM morrow_identity.revoke_browser_family(${lit(returning.result.credential.familyId)},${lit(randomUUID())},${lit(hash("lab-revoke"))});`,
      );
      const revoked = await signup(
        returning.digest,
        returning.profileId,
        key,
        names("Return", "Main"),
      );
      const back = await admit(returning.profile, {
        subject: returning.who.subject,
        sid: wid("session", 777601),
      });
      const replayed = await signup(back.digest, returning.profileId, key, names("Return", "Main"));
      check(
        "ac24_replay_after_re_sign_in",
        first.status === 201 &&
          revoked.status === 401 &&
          back.result.outcome === "newly_admitted" &&
          replayed.status === 200 &&
          replayed.body.organizationId === first.body.organizationId,
      );
    }

    // ---------------------------------------------------------------- AC25
    {
      const x = h.configured();
      const insert = (revision, role = "postgres") =>
        psql(
          `INSERT INTO morrow_identity.self_service_revisions(profile_id,revision,enrollment,organization_signup,reason,approval_ref) VALUES(${lit(x.f.profile)},${revision},'enabled','enabled','Synthetic','approval_lab_2');`,
          role,
          "morrow",
          role === "postgres",
        );
      check("ac25_first_revision_inserts", insert(1).status === 0);
      check("ac25_gap_raises", refused(insert(3), "SELF_SERVICE_REVISION_INVALID"));
      check("ac25_reused_revision_raises", refused(insert(1), "SELF_SERVICE_REVISION_INVALID"));
      check("ac25_next_revision_inserts", insert(2).status === 0);
      check(
        "ac25_recorded_by_session_user",
        admin(
          `SELECT string_agg(recorded_by::text,',' ORDER BY revision) FROM morrow_identity.self_service_revisions WHERE profile_id=${lit(x.f.profile)};`,
        ) === "postgres,postgres",
      );
      for (const statement of [
        `UPDATE morrow_identity.self_service_revisions SET reason='x' WHERE profile_id=${lit(x.f.profile)};`,
        `DELETE FROM morrow_identity.self_service_revisions WHERE profile_id=${lit(x.f.profile)};`,
        "TRUNCATE morrow_identity.self_service_revisions;",
      ])
        check(
          "ac25_switch_history_immutable_" + statement.split(" ")[0].toLowerCase(),
          refused(psql(statement, "postgres", "morrow", true), "ACCOUNT_RECORD_IMMUTABLE"),
        );
      // An insert waits behind an admission holding the profile row.
      const holder = sqlConnection(context.id, "morrow_identity_sessions");
      try {
        const t = await accountTuple(x, freshSubject());
        await holder.query("BEGIN;");
        const held = JSON.parse(await holder.query(directAdmit(t)))[0];
        const blocked = psql(
          `SET lock_timeout='300ms';INSERT INTO morrow_identity.self_service_revisions(profile_id,revision,enrollment,organization_signup,reason,approval_ref) VALUES(${lit(x.f.profile)},3,'enabled','disabled','Synthetic','approval_lab_2');`,
          "postgres",
          "morrow",
          true,
        );
        await holder.query("COMMIT;");
        check(
          "ac25_switch_insert_waits_behind_admission",
          held.outcome === "newly_admitted" && refused(blocked, "55P03") && insert(3).status === 0,
        );
      } finally {
        await holder.close();
      }
      // Signup disabled: POST 403 and the list reports unavailable.
      const y = h.configured();
      revise(y.f.profile, "enabled", "enabled");
      const late = await person(y);
      revise(y.f.profile, "enabled", "disabled");
      const refusedSignup = await signup(late.digest, y.f.profile, randomUUID(), names());
      const list = await overview(late.digest, y.f.profile);
      check(
        "ac25_disabled_signup_403_and_list_unavailable",
        refusedSignup.status === 403 &&
          JSON.stringify(refusedSignup.body) ===
            JSON.stringify({ schemaVersion: 1, outcome: "signup_unavailable" }) &&
          list.status === 200 &&
          list.body.onboarding === "unavailable",
      );
    }

    // ---------------------------------------------------------------- AC27
    {
      const seededPerson = await admit(p1, { subject: p1.f.subject, sid: wid("session", 777701) });
      const list = await overview(seededPerson.digest, p1.f.profile);
      const attempt = await signup(seededPerson.digest, p1.f.profile, randomUUID(), names());
      check(
        "ac27_owner_seeded_principal_not_eligible",
        seededPerson.result.outcome === "newly_admitted" &&
          list.status === 200 &&
          list.body.onboarding === "unavailable" &&
          list.body.workspaces.length === 1 &&
          attempt.status === 403 &&
          attempt.body.outcome === "signup_unavailable",
      );
    }

    // ---------------------------------------------------------------- AC29/AC30
    {
      const subject = await person();
      const connectsBefore = metrics.reduce((n, m) => n + m.connections, 0);
      let rejected = true;
      for (const key of ["organizationId", "workspaceId", "principalId", "subjectId", "email"]) {
        const r = await signup(subject.digest, subject.profileId, randomUUID(), {
          ...names(),
          [key]: "x",
        });
        rejected &&= r.status === 400 && r.body.code === "request_denied";
      }
      check(
        "ac29_client_tenant_fields_rejected_without_sql",
        rejected && metrics.reduce((n, m) => n + m.connections, 0) === connectsBefore,
      );
      // Each signup above created its own pool; none of them connected.
      check(
        "ac29_no_connection_opened_for_rejected_bodies",
        metrics.slice(-5).every((m) => m.connections === 0),
      );
      let tsRejects = true;
      for (const value of [...invalidNames, ...typescriptOnlyInvalidNames]) {
        const r = await signup(
          subject.digest,
          subject.profileId,
          randomUUID(),
          names(value, "Main"),
        );
        tsRejects &&=
          r.status === 400 &&
          JSON.stringify(r.body) === JSON.stringify({ schemaVersion: 1, outcome: "invalid_name" });
      }
      check("ac30_typescript_rejects_invalid_names", tsRejects);
      const rawCreate = (org) =>
        JSON.parse(
          psql(
            `SELECT COALESCE(json_agg(row_to_json(r)),'[]')::text FROM morrow_identity.create_first_organization(${lit(hash("any"))},${lit(randomUUID())},${lit(p1.f.profile)},${lit(org)},'Main') r;`,
            "morrow_identity_onboarding",
          ).stdout.trim(),
        )[0].outcome;
      check(
        "ac30_sql_rejects_invalid_and_non_nfc_names",
        [...invalidNames, ...sqlOnlyInvalidNames].every((value) => rawCreate(value) === "invalid"),
      );
      let stored = true;
      for (const [sent, expected] of acceptedNames) {
        const p = await person();
        const r = await signup(
          p.digest,
          p.profileId,
          randomUUID(),
          names("Org " + p.principal.slice(0, 8), sent),
        );
        const name = admin(
          `SELECT display_name FROM morrow_identity.workspaces WHERE id=${lit(r.body.workspaceId ?? "none")};`,
        );
        stored &&= r.status === 201 && name === expected;
        if (sent === acceptedNames.at(-1)[0]) {
          const b = await bootstrap(r.body.workspaceId, p.secret);
          stored &&= b.status === 200 && b.body.workspace.displayName === expected;
        }
      }
      check("ac30_accepted_names_stored_as_nfc_and_astral_bootstraps", stored);
    }

    // ---------------------------------------------------------------- AC31 and the
    // account_session_principal versus session_eligibility family-half matrix.
    {
      const both = async (digest, profileId = p1.f.profile) => {
        const list = await overview(digest, profileId);
        const post = await signup(digest, profileId, randomUUID(), names());
        return (
          list.status === 401 && post.status === 401 && post.body.code === "authentication_required"
        );
      };
      const matrix = [];
      const matches = (digest, workspace) =>
        admin(
          `SELECT (EXISTS(SELECT 1 FROM morrow_identity.account_session_principal(${lit(digest)})))::text||'|'||(EXISTS(SELECT 1 FROM morrow_identity.session_eligibility(${lit(digest)},${lit(workspace)})))::text;`,
        );
      // A seeded person with one membership, signed in afresh per state.
      const seededState = async (label, mutate, expectAccount) => {
        const x = h.configured();
        const a = await admit(x, { subject: x.f.subject, sid: x.f.sid });
        if (a.result.outcome !== "newly_admitted") throw Error("ACCOUNT_LAB_MATRIX_" + label);
        admin(mutate(x.f, a));
        const m = matches(a.digest, x.f.workspace);
        matrix.push({ label, observed: m });
        check(
          "ac31_matrix_" + label + "_family_half_agrees",
          m === `${expectAccount}|${expectAccount}`,
        );
        if (!expectAccount)
          check("ac31_" + label + "_401_on_both_routes", await both(a.digest, x.f.profile));
      };
      await seededState("current", () => "SELECT 1;", true);
      await seededState(
        "expired_family",
        (_f, a) =>
          `ALTER TABLE morrow_identity.browser_session_families DISABLE TRIGGER USER;ALTER TABLE morrow_identity.browser_session_generations DISABLE TRIGGER USER;UPDATE morrow_identity.browser_session_families SET created_at=created_at-interval '20 minutes',expires_at=expires_at-interval '20 minutes' WHERE id=${lit(a.result.credential.familyId)};UPDATE morrow_identity.browser_session_generations SET created_at=created_at-interval '20 minutes',expires_at=expires_at-interval '20 minutes' WHERE family_id=${lit(a.result.credential.familyId)};ALTER TABLE morrow_identity.browser_session_families ENABLE TRIGGER USER;ALTER TABLE morrow_identity.browser_session_generations ENABLE TRIGGER USER;`,
        false,
      );
      await seededState(
        "revoked_family",
        (_f, a) =>
          `SELECT * FROM morrow_identity.revoke_browser_family(${lit(a.result.credential.familyId)},${lit(randomUUID())},${lit(hash("m1"))});`,
        false,
      );
      await seededState(
        "revoked_provider_binding",
        (_f, a) =>
          `SELECT * FROM morrow_identity.revoke_provider_binding(${lit(a.result.credential.providerBindingId)},${lit(randomUUID())},${lit(hash("m2"))});`,
        false,
      );
      await seededState(
        "inactive_principal",
        (f) => `UPDATE morrow_identity.principals SET active=false WHERE id=${lit(f.principal)};`,
        false,
      );
      await seededState(
        "revoked_mapping",
        (f) =>
          `UPDATE morrow_identity.provider_subject_mappings SET state='revoked',record_revision=record_revision+1 WHERE id=${lit(f.mapping)};`,
        false,
      );
      await seededState(
        "revoked_binding",
        (f) =>
          `UPDATE morrow_identity.provider_subject_profile_bindings SET state='revoked',record_revision=record_revision+1 WHERE mapping_id=${lit(f.mapping)};`,
        false,
      );
      await seededState(
        "changed_profile_revision",
        (f) =>
          `UPDATE morrow_identity.identity_verification_profiles SET record_revision=record_revision+1 WHERE id=${lit(f.profile)};`,
        false,
      );
      // A legacy sessions digest, and a digest present in both representations.
      const legacyFixture = h.configured();
      const legacySecret = randomBytes(32).toString("base64url").slice(0, 42) + "A";
      secrets.push(legacySecret);
      admin(
        `INSERT INTO morrow_identity.sessions(id,principal_id,organization_id,session_digest,provider,provider_session_id,expires_at) VALUES(${lit("legacy_" + randomUUID())},${lit(legacyFixture.f.principal)},${lit(legacyFixture.f.organization)},${lit(hash(legacySecret))},'workos',${lit("legacy_" + randomUUID())},clock_timestamp()+interval '1 hour');`,
      );
      check(
        "ac31_legacy_sessions_digest_401",
        await both(hash(legacySecret), legacyFixture.f.profile),
      );
      const dual = h.configured();
      const dualAdmit = await admit(dual, { subject: dual.f.subject, sid: dual.f.sid });
      admin(
        `INSERT INTO morrow_identity.sessions(id,principal_id,organization_id,session_digest,provider,provider_session_id,expires_at) VALUES(${lit("dual_" + randomUUID())},${lit(dual.f.principal)},${lit(dual.f.organization)},${lit(dualAdmit.digest)},'workos',${lit("dual_" + randomUUID())},clock_timestamp()+interval '1 hour');`,
      );
      check(
        "ac31_dual_representation_digest_401",
        matches(dualAdmit.digest, dual.f.workspace) === "false|false" &&
          (await both(dualAdmit.digest, dual.f.profile)),
      );
      const profileMismatch = await person();
      check(
        "ac31_family_of_other_profile_401",
        await both(profileMismatch.digest, enabled.f.profile),
      );
      check("ac31_unknown_digest_401", await both(hash("unknown-" + randomUUID())));
    }

    // ---------------------------------------------------------------- AC32
    {
      const x = h.configured();
      const a = await admit(x, { subject: x.f.subject, sid: x.f.sid });
      const principal = x.f.principal;
      // A second organization with active and inactive records; one inactive org.
      admin(
        `INSERT INTO morrow_identity.organizations VALUES('zz_org_${x.f.n}','alpha Org',true,1),('zz_dead_${x.f.n}','Dead Org',false,1);
         INSERT INTO morrow_identity.workspaces VALUES('zz_ws1_${x.f.n}','zz_org_${x.f.n}','Beta',true),('zz_ws2_${x.f.n}','zz_org_${x.f.n}','alpha',true),('zz_ws3_${x.f.n}','zz_org_${x.f.n}','Inactive',false),('zz_ws4_${x.f.n}','zz_dead_${x.f.n}','Dead',true),('zz_ws5_${x.f.n}','zz_org_${x.f.n}','Gamma',true);
         INSERT INTO morrow_identity.memberships VALUES('zz_m_${x.f.n}','zz_org_${x.f.n}',${lit(principal)},true),('zz_md_${x.f.n}','zz_dead_${x.f.n}',${lit(principal)},true);
         INSERT INTO morrow_identity.workspace_memberships VALUES('zz_org_${x.f.n}','zz_ws1_${x.f.n}','zz_m_${x.f.n}',true),('zz_org_${x.f.n}','zz_ws2_${x.f.n}','zz_m_${x.f.n}',true),('zz_org_${x.f.n}','zz_ws3_${x.f.n}','zz_m_${x.f.n}',true),('zz_dead_${x.f.n}','zz_ws4_${x.f.n}','zz_md_${x.f.n}',true),('zz_org_${x.f.n}','zz_ws5_${x.f.n}','zz_m_${x.f.n}',false);`,
      );
      const list = await overview(a.digest, x.f.profile);
      const eligible = admin(
        `SELECT string_agg(w.id::text,',' ORDER BY w.id) FROM morrow_identity.workspaces w WHERE EXISTS(SELECT 1 FROM morrow_identity.session_eligibility(${lit(a.digest)},w.id::text));`,
      );
      const listedIds = list.body.workspaces.map((w) => w.workspaceId);
      const sorted = [...list.body.workspaces].sort(
        (l, r) =>
          Buffer.compare(Buffer.from(l.organizationName), Buffer.from(r.organizationName)) ||
          Buffer.compare(Buffer.from(l.organizationId), Buffer.from(r.organizationId)) ||
          Buffer.compare(Buffer.from(l.workspaceName), Buffer.from(r.workspaceName)) ||
          Buffer.compare(Buffer.from(l.workspaceId), Buffer.from(r.workspaceId)),
      );
      check(
        "ac32_list_equals_session_eligibility_set",
        list.status === 200 &&
          [...listedIds].sort().join(",") === eligible &&
          listedIds.length === 3,
      );
      check(
        "ac32_list_ordered_by_c_collation",
        // C collation: "Synthetic" sorts before "alpha Org", and "Beta" before "alpha";
        // a linguistic collation would reverse both.
        JSON.stringify(sorted) === JSON.stringify(list.body.workspaces) &&
          JSON.stringify(listedIds) ===
            JSON.stringify([x.f.workspace, "zz_ws1_" + x.f.n, "zz_ws2_" + x.f.n]),
      );
      check(
        "ac32_list_never_includes_foreign_workspace",
        !listedIds.includes(W) && !listedIds.includes(otherOrgWorkspace),
      );
      admin(
        `INSERT INTO morrow_identity.workspaces SELECT 'zz_many_'||i||'_${x.f.n}','zz_org_${x.f.n}','Many '||lpad(i::text,3,'0'),true FROM generate_series(1,99) i;
         INSERT INTO morrow_identity.workspace_memberships SELECT 'zz_org_${x.f.n}','zz_many_'||i||'_${x.f.n}','zz_m_${x.f.n}',true FROM generate_series(1,99) i;`,
      );
      const many = await overview(a.digest, x.f.profile);
      check(
        "ac32_hundred_and_one_eligible_truncated",
        many.status === 200 && many.body.workspaces.length === 100 && many.body.truncated === true,
      );
      check(
        "ac32_overview_is_one_stable_sql_statement",
        admin(
          "SELECT l.lanname||'|'||p.provolatile::text||'|'||p.prosecdef::text FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid='morrow_identity.account_overview(text,text)'::regprocedure;",
        ) === "sql|s|true",
      );
    }

    // ---------------------------------------------------------------- AC33/AC34
    {
      // A second eligible workspace W2 in the founder's organization (owner SQL), so one tab
      // can select W2 while a W1 tab keeps working.
      const W2 = "zz33_w2_" + randomUUID().slice(0, 8);
      admin(
        `INSERT INTO morrow_identity.workspaces VALUES(${lit(W2)},${lit(O)},'Second',true);
         INSERT INTO morrow_identity.workspace_memberships VALUES(${lit(O)},${lit(W2)},${lit(membershipId)},true);`,
      );
      const foreign = await bootstrap(otherOrgWorkspace, founder.secret);
      const missing = await bootstrap("no_such_workspace", founder.secret);
      const selectionState = () =>
        admin(
          "SELECT md5(string_agg(t,',' ORDER BY t)) FROM (SELECT to_jsonb(x)::text t FROM morrow_identity.workspace_memberships x UNION ALL SELECT to_jsonb(y)::text FROM morrow_identity.browser_session_families y UNION ALL SELECT to_jsonb(g)::text FROM morrow_identity.browser_session_generations g) z;",
        );
      const before = selectionState();
      const tabW1 = await bootstrap(W, founder.secret);
      const [tabW2, tabW1Again] = await Promise.all([
        bootstrap(W2, founder.secret),
        bootstrap(W, founder.secret),
      ]);
      check(
        "ac33_two_tabs_select_w1_and_w2_and_selection_writes_nothing",
        tabW1.status === 200 &&
          tabW1.body.workspace.id === W &&
          tabW2.status === 200 &&
          tabW2.body.workspace.id === W2 &&
          tabW1Again.status === 200 &&
          tabW1Again.body.workspace.id === W &&
          selectionState() === before,
      );
      check(
        "ac33_foreign_and_unknown_same_401_bytes",
        foreign.status === 401 && missing.status === 401 && foreign.text === missing.text,
      );
      // AC34: the founder revokes its own workspace membership with its template grant.
      const revokeGrant = grants.find((g) => g.capabilityId === "governance.membership.revoke");
      const receipt = randomUUID(),
        command = randomUUID(),
        request = hash(randomUUID());
      admin(
        `INSERT INTO morrow_identity.workspace_revocation_receipts(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,actor_session_digest,target_membership_id,command_id,request_digest,expected_policy_revision,authorizing_grant_id,authorizing_grant_snapshot,approval_evidence_id,expires_at) VALUES(${[receipt, O, W, founder.principal, membershipId, founder.digest, membershipId, command, request].map(lit).join(",")},1,${lit(revokeGrant.id)},${lit(JSON.stringify(revokeGrant))}::jsonb,'synthetic_approval',clock_timestamp()+interval '1 hour');`,
      );
      const life = localLifecyclePool(context.id);
      pools.push(life);
      const revoked = await createWorkspaceAccessRevocations(life).apply({
        receiptId: receipt,
        commandId: command,
        requestDigest: request,
        sessionDigest: founder.digest,
        organizationId: O,
        workspaceId: W,
        targetMembershipId: membershipId,
        expectedRevision: 1,
      });
      const afterList = await overview(founder.digest, founder.profileId);
      const afterBoot = await bootstrap(W, founder.secret);
      const afterReplay = await signup(
        founder.digest,
        founder.profileId,
        founderKey,
        names("Noor Labs", "Main"),
      );
      const afterW2 = await bootstrap(W2, founder.secret);
      check(
        "ac34_revocation_removes_list_bootstrap_and_replay",
        revoked.outcome === "applied" &&
          afterList.status === 200 &&
          JSON.stringify(afterList.body.workspaces.map((w) => w.workspaceId)) ===
            JSON.stringify([W2]) &&
          afterBoot.status === 401 &&
          afterReplay.status === 409 &&
          afterReplay.body.outcome === "already_onboarded",
      );
      check(
        "ac34_other_workspace_of_the_organization_unaffected",
        afterW2.status === 200 && afterW2.body.workspace.id === W2,
      );
      check(
        "ac33_revoked_foreign_and_unknown_same_401_bytes",
        afterBoot.status === 401 &&
          afterBoot.text === foreign.text &&
          afterBoot.text === missing.text,
      );
    }

    // ---------------------------------------------------------------- AC35/AC36/AC37
    {
      const newFunctions = [
        "display_name_valid(text)",
        "self_service_current(text)",
        "owner_bootstrap_grants_v1()",
        "executor_role_safe(text)",
        "onboarding_role_safe()",
        "account_session_principal(text)",
        "account_preserve_record()",
        "self_service_revision_sequence()",
        "create_account_login_flow_intent(text,text,text,text,text)",
        "reconcile_login_flow(text,text,text,text,text)",
        "reconcile_workspace_login_flow(text,text,text,text,text)",
        "admit_account_family(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text)",
        "reconcile_account_admission(text,text)",
        "account_overview(text,text)",
        "create_first_organization(text,text,text,text,text)",
      ];
      const executable = (role) =>
        admin(
          `SELECT coalesce(string_agg(f,',' ORDER BY f),'') FROM unnest(ARRAY[${newFunctions.map((f) => lit("morrow_identity." + f)).join(",")}]) f WHERE has_function_privilege(${lit(role)},f::regprocedure,'EXECUTE');`,
        );
      check(
        "ac35_api_executes_only_account_overview",
        executable("morrow_api") === "morrow_identity.account_overview(text,text)",
      );
      check(
        "ac35_onboarding_executes_only_create_first_organization",
        executable("morrow_identity_onboarding") ===
          "morrow_identity.create_first_organization(text,text,text,text,text)" &&
          count(
            "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_identity' AND has_function_privilege('morrow_identity_onboarding',p.oid,'EXECUTE')",
          ) === 1,
      );
      check(
        "ac35_sessions_and_login_executors",
        executable("morrow_identity_sessions") ===
          "morrow_identity.admit_account_family(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text),morrow_identity.reconcile_account_admission(text,text)" &&
          executable("morrow_identity_login") ===
            "morrow_identity.create_account_login_flow_intent(text,text,text,text,text),morrow_identity.reconcile_login_flow(text,text,text,text,text)",
      );
      const roles = [
        "morrow_api",
        "morrow_identity_lifecycle",
        "morrow_identity_linking",
        "morrow_identity_preauth",
        "morrow_identity_resolution",
        "morrow_identity_sessions",
        "morrow_identity_login",
        "morrow_identity_login_maintenance",
        "morrow_identity_logout",
        "morrow_identity_onboarding",
      ];
      check(
        "ac35_no_executor_reads_or_writes_new_tables",
        count(
          `SELECT count(*) FROM unnest(ARRAY[${roles.map(lit).join(",")}]) r,unnest(ARRAY['self_service_revisions','account_enrollments','account_session_commands','organization_signups']) t,unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p WHERE has_table_privilege(r,'morrow_identity.'||t,p)`,
        ) === 0,
      );
      const setRole = JSON.parse(
        psql(
          `SET ROLE morrow_identity_onboarding;SELECT COALESCE(json_agg(row_to_json(r)),'[]')::text FROM morrow_identity.create_first_organization(${lit(founder.digest)},${lit(randomUUID())},${lit(p1.f.profile)},'Org','Main') r;`,
        ).stdout.trim(),
      )[0];
      check("ac35_set_role_onboarding_denied", setRole.outcome === "denied");
      check(
        "ac35_retired_entry_points_revoked",
        admin(
          "SELECT has_function_privilege('morrow_identity_login','morrow_identity.create_login_flow_intent(text,text,text,text,text,text)','EXECUTE')::text||has_function_privilege('morrow_identity_sessions','morrow_identity.admit_browser_family(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text)','EXECUTE')::text||has_function_privilege('morrow_identity_resolution','morrow_identity.resolve_provider_subject_selection(text,text,text,text,text,text,text,text,text)','EXECUTE')::text",
        ) === "falsefalsefalse" &&
          refused(
            psql(
              `SELECT * FROM morrow_identity.admit_browser_family(${Array.from({ length: 27 }, () => "'x'").join(",")});`,
              "morrow_identity_sessions",
            ),
            "42501",
          ),
      );
      for (const table of [
        "account_enrollments",
        "account_session_commands",
        "organization_signups",
      ])
        for (const statement of [
          `UPDATE morrow_identity.${table} SET recorded_at=recorded_at;`,
          `DELETE FROM morrow_identity.${table};`,
          `TRUNCATE morrow_identity.${table} CASCADE;`,
        ])
          check(
            "ac36_" + table + "_" + statement.split(" ")[0].toLowerCase() + "_raises",
            refused(psql(statement, "postgres", "morrow", true), "ACCOUNT_RECORD_IMMUTABLE"),
          );
      check(
        "ac37_new_workspace_has_no_store_links_or_handoffs",
        rows("workspace_store_links", `workspace_id=${lit(W)}`) === 0 &&
          rows("linking_handoffs", `workspace_id=${lit(W)}`) === 0,
      );
      check(
        "ac37_template_has_no_spend_or_billable_capability",
        template.every((t) => {
          const c = capabilities.get(t.c);
          return (
            c &&
            !["spend", "billable_job"].includes(c.effect) &&
            !c.eligible_principal.startsWith("operator_")
          );
        }),
      );
    }

    // Role safety (AC23/AC35): an owner membership on any of the ten executors makes account
    // admission, account login intents and signup refuse before any write. 0013 replaces
    // the 0008 and 0010 helpers, whose lists covered six and eight executors.
    {
      const rx = enabledProfile();
      const signer = await person(rx);
      const flowsOf = () =>
        rows("login_flows", `configuration_digest=${lit(rx.configurationDigest)}`);
      const flowsBefore = flowsOf();
      const intent = (flow = randomUUID()) =>
        psql(
          `SELECT outcome FROM morrow_identity.create_account_login_flow_intent(${[rx.configurationDigest, flow, randomUUID(), randomUUID(), randomUUID()].map(lit).join(",")});`,
          "morrow_identity_login",
        ).stdout.trim();
      const admission = (t) =>
        JSON.parse(psql(directAdmit(t), "morrow_identity_sessions").stdout.trim() || "[{}]")[0]
          .outcome;
      const create = (command = randomUUID()) =>
        JSON.parse(
          psql(
            `SELECT COALESCE(json_agg(row_to_json(r)),'[]')::text FROM morrow_identity.create_first_organization(${lit(signer.digest)},${lit(command)},${lit(rx.f.profile)},'Role Org','Main') r;`,
            "morrow_identity_onboarding",
          ).stdout.trim() || "[{}]",
        )[0].outcome;
      const tuple = await accountTuple(rx, freshSubject());
      const executors = [
        "morrow_api",
        "morrow_identity_lifecycle",
        "morrow_identity_linking",
        "morrow_identity_preauth",
        "morrow_identity_resolution",
        "morrow_identity_sessions",
        "morrow_identity_login",
        "morrow_identity_login_maintenance",
        "morrow_identity_logout",
        "morrow_identity_onboarding",
      ];
      const refusals = [];
      for (const executor of executors) {
        context.sql(`GRANT morrow_identity_owner TO ${executor};`, "morrow");
        try {
          refusals.push([executor, intent(), admission(tuple), create()]);
        } finally {
          context.sql(`REVOKE morrow_identity_owner FROM ${executor};`, "morrow");
        }
      }
      check(
        "role_safety_owner_membership_on_any_executor_denies_intent_admission_and_signup",
        refusals.length === 10 &&
          refusals.every(([, i, a, c]) => i === "denied" && a === "denied" && c === "denied") &&
          flowsOf() === flowsBefore &&
          rows("account_session_commands", `command_id=${lit(tuple[0])}`) === 0 &&
          rows("browser_session_audits", `command_id=${lit(tuple[0])}`) === 0 &&
          rows("organization_signups", `principal_id=${lit(signer.principal)}`) === 0,
      );
      // Reverse membership (the owner a member of an executor) is refused the same way.
      context.sql("GRANT morrow_identity_logout TO morrow_identity_owner;", "morrow");
      let reverse;
      try {
        reverse = [intent(), admission(tuple), create()];
      } finally {
        context.sql("REVOKE morrow_identity_logout FROM morrow_identity_owner;", "morrow");
      }
      check(
        "role_safety_owner_member_of_an_executor_denies",
        reverse.every((outcome) => outcome === "denied"),
      );
      const fresh = await accountTuple(rx, freshSubject());
      check(
        "role_safety_restored_roles_admit_intend_and_sign_up",
        intent() === "newly_created" &&
          admission(fresh) === "newly_admitted" &&
          create() === "created",
      );
      check(
        "role_safety_replaced_helpers_keep_acls",
        count(
          `SELECT count(*) FROM unnest(ARRAY[${executors.map(lit).join(",")}]) r,unnest(ARRAY['morrow_identity.browser_sessions_role_safe()','morrow_identity.login_role_safe(boolean)','morrow_identity.executor_role_safe(text)','morrow_identity.onboarding_role_safe()']) f WHERE has_function_privilege(r,f::regprocedure,'EXECUTE')`,
        ) === 0 &&
          admin(
            "SELECT string_agg(DISTINCT pg_get_userbyid(p.proowner),',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_identity' AND p.proname IN ('browser_sessions_role_safe','login_role_safe','executor_role_safe','onboarding_role_safe');",
          ) === "morrow_identity_owner",
      );
    }

    // Interleavings: signup against a family revoked while it waits; an admission against
    // an in-flight signup on the same profile; admission and signup against an in-flight
    // revoke_workspace_access on the same profile.
    {
      // Raw executor calls: every wait is observed in pg_blocking_pids naming the holder,
      // never by a sleep or a lock timer, and no request budget can expire while a loaded
      // host is slow.
      // waitBehind runs one statement on `connection` while the backend `holderPid` holds a
      // lock. An observer polls until pg_blocking_pids(probe) names the holder, then cancels
      // the probe with pg_cancel_backend. The holder keeps its lock until the caller ends its
      // transaction, so the cancel always lands while the probe waits. psql's SQLSTATE is
      // read in-band on stdout after the statement: 57014 (query_canceled) for the cancelled
      // statement, 00000 for one that completed. psql's stderr is a separate pipe whose bytes
      // can arrive after the stdout marker, so it never decides an outcome. The ten-second
      // bound only ends a probe that never waits on the holder; that probe is cancelled too
      // and reported as not blocked.
      const queryCanceled = "57014";
      const waitBehind = async (observer, holderPid, connection, statement) => {
        const probePid = Number(await connection.query("SELECT pg_backend_pid();"));
        let settled = false;
        const pending = connection.query(`${statement}\n\\echo :SQLSTATE`);
        pending.then(
          () => (settled = true),
          () => (settled = true),
        );
        let blocked = false;
        const end = Date.now() + 10000;
        while (!blocked && !settled && Date.now() < end) {
          blocked =
            (await observer.query(
              `SELECT ${Number(holderPid)}=ANY(pg_blocking_pids(${probePid}));`,
            )) === "t";
          if (!blocked) await new Promise((r) => setTimeout(r, 20));
        }
        const cancelled = settled
          ? false
          : (await observer.query(`SELECT pg_cancel_backend(${probePid});`)) === "t";
        const lines = (await pending).split("\n");
        return { blocked, cancelled, sqlstate: lines.at(-1), rows: lines.length - 1 };
      };
      // The first outcome of a JSON row set, or a closed marker when there is none.
      const firstOutcome = (text) => {
        try {
          return String(JSON.parse(text)[0]?.outcome ?? "none");
        } catch {
          return "unparsed";
        }
      };
      const waiting = await person();
      const holder = sqlConnection(context.id),
        signer0 = sqlConnection(context.id, "morrow_identity_onboarding"),
        observer = sqlConnection(context.id);
      try {
        const [hp, sp] = await Promise.all([
          holder.query("SELECT pg_backend_pid();"),
          signer0.query("SELECT pg_backend_pid();"),
        ]);
        await observer.query("SELECT 1;");
        await holder.query(
          `BEGIN;SET ROLE morrow_identity_owner;SELECT outcome FROM morrow_identity.revoke_browser_family(${lit(waiting.result.credential.familyId)},${lit(randomUUID())},${lit(hash("wait"))});`,
        );
        const pending = signer0.query(
          `SELECT COALESCE(json_agg(row_to_json(r)),'[]')::text FROM morrow_identity.create_first_organization(${lit(waiting.digest)},${lit(randomUUID())},${lit(waiting.profileId)},'Waiting','Main') r;`,
        );
        let blocked = false;
        const end = Date.now() + 30000;
        while (Date.now() < end && !blocked) {
          blocked =
            (await observer.query(`SELECT ${Number(hp)}=ANY(pg_blocking_pids(${Number(sp)}));`)) ===
            "t";
          if (!blocked) await new Promise((r) => setTimeout(r, 20));
        }
        await holder.query("COMMIT;");
        const outcome = firstOutcome(await pending);
        const signups = rows("organization_signups", `principal_id=${lit(waiting.principal)}`);
        check(
          "interleave_signup_against_family_revoked_while_waiting",
          blocked && outcome === "unauthenticated" && signups === 0,
          { blocked, outcome, signups },
        );
      } finally {
        await holder.close();
        await signer0.close();
        await observer.close();
      }
      const signer = await person();
      const onboardingRaw = sqlConnection(context.id, "morrow_identity_onboarding"),
        sessions = sqlConnection(context.id, "morrow_identity_sessions"),
        signupWatcher = sqlConnection(context.id);
      try {
        const [signupPid] = await Promise.all([
          onboardingRaw.query("SELECT pg_backend_pid();"),
          sessions.query("SELECT 1;"),
          signupWatcher.query("SELECT 1;"),
        ]);
        await onboardingRaw.query("BEGIN;");
        const reply = firstOutcome(
          await onboardingRaw.query(
            `SELECT COALESCE(json_agg(row_to_json(r)),'[]')::text FROM morrow_identity.create_first_organization(${lit(signer.digest)},${lit(randomUUID())},${lit(signer.profileId)},'Held','Main') r;`,
          ),
        );
        const t = await accountTuple(signer.profile, {
          subject: signer.who.subject,
          sid: wid("session", 777801),
        });
        const admission = await waitBehind(signupWatcher, signupPid, sessions, directAdmit(t));
        const written = {
          commands: rows("account_session_commands", `command_id=${lit(t[0])}`),
          audits: rows("browser_session_audits", `command_id=${lit(t[0])}`),
        };
        await onboardingRaw.query("COMMIT;");
        const fresh = await accountTuple(signer.profile, {
          subject: signer.who.subject,
          sid: wid("session", 777802),
        });
        const after = firstOutcome(await sessions.query(directAdmit(fresh)));
        const seen = { signup: reply, admission, written, after };
        const name = "interleave_admission_waits_behind_signup_profile_lock";
        check(name + "_signup_created", reply === "created", seen);
        check(name + "_blocked_by_signup", admission.blocked, seen);
        check(
          name + "_cancelled_while_waiting",
          admission.sqlstate === queryCanceled && admission.rows === 0,
          seen,
        );
        check(name + "_nothing_written", written.commands === 0 && written.audits === 0, seen);
        check(name + "_post_commit_admits", after === "newly_admitted", seen);
      } finally {
        await onboardingRaw.close();
        await sessions.close();
        await signupWatcher.close();
      }
      // revoke_workspace_access (organization first, then the actor's session locks,
      // including its profile) holds the profile; an admission and a signup on that profile
      // wait behind it, write nothing, and both succeed once it commits.
      const rv = enabledProfile();
      const actor = await person(rv);
      const actorSignup = await signup(
        actor.digest,
        rv.f.profile,
        randomUUID(),
        names("Revoking Org", "Main"),
      );
      const Oa = actorSignup.body.organizationId,
        Wa = actorSignup.body.workspaceId;
      const Ma = admin(
        `SELECT id FROM morrow_identity.memberships WHERE organization_id=${lit(Oa)} AND principal_id=${lit(actor.principal)};`,
      );
      const revokeGrant = JSON.parse(
        admin(
          `SELECT payload::text FROM morrow_identity.grants WHERE workspace_id=${lit(Wa)} AND payload->>'capabilityId'='governance.membership.revoke';`,
        ),
      );
      const other = await person(rv);
      const receipt = randomUUID(),
        command = randomUUID(),
        request = hash(randomUUID());
      admin(
        `INSERT INTO morrow_identity.workspace_revocation_receipts(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,actor_session_digest,target_membership_id,command_id,request_digest,expected_policy_revision,authorizing_grant_id,authorizing_grant_snapshot,approval_evidence_id,expires_at) VALUES(${[receipt, Oa, Wa, actor.principal, Ma, actor.digest, Ma, command, request].map(lit).join(",")},1,${lit(revokeGrant.id)},${lit(JSON.stringify(revokeGrant))}::jsonb,'synthetic_approval',clock_timestamp()+interval '1 hour');`,
      );
      const revoker = sqlConnection(context.id, "morrow_identity_lifecycle"),
        admitter = sqlConnection(context.id, "morrow_identity_sessions"),
        creator = sqlConnection(context.id, "morrow_identity_onboarding"),
        revokeWatcher = sqlConnection(context.id);
      try {
        const [revokerPid] = await Promise.all([
          revoker.query("SELECT pg_backend_pid();"),
          admitter.query("SELECT 1;"),
          creator.query("SELECT 1;"),
          revokeWatcher.query("SELECT 1;"),
        ]);
        const applied = await revoker.query(
          `BEGIN;SELECT outcome FROM morrow_identity.revoke_workspace_access(${[receipt, command, request, actor.digest, Oa, Wa, Ma, "1"].map(lit).join(",")});`,
        );
        const newcomer = freshSubject();
        const t = await accountTuple(rv, newcomer);
        const admission = await waitBehind(revokeWatcher, revokerPid, admitter, directAdmit(t));
        const otherKey = randomUUID();
        const createSql = `SELECT COALESCE(json_agg(row_to_json(r)),'[]')::text FROM morrow_identity.create_first_organization(${lit(other.digest)},${lit(otherKey)},${lit(rv.f.profile)},'Waiting Org','Main') r;`;
        const creation = await waitBehind(revokeWatcher, revokerPid, creator, createSql);
        const written = {
          commands: rows("account_session_commands", `command_id=${lit(t[0])}`),
          audits: rows("browser_session_audits", `command_id=${lit(t[0])}`),
          mappings: rows("provider_subject_mappings", `subject_id=${lit(newcomer.subject)}`),
          signups: rows("organization_signups", `principal_id=${lit(other.principal)}`),
        };
        await revoker.query("COMMIT;");
        // The same subject and provider session with fresh evidence: admit_account_family
        // bounds evidence to five seconds, and the cancelled attempt left no mapping, so the
        // admission after the commit enrols.
        const fresh = await accountTuple(rv, newcomer);
        const retried = firstOutcome(await admitter.query(directAdmit(fresh)));
        const enrolment = commandRow(fresh[0]);
        const created = firstOutcome(await creator.query(createSql));
        const actorList = await overview(actor.digest, rv.f.profile);
        const listed = actorList.body?.workspaces?.length ?? null;
        const seen = {
          applied,
          admission,
          creation,
          written,
          retried,
          enrolment,
          created,
          list: { status: actorList.status, workspaces: listed },
        };
        const name = "interleave_admission_and_signup_wait_behind_revoke_workspace_access";
        check(name + "_applied", applied === "applied", seen);
        check(name + "_admission_blocked_by_revoker", admission.blocked, seen);
        check(
          name + "_admission_cancelled_while_waiting",
          admission.sqlstate === queryCanceled && admission.rows === 0,
          seen,
        );
        check(name + "_signup_blocked_by_revoker", creation.blocked, seen);
        check(
          name + "_signup_cancelled_while_waiting",
          creation.sqlstate === queryCanceled && creation.rows === 0,
          seen,
        );
        check(
          name + "_nothing_written",
          Object.values(written).every((n) => n === 0),
          seen,
        );
        check(
          name + "_post_commit_enrols",
          retried === "newly_admitted" && enrolment === "admitted|enrolled",
          seen,
        );
        check(name + "_same_signup_creates", created === "created", seen);
        check(name + "_actor_list_empty", actorList.status === 200 && listed === 0, seen);
      } finally {
        await revoker.close();
        await admitter.close();
        await creator.close();
        await revokeWatcher.close();
      }
    }

    check(
      "no_secret_in_sql_observations",
      [...pools, ...h.rolePools].every((p) => {
        const text = JSON.stringify(p.observed ?? []);
        return secrets.every((s) => !text.includes(s));
      }),
    );
    return { version: context.version, image: context.image };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const closed = await Promise.allSettled([h.close(), ...pools.map((p) => p.close())]);
    // A cleanup failure is reported, but never replaces the original failure.
    if (closed.some((r) => r.status === "rejected") && primaryFailure === undefined)
      throw Error("ACCOUNT_ONBOARDING_LAB_CLEANUP_UNVERIFIED");
  }
});
check(
  "all_source_bytes_stable",
  sourcePaths.every((p) => sourceHashes[p] === hash(readFileSync(p))),
);
check(
  "disposable_clients_physically_closed",
  metrics.every(
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
  part: "B",
  acceptance: [
    5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 29, 30, 31,
    32, 33, 34, 35, 36, 37,
  ].map((n) => "P05.T01x-AC" + String(n).padStart(2, "0")),
  migrations: appliedMigrations.map((m) => ({ sequence: m.sequence, sha256: m.sha256 })),
  source_hashes: sourceHashes,
  checks,
  checks_passed: checks.length,
  cleanup: metrics,
  container_absent: absent,
  engine: observed,
  provider_requests: 0,
  limitations: [
    "Synthetic identities in a fresh local container only; no hosted migration, provider, real user or merchant effect.",
    "Enrollment and signup windows are reached by seeding window rows directly as the owner; the limits themselves are enforced by the definers.",
    "The HTTP envelope, the Workers runtime and the broker lease failure are covered by the account Workers laboratory.",
  ],
};
writeArtifact("labs/account-onboarding.json", JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    packet: report.packet,
    checks: checks.length,
    passed: true,
    provider_requests: 0,
    container_absent: absent,
  }),
);
