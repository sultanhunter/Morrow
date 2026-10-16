import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createStandaloneLoginFixtureHarness } from "./standalone-login-fixture.mjs";
import { localSelfLogoutSqlPool } from "../local-self-logout-sql.mjs";
export function createSelfLogoutFixtureHarness(context) {
  const h = createStandaloneLoginFixtureHarness(context);
  context.sql(readFileSync("infra/identity-logout-role-prerequisites.sql", "utf8"), "morrow");
  const migration = JSON.parse(readFileSync("migrations/manifest.json", "utf8")).migrations[10];
  const bytes = readFileSync("migrations/" + migration.file);
  if (
    migration.sequence !== 11 ||
    createHash("sha256").update(bytes).digest("hex") !== migration.sha256
  )
    throw Error("SELF_LOGOUT_FIXTURE_MIGRATION_UNQUALIFIED");
  h.admin(bytes.toString("utf8"));
  context.sql("ALTER ROLE morrow_identity_logout LOGIN;", "morrow");
  const logoutRolePools = [];
  return Object.freeze({
    ...h,
    logoutRolePools,
    logoutConfiguration(configured) {
      return JSON.stringify({
        schemaVersion: 1,
        protocol: "morrow-local-self-logout-85",
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
