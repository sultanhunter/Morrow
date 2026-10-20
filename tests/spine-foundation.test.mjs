// M2 PR-1 spine foundation (migrations 0019-0024): static checks of the migration text,
// the manifest rows, the role prerequisites and the conformance registry. The behaviour is
// proved by lab:spine-foundation, lab:tenant-conformance and lab:createrole-administrator
// against PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrationSqlViolations } from "../scripts/migration-sql.mjs";
import { loadMigrationChain } from "../scripts/migration-chain.mjs";
import {
  billingFunctions,
  billingTables,
  bridgeFunctions,
  executorLogins,
  vaultFunctions,
  vaultTables,
  workFunctions,
  workTables,
} from "./tenant-conformance/registry.mjs";

const read = (path) => readFileSync(path, "utf8");
const sha = (text) => createHash("sha256").update(text).digest("hex");
const bridge = read("migrations/0019.spine-identity-bridge.sql");
const foundation = read("migrations/0020.spine-foundation.sql");
const signup = read("migrations/0021.signup-billing-route.sql");
// The review's forward migrations: the signup fact (0022), the member-lease revocation and
// the bound signup policy (0023), and the membership triggers (0024).
const signupCheck = read("migrations/0022.signup-route-identity-check.sql");
const revocation = read("migrations/0023.member-lease-revocation.sql");
const triggers = read("migrations/0024.membership-lease-revocation.sql");
const spine = [bridge, foundation, signup, signupCheck, revocation, triggers];
const prerequisites = read("infra/spine-executor-role-prerequisites.sql");
const code = (text) => text.replace(/--.*$/gm, "");
const logins = ["morrow_connector_ingress", "morrow_runtime_executor", "morrow_vault_broker"];

test("manifest: rows 19-24, their executeAs roles, digests and the one prerequisite", () => {
  const manifest = JSON.parse(read("migrations/manifest.json"));
  const rows = manifest.migrations.filter(
    (m) => m.reviewRef === "docs/briefs/M2-shopify-connect.md",
  );
  assert.deepEqual(
    rows.map((m) => [m.sequence, m.file, m.executeAs]),
    [
      [19, "0019.spine-identity-bridge.sql", "morrow_identity_owner"],
      [20, "0020.spine-foundation.sql", "morrow_work_owner"],
      [21, "0021.signup-billing-route.sql", "morrow_identity_owner"],
      [22, "0022.signup-route-identity-check.sql", "morrow_identity_owner"],
      [23, "0023.member-lease-revocation.sql", "morrow_work_owner"],
      [24, "0024.membership-lease-revocation.sql", "morrow_identity_owner"],
    ],
  );
  for (const m of rows) assert.equal(sha(read("migrations/" + m.file)), m.sha256);
  assert.deepEqual(rows[0].prerequisites, [
    { file: "infra/spine-executor-role-prerequisites.sql", sha256: sha(prerequisites) },
  ]);
  for (const row of rows.slice(1)) assert.equal(row.prerequisites, undefined, row.file);
  // The one chain module (P04.T01i D3), which the harness and every lab read, pins the same
  // prerequisite before 0019 and the three logins it creates.
  const entry = loadMigrationChain().find((e) => e.sequence === 19);
  assert.deepEqual(
    entry.prerequisites.map((p) => [p.file, p.sha256, [...p.roles]]),
    [["infra/spine-executor-role-prerequisites.sql", sha(prerequisites), logins]],
  );
  assert.deepEqual(
    loadMigrationChain()
      .filter((e) => e.sequence >= 19)
      .map((e) => e.executeAs),
    rows.map((m) => m.executeAs),
  );
});

