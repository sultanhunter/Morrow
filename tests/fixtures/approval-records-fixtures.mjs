// Owner-seeded synthetic fixtures for the P06.T01b PostgreSQL laboratory (packet
// "Acceptance cases": Fixtures). Organization O: A is the organization_signups
// owner with grant template v1 plus task and erase grants; B, D, R are reviewers;
// C is a beneficiary who holds the same; X is a member with no grants. Y is a
// member of O′ only. Each acceptance case gets its own workspace of O (so policy
// revisions never leak between cases), or its own solo organization (O1 and its
// variants, owner S). No provider, credential or merchant data.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateDefinition } from "../../packages/contracts/src/validation.ts";
import {
  WorkOutcomeUnknown,
  WorkSqlUnavailable,
  withWorkTransaction,
} from "../../packages/work/src/connection.ts";
import { enterWorkContext } from "../../packages/work/src/context.ts";
import { workStatements } from "../../packages/work/src/sql.ts";
import { literal, sleep } from "../tenant-conformance/harness.mjs";

export const sha = (value) => createHash("sha256").update(value).digest("hex");
export const defaults = JSON.parse(
  readFileSync("docs/contracts/review-policy-defaults.json", "utf8"),
);

// The catalogue rows added after 0018 was pinned: P01.T02c's collaboration
// capabilities (contracts v1.1, ADR-0016; PR #19). 0018's review_capabilities
// copies the catalogue as reviewed and stays byte-unchanged, so it lacks them.
// None is review-required, so no proposal can name one: proposals reference
// review_capabilities and proposal_bind refuses a capability without a
// review-required row. A forward migration adds them when a consumer needs them.
export const capabilitiesAfter0018 = Object.freeze([
  "workspace.conversation.create",
  "workspace.conversation.post",
  "workspace.project.create",
  "workspace.project.revise",
  "workspace.project.pin",
  "workspace.inbox.read",
  "workspace.inbox.mark",
  "governance.access.request",
  // M5 PR-1 (ADR-0022 items 2 and 3): neither is review-required.
  "governance.billing.manage",
  "governance.model_default.revise",
  // PR 10 (ADR-0024 item 4, ADR-0030 item 10(c)): neither is review-required. Agents may
  // only propose revoke; its row comes with the forward migration of its definer.
  "workspace.routine.revoke",
  "governance.mail_identity.revise",
  // PR 18 (ADR-0033 items 4 and 5): both human_only, neither review-required.
  "workspace.goal.revise",
  "workspace.goal.measure.record",
]);
/** The catalogue as 0018 copies it, in catalogue order. */
export const catalogueAt0018 = (catalogue) =>
  catalogue.capabilities.filter((c) => !capabilitiesAfter0018.includes(c.id));

// Grant template v1 (migration 0013, owner_bootstrap_grants_v1): governance only.
export const templateV1 = Object.freeze({
  "governance.membership.invite": [
    ["execute", "approve"],
    ["identity", "grantProposal"],
  ],
  "governance.membership.revoke": [
    ["execute", "approve"],
    ["membershipId", "expectedRevision", "control"],
  ],
  "governance.grants.revise": [
    ["execute", "approve"],
    ["proposalRef", "approvalRef"],
  ],
  "governance.connection.connect": [
    ["administer", "approve"],
    ["providerId", "installationProof", "scope"],
  ],
  "governance.connection.disconnect": [
    ["execute", "approve"],
    ["connectionId", "expectedRevision", "control"],
  ],
  "governance.approval.decide": [["approve"], ["proposalRef", "decision", "expectedRevision"]],
  "governance.approval.preview": [["view"], ["proposalRef", "selectedTargetIndexes"]],
  "governance.usage.read": [["view"], ["scope", "period"]],
});
const taskFields = [
  "goalId",
  "parentTaskId",
  "status",
  "objective",
  "scope",
  "initiatingPrincipal",
  "owner",
  "dependencyIds",
  "acceptedArtifactRefs",
  "completionEvidenceRefs",
  "leaseGeneration",
  "activeRunId",
  "allowedResources",
];
const eraseFields = ["subjectRef", "verifiedRequest", "approvalRef"];
export const ownerGrants = Object.freeze({
  ...templateV1,
  "workspace.task.create": [["view", "execute"], taskFields],
  "governance.privacy.erase": [["execute", "approve"], eraseFields],
});
export const reviewerGrants = Object.freeze({
  "governance.approval.decide": templateV1["governance.approval.decide"],
  "governance.approval.preview": templateV1["governance.approval.preview"],
  "governance.grants.revise": [["approve"], ["proposalRef", "approvalRef"]],
  "governance.privacy.erase": [["approve"], eraseFields],
  "workspace.task.create": [["view"], taskFields],
});
// A reviewer who cannot preview (AC15): the decide verbs without preview view.
export const blindReviewerGrants = Object.freeze({
  "governance.approval.decide": templateV1["governance.approval.decide"],
  "governance.grants.revise": [["approve"], ["proposalRef", "approvalRef"]],
});

