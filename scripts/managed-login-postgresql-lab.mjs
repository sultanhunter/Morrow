import { createHash, createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { tsImport } from "tsx/esm/api";
import {
  controlledNeonPostgresqlLab,
  resolveControlledNeonPostgresqlEndpoint,
} from "./fixtures/controlled-neon-postgresql.mjs";
import { createControlledNeonTcpService } from "./fixtures/controlled-neon-tcp-bridge.mjs";
import {
  createPgFrontendParser,
  controlledNeonWireBinding,
} from "./fixtures/controlled-neon-pg-wire-oracle.mjs";
import { createPlatformWorkosProviderOracle } from "./fixtures/fixed-workos-platform-provider.mjs";
import { createBoundedLoginCookieJar } from "./fixtures/login-https.mjs";
import { writeArtifact } from "./artifacts.mjs";

// Fixed loader for the unchanged fixture's existing .ts transitive imports.
// No caller path or executable selector is accepted.
const { createSelfLogoutFixtureHarness } = await tsImport(
  "./fixtures/self-logout-fixture.mjs",
  import.meta.url,
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const held = () => Error("MANAGED_LOGIN_POSTGRESQL_HELD");
if (process.version !== "v24.13.0") throw held();
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !/^--attempt=[a-z][a-z0-9-]{0,31}$/.test(args[0])))
  throw held();
const reportName =
  "labs/managed-login-postgresql" + (args.length ? "-" + args[0].slice(10) : "") + ".json";
const paths = [
  "scripts/managed-login-postgresql-lab.mjs",
  "scripts/fixtures/managed-login-request-worker.ts",
  "scripts/fixtures/controlled-neon-postgresql.mjs",
  "scripts/fixtures/controlled-neon-tcp-bridge.mjs",
  "scripts/fixtures/controlled-neon-pg-wire-oracle.mjs",
  "scripts/fixtures/self-logout-fixture.mjs",
  "scripts/fixtures/standalone-login-fixture.mjs",
  "scripts/standalone-session-fixtures.mjs",
  "scripts/fixtures/fixed-workos-platform-provider.mjs",
  "scripts/fixtures/fixed-workos-provider.mjs",
  "scripts/fixtures/login-https.mjs",
  "scripts/local-login-flow-sql.mjs",
  "scripts/local-browser-session-sql.mjs",
  "scripts/local-self-logout-sql.mjs",
  "infra/local-engine.json",
  "infra/identity-role-prerequisites.sql",
  "infra/identity-login-role-prerequisites.sql",
  "infra/identity-logout-role-prerequisites.sql",
  "infra/identity-onboarding-role-prerequisites.sql",
  "migrations/manifest.json",
  "package.json",
  "package-lock.json",
  ...[
    "managed-login-request",
    "managed-login-request-scope",
    "managed-login-capsule",
    "standalone-login",
    "standalone-login-protocol",
    "controlled-neon-login-pool",
    "controlled-neon-login-profiles",
    "controlled-neon-transport",
    "fixed-workos-login-port",
    "login-flow-custody",
    "login-preauth-control",
    "authentication-exchange-admission",
    "workos-authentication-evidence",
    "workos-session-token",
    "workos-session-status",
    "workos-browser-session-admission",
  ].map((n) => "packages/identity/src/" + n + ".ts"),
];
const manifest = JSON.parse(readFileSync("migrations/manifest.json"));
// The login fixture applies 0001-0013 (account login, P05.T01x); they must be present in order and
// checksum-verified. Later manifest entries are not applied by this lab.
if (manifest.migrations.length < 13) throw held();
for (const [i, row] of manifest.migrations.slice(0, 13).entries()) {
  if (row.sequence !== i + 1 || hash(readFileSync("migrations/" + row.file)) !== row.sha256)
    throw held();
  paths.push("migrations/" + row.file);
}
const sourceDigests = Object.fromEntries(paths.sort().map((p) => [p, hash(readFileSync(p))]));
const runtimePaths = [
  "node_modules/@neondatabase/serverless/package.json",
  "node_modules/@neondatabase/serverless/index.mjs",
  "node_modules/miniflare/package.json",
  "node_modules/workerd/package.json",
  "node_modules/tsx/package.json",
];
const runtimeDependencyDigests = Object.fromEntries(
  runtimePaths.map((p) => [p, hash(readFileSync(p))]),
);
for (const [name, version] of [
  ["@neondatabase/serverless", "1.2.0"],
  ["miniflare", "4.20260730.0"],
  ["workerd", "1.20260730.1"],
  ["tsx", "4.20.6"],
])
  if (JSON.parse(readFileSync("node_modules/" + name + "/package.json")).version !== version)
    throw held();
const checks = [],
  cases = [],
  privateMarkers = [],
  instances = new Set(),
  disposalPromises = new Map();
const check = (name, passed) => {
  checks.push({ name, passed });
  if (!passed) throw held();
};
const roles = ["morrow_identity_login", "morrow_identity_preauth", "morrow_identity_sessions"];
let stage = "owned_engine",
  failure = null,
  measured = null,
  service,
  serviceDisposal,
  appliedMigrations = 0,
  unexpectedRequests = 0,
  peakInstances = 0;
