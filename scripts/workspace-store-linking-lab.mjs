import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import canonicalize from "canonicalize";
import {
  localPostgresLab,
  containerCommand,
  localPostgresWaitingCaseDiagnostic,
} from "./local-postgres-lab.mjs";
import { localStoreLinkingPool } from "./local-store-linking-sql.mjs";
import {
  createWorkspaceStoreLinks,
  workspaceStoreLinkingSql,
} from "../packages/identity/src/workspace-store-linking.ts";
import { createHumanPolicyService } from "../packages/policy/src/index.ts";
import {
  validateDefinition,
  validateCapabilityInput,
} from "../packages/contracts/src/validation.ts";
import { writeArtifact } from "./artifacts.mjs";
const checks = [];
const check = (name, ok) => {
  if (!ok) throw Error("STORE_LINKING_LAB_FAILED:" + name);
  checks.push({ name, passed: true });
};
const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const json = (s) => literal(JSON.stringify(s)) + "::jsonb";
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
// This preserved regression keeps its qualified pre-login-custody schema.
if (!Array.isArray(manifest.migrations) || manifest.migrations.length < 9)
  throw Error("PRESERVED_MIGRATIONS_1_TO_9_REQUIRED");
const selectedMigrations = manifest.migrations.slice(0, 9);
if (selectedMigrations.length !== 9) throw Error("PRESERVED_MIGRATIONS_1_TO_9_REQUIRED");
const migrations = selectedMigrations.map((record, index) => {
  const text = readFileSync("migrations/" + record.file, "utf8");
  if (record.sequence !== index + 1 || hash(text) !== record.sha256)
    throw Error("MIGRATION_CHECKSUM");
  return { record, text };
});
if (migrations.length < 5 || migrations[4].record.sequence !== 5)
  throw Error("LINKING_MIGRATION_REQUIRED");
