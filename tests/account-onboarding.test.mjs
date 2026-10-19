import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  accountOnboardingSql,
  accountOverviewSql,
  executeAccountOverview,
  executeFirstOrganization,
  normalizeDisplayName,
  parseOrganizationSignupBody,
  signupResponses,
} from "../packages/identity/src/account-onboarding.ts";
import { runFixedSqlTransaction } from "../packages/identity/src/fixed-sql-transaction.ts";
import { createManagedStandaloneRequestGuard } from "../packages/identity/src/standalone-request-guard.ts";
import {
  controlledNeonWorkspaceProfiles,
  snapshotControlledNeonWorkspaceParameters,
} from "../packages/identity/src/controlled-neon-workspace-profiles.ts";
import {
  brokerNeonRoles,
  brokerRequiredSecrets,
} from "../packages/identity/src/broker-protocol.ts";
import { identitySql } from "../packages/identity/src/index.ts";
import {
  validateCurrentDefinition,
  validateDefinition,
} from "../packages/contracts/src/validation.ts";
import {
  acceptedNames,
  forbiddenCodePoints,
  invalidNames,
  typescriptOnlyInvalidNames,
  whitespaceCodePoints,
} from "./fixtures/account-display-names.mjs";
import { isPaidWork } from "../packages/policy/src/paid-work.ts";

// P05.T01x Part B unit cases: names, the closed body, the guard header matrix, the
// outcome table, the grant template against the merged catalogue, the runner latch,
// the workspace parameter policy and the broker role table. No SQL engine here.
const origin = "https://workspace.example.test";
const configuration = JSON.stringify({ schemaVersion: 1, mode: "https", origin });
const secret = Buffer.alloc(32, 27).toString("base64url");
const command = "e519ea9d-c5eb-4613-906c-26a870c0e9e8";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const migration = readFileSync("migrations/0013.account-onboarding.sql", "utf8");
const catalogue = JSON.parse(readFileSync("docs/contracts/capabilities.json", "utf8"));
const v1Bodies = JSON.parse(
  readFileSync("docs/contracts/schemas/v1/capabilities.schema.json", "utf8"),
).$defs;
const v11Bodies = JSON.parse(
  readFileSync("docs/contracts/schemas/v1.1/capabilities.schema.json", "utf8"),
).$defs;

test("AC30 TypeScript name rule: invalid vectors are refused", () => {
  for (const value of [...invalidNames, ...typescriptOnlyInvalidNames])
    assert.equal(normalizeDisplayName(value), null, JSON.stringify(value));
  for (const value of [undefined, null, 1, {}, ["a"]])
    assert.equal(normalizeDisplayName(value), null);
});
test("AC30 TypeScript name rule: accepted vectors are stored as NFC after trimming W", () => {
  for (const [sent, stored] of acceptedNames) {
    assert.equal(normalizeDisplayName(sent), stored);
    assert.equal(stored, stored.normalize("NFC"));
  }
  for (const code of whitespaceCodePoints) {
    const w = String.fromCodePoint(code);
    assert.equal(
      normalizeDisplayName(w + "Main" + w),
      code === 0x2028 || code === 0x2029 ? "Main" : "Main",
    );
  }
  for (const code of forbiddenCodePoints)
    assert.equal(normalizeDisplayName("a" + String.fromCodePoint(code) + "b"), null);
  // String.prototype.trim would also strip U+FEFF; the rule refuses it instead.
  assert.equal(normalizeDisplayName("\uFEFFMain"), null);
  // 100 code points are counted, not UTF-16 units.
  assert.equal(normalizeDisplayName("\u{1F600}".repeat(100))?.length, 200);
});
test("AC30 the SQL rule names exactly the same W and F sets", () => {
  const source = readFileSync("packages/identity/src/account-onboarding.ts", "utf8");
  const tsW = /const W =\s*"([^"]+)"/.exec(source)[1].replaceAll("\\\\", "\\");
  const tsF = /const F =\s*"([^"]+)"/.exec(source)[1].replaceAll("\\\\", "\\");
  const body = /display_name_valid\(p text\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(migration)[1];
  const sets = [...body.matchAll(/'\[([^\]]+)\]'/g)].map((m) => m[1]);
  assert.equal(sets.length, 3);
  assert.equal(sets[1], tsW);
  assert.equal(sets[2], tsW);
  // PostgreSQL text cannot hold NUL, so the SQL F set starts at U+0001.
  assert.equal(sets[0], tsF.replace("\\u0000-", "\\u0001-"));
  assert.match(body, /char_length\(p\) BETWEEN 1 AND 100 AND p IS NFC NORMALIZED/);
});

