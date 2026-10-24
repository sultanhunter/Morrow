// P14.T01a PR-2 browser journeys (AC22-AC32), run by scripts/workspace-ui-journey-lab.mjs
// after the PR-1 smoke (AC20) on the same configured harness: the real api and broker
// bundles in Miniflare, PostgreSQL 17 with the whole verified chain and the api Worker's work
// login, the synthetic WorkOS oracle and owner-SQL fixtures. Three people sign in for
// real through the SPA (button, POST, intercepted authorize, callback, cookie): A (the
// fixture owner, seeded work grants), B (seeded task view and question answer) and C (a
// fresh subject that enrolls and creates its organization). One near-expiry family for A
// is owner-seeded and set with `context.addCookies` (AC30). Faults are injected only by
// routing one request: the lab forwards it to the server itself and then answers the
// browser as if the reply were lost, so the change commits and the SPA must reconcile.
// Record text carries planted markers that must never reach the console, URLs, titles,
// storage, status regions or the report (AC32). No trace, HAR, video or screenshot.
// P05.T01ab: the api runs its development abuse guard, so every sign-in start and signup
// carries a fresh Turnstile token from the stub `window.turnstile`, which each person's
// context fulfils with tokens issued to the synthetic siteverify; aborts stay at zero.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tsImport } from "tsx/esm/api";
import {
  labChallengeActions,
  turnstileScriptUrl,
  turnstileStub,
} from "./fixtures/turnstile-siteverify.mjs";

const workosAuthorize = "https://api.workos.com/user_management/authorize";
const T = 45000; // generous: CI is the authority, but a loaded host must not flake
const sha = (value) => createHash("sha256").update(value).digest("hex");
const lit = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const wid = (prefix, n) => prefix + "_" + String(n).padStart(26, "0");
const keys = (value) =>
  Object.keys(value ?? {})
    .sort()
    .join(",");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const marker = (name) => `UIMARK-${name}-${randomBytes(6).toString("hex")}`;
// A waiter made before its action: if the step fails first, its later rejection must not
// become an unhandled rejection that ends the run without a report.
const later = (promise) => {
  promise.catch(() => {});
  return promise;
};

