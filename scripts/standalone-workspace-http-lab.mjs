// Actual loopback HTTP and isolated PostgreSQL; synthetic owning evidence only.
import { createServer, request as httpRequest } from "node:http";
import { connect as connectSocket } from "node:net";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createWorkspaceHttpListener } from "../apps/api/src/workspace-http.ts";
import { createStandaloneWorkspaceBootstrap } from "../packages/identity/src/standalone-workspace-bootstrap.ts";
import { identitySql } from "../packages/identity/src/index.ts";
import { browserSessionAdmissionSql } from "../packages/identity/src/workos-browser-session-admission.ts";
import {
  createStandaloneFixtureHarness,
  standaloneSqlLiteral as lit,
} from "./standalone-session-fixtures.mjs";
import { localStandaloneSqlPool } from "./local-standalone-sql.mjs";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const checks = [];
function check(name, value) {
  if (!/^[a-z][a-z0-9_]{1,119}$/.test(name) || !value || checks.some((x) => x.name === name))
    throw Error("STANDALONE_HTTP_LAB_FAILED:" + name);
  checks.push({ name, passed: true });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(20);
  }
  return false;
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const paths = [
  "scripts/standalone-workspace-http-lab.mjs",
  "scripts/standalone-session-fixtures.mjs",
  "scripts/local-standalone-sql.mjs",
  "scripts/local-browser-session-sql.mjs",
  "scripts/local-postgres-lab.mjs",
  "apps/api/src/workspace-http.ts",
  "packages/identity/src/standalone-request-guard.ts",
  "packages/identity/src/standalone-workspace-bootstrap.ts",
  "packages/identity/src/index.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/workos-authentication-evidence.ts",
  "packages/identity/src/workos-session-token.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/contracts/src/validation.ts",
  "packages/contracts/src/generated/runtime-validators.mjs",
  "tests/fixtures/workos-authentication-evidence.mjs",
  "infra/identity-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  "docs/plan/source.json",
  "docs/packets/P05.T01q.md",
  "docs/packets/P05.T01r.md",
  "docs/packets/P05.T01s.md",
  "docs/packets/P05.T01t.md",
  "docs/plan/build-plan.md",
  "docs/packets/P05.T01o.md",
  ".nvmrc",
  "package.json",
  "package-lock.json",
  "packages/identity/package.json",
  "packages/contracts/package.json",
  "tsconfig.base.json",
];
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
for (const [index, migration] of manifest.migrations.slice(0, 8).entries()) {
  if (
    migration.sequence !== index + 1 ||
    hash(readFileSync("migrations/" + migration.file)) !== migration.sha256
  )
    throw Error("STANDALONE_HTTP_MIGRATION_BINDING");
  paths.push("migrations/" + migration.file);
}
if (manifest.migrations.length < 8) throw Error("STANDALONE_HTTP_EIGHT_MIGRATIONS_REQUIRED");
const plan = JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan;
if (
  process.version !== "v24.13.0" ||
  plan.sequence < 89 ||
  plan.sha256 !== hash(readFileSync(plan.path))
)
  throw Error("STANDALONE_HTTP_SOURCE_REQUIRED");
const sources = Object.fromEntries(paths.map((path) => [path, hash(readFileSync(path))]));
const engineProfile = JSON.parse(readFileSync("infra/local-engine.json", "utf8"));
if (!/^postgres@sha256:[a-f0-9]{64}$/.test(engineProfile.image))
  throw Error("STANDALONE_HTTP_PINNED_IMAGE_REQUIRED");
