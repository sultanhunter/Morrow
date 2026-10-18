import { identitySql } from "./index.js";
import { workspaceStoreLinkingControlSql } from "./workspace-store-linking-control.js";
import { workspaceStoreLinkingSql } from "./workspace-store-linking.js";
import { selfLogoutSql } from "./self-logout-control.js";
import { accountOnboardingSql, accountOverviewSql } from "./account-onboarding.js";
import {
  controlledNeonHeld,
  snapshotControlledNeonParameters,
  type ControlledNeonProfile,
} from "./controlled-neon-login-profiles.js";

// These four private source profiles are selected only by the workspace factory.
// No application input supplies a role, statement, arity or parameter policy.
function profile(
  role: string,
  sql: Readonly<Record<string, string>>,
  arities: Readonly<Record<string, number>>,
  statementTimeout: number,
  idleTimeout: number,
  maxima: Readonly<Record<string, number>> = {},
): ControlledNeonProfile {
  return Object.freeze({
    role,
    statementTimeout,
    idleTimeout,
    statements: Object.freeze(
      Object.fromEntries(
        Object.entries(arities).map(([name, arity]) => [
          name,
          Object.freeze({ text: sql[name]!, arity, maximum: maxima[name] ?? 128 }),
        ]),
      ),
    ),
  });
}
export const controlledNeonWorkspaceProfiles = Object.freeze({
  identityPool: profile(
    "morrow_api",
    { ...identitySql, overview: accountOverviewSql },
    {
      begin: 0,
      role: 0,
      timeout: 0,
      idleTimeout: 0,
      bind: 2,
      resolve: 0,
      workspace: 1,
      workspaceAuthority: 0,
      overview: 2,
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
  // First-owner signup (P05.T01x, ADR-0009 item 4): one fixed definer, nothing else.
  onboardingPool: profile(
    "morrow_identity_onboarding",
    accountOnboardingSql,
    { begin: 0, role: 0, timeout: 0, idleTimeout: 0, create: 5, commit: 0, rollback: 0 },
    2000,
    5000,
    { create: 200 },
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
  // ASCII is the additional workspace-only policy; the login profiles retain their
  // existing well-formed Unicode behavior. The one exemption is the two display names
  // (parameters 3 and 4) of the signup create: well formed, no NUL, at most 200 UTF-16
  // units. Its digest, command and profile stay ASCII and at most 128.
  const copied = snapshotControlledNeonParameters(selected, text, values);
  const names =
    selected === controlledNeonWorkspaceProfiles.onboardingPool &&
    text === controlledNeonWorkspaceProfiles.onboardingPool.statements.create!.text;
  if (
    copied.some(
      (value, index) =>
        !(names && index >= 3) && (value.length > 128 || /[^\x00-\x7f]/.test(value)),
    )
  )
    throw controlledNeonHeld();
  return copied;
}