test("migrations: one transaction each, the runner contract, fixed search paths, no membership catalog", () => {
  for (const [index, text] of spine.entries()) {
    const file = String(19 + index).padStart(4, "0");
    assert.deepEqual(migrationSqlViolations(text), [], file);
    // ADR-0020 item 6: the helpers only.
    assert.equal(text.includes("pg_auth_" + "members"), false, file);
    for (const fn of text.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION [^\n]+\n(?:[^\n]*\n)*?LANGUAGE [^\n]*/g,
    ))
      assert.match(fn[0], /SET search_path=pg_catalog/, fn[0].slice(0, 80));
    assert.doesNotMatch(code(text), /\bEXECUTE\s+(?!format\(|FUNCTION\b|ON\b)/, file);
    assert.doesNotMatch(code(text), /GRANT[^;]*\b(DELETE|TRUNCATE)\b/, file);
    assert.doesNotMatch(code(text), /TO PUBLIC/, file);
  }
  // Every new function has an explicit PUBLIC revoke.
  for (const text of spine)
    for (const [, name] of text.matchAll(/CREATE FUNCTION ([a-z_]+\.[a-z_]+)\(/g))
      assert.match(
        text,
        new RegExp("REVOKE ALL ON FUNCTION " + name.replace(".", "\\.") + "\\("),
        name,
      );
});

test("roles: three membership-free executor logins, no password, no new owner or membership", () => {
  for (const login of logins)
    assert.match(
      prerequisites,
      new RegExp(
        `CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;`,
      ),
    );
  assert.equal((prerequisites.match(/CREATE ROLE /g) ?? []).length, 3);
  assert.doesNotMatch(code(prerequisites), /PASSWORD|GRANT|IN ROLE|\bROLE morrow_[a-z_]+ TO\b/i);
  // No migration creates, alters or grants a role (ADR-0022 item 8; ADR-0020).
  for (const text of spine)
    assert.doesNotMatch(code(text), /CREATE ROLE|ALTER ROLE|GRANT morrow_[a-z_]+ TO/);
  // Each login executes only its registered definers.
  assert.deepEqual(Object.keys(executorLogins).sort(), logins);
  for (const [login, functions] of Object.entries(executorLogins)) {
    const granted = [
      ...spine.flatMap((text) => [
        ...code(text).matchAll(/GRANT EXECUTE ON FUNCTION ([^;]*?) TO ([a-z_,]+);/g),
      ]),
    ]
      .filter((m) => m[2].split(",").includes(login))
      .flatMap((m) => m[1].split(/,\s*(?=morrow_)/).map((f) => f.trim().replace(/\s+/g, "")));
    assert.deepEqual(granted.sort(), [...functions].sort(), login);
  }
  // The guard every new definer uses names exactly the three logins.
  assert.match(
    bridge,
    /p_executor IN \('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker'\)/,
  );
  assert.match(bridge, /morrow_identity\.executor_memberships_closed\(r\.rolname\)/);
});

test("0020: the operation rows equal state-transitions.json, unchanged", () => {
  const contract = JSON.parse(read("docs/contracts/state-transitions.json")).transitions.operation;
  const rows = [
    ...foundation.matchAll(/\('operation','([a-z_]+)','([a-z_]+)','([a-z_]+)','([a-z_]+)'\)/g),
  ].map((m) => m.slice(1).join("|"));
  assert.deepEqual(
    rows,
    contract.map((r) => [r.from, r.to, r.actor, r.guard].join("|")),
  );
});

test("0020: lease terms, the stop interlock and the session-only lease_open", () => {
  assert.match(
    foundation,
    /CASE kind WHEN 'read' THEN interval '60 seconds'\s+WHEN 'run' THEN interval '30 minutes' ELSE interval '15 minutes' END/,
  );
  // lease_open takes both stop keys shared, then reads the stops; a stop takes its key
  // exclusively before it revokes.
  const open = foundation.slice(
    foundation.indexOf("CREATE FUNCTION morrow_work.lease_open("),
    foundation.indexOf("CREATE FUNCTION morrow_work.operation_transition("),
  );
  const order = [
    "morrow_work.current_tenant()",
    "pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')",
    "pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',",
    "morrow_work.stop_active(",
    "INSERT INTO morrow_work.work_leases",
  ].map((needle) => open.indexOf(needle));
  assert.ok(
    order.every((i) => i > 0),
    JSON.stringify(order),
  );
  assert.deepEqual(
    [...order].sort((x, y) => x - y),
    order,
  );
  assert.doesNotMatch(open, /current_lease/);
  const guard = foundation.slice(
    foundation.indexOf("CREATE FUNCTION morrow_work.stop_guard()"),
    foundation.indexOf("CREATE FUNCTION morrow_work.stop_record_bind()"),
  );
  assert.ok(
    guard.indexOf("pg_advisory_xact_lock(") < guard.indexOf("UPDATE morrow_work.work_leases"),
  );
  // current_lease() is read only through the session-free runtime path.
  const lease = foundation.slice(
    foundation.indexOf("CREATE FUNCTION morrow_work.current_lease()"),
    foundation.indexOf("REVOKE ALL ON FUNCTION morrow_work.current_lease()"),
  );
  assert.match(lease, /work_executor_safe\('morrow_runtime_executor'\)/);
  assert.match(lease, /current_setting\('morrow\.work_session_digest',true\),''\)<>''/);
  assert.match(lease, /work_lease_member_current\(/);
  // The entry proof (review finding 1): the context resolves only through the row
  // enter_lease wrote for this backend and transaction, never through a value the runtime
  // login could compute (the part-1 marker was transaction_timestamp and the backend id).
  assert.match(
    lease,
    /FROM morrow_work\.lease_entries e WHERE e\.backend_pid=pg_catalog\.pg_backend_pid\(\)\n\s+AND e\.xact_id=pg_catalog\.pg_current_xact_id_if_assigned\(\)::text AND e\.nonce=v_entered AND e\.lease_id=v_id/,
  );
  assert.doesNotMatch(lease, /transaction_timestamp/);
  const enter = foundation.slice(
    foundation.indexOf("CREATE FUNCTION morrow_work.enter_lease("),
    foundation.indexOf("CREATE FUNCTION morrow_work.pending_starts()"),
  );
  assert.doesNotMatch(enter, /transaction_timestamp/);
  assert.match(enter, /v_nonce:=gen_random_uuid\(\)::text;/);
  assert.match(enter, /set_config\('morrow\.work_lease_entered',v_nonce,true\)/);
  // The proof is reached only by the runtime login's definers, for its own backend.
  assert.match(
    foundation,
    /CREATE POLICY lease_entry ON morrow_work\.lease_entries TO morrow_work_command\n USING \(session_user='morrow_runtime_executor' AND backend_pid=pg_catalog\.pg_backend_pid\(\)\)/,
  );
  assert.doesNotMatch(
    code(foundation),
    /GRANT[^;]*ON morrow_work\.lease_entries TO (?!morrow_work_command;)/,
  );
  // pending_starts returns ids only.
  assert.match(
    foundation,
    /CREATE FUNCTION morrow_work\.pending_starts\(\)\nRETURNS TABLE\(kind text,subject_id text,lease_id text,generation text\)/,
  );
});

test("registry: every 0020 object is registered with its class", () => {
  for (const table of [
    "work_leases",
    "lease_entries",
    "stop_controls",
    "stop_records",
    "operations",
    "operation_transitions",
  ]) {
    assert.ok(workTables[table], table);
    assert.match(foundation, new RegExp(`CREATE TABLE morrow_work\\.${table} \\(`));
  }
  assert.deepEqual(Object.keys(billingTables), ["workspace_billing_routes"]);
  assert.deepEqual(Object.keys(vaultTables).sort(), ["app_secrets", "credentials"]);
  for (const [schema, functions] of [
    ["morrow_work", workFunctions],
    ["morrow_billing", billingFunctions],
    ["morrow_vault", vaultFunctions],
  ])
    for (const [, name] of [foundation, revocation]
      .join("\n")
      .matchAll(new RegExp(`CREATE FUNCTION ${schema}\\.([a-z_]+)\\(`, "g")))
      assert.ok(
        Object.keys(functions).some((signature) => signature.startsWith(name + "(")),
        schema + "." + name,
      );
  for (const name of ["work_executor_safe", "work_lease_member_current", "work_signup_workspace"])
    assert.ok(
      bridgeFunctions.some((signature) => signature.startsWith(name + "(")),
      name,
    );
  assert.equal(workFunctions["pending_starts()"].crossTenant, true);
});

test("0021: the signup row records the website route in its transaction; nothing else does", () => {
  assert.match(
    signup,
    /CREATE TRIGGER signup_billing_route AFTER INSERT ON morrow_identity\.organization_signups\n FOR EACH ROW EXECUTE FUNCTION morrow_identity\.signup_billing_route\(\);/,
  );
  assert.match(
    foundation,
    /GRANT EXECUTE ON FUNCTION morrow_billing\.record_signup_route\(text,text,timestamptz\) TO morrow_identity_owner;/,
  );
  // The bridge inserts the unfixed website shape only, which its policy also bounds.
  assert.match(foundation, /VALUES \(p_organization_id,p_workspace_id,'website',/);
  assert.match(
    foundation,
    /CREATE POLICY route_signup ON morrow_billing\.workspace_billing_routes FOR INSERT TO morrow_work_command\n WITH CHECK \(origin='website' AND route IS NULL/,
  );
});

test("0022-0024: membership removal revokes leases; the signup policy needs a website signup", () => {
  // 0022: one identity fact for the command role, no table or grant change otherwise.
  assert.match(
    signupCheck,
    /CREATE FUNCTION morrow_identity\.work_signup_workspace\(p_org text,p_ws text\) RETURNS boolean\nLANGUAGE sql STABLE SECURITY DEFINER/,
  );
  assert.equal(signupCheck.match(/^(GRANT|REVOKE) /gm).length, 2);
  assert.match(
    signupCheck,
    /GRANT EXECUTE ON FUNCTION morrow_identity\.work_signup_workspace\(text,text\) TO morrow_work_command;/,
  );
  // 0023: route_signup is replaced by the same shape bound to the website signup.
  assert.match(
    revocation,
    /DROP POLICY route_signup ON morrow_billing\.workspace_billing_routes;\nCREATE POLICY route_signup ON morrow_billing\.workspace_billing_routes FOR INSERT TO morrow_work_command\n WITH CHECK \(origin='website' AND route IS NULL AND mode IS NULL AND route_fixed_at IS NULL AND fixing_payment_key IS NULL AND revision=1\n  AND morrow_identity\.work_signup_workspace\(organization_id::text,workspace_id::text\)\);/,
  );
  // 0023: the revocation definer runs for the identity owner only, and its policy admits
  // only the named membership's active leases while that member is not current.
  assert.match(
    revocation,
    /GRANT EXECUTE ON FUNCTION morrow_work\.revoke_member_leases\(text,text,text\) TO morrow_identity_owner;/,
  );
  assert.equal((code(revocation).match(/GRANT EXECUTE/g) ?? []).length, 1);
  assert.match(
    revocation,
    /USING \(pg_catalog\.current_setting\('morrow\.work_member_revocation',true\)=[^\n]+\n  AND NOT morrow_identity\.work_lease_member_current\(/,
  );
  assert.match(revocation, /WITH CHECK \(status='revoked' AND revoked_reason='membership'/);
  assert.match(
    revocation,
    /ALTER FUNCTION morrow_work\.revoke_member_leases\(text,text,text\) OWNER TO morrow_work_command;/,
  );
  // 0024: both membership tables, only on active -> inactive.
  for (const table of ["workspace_memberships", "memberships"])
    assert.match(
      triggers,
      new RegExp(
        `CREATE TRIGGER revoke_member_work_leases AFTER UPDATE OF active ON morrow_identity\\.${table}\\n FOR EACH ROW WHEN \\(OLD\\.active AND NOT NEW\\.active\\) EXECUTE FUNCTION morrow_identity\\.revoke_member_work_leases\\(\\);`,
      ),
    );
  assert.doesNotMatch(code(triggers), /GRANT /);
  assert.doesNotMatch(code(triggers + revocation + signupCheck), /\b(ALTER|DROP)\s+TABLE\b/);
});
