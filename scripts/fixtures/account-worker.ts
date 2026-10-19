import { createStandaloneLoginBridge } from "../../packages/identity/src/standalone-login.js";
import { createStandaloneLoginFixture } from "./standalone-login-fixture.js";
import { createManagedStandaloneRequestGuard } from "../../packages/identity/src/standalone-request-guard.js";
import {
  accountOnboardingSql,
  accountOverviewSql,
  executeAccountOverview,
  executeFirstOrganization,
  normalizeDisplayName,
} from "../../packages/identity/src/account-onboarding.js";
import { identitySql } from "../../packages/identity/src/index.js";
import { executeStandaloneWorkspaceBootstrap } from "../../packages/identity/src/standalone-workspace-bootstrap.js";
import {
  dispatchStandaloneLogoutWithAttempt,
  parseStandaloneLogoutConfigurationWithAttempt,
} from "../../packages/identity/src/standalone-logout.js";
import { createStandaloneLogoutFixture } from "./standalone-logout-fixture.js";
import defaultWorker from "../../apps/api/src/worker.js";

// P05.T01x Part B in workerd: account login (start and callback with the account
// admission), the account route guard, the list and signup executors over a synthetic
// stateful SQL port with injected faults, the journey on to bootstrap and logout through
// the managed guard entries the composed handler uses, display names under workerd ICU,
// and the unconfigured default export. The synthetic port is not PostgreSQL; the
// PostgreSQL 17 laboratory owns the SQL semantics.
type Input = {
  at: number;
  profile: Record<string, unknown>;
  profileJson: string;
  snapshotJson: string;
  token: string;
  page: string;
  impersonatedPage: string;
  invalidNames: string[];
  acceptedNames: [string, string][];
};
type Row = Record<string, unknown>;
type Fault = {
  connect?: boolean;
  before?: string;
  after?: string;
  roleRow?: Row;
  deniedReply?: boolean;
};
const origin = "https://workspace.example.test";
const profileId = "profile_a";
const apiRole = {
  role: "morrow_api",
  login: "morrow_api",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  owner_member: false,
};
const onboardingRole = {
  role: "morrow_identity_onboarding",
  login: "morrow_identity_onboarding",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolinherit: false,
  owner_member: false,
  role_member: false,
};
async function sha(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}

