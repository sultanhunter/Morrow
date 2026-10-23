// Scripted outcomes per scenario (P14.T01a §4.11). A script maps a port method and its
// call index to a reply; `null` keeps the seed behaviour. Scripted, not simulated: there
// are no permissions, digests or caps here; PR-2 proves those over HTTP.
import type { Outcome, PersonRole, PortMethod } from "@morrow/workspace-ui";

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
  "account_rate_limited",
  "account_rate_limited_brief",
  "account_uncertain",
  "account_unavailable",
  "account_invalid_name",
  "account_signup_refused",
  "account_signup_denied",
  "account_already_onboarded",
  "account_challenge_failed",
  "account_challenge_unavailable",
  "account_guard_rate_limited",
  "uncertain_late",
  "ready_denied",
  "question_expired",
  "restore_unavailable",
  "bootstrap_unavailable",
  "sign_out_unavailable",
  "sign_out_unknown",
  "expire_during_leave",
  "connections_offered",
  "connections_not_permitted",
  "connections_route_not_ready",
  "connections_unlinked",
  "connections_handoff",
  "connections_handoff_route",
  "connections_handoff_expired",
  "connections_link_uncertain",
  "team_member",
  "team_admin",
  "team_add_uncertain",
  "team_thinking_conflict",
  "team_thinking_uncertain",
  "team_solo",
  "stop_all",
  "stop_all_uncertain",
  "notifications_conflict",
] as const;
export type ScenarioName = (typeof scenarioNames)[number];
export type Reply =
  | Outcome<unknown>
  | "pending"
  | "empty_page"
  // A reply after `delayMs`; a null outcome is the seed behaviour, applied then.
  | { readonly delayMs: number; readonly outcome: Outcome<unknown> | null }
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
  // T7 PR 16.
  "team.overview",
  "team.agent",
  "team.catalogue",
  "settings.plan",
  "settings.emailAddresses",
  "settings.notifications",
  "settings.activity",
  "library.knowledge",
  "library.files",
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
  organizationName: n === 3 ? "Sample organization B" : "Sample organization A",
});
// M2 PR-2: a workspace with no store yet, and each install-link offer.
const noStore = (installLink: Readonly<Record<string, unknown>>): Outcome<unknown> => ({
  kind: "ok",
  value: { installations: [], installLink },
  replayed: false,
});
const accountForm: Outcome<unknown> = {
  kind: "ok",
  value: { workspaces: [], truncated: false, onboarding: "available" },
  replayed: false,
};

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
  // Lost, then a Check again whose replay arrives 1.5 s later: time enough to close the
  // dialog, or to reopen it on another goal, before the reply lands.
  uncertain_late: all(creates, (call) =>
    call === 0 ? { kind: "uncertain" } : call === 1 ? { delayMs: 1500, outcome: null } : null,
  ),
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
  account_form: { "account.overview": () => accountForm },
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
  // Signup 429: the action stays off for Retry-After (90 s here, 2 s in the brief one,
  // whose second submit is created).
  account_rate_limited: {
    "account.overview": () => accountForm,
    "account.createOrganization": () => ({ kind: "rate_limited", retryAfterSeconds: 90 }),
  },
  account_rate_limited_brief: {
    "account.overview": () => accountForm,
    "account.createOrganization": (call) =>
      call === 0 ? { kind: "rate_limited", retryAfterSeconds: 2 } : null,
  },
  // Signup 503 outcome_unknown: Check again resends the same key and gets `replayed`.
  account_uncertain: {
    "account.overview": () => accountForm,
    "account.createOrganization": (call) => (call === 0 ? { kind: "uncertain" } : null),
  },
  // GET /workspaces 503: the landing keeps Sign out.
  account_unavailable: {
    "account.overview": () => ({ kind: "unavailable", offline: false }),
  },
  // Signup 400 invalid_name: both name fields are marked.
  account_invalid_name: {
    "account.overview": () => accountForm,
    "account.createOrganization": () => ({ kind: "invalid", field: "name" }),
  },
  // Signup 400 from the request guard (`request_denied`): no field to mark.
  account_signup_refused: {
    "account.overview": () => accountForm,
    "account.createOrganization": () => ({ kind: "invalid", field: null }),
  },
  // Signup 403 signup_unavailable, 0.8 s late (the button reads "Creating…"): the action
  // stays off and the values stay.
  account_signup_denied: {
    "account.overview": () => accountForm,
    "account.createOrganization": () => ({
      delayMs: 800,
      outcome: { kind: "denied", message: "", reference: null },
    }),
  },
  // Signup 409 already_onboarded (another tab created it): the account is read again,
  // and now opens the one workspace.
  account_already_onboarded: {
    "account.overview": (call) => (call === 0 ? accountForm : null),
    "account.createOrganization": () => ({ kind: "conflict", recheck: true, message: "" }),
  },
  // P05.T01ab, with a challenge widget (fixtures/challenge.ts): the api guard's 403
  // challenge_failed (unavailable: nothing ran), then Try again with a fresh token creates.
  account_challenge_failed: {
    "account.overview": () => accountForm,
    "account.createOrganization": (call) =>
      call === 0 ? { kind: "unavailable", offline: false } : null,
  },
  // The widget yields no token, so the form sends nothing. Any send, with or without a token,
  // gets this scripted denial, so a form that sent anyway would fail the state case.
  account_challenge_unavailable: {
    "account.overview": () => accountForm,
    "account.createOrganization": () => ({ kind: "denied", message: "", reference: null }),
  },
  // The api guard's per-address 429 (Retry-After: 60): the existing signup hold.
  account_guard_rate_limited: {
    "account.overview": () => accountForm,
    "account.createOrganization": () => ({ kind: "rate_limited", retryAfterSeconds: 60 }),
  },
  // Mark ready by someone who may view the task but not change it: the server's 403.
  ready_denied: {
    "work.markReady": () => ({
      kind: "denied",
      message: "This operation is not permitted.",
      reference: "corr-fixture-0403",
    }),
  },
  // An open question that has since expired: no answer form.
  question_expired: {
    "work.getQuestion": () => ({
      kind: "ok",
      value: {
        id: "q-source",
        taskId: "task-source",
        prompt: "Which supplier certificate should product pages cite?",
        status: "expired",
        respondent: { principalId: "prn-sample-7f3a", kind: "human", label: null, isSelf: null },
        revision: 2,
        updatedAt: "2026-10-15T16:00:00.000Z",
        expiresAt: "2026-10-15T16:00:00.000Z",
      },
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
  // M2 PR-2 connections. No store yet: the install link offered, not permitted, or waiting
  // on the subscription.
  connections_offered: {
    "connections.list": () =>
      noStore({
        offered: true,
        url: "https://admin.shopify.com/oauth/install_custom_app?client_id=sample&signature=sample",
        reason: "offered",
      }),
  },
  connections_not_permitted: {
    "connections.list": () => noStore({ offered: false, url: null, reason: "not_permitted" }),
  },
  connections_route_not_ready: {
    "connections.list": () => noStore({ offered: false, url: null, reason: "route_not_ready" }),
  },
  // Installed on Shopify, not linked, and no continuation in memory (a sign-in lost it).
  connections_unlinked: {},
  // Opened from the connector's redirect: preview, then Link store applies (the seed).
  connections_handoff: {},
  // The preview's 409 billing_route_required.
  connections_handoff_route: {
    "storeLinks.preview": () => ({ kind: "conflict", recheck: false, message: "" }),
  },
  // The preview's 404 linking_not_found (expired or already used).
  connections_handoff_expired: { "storeLinks.preview": () => ({ kind: "not_found" }) },
  // The apply is applied but its reply is lost; Check again asks status, which answers it.
  connections_link_uncertain: {
    "storeLinks.apply": (call) => (call === 0 ? { kind: "uncertain" } : null),
  },
  // T7 PR 16: Team as a member (no change controls) and as an Admin (added agents only),
  // the add confirmation's lost reply (Check again replays it), and a thinking change
  // whose record moved on (the server's 409: reread).
  team_member: {},
  team_admin: {},
  team_add_uncertain: {
    "team.addConfirm": (call) => (call === 0 ? { kind: "uncertain" } : null),
  },
  // A one-person shop: adding an agent needs no teammate's review.
  team_solo: {},
  // Stop all AI work: the Listings agent is on; in the second, the first stop's reply is
  // lost and Check again replays the same key.
  stop_all: {},
  stop_all_uncertain: {
    "agents.listingsStop": (call) => (call === 0 ? { kind: "uncertain" } : null),
  },
  // A notifications save whose record moved on (the server's 409: reread).
  notifications_conflict: {
    "settings.reviseNotifications": (call) =>
      call === 0
        ? {
            kind: "conflict",
            recheck: true,
            message: "These settings changed since you opened them.",
          }
        : null,
  },
  // A teammate changes how a helper thinks just before the viewer's first save: the record
  // moves on (a new choice and revision; the team fixture does it), so the save meets a real
  // 409 and only a save of the reread revision goes through.
  team_thinking_conflict: {},
  // A thinking change whose reply is lost: the dialog may close, and its marker stays.
  team_thinking_uncertain: {
    "team.reviseThinking": (call) => (call === 0 ? { kind: "uncertain" } : null),
  },
};
/** T7 PR 16: these scenarios start with the Listings agent on (Stop all AI work has a target). */
export const listingsOnIn: readonly ScenarioName[] = ["stop_all", "stop_all_uncertain"];
/** T7 PR 16: who views Team in each scenario (the Owner unless named). */
export const teamViewerIn: Readonly<Partial<Record<ScenarioName, PersonRole>>> = {
  team_member: "member",
  team_admin: "admin",
};
/** M2 PR-2: these scenarios start with the sample store installed but not linked. */
export const unlinkedStoreIn: readonly ScenarioName[] = [
  "connections_unlinked",
  "connections_handoff",
  "connections_handoff_route",
  "connections_handoff_expired",
  "connections_link_uncertain",
];

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
