import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  root,
  read,
  validateCatalogue,
  validateTasks,
  inspectAuthority,
  planInventory,
  TASK_STATUSES,
  EXECUTORS,
} from "../scripts/foundation.mjs";
import { readEffectiveBodies } from "../scripts/contract-sources.mjs";

const catalogue = read("docs/contracts/capabilities.json");
const dependencies = read("docs/decisions/dependencies.json");
const tasks = read("docs/progress/tasks.json");
const types = read("docs/contracts/schema-types.json");
const bodies = readEffectiveBodies(catalogue.capabilities.map((c) => c.id));
const validate = (c, b = bodies) => validateCatalogue(c, dependencies, tasks, types, b);
const find = (c, id) => c.capabilities.find((x) => x.id === id);
test("catalogue satisfies domain and traceability contracts", () =>
  assert.deepEqual(validate(catalogue), []));
for (const [name, mutate, expected] of [
  [
    "untracked provider",
    (c) => (c.capabilities[0].provider_dependency = "unknown"),
    /untracked provider/,
  ],
  [
    "duplicate operation",
    (c) => c.capabilities.push(structuredClone(c.capabilities[0])),
    /duplicate capability/,
  ],
  [
    "missing launch domain",
    (c) => (c.capabilities = c.capabilities.filter((x) => x.domain !== "Finance")),
    /missing launch domain/,
  ],
  [
    "premature capability activation",
    (c) => (c.capabilities[0].activation = "active"),
    /premature activation/,
  ],
  [
    "missing review gate",
    (c) => (c.capabilities.find((x) => x.effect === "spend").review_required = false),
    /R6 agent_after_approval without review gate/,
  ],
  [
    "connector domain exposure",
    (c) => (c.capabilities[0].hosts = ["shopify_connector"]),
    /standalone surface/,
  ],
  ["unbounded fields", (c) => (c.capabilities[0].field_scope = ["*"]), /unrestricted fields/],
  [
    "invented implementation task",
    (c) => (c.capabilities[0].implementation_tasks = ["P99.T01"]),
    /unknown implementation/,
  ],
  [
    "unknown nested type",
    (c) => (Object.values(c.capabilities[0].input.fields)[0].type = "Unknown"),
    /invalid input/,
  ],
])
  test(`rejects ${name}`, () => {
    const c = structuredClone(catalogue);
    mutate(c);
    assert.match(validate(c).join("\n"), expected);
  });
test("task records use the plan status vocabulary", () => {
  assert.deepEqual(validateTasks(tasks), []);
  assert.ok(TASK_STATUSES.includes("Self-reviewed"));
});
for (const [name, mutate, expected] of [
  ["unknown status", (t) => (t.tasks[0].status = "Done"), /P01\.T01: unknown status "Done"/],
  [
    "missing status",
    (t) => delete t.tasks[0].status,
    /exactly id and status[\s\S]*unknown status undefined/,
  ],
  [
    "extra task field",
    (t) => (t.tasks[0].reviewTier = "self"),
    /P01\.T01: task record must have exactly id and status/,
  ],
  [
    "duplicate task",
    (t) => t.tasks.push(structuredClone(t.tasks[0])),
    /duplicate task ID: P01\.T01/,
  ],
  ["malformed task ID", (t) => (t.tasks[0].id = "P1.T1"), /invalid or duplicate task ID: P1\.T1/],
  [
    "duplicate acceptance ID",
    (t) => t.acceptance_ids.push("P01.A01"),
    /duplicate acceptance ID: P01\.A01/,
  ],
])
  test(`task validation rejects ${name}`, () => {
    const t = structuredClone(tasks);
    mutate(t);
    assert.match(validateTasks(t).join("\n"), expected);
  });
test("plan definitions equal tasks.json in order", () => {
  const inventory = planInventory(readFileSync(`${root}/docs/plan/build-plan.md`, "utf8"));
  assert.deepEqual(
    inventory.tasks,
    tasks.tasks.map((t) => t.id),
  );
  assert.deepEqual(inventory.cases, tasks.acceptance_ids);
  const sample = planInventory(
    "Plan status: P02.T04 first.\n1. **P01.T01 Catalogue.** **P01.A01:** case.\n2. **P01.T02 State.**\n7. **P01.T02a child** is not a parent.\n",
  );
  assert.deepEqual(sample.tasks, ["P01.T01", "P01.T02"]);
  assert.deepEqual(sample.cases, ["P01.A01"]);
  assert.deepEqual(sample.mentionedTasks, ["P02.T04", "P01.T01", "P01.T02"]);
});
for (const fixture of read("docs/acceptance/P01.A01-fixtures.json"))
  test(fixture.id, () => {
    const c = catalogue.capabilities.find((c) => c.id === fixture.capability);
    const actual = inspectAuthority(c, fixture.request);
    assert.equal(actual.allowed, fixture.expected.allowed);
    assert.deepEqual(actual.reasons.sort(), fixture.expected.reasons.sort());
  });