// A synthetic stateful account store. A create is staged and applied only at COMMIT,
// so a lost reply before COMMIT leaves nothing and a lost COMMIT ack leaves the effect.
function createStore() {
  const people = new Map<string, { principal: string; profile: string; enrolled: boolean }>();
  const signups = new Map<
    string,
    {
      command: string;
      request: string;
      organizationId: string;
      workspaceId: string;
      membershipId: string;
      organizationName: string;
      workspaceName: string;
      active: boolean;
    }
  >();
  let signupEnabled = true;
  const counts = { connects: 0, creates: 0, commits: 0 };
  function overview(values: readonly string[]): Row[] {
    const person = people.get(values[0]!);
    if (!person || person.profile !== values[1]) return [];
    const signup = signups.get(person.principal);
    return [
      {
        onboarding: person.enrolled && !signup && signupEnabled ? "available" : "unavailable",
        workspaces: JSON.stringify(
          signup && signup.active
            ? [
                {
                  workspaceName: signup.workspaceName,
                  organizationId: signup.organizationId,
                  workspaceId: signup.workspaceId,
                  organizationName: signup.organizationName,
                },
              ]
            : [],
        ),
      },
    ];
  }
  function create(values: readonly string[]): { row: Row; commit?: () => void } {
    const [digest, command, profile, org, ws] = values as [string, string, string, string, string];
    const none = (outcome: string) => ({
      row: { outcome, organization_id: null, workspace_id: null },
    });
    if (!org || !ws || org !== org.normalize("NFC") || ws !== ws.normalize("NFC"))
      return none("invalid");
    const person = people.get(digest);
    if (!person || person.profile !== profile) return none("unauthenticated");
    const request = JSON.stringify([
      "morrow.onboarding.organization",
      "1",
      command,
      profile,
      org,
      ws,
    ]);
    const previous = signups.get(person.principal);
    if (previous) {
      if (previous.command === command && previous.request === request)
        return previous.active
          ? {
              row: {
                outcome: "replayed",
                organization_id: previous.organizationId,
                workspace_id: previous.workspaceId,
              },
            }
          : none("already_onboarded");
      return none(previous.command === command ? "idempotency_conflict" : "already_onboarded");
    }
    if (!person.enrolled) return none("not_eligible");
    if (!signupEnabled) return none("signup_disabled");
    const organizationId = crypto.randomUUID(),
      workspaceId = crypto.randomUUID();
    return {
      row: { outcome: "created", organization_id: organizationId, workspace_id: workspaceId },
      commit: () =>
        signups.set(person.principal, {
          command,
          request,
          organizationId,
          workspaceId,
          membershipId: crypto.randomUUID(),
          organizationName: org,
          workspaceName: ws,
          active: true,
        }),
    };
  }
  // Bootstrap's identity read: the bound digest's active signup workspace, if requested.
  function resolved(bound: readonly string[] | undefined) {
    const person = bound ? people.get(bound[0]!) : undefined;
    const signup = person ? signups.get(person.principal) : undefined;
    if (!person || !signup || !signup.active || signup.workspaceId !== bound![1]) return null;
    return { person, signup };
  }
  function pool(fault: Fault = {}) {
    return {
      async connect() {
        counts.connects++;
        if (fault.connect) throw Error("SYNTHETIC_LEASE_DENIED");
        let staged: (() => void) | undefined;
        let bound: readonly string[] | undefined;
        return {
          async query(text: string, values: readonly string[]) {
            if (fault.before === text) throw Error("SYNTHETIC_LOSS_BEFORE_REPLY");
            let rows: Row[] = [];
            const current = () => resolved(bound);
            const context = (r: NonNullable<ReturnType<typeof current>>) => ({
              principal_id: r.person.principal,
              organization_id: r.signup.organizationId,
              workspace_id: r.signup.workspaceId,
              membership_id: r.signup.membershipId,
              policy_revision: "1",
            });
            if (text === identitySql.role) rows = [apiRole];
            else if (text === identitySql.bind) {
              bound = Object.freeze([...values]);
              rows = [{ configured: true }];
            } else if (text === identitySql.resolve) {
              const r = current();
              rows = r ? [context(r)] : [];
            } else if (text === identitySql.workspace) {
              const r = current();
              rows =
                r && values[0] === r.signup.workspaceId
                  ? [
                      {
                        id: r.signup.workspaceId,
                        organization_id: r.signup.organizationId,
                        display_name: r.signup.workspaceName,
                      },
                    ]
                  : [];
            } else if (text === identitySql.workspaceAuthority) {
              const r = current();
              rows = r ? [{ ...context(r), grants: [] }] : [];
            } else if (text === accountOnboardingSql.role) rows = [fault.roleRow ?? onboardingRole];
            else if (text === accountOverviewSql) rows = overview(values);
            else if (text === accountOnboardingSql.create) {
              counts.creates++;
              const result = fault.deniedReply
                ? { row: { outcome: "denied", organization_id: null, workspace_id: null } }
                : create(values);
              rows = [result.row];
              staged = result.commit;
            } else if (text === accountOnboardingSql.commit || text === identitySql.commit) {
              counts.commits++;
              staged?.();
              staged = undefined;
            } else if (text === accountOnboardingSql.rollback || text === identitySql.rollback)
              staged = undefined;
            if (fault.after === text) throw Error("SYNTHETIC_LOSS_AFTER_EXECUTION");
            return { rows };
          },
          async release() {
            staged = undefined;
          },
        };
      },
    };
  }
  return {
    people,
    signups,
    counts,
    pool,
    setSignup(value: boolean) {
      signupEnabled = value;
    },
  };
}

