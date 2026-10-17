import { readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import canonicalize from "canonicalize";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { localBrowserSessionPool } from "./local-browser-session-sql.mjs";
import { exerciseBrowserSessionSqlFaults } from "../tests/fixtures/browser-session-admission-sql-faults.mjs";
import { localIdentityPool } from "./local-identity-sql.mjs";
import { localLifecyclePool } from "./local-lifecycle-sql.mjs";
import { localStoreLinkingPool } from "./local-store-linking-sql.mjs";
import {
  createWorkosBrowserSessionAdmission,
  browserSessionAdmissionSql,
} from "../packages/identity/src/workos-browser-session-admission.ts";
import { createWorkosAuthenticationEvidence } from "../packages/identity/src/workos-authentication-evidence.ts";
import { buildWorkosAuthenticationEvidenceFixture } from "../tests/fixtures/workos-authentication-evidence.mjs";
import { withIdentityRead } from "../packages/identity/src/index.ts";
import { createWorkspaceAccessRevocations } from "../packages/identity/src/workspace-access-revocation.ts";
import { createWorkspaceStoreLinks } from "../packages/identity/src/workspace-store-linking.ts";
import {
  createHumanPolicyService,
  createWorkspacePermissionBoundary,
} from "../packages/policy/src/index.ts";
import {
  validateDefinition,
  validateCapabilityInput,
} from "../packages/contracts/src/validation.ts";
import { writeArtifact } from "./artifacts.mjs";
const checks = [];
const check = (name, ok) => {
  if (!ok) throw Error("BROWSER_SESSION_LAB_FAILED:" + name);
  if (checks.some((x) => x.name === name)) throw Error("BROWSER_SESSION_LAB_DUPLICATE_CHECK");
  checks.push({ name, passed: true });
};
const hash = (x) => createHash("sha256").update(x).digest("hex");
const lit = (x) => "'" + String(x).replaceAll("'", "''") + "'";
const wid = (p, n) => p + "_" + String(n).padStart(26, "0");
const sourcePaths = [
  "scripts/browser-session-admission-lab.mjs",
  "scripts/local-browser-session-sql.mjs",
  "tests/fixtures/browser-session-admission-sql-faults.mjs",
  "scripts/local-postgres-lab.mjs",
  "scripts/local-identity-sql.mjs",
  "scripts/local-lifecycle-sql.mjs",
  "scripts/local-store-linking-sql.mjs",
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/workos-authentication-evidence.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/identity/src/workos-session-token.ts",
  "packages/identity/src/index.ts",
  "packages/identity/src/workspace-access-revocation.ts",
  "packages/identity/src/workspace-store-linking.ts",
  "packages/policy/src/index.ts",
  "tests/fixtures/workos-authentication-evidence.mjs",
  "infra/identity-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  "docs/plan/source.json",
  "docs/plan/build-plan.md",
];
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const migrations = manifest.migrations.slice(0, 8).map((m) => {
  const text = readFileSync("migrations/" + m.file, "utf8");
  if (hash(text) !== m.sha256) throw Error("BROWSER_SESSION_MIGRATION_HASH");
  sourcePaths.push("migrations/" + m.file);
  return { m, text };
});
if (migrations.length !== 8 || migrations[7].m.sequence !== 8)
  throw Error("BROWSER_SESSION_MIGRATION_REQUIRED");
const plan = JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan;
if (
  !Number.isSafeInteger(plan.sequence) ||
  plan.sequence < 81 ||
  plan.sha256 !== hash(readFileSync("docs/plan/build-plan.md"))
)
  throw Error("BROWSER_SESSION_PLAN_REQUIRED");
const sources = Object.fromEntries(sourcePaths.map((p) => [p, hash(readFileSync(p))]));
const secrets = [],
  pools = [],
  metrics = [];
// Fixed local-only process helper for intentional locks and exact SQL role tests.
// No SQL or proof values enter argv/environment/errors. Every connection is owned.
function sqlConnection(id, role = "postgres") {
  const child = spawn(
    "docker",
    [
      "exec",
      "--interactive",
      id,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      role,
      "-d",
      "morrow",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "",
    pending = null,
    closed = false,
    bytes = 0;
  const ended = new Promise((resolve) =>
    child.on("close", () => {
      closed = true;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(Error("BROWSER_SESSION_LOCK_CLOSED"));
        pending = null;
      }
      resolve();
    }),
  );
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.stderr.on("data", () => {});
  child.stdout.on("data", (c) => {
    bytes += c.length;
    if (bytes > 1048576) {
      child.kill("SIGKILL");
      return;
    }
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
      if (closed || pending) throw Error("BROWSER_SESSION_LOCK_PROTOCOL");
      const marker = "BROWSER_SESSION_LOCK_" + randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error("BROWSER_SESSION_LOCK_TIMEOUT"));
        }, 10000);
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
          }, 2000);
        }),
      ]);
      clearTimeout(timer);
      await ended;
    },
  };
}
let ownedContainerId = null;
const result = await localPostgresLab("P05.T01m", async ({ id, sql, image, version }) => {
  ownedContainerId = id;
  sql("CREATE DATABASE morrow; CREATE DATABASE morrow_browser_rollback;");
  sql(readFileSync("infra/identity-role-prerequisites.sql", "utf8"), "morrow");
  for (const m of migrations) sql("SET ROLE morrow_identity_owner;\n" + m.text, "morrow");
  const admin = (t) => sql("SET ROLE morrow_identity_owner;\n" + t, "morrow");
  const exec = (t, role = "morrow_identity_sessions", allowFailure = false, db = "morrow") =>
    containerCommand(
      [
        "exec",
        "--interactive",
        id,
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
        db,
      ],
      t,
      allowFailure,
    );
  const jsonSQL = (t) =>
    "SELECT COALESCE(json_agg(row_to_json(r)),'[]'::json)::text FROM (" + t + ") r;";
  const tableNames = [
    "provider_session_bindings",
    "browser_session_families",
    "browser_session_generations",
    "browser_session_commands",
    "browser_session_audits",
  ];
  check(
    "executor_initially_safe_nologin",
    sql(
      "SELECT NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) FROM pg_roles r WHERE rolname='morrow_identity_sessions';",
      "morrow",
    ) === "t",
  );
  sql("GRANT CREATE ON DATABASE morrow_browser_rollback TO morrow_identity_owner;");
  for (const m of migrations.slice(0, 7))
    sql("SET ROLE morrow_identity_owner;\n" + m.text, "morrow_browser_rollback");
  const rollback = exec(
    "SET ROLE morrow_identity_owner;\n" +
      migrations[7].text.replace(/COMMIT;\s*$/, "SELECT 1/0;\nCOMMIT;"),
    "postgres",
    true,
    "morrow_browser_rollback",
  );
  check(
    "migration8_transaction_atomic_rollback",
    rollback.status !== 0 && /22012/.test(rollback.stderr),
  );
  check(
    "rollback_preserves_seven_and_no_partial_eighth",
    sql(
      "SELECT to_regclass('morrow_identity.provider_subject_mappings') IS NOT NULL AND to_regclass('morrow_identity.browser_session_families') IS NULL AND to_regprocedure('morrow_identity.session_eligibility(text,text)') IS NULL;",
      "morrow_browser_rollback",
    ) === "t",
  );
  for (const [name, on, off] of [
    [
      "executor_login",
      "ALTER ROLE morrow_identity_sessions LOGIN;",
      "ALTER ROLE morrow_identity_sessions NOLOGIN;",
    ],
    [
      "executor_replication",
      "ALTER ROLE morrow_identity_sessions REPLICATION;",
      "ALTER ROLE morrow_identity_sessions NOREPLICATION;",
    ],
    [
      "owner_login",
      "ALTER ROLE morrow_identity_owner LOGIN;",
      "ALTER ROLE morrow_identity_owner NOLOGIN;",
    ],
    [
      "incoming_executor_membership",
      "GRANT morrow_identity_sessions TO morrow_api;",
      "REVOKE morrow_identity_sessions FROM morrow_api;",
    ],
    [
      "service_owner_membership",
      "GRANT morrow_identity_owner TO morrow_api;",
      "REVOKE morrow_identity_owner FROM morrow_api;",
    ],
  ]) {
    sql(on);
    const r = exec(
      "SET ROLE morrow_identity_owner;\n" + migrations[7].text,
      "postgres",
      true,
      "morrow_browser_rollback",
    );
    check(
      "migration_prerequisite_" + name,
      r.status !== 0 && r.stderr.includes("BROWSER_SESSION_ROLE_PREREQUISITES_INVALID"),
    );
    sql(off);
  }
  // Only this isolated synthetic socket enables the otherwise NOLOGIN executors.
  sql(
    "ALTER ROLE morrow_identity_sessions LOGIN; ALTER ROLE morrow_api LOGIN; ALTER ROLE morrow_identity_lifecycle LOGIN; ALTER ROLE morrow_identity_linking LOGIN; ALTER ROLE morrow_identity_preauth LOGIN; ALTER ROLE morrow_identity_resolution LOGIN; CREATE ROLE browser_public_probe LOGIN NOINHERIT;",
  );
  for (const t of tableNames) {
    check(
      t + "_forced_rls_owner",
      sql(
        `SELECT relrowsecurity AND relforcerowsecurity AND pg_get_userbyid(relowner)='morrow_identity_owner' FROM pg_class WHERE oid='morrow_identity.${t}'::regclass;`,
        "morrow",
      ) === "t",
    );
    for (const role of [
      "morrow_identity_sessions",
      "morrow_api",
      "morrow_identity_lifecycle",
      "morrow_identity_linking",
      "morrow_identity_preauth",
      "morrow_identity_resolution",
    ]) {
      for (const [op, q] of [
        ["select", `SELECT * FROM morrow_identity.${t};`],
        ["delete", `DELETE FROM morrow_identity.${t};`],
      ]) {
        const r = exec(q, role, true);
        check(role + "_" + op + "_denied_" + t, r.status !== 0 && r.stderr.includes("42501"));
      }
      check(
        role + "_no_table_acl_" + t,
        sql(
          `SELECT NOT has_table_privilege(${lit(role)},'morrow_identity.${t}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');`,
          "morrow",
        ) === "t",
      );
    }
  }
  const reconcileSql = (command, digest) =>
    jsonSQL(
      `SELECT * FROM morrow_identity.reconcile_browser_admission(${lit(command)},${lit(digest)})`,
    );
  for (const role of [
    "morrow_api",
    "morrow_identity_lifecycle",
    "morrow_identity_linking",
    "morrow_identity_preauth",
    "morrow_identity_resolution",
    "browser_public_probe",
  ]) {
    check(
      role + "_no_admission_reconcile",
      exec(reconcileSql(randomUUID(), hash("synthetic")), role, true).status !== 0,
    );
    check(
      role + "_cannot_assume_executor",
      exec("SET ROLE morrow_identity_sessions;", role, true).status !== 0,
    );
  }
  const ownerAttempt = JSON.parse(
    exec(
      "SET ROLE morrow_identity_sessions;\n" + reconcileSql(randomUUID(), hash("synthetic")),
      "postgres",
    ).stdout.trim(),
  )[0];
  check(
    "session_user_guard_blocks_owner_set_role",
    ownerAttempt.outcome === "denied" &&
      Object.values(ownerAttempt)
        .slice(1)
        .every((x) => x === null),
  );
  const reads = localIdentityPool(id),
    life = localLifecyclePool(id),
    links = localStoreLinkingPool(id);
  pools.push(reads, life, links);
  const boundary = createWorkspacePermissionBoundary(reads, {
    readCurrent: async () => ({ providerAllowed: true, entitlementAllowed: true }),
  });
  let serial = 0;
  function fixture(options = {}) {
    const n = ++serial;
    const f = {
      n,
      environment: options.environment ?? wid("environment", n),
      application: options.application ?? wid("app", n),
      client: options.client ?? wid("client", n),
      subject: options.subject ?? wid("user", n),
      sid: options.sid ?? wid("session", n),
      principal: options.principal ?? "person_" + n,
      organization: "organization_" + n,
      workspace: "workspace_" + n,
      membership: "membership_" + n,
      profile: "profile_" + n,
      mapping: options.mapping ?? "mapping_" + n,
    };
    f.issuer = "https://api.workos.com/user_management/" + f.client;
    f.profileJson = JSON.stringify({
      schemaVersion: 1,
      providerId: "workos",
      environmentId: f.environment,
      applicationId: f.application,
      clientId: f.client,
      issuer: f.issuer,
      revision: 1,
      audiencePolicy: "absent",
    });
    f.selector = {
      schemaVersion: 1,
      commandId: randomUUID(),
      workspaceId: f.workspace,
      profileId: f.profile,
      profileRecordRevision: 1,
      mappingId: f.mapping,
      mappingRevision: 1,
      bindingRevision: 1,
      membershipId: f.membership,
      policyRevision: 1,
    };
    admin(
      `${options.principal ? "" : `INSERT INTO morrow_identity.principals VALUES(${lit(f.principal)},'human',true);`}INSERT INTO morrow_identity.organizations VALUES(${lit(f.organization)},'Synthetic',true,1); INSERT INTO morrow_identity.workspaces VALUES(${lit(f.workspace)},${lit(f.organization)},'Synthetic',true); INSERT INTO morrow_identity.memberships VALUES(${lit(f.membership)},${lit(f.organization)},${lit(f.principal)},true); INSERT INTO morrow_identity.workspace_memberships VALUES(${lit(f.organization)},${lit(f.workspace)},${lit(f.membership)},true); INSERT INTO morrow_identity.identity_verification_profiles VALUES(${lit(f.profile)},'workos',${lit(f.environment)},${lit(f.application)},${lit(f.client)},${lit(f.issuer)},1,${lit(hash(f.profileJson))},1,'active'); ${options.mapping ? "" : `INSERT INTO morrow_identity.provider_subject_mappings VALUES(${lit(f.mapping)},'workos',${lit(f.environment)},${lit(f.subject)},${lit(f.principal)},1,'active');`} INSERT INTO morrow_identity.provider_subject_profile_bindings VALUES(${lit(f.mapping)},${lit(f.profile)},'workos',${lit(f.environment)},1,'active');`,
    );
    return f;
  }
  async function evidenceFor(f, options = {}) {
    const at = Date.now(),
      fx = buildWorkosAuthenticationEvidenceFixture({
        profile: JSON.parse(f.profileJson),
        claims: {
          sub: f.subject,
          sid: f.sid,
          iat: Math.floor(at / 1000) - 1,
          exp: Math.floor(at / 1000) + 120,
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
            ...options.session,
          }),
        ]),
    });
    const verified = await owner.verify(fx.token);
    if (verified.outcome !== "verified_active_evidence")
      throw Error("BROWSER_SESSION_EVIDENCE_FIXTURE");
    return {
      owner,
      handle: verified.handle,
      evidence: owner.readEvidence(verified.handle),
      token: fx.token,
    };
  }
  const controlled = () => ({
    deadlineMs: Date.now() + 5000,
    signal: new AbortController().signal,
  });
  async function admitted(f, options = {}) {
    const e = await evidenceFor(f),
      capture = [];
    const pool = localBrowserSessionPool(id, {
      ...options,
      beforeQuery: async (t, v) => {
        if (t === browserSessionAdmissionSql.admit) capture.push([...v]);
        if (options.beforeQuery) await options.beforeQuery(t, v);
      },
    });
    pools.push(pool);
    metrics.push(pool.metrics);
    const service = createWorkosBrowserSessionAdmission({
      pool,
      readEvidence: e.owner.readEvidence,
      now: Date.now,
      signal: options.signal,
    });
    const r = await service.admit(e.handle, JSON.stringify(f.selector));
    if (r.credential) secrets.push(r.credential.secret);
    return { f, e, pool, service, result: r, tuple: capture[0] };
  }
  async function identity(digest, workspace) {
    return withIdentityRead(reads, digest, workspace, async (s) => s.identity);
  }
  async function deniedIdentity(digest, workspace) {
    try {
      await identity(digest, workspace);
      return false;
    } catch (e) {
      return e.code === "IDENTITY_DENIED";
    }
  }
  const count = (table, condition = "true") =>
    Number(admin(`SELECT count(*) FROM morrow_identity.${table} WHERE ${condition};`));
  const direct = (values) =>
    jsonSQL(
      "SELECT * FROM morrow_identity.admit_browser_family(" + values.map(lit).join(",") + ")",
    );
  const first = await admitted(fixture());
  check(
    "owning_evidence_actual_sql_fresh_admission",
    first.result.outcome === "newly_admitted" && first.result.credential !== null,
  );
  const c = first.result.credential,
    proof = hash(c.secret);
  check(
    "fresh_credential_canonical_32_bytes",
    /^[A-Za-z0-9_-]{43}$/.test(c.secret) && Buffer.from(c.secret, "base64url").length === 32,
  );
  check(
    "database_stores_digest_not_secret",
    admin(
      `SELECT secret_digest=${lit(proof)} FROM morrow_identity.browser_session_generations WHERE id=${lit(c.generationId)};`,
    ) === "t",
  );
  check(
    "fixed_database_15_minute_non_sliding_lifetime",
    admin(
      `SELECT f.created_at=g.created_at AND f.expires_at=g.expires_at AND f.expires_at=f.created_at+interval '15 minutes' FROM morrow_identity.browser_session_families f JOIN morrow_identity.browser_session_generations g ON g.family_id=f.id WHERE f.id=${lit(c.familyId)};`,
    ) === "t",
  );
  check("no_legacy_session_or_grant_issued", count("sessions") === 0 && count("grants") === 0);
  const context = await identity(proof, first.f.workspace);
  check(
    "existing_read_boundary_resolves_new_family",
    context.actor.principalId === first.f.principal &&
      context.actor.workspaceId === first.f.workspace &&
      context.actor.membershipId === first.f.membership &&
      context.policyRevision === 1,
  );
  const repeat = await first.service.admit(first.e.handle, JSON.stringify(first.f.selector));
  check(
    "same_process_reentry_no_new_secret_or_connection",
    repeat.outcome === "held" && repeat.credential === null && first.pool.metrics.connections === 1,
  );
  const rec = await first.service.reconcile(
    JSON.stringify({ schemaVersion: 1, ...first.result.correlation }),
  );
  check(
    "read_only_reconcile_attribution_no_secret",
    rec.outcome === "replayed" &&
      rec.attribution.familyId === c.familyId &&
      !Object.hasOwn(rec.attribution, "secret"),
  );
  check(
    "exact_tuple_sql_replay_one_family",
    JSON.parse(exec(direct(first.tuple)).stdout.trim())[0].outcome === "replayed" &&
      count("browser_session_families") === 1,
  );
  const changed = [...first.tuple];
  changed[26] = randomUUID();
  changed[1] = hash(JSON.stringify(changed.filter((_, i) => i !== 1)));
  check(
    "changed_binding_same_command_conflicts",
    JSON.parse(exec(direct(changed)).stdout.trim())[0].outcome === "conflict",
  );
  const wrongRec = await first.service.reconcile(
    JSON.stringify({
      schemaVersion: 1,
      commandId: first.f.selector.commandId,
      requestDigest: hash("changed"),
    }),
  );
  check(
    "reconcile_changed_digest_no_attribution",
    wrongRec.outcome === "conflict" && wrongRec.attribution === null,
  );
  const f2 = { ...first.f, selector: { ...first.f.selector, commandId: randomUUID() } };
  const second = await admitted(f2);
  check(
    "fresh_evidence_independent_family_same_provider",
    second.result.outcome === "newly_admitted" &&
      second.result.credential.familyId !== c.familyId &&
      second.result.credential.providerBindingId === c.providerBindingId &&
      second.result.credential.secret !== c.secret,
  );
  check(
    "existing_family_lifetime_not_extended",
    admin(
      `SELECT floor(extract(epoch FROM expires_at)*1000)::text FROM morrow_identity.browser_session_families WHERE id=${lit(c.familyId)};`,
    ) === String(c.expiresAtMs),
  );
  // The same durable provider binding resolves independently selected memberships.
  const org2 = "second_org_" + first.f.n,
    ws2 = "second_ws_" + first.f.n,
    member2 = "second_member_" + first.f.n;
  admin(
    `INSERT INTO morrow_identity.organizations VALUES(${lit(org2)},'Synthetic',true,1);INSERT INTO morrow_identity.workspaces VALUES(${lit(ws2)},${lit(org2)},'Synthetic',true);INSERT INTO morrow_identity.memberships VALUES(${lit(member2)},${lit(org2)},${lit(first.f.principal)},true);INSERT INTO morrow_identity.workspace_memberships VALUES(${lit(org2)},${lit(ws2)},${lit(member2)},true);`,
  );
  check(
    "same_family_explicit_other_org_resolves",
    (await identity(proof, ws2)).actor.organizationId === org2,
  );
  check(
    "first_tab_not_retargeted_by_other_selection",
    (await identity(proof, first.f.workspace)).actor.organizationId === first.f.organization,
  );
  const foreign = fixture();
  check("foreign_workspace_denied", await deniedIdentity(proof, foreign.workspace));
  const otherAdmission = await admitted({
    ...first.f,
    organization: org2,
    workspace: ws2,
    membership: member2,
    selector: {
      ...first.f.selector,
      commandId: randomUUID(),
      workspaceId: ws2,
      membershipId: member2,
    },
  });
  check(
    "same_provider_second_org_admits_own_family",
    otherAdmission.result.outcome === "newly_admitted" &&
      otherAdmission.result.credential.providerBindingId === c.providerBindingId,
  );
  // Source-owned primitive/schema/owning-handle failures cannot reach PostgreSQL.
  const invalidPool = localBrowserSessionPool(id);
  pools.push(invalidPool);
  metrics.push(invalidPool.metrics);
  const invalid = createWorkosBrowserSessionAdmission({
    pool: invalidPool,
    readEvidence: first.e.owner.readEvidence,
    now: Date.now,
  });
  for (const [name, h, s] of [
    ["foreign_handle", {}, JSON.stringify(first.f.selector)],
    ["object_selector", first.e.handle, first.f.selector],
    ["unknown_selector", first.e.handle, JSON.stringify({ ...first.f.selector, authority: true })],
  ])
    check(
      name + "_zero_acquisition",
      (await invalid.admit(h, s)).outcome === "held" && invalidPool.metrics.connections === 0,
    );
  // Every current identity/revision intersection is checked again by SQL.
  for (const [name, mutation] of [
    [
      "profile",
      (f) =>
        `UPDATE morrow_identity.identity_verification_profiles SET state='inactive',record_revision=2 WHERE id=${lit(f.profile)};`,
    ],
    [
      "mapping",
      (f) =>
        `UPDATE morrow_identity.provider_subject_mappings SET state='inactive',record_revision=2 WHERE id=${lit(f.mapping)};`,
    ],
    [
      "binding",
      (f) =>
        `UPDATE morrow_identity.provider_subject_profile_bindings SET state='inactive',record_revision=2 WHERE mapping_id=${lit(f.mapping)};`,
    ],
    [
      "principal",
      (f) => `UPDATE morrow_identity.principals SET active=false WHERE id=${lit(f.principal)};`,
    ],
    [
      "organization",
      (f) =>
        `UPDATE morrow_identity.organizations SET active=false WHERE id=${lit(f.organization)};`,
    ],
    [
      "workspace",
      (f) => `UPDATE morrow_identity.workspaces SET active=false WHERE id=${lit(f.workspace)};`,
    ],
    [
      "membership",
      (f) => `UPDATE morrow_identity.memberships SET active=false WHERE id=${lit(f.membership)};`,
    ],
    [
      "workspace_membership",
      (f) =>
        `UPDATE morrow_identity.workspace_memberships SET active=false WHERE membership_id=${lit(f.membership)};`,
    ],
    [
      "policy_revision",
      (f) =>
        `UPDATE morrow_identity.organizations SET policy_revision=2 WHERE id=${lit(f.organization)};`,
    ],
  ]) {
    const f = fixture();
    admin(mutation(f));
    const a = await admitted(f);
    check(
      "admission_current_" + name + "_denied",
      a.result.outcome === "held" &&
        a.result.credential === null &&
        count("browser_session_families", `id=${lit(a.tuple[25])}`) === 0 &&
        count(
          "browser_session_commands",
          `command_id=${lit(f.selector.commandId)} AND outcome='denied'`,
        ) === 1,
    );
  }
  // Failures after COMMIT can reconcile the same durable result, never a bearer.
  for (const fault of ["commitAckLoss", "releaseAckLoss"]) {
    const a = await admitted(fixture(), { [fault]: true });
    check(
      fault + "_held_after_real_commit",
      a.result.outcome === "held" &&
        a.result.credential === null &&
        a.result.correlation !== null &&
        count(
          "browser_session_commands",
          `command_id=${lit(a.f.selector.commandId)} AND outcome='admitted'`,
        ) === 1,
    );
    const p = localBrowserSessionPool(id);
    pools.push(p);
    metrics.push(p.metrics);
    const s = createWorkosBrowserSessionAdmission({
      pool: p,
      readEvidence: () => null,
      now: Date.now,
    });
    const r = await s.reconcile(JSON.stringify({ schemaVersion: 1, ...a.result.correlation }));
    check(
      fault + "_readonly_reconciliation_no_reissue",
      r.outcome === "replayed" &&
        !Object.hasOwn(r.attribution, "secret") &&
        count("browser_session_families", `id=${lit(a.tuple[25])}`) === 1,
    );
  }
  // Immutable records and executor privileges keep revocation narrowly owner-only.
  for (const t of tableNames) {
    const r = exec(
      "SET ROLE morrow_identity_owner;\n" + `DELETE FROM morrow_identity.${t};`,
      "postgres",
      true,
    );
    check(
      t + "_immutable_delete",
      r.status !== 0 && r.stderr.includes("BROWSER_SESSION_RECORD_IMMUTABLE"),
    );
  }
  for (const fn of [
    "revoke_provider_binding",
    "revoke_browser_family",
    "revoke_browser_generation",
  ])
    for (const role of [
      "morrow_identity_sessions",
      "morrow_api",
      "morrow_identity_lifecycle",
      "morrow_identity_linking",
    ])
      check(
        role + "_cannot_" + fn,
        exec(
          `SELECT * FROM morrow_identity.${fn}(${lit(c.familyId)},${lit(randomUUID())},${lit(hash(fn))});`,
          role,
          true,
        ).status !== 0,
      );
  const revoke = (fn, target, command = randomUUID(), digest = hash(randomUUID())) =>
    JSON.parse(
      admin(
        jsonSQL(
          `SELECT * FROM morrow_identity.${fn}(${lit(target)},${lit(command)},${lit(digest)})`,
        ),
      ),
    )[0];
  for (const [kind, fn, key] of [
    ["generation", "revoke_browser_generation", "generationId"],
    ["family", "revoke_browser_family", "familyId"],
    ["provider", "revoke_provider_binding", "providerBindingId"],
  ]) {
    const f = fixture(),
      a = await admitted(f),
      cc = a.result.credential;
    check(kind + "_revocation_fixture_admitted", a.result.outcome === "newly_admitted");
    const cmd = randomUUID(),
      dg = hash(cmd),
      r = revoke(fn, cc[key], cmd, dg);
    check(kind + "_revocation_audited", r.outcome === "applied" && typeof r.audit_id === "string");
    check(
      kind + "_revocation_immediate_read_denial",
      await deniedIdentity(hash(cc.secret), f.workspace),
    );
    check(
      kind + "_revocation_replay_one_audit",
      revoke(fn, cc[key], cmd, dg).outcome === "replayed" &&
        count("browser_session_audits", `command_id=${lit(cmd)}`) === 1,
    );
    if (kind === "provider") {
      const again = await admitted({ ...f, selector: { ...f.selector, commandId: randomUUID() } });
      check(
        "revoked_provider_cannot_be_revived_by_fresh_evidence",
        again.result.outcome === "held" &&
          count("provider_session_bindings", `id=${lit(cc.providerBindingId)}`) === 1,
      );
    }
  }
  // Existing legacy uniqueness remains meaningful; an ambiguous digest always denies.
  admin(
    `INSERT INTO morrow_identity.sessions VALUES('legacy_collision',${lit(first.f.principal)},${lit(first.f.organization)},${lit(proof)},'workos','legacy_exact_sid',clock_timestamp()+interval '1 hour',NULL);`,
  );
  check("dual_representation_digest_denies_both", await deniedIdentity(proof, first.f.workspace));
  check(
    "legacy_provider_sid_uniqueness_preserved",
    exec(
      `SET ROLE morrow_identity_owner; INSERT INTO morrow_identity.sessions VALUES('legacy_duplicate',${lit(first.f.principal)},${lit(first.f.organization)},${lit(hash("legacy_second"))},'workos','legacy_exact_sid',clock_timestamp()+interval '1 hour',NULL);`,
      "postgres",
      true,
    ).stderr.includes("23505"),
  );
  await exerciseAdmission({
    id,
    sql,
    admin,
    exec,
    jsonSQL,
    fixture,
    evidenceFor,
    admitted,
    count,
    direct,
    identity,
    deniedIdentity,
    revoke,
    first,
    metrics,
  });
  // More full integration cases are defined below before cleanup.
  await exerciseWriters({
    fixture,
    admitted,
    admin,
    exec,
    identity,
    deniedIdentity,
    boundary,
    life,
    links,
    revoke,
    count,
    sql,
    id,
    jsonSQL,
  });
  const { faultMetrics } = await exerciseBrowserSessionSqlFaults({
    id,
    fixture,
    evidenceFor,
    check,
    hash,
    count,
    admin,
    sql,
    sqlConnection: () => sqlConnection(id),
  });
  for (const p of pools) {
    try {
      await p.close();
    } catch {
      if (
        !p.metrics ||
        p.metrics.closed !== p.metrics.connections ||
        p.metrics.backendCleanupVerified !== p.metrics.connections
      )
        throw Error("BROWSER_SESSION_CLEANUP_UNVERIFIED");
    }
  }
  check(
    "all_new_adapter_clients_closed_and_backends_absent",
    metrics.every(
      (m) =>
        m.connections === m.closed &&
        m.connections === m.released &&
        m.connections === m.backendCleanupVerified &&
        m.unverifiedHostClosures === 0,
    ),
  );
  check(
    "no_remaining_owned_session_backends",
    sql(
      "SELECT count(*) FROM pg_stat_activity WHERE datname='morrow' AND (usename IN ('morrow_identity_sessions','morrow_api','morrow_identity_lifecycle','morrow_identity_linking') OR application_name LIKE 'morrow_browser_session_%');",
      "morrow",
    ) === "0",
  );
  const privateDump =
    admin(
      "SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb)::text FROM morrow_identity.browser_session_commands t;",
    ) +
    admin(
      "SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb)::text FROM morrow_identity.browser_session_audits t;",
    );
  check(
    "no_raw_credentials_in_ledger_or_child_output",
    secrets.every(
      (s) =>
        !privateDump.includes(s) &&
        pools.every((p) => !JSON.stringify(p.observed ?? []).includes(s)),
    ),
  );
  return { image, version, adapterMetrics: metrics, faultMetrics };
});
check(
  "independent_owned_container_absence",
  ownedContainerId !== null &&
    containerCommand(["inspect", ownedContainerId], undefined, true).status !== 0,
);
for (const [p, d] of Object.entries(sources))
  check("source_unchanged_" + p, hash(readFileSync(p)) === d);
