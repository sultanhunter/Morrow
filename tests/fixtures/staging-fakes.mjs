// Fakes for the staging tools (P04.T01i PR-B): wrangler, gh, git and neonctl as
// in-process functions with the real tools' result shape {status, stdout, stderr}, a
// Cloudflare API, a scriptable database, and a context builder. No fake ever starts a
// process or touches the network; every call is recorded (args, stdin, environment
// keys) so tests can prove where each value went. `emit` makes a fake print marker text
// on stdout and stderr, and `fail` makes it exit non-zero, so tests can show that tool
// output never reaches the staging tool's own output.
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StagingError } from "../../scripts/staging-common.mjs";

export const fakeSha = (seed) => createHash("sha1").update(String(seed)).digest("hex");
// git's blob object id for `text`.
export const fakeBlobId = (text) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const missing = () => ({ status: 1, stdout: "", stderr: "HTTP 404" });
// Worker key -> staging script name, as in infra/environments/staging.json.
export const scriptOf = Object.freeze({
  api: "morrow-staging-api",
  broker: "morrow-staging-broker",
  orchestrator: "morrow-staging-orchestrator",
  connector: "morrow-staging-connector",
});
export const fakeUuid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");

export function fakeTools(options = {}) {
  const calls = [];
  const state = {
    main: options.git?.main ?? fakeSha("main"),
    head: options.git?.head ?? options.git?.main ?? fakeSha("main"),
    status: options.git?.status ?? "",
    diff: options.git?.diff ?? "",
    // The committed tree at main: path -> {text, mode = "100644", type = "blob"}.
    files: options.git?.files ?? {},
    checkRuns: options.gh?.checkRuns ?? null,
    ghSecrets: options.gh?.secrets ?? [
      { name: "CLOUDFLARE_API_TOKEN", updatedAt: "2026-10-19T10:00:00Z" },
    ],
    ghVariables: options.gh?.variables ?? [
      { name: "CLOUDFLARE_ACCOUNT_ID", updatedAt: "2026-10-19T10:00:00Z" },
      { name: "STAGING_DEPLOY_ENABLED", updatedAt: "2026-10-19T10:00:00Z" },
    ],
    variables: {},
    workerSecrets: structuredClone(
      options.wrangler?.secrets ?? { api: [], broker: [], orchestrator: [], connector: [] },
    ),
    versions: options.wrangler?.versions ?? [
      {
        id: "00000000-0000-4000-8000-000000000001",
        metadata: { created_on: "2026-10-19T10:00:00Z" },
      },
    ],
    bulkInputs: [],
    // GitHub: variable values, the deploy workflow's state, main's tip and its runs.
    values: { ...(options.gh?.values ?? {}) },
    workflow: options.gh?.workflow ?? "active",
    mainTip: options.gh?.mainTip ?? null,
    runs: structuredClone(options.gh?.runs ?? []),
    deployed: [],
    deploySerial: 100,
  };
  // `cloudflare` (a fakeCloudflare) receives each successful `wrangler deploy`, so the
  // deployed version and the api's workers.dev state move as the real ones do.
  const cloudflare = options.cloudflare ?? null;
  const emit = options.emit ?? null;
  const decorate = (result) =>
    emit
      ? { ...result, stdout: result.stdout + (result.status === 0 ? "" : emit), stderr: emit }
      : result;
  const failure = (tool, args) => {
    const rule = options.fail?.[tool];
    if (!rule) return null;
    if (typeof rule === "function" ? rule(args) : true)
      return { status: options.failStatus ?? 1, stdout: emit ?? "", stderr: emit ?? "" };
    return null;
  };
  const record = (tool, args, extra = {}) => calls.push({ tool, args: [...args], ...extra });
  const workerOf = (args) => {
    const config = args[args.indexOf("--config") + 1] ?? "";
    return /apps\/(api|broker)\//.test(config)
      ? /apps\/api\//.test(config)
        ? "api"
        : "broker"
      : /apps\/workers\//.test(config)
        ? "orchestrator"
        : "connector";
  };
  const tools = {
    async git(args) {
      record("git", args);
      const failed = failure("git", args);
      if (failed) return failed;
      if (args[0] === "fetch") return ok();
      if (args[0] === "status") return ok(state.status);
      if (args[0] === "rev-parse")
        return ok((args.includes("HEAD^{commit}") ? state.head : state.main) + "\n");
      if (args[0] === "diff") return ok(state.diff);
      // `ls-tree -z --full-tree <commit> -- <path>` and `cat-file blob <id>`, over the
      // committed tree at main; any other commit is not an object here.
      if (args[0] === "ls-tree") {
        const commit = args[args.indexOf("--") - 1];
        const path = args[args.indexOf("--") + 1];
        if (commit !== state.main) return { status: 128, stdout: "", stderr: "" };
        const file = Object.hasOwn(state.files, path) ? state.files[path] : null;
        return ok(
          file
            ? `${file.mode ?? "100644"} ${file.type ?? "blob"} ${fakeBlobId(file.text)}\t${path}\0`
            : "",
        );
      }
      if (args[0] === "cat-file" && args[1] === "blob") {
        const file = Object.values(state.files).find((f) => fakeBlobId(f.text) === args[2]);
        return file ? ok(file.text) : { status: 128, stdout: "", stderr: "" };
      }
      return { status: 2, stdout: "", stderr: "" };
    },
    async gh(args, { input } = {}) {
      record("gh", args, { input: input ?? null });
      const failed = failure("gh", args);
      if (failed) return failed;
      if (args[0] === "api" && /check-runs/.test(args[1])) {
        const runs = state.checkRuns ?? [
          { name: "foundation", head_sha: state.main, status: "completed", conclusion: "success" },
        ];
        return decorate(ok(JSON.stringify({ total_count: runs.length, check_runs: runs })));
      }
      if (args[0] === "secret" && args[1] === "list")
        return decorate(ok(JSON.stringify(state.ghSecrets)));
      if (args[0] === "variable" && args[1] === "list")
        return decorate(ok(JSON.stringify(state.ghVariables)));
      if (args[0] === "variable" && args[1] === "set") {
        state.variables[args[2]] = args[args.indexOf("--body") + 1];
        state.values[args[2]] = args[args.indexOf("--body") + 1];
        return decorate(ok());
      }
      if (args[0] === "auth" && args[1] === "status") return decorate(ok());
      if (args[0] === "api") {
        const method = args[1] === "-X" ? args[2] : "GET";
        const path = args[1] === "-X" ? args[3] : args[1];
        const variable =
          /^repos\/[^/]+\/[^/]+\/(?:environments\/staging|actions)\/variables\/([A-Z_]+)$/.exec(
            path,
          );
        if (variable)
          return Object.hasOwn(state.values, variable[1])
            ? decorate(ok(JSON.stringify({ name: variable[1], value: state.values[variable[1]] })))
            : missing();
        if (/\/git\/ref\/heads\/main$/.test(path))
          return decorate(ok(JSON.stringify({ object: { sha: state.mainTip ?? state.main } })));
        if (/\/actions\/workflows\/deploy-staging\.yml$/.test(path))
          return decorate(ok(JSON.stringify({ state: state.workflow })));
        if (/\/actions\/workflows\/deploy-staging\.yml\/runs\?per_page=\d+$/.test(path))
          return decorate(ok(JSON.stringify({ workflow_runs: state.runs })));
        if (method === "PUT" && /\/actions\/workflows\/deploy-staging\.yml\/disable$/.test(path)) {
          state.workflow = "disabled_manually";
          return decorate(ok());
        }
        if (method === "PUT" && /\/actions\/workflows\/deploy-staging\.yml\/enable$/.test(path)) {
          state.workflow = "active";
          return decorate(ok());
        }
        const cancel = /\/actions\/runs\/(\d+)\/cancel$/.exec(path);
        if (method === "POST" && cancel) {
          const run = state.runs.find((r) => String(r.id) === cancel[1]);
          if (run) run.status = "completed";
          return decorate(ok());
        }
      }
      return { status: 2, stdout: "", stderr: "" };
    },
    async wrangler(args, { input } = {}) {
      record("wrangler", args, { input: input ?? null });
      const failed = failure("wrangler", args);
      if (failed) return failed;
      const worker = workerOf(args);
      if (args[0] === "secret" && args[1] === "list")
        return decorate(
          ok(
            JSON.stringify(
              (state.workerSecrets[worker] ?? []).map((name) => ({ name, type: "secret_text" })),
            ),
          ),
        );
      if (args[0] === "secret" && args[1] === "bulk") {
        state.bulkInputs.push({ worker, input });
        const names = Object.keys(JSON.parse(input));
        state.workerSecrets[worker] = [
          ...new Set([...(state.workerSecrets[worker] ?? []), ...names]),
        ].sort();
        state.versions = [
          ...state.versions,
          {
            id: "00000000-0000-4000-8000-" + String(state.versions.length + 1).padStart(12, "0"),
            metadata: {
              created_on:
                "2026-10-19T11:" + String(state.versions.length).padStart(2, "0") + ":00Z",
            },
          },
        ];
        return decorate(ok("✨ Successfully created secret for key"));
      }
      if (args[0] === "versions" && args[1] === "list")
        return decorate(ok(JSON.stringify(state.versions)));
      if (args[0] === "deploy") {
        const versionId = fakeUuid(state.deploySerial++);
        // A hook runs while the upload is "in flight" (the kill race); a deploy then
        // lands, which on the api and (v1 PR 1) the connector re-enables workers.dev, as
        // wrangler does with their `workers_dev: true`.
        await options.onDeploy?.(worker, state);
        const lands = options.deployLands?.(worker) ?? true;
        if (lands) {
          state.deployed.push(worker);
          cloudflare?.deploy(scriptOf[worker], versionId, {
            workersDev: worker === "api" || worker === "connector",
          });
        }
        const failed = options.deployFails?.(worker);
        if (failed) return { status: 1, stdout: emit ?? "", stderr: emit ?? "", output: [] };
        return {
          ...decorate(ok("Deployed " + scriptOf[worker])),
          output: lands
            ? [
                { type: "wrangler-session", version: 1 },
                {
                  type: "deploy",
                  version: 1,
                  worker_name: scriptOf[worker],
                  version_id: versionId,
                },
              ]
            : [],
        };
      }
      return { status: 2, stdout: "", stderr: "" };
    },
    async neonctl(args, { input } = {}) {
      record("neonctl", args, { input: input ?? null });
      const failed = failure("neonctl", args);
      if (failed) return failed;
      const reply = options.neonctl?.(args, state);
      if (reply) return decorate(reply);
      return { status: 2, stdout: "", stderr: "" };
    },
  };
  return { tools, calls, state };
}