export default {
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/synthetic-account")
      return new Response(null, { status: 404 });
    const input = (await request.json()) as Input;
    const checks: { name: string; passed: boolean }[] = [];
    const check = (name: string, passed: boolean) => checks.push({ name, passed });
    const accountResponses: Response[] = [];

    // ------------------------------------------------------------ account login (AC06)
    const login = createStandaloneLoginFixture({ ...input, page: input.page });
    const bridge = await createStandaloneLoginBridge(login);
    const start = (body: string) =>
      new Request(origin + "/auth/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Morrow-Request": "1" },
        body,
      });
    const v1 = await bridge.fetch(start(JSON.stringify({ schemaVersion: 1, workspaceId: "w" })));
    check("ac06_workspace_body_refused_400", v1.status === 400 && login.calls.length === 0);
    const started = await bridge.fetch(start(JSON.stringify({ schemaVersion: 2 })));
    const begin = (await started.json()) as { authorizationUrl: string };
    const state = new URL(begin.authorizationUrl).searchParams.get("state");
    const flowCookie = started.headers.getSetCookie()[0]!.split(";")[0]!;
    check(
      "ac06_account_start_200_login_cookie",
      started.status === 200 && flowCookie.startsWith("__Host-morrow_login="),
    );
    const intent = login.calls.find((c) => c.stage === "createAccountIntent");
    check("ac06_account_intent_has_no_workspace", intent?.values.length === 5);
    const callback = await bridge.fetch(
      new Request(origin + `/auth/workos/callback?code=synthetic-code&state=${state}`, {
        headers: { Cookie: flowCookie },
      }),
    );
    const sessionCookie = callback.headers.getSetCookie()[0] ?? "";
    const secret = sessionCookie.split(";")[0]!.split("=")[1] ?? "";
    const digest = await sha(secret);
    const admission = login.calls.find((c) => c.role === "sessions" && c.stage === "admitAccount");
    check(
      "ac06_callback_admits_account_family",
      callback.status === 303 &&
        callback.headers.get("location") === "/" &&
        sessionCookie.startsWith("__Host-morrow_session=") &&
        admission?.values.length === 21 &&
        admission.values[16] === digest &&
        admission.values[17] === profileId,
    );
    check(
      "ac06_login_uses_three_roles_and_no_selection",
      login.calls.every((c) => ["login", "preauth", "sessions"].includes(c.role)),
    );

    // ------------------------------------------------------------ impersonation (AC15)
    const impersonated = createStandaloneLoginFixture({ ...input, page: input.impersonatedPage });
    const otherBridge = await createStandaloneLoginBridge(impersonated);
    const startedTwice = await otherBridge.fetch(start(JSON.stringify({ schemaVersion: 2 })));
    const otherState = new URL(
      ((await startedTwice.json()) as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state");
    const refused = await otherBridge.fetch(
      new Request(origin + `/auth/workos/callback?code=synthetic-code&state=${otherState}`, {
        headers: { Cookie: startedTwice.headers.getSetCookie()[0]!.split(";")[0]! },
      }),
    );
    check(
      "ac15_impersonated_session_no_admission",
      refused.status === 303 &&
        refused.headers.get("location") === "/auth/result" &&
        !refused.headers.has("set-cookie") &&
        !impersonated.calls.some((c) => c.role === "sessions"),
    );

    // ------------------------------------------------------------ account routes
    const store = createStore();
    store.people.set(digest, { principal: "human_a", profile: profileId, enrolled: true });
    const guard = createManagedStandaloneRequestGuard(
      JSON.stringify({ schemaVersion: 1, mode: "https", origin }),
      Date.now,
    );
    async function call(
      route: "workspaces" | "organizations",
      options: {
        secret?: string | null;
        key?: string;
        body?: string;
        headers?: Record<string, string>;
        fault?: Fault;
        profile?: string;
        method?: string;
        noOrigin?: boolean;
      } = {},
    ) {
      const post = route === "organizations";
      const cookieSecret = options.secret === undefined ? secret : options.secret;
      const input = new Request(origin + "/" + route, {
        method: options.method ?? (post ? "POST" : "GET"),
        headers: {
          ...(cookieSecret === null ? {} : { Cookie: "__Host-morrow_session=" + cookieSecret }),
          "X-Morrow-Request": "1",
          ...(post
            ? {
                ...(options.noOrigin ? {} : { Origin: origin }),
                "Content-Type": "application/json",
                "Idempotency-Key": options.key ?? crypto.randomUUID(),
              }
            : {}),
          ...options.headers,
        },
        ...(post && options.method === undefined
          ? {
              body:
                options.body ??
                JSON.stringify({
                  schemaVersion: 1,
                  organizationName: "Noor",
                  workspaceName: "Main",
                }),
            }
          : {}),
      });
      const owner = guard.begin(input);
      let invoked = 0;
      try {
        const response = await owner.handleAccount(route, (c) => {
          invoked++;
          const pool = store.pool(options.fault);
          return route === "workspaces"
            ? executeAccountOverview(pool, options.profile ?? profileId, c)
            : executeFirstOrganization(pool, options.profile ?? profileId, c);
        });
        accountResponses.push(response);
        const text = await response.text();
        return {
          status: response.status,
          body: JSON.parse(text) as Record<string, unknown>,
          retryAfter: response.headers.get("retry-after"),
          invoked,
          submitted: owner.accountSubmitted(),
        };
      } finally {
        owner.attempt.end();
      }
    }
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    // Bootstrap and logout through the same managed guard entries the composed workspace
    // handler uses (handle("bootstrap") and the managed logout dispatch), on synthetic ports.
    async function bootstrap(workspaceId: string, cookieSecret: string = secret) {
      const owner = guard.begin(
        new Request(origin + `/workspace/${workspaceId}/bootstrap`, {
          headers: { Cookie: "__Host-morrow_session=" + cookieSecret },
        }),
      );
      try {
        const response = await owner.handle("bootstrap", (c) =>
          executeStandaloneWorkspaceBootstrap(store.pool(), c),
        );
        accountResponses.push(response);
        const text = await response.text();
        return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
      } finally {
        owner.attempt.end();
      }
    }
    const logoutPort = createStandaloneLogoutFixture();
    await logoutPort.register(secret);
    async function logout() {
      const request = new Request(origin + "/auth/logout", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Morrow-Request": "1",
          Cookie: "__Host-morrow_session=" + secret,
        },
        body: '{"schemaVersion":1}',
      });
      const owner = guard.begin(request);
      let delivered: Response | undefined,
        cookies = -1,
        clear: string | undefined;
      try {
        const configuration = await parseStandaloneLogoutConfigurationWithAttempt(
          logoutPort.configurationJson,
          owner.attempt,
        );
        await dispatchStandaloneLogoutWithAttempt(
          request,
          (output) => {
            cookies = output.cookies.length;
            clear = output.cookies[0];
            delivered = new Response(output.bodyText, {
              status: output.status,
              headers: output.headers.map(([name, value]) => [name, value] as [string, string]),
            });
          },
          owner.attempt,
          configuration,
          logoutPort.pool,
        );
      } finally {
        owner.attempt.end();
      }
      const response = delivered!;
      accountResponses.push(response);
      return {
        status: response.status,
        cookies,
        clear,
        body: (await response.json()) as unknown,
      };
    }
    const empty = await call("workspaces");
    check(
      "ac17_fresh_list_empty_onboarding_available",
      empty.status === 200 &&
        same(empty.body, {
          schemaVersion: 1,
          workspaces: [],
          truncated: false,
          onboarding: "available",
        }),
    );
    const key = crypto.randomUUID();
    const decomposedBody = JSON.stringify({
      schemaVersion: 1,
      organizationName: input.acceptedNames[0]![0],
      workspaceName: "Main",
    });
    const created = await call("organizations", { key, body: decomposedBody });
    const signup = store.signups.get("human_a");
    check(
      "ac17_signup_created_with_nfc_names",
      created.status === 201 &&
        created.body.outcome === "created" &&
        signup?.organizationName === input.acceptedNames[0]![1],
    );
    const listed = await call("workspaces");
    check(
      "ac17_list_then_shows_workspace_unavailable",
      listed.status === 200 &&
        same(listed.body, {
          schemaVersion: 1,
          workspaces: [
            {
              organizationId: created.body.organizationId,
              organizationName: input.acceptedNames[0]![1],
              workspaceId: created.body.workspaceId,
              workspaceName: "Main",
            },
          ],
          truncated: false,
          onboarding: "unavailable",
        }),
    );
    const booted = await bootstrap(created.body.workspaceId as string);
    check(
      "ac38_journey_bootstrap_of_created_workspace_200",
      booted.status === 200 &&
        same(booted.body, {
          schemaVersion: 1,
          workspace: { id: created.body.workspaceId, displayName: "Main" },
          policyRevision: 1,
        }),
    );
    const foreignBoot = await bootstrap("w_foreign_workspace");
    check(
      "ac38_journey_bootstrap_of_unlisted_workspace_401",
      foreignBoot.status === 401 && same(foreignBoot.body, { code: "authentication_required" }),
    );
    const replay = await call("organizations", { key, body: decomposedBody });
    check(
      "ac19_same_key_same_body_replayed",
      replay.status === 200 &&
        replay.body.outcome === "replayed" &&
        replay.body.organizationId === created.body.organizationId,
    );
    const conflict = await call("organizations", { key });
    check(
      "ac19_same_key_other_body_conflict",
      conflict.status === 409 && conflict.body.outcome === "idempotency_conflict",
    );
    const again = await call("organizations");
    check(
      "ac19_new_key_already_onboarded",
      again.status === 409 && again.body.outcome === "already_onboarded",
    );

    // AC22/AC23 with a fault-injecting pool on a second enrolled person.
    const second = "b".repeat(43).replace(/b$/, "A");
    const secondDigest = await sha(second);
    store.people.set(secondDigest, { principal: "human_b", profile: profileId, enrolled: true });
    const unknownBody = { schemaVersion: 1, outcome: "outcome_unknown" },
      unavailableBody = { code: "unavailable" };
    const lostKey = crypto.randomUUID();
    const lost = await call("organizations", {
      secret: second,
      key: lostKey,
      fault: { after: accountOnboardingSql.create },
    });
    check(
      "ac22_loss_after_create_sent_unknown",
      lost.status === 503 && same(lost.body, unknownBody) && lost.submitted,
    );
    const retried = await call("organizations", { secret: second, key: lostKey });
    check("ac22_retry_after_uncommitted_loss_creates", retried.status === 201);
    const third = "c".repeat(43).replace(/c$/, "A");
    store.people.set(await sha(third), {
      principal: "human_c",
      profile: profileId,
      enrolled: true,
    });
    const commitKey = crypto.randomUUID();
    const commitLost = await call("organizations", {
      secret: third,
      key: commitKey,
      fault: { after: accountOnboardingSql.commit },
    });
    const commitRetry = await call("organizations", { secret: third, key: commitKey });
    check(
      "ac22_loss_after_commit_unknown_then_replayed_once",
      commitLost.status === 503 &&
        same(commitLost.body, unknownBody) &&
        commitRetry.status === 200 &&
        commitRetry.body.outcome === "replayed" &&
        [...store.signups.keys()].filter((p) => p === "human_c").length === 1,
    );
    const fourth = "d".repeat(43).replace(/d$/, "A");
    store.people.set(await sha(fourth), {
      principal: "human_d",
      profile: profileId,
      enrolled: true,
    });
    for (const [name, fault] of [
      ["lease_or_connect_failure", { connect: true }],
      ["begin_failure", { before: accountOnboardingSql.begin }],
      ["role_row_mismatch", { roleRow: { ...onboardingRole, role: "morrow_api" } }],
      ["denied_reply", { deniedReply: true }],
    ] as [string, Fault][]) {
      const r = await call("organizations", { secret: fourth, fault });
      check(
        "ac23_" + name + "_unavailable",
        r.status === 503 && same(r.body, unavailableBody) && !store.signups.has("human_d"),
      );
    }
    store.setSignup(false);
    const disabled = await call("organizations", { secret: fourth });
    check(
      "ac25_signup_disabled_403",
      disabled.status === 403 && disabled.body.outcome === "signup_unavailable",
    );
    store.setSignup(true);

    // AC30: the TypeScript rule under workerd ICU.
    check(
      "ac30_workerd_invalid_names_refused",
      input.invalidNames.every((name) => normalizeDisplayName(name) === null),
    );
    check(
      "ac30_workerd_accepted_names_normalized",
      input.acceptedNames.every(([sent, stored]) => normalizeDisplayName(sent) === stored),
    );
    let invalidAnswers = true;
    for (const name of input.invalidNames.slice(0, 6)) {
      const r = await call("organizations", {
        secret: fourth,
        body: JSON.stringify({ schemaVersion: 1, organizationName: name, workspaceName: "Main" }),
      });
      invalidAnswers &&=
        r.status === 400 && same(r.body, { schemaVersion: 1, outcome: "invalid_name" });
    }
    check("ac30_workerd_invalid_name_400", invalidAnswers);

    // AC28/AC29/AC31: envelope and session states, before any SQL.
    const listWithoutOrigin = await call("workspaces");
    check(
      "ac28_same_origin_get_without_origin_reaches_list",
      listWithoutOrigin.status === 200 && listWithoutOrigin.invoked === 1,
    );
    const connectsBefore = store.counts.connects;
    const envelope: [string, Awaited<ReturnType<typeof call>>, number][] = [
      ["post_without_origin", await call("organizations", { noOrigin: true }), 403],
      [
        "foreign_origin",
        await call("workspaces", { headers: { Origin: "https://evil.example" } }),
        403,
      ],
      [
        "cross_site",
        await call("organizations", { headers: { "Sec-Fetch-Site": "cross-site" } }),
        403,
      ],
      ["navigate", await call("workspaces", { headers: { "Sec-Fetch-Mode": "navigate" } }), 403],
      ["document", await call("workspaces", { headers: { "Sec-Fetch-Dest": "document" } }), 403],
      ["no_marker", await call("workspaces", { headers: { "X-Morrow-Request": "0" } }), 403],
      [
        "wrong_type",
        await call("organizations", { headers: { "Content-Type": "text/plain" } }),
        403,
      ],
      ["authorization", await call("workspaces", { headers: { Authorization: "Bearer x" } }), 401],
      ["upper_key", await call("organizations", { key: crypto.randomUUID().toUpperCase() }), 400],
      [
        "client_tenant_field",
        await call("organizations", {
          body: JSON.stringify({
            schemaVersion: 1,
            organizationName: "N",
            workspaceName: "W",
            workspaceId: "w",
          }),
        }),
        400,
      ],
      ["no_cookie_list", await call("workspaces", { secret: null }), 401],
      ["no_cookie_signup", await call("organizations", { secret: null }), 401],
      ["head", await call("workspaces", { method: "HEAD" }), 405],
      ["put", await call("organizations", { method: "PUT" }), 405],
    ];
    for (const [name, r, status] of envelope)
      check("ac28_" + name + "_" + status, r.status === status);
    check("ac28_envelope_failures_open_no_connection", store.counts.connects === connectsBefore);
    const unknownSecret = "e".repeat(43).replace(/e$/, "A");
    const unknownList = await call("workspaces", { secret: unknownSecret });
    const unknownPost = await call("organizations", { secret: unknownSecret });
    const otherProfile = await call("workspaces", { profile: "profile_b" });
    check(
      "ac31_unknown_or_foreign_profile_family_401_both_routes",
      unknownList.status === 401 &&
        unknownPost.status === 401 &&
        otherProfile.status === 401 &&
        same(unknownPost.body, { code: "authentication_required" }),
    );

    // AC38: the journey ends with logout of the same family. The two synthetic ports share
    // no state, so the logout port's committed end is applied to the account port before
    // the list and bootstrap are read again.
    const ended = await logout();
    const endedCommitted = await logoutPort.ended(secret);
    if (endedCommitted) store.people.delete(digest);
    const afterLogoutList = await call("workspaces");
    const afterLogoutBoot = await bootstrap(created.body.workspaceId as string);
    check(
      "ac38_journey_logout_ends_family_then_401",
      ended.status === 200 &&
        // P05.T01y-AC26: the post-SQL logout plan carries exactly the session clear.
        ended.cookies === 1 &&
        ended.clear ===
          "__Host-morrow_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0" &&
        same(ended.body, { schemaVersion: 1, outcome: "session_ended" }) &&
        endedCommitted &&
        afterLogoutList.status === 401 &&
        afterLogoutBoot.status === 401 &&
        afterLogoutBoot.text === foreignBoot.text,
    );
    // AC38: no account response sets a cookie; the unconfigured default denies with 401.
    check(
      "ac38_account_routes_never_set_cookie",
      accountResponses.every((r) => !r.headers.has("set-cookie")),
    );
    const ctx = { waitUntil() {} };
    const listDenied = await defaultWorker.fetch(
      new Request(origin + "/workspaces", { headers: { "X-Morrow-Request": "1" } }),
      undefined,
      ctx,
    );
    const postDenied = await defaultWorker.fetch(
      new Request(origin + "/organizations", { method: "POST", body: "{}" }),
      undefined,
      ctx,
    );
    check(
      "ac38_unconfigured_default_401_both_routes",
      listDenied.status === 401 &&
        postDenied.status === 401 &&
        !listDenied.headers.has("set-cookie") &&
        same(await listDenied.json(), { code: "authentication_required" }),
    );
    return Response.json({
      checks,
      store: { ...store.counts, signups: store.signups.size },
      loginStatements: login.calls.map((c) => c.role + ":" + c.stage),
    });
  },
};
