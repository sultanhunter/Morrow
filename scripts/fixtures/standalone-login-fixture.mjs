import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createStandaloneFixtureHarness,
  standaloneSqlLiteral as lit,
} from "../standalone-session-fixtures.mjs";
import { localLoginFlowSqlPool } from "../local-login-flow-sql.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
// The exact current manifest: 0001-0009 through the session harness, then this chain.
// A new migration must be added here, so every login and logout lab applies it.
const loginMigrationChain = Object.freeze([
  [10, "0010.login-flow-custody.sql"],
  [11, "0011.self-browser-family-logout.sql"],
  [12, "0012.login-protocol-v1.sql"],
]);
export const currentMigrationCount = 12;
export const loginControllerProtocol = "morrow-login-v1";
function qualifiedMigration(sequence) {
  const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
  const m = manifest.migrations[sequence - 1];
  const expected = loginMigrationChain.find(([n]) => n === sequence);
  if (
    manifest.migrations.length !== currentMigrationCount ||
    !expected ||
    m.sequence !== sequence ||
    m.file !== expected[1]
  )
    throw Error("LOGIN_FIXTURE_MIGRATION_UNQUALIFIED");
  const source = readFileSync("migrations/" + m.file, "utf8");
  if (hash(source) !== m.sha256) throw Error("LOGIN_FIXTURE_MIGRATION_UNQUALIFIED");
  return source;
}
// The retired controller protocol exactly as the applied 0010 bytes define it. Upgrade
// laboratories seed legacy rows with it; no current code or migration names it.
export function appliedLegacyLoginControllerProtocol() {
  const found =
    /controller_protocol text NOT NULL CHECK\(controller_protocol='([a-z0-9-]{1,64})'\)/.exec(
      qualifiedMigration(10),
    );
  if (!found || found[1] === loginControllerProtocol)
    throw Error("LOGIN_FIXTURE_MIGRATION_UNQUALIFIED");
  return found[1];
}
// Only fresh isolated laboratory databases. No real account/user material. By default
// every migration in the manifest is applied. `deferProtocolV1` stops after 0011, so an
// upgrade laboratory can seed legacy rows before it calls `applyProtocolV1()`.
export function createStandaloneLoginFixtureHarness(context, options = {}) {
  const sources = loginMigrationChain.map(([sequence]) => qualifiedMigration(sequence));
  const legacyProtocol = appliedLegacyLoginControllerProtocol();
  const h = createStandaloneFixtureHarness(context, 9);
  context.sql(readFileSync("infra/identity-login-role-prerequisites.sql", "utf8"), "morrow");
  h.admin(sources[0]);
  context.sql(readFileSync("infra/identity-logout-role-prerequisites.sql", "utf8"), "morrow");
  h.admin(sources[1]);
  let protocol = legacyProtocol;
  function applyProtocolV1() {
    if (protocol === loginControllerProtocol) throw Error("LOGIN_FIXTURE_PROTOCOL_V1_APPLIED");
    h.admin(sources[2]);
    protocol = loginControllerProtocol;
  }
  if (options.deferProtocolV1 !== true) applyProtocolV1();
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
      retentionTier = options.retentionTier ?? "development",
      controllerProtocol = options.controllerProtocol ?? protocol;
    const configurationJson = JSON.stringify({
      schemaVersion: 1,
      controllerProtocol,
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
        controllerProtocol,
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
      `INSERT INTO morrow_identity.authentication_bindings VALUES(${lit(bindingId)},${lit(f.environment)},${lit(f.client)},${lit(origin + "/auth/workos/callback")},'/',true);INSERT INTO morrow_identity.authentication_exchange_bindings VALUES(${lit(bindingId)},'workos',${lit(f.application)},1,true);INSERT INTO morrow_identity.login_controller_configurations VALUES(${lit(configurationDigest)},${lit(controllerProtocol)},${lit(origin)},${lit(retentionTier)},${lit(bindingId)},1,${lit(f.environment)},${lit(f.application)},${lit(f.client)},${lit(origin + "/auth/workos/callback")},'/',${lit(f.profile)},1,${lit(f.issuer)},1,${lit(hash(f.profileJson))});`,
    );
    return {
      f,
      origin,
      controllerProtocol,
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
    applyProtocolV1,
    legacyProtocol,
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
