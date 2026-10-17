import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { localLifecyclePool } from "./local-lifecycle-sql.mjs";
import { localIdentityPool } from "./local-identity-sql.mjs";
import {
  createWorkspaceAccessRevocations,
  workspaceAccessRevocationSql,
} from "../packages/identity/src/workspace-access-revocation.ts";
import { withIdentityRead } from "../packages/identity/src/index.ts";
import {
  createHumanPolicyService,
  createWorkspacePermissionBoundary,
} from "../packages/policy/src/index.ts";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import { writeArtifact } from "./artifacts.mjs";
const checks = [];
const check = (name, condition) => {
  if (!condition) throw Error("WORKSPACE_REVOCATION_LAB_FAILED:" + name);
  checks.push({ name, passed: true });
};
const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
// This preserved regression keeps its qualified pre-login-custody schema.
if (!Array.isArray(manifest.migrations) || manifest.migrations.length < 9)
  throw Error("PRESERVED_MIGRATIONS_1_TO_9_REQUIRED");
const selectedMigrations = manifest.migrations.slice(0, 9);
if (selectedMigrations.length !== 9) throw Error("PRESERVED_MIGRATIONS_1_TO_9_REQUIRED");
const migrations = selectedMigrations.map((m, index) => {
  const text = readFileSync("migrations/" + m.file, "utf8");
  if (m.sequence !== index + 1 || hash(text) !== m.sha256) throw Error("MIGRATION_CHECKSUM");
  return { record: m, text };
});
if (migrations.length < 4 || migrations[3].record.sequence !== 4)
  throw Error("LIFECYCLE_MIGRATION_REQUIRED");
