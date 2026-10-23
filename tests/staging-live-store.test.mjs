// v1 PR 1 (ADR-0035 items 2 to 4; docs/briefs/v1-connect-store.md): the staging tools'
// side of "Connect your live store", over fakes. The approval the tools read is the owner's
// standing approval (docs/decisions/standing-approval.json), which replaced staging-card-1
// and has no end date; the test entitlement under it needs no per-use record and goes only
// to the workspace the live-store app invites; self-service rests on the recorded WorkOS
// facts; and `staging:shopify-app-register` registers the owner's app with the live-store
// mark and seals its client secret, reading the secret only from the hidden prompt or the
// owner's 0600 file and printing nothing secret. PostgreSQL behaviour of the two
// statements is qualified by lab:test-entitlement (V cases) and lab:shopify-install.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvalRecordPath,
  cardState,
  defaultContext,
  main,
  requireStandingRecord,
  requireTestEntitlementApproval,
  standingApprovalId,
  standingState,
} from "../scripts/staging.mjs";
import {
  checkSealedEnvelope,
  grantTestEntitlement,
  liveStoreWorkspaceStatement,
  registerShopifyApp,
  seedPlatform,
  selfServiceReasons,
  shopifyAppRegistrationInput,
  shopifyAppStatements,
} from "../scripts/staging-runner.mjs";
import { kekFingerprint, sealAppSecretWithKek } from "../scripts/vault.mjs";
import {
  approvedCard,
  fakeContext,
  fakeDatabase,
  fakeSha,
  fakeTools,
  labBinding,
  plantedHome,
  standingApproval,
} from "./fixtures/staging-fakes.mjs";

const read = (path) => readFileSync(path, "utf8");
const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code ?? error.message;
  }
};
const administrator = Object.freeze({ name: "neondb_owner", mode: "createrole" });
const ownerUrl = `postgresql://neondb_owner:${"o".repeat(24)}@${labBinding.hostname}/morrow?sslmode=require`;
const kek = "5eed".repeat(16);
const secret = "shpss_" + "0123456789abcdef".repeat(2);
const shop = "owner-live-store.myshopify.com";
const shopDigest = createHash("sha256").update(shop).digest("hex");
const installUrl =
  "https://admin.shopify.com/oauth/install_custom_app?client_id=0123456789abcdef0123456789abcdef&no_redirect=true&signature=synthetic";
const registration = Object.freeze({
  appKey: "morrow-live",
  clientId: "0123456789abcdef0123456789abcdef",
  shopDigest,
  workspaceId: "ws_owner",
  installUrl,
});
const sealFor = (appKey) => async (version) =>
  sealAppSecretWithKek(
    { environment: "staging", "app-key": appKey, version: String(version), "kek-version": "1" },
    secret,
    () => kek,
  );
// Every statement and parameter a fake database received, as one text.
const sent = (db) => JSON.stringify(db.statements);
const afterBegin = (db) => {
  const texts = db.statements.map((s) => s.text);
  return texts.slice(texts.indexOf("BEGIN"));
};