const cleanupFailures = [];
const disposeInstance = (instance) => {
  if (disposalPromises.has(instance)) return disposalPromises.get(instance);
  const pending = Promise.resolve()
    .then(() => instance.dispose())
    .then(() => instances.delete(instance));
  disposalPromises.set(instance, pending);
  return pending;
};
const disposeService = () => {
  if (serviceDisposal) return serviceDisposal;
  serviceDisposal = service ? Promise.resolve().then(() => service.close()) : Promise.resolve();
  return serviceDisposal;
};
async function observeCleanup() {
  const pending = [...instances].map(disposeInstance);
  pending.push(disposeService());
  const outcomes = await Promise.allSettled(pending);
  outcomes.forEach((v, i) => {
    if (v.status !== "fulfilled") cleanupFailures.push("owned_cleanup_" + i + "_unknown");
  });
}
try {
  measured = await controlledNeonPostgresqlLab(async (engine) => {
    try {
      const migrationStatements = new Map(
        manifest.migrations.map((row) => [
          "SET ROLE morrow_identity_owner;\n" + readFileSync("migrations/" + row.file, "utf8"),
          row.sequence,
        ]),
      );
      const setupSql = (text, database) => {
        const seq = migrationStatements.get(text);
        if (seq !== undefined && seq !== appliedMigrations + 1) throw held();
        const result = engine.sql(text, database);
        if (seq !== undefined) appliedMigrations = seq;
        return result;
      };
      const harness = createSelfLogoutFixtureHarness(
        { id: engine.id, sql: setupSql },
        { accountOnboarding: true },
      );
      const origin = "https://127.0.0.1",
        configuration = harness.configured({ origin });
      const oracle = createPlatformWorkosProviderOracle({
        configurationJson: configuration.configurationJson,
        subjectId: configuration.f.subject,
        providerSessionId: configuration.f.sid,
        now: Date.now,
      });
      privateMarkers.push(...Object.values(engine.passwordByRole));
      const epoch = Date.now(),
        k1 = {
          keyId: "10500000-0000-4000-8000-000000000001",
          material: randomBytes(32).toString("base64url"),
          encryptFromMs: epoch - 60000,
          encryptUntilMs: epoch + 600000,
          decryptUntilMs: epoch + 900000,
        };
      const k2 = {
        keyId: "10500000-0000-4000-8000-000000000002",
        material: randomBytes(32).toString("base64url"),
        encryptFromMs: epoch - 60000,
        encryptUntilMs: epoch + 600000,
        decryptUntilMs: epoch + 900000,
      };
      privateMarkers.push(k1.material, k2.material);
      const ring = (current, versions) =>
        JSON.stringify({
          schemaVersion: 1,
          purpose: "morrow.login.capsule/1",
          configurationDigest: configuration.configurationDigest,
          currentKeyId: current.keyId,
          versions,
        });
      const k1Ring = ring(k1, [k1]),
        rotatedRing = ring(k2, [k2, k1]);
      const preseedConfiguration = harness.configured({ origin });
      const preseedOracle = createPlatformWorkosProviderOracle({
        configurationJson: preseedConfiguration.configurationJson,
        subjectId: preseedConfiguration.f.subject,
        providerSessionId: preseedConfiguration.f.sid,
        now: Date.now,
      });
      const k3 = {
        keyId: "10500000-0000-4000-8000-000000000003",
        material: randomBytes(32).toString("base64url"),
        encryptFromMs: epoch - 600000,
        encryptUntilMs: epoch - 300001,
        decryptUntilMs: epoch - 1,
      };
      privateMarkers.push(k3.material);
      const preseedRing = (expired = false) =>
        JSON.stringify({
          schemaVersion: 1,
          purpose: "morrow.login.capsule/1",
          configurationDigest: preseedConfiguration.configurationDigest,
          currentKeyId: k2.keyId,
          versions: [k2, expired ? k3 : k1],
        });
      // Setup-only malformed capsules. Unchanged real owners create the flow
      // and PKCE challenge; independently authored OpenSSL AES bytes intentionally
      // disagree with a tag, AAD or claimed UUID. No post-seal admin mutation.
      const { createLoginFlowCustody: seedCustodyFactory, loginFlowCustodySql: seedCustodySql } =
        await tsImport("../packages/identity/src/login-flow-custody.ts", import.meta.url);
      const { authenticationExchangeAdmissionSql: seedPreauthSql } = await tsImport(
        "../packages/identity/src/authentication-exchange-admission.ts",
        import.meta.url,
      );
      const { runControlledPreauth } = await tsImport(
        "../packages/identity/src/login-preauth-control.ts",
        import.meta.url,
      );
      const { createLoginAttempt } = await tsImport(
        "../packages/identity/src/standalone-login-protocol.ts",
        import.meta.url,
      );
      const seedCustody = seedCustodyFactory({
        pool: harness.pool("morrow_identity_login", Object.values(seedCustodySql)),
        now: Date.now,
      });
      const preseeded = [];
      for (const mode of ["tampered_tag", "different_AAD", "wrong_claimed_key", "expired_key"]) {
        const flowId = randomUUID(),
          beginCommandId = randomUUID(),
          admissionCommandId = randomUUID(),
          issuerCommandId = randomUUID();
        const control = { deadlineMs: Date.now() + 5000, signal: new AbortController().signal };
        const intent = await seedCustody.createAccountIntent(
          JSON.stringify({
            schemaVersion: 1,
            configurationDigest: preseedConfiguration.configurationDigest,
            flowId,
            beginCommandId,
            admissionCommandId,
            issuerCommandId,
          }),
          control,
        );
        check(
          "preseed_real_flow_intent_" + mode,
          intent.outcome === "newly_created" && intent.flow_id === flowId,
        );
        const attempt = createLoginAttempt(Date.now, new AbortController().signal, 5000);
        let material;
        try {
          material = await runControlledPreauth(
            harness.pool("morrow_identity_preauth", Object.values(seedPreauthSql)),
            preseedConfiguration.authenticationBindingJson,
            attempt,
            (service) => service.begin(JSON.stringify({ commandId: beginCommandId })),
          );
        } finally {
          attempt.end();
        }
        check("preseed_real_PKCE_" + mode, material !== null);
        const opaque = randomBytes(32).toString("base64url"),
          stateDigest = hash(material.state),
          cookieDigest = hash(opaque),
          browserProofDigest = hash(material.browserProof),
          verifierDigest = hash(material.verifier);
        const claimedKey =
          mode === "wrong_claimed_key" ? k2.keyId : mode === "expired_key" ? k3.keyId : k1.keyId;
        const aad = Buffer.from(
          JSON.stringify([
            "morrow.login.capsule",
            "1",
            preseedConfiguration.configurationDigest,
            flowId,
            material.challengeId,
            beginCommandId,
            admissionCommandId,
            issuerCommandId,
            null,
            intent.expires_at_ms,
            stateDigest,
            cookieDigest,
            browserProofDigest,
            verifierDigest,
            claimedKey,
          ]),
        );
        const iv = randomBytes(12),
          rawKey = Buffer.from(mode === "expired_key" ? k3.material : k1.material, "base64url"),
          plain = Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              browserProof: material.browserProof,
              verifier: material.verifier,
            }),
          );
        const cipher = createCipheriv("aes-256-gcm", rawKey, iv, { authTagLength: 16 });
        cipher.setAAD(
          mode === "different_AAD"
            ? Buffer.concat([aad, Buffer.from("-deliberately-different")])
            : aad,
        );
        let encrypted;
        try {
          encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
        } finally {
          rawKey.fill(0);
          plain.fill(0);
        }
        if (mode === "tampered_tag") encrypted[encrypted.length - 1] ^= 1;
        const ciphertext = encrypted.toString("base64url");
        encrypted.fill(0);
        const bound = await seedCustody.bindBegin(
          JSON.stringify({
            schemaVersion: 1,
            configurationDigest: preseedConfiguration.configurationDigest,
            flowId,
            expectedRevision: intent.flow_revision,
            challengeId: material.challengeId,
            stateDigest,
            cookieDigest,
            browserProofDigest,
            verifierDigest,
            ciphertext,
            encryptionNonce: iv.toString("base64url"),
            keyId: claimedKey,
            aadDigest: hash(aad),
          }),
          { deadlineMs: Date.now() + 5000, signal: new AbortController().signal },
        );
        check(
          "preseed_capsule_persisted_" + mode,
          bound.outcome === "newly_ready" && bound.expires_at_ms === intent.expires_at_ms,
        );
        const authorization = new URL("https://api.workos.com/user_management/authorize");
        const authBinding = JSON.parse(preseedConfiguration.authenticationBindingJson);
        for (const [name, value] of Object.entries({
          client_id: authBinding.clientId,
          redirect_uri: authBinding.redirectUri,
          response_type: "code",
          provider: "authkit",
          state: material.state,
          code_challenge: material.codeChallenge,
          code_challenge_method: "S256",
        }))
          authorization.searchParams.set(name, value);
        const callback = preseedOracle.arm(authorization.href),
          jar = createBoundedLoginCookieJar();
        const headers = new Headers({
          "Set-Cookie": `__Host-morrow_login=${opaque}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300`,
        });
        check(
          "preseed_cookie_envelope_" + mode,
          jar.ingest(origin + "/auth/login", headers).accepted === 1,
        );
        privateMarkers.push(
          opaque,
          material.state,
          material.browserProof,
          material.verifier,
          ciphertext,
          callback.code,
          callback.token,
          authorization.href,
        );
        preseeded.push({
          mode,
          jar,
          callback,
          serial: "preseed_" + mode,
          keyring: preseedRing(mode === "expired_key"),
          selectorJson: JSON.stringify({
            schemaVersion: 1,
            configurationDigest: preseedConfiguration.configurationDigest,
            flowId,
            beginCommandId,
            admissionCommandId,
            issuerCommandId,
          }),
          flowId,
          claimedKey,
        });
      }
      const auth = await engine.sealSetup();
      check("all_thirteen_migrations_installed", appliedMigrations === 13);
      check(
        "attested_owned_internal_no_publication_topology",
        engine.topology.internalNetwork &&
          engine.topology.noPublishedPorts &&
          engine.topology.ownedContainerEndpointAttested &&
          engine.topology.sameHostReachability &&
          engine.topology.sourceMatchedGateway &&
          engine.topology.ipv4NoDefaultRouteMeasured &&
          engine.topology.singleOwnedNetworkEndpoint,
      );
      check(
        "three_role_scram_and_tcp_administrator_denial",
        auth.scramOfferedRoles === 3 &&
          auth.tcpAdministratorRejected &&
          auth.tcpOwnerRejected &&
          auth.probeConnectionsClosed === 5,
      );
      check(
        "exact_live_endpoint_capability",
        resolveControlledNeonPostgresqlEndpoint(engine.endpoint) !== null &&
          resolveControlledNeonPostgresqlEndpoint({ ...engine.endpoint }) === null,
      );
      stage = "transparent_transport";
      const parsers = new Map(),
        backend = new Map();
      service = createControlledNeonTcpService({
        endpoint: engine.endpoint,
        hostname: controlledNeonWireBinding.hostname,
        onClientBytes(bytes, observation) {
          let parser = parsers.get(observation.index);
          if (!parser) {
            parser = createPgFrontendParser({
              onStartup({ parameters }) {
                observation.startup = parameters;
                if (
                  !roles.includes(parameters.user) ||
                  parameters.database !== "morrow" ||
                  !/^morrow_id_[a-f0-9]{32}_[po]$/.test(parameters.application_name)
                )
                  throw held();
              },
              onMessage(message) {
                observation.messages.push(message.type);
                if (message.type === "P") observation.statement = message.text;
                if (message.type === "Q")
                  (observation.executions ??= []).push({ text: message.text, values: [] });
                if (message.type === "B")
                  (observation.executions ??= []).push({
                    text: observation.statement,
                    values: [...message.parameters],
                  });
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
          let data = Buffer.concat([
            backend.get(observation.index) ?? Buffer.alloc(0),
            Buffer.from(bytes),
          ]);
          if (data.length > 262144) throw held();
          while (data.length >= 5) {
            const size = data.readInt32BE(1);
            if (size < 4 || size > 262144) throw held();
            if (data.length < size + 1) break;
            if (data[0] === 82 && size >= 8 && data.readInt32BE(5) === 10)
              observation.authenticationSasl = true;

            if (data[0] === 84) {
              const count = data.readInt16BE(5);
              let at = 7;
              const fields = [];
              if (count < 0 || count > 64) throw held();
              for (let i = 0; i < count; i++) {
                const end = data.indexOf(0, at);
                if (end < at || end - at > 128 || end + 19 > size + 1) throw held();
                fields.push(
                  new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(at, end)),
                );
                at = end + 19;
              }
              if (at !== size + 1) throw held();
              observation.fields = fields;
            }
            if (data[0] === 68) {
              const count = data.readInt16BE(5),
                values = [];
              let at = 7;
              if (count !== observation.fields?.length) throw held();
              for (let i = 0; i < count; i++) {
                if (at + 4 > size + 1) throw held();
                const length = data.readInt32BE(at);
                at += 4;
                if (length === -1) values.push(null);
                else {
                  if (length < 0 || at + length > size + 1) throw held();
                  values.push(
                    new TextDecoder("utf-8", { fatal: true }).decode(
                      data.subarray(at, at + length),
                    ),
                  );
                  at += length;
                }
              }
              if (at !== size + 1 || (observation.returnedRows?.length ?? 0) > 256) throw held();
              (observation.returnedRows ??= []).push(
                Object.fromEntries(observation.fields.map((key, i) => [key, values[i]])),
              );
            }
            data = data.subarray(size + 1);
          }
          backend.set(observation.index, Buffer.from(data));
        },
      });
      const executions = () =>
        service.observations.flatMap((o) =>
          (o.executions ?? []).map((e) => ({ ...e, role: o.startup?.user })),
        );
      const returnedRows = () => service.observations.flatMap((o) => o.returnedRows ?? []);
      const newlyClaimedRows = () =>
        returnedRows().filter((row) => row.outcome === "newly_claimed");
      const calls = (suffix) =>
        executions().filter((e) => e.text.includes("morrow_identity." + suffix + "("));
      const sourceMetricRows = [];
      async function isolate(
        keyringJson,
        {
          releaseMode = "normal",
          clockOffsetMs = 0,
          selectedConfiguration = configuration,
          bindCutoff = null,
        } = {},
      ) {
        check("at_most_two_independent_isolates_" + checks.length, instances.size < 2);
        const bundle = await build({
          entryPoints: ["scripts/fixtures/managed-login-request-worker.ts"],
          bundle: true,
          write: false,
          format: "esm",
          platform: "browser",
          target: "es2022",
          external: ["node:*"],
          metafile: true,
          define: {
            MANAGED_LOGIN_FIXTURE_JSON: JSON.stringify(
              JSON.stringify({
                configurationJson: selectedConfiguration.configurationJson,
                capsuleKeyringJson: keyringJson,
                bindingJson: JSON.stringify(controlledNeonWireBinding),
                passwordByRole: engine.passwordByRole,
                releaseMode,
                wrongPassword: false,
                gateNonce: randomBytes(16).toString("hex"),
                clockOffsetMs,
                bindCutoff,
              }),
            ),
          },
        });
        check(
          "no_dynamic_schema_compiler_" + checks.length,
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
        return Object.freeze({
          runtime,
          async fetch(path, options = {}) {
            const response = await runtime.dispatchFetch(origin + path, {
              redirect: "manual",
              ...options,
            });
            const metric = JSON.parse(response.headers.get("x-morrow-fixture-metrics") ?? "null");
            check(
              "real_entry_same_original_attempt_" + sourceMetricRows.length,
              metric?.response.attemptEnded === true &&
                metric.response.initialDeadlineMs === metric.response.enteredAtMs + 25000 &&
                metric.response.finalDeadlineMs ===
                  metric.response.enteredAtMs +
                    (path.startsWith("/auth/workos/callback") ? 25000 : 5000),
            );
            sourceMetricRows.push(metric);
            return { response, metric };
          },
        });
      }
      let serial = 0;
      async function begin(owner, expectedKey) {
        const jar = createBoundedLoginCookieJar(),
          before = calls("bind_login_flow_begin").length;
        const { response, metric } = await owner.fetch("/auth/login", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json", "X-Morrow-Request": "1" },
          body: JSON.stringify({ schemaVersion: 2 }),
        });
        const body = await response.json();
        check(
          "managed_begin_one_cookie_" + ++serial,
          response.status === 200 &&
            response.headers.getSetCookie().length === 1 &&
            jar.ingest(origin + "/auth/login", response.headers).accepted === 1,
        );
        const callback = oracle.arm(body.authorizationUrl),
          bound = calls("bind_login_flow_begin").at(-1),
          intent = calls("create_account_login_flow_intent").at(-1);
        privateMarkers.push(callback.code, callback.token, body.authorizationUrl);
        check(
          "persisted_begin_selected_key_" + serial,
          calls("bind_login_flow_begin").length === before + 1 &&
            bound.values[10] === expectedKey &&
            bound.values.length === 12 &&
            intent.values.length === 5,
        );
        return { jar, callback, intent, bound, serial, metric };
      }
      async function finish(owner, flow, success = null) {
        const url = new URL(flow.callback.callbackUrl),
          headers = {
            Cookie: flow.jar.header(flow.callback.callbackUrl),
            "Sec-Fetch-Mode": "navigate",
            "MF-Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Site": "cross-site",
          };
        const { response, metric } = await owner.fetch(url.pathname + url.search, { headers }),
          body = await response.text();
        if (success === null)
          success =
            response.headers.get("location") === "/" &&
            response.headers.getSetCookie().length === 1;
        check(
          "managed_callback_finite_delivery_" + flow.serial,
          response.status === 303 &&
            body === "" &&
            response.headers.get("location") === (success ? "/" : "/auth/result") &&
            response.headers.getSetCookie().length === (success ? 1 : 0),
        );
        if (success) {
          check(
            "managed_callback_cookie_" + flow.serial,
            flow.jar.ingest(flow.callback.callbackUrl, response.headers).accepted === 1,
          );
          privateMarkers.push(flow.jar.header(origin + "/"));
        }
        return {
          metric,
          status: response.status,
          cookies: response.headers.getSetCookie().length,
          success,
        };
      }
      stage = "independent_isolate_continuity";
      let a = await isolate(k1Ring),
        b = await isolate(k1Ring);
      const first = await begin(a, k1.keyId),
        firstOutcome = await finish(b, first, true);
      check(
        "independent_B_cold_key_cache",
        firstOutcome.metric.response.cacheHit === false &&
          firstOutcome.metric.response.cacheResolved === true,
      );
      check(
        "same_configuration_namespace_after_independent_import",
        first.metric.response.cacheResolved === true &&
          configuration.configurationDigest === JSON.parse(rotatedRing).configurationDigest,
      );
      const replayBefore = oracle.metrics.exchange,
        claimsBeforeReplay = newlyClaimedRows().length,
        submissionsBeforeReplay = calls("claim_login_callback").length;
      await finish(b, first, false);
      check(
        "persisted_single_claim_no_reexchange",
        oracle.metrics.exchange === replayBefore &&
          newlyClaimedRows().length === claimsBeforeReplay &&
          calls("claim_login_callback").length === submissionsBeforeReplay + 1,
      );
      check(
        "actual_owning_chain_all_three_timely_disposals",
        Object.values(firstOutcome.metric.response.pools).every(
          (pool) =>
            pool.normalReleases > 0 &&
            pool.activeLeases === 0 &&
            pool.unverifiedReleases === 0 &&
            pool.primaryAttributions === pool.primaryAbsenceVerified &&
            pool.leaseReleaseAcks === pool.leasesAcquired,
        ),
      );
      check(
        "independent_HTTP_PKCE_RSA_chain",
        oracle.metrics.exchange === 1 &&
          oracle.metrics.publicKeyset === 1 &&
          oracle.metrics.sessionPage === 1 &&
          oracle.metrics.oracleFailures === 0,
      );
      cases.push({ name: "A_K1_begin_B_K1_callback", passed: true });
      stage = "bounded_rotation";
      const oldFlow = await begin(a, k1.keyId);
      await disposeInstance(b.runtime);
      b = await isolate(rotatedRing);
      await finish(b, oldFlow, true);
      const newFlow = await begin(b, k2.keyId);
      await finish(b, newFlow, true);
      check(
        "K1_previous_record_immutable",
        JSON.stringify(JSON.parse(rotatedRing).versions[1]) === JSON.stringify(k1),
      );
      cases.push({ name: "K2_current_K1_previous_rotation", passed: true });
      stage = "concurrent_real_claims";
      const concurrent = await begin(a, k1.keyId),
        beforeExchange = oracle.metrics.exchange,
        beforeClaims = calls("claim_login_callback").length;
      const race = await Promise.all([finish(b, concurrent), finish(a, concurrent)]);
      // The winner is intentionally not predetermined. Re-evaluate concrete
      // deliveries below rather than using the order supplied to Promise.all.
      check(
        "concurrent_claim_exactly_one_exchange",
        oracle.metrics.exchange === beforeExchange + 1 &&
          calls("claim_login_callback").length === beforeClaims + 2,
      );
      check(
        "concurrent_claim_at_least_one_delivery",
        race.filter((r) => r.success === true).length === 1 &&
          race.filter((r) => r.success === false).length === 1,
      );
      cases.push({ name: "atomic_single_claim", passed: true });
      stage = "post_claim_key_loss";
      for (const mode of ["missing_K1", "wrong_K1_material"]) {
        const flow = await begin(a, k1.keyId);
        await disposeInstance(b.runtime);
        let badRing;
        if (mode === "missing_K1") badRing = ring(k2, [k2]);
        else {
          const material = randomBytes(32).toString("base64url");
          privateMarkers.push(material);
          badRing = ring(k2, [k2, { ...k1, material }]);
        }
        b = await isolate(badRing);
        const before = oracle.metrics.exchange,
          claims = calls("claim_login_callback").length,
          actualClaims = newlyClaimedRows().length;
        await finish(b, flow, false);
        await finish(b, flow, false);
        check(
          mode + "_consumed_claim_no_exchange",
          oracle.metrics.exchange === before &&
            calls("claim_login_callback").length === claims + 2 &&
            newlyClaimedRows().length === actualClaims + 1,
        );
        cases.push({ name: mode, passed: true });
      }
      await disposeInstance(b.runtime);
      b = await isolate(rotatedRing);
      stage = "preseeded_real_SQL_proof_loss";
      for (const flow of preseeded) {
        await disposeInstance(b.runtime);
        b = await isolate(flow.keyring, { selectedConfiguration: preseedConfiguration });
        const claims = newlyClaimedRows().length,
          submissions = calls("claim_login_callback").length,
          beforeExchange = oracle.metrics.exchange + preseedOracle.metrics.exchange;
        await finish(b, flow, false);
        await finish(b, flow, false);
        check(
          "preseeded_" + flow.mode + "_one_claim_no_exchange",
          newlyClaimedRows().length === claims + 1 &&
            calls("claim_login_callback").length === submissions + 2 &&
            oracle.metrics.exchange + preseedOracle.metrics.exchange === beforeExchange,
        );
        const fresh = await seedCustody.reconcile(flow.selectorJson, {
          deadlineMs: Date.now() + 5000,
          signal: new AbortController().signal,
        });
        const claimed = newlyClaimedRows().filter((row) => row.flow_id === flow.flowId);
        check(
          "preseeded_" + flow.mode + "_fresh_restricted_claim_reconciliation",
          fresh.outcome === "observed" &&
            fresh.phase === "claimed" &&
            claimed.length === 1 &&
            claimed[0].key_id === flow.claimedKey &&
            typeof claimed[0].ciphertext === "string",
        );
        cases.push({
          name: "preseeded_" + flow.mode,
          passed: true,
          provenance: "setup_only_independent_malformed_AES_capsule",
          exactlyOneAtomicClaimObserved: true,
          freshRestrictedReconciliationPhase: fresh.phase,
          erasureBoundary:
            "installed_SQL10_atomic_claim_erases_ciphertext_and_fresh_replay_cannot_return_it",
        });
      }
      await disposeInstance(b.runtime);
      b = await isolate(rotatedRing);
      stage = "stale_isolate_cutoff_and_invalid_ring";
      await disposeInstance(a.runtime);
      a = await isolate(k1Ring, { clockOffsetMs: 600001 });
      const intentBefore = calls("create_account_login_flow_intent").length;
      const stale = await a.fetch("/auth/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Morrow-Request": "1" },
        body: JSON.stringify({ schemaVersion: 2 }),
      });
      check(
        "stale_K1_stops_sealing_before_SQL",
        stale.response.status === 503 &&
          stale.response.headers.getSetCookie().length === 0 &&
          calls("create_account_login_flow_intent").length === intentBefore,
      );
      await stale.response.body?.cancel();
      await disposeInstance(a.runtime);
      a = await isolate(JSON.stringify({ ...JSON.parse(k1Ring), unknown: true }));
      const invalid = await a.fetch("/auth/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Morrow-Request": "1" },
        body: JSON.stringify({ schemaVersion: 2 }),
      });
      check(
        "invalid_whole_ring_pre_SQL_provider",
        invalid.response.status === 503 &&
          invalid.response.headers.getSetCookie().length === 0 &&
          calls("create_account_login_flow_intent").length === intentBefore &&
          invalid.metric.leases.borrows === 0,
      );
      await invalid.response.body?.cancel();
      await disposeInstance(a.runtime);
      a = await isolate(k1Ring);
      stage = "key_cutoff_during_committed_bind";
      await disposeInstance(a.runtime);
      const cutoffBase = Date.now(),
        cutoffKey = {
          keyId: "10500000-0000-4000-8000-000000000004",
          material: randomBytes(32).toString("base64url"),
          encryptFromMs: cutoffBase - 60000,
          encryptUntilMs: cutoffBase + 4000,
          decryptUntilMs: cutoffBase + 304000,
        };
      privateMarkers.push(cutoffKey.material);
      a = await isolate(ring(cutoffKey, [cutoffKey]), {
        bindCutoff: { initialNowMs: cutoffBase, encryptUntilMs: cutoffKey.encryptUntilMs },
      });
      const beforeCutoffBinds = calls("bind_login_flow_begin").length,
        beforeCutoffClaims = newlyClaimedRows().length,
        beforeCutoffExchange = oracle.metrics.exchange;
      const cutoffDelivery = await a.fetch("/auth/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Morrow-Request": "1" },
        body: JSON.stringify({ schemaVersion: 2 }),
      });
      const cutoffBody = await cutoffDelivery.response.text(),
        cutoffMetric = cutoffDelivery.metric;
      const cutoffIntent = calls("create_account_login_flow_intent").at(-1),
        cutoffBound = calls("bind_login_flow_begin").at(-1);
      check(
        "actual_bind_newly_ready_before_cutoff_handoff",
        calls("bind_login_flow_begin").length === beforeCutoffBinds + 1 &&
          cutoffBound.values[10] === cutoffKey.keyId &&
          returnedRows().filter(
            (row) => row.outcome === "newly_ready" && row.flow_id === cutoffIntent.values[1],
          ).length === 1,
      );
      check(
        "key_cutoff_crossed_inside_unchanged_entry_D",
        cutoffMetric.response.enteredAtMs === cutoffBase &&
          cutoffMetric.response.finalDeadlineMs === cutoffBase + 5000 &&
          cutoffMetric.fixtureClock.progressed === true &&
          cutoffMetric.fixtureClock.advancedAtMs === cutoffKey.encryptUntilMs &&
          cutoffMetric.fixtureClock.originalDeadlineStillLive === true &&
          cutoffMetric.fixtureClock.currentNowMs >= cutoffKey.encryptUntilMs &&
          cutoffMetric.fixtureClock.currentNowMs < cutoffMetric.response.finalDeadlineMs,
      );
      check(
        "committed_bind_cutoff_withholds_cookie_and_authorization",
        cutoffDelivery.response.status === 503 &&
          cutoffBody === JSON.stringify({ schemaVersion: 1, outcome: "login_unavailable" }) &&
          cutoffDelivery.response.headers.getSetCookie().length === 0 &&
          newlyClaimedRows().length === beforeCutoffClaims &&
          oracle.metrics.exchange === beforeCutoffExchange,
      );
      const cutoffRead = await seedCustody.reconcile(
        JSON.stringify({
          schemaVersion: 1,
          configurationDigest: cutoffIntent.values[0],
          flowId: cutoffIntent.values[1],
          beginCommandId: cutoffIntent.values[2],
          admissionCommandId: cutoffIntent.values[3],
          issuerCommandId: cutoffIntent.values[4],
        }),
        { deadlineMs: Date.now() + 5000, signal: new AbortController().signal },
      );
      check(
        "fresh_restricted_cutoff_commit_reconciliation",
        cutoffRead.outcome === "observed" &&
          cutoffRead.phase === "awaiting_callback" &&
          cutoffRead.issuer_outcome === null,
      );
      cases.push({
        name: "key_cutoff_during_committed_bind",
        passed: true,
        provenance: "fixture_only_monotonic_trusted_clock_same_original_attempt",
        entryDeadlineMs: 5000,
        cutoffOffsetMs: 4000,
        persistedPhase: cutoffRead.phase,
        cookieWithheld: true,
      });
      await disposeInstance(a.runtime);
      a = await isolate(k1Ring);
      stage = "committed_effect_release_unknown";
      const uncertain = await begin(a, k1.keyId);
      await disposeInstance(b.runtime);
      b = await isolate(rotatedRing, { releaseMode: "session_reject" });
      await finish(b, uncertain, false);
      const unknownMetric = sourceMetricRows.at(-1),
        session = unknownMetric.response.pools.sessionPool;
      check(
        "committed_effect_release_unknown_before_admin",
        session.heldClients === 1 &&
          session.normalReleases === 0 &&
          session.primaryAbsenceVerified === 1 &&
          session.leaseReleaseAttempts === 1 &&
          session.leaseReleaseAcks === 0 &&
          unknownMetric.leases.activeLeases === 1,
      );
      // Exact wire ids remain in memory. Reconciliation is a separate read-only
      // restricted-role owner path, not another issuer or callback retry.
      const admission = calls("admit_account_family").at(-1);
      check("actual_issuer_submission_observed", admission?.values.length === 21);
      const { createWorkosAccountAdmission, browserSessionAdmissionSql } = await tsImport(
        "../packages/identity/src/workos-browser-session-admission.ts",
        import.meta.url,
      );
      const { createLoginFlowCustody, loginFlowCustodySql } = await tsImport(
        "../packages/identity/src/login-flow-custody.ts",
        import.meta.url,
      );
      const reconcilePool = harness.pool(
        "morrow_identity_sessions",
        Object.values(browserSessionAdmissionSql),
      );
      const owner = createWorkosAccountAdmission({
        pool: reconcilePool,
        now: Date.now,
        readEvidence: () => {
          throw held();
        },
      });
      const control = { deadlineMs: Date.now() + 5000, signal: new AbortController().signal };
      const reconciled = await owner.reconcile(
        JSON.stringify({
          schemaVersion: 1,
          commandId: admission.values[0],
          requestDigest: admission.values[1],
        }),
      );
      check(
        "real_readonly_issuer_reconciliation_no_secret",
        reconciled.outcome === "replayed" &&
          reconciled.attribution !== null &&
          !Object.hasOwn(reconciled.attribution, "secret"),
      );
      const reconcileFlowPool = harness.pool(
        "morrow_identity_login",
        Object.values(loginFlowCustodySql),
      );
      const custody = createLoginFlowCustody({ pool: reconcileFlowPool, now: Date.now });
      const observed = await custody.reconcile(
        JSON.stringify({
          schemaVersion: 1,
          configurationDigest: uncertain.intent.values[0],
          flowId: uncertain.intent.values[1],
          beginCommandId: uncertain.intent.values[2],
          admissionCommandId: uncertain.intent.values[3],
          issuerCommandId: uncertain.intent.values[4],
        }),
        control,
      );
      check(
        "real_readonly_flow_reconciliation_keeps_unknown",
        observed.outcome === "observed" &&
          observed.phase === "claimed" &&
          observed.issuer_outcome === "admitted" &&
          unknownMetric.leases.activeLeases === 1,
      );
      check(
        "fresh_restricted_reconciliation_backend_cleanup",
        [reconcilePool, reconcileFlowPool].every(
          (pool) =>
            pool.metrics.connections === 1 &&
            pool.metrics.backendCleanupVerified === 1 &&
            pool.metrics.unverifiedHostClosures === 0 &&
            pool.metrics.closed === 1,
        ),
      );
      stage = "pre_admin_request_observation";
      check(
        "all_three_restricted_roles_actually_used",
        roles.every((role) =>
          service.observations.some(
            (o) => o.startup?.user === role && o.authenticationSasl === true,
          ),
        ),
      );
      check(
        "native_fixed_transport_no_escape",
        service.counts().interceptedRequests > 0 &&
          service.counts().deniedRequests === 0 &&
          unexpectedRequests === 0 &&
          oracle.metrics.actualInternetRequests === 0 &&
          oracle.metrics.actualProviderRequests === 0 &&
          oracle.metrics.oracleFailures === 0 &&
          preseedOracle.metrics.oracleFailures === 0 &&
          preseedOracle.metrics.exchange === 0,
      );
      const beforeCleanup = service.bridges.map((b) => ({ ...b.metrics }));
      const countsBefore = service.counts(),
        bridgesBefore = service.bridges.length,
        observationsBefore = service.observations.length;
      engine.revokeEndpoint();
      check(
        "owned_endpoint_capability_revoked",
        resolveControlledNeonPostgresqlEndpoint(engine.endpoint) === null,
      );
      const denied = service.outbound(
        new Request(
          "https://" +
            controlledNeonWireBinding.hostname +
            "/v2?address=" +
            encodeURIComponent(controlledNeonWireBinding.hostname + ":5432"),
          { headers: { Upgrade: "websocket" } },
        ),
      );
      const after = service.counts();
      check(
        "revoked_capability_allocates_nothing",
        denied.status === 403 &&
          after.deniedRequests === countsBefore.deniedRequests + 1 &&
          after.interceptedRequests === countsBefore.interceptedRequests &&
          after.pairAllocations === countsBefore.pairAllocations &&
          service.bridges.length === bridgesBefore &&
          service.observations.length === observationsBefore,
      );
      await Promise.all([...instances].map(disposeInstance));
      await disposeService();
      check(
        "all_worker_WS_TCP_closed_before_admin",
        instances.size === 0 &&
          service.bridges.every(
            (b) =>
              b.metrics.tcpClosed &&
              b.metrics.webSocketClosed &&
              !b.metrics.timerActive &&
              b.metrics.pendingBytes === 0,
          ),
      );
      for (const parser of parsers.values()) parser.finish();
      check(
        "complete_independent_wire_frames",
        service.observations.every((o) => !o.parseFailure) &&
          [...backend.values()].every((bytes) => bytes.length === 0),
      );
      await harness.close();
      const finalNamespace = await engine.observeFinalNamespace();
      check(
        "administrator_cleanup_not_needed_for_backends",
        finalNamespace.presentBeforeFinalCleanup === 0 &&
          finalNamespace.absentAfterFinalCleanup &&
          finalNamespace.forcedFinalCleanup === false,
      );
      return {
        engine: { image: engine.image, version: engine.version, topology: engine.topology, auth },
        peakIndependentIsolates: peakInstances,
        sourceMetricRows,
        actualClaimRows: newlyClaimedRows().length,
        preseededProofLossCases: preseeded.length,
        unknownBeforeFinalAdmin: {
          normalReleaseDenied: session.normalReleases === 0,
          credentialAcknowledgements: session.leaseReleaseAcks,
          activeLeases: unknownMetric.leases.activeLeases,
        },
        reconciliation: {
          transport: "fresh_restricted_role_Unix_psql_not_original_native_clients",
          issuerPool: { ...reconcilePool.metrics },
          flowPool: { ...reconcileFlowPool.metrics },
          issuerOutcome: reconciled.outcome,
          flowOutcome: observed.outcome,
          flowPhase: observed.phase,
          issuerEffect: observed.issuer_outcome,
        },
        wire: service.observations.map((o) => ({
          role: o.startup?.user,
          observer: o.startup?.application_name.endsWith("_o"),
          authenticationSasl: o.authenticationSasl === true,
          frontendFrames: o.messages.length,
          statements: (o.executions ?? []).length,
          parseFailure: o.parseFailure === true,
        })),
        transport: countsBefore,
        revokedCapabilityDenial: {
          status: denied.status,
          deniedRequestsAdded: after.deniedRequests - countsBefore.deniedRequests,
          pairAllocationsAdded: after.pairAllocations - countsBefore.pairAllocations,
          interceptedRequestsAdded: after.interceptedRequests - countsBefore.interceptedRequests,
          tcpBridgesAdded: service.bridges.length - bridgesBefore,
          observationRowsAdded: service.observations.length - observationsBefore,
        },
        beforeEndpointCleanup: beforeCleanup,
        endpointCleanup: service.bridges.map((b) => ({ ...b.metrics })),
        provider: {
          metrics: oracle.metrics,
          calls: oracle.calls,
          preseededNegativeMetrics: preseedOracle.metrics,
        },
        finalNamespace,
      };
    } finally {
      engine.revokeEndpoint();
      await observeCleanup();
    }
  });
  check(
    "owned_container_and_network_absent",
    measured.cleanup.container === "absent" && measured.cleanup.network === "absent",
  );
} catch (error) {
  failure = {
    stage,
    code: "MANAGED_LOGIN_POSTGRESQL_HELD",
    observation: error?.observation ?? null,
  };
} finally {
  await observeCleanup();
}
for (const [path, digest] of Object.entries(sourceDigests))
  check(
    "source_unchanged_" +
      path
        .toLowerCase()
        .replaceAll(/[^a-z0-9]/g, "_")
        .slice(-100),
    hash(readFileSync(path)) === digest,
  );