test("closed signup body: exact keys, once each, string names and schemaVersion 1", () => {
  const ok = { schemaVersion: 1, organizationName: "Noor", workspaceName: "Main" };
  assert.deepEqual(parseOrganizationSignupBody(JSON.stringify(ok)), {
    organizationName: "Noor",
    workspaceName: "Main",
  });
  assert.deepEqual(
    parseOrganizationSignupBody(
      ' {\n "workspaceName" : "Main", "schemaVersion":1,"organizationName":"N"} ',
    ),
    { organizationName: "N", workspaceName: "Main" },
  );
  for (const text of [
    "",
    "[]",
    "null",
    JSON.stringify({ ...ok, schemaVersion: 2 }),
    JSON.stringify({ ...ok, schemaVersion: "1" }),
    JSON.stringify({ ...ok, organizationName: 7 }),
    JSON.stringify({ ...ok, workspaceName: null }),
    JSON.stringify({ ...ok, workspaceName: { a: 1 } }),
    JSON.stringify({ schemaVersion: 1, organizationName: "N" }),
    '{"schemaVersion":1,"organizationName":"N","organizationName":"M","workspaceName":"W"}',
    JSON.stringify(ok) + "x",
    JSON.stringify(ok).slice(0, -1),
    JSON.stringify({ ...ok, organizationName: "x".repeat(2100) }),
    ...["organizationId", "workspaceId", "principalId", "subjectId", "email"].map((key) =>
      JSON.stringify({ ...ok, [key]: "x" }),
    ),
  ])
    assert.equal(parseOrganizationSignupBody(text), null, text.slice(0, 80));
  // A lone surrogate escape reaches the name rule and is refused there (invalid_name).
  const lone = parseOrganizationSignupBody(
    '{"schemaVersion":1,"organizationName":"a\\ud800b","workspaceName":"Main"}',
  );
  assert.equal(lone.organizationName, "a\ud800b");
  assert.equal(normalizeDisplayName(lone.organizationName), null);
});