const prewarmName = "morrow-o83-prewarm-" + randomUUID();
let prewarmAbsent = false;
try {
  // A real bounded container command wakes the VM; docker info does not.
  const warm = spawnSync(
    "docker",
    [
      "run",
      "--name",
      prewarmName,
      "--rm",
      "--pull=never",
      "--network",
      "none",
      "--read-only",
      "--user",
      "999:999",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "32",
      "--memory",
      "64m",
      "--cpus",
      "1",
      "--label",
      "morrow.packet=P05.T01o-prewarm",
      "--entrypoint",
      "/bin/true",
      engineProfile.image,
    ],
    { timeout: 45000, maxBuffer: 65536, encoding: "utf8" },
  );
  if (warm.error || warm.status !== 0 || warm.signal !== null)
    throw Error("STANDALONE_HTTP_PREWARM_HELD");
} finally {
  if (containerCommand(["inspect", prewarmName], undefined, true).status === 0)
    containerCommand(["rm", "--force", prewarmName]);
  const absence = containerCommand([
    "ps",
    "--all",
    "--filter",
    "name=^/" + prewarmName + "$",
    "--format",
    "{{.ID}}",
  ]);
  prewarmAbsent = absence.status === 0 && absence.stdout.trim() === "";
}
check("pinned_credential_free_prewarm_container_absent", prewarmAbsent);

const replies = [],
  readPools = [],
  observations = [],
  expectedReleaseLoss = new WeakSet();
async function closePool(owned) {
  try {
    await owned.close();
  } catch {
    const m = owned.metrics;
    if (
      !expectedReleaseLoss.has(owned) ||
      m.connections !== m.released ||
      m.connections !== m.closed ||
      m.connections !== m.backendCleanupVerified ||
      m.unverifiedHostClosures !== 0
    )
      throw Error("STANDALONE_HTTP_CLEANUP_UNVERIFIED");
  }
}
let ownedContainer,
  loopbackClosed = false,
  issuedFamilies = 0,
  requests = 0;
