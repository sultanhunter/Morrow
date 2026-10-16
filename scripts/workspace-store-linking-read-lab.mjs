import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { localStandaloneSqlPool } from "./local-standalone-sql.mjs";
import {
  createStandaloneFixtureHarness,
  standaloneSqlLiteral as lit,
} from "./standalone-session-fixtures.mjs";
import { seedStandaloneLinkingFixture } from "./fixtures/standalone-linking-fixture.mjs";
import {
  createControlledWorkspaceStoreLinking,
  workspaceStoreLinkingControlSql,
} from "../packages/identity/src/workspace-store-linking-control.ts";
import { workspaceStoreLinkingSql } from "../packages/identity/src/workspace-store-linking.ts";
const hash = (v) => createHash("sha256").update(v).digest("hex");
let failedCheck = null;
const checks = [],
  check = (name, condition) => {
    if (!condition) {
      failedCheck = name;
      throw Error("LINKING_READ_LAB_FAILED");
    }
    checks.push({ name, passed: true });
  };
const sourcePaths = [
  "scripts/workspace-store-linking-read-lab.mjs",
  "scripts/local-postgres-lab.mjs",
  "scripts/local-standalone-sql.mjs",
  "scripts/local-browser-session-sql.mjs",
  "scripts/standalone-session-fixtures.mjs",
  "scripts/fixtures/standalone-linking-fixture.mjs",
  "packages/identity/src/workspace-store-linking-control.ts",
  "packages/identity/src/workspace-store-linking.ts",
  "packages/identity/src/standalone-workspace-bootstrap.ts",
  "packages/identity/src/standalone-request-guard.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/workos-authentication-evidence.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/identity/src/workos-session-token.ts",
  "tests/fixtures/workos-authentication-evidence.mjs",
  "packages/policy/src/index.ts",
  "packages/contracts/src/validation.ts",
  "infra/identity-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  "docs/plan/source.json",
  "docs/packets/P05.T01q.md",
  "docs/packets/P05.T01r.md",
  "docs/packets/P05.T01s.md",
  "docs/packets/P05.T01t.md",
  "docs/plan/build-plan.md",
  ...JSON.parse(readFileSync("migrations/manifest.json", "utf8"))
    .migrations.slice(0, 9)
    .map((m) => "migrations/" + m.file),
];
const sourceHashes = Object.fromEntries(sourcePaths.map((p) => [p, hash(readFileSync(p))]));
const plan = JSON.parse(readFileSync("docs/plan/source.json", "utf8"));
if (plan.sources.plan.sequence !== 88) throw Error("LINKING_READ_PLAN_REQUIRED");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
if (manifest.migrations.length < 9) throw Error("LINKING_READ_MIGRATIONS_REQUIRED");
const migrations = manifest.migrations.slice(0, 9).map((m) => {
  const text = readFileSync("migrations/" + m.file, "utf8");
  if (hash(text) !== m.sha256) throw Error("LINKING_READ_MIGRATION_HASH");
  return { ...m, text };
});
const normalMetrics = [],
  faultMetrics = [],
  holderCleanup = [];