// A Cloudflare API: the census reads, deployments, the workers.dev switch, queues and
// Turnstile widgets. `failWith` makes every request fail with a fixed code, as the real
// client does for an error reply. `deploy` is how fakeTools' `wrangler deploy` lands.
export function fakeCloudflare(options = {}) {
  const calls = [];
  const scripts = structuredClone(
    options.scripts ?? [
      {
        name: "morrow-staging-api",
        enabled: true,
        previews: false,
        bindings: [{ service: "morrow-staging-broker", entrypoint: "ApiBroker" }],
      },
      { name: "morrow-staging-broker", enabled: false, previews: false, bindings: [] },
      { name: "morrow-staging-orchestrator", enabled: false, previews: false, bindings: [] },
      // v1 PR 1 (ADR-0035 item 2): the connector is the second public Worker.
      { name: "morrow-staging-connector", enabled: true, previews: false, bindings: [] },
    ],
  );
  const deployments = { ...(options.deployments ?? {}) };
  for (const script of scripts) deployments[script.name] ??= fakeUuid(scripts.indexOf(script) + 1);
  const queues = structuredClone(options.queues ?? []);
  const widgets = structuredClone(options.widgets ?? []);
  const notFound = () => new StagingError("STAGING_CLOUDFLARE_REQUEST_FAILED", { status: 404 });
  const scriptNamed = (name) => scripts.find((s) => s.name === name);
  const api = {
    async get(segments) {
      calls.push(segments.join("/"));
      if (options.failWith) throw new StagingError(options.failWith, { status: 403 });
      const path = segments.join("/");
      if (path === "workers/scripts") return scripts.map((s) => ({ id: s.name }));
      const match = /^workers\/scripts\/([^/]+)\/(subdomain|settings|deployments)$/.exec(path);
      if (match) {
        const script = scriptNamed(match[1]);
        if (!script) throw notFound();
        if (match[2] === "deployments")
          return {
            deployments: [
              {
                id: "dep-" + script.name,
                created_on: "2026-10-20T10:00:00Z",
                versions: [{ version_id: deployments[script.name], percentage: 100 }],
              },
            ],
          };
        return match[2] === "subdomain"
          ? { enabled: script.enabled, previews_enabled: script.previews }
          : {
              // A binding is a service name, or {service, entrypoint} (M2 PR-2).
              bindings: script.bindings.map((binding) =>
                typeof binding === "string"
                  ? { type: "service", name: "BROKER", service: binding }
                  : { type: "service", name: "BROKER", ...binding },
              ),
            };
      }
      if (path === "workers/dispatch/namespaces") {
        if (options.namespacesError)
          throw new StagingError("STAGING_CLOUDFLARE_REQUEST_FAILED", options.namespacesError);
        return options.namespaces ?? [];
      }
      if (path === "queues") {
        if (options.queueListFails) throw notFound();
        return queues;
      }
      throw new StagingError("STAGING_CLOUDFLARE_REQUEST_FAILED", { status: 404 });
    },
    async list(segments) {
      calls.push(segments.join("/"));
      if (options.failWith) throw new StagingError(options.failWith, { status: 403 });
      const path = segments.join("/");
      if (path === "pages/projects") return options.pages ?? [];
      if (path === "members") return options.members ?? [{ id: "member-1" }];
      if (path === "challenges/widgets") return widgets;
      throw new StagingError("STAGING_CLOUDFLARE_REQUEST_FAILED", { status: 404 });
    },
    async request(method, segments, { body } = {}) {
      calls.push(method + " " + segments.join("/"));
      if (options.failWith) throw new StagingError(options.failWith, { status: 403 });
      const path = segments.join("/");
      const subdomain = /^workers\/scripts\/([^/]+)\/subdomain$/.exec(path);
      if (method === "POST" && subdomain) {
        const script = scriptNamed(subdomain[1]);
        if (!script) throw notFound();
        if (options.subdomainFails) throw new StagingError("STAGING_CLOUDFLARE_UNAVAILABLE");
        script.enabled = body.enabled;
        script.previews = body.previews_enabled;
        return { success: true, result: { enabled: script.enabled, previews_enabled: false } };
      }
      if (method === "POST" && path === "queues") {
        const outcome = options.queueCreate?.(body.queue_name) ?? "ok";
        if (outcome !== "fail") queues.push({ queue_name: body.queue_name, queue_id: "q" });
        if (outcome !== "ok") throw new StagingError("STAGING_CLOUDFLARE_UNAVAILABLE");
        return { success: true, result: { queue_name: body.queue_name } };
      }
      if (method === "POST" && path === "challenges/widgets") {
        const reply = options.widgetReply ?? {
          sitekey: "0x4AAAAAAA" + "S".repeat(14),
          secret: "0x4AAAAAAA" + "s".repeat(24),
        };
        // `refuse`: Cloudflare's answer to a token without Turnstile Edit (403, code 10000),
        // as staging-tools.mjs reports it, plus a detail the tool must not relay.
        if (options.widgetCreate === "refuse")
          throw new StagingError("STAGING_CLOUDFLARE_REQUEST_FAILED", {
            status: 403,
            codes: [10000],
            reason: "relayed_detail",
          });
        if (options.widgetCreate !== "fail")
          widgets.push({ name: body.name, sitekey: reply.sitekey, domains: body.domains });
        if (options.widgetCreate === "lost" || options.widgetCreate === "fail")
          throw new StagingError("STAGING_CLOUDFLARE_UNAVAILABLE");
        return { success: true, result: { ...reply, name: body.name, domains: body.domains } };
      }
      throw new StagingError("STAGING_CLOUDFLARE_REQUEST_FAILED", { status: 404 });
    },
  };
  const cloud = {
    api,
    calls,
    scripts,
    queues,
    widgets,
    deployments,
    // A landed `wrangler deploy`: the script exists, its version moves, and on the api
    // workers.dev is (re-)enabled by the configuration's `workers_dev: true`.
    deploy(name, versionId, { workersDev = false } = {}) {
      let script = scriptNamed(name);
      if (!script) {
        script = { name, enabled: false, previews: false, bindings: [] };
        scripts.push(script);
      }
      if (workersDev) script.enabled = true;
      // The committed wrangler configurations: the api binds ApiBroker, from M2 PR-2 the
      // connector binds ConnectorBroker and from M3 PR-2 the orchestrator binds
      // RuntimeBroker (the census allow table admits exactly these).
      if (name === "morrow-staging-api")
        script.bindings = [{ service: "morrow-staging-broker", entrypoint: "ApiBroker" }];
      if (name === "morrow-staging-connector")
        script.bindings = [{ service: "morrow-staging-broker", entrypoint: "ConnectorBroker" }];
      if (name === "morrow-staging-orchestrator")
        script.bindings = [{ service: "morrow-staging-broker", entrypoint: "RuntimeBroker" }];
      deployments[name] = versionId;
    },
    workersDev: (name) => scriptNamed(name)?.enabled ?? null,
  };
  return cloud;
}