export const workspaceResource = (org, ws) => ({
  organizationId: org,
  workspaceId: ws,
  storeId: null,
  connectionId: null,
  kind: "workspace",
  id: ws,
});
export function actorRef(p) {
  return {
    kind: "human",
    principalId: p.principal,
    organizationId: p.org,
    workspaceId: p.workspace,
    membershipId: p.membership,
    installationId: null,
    mandateId: null,
  };
}
export function grant(p, capabilityId, verbs, fields, overrides = {}) {
  const value = {
    id: "g_" + p.key + "_" + p.workspace + "_" + capabilityId.replaceAll(".", "_"),
    principal: actorRef(p),
    capabilityId,
    verbs,
    scope: {
      organizationId: p.org,
      workspaceId: p.workspace,
      storeIds: [],
      accountIds: [],
      resources: [workspaceResource(p.org, p.workspace)],
      fields,
    },
    issuedBy: actorRef(p),
    validFrom: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
    ...overrides,
  };
  if (!validateDefinition("core", "Grant", value)) throw Error("FIXTURE_GRANT_INVALID");
  return value;
}
export const grantSql = (p, g) =>
  `INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload) VALUES(${literal(g.id)},${literal(p.org)},${literal(p.workspace)},${literal(p.membership)},${literal(p.principal)},${literal(JSON.stringify(g))}::jsonb);`;

const profile = {
  id: "profile_approvals",
  environment: "environment_" + "A".repeat(26),
  application: "app_" + "B".repeat(26),
  client: "client_" + "C".repeat(26),
};

/**
 * The fixture world. Returns a builder whose `principal(name, ws)` gives the
 * per-workspace view {key, principal, membership, org, workspace, secret, digest}.
 */