const report = {
  schema_version: 1,
  task: "P05.T01u",
  status: failure || cleanupFailures.length ? "held" : "passed",
  scope:
    "independent_managed_Workers_capsule_keys_real_PostgreSQL17_fixed_three_role_native_transport",
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
    "Owned T helper/transport provenance retains P05.T01t labels and fresh morrow_id_ application names; this is measured fresh U state, not an old resource.",
    "No hosted Neon, WorkOS account/key, browser sign-in, application ingress or merchant state is used.",
    "Credential rejection remains unknown before independent read-only reconciliation and final physical administrator/container cleanup; physical absence never supplies its acknowledgement.",
    "The bind-cutoff case uses a dedicated fixture-only monotonic trusted clock, crossing key E during the second login-role normal lease acknowledgement while the same original entry D is live; it is not fleet wall-clock or emergency key revocation proof.",
    "Tag/AAD/wrong-claimed-key negatives are independently prepared during setup using unchanged SQL/PKCE owners and real Node AES, then claimed/opened by actual managed Workers; they are distinct from actual managed A-to-B begins.",
    "Reconciliation uses fresh restricted-role Unix psql source adapters, not the native WebSocket transport or the poisoned client's observer. Those existing adapters never call the sealed engine.sql setup function.",
    "Static keyring immutability between deployments is trusted promotion policy, not a persistent registry or emergency revocation mechanism.",
  ],
};
const text = JSON.stringify(report, null, 2) + "\n";
if (privateMarkers.some((marker) => marker && text.includes(marker)))
  throw Error("MANAGED_LOGIN_PG_SECRET_FENCE");
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