// P01.T02a PR-A (AC06): executor classes and kill switches (ADR-0005).
const killSwitches = [
  "ads.campaign.pause",
  "agents.installation.disable",
  "governance.membership.revoke",
  "governance.connection.disconnect",
  "agents.release.revoke",
];
test("AC06: every capability carries an executor and a kill-switch flag; the kill switches are the ADR-0005 five", () => {
  assert.equal(catalogue.schema_version, 2);
  for (const c of catalogue.capabilities) {
    assert.ok(EXECUTORS.includes(c.executor), c.id);
    assert.equal(typeof c.kill_switch, "boolean", c.id);
  }
  assert.deepEqual(
    new Set(catalogue.capabilities.filter((c) => c.kill_switch).map((c) => c.id)),
    new Set(killSwitches),
  );
  for (const id of killSwitches) {
    const c = find(catalogue, id);
    assert.equal(c.executor, "human_only", id);
    assert.equal(c.review_required, false, id);
  }
});
test("AC06: reversals keep review; activation is agent_after_approval and the rest human_only", () => {
  for (const [id, executor] of [
    ["ads.campaign.activate", "agent_after_approval"],
    ["agents.installation.activate", "human_only"],
    ["governance.connection.connect", "human_only"],
    ["governance.membership.invite", "human_only"],
    ["governance.grants.revise", "human_only"],
    ["agents.release.publish", "human_only"],
  ]) {
    const c = find(catalogue, id);
    assert.equal(c.review_required, true, id);
    assert.equal(c.kill_switch, false, id);
    assert.equal(c.executor, executor, id);
  }
  // ADR-0011 Q7: grants carrying delegate and mandate activation are human_only;
  // dispatching and configuring bounded work stays agent_direct_write.
  assert.equal(find(catalogue, "workspace.routine.activate").executor, "human_only");
  assert.equal(find(catalogue, "workspace.task.delegate").executor, "agent_direct_write");
  assert.equal(find(catalogue, "workspace.routine.configure").executor, "agent_direct_write");
  for (const id of [
    "workspace.task.takeover",
    "workspace.knowledge.approve",
    "creative.image.approve",
    "governance.audit.export",
    "governance.privacy.export",
  ])
    assert.equal(find(catalogue, id).executor, "human_only", id);
});
for (const [name, mutate, expected] of [
  [
    "R1 unknown executor",
    (c) => (find(c, "catalog.products.read").executor = "agent"),
    /R1 invalid executor/,
  ],
  [
    "R1 non-boolean kill switch",
    (c) => (find(c, "catalog.products.read").kill_switch = "no"),
    /R1 kill_switch, irreversible and review_required must be booleans/,
  ],
  [
    "R2 read written by agents",
    (c) => (find(c, "catalog.products.read").executor = "agent_direct_write"),
    /R2 read/,
  ],
  [
    "R3 write as a read",
    (c) => (find(c, "workspace.task.create").executor = "agent_direct_read"),
    /R3 write/,
  ],
  [
    "R4 external write without approval executor",
    (c) => (find(c, "catalog.content.publish").executor = "agent_direct_write"),
    /R4 consequential/,
  ],
  [
    "R5 control as agent_direct_write",
    (c) => (find(c, "governance.membership.invite").executor = "agent_direct_write"),
    /R5 control must be human_only/,
  ],
  [
    "R6 agent_after_approval without review",
    (c) => (find(c, "ads.campaign.activate").review_required = false),
    /R6 agent_after_approval without review gate/,
  ],
  [
    "R7 reviewed kill switch",
    (c) => (find(c, "governance.membership.revoke").review_required = true),
    /R7 kill switch/,
  ],
  [
    "R7 agent-executed kill switch",
    (c) => (find(c, "ads.campaign.pause").executor = "agent_after_approval"),
    /R7 kill switch/,
  ],
  [
    "R7 kill switch on a spend",
    (c) =>
      Object.assign(find(c, "ads.campaign.activate"), {
        kill_switch: true,
        review_required: false,
        executor: "human_only",
      }),
    /R7 kill switch/,
  ],
  [
    "R8 unreviewed non-kill-switch external write",
    (c) =>
      Object.assign(find(c, "catalog.content.publish"), {
        review_required: false,
        executor: "human_only",
      }),
    /R8 consequential action without review gate must be a kill switch/,
  ],
  [
    "R8 kill switch flag removed",
    (c) => (find(c, "ads.campaign.pause").kill_switch = false),
    /R8 consequential/,
  ],
  [
    "R9 eligible human capability not human_only",
    (c) => (find(c, "workspace.knowledge.approve").executor = "agent_direct_write"),
    /R9 eligible human/,
  ],
  [
    "R11 catalogue field missing from the body",
    (c) => {
      const f = find(c, "ads.campaign.pause").input.fields;
      f.reason = { type: "string", required: true, nullable: false };
    },
    /R11 input fields differ/,
  ],
  [
    "R11 catalogue still describing the v1 body",
    (c) => {
      find(c, "governance.membership.revoke").input.fields = {
        membershipId: { type: "Id", required: true, nullable: false },
        expectedRevision: { type: "Revision", required: true, nullable: false },
      };
    },
    /R11 input fields differ/,
  ],
  [
    "R11 field type differing from the body ref",
    (c) => {
      find(c, "ads.campaign.pause").input.fields.control.type = "ProposalRef";
    },
    /R11 input.control type differs/,
  ],
])
  test(`AC06 rejects ${name}`, () => {
    const c = structuredClone(catalogue);
    mutate(c);
    assert.match(validate(c).join("\n"), expected);
  });