export function seedApprovalFixtures(db) {
  const statements = [
    `INSERT INTO morrow_identity.identity_verification_profiles VALUES(${literal(profile.id)},'workos',${literal(profile.environment)},${literal(profile.application)},${literal(profile.client)},${literal("https://api.workos.com/user_management/" + profile.client)},1,${literal("d".repeat(64))},1,'active');`,
  ];
  const people = new Map();
  function person(name, org) {
    if (people.has(name)) return people.get(name);
    const secret = createHash("sha256").update(randomUUID()).digest().toString("base64url");
    const p = {
      name,
      principal: "person_" + name,
      membership: "membership_" + name,
      org,
      secret,
      digest: sha(secret),
    };
    people.set(name, p);
    statements.push(
      `INSERT INTO morrow_identity.principals VALUES(${literal(p.principal)},'human',true);`,
      `INSERT INTO morrow_identity.memberships VALUES(${literal(p.membership)},${literal(org)},${literal(p.principal)},true);`,
      `INSERT INTO morrow_identity.sessions VALUES(${literal("session_" + name)},${literal(p.principal)},${literal(org)},${literal(p.digest)},'workos',${literal("provider_session_" + name)},clock_timestamp()+interval '1 day',NULL);`,
    );
    return p;
  }
  const workspaces = new Map();
  const view = (p, ws) => ({ ...p, key: p.name, workspace: ws });
  function join(p, ws, grants) {
    statements.push(
      `INSERT INTO morrow_identity.workspace_memberships VALUES(${literal(p.org)},${literal(ws)},${literal(p.membership)},true);`,
    );
    const v = view(p, ws);
    for (const [capability, [verbs, fields]] of Object.entries(grants))
      statements.push(grantSql(v, grant(v, capability, verbs, fields)));
  }
  function organization(org, name) {
    statements.push(
      `INSERT INTO morrow_identity.organizations VALUES(${literal(org)},${literal("Synthetic " + name)},true,1);`,
    );
  }
  function workspace(org, ws) {
    statements.push(
      `INSERT INTO morrow_identity.workspaces VALUES(${literal(ws)},${literal(org)},'Synthetic',true);`,
    );
    workspaces.set(ws, org);
  }
  function signup(p, ws) {
    statements.push(
      `INSERT INTO morrow_identity.organization_signups(principal_id,command_id,request_digest,profile_id,organization_id,workspace_id,membership_id,grant_template,recorded_at) VALUES(${literal(p.principal)},${literal("signup_" + p.name)},${literal(sha("signup" + p.name))},${literal(profile.id)},${literal(p.org)},${literal(ws)},${literal(p.membership)},'owner-bootstrap-v1',clock_timestamp()-interval '30 days');`,
    );
  }
  // Organization O and O′.
  const O = "org_ap",
    P = "org_ap_p";
  organization(O, "O");
  organization(P, "O prime");
  const caseWorkspaces = [
    "W",
    "W2",
    "W3",
    "W4",
    "W5",
    "W8",
    "W9",
    "W9b",
    "W9c",
    "W10",
    "W11",
    "W12",
    "W13",
    "W14",
    "W15",
    "W17",
    "W18",
    "W19",
    "W21",
    "W23",
    "W24",
    "W25",
  ].map((k) => ["ws_ap_" + k.toLowerCase(), k]);
  for (const [ws] of caseWorkspaces) workspace(O, ws);
  workspace(P, "ws_ap_p");
  const A = person("a", O),
    B = person("b", O),
    C = person("c", O),
    D = person("d", O),
    R = person("r", O),
    X = person("x", O),
    V = person("v", O),
    Y = person("y", P);
  for (const [ws] of caseWorkspaces) {
    join(A, ws, ownerGrants);
    for (const p of [B, C, D, R]) join(p, ws, reviewerGrants);
    join(X, ws, {});
    join(V, ws, blindReviewerGrants);
  }
  join(Y, "ws_ap_p", ownerGrants);
  signup(A, "ws_ap_w");
  db.admin("BEGIN;\n" + statements.join("\n") + "\nCOMMIT;");
  statements.length = 0;
  // Goals and tasks (P06.T01a records): T_A initiated by A, T_B by B, per workspace.
  const tasks = {};
  const work = [];
  for (const [ws] of caseWorkspaces) {
    const goal = "goal_" + ws;
    work.push(
      `INSERT INTO morrow_work.workspace_streams VALUES(${literal(O)},${literal(ws)},0,clock_timestamp());`,
      `INSERT INTO morrow_work.goals VALUES(${literal(O)},${literal(ws)},${literal(goal)},1,'draft','Synthetic goal',${literal(JSON.stringify({ organizationId: O, workspaceId: ws, storeIds: [], accountIds: [], resources: [workspaceResource(O, ws)], fields: [] }))},'[{"description":"d","verificationCapabilityId":null,"evidenceRequired":false}]',${literal(A.principal)},${literal(A.membership)},${literal(A.principal)},${literal(A.membership)},now(),now());`,
    );
    for (const [initiator, label] of [
      [A, "a"],
      [B, "b"],
    ]) {
      const task = "task_" + label + "_" + ws;
      work.push(
        `INSERT INTO morrow_work.tasks VALUES(${literal(O)},${literal(ws)},${literal(task)},1,${literal(goal)},'draft','Synthetic task',${literal(JSON.stringify({ organizationId: O, workspaceId: ws, storeIds: [], accountIds: [], resources: [], fields: [] }))},${literal(initiator.principal)},${literal(initiator.membership)},${literal(initiator.principal)},${literal(initiator.membership)},now(),now());`,
      );
      tasks[label + ":" + ws] = task;
    }
  }
  db.workOwner("BEGIN;\n" + work.join("\n") + "\nCOMMIT;");
  const at = (p, ws) => view(p, ws);
  const W = Object.fromEntries(caseWorkspaces.map(([ws, k]) => [k, ws]));
  return Object.freeze({
    O,
    P,
    W,
    tasks,
    people: { A, B, C, D, R, X, V, Y },
    at,
    task: (label, ws) => tasks[label + ":" + ws],
    /** A solo organization: owner S (signup) as its only active human member. */
    soloOrganization(name, options = {}) {
      const org = "org_" + name,
        ws = "ws_" + name;
      organization(org, name);
      workspace(org, ws);
      const S = person("s_" + name, org);
      join(S, ws, ownerGrants);
      if (options.signup !== false) signup(S, ws);
      const extra = [];
      for (const other of options.members ?? []) {
        const m = person(other.name, org);
        if (other.workspace) join(m, ws, reviewerGrants);
        extra.push(m);
      }
      db.admin("BEGIN;\n" + statements.join("\n") + "\nCOMMIT;");
      statements.length = 0;
      const goal = "goal_" + ws,
        task = "task_s_" + ws;
      db.workOwner(
        [
          "BEGIN;",
          `INSERT INTO morrow_work.workspace_streams VALUES(${literal(org)},${literal(ws)},0,clock_timestamp());`,
          `INSERT INTO morrow_work.goals VALUES(${literal(org)},${literal(ws)},${literal(goal)},1,'draft','Synthetic goal',${literal(JSON.stringify({ organizationId: org, workspaceId: ws, storeIds: [], accountIds: [], resources: [workspaceResource(org, ws)], fields: [] }))},'[{"description":"d","verificationCapabilityId":null,"evidenceRequired":false}]',${literal(S.principal)},${literal(S.membership)},${literal(S.principal)},${literal(S.membership)},now(),now());`,
          `INSERT INTO morrow_work.tasks VALUES(${literal(org)},${literal(ws)},${literal(task)},1,${literal(goal)},'draft','Synthetic task',${literal(JSON.stringify({ organizationId: org, workspaceId: ws, storeIds: [], accountIds: [], resources: [], fields: [] }))},${literal(S.principal)},${literal(S.membership)},${literal(S.principal)},${literal(S.membership)},now(),now());`,
          "COMMIT;",
        ].join("\n"),
      );
      return { org, ws, S: view(S, ws), task, members: extra.map((m) => view(m, ws)) };
    },
    /** Adds an active human member to an organization (and optionally a workspace). */
    addMember(name, org, ws = null) {
      const m = person(name, org);
      if (ws) join(m, ws, reviewerGrants);
      db.admin("BEGIN;\n" + statements.join("\n") + "\nCOMMIT;");
      statements.length = 0;
      return ws ? view(m, ws) : m;
    },
  });
}

