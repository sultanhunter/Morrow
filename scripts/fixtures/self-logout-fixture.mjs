import { createStandaloneLoginFixtureHarness } from "./standalone-login-fixture.mjs";
import { localSelfLogoutSqlPool } from "../local-self-logout-sql.mjs";
// The login harness applies the exact current manifest, 0011 and the logout role
// prerequisites included; this harness adds only the logout executor and configuration.
export function createSelfLogoutFixtureHarness(context, options = {}) {
  const h = createStandaloneLoginFixtureHarness(context, options);
  context.sql("ALTER ROLE morrow_identity_logout LOGIN;", "morrow");
  const logoutRolePools = [];
  return Object.freeze({
    ...h,
    logoutRolePools,
    logoutConfiguration(configured) {
      return JSON.stringify({
        schemaVersion: 1,
        protocol: "morrow-self-logout-v1",
        origin: configured.origin,
        providerId: "workos",
        environmentId: configured.f.environment,
        applicationId: configured.f.application,
        clientId: configured.f.client,
        profileId: configured.f.profile,
      });
    },
    pool(role, statements, options = {}) {
      if (role !== "morrow_identity_logout") return h.pool(role, statements, options);
      const pool = localSelfLogoutSqlPool(context.id, role, statements, options);
      logoutRolePools.push(pool);
      return pool;
    },
    async close() {
      const replies = await Promise.allSettled([
        h.close(),
        ...logoutRolePools.map((pool) => pool.close()),
      ]);
      if (replies.some((reply) => reply.status !== "fulfilled"))
        throw Error("SELF_LOGOUT_FIXTURE_CLEANUP_UNVERIFIED");
    },
  });
}
