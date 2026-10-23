// The scripted fixture adapter (P14.T01a §4.11). Dev-only: reachable only through
// fixture.html → fixture-main.tsx, built only under `--mode fixture`, and it never calls
// fetch. Commands are idempotent per key, as the server's are: a replay of an applied
// key answers `replayed`.
import {
  portMethods,
  type AnswerView,
  type ListingsAgentView,
  type ListingsDocumentView,
  type ModelCatalogueView,
  type Command,
  type Composed,
  type GoalView,
  type Outcome,
  type Page,
  type PortMethod,
  type QuestionView,
  type RunAdmittedView,
  type RunDetailView,
  type RunView,
  type TaskView,
  type WorkspacePort,
} from "@morrow/workspace-ui";
import { challengedIn } from "./challenge";
import {
  createSeed,
  fixtureCatalogue,
  fixtureConnection,
  fixtureCsrfToken,
  fixtureHandoffToken,
  fixtureInstallUrl,
  fixtureOrganizationName,
  fixtureStore,
  fixtureWorkspace,
  people,
} from "./seed";
import {
  listingsOnIn,
  scenarios,
  teamViewerIn,
  uncomposedIn,
  unlinkedStoreIn,
  type ScenarioName,
} from "./scenarios";
import { createTeamFixture } from "./team";

/** Present in every fixture bundle; `verify:workspace-web` fails a dist that holds it. */
export const fixtureCanary = "MORROW_FIXTURE_BUILD_CANARY";

const unbuilt: readonly PortMethod[] = ["session.keepAlive", "people.list"];
/** What a scenario's build composes; an uncomposed method answers `not_in_build`. */
export function fixtureComposedFor(scenario: ScenarioName): Composed {
  const off = [...unbuilt, ...(uncomposedIn[scenario] ?? [])];
  return Object.freeze(
    Object.fromEntries(portMethods.map((m) => [m, !off.includes(m)])) as Record<
      PortMethod,
      boolean
    >,
  );
}
export const fixtureComposed: Composed = fixtureComposedFor("ready");

const ok = <T>(value: T, replayed = false): Outcome<T> => ({ kind: "ok", value, replayed });
const notFound = { kind: "not_found" } as const;
function page<T>(items: readonly T[], after: string | null, size: number): Page<T> {
  const start = after === null ? 0 : Number(after.replace(/^cursor-/, ""));
  const slice = items.slice(start, start + size);
  const next = start + size < items.length ? `cursor-${start + size}` : null;
  return { items: slice, next };
}