const result = await localPostgresLab("P05.T01o", async ({ id, sql, image, version }) => {
  ownedContainer = id;
  const harness = createStandaloneFixtureHarness({ id, sql }, 8);
  check(
    "only_eight_migrations_installed_not_linking_read_nine",
    sql(
      "SELECT to_regprocedure('morrow_identity.lookup_workspace_store_link(text,text,text,text)') IS NULL;",
      "morrow",
    ) === "t",
  );
  let listener = createWorkspaceHttpListener();
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) =>
    listener(request, response),
  );
  server.headersTimeout = server.requestTimeout = 5000;
  server.maxHeadersCount = 64;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port,
    origin = "http://127.0.0.1:" + port;
  function pool(options = {}) {
    const calls = [];
    const owned = localStandaloneSqlPool(id, "morrow_api", Object.values(identitySql), {
      ...options,
      beforeQuery: async (text, values) => {
        calls.push(
          Object.entries(identitySql).find(([, statement]) => statement === text)?.[0] ?? "unknown",
        );
        if (options.beforeQuery) await options.beforeQuery(text, values);
      },
    });
    readPools.push(owned);
    if (options.releaseAckLoss === true) expectedReleaseLoss.add(owned);
    return Object.assign(owned, { calls });
  }
  function configure(owned) {
    const bootstrap = createStandaloneWorkspaceBootstrap({
      configurationJson: JSON.stringify({
        schemaVersion: 1,
        mode: "loopback_qualification",
        origin,
      }),
      pool: owned,
      now: Date.now,
    });
    listener = createWorkspaceHttpListener({ origin, bootstrap });
  }
  function send({
    path = "/workspace/missing/bootstrap",
    secret,
    headers = {},
    rawHeaders,
    method = "GET",
    body,
  } = {}) {
    requests++;
    return new Promise((resolve, reject) => {
      const selected = rawHeaders ?? {
        Host: "127.0.0.1:" + port,
        Connection: "close",
        ...(secret === undefined ? {} : { Cookie: "__Host-morrow_session=" + secret }),
        ...headers,
      };
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          method,
          path,
          headers: selected,
          agent: false,
          timeout: 10000,
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
            if (Buffer.byteLength(text) > 8192) request.destroy();
          });
          response.on("end", () => {
            const value = { status: response.statusCode, headers: response.headers, text };
            replies.push(value);
            resolve(value);
          });
          response.on("error", () => reject(Error("STANDALONE_HTTP_RESPONSE_HELD")));
        },
      );
      request.on("error", () => reject(Error("STANDALONE_HTTP_REQUEST_HELD")));
      request.on("timeout", () => request.destroy());
      request.end(body);
    });
  }
  const safeHeaders = (reply) =>
    reply.headers["cache-control"] === "no-store" &&
    reply.headers["x-content-type-options"] === "nosniff" &&
    reply.headers["referrer-policy"] === "no-referrer" &&
    !reply.headers["set-cookie"] &&
    !reply.headers["access-control-allow-origin"];
  async function admitted(f) {
    let stage = "none",
      sqlOutcome = "none";
    const issued = await harness.admitted(f, {
      afterQuery(text, _values, result) {
        stage =
          Object.entries(browserSessionAdmissionSql).find(([, value]) => value === text)?.[0] ??
          "unknown";
        if (text === browserSessionAdmissionSql.admit) {
          const outcome = result.rows[0]?.outcome;
          sqlOutcome = ["newly_admitted", "replayed", "denied", "conflict"].includes(outcome)
            ? outcome
            : "unknown";
        }
      },
    });
    if (issued.result.outcome !== "newly_admitted" || !issued.result.credential) {
      console.error(
        JSON.stringify({
          diagnostic: "synthetic_issuer_held",
          stage,
          sqlOutcome,
          tupleCaptured: Array.isArray(issued.tuple),
          evidenceCurrent: issued.e.owner.readEvidence(issued.e.handle) !== null,
        }),
      );
      throw Error("STANDALONE_HTTP_FRESH_ISSUANCE_REQUIRED");
    }
    issuedFamilies++;
    return issued.result.credential;
  }
  function exactSuccess(reply, workspace, revision = 1) {
    return (
      reply.status === 200 &&
      safeHeaders(reply) &&
      reply.text ===
        JSON.stringify({
          schemaVersion: 1,
          workspace: { id: workspace, displayName: "Synthetic" },
          policyRevision: revision,
        })
    );
  }
  function mutate(kind, f, credential) {
    if (["provider", "family", "generation"].includes(kind)) {
      const key = { provider: "providerBindingId", family: "familyId", generation: "generationId" }[
        kind
      ];
      const fn = {
        provider: "revoke_provider_binding",
        family: "revoke_browser_family",
        generation: "revoke_browser_generation",
      }[kind];
      const outcome = harness.admin(
        `SELECT outcome FROM morrow_identity.${fn}(${lit(credential[key])},${lit(randomUUID())},${lit(hash(randomUUID()))});`,
      );
      if (outcome !== "applied") throw Error("STANDALONE_HTTP_AUDITED_REVOCATION_REQUIRED");
      return;
    }
    const statements = {
      profile: `UPDATE morrow_identity.identity_verification_profiles SET state='inactive',record_revision=record_revision+1 WHERE id=${lit(f.profile)};`,
      mapping: `UPDATE morrow_identity.provider_subject_mappings SET state='inactive',record_revision=record_revision+1 WHERE id=${lit(f.mapping)};`,
      binding: `UPDATE morrow_identity.provider_subject_profile_bindings SET state='inactive',record_revision=record_revision+1 WHERE mapping_id=${lit(f.mapping)} AND profile_id=${lit(f.profile)};`,
      principal: `UPDATE morrow_identity.principals SET active=false WHERE id=${lit(f.principal)};`,
      organization: `UPDATE morrow_identity.organizations SET active=false WHERE id=${lit(f.organization)};`,
      workspace: `UPDATE morrow_identity.workspaces SET active=false WHERE id=${lit(f.workspace)};`,
      membership: `UPDATE morrow_identity.memberships SET active=false WHERE id=${lit(f.membership)};`,
      workspace_membership: `UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id=${lit(f.workspace)} AND membership_id=${lit(f.membership)};`,
    };
    if (!statements[kind]) throw Error("STANDALONE_HTTP_FIXED_MUTATION_REQUIRED");
    harness.admin(statements[kind]);
  }
  try {
    const denied = await send();
    check(
      "default_scaffold_denies_workspace_before_injection",
      denied.status === 401 && safeHeaders(denied),
    );
    const f = harness.fixture(),
      credential = await admitted(f),
      own = pool();
    configure(own);
    const good = await send({
      path: `/workspace/${f.workspace}/bootstrap`,
      secret: credential.secret,
    });
    check("fresh_owning_evidence_issuer_cookie_http_sql_success", exactSuccess(good, f.workspace));
    check(
      "success_waited_for_disposable_backend_cleanup",
      own.metrics.connections === 1 &&
        own.metrics.backendCleanupVerified === 1 &&
        own.metrics.closed === 1,
    );
    const otherWorkspace = "workspace_independent",
      otherOrg = "organization_independent",
      otherMember = "membership_independent";
    harness.admin(
      `INSERT INTO morrow_identity.organizations VALUES(${lit(otherOrg)},'Synthetic',true,1); INSERT INTO morrow_identity.workspaces VALUES(${lit(otherWorkspace)},${lit(otherOrg)},'Synthetic',true); INSERT INTO morrow_identity.memberships VALUES(${lit(otherMember)},${lit(otherOrg)},${lit(f.principal)},true); INSERT INTO morrow_identity.workspace_memberships VALUES(${lit(otherOrg)},${lit(otherWorkspace)},${lit(otherMember)},true);`,
    );
    const tabs = await Promise.all(
      [f.workspace, otherWorkspace].map((workspace) =>
        send({ path: `/workspace/${workspace}/bootstrap`, secret: credential.secret }),
      ),
    );
    check(
      "same_secret_concurrent_tabs_select_independent_organizations",
      tabs.every((reply, index) => exactSuccess(reply, [f.workspace, otherWorkspace][index])),
    );
    check(
      "second_tab_does_not_retarget_first",
      exactSuccess(
        await send({ path: `/workspace/${f.workspace}/bootstrap`, secret: credential.secret }),
        f.workspace,
      ),
    );
    const foreign = harness.fixture();
    const foreignReply = await send({
      path: `/workspace/${foreign.workspace}/bootstrap`,
      secret: credential.secret,
    });
    check(
      "foreign_workspace_returns_no_private_projection",
      foreignReply.status === 401 &&
        foreignReply.text === '{"code":"authentication_required"}' &&
        safeHeaders(foreignReply),
    );
    const idle = pool();
    configure(idle);
    const target = `/workspace/${f.workspace}/bootstrap`;
    const invalid = [
      ["missing_cookie", {}, 401],
      [
        "duplicate_cookie",
        {
          headers: {
            Cookie: `__Host-morrow_session=${credential.secret}; __Host-morrow_session=${credential.secret}`,
          },
        },
        401,
      ],
      [
        "quoted_cookie",
        { headers: { Cookie: `__Host-morrow_session="${credential.secret}"` } },
        401,
      ],
      [
        "encoded_cookie",
        { headers: { Cookie: "__Host-morrow_session=%41" + credential.secret.slice(1) } },
        401,
      ],
      [
        "noncanonical_padding",
        { headers: { Cookie: "__Host-morrow_session=" + credential.secret.slice(0, 42) + "B" } },
        401,
      ],
      [
        "comma_merged_cookie",
        { headers: { Cookie: `__Host-morrow_session=${credential.secret}, extra=x` } },
        401,
      ],
      ["oversized_cookie", { headers: { Cookie: "extra=" + "a".repeat(4097) } }, 401],
      [
        "too_many_cookies",
        {
          headers: {
            Cookie:
              Array.from({ length: 32 }, (_, i) => `c${i}=v`).join("; ") +
              `; __Host-morrow_session=${credential.secret}`,
          },
        },
        401,
      ],
      [
        "foreign_origin",
        { secret: credential.secret, headers: { Origin: "https://foreign.invalid" } },
        403,
      ],
      ["null_origin", { secret: credential.secret, headers: { Origin: "null" } }, 403],
      [
        "same_site_metadata",
        { secret: credential.secret, headers: { "Sec-Fetch-Site": "same-site" } },
        403,
      ],
      [
        "cross_site_metadata",
        { secret: credential.secret, headers: { "Sec-Fetch-Site": "cross-site" } },
        403,
      ],
      ["foreign_host", { secret: credential.secret, headers: { Host: "foreign.invalid" } }, 400],
      [
        "bearer_fallback",
        { secret: credential.secret, headers: { Authorization: "Bearer " + credential.secret } },
        401,
      ],
      ["preflight", { method: "OPTIONS", secret: credential.secret }, 405],
      ["query_selector", { path: target + "?workspace=other", secret: credential.secret }, 403],
      [
        "encoded_workspace",
        { path: "/workspace/%77orkspace/bootstrap", secret: credential.secret },
        404,
      ],
      [
        "raw_dot_segment",
        {
          path: `/workspace/${f.workspace}/../${f.workspace}/bootstrap`,
          secret: credential.secret,
        },
        400,
      ],
      [
        "get_body",
        { secret: credential.secret, headers: { "Content-Length": "2" }, body: "{}" },
        400,
      ],
      [
        "raw_duplicate_cookie",
        {
          rawHeaders: [
            "Host",
            new URL(origin).host,
            "Cookie",
            "a=b",
            "Cookie",
            `__Host-morrow_session=${credential.secret}`,
          ],
        },
        400,
      ],
    ];
    for (const [name, change, status] of invalid) {
      const before = idle.metrics.connections;
      const reply = await send({ path: target, ...change });
      check(
        "reject_" + name + "_before_sql",
        reply.status === status &&
          idle.metrics.connections === before &&
          idle.calls.length === 0 &&
          safeHeaders(reply),
      );
    }
    configure(own);
    check(
      "forwarded_host_cannot_change_server_selected_origin",
      exactSuccess(
        await send({
          path: target,
          secret: credential.secret,
          headers: { "X-Forwarded-Host": "foreign.invalid" },
        }),
        f.workspace,
      ),
    );

    for (const when of ["before_http", "after_resolve", "after_workspace"])
      for (const kind of [
        "profile",
        "mapping",
        "binding",
        "provider",
        "family",
        "generation",
        "principal",
        "organization",
        "workspace",
        "membership",
        "workspace_membership",
      ]) {
        const selected = harness.fixture(),
          issued = await admitted(selected);
        let changed = false;
        if (when === "before_http") {
          mutate(kind, selected, issued);
          changed = true;
        }
        const owned = pool({
          afterQuery(text) {
            if (
              !changed &&
              text === identitySql[when === "after_resolve" ? "resolve" : "workspace"]
            ) {
              mutate(kind, selected, issued);
              changed = true;
            }
          },
        });
        configure(owned);
        const reply = await send({
          path: `/workspace/${selected.workspace}/bootstrap`,
          secret: issued.secret,
        });
        check(
          when + "_" + kind + "_invalidates_http_authority",
          changed &&
            reply.status === 401 &&
            reply.text === '{"code":"authentication_required"}' &&
            safeHeaders(reply),
        );
      }
    for (const stage of ["resolve", "workspace"]) {
      const selected = harness.fixture(),
        issued = await admitted(selected);
      let changed = false;
      const owned = pool({
        afterQuery(text) {
          if (!changed && text === identitySql[stage]) {
            harness.admin(
              `UPDATE morrow_identity.organizations SET policy_revision=2 WHERE id=${lit(selected.organization)};`,
            );
            changed = true;
          }
        },
      });
      configure(owned);
      check(
        "policy_revision_after_" + stage + "_returns_fresh_two",
        exactSuccess(
          await send({ path: `/workspace/${selected.workspace}/bootstrap`, secret: issued.secret }),
          selected.workspace,
          2,
        ),
      );
    }
    for (const fault of ["commitAckLoss", "releaseAckLoss"]) {
      const label = fault === "commitAckLoss" ? "commit_ack_loss" : "release_ack_loss";
      const selected = harness.fixture(),
        issued = await admitted(selected),
        owned = pool({ [fault]: true });
      configure(owned);
      const reply = await send({
        path: `/workspace/${selected.workspace}/bootstrap`,
        secret: issued.secret,
      });
      check(
        label + "_suppresses_success_until_physical_cleanup",
        reply.status === 503 &&
          reply.text === '{"code":"unavailable"}' &&
          owned.metrics.backendCleanupVerified === 1 &&
          owned.metrics.closed === 1,
      );
      check(
        label + "_never_dispatches_followup_rollback",
        owned.calls.at(-1) === "commit" && !owned.calls.includes("rollback"),
      );
    }
    {
      const selected = harness.fixture(),
        issued = await admitted(selected),
        owned = pool({ stallQueryText: identitySql.workspace });
      configure(owned);
      let responded = false;
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: `/workspace/${selected.workspace}/bootstrap`,
          headers: { Cookie: "__Host-morrow_session=" + issued.secret },
          agent: false,
        },
        (response) => {
          responded = true;
          response.resume();
        },
      );
      request.on("error", () => {});
      request.end();
      try {
        check(
          "disconnect_actual_owned_postgres_sleep_observed",
          await until(
            () =>
              sql(
                "SELECT count(*) FROM pg_stat_activity WHERE datname='morrow' AND usename='morrow_api' AND application_name LIKE 'morrow_standalone_%' AND state='active' AND wait_event='PgSleep';",
                "morrow",
              ) === "1",
            1500,
          ),
        );
        request.destroy();
        check(
          "disconnect_cancels_query_and_closes_attributable_backend",
          await until(
            () =>
              owned.metrics.cancelled >= 1 &&
              owned.metrics.closed === 1 &&
              owned.metrics.backendCleanupVerified === 1,
          ),
        );
        check(
          "disconnect_has_no_success_or_followup_application_sql",
          !responded && owned.calls.at(-1) === "workspace" && !owned.calls.includes("rollback"),
        );
      } finally {
        request.destroy();
      }
    }
    {
      const selected = harness.fixture(),
        issued = await admitted(selected),
        owned = pool(),
        ready = deferred(),
        deliver = deferred();
      const delayed = {
        async connect(control) {
          const client = await owned.connect(control);
          ready.resolve();
          await deliver.promise;
          return client;
        },
      };
      configure(delayed);
      const pending = send({
        path: `/workspace/${selected.workspace}/bootstrap`,
        secret: issued.secret,
      });
      await ready.promise;
      const reply = await pending;
      check(
        "late_connection_deadline_holds_http_without_query",
        reply.status === 503 && owned.calls.length === 0 && owned.metrics.released === 0,
      );
      deliver.resolve();
      check(
        "late_connection_owner_disposes_after_delivery",
        await until(
          () => owned.metrics.released === 1 && owned.metrics.backendCleanupVerified === 1,
        ),
      );
      observations.push({
        case: "late_connection",
        responseHeldBeforeClientDelivery: true,
        eventualBackendAbsenceVerified: true,
      });
    }
    await harness.close();
    for (const owned of readPools) await closePool(owned);
    check(
      "issued_session_clients_all_closed_with_backend_absence",
      harness.metrics.every(
        (m) =>
          m.connections === m.closed &&
          m.connections === m.released &&
          m.connections === m.backendCleanupVerified &&
          m.unverifiedHostClosures === 0,
      ),
    );
    check(
      "request_clients_all_closed_with_backend_absence",
      readPools.every(
        (p) =>
          p.metrics.connections === p.metrics.closed &&
          p.metrics.connections === p.metrics.released &&
          p.metrics.connections === p.metrics.backendCleanupVerified &&
          p.metrics.unverifiedHostClosures === 0,
      ),
    );
    check(
      "fresh_database_namespace_has_no_owned_application_backends",
      sql(
        "SELECT count(*) FROM pg_stat_activity WHERE datname='morrow' AND usename IN ('morrow_api','morrow_identity_sessions');",
        "morrow",
      ) === "0",
    );
    const privateValues = [
      ...harness.secrets,
      ...harness.secrets.filter((x) => x.length === 43).map(hash),
    ];
    check(
      "http_responses_and_sql_child_output_exclude_raw_bearers",
      privateValues.every(
        (secret) =>
          !JSON.stringify(replies).includes(secret) &&
          readPools.every((p) => !JSON.stringify(p.observed).includes(secret)) &&
          harness.pools.every((p) => !JSON.stringify(p.observed).includes(secret)),
      ),
    );
    return {
      image,
      version,
      issuerMetrics: harness.metrics,
      requestMetrics: readPools.map((p) => p.metrics),
      issuedFamilies,
      observations,
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    loopbackClosed = await new Promise((resolve) => {
      const socket = connectSocket({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", (error) => {
        socket.destroy();
        resolve(error.code === "ECONNREFUSED");
      });
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
    const cleanup = await Promise.allSettled([...readPools.map(closePool), harness.close()]);
    if (cleanup.some((item) => item.status === "rejected"))
      throw Error("STANDALONE_HTTP_FINAL_CLEANUP_UNVERIFIED");
  }
});
check("loopback_listener_independently_closed", loopbackClosed);
const absent = /^[a-f0-9]{64}$/.test(ownedContainer)
  ? containerCommand(["ps", "--all", "--filter", "id=" + ownedContainer, "--format", "{{.ID}}"])
  : null;