test("AC06 R11 compares the catalogue with the effective (v1.1) body, not the replaced v1 body", () => {
  const v1 = read("docs/contracts/schemas/v1/capabilities.schema.json");
  const stale = { ...bodies, "ads.campaign.pause.input": v1.$defs["ads.campaign.pause.input"] };
  assert.match(
    validate(catalogue, stale).join("\n"),
    /ads\.campaign\.pause: R11 input fields differ/,
  );
  const { ["agents.release.revoke.input"]: _, ...missing } = bodies;
  assert.match(
    validate(catalogue, missing).join("\n"),
    /agents\.release\.revoke: R11 input fields differ/,
  );
});
test("kill-switch walkthroughs require a recorded reason and a human executor", () => {
  for (const id of [
    "P01.A01.human_pauses_campaigns_without_approval.standalone",
    "P01.A01.human_revokes_member_without_approval.standalone",
  ]) {
    const fixture = read("docs/acceptance/P01.A01-fixtures.json").find((f) => f.id === id);
    const c = find(catalogue, fixture.capability);
    assert.deepEqual(inspectAuthority(c, fixture.request), { allowed: true, reasons: [] });
    for (const reason of [undefined, "", "   "]) {
      const request = structuredClone(fixture.request);
      request.conditions.killSwitchReason = reason;
      assert.deepEqual(inspectAuthority(c, request).reasons, ["KILL_SWITCH_REASON_REQUIRED"]);
    }
    const agent = structuredClone(fixture.request);
    agent.origin = structuredClone(agent.principal);
    agent.principal.kind = "agent";
    assert.deepEqual(inspectAuthority(c, agent).reasons, ["HUMAN_EXECUTOR_REQUIRED"]);
  }
});

// P01.T02a PR-B: irreversible capabilities (ADR-0011 Q4), the two review capabilities (Q5) and stops without entitlement (Q8).
const irreversible = [
  "lifecycle.campaign.send",
  "support.reply.send",
  "orders.refund.create",
  "orders.cancel",
  "orders.fulfillment.create",
  "governance.privacy.erase",
  "agents.installation.uninstall",
];
test("AC06 R10: the irreversible set is the ADR-0011 Q4 list and never a read", () => {
  for (const c of catalogue.capabilities) assert.equal(typeof c.irreversible, "boolean", c.id);
  assert.deepEqual(
    new Set(catalogue.capabilities.filter((c) => c.irreversible).map((c) => c.id)),
    new Set(irreversible),
  );
});
for (const [name, mutate, expected] of [
  [
    "R10 irreversible read",
    (c) => (find(c, "catalog.products.read").irreversible = true),
    /R10 an irreversible capability cannot be a read/,
  ],
  [
    "R1 non-boolean irreversible",
    (c) => (find(c, "orders.cancel").irreversible = "yes"),
    /R1 kill_switch, irreversible and review_required must be booleans/,
  ],
  [
    "R1 missing irreversible",
    (c) => delete find(c, "orders.cancel").irreversible,
    /R1 kill_switch, irreversible and review_required must be booleans/,
  ],
  [
    "R11 decide body described with the v1 DecisionRef",
    (c) => (find(c, "governance.approval.decide").input.fields.decision.type = "DecisionRef"),
    /R11 input\.decision type differs/,
  ],
])
  test(`AC06 rejects ${name}`, () => {
    const c = structuredClone(catalogue);
    mutate(c);
    assert.match(validate(c).join("\n"), expected);
  });
