import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { localBrowserSessionPool } from "./local-browser-session-sql.mjs";
import {
  createWorkosBrowserSessionAdmission,
  browserSessionAdmissionSql,
} from "../packages/identity/src/workos-browser-session-admission.ts";
import { createWorkosAuthenticationEvidence } from "../packages/identity/src/workos-authentication-evidence.ts";
import { buildWorkosAuthenticationEvidenceFixture } from "../tests/fixtures/workos-authentication-evidence.mjs";
const hash = (x) => createHash("sha256").update(x).digest("hex");
export const standaloneSqlLiteral = (x) => "'" + String(x).replaceAll("'", "''") + "'";
const lit = standaloneSqlLiteral;
const wid = (p, n) => p + "_" + String(n).padStart(26, "0");

// Owner-seeded synthetic identities only, in a freshly owned isolated database.
// Real provider reports/keys/tokens and merchant state are never inputs.
export function createStandaloneFixtureHarness({ id, sql }, migrationCount = 8) {
  if (![8, 9].includes(migrationCount)) throw Error("STANDALONE_FIXTURE_MIGRATIONS_INVALID");
  const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
  const migrations = manifest.migrations.slice(0, migrationCount);
  if (migrations.length !== migrationCount) throw Error("STANDALONE_FIXTURE_MIGRATIONS_MISSING");
  sql("CREATE DATABASE morrow;");
  sql(readFileSync("infra/identity-role-prerequisites.sql", "utf8"), "morrow");
  for (const [i, migration] of migrations.entries()) {
    const text = readFileSync("migrations/" + migration.file, "utf8");
    if (migration.sequence !== i + 1 || hash(text) !== migration.sha256)
      throw Error("STANDALONE_FIXTURE_MIGRATION_HASH");
    sql("SET ROLE morrow_identity_owner;\n" + text, "morrow");
  }
  sql(
    "ALTER ROLE morrow_identity_sessions LOGIN; ALTER ROLE morrow_api LOGIN; ALTER ROLE morrow_identity_linking LOGIN;",
    "morrow",
  );
  const admin = (text) => sql("SET ROLE morrow_identity_owner;\n" + text, "morrow");
  const pools = [],
    metrics = [],
    secrets = [];
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
    secrets.push(e.token);
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
  return Object.freeze({
    admin,
    fixture,
    admitted,
    evidenceFor,
    pools,
    metrics,
    secrets,
    async close() {
      await Promise.all(pools.map((p) => p.close()));
    },
  });
}
