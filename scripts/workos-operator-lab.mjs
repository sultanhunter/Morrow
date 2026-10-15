import * as fs from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect as socketConnect } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localPostgresLab } from "./local-postgres-lab.mjs";
import { localAuthenticationExchangePool } from "./local-authentication-exchange-sql.mjs";
import {
  createAuthenticationExchangeAdmission,
  authenticationExchangeAdmissionSql,
} from "../packages/identity/src/authentication-exchange-admission.ts";
import {
  loadPublicWorkosOperatorScope,
  workosOperatorSourcePaths,
} from "./workos-operator-input.mjs";
import { createWorkosOperatorController } from "./workos-operator-controller.mjs";
import { inspectWorkosOperatorJournal } from "./workos-operator-journal.mjs";
import { createWorkosOperatorTransport } from "./workos-operator-transport.mjs";
import { createWorkosOperatorListener } from "./workos-operator-listener.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const literal = (s) => "'" + String(s).replaceAll("'", "''") + "'";
function databaseInputs() {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (realpathSync(process.cwd()) !== sourceRoot)
    throw Error("WORKOS_OPERATOR_SOURCE_DIRECTORY_REQUIRED");
  const scope = JSON.parse(loadPublicWorkosOperatorScope());
  const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
  const migrations = manifest.migrations.slice(0, 6).map((m, i) => {
    const text = readFileSync("migrations/" + m.file, "utf8");
    if (m.sequence !== i + 1 || hash(text) !== m.sha256)
      throw Error("WORKOS_OPERATOR_MIGRATION_INVALID");
    return text;
  });
  if (migrations.length !== 6) throw Error("WORKOS_OPERATOR_MIGRATION_INVALID");
  return { scope, migrations, binding: JSON.parse(scope.bindingJson) };
}
// Exact local SQL69 adapter, shared with the explicitly activated operator CLI.
// This function alone confers no browser/provider authority and has no network
// listener. No hosted database, credential, provider, session or grant is used.
export async function withWorkosOperatorDatabase(use) {
  const { scope, migrations, binding } = databaseInputs();
  return localPostgresLab("P05.T01e", async ({ id, sql, image, version }) => {
    sql("CREATE DATABASE morrow;");
    sql(readFileSync("infra/identity-role-prerequisites.sql", "utf8"), "morrow");
    const install = () => {
      for (const text of migrations) sql("SET ROLE morrow_identity_owner;\n" + text, "morrow");
      sql(
        `SET ROLE morrow_identity_owner; INSERT INTO morrow_identity.authentication_bindings VALUES(${literal(binding.bindingId)},${literal(binding.environmentId)},${literal(binding.clientId)},${literal(binding.redirectUri)},${literal(binding.returnPath)},true); INSERT INTO morrow_identity.authentication_exchange_bindings VALUES(${literal(binding.bindingId)},'workos',${literal(binding.applicationId)},1,true);`,
        "morrow",
      );
    };
    install();
    sql("ALTER ROLE morrow_identity_preauth LOGIN;");
    const pool = localAuthenticationExchangePool(id),
      admission = createAuthenticationExchangeAdmission(pool, scope.bindingJson);
    try {
      return await use({ admission, pool, id, sql, image, version, binding, install });
    } finally {
      await pool.close();
    }
  });
}
function request(method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: 4110,
        path: url,
        method,
        headers: { connection: "close", ...headers },
        timeout: 5000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          if (text.length > 131072) req.destroy();
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on("error", () => reject(Error("WORKOS_OPERATOR_LOOPBACK_FAILED")));
    req.on("timeout", () => req.destroy());
    req.end(body);
  });
}
function rawRequest(raw) {
  return new Promise((resolve, reject) => {
    const socket = socketConnect({ host: "127.0.0.1", port: 4110 }, () => socket.end(raw));
    let text = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("data", (c) => (text += c));
    socket.on("error", () => reject(Error("WORKOS_OPERATOR_LOOPBACK_FAILED")));
    socket.on("end", () => resolve(text));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(25);
  }
  throw Error("WORKOS_OPERATOR_LAB_WAIT_FAILED");
}

export async function runWorkosOperatorLab() {
  const checks = [],
    controllers = [],
    roots = [],
    secrets = [],
    httpBodies = [];
  const check = (name, ok) => {
    if (!ok) throw Error("WORKOS_OPERATOR_LAB_FAILED:" + name);
    checks.push({ name, passed: true });
  };
  const scopeJson = loadPublicWorkosOperatorScope(),
    scope = JSON.parse(scopeJson),
    profile = JSON.parse(scope.profileJson);
  let fakePosts = 0;
  try {
    const result = await withWorkosOperatorDatabase(
      async ({ admission, pool, id, sql, image, version, binding, install }) => {
        const admin = (text) => sql("SET ROLE morrow_identity_owner; " + text, "morrow");
        const count = (table) =>
          Number(admin("SELECT count(*) FROM morrow_identity." + table + ";"));
        check(
          "local_role_only_preauth_enabled",
          sql(
            "SELECT count(*)=1 FROM pg_roles WHERE rolname IN('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth') AND rolcanlogin;",
            "morrow",
          ) === "t",
        );
        check(
          "local_role_has_no_elevation",
          sql(
            "SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) FROM pg_roles r WHERE rolname='morrow_identity_preauth';",
            "morrow",
          ) === "t",
        );
        async function fixture(options = {}) {
          const root = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), "morrow-workos-pg-")),
          );
          roots.push(root);
          await fs.chmod(root, 0o700);
          const meta = await fs.stat(root, { bigint: true });
          let clock = Date.now(),
            current = scopeJson;
          const activation = {
            schemaVersion: 1,
            mode: "synthetic",
            operationId: randomUUID(),
            activationId: randomUUID(),
            beginCommandId: randomUUID(),
            callbackCommandId: randomUUID(),
            planSequence: 71,
            planDigest: scope.planDigest,
            sourceDigest: scope.sourceDigest,
            profileDigest: scope.profileDigest,
            bindingDigest: scope.bindingDigest,
            environmentId: profile.environment_id,
            applicationId: profile.application_id,
            clientId: profile.client_id,
            bindingId: profile.binding_id,
            bindingRevision: 1,
            ownerUid: process.getuid(),
            rootDevice: String(meta.dev),
            rootInode: String(meta.ino),
            expiresAt: new Date(clock + 300000).toISOString(),
            tokenEndpoint: profile.token_endpoint,
            maxInitiations: 1,
            maxPosts: 1,
            ownerApproved: true,
            callbackRegistered: true,
            cleanupBaseline: true,
          };
          let posts = 0;
          const transport = createWorkosOperatorTransport(scope.profileJson, {
            mode: "synthetic",
            clock: () => clock,
            fetch: async (url, init) => {
              posts++;
              fakePosts++;
              check(
                "synthetic_request_fixed_endpoint_" + fakePosts,
                url === profile.token_endpoint &&
                  init.method === "POST" &&
                  init.redirect === "error",
              );
              const body = JSON.parse(init.body);
              check(
                "synthetic_request_closed_fields_" + fakePosts,
                Object.keys(body).sort().join(",") === "client_id,code,code_verifier,grant_type" &&
                  body.client_id === profile.client_id &&
                  body.grant_type === "authorization_code",
              );
              secrets.push(body.code, body.code_verifier);
              const marker = JSON.parse(
                await fs.readFile(path.join(root, "send_requested.json"), "utf8"),
              );
              check(
                "durable_send_precedes_fake_post_" + fakePosts,
                marker.codeDigest === hash(body.code),
              );
              if (options.fetch) await options.fetch();
              const response = new Response(
                JSON.stringify({
                  access_token: ["synthetic", "access", "token", "only"].join("-"),
                  refresh_token: "synthetic-refresh-token-only",
                  user: { id: "user_00000000000000000000000001" },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
              Object.defineProperty(response, "url", { value: profile.token_endpoint });
              return response;
            },
          });
          const configuration = {
            scopeJson,
            activationJson: JSON.stringify(activation),
            journalRoot: root,
            admission: options.admission ?? admission,
            transport,
            currentScope: async () => current,
            clock: () => clock,
            journalFault: options.journalFault,
          };
          const controller = await createWorkosOperatorController(configuration);
          controllers.push(controller);
          check(
            "fresh_synthetic_claim_ready_" + roots.length,
            controller.status().state === "ready",
          );
          return {
            root,
            activation,
            configuration,
            controller,
            posts: () => posts,
            setClock(v) {
              clock = v;
            },
            time: () => clock,
            setScope(v) {
              current = v;
            },
          };
        }
        check("before_claim_database_empty", count("authentication_challenges") === 0);
        let releasePost;
        const postBarrier = new Promise((r) => (releasePost = r));
        const f = await fixture({ fetch: () => postBarrier });
        check(
          "claim_before_sql_begin",
          count("authentication_challenges") === 0 &&
            (await fs.readdir(f.root)).join(",") === "claim.json",
        );
        const listener = createWorkosOperatorListener(scope.profileJson, f.controller, {
          clock: f.time,
        });
        await listener.listen();
        try {
          const first = await request("GET", profile.start_path);
          httpBodies.push(first.text);
          check(
            "actual_get_bootstrap_no_sql",
            first.status === 200 && count("authentication_challenges") === 0,
          );
          const csrf = /name="csrf" value="([A-Za-z0-9_-]{43})"/.exec(first.text)?.[1],
            bootstrap = first.headers["set-cookie"]?.[0]?.split(";")[0];
          check("actual_bootstrap_form_and_cookie", !!csrf && !!bootstrap);
          secrets.push(csrf, bootstrap.split("=")[1]);
          check(
            "actual_privacy_headers",
            first.headers["cache-control"] === "no-store" &&
              first.headers["referrer-policy"] === "same-origin" &&
              first.headers["x-content-type-options"] === "nosniff" &&
              first.headers["x-frame-options"] === "DENY" &&
              !first.headers["access-control-allow-origin"],
          );
          check(
            "actual_duplicate_host_denied",
            (
              await rawRequest(
                `GET ${profile.start_path} HTTP/1.1\r\nHost: 127.0.0.1:4110\r\nHost: foreign.invalid\r\nConnection: close\r\n\r\n`,
              )
            ).startsWith("HTTP/1.1 400"),
          );
          const body = "csrf=" + csrf;
          const startHeaders = {
            cookie: bootstrap,
            origin: profile.origin,
            "content-type": "application/x-www-form-urlencoded",
            "content-length": String(Buffer.byteLength(body)),
          };
          check(
            "actual_foreign_origin_denied",
            (
              await request(
                "POST",
                profile.start_path,
                { ...startHeaders, origin: "https://foreign.invalid" },
                body,
              )
            ).status === 400,
          );
          check(
            "actual_bad_csrf_denied",
            (
              await request(
                "POST",
                profile.start_path,
                { ...startHeaders, "content-length": "10" },
                "csrf=wrong",
              )
            ).status === 400,
          );
          check("invalid_start_no_sql", count("authentication_challenges") === 0);
          const started = await request("POST", profile.start_path, startHeaders, body);
          httpBodies.push(started.text);
          check(
            "actual_start_uses_sql69",
            started.status === 200 &&
              count("authentication_challenges") === 1 &&
              count("authentication_pkce_challenges") === 1,
          );
          const link = /href="([^"]+)"/.exec(started.text)?.[1]?.replaceAll("&amp;", "&"),
            url = new URL(link),
            state = url.searchParams.get("state");
          secrets.push(state);
          const browserCookie = started.headers["set-cookie"]?.find((v) =>
            v.startsWith("morrow_operator_browser="),
          );
          const cookie = browserCookie?.split(";")[0];
          secrets.push(cookie.split("=")[1]);
          check(
            "actual_static_authorization_continuation",
            url.origin + url.pathname === profile.authorize_endpoint &&
              started.headers["content-security-policy"].includes("form-action 'self'") &&
              !started.headers.location,
          );
          check(
            "actual_browser_cookie_scoped",
            browserCookie.includes("Path=/operator/workos;") &&
              browserCookie.includes("HttpOnly") &&
              browserCookie.includes("SameSite=Lax") &&
              !browserCookie.includes("Domain=") &&
              !browserCookie.includes("Secure"),
          );
          check(
            "initiation_marker_precedes_link",
            JSON.parse(await fs.readFile(path.join(f.root, "initiation_started.json"), "utf8"))
              .record === "initiation_started",
          );
          const code = "synthetic-operator-code +%/雪";
          secrets.push(code);
          const callback =
            profile.callback_path + "?state=" + state + "&code=" + encodeURIComponent(code);
          check("actual_missing_cookie_denied", (await request("GET", callback)).status === 400);
          check(
            "actual_duplicate_cookie_denied",
            (await request("GET", callback, { cookie: cookie + "; " + cookie })).status === 400,
          );
          check(
            "actual_malformed_utf8_denied",
            (
              await request("GET", profile.callback_path + "?state=" + state + "&code=%C0%AF", {
                cookie,
              })
            ).status === 400,
          );
          check(
            "actual_unknown_callback_field_denied",
            (await request("GET", callback + "&extra=x", { cookie })).status === 400,
          );
          check(
            "invalid_callbacks_no_admission",
            count("authentication_exchange_admissions") === 0 && f.posts() === 0,
          );
          const pair = await Promise.race([
            Promise.all([
              request("GET", callback, { cookie }),
              request("GET", callback, { cookie }),
            ]),
            sleep(1500).then(() => {
              throw Error("CALLBACK_DID_NOT_REDIRECT_PROMPTLY");
            }),
          ]);
          check(
            "concurrent_callbacks_one_quick_clean_redirect",
            pair.filter((v) => v.status === 303).length === 1 &&
              pair.filter((v) => v.status === 400).length === 1 &&
              pair.find((v) => v.status === 303).headers.location ===
                profile.origin + profile.result_path,
          );
          await until(() => f.posts() === 1);
          check(
            "one_real_sql_reservation_one_fake_post",
            count("authentication_exchange_admissions") === 1 && f.posts() === 1,
          );
          const pendingResult = await request("GET", profile.result_path);
          httpBodies.push(pendingResult.text);
          check(
            "result_read_during_provider_wait",
            pendingResult.status === 200 &&
              pendingResult.text.includes("processing") &&
              count("authentication_exchange_admissions") === 1,
          );
          releasePost();
          await until(() => f.controller.status().state !== "processing");
          check(
            "synthetic_shape_not_identity",
            f.controller.status().state === "response_shape_received" &&
              f.controller.status().providerSessionCleanup === "unknown",
          );
          const resultPage = await request("GET", profile.result_path);
          check(
            "result_contains_no_callback_secrets",
            !secrets.filter(Boolean).some((s) => resultPage.text.includes(s)),
          );
          check(
            "repeat_callback_never_resends",
            (await request("GET", callback, { cookie })).status === 400 && f.posts() === 1,
          );
        } finally {
          releasePost();
          await listener.close();
        }
        const originalFiles = await fs.readdir(f.root),
          beforeInspect = await Promise.all(
            originalFiles.map(async (n) => {
              const s = await fs.stat(path.join(f.root, n));
              return [n, s.mtimeMs, s.size];
            }),
          );
        check(
          "inspection_held_after_observation",
          (await inspectWorkosOperatorJournal(f.root)).state === "held",
        );
        const afterInspect = await Promise.all(
          originalFiles.map(async (n) => {
            const s = await fs.stat(path.join(f.root, n));
            return [n, s.mtimeMs, s.size];
          }),
        );
        check(
          "inspection_preserves_files",
          JSON.stringify(beforeInspect) === JSON.stringify(afterInspect),
        );
        check(
          "restart_cannot_recreate_send_handle",
          (await createWorkosOperatorController(f.configuration)).status().state === "held" &&
            f.posts() === 1,
        );

        // Real READ ONLY reconciliation rejects owner configuration drift after a
        // successfully committed admission. No parallel fake authority adapter.
        let realAdmission;
        const drifting = {
          ...admission,
          async admit(input) {
            const result = await admission.admit(input);
            realAdmission = result;
            admin(
              `UPDATE morrow_identity.authentication_exchange_bindings SET active=false WHERE binding_id=${literal(binding.bindingId)};`,
            );
            return result;
          },
        };
        const drift = await fixture({ admission: drifting });
        const dm = await drift.controller.start();
        secrets.push(dm.state, dm.browserProof);
        check(
          "config_drift_after_admission_holds",
          (
            await drift.controller.complete(
              JSON.stringify({
                state: dm.state,
                browserProof: dm.browserProof,
                code: "synthetic-config-drift",
              }),
            )
          ).state === "held" &&
            realAdmission.outcome === "newly_reserved" &&
            drift.posts() === 0,
        );
        check(
          "config_drift_no_send_marker",
          !(await fs.readdir(drift.root)).includes("send_requested.json"),
        );
        admin(
          `UPDATE morrow_identity.authentication_exchange_bindings SET active=true WHERE binding_id=${literal(binding.bindingId)};`,
        );
        const expired = await fixture(),
          em = await expired.controller.start();
        secrets.push(em.state, em.browserProof);
        expired.setClock(expired.time() + 300001);
        let expiryRejected = false;
        try {
          expired.controller.complete(
            JSON.stringify({
              state: em.state,
              browserProof: em.browserProof,
              code: "synthetic-expired",
            }),
          );
        } catch {
          expiryRejected = true;
        }
        check(
          "controller_deadline_holds_before_actual_sql_admission",
          expiryRejected && expired.posts() === 0,
        );

        // Actual COMMIT succeeds, then the application loses its acknowledgement.
        let dropCommit = false;
        const lossPool = {
          async connect() {
            const client = await pool.connect();
            return {
              async query(q, args) {
                const result = await client.query(q, args);
                if (dropCommit && q === authenticationExchangeAdmissionSql.commit) {
                  dropCommit = false;
                  throw Error("SYNTHETIC_ACK_LOSS");
                }
                return result;
              },
              release: (discard) => client.release(discard),
            };
          },
        };
        const loss = await fixture({
            admission: createAuthenticationExchangeAdmission(lossPool, scope.bindingJson),
          }),
          lm = await loss.controller.start();
        secrets.push(lm.state, lm.browserProof);
        dropCommit = true;
        const countBeforeLoss = count("authentication_exchange_admissions");
        check(
          "real_commit_ack_loss_holds",
          (
            await loss.controller.complete(
              JSON.stringify({
                state: lm.state,
                browserProof: lm.browserProof,
                code: "synthetic-commit-loss",
              }),
            )
          ).state === "held" && loss.posts() === 0,
        );
        check(
          "commit_loss_has_one_durable_reservation",
          count("authentication_exchange_admissions") === countBeforeLoss + 1,
        );
        check(
          "commit_loss_restart_no_retry",
          (await createWorkosOperatorController(loss.configuration)).status().state === "held",
        );
        const observationLoss = await fixture({
            journalFault: async (name, stage) => {
              if (name === "observation.json" && stage === "after_file_sync")
                throw Error("SYNTHETIC_OBSERVATION_LOSS");
            },
          }),
          om = await observationLoss.controller.start();
        secrets.push(om.state, om.browserProof);
        check(
          "observation_ack_loss_holds_sent_attempt",
          (
            await observationLoss.controller.complete(
              JSON.stringify({
                state: om.state,
                browserProof: om.browserProof,
                code: "synthetic-observation-loss",
              }),
            )
          ).state === "held" && observationLoss.posts() === 1,
        );
        check(
          "observation_loss_restart_no_second_post",
          (await createWorkosOperatorController(observationLoss.configuration)).status().state ===
            "held" && observationLoss.posts() === 1,
        );

        // Expiry and request budget exercised through the actual fixed listener.
        for (const scenario of ["expiry", "rate"]) {
          const extra = await fixture();
          const l = createWorkosOperatorListener(scope.profileJson, extra.controller, {
            clock: extra.time,
          });
          await l.listen();
          try {
            if (scenario === "expiry") {
              extra.setClock(extra.time() + 300001);
              check(
                "actual_listener_expiry_denied",
                (await request("GET", profile.start_path)).status === 410,
              );
            } else {
              let response;
              for (let i = 0; i < 22; i++) response = await request("GET", "/invalid");
              check("actual_listener_invalid_request_budget", response.status === 429);
            }
            check("listener_" + scenario + "_no_post", extra.posts() === 0);
          } finally {
            await l.close();
          }
        }
        // Keep the operator journal while actually dropping/recreating the DB.
        await pool.close();
        sql("DROP DATABASE morrow; CREATE DATABASE morrow;");
        sql(
          "ALTER ROLE morrow_identity_preauth NOLOGIN; GRANT CREATE ON DATABASE morrow TO morrow_identity_owner;",
        );
        install();
        sql("ALTER ROLE morrow_identity_preauth LOGIN;");
        check(
          "actual_recreated_database_has_no_admission",
          count("authentication_exchange_admissions") === 0,
        );
        const replacementPool = localAuthenticationExchangePool(id);
        try {
          let attempts = 0;
          const replacement = createAuthenticationExchangeAdmission(
            {
              async connect() {
                attempts++;
                return replacementPool.connect();
              },
            },
            scope.bindingJson,
          );
          check(
            "retained_journal_blocks_recreated_database",
            (
              await createWorkosOperatorController({ ...f.configuration, admission: replacement })
            ).status().state === "held" &&
              attempts === 0 &&
              f.posts() === 1,
          );
        } finally {
          await replacementPool.close();
        }
        const records = [];
        for (const root of roots)
          for (const n of await fs.readdir(root))
            records.push(await fs.readFile(path.join(root, n), "utf8"));
        const durable = records.join("\n"),
          sqlOutput = pool.observed.map((o) => o.stdout + o.stderr).join("\n");
        check(
          "all_journals_exclude_raw_proofs_codes_tokens",
          !secrets.filter(Boolean).some((s) => durable.includes(s)) &&
            !durable.includes("synthetic-access-token-only") &&
            !durable.includes("synthetic-refresh-token-only"),
        );
        check(
          "actual_sql_output_excludes_raw_proofs_codes",
          !secrets.filter(Boolean).some((s) => sqlOutput.includes(s)),
        );
        check("only_synthetic_injected_provider_transport", fakePosts === 2);
        return { image, version };
      },
    );
    const sources = Object.fromEntries(
      [...workosOperatorSourcePaths, "tests/workos-operator-controller.test.mjs"].map((name) => [
        name,
        hash(readFileSync(name)),
      ]),
    );
    const report = {
      schema_version: 1,
      packet: "P05.T01e",
      plan_sequence: 71,
      generated_at: new Date().toISOString(),
      status: "synthetic_local_qualified_not_provider_qualified",
      engine: result,
      actual_loopback_origin: "http://127.0.0.1:4110",
      actual_postgresql: true,
      real_provider_requests: 0,
      synthetic_provider_requests: fakePosts,
      provider_session_cleanup: "unknown",
      checks,
      sources,
    };
    await fs.mkdir("docs/evidence/P05.T01e", { recursive: true });
    await fs.writeFile(
      "docs/evidence/P05.T01e/postgresql-loopback-lab.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    return report;
  } finally {
    for (const controller of controllers) await controller.close();
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runWorkosOperatorLab();
    console.log(
      JSON.stringify({
        packet: report.packet,
        checks: report.checks.length,
        realProviderRequests: 0,
        syntheticProviderRequests: report.synthetic_provider_requests,
        status: report.status,
      }),
    );
  } catch (error) {
    console.error(
      typeof error?.message === "string" &&
        /^(WORKOS_OPERATOR_LAB_FAILED:[A-Za-z0-9_]+|WORKOS_OPERATOR_[A-Z_]+|CALLBACK_DID_NOT_REDIRECT_PROMPTLY|LOCAL_[A-Z_:]+)$/.test(
          error.message,
        )
        ? error.message
        : "WORKOS_OPERATOR_LAB_FAILED",
    );
    process.exitCode = 1;
  }
}
