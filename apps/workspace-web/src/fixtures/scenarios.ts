// Scripted outcomes per scenario (P14.T01a §4.11). A script maps a port method and its
// call index to a reply; `null` keeps the seed behaviour. Scripted, not simulated: there
// are no permissions, digests or caps here; PR-2 proves those over HTTP.
import type { Outcome, PortMethod } from "@morrow/workspace-ui";

export const scenarioNames = [
  "ready",
  "empty",
  "loading",
  "denied",
  "home_partial_denied",
  "session_expired",
  "workspace_unavailable",
  "conflict",
  "uncertain",
  "uncertain_persisting",
  "reentry",
  "offline",
  "unavailable",
  "not_in_build",
  "account_form",
  "account_chooser",
  "account_invite",
  "restore_unavailable",
  "bootstrap_unavailable",
  "sign_out_unavailable",
  "sign_out_unknown",
  "expire_during_leave",
] as const;
export type ScenarioName = (typeof scenarioNames)[number];
export type Reply =
  | Outcome<unknown>
  | "pending"
  | "empty_page"
  | { readonly delayMs: number; readonly outcome: Outcome<unknown> }
  | null;
export type Script = Partial<Record<PortMethod, (call: number) => Reply>>;

const reads: readonly PortMethod[] = [
  "work.listGoals",
  "work.getGoal",
  "work.listTasks",
  "work.getTask",
  "work.listTaskQuestions",
  "work.listMyOpenQuestions",
  "work.getQuestion",
  "work.getAnswer",
];
const creates: readonly PortMethod[] = [
  "work.createGoal",
  "work.createTask",
  "work.markReady",
  "work.answer",
  "work.cancelQuestion",
];
const all = (methods: readonly PortMethod[], reply: (call: number) => Reply): Script =>
  Object.fromEntries(methods.map((m) => [m, reply]));
const denied: Outcome<never> = {
  kind: "denied",
  message: "You don't have access to view this.",
  reference: "corr-fixture-0403",
};
const sample = (n: number) => ({
  workspaceId: `ws-sample-${n}`,
  displayName: `Sample workspace ${n}`,
});

export const scenarios: Readonly<Record<ScenarioName, Script>> = {
  ready: {},
  empty: {
    "work.listGoals": () => "empty_page",
    "work.listMyOpenQuestions": () => "empty_page",
  },
  loading: { ...all(reads, () => "pending"), "account.overview": () => "pending" },
  denied: all(reads, () => denied),
  home_partial_denied: { "work.listMyOpenQuestions": () => denied },
  session_expired: {
    "workspace.bootstrap": () => ({ kind: "unauthenticated" }),
    "account.overview": () => ({ kind: "unauthenticated" }),
  },
  workspace_unavailable: { "workspace.bootstrap": () => ({ kind: "unauthenticated" }) },
  conflict: {
    "work.createGoal": () => ({
      kind: "conflict",
      recheck: false,
      message: "This request conflicts with an earlier one. Nothing was changed.",
    }),
    "work.createTask": () => ({
      kind: "conflict",
      recheck: false,
      message: "This request conflicts with an earlier one. Nothing was changed.",
    }),
    "work.markReady": () => ({ kind: "conflict", recheck: true, message: "This task changed." }),
    "work.answer": () => ({ kind: "conflict", recheck: true, message: "This question changed." }),
  },
  // The first send is applied but its reply is lost; Check again replays it.
  uncertain: all(creates, (call) => (call === 0 ? { kind: "uncertain" } : null)),
  // Lost, then a still-in-flight 503 (which stays uncertain), then the replay.
  uncertain_persisting: all(creates, (call) =>
    call === 0
      ? { kind: "uncertain" }
      : call === 1
        ? { kind: "unavailable", offline: false }
        : null,
  ),
  reentry: {},
  offline: all(reads, () => ({ kind: "unavailable", offline: true })),
  unavailable: all(reads, () => ({ kind: "unavailable", offline: false })),
  not_in_build: {
    ...all([...reads, ...creates, "work.assign", "work.ask", "work.createTask"], () => ({
      kind: "not_in_build",
    })),
    "account.overview": () => ({ kind: "not_in_build" }),
    "account.createOrganization": () => ({ kind: "not_in_build" }),
  },
  account_form: {
    "account.overview": () => ({
      kind: "ok",
      value: { workspaces: [], truncated: false, onboarding: "available" },
      replayed: false,
    }),
  },
  account_chooser: {
    "account.overview": () => ({
      kind: "ok",
      value: {
        workspaces: [sample(1), sample(2), sample(3)],
        truncated: true,
        onboarding: "unavailable",
      },
      replayed: false,
    }),
  },
  account_invite: {
    "account.overview": () => ({
      kind: "ok",
      value: { workspaces: [], truncated: false, onboarding: "unavailable" },
      replayed: false,
    }),
  },
  // The PR-1 HTTP composition (no account routes, so no probe): every bootstrap is 401.
  // The first asks for sign-in and stores the path; the one after the restore shows
  // WorkspaceUnavailable with Sign in and drops the path, so a second sign-in lands on `/`.
  restore_unavailable: { "workspace.bootstrap": () => ({ kind: "unauthenticated" }) },
  // A bootstrap 503, then the workspace on Retry.
  bootstrap_unavailable: {
    "workspace.bootstrap": (call) => (call === 0 ? { kind: "unavailable", offline: false } : null),
  },
  // Sign-out 503 `logout_unavailable`, then 200 on Try again.
  sign_out_unavailable: {
    "session.signOut": (call) => (call === 0 ? { kind: "unavailable", offline: false } : null),
  },
  // Sign-out 503 `logout_outcome_unknown`, then 200 on Try again.
  sign_out_unknown: { "session.signOut": (call) => (call === 0 ? { kind: "uncertain" } : null) },
  // An answer whose reply is a 401 that arrives 2.5 s later, time enough to open the
  // leave dialog; the probe after it is 401 too (the first overview read is the switcher).
  expire_during_leave: {
    "work.answer": () => ({ delayMs: 2500, outcome: { kind: "unauthenticated" } }),
    "account.overview": (call) => (call === 0 ? null : { kind: "unauthenticated" }),
  },
};

/**
 * Scenarios that model a build's composition rather than one reply: these methods are
 * uncomposed, as in the PR-1 HTTP build. Signing in doesn't change a build, so the
 * fixture sign-in and a return to `/` keep such a scenario (see `scenarioRoot`).
 */
export const uncomposedIn: Readonly<Partial<Record<ScenarioName, readonly PortMethod[]>>> = {
  restore_unavailable: ["account.overview", "account.createOrganization"],
};
/** The fixture's `/`: it keeps a composition scenario, and drops any other. */
export function scenarioRoot(name: ScenarioName): string {
  return uncomposedIn[name] ? `/?scenario=${name}` : "/";
}

/** `?scenario=` is read once at boot; unknown values fall back to `ready`. */
export function readScenario(search: string): ScenarioName {
  const value = new URLSearchParams(search).get("scenario");
  return scenarioNames.find((name) => name === value) ?? "ready";
}
/** Fixture code boots only in a `fixture` build and only on a loopback host (§4.11 d). */
export function fixtureBootAllowed(mode: unknown, hostname: unknown): boolean {
  return mode === "fixture" && (hostname === "127.0.0.1" || hostname === "localhost");
}
