// The scripted fixture adapter (P14.T01a §4.11). Dev-only: reachable only through
// fixture.html → fixture-main.tsx, built only under `--mode fixture`, and it never calls
// fetch. Commands are idempotent per key, as the server's are: a replay of an applied
// key answers `replayed`.
import {
  portMethods,
  type AnswerView,
  type Command,
  type Composed,
  type GoalView,
  type Outcome,
  type Page,
  type PortMethod,
  type QuestionView,
  type TaskView,
  type WorkspacePort,
} from "@morrow/workspace-ui";
import { createSeed, fixtureWorkspace, people } from "./seed";
import { scenarios, uncomposedIn, type ScenarioName } from "./scenarios";

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
      return new Promise((resolve) => setTimeout(() => resolve(outcome as Outcome<T>), delayMs));
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
  const ws = (id: string) => id === fixtureWorkspace.id;
  const task = (id: string) => seed.tasks.find((t) => t.id === id);
  const question = (id: string) => seed.questions.find((q) => q.id === id);
  const goal = (id: string) => seed.goals.find((g) => g.id === id);
  const at = () => new Date(Date.UTC(2026, 9, 16, 9, created)).toISOString();
  return {
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
              { workspaceId: fixtureWorkspace.id, displayName: fixtureWorkspace.displayName },
            ],
            truncated: false,
            onboarding: "unavailable" as const,
          }),
        ),
      createOrganization: (c) =>
        command("account.createOrganization", c, () => ok({ workspaceId: fixtureWorkspace.id })),
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
  };
}