/**
 * A back-dated applied 0004 revocation result in `org` (owner SQL; the receipt and
 * result pair the lifecycle would write), targeting a removed member `target`.
 */
export function backdatedRevocationSql(actor, target, ws, ageSql) {
  const receipt = "receipt_" + randomUUID();
  const grantId = "g_" + actor.key + "_" + ws + "_governance_membership_revoke";
  return `BEGIN; SET LOCAL ROLE morrow_identity_owner;
INSERT INTO morrow_identity.workspace_revocation_receipts SELECT ${literal(receipt)},${literal(actor.org)},${literal(ws)},${literal(actor.principal)},${literal(actor.membership)},${literal(actor.digest)},${literal(target.membership)},${literal("cmd_" + receipt)},${literal("e".repeat(64))},1,${literal(grantId)},g.payload,'evidence',clock_timestamp()+interval '1 hour',clock_timestamp()-${ageSql} FROM morrow_identity.grants g WHERE g.id=${literal(grantId)};
INSERT INTO morrow_identity.workspace_revocation_results VALUES(${literal("result_" + receipt)},${literal(receipt)},${literal(actor.org)},${literal(ws)},${literal("cmd_" + receipt)},${literal(actor.principal)},${literal(actor.membership)},${literal(target.membership)},'evidence','applied','applied',${literal("revocation_" + receipt)},1,clock_timestamp()-${ageSql});
COMMIT;`;
}

/**
 * One request transaction exactly as the api Worker runs it: a fresh psql login as
 * morrow_api_worker, the fixed prologue, enter_context with the principal's session
 * digest, then `body`. Load-induced unavailability and unknown outcomes are
 * reconciled the only way the contract allows: the same command again.
 */
export function transactions(db, stats = { retries: 0 }) {
  return async function inTx(p, body, options = {}) {
    const connector = options.connector ?? db.connector(options.hooks);
    for (let attempt = 1; ; attempt++) {
      const control = new AbortController();
      const connection = await connector.open({
        signal: control.signal,
        deadlineMs: Date.now() + 120000,
        waitUntil() {},
      });
      try {
        return await withWorkTransaction(
          connection,
          {
            readOnly: options.readOnly ?? false,
            deadlineMs: Date.now() + 120000,
            signal: control.signal,
          },
          async (tx) => {
            const a = await enterWorkContext(tx, p.digest, options.workspace ?? p.workspace);
            if (typeof a === "string") {
              tx.rollbackOnly();
              return { outcome: a };
            }
            return body(tx, a, connection);
          },
        );
      } catch (error) {
        const retry =
          (error instanceof WorkSqlUnavailable || error instanceof WorkOutcomeUnknown) &&
          options.retry !== false &&
          attempt < (options.attempts ?? 6);
        if (!retry) throw error;
        stats.retries++;
        await sleep(300);
      } finally {
        await connection.close().catch(() => {});
      }
    }
  };
}

/** A WorkTx over an open connection inside a transaction the caller opened. */
export function rawTx(connection, signal) {
  return {
    run: async (name, values) =>
      (await connection.query(workStatements[name], values, signal)).rows,
    markSubmitted() {},
    rollbackOnly() {},
  };
}