check(
  "owned_database_container_independently_absent",
  absent?.status === 0 && absent.stdout.trim() === "",
);
for (const [path, digest] of Object.entries(sources))
  check(
    "source_unchanged_" + path.replaceAll(/[^a-z0-9]/gi, "_").toLowerCase(),
    hash(readFileSync(path)) === digest,
  );
const report = {
  schemaVersion: 1,
  task: "P05.T01o",
  canonicalSequence: plan.sequence,
  observedAt: new Date().toISOString(),
  sources,
  appliedMigrations: 8,
  realProviderRequests: 0,
  httpRequests: requests,
  checks,
  passed: checks.length,
  engine: result,
  cleanup: {
    prewarmContainerAbsent: prewarmAbsent,
    listenerClosed: loopbackClosed,
    databaseContainerAbsent: true,
  },
  qualification: "synthetic_cookie_to_current_workspace_http_postgresql_only",
  limitations: [
    "Fresh independently signed synthetic owning76 evidence and owner-seeded identities only.",
    "No real WorkOS credential, live token, provider request, cookie issuer or Set-Cookie qualification.",
    "Only migrations1–8 are applied; no store-linking read migration9 or merchant activation.",
    "Authority is observed at the final protected SQL read, not guaranteed indefinitely after it.",
    "Late acquisition returns a held response first; separately owned disposal is measured after client delivery.",
  ],
};
mkdirSync("docs/evidence/P05.T01t/canonical89/regressions", { recursive: true });
writeFileSync(
  "docs/evidence/P05.T01t/canonical89/regressions/standalone-workspace-http.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  "PASS: " + checks.length + " actual standalone HTTP/PostgreSQL checks; zero provider requests.",
);