// ------------------------------------------------------------------ guard matrix (AC28)
function request(route, change = {}) {
  const { headers = {}, path, ...options } = change;
  const post = route === "organizations";
  return new Request(origin + (path ?? (post ? "/organizations" : "/workspaces")), {
    method: post ? "POST" : "GET",
    ...(post
      ? { body: JSON.stringify({ schemaVersion: 1, organizationName: "N", workspaceName: "W" }) }
      : {}),
    ...options,
    headers: {
      Cookie: `__Host-morrow_session=${secret}`,
      "X-Morrow-Request": "1",
      ...(post
        ? { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": command }
        : {}),
      ...headers,
    },
  });
}
async function guarded(route, input, execute) {
  const guard = createManagedStandaloneRequestGuard(configuration, Date.now);
  const owner = guard.begin(input);
  try {
    const response = await owner.handleAccount(route, execute);
    return { response, submitted: owner.accountSubmitted(), body: await response.json() };
  } finally {
    owner.attempt.end();
  }
}
const without = (route, name) => {
  const r = request(route);
  const headers = new Headers(r.headers);
  headers.delete(name);
  return new Request(r.url, {
    method: r.method,
    headers,
    ...(r.method === "POST"
      ? { body: JSON.stringify({ schemaVersion: 1, organizationName: "N", workspaceName: "W" }) }
      : {}),
  });
};
test("AC28 envelope: every refusal answers before the callback (zero SQL)", async () => {
  const cases = [];
  for (const route of ["workspaces", "organizations"]) {
    cases.push(
      [route, request(route, { headers: { Origin: "https://evil.example" } }), 403],
      [route, request(route, { headers: { "Sec-Fetch-Site": "cross-site" } }), 403],
      [route, request(route, { headers: { "Sec-Fetch-Site": "same-site" } }), 403],
      [route, request(route, { headers: { "Sec-Fetch-Site": "none" } }), 403],
      [route, request(route, { headers: { "Sec-Fetch-Mode": "navigate" } }), 403],
      [route, request(route, { headers: { "Sec-Fetch-Dest": "document" } }), 403],
      [route, without(route, "X-Morrow-Request"), 403],
      [route, request(route, { headers: { "X-Morrow-Request": "2" } }), 403],
      [
        route,
        request(route, {
          path: (route === "organizations" ? "/organizations" : "/workspaces") + "?a=1",
        }),
        403,
      ],
      [route, request(route, { headers: { Host: "other.example.test" } }), 403],
      [route, request(route, { headers: { Authorization: "Bearer x" } }), 401],
      [route, request(route, { headers: { "Proxy-Authorization": "Basic x" } }), 401],
      [route, without(route, "Cookie"), 401],
      [
        route,
        request(route, {
          headers: { Cookie: `__Host-morrow_session=${secret}; __Host-morrow_session=${secret}` },
        }),
        401,
      ],
      [route, request(route, { headers: { Cookie: "__Host-morrow_session=short" } }), 401],
      [route, request(route, { headers: { "Transfer-Encoding": "chunked" } }), 400],
      [route, request(route, { headers: { "X-Morrow-CSRF": "x" } }), 400],
    );
    for (const method of ["HEAD", "OPTIONS", "PUT", route === "workspaces" ? "POST" : "GET"])
      cases.push([route, new Request(origin + "/" + route, { method }), 405]);
  }
  cases.push(
    ["organizations", without("organizations", "Origin"), 403],
    ["organizations", request("organizations", { headers: { "Content-Type": "text/plain" } }), 403],
    ["organizations", without("organizations", "Idempotency-Key"), 400],
    [
      "organizations",
      request("organizations", { headers: { "Idempotency-Key": command.toUpperCase() } }),
      400,
    ],
    ["organizations", request("organizations", { body: "x".repeat(2049) }), 400],
    ["organizations", request("organizations", { body: new Uint8Array([0x7b, 0xff, 0x7d]) }), 400],
    ["workspaces", request("workspaces", { headers: { "Content-Type": "application/json" } }), 400],
    ["workspaces", request("workspaces", { headers: { "Idempotency-Key": command } }), 400],
    ["workspaces", request("workspaces", { headers: { "Content-Length": "3" } }), 400],
  );
  for (const [route, input, status] of cases) {
    let calls = 0;
    const out = await guarded(route, input, async () => {
      calls++;
      return new Response("{}");
    });
    assert.equal(
      out.response.status,
      status,
      `${route} ${input.method} ${[...input.headers.keys()].join(",")}`,
    );
    assert.equal(calls, 0);
    assert.equal(out.submitted, false);
    assert.equal(out.response.headers.has("set-cookie"), false);
    assert.equal(out.response.headers.has("access-control-allow-origin"), false);
    if (status === 405)
      assert.equal(out.response.headers.get("allow"), route === "workspaces" ? "GET" : "POST");
  }
});
test("AC28 envelope: accepted requests reach the callback with derived values only", async () => {
  let seen;
  const list = await guarded("workspaces", request("workspaces"), async (c) => {
    seen = c;
    return new Response("{}");
  });
  assert.equal(list.response.status, 200);
  assert.equal(seen.sessionDigest, sha(secret));
  assert.equal(seen.commandId, null);
  assert.equal(seen.bodyText, null);
  // A same-origin GET may carry the exact Origin, as browsers send on some requests.
  assert.equal(
    (
      await guarded(
        "workspaces",
        request("workspaces", {
          headers: {
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
          },
        }),
        async () => new Response("{}"),
      )
    ).response.status,
    200,
  );
  const post = await guarded("organizations", request("organizations"), async (c) => {
    seen = c;
    return new Response("{}");
  });
  assert.equal(post.response.status, 200);
  assert.equal(seen.commandId, command);
  assert.equal(
    seen.bodyText,
    JSON.stringify({ schemaVersion: 1, organizationName: "N", workspaceName: "W" }),
  );
  assert.ok(Object.isFrozen(seen));
});
test("AC28 Origin: a missing Origin is accepted only on the same-origin GET, never on POST", async () => {
  // Browsers omit Origin on a same-origin GET (packet §14, pending the §9/AC28 amendment);
  // the existing workspace bootstrap GET has the same rule. POST always needs the exact one.
  const get = request("workspaces");
  assert.equal(get.headers.has("Origin"), false);
  let calls = 0;
  const list = await guarded("workspaces", get, async () => {
    calls++;
    return new Response("{}");
  });
  assert.equal(list.response.status, 200);
  assert.equal(calls, 1);
  const post = without("organizations", "Origin");
  assert.equal(post.headers.has("Origin"), false);
  const refused = await guarded("organizations", post, async () => {
    calls++;
    return new Response("{}");
  });
  assert.equal(refused.response.status, 403);
  assert.deepEqual(refused.body, { code: "request_denied" });
  assert.equal(calls, 1);
  assert.equal(refused.submitted, false);
});
test("the guard latch: a loss after markSubmitted is outcome_unknown, before it unavailable", async () => {
  const unknown = await guarded("organizations", request("organizations"), async (c) => {
    c.markSubmitted();
    throw Error("lost");
  });
  assert.equal(unknown.response.status, 503);
  assert.deepEqual(unknown.body, { schemaVersion: 1, outcome: "outcome_unknown" });
  assert.equal(unknown.submitted, true);
  const before = await guarded("organizations", request("organizations"), async () => {
    throw Error("lost");
  });
  assert.equal(before.response.status, 503);
  assert.deepEqual(before.body, { code: "unavailable" });
});

// ------------------------------------------------------------------ outcomes and template
test("signupResponses covers every SQL outcome with the section 9 statuses", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(signupResponses).map(([k, v]) => [k, v.status])),
    {
      created: 201,
      replayed: 200,
      invalid: 400,
      unauthenticated: 401,
      not_eligible: 403,
      signup_disabled: 403,
      already_onboarded: 409,
      idempotency_conflict: 409,
      rate_limited: 429,
      denied: 503,
    },
  );
  const sqlOutcomes = new Set(
    [...migration.matchAll(/RETURN QUERY SELECT '([a-z_]+)'::text,NULL::text,NULL::text;/g)].map(
      (m) => m[1],
    ),
  );
  for (const outcome of sqlOutcomes) assert.ok(Object.hasOwn(signupResponses, outcome), outcome);
  for (const [outcome, { status, body }] of Object.entries(signupResponses)) {
    if (status === 401) assert.deepEqual(body, { code: "authentication_required" });
    else if (status === 503) assert.deepEqual(body, { code: "unavailable" });
    else if (status >= 400)
      assert.ok(validateCurrentDefinition("OrganizationSignupResult", body), outcome);
  }
  assert.deepEqual(signupResponses.not_eligible.body, signupResponses.signup_disabled.body);
});
function templateRows() {
  const block = /owner_bootstrap_grants_v1\(\)[\s\S]*?FROM \(VALUES([\s\S]*?)\) t\(c,v,f\)/.exec(
    migration,
  )[1];
  return [...block.matchAll(/\('([a-z_.]+)','(\[[^\]]*\])','(\[[^\]]*\])'\)/g)].map((m) => ({
    capabilityId: m[1],
    verbs: JSON.parse(m[2]),
    fields: JSON.parse(m[3]),
  }));
}
test("grant template v1 follows the section 3.4 rule against the merged catalogue", () => {
  const rows = templateRows();
  assert.deepEqual(rows.map((r) => r.capabilityId).sort(), [
    "governance.approval.decide",
    "governance.approval.preview",
    "governance.connection.connect",
    "governance.connection.disconnect",
    "governance.grants.revise",
    "governance.membership.invite",
    "governance.membership.revoke",
    "governance.usage.read",
  ]);
  const capabilities = new Map(catalogue.capabilities.map((c) => [c.id, c]));
  for (const row of rows) {
    const c = capabilities.get(row.capabilityId);
    assert.ok(c, row.capabilityId);
    assert.equal(c.eligible_principal.startsWith("operator_"), false);
    assert.ok(!["spend", "billable_job"].includes(c.effect), row.capabilityId);
    const expected =
      c.effect === "read"
        ? ["view"]
        : row.capabilityId === "governance.approval.decide"
          ? ["approve"]
          : row.capabilityId === "governance.connection.connect"
            ? ["administer", "approve"]
            : ["execute", "approve"];
    assert.deepEqual(row.verbs, expected, row.capabilityId);
    const names = new Set([
      ...Object.keys(v1Bodies[row.capabilityId + ".input"]?.properties ?? {}),
      ...Object.keys(v11Bodies[row.capabilityId + ".input"]?.properties ?? {}),
    ]);
    assert.deepEqual([...row.fields].sort(), [...names].sort(), row.capabilityId);
    for (const field of row.fields) assert.ok(validateDefinition("core", "FieldPath", field));
  }
});
test("grant template v1 is never paid work and matches the P01.T04a template list (P01.T04a PW5, section 9)", () => {
  // Part B merged before P01.T04a PR-A, so PR-A adds this check (P01.T04a section 9):
  // no row of owner-bootstrap-v1 is paid with its template verbs, so an unpaid
  // workspace keeps every governance power, and the migration's rows equal the
  // fixture list that inspectPaidWork (PW5) checks.
  const normalize = (rows) =>
    rows
      .map((r) => ({
        capabilityId: r.capabilityId,
        verbs: [...r.verbs].sort(),
        fields: [...r.fields].sort(),
      }))
      .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  const rows = templateRows();
  for (const row of rows)
    for (const verb of row.verbs)
      assert.equal(isPaidWork(row.capabilityId, verb), false, `${row.capabilityId} ${verb}`);
  const fixture = JSON.parse(readFileSync("docs/contracts/fixtures/P01.T04a.json", "utf8"));
  assert.deepEqual(normalize(rows), normalize(fixture.templates["owner-bootstrap-v1"]));
});
test("every template payload passes Grant and the 0002 CHECK", () => {
  const O = "0f1d5a5e-7d0c-4b6a-9bb6-6f3d2c3e1a10",
    W = "8b4f6f62-0b0e-4a4f-8a6e-4f1e6f3a2b11",
    M = "a1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d12",
    P = "c0ffee00-1111-4222-8333-444455556666";
  for (const [i, row] of templateRows().entries()) {
    const id = "00000000-0000-4000-8000-00000000000" + i;
    const payload = {
      id,
      principal: {
        kind: "human",
        principalId: P,
        organizationId: O,
        workspaceId: W,
        membershipId: M,
        installationId: null,
        mandateId: null,
      },
      capabilityId: row.capabilityId,
      verbs: row.verbs,
      scope: {
        organizationId: O,
        workspaceId: W,
        storeIds: [],
        accountIds: [],
        resources: [
          {
            organizationId: O,
            workspaceId: W,
            storeId: null,
            connectionId: null,
            kind: "workspace",
            id: W,
          },
        ],
        fields: row.fields,
      },
      issuedBy: {
        kind: "service",
        principalId: "morrow.onboarding",
        organizationId: O,
        workspaceId: W,
        membershipId: null,
        installationId: null,
        mandateId: null,
      },
      validFrom: "2026-10-18T12:00:00.123Z",
      expiresAt: null,
      revokedAt: null,
      policyRevision: 1,
    };
    assert.ok(validateDefinition("core", "Grant", payload), row.capabilityId);
    // The 0002 CHECK, field by field.
    assert.equal(payload.id, id);
    assert.equal(payload.principal.organizationId, O);
    assert.equal(payload.principal.workspaceId, W);
    assert.equal(payload.principal.membershipId, M);
    assert.equal(payload.principal.principalId, P);
    assert.equal(payload.scope.organizationId, O);
    assert.equal(payload.scope.workspaceId, W);
  }
  // The SQL builds exactly these keys, with the service provenance tag.
  assert.match(
    migration,
    /'issuedBy',jsonb_build_object\('kind','service','principalId','morrow\.onboarding'/,
  );
  assert.match(
    migration,
    /'validFrom',to_char\(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\)/,
  );
});

// ------------------------------------------------------------------ executors
function pool(script) {
  const log = { connects: 0, queries: [], releases: [] };
  return {
    log,
    async connect() {
      log.connects++;
      if (script.connect) await script.connect();
      return {
        async query(text, values) {
          log.queries.push([text, [...values]]);
          return script.query(text, values);
        },
        async release(discard) {
          log.releases.push(discard);
        },
      };
    },
  };
}
const onboardingRole = {
  role: "morrow_identity_onboarding",
  login: "morrow_identity_onboarding",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolinherit: false,
  owner_member: false,
  role_member: false,
};
const apiRole = {
  role: "morrow_api",
  login: "morrow_api",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  owner_member: false,
};
function context(change = {}) {
  const controller = new AbortController();
  const state = { submitted: false };
  return {
    state,
    c: Object.freeze({
      sessionDigest: sha(secret),
      commandId: command,
      bodyText: JSON.stringify({
        schemaVersion: 1,
        organizationName: "Cafe\u0301",
        workspaceName: " Main ",
      }),
      control: Object.freeze({ deadlineMs: Date.now() + 5000, signal: controller.signal }),
      check: () => Date.now(),
      wait: (p) => p,
      markSubmitted() {
        state.submitted = true;
      },
      ...change,
    }),
  };
}
const created = {
  outcome: "created",
  organization_id: "0f1d5a5e-7d0c-4b6a-9bb6-6f3d2c3e1a10",
  workspace_id: "8b4f6f62-0b0e-4a4f-8a6e-4f1e6f3a2b11",
};
const signupScript = (reply, change = {}) => ({
  query(text) {
    if (change[text]) return change[text]();
    if (text === accountOnboardingSql.role) return { rows: [onboardingRole] };
    if (text === accountOnboardingSql.create) return { rows: [reply] };
    return { rows: [] };
  },
});
test("signup: NFC names reach the fixed create statement once, then COMMIT", async () => {
  const p = pool(signupScript(created));
  const { c, state } = context();
  const response = await executeFirstOrganization(p, "profile_a", c);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    outcome: "created",
    organizationId: created.organization_id,
    workspaceId: created.workspace_id,
  });
  assert.equal(state.submitted, true);
  assert.deepEqual(
    p.log.queries.map(([text]) => text),
    [
      accountOnboardingSql.begin,
      accountOnboardingSql.role,
      accountOnboardingSql.timeout,
      accountOnboardingSql.idleTimeout,
      accountOnboardingSql.create,
      accountOnboardingSql.commit,
    ],
  );
  assert.deepEqual(p.log.queries[4][1], [sha(secret), command, "profile_a", "Caf\u00E9", "Main"]);
  assert.deepEqual(p.log.releases, [true]);
});
test("signup: each SQL outcome maps through the table; 429 carries Retry-After: 600", async () => {
  for (const outcome of Object.keys(signupResponses)) {
    if (outcome === "created" || outcome === "replayed") continue;
    const response = await executeFirstOrganization(
      pool(signupScript({ outcome, organization_id: null, workspace_id: null })),
      "profile_a",
      context().c,
    );
    assert.equal(response.status, signupResponses[outcome].status, outcome);
    assert.deepEqual(await response.json(), signupResponses[outcome].body);
    assert.equal(response.headers.get("retry-after"), outcome === "rate_limited" ? "600" : null);
  }
  const replayed = await executeFirstOrganization(
    pool(signupScript({ ...created, outcome: "replayed" })),
    "profile_a",
    context().c,
  );
  assert.equal(replayed.status, 200);
});
test("signup: failures before submission are unavailable; after it outcome_unknown (AC22/AC23)", async () => {
  const unavailable = { code: "unavailable" };
  const unknown = { schemaVersion: 1, outcome: "outcome_unknown" };
  const cases = [
    [
      { connect: () => Promise.reject(Error("lease")), ...signupScript(created) },
      unavailable,
      false,
    ],
    [
      signupScript(created, { [accountOnboardingSql.begin]: () => Promise.reject(Error("begin")) }),
      unavailable,
      false,
    ],
    [
      signupScript(created, {
        [accountOnboardingSql.role]: () => ({ rows: [{ ...onboardingRole, role: "morrow_api" }] }),
      }),
      unavailable,
      false,
    ],
    [
      signupScript(created, {
        [accountOnboardingSql.role]: () => ({ rows: [{ ...onboardingRole, role_member: true }] }),
      }),
      unavailable,
      false,
    ],
    // ADR-0020 (P04.T01j D5): an unknown preflight fails closed.
    [
      signupScript(created, {
        [accountOnboardingSql.role]: () => ({ rows: [{ ...onboardingRole, role_member: null }] }),
      }),
      unavailable,
      false,
    ],
    [
      signupScript(created, { [accountOnboardingSql.create]: () => Promise.reject(Error("lost")) }),
      unknown,
      true,
    ],
    [
      signupScript(created, {
        [accountOnboardingSql.create]: () => ({ rows: [{ outcome: "created" }] }),
      }),
      unknown,
      true,
    ],
    [
      signupScript(created, { [accountOnboardingSql.commit]: () => Promise.reject(Error("lost")) }),
      unknown,
      true,
    ],
  ];
  for (const [script, body, submitted] of cases) {
    const p = pool(script);
    const { c, state } = context();
    const response = await executeFirstOrganization(p, "profile_a", c);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), body);
    assert.equal(state.submitted, submitted);
    if (!submitted)
      assert.ok(!p.log.queries.some(([text]) => text === accountOnboardingSql.create));
  }
  // A lost create is discarded: no ROLLBACK is sent after an unacknowledged statement.
  const lost = pool(
    signupScript(created, { [accountOnboardingSql.create]: () => Promise.reject(Error("lost")) }),
  );
  await executeFirstOrganization(lost, "profile_a", context().c);
  assert.ok(!lost.log.queries.some(([text]) => text === accountOnboardingSql.rollback));
  // A refused role row is acknowledged, so the transaction is rolled back before release.
  const role = pool(
    signupScript(created, {
      [accountOnboardingSql.role]: () => ({ rows: [{ ...onboardingRole, rolsuper: true }] }),
    }),
  );
  await executeFirstOrganization(role, "profile_a", context().c);
  assert.equal(role.log.queries.at(-1)[0], accountOnboardingSql.rollback);
});
test("signup: closed body and names are decided before any connection", async () => {
  for (const [bodyText, status, body] of [
    [
      JSON.stringify({ schemaVersion: 1, organizationName: "N", workspaceName: "W", email: "a@b" }),
      400,
      { code: "request_denied" },
    ],
    [
      JSON.stringify({ schemaVersion: 1, organizationName: "", workspaceName: "W" }),
      400,
      { schemaVersion: 1, outcome: "invalid_name" },
    ],
    [
      JSON.stringify({ schemaVersion: 1, organizationName: "a\u202Eb", workspaceName: "W" }),
      400,
      { schemaVersion: 1, outcome: "invalid_name" },
    ],
  ]) {
    const p = pool(signupScript(created));
    const response = await executeFirstOrganization(p, "profile_a", context({ bodyText }).c);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), body);
    assert.equal(p.log.connects, 0);
  }
});
test("overview: zero rows is 401; 101 rows are 100 and truncated; malformed rows are 503", async () => {
  const entry = (i) => ({
    workspaceName: "W" + i,
    organizationId: "org_a",
    workspaceId: "ws_" + i,
    organizationName: "Org",
  });
  const script = (rows) => ({
    query(text) {
      if (text === identitySql.role) return { rows: [apiRole] };
      if (text === accountOverviewSql) return { rows };
      return { rows: [] };
    },
  });
  const run = async (rows) =>
    executeAccountOverview(
      pool(script(rows)),
      "profile_a",
      context({ commandId: null, bodyText: null }).c,
    );
  assert.equal((await run([])).status, 401);
  const many = await run([
    {
      onboarding: "unavailable",
      workspaces: JSON.stringify(Array.from({ length: 101 }, (_, i) => entry(i))),
    },
  ]);
  const body = await many.json();
  assert.equal(many.status, 200);
  assert.equal(body.workspaces.length, 100);
  assert.equal(body.truncated, true);
  assert.deepEqual(Object.keys(body.workspaces[0]), [
    "organizationId",
    "organizationName",
    "workspaceId",
    "workspaceName",
  ]);
  assert.ok(validateCurrentDefinition("AccountOverview", body));
  for (const rows of [
    [{ onboarding: "maybe", workspaces: "[]" }],
    [{ onboarding: "available", workspaces: "{}" }],
    [{ onboarding: "available", workspaces: JSON.stringify([{ ...entry(1), email: "x" }]) }],
    [{ onboarding: "available", workspaces: JSON.stringify([entry(1), entry(1)]) }],
    [{ onboarding: "available" }],
    [
      { onboarding: "available", workspaces: "[]" },
      { onboarding: "available", workspaces: "[]" },
    ],
  ])
    assert.equal((await run(rows)).status, 503, JSON.stringify(rows).slice(0, 80));
});
test("the fixed runner: READ ONLY begin and role row for the list; it never decides unknown", async () => {
  const p = pool({
    query(text) {
      if (text === identitySql.role) return { rows: [apiRole] };
      return { rows: [] };
    },
  });
  const { c } = context();
  const result = await runFixedSqlTransaction(
    p,
    c,
    {
      begin: identitySql.begin,
      role: identitySql.role,
      settings: [identitySql.timeout],
      commit: identitySql.commit,
      rollback: identitySql.rollback,
      requireRole() {},
    },
    async () => {
      throw Error("body");
    },
  );
  assert.deepEqual(result, { ok: false });
  assert.deepEqual(
    p.log.queries.map(([t]) => t),
    [identitySql.begin, identitySql.role, identitySql.timeout, identitySql.rollback],
  );
  assert.match(identitySql.begin, /READ ONLY/);
});