export function createFixtureAdapter(scenario: ScenarioName): WorkspacePort {
  const seed = createSeed();
  const script = scenarios[scenario];
  const composed = fixtureComposedFor(scenario);
  const calls = new Map<PortMethod, number>();
  const applied = new Map<string, Outcome<unknown>>();
  // P05.T01ab: where the scenario's build asks for a challenge, signup needs a token the
  // api guard has never seen; a missing or spent one is the guard's 403 challenge_*,
  // which the HTTP adapter decodes as unavailable (nothing ran).
  // The fixture guard (a missing or spent token is refused, as the api guard refuses it)
  // runs only where the widget issues tokens. Where it yields none ("fails"), any send at
  // all falls through to the scenario's scripted reply, so a form that sent without a
  // token would show that reply and fail its state case (P05.T01ab review).
  const challenged = challengedIn[scenario] === "issues";
  const spentChallenges = new Set<string>();
  let created = 0;
  // Scripted reply first; `null` falls through to the seed behaviour.
  function reply<T>(method: PortMethod, fallback: () => Outcome<T>): Promise<Outcome<T>> {
    // As over HTTP, an uncomposed method sends nothing.
    if (!composed[method]) return Promise.resolve({ kind: "not_in_build" });
    const call = calls.get(method) ?? 0;
    calls.set(method, call + 1);
    const scripted = script[method]?.(call) ?? null;
    if (scripted === "pending") return new Promise(() => {});
    if (scripted === "empty_page")
      return Promise.resolve(ok({ items: [], next: null }) as Outcome<T>);
    if (scripted !== null && "delayMs" in scripted) {
      const { delayMs, outcome } = scripted;
      return new Promise((resolve) =>
        setTimeout(() => resolve((outcome ?? fallback()) as Outcome<T>), delayMs),
      );
    }
    if (scripted !== null && scripted.kind !== "uncertain")
      return Promise.resolve(scripted as Outcome<T>);
    const outcome = fallback();
    return Promise.resolve(scripted ?? outcome);
  }
  // A command's effect happens once per key; a repeat answers `replayed`.
  function command<T>(method: PortMethod, c: Command<unknown>, apply: () => Outcome<T>) {
    return reply<T>(method, () => {
      const previous = applied.get(c.key);
      if (previous)
        return previous.kind === "ok"
          ? { ...(previous as Outcome<T> & { kind: "ok" }), replayed: true }
          : (previous as Outcome<T>);
      const outcome = apply();
      applied.set(c.key, outcome);
      return outcome;
    });
  }
  // M2 PR-2: an unlinked sample store, with the install link offered; a link applies once
  // per key (preview, apply and status share the handoff's key, so results are per route).
  if (unlinkedStoreIn.includes(scenario))
    seed.connections = {
      installations: [fixtureConnection("unlinked")],
      installLink: { offered: true, url: fixtureInstallUrl, reason: "offered" },
    };
  const linkResults = new Map<string, "applied">();
  const ws = (id: string) => id === fixtureWorkspace.id;
  const task = (id: string) => seed.tasks.find((t) => t.id === id);
  const question = (id: string) => seed.questions.find((q) => q.id === id);
  const goal = (id: string) => seed.goals.find((g) => g.id === id);
  const at = () => new Date(Date.UTC(2026, 9, 16, 9, created)).toISOString();
  // M3 PR-1 fixture state: the Listings agent of the fixture store, and the model default.
  // T7 PR 16: `stop_all` scenarios start with it on (enabled earlier, not stopped).
  const listings = {
    installationId: (listingsOnIn.includes(scenario) ? "inst-listings-0" : null) as string | null,
    status: "active" as "active" | "disabled",
    stopped: false,
    revision: 0,
    document: null as ListingsDocumentView | null,
  };
  // The store's association is current while M2 PR-2's sample connection is linked.
  const storeLinked = () =>
    seed.connections.installations.some(
      (i) => i.storeId === fixtureStore.storeId && i.status === "linked",
    );
  const listingsView = (): ListingsAgentView => ({
    storeId: fixtureStore.storeId,
    linked: storeLinked(),
    blocked: false,
    installation:
      listings.installationId === null
        ? null
        : {
            installationId: listings.installationId,
            status: listings.status,
            revision: listings.revision,
            stopped: listings.stopped,
            updatedAt: at(),
          },
    actions: {
      enable: listings.installationId === null && storeLinked(),
      resume: listings.installationId !== null && listings.stopped && storeLinked(),
      stop: listings.installationId !== null,
    },
  });
  // T7 PR 16: who views Team in this scenario. The workspace model default (the Listings
  // agent's choice) is the Owner's to change, as Team shows; Admins and members only see it.
  const teamViewer = teamViewerIn[scenario] ?? "owner";
  const modelDefault = {
    model: "claude_sonnet_5_5",
    effort: "low",
    ceiling: 1,
    revision: null as number | null,
    canRevise: teamViewer === "owner",
  };
  // M3 PR-2 fixture runs: an admitted run drafts at once (the fixture has no Workflow);
  // product:13 is "too long" and fails, as an input over the cap would.
  const runs: RunDetailView[] = [];
  const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  // T7 PR 16: Team, agent pages, Add agents, Settings, Shop knowledge and Files.
  const teamGroups = createTeamFixture({
    viewer: teamViewer,
    empty: scenario === "empty",
    solo: scenario === "team_solo",
    teammateSavesFirst: scenario === "team_thinking_conflict",
    isWorkspace: ws,
    workspaceDefault: () => ({
      model: modelDefault.model,
      effort: modelDefault.effort,
      revision: modelDefault.revision,
    }),
    reply,
    command,
  });
  return {
    ...teamGroups,
    session: {
      startSignIn: () => reply("session.startSignIn", () => ok({ navigateTo: "/" })),
      signOut: () => reply("session.signOut", () => ok("ended" as const)),
      keepAlive: () => Promise.resolve({ kind: "not_in_build" }),
    },
    workspace: {
      bootstrap: (id) =>
        reply("workspace.bootstrap", () =>
          ws(id) ? ok({ ...fixtureWorkspace }) : { kind: "unauthenticated" },
        ),
    },
    account: {
      overview: () =>
        reply("account.overview", () =>
          ok({
            workspaces: [
              {
                workspaceId: fixtureWorkspace.id,
                displayName: fixtureWorkspace.displayName,
                organizationName: fixtureOrganizationName,
              },
            ],
            truncated: false,
            onboarding: "unavailable" as const,
          }),
        ),
      createOrganization: (c, challenge = null) => {
        if (challenged) {
          if (challenge === null || spentChallenges.has(challenge))
            return Promise.resolve({ kind: "unavailable", offline: false });
          spentChallenges.add(challenge);
        }
        return command("account.createOrganization", c, () =>
          ok({ workspaceId: fixtureWorkspace.id }),
        );
      },
    },
    work: {
      listGoals: (id, after) =>
        reply<Page<GoalView>>("work.listGoals", () =>
          ws(id) ? ok(page(seed.goals, after, 25)) : notFound,
        ),
      getGoal: (id, goalId) =>
        reply<GoalView>("work.getGoal", () =>
          ws(id) && goal(goalId) ? ok(goal(goalId)!) : notFound,
        ),
      createGoal: (id, c) =>
        command("work.createGoal", c, () => {
          created++;
          const goalId = `goal-new-${created}`;
          seed.goals.unshift({
            id: goalId,
            objective: c.body.objective,
            status: "draft",
            criteria: [...c.body.criteria],
            owner: people.owner,
            revision: 1,
            updatedAt: at(),
          });
          return ws(id) ? ok({ goalId }) : notFound;
        }),
      listTasks: (id, goalId, after) =>
        reply<Page<TaskView>>("work.listTasks", () =>
          ws(id)
            ? ok(
                page(
                  seed.tasks.filter((t) => t.goalId === goalId),
                  after,
                  50,
                ),
              )
            : notFound,
        ),
      getTask: (id, taskId) =>
        reply<TaskView>("work.getTask", () =>
          ws(id) && task(taskId) ? ok(task(taskId)!) : notFound,
        ),
      createTask: (id, c) =>
        command("work.createTask", c, () => {
          created++;
          const taskId = `task-new-${created}`;
          seed.tasks.push({
            id: taskId,
            goalId: c.body.goalId,
            objective: c.body.objective,
            status: "draft",
            owner: people.owner,
            revision: 1,
            updatedAt: at(),
          });
          return ws(id) ? ok({ taskId }) : notFound;
        }),
      markReady: (id, taskId, c) =>
        command("work.markReady", c, () => {
          const current = task(taskId);
          if (!ws(id) || !current) return notFound;
          if (current.revision !== c.body.expectedRevision)
            return { kind: "conflict", recheck: true, message: "This task changed." };
          const index = seed.tasks.indexOf(current);
          seed.tasks[index] = {
            ...current,
            status: "ready",
            revision: current.revision + 1,
            updatedAt: at(),
          };
          return ok({ revision: current.revision + 1 });
        }),
      assign: (id, taskId, c) =>
        command("work.assign", c, () => {
          const current = task(taskId);
          return ws(id) && current ? ok({ revision: current.revision + 1 }) : notFound;
        }),
      listTaskQuestions: (id, taskId, after) =>
        reply<Page<QuestionView>>("work.listTaskQuestions", () =>
          ws(id)
            ? ok(
                page(
                  seed.questions.filter((q) => q.taskId === taskId),
                  after,
                  50,
                ),
              )
            : notFound,
        ),
      ask: (id, taskId, c) =>
        command("work.ask", c, () => {
          created++;
          const questionId = `q-new-${created}`;
          seed.questions.push({
            id: questionId,
            taskId,
            prompt: c.body.question,
            status: "open",
            respondent: people.owner,
            revision: 1,
            updatedAt: at(),
            expiresAt: null,
          });
          return ws(id) ? ok({ questionId }) : notFound;
        }),
      listMyOpenQuestions: (id, after) =>
        reply<Page<QuestionView>>("work.listMyOpenQuestions", () =>
          ws(id)
            ? ok(
                page(
                  seed.questions.filter((q) => q.status === "open"),
                  after,
                  50,
                ),
              )
            : notFound,
        ),
      getQuestion: (id, questionId) =>
        reply<QuestionView>("work.getQuestion", () =>
          ws(id) && question(questionId) ? ok(question(questionId)!) : notFound,
        ),
      answer: (id, questionId, c) =>
        command("work.answer", c, () => {
          const current = question(questionId);
          if (!ws(id) || !current) return notFound;
          if (current.status !== "open" || current.revision !== c.body.expectedRevision)
            return { kind: "conflict", recheck: true, message: "This question changed." };
          seed.questions[seed.questions.indexOf(current)] = {
            ...current,
            status: "answered",
            revision: current.revision + 1,
            updatedAt: at(),
          };
          seed.answers[questionId] = { text: c.body.text, by: people.owner, at: at() };
          return ok({ answerRevision: 1 });
        }),
      cancelQuestion: (id, questionId, c) =>
        command("work.cancelQuestion", c, () => {
          const current = question(questionId);
          if (!ws(id) || !current) return notFound;
          if (current.status !== "open" || current.revision !== c.body.expectedRevision)
            return { kind: "conflict", recheck: true, message: "This question changed." };
          seed.questions[seed.questions.indexOf(current)] = {
            ...current,
            status: "cancelled",
            revision: current.revision + 1,
            updatedAt: at(),
          };
          return ok({ revision: current.revision + 1 });
        }),
      getAnswer: (id, questionId) =>
        reply<AnswerView>("work.getAnswer", () => {
          const answer = seed.answers[questionId];
          return ws(id) && answer
            ? ok({
                id: `answer-${questionId}`,
                questionId,
                text: answer.text,
                answeredBy: answer.by,
                createdAt: answer.at,
              })
            : notFound;
        }),
    },
    people: { list: () => Promise.resolve({ kind: "not_in_build" }) },
    connections: {
      list: (id) =>
        reply("connections.list", () =>
          ws(id)
            ? ok({
                installations: [...seed.connections.installations],
                installLink: seed.connections.installLink,
              })
            : { kind: "unauthenticated" },
        ),
    },
    storeLinks: {
      preview: (id, c) =>
        reply("storeLinks.preview", () => {
          const unlinked = seed.connections.installations.find((i) => i.status === "unlinked");
          if (!ws(id) || c.body.handoffToken !== fixtureHandoffToken || !unlinked)
            return linkResults.has(c.key)
              ? ok({ installationId: fixtureStore.installationId, csrfToken: fixtureCsrfToken })
              : notFound;
          return ok({ installationId: unlinked.installationId, csrfToken: fixtureCsrfToken });
        }),
      apply: (id, c, csrf) =>
        reply("storeLinks.apply", () => {
          if (!ws(id) || csrf !== fixtureCsrfToken)
            return { kind: "denied", message: "", reference: null };
          if (linkResults.has(c.key)) return ok({ outcome: "applied" as const }, true);
          if (c.body.handoffToken !== fixtureHandoffToken) return notFound;
          linkResults.set(c.key, "applied");
          seed.connections = {
            installations: [fixtureConnection("linked")],
            installLink: { offered: false, url: null, reason: "linked" },
          };
          return ok({ outcome: "applied" as const });
        }),
      status: (id, c) =>
        reply("storeLinks.status", () =>
          ws(id) && linkResults.has(c.key) ? ok({ outcome: "applied" as const }) : notFound,
        ),
    },
    // M3 PR-1: one fixture store with the Listings agent, and the catalogue version 1
    // listing (no provider strings, prices or tokens). Scripted, not simulated: the
    // server's kernel, document binding and stops are proved by lab:listings-authority.
    agents: {
      listingsStatus: (id, storeId) =>
        reply<ListingsAgentView>("agents.listingsStatus", () =>
          ws(id) && storeId === fixtureStore.storeId ? ok(listingsView()) : notFound,
        ),
      listingsDocument: (id, storeId, c) =>
        command("agents.listingsDocument", c, () => {
          if (!ws(id) || storeId !== fixtureStore.storeId) return notFound;
          const view = listingsView();
          const purpose = view.actions.enable ? "enable" : view.actions.resume ? "resume" : null;
          if (purpose === null)
            return { kind: "conflict", recheck: true, message: "The agent changed." };
          created++;
          listings.document = {
            documentDigest: created.toString(16).padStart(64, "d"),
            nonce: created.toString(16).padStart(64, "e"),
            purpose,
            installationId: listings.installationId ?? `inst-listings-${created}`,
            expiresAt: new Date(Date.UTC(2026, 9, 16, 9, 5 + created)).toISOString(),
            releaseRevision: 1,
            grants: [
              { capabilityId: "catalog.content.propose", verbs: ["execute"] },
              { capabilityId: "catalog.content.publish", verbs: ["propose"] },
              { capabilityId: "catalog.products.read", verbs: ["view"] },
            ],
            fields: ["descriptionHtml", "seo.description", "seo.title", "tags", "title"],
          };
          return ok(listings.document);
        }),
      listingsEnable: (id, storeId, c) =>
        command("agents.listingsEnable", c, () => {
          const doc = listings.document;
          if (!ws(id) || storeId !== fixtureStore.storeId) return notFound;
          if (!doc || doc.documentDigest !== c.body.documentDigest || doc.nonce !== c.body.nonce)
            return {
              kind: "conflict",
              recheck: true,
              message: "A precondition for this change is not met.",
            };
          listings.document = null;
          listings.installationId = doc.installationId;
          listings.status = "active";
          listings.stopped = false;
          listings.revision += 1;
          return ok({
            installationId: doc.installationId,
            status: "active",
            revision: listings.revision,
          });
        }),
      listingsStop: (id, storeId, c) =>
        command("agents.listingsStop", c, () => {
          if (!ws(id) || storeId !== fixtureStore.storeId || listings.installationId === null)
            return notFound;
          if (listings.status === "active") listings.revision += 1;
          listings.status = "disabled";
          listings.stopped = true;
          return ok({
            installationId: listings.installationId,
            status: "disabled",
            revision: listings.revision,
          });
        }),
    },
    runs: {
      admit: (id, taskId, c) =>
        command<RunAdmittedView>("runs.admit", c, () => {
          if (!ws(id) || !task(taskId)) return notFound;
          if (c.body.storeId !== fixtureStore.storeId || !storeLinked())
            return { kind: "not_found" };
          if (listings.installationId === null || listings.status !== "active")
            return {
              kind: "conflict",
              recheck: false,
              message: "The Listings agent is not enabled for this store.",
            };
          const key = c.body.selection ?? {
            model: modelDefault.model,
            effort: modelDefault.effort,
          };
          const entry = fixtureCatalogue.find(
            (e) => e.model === key.model && e.effort === key.effort,
          );
          if (!entry) return { kind: "invalid", field: null };
          if (!modelDefault.canRevise && entry.creditsPerProduct > modelDefault.ceiling)
            return {
              kind: "denied",
              message: "That model or effort is above your workspace's limit.",
              reference: null,
            };
          if (c.body.products.length > entry.runProductLimit)
            return {
              kind: "conflict",
              recheck: false,
              message: "Too many products for this model and effort.",
            };
          created += 1;
          const products = c.body.products.map((productId, index) => {
            const failed = productId === "product:13";
            return {
              index,
              productId,
              status: failed ? "failed" : "drafted",
              attempts: failed ? 0 : 1,
              failureCode: failed ? "input_over_cap" : null,
              proposalId: failed ? null : `proposal-${created}`,
              flags: failed
                ? null
                : { newUrls: 0, newEmails: 0, newPhones: 0, tagsAdded: 0, tagsRemoved: 0 },
            };
          });
          const drafted = products.filter((p) => p.status === "drafted").length;
          const run: RunView = {
            runId: runId(created),
            taskId,
            storeId: c.body.storeId,
            status: drafted > 0 ? "succeeded" : "failed",
            endedReason: drafted > 0 ? null : "nothing_drafted",
            selection: { model: entry.model, effort: entry.effort },
            creditsPerProduct: entry.creditsPerProduct,
            productCount: products.length,
            fields: [...c.body.fields],
            productsDrafted: drafted,
            productsFailed: products.length - drafted,
            createdAt: at(),
            endedAt: at(),
          };
          runs.unshift({
            run,
            credits: {
              reserved: products.length * entry.creditsPerProduct,
              settled: drafted * entry.creditsPerProduct,
              status: drafted > 0 ? "settled" : "released",
            },
            usage: { attempts: drafted, inputTokens: 900 * drafted, outputTokens: 300 * drafted },
            products,
            interrupted: false,
          });
          return ok({
            runId: run.runId,
            childTaskId: runId(1000 + created),
            productCount: products.length,
            creditsReserved: products.length * entry.creditsPerProduct,
            selection: run.selection,
          });
        }),
      listOfTask: (id, taskId) =>
        reply<readonly RunView[]>("runs.listOfTask", () =>
          ws(id) && task(taskId)
            ? ok(runs.filter((r) => r.run.taskId === taskId).map((r) => r.run))
            : notFound,
        ),
      get: (id, runIdValue) =>
        reply<RunDetailView>("runs.get", () => {
          const found = runs.find((r) => r.run.runId === runIdValue);
          return ws(id) && found ? ok(found) : notFound;
        }),
      reconcile: (id, c) =>
        command<{ readonly closed: number }>("runs.reconcile", c, () =>
          ws(id) ? ok({ closed: 0 }) : notFound,
        ),
    },
    models: {
      list: (id) =>
        reply<ModelCatalogueView>("models.list", () =>
          ws(id)
            ? ok({
                catalogueVersion: 1,
                entries: fixtureCatalogue.map((e) => ({
                  ...e,
                  allowedForMember:
                    modelDefault.canRevise || e.creditsPerProduct <= modelDefault.ceiling,
                })),
                workspaceDefault: { model: modelDefault.model, effort: modelDefault.effort },
                ceiling: modelDefault.ceiling,
                revision: modelDefault.revision,
                canRevise: modelDefault.canRevise,
                draftingAvailable: true,
              })
            : notFound,
        ),
      reviseDefault: (id, c) =>
        command("models.reviseDefault", c, () => {
          if (!ws(id)) return notFound;
          if (!modelDefault.canRevise)
            return {
              kind: "denied",
              message: "Only the Owner can change the default model.",
              reference: null,
            };
          if (c.body.expectedRevision !== modelDefault.revision)
            return {
              kind: "conflict",
              recheck: true,
              message: "The record changed. Reread it before retrying.",
            };
          const entry = fixtureCatalogue.find(
            (e) => e.model === c.body.model && e.effort === c.body.effort,
          );
          if (!entry || entry.creditsPerProduct > c.body.maxCreditsPerProduct)
            return { kind: "invalid", field: null };
          modelDefault.model = c.body.model;
          modelDefault.effort = c.body.effort;
          modelDefault.ceiling = c.body.maxCreditsPerProduct;
          modelDefault.revision = (modelDefault.revision ?? 0) + 1;
          return ok({ revision: modelDefault.revision });
        }),
    },
  };
}
