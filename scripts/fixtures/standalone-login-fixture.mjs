import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createStandaloneFixtureHarness,
  standaloneSqlLiteral as lit,
} from "../standalone-session-fixtures.mjs";
import { localLoginFlowSqlPool } from "../local-login-flow-sql.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
// Only fresh isolated laboratory databases. No real account/user material.
export function createStandaloneLoginFixtureHarness(context) {
  const h = createStandaloneFixtureHarness(context, 9);
  context.sql(readFileSync("infra/identity-login-role-prerequisites.sql", "utf8"), "morrow");
  const m = JSON.parse(readFileSync("migrations/manifest.json", "utf8")).migrations[9];
  const source = readFileSync("migrations/" + m.file, "utf8");
  if (m.sequence !== 10 || hash(source) !== m.sha256)
    throw Error("LOGIN_FIXTURE_MIGRATION_UNQUALIFIED");
  h.admin(source);
  context.sql(
    "ALTER ROLE morrow_identity_login LOGIN;ALTER ROLE morrow_identity_login_maintenance LOGIN;ALTER ROLE morrow_identity_preauth LOGIN;ALTER ROLE morrow_identity_resolution LOGIN;",
    "morrow",
  );
  function configured(options = {}) {
    const f = h.fixture(options),
      origin = options.origin ?? "https://localhost:4443",
      bindingId = "login_binding_" + f.n;
    const authenticationBindingJson = JSON.stringify({
      bindingId,
      bindingRevision: 1,
      environmentId: f.environment,
      applicationId: f.application,
      clientId: f.client,
      redirectUri: origin + "/auth/workos/callback",
      returnPath: "/",
    });
    const verificationProfileJson = f.profileJson,
      retentionTier = options.retentionTier ?? "development";
    const configurationJson = JSON.stringify({
      schemaVersion: 1,
      controllerProtocol: "morrow-local-login-84",
      origin,
      retentionTier,
      authenticationBindingJson,
      verificationProfileJson,
      profileId: f.profile,
      profileRecordRevision: 1,
    });
    const configurationDigest = hash(
      JSON.stringify([
        "morrow.login.configuration",
        "1",
        "morrow-local-login-84",
        origin,
        retentionTier,
        bindingId,
        "1",
        f.environment,
        f.application,
        f.client,
        origin + "/auth/workos/callback",
        "/",
        f.profile,
        "1",
        hash(verificationProfileJson),
      ]),
    );
    h.admin(
      `INSERT INTO morrow_identity.authentication_bindings VALUES(${lit(bindingId)},${lit(f.environment)},${lit(f.client)},${lit(origin + "/auth/workos/callback")},'/',true);INSERT INTO morrow_identity.authentication_exchange_bindings VALUES(${lit(bindingId)},'workos',${lit(f.application)},1,true);INSERT INTO morrow_identity.login_controller_configurations VALUES(${lit(configurationDigest)},'morrow-local-login-84',${lit(origin)},${lit(retentionTier)},${lit(bindingId)},1,${lit(f.environment)},${lit(f.application)},${lit(f.client)},${lit(origin + "/auth/workos/callback")},'/',${lit(f.profile)},1,${lit(f.issuer)},1,${lit(hash(f.profileJson))});`,
    );
    return {
      f,
      origin,
      bindingId,
      configurationJson,
      configurationDigest,
      authenticationBindingJson,
      verificationProfileJson,
    };
  }
  const rolePools = [];
  function pool(role, statements, options = {}) {
    const p = localLoginFlowSqlPool(context.id, role, statements, options);
    rolePools.push(p);
    return p;
  }
  return Object.freeze({
    ...h,
    configured,
    pool,
    rolePools,
    async close() {
      const results = await Promise.allSettled([h.close(), ...rolePools.map((p) => p.close())]);
      if (results.some((r) => r.status === "rejected"))
        throw Error("LOGIN_FIXTURE_CLEANUP_UNVERIFIED");
    },
  });
}