const report = {
  schemaVersion: 1,
  packet: "P05.T01m",
  executionSequence: plan.sequence,
  observedAt: new Date().toISOString(),
  scope:
    "Synthetic owning evidence and private local session persistence; no provider, browser, public issuer or live qualification.",
  realProviderRequests: 0,
  checks,
  passed: checks.length,
  sources,
  engine: result,
  containerRemoved: true,
  limitations: [
    "Owner-seeded synthetic identity and approval fixtures only.",
    "Positive admission uses independently signed owning76 evidence through the real application and SQL. Direct SQL race/guard fixtures derive trusted tuples and deliberately shorten leases; they do not claim a rewritten owning handle or relax the application one-second statement timeout.",
    "Normal adapter cleanup metrics are separate from intentional host-signal uncertainty. Fresh backend absence does not erase that uncertainty; the final exact-container fence is independently observed.",
    "Local socket executor LOGIN is enabled only inside the isolated lab.",
    "No cookie, refresh transport, production adapter or end-user revocation issuer.",
  ],
};
writeArtifact("labs/browser-session-admission.json", JSON.stringify(report, null, 2) + "\n");
console.log("PASS browser session admission PostgreSQL lab " + checks.length + " checks");
async function exerciseWriters(ctx) {
  const {
    fixture,
    admitted,
    admin,
    identity,
    deniedIdentity,
    boundary,
    life,
    links,
    revoke,
    count,
  } = ctx;
  const actor = (f) => ({
    kind: "human",
    principalId: f.principal,
    organizationId: f.organization,
    workspaceId: f.workspace,
    membershipId: f.membership,
    installationId: null,
    mandateId: null,
  });
  const resource = (f) => ({
    organizationId: f.organization,
    workspaceId: f.workspace,
    storeId: null,
    connectionId: null,
    kind: "workspace",
    id: f.workspace,
  });
  async function grant(f, capabilityId, verb, fields) {
    const a = actor(f),
      r = resource(f),
      g = {
        id: "grant_" + randomUUID(),
        principal: a,
        capabilityId,
        verbs: [verb],
        scope: {
          organizationId: f.organization,
          workspaceId: f.workspace,
          storeIds: [],
          accountIds: [],
          resources: [r],
          fields,
        },
        issuedBy: a,
        validFrom: "2020-01-01T00:00:00.000Z",
        expiresAt: null,
        revokedAt: null,
        policyRevision: 1,
      };
    check("grant_" + capabilityId + "_" + f.n + "_schema", validateDefinition("core", "Grant", g));
    const req = { capabilityId, verb, resource: r, accountId: null, fields };
    const pre = await createHumanPolicyService({
      readCurrent: async () => ({
        actor: a,
        policyRevision: 1,
        grantsRevision: 1,
        principalActive: true,
        organizationActive: true,
        workspaceActive: true,
        membershipActive: true,
        sessionCurrent: true,
        resource: r,
        accountId: null,
        providerAllowed: true,
        entitlementAllowed: true,
        grants: [g],
      }),
    }).decide(req);
    check(
      "grant_" + capabilityId + "_" + f.n + "_policy",
      pre.decision.allowed &&
        (capabilityId === "workspace.goal.create" || pre.obligations.includes("exact_approval")),
    );
    admin(
      `INSERT INTO morrow_identity.grants VALUES(${lit(g.id)},${lit(f.organization)},${lit(f.workspace)},${lit(f.membership)},${lit(f.principal)},${lit(JSON.stringify(g))}::jsonb);`,
    );
    return { g, req };
  }
  const f = fixture(),
    a = await admitted(f),
    digest = hash(a.result.credential.secret);
  const goal = await grant(f, "workspace.goal.create", "execute", ["objective"]);
  check(
    "new_session_shared_sql_policy_allows",
    (await boundary.decide(digest, f.workspace, goal.req)).decision.allowed,
  );
  admin(
    `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE id=${lit(goal.g.id)};`,
  );
  check(
    "current_grant_revocation_shared_policy_denies",
    !(await boundary.decide(digest, f.workspace, goal.req)).decision.allowed,
  );
  const r = fixture(),
    ar = await admitted(r),
    rd = hash(ar.result.credential.secret),
    rg = await grant(r, "governance.membership.revoke", "execute", [
      "membership",
      "session_revocation",
    ]);
  const receipt = randomUUID(),
    command = randomUUID(),
    request = hash(randomUUID());
  admin(
    `INSERT INTO morrow_identity.workspace_revocation_receipts(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,actor_session_digest,target_membership_id,command_id,request_digest,expected_policy_revision,authorizing_grant_id,authorizing_grant_snapshot,approval_evidence_id,expires_at) VALUES(${[receipt, r.organization, r.workspace, r.principal, r.membership, rd, r.membership, command, request].map(lit).join(",")},1,${lit(rg.g.id)},${lit(JSON.stringify(rg.g))}::jsonb,'synthetic_approval',clock_timestamp()+interval '1 hour');`,
  );
  const applied = await createWorkspaceAccessRevocations(life).apply({
    receiptId: receipt,
    commandId: command,
    requestDigest: request,
    sessionDigest: rd,
    organizationId: r.organization,
    workspaceId: r.workspace,
    targetMembershipId: r.membership,
    expectedRevision: 1,
  });
  check(
    "migration4_writer_accepts_current_new_session",
    applied.outcome === "applied" && applied.policyRevision === 2,
  );
  check("workspace_revocation_new_session_denies_read", await deniedIdentity(rd, r.workspace));
  check(
    "workspace_revoke_preserves_family_and_org_membership",
    count(
      "browser_session_families",
      `id=${lit(ar.result.credential.familyId)} AND revoked_at IS NULL`,
    ) === 1 &&
      admin(`SELECT active FROM morrow_identity.memberships WHERE id=${lit(r.membership)};`) ===
        "t",
  );
  // One unchanged credential remains separately eligible in another workspace.
  const other = "writer_other_" + r.n;
  admin(
    `INSERT INTO morrow_identity.workspaces VALUES(${lit(other)},${lit(r.organization)},'Synthetic other',true); INSERT INTO morrow_identity.workspace_memberships VALUES(${lit(r.organization)},${lit(other)},${lit(r.membership)},true);`,
  );
  check(
    "workspace_revocation_keeps_other_tab_eligible",
    (await identity(rd, other)).actor.workspaceId === other,
  );
  async function revocationFixture(legacy = false) {
    const f = fixture(),
      a = await admitted(f),
      digest = legacy ? hash(randomBytes(32)) : hash(a.result.credential.secret),
      gg = await grant(f, "governance.membership.revoke", "execute", [
        "membership",
        "session_revocation",
      ]);
    if (legacy)
      admin(
        `INSERT INTO morrow_identity.sessions VALUES(${lit("legacy_writer_" + f.n)},${lit(f.principal)},${lit(f.organization)},${lit(digest)},'workos',${lit("legacy_writer_sid_" + f.n)},clock_timestamp()+interval '1 hour',NULL);`,
      );
    const input = {
      receiptId: randomUUID(),
      commandId: randomUUID(),
      requestDigest: hash(randomUUID()),
      sessionDigest: digest,
      organizationId: f.organization,
      workspaceId: f.workspace,
      targetMembershipId: f.membership,
      expectedRevision: 1,
    };
    admin(
      `INSERT INTO morrow_identity.workspace_revocation_receipts(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,actor_session_digest,target_membership_id,command_id,request_digest,expected_policy_revision,authorizing_grant_id,authorizing_grant_snapshot,approval_evidence_id,expires_at) VALUES(${[input.receiptId, f.organization, f.workspace, f.principal, f.membership, digest, f.membership, input.commandId, input.requestDigest].map(lit).join(",")},1,${lit(gg.g.id)},${lit(JSON.stringify(gg.g))}::jsonb,'synthetic_approval',clock_timestamp()+interval '1 hour');`,
    );
    return { f, a, input };
  }
  async function linkingFixture(legacy = false) {
    const f = fixture(),
      a = await admitted(f),
      digest = legacy ? hash(randomBytes(32)) : hash(a.result.credential.secret),
      gg = await grant(f, "governance.connection.connect", "administer", [
        "providerId",
        "installationProof",
        "scope",
      ]),
      scope = gg.g.scope;
    if (legacy)
      admin(
        `INSERT INTO morrow_identity.sessions VALUES(${lit("legacy_writer_" + f.n)},${lit(f.principal)},${lit(f.organization)},${lit(digest)},'workos',${lit("legacy_writer_sid_" + f.n)},clock_timestamp()+interval '1 hour',NULL);`,
      );
    const candidate = "candidate_" + f.n,
      installation = "installation_" + f.n,
      proofPayload = {
        providerId: "shopify",
        applicationId: "synthetic_app",
        environmentId: "synthetic_env",
        shopId: "shop_" + f.n,
        installationId: installation,
        generation: 1,
        eligiblePrincipalId: f.principal,
      };
    const proof = {
        organizationId: f.organization,
        workspaceId: f.workspace,
        storeId: null,
        kind: "proof",
        id: "proof_" + f.n,
        revision: 1,
        digest: hash(canonicalize(proofPayload)),
      },
      scopeRef = {
        organizationId: f.organization,
        workspaceId: f.workspace,
        storeId: null,
        kind: "scope",
        id: "scope_" + f.n,
        revision: 1,
        digest: hash(canonicalize(scope)),
      },
      capabilityInput = { providerId: "shopify", installationProof: proof, scope: scopeRef };
    check(
      "link_fixture_" + f.n + "_closed_proof_scope_input",
      validateDefinition("core", "ProofRef", proof) &&
        validateDefinition("core", "Scope", scope) &&
        validateDefinition("core", "ScopeRef", scopeRef) &&
        validateCapabilityInput("governance.connection.connect", capabilityInput),
    );
    const input = {
      handoffId: randomUUID(),
      commandId: randomUUID(),
      requestDigest: "",
      sessionDigest: digest,
      nonceDigest: hash(randomUUID()),
      organizationId: f.organization,
      workspaceId: f.workspace,
      installationId: installation,
      purpose: "workspace_first",
      expectedPolicyRevision: 1,
      expectedOwnershipRevision: 1,
    };
    input.requestDigest = hash(
      canonicalize({
        operation: gg.req,
        capabilityInput,
        requestedScope: scope,
        actor: actor(f),
        sessionDigest: digest,
        nonceDigest: input.nonceDigest,
        organizationId: f.organization,
        workspaceId: f.workspace,
        installationId: installation,
        purpose: input.purpose,
        expectedPolicyRevision: 1,
        expectedOwnershipRevision: 1,
        commandId: input.commandId,
        handoffId: input.handoffId,
      }),
    );
    const review = "review_" + f.n;
    admin(`INSERT INTO morrow_identity.linking_candidates VALUES(${lit(candidate)},'shopify','synthetic_app','synthetic_env',${lit(proofPayload.shopId)},'synthetic-${f.n}.myshopify.com',${lit(installation)},1,true,1,'controlled_fixture',${lit(proof.id)},1,${lit(proof.digest)},${lit(f.principal)},clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour',NULL);
INSERT INTO morrow_identity.linking_reviews(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,session_digest,nonce_digest,handoff_id,candidate_id,installation_id,generation,command_id,request_digest,purpose,expected_policy_revision,expected_ownership_revision,proof_id,proof_revision,proof_digest,scope_snapshot,evidence_kind,created_at,expires_at) VALUES(${[review, f.organization, f.workspace, f.principal, f.membership, digest, input.nonceDigest, input.handoffId, candidate, installation].map(lit).join(",")},1,${lit(input.commandId)},${lit(input.requestDigest)},'workspace_first',1,1,${lit(proof.id)},1,${lit(proof.digest)},${lit(JSON.stringify(scope))}::jsonb,'controlled_review',clock_timestamp()-interval '1 second',clock_timestamp()+interval '300 seconds');
INSERT INTO morrow_identity.linking_handoffs(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,session_digest,nonce_digest,candidate_id,installation_id,generation,command_id,request_digest,purpose,expected_policy_revision,expected_ownership_revision,proof_id,proof_revision,proof_digest,review_id,authorizing_grant_id,authorizing_grant_snapshot,requested_scope_snapshot,created_at,expires_at) VALUES(${[input.handoffId, f.organization, f.workspace, f.principal, f.membership, digest, input.nonceDigest, candidate, installation].map(lit).join(",")},1,${lit(input.commandId)},${lit(input.requestDigest)},'workspace_first',1,1,${lit(proof.id)},1,${lit(proof.digest)},${lit(review)},${lit(gg.g.id)},${lit(JSON.stringify(gg.g))}::jsonb,${lit(JSON.stringify(scope))}::jsonb,clock_timestamp(),clock_timestamp()+interval '299 seconds');`);
    return { f, a, input, candidate, review, grant: gg.g };
  }
  const link = await linkingFixture(),
    linkService = createWorkspaceStoreLinks(links),
    lr = await linkService.apply(JSON.stringify(link.input));
  check(
    "migration5_writer_accepts_current_new_session",
    lr.outcome === "applied" &&
      lr.policyRevision === 2 &&
      lr.ownershipRevision === 2 &&
      count("workspace_store_links", `candidate_id=${lit(link.candidate)}`) === 1,
  );
  const replay = await linkService.apply(JSON.stringify(link.input));
  check(
    "migration5_exact_replay_original_result",
    replay.outcome === "applied" && replay.linkId === lr.linkId && replay.auditId === lr.auditId,
  );
  const changed = await linkService.apply(
    JSON.stringify({ ...link.input, nonceDigest: hash("different_nonce") }),
  );
  check(
    "migration5_changed_nonce_no_audit_or_authority",
    changed.outcome === "denied" && changed.auditId === null && changed.linkId === null,
  );
  // Both receipt writers must wait, then reread the common current session state.
  for (const writer of ["revocation", "linking"])
    for (const [kind, fn, key] of [
      ["provider", "revoke_provider_binding", "providerBindingId"],
      ["family", "revoke_browser_family", "familyId"],
      ["generation", "revoke_browser_generation", "generationId"],
    ]) {
      const fx = writer === "revocation" ? await revocationFixture() : await linkingFixture(),
        h = sqlConnection(ctx.id);
      let pending;
      try {
        const pid = Number(await h.query("SELECT pg_backend_pid();"));
        await h.query(
          `BEGIN; SET ROLE morrow_identity_owner; SELECT id FROM morrow_identity.organizations WHERE id=${lit(fx.f.organization)} FOR UPDATE;`,
        );
        pending =
          writer === "revocation"
            ? createWorkspaceAccessRevocations(life).apply(fx.input)
            : linkService.apply(JSON.stringify(fx.input));
        let blocked = false;
        const end = Date.now() + 3000;
        while (Date.now() < end) {
          blocked =
            ctx.sql(
              `SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.datname='morrow' AND a.usename=${lit(writer === "revocation" ? "morrow_identity_lifecycle" : "morrow_identity_linking")} AND ${pid}=ANY(pg_blocking_pids(a.pid)));`,
              "morrow",
            ) === "t";
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        check(writer + "_" + kind + "_actual_org_lock_wait", blocked);
        await h.query(
          `SELECT * FROM morrow_identity.${fn}(${lit(fx.a.result.credential[key])},${lit(randomUUID())},${lit(hash(randomUUID()))}); COMMIT;`,
        );
        const denied = await pending;
        check(
          writer + "_" + kind + "_revocation_during_wait_denies",
          denied.outcome === "denied" && denied.auditId !== null,
        );
        check(
          writer + "_" + kind + "_denial_no_effect",
          writer === "revocation"
            ? admin(
                `SELECT active FROM morrow_identity.workspace_memberships WHERE workspace_id=${lit(fx.f.workspace)};`,
              ) === "t"
            : count("workspace_store_links", `candidate_id=${lit(fx.candidate)}`) === 0,
        );
      } finally {
        await h.close();
        if (pending) await pending.catch(() => {});
      }
    }
  const badGrant = await linkingFixture();
  admin(
    `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE id=${lit(badGrant.grant.id)};`,
  );
  check(
    "migration5_existing_grant_guard_preserved",
    (await linkService.apply(JSON.stringify(badGrant.input))).outcome === "denied",
  );
  const badReview = await linkingFixture();
  admin(
    `UPDATE morrow_identity.linking_reviews SET revoked_at=clock_timestamp() WHERE id=${lit(badReview.review)};`,
  );
  check(
    "migration5_existing_review_guard_preserved",
    (await linkService.apply(JSON.stringify(badReview.input))).outcome === "denied",
  );
  for (const writer of ["revocation", "linking"])
    for (const revoked of [false, true]) {
      const fx =
        writer === "revocation" ? await revocationFixture(true) : await linkingFixture(true);
      check(
        "legacy_" + writer + "_" + revoked + "_read_before_change",
        (await identity(fx.input.sessionDigest, fx.f.workspace)).actor.principalId ===
          fx.f.principal,
      );
      if (revoked)
        admin(
          `UPDATE morrow_identity.sessions SET revoked_at=clock_timestamp() WHERE session_digest=${lit(fx.input.sessionDigest)};`,
        );
      const outcome =
        writer === "revocation"
          ? await createWorkspaceAccessRevocations(life).apply(fx.input)
          : await linkService.apply(JSON.stringify(fx.input));
      check(
        "legacy_" +
          writer +
          "_" +
          (revoked ? "revoked_denied" : "current_applied") +
          "_under_migration8",
        outcome.outcome === (revoked ? "denied" : "applied"),
      );
    }
}

async function exerciseAdmission(ctx) {
  const {
    id,
    sql,
    admin,
    exec,
    jsonSQL,
    fixture,
    evidenceFor,
    admitted,
    count,
    direct,
    identity,
    deniedIdentity,
    revoke,
    first,
  } = ctx;
  const tupleFor = async (f) => {
    const own = await evidenceFor(f),
      e = own.evidence,
      s = f.selector;
    const t = [
      s.commandId,
      "",
      e.providerId,
      e.environmentId,
      e.applicationId,
      e.clientId,
      e.issuer,
      String(e.tokenProfileRevision),
      e.tokenProfileDigest,
      e.subjectId,
      e.providerSessionId,
      s.workspaceId,
      String(e.issuedAtMs),
      String(e.observedAtMs),
      String(e.expiresAtMs),
      e.keySetDigest,
      e.observationProfileDigest,
      hash(randomBytes(32)),
      s.profileId,
      String(s.profileRecordRevision),
      s.mappingId,
      String(s.mappingRevision),
      String(s.bindingRevision),
      s.membershipId,
      String(s.policyRevision),
      randomUUID(),
      randomUUID(),
    ];
    t[1] = hash(JSON.stringify(t.filter((_, i) => i !== 1)));
    return t;
  };
  const rehash = (t) => {
    t[1] = hash(JSON.stringify(t.filter((_, i) => i !== 1)));
    return t;
  };
  const raw = async (c, t) => JSON.parse(await c.query(direct(t)))[0];
  // Exact tuple concurrency reaches independent backends, not an in-process cache.
  const f = fixture(),
    x = sqlConnection(id, "morrow_identity_sessions"),
    y = sqlConnection(id, "morrow_identity_sessions"),
    observer = sqlConnection(id);
  try {
    const [xp, yp] = await Promise.all([
      x.query("SELECT pg_backend_pid();"),
      y.query("SELECT pg_backend_pid();"),
    ]);
    await observer.query("SELECT 1;");
    const t = await tupleFor(f);
    await x.query("BEGIN;");
    const winner = await raw(x, t);
    const waiting = raw(y, t);
    let blocked = false;
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      blocked =
        (await observer.query(`SELECT ${Number(xp)}=ANY(pg_blocking_pids(${Number(yp)}));`)) ===
        "t";
      if (blocked) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    check("identical_command_contender_actual_database_wait", blocked);
    await x.query("COMMIT;");
    const both = [winner, await waiting];
    check(
      "concurrent_exact_command_one_admission_one_replay",
      both
        .map((r) => r.outcome)
        .sort()
        .join(",") === "newly_admitted,replayed" &&
        count("browser_session_families", `id=${lit(t[25])}`) === 1 &&
        count("browser_session_commands", `command_id=${lit(t[0])}`) === 1 &&
        count("browser_session_audits", `command_id=${lit(t[0])}`) === 1,
    );
    const a = await tupleFor({ ...f, selector: { ...f.selector, commandId: randomUUID() } }),
      b = await tupleFor({ ...f, selector: { ...f.selector, commandId: randomUUID() } });
    const independent = await Promise.all([raw(x, a), raw(y, b)]);
    check(
      "concurrent_distinct_families_reuse_one_provider_binding",
      independent.every((r) => r.outcome === "newly_admitted") &&
        independent[0].provider_binding_id === independent[1].provider_binding_id &&
        independent[0].family_id !== independent[1].family_id,
    );
  } finally {
    await x.close();
    await y.close();
    await observer.close();
  }
  // Environment and client are real namespace dimensions; app metadata cannot silently replace a binding.
  const base = fixture(),
    baseA = await admitted(base);
  const env = await admitted(fixture({ sid: base.sid }));
  check(
    "same_sid_different_environment_isolated",
    env.result.outcome === "newly_admitted" &&
      env.result.credential.providerBindingId !== baseA.result.credential.providerBindingId,
  );
  const client = await admitted(
    fixture({
      environment: base.environment,
      principal: base.principal,
      mapping: base.mapping,
      subject: base.subject,
      sid: base.sid,
    }),
  );
  check(
    "same_sid_different_client_isolated",
    client.result.outcome === "newly_admitted" &&
      client.result.credential.providerBindingId !== baseA.result.credential.providerBindingId,
  );
  const sibling = fixture({
      environment: base.environment,
      client: base.client,
      principal: base.principal,
      mapping: base.mapping,
      subject: base.subject,
      sid: base.sid,
    }),
    sb = await admitted(sibling);
  check(
    "same_client_sid_sibling_application_profile_denied",
    sb.result.outcome === "held" &&
      count("browser_session_families", `id=${lit(sb.tuple[25])}`) === 0,
  );
  for (const [name, lock, mutateTuple] of [
    [
      "foreign_organization",
      (q) =>
        `SELECT id FROM morrow_identity.organizations WHERE id=${lit(q.organization)} FOR UPDATE;`,
      (t, q) => {
        t[11] = q.workspace;
        t[23] = q.membership;
      },
    ],
    [
      "foreign_profile",
      (q) =>
        `SELECT id FROM morrow_identity.identity_verification_profiles WHERE id=${lit(q.profile)} FOR UPDATE;`,
      (t, q) => {
        t[18] = q.profile;
      },
    ],
  ]) {
    const own = fixture(),
      foreign = fixture(),
      holder = sqlConnection(id),
      consumer = sqlConnection(id, "morrow_identity_sessions");
    try {
      await consumer.query("SELECT 1;");
      await holder.query("BEGIN;SET ROLE morrow_identity_owner;" + lock(foreign));
      const t = await tupleFor(own);
      mutateTuple(t, foreign);
      rehash(t);
      const row = await raw(consumer, t);
      check(
        name + "_denies_while_foreign_lock_held",
        row.outcome === "denied" &&
          Object.values(row)
            .slice(1)
            .every((v) => v === null),
      );
      check(
        name + "_creates_no_family",
        count("browser_session_families", `id=${lit(t[25])}`) === 0,
      );
      await holder.query("ROLLBACK;");
    } finally {
      await holder.close();
      await consumer.close();
    }
  }
  // An actual row-lock witness precedes mutation/release. Current predicates are
  // checked after PostgreSQL's wait, independent of the Node scheduler's timing.
  for (const [name, lock, mutate] of [
    [
      "policy_revision",
      (f) =>
        `SELECT id FROM morrow_identity.organizations WHERE id=${lit(f.organization)} FOR UPDATE;`,
      (f) =>
        `UPDATE morrow_identity.organizations SET policy_revision=2 WHERE id=${lit(f.organization)};`,
    ],
    [
      "profile_revision",
      (f) =>
        `SELECT id FROM morrow_identity.identity_verification_profiles WHERE id=${lit(f.profile)} FOR UPDATE;`,
      (f) =>
        `UPDATE morrow_identity.identity_verification_profiles SET record_revision=2 WHERE id=${lit(f.profile)};`,
    ],
    [
      "mapping_revision",
      (f) =>
        `SELECT id FROM morrow_identity.provider_subject_mappings WHERE id=${lit(f.mapping)} FOR UPDATE;`,
      (f) =>
        `UPDATE morrow_identity.provider_subject_mappings SET record_revision=2 WHERE id=${lit(f.mapping)};`,
    ],
    [
      "allow_binding_revision",
      (f) =>
        `SELECT mapping_id FROM morrow_identity.provider_subject_profile_bindings WHERE mapping_id=${lit(f.mapping)} FOR UPDATE;`,
      (f) =>
        `UPDATE morrow_identity.provider_subject_profile_bindings SET record_revision=2 WHERE mapping_id=${lit(f.mapping)};`,
    ],
    [
      "membership",
      (f) => `SELECT id FROM morrow_identity.memberships WHERE id=${lit(f.membership)} FOR UPDATE;`,
      (f) => `UPDATE morrow_identity.memberships SET active=false WHERE id=${lit(f.membership)};`,
    ],
  ]) {
    const f = fixture(),
      holder = sqlConnection(id),
      consumer = sqlConnection(id, "morrow_identity_sessions"),
      observer = sqlConnection(id);
    let work;
    try {
      const [hp, cp] = await Promise.all([
        holder.query("SELECT pg_backend_pid();"),
        consumer.query("SELECT pg_backend_pid();"),
      ]);
      await observer.query("SELECT 1;");
      await holder.query("BEGIN;SET ROLE morrow_identity_owner;" + lock(f));
      const t = await tupleFor(f);
      work = raw(consumer, t);
      const end = Date.now() + 2000;
      let blocked = false;
      while (Date.now() < end) {
        blocked =
          (await observer.query(`SELECT ${Number(hp)}=ANY(pg_blocking_pids(${Number(cp)}));`)) ===
          "t";
        if (blocked) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      check(name + "_real_admission_lock_wait", blocked);
      await holder.query(mutate(f) + "COMMIT;");
      const row = await work;
      check(
        name + "_changed_during_wait_denied",
        row.outcome === "denied" && count("browser_session_families", `id=${lit(t[25])}`) === 0,
      );
    } finally {
      await holder.close();
      if (work) await work.catch(() => {});
      await consumer.close();
      await observer.close();
    }
  }
  // Warm all sessions before arming a two-second proof lease; only DB clock and
  // an exact blocked backend establish expiry ordering, never a sleep assertion.
  for (const waitKind of ["row", "unique"]) {
    const f = fixture(),
      holder = sqlConnection(id),
      consumer = sqlConnection(id, "morrow_identity_sessions"),
      observer = sqlConnection(id);
    let work;
    try {
      const [hp, cp] = await Promise.all([
        holder.query("SELECT pg_backend_pid();"),
        consumer.query("SELECT pg_backend_pid();"),
      ]);
      await observer.query("SELECT 1;");
      let unrelatedFamily = null;
      if (waitKind === "unique") {
        const unrelated = fixture(),
          pb = randomUUID();
        unrelatedFamily = randomUUID();
        admin(
          `INSERT INTO morrow_identity.provider_session_bindings(id,provider_id,environment_id,client_id,provider_session_id,mapping_id,profile_id,created_at) VALUES(${lit(pb)},'workos',${lit(unrelated.environment)},${lit(unrelated.client)},${lit(unrelated.sid)},${lit(unrelated.mapping)},${lit(unrelated.profile)},clock_timestamp()); INSERT INTO morrow_identity.browser_session_families(id,provider_binding_id,profile_record_revision,mapping_revision,binding_revision,created_at,expires_at) SELECT ${lit(unrelatedFamily)},${lit(pb)},1,1,1,t,t+interval '15 minutes' FROM (SELECT clock_timestamp() AS t) clock;`,
        );
      }
      const t = await tupleFor(f);
      if (waitKind === "row")
        await holder.query(
          `BEGIN;SET ROLE morrow_identity_owner;SELECT id FROM morrow_identity.organizations WHERE id=${lit(f.organization)} FOR UPDATE;`,
        );
      else {
        // The holder's FK parents are an unrelated committed family. The only
        // shared key is secret_digest, so this blocks inside generation INSERT,
        // after the consumer has passed its own identity/provider locks.
        await holder.query(
          `BEGIN;SET ROLE morrow_identity_owner;INSERT INTO morrow_identity.browser_session_generations(id,family_id,secret_digest,created_at,expires_at) SELECT ${lit(randomUUID())},id,${lit(t[17])},created_at,expires_at FROM morrow_identity.browser_session_families WHERE id=${lit(unrelatedFamily)};`,
        );
      }
      const now = Number(
        await observer.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text;"),
      );
      t[13] = String(now);
      t[14] = String(now + 2000);
      rehash(t);
      work = raw(consumer, t);
      let witnessed = false,
        expired = false;
      const end = Date.now() + 4000;
      while (Date.now() < end) {
        const state = await observer.query(
          `WITH facts AS MATERIALIZED (SELECT ${Number(hp)}=ANY(pg_blocking_pids(${Number(cp)})) AS blocked) SELECT blocked::text||'|'||(floor(extract(epoch FROM clock_timestamp())*1000)<${t[14]})::text FROM facts;`,
        );
        if (state === "true|true") {
          witnessed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      check(waitKind + "_wait_observed_before_database_evidence_expiry", witnessed);
      if (waitKind === "unique")
        check(
          "unique_wait_reaches_generation_insert_after_own_identity_locks",
          (await observer.query(
            `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${Number(cp)} AND relation='morrow_identity.browser_session_generations'::regclass AND mode='RowExclusiveLock' AND granted);`,
          )) === "t",
        );
      while (Date.now() < end) {
        expired =
          (await observer.query(
            `SELECT floor(extract(epoch FROM clock_timestamp())*1000)>=${t[14]};`,
          )) === "t";
        if (expired) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      check(waitKind + "_release_only_after_database_expiry", expired);
      await holder.query("ROLLBACK;");
      const row = await work;
      check(
        waitKind + "_late_expiry_denies_and_rolls_back_persistence",
        row.outcome === "denied" &&
          count("browser_session_families", `id=${lit(t[25])}`) === 0 &&
          count("provider_session_bindings", `profile_id=${lit(f.profile)}`) === 0 &&
          count(
            "browser_session_audits",
            `command_id=${lit(t[0])} AND reason='evidence_expired'`,
          ) === 1,
      );
    } finally {
      await holder.close();
      if (work) await work.catch(() => {});
      await consumer.close();
      await observer.close();
    }
  }
  // Owner fixtures expose immutable lifetime edges without advancing the real DB clock.
  for (const [kind, offset] of [
    ["expired", "-16 minutes"],
    ["future", "1 minute"],
  ]) {
    const f = fixture(),
      a = await admitted(f),
      cc = a.result.credential,
      fd = randomUUID(),
      gd = randomUUID(),
      digest = hash(randomBytes(32));
    admin(
      `INSERT INTO morrow_identity.browser_session_families(id,provider_binding_id,profile_record_revision,mapping_revision,binding_revision,created_at,expires_at) SELECT ${lit(fd)},${lit(cc.providerBindingId)},1,1,1,t,t+interval '15 minutes' FROM (SELECT clock_timestamp()+interval '${offset}' AS t) clock; INSERT INTO morrow_identity.browser_session_generations(id,family_id,secret_digest,created_at,expires_at) SELECT ${lit(gd)},id,${lit(digest)},created_at,expires_at FROM morrow_identity.browser_session_families WHERE id=${lit(fd)};`,
    );
    check(
      kind + "_immutable_family_not_current_authority",
      await deniedIdentity(digest, f.workspace),
    );
  }
  const future = fixture(),
    futurePb = randomUUID();
  admin(
    `INSERT INTO morrow_identity.provider_session_bindings(id,provider_id,environment_id,client_id,provider_session_id,mapping_id,profile_id,created_at) VALUES(${lit(futurePb)},'workos',${lit(future.environment)},${lit(future.client)},${lit(future.sid)},${lit(future.mapping)},${lit(future.profile)},clock_timestamp()+interval '1 minute');`,
  );
  const fa = await admitted(future);
  check(
    "future_provider_binding_cannot_admit_family",
    fa.result.outcome === "held" &&
      count("browser_session_families", `provider_binding_id=${lit(futurePb)}`) === 0,
  );
  for (const [table, key] of [
    ["provider_session_bindings", "id"],
    ["browser_session_families", "id"],
    ["browser_session_generations", "id"],
    ["browser_session_commands", "command_id"],
    ["browser_session_audits", "id"],
  ]) {
    const denied = exec(
      `SET ROLE morrow_identity_owner; UPDATE morrow_identity.${table} SET ${key}=${key};`,
      "postgres",
      true,
    );
    check(
      table + "_unaudited_update_immutable",
      denied.status !== 0 &&
        denied.stderr.includes(
          ["browser_session_commands", "browser_session_audits"].includes(table)
            ? "BROWSER_SESSION_RECORD_IMMUTABLE"
            : "BROWSER_SESSION_REVOCATION_INVALID",
        ),
    );
  }
  const trunc = exec(
    "SET ROLE morrow_identity_owner;TRUNCATE morrow_identity.provider_session_bindings,morrow_identity.browser_session_families,morrow_identity.browser_session_generations,morrow_identity.browser_session_commands,morrow_identity.browser_session_audits CASCADE;",
    "postgres",
    true,
  );
  check(
    "grouped_truncate_immutable",
    trunc.status !== 0 && trunc.stderr.includes("BROWSER_SESSION_RECORD_IMMUTABLE"),
  );
  const rollbackFixture = fixture();
  admin(
    `CREATE FUNCTION morrow_identity.synthetic_admission_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.command_id=${lit(rollbackFixture.selector.commandId)} THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END IF;RETURN NEW;END $$;CREATE TRIGGER synthetic_admission_audit_fault BEFORE INSERT ON morrow_identity.browser_session_audits FOR EACH ROW EXECUTE FUNCTION morrow_identity.synthetic_admission_audit_fault();`,
  );
  try {
    const failed = await admitted(rollbackFixture);
    check(
      "audit_failure_rolls_back_all_new_session_state",
      failed.result.outcome === "held" &&
        count(
          "browser_session_commands",
          `command_id=${lit(rollbackFixture.selector.commandId)}`,
        ) === 0 &&
        count("provider_session_bindings", `profile_id=${lit(rollbackFixture.profile)}`) === 0 &&
        count("browser_session_families", `id=${lit(failed.tuple[25])}`) === 0,
    );
  } finally {
    admin(
      "DROP TRIGGER synthetic_admission_audit_fault ON morrow_identity.browser_session_audits;DROP FUNCTION morrow_identity.synthetic_admission_audit_fault();",
    );
  }
  // Real query cancellation destroys its dedicated child and proves guest absence.
  const cancelledFixture = fixture(),
    cancel = new AbortController();
  const cancellation = await admitted(cancelledFixture, {
    signal: cancel.signal,
    beforeQuery: async (t) => {
      if (t === browserSessionAdmissionSql.admit) cancel.abort();
    },
  });
  check(
    "cancel_before_admit_held_no_persistence",
    cancellation.result.outcome === "held" &&
      count(
        "browser_session_commands",
        `command_id=${lit(cancelledFixture.selector.commandId)}`,
      ) === 0,
  );
  const stalled = await admitted(fixture(), { stallAdmission: true });
  check(
    "actual_statement_timeout_no_command_or_secret",
    stalled.result.outcome === "held" &&
      stalled.result.credential === null &&
      count("browser_session_commands", `command_id=${lit(stalled.f.selector.commandId)}`) === 0,
  );
  // Post-COMMIT evidence expiry cannot disclose a credential; attribution remains historical.
  const late = await admitted(fixture(), {
    afterQuery: async (t) => {
      if (t === browserSessionAdmissionSql.commit) await new Promise((r) => setTimeout(r, 5100));
    },
  });
  check(
    "postcommit_evidence_expiry_holds_secret",
    late.result.outcome === "held" &&
      late.result.credential === null &&
      count(
        "browser_session_commands",
        `command_id=${lit(late.f.selector.commandId)} AND outcome='admitted'`,
      ) === 1,
  );
}
