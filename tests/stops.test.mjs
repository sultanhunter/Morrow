// M2 PR-1 stops (ADR-0005; ADR-0022 items 2 and 15; mvp-architecture §10): "Stop AI work"
// on the existing kill-switch path, the system uninstall stop, StopRecord@1 and the
// TypeScript twin of morrow_work.stop_active. lab:spine-foundation T4 maps real
// stop_records rows and compares stopBlocks with stop_active in PostgreSQL 17.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { KillSwitchBoundaryError } from "../packages/policy/src/kill-switch.ts";
import {
  StopBoundaryError,
  planStopAiWork,
  stopAiWorkRecord,
  stopBlocks,
  stopReasonCodes,
  stopRecordFromRow,
  uninstallConnectionStop,
} from "../packages/work/src/stops.ts";
import { spineStatements } from "../packages/work/src/spine-sql.ts";
import { workStatements } from "../packages/work/src/sql.ts";

const tenant = { organizationId: "org_a", workspaceId: "workspace_a" };
const actor = {
  kind: "human",
  principalId: "human_owner",
  ...tenant,
  membershipId: "membership_owner",
  installationId: null,
  mandateId: null,
};
const record = (kind, id, change = {}) => ({
  kind,
  id,
  ...tenant,
  storeId: null,
  connectionId: null,
  revision: null,
  digest: null,
  ...change,
});
const facts = (change = {}) => ({
  ...tenant,
  records: [
    record("installation", "installation_listings", {
      storeId: "store_a",
      connectionId: "connection_a",
    }),
    record("installation", "installation_storeless"),
    record("installation", "installation_ungranted", { storeId: "store_b" }),
    record("installation", "installation_foreign", {
      organizationId: "org_b",
      workspaceId: "workspace_b",
      storeId: "store_a",
    }),
  ],
  grants: [
    { storeIds: ["store_a"], connectionIds: ["connection_a"] },
    { storeIds: [], connectionIds: [] },
  ],
  sourceProposal: null,
  ownership: {
    ownerPrincipalId: "human_owner",
    ownerMembershipId: "membership_owner",
    activeHumanMembershipCount: 1,
    lastMembershipChangeAt: null,
  },
  ...change,
});
const stopAiWork = (installationId, reason = "The drafts look wrong; stop until I check.") => ({
  capabilityId: "agents.installation.disable",
  input: { installationId, control: { reason, sourceProposalRef: null } },
});

test("Stop AI work: the kill-switch target check, then one installation stop by a person", () => {
  const result = planStopAiWork(actor, stopAiWork("installation_listings"), facts());
  assert.equal(result.allowed, true);
  assert.deepEqual(result.plan, {
    scope: "installation",
    ...tenant,
    storeId: "store_a",
    targetId: "installation_listings",
    setBy: { kind: "human", principalId: "human_owner", membershipId: "membership_owner" },
    reasonCode: "human_stop_ai_work",
    reason: "The drafts look wrong; stop until I check.",
  });
  assert.deepEqual(result.targets, [
    {
      ...tenant,
      storeId: "store_a",
      connectionId: "connection_a",
      kind: "installation",
      id: "installation_listings",
    },
  ]);
  // Its KillSwitchRecord validates and carries the human actor and the control.
  const killSwitch = stopAiWorkRecord(actor, stopAiWork("installation_listings"), result, {
    id: "kill_1",
    createdAt: "2026-10-20T10:00:00.000Z",
    commandId: "command_1",
    requestDigest: "a".repeat(64),
    priorStateObserved: "active",
  });
  assert.ok(validateCurrentDefinition("KillSwitchRecord", killSwitch));
  assert.equal(killSwitch.capabilityId, "agents.installation.disable");
  assert.equal(killSwitch.storeId, "store_a");
  assert.throws(
    () =>
      stopAiWorkRecord(actor, stopAiWork("installation_listings"), result, {
        id: "kill_1",
        createdAt: "yesterday",
        commandId: "command_1",
        requestDigest: "a".repeat(64),
        priorStateObserved: "active",
      }),
    StopBoundaryError,
  );
});

test("Stop AI work: unknown, foreign, ungranted and storeless targets get one denial", () => {
  for (const id of [
    "installation_absent",
    "installation_foreign",
    "installation_ungranted",
    "installation_storeless",
  ]) {
    const result = planStopAiWork(actor, stopAiWork(id), facts());
    assert.deepEqual(result, {
      allowed: false,
      code: "TARGET_NOT_FOUND",
      category: "denied",
      retry: "never",
      safeMessage: "The requested target is not available.",
    });
  }
});

test("Stop AI work: only a human member of the tenant, only for this kill switch", () => {
  for (const who of [
    { ...actor, kind: "agent" },
    { ...actor, installationId: "installation_listings" },
    { ...actor, organizationId: "org_b" },
    { ...actor, workspaceId: "workspace_b" },
    { ...actor, membershipId: null },
  ])
    assert.throws(
      () => planStopAiWork(who, stopAiWork("installation_listings"), facts()),
      (e) => e instanceof StopBoundaryError && e.code === "STOP_INPUT_INVALID",
    );
  assert.throws(
    () =>
      planStopAiWork(
        actor,
        {
          capabilityId: "governance.connection.disconnect",
          input: {
            connectionId: "connection_a",
            control: { reason: "x", sourceProposalRef: null },
          },
        },
        facts(),
      ),
    StopBoundaryError,
  );
  // The kill-switch library's own boundary still applies (a blank reason).
  assert.throws(
    () => planStopAiWork(actor, stopAiWork("installation_listings", " "), facts()),
    KillSwitchBoundaryError,
  );
});

