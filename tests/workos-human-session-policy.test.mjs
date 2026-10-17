import assert from "node:assert/strict";
import test from "node:test";
import { createWorkosSessionStatusReader } from "../packages/identity/src/workos-session-status.ts";
import { createWorkosAuthenticationEvidence } from "../packages/identity/src/workos-authentication-evidence.ts";
import {
  createWorkosWorkspaceSelection,
  workspaceSelectionSql,
} from "../packages/identity/src/workos-workspace-selection.ts";
import {
  buildWorkosAuthenticationEvidenceFixture,
  workosAuthenticationEvidenceId as id,
} from "./fixtures/workos-authentication-evidence.mjs";

// Independent policy expectations from canonical78, not implementation exports.
const knownMethods = [
  "cross_app_auth",
  "external_auth",
  "magic_code",
  "migrated_session",
  "oauth",
  "passkey",
  "password",
  "sso",
];
const fixture = buildWorkosAuthenticationEvidenceFixture();
const heldObservation = { outcome: "held", handle: null };
const heldSelection = { outcome: "held", selection: null };
async function chain(pages, options = {}) {
  const f = fixture;
  let readerPages = 0,
    compositionPages = 0,
    connections = 0,
    releases = 0;
  const queryJson = JSON.stringify({
    schemaVersion: 1,
    subjectId: f.claims.sub,
    providerSessionId: f.claims.sid,
  });
  const reader = createWorkosSessionStatusReader(f.observationProfileJson, {
    now: () => f.at,
    currentProfile: () => f.observationProfileJson,
    readPage: async () => pages[readerPages++],
  });
  const observed = await reader.observe(queryJson);
  const composer = createWorkosAuthenticationEvidence(f.profileJson, f.snapshotJson, {
    now: () => f.at,
    currentProfile: () => f.profileJson,
    readPage: async () => pages[compositionPages++],
  });
  const evidence = await composer.verify(options.token ?? f.token);
  const queries = [];
  const selector = createWorkosWorkspaceSelection({
    readEvidence: composer.readEvidence,
    now: () => f.at,
    pool: {
      connect: async (control) => {
        connections++;
        assert.equal(control.deadlineMs, f.at + 5000);
        return {
          query: async (text, values) => {
            queries.push(text);
            if (text === workspaceSelectionSql.role)
              return {
                rows: [
                  {
                    role: "morrow_identity_resolution",
                    login: "morrow_identity_resolution",
                    rolsuper: false,
                    rolbypassrls: false,
                    rolcreatedb: false,
                    rolcreaterole: false,
                    rolreplication: false,
                    rolinherit: false,
                    owner_member: false,
                    role_member: false,
                  },
                ],
              };
            if (text === workspaceSelectionSql.resolve) {
              assert.deepEqual(values, [
                "workos",
                f.profile.environmentId,
                f.profile.applicationId,
                f.profile.clientId,
                f.profile.issuer,
                "1",
                composer.readEvidence(evidence.handle).tokenProfileDigest,
                f.claims.sub,
                "workspace_policy",
              ]);
              return {
                rows: [
                  {
                    profile_id: "profile_policy",
                    profile_record_revision: "1",
                    mapping_id: "mapping_policy",
                    mapping_revision: "1",
                    binding_revision: "1",
                    principal_id: "human_policy",
                    organization_id: "organization_policy",
                    workspace_id: "workspace_policy",
                    membership_id: "membership_policy",
                    policy_revision: "1",
                  },
                ],
              };
            }
            assert.ok(Object.values(workspaceSelectionSql).includes(text));
            return { rows: [] };
          },
          release: async (discard) => {
            assert.equal(discard, true);
            releases++;
          },
        };
      },
    },
  });
  const selected = await selector.resolve(
    evidence.handle,
    JSON.stringify({ schemaVersion: 1, workspaceId: "workspace_policy" }),
  );
  return {
    observed,
    evidence,
    selected,
    connections,
    releases,
    queries,
    readerPages,
    compositionPages,
    observation: observed.outcome === "held" ? null : reader.readObservation(observed.handle),
    privateEvidence: evidence.outcome === "held" ? null : composer.readEvidence(evidence.handle),
  };
}
async function assertHeld(pages, expectedPages = pages.length) {
  const result = await chain(pages);
  assert.deepEqual(result.observed, heldObservation);
  assert.deepEqual(result.evidence, heldObservation);
  assert.deepEqual(result.selected, heldSelection);
  assert.equal(result.connections, 0);
  assert.equal(result.releases, 0);
  assert.equal(result.queries.length, 0);
  assert.equal(result.readerPages, expectedPages);
  assert.equal(result.compositionPages, expectedPages);
}
for (const method of knownMethods) {
  test(`recognized ${method} reaches private evidence and selected snapshot without exposing method`, async () => {
    const result = await chain([
      fixture.page([fixture.session({ auth_method: method, impersonator: null })]),
    ]);
    assert.equal(result.observed.outcome, "observed_active");
    assert.equal(result.evidence.outcome, "verified_active_evidence");
    assert.equal(result.selected.outcome, "selected");
    assert.equal(result.connections, 1);
    assert.equal(result.releases, 1);
    assert.equal(result.queries.length, 7);
    assert.equal(result.selected.selection.workspaceId, "workspace_policy");
    assert.equal(result.privateEvidence.sessionClientBinding, "expected_only");
    assert.equal(Object.hasOwn(result.observation, "authMethod"), false);
    assert.equal(Object.hasOwn(result.privateEvidence, "authMethod"), false);
    assert.equal(Object.hasOwn(result.observation, "impersonator"), false);
    assert.equal(JSON.stringify(result.observed), '{"outcome":"observed_active","handle":{}}');
  });
}
test("explicit impersonation independently holds with absent, null or contradictory metadata", async () => {
  for (const impersonator of [
    undefined,
    null,
    { email: "support@example.invalid", reason: null },
    { email: "support@example.invalid", reason: "synthetic" },
  ]) {
    await assertHeld([
      fixture.page([fixture.session({ auth_method: "impersonation", impersonator })]),
    ]);
  }
});
test("either target impersonator metadata signal holds even with a recognized normal method", async () => {
  for (const reason of [null, "synthetic support reason", ""]) {
    await assertHeld([
      fixture.page([
        fixture.session({
          auth_method: "oauth",
          impersonator: { email: "support@example.invalid", reason },
        }),
      ]),
    ]);
  }
});
test("absent, null, unknown, new, cased and padded target methods never produce evidence or SQL", async () => {
  for (const auth_method of [
    undefined,
    null,
    "unknown",
    "new_provider_method",
    "OAUTH",
    "OAuth",
    " oauth",
    "oauth ",
    "oauth\n",
    "",
    false,
    1,
    {},
    ["oauth"],
  ]) {
    await assertHeld([fixture.page([fixture.session({ auth_method, impersonator: null })])]);
  }
});
test("valid unrelated impersonated and unknown-method rows do not poison a normal target", async () => {
  const first = fixture.session({ auth_method: "sso" });
  const cursor = id("session", 60);
  const otherImpersonation = fixture.session({
    id: cursor,
    auth_method: "impersonation",
    impersonator: { email: "support@example.invalid", reason: null },
  });
  const unknown = fixture.session({
    id: id("session", 61),
    auth_method: "unknown",
    impersonator: null,
  });
  const pages = [fixture.page([first], cursor), fixture.page([otherImpersonation, unknown])];
  const result = await chain(pages);
  assert.equal(result.observed.outcome, "observed_active");
  assert.equal(result.evidence.outcome, "verified_active_evidence");
  assert.equal(result.selected.outcome, "selected");
  assert.equal(result.readerPages, 2);
  assert.equal(result.compositionPages, 2);
  assert.equal(result.connections, 1);
  for (const privateFact of [result.observation, result.privateEvidence]) {
    const serialized = JSON.stringify(privateFact);
    assert.equal(serialized.includes("support@example.invalid"), false);
    assert.equal(serialized.includes("impersonation"), false);
    assert.equal(serialized.includes("unknown"), false);
  }
});
test("complete target miss remains only not_observed_active even with other impersonated rows", async () => {
  const pages = [
    fixture.page([
      fixture.session({
        id: id("session", 70),
        auth_method: "impersonation",
        impersonator: { email: "support@example.invalid", reason: null },
      }),
    ]),
  ];
  const result = await chain(pages);
  assert.equal(result.observed.outcome, "not_observed_active");
  assert.deepEqual(result.evidence, heldObservation);
  assert.deepEqual(result.selected, heldSelection);
  assert.equal(result.connections, 0);
});
test("nullable reason is valid shape but malformed unrelated metadata still holds whole catalogue", async () => {
  for (const reason of [false, 1, {}, [], "x".repeat(4097), undefined]) {
    const pages = [
      fixture.page([fixture.session({ auth_method: "password" })], id("session", 80)),
      fixture.page([
        fixture.session({
          id: id("session", 80),
          auth_method: "impersonation",
          impersonator: { email: "support@example.invalid", reason },
        }),
      ]),
    ];
    await assertHeld(pages);
  }
});
test("early normal match cannot bypass later malformed page or missing pagination completeness", async () => {
  for (const later of [
    "{}",
    '{"object":"list","data":[],"list_metadata":{"before":null}}',
    '{"object":"list","data":[],"list_metadata":{"after":null}}',
    '{"object":"list","data":[],"list_metadata":{}}',
  ]) {
    await assertHeld([
      fixture.page([fixture.session({ auth_method: "passkey" })], id("session", 90)),
      later,
    ]);
  }
});
test("unchanged cryptographic act rejection still prevents catalogue reads and any SQL", async () => {
  const result = await chain([fixture.page()], {
    token: fixture.sign({ act: { sub: "support" } }),
  });
  assert.deepEqual(result.evidence, heldObservation);
  assert.deepEqual(result.selected, heldSelection);
  assert.equal(result.compositionPages, 0);
  assert.equal(result.connections, 0);
});