// ------------------------------------------------------------------ pools and broker
test("workspace pools: overview on morrow_api, and the onboarding create parameter rule", () => {
  const { identityPool, onboardingPool } = controlledNeonWorkspaceProfiles;
  assert.equal(identityPool.statements.overview.text, accountOverviewSql);
  assert.equal(identityPool.statements.overview.arity, 2);
  assert.equal(onboardingPool.role, "morrow_identity_onboarding");
  assert.deepEqual(Object.keys(onboardingPool.statements).sort(), [
    "begin",
    "commit",
    "create",
    "idleTimeout",
    "role",
    "rollback",
    "timeout",
  ]);
  assert.equal(onboardingPool.statementTimeout, 2000);
  assert.equal(onboardingPool.idleTimeout, 5000);
  const create = onboardingPool.statements.create.text;
  const ok = [sha(secret), command, "profile_a", "Caf\u00E9 Noor", "\u{1F600}".repeat(100)];
  assert.deepEqual(snapshotControlledNeonWorkspaceParameters(onboardingPool, create, ok), ok);
  for (const values of [
    [sha(secret), command, "profil\u00E9", "Org", "Main"],
    [sha(secret) + "\u00E9", command, "profile_a", "Org", "Main"],
    [sha(secret), command, "p".repeat(129), "Org", "Main"],
    [sha(secret), command, "profile_a", "x".repeat(201), "Main"],
    [sha(secret), command, "profile_a", "a\u0000b", "Main"],
    [sha(secret), command, "profile_a", "a\ud800b", "Main"],
  ])
    assert.throws(() => snapshotControlledNeonWorkspaceParameters(onboardingPool, create, values));
  // The Unicode exemption is only for the create statement of the onboarding pool.
  assert.throws(() =>
    snapshotControlledNeonWorkspaceParameters(identityPool, accountOverviewSql, [
      sha(secret),
      "profil\u00E9",
    ]),
  );
});
test("broker role table: eight roles, onboarding added and the selection role dropped", () => {
  // Seven identity roles plus the P06.T01a work login (ADR-0010 item 2).
  assert.equal(Object.keys(brokerNeonRoles).length, 8);
  assert.equal(
    brokerNeonRoles.morrow_identity_onboarding,
    "workspace_primary_and_one_same_role_observer",
  );
  assert.equal(Object.hasOwn(brokerNeonRoles, "morrow_identity_resolution"), false);
  // WORKOS_API_KEY, TURNSTILE_SECRET_KEY (P05.T01ab) and the eight role passwords.
  assert.equal(brokerRequiredSecrets.length, 10);
  assert.ok(brokerRequiredSecrets.includes("MORROW_DB_PASSWORD_MORROW_IDENTITY_ONBOARDING"));
  assert.equal(brokerNeonRoles.morrow_api_worker, "work_request_transaction");
  for (const [role, purpose] of Object.entries(brokerNeonRoles)) {
    if (role === "morrow_api_worker") continue;
    assert.equal(
      purpose,
      Object.values(controlledNeonWorkspaceProfiles).some((p) => p.role === role)
        ? "workspace_primary_and_one_same_role_observer"
        : "primary_and_one_same_role_observer",
      role,
    );
  }
});