const secrets = [];
const observed = await localPostgresLab("P05.T03a", async ({ id, sql, image, version }) => {
  sql("CREATE DATABASE morrow; CREATE DATABASE morrow_linking_rollback;");
  sql(readFileSync("infra/identity-role-prerequisites.sql", "utf8"), "morrow");
  for (const m of migrations) sql("SET ROLE morrow_identity_owner;\n" + m.text, "morrow");
  const admin = (text) => sql("SET ROLE morrow_identity_owner;\n" + text, "morrow");
  const exec = (text, role = "morrow_identity_linking", failure = false, database = "morrow") =>
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
      failure,
    );
  check(
    "dedicated_role_starts_nologin_no_membership_either_direction",
    sql(
      "SELECT NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) FROM pg_roles r WHERE rolname='morrow_identity_linking';",
      "morrow",
    ) === "t",
  );
  sql(
    "ALTER ROLE morrow_api LOGIN; ALTER ROLE morrow_identity_lifecycle LOGIN; ALTER ROLE morrow_identity_linking LOGIN;",
  );
  const pool = localStoreLinkingPool(id),
    service = createWorkspaceStoreLinks(pool);
  const apply = (input) => service.apply(JSON.stringify(input));
  let sequence = 0;
  async function fixture(options = {}) {
    const n = ++sequence,
      org = options.sameWorkspace?.org ?? "link_org_" + n,
      workspace = options.sameWorkspace?.workspace ?? "link_workspace_" + n;
    const principal = options.shared?.principal ?? "link_actor_" + n,
      member = options.sameWorkspace?.member ?? "link_member_" + n;
    const session = randomBytes(32).toString("hex"),
      nonce = randomBytes(32).toString("hex");
    secrets.push(session, nonce);
    const actor = {
      kind: "human",
      principalId: principal,
      organizationId: org,
      workspaceId: workspace,
      membershipId: member,
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
    const scope = {
      organizationId: org,
      workspaceId: workspace,
      storeIds: [],
      accountIds: [],
      resources: [resource],
      fields: ["providerId", "installationProof", "scope"],
    };
    const grant = {
      id: "link_grant_" + n,
      principal: actor,
      capabilityId: "governance.connection.connect",
      verbs: ["administer"],
      scope: structuredClone(scope),
      issuedBy: actor,
      validFrom: "2020-01-01T00:00:00.000Z",
      expiresAt: options.grantSeconds
        ? new Date(Date.now() + options.grantSeconds * 1000).toISOString()
        : null,
      revokedAt: null,
      policyRevision: 1,
    };
    if (options.broadGrant) grant.scope.fields.push("status");
    const operation = {
      capabilityId: grant.capabilityId,
      verb: "administer",
      resource,
      accountId: null,
      fields: scope.fields,
    };
    check(
      "fixture_" + n + "_valid_full_grant_and_scope",
      validateDefinition("core", "Grant", grant) && validateDefinition("core", "Scope", scope),
    );
    const decision = await createHumanPolicyService({
      readCurrent: async () => ({
        actor,
        policyRevision: options.policyRevision ?? 1,
        grantsRevision: options.policyRevision ?? 1,
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
    }).decide(operation);
    check(
      "fixture_" + n + "_shared_policy_requires_separate_review",
      decision.decision.allowed && decision.obligations.includes("exact_approval"),
    );
    if (!options.sameWorkspace)
      admin(`INSERT INTO morrow_identity.organizations VALUES(${literal(org)},'Synthetic linking',true,${options.policyRevision ?? 1});
INSERT INTO morrow_identity.principals VALUES(${literal(principal)},'human',true) ON CONFLICT DO NOTHING;
INSERT INTO morrow_identity.memberships VALUES(${literal(member)},${literal(org)},${literal(principal)},true);
INSERT INTO morrow_identity.workspaces VALUES(${literal(workspace)},${literal(org)},'Synthetic',true);
INSERT INTO morrow_identity.workspace_memberships VALUES(${literal(org)},${literal(workspace)},${literal(member)},true);`);
    admin(`INSERT INTO morrow_identity.sessions VALUES('link_session_${n}',${literal(principal)},${literal(org)},${literal(session)},'workos','synthetic_link_${n}',clock_timestamp()+interval '${options.sessionSeconds ?? 3600} seconds',NULL);
INSERT INTO morrow_identity.grants VALUES(${literal(grant.id)},${literal(org)},${literal(workspace)},${literal(member)},${literal(principal)},${json(grant)});`);
    const candidate = options.shared?.candidate ?? "candidate_" + n,
      installation = options.shared?.installation ?? "installation_" + n;
    const proofPayload = options.shared?.proofPayload ?? {
      providerId: "shopify",
      applicationId: "synthetic_app",
      environmentId: "synthetic_env",
      shopId: "shop_" + n,
      installationId: installation,
      generation: 1,
      eligiblePrincipalId: principal,
    };
    const proof = options.shared?.proof ?? {
      id: "proof_" + n,
      revision: 1,
      digest: hash(canonicalize(proofPayload)),
    };
    const proofRef = {
      organizationId: org,
      workspaceId: workspace,
      storeId: null,
      kind: "proof",
      ...proof,
    };
    check(
      "fixture_" + n + "_proof_reference_valid_and_canonical",
      validateDefinition("core", "ProofRef", proofRef) &&
        proof.digest === hash(canonicalize(proofPayload)),
    );
    if (!options.shared)
      admin(
        `INSERT INTO morrow_identity.linking_candidates VALUES(${literal(candidate)},'shopify','synthetic_app','synthetic_env',${literal(proofPayload.shopId)},'synthetic-${n}.myshopify.com',${literal(installation)},1,true,${options.ownershipRevision ?? 1},'controlled_fixture',${literal(proof.id)},${proof.revision},${literal(proof.digest)},${literal(principal)},clock_timestamp()-interval '1 second',clock_timestamp()+interval '${options.proofSeconds ?? 3600} seconds',NULL);`,
      );
    const scopeRef = {
      organizationId: org,
      workspaceId: workspace,
      storeId: null,
      kind: "scope",
      id: "requested_scope_" + n,
      revision: 1,
      digest: hash(canonicalize(scope)),
    };
    const capabilityInput = { providerId: "shopify", installationProof: proofRef, scope: scopeRef };
    check(
      "fixture_" + n + "_capability_input_and_scope_ref_valid",
      validateCapabilityInput("governance.connection.connect", capabilityInput) &&
        validateDefinition("core", "ScopeRef", scopeRef),
    );
    const input = {
      handoffId: "handoff_" + n,
      commandId: "link_command_" + n,
      requestDigest: hash(
        canonicalize({
          operation,
          capabilityInput,
          requestedScope: scope,
          actor,
          sessionDigest: session,
          nonceDigest: nonce,
          organizationId: org,
          workspaceId: workspace,
          installationId: installation,
          purpose: options.purpose ?? "workspace_first",
          expectedPolicyRevision: options.policyRevision ?? 1,
          expectedOwnershipRevision: options.ownershipRevision ?? 1,
          commandId: "link_command_" + n,
          handoffId: "handoff_" + n,
        }),
      ),
      sessionDigest: session,
      nonceDigest: nonce,
      organizationId: org,
      workspaceId: workspace,
      installationId: installation,
      purpose: options.purpose ?? "workspace_first",
      expectedPolicyRevision: options.policyRevision ?? 1,
      expectedOwnershipRevision: options.ownershipRevision ?? 1,
    };
    const review = "review_" + n;
    admin(`INSERT INTO morrow_identity.linking_reviews(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,session_digest,nonce_digest,handoff_id,candidate_id,installation_id,generation,command_id,request_digest,purpose,expected_policy_revision,expected_ownership_revision,proof_id,proof_revision,proof_digest,scope_snapshot,evidence_kind,created_at,expires_at)
VALUES(${literal(review)},${literal(org)},${literal(workspace)},${literal(principal)},${literal(options.reviewMember ?? member)},${literal(options.reviewSession ?? session)},${literal(options.reviewNonce ?? nonce)},${literal(options.reviewHandoff ?? input.handoffId)},${literal(candidate)},${literal(installation)},1,${literal(input.commandId)},${literal(input.requestDigest)},${literal(input.purpose)},${input.expectedPolicyRevision},${input.expectedOwnershipRevision},${literal(proof.id)},${proof.revision},${literal(proof.digest)},${json(options.reviewBroaderGrant ? grant.scope : (options.reviewScope ?? scope))},'controlled_review',clock_timestamp()-interval '1 second',clock_timestamp()+interval '${options.reviewSeconds ?? 300} seconds');
INSERT INTO morrow_identity.linking_handoffs(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,session_digest,nonce_digest,candidate_id,installation_id,generation,command_id,request_digest,purpose,expected_policy_revision,expected_ownership_revision,proof_id,proof_revision,proof_digest,review_id,authorizing_grant_id,authorizing_grant_snapshot,requested_scope_snapshot,created_at,expires_at)
VALUES(${literal(input.handoffId)},${literal(org)},${literal(workspace)},${literal(principal)},${literal(member)},${literal(session)},${literal(nonce)},${literal(candidate)},${literal(installation)},1,${literal(input.commandId)},${literal(input.requestDigest)},${literal(input.purpose)},${input.expectedPolicyRevision},${input.expectedOwnershipRevision},${literal(proof.id)},${proof.revision},${literal(proof.digest)},${literal(review)},${literal(grant.id)},${json(grant)},${json(scope)},clock_timestamp(),clock_timestamp()+interval '${options.handoffSeconds ?? 299} seconds');`);
    return {
      n,
      input,
      org,
      workspace,
      principal,
      member,
      actor,
      resource,
      scope,
      grant,
      review,
      candidate,
      installation,
      proof,
      proofPayload,
    };
  }
  const count = (f) =>
    admin(
      `SELECT count(*) FROM morrow_identity.workspace_link_results WHERE handoff_id=${literal(f.input.handoffId)};`,
    );
  const reason = (f) =>
    admin(
      `SELECT reason FROM morrow_identity.workspace_link_results WHERE handoff_id=${literal(f.input.handoffId)};`,
    );
  const links = (f) =>
    admin(
      `SELECT count(*) FROM morrow_identity.workspace_store_links WHERE candidate_id=${literal(f.candidate)};`,
    );
  const rawArgs = (input) =>
    Object.values(input)
      .map((x) => literal(String(x)))
      .join(",");
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
        reject(Error("LINKING_LOCK_BARRIER_FAILED"));
      }, 5000);
      child.on("error", () => {
        clearTimeout(timer);
        reject(Error("LINKING_LOCK_BARRIER_FAILED"));
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("LINKING_LOCK_READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    });
    child.stdin.write(
      "BEGIN; SET ROLE morrow_identity_owner; " + lockSql + ";\n\\echo LINKING_LOCK_READY\n",
    );
    await ready;
    return {
      async release(mutate = "") {
        child.stdin.end(mutate + "\nCOMMIT;\n");
        if ((await done) !== 0 || stderr || secrets.some((p) => stdout.includes(p)))
          throw Error("LINKING_LOCK_RELEASE_FAILED");
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
            "SELECT count(DISTINCT a.pid) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND a.usename='morrow_identity_linking';",
            "morrow",
          ),
        ) >= expected
      )
        return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error("LINKING_CALL_NOT_BLOCKED");
  }
  async function waitingCase(
    name,
    table,
    predicate,
    mutation,
    expectedReason,
    options = {},
    expiryQuery = null,
  ) {
    const f = await fixture(options),
      h = await holder(`SELECT 1 FROM morrow_identity.${table} WHERE ${predicate(f)} FOR UPDATE`);
    const pending = apply(f.input);
    try {
      await waitBlocked();
      if (expiryQuery) {
        while (admin(expiryQuery(f)) === "t") await new Promise((r) => setTimeout(r, 30));
      }
      await h.release(mutation(f));
      const result = await pending;
      check(
        name,
        result.outcome === "denied" &&
          result.auditId !== null &&
          reason(f) === expectedReason &&
          links(f) === "0" &&
          count(f) === "1",
      );
    } catch (error) {
      try {
        console.error("LOCAL_LAB_WAITING_CASE " + localPostgresWaitingCaseDiagnostic(name));
      } catch {
        // Preserve the original failure even when the diagnostic sink fails.
      }
      throw error;
    } finally {
      await h.close();
    }
  }
  try {
    const first = await fixture({ broadGrant: true }),
      result = await apply(first.input);
    check(
      "first_claim_atomically_links_consumes_and_audits",
      result.outcome === "applied" &&
        result.policyRevision === 2 &&
        result.ownershipRevision === 2 &&
        result.linkId &&
        result.auditId &&
        links(first) === "1" &&
        count(first) === "1",
    );
    check(
      "exact_replay_returns_original_without_new_effect",
      JSON.stringify(await apply(first.input)) === JSON.stringify(result) && count(first) === "1",
    );
    check(
      "association_owns_exact_tenant_and_subject",
      admin(
        `SELECT organization_id::text||'|'||workspace_id::text||'|'||installation_id::text FROM morrow_identity.workspace_store_links WHERE id=${literal(result.linkId)};`,
      ) === `${first.org}|${first.workspace}|${first.installation}`,
    );
    const foreign = await fixture();
    for (const [name, patch] of [
      ["handoff", { handoffId: "missing" }],
      ["organization", { organizationId: foreign.org }],
      ["workspace", { workspaceId: foreign.workspace }],
      ["installation", { installationId: foreign.installation }],
      ["session", { sessionDigest: foreign.input.sessionDigest }],
      ["nonce", { nonceDigest: foreign.input.nonceDigest }],
      ["purpose", { purpose: "install_first" }],
      ["policy", { expectedPolicyRevision: 2 }],
      ["ownership", { expectedOwnershipRevision: 2 }],
      ["command", { commandId: "changed" }],
      ["digest", { requestDigest: "f".repeat(64) }],
    ]) {
      const x = await apply({ ...first.input, ...patch });
      check(
        "changed_" + name + "_cannot_disclose_or_mutate",
        x.outcome !== "applied" &&
          x.linkId === null &&
          x.ownershipRevision === null &&
          x.auditId === null &&
          x.policyRevision === null &&
          count(first) === "1",
      );
    }
    for (const purpose of ["install_first", "existing_account", "additional_store"]) {
      const f = await fixture({ purpose });
      check(purpose + "_first_claim_allowed", (await apply(f.input)).outcome === "applied");
    }
    const unsupported = await fixture({ purpose: "cross_host_resume" });
    check(
      "cross_host_resume_denies_first_claim",
      (await apply(unsupported.input)).outcome === "denied" &&
        reason(unsupported) === "purpose_denied" &&
        links(unsupported) === "0",
    );
    check(
      "exact_denied_replay_returns_same_own_audit",
      JSON.stringify(await apply(unsupported.input)) ===
        JSON.stringify(await apply(unsupported.input)) && count(unsupported) === "1",
    );
    for (const [name, change] of [
      [
        "invited_without_current_whole_grant",
        (f) =>
          `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{scope,fields}','["providerId"]'::jsonb) WHERE id=${literal(f.grant.id)};`,
      ],
      [
        "proof_revision",
        (f) =>
          `UPDATE morrow_identity.linking_candidates SET proof_revision=2 WHERE id=${literal(f.candidate)};`,
      ],
      [
        "proof_digest",
        (f) =>
          `UPDATE morrow_identity.linking_candidates SET proof_digest=repeat('e',64) WHERE id=${literal(f.candidate)};`,
      ],
      [
        "proof_subject",
        (f) =>
          `UPDATE morrow_identity.linking_candidates SET eligible_principal_id=${literal(first.principal)} WHERE id=${literal(f.candidate)};`,
      ],
      [
        "reinstall_generation",
        (f) =>
          `UPDATE morrow_identity.linking_candidates SET generation=2,installation_id='reinstalled_'||id WHERE id=${literal(f.candidate)};`,
      ],
      [
        "uninstalled",
        (f) =>
          `UPDATE morrow_identity.linking_candidates SET active=false WHERE id=${literal(f.candidate)};`,
      ],
      [
        "current_ownership_revision",
        (f) =>
          `UPDATE morrow_identity.linking_candidates SET ownership_revision=2 WHERE id=${literal(f.candidate)};`,
      ],
    ]) {
      const f = await fixture();
      admin(change(f));
      const r = await apply(f.input);
      check(
        name + "_denies_without_link",
        r.outcome === "denied" &&
          r.linkId === null &&
          r.ownershipRevision === null &&
          links(f) === "0",
      );
    }
    const wrongReview = await fixture({ reviewScope: first.scope });
    check(
      "review_cannot_approve_other_request_scope",
      (await apply(wrongReview.input)).outcome === "denied" &&
        reason(wrongReview) === "review_invalid",
    );
    for (const [name, opts] of [
      ["session", { reviewSession: foreign.input.sessionDigest }],
      ["membership", { reviewMember: foreign.member }],
      ["nonce", { reviewNonce: foreign.input.nonceDigest }],
      ["handoff", { reviewHandoff: foreign.input.handoffId }],
      ["broader_grant_scope", { broadGrant: true, reviewBroaderGrant: true }],
    ]) {
      const f = await fixture(opts),
        r = await apply(f.input);
      check(
        "same_actor_review_" + name + "_binding_denies",
        r.outcome === "denied" &&
          reason(f) === "review_invalid" &&
          links(f) === "0" &&
          count(f) === "1",
      );
    }
    for (const [name, opts] of [
      ["policy", { policyRevision: 9007199254740991 }],
      ["ownership", { ownershipRevision: 9007199254740991 }],
    ]) {
      const f = await fixture(opts);
      check(
        name + "_overflow_denies",
        (await apply(f.input)).outcome === "denied" && reason(f) === "revision_exhausted",
      );
    }
    const duplicate = await fixture(),
      hold = await holder(
        `SELECT 1 FROM morrow_identity.organizations WHERE id=${literal(duplicate.org)} FOR UPDATE`,
      );
    const dup = [apply(duplicate.input), apply(duplicate.input)];
    try {
      await waitBlocked(2);
      await hold.release();
      const rs = await Promise.all(dup);
      check(
        "simultaneous_duplicate_one_effect_and_original_results",
        rs.every((r) => r.outcome === "applied") &&
          JSON.stringify(rs[0]) === JSON.stringify(rs[1]) &&
          links(duplicate) === "1" &&
          count(duplicate) === "1",
      );
    } finally {
      await hold.close();
    }
    const one = await fixture(),
      two = await fixture({ shared: one }),
      globalLock = await holder(
        `SELECT 1 FROM morrow_identity.linking_candidates WHERE id=${literal(one.candidate)} FOR UPDATE`,
      );
    const competing = [apply(one.input), apply(two.input)];
    try {
      await waitBlocked(2);
      await globalLock.release();
      const rs = await Promise.all(competing);
      check(
        "two_organizations_claim_one_stable_shop_one_winner",
        rs.filter((r) => r.outcome === "applied").length === 1 &&
          rs.filter((r) => r.outcome === "denied").length === 1 &&
          links(one) === "1" &&
          count(one) === "1" &&
          count(two) === "1" &&
          [reason(one), reason(two)].sort().join("|") === "applied|ownership_conflict" &&
          admin(
            `SELECT ownership_revision FROM morrow_identity.linking_candidates WHERE id=${literal(one.candidate)};`,
          ) === "2",
      );
    } finally {
      await globalLock.close();
    }
    const fresh = await fixture({ shared: first, ownershipRevision: 2 });
    check(
      "fresh_command_cannot_reassign_owned_shop",
      (await apply(fresh.input)).outcome === "denied" &&
        reason(fresh) === "ownership_conflict" &&
        links(first) === "1",
    );
    const sameOwner = await fixture({
      shared: first,
      sameWorkspace: first,
      policyRevision: 2,
      ownershipRevision: 2,
    });
    check(
      "fresh_command_same_workspace_cannot_reclaim",
      (await apply(sameOwner.input)).outcome === "denied" &&
        reason(sameOwner) === "ownership_conflict" &&
        links(first) === "1",
    );
    const stable = exec(
      `SET ROLE morrow_identity_owner; INSERT INTO morrow_identity.linking_candidates SELECT 'duplicate_subject',provider_id,application_id,environment_id,shop_id,shop_domain,'different_installation',2,true,1,proof_kind,'different_proof',2,proof_digest,eligible_principal_id,proof_created_at,proof_expires_at,NULL FROM morrow_identity.linking_candidates WHERE id=${literal(first.candidate)};`,
      "postgres",
      true,
    );
    check(
      "stable_shop_uniqueness_survives_new_installation_generation",
      stable.status !== 0 && stable.stderr.includes("23505"),
    );
    for (const [name, table, key] of [
      ["organization", "organizations", "org"],
      ["principal", "principals", "principal"],
      ["workspace", "workspaces", "workspace"],
      ["organization_membership", "memberships", "member"],
    ]) {
      await waitingCase(
        name + "_revocation_after_lock_wait",
        table,
        (f) => `id=${literal(f[key])}`,
        (f) => `UPDATE morrow_identity.${table} SET active=false WHERE id=${literal(f[key])};`,
        "actor_ineligible",
      );
    }
    await waitingCase(
      "review_revocation_after_lock_wait",
      "linking_reviews",
      (f) => `id=${literal(f.review)}`,
      (f) =>
        `UPDATE morrow_identity.linking_reviews SET revoked_at=clock_timestamp() WHERE id=${literal(f.review)};`,
      "review_invalid",
    );
    await waitingCase(
      "proof_revocation_after_lock_wait",
      "linking_candidates",
      (f) => `id=${literal(f.candidate)}`,
      (f) =>
        `UPDATE morrow_identity.linking_candidates SET proof_revoked_at=clock_timestamp() WHERE id=${literal(f.candidate)};`,
      "proof_invalid",
    );
    await waitingCase(
      "session_revocation_after_lock_wait",
      "sessions",
      (f) => `session_digest=${literal(f.input.sessionDigest)}`,
      (f) =>
        `UPDATE morrow_identity.sessions SET revoked_at=clock_timestamp() WHERE session_digest=${literal(f.input.sessionDigest)};`,
      "actor_ineligible",
    );
    await waitingCase(
      "membership_departure_after_lock_wait",
      "workspace_memberships",
      (f) => `workspace_id=${literal(f.workspace)}`,
      (f) =>
        `UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id=${literal(f.workspace)};`,
      "actor_ineligible",
    );
    await waitingCase(
      "grant_drift_after_lock_wait",
      "grants",
      (f) => `id=${literal(f.grant.id)}`,
      (f) =>
        `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb('2020-01-01T00:00:00.000Z'::text)) WHERE id=${literal(f.grant.id)};`,
      "grant_changed",
    );
    for (const [name, options, table, pred, expiry, why] of [
      [
        "handoff",
        { handoffSeconds: 2 },
        "linking_handoffs",
        (f) => `id=${literal(f.input.handoffId)}`,
        (f) =>
          `SELECT expires_at>clock_timestamp() FROM morrow_identity.linking_handoffs WHERE id=${literal(f.input.handoffId)};`,
        "handoff_expired",
      ],
      [
        "review",
        { reviewSeconds: 2 },
        "linking_reviews",
        (f) => `id=${literal(f.review)}`,
        (f) =>
          `SELECT expires_at>clock_timestamp() FROM morrow_identity.linking_reviews WHERE id=${literal(f.review)};`,
        "review_invalid",
      ],
      [
        "proof",
        { proofSeconds: 2 },
        "linking_candidates",
        (f) => `id=${literal(f.candidate)}`,
        (f) =>
          `SELECT proof_expires_at>clock_timestamp() FROM morrow_identity.linking_candidates WHERE id=${literal(f.candidate)};`,
        "proof_invalid",
      ],
      [
        "session",
        { sessionSeconds: 2 },
        "sessions",
        (f) => `session_digest=${literal(f.input.sessionDigest)}`,
        (f) =>
          `SELECT expires_at>clock_timestamp() FROM morrow_identity.sessions WHERE session_digest=${literal(f.input.sessionDigest)};`,
        "actor_ineligible",
      ],
      [
        "grant",
        { grantSeconds: 2 },
        "grants",
        (f) => `id=${literal(f.grant.id)}`,
        (f) =>
          `SELECT (payload->>'expiresAt')::timestamptz>clock_timestamp() FROM morrow_identity.grants WHERE id=${literal(f.grant.id)};`,
        "grant_changed",
      ],
    ])
      await waitingCase(name + "_expiry_after_wait", table, pred, () => "", why, options, expiry);
    // Committed replay must not survive current authority or subject changes.
    for (const [name, mutate] of [
      [
        "review_revoked",
        (f) =>
          `UPDATE morrow_identity.linking_reviews SET revoked_at=clock_timestamp() WHERE id=${literal(f.review)};`,
      ],
      [
        "proof_revoked",
        (f) =>
          `UPDATE morrow_identity.linking_candidates SET proof_revoked_at=clock_timestamp() WHERE id=${literal(f.candidate)};`,
      ],
      [
        "generation_changed",
        (f) =>
          `UPDATE morrow_identity.linking_candidates SET generation=2,installation_id='again_'||id WHERE id=${literal(f.candidate)};`,
      ],
      [
        "uninstalled",
        (f) =>
          `UPDATE morrow_identity.linking_candidates SET active=false WHERE id=${literal(f.candidate)};`,
      ],
      [
        "ownership_invalidated",
        (f) =>
          `UPDATE morrow_identity.linking_candidates SET ownership_revision=3 WHERE id=${literal(f.candidate)};`,
      ],
      [
        "session_expired",
        (f) =>
          `UPDATE morrow_identity.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_digest=${literal(f.input.sessionDigest)};`,
      ],
      [
        "member_revoked",
        (f) =>
          `UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id=${literal(f.workspace)};`,
      ],
    ]) {
      const f = await fixture();
      check(name + "_precondition_commits", (await apply(f.input)).outcome === "applied");
      admin(mutate(f));
      const r = await apply(f.input);
      check(
        name + "_cannot_replay_private_result",
        r.outcome === "denied" && r.auditId === null && r.linkId === null && count(f) === "1",
      );
    }
    const old = await fixture({ handoffSeconds: 2, reviewSeconds: 2 });
    const oldResult = await apply(old.input);
    while (
      admin(
        `SELECT expires_at>clock_timestamp() FROM morrow_identity.linking_handoffs WHERE id=${literal(old.input.handoffId)};`,
      ) === "t"
    )
      await new Promise((r) => setTimeout(r, 30));
    check(
      "historical_handoff_review_ttl_cannot_cause_second_effect",
      JSON.stringify(await apply(old.input)) === JSON.stringify(oldResult) && count(old) === "1",
    );
    const orphan = await fixture();
    admin(
      `UPDATE morrow_identity.linking_handoffs SET consumed_at=clock_timestamp() WHERE id=${literal(orphan.input.handoffId)};`,
    );
    check(
      "consumed_without_result_fails_closed",
      (await apply(orphan.input)).auditId === null &&
        count(orphan) === "0" &&
        links(orphan) === "0",
    );
    const rollback = await fixture();
    admin(
      "CREATE FUNCTION morrow_identity.fail_link_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END $$; CREATE TRIGGER fault_link_audit BEFORE INSERT ON morrow_identity.workspace_link_results FOR EACH ROW EXECUTE FUNCTION morrow_identity.fail_link_audit();",
    );
    let unavailable = false;
    try {
      await apply(rollback.input);
    } catch (error) {
      unavailable = error.code === "WORKSPACE_LINKING_UNAVAILABLE";
    }
    check(
      "audit_write_failure_rolls_back_all_effects",
      unavailable &&
        links(rollback) === "0" &&
        count(rollback) === "0" &&
        admin(
          `SELECT consumed_at IS NULL FROM morrow_identity.linking_handoffs WHERE id=${literal(rollback.input.handoffId)};`,
        ) === "t" &&
        admin(
          `SELECT ownership_revision FROM morrow_identity.linking_candidates WHERE id=${literal(rollback.candidate)};`,
        ) === "1" &&
        admin(
          `SELECT policy_revision FROM morrow_identity.organizations WHERE id=${literal(rollback.org)};`,
        ) === "1",
    );
    admin(
      "DROP TRIGGER fault_link_audit ON morrow_identity.workspace_link_results; DROP FUNCTION morrow_identity.fail_link_audit();",
    );
    const transaction = await fixture();
    exec(
      `BEGIN; SELECT outcome FROM morrow_identity.link_workspace_store(${rawArgs(transaction.input)}); ROLLBACK;`,
    );
    check(
      "explicit_transaction_rollback_preserves_unclaimed_subject",
      links(transaction) === "0" &&
        count(transaction) === "0" &&
        admin(
          `SELECT policy_revision FROM morrow_identity.organizations WHERE id=${literal(transaction.org)};`,
        ) === "1" &&
        admin(
          `SELECT ownership_revision FROM morrow_identity.linking_candidates WHERE id=${literal(transaction.candidate)};`,
        ) === "1",
    );
    const uncertain = await fixture();
    let dropped = false;
    const loss = createWorkspaceStoreLinks({
      async connect() {
        const client = await pool.connect();
        return {
          query: async (text, values) => {
            const result = await client.query(text, values);
            if (text === workspaceStoreLinkingSql.commit && !dropped) {
              dropped = true;
              throw Error("SYNTHETIC_COMMIT_ACK_LOSS");
            }
            return result;
          },
          release: (value) => client.release(value),
        };
      },
    });
    let unknown = false;
    try {
      await loss.apply(JSON.stringify(uncertain.input));
    } catch (error) {
      unknown =
        error.code === "WORKSPACE_LINKING_UNCERTAIN" &&
        error.commandId === uncertain.input.commandId;
    }
    check(
      "lost_actual_commit_ack_is_uncertain",
      unknown && links(uncertain) === "1" && count(uncertain) === "1",
    );
    const reconciled = await apply(uncertain.input);
    check(
      "unknown_commit_reconciles_original_without_duplicate",
      reconciled.outcome === "applied" && count(uncertain) === "1",
    );
    for (const role of ["morrow_api", "morrow_identity_lifecycle", "morrow_identity_linking"]) {
      for (const table of [
        "linking_candidates",
        "linking_reviews",
        "linking_handoffs",
        "workspace_store_links",
        "workspace_link_results",
      ]) {
        for (const statement of [
          `SELECT * FROM morrow_identity.${table}`,
          `INSERT INTO morrow_identity.${table} DEFAULT VALUES`,
          `UPDATE morrow_identity.${table} SET id=id`,
          `DELETE FROM morrow_identity.${table}`,
        ]) {
          const r = exec(statement + ";", role, true);
          check(
            role + "_private_" + statement.split(" ")[0] + "_" + table,
            r.status !== 0 && r.stderr.includes("42501"),
          );
        }
      }
      for (const target of [
        "morrow_identity_owner",
        ...(role === "morrow_identity_linking" ? [] : ["morrow_identity_linking"]),
      ]) {
        const r = exec(`SET ROLE ${target};`, role, true);
        check(role + "_cannot_assume_" + target, r.status !== 0 && r.stderr.includes("42501"));
      }
      if (role !== "morrow_identity_linking") {
        const r = exec(
          `SELECT * FROM morrow_identity.link_workspace_store(${rawArgs(first.input)});`,
          role,
          true,
        );
        check(role + "_cannot_execute_link_function", r.status !== 0 && r.stderr.includes("42501"));
      }
    }
    sql("GRANT morrow_identity_linking TO morrow_api;");
    for (const login of ["morrow_api", "morrow_identity_linking"]) {
      const r = exec(
        `SET ROLE morrow_identity_linking; SELECT outcome||'|'||COALESCE(audit_id,'null') FROM morrow_identity.link_workspace_store(${rawArgs(first.input)});`,
        login,
      );
      check(login + "_unsafe_membership_direct_definer_denies", r.stdout.trim() === "denied|null");
    }
    sql("REVOKE morrow_identity_linking FROM morrow_api;");
    check(
      "owner_session_cannot_execute_dedicated_operation",
      exec(
        `SET ROLE morrow_identity_owner; SELECT outcome||'|'||COALESCE(audit_id,'null') FROM morrow_identity.link_workspace_store(${rawArgs(first.input)});`,
        "postgres",
      ).stdout.trim() === "denied|null",
    );
    check(
      "public_has_no_link_function_execute",
      sql(
        "SELECT NOT EXISTS(SELECT 1 FROM pg_proc p,aclexplode(p.proacl) a WHERE p.pronamespace='morrow_identity'::regnamespace AND p.proname='link_workspace_store' AND a.grantee=0 AND a.privilege_type='EXECUTE');",
        "morrow",
      ) === "t",
    );
    for (const [table, key] of [
      ["linking_handoffs", first.input.handoffId],
      ["linking_reviews", first.review],
      ["workspace_store_links", result.linkId],
      ["workspace_link_results", result.auditId],
    ]) {
      for (const statement of [
        `UPDATE morrow_identity.${table} SET id='replacement' WHERE id=${literal(key)}`,
        `DELETE FROM morrow_identity.${table} WHERE id=${literal(key)}`,
      ]) {
        const r = exec("SET ROLE morrow_identity_owner; " + statement + ";", "postgres", true);
        check(
          table + "_immutable_" + statement.split(" ")[0],
          r.status !== 0 && r.stderr.includes("LINKING_RECORD_IMMUTABLE"),
        );
      }
    }
    const stableEdit = exec(
      `SET ROLE morrow_identity_owner; UPDATE morrow_identity.linking_candidates SET shop_id='another' WHERE id=${literal(first.candidate)};`,
      "postgres",
      true,
    );
    check(
      "stable_subject_identity_cannot_change",
      stableEdit.status !== 0 && stableEdit.stderr.includes("LINKING_RECORD_IMMUTABLE"),
    );
    check(
      "five_new_tables_force_rls",
      sql(
        "SELECT count(*) FROM pg_class WHERE relnamespace='morrow_identity'::regnamespace AND relname IN ('linking_candidates','linking_reviews','linking_handoffs','workspace_store_links','workspace_link_results') AND relrowsecurity AND relforcerowsecurity;",
        "morrow",
      ) === "5",
    );
    // Independent rollback database: old immutable migrations, then an injected
    // failure inside migration5's transaction must leave none of its objects.
    sql(
      "GRANT CREATE ON DATABASE morrow_linking_rollback TO morrow_identity_owner; ALTER ROLE morrow_identity_linking NOLOGIN; ALTER ROLE morrow_identity_lifecycle NOLOGIN;",
    );
    for (const m of migrations.slice(0, 4))
      sql("SET ROLE morrow_identity_owner;\n" + m.text, "morrow_linking_rollback");
    const injected = migrations[4].text.replace(/COMMIT;\s*$/, "SELECT 1/0;\nCOMMIT;");
    const failed = exec(
      "SET ROLE morrow_identity_owner;\n" + injected,
      "postgres",
      true,
      "morrow_linking_rollback",
    );
    check(
      "migration_failure_rolls_back_all_new_objects",
      failed.status !== 0 &&
        sql(
          "SELECT to_regclass('morrow_identity.linking_candidates') IS NULL AND to_regprocedure('morrow_identity.link_workspace_store(text,text,text,text,text,text,text,text,text,text,text)') IS NULL;",
          "morrow_linking_rollback",
        ) === "t",
    );
    sql("GRANT morrow_identity_linking TO morrow_api;");
    const unsafe = exec(
      "SET ROLE morrow_identity_owner;\n" + migrations[4].text,
      "postgres",
      true,
      "morrow_linking_rollback",
    );
    check(
      "unsafe_preexisting_executor_membership_rejected",
      unsafe.status !== 0 && unsafe.stderr.includes("LINKING_ROLE_PREREQUISITES_INVALID"),
    );
    sql("REVOKE morrow_identity_linking FROM morrow_api;");
    check(
      "no_proof_or_session_in_application_sql_output",
      pool.observed.every(
        (o) => !secrets.some((secret) => o.stdout.includes(secret) || o.stderr.includes(secret)),
      ),
    );
    return { image, version };
  } finally {
    await pool.close();
  }
});
const sources = [
  "migrations/0005.workspace-store-linking.sql",
  "infra/identity-role-prerequisites.sql",
  "packages/identity/src/workspace-store-linking.ts",
  "scripts/local-store-linking-sql.mjs",
  "scripts/workspace-store-linking-lab.mjs",
];
writeArtifact(
  "labs/workspace-store-linking.json",
  JSON.stringify(
    {
      task: "P05.T03a",
      observed_at: new Date().toISOString(),
      scope:
        "Actual isolated PostgreSQL with controlled fixture proofs/reviews only; no production issuer, provider authentication, merchant data or public route",
      ...observed,
      checks,
      migrations: migrations.map(({ record }) => ({
        sequence: record.sequence,
        file: record.file,
        sha256: record.sha256,
      })),
      limitations: [
        "Only the preserved migrations1–9 are installed; migration10 login custody is not installed or qualified by this regression.",
      ],
      source_digests: Object.fromEntries(sources.map((p) => [p, hash(readFileSync(p))])),
    },
    null,
    2,
  ) + "\n",
);
console.log(`PASS: ${checks.length} actual PostgreSQL workspace-store linking checks.`);
