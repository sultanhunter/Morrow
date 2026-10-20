// M2 PR-1 PostgreSQL 17 laboratory: the spine foundation (migrations 0019-0024) on an
// isolated network-none engine with the full manifest applied by the Neon-shaped
// non-superuser CREATEROLE administrator (ADR-0020 D4, the hosted shape). It proves the
// lease context (its entry proof, and revocation at membership removal), that stops block
// admission (including both race orders), the operation
// state machine and its send fence, that vault rows are unreadable to every role but the
// broker's login (with the broker's own AES-256-GCM envelopes and the owner script's
// apply statement), and the billing route's creation and immutability rules. Part 2's
// TypeScript helpers run here too: the runtime lease steps as morrow_runtime_executor,
// StopRecord@1 and the stop_active twin, and the billing route row mapping (T, R6).
// Owner-seeded synthetic fixtures only; no provider,
// credential or merchant data. Runs in the CI pg-work group. The local superuser is used
// only for fixtures, the lab-only probe definers and the shapes marked "sim".
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createVaultKeyring,
  openVaultRecord,
  readAppSecret,
  sealVaultRecord,
} from "../apps/broker/src/vault.ts";
import {
  billingRouteForCreation,
  effectiveBillingOrigin,
  workspaceBillingRouteFromRow,
} from "../packages/work/src/billing-route.ts";
import {
  createRuntimeAttempt,
  listPendingStarts,
  runLeaseStep,
} from "../packages/work/src/runtime/leases.ts";
import { spineStatements } from "../packages/work/src/spine-sql.ts";
import { stopBlocks, stopRecordFromRow } from "../packages/work/src/stops.ts";
import {
  asApi,
  asCommandRole,
  createLocalWorkConnector,
  literal,
  restoreSql,
  revocationSql,
  seedWorkFixtures,
  sleep,
  withWorkDatabase,
} from "../tests/tenant-conformance/harness.mjs";
import { writeArtifact } from "./artifacts.mjs";
import { appSecretPutStatement, sealAppSecret } from "./vault.mjs";

