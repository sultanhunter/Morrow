import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { createStandaloneLoginFixtureHarness } from "./fixtures/standalone-login-fixture.mjs";
import { standaloneSqlLiteral as lit } from "./standalone-session-fixtures.mjs";
import {
  createLoginFlowCustody,
  createLoginFlowMaintenance,
  loginFlowCustodySql as sql,
} from "../packages/identity/src/login-flow-custody.ts";
import { authenticationExchangeAdmissionSql as preauthSql } from "../packages/identity/src/authentication-exchange-admission.ts";
import { runControlledPreauth } from "../packages/identity/src/login-preauth-control.ts";
import { createLoginAttempt } from "../packages/identity/src/standalone-login-protocol.ts";
const hash = (v) => createHash("sha256").update(v).digest("hex"),
  checks = [],
  check = (name, value) => {
    if (!value) throw Error("LOGIN_CUSTODY_LAB_FAILED:" + name);
    checks.push({ name, passed: true });
    console.log(JSON.stringify({ check: name, passed: true }));
  };
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const selectedMigrations = manifest.migrations.slice(0, 10);
const executionPlan = JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan;
const executionSequence = executionPlan.sequence;
const sourcePaths = [
  "scripts/login-flow-custody-lab.mjs",
  "scripts/local-postgres-lab.mjs",
  "scripts/local-login-flow-sql.mjs",
  "scripts/local-browser-session-sql.mjs",
  "scripts/standalone-session-fixtures.mjs",
  "scripts/fixtures/standalone-login-fixture.mjs",
  "packages/identity/src/login-flow-custody.ts",
  "packages/identity/src/login-preauth-control.ts",
  "packages/identity/src/standalone-login-protocol.ts",
  "packages/identity/src/authentication-exchange-admission.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/workos-authentication-evidence.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/identity/src/workos-session-token.ts",
  "tests/fixtures/workos-authentication-evidence.mjs",
  "infra/identity-role-prerequisites.sql",
  "infra/identity-login-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  "docs/plan/source.json",
  "docs/plan/build-plan.md",
  "docs/packets/P05.T01p.md",
  "docs/packets/P05.T01r.md",
  "docs/packets/P05.T01s.md",
  "docs/packets/P05.T01t.md",
  ...selectedMigrations.map((m) => "migrations/" + m.file),
];
const sourceHashes = Object.fromEntries(sourcePaths.map((p) => [p, hash(readFileSync(p))]));
if (
  !Number.isSafeInteger(executionSequence) ||
  executionSequence < 84 ||
  executionPlan.path !== "docs/plan/build-plan.md" ||
  executionPlan.sha256 !== hash(readFileSync("docs/plan/build-plan.md")) ||
  selectedMigrations.length !== 10 ||
  selectedMigrations.some(
    (m, index) =>
      m.sequence !== index + 1 || hash(readFileSync("migrations/" + m.file)) !== m.sha256,
  )
)
  throw Error("LOGIN_CUSTODY_PLAN_REQUIRED");
let container,
  metrics = [],
  faultMetrics = [],
  holderCleanup = [];
