// ADR-0020 item 4 and P04.T01j D5 (AC13): the identity executors' role preflight. The
// database guards stay the authority; these tests pin the application side's exact text,
// its use by the eight adapters and the pg-wire oracles' independent copies.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { executorRoleMemberSql } from "../packages/identity/src/executor-role-preflight.ts";
import { accountOnboardingSql } from "../packages/identity/src/account-onboarding.ts";
import { authenticationExchangeAdmissionSql } from "../packages/identity/src/authentication-exchange-admission.ts";
import { loginFlowCustodySql } from "../packages/identity/src/login-flow-custody.ts";
import { selfLogoutSql } from "../packages/identity/src/self-logout-control.ts";
import { workspaceStoreLinkingSql } from "../packages/identity/src/workspace-store-linking.ts";
import { workspaceStoreLinkingControlSql } from "../packages/identity/src/workspace-store-linking-control.ts";
import { browserSessionAdmissionSql } from "../packages/identity/src/workos-browser-session-admission.ts";
import { workspaceSelectionSql } from "../packages/identity/src/workos-workspace-selection.ts";
import { workspaceAccessRevocationSql } from "../packages/identity/src/workspace-access-revocation.ts";
import { managedWorkspaceWireSql } from "../scripts/fixtures/managed-workspace-pg-oracle.mjs";
import { controlledNeonWireSql } from "../scripts/fixtures/controlled-neon-pg-wire-oracle.mjs";

// An independent literal of D5: more than one row naming the executor, any row with the
// executor as member, or a row that is not the creation row of a non-Morrow,
// non-superuser member makes role_member true.
const d5 =
  "(EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid)" +
  " OR (SELECT count(*) FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid)>1" +
  " OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles u ON u.oid=m.member WHERE m.roleid=r.oid" +
  " AND NOT (m.grantor=10 AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option" +
  " AND u.rolname NOT LIKE 'morrow\\_%' AND NOT u.rolsuper))) AS role_member";
const oldPreflight =
  /EXISTS ?\(SELECT 1 FROM pg_catalog\.pg_auth_members m WHERE m\.member=r\.oid OR m\.roleid=r\.oid\)/;
const adapters = {
  "account-onboarding": accountOnboardingSql.role,
  "authentication-exchange-admission": authenticationExchangeAdmissionSql.role,
  "login-flow-custody": loginFlowCustodySql.role,
  "self-logout-control": selfLogoutSql.role,
  "workspace-store-linking": workspaceStoreLinkingSql.role,
  "workspace-store-linking-control": workspaceStoreLinkingControlSql.role,
  "workos-browser-session-admission": browserSessionAdmissionSql.role,
  "workos-workspace-selection": workspaceSelectionSql.role,
};
const count = (text, part) => text.split(part).length - 1;

test("the D5 preflight text is exact", () => {
  assert.equal(executorRoleMemberSql, d5);
  assert.ok(!/\$[0-9]/.test(d5), "no placeholder");
});

test("the eight identity adapters use the D5 preflight once and never the old one", () => {
  assert.equal(Object.keys(adapters).length, 8);
  for (const [name, sql] of Object.entries(adapters)) {
    assert.equal(count(sql, d5), 1, name);
    assert.equal(count(sql, "pg_auth_members"), 3, name);
    assert.ok(!oldPreflight.test(sql), name);
    assert.match(sql, /FROM pg_catalog\.pg_roles r WHERE r\.rolname=current_user$/, name);
  }
});

test("the lifecycle preflight still refuses only member rows, mirroring 0004", () => {
  assert.equal(count(workspaceAccessRevocationSql.role, "pg_auth_members"), 1);
  assert.match(
    workspaceAccessRevocationSql.role,
    /EXISTS \(SELECT 1 FROM pg_catalog\.pg_auth_members m WHERE m\.member=r\.oid\) AS role_member/,
  );
});

test("the pg-wire oracles' independent literals match the adapters byte for byte", () => {
  const linking = managedWorkspaceWireSql.linkingPool.statements;
  assert.equal(linking.readRole, workspaceStoreLinkingControlSql.role);
  assert.equal(linking.role, workspaceStoreLinkingSql.role);
  assert.equal(managedWorkspaceWireSql.logoutPool.statements.role, selfLogoutSql.role);
  assert.equal(controlledNeonWireSql.loginPool.roleQuery, loginFlowCustodySql.role);
  assert.equal(
    controlledNeonWireSql.preauthPool.roleQuery,
    authenticationExchangeAdmissionSql.role,
  );
  assert.equal(controlledNeonWireSql.sessionPool.roleQuery, browserSessionAdmissionSql.role);
  assert.equal(controlledNeonWireSql.sessionPool.roleQuery, workspaceSelectionSql.role);
  for (const file of [
    "scripts/fixtures/managed-workspace-pg-oracle.mjs",
    "scripts/fixtures/controlled-neon-pg-wire-oracle.mjs",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.ok(!oldPreflight.test(source), file);
    assert.ok(!source.includes("executor-role-preflight"), file + " keeps an independent literal");
  }
});

// The labs' source inventories (their sourceHashes and source_snapshot_unchanged evidence,
// ADR-0012) must cover the D5 text their adapters now import: every inventory array that
// lists one of the eight adapters also lists executor-role-preflight.ts.
test("every lab source inventory that lists an adapter also lists the preflight module", () => {
  const adapterEntry = new RegExp(
    `^\\s*"packages/identity/src/(${Object.keys(adapters).join("|")})\\.ts",\\s*$`,
  );
  const preflightEntry = /^\s*"packages\/identity\/src\/executor-role-preflight\.ts",\s*$/;
  let inventories = 0;
  for (const name of readdirSync("scripts").filter((f) => f.endsWith(".mjs"))) {
    // Array literals end on a line that starts with "]"; the lines between are one segment.
    const segments = readFileSync("scripts/" + name, "utf8").split(/\n\s*\]/);
    for (const segment of segments) {
      const lines = segment.split("\n");
      if (!lines.some((line) => adapterEntry.test(line))) continue;
      inventories += 1;
      assert.ok(
        lines.some((line) => preflightEntry.test(line)),
        `scripts/${name} lists an adapter without packages/identity/src/executor-role-preflight.ts`,
      );
    }
  }
  assert.ok(inventories >= 28, String(inventories));
});