const proofs = [];
const observed = await localPostgresLab("P05.T01c", async ({ id, sql, image, version }) => {
  sql("CREATE DATABASE morrow; CREATE DATABASE morrow_lifecycle_rollback;");
  sql(readFileSync("infra/identity-role-prerequisites.sql", "utf8"), "morrow");
  for (const { text } of migrations) sql("SET ROLE morrow_identity_owner;\n" + text, "morrow");
  const admin = (text) => sql("SET ROLE morrow_identity_owner;\n" + text, "morrow");
  const exec = (
    text,
    role = "morrow_identity_lifecycle",
    allowFailure = false,
    database = "morrow",
  ) =>
    containerCommand(
      [
        "exec",
        "--interactive",
        id,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "VERBOSITY=verbose",
        "-U",
        role,
        "-d",
        database,
      ],
      text,
      allowFailure,
    );
  check(
    "executor_starts_nologin_without_memberships",
    sql(
      "SELECT NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) FROM pg_roles r WHERE rolname='morrow_identity_lifecycle';",
      "morrow",
    ) === "t",
  );
  sql("ALTER ROLE morrow_api LOGIN; ALTER ROLE morrow_identity_lifecycle LOGIN;");
  const pool = localLifecyclePool(id),
    reads = localIdentityPool(id);
  const service = createWorkspaceAccessRevocations(pool);
  const constraints = {
    readCurrent: async () => ({ providerAllowed: true, entitlementAllowed: true }),
  };
  const boundary = createWorkspacePermissionBoundary(reads, constraints);
  let fixtureNumber = 0;
  async function fixture(options = {}) {
    const n = ++fixtureNumber;
    const org = "org_" + n,
      workspace = "workspace_" + n,
      other = "other_" + n;
    const actorId = "actor_" + n,
      targetId = options.self ? actorId : "target_" + n;
    const actorMembership = "actor_member_" + n,
      targetMembership = options.self ? actorMembership : "target_member_" + n;
    const actorProof = randomBytes(32).toString("hex"),
      targetProof = options.self ? actorProof : randomBytes(32).toString("hex");
    proofs.push(actorProof, targetProof);
    const actor = {
      kind: "human",
      principalId: actorId,
      organizationId: org,
      workspaceId: workspace,
      membershipId: actorMembership,
      installationId: null,
      mandateId: null,
    };
    const resource = {
      organizationId: org,
      workspaceId: workspace,
      storeId: null,
      connectionId: null,
      kind: "workspace",
      id: workspace,
    };
    const grant = {
      id: "authority_" + n,
      principal: actor,
      capabilityId: "governance.membership.revoke",
      verbs: ["execute"],
      scope: {
        organizationId: org,
        workspaceId: workspace,
        storeIds: [],
        accountIds: [],
        resources: [resource],
        fields: ["membership", "session_revocation"],
      },
      issuedBy: actor,
      validFrom: "2020-01-01T00:00:00.000Z",
      expiresAt: options.grantExpirySeconds
        ? new Date(Date.now() + options.grantExpirySeconds * 1000).toISOString()
        : null,
      revokedAt: null,
      policyRevision: 1,
    };
    check("fixture_" + n + "_grant_schema_valid", validateDefinition("core", "Grant", grant));
    const request = {
      capabilityId: grant.capabilityId,
      verb: "execute",
      resource,
      accountId: null,
      fields: grant.scope.fields,
    };
    const preflight = await createHumanPolicyService({
      readCurrent: async () => ({
        actor,
        policyRevision: 1,
        grantsRevision: 1,
        principalActive: true,
        organizationActive: true,
        workspaceActive: true,
        membershipActive: true,
        sessionCurrent: true,
        resource,
        accountId: null,
        providerAllowed: true,
        entitlementAllowed: true,
        grants: [grant],
      }),
    }).decide(request);
    check(
      "fixture_" + n + "_shared_policy_requires_separate_approval",
      preflight.decision.allowed && preflight.obligations.includes("exact_approval"),
    );
    const targetGrant = (w) => ({
      ...grant,
      id: "target_grant_" + w,
      principal: {
        ...actor,
        principalId: targetId,
        membershipId: targetMembership,
        workspaceId: w,
      },
      capabilityId: "workspace.goal.create",
      issuedBy: { ...actor, workspaceId: null },
      scope: {
        ...grant.scope,
        workspaceId: w,
        resources: [{ ...resource, workspaceId: w, id: w }],
        fields: ["objective"],
      },
    });
    const grants = [grant, targetGrant(workspace), targetGrant(other)];
    for (const g of grants)
      if (!validateDefinition("core", "Grant", g)) throw Error("FIXTURE_GRANT_INVALID");
    admin(`INSERT INTO morrow_identity.organizations VALUES (${literal(org)},'Synthetic',true,${options.revision ?? 1});
INSERT INTO morrow_identity.principals VALUES (${literal(actorId)},'human',true)${options.self ? "" : `,(${literal(targetId)},'human',true)`};
INSERT INTO morrow_identity.memberships VALUES (${literal(actorMembership)},${literal(org)},${literal(actorId)},true)${options.self ? "" : `,(${literal(targetMembership)},${literal(org)},${literal(targetId)},true)`};
INSERT INTO morrow_identity.workspaces VALUES (${literal(workspace)},${literal(org)},'First',true),(${literal(other)},${literal(org)},'Other',true);
INSERT INTO morrow_identity.workspace_memberships VALUES (${literal(org)},${literal(workspace)},${literal(actorMembership)},true)${options.self ? "" : `,(${literal(org)},${literal(workspace)},${literal(targetMembership)},true)`},(${literal(org)},${literal(other)},${literal(targetMembership)},true);
INSERT INTO morrow_identity.sessions VALUES ('actor_session_${n}',${literal(actorId)},${literal(org)},${literal(actorProof)},'workos','synthetic_actor_${n}',clock_timestamp()+interval '1 hour',NULL)${options.self ? "" : `,('target_session_${n}',${literal(targetId)},${literal(org)},${literal(targetProof)},'workos','synthetic_target_${n}',clock_timestamp()+interval '1 hour',NULL)`};
${grants.map((g) => `INSERT INTO morrow_identity.grants VALUES (${literal(g.id)},${literal(org)},${literal(g.principal.workspaceId)},${literal(g.principal.membershipId)},${literal(g.principal.principalId)},${literal(JSON.stringify(g))}::jsonb);`).join("\n")}`);
    const input = {
      receiptId: "receipt_" + n,
      commandId: "command_" + n,
      requestDigest: randomBytes(32).toString("hex"),
      sessionDigest: actorProof,
      organizationId: org,
      workspaceId: workspace,
      targetMembershipId: targetMembership,
      expectedRevision: options.revision ?? 1,
    };
    const seedReceipt = (value = input, seconds = options.expirySeconds ?? 300) =>
      admin(`INSERT INTO morrow_identity.workspace_revocation_receipts
(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,actor_session_digest,target_membership_id,command_id,request_digest,expected_policy_revision,authorizing_grant_id,authorizing_grant_snapshot,approval_evidence_id,expires_at)
VALUES (${literal(value.receiptId)},${literal(org)},${literal(workspace)},${literal(actorId)},${literal(actorMembership)},${literal(actorProof)},${literal(targetMembership)},${literal(value.commandId)},${literal(value.requestDigest)},${value.expectedRevision},${literal(grant.id)},${literal(JSON.stringify(grant))}::jsonb,'synthetic_approval_${n}',clock_timestamp()+interval '${seconds} seconds');`);
    seedReceipt();
    return {
      n,
      input,
      actor,
      actorId,
      actorMembership,
      targetId,
      targetMembership,
      targetProof,
      org,
      workspace,
      other,
      grant,
      seedReceipt,
      targetGrant,
    };
  }
  const countResults = (f) =>
    admin(
      `SELECT count(*) FROM morrow_identity.workspace_revocation_results WHERE organization_id=${literal(f.org)};`,
    );
  const state = (f) =>
    admin(
      `SELECT wm.active::text||'|'||o.policy_revision::text||'|'||(r.consumed_at IS NOT NULL)::text FROM morrow_identity.workspace_memberships wm JOIN morrow_identity.organizations o ON o.id=wm.organization_id JOIN morrow_identity.workspace_revocation_receipts r ON r.workspace_id=wm.workspace_id AND r.target_membership_id=wm.membership_id WHERE wm.workspace_id=${literal(f.workspace)} AND wm.membership_id=${literal(f.targetMembership)} AND r.id=${literal(f.input.receiptId)};`,
    );
  const requestFor = (f, w) => ({
    capabilityId: "workspace.goal.create",
    verb: "execute",
    resource: {
      organizationId: f.org,
      workspaceId: w,
      storeId: null,
      connectionId: null,
      kind: "workspace",
      id: w,
    },
    accountId: null,
    fields: ["objective"],
  });
  const auditReason = (f) =>
    admin(
      `SELECT reason FROM morrow_identity.workspace_revocation_results WHERE receipt_id=${literal(f.input.receiptId)};`,
    );
  // A live row-lock barrier, not a timing assumption: the holder signals only
  // after acquiring its lock; the caller is observed waiting in pg_locks.
  async function holder(lockSql) {
    const child = spawn(
      "docker",
      [
        "exec",
        "--interactive",
        id,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "morrow",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    const done = new Promise((resolve) => child.on("close", (code) => resolve(code)));
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("LIFECYCLE_LOCK_BARRIER_FAILED"));
      }, 5000);
      child.on("error", () => {
        clearTimeout(timer);
        reject(Error("LIFECYCLE_LOCK_BARRIER_FAILED"));
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("LIFECYCLE_LOCK_READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    });
    child.stdin.write(
      "BEGIN; SET ROLE morrow_identity_owner; " + lockSql + ";\n\\echo LIFECYCLE_LOCK_READY\n",
    );
    await ready;
    return {
      async release(mutate = "") {
        child.stdin.end(mutate + "\nCOMMIT;\n");
        if ((await done) !== 0 || stderr || proofs.some((p) => stdout.includes(p)))
          throw Error("LIFECYCLE_LOCK_RELEASE_FAILED");
      },
      async close() {
        if (child.exitCode === null) child.kill("SIGKILL");
        await done;
      },
    };
  }
  async function waitBlocked(expected = 1) {
    for (let i = 0; i < 60; i++) {
      if (
        Number(
          sql(
            "SELECT count(DISTINCT a.pid) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND a.usename='morrow_identity_lifecycle';",
            "morrow",
          ),
        ) >= expected
      )
        return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error("LIFECYCLE_CALL_NOT_BLOCKED");
  }
  async function waitingCase(name, lock, mutation, expectedReason, options = {}) {
    const f = await fixture(options);
    if (options.sessionExpirySeconds)
      admin(
        `UPDATE morrow_identity.sessions SET expires_at=clock_timestamp()+interval '${options.sessionExpirySeconds} seconds' WHERE session_digest=${literal(f.input.sessionDigest)};`,
      );
    const h = await holder(lock(f));
    const pending = service.apply(f.input);
    try {
      await waitBlocked();
      if (options.expirySeconds || options.grantExpirySeconds || options.sessionExpirySeconds) {
        while (
          admin(
            options.grantExpirySeconds
              ? `SELECT (authorizing_grant_snapshot->>'expiresAt')::timestamptz>clock_timestamp() FROM morrow_identity.workspace_revocation_receipts WHERE id=${literal(f.input.receiptId)};`
              : options.sessionExpirySeconds
                ? `SELECT expires_at>clock_timestamp() FROM morrow_identity.sessions WHERE session_digest=${literal(f.input.sessionDigest)};`
                : `SELECT expires_at>clock_timestamp() FROM morrow_identity.workspace_revocation_receipts WHERE id=${literal(f.input.receiptId)};`,
          ) === "t"
        )
          await new Promise((r) => setTimeout(r, 30));
      }
      await h.release(mutation(f));
      const r = await pending;
      check(
        name,
        r.outcome === "denied" &&
          r.auditId !== null &&
          auditReason(f) === expectedReason &&
          state(f) === "true|1|true",
      );
    } finally {
      await h.close();
    }
  }
  try {
    const a = await fixture(),
      foreign = await fixture();
    check(
      "before_revocation_actual_shared_sql_policy_allows",
      (await boundary.decide(a.targetProof, a.workspace, requestFor(a, a.workspace))).decision
        .allowed,
    );
    const r = await service.apply(a.input);
    check(
      "exact_receipt_applies_once_with_audit",
      r.outcome === "applied" &&
        r.policyRevision === 2 &&
        r.auditId &&
        r.revocationId &&
        state(a) === "false|2|true" &&
        countResults(a) === "1",
    );
    check(
      "current_read_boundary_rejects_revoked_workspace",
      await withIdentityRead(reads, a.targetProof, a.workspace, (s) => s.readWorkspace()).then(
        () => false,
        (error) => error.code === "IDENTITY_DENIED",
      ),
    );
    check(
      "current_sql_policy_rejects_revoked_workspace",
      await boundary.decide(a.targetProof, a.workspace, requestFor(a, a.workspace)).then(
        () => false,
        (error) => error.code === "IDENTITY_DENIED",
      ),
    );
    check(
      "other_workspace_shared_policy_still_allows_after_revision",
      (await boundary.decide(a.targetProof, a.other, requestFor(a, a.other))).decision.allowed,
    );
    check(
      "other_tenant_shared_policy_unchanged",
      (
        await boundary.decide(
          foreign.targetProof,
          foreign.workspace,
          requestFor(foreign, foreign.workspace),
        )
      ).decision.allowed,
    );
    check(
      "organization_membership_principal_sessions_preserved",
      admin(
        `SELECT p.active AND m.active AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FROM morrow_identity.principals p JOIN morrow_identity.memberships m ON m.principal_id=p.id JOIN morrow_identity.sessions s ON s.principal_id=p.id WHERE p.id=${literal(a.targetId)};`,
      ) === "t",
    );
    const revokedPayload = JSON.parse(
      admin(
        `SELECT payload::text FROM morrow_identity.grants WHERE id=${literal(a.targetGrant(a.workspace).id)};`,
      ),
    );
    check(
      "revoked_grant_remains_canonical_valid_UTC",
      validateDefinition("core", "Grant", revokedPayload) &&
        /^[0-9]{4}-.+\.[0-9]{3}Z$/.test(revokedPayload.revokedAt),
    );
    check(
      "only_target_workspace_grants_revoked",
      admin(
        `SELECT count(*) FROM morrow_identity.grants WHERE organization_id=${literal(a.org)} AND payload->'revokedAt'<>'null'::jsonb;`,
      ) === "1",
    );
    const replay = await service.apply(a.input);
    check(
      "same_command_reconciliation_returns_original_after_commit",
      JSON.stringify(replay) === JSON.stringify(r) && countResults(a) === "1",
    );
    for (const [name, patch] of [
      ["wrong_receipt", { receiptId: "unknown" }],
      ["wrong_organization", { organizationId: foreign.org }],
      ["wrong_workspace", { workspaceId: a.other }],
      ["wrong_target", { targetMembershipId: a.actorMembership }],
      ["wrong_session", { sessionDigest: foreign.input.sessionDigest }],
      ["changed_expected_revision", { expectedRevision: 2 }],
      ["changed_command", { commandId: "changed" }],
      ["changed_digest", { requestDigest: "f".repeat(64) }],
    ]) {
      const x = await service.apply({ ...a.input, ...patch });
      check(
        name + "_no_authority_or_audit_disclosure",
        ["denied", "conflict"].includes(x.outcome) &&
          x.auditId === null &&
          x.policyRevision === null &&
          x.revocationId === null &&
          countResults(a) === "1",
      );
    }
    admin(
      `UPDATE morrow_identity.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_digest=${literal(a.input.sessionDigest)};`,
    );
    check(
      "expired_session_cannot_retrieve_private_replay",
      (await service.apply(a.input)).auditId === null,
    );
    const self = await fixture({ self: true });
    check(
      "self_revocation_commits_but_cannot_replay",
      (await service.apply(self.input)).outcome === "applied" &&
        (await service.apply(self.input)).auditId === null,
    );
    check(
      "self_revocation_preserves_other_workspace",
      (await boundary.decide(self.targetProof, self.other, requestFor(self, self.other))).decision
        .allowed,
    );
    const expired = await fixture({ expirySeconds: -1 });
    check(
      "exact_expired_receipt_denial_is_committed_and_attributed",
      (await service.apply(expired.input)).outcome === "denied" &&
        countResults(expired) === "1" &&
        auditReason(expired) === "receipt_expired" &&
        state(expired) === "true|1|true",
    );
    const inactive = await fixture();
    admin(
      `UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id=${literal(inactive.workspace)} AND membership_id=${literal(inactive.targetMembership)};`,
    );
    check(
      "inactive_target_commits_denial_without_revision",
      (await service.apply(inactive.input)).outcome === "denied" &&
        auditReason(inactive) === "target_ineligible" &&
        state(inactive) === "false|1|true",
    );
    const overflow = await fixture({ revision: 9007199254740991 });
    check(
      "revision_overflow_fails_closed_with_terminal_audit",
      (await service.apply(overflow.input)).outcome === "denied" &&
        auditReason(overflow) === "revision_exhausted",
    );
    const duplicate = await fixture(),
      hd = await holder(
        `SELECT 1 FROM morrow_identity.organizations WHERE id=${literal(duplicate.org)} FOR UPDATE`,
      );
    const duplicates = [service.apply(duplicate.input), service.apply(duplicate.input)];
    try {
      await waitBlocked(2);
      await hd.release();
      const results = await Promise.all(duplicates);
      check(
        "concurrent_duplicate_has_one_mutation_revision_and_audit",
        results.every((v) => v.outcome === "applied") &&
          JSON.stringify(results[0]) === JSON.stringify(results[1]) &&
          countResults(duplicate) === "1" &&
          state(duplicate) === "false|2|true",
      );
    } finally {
      await hd.close();
    }
    const competing = await fixture();
    const second = {
      ...competing.input,
      receiptId: "second_receipt",
      commandId: "second_command",
      requestDigest: randomBytes(32).toString("hex"),
    };
    competing.seedReceipt(second);
    const hc = await holder(
        `SELECT 1 FROM morrow_identity.organizations WHERE id=${literal(competing.org)} FOR UPDATE`,
      ),
      races = [service.apply(competing.input), service.apply(second)];
    try {
      await waitBlocked(2);
      await hc.release();
      const results = await Promise.all(races);
      check(
        "competing_expected_revisions_have_one_winner",
        results.filter((v) => v.outcome === "applied").length === 1 &&
          results.filter((v) => v.outcome === "denied").length === 1 &&
          countResults(competing) === "2" &&
          admin(
            `SELECT policy_revision FROM morrow_identity.organizations WHERE id=${literal(competing.org)};`,
          ) === "2",
      );
    } finally {
      await hc.close();
    }
    await waitingCase(
      "receipt_expiry_during_real_lock_wait_denies",
      (f) => `SELECT 1 FROM morrow_identity.organizations WHERE id=${literal(f.org)} FOR UPDATE`,
      () => "",
      "receipt_expired",
      { expirySeconds: 2 },
    );
    await waitingCase(
      "session_revoked_during_lock_wait_denies",
      (f) =>
        `SELECT 1 FROM morrow_identity.sessions WHERE session_digest=${literal(f.input.sessionDigest)} FOR UPDATE`,
      (f) =>
        `UPDATE morrow_identity.sessions SET revoked_at=clock_timestamp() WHERE session_digest=${literal(f.input.sessionDigest)};`,
      "actor_ineligible",
    );
    await waitingCase(
      "actor_membership_revoked_during_lock_wait_denies",
      (f) =>
        `SELECT 1 FROM morrow_identity.memberships WHERE id=${literal(f.actorMembership)} FOR UPDATE`,
      (f) =>
        `UPDATE morrow_identity.memberships SET active=false WHERE id=${literal(f.actorMembership)};`,
      "actor_ineligible",
    );
    await waitingCase(
      "authorizing_grant_drift_during_lock_wait_denies",
      (f) => `SELECT 1 FROM morrow_identity.grants WHERE id=${literal(f.grant.id)} FOR UPDATE`,
      (f) =>
        `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{verbs}','["view"]'::jsonb) WHERE id=${literal(f.grant.id)};`,
      "grant_changed",
    );
    await waitingCase(
      "grant_expiry_after_last_row_lock_denies",
      (f) => `SELECT 1 FROM morrow_identity.grants WHERE id=${literal(f.grant.id)} FOR UPDATE`,
      () => "",
      "grant_changed",
      { grantExpirySeconds: 3 },
    );
    await waitingCase(
      "session_expiry_after_lock_wait_denies",
      (f) =>
        `SELECT 1 FROM morrow_identity.sessions WHERE session_digest=${literal(f.input.sessionDigest)} FOR UPDATE`,
      () => "",
      "actor_ineligible",
      { sessionExpirySeconds: 2 },
    );
    const stale = await fixture();
    admin(
      `UPDATE morrow_identity.organizations SET policy_revision=2 WHERE id=${literal(stale.org)};`,
    );
    check(
      "stale_policy_revision_is_terminal_denial",
      (await service.apply(stale.input)).outcome === "denied" &&
        auditReason(stale) === "policy_conflict",
    );
    const uncertain = await fixture();
    let commitAttempts = 0;
    const lostAckPool = {
      async connect() {
        const client = await pool.connect();
        return {
          release: (discard) => client.release(discard),
          async query(text, values) {
            const result = await client.query(text, values);
            if (text === workspaceAccessRevocationSql.commit) {
              commitAttempts++;
              throw Error("SYNTHETIC_LOST_COMMIT_ACK");
            }
            return result;
          },
        };
      },
    };
    check(
      "lost_real_commit_ack_remains_uncertain_without_retry",
      (await createWorkspaceAccessRevocations(lostAckPool)
        .apply(uncertain.input)
        .then(
          () => false,
          (error) =>
            error.code === "WORKSPACE_REVOCATION_UNCERTAIN" &&
            error.commandId === uncertain.input.commandId,
        )) &&
        commitAttempts === 1 &&
        countResults(uncertain) === "1" &&
        state(uncertain) === "false|2|true",
    );
    const reconciled = await service.apply(uncertain.input);
    check(
      "uncertain_commit_reconciles_same_command_once",
      reconciled.outcome === "applied" &&
        reconciled.policyRevision === 2 &&
        countResults(uncertain) === "1",
    );
    const consumed = await fixture();
    admin(
      `UPDATE morrow_identity.workspace_revocation_receipts SET consumed_at=clock_timestamp() WHERE id=${literal(consumed.input.receiptId)};`,
    );
    check(
      "consumed_receipt_without_result_fails_closed",
      (await service.apply(consumed.input)).auditId === null &&
        countResults(consumed) === "0" &&
        state(consumed) === "true|1|true",
    );
    const rollback = await fixture();
    admin(
      "CREATE FUNCTION morrow_identity.lab_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END $$; CREATE TRIGGER lab_fail_audit BEFORE INSERT ON morrow_identity.workspace_revocation_results FOR EACH ROW EXECUTE FUNCTION morrow_identity.lab_fail_audit();",
    );
    check(
      "audit_write_failure_rolls_back_all_effects",
      (await service.apply(rollback.input).then(
        () => false,
        () => true,
      )) &&
        state(rollback) === "true|1|false" &&
        countResults(rollback) === "0" &&
        admin(
          `SELECT payload->'revokedAt'='null'::jsonb FROM morrow_identity.grants WHERE id=${literal(rollback.targetGrant(rollback.workspace).id)};`,
        ) === "t",
    );
    admin(
      "DROP TRIGGER lab_fail_audit ON morrow_identity.workspace_revocation_results; DROP FUNCTION morrow_identity.lab_fail_audit();",
    );
    check(
      "same_command_after_definite_rollback_can_apply",
      (await service.apply(rollback.input)).outcome === "applied",
    );
    const tx = await fixture();
    const call = (f, rev = String(f.input.expectedRevision)) =>
      `SELECT * FROM morrow_identity.revoke_workspace_access(${[f.input.receiptId, f.input.commandId, f.input.requestDigest, f.input.sessionDigest, f.org, f.workspace, f.targetMembership, rev].map(literal).join(",")});`;
    exec("BEGIN; " + call(tx) + " ROLLBACK;");
    check(
      "explicit_transaction_rollback_reverts_receipt_and_effect",
      state(tx) === "true|1|false" && countResults(tx) === "0",
    );
    for (const revision of ["nonnumeric", "0", "1.0", "9007199254740992", "1".repeat(100)])
      check(
        "malformed_revision_" + revision.length + "_denied_without_exception",
        exec(call(tx, revision)).stdout.trim() === "denied|||",
      );
    for (const role of ["morrow_api", "morrow_identity_lifecycle"])
      for (const [name, text] of [
        ["private_receipt_read", "SELECT * FROM morrow_identity.workspace_revocation_receipts;"],
        ["private_result_read", "SELECT * FROM morrow_identity.workspace_revocation_results;"],
        ["receipt_write", "DELETE FROM morrow_identity.workspace_revocation_receipts;"],
        ["membership_write", "UPDATE morrow_identity.workspace_memberships SET active=false;"],
        ["grant_write", "UPDATE morrow_identity.grants SET payload='{}';"],
        ["owner_escalation", "SET ROLE morrow_identity_owner;"],
        [
          "receipt_insert",
          "INSERT INTO morrow_identity.workspace_revocation_receipts DEFAULT VALUES;",
        ],
        [
          "result_insert",
          "INSERT INTO morrow_identity.workspace_revocation_results DEFAULT VALUES;",
        ],
        [
          "result_update",
          "UPDATE morrow_identity.workspace_revocation_results SET outcome='denied';",
        ],
      ])
        check(role + "_" + name + "_denied", /42501:/.test(exec(text, role, true).stderr));
    check(
      "api_cannot_execute_lifecycle_function",
      /42501:/.test(exec(call(tx), "morrow_api", true).stderr),
    );
    check(
      "api_cannot_assume_lifecycle_role",
      /42501:/.test(exec("SET ROLE morrow_identity_lifecycle;", "morrow_api", true).stderr),
    );
    check(
      "receipt_bindings_are_immutable_even_for_maintenance",
      exec(
        `SET ROLE morrow_identity_owner; UPDATE morrow_identity.workspace_revocation_receipts SET request_digest=repeat('a',64) WHERE id=${literal(tx.input.receiptId)};`,
        "postgres",
        true,
      ).status !== 0,
    );
    check(
      "terminal_audit_is_immutable_even_for_maintenance",
      exec(
        `SET ROLE morrow_identity_owner; DELETE FROM morrow_identity.workspace_revocation_results WHERE organization_id=${literal(a.org)};`,
        "postgres",
        true,
      ).status !== 0,
    );
    check(
      "both_private_tables_force_rls",
      sql(
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='morrow_identity' AND c.relname IN('workspace_revocation_receipts','workspace_revocation_results') AND c.relrowsecurity AND c.relforcerowsecurity;",
        "morrow",
      ) === "2",
    );
    check(
      "public_has_no_function_execution",
      sql(
        "SELECT NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE n.nspname='morrow_identity' AND p.proname='revoke_workspace_access' AND a.grantee=0 AND a.privilege_type='EXECUTE');",
        "morrow",
      ) === "t",
    );
    sql(
      "GRANT CREATE ON DATABASE morrow_lifecycle_rollback TO morrow_identity_owner; ALTER ROLE morrow_identity_lifecycle NOLOGIN;",
    );
    for (const { text } of migrations.slice(0, 3))
      sql("SET ROLE morrow_identity_owner;\n" + text, "morrow_lifecycle_rollback");
    const failed = exec(
      "SET ROLE morrow_identity_owner;\n" +
        migrations[3].text.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;"),
      "postgres",
      true,
      "morrow_lifecycle_rollback",
    );
    check(
      "failed_migration_rolls_back_all_new_objects",
      failed.status !== 0 &&
        sql(
          "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='morrow_identity' AND c.relname LIKE 'workspace_revocation_%';",
          "morrow_lifecycle_rollback",
        ) === "0",
    );
    const logs = containerCommand(["logs", id]);
    check(
      "proofs_absent_from_database_and_adapter_output",
      !proofs.some(
        (p) =>
          logs.stdout.includes(p) ||
          logs.stderr.includes(p) ||
          [...pool.observed, ...reads.observed].some(
            (o) => o.stdout.includes(p) || o.stderr.includes(p),
          ),
      ),
    );
  } finally {
    await pool.close();
    await reads.close();
  }
  return { image, version };
});
const source = JSON.parse(readFileSync("docs/plan/source.json", "utf8"));
writeArtifact(
  "labs/workspace-revocation.json",
  JSON.stringify(
    {
      task: "P05.T01c",
      canonical_sequence: source.sources.plan.sequence,
      observed_at: new Date().toISOString(),
      scope:
        "Actual application lifecycle transaction and shared identity/policy read boundary on isolated PostgreSQL17.11. Synthetic owner-seeded receipts, approvals, sessions and constraint facts only; no production issuer or hosted identity.",
      ...observed,
      migrations: migrations.map((m) => ({ file: m.record.file, sha256: m.record.sha256 })),
      checks,
      limitations: [
        "Only the preserved migrations1–9 are installed; migration10 login custody is not installed or qualified by this regression.",
        "No WorkOS authentication, public lifecycle route, grant issuance, production approval receipt issuer or merchant activation.",
        "Workspace-only access revocation preserves organization sessions and other workspaces; no affected-run cancellation or dispatch claim.",
        "Scripts-only psql adapter is not a production lifecycle credential or driver qualification.",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "PASS: " +
    checks.length +
    " real application/SQL workspace revocation checks; hosted identity and production issuance pending.",
);