let ownedContainer;
const observed = await localPostgresLab("P05.T03b", async (context) => {
  ownedContainer = context.id;
  let phase = "setup",
    primaryFailed = false;
  const h = createStandaloneFixtureHarness(context, 9),
    pools = [],
    expectedCloseLoss = new WeakSet();
  const allowed = [
    ...Object.values(workspaceStoreLinkingControlSql),
    ...Object.values(workspaceStoreLinkingSql),
  ];
  const control = () => ({ deadlineMs: Date.now() + 5000, signal: new AbortController().signal });
  const pool = (options = {}, fault = false) => {
    const p = localStandaloneSqlPool(context.id, "morrow_identity_linking", allowed, options);
    pools.push(p);
    if (options.releaseAckLoss === true) expectedCloseLoss.add(p);
    (fault ? faultMetrics : normalMetrics).push(p.metrics);
    return p;
  };
  const closePools = async () => {
    const settled = await Promise.allSettled(pools.map((p) => p.close()));
    if (
      settled.some(
        (r, i) =>
          r.status === "rejected" &&
          !(
            expectedCloseLoss.has(pools[i]) &&
            pools[i].metrics.backendCleanupVerified === pools[i].metrics.connections &&
            pools[i].metrics.closed === pools[i].metrics.connections &&
            pools[i].metrics.unverifiedHostClosures === 0
          ),
      )
    )
      throw Error("LINKING_READ_CLEANUP_UNVERIFIED");
  };
  const service = (options = {}, fault = false) =>
    createControlledWorkspaceStoreLinking({ pool: pool(options, fault), now: Date.now });
  const count = (fx, table = "workspace_link_results") =>
    h.admin(
      `SELECT count(*) FROM morrow_identity.${table} WHERE ${table === "workspace_store_links" ? "candidate_id" : "handoff_id"}=${lit(table === "workspace_store_links" ? fx.candidateId : fx.input.handoffId)};`,
    );
  const fixture = async (options = {}) => {
    const a = await h.admitted(h.fixture());
    check(
      "fresh_owning_evidence_admits_fixture_" + h.metrics.length,
      a.result.outcome === "newly_admitted",
    );
    const fx = await seedStandaloneLinkingFixture(h, a, options);
    return fx;
  };
  const direct = (statement, role = "morrow_identity_linking") =>
    containerCommand(
      [
        "exec",
        "--interactive",
        context.id,
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
        "morrow",
      ],
      statement,
      true,
    );
  const args = (fx) =>
    [fx.input.sessionDigest, fx.workspaceId, fx.input.nonceDigest, fx.commandId].map(lit).join(",");
  // Warm private holder/observer before arming a short fixture. DB lock facts,
  // not sleep timing, prove the exact real consumer waited while still valid.
  const openHolder = async () => {
    const applicationName = "morrow_linking_holder_" + randomUUID().replaceAll("-", "");
    const child = spawn(
      "docker",
      [
        "exec",
        "--env",
        "PGAPPNAME=" + applicationName,
        "--interactive",
        context.id,
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
    let pending = null,
      buffer = "",
      total = 0;
    const finished = new Promise((resolve) =>
      child.once("close", (code, signal) => {
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(Error("LINKING_WAIT_HOLDER_UNAVAILABLE"));
          pending = null;
        }
        resolve({ code, signal });
      }),
    );
    child.once("error", () => {
      if (pending) {
        pending.reject(Error("LINKING_WAIT_HOLDER_UNAVAILABLE"));
        pending = null;
      }
    });
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk) => {
      total += chunk.length;
      buffer += chunk.toString("utf8");
      if (total > 65536) {
        child.kill("SIGKILL");
        return;
      }
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"),
          line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!pending) continue;
        if (line === pending.marker) {
          const p = pending;
          pending = null;
          clearTimeout(p.timer);
          p.resolve(p.lines.join("\n"));
        } else if (line) pending.lines.push(line);
      }
    });
    const run = (text) =>
      new Promise((resolve, reject) => {
        if (pending) return reject(Error("LINKING_WAIT_HOLDER_UNAVAILABLE"));
        const marker = "LINKING_HOLDER_" + randomUUID();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error("LINKING_WAIT_HOLDER_UNAVAILABLE"));
        }, 5000);
        pending = { marker, timer, lines: [], resolve, reject };
        child.stdin.write(text + "\n\\echo " + marker + "\n");
      });
    const pid = Number(await run("SELECT pg_backend_pid();"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("LINKING_WAIT_HOLDER_UNAVAILABLE");
    return {
      pid,
      run,
      async close() {
        child.stdin.end();
        let timeout;
        const r = await Promise.race([
          finished,
          new Promise((resolve) => {
            timeout = setTimeout(() => {
              child.kill("SIGKILL");
              resolve(null);
            }, 3000);
          }),
        ]);
        clearTimeout(timeout);
        const absent =
          context.sql(
            "SELECT count(*) FROM pg_stat_activity WHERE datname='morrow' AND usename='postgres' AND application_name=" +
              lit(applicationName) +
              ";",
            "morrow",
          ) === "0";
        const verified = r !== null && r.code === 0 && r.signal === null && absent;
        holderCleanup.push({
          hostClosedNormally: r !== null && r.code === 0 && r.signal === null,
          backendAbsent: absent,
        });
        if (!verified) throw Error("LINKING_WAIT_HOLDER_CLEANUP_UNVERIFIED");
      },
    };
  };
  const waitForExpiry = async (fx) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (
        h.admin(
          `SELECT expires_at<=clock_timestamp() FROM morrow_identity.linking_handoffs WHERE id=${lit(fx.input.handoffId)};`,
        ) === "t"
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw Error("LINKING_READ_EXPIRY_WITNESS_UNAVAILABLE");
  };
  const hidden = async (fx, selected = fx.selectorJson) => {
    const s = service();
    return (
      (await s.lookup(selected, control())) === null &&
      (await s.status(selected, control())) === null
    );
  };
  try {
    phase = "prerequisites";
    check(
      "all_nine_exact_migrations_installed",
      context.sql("SELECT count(*) FROM morrow_identity.linking_handoffs;", "morrow") === "0",
    );
    context.sql("CREATE DATABASE morrow_link_read_rollback;");
    context.sql(
      "ALTER ROLE morrow_api NOLOGIN; ALTER ROLE morrow_identity_sessions NOLOGIN; ALTER ROLE morrow_identity_linking NOLOGIN;",
      "morrow",
    );
    context.sql(
      "GRANT CREATE ON DATABASE morrow_link_read_rollback TO morrow_identity_owner;",
      "morrow_link_read_rollback",
    );
    for (const m of migrations.slice(0, 8))
      context.sql("SET ROLE morrow_identity_owner;\n" + m.text, "morrow_link_read_rollback");
    const rollback = containerCommand(
      [
        "exec",
        "--interactive",
        context.id,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "VERBOSITY=verbose",
        "-U",
        "postgres",
        "-d",
        "morrow_link_read_rollback",
      ],
      "SET ROLE morrow_identity_owner;\n" +
        migrations[8].text.replace(
          /COMMIT;\s*$/,
          () => "DO $$ BEGIN RAISE EXCEPTION 'LINKING_READ_ROLLBACK_PROBE'; END $$; COMMIT;",
        ),
      true,
    );
    check(
      "migration9_failure_rolls_back_all_new_functions",
      rollback.status !== 0 &&
        /P0001/.test(rollback.stderr) &&
        rollback.stderr.includes("LINKING_READ_ROLLBACK_PROBE") &&
        context.sql(
          "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_identity' AND p.proname IN ('bound_workspace_linking_handoff','lookup_workspace_store_link','workspace_store_link_status');",
          "morrow_link_read_rollback",
        ) === "0",
    );
    context.sql(
      "ALTER ROLE morrow_api LOGIN; ALTER ROLE morrow_identity_sessions LOGIN; ALTER ROLE morrow_identity_linking LOGIN;",
      "morrow",
    );
    check(
      "read_functions_stable_definer_fixed_path",
      context.sql(
        "SELECT count(*)=3 AND bool_and(provolatile='s' AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog, morrow_identity, pg_temp']) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_identity' AND proname IN ('bound_workspace_linking_handoff','lookup_workspace_store_link','workspace_store_link_status');",
        "morrow",
      ) === "t",
    );
    for (const role of [
      "morrow_api",
      "morrow_identity_lifecycle",
      "morrow_identity_preauth",
      "morrow_identity_resolution",
      "morrow_identity_sessions",
    ]) {
      check(
        "no_read_function_acl_" + role,
        context.sql(
          `SELECT NOT has_function_privilege(${lit(role)},'morrow_identity.lookup_workspace_store_link(text,text,text,text)','EXECUTE') AND NOT has_function_privilege(${lit(role)},'morrow_identity.workspace_store_link_status(text,text,text,text)','EXECUTE');`,
          "morrow",
        ) === "t",
      );
    }
    check(
      "linking_has_only_public_read_entries",
      context.sql(
        "SELECT has_function_privilege('morrow_identity_linking','morrow_identity.lookup_workspace_store_link(text,text,text,text)','EXECUTE') AND has_function_privilege('morrow_identity_linking','morrow_identity.workspace_store_link_status(text,text,text,text)','EXECUTE') AND NOT has_function_privilege('morrow_identity_linking','morrow_identity.bound_workspace_linking_handoff(text,text,text,text)','EXECUTE');",
        "morrow",
      ) === "t",
    );
    for (const table of [
      "linking_handoffs",
      "linking_reviews",
      "linking_candidates",
      "workspace_link_results",
      "workspace_store_links",
    ]) {
      const denied = direct("SELECT * FROM morrow_identity." + table + ";");
      check(
        "linking_private_table_denied_" + table,
        denied.status !== 0 && /42501/.test(denied.stderr),
      );
      check(
        "force_rls_" + table,
        context.sql(
          `SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=${lit("morrow_identity." + table)}::regclass;`,
          "morrow",
        ) === "t",
      );
    }
    phase = "fixtures";
    const first = await fixture({ handoffSeconds: 30, reviewSeconds: 30 }),
      s = service(),
      preview = await s.lookup(first.selectorJson, control());
    check(
      "lookup_exact_immutable_eleven_tuple",
      JSON.stringify(preview) === JSON.stringify(first.input),
    );
    check(
      "unconsumed_status_has_no_fabricated_result",
      (await s.status(first.selectorJson, control())) === null,
    );
    check(
      "lookup_and_status_have_no_mutation",
      count(first) === "0" && count(first, "workspace_store_links") === "0",
    );
    const applied = await s.apply(JSON.stringify(preview), control());
    check(
      "unchanged_writer_applies_once",
      applied.outcome === "applied" &&
        applied.policyRevision === 2 &&
        applied.ownershipRevision === 2 &&
        count(first) === "1" &&
        count(first, "workspace_store_links") === "1",
    );
    check(
      "status_exact_original_terminal_result",
      JSON.stringify(await s.status(first.selectorJson, control())) === JSON.stringify(applied),
    );
    check(
      "lookup_after_apply_remains_same_command",
      JSON.stringify(await s.lookup(first.selectorJson, control())) === JSON.stringify(first.input),
    );
    const replay = await s.apply(JSON.stringify(first.input), control());
    check(
      "exact_replay_original_result_no_second_write",
      JSON.stringify(replay) === JSON.stringify(applied) && count(first) === "1",
    );
    await waitForExpiry(first);
    check(
      "receipt_and_review_ttls_actually_expired",
      h.admin(
        `SELECT h.expires_at<clock_timestamp() AND r.expires_at<clock_timestamp() FROM morrow_identity.linking_handoffs h JOIN morrow_identity.linking_reviews r ON r.id=h.review_id WHERE h.id=${lit(first.input.handoffId)};`,
      ) === "t",
    );
    check(
      "terminal_status_after_old_receipt_expiry_is_readonly",
      JSON.stringify(await s.status(first.selectorJson, control())) === JSON.stringify(applied) &&
        count(first) === "1",
    );
    check(
      "old_command_replay_not_new_authority",
      JSON.stringify(await s.apply(JSON.stringify(first.input), control())) ===
        JSON.stringify(applied) && count(first) === "1",
    );
    const raw = direct(
      `BEGIN READ ONLY; SELECT count(*) FROM morrow_identity.workspace_store_link_status(${args(first)}); SELECT current_setting('transaction_read_only'); COMMIT;`,
    );
    check(
      "genuine_status_runs_in_readonly_transaction",
      raw.status === 0 && raw.stdout.trim() === "1\non",
    );
    const spoof = direct(
      `SET ROLE morrow_identity_linking; SELECT count(*) FROM morrow_identity.workspace_store_link_status(${args(first)});`,
      "postgres",
    );
    check(
      "set_role_cannot_substitute_exact_session_user",
      spoof.status === 0 && spoof.stdout.trim() === "0",
    );
    for (const [key, value] of [
      ["sessionDigest", "f".repeat(64)],
      ["workspaceId", "foreign_workspace"],
      ["nonceDigest", "e".repeat(64)],
      ["commandId", randomUUID()],
    ]) {
      check(
        "foreign_" + key + "_has_no_lookup_or_status",
        await hidden(first, JSON.stringify({ ...JSON.parse(first.selectorJson), [key]: value })),
      );
    }
    const stale = await fixture({ handoffSeconds: 1, reviewSeconds: 1 });
    await waitForExpiry(stale);
    check(
      "unconsumed_expired_handoff_never_exposes_command",
      (await hidden(stale)) && count(stale) === "0",
    );
    for (const [label, mutate] of [
      [
        "grant_payload",
        (fx) =>
          `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(clock_timestamp()::text)) WHERE id=${lit(fx.grantId)};`,
      ],
      [
        "review",
        (fx) =>
          `UPDATE morrow_identity.linking_reviews SET revoked_at=clock_timestamp() WHERE id=${lit(fx.reviewId)};`,
      ],
      [
        "proof",
        (fx) =>
          `UPDATE morrow_identity.linking_candidates SET proof_revoked_at=clock_timestamp() WHERE id=${lit(fx.candidateId)};`,
      ],
      [
        "ownership",
        (fx) =>
          `UPDATE morrow_identity.linking_candidates SET ownership_revision=ownership_revision+1 WHERE id=${lit(fx.candidateId)};`,
      ],
      [
        "membership",
        (fx) =>
          `UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id=${lit(fx.workspaceId)};`,
      ],
      [
        "profile",
        (fx) =>
          `UPDATE morrow_identity.identity_verification_profiles SET state='revoked',record_revision=record_revision+1 WHERE id=${lit(fx.admitted.f.profile)};`,
      ],
      [
        "family",
        (fx) =>
          `SELECT * FROM morrow_identity.revoke_browser_family(${lit(fx.admitted.result.credential.familyId)},${lit(randomUUID())},${lit(hash(randomUUID()))});`,
      ],
      [
        "policy",
        (fx) =>
          `UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id=${lit(fx.input.organizationId)};`,
      ],
    ]) {
      const fx = await fixture(),
        before = await service().lookup(fx.selectorJson, control());
      check("current_" + label + "_precondition_initially_eligible", before !== null);
      h.admin(mutate(fx));
      check("current_" + label + "_drift_hides_unconsumed_lookup", await hidden(fx));
      const result = await service().apply(JSON.stringify(before), control());
      check(
        "unchanged_locked_writer_rejects_" + label + "_after_lookup",
        result.outcome === "denied" && count(fx, "workspace_store_links") === "0",
      );
    }
    phase = "waits";
    for (const label of [
      "proof",
      "review",
      "grant",
      "membership",
      "profile",
      "session",
      "ownership",
      "policy",
      "expiry",
    ]) {
      const a = await h.admitted(h.fixture()),
        holder = await openHolder(),
        consumer = pool();
      let owned;
      try {
        owned = await consumer.connect({
          deadlineMs: Date.now() + 15000,
          signal: new AbortController().signal,
        });
        const pidText = await holder.run(
          "SELECT pid FROM pg_stat_activity WHERE datname='morrow' AND usename='morrow_identity_linking' AND application_name LIKE 'morrow_standalone_%';",
        );
        const consumerPid = Number(pidText);
        check(
          "wait_" + label + "_unique_warmed_real_consumer",
          /^[1-9][0-9]*$/.test(pidText) && Number.isSafeInteger(consumerPid),
        );
        const fx = await seedStandaloneLinkingFixture(
          h,
          a,
          label === "expiry" ? { handoffSeconds: 3 } : {},
        );
        await holder.run(
          "BEGIN; SET ROLE morrow_identity_owner; SELECT 1 FROM morrow_identity.organizations WHERE id=" +
            lit(fx.input.organizationId) +
            " FOR UPDATE; RESET ROLE;",
        );
        let adoption = 0;
        const waitingService = createControlledWorkspaceStoreLinking({
          pool: {
            connect: async () => {
              if (adoption++) throw Error("SYNTHETIC_ALREADY_ADOPTED");
              return owned;
            },
          },
          now: Date.now,
        });
        const attempt = waitingService.apply(JSON.stringify(fx.input), control());
        void attempt.catch(() => {});
        let witnessed = false;
        const witnessDeadline = Date.now() + 1500;
        while (Date.now() < witnessDeadline) {
          const fact = await holder.run(
            `SELECT pg_stat_clear_snapshot(); WITH fact AS MATERIALIZED (SELECT ${holder.pid}=ANY(pg_blocking_pids(${consumerPid})) AND EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${consumerPid} AND wait_event_type='Lock') AS blocked) SELECT blocked AND (SELECT expires_at>clock_timestamp() FROM morrow_identity.linking_handoffs WHERE id=${lit(fx.input.handoffId)}) FROM fact;`,
          );
          if (fact === "t") {
            witnessed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        check("wait_" + label + "_exact_consumer_blocked_by_holder_while_valid", witnessed);
        if (label === "expiry") {
          let expired = false;
          const end = Date.now() + 3500;
          while (Date.now() < end) {
            if (
              (await holder.run(
                `SELECT expires_at<=clock_timestamp() FROM morrow_identity.linking_handoffs WHERE id=${lit(fx.input.handoffId)};`,
              )) === "t"
            ) {
              expired = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          check("wait_expiry_independent_database_clock_witness", expired);
        }
        const mutations = {
          proof: `UPDATE morrow_identity.linking_candidates SET proof_revoked_at=clock_timestamp() WHERE id=${lit(fx.candidateId)};`,
          review: `UPDATE morrow_identity.linking_reviews SET revoked_at=clock_timestamp() WHERE id=${lit(fx.reviewId)};`,
          grant: `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(clock_timestamp()::text)) WHERE id=${lit(fx.grantId)};`,
          membership: `UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id=${lit(fx.workspaceId)};`,
          profile: `UPDATE morrow_identity.identity_verification_profiles SET state='revoked',record_revision=record_revision+1 WHERE id=${lit(a.f.profile)};`,
          session: `SELECT * FROM morrow_identity.revoke_browser_family(${lit(a.result.credential.familyId)},${lit(randomUUID())},${lit(hash(randomUUID()))});`,
          ownership: `UPDATE morrow_identity.linking_candidates SET ownership_revision=ownership_revision+1 WHERE id=${lit(fx.candidateId)};`,
          policy: `UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id=${lit(fx.input.organizationId)};`,
          expiry: "",
        };
        await holder.run(
          "SET ROLE morrow_identity_owner; " + mutations[label] + " COMMIT; RESET ROLE;",
        );
        const denied = await attempt;
        check(
          "wait_" + label + "_sql_denied_not_application_timeout",
          denied.outcome === "denied" &&
            denied.auditId !== null &&
            count(fx) === "1" &&
            count(fx, "workspace_store_links") === "0",
        );
      } finally {
        const cleanup = await Promise.allSettled([holder.close(), owned?.release(true)]);
        if (cleanup.some((r) => r.status === "rejected"))
          throw Error("LINKING_WAIT_CLEANUP_UNVERIFIED");
      }
    }
    phase = "concurrency";
    const shared = await fixture(),
      concurrent = await Promise.all([
        service().apply(JSON.stringify(shared.input), control()),
        service().apply(JSON.stringify(shared.input), control()),
      ]);
    check(
      "concurrent_identical_commands_one_terminal",
      concurrent.every((x) => x.outcome === "applied") &&
        JSON.stringify(concurrent[0]) === JSON.stringify(concurrent[1]) &&
        count(shared) === "1" &&
        count(shared, "workspace_store_links") === "1",
    );
    phase = "faults";
    const uncertain = await fixture(),
      traced = [];
    try {
      await service({ commitAckLoss: true, beforeQuery: async (t) => traced.push(t) }, true).apply(
        JSON.stringify(uncertain.input),
        control(),
      );
      check("commit_ack_loss_is_unknown", false);
    } catch (e) {
      check("commit_ack_loss_is_unknown", e.code === "WORKSPACE_LINKING_OUTCOME_UNKNOWN");
    }
    check(
      "unknown_commit_has_no_rollback_or_retry",
      traced.at(-1) === workspaceStoreLinkingSql.commit &&
        traced.filter((x) => x === workspaceStoreLinkingSql.apply).length === 1 &&
        !traced.includes(workspaceStoreLinkingSql.rollback),
    );
    check(
      "readonly_status_recovers_unknown_committed_result",
      (await service().status(uncertain.selectorJson, control()))?.outcome === "applied" &&
        count(uncertain) === "1",
    );
    const releaseUncertain = await fixture();
    try {
      await service({ releaseAckLoss: true }, true).apply(
        JSON.stringify(releaseUncertain.input),
        control(),
      );
      check("release_ack_loss_is_unknown", false);
    } catch (e) {
      check("release_ack_loss_is_unknown", e.code === "WORKSPACE_LINKING_OUTCOME_UNKNOWN");
    }
    check(
      "readonly_status_recovers_release_uncertainty",
      (await service().status(releaseUncertain.selectorJson, control()))?.outcome === "applied" &&
        count(releaseUncertain) === "1",
    );
    const cancelled = await fixture(),
      abort = new AbortController(),
      cancelledTrace = [];
    try {
      await service(
        {
          afterQuery: async (t) => {
            cancelledTrace.push(t);
            if (t === workspaceStoreLinkingSql.apply) abort.abort();
          },
        },
        true,
      ).apply(JSON.stringify(cancelled.input), {
        deadlineMs: Date.now() + 5000,
        signal: abort.signal,
      });
      check("abort_after_reply_holds", false);
    } catch (e) {
      check("abort_after_reply_holds", e.code === "WORKSPACE_LINKING_OUTCOME_UNKNOWN");
    }
    check(
      "abort_has_no_next_commit_or_rollback",
      cancelledTrace.at(-1) === workspaceStoreLinkingSql.apply &&
        !cancelledTrace.includes(workspaceStoreLinkingSql.commit) &&
        !cancelledTrace.includes(workspaceStoreLinkingSql.rollback),
    );
    await closePools();
    check(
      "aborted_transaction_not_persisted",
      count(cancelled) === "0" && count(cancelled, "workspace_store_links") === "0",
    );
    phase = "privileges";
    const unsafe = await fixture();
    context.sql("ALTER ROLE morrow_identity_linking REPLICATION;", "morrow");
    const deniedUnsafe = direct(
      `SELECT count(*) FROM morrow_identity.lookup_workspace_store_link(${args(unsafe)});`,
    );
    check(
      "database_definer_rechecks_replication_role_drift",
      deniedUnsafe.status === 0 && deniedUnsafe.stdout.trim() === "0",
    );
    context.sql("ALTER ROLE morrow_identity_linking NOREPLICATION;", "morrow");
    check(
      "session_grant_proof_values_never_public_reported",
      !JSON.stringify({ checks }).includes(unsafe.input.nonceDigest),
    );
    phase = "final_checks";
    await h.close();
    check(
      "all_nine_wait_holders_host_and_backend_closed",
      holderCleanup.length === 9 &&
        holderCleanup.every((x) => x.hostClosedNormally && x.backendAbsent),
    );
    check(
      "all_normal_clients_guest_and_host_cleanup_verified",
      normalMetrics.every(
        (m) =>
          m.connections === m.released &&
          m.released === m.closed &&
          m.closed === m.backendCleanupVerified &&
          m.unverifiedHostClosures === 0,
      ),
    );
    check(
      "fault_outcome_uncertainty_separate_from_cleanup",
      faultMetrics.length === 3 &&
        faultMetrics.every(
          (m) =>
            m.connections === m.released &&
            m.closed === m.backendCleanupVerified &&
            m.unverifiedHostClosures === 0,
        ),
    );
    check(
      "issuer_fixture_clients_cleanup_verified",
      h.metrics.every((m) => m.connections === m.released && m.closed === m.backendCleanupVerified),
    );
    check(
      "raw_bearer_tokens_never_in_child_output",
      pools.every((p) =>
        p.observed.every((out) =>
          h.secrets
            .filter((secret) => !/^[a-f0-9]{64}$/.test(secret))
            .every((secret) => !JSON.stringify(out).includes(secret)),
        ),
      ),
    );
    return { image: context.image, version: context.version };
  } catch {
    primaryFailed = true;
    throw Error("LINKING_READ_PRIMARY_FAILED");
  } finally {
    const cleanup = await Promise.allSettled([closePools(), h.close()]);
    const cleanupFailed = cleanup.some((r) => r.status === "rejected");
    if (primaryFailed || cleanupFailed) {
      // Owned counters only. Never inspect/serialize an Error, process output,
      // SQL, actor identifier, digest, bearer or database row. Observability
      // cannot prevent either cleanup attempt or replace the failure state.
      try {
        const safeName = (name) =>
          typeof name === "string" && /^[a-z0-9_]{1,128}$/.test(name) ? name : null;
        const project = (m) =>
          Object.fromEntries(
            [
              "connections",
              "released",
              "closed",
              "discarded",
              "cancelled",
              "backendCleanupVerified",
              "unverifiedHostClosures",
            ].map((key) => [
              key,
              Number.isSafeInteger(m[key]) && m[key] >= 0 && m[key] <= 10000 ? m[key] : null,
            ]),
          );
        console.error(
          "LINKING_READ_DIAGNOSTIC " +
            JSON.stringify({
              phase,
              primaryFailed,
              cleanupFailed,
              failedCheck: safeName(failedCheck),
              lastPassedCheck: safeName(checks.at(-1)?.name),
              cleanupSettled: { linkingPools: cleanup[0].status, issuerPools: cleanup[1].status },
              linkingPools: pools.slice(0, 256).map((p, index) => ({
                index,
                class: faultMetrics.includes(p.metrics) ? "fault" : "normal",
                knownReleaseAckLoss: expectedCloseLoss.has(p),
                ...project(p.metrics),
              })),
              issuerPools: h.metrics.slice(0, 256).map(project),
              holders: holderCleanup.slice(0, 16).map((m) => ({
                hostClosedNormally: m.hostClosedNormally === true,
                backendAbsent: m.backendAbsent === true,
              })),
            }),
        );
      } catch {
        /* Failure-only diagnostics never affect cleanup or acceptance. */
      }
    }
    if (cleanupFailed)
      throw Error(
        primaryFailed
          ? "LINKING_READ_PRIMARY_AND_CLEANUP_UNVERIFIED"
          : "LINKING_READ_CLEANUP_UNVERIFIED",
      );
  }
});
check(
  "exact_owned_container_absent",
  containerCommand([
    "ps",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    "id=" + ownedContainer,
  ]).stdout.trim() === "",
);
check(
  "all_source_hashes_unchanged",
  sourcePaths.every((p) => hash(readFileSync(p)) === sourceHashes[p]),
);
const report = {
  packet: "P05.T03b",
  canonicalSequence: 88,
  scope:
    "controlled owner-seeded synthetic store-linking read boundaries with fresh independently signed owning76 evidence and actual M-family admission",
  providerCalls: 0,
  localNetwork: "none",
  ...observed,
  sourceHashes,
  migrationHashes: Object.fromEntries(migrations.map((m) => [m.file, m.sha256])),
  checks,
  checkCount: checks.length,
  normalCleanup: normalMetrics,
  holderCleanup,
  faultCleanup: faultMetrics,
  containerAbsent: true,
  limitations: [
    "No Shopify verification, handoff/review issuer or merchant activation.",
    "Fault outcomes remain unknown even when local host/backend cleanup is verified.",
  ],
};
if (new Set(checks.map((x) => x.name)).size !== checks.length)
  throw Error("LINKING_READ_DUPLICATE_CHECK");
mkdirSync("docs/evidence/P05.T01t/regressions", { recursive: true });
writeFileSync(
  "docs/evidence/P05.T01t/regressions/workspace-linking-read.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    packet: report.packet,
    checkCount: report.checkCount,
    providerCalls: 0,
    containerAbsent: true,
  }),
);
