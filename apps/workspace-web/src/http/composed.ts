// Which port methods this build composes over HTTP (P14.T01a §4.2). An uncomposed
// method returns `not_in_build` without a request, and its screen renders a truthful
// dependency state; a 404 never means "not built".
// Who flips what: PR-1 the three below; PR-2 `account.*` and `work.*`; whichever of
// P05.T01y PR-2 and P14.T01a PR-2 lands second `session.keepAlive`; P05.T01z `people.list`.
// `loginBodyVersion` is 2: P05.T01x Part B landed first, and its account-mode start
// accepts only `{"schemaVersion":2}` (the v1 `{workspaceId}` body is a 400), so PR-1
// starts at v2 (§4.14). A unit test feeds this body to the server's `loginStartInput`.
import { portMethods, type Composed, type PortMethod } from "@morrow/workspace-ui";

const enabled: readonly PortMethod[] = [
  "session.startSignIn",
  "session.signOut",
  "workspace.bootstrap",
];
export const composed: Composed = Object.freeze(
  Object.fromEntries(portMethods.map((method) => [method, enabled.includes(method)])) as Record<
    PortMethod,
    boolean
  >,
);
export const loginBodyVersion: 1 | 2 = 2;
