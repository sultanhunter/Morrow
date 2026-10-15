// Scripts-only SQL69 bridge. An already claimed, source-bound run is required
// before allocation; this never issues a local identity or provider permission.
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { localAuthenticationExchangePool } from "./local-authentication-exchange-sql.mjs";
import {
  createAuthenticationExchangeAdmission,
  authenticationExchangeAdmissionSql,
} from "../packages/identity/src/authentication-exchange-admission.ts";
import { readWorkosAuthenticationOperatorRun } from "./workos-authentication-operator-input.mjs";

const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
const used = new WeakSet();
const frozenMigrations = [
  [
    "0001.identity-foundation.sql",
    "09e047173c39bff3d4ce1d0e16efeff3f423848f40e2c2e012ae6aa620d52491",
  ],
  ["0002.identity-grants.sql", "0d7561075037d354980a33ddd005688f5e73597011c5423f54c9ca9164f871a7"],
  [
    "0003.authentication-challenges.sql",
    "72acd69951b379bf1af2ac7731a6d00b3b8b674c00aa7ded49e49a3f1571c83f",
  ],
  [
    "0004.workspace-access-revocation.sql",
    "19f0d6e09079540020992c054719fe7e5c461c6e4e4b07d431e29d8274e8e038",
  ],
  [
    "0005.workspace-store-linking.sql",
    "e42e91b7cbb2de9c59591346212fb250aed0c8cdba6edb6bd787dcceda78de92",
  ],
  [
    "0006.authentication-exchange-admission.sql",
    "1f67f961c778ec6c67b9050b7c6290fe8a3c0072f1bc8126e974ee243fae6d87",
  ],
];
const failure = () => Error("WORKOS_AUTHENTICATION_OPERATOR_DATABASE_HELD");
const bounded = async (promise, milliseconds) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure()), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
export class WorkosAuthenticationOperatorDatabaseError extends Error {
  constructor(cleanup) {
    super("WORKOS_AUTHENTICATION_OPERATOR_DATABASE_HELD");
    this.name = "WorkosAuthenticationOperatorDatabaseError";
    this.cleanup = Object.freeze({ ...cleanup });
  }
}
function inputs(ownedRun) {
  const context = readWorkosAuthenticationOperatorRun(ownedRun);
  if (
    context.sourceRoot !== root ||
    realpathSync(process.cwd()) !== root ||
    context.current() !== true
  )
    throw failure();
  const manifest = JSON.parse(readFileSync(path.join(root, "migrations/manifest.json"), "utf8"));
  if (
    manifest.engine !== "postgresql17" ||
    !Array.isArray(manifest.migrations) ||
    manifest.migrations.length < 6
  )
    throw failure();
  const migrations = frozenMigrations.map(([file, digest], index) => {
    const record = manifest.migrations[index];
    const text = readFileSync(path.join(root, "migrations", file), "utf8");
    if (
      record.sequence !== index + 1 ||
      record.file !== file ||
      record.sha256 !== digest ||
      hash(text) !== digest
    )
      throw failure();
    return text;
  });
  const prerequisites = readFileSync(
    path.join(root, "infra/identity-role-prerequisites.sql"),
    "utf8",
  );
  const binding = JSON.parse(context.admissionBindingJson);
  // Run the existing closed binding validator before allocation, without opening
  // a SQL connection. The returned service is deliberately never used.
  createAuthenticationExchangeAdmission(
    {
      connect: async () => {
        throw failure();
      },
    },
    context.admissionBindingJson,
  );
  if (context.current() !== true) throw failure();
  return { context, binding, migrations, prerequisites };
}
export async function withWorkosAuthenticationOperatorDatabase(ownedRun, use) {
  const cleanup = {
    hostChildClosure: "unverified",
    backendNamespace: "unverified",
    containerFence: "unverified",
  };
  let ownedContainer = null,
    result,
    failed = false;
  try {
    const { context, binding, migrations, prerequisites } = inputs(ownedRun);
    if (typeof use !== "function" || used.has(ownedRun)) throw failure();
    used.add(ownedRun);
    result = await localPostgresLab("P05.T01l", async ({ id, sql, image, version }) => {
      ownedContainer = id;
      if (context.current() !== true) throw failure();
      sql("CREATE DATABASE morrow;");
      sql(prerequisites, "morrow");
      for (const text of migrations) sql("SET ROLE morrow_identity_owner;\n" + text, "morrow");
      sql(
        "SET ROLE morrow_identity_owner; INSERT INTO morrow_identity.authentication_bindings VALUES(" +
          [
            binding.bindingId,
            binding.environmentId,
            binding.clientId,
            binding.redirectUri,
            binding.returnPath,
          ]
            .map(literal)
            .join(",") +
          ",true); INSERT INTO morrow_identity.authentication_exchange_bindings VALUES(" +
          literal(binding.bindingId) +
          ",'workos'," +
          literal(binding.applicationId) +
          ",1,true);",
        "morrow",
      );
      sql("ALTER ROLE morrow_identity_preauth LOGIN;", "morrow");
      const pool = localAuthenticationExchangePool(id);
      const admission = createAuthenticationExchangeAdmission(pool, context.admissionBindingJson);
      let cleanupFault = null;
      const diagnostics =
        context.mode === "synthetic"
          ? Object.freeze({
              engine: Object.freeze({ image, version }),
              counts() {
                const value = JSON.parse(
                  sql(
                    "SELECT json_build_object('challenges',(SELECT count(*) FROM morrow_identity.authentication_challenges),'admissions',(SELECT count(*) FROM morrow_identity.authentication_exchange_admissions),'principals',(SELECT count(*) FROM morrow_identity.principals),'organizations',(SELECT count(*) FROM morrow_identity.organizations),'memberships',(SELECT count(*) FROM morrow_identity.memberships),'sessions',(SELECT count(*) FROM morrow_identity.sessions),'grants',(SELECT count(*) FROM morrow_identity.grants),'mappingInstalled',to_regclass('morrow_identity.provider_subject_mappings') IS NOT NULL);",
                    "morrow",
                  ),
                );
                if (
                  Object.keys(value).sort().join(",") !==
                    "admissions,challenges,grants,mappingInstalled,memberships,organizations,principals,sessions" ||
                  Object.entries(value).some(([key, number]) =>
                    key === "mappingInstalled"
                      ? typeof number !== "boolean"
                      : !Number.isSafeInteger(number) || number < 0,
                  )
                )
                  throw failure();
                return Object.freeze(value);
              },
              setBindingActive(active) {
                if (typeof active !== "boolean") throw failure();
                sql(
                  "SET ROLE morrow_identity_owner; UPDATE morrow_identity.authentication_exchange_bindings SET active=" +
                    (active ? "true" : "false") +
                    " WHERE binding_id=" +
                    literal(binding.bindingId) +
                    ";",
                  "morrow",
                );
              },
              admissionWithFault(kind) {
                if (!["commit_ack_loss", "release_ack_loss"].includes(kind)) throw failure();
                let fired = false;
                const facade = {
                  async connect() {
                    const client = await pool.connect();
                    let admitting = false,
                      committed = false;
                    return {
                      async query(text, values) {
                        if (text === authenticationExchangeAdmissionSql.admit) admitting = true;
                        const answer = await client.query(text, values);
                        if (text === authenticationExchangeAdmissionSql.commit && admitting) {
                          committed = true;
                          if (kind === "commit_ack_loss" && !fired) {
                            fired = true;
                            throw failure();
                          }
                        }
                        return answer;
                      },
                      release(discard) {
                        client.release(discard);
                        if (kind === "release_ack_loss" && committed && !fired) {
                          fired = true;
                          throw failure();
                        }
                      },
                    };
                  },
                };
                return createAuthenticationExchangeAdmission(facade, context.admissionBindingJson);
              },
              async injectCleanupFault(kind) {
                if (
                  cleanupFault !== null ||
                  !["host_child_signal", "backend_inspection_loss"].includes(kind)
                )
                  throw failure();
                cleanupFault = kind;
                if (kind === "host_child_signal") {
                  const client = await pool.connect();
                  await client.query(authenticationExchangeAdmissionSql.role);
                  // Actual owned Docker/psql host child signal. The legacy adapter
                  // cannot prove its exit mode or physical backend cleanup.
                  client.release(true);
                }
              },
              outputExcludes(values) {
                if (
                  !Array.isArray(values) ||
                  values.some((value) => typeof value !== "string" || !value.length)
                )
                  throw failure();
                const logs = containerCommand(["logs", id]);
                return values.every(
                  (value) =>
                    !logs.stdout.includes(value) &&
                    !logs.stderr.includes(value) &&
                    pool.observed.every(
                      (output) => !output.stdout.includes(value) && !output.stderr.includes(value),
                    ),
                );
              },
            })
          : undefined;
      try {
        if (context.current() !== true) throw failure();
        return await use(Object.freeze({ admission, ...(diagnostics ? { diagnostics } : {}) }));
      } finally {
        try {
          await bounded(pool.close(), 5000);
          if (cleanupFault !== "host_child_signal") cleanup.hostChildClosure = "observed";
        } catch {
          /* Retain unverified; the independent namespace/fence still run. */
        }
        try {
          if (cleanupFault === "backend_inspection_loss") throw failure();
          const count = sql(
            "SELECT count(*) FROM pg_stat_activity WHERE datname='morrow' AND usename='morrow_identity_preauth';",
            "morrow",
          );
          if (!/^(?:0|[1-9][0-9]*)$/.test(count)) throw failure();
          cleanup.backendNamespace = count === "0" ? "absent" : "present";
        } catch {
          /* Container cleanup remains independent of inspection. */
        }
      }
    });
  } catch {
    failed = true;
  } finally {
    if (ownedContainer) {
      try {
        const list = containerCommand([
          "ps",
          "-a",
          "--no-trunc",
          "--filter",
          "id=" + ownedContainer,
          "--format",
          "{{.ID}}",
        ]);
        if (list.stdout.trim() === "") cleanup.containerFence = "absent";
      } catch {
        /* Absence is not inferred from an attempted rm or failed read. */
      }
    }
  }
  if (failed) throw new WorkosAuthenticationOperatorDatabaseError(cleanup);
  return Object.freeze({ result, cleanup: Object.freeze({ ...cleanup }) });
}