// ---------------------------------------------------------------------------
// The approval record.
test("standing approval: the committed record is active with no end date, and its records exist", () => {
  assert.equal(approvalRecordPath, "docs/decisions/standing-approval.json");
  const record = JSON.parse(read(approvalRecordPath));
  assert.deepEqual(record, standingApproval());
  assert.deepEqual(standingState(record), { active: true, reason: null });
  for (const at of ["2026-10-23T00:00:00Z", "2026-11-19T00:00:00Z", "2027-06-01T00:00:00Z"])
    assert.deepEqual(cardState(record, Date.parse(at)), { active: true, reason: null }, at);
  // The decision it names, its own live record and the WorkOS record self-service rests on.
  assert.match(read(record.record), /^# ADR-0035 Build v1 live/);
  requireStandingRecord(read(record.evidence), standingApprovalId);
  assert.match(read(record.e7.record), /Sign-up[\s\S]*off|Disabled/);
  assert.match(read(record.e7.record), /Email verification: Enabled/);
  // It sits beside the reviewed records, not among the graph's cards, and the card stays.
  assert.ok(!approvalRecordPath.startsWith("docs/decisions/approvals/"));
  assert.equal(JSON.parse(read("docs/decisions/approvals/staging-card.json")).id, "staging-card-1");
  // No shop identity in either record.
  assert.doesNotMatch(read(approvalRecordPath) + read(record.evidence), /myshopify|\.myshop/);
});

test("standing approval: a closed shape; withdrawn or any other change is inactive", () => {
  assert.deepEqual(standingState(standingApproval({ status: "withdrawn" })), {
    active: false,
    reason: "withdrawn",
  });
  for (const change of [
    { status: "proposed" },
    { status: "expired" },
    { id: "adr-0036" },
    { schemaVersion: 2 },
    { record: "docs/decisions/adr/ADR-0023-lean-mvp.md" },
    { replaces: "staging-card-2" },
    { environment: "production" },
    { approvedOn: "soon" },
    { evidence: "docs/decisions/approvals/staging.md" },
    { evidence: "../docs/evidence/live/2026-10-23-x.md" },
    { expiresOn: "2026-11-18" },
  ])
    assert.equal(standingState(standingApproval(change)).reason, "invalid", JSON.stringify(change));
  const { e7: _e7, ...missing } = standingApproval();
  assert.equal(standingState(missing).reason, "invalid");
  assert.equal(standingState(null).reason, "invalid");
  assert.equal(standingState([]).reason, "invalid");
  // A standing record of another kind is read by the card's rule, which refuses it.
  assert.equal(cardState(standingApproval({ kind: "card" }), Date.now()).reason, "invalid");
});

test("standing approval: its live record names it on one labelled line, exactly once", () => {
  for (const text of [
    "- **Standing approval:** `adr-0035`\n",
    "Standing approval: adr-0035\r\n",
    "* **Standing approval:** adr-0035  \n",
  ])
    requireStandingRecord(text, "adr-0035");
  for (const text of [
    "",
    "- **Standing approval:** `adr-0035` and more\n",
    "- **Standing approval:** `adr-00351`\n",
    "- **Standing approval:** `staging-card-1`\n",
    "- **Standing approval:** `adr-0035`\n- Standing approval: adr-0035\n",
    "The standing approval adr-0035 covers this.\n",
  ])
    assert.equal(
      codeOf(() => requireStandingRecord(text, "adr-0035")),
      "STAGING_EVIDENCE_MISMATCH",
      text,
    );
});

// ---------------------------------------------------------------------------
// The test entitlement under the standing approval.
test("test-entitlement: under the standing approval, adr-0035.e13 references from its date, with no end date", () => {
  const record = standingApproval();
  requireTestEntitlementApproval(record, "adr-0035.e13.2026-10-23.1", Date.parse("2026-10-24"));
  requireTestEntitlementApproval(record, "adr-0035.e13.2026-12-01.4", Date.parse("2026-12-02"));
  for (const ref of [
    "staging-card-1.e13.2026-10-23.1",
    "adr-0035.e13.2026-10-22.1",
    "adr-0035.e7.2026-10-23.1",
    "adr-0035.e13.2026-10-25.1",
    "adr-0035.e13.2026-10-23",
  ])
    assert.equal(
      codeOf(() => requireTestEntitlementApproval(record, ref, Date.parse("2026-10-24"))),
      "STAGING_APPROVAL_INVALID",
      ref,
    );
  for (const e13 of [null, { amendedOn: "2026-10-21" }, { amendedOn: "2026-10-23", n: 1 }])
    assert.equal(
      codeOf(() =>
        requireTestEntitlementApproval(
          standingApproval({ e13 }),
          "adr-0035.e13.2026-10-23.1",
          Date.parse("2026-10-24"),
        ),
      ),
      "STAGING_CARD_EFFECT_MISSING",
      JSON.stringify(e13),
    );
});

const entitlementResult = Object.freeze({
  entitlementId: "00000000-0000-4000-8000-0000000000e1",
  organizationId: "org_owner",
  workspaceId: "ws_owner",
  billingAccountId: "00000000-0000-4000-8000-0000000000a1",
  creditUnits: "300",
  termsRevision: "1",
  periodStart: "2026-10-24T12:00:00.000Z",
  periodEnd: "2026-11-23T12:00:00.000Z",
  routeRevision: "2",
});
const standingInput = Object.freeze({
  operatorId: "operator_claude",
  workspaceId: "ws_owner",
  approvalRef: "adr-0035.e13.2026-10-24.1",
  evidenceRef: "docs/evidence/live/2026-10-23-standing-approval.md",
});

test("test-entitlement: requireLiveStoreWorkspace reads the live-store app's workspace as the identity owner first", async () => {
  const run = async (n) => {
    const db = fakeDatabase({
      rules: [
        [/FROM morrow_identity\.shopify_apps WHERE live_store/, [{ n }]],
        [
          /operator_test_entitlement_grant/,
          [{ outcome: "granted", result: JSON.stringify(entitlementResult) }],
        ],
      ],
    });
    const outcome = await grantTestEntitlement({
      connect: db.connector().connect,
      binding: labBinding,
      administrator,
      input: standingInput,
      requireLiveStoreWorkspace: true,
    }).then(
      (done) => done,
      (error) => error,
    );
    return { db, outcome };
  };
  const ok = await run(1);
  assert.deepEqual(ok.outcome, { outcome: "granted", ...entitlementResult });
  assert.deepEqual(afterBegin(ok.db).slice(0, 9), [
    "BEGIN",
    "GRANT morrow_identity_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
    "SET LOCAL ROLE morrow_identity_owner",
    liveStoreWorkspaceStatement,
    "RESET ROLE",
    "REVOKE morrow_identity_owner FROM neondb_owner GRANTED BY neondb_owner",
    "GRANT morrow_work_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
    "SET LOCAL ROLE morrow_work_owner",
    "SELECT outcome, result FROM morrow_billing.operator_test_entitlement_grant($1, $2, $3, $4)",
  ]);
  assert.deepEqual(ok.db.statements.find((s) => s.text === liveStoreWorkspaceStatement).params, [
    "staging",
    "ws_owner",
  ]);
  // Any other workspace (none, or more than one marked app naming it) grants nothing.
  for (const n of [0, 2]) {
    const refused = await run(n);
    assert.equal(refused.outcome.code, "STAGING_TEST_ENTITLEMENT_NOT_OWNER_WORKSPACE");
    assert.ok(!sent(refused.db).includes("operator_test_entitlement_grant"));
    assert.ok(!afterBegin(refused.db).includes("COMMIT"));
  }
});

test("cli: test-entitlement under the standing approval uses its own record at main and the owner's workspace only", async () => {
  const planted = plantedHome({ "neon-owner-url": ownerUrl });
  const root = mkdtempSync(join(tmpdir(), "morrow-live-entitlement-root-"));
  const evidence = standingInput.evidenceRef;
  const named = "- **Standing approval:** `adr-0035`\n";
  const argv = [
    "test-entitlement",
    "--workspace",
    standingInput.workspaceId,
    "--approval",
    standingInput.approvalRef,
    "--operator",
    standingInput.operatorId,
  ];
  const world = async ({ text = named, n = 1, card = standingApproval() } = {}) => {
    const fake = fakeTools({ git: { files: text === null ? {} : { [evidence]: { text } } } });
    const { ctx, out, err } = await fakeContext({
      home: planted.home,
      root,
      tools: fake.tools,
      card,
      now: Date.parse("2026-10-24T12:00:00Z"),
    });
    const db = fakeDatabase({
      rules: [
        [/FROM morrow_identity\.shopify_apps WHERE live_store/, [{ n }]],
        [
          /operator_test_entitlement_grant/,
          [{ outcome: "granted", result: JSON.stringify(entitlementResult) }],
        ],
      ],
    });
    ctx.database = db.connector;
    return { ctx, out, err, db };
  };
  try {
    const ok = await world();
    assert.equal(await main(argv, ok.ctx), 0, ok.err.join("\n"));
    assert.deepEqual(JSON.parse(ok.out.at(-1)), {
      command: "test-entitlement",
      outcome: "granted",
      ...entitlementResult,
      approvalRef: standingInput.approvalRef,
      record: evidence,
      recordCommit: fakeSha("main"),
    });
    assert.deepEqual(
      ok.db.statements.find((s) => /operator_test_entitlement_grant/.test(s.text)).params,
      Object.values(standingInput),
    );
    // The same record named explicitly is accepted; another record is a usage error.
    const explicit = await world();
    assert.equal(await main([...argv, "--record", evidence], explicit.ctx), 0);
    for (const [options, extra, code] of [
      [{}, ["--record", "docs/evidence/live/2026-10-24-other.md"], "STAGING_USAGE"],
      [{ text: "- **Approval.** yes\n" }, [], "STAGING_EVIDENCE_MISMATCH"],
      [{ text: null }, [], "STAGING_EVIDENCE_MISSING"],
      [{ n: 0 }, [], "STAGING_TEST_ENTITLEMENT_NOT_OWNER_WORKSPACE"],
      [{ card: standingApproval({ status: "withdrawn" }) }, [], "STAGING_CARD_INACTIVE"],
      // The card keeps its per-use record: without --record it is a usage error.
      [
        { card: { ...approvedCard("2026-10-23"), e13: { amendedOn: "2026-10-23" } } },
        [],
        "STAGING_APPROVAL_INVALID",
      ],
    ]) {
      const w = await world(options);
      assert.equal(await main([...argv, ...extra], w.ctx), 1, code);
      assert.equal(JSON.parse(w.err.at(-1)).code, code, code);
      assert.ok(!sent(w.db).includes("operator_test_entitlement_grant"), code);
    }
    const card = await world({
      card: { ...approvedCard("2026-10-23"), e13: { amendedOn: "2026-10-23" } },
    });
    const cardArgv = argv.map((a) =>
      a === standingInput.approvalRef ? "staging-card-1.e13.2026-10-24.1" : a,
    );
    assert.equal(await main(cardArgv, card.ctx), 1);
    assert.equal(JSON.parse(card.err.at(-1)).code, "STAGING_USAGE");
  } finally {
    planted.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Self-service under the standing approval.
test("cli: seed-platform's self-service under the standing approval needs e7's observed WorkOS record", async () => {
  const planted = plantedHome();
  try {
    for (const [e7, code] of [
      [null, "STAGING_SELF_SERVICE_UNCONFIRMED"],
      // The card's shape is not the standing approval's.
      [
        {
          confirmedOn: "2026-10-19",
          record: "docs/evidence/live/2026-10-19-workos-signup-disabled.md",
        },
        "STAGING_SELF_SERVICE_UNCONFIRMED",
      ],
      [
        { observedOn: "2026-10-19", record: "docs/evidence/live/2026-10-19-workos-other.md" },
        "STAGING_SELF_SERVICE_UNCONFIRMED",
      ],
      [
        { observedOn: "soon", record: "docs/evidence/live/2026-10-19-workos-signup-disabled.md" },
        "STAGING_SELF_SERVICE_UNCONFIRMED",
      ],
      // The committed record passes the e7 check; the fake then has no login configuration.
      [standingApproval().e7, "STAGING_LOGIN_CONFIGURATION_MISSING"],
    ]) {
      const { ctx, err } = await fakeContext({
        home: planted.home,
        tools: fakeTools().tools,
        card: standingApproval({ e7 }),
      });
      assert.equal(await main(["seed-platform", "--self-service"], ctx), 1);
      assert.equal(JSON.parse(err.at(-1)).code, code, JSON.stringify(e7));
    }
  } finally {
    planted.cleanup();
  }
  // The self-service row's reason is fixed per approval; any other reference is refused
  // before a connection.
  assert.deepEqual(Object.keys(selfServiceReasons).sort(), ["adr-0035.e7", "staging-card-1.e7"]);
  for (const approvalRef of ["adr-0035.e13", "staging-card-2.e7", "approved"])
    await assert.rejects(
      seedPlatform({
        connect: async () => {
          throw Error("connected");
        },
        binding: labBinding,
        administrator,
        rows: {},
        selfService: { approvalRef },
      }),
      (error) => error.code === "STAGING_SELF_SERVICE_UNCONFIRMED",
      approvalRef,
    );
});

// ---------------------------------------------------------------------------
// The registration and the sealed secret.
const appRules = (overrides = {}) => [
  [
    /FROM morrow_identity\.workspaces WHERE id/,
    overrides.workspace ?? [{ organization_id: "org_owner" }],
  ],
  [
    /shopify_app_register_live/,
    overrides.register ?? [{ outcome: "registered", app_key: registration.appKey }],
  ],
  [/FROM morrow_identity\.shopify_apps WHERE app_key/, overrides.existing ?? []],
  [/pg_advisory_xact_lock/, [{ locked: true }]],
  [/FROM morrow_vault\.app_secrets WHERE app_key/, overrides.next ?? [{ version: "1" }]],
  [/app_secret_put/, overrides.put ?? [{ outcome: "stored", version: "1" }]],
];
const existingRow = Object.freeze({
  client_id: registration.clientId,
  environment_id: "staging",
  intended_shop_digest: shopDigest,
  organization_id: "org_owner",
  workspace_id: "ws_owner",
  install_url: installUrl,
  status: "active",
  live_store: "true",
});

test("registerShopifyApp: the registration as the identity owner, then the secret at the app's next version as the work owner", async () => {
  const db = fakeDatabase({ rules: appRules() });
  const versions = [];
  const seal = sealFor(registration.appKey);
  const result = await registerShopifyApp({
    connect: db.connector().connect,
    binding: labBinding,
    administrator,
    input: registration,
    seal: async (version) => {
      versions.push(version);
      return seal(version);
    },
  });
  assert.deepEqual(result, {
    appKey: "morrow-live",
    registration: "registered",
    organizationId: "org_owner",
    workspaceId: "ws_owner",
    secretVersion: "1",
    kekVersion: 1,
  });
  assert.deepEqual(versions, [1]);
  const texts = db.statements.map((s) => s.text);
  const begins = texts.flatMap((t, i) => (t === "BEGIN" ? [i] : []));
  assert.equal(begins.length, 2);
  assert.deepEqual(texts.slice(begins[0], begins[0] + 8), [
    "BEGIN",
    "GRANT morrow_identity_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
    "SET LOCAL ROLE morrow_identity_owner",
    shopifyAppStatements.workspace,
    shopifyAppStatements.register,
    "RESET ROLE",
    "REVOKE morrow_identity_owner FROM neondb_owner GRANTED BY neondb_owner",
    "COMMIT",
  ]);
  assert.deepEqual(texts.slice(begins[1], begins[1] + 9), [
    "BEGIN",
    "GRANT morrow_work_owner TO neondb_owner WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
    "SET LOCAL ROLE morrow_work_owner",
    shopifyAppStatements.secretLock,
    shopifyAppStatements.secretNext,
    shopifyAppStatements.secretPut,
    "RESET ROLE",
    "REVOKE morrow_work_owner FROM neondb_owner GRANTED BY neondb_owner",
    "COMMIT",
  ]);
  assert.deepEqual(db.statements.find((s) => s.text === shopifyAppStatements.register).params, [
    "morrow-live",
    registration.clientId,
    "staging",
    shopDigest,
    "org_owner",
    "ws_owner",
    installUrl,
  ]);
  const put = db.statements.find((s) => s.text === shopifyAppStatements.secretPut).params;
  assert.equal(put[0], "morrow-live");
  assert.equal(put[1], "1");
  assert.match(put[2], /^[a-f0-9]{120}$/);
  assert.match(put[3], /^[a-f0-9]+$/);
  // The database receives the shop's digest and the ciphertext: never the domain or the
  // secret, in any statement or parameter.
  assert.ok(!sent(db).includes(secret));
  assert.ok(!sent(db).includes(Buffer.from(secret).toString("hex")));
  assert.ok(!sent(db).includes(shop));
});

test("registerShopifyApp: a replay stores the next version; a refusal, a mismatch or a bad envelope commits nothing more", async () => {
  // The same registration again: replayed, and the secret goes in at version 2 (a rotation).
  const replay = fakeDatabase({
    rules: appRules({
      register: [{ outcome: "exists", app_key: null }],
      existing: [existingRow],
      next: [{ version: "2" }],
      put: [{ outcome: "stored", version: "2" }],
    }),
  });
  const replayed = await registerShopifyApp({
    connect: replay.connector().connect,
    binding: labBinding,
    administrator,
    input: registration,
    seal: sealFor(registration.appKey),
  });
  assert.equal(replayed.registration, "already_registered");
  assert.equal(replayed.secretVersion, "2");
  const run = async (overrides, seal = sealFor(registration.appKey)) => {
    const db = fakeDatabase({ rules: appRules(overrides) });
    const error = await registerShopifyApp({
      connect: db.connector().connect,
      binding: labBinding,
      administrator,
      input: registration,
      seal,
    }).then(
      () => null,
      (e) => e,
    );
    const texts = db.statements.map((s) => s.text);
    return { error, texts, commits: texts.filter((t) => t === "COMMIT").length };
  };
  // The registration refused: nothing committed and the vault never asked.
  for (const [overrides, code, details] of [
    [{ workspace: [] }, "STAGING_SHOPIFY_APP_WORKSPACE_UNKNOWN", undefined],
    [
      { register: [{ outcome: "live_store_taken", app_key: null }] },
      "STAGING_SHOPIFY_APP_REFUSED",
      { outcome: "live_store_taken" },
    ],
    [
      // Another app's row, or this app for another shop or workspace, is not a replay.
      {
        register: [{ outcome: "exists", app_key: null }],
        existing: [{ ...existingRow, intended_shop_digest: "f".repeat(64) }],
      },
      "STAGING_SHOPIFY_APP_REFUSED",
      { outcome: "exists" },
    ],
    [
      {
        register: [{ outcome: "exists", app_key: null }],
        existing: [{ ...existingRow, live_store: "false" }],
      },
      "STAGING_SHOPIFY_APP_REFUSED",
      { outcome: "exists" },
    ],
    [
      { register: [{ outcome: "denied", app_key: null }] },
      "STAGING_SHOPIFY_APP_REFUSED",
      { outcome: "denied" },
    ],
    [
      { register: [{ outcome: "surprise", app_key: null }] },
      "STAGING_SHOPIFY_APP_REFUSED",
      { outcome: "other" },
    ],
  ]) {
    const r = await run(overrides);
    assert.equal(r.error?.code, code, JSON.stringify(overrides));
    if (details) assert.deepEqual(r.error.details, details);
    assert.equal(r.commits, 0, code);
    assert.ok(!r.texts.includes(shopifyAppStatements.secretPut), code);
  }
  // The secret step refused: the registration committed, the secret did not.
  for (const [overrides, seal, code] of [
    [
      { put: [{ outcome: "stored", version: "2" }] },
      undefined,
      "STAGING_APP_SECRET_VERSION_MISMATCH",
    ],
    [{ put: [{ outcome: "invalid", version: null }] }, undefined, "STAGING_APP_SECRET_REFUSED"],
    [{ next: [{ version: "0" }] }, undefined, "STAGING_APP_SECRET_VERSION_UNREADABLE"],
    // An envelope for another version or another app never reaches the vault.
    [{}, async () => sealFor(registration.appKey)(2), "STAGING_SEAL_FAILED"],
    [{}, async (version) => sealFor("other-app")(version), "STAGING_SEAL_FAILED"],
  ]) {
    const r = await run(overrides, seal);
    assert.equal(r.error?.code, code);
    assert.equal(r.commits, 1, code);
    if (code === "STAGING_SEAL_FAILED")
      assert.ok(!r.texts.includes(shopifyAppStatements.secretPut));
  }
  // Closed inputs: no extra member (no secret or envelope travels through `input`).
  for (const change of [
    { appKey: "Live" },
    { clientId: "shpss_x" },
    { shopDigest: shop },
    { workspaceId: "ws owner" },
    { installUrl: "https://evil.test/x" },
    { secret },
  ])
    assert.equal(
      codeOf(() => shopifyAppRegistrationInput({ ...registration, ...change })),
      "STAGING_USAGE",
      JSON.stringify(change),
    );
  assert.equal(
    codeOf(() =>
      checkSealedEnvelope({ appKey: "morrow-live", environment: "development" }, "morrow-live", 1),
    ),
    "STAGING_SEAL_FAILED",
  );
});

test("cli: shopify-app-register takes the secret only from the hidden prompt or the owner's file and prints nothing secret", async () => {
  const argv = [
    "shopify-app-register",
    "--app-key",
    registration.appKey,
    "--client-id",
    registration.clientId,
    "--shop",
    shop,
    "--workspace",
    registration.workspaceId,
    "--install-url",
    installUrl,
  ];
  const world = async ({
    files = {},
    card = standingApproval(),
    tools = {},
    typed = secret,
    rules,
  } = {}) => {
    const planted = plantedHome({ "neon-owner-url": ownerUrl, "vault-kek-v1": kek, ...files });
    const fake = fakeTools(tools);
    const prompts = [];
    const { ctx, out, err } = await fakeContext({
      home: planted.home,
      tools: fake.tools,
      card,
      now: Date.parse("2026-10-24T12:00:00Z"),
      overrides: {
        readSecret: async () => {
          prompts.push("prompt");
          return typed;
        },
      },
    });
    const db = fakeDatabase({ rules: rules ?? appRules() });
    ctx.database = db.connector;
    const run = async (args = argv) => {
      const code = await main(args, ctx);
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    return { ctx, db, prompts, planted, run };
  };
  const clean = (text) => {
    assert.ok(!text.includes(secret), "secret");
    assert.ok(!text.includes(shop) && !text.includes("owner-live-store"), "shop");
    assert.ok(!text.includes(shopDigest), "shop digest");
    assert.ok(!text.includes("admin.shopify.com"), "install link");
    assert.ok(!text.includes(kek), "kek");
  };
  // From the prompt.
  const ok = await world();
  try {
    const result = await ok.run();
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(result.out), {
      command: "shopify-app-register",
      appKey: "morrow-live",
      registration: "registered",
      organizationId: "org_owner",
      workspaceId: "ws_owner",
      secretVersion: "1",
      kekVersion: 1,
      secretSource: "prompt",
      secretFileRemoved: null,
      kekFingerprint: kekFingerprint(kek),
    });
    clean(result.out + result.err);
    assert.deepEqual(ok.prompts, ["prompt"]);
    assert.ok(!sent(ok.db).includes(secret) && !sent(ok.db).includes(shop));
  } finally {
    ok.planted.cleanup();
  }
  // No way to pass the secret on the command line: any other flag, a flag twice, a missing
  // value or a positional argument is a usage error before anything is read.
  for (const bad of [
    [...argv, "--secret", secret],
    [...argv, "--client-secret", secret],
    [...argv, secret],
    [...argv, "--secret-file", "--secret-file"],
    [...argv, "--app-key", "morrow-live"],
    argv.slice(0, -1),
    argv.filter((a, i) => i !== 5 && i !== 6),
  ]) {
    const w = await world();
    try {
      const result = await w.run(bad);
      assert.equal(result.code, 2, bad.join(" "));
      assert.equal(JSON.parse(result.err).code, "STAGING_USAGE");
      clean(result.out + result.err);
      assert.deepEqual(w.prompts, []);
      assert.deepEqual(w.db.statements, []);
    } finally {
      w.planted.cleanup();
    }
  }
  // Before the prompt: the approval, the values and reviewed main.
  for (const [options, args, code] of [
    [{ card: standingApproval({ status: "withdrawn" }) }, argv, "STAGING_CARD_INACTIVE"],
    [{ tools: { git: { head: fakeSha("branch") } } }, argv, "STAGING_NOT_MAIN"],
    [{}, argv.map((a) => (a === shop ? "owner-live-store.example.com" : a)), "STAGING_USAGE"],
  ]) {
    const w = await world(options);
    try {
      const result = await w.run(args);
      assert.equal(result.code, 1, code);
      assert.equal(JSON.parse(result.err).code, code);
      clean(result.out + result.err);
      assert.deepEqual(w.prompts, [], code);
      assert.deepEqual(w.db.statements, [], code);
    } finally {
      w.planted.cleanup();
    }
  }
  // A secret with a control character (a typed Backspace) is refused before the database.
  const typo = await world({ typed: secret.slice(0, 10) + "\u007f" + secret.slice(10) });
  try {
    const result = await typo.run();
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.err).code, "STAGING_SECRET_INVALID");
    assert.deepEqual(typo.db.statements, []);
  } finally {
    typo.planted.cleanup();
  }
  // From the owner's 0600 file: read once, never prompted, removed once the vault stored it.
  const file = await world({ files: { "shopify-app-secret": secret } });
  try {
    const result = await file.run([...argv, "--secret-file"]);
    assert.equal(result.code, 0, result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.secretSource, "file");
    assert.equal(report.secretFileRemoved, true);
    clean(result.out + result.err);
    assert.deepEqual(file.prompts, []);
    assert.ok(!existsSync(join(file.planted.directory, "shopify-app-secret")));
  } finally {
    file.planted.cleanup();
  }
  // A refused registration keeps the file; a group- or world-readable file is refused.
  const kept = await world({
    files: { "shopify-app-secret": secret },
    rules: appRules({ register: [{ outcome: "live_store_taken", app_key: null }] }),
  });
  try {
    const result = await kept.run([...argv, "--secret-file"]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.err).code, "STAGING_SHOPIFY_APP_REFUSED");
    assert.ok(existsSync(join(kept.planted.directory, "shopify-app-secret")));
    clean(result.out + result.err);
  } finally {
    kept.planted.cleanup();
  }
  const planted = plantedHome(
    { "neon-owner-url": ownerUrl, "vault-kek-v1": kek, "shopify-app-secret": secret },
    { modes: { "shopify-app-secret": 0o644 } },
  );
  try {
    const { ctx, err } = await fakeContext({
      home: planted.home,
      tools: fakeTools().tools,
      card: standingApproval(),
    });
    const db = fakeDatabase({ rules: appRules() });
    ctx.database = db.connector;
    assert.equal(await main([...argv, "--secret-file"], ctx), 1);
    assert.match(JSON.parse(err.at(-1)).code, /^STAGING_FILE_/);
    assert.deepEqual(db.statements, []);
    clean(err.join("\n"));
  } finally {
    planted.cleanup();
  }
});

test("cli: the real context's prompt refuses anything that is not a terminal", async () => {
  if (process.stdin.isTTY === true && process.stderr.isTTY === true) return;
  const ctx = defaultContext();
  await assert.rejects(
    ctx.readSecret(),
    (error) => error.code === "STAGING_SECRET_PROMPT_UNAVAILABLE",
  );
  // The npm script runs the command without tsx's loader, like the other staging commands.
  const pkg = JSON.parse(read("package.json"));
  assert.equal(
    pkg.scripts["staging:shopify-app-register"],
    "node scripts/staging.mjs shopify-app-register",
  );
});