test("the uninstall stop is a system connection stop with a fixed reason", () => {
  assert.deepEqual(
    uninstallConnectionStop({ ...tenant, storeId: "store_a", connectionId: "connection_a" }),
    {
      scope: "connection",
      ...tenant,
      storeId: "store_a",
      targetId: "connection_a",
      setBy: { kind: "system" },
      reasonCode: "shopify_app_uninstalled",
      reason: "The Shopify app was uninstalled from the store.",
    },
  );
  for (const change of [{ storeId: "" }, { connectionId: "a b" }, { organizationId: null }])
    assert.throws(
      () =>
        uninstallConnectionStop({
          ...tenant,
          storeId: "store_a",
          connectionId: "connection_a",
          ...change,
        }),
      StopBoundaryError,
    );
  // M2 PR-3: the same system stop when app/scopes_update reports changed scopes; no other
  // reason code is a system stop.
  assert.deepEqual(
    uninstallConnectionStop(
      { ...tenant, storeId: "store_a", connectionId: "connection_a" },
      "shopify_scopes_changed",
    ).reason,
    "The Shopify app's access scopes changed.",
  );
  assert.throws(
    () =>
      uninstallConnectionStop(
        { ...tenant, storeId: "store_a", connectionId: "connection_a" },
        "human_disconnect",
      ),
    StopBoundaryError,
  );
  // Every reason code fits the 0020 CHECK; the platform ones are the definers' literals.
  const migration = readFileSync("migrations/0020.spine-foundation.sql", "utf8");
  for (const code of Object.values(stopReasonCodes)) assert.match(code, /^[a-z][a-z0-9_]{2,63}$/);
  assert.ok(migration.includes("'operator_platform_stop'"));
  assert.ok(migration.includes("'operator_platform_lift'"));
});

const row = (change = {}) => ({
  id: "record_1",
  stop_control_id: "stop_1",
  action: "set",
  scope: "connection",
  organization_id: "org_a",
  workspace_id: "workspace_a",
  store_id: "store_a",
  target_id: "connection_a",
  actor_kind: "system",
  operator_id: null,
  reason_code: "shopify_app_uninstalled",
  reason: "The Shopify app was uninstalled from the store.",
  recorded_at: "2026-10-20T10:00:00.000Z",
  ...change,
});
const platform = {
  scope: "platform",
  organization_id: null,
  workspace_id: null,
  store_id: null,
  target_id: null,
  actor_kind: "operator",
  operator_id: "owner_script",
  reason_code: "operator_platform_stop",
};

test("StopRecord@1: system and operator records map; anything the table refuses is invalid", () => {
  const system = stopRecordFromRow(row());
  assert.deepEqual(system.actor, { kind: "system", operatorId: null });
  assert.equal(system.schemaVersion, 1);
  assert.ok(validateCurrentDefinition("StopRecord", system));
  assert.equal(stopRecordFromRow(row(platform)).actor.operatorId, "owner_script");
  assert.equal(
    stopRecordFromRow(row({ ...platform, action: "lift", reason_code: "operator_platform_lift" }))
      .action,
    "lift",
  );
  assert.ok(
    stopRecordFromRow(row({ action: "lift", actor_kind: "operator", operator_id: "owner_script" })),
  );
  for (const change of [
    { ...platform, actor_kind: "system", operator_id: null },
    { action: "lift" },
    { actor_kind: "human" },
    { actor_kind: "system", operator_id: "owner_script" },
    { actor_kind: "operator", operator_id: null },
    { scope: "platform" },
    { ...platform, store_id: "store_a" },
    { target_id: null },
    { reason_code: "X" },
    { reason: " " },
    { recorded_at: "2026-10-20 10:00:00" },
    { extra: "1" },
  ])
    assert.throws(
      () => stopRecordFromRow(row(change)),
      (e) => e instanceof StopBoundaryError && e.code === "STOP_RECORD_INVALID",
    );
  // The api reads them with fixed statements merged into workStatements.
  for (const [name, text] of Object.entries(spineStatements)) {
    assert.equal(workStatements[name], text);
    assert.match(text, /^SELECT /);
  }
  assert.match(spineStatements.stopRecordsOfControl, /WHERE r\.stop_control_id=\$1::text/);
});

test("stopBlocks mirrors stop_active: platform, connection and installation scopes", () => {
  const work = (kind, change = {}) => ({
    ...tenant,
    kind,
    connectionId: "connection_a",
    installationId: kind === "read" ? null : "installation_a",
    ...change,
  });
  const stop = (scope, targetId, change = {}) => ({ scope, ...tenant, targetId, ...change });
  const platformStop = {
    scope: "platform",
    organizationId: null,
    workspaceId: null,
    targetId: null,
  };
  // [stop, read, run, operation]
  const table = [
    [platformStop, false, true, true],
    [stop("connection", "connection_a"), true, true, true],
    [stop("connection", "connection_b"), false, false, false],
    [stop("installation", "installation_a"), false, true, true],
    [stop("installation", "installation_b"), false, false, false],
    [stop("connection", "connection_a", { workspaceId: "workspace_b" }), false, false, false],
    [stop("installation", "installation_a", { organizationId: "org_b" }), false, false, false],
  ];
  for (const [s, read, run, operation] of table)
    assert.deepEqual(
      ["read", "run", "operation"].map((kind) => stopBlocks([s], work(kind))),
      [read, run, operation],
      JSON.stringify(s),
    );
  assert.equal(stopBlocks([], work("run")), false);
  assert.equal(
    stopBlocks([stop("connection", "connection_b"), platformStop], work("operation")),
    true,
  );
});