test("the review capabilities follow ADR-0011 Q5", () => {
  const revise = find(catalogue, "governance.review_policy.revise"),
    preview = find(catalogue, "governance.approval.preview"),
    decide = find(catalogue, "governance.approval.decide");
  assert.deepEqual(
    [
      revise.effect,
      revise.executor,
      revise.review_required,
      revise.kill_switch,
      revise.irreversible,
      revise.eligible_principal,
    ],
    [
      "control",
      "human_only",
      true,
      false,
      false,
      "human_or_bounded_installation_with_explicit_capability_grant",
    ],
  );
  assert.deepEqual(
    [
      preview.effect,
      preview.executor,
      preview.review_required,
      preview.kill_switch,
      preview.irreversible,
      preview.eligible_principal,
    ],
    [
      "read",
      "human_only",
      false,
      false,
      false,
      "eligible_human_reviewer_with_explicit_decision_grant",
    ],
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(revise.input.fields).map(([k, v]) => [k, v.type])),
    { proposalRef: "ProposalRef", approvalRef: "ApprovalRef" },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(revise.output.fields).map(([k, v]) => [k, v.type])),
    { policyRef: "PolicyRef" },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(preview.input.fields).map(([k, v]) => [k, v.type])),
    { proposalRef: "ProposalRef", selectedTargetIndexes: "TargetSelection" },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(preview.output.fields).map(([k, v]) => [k, v.type])),
    { proposal: "Proposal" },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(decide.input.fields).map(([k, v]) => [k, v.type])),
    { proposalRef: "ProposalRef", decision: "ReviewDecisionInput", expectedRevision: "Revision" },
  );
  assert.deepEqual(
    [revise.implementation_tasks, revise.acceptance_cases],
    [["P11.T01"], ["P01.A01", "P11.A01"]],
  );
  assert.deepEqual(
    [preview.implementation_tasks, preview.acceptance_cases],
    [
      ["P11.T01", "P14.T03"],
      ["P01.A01", "P11.A01", "P14.A03"],
    ],
  );
  for (const c of [revise, preview]) {
    assert.deepEqual(
      [c.domain, c.provider_dependency, c.hosts, c.retention_class, c.journey, c.activation],
      [
        "Governance",
        "D01",
        ["standalone"],
        "R02",
        "J13",
        "blocked_until_contract_and_provider_qualified",
      ],
    );
    for (const key of ["resource_scope", "source_authority", "failure_behavior", "layout"])
      assert.equal(c[key], decide[key], key);
  }
});
test("kill-switch walkthroughs are not blocked by entitlement (ADR-0011 Q8)", () => {
  const fixture = read("docs/acceptance/P01.A01-fixtures.json").find(
    (f) => f.id === "P01.A01.human_pauses_campaigns_without_approval.standalone",
  );
  const request = structuredClone(fixture.request);
  request.conditions.entitled = false;
  assert.deepEqual(inspectAuthority(find(catalogue, "ads.campaign.pause"), request), {
    allowed: true,
    reasons: [],
  });
  request.conditions.providerPermission = false;
  assert.deepEqual(inspectAuthority(find(catalogue, "ads.campaign.pause"), request).reasons, [
    "PROVIDER_PERMISSION_DENIED",
  ]);
  const billed = read("docs/acceptance/P01.A01-fixtures.json").find(
    (f) => f.id === "P01.A01.missing_entitlement_denied.standalone",
  );
  assert.deepEqual(inspectAuthority(find(catalogue, billed.capability), billed.request).reasons, [
    "ENTITLEMENT_DENIED",
  ]);
});