const transitionsJson = JSON.parse(readFileSync("docs/contracts/state-transitions.json", "utf8"));
const checks = [];
const failures = [];
function check(name, passed, detail) {
  if (!/^[A-Z][0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("SPINE_LAB_CHECK_NAME:" + name);
  checks.push({ name, passed: passed === true });
  if (passed !== true) {
    failures.push(name);
    console.error(
      "CHECK_FAILED " + name + (detail === undefined ? "" : " " + JSON.stringify(detail)),
    );
  }
}
const last = (out) => (Array.isArray(out) ? out : out.split("\n")).at(-1);
const ms = "date_trunc('milliseconds',clock_timestamp())";
// One instant per transaction, for inserts whose triggers require created_at=updated_at:
// two clock_timestamp() calls can straddle a millisecond on a loaded host.
const txMs = "date_trunc('milliseconds',transaction_timestamp())";
// The part-1 entry marker, which the runtime login can compute for itself: the forged
// entry checks (L3) prove it no longer resolves a lease.
const marker =
  "(extract(epoch FROM transaction_timestamp())*1000000)::bigint::text||':'||pg_backend_pid()::text";
const uuid = () => randomUUID();
// A psql session that runs in the background under its own application name, with a kill
// timer long enough for a loaded host (the shared psqlAsync allows 60 s). It resolves with
// its exit status and output; the gate session is ended by pg_terminate_backend.
function background(id, text, applicationName, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "--env",
        "PGAPPNAME=" + applicationName,
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
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", () => {});
    child.on("error", () => {});
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim() });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

// Lab-only definers, created by the local superuser as scaffolding (not migration
// objects). lease_view and lease_transition stand in for the runtime definers of M3/M4:
// owned by the command role, they act only through the tenant_lease policies.
// vault_count is a command-owned definer any login may call; only the broker's session
// sees vault rows through it.
const probes = `CREATE SCHEMA lab_probe;
CREATE FUNCTION lab_probe.lease_view() RETURNS TABLE(organization_id text,operations bigint,transitions bigint,stops bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT (SELECT c.organization_id FROM morrow_work.current_lease() c),(SELECT count(*) FROM morrow_work.operations),
  (SELECT count(*) FROM morrow_work.operation_transitions),(SELECT count(*) FROM morrow_work.stop_controls) $$;
CREATE FUNCTION lab_probe.lease_transition(p_operation text,p_expected bigint,p_to text,p_actor text,p_guard text,p_reason text,p_uncertainty text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE l record; r record;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND THEN RETURN 'denied'; END IF;
 SELECT * INTO r FROM morrow_work.operation_transition(l.organization_id,l.workspace_id,p_operation,p_expected,p_to,p_actor,p_guard,p_reason,p_uncertainty,l.lease_id);
 RETURN r.outcome;
END $$;
CREATE FUNCTION lab_probe.vault_count() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT (SELECT count(*) FROM morrow_vault.app_secrets)+(SELECT count(*) FROM morrow_vault.credentials) $$;
ALTER FUNCTION lab_probe.lease_view() OWNER TO morrow_work_command;
ALTER FUNCTION lab_probe.lease_transition(text,bigint,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION lab_probe.vault_count() OWNER TO morrow_work_command;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lab_probe FROM PUBLIC;
GRANT USAGE ON SCHEMA lab_probe TO morrow_runtime_executor,morrow_api_worker,morrow_vault_broker,morrow_connector_ingress;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lab_probe TO morrow_runtime_executor,morrow_api_worker,morrow_vault_broker,morrow_connector_ingress;`;

export async function runSpineFoundationLab(db) {
  const P = seedWorkFixtures(db);
  db.sql(probes);
  const as = (user) => (text) => db.sql(text, { user });
  const runtime = as("morrow_runtime_executor");
  const attempt = (text, user = "postgres") => db.tryRun(text, { user });
  const refused = (text, code, user = "postgres") => {
    const r = attempt(text, user);
    return !r.ok && new RegExp(code).test(r.stderr);
  };
  // The command role in a principal's session context, then the caller's statements; the
  // first output line is the context's set_config row.
  const cmd = (p, statements, end = "ROLLBACK") =>
    db
      .sql(asCommandRole(p, statements, { end }))
      .split("\n")
      .slice(1);
  const openLease = (p, kind, subject, o = {}) => {
    const [line] = cmd(
      p,
      `SELECT concat_ws('|',outcome,lease_id,generation,expires_at_ms) FROM morrow_work.lease_open(${literal(kind)},${literal(subject)},${literal(o.store ?? "store_1")},${literal(o.connection ?? "connection_1")},${o.installation === null || kind === "read" ? "NULL" : literal(o.installation ?? "installation_1")});`,
      "COMMIT",
    );
    const [outcome, id, generation, expires] = line.split("|");
    return { outcome, id, generation, expires };
  };
  const enter = (id, generation = "1") =>
    `SELECT outcome FROM morrow_work.enter_lease(${literal(id)},${literal(generation)});`;
  const entered = (id, generation) => last(runtime(`BEGIN; ${enter(id, generation)} ROLLBACK;`));
  const lease = (id) =>
    db.rows(
      `SELECT kind,status,revoked_reason,generation::text,started_at IS NOT NULL AS started,ended_at IS NOT NULL AS ended,(expires_at-created_at)::text AS term FROM morrow_work.work_leases WHERE id=${literal(id)}`,
    )[0];
  const pending = () =>
    runtime(
      "SELECT kind||'|'||subject_id||'|'||lease_id||'|'||generation FROM morrow_work.pending_starts();",
    )
      .split("\n")
      .filter(Boolean);

  // ---------------------------------------------------------------------------
  // L: the lease context (spine §5; ADR-0022 item 9).
  {
    const read = openLease(P.A, "read", "l_read_1", { installation: null });
    const run = openLease(P.A, "run", "l_run_1");
    const operation = openLease(P.A, "operation", "l_claim_1");
    check(
      "L1:opened_in_session",
      [read, run, operation].every((l) => l.outcome === "opened" && l.generation === "1"),
    );
    check(
      "L1:terms_read_60s_run_30min_operation_15min",
      lease(read.id).term === "00:01:00" &&
        lease(run.id).term === "00:30:00" &&
        lease(operation.id).term === "00:15:00",
    );
    check(
      "L1:one_lease_per_subject",
      openLease(P.A, "run", "l_run_1").outcome === "subject_conflict",
    );
    check(
      "L1:invalid_shapes",
      last(
        cmd(
          P.A,
          "SELECT outcome FROM morrow_work.lease_open('read','x','s','c','installation_1');",
        ),
      ) === "invalid" &&
        last(cmd(P.A, "SELECT outcome FROM morrow_work.lease_open('run','x','s','c',NULL);")) ===
          "invalid" &&
        last(cmd(P.A, "SELECT outcome FROM morrow_work.lease_open('write','x','s','c','i');")) ===
          "invalid",
    );
    // Without a session context (the command role alone, or a forged digest) nothing opens.
    check(
      "L1:no_session_no_lease",
      last(
        db.sql(
          "BEGIN; SET LOCAL ROLE morrow_work_command; SELECT outcome FROM morrow_work.lease_open('run','l_x','s','c','i'); ROLLBACK;",
        ),
      ) === "ineligible" &&
        last(
          db.sql(
            `BEGIN; SELECT set_config('morrow.work_session_digest',${literal("0".repeat(64))},true),set_config('morrow.work_workspace',${literal(P.A.workspace)},true) IS NOT NULL; SET LOCAL ROLE morrow_work_command; SELECT outcome FROM morrow_work.lease_open('run','l_x','s','c','i'); ROLLBACK;`,
          ),
        ) === "ineligible",
    );
    // lease_open is a helper: no login may call it directly.
    check(
      "L1:helper_granted_to_nobody",
      refused(
        asApi(P.A, "SELECT * FROM morrow_work.lease_open('run','l_y','s','c','i');"),
        "permission denied",
        "morrow_api_worker",
      ) &&
        refused(
          "SELECT * FROM morrow_work.lease_open('run','l_y','s','c','i');",
          "permission denied",
          "morrow_runtime_executor",
        ),
    );
    const foreign = openLease(P.Y, "run", "l_run_y");
    const listed = pending();
    check(
      "L2:pending_starts_ids_only_runs_and_claims_across_tenants",
      listed.includes(`run|l_run_1|${run.id}|1`) &&
        listed.includes(`operation|l_claim_1|${operation.id}|1`) &&
        listed.includes(`run|l_run_y|${foreign.id}|1`) &&
        !listed.some((l) => l.includes(read.id)),
      listed,
    );
    check(
      "L2:pending_starts_runtime_only",
      refused(
        asApi(P.A, "SELECT * FROM morrow_work.pending_starts();"),
        "permission denied",
        "morrow_api_worker",
      ) &&
        refused(
          "SELECT * FROM morrow_work.pending_starts();",
          "permission denied",
          "morrow_vault_broker",
        ) &&
        refused(
          "SELECT * FROM morrow_work.pending_starts();",
          "permission denied",
          "morrow_connector_ingress",
        ),
    );
    const started = runtime(
      `BEGIN; ${enter(run.id)} SELECT morrow_work.lease_mark_started(); SELECT morrow_work.lease_mark_started(); COMMIT;`,
    ).split("\n");
    check(
      "L2:mark_started_once",
      started.join(",") === "entered,started,already_started" && lease(run.id).started,
    );
    check("L2:started_leaves_pending", !pending().some((l) => l.includes(run.id)));
    check(
      "L2:read_lease_never_marked",
      last(
        runtime(`BEGIN; ${enter(read.id)} SELECT morrow_work.lease_mark_started(); ROLLBACK;`),
      ) === "denied",
    );
    // Each entry outcome.
    const entry = db
      .sql(
        `BEGIN; ${enter(run.id)} SELECT concat_ws('|',organization_id,operations) FROM lab_probe.lease_view(); ROLLBACK;`,
        { user: "morrow_runtime_executor" },
      )
      .split("\n");
    check("L3:entered_selects_the_tenant", entry[0] === "entered" && entry[1] === P.A.org + "|0");
    check("L3:other_generation_not_found", entered(run.id, "2") === "not_found");
    check("L3:unknown_lease_not_found", entered(uuid()) === "not_found");
    check(
      "L3:malformed_denied",
      entered("lease_1") === "denied" && entered(run.id, "0") === "denied",
    );
    check(
      "L3:second_entry_denied",
      runtime(`BEGIN; ${enter(run.id)} ${enter(operation.id)} ROLLBACK;`)
        .split("\n")
        .join(",") === "entered,denied",
    );
    check(
      "L3:only_the_runtime_login_enters",
      last(cmd(P.A, enter(run.id))) === "denied" &&
        refused(enter(run.id), "permission denied", "morrow_vault_broker") &&
        refused(asApi(P.A, enter(run.id)), "permission denied", "morrow_api_worker"),
    );
    // The entry proof (review finding 1): the runtime login can set every lease setting
    // itself, including the computable part-1 marker or any nonce, but only enter_lease
    // writes the proof row, so a forged context resolves nothing, even for an active lease
    // at its own generation, and its definers refuse it.
    const forge = (id, entered) =>
      `SELECT concat(set_config('morrow.work_lease_id',${literal(id)},true),set_config('morrow.work_lease_generation','1',true),set_config('morrow.work_lease_entered',${entered},true)) IS NOT NULL;`;
    const forged = (id, entered) =>
      runtime(
        `BEGIN; ${forge(id, entered)} SELECT concat_ws('|',COALESCE(organization_id,'-'),operations) FROM lab_probe.lease_view(); SELECT morrow_work.lease_mark_started(); SELECT morrow_work.lease_release(); ROLLBACK;`,
      )
        .split("\n")
        .join(",");
    const unstarted = openLease(P.A, "run", "l_run_forged");
    const forgeries = [
      forged(unstarted.id, marker),
      forged(unstarted.id, literal(uuid())),
      forged(run.id, marker),
    ];
    check(
      "L3:forged_context_resolves_nothing",
      forgeries.every((f) => f === "t,-|0,denied,denied") &&
        lease(unstarted.id).status === "active" &&
        !lease(unstarted.id).started,
      forgeries,
    );
    // One entry per transaction, even after the caller clears its settings; a retargeted
    // context (another lease with this entry's nonce) resolves nothing.
    const once = [
      runtime(
        `BEGIN; ${enter(run.id)} SELECT concat(set_config('morrow.work_lease_id','',true),set_config('morrow.work_lease_generation','',true),set_config('morrow.work_lease_entered','',true)) IS NOT NULL; ${enter(operation.id)} ROLLBACK;`,
      )
        .split("\n")
        .join(","),
      runtime(
        `BEGIN; ${enter(run.id)} SELECT set_config('morrow.work_lease_id',${literal(unstarted.id)},true) IS NOT NULL; SELECT concat_ws('|',COALESCE(organization_id,'-'),operations) FROM lab_probe.lease_view(); ROLLBACK;`,
      )
        .split("\n")
        .join(","),
    ];
    check(
      "L3:one_entry_per_transaction",
      once[0] === "entered,t,denied" && once[1] === "entered,t,-|0",
      once,
    );
    // A refused entry leaves no usable proof: the next entry in the same transaction works.
    check(
      "L3:refused_entry_then_entry",
      runtime(`BEGIN; ${enter(uuid())} ${enter(unstarted.id)} ROLLBACK;`)
        .split("\n")
        .join(",") === "not_found,entered",
    );
    check(
      "L3:entry_proof_unreachable_to_logins",
      refused(
        "SELECT count(*) FROM morrow_work.lease_entries;",
        "permission denied",
        "morrow_runtime_executor",
      ) &&
        refused(
          "INSERT INTO morrow_work.lease_entries VALUES(pg_backend_pid(),'1','00000000-0000-4000-8000-000000000001','1','00000000-0000-4000-8000-000000000002');",
          "permission denied",
          "morrow_runtime_executor",
        ) &&
        refused(
          asApi(P.A, "SELECT count(*) FROM morrow_work.lease_entries;"),
          "permission denied",
          "morrow_api_worker",
        ),
    );
    // An expired lease (owner-inserted with a past creation time; no sweep exists).
    const expired = uuid();
    db.workOwner(
      `INSERT INTO morrow_work.work_leases(organization_id,workspace_id,id,generation,kind,subject_id,store_id,connection_id,installation_id,initiator_principal_id,initiator_membership_id,status,created_at,expires_at) VALUES(${literal(P.A.org)},${literal(P.A.workspace)},${literal(expired)},1,'read','l_expired','store_1','connection_1',NULL,${literal(P.A.principal)},${literal(P.A.membership)},'active',${ms}-interval '2 minutes',${ms}-interval '1 minute');`,
    );
    check("L3:expired", entered(expired) === "expired");
    // Release ends the context at once.
    const release = openLease(P.A, "run", "l_run_release");
    const released = runtime(
      `BEGIN; ${enter(release.id)} SELECT morrow_work.lease_release(); SELECT concat_ws('|',COALESCE(organization_id,'-'),operations) FROM lab_probe.lease_view(); SELECT morrow_work.lease_release(); COMMIT;`,
    ).split("\n");
    check(
      "L4:release_ends_the_context",
      released.join(",") === "entered,released,-|0,denied" && entered(release.id) === "ended",
    );
    // An inactive member whose leases were not revoked (a principal deactivated by the
    // owner; no identity path does that today): the live recheck still resolves nothing.
    const paused = openLease(P.R, "run", "l_run_r_paused");
    const principalActive = (active) =>
      db.sql(
        `BEGIN; SET LOCAL ROLE morrow_identity_owner; UPDATE morrow_identity.principals SET active=${active} WHERE id=${literal(P.R.principal)}; COMMIT;`,
      );
    principalActive(false);
    try {
      check(
        "L3:member_inactive",
        entered(paused.id) === "member_inactive" && lease(paused.id).status === "active",
      );
    } finally {
      principalActive(true);
    }
    check("L3:member_restored", entered(paused.id) === "entered");
    // A removed member (review finding 2; spine §5): the removing transaction revokes the
    // member's leases (0024's trigger and 0023's definer), pending_starts drops them, and
    // they stay ended when the membership returns. Other members' leases are untouched.
    const removed = openLease(P.R, "run", "l_run_r");
    const removedRead = openLease(P.R, "read", "l_read_r", { installation: null });
    const bystander = openLease(P.A, "run", "l_run_bystander");
    check(
      "L6:pending_before_removal",
      pending().some((l) => l.includes(removed.id)),
    );
    db.sql(revocationSql(P.R));
    try {
      check(
        "L6:membership_removal_revokes_its_leases",
        [removed, removedRead, paused].every(
          (l) => lease(l.id).status === "revoked" && lease(l.id).revoked_reason === "membership",
        ) &&
          lease(bystander.id).status === "active" &&
          lease(run.id).status === "active",
      );
      check("L6:pending_starts_drops_them", !pending().some((l) => l.includes(removed.id)));
      check("L6:removed_member_enters_nothing", entered(removed.id) === "ended");
    } finally {
      db.sql(restoreSql(P.R));
    }
    check(
      "L6:membership_return_does_not_resume",
      entered(removed.id) === "ended" &&
        lease(removed.id).status === "revoked" &&
        !pending().some((l) => l.includes(removed.id)),
    );
    // The organization membership behind it: every workspace's leases of that member.
    const orgRemoved = openLease(P.R, "operation", "l_claim_r");
    const membershipActive = (active) =>
      db.sql(
        `BEGIN; SET LOCAL ROLE morrow_identity_owner; UPDATE morrow_identity.memberships SET active=${active} WHERE id=${literal(P.R.membership)}; COMMIT;`,
      );
    membershipActive(false);
    membershipActive(true);
    check(
      "L6:organization_membership_removal_revokes",
      lease(orgRemoved.id).status === "revoked" &&
        lease(orgRemoved.id).revoked_reason === "membership" &&
        entered(orgRemoved.id) === "ended" &&
        lease(bystander.id).status === "active",
    );
    // The definer and its policy spare current members: the command role (its owner) and
    // a context-free command role with the revocation setting revoke nothing of P.A's.
    const spare = `SELECT outcome||'|'||revoked FROM morrow_work.revoke_member_leases(${literal(P.A.org)},${literal(P.A.workspace)},${literal(P.A.membership)});`;
    const spared = [
      last(db.sql(`BEGIN; SET LOCAL ROLE morrow_work_command; ${spare} COMMIT;`)),
      last(
        db.sql(
          `BEGIN; SET LOCAL ROLE morrow_work_command; SELECT set_config('morrow.work_member_revocation',${literal(`${P.A.org}|${P.A.workspace}|${P.A.membership}`)},true) IS NOT NULL; WITH u AS (UPDATE morrow_work.work_leases SET status='revoked',revoked_reason='membership',ended_at=${ms} WHERE id=${literal(bystander.id)} RETURNING 1) SELECT count(*) FROM u; COMMIT;`,
        ),
      ),
    ];
    check(
      "L6:revocation_spares_current_members",
      spared[0] === "applied|0" && spared[1] === "0" && lease(bystander.id).status === "active",
      spared,
    );
    check(
      "L6:revocation_definer_identity_owner_only",
      refused(spare, "permission denied", "morrow_runtime_executor") &&
        refused(asApi(P.A, spare), "permission denied", "morrow_api_worker") &&
        refused("SET ROLE morrow_work_owner; " + spare, "permission denied") &&
        last(db.sql(`BEGIN; SET LOCAL ROLE morrow_identity_owner; ${spare} ROLLBACK;`)) ===
          "applied|0",
    );
    // Lease rows: no generation, term or tenant change, no update after the end, no delete.
    const own = (statement) =>
      refused(
        "SET ROLE morrow_work_owner; " + statement,
        "WORK_LEASE_INVALID|WORK_RECORD_IMMUTABLE|violates check",
      );
    check(
      "L5:lease_rows_guarded",
      own(`UPDATE morrow_work.work_leases SET generation=2 WHERE id=${literal(run.id)};`) &&
        own(
          `UPDATE morrow_work.work_leases SET expires_at=expires_at+interval '1 hour' WHERE id=${literal(run.id)};`,
        ) &&
        own(
          `UPDATE morrow_work.work_leases SET status='active',ended_at=NULL WHERE id=${literal(release.id)};`,
        ) &&
        own(`UPDATE morrow_work.work_leases SET started_at=${ms} WHERE id=${literal(run.id)};`) &&
        own(`DELETE FROM morrow_work.work_leases WHERE id=${literal(read.id)};`) &&
        own("TRUNCATE morrow_work.work_leases CASCADE;") &&
        own(
          `INSERT INTO morrow_work.work_leases(organization_id,workspace_id,id,generation,kind,subject_id,store_id,connection_id,installation_id,initiator_principal_id,initiator_membership_id,status,created_at,expires_at) VALUES(${literal(P.A.org)},${literal(P.A.workspace)},${literal(uuid())},1,'run','l_long','s','c','i',${literal(P.A.principal)},${literal(P.A.membership)},'active',${ms},${ms}+interval '2 hours');`,
        ),
    );
  }

  // ---------------------------------------------------------------------------
  // S: stops block admission (spine §10; ADR-0022 item 15), and revoke leases.
  {
    const stopSql = (p, scope, target, o = {}) =>
      `INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,set_by_membership_id,reason_code,reason,created_at) VALUES(${literal(p.org)},${literal(p.workspace)},${literal(o.id ?? uuid())},${literal(scope)},${literal(o.store ?? "store_s")},${literal(target)},'human',${literal(p.principal)},${literal(p.membership)},'kill_switch','Stop AI work',${ms});`;
    const s = { store: "store_s", connection: "connection_s", installation: "installation_s" };
    const runBefore = openLease(P.A, "run", "s_run_before", s);
    const operationBefore = openLease(P.A, "operation", "s_claim_before", s);
    const readBefore = openLease(P.A, "read", "s_read_before", s);
    const otherInstallation = openLease(P.A, "run", "s_run_other", {
      ...s,
      installation: "installation_other",
    });
    cmd(P.A, stopSql(P.A, "installation", "installation_s"), "COMMIT");
    check(
      "S1:installation_stop_revokes_its_run_and_operation_leases",
      lease(runBefore.id).status === "revoked" &&
        lease(runBefore.id).revoked_reason === "stop" &&
        lease(operationBefore.id).status === "revoked" &&
        lease(readBefore.id).status === "active" &&
        lease(otherInstallation.id).status === "active",
    );
    check(
      "S1:installation_stop_blocks_admission",
      openLease(P.A, "run", "s_run_after", s).outcome === "stopped" &&
        openLease(P.A, "operation", "s_claim_after", s).outcome === "stopped" &&
        openLease(P.A, "read", "s_read_after", s).outcome === "opened" &&
        openLease(P.A, "run", "s_run_other_after", { ...s, installation: "installation_other" })
          .outcome === "opened",
    );
    check("S1:revoked_lease_cannot_be_entered", entered(runBefore.id) === "ended");
    check(
      "S1:one_active_stop_per_target",
      refused(asCommandRole(P.A, stopSql(P.A, "installation", "installation_s")), "duplicate key"),
    );
    // A connection stop revokes and refuses every kind on that connection.
    const readOnConnection = openLease(P.A, "read", "s_read_c", s);
    cmd(P.A, stopSql(P.A, "connection", "connection_s"), "COMMIT");
    check(
      "S2:connection_stop_revokes_and_refuses_every_kind",
      lease(readOnConnection.id).status === "revoked" &&
        lease(otherInstallation.id).status === "revoked" &&
        openLease(P.A, "read", "s_read_c2", s).outcome === "stopped" &&
        openLease(P.A, "run", "s_run_c2", { ...s, installation: "installation_other" }).outcome ===
          "stopped" &&
        openLease(P.A, "read", "s_read_other_connection", { ...s, connection: "connection_t" })
          .outcome === "opened",
    );
    // Another tenant is unaffected by A's stops.
    check("S2:foreign_tenant_unaffected", openLease(P.Y, "run", "s_run_y", s).outcome === "opened");
    // A defence in depth, sim: a lease left active under a stop (the trigger disabled by
    // the superuser) still cannot be entered.
    const kept = openLease(P.A, "run", "s_run_kept", {
      ...s,
      connection: "connection_k",
      installation: "installation_k",
    });
    db.sql(
      `ALTER TABLE morrow_work.stop_controls DISABLE TRIGGER stop_guard;
INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,set_by_membership_id,reason_code,reason,created_at) VALUES(${literal(P.A.org)},${literal(P.A.workspace)},'s_sim',${literal("installation")},'store_s','installation_k','human',${literal(P.A.principal)},${literal(P.A.membership)},'kill_switch','sim',${ms});
ALTER TABLE morrow_work.stop_controls ENABLE TRIGGER stop_guard;`,
    );
    check(
      "S3:entry_refused_under_a_stop_sim",
      lease(kept.id).status === "active" && entered(kept.id) === "stopped",
    );
    // The platform stop, set and lifted only by the owner's script, revokes run and
    // operation leases of every tenant and refuses their admission; reads continue.
    const platform = {
      store: "store_p",
      connection: "connection_p",
      installation: "installation_p",
    };
    const runA = openLease(P.A, "run", "s_run_pa", platform);
    const claimY = openLease(P.Y, "operation", "s_claim_py", platform);
    const readA = openLease(P.A, "read", "s_read_pa", platform);
    const set = db.workOwner(
      "SELECT outcome||'|'||stop_id FROM morrow_work.platform_stop_set('morrow_owner','Lab platform stop');",
    );
    const [setOutcome, platformStop] = last(set).split("|");
    check(
      "S4:platform_stop_revokes_runs_and_claims_everywhere",
      setOutcome === "applied" &&
        lease(runA.id).status === "revoked" &&
        lease(claimY.id).status === "revoked" &&
        lease(readA.id).status === "active",
    );
    check(
      "S4:platform_stop_blocks_admission_not_reads",
      openLease(P.A, "run", "s_run_pa2", platform).outcome === "stopped" &&
        openLease(P.Y, "operation", "s_claim_py2", platform).outcome === "stopped" &&
        openLease(P.A, "read", "s_read_pa2", platform).outcome === "opened",
    );
    check(
      "S4:platform_stop_once",
      last(
        db.workOwner("SELECT outcome FROM morrow_work.platform_stop_set('morrow_owner','again');"),
      ) === "already_stopped",
    );
    check(
      "S4:platform_stop_owner_only",
      refused(
        "SELECT * FROM morrow_work.platform_stop_set('x','y');",
        "permission denied",
        "morrow_api_worker",
      ) &&
        last(db.sql("SELECT outcome FROM morrow_work.platform_stop_set('x','y');")) === "denied" &&
        refused(
          asCommandRole(
            P.A,
            `INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_operator_id,reason_code,reason,created_at) VALUES(NULL,NULL,'s_forged','platform',NULL,NULL,'operator','x','operator_platform_stop','forged',${ms});`,
          ),
          "row-level security",
        ),
    );
    // Platform stops are visible to every tenant; tenant stops only to their tenant.
    const visible = (p) =>
      last(
        db.sql(
          asApi(
            p,
            "SELECT count(*) FILTER (WHERE organization_id IS NULL)||'|'||count(*) FILTER (WHERE organization_id IS NOT NULL) FROM morrow_work.stop_controls;",
          ),
          {
            user: "morrow_api_worker",
          },
        ),
      );
    check(
      "S4:platform_stop_visible_to_every_tenant",
      visible(P.A) === "1|3" && visible(P.Y) === "1|0",
    );
    const records = db.rows(
      "SELECT action,actor_kind,operator_id,reason_code FROM morrow_work.stop_records ORDER BY recorded_at",
    );
    check(
      "S4:stop_record_written",
      records.length === 1 &&
        records[0].action === "set" &&
        records[0].actor_kind === "operator" &&
        records[0].reason_code === "operator_platform_stop",
    );
    const lift = last(
      db.workOwner(
        "SELECT outcome||'|'||stop_id FROM morrow_work.platform_stop_lift('morrow_owner','Lab lift');",
      ),
    );
    check(
      "S4:only_a_person_lifts_and_it_is_recorded",
      lift === "applied|" + platformStop &&
        db
          .rows(
            "SELECT action FROM morrow_work.stop_records WHERE stop_control_id=" +
              literal(platformStop) +
              " ORDER BY action",
          )
          .map((r) => r.action)
          .join() === "lift,set" &&
        last(
          db.workOwner(
            "SELECT outcome FROM morrow_work.platform_stop_lift('morrow_owner','again');",
          ),
        ) === "not_stopped",
    );
    check(
      "S4:lifting_restores_admission_not_revoked_leases",
      openLease(P.A, "run", "s_run_pa3", platform).outcome === "opened" &&
        lease(runA.id).status === "revoked",
    );
    // Stop rows: a human never lifts a platform stop, a lift happens once, nothing deletes,
    // and a StopRecord must match its control (a system actor never lifts).
    const own = (statement, code) => refused("SET ROLE morrow_work_owner; " + statement, code);
    check(
      "S5:stop_rows_guarded",
      own(
        `UPDATE morrow_work.stop_controls SET lifted_at=${ms},lifted_by_kind='human',lifted_by_principal_id=${literal(P.A.principal)},lifted_by_membership_id=${literal(P.A.membership)} WHERE scope='platform';`,
        "WORK_STOP_INVALID|violates check",
      ) &&
        own(
          `UPDATE morrow_work.stop_controls SET reason='changed' WHERE scope='installation';`,
          "WORK_STOP_INVALID",
        ) &&
        own(
          `UPDATE morrow_work.stop_controls SET lifted_at=NULL,lifted_by_kind=NULL,lifted_by_operator_id=NULL WHERE id=${literal(platformStop)};`,
          "WORK_STOP_INVALID",
        ) &&
        own("DELETE FROM morrow_work.stop_controls;", "WORK_RECORD_IMMUTABLE") &&
        own("TRUNCATE morrow_work.stop_records;", "WORK_RECORD_IMMUTABLE") &&
        own(
          `INSERT INTO morrow_work.stop_records(organization_id,workspace_id,id,stop_control_id,action,scope,store_id,target_id,actor_kind,operator_id,reason_code,reason,recorded_at) VALUES(NULL,NULL,'r_forged',${literal(platformStop)},'set','platform',NULL,NULL,'system',NULL,'app_uninstalled','forged',${ms});`,
          "WORK_STOP_RECORD_INVALID|duplicate key",
        ) &&
        own(
          `INSERT INTO morrow_work.stop_records(organization_id,workspace_id,id,stop_control_id,action,scope,store_id,target_id,actor_kind,operator_id,reason_code,reason,recorded_at) VALUES(NULL,NULL,'r_forged2',${literal(platformStop)},'lift','platform',NULL,NULL,'system',NULL,'x_lift','forged',${ms});`,
          "violates check|WORK_STOP_RECORD_INVALID",
        ),
    );
    // Races, forced with a gate session that the lab terminates: (a) a stop waits for an
    // in-flight lease_open and then revokes the committed lease; (b) a lease_open waits for
    // an in-flight stop and then refuses.
    const gateKey = 7240191;
    const gate = async (name) => {
      const held = background(
        db.id,
        `BEGIN; SELECT pg_advisory_xact_lock(${gateKey}); SELECT pg_sleep(600); COMMIT;`,
        name,
      );
      for (let i = 0; i < 2400; i++) {
        if (
          last(
            db.sql(
              `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=${gateKey} AND granted;`,
            ),
          ) === "1"
        )
          return held;
        await sleep(25);
      }
      throw Error("SPINE_LAB_GATE");
    };
    const release = async (name, held) => {
      db.sql(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=${literal(name)};`,
      );
      await held;
    };
    const race = { store: "store_r", connection: "connection_r", installation: "installation_r" };
    {
      const held = await gate("spine_gate_a");
      const opener = background(
        db.id,
        asCommandRole(
          P.A,
          `SELECT outcome||'|'||lease_id FROM morrow_work.lease_open('run','s_race_a','store_r','connection_r','installation_r'); SELECT pg_advisory_xact_lock(${gateKey}) IS NOT NULL;`,
          { end: "COMMIT" },
        ),
        "spine_race_open_a",
      );
      const waitingOpen = await db.waitForLockWait("application_name='spine_race_open_a'", 120000);
      const stopper = background(
        db.id,
        asCommandRole(P.A, stopSql(P.A, "installation", "installation_r", { store: "store_r" }), {
          end: "COMMIT",
        }),
        "spine_race_stop_a",
      );
      const waitingStop = await db.waitForLockWait("application_name='spine_race_stop_a'", 120000);
      await release("spine_gate_a", held);
      const [opened, stopped] = await Promise.all([opener, stopper]);
      const id = opened.stdout.split("\n")[1]?.split("|")[1];
      check(
        "S6:stop_waits_for_inflight_lease_then_revokes_it",
        waitingOpen &&
          waitingStop &&
          opened.ok &&
          stopped.ok &&
          opened.stdout.split("\n")[1]?.startsWith("opened|") &&
          lease(id)?.status === "revoked",
        { waitingOpen, waitingStop, opened: opened.ok, stopped: stopped.ok },
      );
    }
    {
      const held = await gate("spine_gate_b");
      const stopper = background(
        db.id,
        asCommandRole(
          P.A,
          stopSql(P.A, "connection", "connection_r", { store: "store_r" }) +
            ` SELECT pg_advisory_xact_lock(${gateKey}) IS NOT NULL;`,
          { end: "COMMIT" },
        ),
        "spine_race_stop_b",
      );
      const waitingStop = await db.waitForLockWait("application_name='spine_race_stop_b'", 120000);
      const opener = background(
        db.id,
        asCommandRole(
          P.A,
          "SELECT outcome FROM morrow_work.lease_open('read','s_race_b','store_r','connection_r',NULL);",
          { end: "COMMIT" },
        ),
        "spine_race_open_b",
      );
      const waitingOpen = await db.waitForLockWait("application_name='spine_race_open_b'", 120000);
      await release("spine_gate_b", held);
      const [stopped, opened] = await Promise.all([stopper, opener]);
      check(
        "S6:lease_waits_for_inflight_stop_then_refuses",
        waitingStop && waitingOpen && stopped.ok && opened.ok && last(opened.stdout) === "stopped",
        { waitingStop, waitingOpen, out: last(opened.stdout) },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // O: the OperationLedger machine (spine §8) on state-transitions.json, unchanged.
  {
    const rules = db
      .rows(
        "SELECT from_status,to_status,actor,guard FROM morrow_work.transition_rules WHERE machine='operation'",
      )
      .map((r) => [r.from_status, r.to_status, r.actor, r.guard].join("|"))
      .sort();
    const contract = transitionsJson.transitions.operation
      .map((r) => [r.from, r.to, r.actor, r.guard].join("|"))
      .sort();
    check(
      "O1:operation_rules_equal_the_contract",
      JSON.stringify(rules) === JSON.stringify(contract),
    );
    const insert = (p, id, extra = "") =>
      `INSERT INTO morrow_work.operations(organization_id,workspace_id,id,revision,kind,capability_id,status,request_digest,attempt,created_at,updated_at${extra ? "," + extra.split("=")[0] : ""}) VALUES(${literal(p.org)},${literal(p.workspace)},${literal(id)},1,'stripe_write','governance.billing.manage','planned',${literal("e".repeat(64))},0,${txMs},${txMs}${extra ? "," + extra.split("=")[1] : ""});`;
    const step = (id, expected, to, actor, guard, reason = null, uncertainty = null) =>
      `SELECT outcome FROM morrow_work.operation_transition(${literal(P.A.org)},${literal(P.A.workspace)},${literal(id)},${expected},${literal(to)},${literal(actor)},${literal(guard)},${literal(reason)},${literal(uncertainty)},NULL);`;
    const fence = (id, revision) =>
      `UPDATE morrow_work.operations SET send_started_at=${ms},attempt=attempt+1,revision=${revision},updated_at=${ms} WHERE id=${literal(id)};`;
    const happy = cmd(
      P.A,
      [
        insert(P.A, "o_happy"),
        step("o_happy", 1, "authorized", "action_service", "current_grants_and_preconditions"),
        step(
          "o_happy",
          2,
          "dispatching",
          "action_service",
          "non_billable_current_grants_and_lease",
        ),
        fence("o_happy", 4),
        step("o_happy", 4, "submitted", "connector", "provider_submission_receipt"),
        step("o_happy", 5, "verifying", "connector", "provider_terminal_result"),
        step("o_happy", 6, "verified", "action_service", "declared_postconditions_verified"),
        "SELECT status||'|'||revision||'|'||attempt||'|'||(submitted_at IS NOT NULL) FROM morrow_work.operations WHERE id='o_happy';",
        "SELECT string_agg(from_status||'>'||to_status,',' ORDER BY revision) FROM morrow_work.operation_transitions WHERE operation_id='o_happy';",
      ].join("\n"),
      "COMMIT",
    );
    check(
      "O2:planned_to_verified_with_one_fenced_send",
      happy.join(",") ===
        "applied,applied,applied,applied,applied,verified|7|1|true,planned>authorized,authorized>dispatching,dispatching>submitted,submitted>verifying,verifying>verified",
      happy,
    );
    const uncertain = cmd(
      P.A,
      [
        insert(P.A, "o_uncertain"),
        step("o_uncertain", 1, "authorized", "action_service", "current_grants_and_preconditions"),
        step(
          "o_uncertain",
          2,
          "dispatching",
          "action_service",
          "non_billable_current_grants_and_lease",
        ),
        fence("o_uncertain", 4),
        step(
          "o_uncertain",
          4,
          "uncertain",
          "connector",
          "unknown_external_outcome",
          "transport_after_dispatch",
        ),
        step(
          "o_uncertain",
          4,
          "uncertain",
          "connector",
          "unknown_external_outcome",
          "transport_after_dispatch",
          "transport_after_dispatch",
        ),
        step("o_uncertain", 5, "verified", "action_service", "declared_postconditions_verified"),
        step("o_uncertain", 5, "failed", "action_service", "verified_no_effect"),
        "SELECT status||'|'||uncertainty_reason FROM morrow_work.operations WHERE id='o_uncertain';",
      ].join("\n"),
      "COMMIT",
    );
    check(
      "O2:uncertain_needs_a_reason_and_leaves_only_by_rule",
      uncertain.join(",") ===
        "applied,applied,invalid,applied,state_conflict,applied,failed|transport_after_dispatch",
      uncertain,
    );
    const outcomes = cmd(
      P.A,
      [
        insert(P.A, "o_bad"),
        step("o_bad", 1, "dispatching", "action_service", "non_billable_current_grants_and_lease"),
        step("o_bad", 1, "authorized", "connector", "current_grants_and_preconditions"),
        step("o_bad", 2, "authorized", "action_service", "current_grants_and_preconditions"),
        step("o_absent", 1, "authorized", "action_service", "current_grants_and_preconditions"),
      ].join("\n"),
    );
    check(
      "O3:edges_actors_guards_and_revisions_checked",
      outcomes.join(",") === "state_conflict,state_conflict,revision_conflict,not_found",
      outcomes,
    );
    // Direct writes bypassing the helper: each refused by operation_guard, the transition
    // binding or the privileges.
    const setup = [
      insert(P.A, "o_guard"),
      step("o_guard", 1, "authorized", "action_service", "current_grants_and_preconditions"),
      step("o_guard", 2, "dispatching", "action_service", "non_billable_current_grants_and_lease"),
    ].join("\n");
    const guarded = (statements, code = "WORK_OPERATION_INVALID") =>
      refused(asCommandRole(P.A, setup + "\n" + statements), code);
    check(
      "O3:status_change_needs_its_transition_row",
      guarded(
        `UPDATE morrow_work.operations SET status='submitted',revision=4,updated_at=${ms} WHERE id='o_guard';`,
      ),
    );
    check(
      "O3:submission_needs_the_send_fence",
      guarded(step("o_guard", 3, "submitted", "connector", "provider_submission_receipt")) &&
        guarded(
          step(
            "o_guard",
            3,
            "uncertain",
            "connector",
            "unknown_external_outcome",
            null,
            "unknown_submission",
          ),
        ),
    );
    check("O3:send_fence_once", guarded(fence("o_guard", 4) + "\n" + fence("o_guard", 5)));
    check(
      "O3:send_fence_only_while_dispatching",
      refused(
        asCommandRole(P.A, insert(P.A, "o_early") + "\n" + fence("o_early", 2)),
        "WORK_OPERATION_INVALID",
      ),
    );
    check(
      "O3:attempt_moves_only_with_the_fence",
      guarded(
        `UPDATE morrow_work.operations SET attempt=attempt+1,revision=4,updated_at=${ms} WHERE id='o_guard';`,
        "WORK_OPERATION_INVALID|violates check",
      ),
    );
    check(
      "O3:immutable_columns",
      guarded(
        `UPDATE morrow_work.operations SET request_digest=${literal("f".repeat(64))},revision=4,updated_at=${ms} WHERE id='o_guard';`,
        "permission denied",
      ) &&
        refused(
          `SET ROLE morrow_work_owner; UPDATE morrow_work.operations SET request_digest=${literal("f".repeat(64))},revision=revision+1 WHERE id='o_happy';`,
          "WORK_OPERATION_INVALID",
        ),
    );
    check(
      "O3:transition_rows_bind_to_the_current_state",
      guarded(
        `INSERT INTO morrow_work.operation_transitions(organization_id,workspace_id,operation_id,revision,machine,from_status,to_status,actor,guard,occurred_at) VALUES(${literal(P.A.org)},${literal(P.A.workspace)},'o_guard',4,'operation','planned','authorized','action_service','current_grants_and_preconditions',${ms});`,
        "WORK_OPERATION_TRANSITION_INVALID",
      ) &&
        guarded(
          `INSERT INTO morrow_work.operation_transitions(organization_id,workspace_id,operation_id,revision,machine,from_status,to_status,actor,guard,occurred_at) VALUES(${literal(P.A.org)},${literal(P.A.workspace)},'o_guard',4,'operation','dispatching','verified','action_service','declared_postconditions_verified',${ms});`,
          "foreign key",
        ),
    );
    check(
      "O3:append_only_and_no_delete",
      refused(
        "SET ROLE morrow_work_owner; UPDATE morrow_work.operation_transitions SET reason='edited';",
        "WORK_RECORD_IMMUTABLE",
      ) &&
        refused(
          "SET ROLE morrow_work_owner; DELETE FROM morrow_work.operations;",
          "WORK_RECORD_IMMUTABLE",
        ) &&
        refused(
          "SET ROLE morrow_work_owner; TRUNCATE morrow_work.operation_transitions;",
          "WORK_RECORD_IMMUTABLE",
        ) &&
        refused(asCommandRole(P.A, "DELETE FROM morrow_work.operations;"), "permission denied"),
    );
    // Kinds: a catalog write needs every claim column; a billing write has none and is the
    // only kind that may have no task (ADR-0022 item 2).
    check(
      "O4:kind_shapes",
      refused(
        asCommandRole(
          P.A,
          `INSERT INTO morrow_work.operations(organization_id,workspace_id,id,revision,kind,capability_id,status,request_digest,attempt,created_at,updated_at) VALUES(${literal(P.A.org)},${literal(P.A.workspace)},'o_catalog',1,'catalog_write','catalog.content.publish','planned',${literal("e".repeat(64))},0,${txMs},${txMs});`,
        ),
        "operations_kind",
      ) &&
        refused(
          asCommandRole(P.A, insert(P.A, "o_store", "store_id='store_1'")),
          "operations_kind",
        ) &&
        refused(
          asCommandRole(
            P.A,
            `INSERT INTO morrow_work.operations(organization_id,workspace_id,id,revision,kind,capability_id,status,request_digest,attempt,created_at,updated_at) VALUES(${literal(P.A.org)},${literal(P.A.workspace)},'o_cap',1,'stripe_write','catalog.content.publish','planned',${literal("e".repeat(64))},0,${txMs},${txMs});`,
          ),
          "operations_kind",
        ) &&
        refused(
          asCommandRole(P.A, insert(P.A, "o_born_late").replace("'planned'", "'authorized'")),
          "WORK_OPERATION_INVALID",
        ),
    );
    // The lease context: under an entered operation lease a runtime definer sees and moves
    // only its tenant's operations; another tenant's operation is not found.
    cmd(P.Y, insert(P.Y, "o_foreign"), "COMMIT");
    const op = openLease(P.A, "operation", "o_claim_lease", {
      connection: "connection_o",
      installation: "installation_o",
    });
    const seen = runtime(
      `BEGIN; ${enter(op.id)} SELECT organization_id||'|'||operations FROM lab_probe.lease_view(); SELECT lab_probe.lease_transition('o_foreign',1,'authorized','action_service','current_grants_and_preconditions',NULL,NULL); SELECT lab_probe.lease_transition('o_guard',1,'authorized','action_service','current_grants_and_preconditions',NULL,NULL); ROLLBACK;`,
    ).split("\n");
    const tenantOperations = last(
      db.sql(
        `SELECT count(*) FROM morrow_work.operations WHERE organization_id=${literal(P.A.org)};`,
      ),
    );
    check(
      "O5:lease_context_sees_and_moves_only_its_tenant",
      seen.join(",") === `entered,${P.A.org}|${tenantOperations},not_found,not_found`,
      seen,
    );
    const moved = runtime(
      `BEGIN; ${enter(op.id)} SELECT lab_probe.lease_transition('o_happy',7,'cancel_requested','owner','provider_cancel_supported_or_recorded_request',NULL,NULL); ROLLBACK;`,
    ).split("\n");
    // The runtime login itself holds no table privilege: only definers act for it.
    check(
      "O5:runtime_login_has_no_table_access",
      refused(
        `BEGIN; ${enter(op.id)} ${insert(P.A, "o_runtime_direct")} ROLLBACK;`,
        "permission denied",
        "morrow_runtime_executor",
      ),
    );
    check(
      "O5:lease_context_transitions_by_rule",
      moved.join(",") === "entered,state_conflict",
      moved,
    );
  }

  // ---------------------------------------------------------------------------
  // V: the vault (ADR-0022 item 7). Every role but the broker's login is denied, and the
  // envelope the broker reads decrypts only with its KEK and the exact AAD.
  {
    // Every envelope is sealed and opened by the broker's own vault module
    // (apps/broker/src/vault.ts), with its additional data.
    const kek = randomBytes(32).toString("hex");
    const keyring = await createVaultKeyring("development", new Map([[1, kek]]));
    const appRef = (appKey, version) => ({
      kind: "app_secret",
      appKey,
      provider: "shopify",
      version,
    });
    const envelope = async (app, secret, version) => {
      const e = await sealVaultRecord(keyring, appRef(app, version), Buffer.from(secret, "utf8"));
      return { wrapped: Buffer.from(e.wrappedKey), sealed: Buffer.from(e.sealedValue) };
    };
    const put = (app, e) =>
      last(
        db.workOwner(
          `SELECT outcome||'|'||version FROM morrow_vault.app_secret_put(${literal(app)},'1',${literal(e.wrapped.toString("hex"))},${literal(e.sealed.toString("hex"))});`,
        ),
      );
    const first = await envelope("lab-app", "lab-client-secret-1", 1);
    const second = await envelope("lab-app", "lab-client-secret-2", 2);
    const other = await envelope("other-app", "other-client-secret", 1);
    check(
      "V1:rotation_versions",
      put("lab-app", first) === "stored|1" &&
        put("lab-app", second) === "stored|2" &&
        put("other-app", other) === "stored|1",
    );
    const rows = db.rows(
      "SELECT app_key,version::int,status,wrapped_key IS NULL AS erased FROM morrow_vault.app_secrets ORDER BY app_key,version",
    );
    check(
      "V1:rotation_retires_and_erases_only_that_app",
      JSON.stringify(rows.map((r) => [r.app_key, r.version, r.status, r.erased].join("|"))) ===
        JSON.stringify([
          "lab-app|1|retired|true",
          "lab-app|2|active|false",
          "other-app|1|active|false",
        ]),
    );
    // The broker's read path: its one fixed statement on a connection logged in as
    // morrow_vault_broker, then readAppSecret opens the envelope.
    const brokerConnector = createLocalWorkConnector(db.id, { user: "morrow_vault_broker" });
    const brokerQuery = async (text, values) => {
      const connection = await brokerConnector.open({
        signal: new AbortController().signal,
        deadlineMs: Date.now() + 60000,
        waitUntil() {},
      });
      try {
        return (await connection.query(text, values, new AbortController().signal)).rows;
      } finally {
        await connection.close();
      }
    };
    const readSecret = (app) => readAppSecret(keyring, brokerQuery, app).catch(() => null);
    const got = await readSecret("lab-app");
    const otherGot = await readSecret("other-app");
    check(
      "V2:broker_reads_the_active_envelope_and_it_decrypts",
      got?.outcome === "found" &&
        got.version === 2 &&
        got.secret === "lab-client-secret-2" &&
        otherGot?.secret === "other-client-secret",
    );
    const stored = { kekVersion: 1, wrappedKey: second.wrapped, sealedValue: second.sealed };
    const fails = async (k, ref) => {
      try {
        await openVaultRecord(k, ref, stored);
        return false;
      } catch (error) {
        return error?.code === "VAULT_OPEN_FAILED";
      }
    };
    check(
      "V2:wrong_aad_environment_version_or_kek_fails",
      (await fails(
        await createVaultKeyring("staging", new Map([[1, kek]])),
        appRef("lab-app", 2),
      )) &&
        (await fails(keyring, appRef("lab-app", 1))) &&
        (await fails(keyring, appRef("other-app", 2))) &&
        (await fails(
          await createVaultKeyring("development", new Map([[1, randomBytes(32).toString("hex")]])),
          appRef("lab-app", 2),
        )),
    );
    check(
      "V2:get_outcomes",
      (await readSecret("absent-app"))?.outcome === "not_found" &&
        last(
          as("morrow_vault_broker")("SELECT outcome FROM morrow_vault.app_secret_get('Bad App');"),
        ) === "invalid",
    );
    // A tenant credential row (owner-seeded; its writers land in M2 PR-2).
    db.workOwner(
      `INSERT INTO morrow_vault.credentials(organization_id,workspace_id,id,version,provider,kind,subject_id,status,kek_version,wrapped_key,sealed_value,created_at) VALUES(${literal(P.A.org)},${literal(P.A.workspace)},'credential_1',1,'shopify','shopify_offline_token','installation_1','active',1,${literal("\\x" + first.wrapped.toString("hex"))}::bytea,${literal("\\x" + first.sealed.toString("hex"))}::bytea,${ms});`,
    );
    // Every Morrow role except the owner: no privilege on either table, and the command
    // role (which owns the vault definers) sees zero rows outside the broker's session.
    const roles = db
      .rows("SELECT rolname FROM pg_roles WHERE rolname LIKE 'morrow\\_%' ORDER BY 1")
      .map((r) => r.rolname);
    const privileged = db.rows(
      "SELECT r.rolname,c.relname FROM pg_roles r, pg_class c WHERE r.rolname LIKE 'morrow\\_%' AND c.relnamespace='morrow_vault'::regnamespace AND c.relkind='r' AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))",
    );
    check(
      "V3:no_role_but_owner_and_command_holds_a_vault_privilege",
      roles.length >= 18 &&
        privileged.every(
          (p) => p.rolname === "morrow_work_owner" || p.rolname === "morrow_work_command",
        ) &&
        privileged.filter((p) => p.rolname === "morrow_work_command").length === 2,
      privileged,
    );
    const direct = [
      "morrow_api_worker",
      "morrow_runtime_executor",
      "morrow_connector_ingress",
      "morrow_vault_broker",
    ].map((login) =>
      ["app_secrets", "credentials"].every((t) =>
        refused(`SELECT count(*) FROM morrow_vault.${t};`, "permission denied", login),
      ),
    );
    check("V3:every_login_denied_direct_reads", direct.every(Boolean));
    check(
      "V3:every_non_login_role_denied_direct_reads",
      roles
        .filter((r) => !["morrow_work_owner", "morrow_work_command"].includes(r))
        .every((r) =>
          refused(
            `SET ROLE ${r}; SELECT count(*) FROM morrow_vault.app_secrets;`,
            "permission denied",
          ),
        ),
    );
    check(
      "V3:command_role_sees_nothing_outside_the_broker_session",
      last(
        db.sql("SET ROLE morrow_work_command; SELECT count(*) FROM morrow_vault.app_secrets;"),
      ) === "0" &&
        last(as("morrow_api_worker")("SELECT lab_probe.vault_count();")) === "0" &&
        last(runtime("SELECT lab_probe.vault_count();")) === "0" &&
        last(as("morrow_connector_ingress")("SELECT lab_probe.vault_count();")) === "0" &&
        last(as("morrow_vault_broker")("SELECT lab_probe.vault_count();")) === "4",
    );
    check(
      "V3:vault_definer_broker_only",
      ["morrow_api_worker", "morrow_runtime_executor", "morrow_connector_ingress"].every((login) =>
        refused(
          "SELECT * FROM morrow_vault.app_secret_get('lab-app');",
          "permission denied",
          login,
        ),
      ) && last(db.sql("SELECT outcome FROM morrow_vault.app_secret_get('lab-app');")) === "denied",
    );
    const own = (statement, code = "VAULT_RECORD_IMMUTABLE|VAULT_RECORD_INVALID|violates check") =>
      refused("SET ROLE morrow_work_owner; " + statement, code);
    check(
      "V4:vault_rows_guarded",
      own(
        "UPDATE morrow_vault.app_secrets SET sealed_value=wrapped_key WHERE app_key='lab-app' AND status='active';",
      ) &&
        own("UPDATE morrow_vault.app_secrets SET status='active' WHERE status='retired';") &&
        own("DELETE FROM morrow_vault.app_secrets;") &&
        own("TRUNCATE morrow_vault.credentials;") &&
        own(
          `INSERT INTO morrow_vault.app_secrets(app_key,version,provider,status,kek_version,wrapped_key,sealed_value,created_at) VALUES('lab-app',5,'shopify','active',1,${literal("\\x" + first.wrapped.toString("hex"))}::bytea,${literal("\\x" + first.sealed.toString("hex"))}::bytea,${ms});`,
        ) &&
        own(
          `INSERT INTO morrow_vault.credentials(organization_id,workspace_id,id,version,provider,kind,subject_id,status,kek_version,wrapped_key,sealed_value,created_at) VALUES(${literal(P.A.org)},${literal(P.A.workspace)},'credential_1',2,'shopify','shopify_offline_token','installation_2','active',1,${literal("\\x" + first.wrapped.toString("hex"))}::bytea,${literal("\\x" + first.sealed.toString("hex"))}::bytea,${ms});`,
        ) &&
        last(
          db.sql("SELECT outcome FROM morrow_vault.app_secret_put('lab-app','1','00','00');"),
        ) === "denied" &&
        last(
          db.workOwner("SELECT outcome FROM morrow_vault.app_secret_put('lab-app','1','zz','00');"),
        ) === "invalid",
    );
    db.workOwner(
      `UPDATE morrow_vault.credentials SET status='destroyed',wrapped_key=NULL,sealed_value=NULL,destroyed_at=${ms},destroy_reason='uninstalled' WHERE id='credential_1';`,
    );
    check(
      "V4:destroy_erases_the_material_once",
      last(
        db.sql(
          "SELECT status||'|'||(wrapped_key IS NULL AND sealed_value IS NULL) FROM morrow_vault.credentials WHERE id='credential_1';",
        ),
      ) === "destroyed|true" &&
        own(
          `UPDATE morrow_vault.credentials SET destroy_reason='disconnected' WHERE id='credential_1';`,
        ),
    );
    // The owner script (scripts/vault.mjs): an envelope sealed from a 0600 KEK file is
    // applied with the runner's one statement as the work owner, stores exactly its
    // version, and the broker opens it.
    const scratch = mkdtempSync(join(tmpdir(), "morrow-spine-vault-"));
    try {
      writeFileSync(join(scratch, "kek"), kek + "\n", { mode: 0o600 });
      const scripted = await sealAppSecret(
        {
          environment: "development",
          "app-key": "script-app",
          version: "1",
          "kek-file": join(scratch, "kek"),
        },
        "script-client-secret",
      );
      const statement = appSecretPutStatement(scripted);
      const bound = statement.text.replace(/\$(\d+)/g, (_, n) =>
        literal(statement.values[Number(n) - 1]),
      );
      const applied = db.rows(bound, { prefix: "SET ROLE morrow_work_owner;\n" })[0];
      const opened = await readSecret("script-app");
      check(
        "V5:owner_script_envelope_applies_at_its_version_and_opens",
        applied?.outcome === "stored" &&
          applied.version === statement.expectedVersion &&
          opened?.outcome === "found" &&
          opened.secret === "script-client-secret",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------------
  // R: the billing route (P01.T04a §3 R1-R4, §8.1; ADR-0015 item 2).
  {
    const routeOf = (ws) =>
      db.rows(
        `SELECT origin,shopify_bound_at IS NOT NULL AS bound,route,mode,revision::int FROM morrow_billing.workspace_billing_routes WHERE workspace_id=${literal(ws)}`,
      )[0] ?? null;
    // Fixture world: a signup profile, then website signups for two fresh organizations.
    db.admin(
      `INSERT INTO morrow_identity.identity_verification_profiles VALUES('profile_spine','workos',${literal("environment_" + "A".repeat(26))},${literal("app_" + "B".repeat(26))},${literal("client_" + "C".repeat(26))},${literal("https://api.workos.com/user_management/client_" + "C".repeat(26))},1,${literal("d".repeat(64))},1,'active');`,
    );
    const tenantSql = (
      n,
    ) => `INSERT INTO morrow_identity.organizations VALUES('org_r${n}','Synthetic R${n}',true,1);
INSERT INTO morrow_identity.workspaces VALUES('ws_r${n}','org_r${n}','Synthetic',true);
INSERT INTO morrow_identity.principals VALUES('person_r${n}','human',true);
INSERT INTO morrow_identity.memberships VALUES('membership_r${n}','org_r${n}','person_r${n}',true);
INSERT INTO morrow_identity.workspace_memberships VALUES('org_r${n}','ws_r${n}','membership_r${n}',true);`;
    const signupRowSql = (n) =>
      `INSERT INTO morrow_identity.organization_signups(principal_id,command_id,request_digest,profile_id,organization_id,workspace_id,membership_id,grant_template,recorded_at) VALUES('person_r${n}','signup_r${n}',${literal("c".repeat(64))},'profile_spine','org_r${n}','ws_r${n}','membership_r${n}','owner-bootstrap-v1',clock_timestamp());`;
    const signupSql = (n) => tenantSql(n) + "\n" + signupRowSql(n);
    db.sql(`BEGIN; SET LOCAL ROLE morrow_identity_owner; ${signupSql(1)} ROLLBACK;`);
    check("R1:rolled_back_signup_leaves_no_route", routeOf("ws_r1") === null);
    db.admin(signupSql(1));
    db.admin(signupSql(2));
    const r1 = routeOf("ws_r1");
    check(
      "R1:website_signup_records_the_route_in_its_transaction",
      r1?.origin === "website" && r1.bound === false && r1.route === null && r1.revision === 1,
    );
    check(
      "R1:other_workspaces_have_no_row",
      routeOf(P.A.workspace) === null && routeOf("ws_w2") === null,
    );
    // Part 2: the api's fixed statement and row mapping give exactly the row
    // billingRouteForCreation defines for a website signup (originForCreation).
    const routeRow = (ws) =>
      db.rows(
        spineStatements.workspaceBillingRoute.replace(/\$1::text/, literal(ws) + "::text"),
      )[0] ?? null;
    let mapped = null;
    try {
      mapped = workspaceBillingRouteFromRow(routeRow("ws_r1"));
    } catch {
      mapped = null;
    }
    check(
      "R6:signup_row_is_the_creation_plan",
      JSON.stringify(mapped) ===
        JSON.stringify(
          billingRouteForCreation(
            { kind: "website_signup", installHandoffPending: false },
            { organizationId: "org_r1", workspaceId: "ws_r1" },
          ),
        ),
    );
    // The signup bridge: the identity owner only (its owner, the command role, runs it as
    // a definer; no login and neither work role may call it).
    check(
      "R2:signup_bridge_identity_owner_only",
      last(db.admin("SELECT morrow_billing.record_signup_route('org_r1','ws_r1',NULL);")) ===
        "exists" &&
        last(
          db.admin(
            "SELECT morrow_billing.record_signup_route('org_r1','ws_r1',clock_timestamp()+interval '1 day');",
          ),
        ) === "invalid" &&
        refused(
          asApi(
            P.A,
            `SELECT morrow_billing.record_signup_route(${literal(P.A.org)},${literal(P.A.workspace)},NULL);`,
          ),
          "permission denied",
          "morrow_api_worker",
        ) &&
        refused(
          "SELECT morrow_billing.record_signup_route('org_r1','ws_r1',NULL);",
          "permission denied",
          "morrow_runtime_executor",
        ) &&
        refused(
          "SET ROLE morrow_work_owner; SELECT morrow_billing.record_signup_route('org_r1','ws_r1',NULL);",
          "permission denied",
        ),
    );
    // A signup whose workspace already has a route row is refused (fail closed), and the
    // existing row is unchanged.
    db.admin(tenantSql(3));
    db.workOwner(
      `INSERT INTO morrow_billing.workspace_billing_routes VALUES('org_r3','ws_r3','shopify_install',NULL,NULL,NULL,NULL,NULL,1,${txMs},${txMs});`,
    );
    const preexisting = attempt("SET ROLE morrow_identity_owner; " + signupRowSql(3));
    check(
      "R1:signup_over_an_existing_row_refused",
      !preexisting.ok &&
        /SIGNUP_BILLING_ROUTE_INVALID/.test(preexisting.stderr) &&
        routeOf("ws_r3")?.origin === "shopify_install",
    );
    // Immutability (the owner, so only the trigger and the CHECKs stand in the way).
    const own = (statement, code) => refused("SET ROLE morrow_work_owner; " + statement, code);
    const where = "WHERE workspace_id='ws_r1'";
    const now = `updated_at=${ms}`;
    check(
      "R3:refused_changes",
      own(
        `UPDATE morrow_billing.workspace_billing_routes SET origin='shopify_install',revision=2,${now} ${where};`,
        "BILLING_ROUTE_IMMUTABLE",
      ) &&
        own(
          `UPDATE morrow_billing.workspace_billing_routes SET revision=2,${now} ${where};`,
          "BILLING_ROUTE_INVALID",
        ) &&
        own(
          `UPDATE morrow_billing.workspace_billing_routes SET route='shopify_app_pricing',mode='test',route_fixed_at=${ms},fixing_payment_key='shopify:app:1:shop:2:cycle:2026-10-01T00:00:00Z',revision=2,${now} ${where};`,
          "violates check",
        ) &&
        own(
          `UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',route_fixed_at=${ms},fixing_payment_key='pi_12345678',revision=2,${now} ${where};`,
          "violates check",
        ) &&
        own(
          `DELETE FROM morrow_billing.workspace_billing_routes ${where};`,
          "BILLING_ROUTE_IMMUTABLE",
        ) &&
        own("TRUNCATE morrow_billing.workspace_billing_routes;", "BILLING_ROUTE_IMMUTABLE"),
    );
    // R2 binding: once, while unfixed; never cleared or moved; then the Shopify route fixes.
    db.workOwner(
      `UPDATE morrow_billing.workspace_billing_routes SET shopify_bound_at=${ms},revision=2,${now} WHERE workspace_id='ws_r2';`,
    );
    check(
      "R3:binding_is_set_once_and_kept",
      routeOf("ws_r2")?.bound === true &&
        own(
          `UPDATE morrow_billing.workspace_billing_routes SET shopify_bound_at=NULL,revision=3,${now} WHERE workspace_id='ws_r2';`,
          "BILLING_ROUTE_IMMUTABLE",
        ) &&
        own(
          `UPDATE morrow_billing.workspace_billing_routes SET shopify_bound_at=shopify_bound_at-interval '1 day',revision=3,${now} WHERE workspace_id='ws_r2';`,
          "BILLING_ROUTE_IMMUTABLE",
        ) &&
        own(
          `UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',route_fixed_at=${ms},fixing_payment_key='stripe:invoice:in_ABCDEFGH12',revision=3,${now} WHERE workspace_id='ws_r2';`,
          "violates check",
        ),
    );
    db.workOwner(
      `UPDATE morrow_billing.workspace_billing_routes SET route='shopify_app_pricing',mode='test',route_fixed_at=${ms},fixing_payment_key='shopify:app:1:shop:2:cycle:2026-10-01T00:00:00Z',revision=3,${now} WHERE workspace_id='ws_r2';`,
    );
    db.workOwner(
      `UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',route_fixed_at=${ms},fixing_payment_key='stripe:invoice:in_ABCDEFGH12',revision=2,${now} ${where};`,
    );
    check(
      "R4:fixed_routes_never_change",
      routeOf("ws_r1")?.route === "morrow_direct" &&
        routeOf("ws_r2")?.route === "shopify_app_pricing" &&
        own(
          `UPDATE morrow_billing.workspace_billing_routes SET mode='live',revision=3,${now} ${where};`,
          "BILLING_ROUTE_IMMUTABLE",
        ) &&
        own(
          `UPDATE morrow_billing.workspace_billing_routes SET route='shopify_app_pricing',revision=3,${now} ${where};`,
          "BILLING_ROUTE_IMMUTABLE",
        ) &&
        own(
          `UPDATE morrow_billing.workspace_billing_routes SET shopify_bound_at=${ms},revision=3,${now} ${where};`,
          "BILLING_ROUTE_INVALID|violates check",
        ) &&
        own(
          `UPDATE morrow_billing.workspace_billing_routes SET fixing_payment_key='stripe:invoice:in_ZZZZZZZZ99',revision=4,${now} WHERE workspace_id='ws_r2';`,
          "BILLING_ROUTE_IMMUTABLE",
        ),
    );
    const fixedVariants = ["ws_r1", "ws_r2"].map((ws) => {
      try {
        return workspaceBillingRouteFromRow(routeRow(ws)).route;
      } catch {
        return null;
      }
    });
    const apiRows = db.rows(
      spineStatements.workspaceBillingRoute.replace(/\$1::text/, literal(P.A.workspace) + "::text"),
      {
        user: "morrow_api_worker",
        prefix: asApi(P.A, "").replace(/\nROLLBACK;$/, "\n"),
        suffix: "\nROLLBACK;",
      },
    );
    check(
      "R6:fixed_rows_map_and_a_missing_row_reads_shopify_install",
      JSON.stringify(fixedVariants) === JSON.stringify(["morrow_direct", "shopify_app_pricing"]) &&
        apiRows.length === 0 &&
        effectiveBillingOrigin(null) === "shopify_install",
    );
    // The api reads only its own tenant's row; the command role inserts only the unfixed
    // website shape outside its tenant (the signup bridge's policy).
    check(
      "R5:api_reads_only_its_route",
      last(
        db.sql(asApi(P.A, "SELECT count(*) FROM morrow_billing.workspace_billing_routes;"), {
          user: "morrow_api_worker",
        }),
      ) === "0" &&
        refused(
          asApi(P.A, "UPDATE morrow_billing.workspace_billing_routes SET revision=revision;"),
          "permission denied",
          "morrow_api_worker",
        ),
    );
    check(
      "R5:command_role_cannot_forge_a_fixed_route",
      refused(
        asCommandRole(
          P.A,
          `INSERT INTO morrow_billing.workspace_billing_routes VALUES('org_r2','ws_r2','website',NULL,'morrow_direct','test',${ms},'stripe:invoice:in_ABCDEFGH12',1,${txMs},${txMs});`,
        ),
        "row-level security|BILLING_ROUTE_INVALID",
      ) &&
        refused(
          asCommandRole(
            P.A,
            "UPDATE morrow_billing.workspace_billing_routes SET revision=revision+1;",
          ),
          "permission denied",
        ),
    );
    // The signup bridge's policy is bound to the website signup itself (review finding 7;
    // 0022-0023): a session-context definer cannot record a website route for another
    // tenant, nor can a context-free command-role definer for a workspace that no website
    // signup created. R1 is the admitted case (the signup's own transaction).
    const websiteRow = (p) =>
      `INSERT INTO morrow_billing.workspace_billing_routes VALUES(${literal(p.org)},${literal(p.workspace)},'website',NULL,NULL,NULL,NULL,NULL,1,${txMs},${txMs});`;
    check(
      "R5:no_website_route_without_its_signup",
      refused(asCommandRole(P.A, websiteRow(P.Y)), "row-level security") &&
        refused(
          `BEGIN; SET LOCAL ROLE morrow_work_command; ${websiteRow(P.Y)} ROLLBACK;`,
          "row-level security",
        ) &&
        refused(
          `BEGIN; SET LOCAL ROLE morrow_work_command; ${websiteRow({ org: "org_r3", workspace: "ws_r3" })} ROLLBACK;`,
          "row-level security",
        ) &&
        routeOf(P.Y.workspace) === null,
    );
  }
  // ---------------------------------------------------------------------------
  // T: the part-2 TypeScript helpers against this database. The runtime lease steps run
  // on a psql connection logged in as morrow_runtime_executor (the shape of the
  // orchestrator's leased connection), through the same runFixedSqlTransaction runner and
  // ADR-0020 D5 preflight; stop rows and the stop_active twin use the api's fixed
  // statements.
  {
    const fixedPool = (user) => {
      const connector = createLocalWorkConnector(db.id, { user });
      return {
        async connect(control) {
          const connection = await connector.open({
            signal: control.signal,
            deadlineMs: control.deadlineMs,
            waitUntil() {},
          });
          return {
            query: (text, values, c) => connection.query(text, [...values], c.signal),
            release: () => connection.close(),
          };
        },
      };
    };
    const runtimePool = fixedPool("morrow_runtime_executor");
    const attempt = () => createRuntimeAttempt(30000, new AbortController().signal);
    const where = { store: "store_t", connection: "connection_t", installation: "installation_t" };
    const run = openLease(P.A, "run", "t_run_1", where);
    const operation = openLease(P.A, "operation", "t_claim_1", where);
    const read = openLease(P.A, "read", "t_read_1", { ...where, installation: null });
    const step = (l, body = async (s) => s.lease, pool = runtimePool) =>
      runLeaseStep(pool, attempt(), { leaseId: l.id, generation: 1 }, body).catch(() => ({
        ok: false,
      }));
    const first = await step(run, async (s) => ({
      lease: s.lease,
      started: await s.markStarted(),
    }));
    const l = first.value?.lease;
    check(
      "T1:runtime_step_enters_with_the_lease_ids_and_marks_started",
      first.ok === true &&
        first.value.entered === true &&
        l.organizationId === P.A.org &&
        l.workspaceId === P.A.workspace &&
        l.kind === "run" &&
        l.subjectId === "t_run_1" &&
        l.storeId === "store_t" &&
        l.connectionId === "connection_t" &&
        l.installationId === "installation_t" &&
        l.initiatorPrincipalId === P.A.principal &&
        l.initiatorMembershipId === P.A.membership &&
        first.value.value.started === "started" &&
        lease(run.id).started === true,
      first,
    );
    const again = await step(run, async (s) => s.markStarted());
    const readStep = await step(read);
    const operationStep = await step(operation);
    check(
      "T1:later_steps_and_every_kind",
      again.value?.value === "already_started" &&
        readStep.value?.entered === true &&
        readStep.value.lease.kind === "read" &&
        readStep.value.lease.installationId === null &&
        operationStep.value?.lease?.kind === "operation",
    );
    const refusal = async (ref) =>
      (
        await runLeaseStep(runtimePool, attempt(), ref, async () => "ran").catch(() => ({
          ok: false,
        }))
      ).value?.refusal ?? null;
    check(
      "T1:forged_or_stale_references_are_refused_without_a_body",
      (await refusal({ leaseId: uuid(), generation: 1 })) === "not_found" &&
        (await refusal({ leaseId: run.id, generation: 2 })) === "not_found" &&
        (await refusal({ leaseId: "not-a-uuid", generation: 1 })) === "denied",
    );
    // The D5 preflight: any login but the runtime executor is refused before enter_lease.
    const wrongLogins = [];
    for (const user of ["morrow_api_worker", "morrow_connector_ingress", "morrow_vault_broker"])
      wrongLogins.push((await step(operation, async (s) => s.lease, fixedPool(user))).ok);
    check(
      "T1:the_role_preflight_admits_only_the_runtime_executor",
      wrongLogins.every((ok) => ok === false),
    );
    // Pending starts: exactly what the definer's own query selects, ids only.
    const pending = await listPendingStarts(runtimePool, attempt()).catch(() => ({ ok: false }));
    const expected = db
      .rows(
        "SELECT l.id::text AS id FROM morrow_work.work_leases l WHERE l.status='active' AND l.started_at IS NULL AND l.kind IN ('run','operation') AND l.expires_at>clock_timestamp() ORDER BY l.created_at,l.id LIMIT 100",
      )
      .map((r) => r.id);
    check(
      "T2:pending_starts_through_the_helper",
      pending.ok === true &&
        JSON.stringify(pending.value.map((p) => p.leaseId)) === JSON.stringify(expected) &&
        pending.value.some((p) => p.leaseId === operation.id && p.kind === "operation") &&
        !pending.value.some((p) => p.leaseId === run.id || p.leaseId === read.id) &&
        pending.value.every(
          (p) => Object.keys(p).sort().join(",") === "generation,kind,leaseId,subjectId",
        ),
    );
    const released = await step(run, async (s) => s.release());
    check(
      "T2:release_then_ended",
      released.value?.value === "released" &&
        (await refusal({ leaseId: run.id, generation: 1 })) === "ended",
    );
    // StopRecord@1 from real rows, and stopBlocks equal to stop_active over a matrix.
    const records = (stopId) =>
      db.rows(
        spineStatements.stopRecordsOfControl.replace(/\$1::text/, literal(stopId) + "::text"),
      );
    const active = () =>
      db.rows(spineStatements.activeStops).map((r) => ({
        scope: r.scope,
        organizationId: r.organization_id,
        workspaceId: r.workspace_id,
        targetId: r.target_id,
      }));
    const twins = (stops) => {
      const tenants = [
        [P.A.org, P.A.workspace],
        [P.Y.org, P.Y.workspace],
      ];
      const connections = [
        ...new Set([...stops.map((x) => x.targetId), "connection_t", "connection_none"]),
      ].filter(Boolean);
      const installations = [
        ...new Set([...stops.map((x) => x.targetId), "installation_t", "installation_none"]),
      ].filter(Boolean);
      const mismatches = [];
      const queries = [];
      const cases = [];
      for (const [org, ws] of tenants)
        for (const kind of ["read", "run", "operation"])
          for (const connection of connections)
            for (const installation of kind === "read" ? [null] : installations) {
              cases.push({
                organizationId: org,
                workspaceId: ws,
                kind,
                connectionId: connection,
                installationId: installation,
              });
              queries.push(
                `SELECT morrow_work.stop_active(${literal(org)},${literal(ws)},${literal(kind)},${literal(connection)},${literal(installation)})::text AS blocked`,
              );
            }
      const sql = db.rows(queries.join(" UNION ALL "));
      cases.forEach((work, i) => {
        if (String(stopBlocks(stops, work)) !== sql[i]?.blocked) mismatches.push(work);
      });
      return { cases: cases.length, mismatches };
    };
    const before = twins(active());
    check(
      "T3:stop_blocks_equals_stop_active",
      before.cases > 50 && before.mismatches.length === 0,
      before.mismatches.slice(0, 3),
    );
    const [setOutcome, platformId] = last(
      db.workOwner(
        "SELECT outcome||'|'||stop_id FROM morrow_work.platform_stop_set('morrow_owner','T platform stop');",
      ),
    ).split("|");
    const during = twins(active());
    db.workOwner("SELECT outcome FROM morrow_work.platform_stop_lift('morrow_owner','T lift');");
    let mappedRecords = [];
    try {
      mappedRecords = records(platformId).map(stopRecordFromRow);
    } catch {
      mappedRecords = [];
    }
    check(
      "T3:platform_stop_records_map_to_stop_record_v1",
      setOutcome === "applied" &&
        during.mismatches.length === 0 &&
        JSON.stringify(
          mappedRecords.map((r) => [
            r.action,
            r.scope,
            r.actor.kind,
            r.actor.operatorId,
            r.reasonCode,
          ]),
        ) ===
          JSON.stringify([
            ["set", "platform", "operator", "morrow_owner", "operator_platform_stop"],
            ["lift", "platform", "operator", "morrow_owner", "operator_platform_lift"],
          ]),
      mappedRecords,
    );
    check("T3:after_lift_twins_agree", twins(active()).mismatches.length === 0);
    // The api reads both through its own column grants and tenant_read: its tenant's and
    // the platform's rows, never another tenant's.
    const asApiRows = (p, text) =>
      db.rows(text, {
        user: "morrow_api_worker",
        prefix: asApi(p, "").replace(/\nROLLBACK;$/, "\n"),
        suffix: "\nROLLBACK;",
      });
    const apiActive = asApiRows(P.A, spineStatements.activeStops);
    const apiRecords = asApiRows(
      P.Y,
      spineStatements.stopRecordsOfControl.replace(/\$1::text/, literal(platformId) + "::text"),
    );
    check(
      "T3:api_reads_stops_with_its_column_grants",
      apiActive.length ===
        Math.min(
          100,
          Number(
            last(
              db.sql(
                `SELECT count(*) FROM morrow_work.stop_controls WHERE lifted_at IS NULL AND (organization_id IS NULL OR (organization_id=${literal(P.A.org)} AND workspace_id=${literal(P.A.workspace)}));`,
              ),
            ),
          ),
        ) &&
        apiActive.every(
          (r) =>
            r.organization_id === null ||
            (r.organization_id === P.A.org && r.workspace_id === P.A.workspace),
        ) &&
        apiRecords.length === 2 &&
        apiRecords.every((r) => stopRecordFromRow(r).scope === "platform"),
      { apiActive: apiActive.length, apiRecords: apiRecords.length },
    );
  }
  return { checks, failures };
}

async function main() {
  const started = Date.now();
  let result;
  await withWorkDatabase(
    "M2.PR1.spine-foundation",
    async (db) => {
      result = await runSpineFoundationLab(db);
    },
    { administrator: "createrole" },
  );
  writeArtifact("labs/spine-foundation.json", {
    task: "M2 PR-1",
    qualification: "local_postgresql17_network_none_spine_foundation",
    observedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    administrator: "createrole",
    checks: result.checks,
    providerRequests: 0,
    limitations: [
      "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, Neon transport, provider or merchant data.",
      "Runtime and vault definers of later packets are stood in for by lab-only command-owned definers (lab_probe), created by the local superuser.",
      "The vault envelopes are sealed and opened by the broker's own module (apps/broker/src/vault.ts) in Node, not in workerd; the broker reads app_secret_get over a psql connection logged in as morrow_vault_broker, not the Neon transport (wired in M2 PR-2).",
      "The runtime lease helpers run over a psql connection logged in as morrow_runtime_executor, not the Neon transport the orchestrator will lease from RuntimeBroker (M3).",
      "Credential rows are owner-seeded: their writers (install, re-authorisation, destroy) land with M2 PR-2 and PR-3.",
    ],
  });
  if (result.failures.length) {
    console.log("FAILED: " + result.failures.join(", "));
    process.exitCode = 1;
  } else console.log(`PASS: ${result.checks.length} M2 PR-1 spine foundation checks.`);
}

await main();
