import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { tsImport } from "tsx/esm/api";
import {
  managedWorkspacePostgresqlLab,
  resolveControlledNeonPostgresqlEndpoint,
} from "./fixtures/controlled-neon-postgresql.mjs";
import { createControlledNeonTcpService } from "./fixtures/controlled-neon-tcp-bridge.mjs";
import {
  createPgFrontendParser,
  controlledNeonWireBinding,
} from "./fixtures/controlled-neon-pg-wire-oracle.mjs";
import { createPlatformWorkosProviderOracle } from "./fixtures/fixed-workos-platform-provider.mjs";
import { createBoundedLoginCookieJar } from "./fixtures/login-https.mjs";
import { localStandaloneSqlPool } from "./local-standalone-sql.mjs";
import { writeArtifact } from "./artifacts.mjs";

const { createSelfLogoutFixtureHarness } = await tsImport(
  "./fixtures/self-logout-fixture.mjs",
  import.meta.url,
);
const { seedStandaloneLinkingFixture } = await tsImport(
  "./fixtures/standalone-linking-fixture.mjs",
  import.meta.url,
);
const { withIdentityRead, identitySql } = await tsImport(
  "../packages/identity/src/index.ts",
  import.meta.url,
);
const { createControlledWorkspaceStoreLinking, workspaceStoreLinkingControlSql } = await tsImport(
  "../packages/identity/src/workspace-store-linking-control.ts",
  import.meta.url,
);
const { workspaceStoreLinkingSql } = await tsImport(
  "../packages/identity/src/workspace-store-linking.ts",
  import.meta.url,
);
const { validateDefinition } = await tsImport(
  "../packages/contracts/src/validation.ts",
  import.meta.url,
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const held = () => Error("MANAGED_WORKSPACE_POSTGRESQL_HELD");
const require = (condition) => {
  if (!condition) throw held();
};
require(process.version === "v24.13.0");
const args = process.argv.slice(2);
require(args.length <= 1 && (!args.length || /^--attempt=[a-z][a-z0-9-]{0,31}$/.test(args[0])));
const reportName =
  "labs/workspace-api-postgresql" + (args.length ? "-" + args[0].slice(10) : "") + ".json";
const paths = [
  "scripts/managed-workspace-api-postgresql-lab.mjs",
  "scripts/fixtures/managed-workspace-api-worker.ts",
  "scripts/fixtures/controlled-neon-postgresql.mjs",
  "scripts/fixtures/controlled-neon-tcp-bridge.mjs",
  "scripts/fixtures/controlled-neon-pg-wire-oracle.mjs",
  "scripts/fixtures/fixed-workos-platform-provider.mjs",
  "scripts/fixtures/fixed-workos-provider.mjs",
  "scripts/fixtures/self-logout-fixture.mjs",
  "scripts/fixtures/standalone-login-fixture.mjs",
  "scripts/fixtures/standalone-linking-fixture.mjs",
  "scripts/fixtures/login-https.mjs",
  "scripts/standalone-session-fixtures.mjs",
  "scripts/local-standalone-sql.mjs",
  "scripts/local-login-flow-sql.mjs",
  "scripts/local-browser-session-sql.mjs",
  "scripts/local-self-logout-sql.mjs",
  "apps/api/src/worker.ts",
  "infra/local-engine.json",
  "infra/identity-role-prerequisites.sql",
  "infra/identity-login-role-prerequisites.sql",
  "infra/identity-logout-role-prerequisites.sql",
  "migrations/manifest.json",
  "package.json",
  "package-lock.json",
  ...[
    "managed-workspace-api",
    "managed-workspace-binding",
    "managed-workspace-request",
    "standalone-request-guard",
    "standalone-workspace-bootstrap",
    "standalone-store-linking",
    "standalone-logout",
    "managed-login-request",
    "managed-login-request-scope",
    "managed-login-capsule",
    "standalone-login",
    "standalone-login-protocol",
    "controlled-neon-login-pool",
    "controlled-neon-login-profiles",
    "controlled-neon-workspace-profiles",
    "controlled-neon-transport",
    "fixed-workos-login-port",
    "login-flow-custody",
    "login-preauth-control",
    "authentication-exchange-admission",
    "workos-authentication-evidence",
    "workos-session-token",
    "workos-session-status",
    "workos-workspace-selection",
    "workos-browser-session-admission",
    "workspace-store-linking-control",
    "workspace-store-linking",
    "index",
  ].map((name) => "packages/identity/src/" + name + ".ts"),
];
const manifest = JSON.parse(readFileSync("migrations/manifest.json"));
// Every published migration must be present in order and checksum-verified. The
// login fixture applies exactly the twelve in the manifest, so the count stays exact until
// this lab also applies later migrations; a thirteenth migration must fail here.
require(manifest.migrations.length === 12);
for (const [i, row] of manifest.migrations.entries()) {
  require(row.sequence === i + 1 && hash(readFileSync("migrations/" + row.file)) === row.sha256);
  paths.push("migrations/" + row.file);
}
const sourceDigests = Object.fromEntries(paths.sort().map((p) => [p, hash(readFileSync(p))]));
const versions = {
  "@neondatabase/serverless": "1.2.0",
  miniflare: "4.20260730.0",
  workerd: "1.20260730.1",
  tsx: "4.20.6",
  esbuild: "0.25.12",
};
const runtimeDependencyDigests = {};
for (const [name, version] of Object.entries(versions)) {
  const path = "node_modules/" + name + "/package.json";
  require(JSON.parse(readFileSync(path)).version === version);
  runtimeDependencyDigests[path] = hash(readFileSync(path));
}
runtimeDependencyDigests["node_modules/@neondatabase/serverless/index.mjs"] = hash(
  readFileSync("node_modules/@neondatabase/serverless/index.mjs"),
);
const checks = [],
  cases = [],
  privateMarkers = [],
  fixtureOperations = [],
  sourceMetricRows = [],
  instances = new Set(),
  disposals = new Map();
const check = (name, passed) => {
  checks.push({ name, passed });
  require(passed);
};
const roles = [
  "morrow_identity_login",
  "morrow_identity_preauth",
  "morrow_identity_resolution",
  "morrow_identity_sessions",
  "morrow_api",
  "morrow_identity_linking",
  "morrow_identity_logout",
];
let stage = "owned_engine",
  failure = null,
  measured = null,
  service,
  serviceDisposal,
  appliedMigrations = 0,
  unexpectedRequests = 0,
  peakInstances = 0;
const cleanupFailures = [];
const disposeInstance = (runtime) => {
  if (!disposals.has(runtime))
    disposals.set(
      runtime,
      Promise.resolve()
        .then(() => runtime.dispose())
        .then(() => instances.delete(runtime)),
    );
  return disposals.get(runtime);
};
const disposeService = () =>
  (serviceDisposal ??= service ? Promise.resolve().then(() => service.close()) : Promise.resolve());
async function cleanup() {
  const replies = await Promise.allSettled(
    [...instances].map(disposeInstance).concat([disposeService()]),
  );
  replies.forEach((reply, i) => {
    if (reply.status !== "fulfilled") cleanupFailures.push("owned_cleanup_" + i + "_unknown");
  });
}
try {
  measured = await managedWorkspacePostgresqlLab(async (engine) => {
    let harness;
    const reconciliationPools = [],
      privateReferenceArrays = [];
    try {
      const migrationSql = new Map(
        manifest.migrations.map((row) => [
          "SET ROLE morrow_identity_owner;\n" + readFileSync("migrations/" + row.file, "utf8"),
          row.sequence,
        ]),
      );
      harness = createSelfLogoutFixtureHarness({
        id: engine.id,
        sql(text, database) {
          const sequence = migrationSql.get(text);
          if (sequence !== undefined) require(sequence === appliedMigrations + 1);
          const result = engine.sql(text, database);
          if (sequence !== undefined) appliedMigrations = sequence;
          return result;
        },
      });
      const origin = "https://127.0.0.1",
        configuration = harness.configured({ origin }),
        f = configuration.f;
      const oracle = createPlatformWorkosProviderOracle({
        configurationJson: configuration.configurationJson,
        subjectId: f.subject,
        providerSessionId: f.sid,
        now: Date.now,
      });
      const epoch = Date.now(),
        keyId = randomUUID();
      const ring = JSON.stringify({
        schemaVersion: 1,
        purpose: "morrow.login.capsule/1",
        configurationDigest: configuration.configurationDigest,
        currentKeyId: keyId,
        versions: [
          {
            keyId,
            material: randomBytes(32).toString("base64url"),
            encryptFromMs: epoch - 60000,
            encryptUntilMs: epoch + 600000,
            decryptUntilMs: epoch + 900000,
          },
        ],
      });
      privateMarkers.push(
        ...Object.values(engine.passwordByRole),
        JSON.parse(ring).versions[0].material,
      );
      // These count/resource fixtures are separately admitted through the old
      // actual SQL owner before seal; they are not the main native login cookie.
      const secondaryLinks = [];
      privateReferenceArrays.push(secondaryLinks);
      for (const scenario of ["concurrent_replay", "unknown_commit"]) {
        const configured = harness.configured({ origin });
        const admitted = await harness.admitted(configured.f);
        const link = await seedStandaloneLinkingFixture(harness, admitted);
        secondaryLinks.push({ scenario, link });
      }
      const authorityFixtures = [];
      privateReferenceArrays.push(authorityFixtures);
      for (const [count, oversized] of [
        [1000, false],
        [1001, false],
        [1000, true],
      ]) {
        const configured = harness.configured({ origin }),
          admitted = await harness.admitted(configured.f);
        const link = await seedStandaloneLinkingFixture(harness, admitted);
        const clones = [];
        for (let i = 1; i < count; i++) {
          const grant = {
            ...link.grant,
            id: workspaceAuthorityGrantId(count, oversized, i),
            ...(oversized
              ? {
                  scope: {
                    ...link.grant.scope,
                    fields: Array.from(
                      { length: 6 },
                      (_, j) => "field_" + String(j).padStart(3, "0") + "x".repeat(110),
                    ),
                  },
                }
              : {}),
          };
          require(validateDefinition("core", "Grant", grant));
          clones.push(
            `(${literal(grant.id)},${literal(configured.f.organization)},${literal(configured.f.workspace)},${literal(configured.f.membership)},${literal(configured.f.principal)},${literal(JSON.stringify(grant))}::jsonb)`,
          );
        }
        harness.admin("INSERT INTO morrow_identity.grants VALUES " + clones.join(",") + ";");
        authorityFixtures.push({ configured, admitted, link, count, oversized });
      }
      const auth = await engine.sealSetup();
      check("all_twelve_unchanged_migrations", appliedMigrations === 12);
      check(
        "seven_scram_offers_and_nine_closed_probes",
        auth.scramOfferedRoles === 7 &&
          auth.probeConnectionsClosed === 9 &&
          auth.tcpAdministratorRejected &&
          auth.tcpOwnerRejected,
      );
      check(
        "owned_internal_attested_topology",
        Object.entries(engine.topology)
          .filter(([key, value]) => typeof value === "boolean" && key !== "tcpAdministratorAllowed")
          .every(([, value]) => value === true) &&
          engine.topology.hostMounts === 0 &&
          engine.topology.tcpAdministratorAllowed === false,
      );
      check(
        "exact_live_endpoint_only",
        resolveControlledNeonPostgresqlEndpoint(engine.endpoint) !== null &&
          resolveControlledNeonPostgresqlEndpoint({ ...engine.endpoint }) === null,
      );
      // Canonical93 test-side Unix fixture authority only. Never returned to
      // app/broker/bridge, and the sealed engine.sql capability is not reopened.
      // All callers below supply fixed runner templates or the unchanged,
      // independently validated controlled seed helper's four INSERTs.
      function fixtureSql(operation, sql) {
        require(
          [
            "seed_cookie_handoff",
            "membership_off",
            "membership_on",
            "grant_off",
            "grant_on",
            "effect_count",
            "grant_count",
          ].includes(operation),
        );
        require(
          /^[a-f0-9]{64}$/.test(engine.id) &&
            typeof sql === "string" &&
            Buffer.byteLength(sql) <= 65536,
        );
        const output = execFileSync(
          "docker",
          [
            "exec",
            "--interactive",
            engine.id,
            "psql",
            "-X",
            "-qAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            "morrow",
          ],
          {
            input:
              "BEGIN; SET LOCAL ROLE morrow_identity_owner; SET LOCAL statement_timeout = '5s';\n" +
              sql +
              "\nCOMMIT;\n",
            encoding: "utf8",
            timeout: 10000,
            maxBuffer: 1048576,
          },
        ).trim();
        if (["membership_off", "membership_on", "grant_off", "grant_on"].includes(operation))
          require(output === "1");
        fixtureOperations.push({
          operation,
          affectedRecords: ["membership_off", "membership_on", "grant_off", "grant_on"].includes(
            operation,
          )
            ? 1
            : null,
          statementDigest: hash(sql),
          outputDigest: hash(output),
          transport: "fixture_only_local_Unix_owner_DML_not_application",
        });
        return output;
      }
      async function seedForCookie(secret) {
        require(/^[A-Za-z0-9_-]{43}$/.test(secret));
        const collected = [],
          accepted = { f, result: { outcome: "newly_admitted", credential: { secret } } };
        const link = await seedStandaloneLinkingFixture(
          {
            secrets: privateMarkers,
            admin(sql) {
              collected.push(sql);
            },
          },
          accepted,
        );
        require(
          collected.length === 1 &&
            collected[0].startsWith("INSERT INTO morrow_identity.grants VALUES(") &&
            Buffer.byteLength(collected[0]) <= 65536,
        );
        fixtureSql("seed_cookie_handoff", collected[0]);
        check(
          "cookie_bound_seed_record_count_" + fixtureOperations.length,
          fixtureSql(
            "effect_count",
            `SELECT (SELECT count(*) FROM morrow_identity.linking_handoffs WHERE id=${literal(link.input.handoffId)} AND session_digest=${literal(hash(secret))}), (SELECT count(*) FROM morrow_identity.linking_candidates WHERE id=${literal(link.candidateId)}), (SELECT count(*) FROM morrow_identity.linking_reviews WHERE id=${literal(link.reviewId)}), (SELECT count(*) FROM morrow_identity.grants WHERE id=${literal(link.grantId)});`,
          ) === "1|1|1|1",
        );
        return link;
      }
      const parsers = new Map(),
        backend = new Map();
      let interruptApplyCommit = false;
      service = createControlledNeonTcpService({
        endpoint: engine.endpoint,
        hostname: controlledNeonWireBinding.hostname,
        onClientBytes(bytes, observation) {
          let parser = parsers.get(observation.index);
          if (!parser) {
            parser = createPgFrontendParser({
              onStartup({ parameters }) {
                observation.startup = parameters;
                require(
                  roles.includes(parameters.user) &&
                    parameters.database === "morrow" &&
                    /^morrow_id_[a-f0-9]{32}_[po]$/.test(parameters.application_name),
                );
              },
              onMessage(message) {
                observation.messages.push(message.type);
                if (message.type === "P") observation.statement = message.text;
                if (message.type === "Q" || message.type === "B") {
                  const text = message.type === "Q" ? message.text : observation.statement;
                  (observation.executions ??= []).push({
                    text,
                    values: message.type === "Q" ? [] : [...message.parameters],
                  });
                  observation.lastStatement = text;
                  observation.applySeen ||= text.includes("morrow_identity.link_workspace_store(");
                }
              },
            });
            parsers.set(observation.index, parser);
          }
          try {
            parser.push(bytes);
          } catch {
            observation.parseFailure = true;
            throw held();
          }
        },
        onServerBytes(bytes, observation) {
          const state = backend.get(observation.index) ?? { buffer: Buffer.alloc(0), remaining: 0 };
          const interrupted = observeWorkspaceBackendBytes(
            bytes,
            observation,
            state,
            interruptApplyCommit,
          );
          backend.set(observation.index, state);
          if (interrupted) {
            interruptApplyCommit = false;
            throw held();
          }
        },
      });
      const executed = (needle) =>
        service.observations
          .flatMap((o) => (o.executions ?? []).map((e) => ({ ...e, role: o.startup?.user })))
          .filter((e) => e.text.includes(needle));
      async function isolate(releaseMode = "normal") {
        check(
          "at_most_two_isolates_" + sourceMetricRows.length + "_" + instances.size,
          instances.size < 2,
        );
        const bundle = await build({
          entryPoints: ["scripts/fixtures/managed-workspace-api-worker.ts"],
          bundle: true,
          write: false,
          format: "esm",
          platform: "browser",
          target: "es2022",
          external: ["node:*"],
          metafile: true,
          define: {
            MANAGED_WORKSPACE_FIXTURE_JSON: JSON.stringify(
              JSON.stringify({
                configurationJson: configuration.configurationJson,
                workspaceConfigurationJson: JSON.stringify({
                  schemaVersion: 1,
                  mode: "https",
                  origin,
                }),
                logoutConfigurationJson: harness.logoutConfiguration(configuration),
                capsuleKeyringJson: ring,
                bindingJson: JSON.stringify(controlledNeonWireBinding),
                passwordByRole: engine.passwordByRole,
                releaseMode,
                wrongPassword: false,
                gateNonce: randomBytes(16).toString("hex"),
                clockOffsetMs: 0,
              }),
            ),
          },
        });
        check(
          "actual_app_import_no_schema_compiler_" + sourceMetricRows.length + "_" + instances.size,
          Object.hasOwn(bundle.metafile.inputs, "apps/api/src/worker.ts") &&
            !Object.keys(bundle.metafile.inputs).some((p) =>
              /ajv\/dist\/(compile|core|2020)/.test(p),
            ),
        );
        const runtime = new Miniflare({
          modules: true,
          script: bundle.outputFiles[0].text,
          upstream: origin,
          compatibilityDate: "2026-07-30",
          compatibilityFlags: ["nodejs_compat"],
          log: new Log(LogLevel.NONE),
          outboundService(request) {
            const url = new URL(request.url);
            if (url.hostname === controlledNeonWireBinding.hostname)
              return service.outbound(request);
            if (url.origin === "https://api.workos.com") return oracle.handleRequest(request);
            unexpectedRequests++;
            throw held();
          },
        });
        instances.add(runtime);
        peakInstances = Math.max(peakInstances, instances.size);
        return {
          runtime,
          bundleDigest: hash(bundle.outputFiles[0].contents),
          async fetch(path, options = {}) {
            const response = await runtime.dispatchFetch(
              origin + path,
              workspaceFixtureRequestOptions(options),
            );
            const metric = JSON.parse(response.headers.get("x-morrow-fixture-metrics") ?? "null"),
              row = sourceMetricRows.length;
            check(
              "owning_actual_entry_original_budget_" + row,
              metric?.response?.attemptEnded === true &&
                metric.response.initialDeadlineMs ===
                  metric.response.enteredAtMs + (metric.kind === "login" ? 25000 : 5000),
            );
            check(
              "same_original_final_deadline_" + row,
              metric.response.finalDeadlineMs ===
                metric.response.enteredAtMs +
                  (metric.kind === "login" && path.startsWith("/auth/workos/callback")
                    ? 25000
                    : 5000),
            );
            if (metric.kind === "workspace")
              check("no_workspace_set_cookie_" + row, !response.headers.has("set-cookie"));
            sourceMetricRows.push({
              pathKind: path.startsWith("/auth/workos/callback")
                ? "callback"
                : path.split("/").at(-1),
              metric,
            });
            return { response, metric, body: await response.text() };
          },
        };
      }
      const a = await isolate(),
        b = await isolate(),
        jar = createBoundedLoginCookieJar();
      stage = "native_login_cookie";
      const started = await a.fetch("/auth/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Morrow-Request": "1" },
        body: JSON.stringify({ schemaVersion: 1, workspaceId: f.workspace }),
      });
      check(
        "finite_begin_cookie_only",
        started.response.status === 200 &&
          started.response.headers.getSetCookie().length === 1 &&
          jar.ingest(origin + "/auth/login", started.response.headers).accepted === 1,
      );
      const authorization = JSON.parse(started.body).authorizationUrl,
        callback = oracle.arm(authorization),
        callbackUrl = new URL(callback.callbackUrl);
      privateMarkers.push(authorization, callback.code, callback.token);
      const finished = await b.fetch(callbackUrl.pathname + callbackUrl.search, {
        headers: {
          Cookie: jar.header(callback.callbackUrl),
          "Sec-Fetch-Mode": "navigate",
          "MF-Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Site": "cross-site",
        },
      });
      check(
        "independent_isolate_callback_cookie",
        finished.response.status === 303 &&
          finished.body === "" &&
          finished.response.headers.get("location") === "/" &&
          jar.ingest(callback.callbackUrl, finished.response.headers).accepted === 1,
      );
      const cookie = jar.header(origin + "/"),
        secret = /(?:^|;\s*)__Host-morrow_session=([^;]+)/.exec(cookie)?.[1];
      require(typeof secret === "string");
      privateMarkers.push(cookie, secret);
      const bootstrap = (owner, workspace = f.workspace, supplied = cookie) =>
        owner.fetch("/workspace/" + workspace + "/bootstrap", { headers: { Cookie: supplied } });
      const mutation = (owner, link, route, extra = {}) =>
        owner.fetch(
          "/workspace/" +
            link.workspaceId +
            "/store-links" +
            (route === "apply" ? "" : "/" + route),
          {
            method: "POST",
            headers: {
              Cookie: "__Host-morrow_session=" + link.admitted.result.credential.secret,
              Origin: origin,
              "Content-Type": "application/json",
              "X-Morrow-Request": "1",
              "Idempotency-Key": link.commandId,
              ...extra,
            },
            body: JSON.stringify({ handoffToken: link.handoffToken }),
          },
        );
      check("same_cookie_bootstrap_identity_only", (await bootstrap(a)).response.status === 200);
      const firstLink = await seedForCookie(secret);
      const preview = await mutation(a, firstLink, "preview");
      check(
        "controlled_cookie_bound_preview",
        preview.response.status === 200 && typeof JSON.parse(preview.body).csrfToken === "string",
      );
      const csrf = JSON.parse(preview.body).csrfToken;
      const beforeInvalid = executed("morrow_identity.link_workspace_store(").length;
      check(
        "wrong_handoff_denied",
        (
          await mutation(
            a,
            { ...firstLink, handoffToken: randomBytes(32).toString("base64url") },
            "preview",
          )
        ).response.status === 404,
      );
      check(
        "wrong_command_denied",
        (await mutation(a, { ...firstLink, commandId: randomUUID() }, "preview")).response
          .status === 404,
      );
      check(
        "wrong_selectors_have_no_apply",
        executed("morrow_identity.link_workspace_store(").length === beforeInvalid,
      );
      check(
        "wrong_csrf_denied_before_write",
        (await mutation(a, firstLink, "apply", { "X-Morrow-CSRF": "invalid" })).response.status ===
          403,
      );
      const applied = await mutation(a, firstLink, "apply", { "X-Morrow-CSRF": csrf });
      check(
        "same_entry_CSFR_apply",
        applied.response.status === 200 && JSON.parse(applied.body).outcome === "applied",
      );
      const status = await mutation(b, firstLink, "status");
      check(
        "independent_durable_link_status",
        status.response.status === 200 && JSON.parse(status.body).outcome === "applied",
      );
      cases.push({ name: "native_login_cookie_bootstrap_preview_apply_status", passed: true });
      stage = "fresh_authority_and_scope";
      check(
        "wrong_workspace_denied",
        (await bootstrap(a, "workspace_missing")).response.status === 401,
      );
      check("no_cookie_denied", (await bootstrap(a, f.workspace, "")).response.status === 401);
      fixtureSql(
        "membership_off",
        `WITH changed AS (UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id=${literal(f.workspace)} AND membership_id=${literal(f.membership)} RETURNING 1) SELECT count(*) FROM changed;`,
      );
      check("fresh_membership_revocation_denies", (await bootstrap(a)).response.status === 401);
      fixtureSql(
        "membership_on",
        `WITH changed AS (UPDATE morrow_identity.workspace_memberships SET active=true WHERE workspace_id=${literal(f.workspace)} AND membership_id=${literal(f.membership)} RETURNING 1) SELECT count(*) FROM changed;`,
      );
      check("fresh_membership_restored", (await bootstrap(b)).response.status === 200);
      const secondLink = secondaryLinks[0].link;
      fixtureSql(
        "grant_off",
        `WITH changed AS (UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb('2020-01-02T00:00:00.000Z'::text)) WHERE id=${literal(secondLink.grantId)} RETURNING 1) SELECT count(*) FROM changed;`,
      );
      const revokedPreview = await mutation(a, secondLink, "preview");
      check("revoked_handoff_authorizing_grant_denies", revokedPreview.response.status === 404);
      fixtureSql(
        "grant_on",
        `WITH changed AS (UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}','null'::jsonb) WHERE id=${literal(secondLink.grantId)} RETURNING 1) SELECT count(*) FROM changed;`,
      );
      const nextPreview = await mutation(a, secondLink, "preview"),
        nextCsrf = JSON.parse(nextPreview.body).csrfToken;
      require(nextPreview.response.status === 200 && typeof nextCsrf === "string");
      const beforeApply = executed("morrow_identity.link_workspace_store(").length;
      const replay = await Promise.all([
        mutation(a, secondLink, "apply", { "X-Morrow-CSRF": nextCsrf }),
        mutation(b, secondLink, "apply", { "X-Morrow-CSRF": nextCsrf }),
      ]);
      check(
        "concurrent_replay_one_durable_result",
        replay.every(
          (r) => r.response.status === 200 && JSON.parse(r.body).outcome === "applied",
        ) && new Set(replay.map((r) => JSON.parse(r.body).linkId)).size === 1,
      );
      check(
        "two_native_apply_submissions",
        executed("morrow_identity.link_workspace_store(").length === beforeApply + 2,
      );
      check(
        "concurrent_one_durable_effect_and_result",
        fixtureSql(
          "effect_count",
          `SELECT (SELECT count(*) FROM morrow_identity.workspace_store_links WHERE candidate_id=${literal(secondLink.candidateId)}), (SELECT count(*) FROM morrow_identity.workspace_link_results WHERE handoff_id=${literal(secondLink.input.handoffId)} AND outcome='applied');`,
        ) === "1|1",
      );
      cases.push({
        name: "fresh_membership_grant_and_concurrent_replay",
        passed: true,
        secondarySession: "controlled_preseal_SQL_admission_distinct_from_main_native_cookie",
      });
      stage = "unknown_commit_reconciliation";
      const unknownLink = secondaryLinks[1].link,
        unknownPreview = await mutation(a, unknownLink, "preview");
      interruptApplyCommit = true;
      const unknown = await mutation(a, unknownLink, "apply", {
        "X-Morrow-CSRF": JSON.parse(unknownPreview.body).csrfToken,
      });
      check(
        "accepted_commit_response_loss_remains_unknown",
        unknown.response.status === 503 &&
          JSON.parse(unknown.body).outcome === "outcome_unknown" &&
          service.observations.some((o) => o.committedResponseInterrupted),
      );
      const reconciliationPool = localStandaloneSqlPool(engine.id, "morrow_identity_linking", [
        ...Object.values(workspaceStoreLinkingControlSql),
        ...Object.values(workspaceStoreLinkingSql),
      ]);
      reconciliationPools.push(reconciliationPool);
      const reconciliation = await createControlledWorkspaceStoreLinking({
        pool: reconciliationPool,
        now: Date.now,
      }).status(unknownLink.selectorJson, {
        deadlineMs: Date.now() + 5000,
        signal: new AbortController().signal,
      });
      check("fresh_restricted_reconciliation_applied", reconciliation?.outcome === "applied");
      cases.push({
        name: "unknown_commit_fresh_restricted_reconciliation",
        passed: true,
        originalOutcome: "outcome_unknown",
        freshOutcome: reconciliation?.outcome,
      });
      stage = "authority_count_and_wire_caps";
      const authorityObservations = [];
      for (const item of authorityFixtures) {
        const pool = localStandaloneSqlPool(engine.id, "morrow_api", Object.values(identitySql));
        reconciliationPools.push(pool);
        const facade = {
          async connect() {
            const control = { deadlineMs: Date.now() + 5000, signal: new AbortController().signal };
            const owned = await pool.connect(control);
            return {
              query: (text, values = []) => owned.query(text, values, control),
              release: (discard) => {
                const pending = owned.release(discard);
                void pending.catch(() => {});
              },
            };
          },
        };
        let countAccepted = false;
        try {
          countAccepted = await withIdentityRead(
            facade,
            hash(item.admitted.result.credential.secret),
            item.configured.f.workspace,
            async (scope) => (await scope.readWorkspaceAuthority()).grants.length === item.count,
          );
        } catch {
          /* Count ceiling denial remains explicit below. */
        }
        check(
          "actual_restricted_count_ceiling_" +
            item.count +
            (item.oversized ? "_oversized" : "_compact"),
          countAccepted === (item.count === 1000),
        );
        const beforeNative = service.observations.length;
        const response = await bootstrap(
          b,
          item.configured.f.workspace,
          "__Host-morrow_session=" + item.admitted.result.credential.secret,
        );
        check(
          "native_authority_count_and_resource_outcome_" +
            item.count +
            (item.oversized ? "_oversized" : "_compact"),
          response.response.status === (item.oversized ? 503 : item.count === 1000 ? 200 : 401) &&
            !response.response.headers.has("set-cookie"),
        );
        const nativeConnections = service.observations.slice(beforeNative);
        if (item.oversized)
          check(
            "actual_existing_native_directional_cap_observed",
            nativeConnections.some(
              (o) =>
                o.maximumDataRowBytes > 1048576 &&
                o.maximumDataRowBytes < 2097152 &&
                o.maximumServerChunkBytes <= 262144 &&
                o.toWorkerObservedBytes > 1048576 &&
                o.toWorkerObservedBytes < 2097152,
            ) && response.metric.response.pools.identityPool.normalReleases === 0,
          );
        authorityObservations.push({
          grants: item.count,
          oversized: item.oversized,
          wireObservations: nativeConnections.map((o) => ({
            maximumDataRowBytes: o.maximumDataRowBytes ?? 0,
            maximumServerChunkBytes: o.maximumServerChunkBytes ?? 0,
            toWorkerObservedBytes: o.toWorkerObservedBytes ?? 0,
            unobservedDataRowBytes: o.largeFrameRemaining ?? 0,
          })),
          restrictedUnixCountAccepted: countAccepted,
          nativeStatus: response.response.status,
          nativeAuthorityAdmitted: response.response.status === 200,
          wireBounds: { frame: 262144, direction: 1048576 },
          interpretation:
            "PG_DataRow_can_span_native_WebSocket_messages_and_count_does_not_override_directional_limit",
        });
      }
      cases.push({ name: "1000_count_accept_1001_deny_native_oversize_hold", passed: true });
      stage = "unknown_lease";
      await disposeInstance(b.runtime);
      const rejecting = await isolate("reject");
      const heldRead = await bootstrap(rejecting),
        heldPool = heldRead.metric.response.pools.identityPool;
      check(
        "read_release_rejection_not_success",
        heldRead.response.status === 503 &&
          heldPool.leaseReleaseAcks === 0 &&
          heldPool.normalReleases === 0 &&
          heldRead.metric.leases.activeLeases === 1,
      );
      const unknownCustody = {
        acknowledgements: heldPool.leaseReleaseAcks,
        activeLeases: heldRead.metric.leases.activeLeases,
        normalReleases: heldPool.normalReleases,
      };
      cases.push({ name: "unknown_credential_release_before_admin", passed: true });
      await disposeInstance(rejecting.runtime);
      stage = "current_family_logout";
      const logout = await a.fetch("/auth/logout", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
          "X-Morrow-Request": "1",
        },
        body: JSON.stringify({ schemaVersion: 1 }),
      });
      check(
        "self_logout_without_cookie_mutation",
        logout.response.status === 200 && !logout.response.headers.has("set-cookie"),
      );
      check("retired_cookie_bootstrap_denied", (await bootstrap(a)).response.status === 401);
      check(
        "retired_cookie_linking_denied",
        (await mutation(a, firstLink, "status")).response.status === 404,
      );
      cases.push({ name: "current_family_logout_and_future_denial", passed: true });
      check(
        "seven_actual_authenticated_native_roles",
        roles.every((role) =>
          service.observations.some(
            (o) => o.startup?.user === role && o.authenticationSasl && o.authenticationCompleted,
          ),
        ),
      );
      check(
        "zero_provider_or_Internet_escape",
        unexpectedRequests === 0 &&
          oracle.metrics.actualInternetRequests === 0 &&
          oracle.metrics.actualProviderRequests === 0 &&
          oracle.metrics.oracleFailures === 0,
      );
      const transport = service.counts(),
        beforeEndpointCleanup = service.bridges.map((bridge) => ({ ...bridge.metrics }));
      engine.revokeEndpoint();
      check(
        "endpoint_capability_revoked",
        resolveControlledNeonPostgresqlEndpoint(engine.endpoint) === null,
      );
      await Promise.all([...instances].map(disposeInstance));
      await disposeService();
      check(
        "all_native_handles_closed_before_admin",
        instances.size === 0 &&
          service.bridges.every(
            (bridge) =>
              bridge.metrics.tcpClosed &&
              bridge.metrics.webSocketClosed &&
              !bridge.metrics.timerActive &&
              bridge.metrics.pendingBytes === 0,
          ),
      );
      await Promise.all(reconciliationPools.map((pool) => pool.close()));
      await harness.close();
      const finalNamespace = await engine.observeFinalNamespace();
      check(
        "fresh_final_namespace_absent_without_forced_termination",
        finalNamespace.presentBeforeFinalCleanup === 0 &&
          finalNamespace.absentAfterFinalCleanup &&
          !finalNamespace.forcedFinalCleanup,
      );
      return {
        engine: { image: engine.image, version: engine.version, topology: engine.topology, auth },
        peakIndependentIsolates: peakInstances,
        fixtureBundles: [a.bundleDigest, b.bundleDigest, rejecting.bundleDigest],
        sourceMetricRows,
        fixtureOperations,
        authorityObservations,
        unknownBeforeFinalAdmin: unknownCustody,
        reconciliation: {
          transport: "fresh_restricted_role_Unix_psql_not_original_native_client",
          outcome: reconciliation.outcome,
          pool: { ...reconciliationPool.metrics },
        },
        wire: service.observations.map((o) => ({
          role: o.startup?.user,
          observer: o.startup?.application_name.endsWith("_o"),
          authenticationSasl: o.authenticationSasl === true,
          authenticationCompleted: o.authenticationCompleted === true,
          frontendFrames: o.messages.length,
          statements: (o.executions ?? []).length,
          maximumDataRowBytes: o.maximumDataRowBytes ?? 0,
          maximumServerChunkBytes: o.maximumServerChunkBytes ?? 0,
          toWorkerObservedBytes: o.toWorkerObservedBytes ?? 0,
          unobservedDataRowBytes: o.largeFrameRemaining ?? 0,
          parseFailure: o.parseFailure === true,
          committedResponseInterrupted: o.committedResponseInterrupted === true,
        })),
        transport,
        beforeEndpointCleanup,
        endpointCleanup: service.bridges.map((bridge) => ({ ...bridge.metrics })),
        provider: { metrics: oracle.metrics, calls: oracle.calls },
        finalNamespace,
      };
    } finally {
      try {
        engine.revokeEndpoint();
        await cleanup();
        await Promise.allSettled(reconciliationPools.map((pool) => pool.close()));
        if (harness) {
          privateMarkers.push(...harness.secrets);
          harness.secrets.fill("");
          harness.secrets.length = 0;
          await harness.close();
        }
      } finally {
        for (const references of privateReferenceArrays) references.length = 0;
        privateReferenceArrays.length = 0;
      }
    }
  });
  check(
    "owned_container_and_network_absent",
    measured.cleanup.container === "absent" && measured.cleanup.network === "absent",
  );
} catch (error) {
  failure = {
    stage,
    code: "MANAGED_WORKSPACE_POSTGRESQL_HELD",
    observation: error?.observation ?? null,
  };
} finally {
  await cleanup();
}
for (const [path, digest] of Object.entries(sourceDigests))
  check(
    "source_unchanged_" + path.replaceAll(/[^a-z0-9]/gi, "_").slice(-100),
    hash(readFileSync(path)) === digest,
  );
