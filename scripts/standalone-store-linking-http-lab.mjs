import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { localStandaloneSqlPool } from "./local-standalone-sql.mjs";
import {
  createStandaloneFixtureHarness,
  standaloneSqlLiteral as lit,
} from "./standalone-session-fixtures.mjs";
import { seedStandaloneLinkingFixture } from "./fixtures/standalone-linking-fixture.mjs";
import { createWorkspaceHttpListener } from "../apps/api/src/workspace-http.ts";
import { createStandaloneWorkspaceBootstrap } from "../packages/identity/src/standalone-workspace-bootstrap.ts";
import { createStandaloneStoreLinking } from "../packages/identity/src/standalone-store-linking.ts";
import { identitySql } from "../packages/identity/src/index.ts";
import { workspaceStoreLinkingControlSql } from "../packages/identity/src/workspace-store-linking-control.ts";
import { workspaceStoreLinkingSql } from "../packages/identity/src/workspace-store-linking.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const checks = [];
const check = (name, value) => {
  if (!value || checks.some((c) => c.name === name))
    throw Error("STANDALONE_LINKING_HTTP_CHECK:" + name);
  checks.push({ name, passed: true });
};
const paths = [
  "scripts/standalone-store-linking-http-lab.mjs",
  "scripts/standalone-session-fixtures.mjs",
  "scripts/fixtures/standalone-linking-fixture.mjs",
  "scripts/local-standalone-sql.mjs",
  "scripts/local-browser-session-sql.mjs",
  "scripts/local-postgres-lab.mjs",
  "apps/api/src/workspace-http.ts",
  "packages/identity/src/standalone-request-guard.ts",
  "packages/identity/src/standalone-workspace-bootstrap.ts",
  "packages/identity/src/standalone-store-linking.ts",
  "packages/identity/src/workspace-store-linking-control.ts",
  "packages/identity/src/workspace-store-linking.ts",
  "packages/identity/src/index.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/workos-authentication-evidence.ts",
  "packages/identity/src/workos-session-token.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/policy/src/index.ts",
  "tests/fixtures/workos-authentication-evidence.mjs",
  "infra/identity-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  "docs/plan/source.json",
  "docs/packets/P05.T01q.md",
  "docs/plan/build-plan.md",
  ".nvmrc",
  "package-lock.json",
];
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
for (const m of manifest.migrations.slice(0, 9)) paths.push("migrations/" + m.file);
const sourceDigests = Object.fromEntries(paths.map((p) => [p, hash(readFileSync(p))]));
const plan = JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan;
assert.equal(plan.sequence, 85);
assert.equal(plan.sha256, hash(readFileSync("docs/plan/build-plan.md")));
const queryTrace = [],
  allPools = [],
  responseTexts = [];
