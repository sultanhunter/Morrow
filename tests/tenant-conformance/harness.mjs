// Tenant-isolation conformance harness (P06.T01a §4.12, ADR-0010 item 2).
// Laboratory-only: an isolated network-none PostgreSQL 17 container, the full
// migration manifest applied once with `executeAs` and a fresh connection per
// migration (the P03.T04e lab fallback), owner-seeded synthetic fixtures, and a
// psql-backed WorkSqlConnector that logs in as morrow_api_worker exactly as the
// api Worker does. No provider, credential, host port or merchant data.
// The chain is applied by one of two administrators (ADR-0020, P04.T01j D7): the local
// superuser, as every other lab does, or "createrole", the hosted shape, in which a
// Neon-shaped non-superuser CREATEROLE login runs the prerequisites and applies each
// entry with the D4 runner protocol. Fixture seeding always uses the local superuser
// with SET ROLE, as scaffolding.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { localPostgresLab } from "../../scripts/local-postgres-lab.mjs";
import {
  applyChainAsAdministrator,
  createAdministrator,
} from "../../scripts/fixtures/createrole-administrator.mjs";
import { loadMigrationChain } from "../../scripts/migration-chain.mjs";
import { validateDefinition } from "../../packages/contracts/src/validation.ts";
import { workPermissions } from "../../packages/contracts/src/work-permissions.ts";

export const sha = (value) => createHash("sha256").update(value).digest("hex");
export const literal = (value) => {
  if (value === null || value === undefined) return "NULL";
  const text = String(value);
  if (text.includes("\0")) throw Error("HARNESS_LITERAL_NUL");
  return "'" + text.replaceAll("'", "''") + "'";
};
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Database lifecycle and the migration chain.

// The chain comes from scripts/migration-chain.mjs (P04.T01i D3): the manifest's own
// pinned prerequisites ({file, sha256}) and `executeAs`, verified by digest. The harness
// keeps no private file map. Each prerequisite runs once, before the first entry that
// pins it; every entry runs under its own `executeAs` on a fresh connection (the
// superuser "harness shape" of P04.T01j D4).
export function migrationPlan(chain = loadMigrationChain()) {
  const steps = [];
  for (const entry of chain) {
    for (const prerequisite of entry.prerequisites)
      steps.push(
        Object.freeze({ kind: "prerequisite", file: prerequisite.file, text: prerequisite.text }),
      );
    steps.push(
      Object.freeze({
        kind: "migration",
        sequence: entry.sequence,
        file: entry.file,
        executeAs: entry.executeAs,
        text: entry.text,
      }),
    );
  }
  return Object.freeze(steps);
}

// A fresh psql connection per call. The shared adapter's 10 s limit is too short
// for the larger migrations on a loaded host, so this one allows 60 s. Failures
// expose fixed codes only; callers may inspect stderr only with allowFailure.
export function psql(
  id,
  text,
  { user = "postgres", database = "morrow", allowFailure = false } = {},
) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error("HARNESS_CONTAINER_INVALID");
  const result = spawnSync(
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
      user,
      "-d",
      database,
    ],
    { encoding: "utf8", input: text, timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
  );
  const ok = !result.error && result.status === 0;
  if (allowFailure)
    return { ok, stdout: (result.stdout ?? "").trim(), stderr: result.stderr ?? "" };
  if (!ok) throw Error("HARNESS_SQL_FAILED");
  return result.stdout.trim();
}