const report = {
  schema_version: 1,
  task: "P05.T01v",
  status: failure || cleanupFailures.length ? "held" : "passed",
  scope: "configured_local_same_application_Worker_seven_restricted_roles_real_PostgreSQL17",
  source_digests: sourceDigests,
  source_inventory_digest: hash(JSON.stringify(Object.entries(sourceDigests))),
  runtimeDependencyDigests,
  runtime: {
    node: process.version,
    neon: "1.2.0",
    miniflare: "4.20260730.0",
    workerd: "1.20260730.1",
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
  },
  checks,
  checkCount: checks.length,
  cases,
  caseCount: cases.length,
  appliedMigrations,
  measured,
  failure,
  cleanupFailures,
  activeRuntimes: instances.size,
  unexpectedRequests,
  actualInternetRequests: 0,
  actualProviderRequests: 0,
  limitations: [
    "Configured local application factory only; default ordinary app remains unbound. No hosted Neon, live WorkOS, genuine browser or Shopify ownership qualification.",
    "Post-seal controlled fixture DML uses the explicit Canonical93 local Unix owner path; it supplies no application request/commit/credential proof and never reopens engine.sql or changes schema/HBA/roles.",
    "1000 is a grant count ceiling, not an allowance for otherwise valid JSON exceeding existing native WebSocket-message/directional caps; native oversize stays held without partial authority.",
    "Unknown business commits and credential releases retain their original outcomes even when fresh restricted reconciliation or physical cleanup gives separate observations.",
  ],
};
const text = JSON.stringify(report, null, 2) + "\n";
const secretFenceClear = !privateMarkers.some((marker) => marker && text.includes(marker));
// Drop owned string references after the fence; this is not physical string
// zeroization or proof about runtime internals.
privateMarkers.fill("");
privateMarkers.length = 0;
require(secretFenceClear);
const reportPath = writeArtifact(reportName, text);
process.stdout.write(
  JSON.stringify({
    report: reportPath,
    status: report.status,
    checks: checks.length,
    cases: cases.length,
  }) + "\n",
);
if (report.status !== "passed") process.exitCode = 1;