// A fake staging origin over a fakeCloudflare: the api answers only while its workers.dev
// is enabled, and (v1 PR 1) the connector likewise on its own hostname; the other
// hostnames never answer. `ready`, `guard` and `limit` shape the api, `connectorReady` the
// connector. Every request is recorded (method and path, never a header value).
export function fakeSite({
  cloud,
  ready = true,
  guard = true,
  limit = 10,
  csp,
  other = 404,
  connectorReady = true,
}) {
  const requests = [];
  let starts = 0;
  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    });
  const fetch = async (url, init = {}) => {
    const { host, pathname } = new URL(url);
    const method = init.method ?? "GET";
    requests.push({ method, host, path: pathname });
    const isReady = typeof ready === "function" ? ready() : ready;
    if (host === "morrow-staging-connector.lab.workers.dev") {
      if (!cloud.workersDev("morrow-staging-connector"))
        return new Response("There is nothing here yet", { status: 404 });
      if (pathname === "/healthz")
        return json(200, {
          schemaVersion: 1,
          service: "connector",
          ready: typeof connectorReady === "function" ? connectorReady() : connectorReady,
        });
      return json(404, { code: "not_found" });
    }
    if (host !== "morrow-staging-api.lab.workers.dev")
      return new Response("nothing here", { status: other });
    if (!cloud.workersDev("morrow-staging-api"))
      return new Response("There is nothing here yet", { status: 404 });
    if (pathname === "/healthz")
      return json(200, { schemaVersion: 1, service: "api", ready: isReady });
    if (pathname === "/")
      return new Response("<!doctype html>", {
        status: 200,
        headers: { "content-type": "text/html", "content-security-policy": csp },
      });
    if (pathname === "/w/x/inbox") return new Response("<!doctype html>", { status: 200 });
    if (pathname === "/api/x") return json(404, { code: "not_found" });
    if (pathname === "/auth/challenge")
      return guard
        ? json(200, {
            schemaVersion: 1,
            provider: "turnstile",
            siteKey: "0x4AAAAAAAx",
            actions: {},
          })
        : json(404, { code: "not_found" });
    if (pathname === "/auth/login" && method === "POST") {
      if (!guard) {
        starts++;
        return json(200, { schemaVersion: 1, authorizationUrl: "https://example.invalid/" });
      }
      const header = new Headers(init.headers).get("x-morrow-challenge");
      if (!header) return json(403, { schemaVersion: 1, outcome: "challenge_required" });
      starts++;
      return starts > limit
        ? json(429, { schemaVersion: 1, outcome: "rate_limited" }, { "retry-after": "60" })
        : json(403, { schemaVersion: 1, outcome: "challenge_failed" });
    }
    if (pathname === "/workspaces") return json(401, { code: "authentication_required" });
    return json(404, { code: "not_found" });
  };
  return { fetch, requests, flowsCreated: () => (guard ? 0 : starts) };
}

