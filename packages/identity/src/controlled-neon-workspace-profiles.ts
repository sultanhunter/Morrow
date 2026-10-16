import { identitySql } from "./index.js";
import { workspaceStoreLinkingControlSql } from "./workspace-store-linking-control.js";
import { workspaceStoreLinkingSql } from "./workspace-store-linking.js";
import { selfLogoutSql } from "./self-logout-control.js";
import {
  controlledNeonHeld,
  snapshotControlledNeonParameters,
  type ControlledNeonProfile,
} from "./controlled-neon-login-profiles.js";

// These three private source profiles are selected only by the workspace factory.
// No application input supplies a role, statement, arity or parameter policy.
function profile(
  role: string,
  sql: Readonly<Record<string, string>>,
  arities: Readonly<Record<string, number>>,
  statementTimeout: number,
  idleTimeout: number,
): ControlledNeonProfile {
  return Object.freeze({
    role,
    statementTimeout,
    idleTimeout,
    statements: Object.freeze(
      Object.fromEntries(
        Object.entries(arities).map(([name, arity]) => [
          name,
          Object.freeze({ text: sql[name]!, arity, maximum: 128 }),
        ]),
      ),
    ),
  });
}
export const controlledNeonWorkspaceProfiles = Object.freeze({
  identityPool: profile(
    "morrow_api",
    identitySql,
    {
      begin: 0,
      role: 0,
      timeout: 0,
      idleTimeout: 0,
      bind: 2,
      resolve: 0,
      workspace: 1,
      workspaceAuthority: 0,
      commit: 0,
      rollback: 0,
    },
    5000,
    10000,
  ),
  linkingPool: profile(
    "morrow_identity_linking",
    {
      readOnlyBegin: workspaceStoreLinkingControlSql.begin,
      readRole: workspaceStoreLinkingControlSql.role,
      ...workspaceStoreLinkingSql,
      lookup: workspaceStoreLinkingControlSql.lookup,
      status: workspaceStoreLinkingControlSql.status,
    },
    {
      readOnlyBegin: 0,
      readRole: 0,
      begin: 0,
      role: 0,
      timeout: 0,
      idleTimeout: 0,
      lookup: 4,
      status: 4,
      apply: 11,
      commit: 0,
      rollback: 0,
    },
    5000,
    10000,
  ),
  logoutPool: profile(
    "morrow_identity_logout",
    selfLogoutSql,
    { begin: 0, role: 0, timeout: 0, idleTimeout: 0, end: 8, commit: 0, rollback: 0 },
    1000,
    5000,
  ),
});
export type ControlledNeonWorkspacePoolName = keyof typeof controlledNeonWorkspaceProfiles;
export function snapshotControlledNeonWorkspaceParameters(
  selected: ControlledNeonProfile,
  text: unknown,
  values: unknown,
): readonly string[] {
  if (!Object.values(controlledNeonWorkspaceProfiles).includes(selected))
    throw controlledNeonHeld();
  // Preserve the original dense/data-only arity, NUL and 16384-total copier.
  // ASCII is the additional workspace-only policy; the four login profiles
  // retain their existing well-formed Unicode behavior.
  const copied = snapshotControlledNeonParameters(selected, text, values);
  if (copied.some((value) => /[^\x00-\x7f]/.test(value))) throw controlledNeonHeld();
  return copied;
}