const secrets = [];
const observed = await localPostgresLab("P05.T01p-custody", async (context) => {
  container = context.id;
  const h = createStandaloneLoginFixtureHarness(context),
    count = (text) => Number(h.admin(text)),
    control = () => ({ deadlineMs: Date.now() + 5000, signal: new AbortController().signal });
  const owned = (role = "morrow_identity_login", options = {}, fault = false) => {
    const p = h.pool(role, [...Object.values(sql), ...Object.values(preauthSql)], options);
    (fault ? faultMetrics : metrics).push(p.metrics);
    return p;
  };
  const custody = (options = {}, fault = false) =>
    createLoginFlowCustody({ pool: owned("morrow_identity_login", options, fault), now: Date.now });
  const maintain = () =>
    createLoginFlowMaintenance({ pool: owned("morrow_identity_login_maintenance"), now: Date.now });
  const intent = (x) => ({
    schemaVersion: 1,
    configurationDigest: x.configurationDigest,
    flowId: randomUUID(),
    beginCommandId: randomUUID(),
    admissionCommandId: randomUUID(),
    issuerCommandId: randomUUID(),
    workspaceId: x.f.workspace,
  });
  const attempt = () => createLoginAttempt(Date.now, new AbortController().signal, 5000);
  async function begun(x, selected) {
    const a = attempt();
    try {
      return await runControlledPreauth(
        owned("morrow_identity_preauth"),
        x.authenticationBindingJson,
        a,
        (s) => s.begin(JSON.stringify({ commandId: selected.beginCommandId })),
      );
    } finally {
      a.end();
    }
  }
  async function ready(x = h.configured()) {
    const selected = intent(x),
      service = custody(),
      created = await service.createIntent(JSON.stringify(selected), control());
    check("create_" + checks.length, created.outcome === "newly_created");
    const begin = await begun(x, selected);
    check("begin_" + checks.length, !!begin);
    secrets.push(begin.state, begin.browserProof, begin.verifier);
    const key = randomUUID(),
      state = hash(begin.state),
      cookie = hash(randomBytes(32)),
      browser = hash(begin.browserProof),
      verifier = hash(begin.verifier);
    const aad = hash(
      JSON.stringify([
        "morrow.login.capsule",
        "1",
        x.configurationDigest,
        selected.flowId,
        begin.challengeId,
        selected.beginCommandId,
        selected.admissionCommandId,
        selected.issuerCommandId,
        x.f.workspace,
        created.expires_at_ms,
        state,
        cookie,
        browser,
        verifier,
        key,
      ]),
    );
    const bind = {
      schemaVersion: 1,
      configurationDigest: x.configurationDigest,
      flowId: selected.flowId,
      expectedRevision: "1",
      challengeId: begin.challengeId,
      stateDigest: state,
      cookieDigest: cookie,
      browserProofDigest: browser,
      verifierDigest: verifier,
      ciphertext: randomBytes(48).toString("base64url"),
      encryptionNonce: randomBytes(12).toString("base64url"),
      keyId: key,
      aadDigest: aad,
    };
    const bound = await service.bindBegin(JSON.stringify(bind), control());
    check(
      "ready_" + checks.length,
      bound.outcome === "newly_ready" &&
        bound.flow_revision === "2" &&
        bound.expires_at_ms === created.expires_at_ms,
    );
    return {
      x,
      selected,
      service,
      created,
      begin,
      bind,
      claim: {
        schemaVersion: 1,
        configurationDigest: x.configurationDigest,
        cookieDigest: cookie,
        stateDigest: state,
        codeDigest: hash(randomBytes(32)),
      },
    };
  }
  const rec = (v) =>
    JSON.stringify({
      schemaVersion: 1,
      configurationDigest: v.x.configurationDigest,
      flowId: v.selected.flowId,
      beginCommandId: v.selected.beginCommandId,
      admissionCommandId: v.selected.admissionCommandId,
      issuerCommandId: v.selected.issuerCommandId,
    });
  const select = (v) =>
    JSON.stringify({
      schemaVersion: 1,
      flowId: v.selected.flowId,
      configurationDigest: v.x.configurationDigest,
    });
  const ownerDenied = (name, statement, code = "P0001", fixed = null) => {
    const r = containerCommand(
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
        "morrow",
      ],
      "SET ROLE morrow_identity_owner;\n" + statement,
      true,
    );
    check(name, r.status !== 0 && r.stderr.includes(code) && (!fixed || r.stderr.includes(fixed)));
  };
  const openHolder = async () => {
    const applicationName = "morrow_login_holder_" + randomUUID().replaceAll("-", "");
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
          pending.reject(Error("LOGIN_WAIT_HOLDER_UNAVAILABLE"));
          pending = null;
        }
        resolve({ code, signal });
      }),
    );
    child.once("error", () => {
      if (pending) {
        pending.reject(Error("LOGIN_WAIT_HOLDER_UNAVAILABLE"));
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
        if (pending) return reject(Error("LOGIN_WAIT_HOLDER_UNAVAILABLE"));
        const marker = "LINKING_HOLDER_" + randomUUID();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error("LOGIN_WAIT_HOLDER_UNAVAILABLE"));
        }, 5000);
        pending = { marker, timer, lines: [], resolve, reject };
        child.stdin.write(text + "\n\\echo " + marker + "\n");
      });
    const pid = Number(await run("SELECT pg_backend_pid();"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("LOGIN_WAIT_HOLDER_UNAVAILABLE");
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
        if (!verified) throw Error("LOGIN_WAIT_HOLDER_CLEANUP_UNVERIFIED");
      },
    };
  };
  try {
    check(
      "ten_exact_immutable_migrations",
      manifest.migrations.every((m) => hash(readFileSync("migrations/" + m.file)) === m.sha256),
    );
    check(
      "six_force_rls_owner_tables",
      count(
        "SELECT count(*) FROM pg_class WHERE relnamespace='morrow_identity'::regnamespace AND relname IN ('login_controller_configurations','login_flow_quotas','login_command_guards','login_flows','login_flow_events','login_flow_tombstones') AND relrowsecurity AND relforcerowsecurity",
      ) === 6,
    );
    check(
      "login_exact_five_executes",
      count(
        "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_identity' AND has_function_privilege('morrow_identity_login',p.oid,'EXECUTE')",
      ) === 5,
    );
    check(
      "maintenance_exact_one_execute",
      count(
        "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_identity' AND has_function_privilege('morrow_identity_login_maintenance',p.oid,'EXECUTE')",
      ) === 1,
    );
    for (const table of [
      "login_controller_configurations",
      "login_flow_quotas",
      "login_command_guards",
      "login_flows",
      "login_flow_events",
      "login_flow_tombstones",
    ]) {
      check(
        "login_no_table_" + table,
        count(
          `SELECT has_table_privilege('morrow_identity_login','morrow_identity.${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')::int`,
        ) === 0,
      );
      check(
        "maintenance_no_table_" + table,
        count(
          `SELECT has_table_privilege('morrow_identity_login_maintenance','morrow_identity.${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')::int`,
        ) === 0,
      );
    }
    const v = await ready();
    ownerDenied(
      "owner_no_flow_reset",
      `UPDATE morrow_identity.login_flows SET phase='intent',revision=1 WHERE id=${lit(v.selected.flowId)}`,
      "P0001",
      "LOGIN_RECORD_IMMUTABLE",
    );
    ownerDenied(
      "owner_no_command_delete",
      `DELETE FROM morrow_identity.login_command_guards WHERE flow_id=${lit(v.selected.flowId)}`,
      "P0001",
      "LOGIN_RECORD_IMMUTABLE",
    );
    ownerDenied(
      "owner_no_event_delete",
      `DELETE FROM morrow_identity.login_flow_events WHERE flow_id=${lit(v.selected.flowId)}`,
      "P0001",
      "LOGIN_RECORD_IMMUTABLE",
    );
    ownerDenied(
      "owner_no_grouped_truncate",
      "TRUNCATE morrow_identity.login_flow_events,morrow_identity.login_flows,morrow_identity.login_command_guards,morrow_identity.login_flow_quotas,morrow_identity.login_controller_configurations CASCADE",
      "P0001",
      "LOGIN_RECORD_IMMUTABLE",
    );
    check(
      "not_claimed_ineligible",
      !(await v.service.observeEligibility(select(v), control())).matches,
    );
    check(
      "wrong_cookie_held",
      (
        await v.service.claimCallback(
          JSON.stringify({ ...v.claim, cookieDigest: "0".repeat(64) }),
          control(),
        )
      ).outcome === "held",
    );
    const claims = await Promise.all([
      v.service.claimCallback(JSON.stringify(v.claim), control()),
      custody().claimCallback(JSON.stringify(v.claim), control()),
    ]);
    check(
      "concurrent_claim_exactly_one_capsule",
      claims.filter((r) => r.outcome === "newly_claimed" && r.ciphertext === v.bind.ciphertext)
        .length === 1 &&
        claims.filter((r) => r.outcome === "held" && r.ciphertext === null).length === 1,
    );
    check(
      "claim_cipher_physically_null",
      count(
        `SELECT count(*) FROM morrow_identity.login_flows WHERE id=${lit(v.selected.flowId)} AND phase='claimed' AND revision=3 AND ciphertext IS NULL AND capsule_erased_at IS NOT NULL`,
      ) === 1,
    );
    check(
      "claimed_eligibility_true",
      (await v.service.observeEligibility(select(v), control())).matches,
    );
    check(
      "replayed_bind_never_returns_capsule",
      (await v.service.bindBegin(JSON.stringify(v.bind), control())).outcome === "held",
    );
    const before = await v.service.reconcile(rec(v), control());
    check(
      "reconcile_claim_only_historical",
      before.outcome === "observed" &&
        before.phase === "claimed" &&
        before.admission_id === null &&
        before.issuer_outcome === null &&
        !Object.hasOwn(before, "ciphertext"),
    );
    const a = attempt();
    let reservation;
    try {
      reservation = await runControlledPreauth(
        owned("morrow_identity_preauth"),
        v.x.authenticationBindingJson,
        a,
        (s) =>
          s.admit(
            JSON.stringify({
              commandId: v.selected.admissionCommandId,
              challengeId: v.begin.challengeId,
              state: v.begin.state,
              browserProof: v.begin.browserProof,
              verifier: v.begin.verifier,
              code: "synthetic-original-code",
            }),
          ),
      );
    } finally {
      a.end();
    }
    // The SQL code commitment is opaque; bind the same code used by the fixture.
    check(
      "different_code_receipt_not_attributed",
      reservation.outcome === "newly_reserved" &&
        (await v.service.reconcile(rec(v), control())).outcome === "held",
    );
    const good = await ready();
    good.claim.codeDigest = hash("synthetic-matched-code");
    await good.service.claimCallback(JSON.stringify(good.claim), control());
    const b = attempt();
    try {
      const r = await runControlledPreauth(
        owned("morrow_identity_preauth"),
        good.x.authenticationBindingJson,
        b,
        (s) =>
          s.admit(
            JSON.stringify({
              commandId: good.selected.admissionCommandId,
              challengeId: good.begin.challengeId,
              state: good.begin.state,
              browserProof: good.begin.browserProof,
              verifier: good.begin.verifier,
              code: "synthetic-matched-code",
            }),
          ),
      );
      check("original_69_reservation", r.outcome === "newly_reserved");
    } finally {
      b.end();
    }
    check(
      "exact_69_receipt_attribution",
      (await good.service.reconcile(rec(good), control())).admission_id !== null,
    );
    good.x.f.selector.commandId = good.selected.issuerCommandId;
    const issued = await h.admitted(good.x.f);
    check("owning_76_M_issuer", issued.result.outcome === "newly_admitted");
    const history = await good.service.reconcile(rec(good), control());
    check(
      "exact_M_admitted_attribution",
      history.issuer_outcome === "admitted" &&
        history.family_id === issued.result.credential.familyId &&
        history.issuer_request_digest === issued.result.correlation.requestDigest,
    );
    h.admin(
      `SELECT * FROM morrow_identity.revoke_browser_family(${lit(history.family_id)},${lit(randomUUID())},${lit(hash("revoke"))});`,
    );
    check(
      "revoked_M_stays_historical",
      (await good.service.reconcile(rec(good), control())).issuer_outcome === "admitted",
    );
    const x = await ready();
    h.admin(
      `UPDATE morrow_identity.identity_verification_profiles SET state='revoked',record_revision=record_revision+1 WHERE id=${lit(x.x.f.profile)};`,
    );
    check(
      "profile_drift_denies_claim",
      (await x.service.claimCallback(JSON.stringify(x.claim), control())).outcome === "denied",
    );
    check(
      "profile_drift_does_not_erase_capsule",
      count(
        `SELECT count(*) FROM morrow_identity.login_flows WHERE id=${lit(x.selected.flowId)} AND ciphertext IS NOT NULL AND phase='awaiting_callback'`,
      ) === 1,
    );
    const rate = h.configured();
    // One real role-bound connection removes Docker startup/disposal time from
    // this DB rolling-window predicate fixture. No merchant authority enters it.
    const rateCalls = Array.from({ length: 11 }, () => {
      const v = intent(rate);
      return `SELECT outcome FROM morrow_identity.create_login_flow_intent(${[v.configurationDigest, v.flowId, v.beginCommandId, v.admissionCommandId, v.issuerCommandId, v.workspaceId].map(lit).join(",")});`;
    }).join("\n");
    const rateReply = containerCommand(
      [
        "exec",
        "--interactive",
        context.id,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "morrow_identity_login",
        "-d",
        "morrow",
      ],
      "BEGIN;\n" + rateCalls + "\nCOMMIT;",
    )
      .stdout.trim()
      .split("\n");
    check(
      "locked_rolling_ten_starts",
      rateReply.length === 11 &&
        rateReply.slice(0, 10).every((r) => r === "newly_created") &&
        rateReply[10] === "rate_limited",
    );
    const unknown = h.configured(),
      in1 = intent(unknown),
      unknownPool = custody({ commitAckLoss: true }, true);
    let held = false;
    try {
      await unknownPool.createIntent(JSON.stringify(in1), control());
    } catch {
      held = true;
    }
    check(
      "commit_ack_loss_holds",
      held &&
        count(`SELECT count(*) FROM morrow_identity.login_flows WHERE id=${lit(in1.flowId)}`) === 1,
    );
    const nonrepeat = await custody().createIntent(JSON.stringify(in1), control());
    check("lost_creation_no_retry_new_material", nonrepeat.outcome === "conflict");
    const expire = await ready();
    context.sql(
      `ALTER TABLE morrow_identity.login_flows DISABLE TRIGGER USER;UPDATE morrow_identity.login_flows SET created_at=t.at-interval '301 seconds',expires_at=t.at-interval '1 second' FROM (SELECT clock_timestamp() AS at) t WHERE id=${lit(expire.selected.flowId)};ALTER TABLE morrow_identity.login_flows ENABLE TRIGGER USER;`,
      "morrow",
    );
    check(
      "expired_capsule_inaccessible",
      (await expire.service.claimCallback(JSON.stringify(expire.claim), control())).outcome ===
        "denied",
    );
    const swept = await maintain().maintain(
      JSON.stringify({ schemaVersion: 1, configurationDigest: expire.x.configurationDigest }),
      control(),
    );
    check("bounded_expiry_sweep", swept.outcome === "completed" && swept.erased_capsules === "1");
    check(
      "expired_cipher_erased",
      count(
        `SELECT count(*) FROM morrow_identity.login_flows WHERE id=${lit(expire.selected.flowId)} AND ciphertext IS NULL AND capsule_erased_at IS NOT NULL`,
      ) === 1,
    );
    const old = await ready();
    context.sql(
      `ALTER TABLE morrow_identity.login_flows DISABLE TRIGGER USER;UPDATE morrow_identity.login_flows SET created_at=t.at-interval '8 days'-interval '300 seconds',expires_at=t.at-interval '8 days' FROM (SELECT clock_timestamp() AS at) t WHERE id=${lit(old.selected.flowId)};ALTER TABLE morrow_identity.login_flows ENABLE TRIGGER USER;`,
      "morrow",
    );
    const closed = await maintain().maintain(
      JSON.stringify({ schemaVersion: 1, configurationDigest: old.x.configurationDigest }),
      control(),
    );
    check(
      "safe_old_detail_pruned",
      closed.pruned_closed_states === "1" &&
        count(
          `SELECT count(*) FROM morrow_identity.login_flows WHERE id=${lit(old.selected.flowId)}`,
        ) === 0,
    );
    check(
      "reserved_commands_never_age_deleted",
      count(
        `SELECT count(*) FROM morrow_identity.login_command_guards WHERE flow_id=${lit(old.selected.flowId)}`,
      ) === 3,
    );
    const compact = await ready();
    await compact.service.claimCallback(JSON.stringify(compact.claim), control());
    context.sql(
      `ALTER TABLE morrow_identity.login_flows DISABLE TRIGGER USER;UPDATE morrow_identity.login_flows SET created_at=t.at-interval '8 days'-interval '300 seconds',expires_at=t.at-interval '8 days' FROM (SELECT clock_timestamp() AS at) t WHERE id=${lit(compact.selected.flowId)};ALTER TABLE morrow_identity.login_flows ENABLE TRIGGER USER;ALTER TABLE morrow_identity.login_flow_events DISABLE TRIGGER USER;UPDATE morrow_identity.login_flow_events SET recorded_at=clock_timestamp()-interval '8 days' WHERE flow_id=${lit(compact.selected.flowId)};ALTER TABLE morrow_identity.login_flow_events ENABLE TRIGGER USER;`,
      "morrow",
    );
    const minimized = await maintain().maintain(
      JSON.stringify({ schemaVersion: 1, configurationDigest: compact.x.configurationDigest }),
      control(),
    );
    check(
      "unresolved_detail_compacted_never_closed",
      minimized.pruned_closed_states === "0" &&
        minimized.retained_unresolved === "1" &&
        count(
          `SELECT count(*) FROM morrow_identity.login_flows WHERE id=${lit(compact.selected.flowId)}`,
        ) === 0,
    );
    check(
      "minimal_uncertainty_guard_persists",
      count(
        `SELECT count(*) FROM morrow_identity.login_flow_tombstones WHERE flow_id=${lit(compact.selected.flowId)} AND phase='claimed' AND effect_uncertainty`,
      ) === 1,
    );
    check(
      "compact_guard_three_reservations_untouched",
      count(
        `SELECT count(*) FROM morrow_identity.login_command_guards WHERE flow_id=${lit(compact.selected.flowId)}`,
      ) === 3,
    );
    check(
      "compacted_reconciliation_never_resume",
      (await compact.service.reconcile(rec(compact), control())).outcome === "held",
    );
    check("safe_audit_association_pseudonymized", minimized.pseudonymized_audits === "3");
    const twice = await maintain().maintain(
      JSON.stringify({ schemaVersion: 1, configurationDigest: compact.x.configurationDigest }),
      control(),
    );
    check(
      "repeat_maintenance_keeps_uncertainty",
      twice.pruned_closed_states === "0" && twice.retained_unresolved === "1",
    );
    check(
      "compacted_commands_not_reusable",
      (
        await custody().createIntent(
          JSON.stringify({ ...compact.selected, flowId: randomUUID() }),
          control(),
        )
      ).outcome === "conflict",
    );
    ownerDenied(
      "owner_no_tombstone_delete",
      `DELETE FROM morrow_identity.login_flow_tombstones WHERE flow_id=${lit(compact.selected.flowId)}`,
      "P0001",
      "LOGIN_RECORD_IMMUTABLE",
    );
    ownerDenied(
      "owner_no_tombstone_reset",
      `UPDATE morrow_identity.login_flow_tombstones SET effect_uncertainty=false WHERE flow_id=${lit(compact.selected.flowId)}`,
      "P0001",
      "LOGIN_RECORD_IMMUTABLE",
    );
    ownerDenied(
      "owner_no_tombstone_truncate",
      "TRUNCATE morrow_identity.login_flow_tombstones",
      "P0001",
      "LOGIN_RECORD_IMMUTABLE",
    );
    context.sql(
      `ALTER TABLE morrow_identity.login_flow_events DISABLE TRIGGER USER;UPDATE morrow_identity.login_flow_events SET recorded_at=clock_timestamp()-interval '366 days' WHERE pseudonymized;ALTER TABLE morrow_identity.login_flow_events ENABLE TRIGGER USER;`,
      "morrow",
    );
    const auditSweep = await maintain().maintain(
      JSON.stringify({ schemaVersion: 1, configurationDigest: compact.x.configurationDigest }),
      control(),
    );
    check(
      "content_free_old_audits_pruned",
      Number(auditSweep.pruned_audits) >= 3 &&
        Number(auditSweep.pruned_audits) <= 100 &&
        auditSweep.retained_unresolved === "1",
    );
    const quota = h.configured();
    h.admin(
      `INSERT INTO morrow_identity.login_flows(id,configuration_digest,begin_command_id,admission_command_id,issuer_command_id,workspace_id,phase,revision,created_at,expires_at) SELECT gen_random_uuid(),${lit(quota.configurationDigest)},gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),${lit(quota.f.workspace)},'intent',1,t.at-interval '11 seconds',t.at+interval '289 seconds' FROM generate_series(1,100),(SELECT clock_timestamp() AS at)t;`,
    );
    check(
      "hundred_unexpired_rows_quota_bound",
      (await custody().createIntent(JSON.stringify(intent(quota)), control())).outcome ===
        "quota_limited",
    );
    const unsafe = h.configured(),
      unsafeInput = intent(unsafe);
    const roleAttempt = context.sql(
      `SET ROLE morrow_identity_login;SELECT outcome FROM morrow_identity.create_login_flow_intent(${[unsafeInput.configurationDigest, unsafeInput.flowId, unsafeInput.beginCommandId, unsafeInput.admissionCommandId, unsafeInput.issuerCommandId, unsafeInput.workspaceId].map(lit).join(",")});`,
      "morrow",
    );
    check("set_role_is_not_exact_login", roleAttempt.trim() === "denied");
    for (const index of [2, 10, 17]) {
      context.sql(
        `ALTER TABLE morrow_identity.browser_session_commands DISABLE TRIGGER USER;UPDATE morrow_identity.browser_session_commands SET request_tuple=jsonb_set(request_tuple,'{${index}}','null') WHERE command_id=${lit(good.selected.issuerCommandId)};ALTER TABLE morrow_identity.browser_session_commands ENABLE TRIGGER USER;`,
        "morrow",
      );
      check(
        "malformed_historical_tuple_" + index,
        (await good.service.reconcile(rec(good), control())).outcome === "held",
      );
    }
    check(
      "owning_M_client_physically_closed",
      h.metrics.every(
        (m) =>
          m.connections === m.released &&
          m.connections === m.closed &&
          m.connections === m.backendCleanupVerified,
      ),
    );
    for (const kind of ["claim_profile", "claim_expiry", "intent_profile"]) {
      const v = await ready(),
        holder = await openHolder(),
        consumer = owned();
      let client;
      try {
        client = await consumer.connect({
          deadlineMs: Date.now() + 15000,
          signal: new AbortController().signal,
        });
        const pids = await holder.run(
          "SELECT pid FROM pg_stat_activity WHERE datname='morrow' AND usename='morrow_identity_login' AND application_name LIKE 'morrow_login_flow_%';",
        );
        const pid = Number(pids);
        check(
          "wait_" + kind + "_unique_warmed_consumer",
          /^[1-9][0-9]*$/.test(pids) && Number.isSafeInteger(pid),
        );
        if (kind === "claim_expiry")
          await holder.run(
            `ALTER TABLE morrow_identity.login_flows DISABLE TRIGGER USER;UPDATE morrow_identity.login_flows SET created_at=t.at-interval '299.6 seconds',expires_at=t.at+interval '0.4 seconds' FROM (SELECT clock_timestamp() AS at)t WHERE id=${lit(v.selected.flowId)};ALTER TABLE morrow_identity.login_flows ENABLE TRIGGER USER;`,
          );
        await holder.run(
          "BEGIN;SET ROLE morrow_identity_owner;" +
            (kind === "intent_profile"
              ? `SELECT 1 FROM morrow_identity.login_flow_quotas WHERE environment_id=${lit(v.x.f.environment)} AND profile_id=${lit(v.x.f.profile)} FOR UPDATE;`
              : `SELECT 1 FROM morrow_identity.login_flows WHERE id=${lit(v.selected.flowId)} FOR UPDATE;`) +
            "RESET ROLE;",
        );
        let adopted = false;
        const service = createLoginFlowCustody({
          pool: {
            connect: async () => {
              if (adopted) throw Error("LOGIN_WAIT_ALREADY_ADOPTED");
              adopted = true;
              return client;
            },
          },
          now: Date.now,
        });
        const next = intent(v.x);
        const pending =
          kind === "intent_profile"
            ? service.createIntent(JSON.stringify(next), control())
            : service.claimCallback(JSON.stringify(v.claim), control());
        void pending.catch(() => {});
        let witnessed = false;
        const until = Date.now() + 700;
        while (Date.now() < until) {
          const fact = await holder.run(
            `SELECT pg_stat_clear_snapshot();WITH fact AS MATERIALIZED(SELECT ${holder.pid}=ANY(pg_blocking_pids(${pid})) AND EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${pid} AND wait_event_type='Lock') AS blocked) SELECT blocked AND (SELECT expires_at>clock_timestamp() FROM morrow_identity.login_flows WHERE id=${lit(v.selected.flowId)}) FROM fact;`,
          );
          if (fact === "t") {
            witnessed = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        check("wait_" + kind + "_actual_blocked_before_expiry", witnessed);
        if (kind === "claim_expiry") {
          let expired = false;
          while (Date.now() < until + 250) {
            if (
              (await holder.run(
                `SELECT expires_at<=clock_timestamp() FROM morrow_identity.login_flows WHERE id=${lit(v.selected.flowId)};`,
              )) === "t"
            ) {
              expired = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 5));
          }
          check("wait_claim_expiry_independent_DB_clock", expired);
        } else
          await holder.run(
            `SET ROLE morrow_identity_owner;UPDATE morrow_identity.identity_verification_profiles SET state='revoked',record_revision=record_revision+1 WHERE id=${lit(v.x.f.profile)};RESET ROLE;`,
          );
        await holder.run("COMMIT;");
        const result = await pending;
        check(
          "wait_" + kind + "_SQL_denied_no_capsule",
          result.outcome === "denied" &&
            (!Object.hasOwn(result, "ciphertext") || result.ciphertext === null),
        );
        if (kind === "intent_profile")
          check(
            "wait_intent_profile_all_new_rows_rolled_back",
            count(
              `SELECT count(*) FROM morrow_identity.login_flows WHERE id=${lit(next.flowId)}`,
            ) === 0 &&
              count(
                `SELECT count(*) FROM morrow_identity.login_command_guards WHERE flow_id=${lit(next.flowId)}`,
              ) === 0,
          );
        else
          check(
            "wait_" + kind + "_original_capsule_not_consumed",
            count(
              `SELECT count(*) FROM morrow_identity.login_flows WHERE id=${lit(v.selected.flowId)} AND phase='awaiting_callback' AND ciphertext IS NOT NULL`,
            ) === 1,
          );
      } finally {
        if (client) await client.release(true);
        await holder.close();
      }
    }
    // All private psql captures stay in memory; public evidence contains booleans.
    check(
      "no_raw69_material_in_SQL",
      h.rolePools.every((p) =>
        p.observed.every((o) =>
          secrets.every((s) => !o.stdout.includes(s) && !o.stderr.includes(s)),
        ),
      ),
    );
    return { version: context.version, image: context.image };
  } finally {
    await h.close();
  }
});
check(
  "all_source_bytes_stable",
  sourcePaths.every((p) => sourceHashes[p] === hash(readFileSync(p))),
);
check(
  "normal_disposable_clients_physically_closed",
  metrics.every(
    (m) =>
      m.connections === m.released &&
      m.connections === m.closed &&
      m.connections === m.backendCleanupVerified &&
      m.unverifiedHostClosures === 0,
  ),
);
check(
  "fault_clients_physical_cleanup_separate",
  faultMetrics.every(
    (m) => m.connections === m.closed && m.connections === m.backendCleanupVerified,
  ),
);
const absent = containerCommand(["inspect", container], undefined, true).status !== 0;
check("owned_container_absent", absent);
check(
  "all_wait_holders_closed_and_backend_absent",
  holderCleanup.length === 3 && holderCleanup.every((m) => m.hostClosedNormally && m.backendAbsent),
);
const report = {
  schema_version: 1,
  packet: "P05.T01p",
  canonical_sequence: executionSequence,
  fixture_protocol_sequence: 84,
  scope: "synthetic_private_login_custody_actual_postgresql",
  provider_requests: 0,
  source_hashes: sourceHashes,
  checks,
  checks_passed: checks.length,
  normal_cleanup: metrics,
  fault_cleanup: faultMetrics,
  container_absent: absent,
  engine: observed,
  holder_cleanup: holderCleanup,
  limitations: [
    "Synthetic owner-seeded identities only; no native/provider or hosted activation.",
    "Only preserved migrations1–10 are installed; migration11 self-logout is not installed or qualified by this regression.",
    "Controlled age fixtures qualify retention predicates, not elapsed production time.",
    "Historical receipt attribution never proves dispatch, delivery, or current authority.",
  ],
};
mkdirSync("docs/evidence/P05.T01t/canonical89/regressions", { recursive: true });
writeFileSync(
  "docs/evidence/P05.T01t/canonical89/regressions/login-flow-custody.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    packet: report.packet,
    checks: checks.length,
    passed: true,
    provider_requests: 0,
    container_absent: absent,
  }),
);