// A scriptable database for the commands' SQL paths without PostgreSQL. `rules` map a
// statement pattern to rows (or a function of (text, params, database) returning rows,
// or an Error to throw). Every statement and parameter list is recorded with the database
// its connection is bound to (`connector({binding})`, "morrow" by default); the role
// passwords provisioning sends are in the ALTER ROLE statements here, so tests check
// where they appear. `statementStats` overrides the statement-statistics row of the
// binding's database and `scratchStats` that of any other database; `storedForm` makes
// pg_authid readable. The scratch database (M-N3 wipe): `scratchPresent` (default true),
// `scratchExtension` (an extension already there), `residue` (entries left after the
// reset), `partialReset` (stats_reset not moved), `instance` (a map database -> the
// instance identity it reads, default one shared value; null makes it unreadable) and
// `instanceChanged` (the verification reads another instance).
export function fakeDatabase(options = {}) {
  const statements = [];
  const roles = options.roles ?? [];
  const identityFor = (database) => ({
    session_role: "neondb_owner",
    current_role: "neondb_owner",
    database,
    version: 170011,
    superuser: false,
    createrole: true,
    login: true,
    ...(options.identity ?? {}),
  });
  const scratch = { extension: options.scratchExtension === true, created: 0, dropped: 0 };
  const quiet = {
    password_encryption: "scram-sha-256",
    log_statement: "none",
    log_min_duration_statement: "-1",
    log_min_duration_sample: "-1",
    log_statement_sample_rate: "1",
    log_min_error_statement: "panic",
    log_duration: "off",
    debug_print_parse: "off",
    debug_print_rewritten: "off",
    debug_print_plan: "off",
  };
  const instanceOf = (database) =>
    options.instance && database in options.instance
      ? options.instance[database]
      : "1792526146.012127/10.0.0.1/5432";
  const provisioned = new Set(options.provisioned ? roles : []);
  // Migration 0035's platform mark (seed-platform): absent until the seed inserts it,
  // unless a test plants one (`platformEnvironment`); never changed once present.
  let platformEnvironment = options.platformEnvironment ?? null;
  const rules = [
    [
      /^INSERT INTO morrow_billing\.platform_environment/,
      (text, params) => {
        if (platformEnvironment === null) platformEnvironment = params[0];
        return [];
      },
    ],
    [
      /FROM morrow_billing\.platform_environment$/,
      () => (platformEnvironment === null ? [] : [{ environment: platformEnvironment }]),
    ],
    [/^SELECT session_user::text AS session_role/, (text, params, db) => [identityFor(db)]],
    [
      /FROM pg_catalog\.pg_roles WHERE rolname IN/,
      () => [{ n: options.presentRoles ?? roles.length }],
    ],
    [
      /pg_db_role_setting/,
      () =>
        roles.map((role) => ({
          role,
          login: options.controlsOk !== false && provisioned.has(role),
          connection_limit: provisioned.has(role) ? 10 : -1,
          settings: provisioned.has(role)
            ? "statement_timeout=5s,idle_in_transaction_session_timeout=10s"
            : "",
        })),
    ],
    [/privilege_type = 'TEMPORARY'/, () => [{ revoked: provisioned.size > 0 }]],
    [/pg_stat_activity WHERE datname/, () => options.activity ?? []],
    [/pg_auth_members/, () => [{ n: 0 }]],
    // M-N3 as amended: no pg_stat_statements, SCRAM storage and no statement logging,
    // unless a test says so.
    [
      /^SELECT EXISTS \(SELECT 1 FROM pg_catalog\.pg_extension WHERE extname = 'pg_stat_statements'\) AS extension, current_setting/,
      (text, params, db) => [
        db === "morrow"
          ? {
              extension: false,
              track: null,
              track_utility: null,
              ...quiet,
              ...(options.statementStats ?? {}),
            }
          : {
              extension: scratch.extension,
              track: options.statementStats?.track ?? null,
              track_utility: options.statementStats?.track_utility ?? null,
              ...quiet,
              ...(options.scratchStats ?? {}),
            },
      ],
    ],
    [
      /FROM pg_catalog\.pg_database WHERE datname = /,
      () => [{ present: options.scratchPresent ?? true }],
    ],
    [
      /FROM pg_catalog\.pg_extension e JOIN pg_catalog\.pg_namespace/,
      () => (scratch.extension ? [{ schema: "public" }] : []),
    ],
    [/clock_timestamp\(\)::text AS before/, () => [{ before: "2026-10-20 12:00:00.000001+00" }]],
    [/pg_stat_statements_reset\(\)/, () => [{ reset: "2026-10-20 12:00:00.000002+00" }]],
    [
      /pg_stat_statements_info/,
      () => [
        {
          full_reset: options.partialReset !== true,
          same_instance: options.instanceChanged !== true,
          remaining: options.residue ?? 0,
        },
      ],
    ],
    [
      /^SELECT pg_catalog\.concat_ws\('\/'.* AS instance$/,
      (text, params, db) => [{ instance: instanceOf(db) }],
    ],
    // pg_authid is unreadable here (a plain CREATEROLE role); `storedForm` makes it
    // readable, as for a superuser or Neon's neondb_owner (pg_read_all_data), with the
    // given count of SCRAM-SHA-256 rows ("all" or a number).
    [
      /has_table_privilege\('pg_catalog\.pg_authid'/,
      () => [{ readable: options.storedForm !== undefined }],
    ],
    [
      /FROM pg_catalog\.pg_authid WHERE rolname IN/,
      (text) => [
        {
          n:
            options.storedForm === "all"
              ? (text.match(/'morrow_[a-z0-9_]+'/g) ?? []).length
              : options.storedForm,
        },
      ],
    ],
  ];
  const answer = (text, params, database) => {
    for (const [pattern, result] of [...(options.rules ?? []), ...rules]) {
      if (!pattern.test(text)) continue;
      const value = typeof result === "function" ? result(text, params, database) : result;
      if (value instanceof Error) throw value;
      return value;
    }
    return [];
  };
  return {
    statements,
    scratch,
    connector: ({ binding } = {}) => ({
      async connect() {
        const database = binding?.database ?? "morrow";
        if (options.connectError) throw options.connectError;
        if (database !== "morrow" && options.scratchConnectError) throw options.scratchConnectError;
        return {
          async query(text, params = []) {
            statements.push({ text, params: [...params], database });
            return answer(text, params, database);
          },
          async exec(text) {
            statements.push({ text, params: [], database });
            if (options.execError && options.execError.pattern.test(text))
              throw options.execError.error;
            const role = /^ALTER ROLE (morrow_[a-z0-9_]+) WITH LOGIN/.exec(text)?.[1];
            if (role) provisioned.add(role);
            if (text === "CREATE EXTENSION pg_stat_statements") {
              scratch.extension = true;
              scratch.created++;
            }
            if (text === "DROP EXTENSION pg_stat_statements") {
              scratch.extension = false;
              scratch.dropped++;
            }
          },
          async close() {},
        };
      },
    }),
  };
}

// A temporary HOME with ~/.config/morrow/staging (0700, tmp/ too) and the given files,
// each written 0600 unless `modes` says otherwise; `links` become symlinks.
export function plantedHome(files = {}, { modes = {}, links = {}, directoryMode = 0o700 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "morrow-staging-test-home-"));
  const directory = join(home, ".config", "morrow", "staging");
  mkdirSync(join(directory, "tmp"), { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".config", "morrow"), 0o700);
  chmodSync(directory, directoryMode);
  chmodSync(join(directory, "tmp"), 0o700);
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(directory, name), value, { mode: 0o600 });
    chmodSync(join(directory, name), modes[name] ?? 0o600);
  }
  for (const [name, target] of Object.entries(links)) symlinkSync(target, join(directory, name));
  return { home, directory, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export const approvedCard = (approvedOn = "2026-10-19") => {
  const expires = new Date(Date.parse(approvedOn + "T00:00:00Z") + 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  return {
    schemaVersion: 1,
    id: "staging-card-1",
    // `record` (the Markdown card) is not read by cardState, and labs never name one.
    status: "approved",
    approvedOn,
    expiresOn: expires,
    productionResourceCreated: false,
    e7: null,
  };
};

export const labBinding = Object.freeze({
  schemaVersion: 1,
  environment: "staging",
  projectId: "lab-project-runner",
  branchId: "br-lab-runner-000001",
  hostname: "ep-lab-runner-000001.us-east-1.aws.neon.tech",
  database: "morrow",
});

// A synthetic Turnstile site key in the broker's `^0x` format (never a real or dummy key).
export const labSiteKey = "0x" + "labsitekey".repeat(2);
// M5: a synthetic STRIPE_CONFIGURATION_JSON for the switch-on world (never a real id).
export const labStripeConfigurationJson = JSON.stringify({
  schemaVersion: 1,
  portalConfigurationId: "bpc_" + "LabPortal".padEnd(24, "0"),
  automaticTax: false,
  billingAddressCollection: "auto",
});
// A synthetic LOGIN_CONFIGURATION_JSON text. Gate 4 needs the api's and the broker's copies
// present and byte-equal; its content is checked by ctx.loginConfiguration, which the
// fakes replace.
export const labLoginConfigurationJson = JSON.stringify({
  schemaVersion: 1,
  origin: "https://morrow-staging-api.lab.workers.dev",
  retentionTier: "staging",
});

// The committed staging file with every identifier unset, independent of the values
// PR-D commits.
export function unsetStaging() {
  const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const base = JSON.parse(readFileSync(join(root, "infra/environments/staging.json"), "utf8"));
  return {
    ...base,
    cloudflare: {
      ...base.cloudflare,
      account_id: null,
      workers_dev_subdomain: null,
      origin: null,
      turnstile: { ...base.cloudflare.turnstile, site_key: null },
    },
    neon: {
      ...base.neon,
      project_id: null,
      root_branch_id: null,
      branch_id: null,
      region_id: null,
      endpoint_host: null,
    },
  };
}

// A context for scripts/staging.mjs over fakes. Every seam is replaceable through
// `overrides`; nothing reaches a real tool, provider or the operator's HOME.
export async function fakeContext({
  home,
  root,
  tools,
  cloudflare,
  database,
  card = approvedCard(),
  staging,
  binding = labBinding,
  loginConfiguration = labLoginConfigurationJson,
  // P05.T01ab's two challenge vars (D1): a valid pair for the fake origin by default.
  // Each key replaces one value; null removes it. `api` is LOGIN_CHALLENGE_JSON; `broker`
  // is TURNSTILE_CONFIGURATION_JSON; `brokerLogin` and `brokerBinding` are the broker's
  // copies of the api's LOGIN_CONFIGURATION_JSON and MORROW_DATABASE_BINDING_JSON, and
  // `apiLogin` and `apiBinding` replace the api's own two (gate 4 only reads them).
  challengeVars = {},
  // M5: the Stripe switch (owner decision (c), 2026-10-21): "off" (the committed state) or
  // "on". The Stripe vars follow it unless challengeVars sets them: `apiStripeMode` and
  // `brokerStripeMode` (MORROW_STRIPE_MODE) and `brokerStripe` (STRIPE_CONFIGURATION_JSON).
  stripe = "off",
  administrator = { name: "neondb_owner", mode: "createrole" },
  now = Date.parse("2026-10-20T12:00:00Z"),
  environment = {},
  fetch = null,
  overrides = {},
}) {
  const { checkChallengeConfiguration, identityConstants, stagingChallengeActions } = await import(
    "../../scripts/staging.mjs"
  );
  const { stagingFileSpecs, credentialDirectory } = await import("../../scripts/staging-files.mjs");
  const { loadMigrationChain } = await import("../../scripts/migration-chain.mjs");
  const constants = await identityConstants({ stripe });
  const realRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const repoRoot = root ?? realRoot;
  const baseStaging = JSON.parse(
    readFileSync(join(realRoot, "infra/environments/staging.json"), "utf8"),
  );
  const stagingValue = staging ?? {
    ...baseStaging,
    cloudflare: {
      ...baseStaging.cloudflare,
      account_id: "0".repeat(31) + "1",
      workers_dev_subdomain: "lab",
      origin: "https://morrow-staging-api.lab.workers.dev",
      // The challenge vars below carry the synthetic site key; gate 4 holds them to this.
      turnstile: { ...baseStaging.cloudflare.turnstile, site_key: labSiteKey },
    },
    neon: {
      ...baseStaging.neon,
      project_id: binding?.projectId ?? null,
      // The committed file carries real identifiers (PR-D part 1); the default world keeps
      // the root and region unset so the pending-identifier paths stay exercised.
      root_branch_id: null,
      region_id: null,
      branch_id: binding?.branchId ?? null,
      // The binding resolves only through staging.json's endpoint (stagingBinding).
      endpoint_host: binding?.hostname ?? null,
    },
  };
  const bindingJson = binding === null ? null : JSON.stringify(binding);
  let challengeHost = null;
  try {
    challengeHost = new URL(stagingValue.cloudflare?.origin).hostname;
  } catch {
    challengeHost = null;
  }
  const pick = (key, fallback) =>
    challengeVars[key] === undefined ? fallback : challengeVars[key];
  const challengeJson = pick(
    "api",
    JSON.stringify({
      schemaVersion: 1,
      provider: "turnstile",
      siteKey: labSiteKey,
      actions: stagingChallengeActions,
    }),
  );
  const brokerVars = Object.freeze({
    turnstileJson: pick(
      "broker",
      JSON.stringify({
        schemaVersion: 1,
        hostname: challengeHost,
        actions: stagingChallengeActions,
      }),
    ),
    loginConfigurationJson: pick("brokerLogin", loginConfiguration),
    bindingJson: pick("brokerBinding", bindingJson),
    // M5: absent while the switch is off; a valid configuration and mode while it is on.
    stripeJson: pick("brokerStripe", stripe === "on" ? labStripeConfigurationJson : null),
    stripeMode: pick("brokerStripeMode", stripe === "on" ? "test" : null),
  });
  const out = [];
  const err = [];
  const reports = [];
  const outputs = {};
  const sleeps = [];
  const notices = [];
  let clock = now;
  const ctx = {
    root: repoRoot,
    home,
    directory: credentialDirectory(home),
    environment: Object.freeze({
      ci: false,
      headSha: null,
      deployEnabled: null,
      schemaHead: null,
      loginDigest: null,
      accountId: null,
      ...environment,
    }),
    now: () => clock,
    // The fake clock moves only when a command sleeps.
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    fetch:
      fetch ??
      (async () => {
        throw new TypeError("fetch failed");
      }),
    interactive: () => false,
    notice: (text) => notices.push(text),
    browser: async () => {
      throw new StagingError("STAGING_BROWSER_UNAVAILABLE");
    },
    writeReport: (name, value) => reports.push({ name, value: JSON.parse(JSON.stringify(value)) }),
    setOutput: (name, value) => (outputs[name] = value),
    gate5: async () => {},
    probeDatabase: async () => {
      throw new StagingError("STAGING_DATABASE_UNAVAILABLE");
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    administrator,
    constants: async () => constants,
    specs: async () => stagingFileSpecs({ brokerSecretNames: constants.brokerSecrets }),
    config: async () => ({
      staging: stagingValue,
      card,
      bindingJson: pick("apiBinding", bindingJson),
      loginConfigurationJson: pick("apiLogin", loginConfiguration),
      challengeJson,
      broker: brokerVars,
      stripeMode: pick("apiStripeMode", stripe === "on" ? "test" : null),
    }),
    chain: () => loadMigrationChain({ root: repoRoot }),
    tools,
    cloudflareApi: async () => {
      if (!cloudflare) throw new StagingError("STAGING_CLOUDFLARE_UNCONFIGURED");
      return cloudflare;
    },
    database:
      database ??
      (() => ({
        connect: async () => {
          throw new StagingError("STAGING_DATABASE_UNAVAILABLE");
        },
      })),
    async loginConfiguration() {
      throw new StagingError("STAGING_LOGIN_CONFIGURATION_MISSING");
    },
    challengeConfiguration: (loaded) => checkChallengeConfiguration(loaded),
    async checkKeyring() {},
    // M5 PR-1: staging's published billing terms (none until the owner's Price exists).
    billingTerms: async () => [],
    ...overrides,
  };
  return { ctx, out, err, constants, reports, outputs, sleeps, notices };
}