let ownedContainer, privateSecrets;
const result = await localPostgresLab("P05.T03b-http", async (engine) => {
  ownedContainer = engine.id;
  const h = createStandaloneFixtureHarness(engine, 9);
  privateSecrets = h.secrets;
  const statements = [
    ...new Set([
      ...Object.values(workspaceStoreLinkingControlSql),
      ...Object.values(workspaceStoreLinkingSql),
    ]),
  ];
  const reads = localStandaloneSqlPool(engine.id, "morrow_api", Object.values(identitySql));
  allPools.push(reads);
  const pool = () => {
    const p = localStandaloneSqlPool(engine.id, "morrow_identity_linking", statements, {
      beforeQuery(text) {
        queryTrace.push(text);
      },
    });
    allPools.push(p);
    return p;
  };
  const links = pool();
  let listener = createWorkspaceHttpListener(),
    activeLink,
    observeResponse;
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => listener(req, res));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  const configurationJson = JSON.stringify({
    schemaVersion: 1,
    mode: "loopback_qualification",
    origin,
  });
  const bootstrap = createStandaloneWorkspaceBootstrap({
    configurationJson,
    pool: reads,
    now: Date.now,
  });
  const makeLink = (p) =>
    createStandaloneStoreLinking({ configurationJson, pool: p, now: Date.now });
  activeLink = makeLink(links);
  listener = createWorkspaceHttpListener({
    origin,
    bootstrap,
    linking: {
      async fetch(req) {
        const response = await activeLink.fetch(req);
        observeResponse?.(response.status);
        return response;
      },
    },
  });
  const fresh = async (options) => {
    const admitted = await h.admitted(h.fixture());
    check("fresh_morrow_admission_" + checks.length, admitted.result.outcome === "newly_admitted");
    return seedStandaloneLinkingFixture(h, admitted, options);
  };
  const secret = (f) => f.admitted.result.credential.secret;
  const invoke = async (f, route = "apply", change = {}) => {
    const suffix = route === "apply" ? "" : "/" + route;
    const headers = {
      Cookie: "__Host-morrow_session=" + (change.secret ?? secret(f)),
      Origin: origin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      "Idempotency-Key": f.commandId,
      ...(change.csrf ? { "X-Morrow-CSRF": change.csrf } : {}),
      ...change.headers,
    };
    const response = await fetch(
      origin +
        "/workspace/" +
        (change.workspaceId ?? f.workspaceId) +
        "/store-links" +
        suffix +
        (change.query ?? ""),
      {
        method: change.method ?? "POST",
        headers,
        ...(change.method === "GET"
          ? {}
          : { body: change.body ?? JSON.stringify({ handoffToken: f.handoffToken }) }),
        ...(change.signal ? { signal: change.signal } : {}),
      },
    );
    const text = await response.text();
    responseTexts.push(text);
    check(
      "response_private_data_excluded_" + checks.length,
      !h.secrets.some((s) => text.includes(s)),
    );
    check(
      "response_no_cookie_or_cors_" + checks.length,
      !response.headers.has("set-cookie") &&
        !response.headers.has("access-control-allow-origin") &&
        response.headers.get("cache-control") === "no-store",
    );
    return { status: response.status, body: JSON.parse(text) };
  };
  const count = (f) =>
    Number(
      h.admin(
        "SELECT count(*) FROM morrow_identity.workspace_store_links WHERE installation_id=" +
          lit(f.installationId) +
          ";",
      ),
    );
  const applies = () => queryTrace.filter((x) => x === workspaceStoreLinkingSql.apply).length;
  try {
    const first = await fresh();
    const boot = await fetch(origin + "/workspace/" + first.workspaceId + "/bootstrap", {
      headers: { Cookie: "__Host-morrow_session=" + secret(first) },
    });
    const bootBody = await boot.json();
    check(
      "issued_family_cookie_reads_workspace_before_link",
      boot.status === 200 &&
        bootBody.workspace.id === first.workspaceId &&
        bootBody.policyRevision === 1,
    );
    const preview = await invoke(first, "preview");
    check(
      "reviewed_preview_exact_target_and_scope",
      preview.status === 200 &&
        preview.body.link.installationId === first.installationId &&
        preview.body.link.purpose === "workspace_first" &&
        preview.body.link.expectedPolicyRevision === 1 &&
        /^[A-Za-z0-9_-]{43}$/.test(preview.body.csrfToken),
    );
    const csrf = preview.body.csrfToken;
    check("preview_does_not_apply", applies() === 0 && count(first) === 0);
    check(
      "uncommitted_status_is_private_not_found",
      (await invoke(first, "status")).status === 404 && applies() === 0,
    );
    for (const [name, change] of [
      ["foreign_origin", { headers: { Origin: "https://foreign.invalid" } }],
      ["null_origin", { headers: { Origin: "null" } }],
      ["foreign_fetch_site", { headers: { "Sec-Fetch-Site": "cross-site" } }],
      ["missing_request_header", { headers: { "X-Morrow-Request": "" } }],
      ["wrong_csrf", { csrf: "A".repeat(43) }],
      [
        "browser_approval_flag",
        { body: JSON.stringify({ handoffToken: first.handoffToken, approved: true }) },
      ],
      [
        "caller_session_digest",
        {
          body: JSON.stringify({
            handoffToken: first.handoffToken,
            sessionDigest: first.input.sessionDigest,
          }),
        },
      ],
      [
        "duplicate_body_key",
        {
          body:
            '{"handoffToken":"' +
            first.handoffToken +
            '","handoffToken":"' +
            first.handoffToken +
            '"}',
        },
      ],
      ["ticket_in_query", { query: "?handoffToken=" + first.handoffToken }],
      ["get_cannot_mutate", { method: "GET" }],
    ]) {
      const before = queryTrace.length,
        r = await invoke(first, "apply", { csrf, ...change });
      check(
        name + "_before_sql",
        r.status >= 400 && r.status < 500 && queryTrace.length === before && count(first) === 0,
      );
    }
    const secondFamily = await h.admitted({
      ...first.admitted.f,
      selector: { ...first.admitted.f.selector, commandId: randomUUID() },
    });
    check(
      "another_eligible_family_cannot_use_reviewed_handoff",
      (await invoke(first, "preview", { secret: secondFamily.result.credential.secret })).status ===
        404 && count(first) === 0,
    );
    check(
      "changed_command_cannot_select_private_handoff",
      (await invoke(first, "preview", { headers: { "Idempotency-Key": randomUUID() } })).status ===
        404 && count(first) === 0,
    );
    const applied = await invoke(first, "apply", { csrf });
    check(
      "reviewed_cookie_to_link_http_success",
      applied.status === 200 && applied.body.outcome === "applied" && count(first) === 1,
    );
    const after = applies(),
      status = await invoke(first, "status");
    check(
      "status_read_only_exact_original_result",
      status.status === 200 &&
        status.body.linkId === applied.body.linkId &&
        status.body.auditId === applied.body.auditId &&
        applies() === after,
    );
    const replay = await invoke(first, "apply", { csrf });
    check(
      "exact_browser_replay_one_association",
      replay.status === 200 &&
        replay.body.linkId === applied.body.linkId &&
        replay.body.auditId === applied.body.auditId &&
        count(first) === 1,
    );
    const postBoot = await fetch(origin + "/workspace/" + first.workspaceId + "/bootstrap", {
      headers: { Cookie: "__Host-morrow_session=" + secret(first) },
    });
    check(
      "workspace_bootstrap_observes_link_policy_revision",
      (await postBoot.json()).policyRevision === 2,
    );

    const concurrent = await fresh(),
      concurrentPreview = await invoke(concurrent, "preview");
    const pair = await Promise.all([
      invoke(concurrent, "apply", { csrf: concurrentPreview.body.csrfToken }),
      invoke(concurrent, "apply", { csrf: concurrentPreview.body.csrfToken }),
    ]);
    check(
      "concurrent_identical_http_one_link_and_result",
      pair.every((r) => r.status === 200 && r.body.outcome === "applied") &&
        pair[0].body.linkId === pair[1].body.linkId &&
        pair[0].body.auditId === pair[1].body.auditId &&
        count(concurrent) === 1,
    );

    for (const fault of ["commit", "release"]) {
      const f = await fresh(),
        p = await invoke(f, "preview"),
        base = pool();
      const faultTrace = [];
      activeLink = makeLink({
        async connect(control) {
          const c = await base.connect(control);
          let write = false;
          return {
            async query(text, values, ctl) {
              faultTrace.push(text);
              const rows = await c.query(text, values, ctl);
              if (text === workspaceStoreLinkingSql.apply) write = true;
              if (write && text === "COMMIT" && fault === "commit")
                throw Error("SYNTHETIC_LOST_ACK");
              return rows;
            },
            async release(discard) {
              await c.release(discard);
              if (write && fault === "release") throw Error("SYNTHETIC_LOST_ACK");
            },
          };
        },
      });
      const r = await invoke(f, "apply", { csrf: p.body.csrfToken });
      check(
        "actual_" + fault + "_ack_loss_http_unknown",
        r.status === 503 && r.body.outcome === "outcome_unknown" && count(f) === 1,
      );
      check(
        "actual_" + fault + "_ack_loss_no_rollback_or_repeat",
        !faultTrace.includes("ROLLBACK") &&
          faultTrace.filter((s) => s === workspaceStoreLinkingSql.apply).length === 1,
      );
      activeLink = makeLink(links);
      const before = applies(),
        reconciled = await invoke(f, "status");
      check(
        "actual_" + fault + "_ack_loss_http_status_no_write",
        reconciled.status === 200 && reconciled.body.outcome === "applied" && applies() === before,
      );
    }
    // Disconnect the actual browser-side socket only after PostgreSQL commits.
    // The server must suppress success, dispose its client and reconcile by SELECT.
    const disconnected = await fresh(),
      disconnectedPreview = await invoke(disconnected, "preview"),
      disconnectBase = pool();
    const committed = Promise.withResolvers(),
      cancelled = Promise.withResolvers(),
      completed = Promise.withResolvers();
    const disconnectTrace = [];
    activeLink = makeLink({
      async connect(control) {
        const c = await disconnectBase.connect(control);
        let write = false;
        return {
          async query(text, values, ctl) {
            disconnectTrace.push(text);
            const rows = await c.query(text, values, ctl);
            if (text === workspaceStoreLinkingSql.apply) write = true;
            if (write && text === "COMMIT") {
              committed.resolve();
              await new Promise((resolve) => {
                if (ctl.signal.aborted) return resolve();
                ctl.signal.addEventListener("abort", resolve, { once: true });
              });
              cancelled.resolve(ctl.signal.aborted);
            }
            return rows;
          },
          release(discard) {
            return c.release(discard);
          },
        };
      },
    });
    observeResponse = (status) => completed.resolve(status);
    const abortedClient = Promise.withResolvers();
    const client = httpRequest(origin + "/workspace/" + disconnected.workspaceId + "/store-links", {
      method: "POST",
      headers: {
        Cookie: "__Host-morrow_session=" + secret(disconnected),
        Origin: origin,
        "Content-Type": "application/json",
        "X-Morrow-Request": "1",
        "Idempotency-Key": disconnected.commandId,
        "X-Morrow-CSRF": disconnectedPreview.body.csrfToken,
      },
    });
    client.on("response", (response) => {
      response.resume();
      abortedClient.reject(Error("UNEXPECTED_DISCONNECT_RESPONSE"));
    });
    client.on("error", () => abortedClient.resolve());
    client.end(JSON.stringify({ handoffToken: disconnected.handoffToken }));
    const bounded = async (promise) => {
      let timer;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("DISCONNECT_TEST_TIMEOUT")), 7000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await bounded(committed.promise);
      client.destroy();
      await bounded(abortedClient.promise);
      check("actual_disconnect_after_commit_propagates_abort", await bounded(cancelled.promise));
      check(
        "actual_disconnect_suppresses_server_success",
        (await bounded(completed.promise)) === 503 && count(disconnected) === 1,
      );
      check(
        "actual_disconnect_no_rollback_or_repeat",
        !disconnectTrace.includes("ROLLBACK") &&
          disconnectTrace.filter((s) => s === workspaceStoreLinkingSql.apply).length === 1,
      );
    } finally {
      client.destroy();
      observeResponse = undefined;
      activeLink = makeLink(links);
    }
    const beforeDisconnectStatus = applies(),
      reconciledDisconnect = await invoke(disconnected, "status");
    check(
      "actual_disconnect_read_only_status_recovers_original",
      reconciledDisconnect.status === 200 &&
        reconciledDisconnect.body.outcome === "applied" &&
        applies() === beforeDisconnectStatus,
    );
    return {
      image: engine.image,
      serverVersion: engine.version,
      appliedMigrations: 9,
      sessionAdmissionPools: h.metrics,
      linkingAndReadPools: allPools.map((p) => p.metrics),
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const cleanups = await Promise.allSettled([h.close(), ...allPools.map((p) => p.close())]);
    const failedCleanup = cleanups.find((r) => r.status === "rejected");
    if (failedCleanup) throw Error("STANDALONE_LINKING_HTTP_CLEANUP_UNVERIFIED");
    check(
      "all_owned_api_clients_closed",
      allPools.every(
        (p) =>
          p.metrics.connections === p.metrics.released &&
          p.metrics.connections === p.metrics.closed &&
          p.metrics.connections === p.metrics.backendCleanupVerified &&
          p.metrics.unverifiedHostClosures === 0,
      ),
    );
    check(
      "all_real_issuer_clients_closed",
      h.metrics.every(
        (m) =>
          m.connections === m.closed &&
          m.connections === m.backendCleanupVerified &&
          m.unverifiedHostClosures === 0,
      ),
    );
  }
});
const absent = containerCommand(
  ["ps", "--all", "--filter", "id=" + ownedContainer, "--format", "{{.ID}}"],
  undefined,
  true,
);
check("owned_container_absent", absent.status === 0 && absent.stdout.trim() === "");
check(
  "source_inputs_stable",
  paths.every((p) => sourceDigests[p] === hash(readFileSync(p))),
);
const report = {
  schemaVersion: 1,
  task: "P05.T03b",
  canonicalSequence: 85,
  qualification: "actual_local_http_and_postgresql",
  checks,
  sourceDigests,
  sourceDigest: hash(JSON.stringify(Object.entries(sourceDigests).sort())),
  result,
  providerRequests: 0,
  merchantActivation: false,
  actualShopifyInstallation: false,
  cookieIssuanceQualified: false,
  clientHeaders: "synthetic private Cookie headers; no browser credential storage",
  unknownOutcomes:
    "locally injected lost acknowledgement after actual database COMMIT/disposal; separate read-only original-command status",
  cleanup: { hostChildClosure: "observed", backendNamespace: "absent", ownedContainer: "absent" },
  observedAt: new Date().toISOString(),
};
const text = JSON.stringify(report, null, 2) + "\n";
assert.equal(
  privateSecrets.some((s) => text.includes(s)),
  false,
);
mkdirSync("docs/evidence/P05.T01q/regressions", { recursive: true });
writeFileSync("docs/evidence/P05.T01q/regressions/standalone-store-linking-http.json", text);
console.log(
  "PASS: " +
    checks.length +
    " actual local HTTP/PostgreSQL controlled linking checks; zero provider requests; owned resources removed.",
);