export async function accountAndWorkJourneys(h, { browser, observed }) {
  const tenant = await tsImport("../tests/tenant-conformance/harness.mjs", import.meta.url);
  const { origin, f } = h;
  // Verifications before these journeys (AC20's) are not theirs.
  const verifiedFrom = h.siteverify.requests.length;
  const O = f.organization;
  const W = f.workspace;
  const ids = {
    W2: "ws_ui_w2",
    foreignOrg: "org_ui_foreign",
    foreign: "ws_ui_foreign",
    nonMember: "ws_ui_nonmember",
    unknown: "ws_ui_unknown",
  };
  // Planted record text (AC32). Not credentials: they are expected in response bodies.
  const M = {
    w2: marker("workspace-two"),
    goal: marker("goal"),
    criterion1: marker("criterion-one"),
    criterion2: marker("criterion-two"),
    task: marker("task"),
    task2: marker("task-two"),
    question: marker("question"),
    question2: marker("question-two"),
    answer: marker("answer"),
    refused: marker("refused-answer"),
    organization: marker("organization"),
    workspace: marker("workspace"),
  };
  h.privateMarkers.push(...Object.values(M));
  // A failure message may quote a locator that names record text: redact the planted
  // markers, so a held run still writes its report (the report must hold no marker).
  const redact = (message) =>
    Object.values(M).reduce((text, value) => text.replaceAll(value, "<marker>"), message);
  const scenario = (name, run) =>
    h.scenario(name, async () => {
      try {
        await run();
      } catch (error) {
        throw Error(redact(String(error?.message ?? error)));
      }
    });
  const A = {
    key: "ui_a",
    principal: f.principal,
    membership: f.membership,
    org: O,
    workspace: W,
    subject: f.subject,
  };
  const B = {
    key: "ui_b",
    principal: "person_ui_b",
    membership: "membership_ui_b",
    org: O,
    workspace: W,
    subject: wid("user", 901),
    mapping: "mapping_ui_b",
  };
  const C = { subject: wid("user", 902) };
  let sessions = 910;
  const freshSession = () => wid("session", ++sessions);

  // ---- owner-seeded fixtures (ADR-0010 item 1: owner-SQL work grants)
  const fields = tenant.capabilityFields();
  const grants = (p, spec, omit = {}) =>
    Object.entries(spec).map(([capability, verbs]) =>
      tenant.grantInsert(
        p,
        tenant.fixtureGrant(
          p,
          capability,
          verbs,
          fields.get(capability).filter((field) => !(omit[capability] ?? []).includes(field)),
        ),
      ),
    );
  // revoke_workspace_access (0014) scopes both updates to the receipt's workspace.
  const revokeOnW = (p) => {
    const where = `organization_id=${lit(p.org)} AND workspace_id=${lit(p.workspace)} AND membership_id=${lit(p.membership)}`;
    return [
      "BEGIN; SET LOCAL ROLE morrow_identity_owner;",
      tenant.organizationInterlockSql(p.org),
      `SELECT 1 FROM morrow_identity.organizations WHERE id=${lit(p.org)} FOR UPDATE;`,
      `UPDATE morrow_identity.workspace_memberships SET active=false WHERE ${where};`,
      `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE ${where} AND payload->'revokedAt'='null'::jsonb;`,
      `UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id=${lit(p.org)};`,
      "COMMIT;",
    ].join("\n");
  };
  const bOnW = {
    "workspace.goal.create": ["view"],
    "workspace.task.create": ["view"],
    "workspace.question.request": ["view"],
    "workspace.question.answer": ["execute"],
  };
  h.adminSql(
    [
      "SET ROLE morrow_identity_owner;",
      // Self-service on the lab profile, so a fresh subject enrolls and may sign up.
      `INSERT INTO morrow_identity.self_service_revisions(profile_id,revision,enrollment,organization_signup,reason,approval_ref) SELECT ${lit(f.profile)},coalesce(max(revision),0)+1,'enabled','enabled','Synthetic browser lab','approval_ui_lab_1' FROM morrow_identity.self_service_revisions WHERE profile_id=${lit(f.profile)};`,
      `INSERT INTO morrow_identity.workspaces VALUES(${lit(ids.W2)},${lit(O)},${lit(M.w2)},true);`,
      `INSERT INTO morrow_identity.workspaces VALUES(${lit(ids.nonMember)},${lit(O)},'Synthetic non-member',true);`,
      `INSERT INTO morrow_identity.organizations VALUES(${lit(ids.foreignOrg)},'Synthetic foreign',true,1);`,
      `INSERT INTO morrow_identity.workspaces VALUES(${lit(ids.foreign)},${lit(ids.foreignOrg)},'Synthetic foreign',true);`,
      `INSERT INTO morrow_identity.workspace_memberships VALUES(${lit(O)},${lit(ids.W2)},${lit(A.membership)},true);`,
      `INSERT INTO morrow_identity.principals VALUES(${lit(B.principal)},'human',true);`,
      `INSERT INTO morrow_identity.memberships VALUES(${lit(B.membership)},${lit(O)},${lit(B.principal)},true);`,
      `INSERT INTO morrow_identity.workspace_memberships VALUES(${lit(O)},${lit(W)},${lit(B.membership)},true);`,
      `INSERT INTO morrow_identity.workspace_memberships VALUES(${lit(O)},${lit(ids.W2)},${lit(B.membership)},true);`,
      `INSERT INTO morrow_identity.provider_subject_mappings VALUES(${lit(B.mapping)},'workos',${lit(f.environment)},${lit(B.subject)},${lit(B.principal)},1,'active');`,
      `INSERT INTO morrow_identity.provider_subject_profile_bindings VALUES(${lit(B.mapping)},${lit(f.profile)},'workos',${lit(f.environment)},1,'active');`,
      ...grants(A, tenant.fullWorkGrants),
      ...grants({ ...A, key: "ui_a_w2", workspace: ids.W2 }, tenant.fullWorkGrants),
      ...grants(B, bOnW),
      // field_denied on W2: the goal view grant lacks successCriteria (AC27).
      ...grants(
        { ...B, key: "ui_b_w2", workspace: ids.W2 },
        { "workspace.goal.create": ["view"] },
        { "workspace.goal.create": ["successCriteria"] },
      ),
    ].join("\n"),
  );

  // ---- people: one browser context each, with the authorize interception
  const logs = [];
  const loginStarts = [];
  async function loginSlot() {
    // 0010 admits at most 10 starts per 10 s per profile; stay at 8 per 10.5 s.
    for (;;) {
      const recent = loginStarts.filter((at) => at > Date.now() - 10500);
      if (recent.length < 8) break;
      await sleep(recent[0] + 10600 - Date.now());
    }
    loginStarts.push(Date.now());
  }
  async function person(label, subject) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
    });
    const log = {
      label,
      requests: [],
      console: [],
      urls: [],
      titles: [],
      storage: [],
      status: [],
      // Every token this person's stub scripts were given, by action (P05.T01ab).
      tokens: { login: [], signup: [] },
    };
    logs.push(log);
    context.setDefaultTimeout(T);
    await context.route(
      (url) => url.origin !== origin,
      async (route) => {
        const url = new URL(route.request().url());
        if (
          url.origin + url.pathname === workosAuthorize &&
          route.request().isNavigationRequest()
        ) {
          observed.authorize++;
          const armed = h.oracle.arm(route.request().url(), {
            subjectId: subject,
            sessionId: freshSession(),
          });
          h.secret(armed.code, armed.token, route.request().url());
          return route.fulfill({
            status: 302,
            headers: { location: armed.callbackUrl, "cache-control": "no-store" },
          });
        }
        observed.aborted++;
        return route.abort();
      },
    );
    // Registered after the abort-all route, so Playwright tries it first: the allowlisted
    // Turnstile script is the stub, built per request (routing disables the HTTP cache),
    // so each page load gets its own fresh login and signup tokens.
    await context.route(
      (url) => url.href === turnstileScriptUrl,
      (route) => {
        observed.turnstileScript++;
        const issue = (action) => [1, 2, 3].map(() => h.siteverify.issue(action));
        const login = issue(labChallengeActions.login);
        const signup = issue(labChallengeActions.signup);
        log.tokens.login.push(...login);
        log.tokens.signup.push(...signup);
        return route.fulfill({
          status: 200,
          contentType: "text/javascript; charset=utf-8",
          body: turnstileStub({
            [labChallengeActions.login]: login,
            [labChallengeActions.signup]: signup,
          }),
        });
      },
    );
    context.on("page", (page) => watch(page, log));
    return { label, context, log };
  }
  function watch(page, log) {
    // A full navigation away from unsent text meets the leave guard's beforeunload.
    page.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
    page.on("request", (request) =>
      log.requests.push({
        method: request.method(),
        url: request.url(),
        body: request.method() === "POST" ? (request.postData() ?? "") : null,
        key: request.headers()["idempotency-key"] ?? null,
        challenge: request.headers()["x-morrow-challenge"] ?? null,
      }),
    );
    page.on("console", (message) => log.console.push(message.text()));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) log.urls.push(frame.url());
    });
  }
  // A snapshot for AC32: title, both storages and every status region's text.
  async function sample(page, log) {
    log.titles.push(await page.title());
    log.storage.push(
      await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      ),
    );
    log.status.push(
      ...(await page
        .locator('[role="status"]')
        .allTextContents()
        .catch(() => [])),
    );
  }
  const heading = (page, name) => page.getByRole("heading", { name }).waitFor({ timeout: T });
  const text = (page, value) => page.getByText(value).first().waitFor({ timeout: T });
  const morrowKeys = (page) =>
    page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("morrow.")));
  const cookieOf = async (who) => {
    const cookie = (await who.context.cookies(origin)).find(
      (c) => c.name === "__Host-morrow_session",
    );
    if (!cookie) throw Error("NO_SESSION_COOKIE_" + who.label);
    h.secret(cookie.value);
    return cookie.value;
  };
  async function signIn(page) {
    await loginSlot();
    await page.getByRole("button", { name: "Sign in" }).click();
  }

  const instance = await h.instance();
  // The same api the browser talks to, for API-seeded steps and server-side checks.
  async function api(cookie, method, path, body, key = randomUUID(), extra = {}) {
    const headers = {
      Cookie: "__Host-morrow_session=" + cookie,
      "X-Morrow-Request": "1",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    };
    if (method === "POST")
      Object.assign(headers, {
        Origin: origin,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        ...extra,
      });
    const reply = await instance.fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: reply.status, body: h.json(reply.body) };
  }
  // AC10/AC25/AC28 fault injection: forward the first POST to the server with the same
  // cookie, key, body and challenge token, then tell the browser the reply was lost. The route stays
  // registered and passes every later request through: removing it from inside its own
  // handler (an earlier local run) let Chromium continue the paused request to the server.
  async function loseReplyOnce(page, url, cookie, lost) {
    const forwarded = [];
    let used = false;
    await page.route(url, async (route) => {
      const request = route.request();
      if (used || request.method() !== "POST") return route.fallback();
      used = true;
      try {
        const key = request.headers()["idempotency-key"];
        const challenge = request.headers()["x-morrow-challenge"];
        const reply = await api(
          cookie,
          "POST",
          new URL(request.url()).pathname,
          request.postData() ?? "",
          key,
          challenge === undefined ? {} : { "X-Morrow-Challenge": challenge },
        );
        forwarded.push({ status: reply.status, key });
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify(lost),
        });
      } catch {
        forwarded.push({ status: 0, key: null });
        await route.abort().catch(() => {});
      }
    });
    return forwarded;
  }
  const uncertainEnvelope = () => ({
    schemaVersion: 1,
    code: "uncertain",
    retryClass: "reconcile_before_retry",
    safeMessage: "The outcome is unknown. Retry with the same idempotency key.",
    correlationId: randomUUID(),
    operationId: null,
    retryAfterSeconds: null,
    inputRequestIds: [],
  });
  const posts = (log, path) =>
    log.requests.filter((r) => r.method === "POST" && new URL(r.url).pathname === path);

  const a = await person("A", A.subject);
  const b = await person("B", B.subject);
  const c = await person("C", C.subject);
  const state = {};
  try {
    // ---- AC22: the account landing, real sign-in at `/`, the chooser in server order
    await scenario("AC22_account_landing_sign_in_and_chooser", async () => {
      const page = await a.context.newPage();
      state.aPage = page;
      const first = later(page.waitForResponse((r) => r.url() === origin + "/workspaces"));
      await page.goto(origin + "/");
      h.check("AC22:first_overview_401", (await first).status() === 401);
      await heading(page, "Sign in to Morrow");
      h.check("AC22:no_storage_before_sign_in", (await morrowKeys(page)).length === 0);
      const login = later(page.waitForRequest((r) => r.url() === origin + "/auth/login"));
      const listed = later(
        page.waitForResponse((r) => r.url() === origin + "/workspaces" && r.status() === 200, {
          timeout: 2 * T,
        }),
      );
      await signIn(page);
      h.check("AC22:login_body_v2_exact", (await login).postData() === '{"schemaVersion":2}');
      const overview = await (await listed).json();
      await heading(page, "Your workspaces");
      const rows = await page.locator("a.chooser-link .chooser-name").allTextContents();
      h.check(
        "AC22:chooser_in_server_order",
        rows.length === 2 &&
          JSON.stringify(rows) === JSON.stringify(overview.workspaces.map((w) => w.workspaceName)),
      );
      // `/` stores no intended route, so after sign-in nothing at all is stored.
      h.check("AC22:nothing_stored_after_sign_in", (await morrowKeys(page)).length === 0);
      state.rows = rows;
      state.aCookie = await cookieOf(a);
      await sample(page, a.log);
    });

    // ---- AC27: work commands on W with seeded grants
    await scenario("AC27_work_commands_seeded_grants", async () => {
      const page = state.aPage;
      // The fixture workspace W is named "Synthetic"; W2 carries a planted name.
      await page.locator("a.chooser-link").nth(state.rows.indexOf("Synthetic")).click();
      await page.waitForURL(`**/w/${W}`, { timeout: T });
      await page.getByRole("link", { name: "Work", exact: true }).click();
      await text(page, "No work yet");
      h.check("AC27:empty_state_named", await page.getByText("No work yet").isVisible());
      await page.getByRole("button", { name: "Create goal" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Objective").fill(M.goal);
      await dialog.getByLabel("Criterion 1").fill(M.criterion1);
      await dialog.getByRole("button", { name: "Add criterion" }).click();
      await dialog.getByLabel("Criterion 2").fill(M.criterion2);
      const goalPost = later(
        page.waitForRequest(
          (r) => r.method() === "POST" && r.url() === `${origin}/workspace/${W}/work/goals`,
        ),
      );
      await dialog.getByRole("button", { name: "Create goal" }).click();
      const goalBody = JSON.parse((await goalPost).postData());
      h.check(
        "AC27:goal_body_closed",
        keys(goalBody) === "objective,storeIds,successCriteria" &&
          goalBody.storeIds.length === 0 &&
          goalBody.successCriteria.length === 2 &&
          goalBody.successCriteria.every(
            (criterion) =>
              keys(criterion) === "description,evidenceRequired,verificationCapabilityId" &&
              criterion.verificationCapabilityId === null &&
              criterion.evidenceRequired === false,
          ),
      );
      await text(page, "Goal created.");
      await heading(page, M.goal);
      await page.getByRole("button", { name: "Create task" }).first().click();
      const taskDialog = page.getByRole("dialog");
      await taskDialog.getByLabel("Objective").fill(M.task);
      const taskPost = later(
        page.waitForResponse(
          (r) =>
            r.request().method() === "POST" && r.url() === `${origin}/workspace/${W}/work/tasks`,
        ),
      );
      await taskDialog.getByRole("button", { name: "Create task" }).click();
      const taskReply = await taskPost;
      const taskBody = JSON.parse(taskReply.request().postData());
      h.check(
        "AC27:task_body_closed",
        keys(taskBody) === "allowedResources,goalId,objective" &&
          taskBody.allowedResources.length === 0,
      );
      state.taskId = (await taskReply.json()).taskId;
      state.goalId = taskBody.goalId;
      // The goal's tasks open and are read again, so the confirmed task is listed.
      await page.getByRole("link", { name: M.task }).waitFor({ timeout: T });
      // A second draft task (B's denied Mark ready, AC29) and 25 more goals (Load more).
      const second = await api(state.aCookie, "POST", `/workspace/${W}/work/tasks`, {
        goalId: state.goalId,
        objective: M.task2,
        allowedResources: [],
      });
      state.task2Id = second.body?.taskId;
      for (let batch = 0; batch < 5; batch++)
        await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            api(state.aCookie, "POST", `/workspace/${W}/work/goals`, {
              objective: `Synthetic goal ${batch * 5 + i + 1}`,
              storeIds: [],
              successCriteria: [
                {
                  description: "Synthetic",
                  verificationCapabilityId: null,
                  evidenceRequired: false,
                },
              ],
            }),
          ),
        );
      await page.reload();
      await page.getByRole("button", { name: "Load more" }).waitFor({ timeout: T });
      const before = await page.locator("li.goal").count();
      const pageTwo = later(
        page.waitForRequest((r) => r.url().includes("/work/goals?limit=25&after=")),
      );
      await page.getByRole("button", { name: "Load more" }).click();
      h.check(
        "AC27:load_more_follows_next",
        new URL((await pageTwo).url()).searchParams.has("after"),
      );
      await page.waitForFunction(() => document.querySelectorAll("li.goal").length === 26, null, {
        timeout: T,
      });
      h.check("AC27:load_more_appends", before === 25);
      // Stale revision: the assignment to B (seeded by API, AC29) moves the task on.
      await page.goto(`${origin}/w/${W}/work/${state.taskId}`);
      await heading(page, M.task);
      await text(page, "Revision 1");
      const assigned = await api(
        state.aCookie,
        "POST",
        `/workspace/${W}/work/tasks/${state.taskId}/assignment`,
        { assigneeId: B.principal, expectedRevision: 1 },
      );
      h.check("AC29:assignment_seeded_by_api", assigned.status === 200);
      const statusPath = `/workspace/${W}/work/tasks/${state.taskId}/status`;
      const firstReady = later(page.waitForRequest((r) => r.url() === origin + statusPath));
      await page.getByRole("button", { name: "Mark ready" }).click();
      const firstRequest = await firstReady;
      await text(page, "This task changed. The current values are shown");
      await text(page, `Revision ${assigned.body?.revision}`);
      h.check(
        "AC27:stale_revision_refetched_choice_kept",
        JSON.parse(firstRequest.postData()).expectedRevision === 1 &&
          (await page.getByRole("button", { name: "Mark ready" }).isVisible()),
      );
      const secondReady = later(page.waitForRequest((r) => r.url() === origin + statusPath));
      await page.getByRole("button", { name: "Mark ready" }).click();
      const secondRequest = await secondReady;
      await text(page, "Task marked ready.");
      h.check(
        "AC27:resubmit_new_key_and_revision",
        secondRequest.headers()["idempotency-key"] !== firstRequest.headers()["idempotency-key"] &&
          JSON.parse(secondRequest.postData()).expectedRevision === assigned.body?.revision,
      );
      const task = await api(state.aCookie, "GET", `/workspace/${W}/work/tasks/${state.taskId}`);
      h.check("AC29:task_marked_ready", task.body?.task?.status === "ready");
      state.taskRevision = task.body?.task?.revision;
      await sample(page, a.log);
    });

    // ---- AC24: the switcher opens W2 with no W content left; a second tab on W works
    await scenario("AC24_switcher_and_second_tab", async () => {
      const page = state.aPage;
      await page.getByRole("button", { name: /Switch workspace/ }).click();
      await page.getByRole("menuitemradio", { name: M.w2 }).click();
      await page.waitForURL(`**/w/${ids.W2}`, { timeout: T });
      await heading(page, M.w2);
      const html = await page.content();
      h.check(
        "AC24:no_w1_marker_after_switch",
        !html.includes(M.goal) && !html.includes(M.task) && !html.includes(state.taskId),
      );
      await page.getByRole("link", { name: "Work", exact: true }).click();
      await text(page, "No work yet");
      const tab = await a.context.newPage();
      state.aTab = tab;
      await tab.goto(`${origin}/w/${W}/work/${state.taskId}`);
      await heading(tab, M.task);
      h.check(
        "AC24:second_tab_on_w1_keeps_working",
        await tab.getByText(M.task).first().isVisible(),
      );
      await sample(page, a.log);
    });

    // ---- AC28 (A side): A sees the answer form on B's open question; the server's 403
    await scenario("AC28_viewer_sees_form_server_refuses", async () => {
      const asked = await api(
        state.aCookie,
        "POST",
        `/workspace/${W}/work/tasks/${state.taskId}/questions`,
        { question: M.question, respondentId: B.principal },
      );
      h.check("AC29:question_seeded_by_api", asked.status === 201);
      state.questionId = asked.body?.questionId;
      const tab = state.aTab;
      await tab.getByRole("tab", { name: "Questions" }).click();
      await tab.getByRole("link", { name: "Open question" }).click();
      await tab.waitForURL(`**/inbox/questions/${state.questionId}`, { timeout: T });
      await tab.getByLabel("Your answer").fill(M.refused);
      await tab.getByRole("button", { name: "Send answer" }).click();
      await text(tab, "This operation is not permitted.");
      h.check("AC28:refusal_carries_reference", await tab.getByText(/^Reference: /).isVisible());
      const after = await api(
        state.aCookie,
        "GET",
        `/workspace/${W}/work/questions/${state.questionId}`,
      );
      h.check(
        "AC28:refused_answer_changes_nothing",
        after.body?.question?.status === "open" && after.body?.question?.revision === 1,
      );
      await sample(tab, a.log);
    });

    // ---- AC28, AC29 (B side): B's inbox, an uncertain answer reconciled once
    await scenario("AC28_AC29_respondent_answers_once", async () => {
      // A second open question on the task, addressed to A: B's inbox must not list it.
      const other = await api(
        state.aCookie,
        "POST",
        `/workspace/${W}/work/tasks/${state.taskId}/questions`,
        { question: M.question2, respondentId: A.principal },
      );
      h.check("AC28:question_to_a_seeded_by_api", other.status === 201);
      const page = await b.context.newPage();
      state.bPage = page;
      await page.goto(`${origin}/w/${W}/inbox`);
      await heading(page, "Sign in to continue");
      h.check(
        "AC04:inbox_path_stored",
        (await page.evaluate(() => sessionStorage.getItem("morrow.intended.v1"))) ===
          `/w/${W}/inbox`,
      );
      await signIn(page);
      await page.getByRole("heading", { name: "Inbox" }).waitFor({ timeout: 2 * T });
      await page.getByRole("link", { name: M.question }).waitFor({ timeout: T });
      h.check(
        "AC28:inbox_lists_only_my_open_questions",
        (await page.locator("ul.item-list li").count()) === 1 &&
          !(await page.content()).includes(M.question2),
      );
      state.bCookie = await cookieOf(b);
      await page.getByRole("link", { name: M.question }).click();
      await text(page, "Answering doesn't approve any change.");
      h.check(
        "AC28:no_approval_copy",
        await page.getByText("Answering doesn't approve any change.").isVisible(),
      );
      const answerPath = `/workspace/${W}/work/questions/${state.questionId}/answer`;
      const forwarded = await loseReplyOnce(
        page,
        origin + answerPath,
        state.bCookie,
        uncertainEnvelope(),
      );
      await page.getByLabel("Your answer").fill(M.answer);
      await page.getByRole("button", { name: "Send answer" }).dblclick();
      await text(page, "We couldn't confirm whether this was saved.");
      h.check(
        "AC10:form_kept_and_disabled",
        (await page.getByLabel("Your answer").isDisabled()) &&
          (await page.getByLabel("Your answer").inputValue()) === M.answer,
      );
      h.check("AC11:double_activation_one_request", posts(b.log, answerPath).length === 1);
      const reconciled = later(
        page.waitForResponse(
          (r) => r.request().method() === "POST" && r.url() === origin + answerPath,
        ),
      );
      await page.getByRole("button", { name: "Check again" }).dblclick();
      const replay = await reconciled;
      h.check(
        "AC28:check_again_200_replayed",
        replay.status() === 200 && (await replay.json()).replayed === true,
      );
      await text(page, "Answer sent.");
      await page.getByText(M.answer).first().waitFor({ timeout: T });
      const sent = posts(b.log, answerPath);
      h.check(
        "AC28:check_again_reuses_key_and_body",
        forwarded.length === 1 &&
          forwarded[0].status === 200 &&
          sent.length === 2 &&
          sent[0].key === sent[1].key &&
          sent[0].key === forwarded[0].key &&
          sent[0].body === sent[1].body,
      );
      h.check("AC28:success_shown_once", (await page.getByText("Answer sent.").count()) === 1);
      await sample(page, b.log);
    });

    // ---- AC28, AC29: A refreshes and sees the answer under Questions
    await scenario("AC29_requester_sees_answer", async () => {
      const tab = state.aTab;
      const answerPath = `/workspace/${W}/work/questions/${state.questionId}/answer`;
      const answerReads = () =>
        a.log.requests.filter((r) => r.method === "GET" && new URL(r.url).pathname === answerPath)
          .length;
      await tab.goto(`${origin}/w/${W}/work/${state.taskId}`);
      await heading(tab, M.task);
      const before = answerReads();
      await tab.getByRole("tab", { name: "Questions" }).click();
      const show = tab.getByRole("button", { name: "Show answer" });
      await show.waitFor({ timeout: T });
      // One answered question: one disclosure, and no answer read until it is opened.
      h.check(
        "AC29:answer_read_only_when_shown",
        (await show.count()) === 1 && answerReads() === before,
      );
      await show.click();
      await tab.getByText(M.answer).first().waitFor({ timeout: T });
      h.check(
        "AC29:answer_under_questions",
        (await tab.getByText(M.answer).first().isVisible()) && answerReads() === before + 1,
      );
      await sample(tab, a.log);
    });

    // ---- AC29: B's Mark ready is denied with no detail; AC27: field_denied on W2
    await scenario("AC29_AC27_respondent_denied_and_field_denied", async () => {
      const page = state.bPage;
      await page.goto(`${origin}/w/${W}/work/${state.task2Id}`);
      await heading(page, M.task2);
      const refused = later(page.waitForResponse((r) => r.url().endsWith("/status")));
      await page.getByRole("button", { name: "Mark ready" }).click();
      const reply = await refused;
      await text(page, "This operation is not permitted.");
      h.check(
        "AC29:mark_ready_denied_without_detail",
        reply.status() === 403 &&
          (await reply.json()).safeMessage === "This operation is not permitted.",
      );
      const task2 = await api(state.aCookie, "GET", `/workspace/${W}/work/tasks/${state.task2Id}`);
      h.check("AC29:denied_changes_nothing", task2.body?.task?.status === "draft");
      const goals = later(
        page.waitForResponse((r) => r.url().includes(`/workspace/${ids.W2}/work/goals`)),
      );
      await page.goto(`${origin}/w/${ids.W2}/work`);
      const denied = await goals;
      await text(page, "You don't have access to view work");
      h.check(
        "AC27:field_denied_is_denied",
        denied.status() === 403 &&
          (await denied.json()).safeMessage === "The requested fields are not permitted." &&
          (await page.locator("li.goal").count()) === 0,
      );
      await sample(page, b.log);
    });

    // ---- AC25, AC26: a fresh subject enrolls, creates its organization through an
    // unknown outcome, and gets a truthful template-v1 Home
    await scenario("AC25_AC26_signup_unknown_outcome_and_fresh_owner", async () => {
      const page = await c.context.newPage();
      await page.goto(origin + "/");
      await heading(page, "Sign in to Morrow");
      await signIn(page);
      await page
        .getByRole("heading", { name: "Create your organization" })
        .waitFor({ timeout: 2 * T });
      state.cCookie = await cookieOf(c);
      // A second tab loads the form before the organization exists; it submits later with
      // its own fresh key, as a reload would (AC25).
      const stale = await c.context.newPage();
      await stale.goto(origin + "/");
      await stale.getByRole("heading", { name: "Create your organization" }).waitFor();
      const lost = await loseReplyOnce(page, origin + "/organizations", state.cCookie, {
        schemaVersion: 1,
        outcome: "outcome_unknown",
      });
      await page.getByLabel("Organization name").fill(M.organization);
      await page.getByLabel("Workspace name").fill(M.workspace);
      await page.getByRole("button", { name: "Create organization" }).click();
      await text(page, "We couldn't confirm whether this was saved.");
      h.check(
        "AC25:form_disabled_while_unknown",
        await page.getByLabel("Workspace name").isDisabled(),
      );
      const opened = later(page.waitForURL(/\/w\/[^/]+$/, { timeout: T }));
      await page.getByRole("button", { name: "Check again" }).click();
      await opened;
      await heading(page, M.workspace);
      const sent = posts(c.log, "/organizations");
      h.check(
        "AC25:same_key_and_body_on_check_again",
        lost.length === 1 &&
          lost[0].status === 201 &&
          sent.length === 2 &&
          sent[0].key === sent[1].key &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            sent[0].key,
          ) &&
          sent[0].body === sent[1].body &&
          JSON.parse(sent[0].body).schemaVersion === 1,
      );
      const signups = h.adminSql(
        `SELECT count(*) FROM morrow_identity.organization_signups s JOIN morrow_identity.provider_subject_mappings m ON m.principal_id=s.principal_id WHERE m.subject_id=${lit(C.subject)};SELECT count(*) FROM morrow_identity.organizations WHERE display_name=${lit(M.organization)};`,
      );
      h.check(
        "AC25:one_organization_under_fault_injection",
        signups.split("\n").join(",") === "1,1",
      );
      // AC26: template v1 is governance-only, so each Home panel shows its own denial.
      await text(page, "Paid work starts once this workspace has an active plan.");
      // Each panel settles on its own read: wait for the second denial before counting.
      await page.locator(".panel .state-denied").nth(1).waitFor();
      h.check(
        "AC26:home_panels_each_denied",
        (await page.locator(".panel .state-denied").count()) === 2,
      );
      await page.getByRole("link", { name: "Work", exact: true }).click();
      await text(page, "You don't have access to view work");
      // The second tab's fresh key: one organization per principal (409 already_onboarded),
      // and the form reads the account again, which now opens the one workspace.
      await stale.getByLabel("Organization name").fill(M.organization);
      await stale.getByLabel("Workspace name").fill(M.workspace);
      const conflict = later(
        stale.waitForResponse(
          (r) => r.request().method() === "POST" && r.url() === origin + "/organizations",
        ),
      );
      const refetched = later(
        stale.waitForResponse((r) => r.url() === origin + "/workspaces" && r.status() === 200),
      );
      const reopened = later(stale.waitForURL(/\/w\/[^/]+$/, { timeout: T }));
      await stale.getByRole("button", { name: "Create organization" }).click();
      const refused = await conflict;
      const refusedBody = await refused.json();
      await refetched;
      await reopened;
      await heading(stale, M.workspace);
      const keys = posts(c.log, "/organizations").map((r) => r.key);
      h.check(
        "AC25:fresh_key_409_refetches_and_opens",
        refused.status() === 409 &&
          refusedBody.outcome === "already_onboarded" &&
          keys.length === 3 &&
          keys[2] !== keys[0] &&
          new URL(stale.url()).pathname === new URL(page.url()).pathname.replace(/\/work$/, ""),
      );
      // P05.T01ab (P04.T01i D5): each signup POST, the Check again and the second tab's
      // included, carried its own fresh signup token from this person's stubs.
      const signupTokens = posts(c.log, "/organizations").map((r) => r.challenge);
      h.check(
        "P05T01ab-D5:each_signup_post_carries_a_fresh_signup_token",
        lost.length === 1 &&
          signupTokens.length === 3 &&
          new Set(signupTokens).size === 3 &&
          signupTokens.every((token) => c.log.tokens.signup.includes(token)),
      );
      await sample(stale, c.log);
      await stale.close();
      const depth = await page.evaluate(() => history.length);
      const replaced = later(page.waitForURL(/\/w\/[^/]+$/, { timeout: T }));
      await page.goto(origin + "/");
      await replaced;
      // The account landing replaces `/` with the workspace: one entry, not two.
      h.check(
        "AC22:one_workspace_replaces_location",
        new URL(page.url()).pathname !== "/" &&
          (await page.evaluate(() => history.length)) === depth + 1,
      );
      await sample(page, c.log);
    });

    // ---- AC23: foreign, unknown and non-member workspaces: one probe, one view
    await scenario("AC23_workspace_401_probe", async () => {
      for (const id of [ids.foreign, ids.unknown, ids.nonMember]) {
        const page = await a.context.newPage();
        const probes = [];
        page.on("request", (r) => {
          if (r.url() === origin + "/workspaces") probes.push(r.url());
        });
        await page.goto(`${origin}/w/${id}`);
        await heading(page, "This workspace isn't available to you");
        h.check(`AC23:one_probe:${id}`, probes.length === 1);
        h.check(
          `AC23:no_sign_in_and_no_intended_route:${id}`,
          (await page.getByRole("button", { name: "Sign in" }).count()) === 0 &&
            (await page.evaluate(() => sessionStorage.getItem("morrow.intended.v1"))) === null,
        );
        await sample(page, a.log);
        await page.close();
      }
    });

    // ---- AC30: a family expiring mid-task; the probe is 401 too; re-entry opens the task
    await scenario("AC30_session_loss_and_resume", async () => {
      const family = h.adminSql(
        `SELECT family_id FROM morrow_identity.browser_session_generations WHERE secret_digest=${lit(sha(state.aCookie))};`,
      );
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(family)) throw Error("FAMILY_NOT_FOUND");
      const secret = randomBytes(32).toString("base64url");
      h.secret(secret, sha(secret));
      const lifetime = 50;
      const fid = randomUUID();
      h.adminSql(
        `SET ROLE morrow_identity_owner;INSERT INTO morrow_identity.browser_session_families(id,provider_binding_id,profile_record_revision,mapping_revision,binding_revision,created_at,expires_at) SELECT ${lit(fid)},provider_binding_id,profile_record_revision,mapping_revision,binding_revision,statement_timestamp()-interval '15 minutes'+interval '${lifetime} seconds',statement_timestamp()+interval '${lifetime} seconds' FROM morrow_identity.browser_session_families WHERE id=${lit(family)};INSERT INTO morrow_identity.browser_session_generations(id,family_id,secret_digest,created_at,expires_at) SELECT ${lit(randomUUID())},id,${lit(sha(secret))},created_at,expires_at FROM morrow_identity.browser_session_families WHERE id=${lit(fid)};`,
      );
      const expiresAt = Date.now() + lifetime * 1000;
      const resumed = await person("A2", A.subject);
      await resumed.context.addCookies([
        {
          name: "__Host-morrow_session",
          value: secret,
          url: origin + "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const page = await resumed.context.newPage();
      const taskPath = `/w/${W}/work/${state.taskId}`;
      await page.goto(origin + taskPath);
      await heading(page, M.task);
      const revisionA = await page
        .getByText(/^Revision \d+$/)
        .first()
        .textContent();
      // B's session in a second context shows the same record and revision.
      await state.bPage.goto(origin + taskPath);
      await heading(state.bPage, M.task);
      const revisionB = await state.bPage
        .getByText(/^Revision \d+$/)
        .first()
        .textContent();
      h.check(
        "AC30:second_context_same_record_and_revision",
        revisionA === revisionB && revisionA === `Revision ${state.taskRevision}`,
      );
      await sleep(Math.max(0, expiresAt - Date.now()) + 2000);
      const probe = later(page.waitForResponse((r) => r.url() === origin + "/workspaces"));
      await page.getByRole("tab", { name: "Questions" }).click();
      h.check("AC30:probe_also_401", (await probe).status() === 401);
      await heading(page, "Sign in to continue");
      h.check(
        "AC30:markers_left_the_dom_and_path_stored",
        !(await page.content()).includes(M.task) &&
          (await page.evaluate(() => sessionStorage.getItem("morrow.intended.v1"))) === taskPath,
      );
      // The callback's own reply is recorded, so a slow or failed re-entry is diagnosable.
      const callback = later(
        page.waitForResponse((r) => r.url().startsWith(origin + "/auth/workos/callback?"), {
          timeout: 2 * T,
        }),
      );
      await signIn(page);
      const returned = await callback;
      h.check(
        "AC30:re_entry_callback_303_to_root",
        returned.status() === 303 && returned.headers().location === "/",
      );
      await page.getByRole("heading", { name: M.task }).waitFor({ timeout: 2 * T });
      h.check("AC30:re_entry_opens_the_task", new URL(page.url()).pathname === taskPath);
      await sample(page, resumed.log);
      await resumed.context.close();
    });

    // ---- AC31: B's access to W is revoked; one view; B's W2 still works
    await scenario("AC31_revocation", async () => {
      // The effects of revoke_workspace_access (0014) for B on W only: B's W membership
      // and B's W grants. B's W2 membership and W2 grants are untouched.
      const w2Goals = `/workspace/${ids.W2}/work/goals?limit=25`;
      const w2Before = await api(state.bCookie, "GET", w2Goals);
      h.adminSql(revokeOnW(B));
      const page = state.bPage;
      const probe = later(page.waitForResponse((r) => r.url() === origin + "/workspaces"));
      await page.getByRole("tab", { name: "Questions" }).click();
      h.check("AC31:probe_200", (await probe).status() === 200);
      await heading(page, "This workspace isn't available to you");
      const html = await page.content();
      h.check(
        "AC31:no_w_content_in_dom_or_storage",
        [M.goal, M.task, M.question, M.question2, M.answer, state.taskId].every(
          (m) => !html.includes(m),
        ) && (await morrowKeys(page)).length === 0,
      );
      await page.goto(`${origin}/w/${ids.W2}`);
      await heading(page, M.w2);
      h.check("AC31:other_workspace_still_works", new URL(page.url()).pathname === `/w/${ids.W2}`);
      // B's W2 goal grant survives: the read is the same field_denied 403 as before, not
      // the denial of a revoked grant.
      const w2After = await api(state.bCookie, "GET", w2Goals);
      h.check(
        "AC31:w2_work_read_unchanged",
        w2Before.status === 403 &&
          w2Before.body?.safeMessage === "The requested fields are not permitted." &&
          w2After.status === w2Before.status &&
          w2After.body?.safeMessage === w2Before.body?.safeMessage,
      );
      await sample(page, b.log);
    });

    // ---- P05.T01ab: every guarded POST carried its own token, verified once
    await scenario("P05T01ab_guarded_posts_carry_fresh_tokens", async () => {
      const starts = logs.flatMap((log) =>
        posts(log, "/auth/login").map((r) => ({ token: r.challenge, issued: log.tokens.login })),
      );
      const signups = logs.flatMap((log) => posts(log, "/organizations"));
      h.check(
        "P05T01ab-D5:each_sign_in_start_carries_a_fresh_login_token",
        starts.length === 4 &&
          new Set(starts.map((start) => start.token)).size === starts.length &&
          starts.every((start) => start.issued.includes(start.token)),
      );
      // The lab forwards the first signup itself (AC25), so every guarded POST reaches
      // the api once, and the synthetic siteverify passed each one exactly once.
      const verified = h.siteverify.requests.slice(verifiedFrom);
      h.check(
        "P05T01ab-D5:one_passed_verification_per_guarded_post",
        verified.length === starts.length + signups.length &&
          verified.every((row) => row.success === true && row.secretMatches),
      );
    });
  } finally {
    // ---- AC32: planted markers never reach the console, URLs, titles, storage or status
    const markers = Object.values(M);
    const leaks = (values) => values.filter((v) => markers.some((m) => String(v).includes(m)));
    const every = (pick) => logs.flatMap(pick);
    h.check("AC32:no_marker_in_console", leaks(every((l) => l.console)).length === 0);
    h.check(
      "AC32:no_marker_in_urls",
      leaks(every((l) => [...l.urls, ...l.requests.map((r) => r.url)])).length === 0,
    );
    h.check("AC32:no_marker_in_titles", leaks(every((l) => l.titles)).length === 0);
    h.check("AC32:no_marker_in_storage", leaks(every((l) => l.storage)).length === 0);
    h.check("AC32:no_marker_in_status_regions", leaks(every((l) => l.status)).length === 0);
    h.check(
      "AC32:samples_taken",
      every((l) => l.titles).length >= 8 && every((l) => l.storage).length >= 8,
    );
    for (const who of [a, b, c]) await who.context.close().catch(() => {});
    await instance.dispose();
  }
}