function literal(value) {
  require(typeof value === "string" && value.length <= 16384);
  return "'" + value.replaceAll("'", "''") + "'";
}

// New runner-only passive instrumentation. PG DataRows can span many native
// WebSocket messages: stream/skip their payload, never impose a PG-row cap in
// front of the unchanged facade's per-message and per-direction limits.
function observeWorkspaceBackendBytes(bytes, observation, state, interruptCommit) {
  require(bytes instanceof Uint8Array && bytes.byteLength <= 262144);
  observation.maximumServerChunkBytes = Math.max(
    observation.maximumServerChunkBytes ?? 0,
    bytes.byteLength,
  );
  observation.toWorkerObservedBytes = (observation.toWorkerObservedBytes ?? 0) + bytes.byteLength;
  let incoming = Buffer.from(bytes);
  if (state.remaining) {
    const consumed = Math.min(state.remaining, incoming.length);
    state.remaining -= consumed;
    incoming = incoming.subarray(consumed);
    observation.largeFrameRemaining = state.remaining;
    if (!incoming.length) return false;
  }
  let data = Buffer.concat([state.buffer, incoming]);
  state.buffer = Buffer.alloc(0);
  while (data.length >= 5) {
    const size = data.readInt32BE(1),
      type = data[0];
    require(size >= 4 && size <= 8388608);
    if (type === 68) {
      observation.maximumDataRowBytes = Math.max(observation.maximumDataRowBytes ?? 0, size + 1);
      const consumed = Math.min(size + 1, data.length);
      state.remaining = size + 1 - consumed;
      observation.largeFrameRemaining = state.remaining;
      data = data.subarray(consumed);
      if (state.remaining) break;
      continue;
    }
    require(size <= 262144);
    if (data.length < size + 1) break;
    if (type === 82 && size >= 8 && data.readInt32BE(5) === 10)
      observation.authenticationSasl = true;
    if (type === 82 && size >= 8 && data.readInt32BE(5) === 0)
      observation.authenticationCompleted = true;
    if (
      interruptCommit &&
      observation.applySeen &&
      observation.lastStatement === "COMMIT" &&
      type === 67 &&
      data.subarray(5, size).toString() === "COMMIT"
    ) {
      observation.committedResponseInterrupted = true;
      state.buffer = Buffer.alloc(0);
      return true;
    }
    data = data.subarray(size + 1);
  }
  require(data.length <= 262144);
  state.buffer = Buffer.from(data);
  return false;
}

function workspaceAuthorityGrantId(count, oversized, index) {
  require(
    [1000, 1001].includes(count) &&
      typeof oversized === "boolean" &&
      Number.isInteger(index) &&
      index > 0 &&
      index < count,
  );
  return "grant_size_" + (oversized ? "oversized" : "compact") + "_" + count + "_" + index;
}

// Fixed test-side string dispatch preserves actual browser-style known-length
// bytes. It does not remove Transfer-Encoding from any incoming application request.
function workspaceFixtureRequestOptions(options) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) {
    require(options.method === "POST" && typeof options.body === "string");
    if (!headers.has("Content-Length"))
      headers.set("Content-Length", String(Buffer.byteLength(options.body)));
  }
  return { redirect: "manual", ...options, headers };
}