// The same, without blocking the event loop: for statements that wait on a lock
// held by a paused request in this process. The application name identifies the
// backend in pg_stat_activity.
export function psqlAsync(
  id,
  text,
  { user = "postgres", database = "morrow", applicationName } = {},
) {
  if (!/^[a-f0-9]{64}$/.test(id)) return Promise.reject(Error("HARNESS_CONTAINER_INVALID"));
  return new Promise((resolve) => {
    const child = spawn(
      "docker",
      [
        "exec",
        ...(applicationName ? ["--env", "PGAPPNAME=" + applicationName] : []),
        "--interactive",
        id,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        user,
        "-d",
        database,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", () => {});
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

export function applyMigrationChain(
  id,
  { stopBefore = Infinity, administrator = "superuser" } = {},
) {
  if (administrator !== "superuser" && administrator !== "createrole")
    throw Error("HARNESS_ADMINISTRATOR_INVALID");
  // Both shapes read the one verified chain (P04.T01i D3): every migration and pinned
  // prerequisite digest is checked before any SQL runs.
  let chain;
  try {
    chain = loadMigrationChain();
  } catch {
    throw Error("HARNESS_MIGRATION_UNQUALIFIED");
  }
  if (administrator === "createrole") {
    createAdministrator(id, { bypassrls: false });
    return applyChainAsAdministrator(id, chain, { stopBefore });
  }
  psql(id, "CREATE DATABASE morrow;", { database: "morrow_lab" });
  const applied = [];
  for (const step of migrationPlan(chain.filter((entry) => entry.sequence < stopBefore))) {
    if (step.kind === "prerequisite") {
      psql(id, step.text);
      continue;
    }
    if (!/^morrow_[a-z]+_owner$/.test(step.executeAs)) throw Error("HARNESS_EXECUTE_AS_INVALID");
    // A fresh connection per migration: a SET ROLE before BEGIN is session-level.
    psql(id, "SET ROLE " + step.executeAs + ";\n" + step.text);
    applied.push(step.sequence);
  }
  return applied;
}

// Rows of a SELECT as parsed JSON objects, through a fresh connection.
export function jsonRows(id, query, options = {}) {
  const prefix = options.prefix ?? (options.role ? "SET ROLE " + options.role + ";\n" : "");
  const out = psql(
    id,
    prefix +
      "SELECT COALESCE(json_agg(row_to_json(work_lab_row)),'[]'::json)::text FROM (" +
      query +
      ") work_lab_row;" +
      (options.suffix ?? ""),
    options,
  );
  const line = out
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("["));
  return JSON.parse(line ?? "[]");
}

// ---------------------------------------------------------------------------
// A WorkSqlConnector over one psql process per connection, logged in as the api
// Worker's login. Each statement is sent with a unique end marker; SELECTs come
// back as JSON. Faults are injected by `hooks`, never by the code under test.
// Closing terminates the backend by its unique application_name and waits until
// PostgreSQL no longer lists it: host-side process closure alone proves nothing.
export function createLocalWorkConnector(id, hooks = {}) {
  const metrics = { opened: 0, closed: 0, statements: [] };
  const live = new Set();
  async function terminate(applicationName) {
    for (let i = 0; i < 100; i++) {
      const left = psql(
        id,
        "SELECT count(pg_terminate_backend(pid,2000)) FROM pg_stat_activity WHERE application_name=" +
          literal(applicationName) +
          ";\nSELECT count(*) FROM pg_stat_activity WHERE application_name=" +
          literal(applicationName) +
          ";",
        { allowFailure: true },
      );
      if (left.ok && left.stdout.split("\n").at(-1) === "0") return;
      await sleep(50);
    }
    throw Error("HARNESS_BACKEND_NOT_TERMINATED");
  }
  return {
    metrics,
    async open(control) {
      if (!control || !(control.signal instanceof AbortSignal) || control.signal.aborted)
        throw Error("HARNESS_OPEN_DENIED");
      if (hooks.beforeOpen) await hooks.beforeOpen(control);
      metrics.opened++;
      const applicationName = "morrow_work_lab_" + randomUUID().replaceAll("-", "");
      const child = spawn(
        "docker",
        [
          "exec",
          "--env",
          "PGAPPNAME=" + applicationName,
          "--interactive",
          id,
          "psql",
          "-X",
          "-qAt",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          hooks.user ?? "morrow_api_worker",
          "-d",
          "morrow",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let buffer = "",
        pending = null,
        ended = false,
        closing;
      const finished = new Promise((resolve) => child.once("close", resolve));
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.stderr.on("data", (chunk) => {
        // PostgreSQL error text is never reflected into reports; a test may only
        // assert on it through this explicit hook.
        hooks.stderr?.(String(chunk));
      });
      child.once("close", () => {
        ended = true;
        if (pending) {
          const p = pending;
          pending = null;
          p.reject(Error("HARNESS_SQL_UNAVAILABLE"));
        }
      });
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n");
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!pending) continue;
          if (line === pending.marker) {
            const p = pending;
            pending = null;
            p.resolve(p.lines);
          } else pending.lines.push(line);
        }
      });
      const send = (text) =>
        new Promise((resolve, reject) => {
          if (ended || pending) return reject(Error("HARNESS_SQL_UNAVAILABLE"));
          const marker = "WORK_LAB_END_" + randomUUID();
          pending = { marker, lines: [], resolve, reject };
          child.stdin.write(text + "\n\\echo " + marker + "\n");
        });
      const handle = { applicationName };
      live.add(handle);
      const destroy = () => {
        closing ??= (async () => {
          live.delete(handle);
          try {
            child.stdin.end();
          } catch {
            /* Fixed failure only. */
          }
          await terminate(applicationName);
          await Promise.race([finished, sleep(3000)]);
          if (!ended) child.kill("SIGKILL");
          metrics.closed++;
        })();
        return closing;
      };
      try {
        await send("SET standard_conforming_strings=on;");
      } catch {
        await destroy();
        throw Error("HARNESS_SQL_UNAVAILABLE");
      }
      const connection = {
        applicationName,
        async query(text, values, signal) {
          if (typeof text !== "string" || !Array.isArray(values)) throw Error("HARNESS_QUERY");
          if (!(signal instanceof AbortSignal) || signal.aborted) {
            await destroy();
            throw Error("HARNESS_SQL_UNAVAILABLE");
          }
          const record = { text, values: [...values] };
          metrics.statements.push(record);
          if (hooks.beforeQuery) await hooks.beforeQuery(record, connection);
          if (signal.aborted) {
            await destroy();
            throw Error("HARNESS_SQL_UNAVAILABLE");
          }
          const indexes = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
          if ((indexes.length ? Math.max(...indexes) : 0) !== values.length)
            throw Error("HARNESS_QUERY_ARITY");
          let sql;
          if (/^(SELECT|WITH)\b/.test(text)) {
            const wrapped =
              "SELECT COALESCE(json_agg(row_to_json(work_lab_row)),'[]'::json)::text FROM (" +
              text +
              ") work_lab_row";
            sql = values.length
              ? `PREPARE work_lab_q(${values.map(() => "text").join(",")}) AS ${wrapped};\nEXECUTE work_lab_q(${values.map(literal).join(",")});\nDEALLOCATE work_lab_q;`
              : wrapped + ";";
          } else {
            if (values.length) throw Error("HARNESS_QUERY_ARITY");
            sql = text + ";";
          }
          const abort = () => void destroy();
          signal.addEventListener("abort", abort, { once: true });
          let lines;
          try {
            lines = await send(sql);
          } finally {
            signal.removeEventListener("abort", abort);
          }
          const rows = lines.length ? JSON.parse(lines.join("\n")) : [];
          if (hooks.afterQuery) await hooks.afterQuery(record, connection, rows);
          return { rows };
        },
        // The statement executed but its reply is lost: the fault proxy of AC16.
        async loseReply() {
          await destroy();
          throw Error("HARNESS_REPLY_LOST");
        },
        close: destroy,
      };
      return connection;
    },
  };
}

// ---------------------------------------------------------------------------
// Owner-seeded synthetic fixtures (P06.T01a §6). Organization O has workspaces W
// and W2; organization O' (P) has W'. Grants pass both the 0002 CHECK and the
// v1 Grant validator; one grant per capability carries the union of its fields,
// as grant template v2 will issue them.
export const workFixtureOrigin = "https://work.morrow.test";
export function capabilityFields() {
  const fields = new Map();
  for (const rule of Object.values(workPermissions)) {
    const set = fields.get(rule.capabilityId) ?? new Set();
    for (const field of rule.fields) set.add(field);
    fields.set(rule.capabilityId, set);
  }
  return new Map([...fields].map(([capability, set]) => [capability, [...set].sort()]));
}
const allVerbs = ["view", "execute", "administer"];
export const fullWorkGrants = Object.freeze({
  "workspace.goal.create": allVerbs,
  "workspace.task.create": allVerbs,
  "workspace.task.assign": ["execute", "administer"],
  "workspace.question.request": allVerbs,
  "workspace.question.answer": ["execute", "administer"],
});
const viewGrants = {
  "workspace.goal.create": ["view"],
  "workspace.task.create": ["view"],
  "workspace.question.request": ["view"],
};
export const workFixturePrincipals = Object.freeze({
  // §6: A owner, A1, B, C, D, V, V2, E, X, Y.
  A: { org: "O", workspaces: ["W"], grants: fullWorkGrants },
  A1: {
    org: "O",
    workspaces: ["W"],
    grants: { "workspace.task.create": ["view", "execute"], "workspace.task.assign": ["execute"] },
  },
  B: {
    org: "O",
    workspaces: ["W"],
    grants: { ...viewGrants, "workspace.question.answer": ["execute"] },
  },
  C: { org: "O", workspaces: ["W"], grants: { "workspace.task.create": ["view", "execute"] } },
  D: { org: "O", workspaces: ["W"], grants: { "workspace.task.create": ["view", "administer"] } },
  V: { org: "O", workspaces: ["W"], grants: viewGrants },
  V2: {
    org: "O",
    workspaces: ["W"],
    grants: { "workspace.goal.create": ["view"] },
    omit: { "workspace.goal.create": ["successCriteria"] },
  },
  E: { org: "O", workspaces: ["W"], grants: viewGrants },
  X: { org: "O", workspaces: ["W"], grants: {} },
  Y: { org: "P", workspaces: ["WP"], grants: fullWorkGrants },
  // Laboratory additions: A2 is a member of W2 only (foreign-workspace records and
  // the "member of W2 only" assignee); R and S are disposable owners for the
  // revocation and outbox cases, so the shared fixtures above stay current.
  A2: { org: "O", workspaces: ["W2"], grants: fullWorkGrants },
  R: { org: "O", workspaces: ["W"], grants: fullWorkGrants },
  S: { org: "O", workspaces: ["W"], grants: fullWorkGrants },
});
export const workFixtureTenants = Object.freeze({
  O: { id: "org_o", workspaces: { W: "ws_w", W2: "ws_w2" } },
  P: { id: "org_p", workspaces: { WP: "ws_wp" } },
});
export const workspaceResource = (org, ws) => ({
  organizationId: org,
  workspaceId: ws,
  storeId: null,
  connectionId: null,
  kind: "workspace",
  id: ws,
});
export function fixtureActor(p) {
  return {
    kind: "human",
    principalId: p.principal,
    organizationId: p.org,
    workspaceId: p.workspace,
    membershipId: p.membership,
    installationId: null,
    mandateId: null,
  };
}
export function fixtureGrant(p, capabilityId, verbs, fields, overrides = {}) {
  const grant = {
    id: "grant_" + p.key.toLowerCase() + "_" + capabilityId.split(".").slice(1).join("_"),
    principal: fixtureActor(p),
    capabilityId,
    verbs,
    scope: {
      organizationId: p.org,
      workspaceId: p.workspace,
      storeIds: [],
      accountIds: [],
      resources: [workspaceResource(p.org, p.workspace)],
      fields,
    },
    issuedBy: fixtureActor(p),
    validFrom: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
    ...overrides,
  };
  if (!validateDefinition("core", "Grant", grant)) throw Error("HARNESS_GRANT_INVALID");
  return grant;
}
export function grantInsert(p, grant) {
  return `INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload) VALUES(${literal(grant.id)},${literal(p.org)},${literal(p.workspace)},${literal(p.membership)},${literal(p.principal)},${literal(JSON.stringify(grant))}::jsonb);`;
}
export function seedWorkFixtures(context) {
  const fields = capabilityFields();
  const statements = [];
  for (const [key, tenant] of Object.entries(workFixtureTenants)) {
    statements.push(
      `INSERT INTO morrow_identity.organizations VALUES(${literal(tenant.id)},${literal("Synthetic " + key)},true,1);`,
    );
    for (const ws of Object.values(tenant.workspaces))
      statements.push(
        `INSERT INTO morrow_identity.workspaces VALUES(${literal(ws)},${literal(tenant.id)},'Synthetic',true);`,
      );
  }
  const principals = {};
  for (const [key, spec] of Object.entries(workFixturePrincipals)) {
    const tenant = workFixtureTenants[spec.org];
    const secret = createHash("sha256").update(randomUUID()).digest().toString("base64url");
    const p = {
      key,
      principal: "person_" + key.toLowerCase(),
      membership: "membership_" + key.toLowerCase(),
      org: tenant.id,
      workspace: tenant.workspaces[spec.workspaces[0]],
      secret,
      digest: sha(secret),
      grants: [],
    };
    principals[key] = p;
    statements.push(
      `INSERT INTO morrow_identity.principals VALUES(${literal(p.principal)},'human',true);`,
      `INSERT INTO morrow_identity.memberships VALUES(${literal(p.membership)},${literal(p.org)},${literal(p.principal)},true);`,
      `INSERT INTO morrow_identity.sessions VALUES(${literal("session_" + key.toLowerCase())},${literal(p.principal)},${literal(p.org)},${literal(p.digest)},'workos',${literal("provider_session_" + key.toLowerCase())},clock_timestamp()+interval '1 day',NULL);`,
    );
    for (const ws of spec.workspaces)
      statements.push(
        `INSERT INTO morrow_identity.workspace_memberships VALUES(${literal(p.org)},${literal(tenant.workspaces[ws])},${literal(p.membership)},true);`,
      );
    for (const [capability, verbs] of Object.entries(spec.grants)) {
      const omit = spec.omit?.[capability] ?? [];
      const grant = fixtureGrant(
        p,
        capability,
        verbs,
        fields.get(capability).filter((field) => !omit.includes(field)),
      );
      p.grants.push(grant);
      statements.push(grantInsert(p, grant));
    }
  }
  context.admin(statements.join("\n"));
  return Object.freeze(principals);
}

// M2 PR-2's store installation of one workspace, as superuser fixture SQL (M3 PR-1 labs):
// the app registry row inviting exactly that workspace, the StoreInstallation@1 row (born
// unlinked, as 0026 requires), and with `link` the 0005 candidate and link and the
// installation's unlinked -> linked change. morrow_identity.work_store_installations reads
// exactly these rows: the store is current once linked. Synthetic development shops only;
// the shop id is derived from the store id, so each store needs its own id.
export function storeInstallationSql({
  org,
  workspace,
  principal,
  storeId,
  connectionId,
  installationId,
  link = true,
}) {
  const key = storeId.toLowerCase().replaceAll("_", "-").replaceAll(".", "-").replaceAll(":", "-");
  const app = ("lab-" + key).slice(0, 63);
  const shop = (app + ".myshopify.com").slice(0, 255);
  const shopId = String(BigInt("0x" + sha(storeId).slice(0, 12)) + 1n);
  const at = "date_trunc('milliseconds',clock_timestamp())";
  const statements = [
    `INSERT INTO morrow_identity.shopify_apps(app_key,client_id,environment_id,intended_shop_digest,invited_organization_id,invited_workspace_id,scopes,api_version,install_url,status,revision,created_at,retired_at)
 VALUES(${literal(app)},md5(${literal(storeId)}),'development',${literal(sha(shop))},${literal(org)},${literal(workspace)},'read_products,write_products','2026-10',${literal("https://" + shop + "/admin/oauth/install_custom_app")},'active',1,${at},NULL);`,
    `INSERT INTO morrow_identity.store_installations(organization_id,workspace_id,id,app_key,shop_id,shop_domain,store_id,connection_id,generation,status,granted_scopes,credential_id,credential_version,development_store,link_id,revision,created_at,updated_at,reauthorised_at,linked_at)
 SELECT ${literal(org)},${literal(workspace)},${literal(installationId)},${literal(app)},${literal(shopId)},${literal(shop)},${literal(storeId)},${literal(connectionId)},1,'unlinked',ARRAY['read_products','write_products'],${literal("credential_" + installationId)},1,true,NULL,1,t,t,NULL,NULL FROM (SELECT ${at}-interval '2 seconds' AS t) x;`,
  ];
  if (link)
    statements.push(
      `INSERT INTO morrow_identity.linking_candidates VALUES(${literal("cand_" + installationId)},'shopify','synthetic_app','synthetic_env',${literal(shopId)},${literal(shop)},${literal(installationId)},1,true,1,'controlled_fixture',${literal("proof_" + installationId)},1,${literal(sha(installationId))},${literal(principal)},clock_timestamp()-interval '2 seconds',clock_timestamp()+interval '1 hour',NULL);`,
      `INSERT INTO morrow_identity.workspace_store_links VALUES(${literal("link_" + installationId)},${literal("cand_" + installationId)},${literal(org)},${literal(workspace)},${literal(installationId)},1,1,${literal(principal)},clock_timestamp()-interval '1 second');`,
      `UPDATE morrow_identity.store_installations SET status='linked',link_id=${literal("link_" + installationId)},linked_at=greatest(${at}-interval '1 second',created_at),updated_at=greatest(${at}-interval '1 second',created_at),revision=revision+1 WHERE id=${literal(installationId)};`,
    );
  return statements.join("\n");
}

// The 0004 revocation's effect and lock order, as owner maintenance: the
// organization interlock (0014) and the organization FOR UPDATE, the workspace
// membership deactivated, the member's grants marked revoked and the policy
// revision bumped. `restore` undoes it with a further revision bump, so a
// fixture can be reused.
export const organizationInterlockSql = (org) =>
  `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization',${literal(org)}::text)::text,0));`;
export function revocationSql(p) {
  return `BEGIN; SET LOCAL ROLE morrow_identity_owner;
${organizationInterlockSql(p.org)}
SELECT 1 FROM morrow_identity.organizations WHERE id=${literal(p.org)} FOR UPDATE;
UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id=${literal(p.workspace)} AND membership_id=${literal(p.membership)};
UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE membership_id=${literal(p.membership)} AND payload->'revokedAt'='null'::jsonb;
UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id=${literal(p.org)};
COMMIT;`;
}
export function restoreSql(p) {
  return `BEGIN; SET LOCAL ROLE morrow_identity_owner;
${organizationInterlockSql(p.org)}
SELECT 1 FROM morrow_identity.organizations WHERE id=${literal(p.org)} FOR UPDATE;
UPDATE morrow_identity.workspace_memberships SET active=true WHERE workspace_id=${literal(p.workspace)} AND membership_id=${literal(p.membership)};
UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}','null'::jsonb) WHERE membership_id=${literal(p.membership)};
UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id=${literal(p.org)};
COMMIT;`;
}

// SQL inside a principal's own tenant context with TypeScript bypassed: the api
// login, the fixed prologue and enter_context, then the caller's statements.
export function asApi(p, statements, options = {}) {
  return `BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE; SET LOCAL ROLE morrow_work_api;
SELECT count(*) FROM morrow_work.enter_context(${literal(options.digest ?? p.digest)},${literal(options.workspace ?? p.workspace)});
${statements}
${options.end ?? "ROLLBACK"};`;
}
// The command role with a principal's tenant context but no TypeScript or API
// function: direct table writes, for the WITH CHECK and CHECK probes.
export function asCommandRole(p, statements, options = {}) {
  return `BEGIN; SELECT set_config('morrow.work_session_digest',${literal(p.digest)},true),set_config('morrow.work_workspace',${literal(p.workspace)},true);
SET LOCAL ROLE morrow_work_command;
${statements}
${options.end ?? "ROLLBACK"};`;
}

// A browser-shaped request from a fixture principal.
export function workRequest(p, method, path, body, options = {}) {
  const headers = {
    Cookie: "__Host-morrow_session=" + (options.secret ?? p.secret),
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  };
  if (method === "POST") {
    headers.Origin = workFixtureOrigin;
    headers["Content-Type"] = "application/json";
    headers["X-Morrow-Request"] = "1";
    headers["Idempotency-Key"] = options.key ?? randomUUID();
  }
  Object.assign(headers, options.headers ?? {});
  for (const [name, value] of Object.entries(headers)) if (value === null) delete headers[name];
  return new Request(
    workFixtureOrigin + "/workspace/" + (options.workspace ?? p.workspace) + "/work" + path,
    {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

export async function withWorkDatabase(packet, use, options = {}) {
  return localPostgresLab(packet, async (engine) => {
    const applied = applyMigrationChain(engine.id, options);
    const run = (text, opts) => psql(engine.id, text, opts);
    const context = Object.freeze({
      ...engine,
      applied,
      administrator: options.administrator ?? "superuser",
      sql: run,
      tryRun: (text, opts = {}) => psql(engine.id, text, { ...opts, allowFailure: true }),
      runAsync: (text, opts) => psqlAsync(engine.id, text, opts),
      // Polls until a backend matching the SQL predicate waits on a lock.
      async waitForLockWait(where, timeoutMs = 20000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const r = await psqlAsync(
            engine.id,
            "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND (" +
              where +
              ");",
          );
          if (r.ok && Number(r.stdout.split("\n").at(-1)) > 0) return true;
          await sleep(25);
        }
        return false;
      },
      admin: (text) => psql(engine.id, "SET ROLE morrow_identity_owner;\n" + text),
      workOwner: (text) => psql(engine.id, "SET ROLE morrow_work_owner;\n" + text),
      rows: (query, opts) => jsonRows(engine.id, query, opts),
      connector: (hooks) => createLocalWorkConnector(engine.id, hooks),
      logs: () => {
        const result = spawnSync("docker", ["logs", engine.id], {
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 64 * 1024 * 1024,
        });
        return (result.stdout ?? "") + (result.stderr ?? "");
      },
    });
    return use(context);
  });
}
