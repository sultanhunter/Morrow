import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createStandaloneFixtureHarness,
  standaloneSqlLiteral as lit,
} from "../standalone-session-fixtures.mjs";
import { localLoginFlowSqlPool } from "../local-login-flow-sql.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
// 0001-0009 through the session harness, then this chain; each entry is checked by
// sequence, file and sha256. Later manifest entries are not applied here: the shared
// harness planned in P03.T04e applies the whole manifest and honours `executeAs`.
// 0013 (account onboarding) is applied only when a laboratory opts in.
const loginMigrationChain = Object.freeze([
  [10, "0010.login-flow-custody.sql"],
  [11, "0011.self-browser-family-logout.sql"],
  [12, "0012.login-protocol-v1.sql"],
  [13, "0013.account-onboarding.sql"],
]);
export const loginControllerProtocol = "morrow-login-v1";
function qualifiedMigration(sequence) {
  const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
  const m = manifest.migrations[sequence - 1];
  const expected = loginMigrationChain.find(([n]) => n === sequence);
  if (!expected || m?.sequence !== sequence || m.file !== expected[1])
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
// 0001-0012 are applied. `deferProtocolV1` stops after 0011, so an upgrade laboratory
// can seed legacy rows before it calls `applyProtocolV1()`. `accountOnboarding` also
// applies the onboarding role prerequisite and 0013, then enables that executor's
// local LOGIN; account login, enrollment and signup need it.
export function createStandaloneLoginFixtureHarness(context, options = {}) {
  const sources = [10, 11, 12].map((sequence) => qualifiedMigration(sequence));
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
  let accountOnboarding = false;
  function applyAccountOnboarding() {
    if (accountOnboarding || protocol !== loginControllerProtocol)
      throw Error("LOGIN_FIXTURE_ACCOUNT_ONBOARDING_ORDER");
    context.sql(readFileSync("infra/identity-onboarding-role-prerequisites.sql", "utf8"), "morrow");
    h.admin(qualifiedMigration(13));
    context.sql("ALTER ROLE morrow_identity_onboarding LOGIN;", "morrow");
    accountOnboarding = true;
  }
  if (options.accountOnboarding === true) applyAccountOnboarding();
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
    applyAccountOnboarding,
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
