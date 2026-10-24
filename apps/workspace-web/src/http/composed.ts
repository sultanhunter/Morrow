// Which port methods this build composes over HTTP (P14.T01a §4.2). An uncomposed
// method returns `not_in_build` without a request, and its screen renders a truthful
// dependency state; a 404 never means "not built".
// Who flips what: PR-1 the session and bootstrap methods; PR-2 (this build) `account.*`
// (P05.T01x Part B) and `work.*` (P06.T01a); whichever of P05.T01y PR-2 and P14.T01a
// PR-2 lands second `session.keepAlive` (the keeper is not built yet, so it stays off);
// P05.T01z `people.list`. Assign and Ask are composed but stay hidden while
// `people.list` is not_in_build (§4.10).
// `loginBodyVersion` is 2: P05.T01x Part B landed first, and its account-mode start
// accepts only `{"schemaVersion":2}` (the v1 `{workspaceId}` body is a 400), so PR-1
// starts at v2 (§4.14). A unit test feeds this body to the server's `loginStartInput`.
import { portMethods, teamPortMethods, type Composed, type PortMethod } from "@morrow/workspace-ui";

// ADR-0032: `samples.home` is the Home preview's default-off switch. It has no backend
// (ADR-0033 and ADR-0034 are accepted, 2026-10-24, but their contracts and backend land
// in their own PRs), so this build never composes it.
// T7 PR 16: Team, agent pages, Add agents, Settings, Shop knowledge and Files have no
// server routes yet; their screens show "not built yet" in this build (a default-off switch).
const uncomposed: readonly PortMethod[] = [
  "session.keepAlive",
  "people.list",
  ...teamPortMethods,
  "samples.home",
];
export const composed: Composed = Object.freeze(
  Object.fromEntries(portMethods.map((method) => [method, !uncomposed.includes(method)])) as Record<
    PortMethod,
    boolean
  >,
);
export const loginBodyVersion: 1 | 2 = 2;
