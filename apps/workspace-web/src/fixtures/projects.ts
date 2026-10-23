// The scripted fixture of the project screens (T7 PR 19). Scripted, not simulated: it
// models the replies T2 and T6's routes will give (a card creates nothing; a start
// document is issued for the digest held, consumed once, and refused when stale), so the
// screens can be seen and checked. It never calls fetch. Fixture code: reachable only
// from fixture-main.tsx.
import type {
  AskConversationView,
  AskMessageView,
  ChoiceAnswer,
  Command,
  Id,
  Outcome,
  PersonRef,
  PlanCardView,
  PlanEdits,
  PlanStartDocumentView,
  PlanStartResultView,
  PortMethod,
  ProjectDetailView,
  ProjectMessageView,
  ProjectRowView,
  ProjectsOverviewView,
  TaskView,
  WorkspacePort,
} from "@morrow/workspace-ui";
import {
  areaRows,
  datedRows,
  digestOf,
  endOn,
  endOptions,
  health,
  members,
  planChangeCard,
  productOptions,
  projectCard,
  projectDetails,
  quickTasksRow,
  repeatingView,
  starters,
  stockMessages,
  taskRows,
  toteMessages,
} from "./projects-data";

export interface ProjectsFixtureHooks {
  reply<T>(method: PortMethod, fallback: () => Outcome<T>): Promise<Outcome<T>>;
  command<T>(method: PortMethod, c: Command<unknown>, apply: () => Outcome<T>): Promise<Outcome<T>>;
  ws(id: string): boolean;
  /** The work API's tasks: the projects' tasks are added here, under their goal records. */
  readonly tasks: TaskView[];
  readonly owner: PersonRef;
  readonly editor: PersonRef;
}

const ok = <T>(value: T): Outcome<T> => ({ kind: "ok", value, replayed: false });
const notFound = { kind: "not_found" } as const;
const stale = { kind: "conflict", recheck: true, message: "" } as const;
const dayLabel = (day: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

interface AskState {
  readonly id: Id;
  readonly request: string;
  product: { readonly id: string; readonly label: string } | null;
  end: { readonly id: string; readonly label: string; readonly on: string } | null;
  revision: number;
  title: string | null;
  endsOn: string | null;
  dropGoals: readonly string[];
  dropSteps: readonly number[];
  started: Id | null;
}
interface DocumentState {
  readonly view: PlanStartDocumentView;
  readonly kind: "card" | "change" | "finish";
  readonly ref: Id;
  readonly keep: boolean;
  used: boolean;
}

export function createProjectsFixture(
  hooks: ProjectsFixtureHooks,
  options: { readonly teammate: boolean },
): Pick<WorkspacePort, "projects" | "plans"> {
  const { reply, command, ws } = hooks;
  const teammate = options.teammate;
  const asker = teammate ? members.leo : members.maya;
  const dated: ProjectRowView[] = datedRows.map((row) => ({ ...row }));
  const finished: ProjectsOverviewView["finished"][number][] = [];
  const details = projectDetails();
  // A teammate who may only read: the server's actions say so, and the screens hide.
  if (teammate)
    for (const [id, detail] of details)
      details.set(id, {
        ...detail,
        actions: {
          planNextSteps: false,
          stopSteps: false,
          finish: false,
          extend: false,
          post: false,
          mentionMorrow: false,
        },
      });
  const conversations = new Map<Id, ProjectMessageView[]>([
    ["project-tote", toteMessages()],
    ["area-stock", stockMessages()],
  ]);
  const asks = new Map<Id, AskState>([
    [
      "conv-sample",
      {
        id: "conv-sample",
        request: "I want to rank in AI chat bots for one of my products",
        product: { id: "linen-shirt", label: "Linen Shirt" },
        end: { id: "six-weeks", label: endOptions[0]!.label, on: "2026-12-04" },
        revision: 1,
        title: null,
        endsOn: null,
        dropGoals: [],
        dropSteps: [],
        started: null,
      },
    ],
  ]);
  const documents = new Map<string, DocumentState>();
  let counter = 0;

  // The projects' tasks, readable through the work API by their goal records.
  const goalOf = new Map<Id, Id>([
    ...dated.map((r) => [r.projectId, r.goalId] as const),
    ...areaRows.map((a) => [a.projectId, a.goalId] as const),
    [quickTasksRow.projectId, quickTasksRow.goalId],
  ]);
  const statusOf: Readonly<Record<string, string>> = {
    needs_you: "waiting_approval",
    to_do: "ready",
    working: "running",
    done_today: "succeeded",
  };
  for (const row of taskRows)
    hooks.tasks.push({
      id: row.taskId,
      goalId: goalOf.get(row.projectId) ?? null,
      objective: row.title,
      status: statusOf[row.bucket] ?? "ready",
      owner:
        row.owner.kind === "person"
          ? row.owner.name === "Leo Martin"
            ? hooks.editor
            : hooks.owner
          : { principalId: `prn-agent-${row.owner.name.length}a0c`, kind: "agent", label: null, isSelf: null },
      revision: 1,
      updatedAt: "2026-10-23T10:30:00.000Z",
    });

  const overview = (): ProjectsOverviewView => ({
    credits: { used: 798, allowance: 2000, left: 1202, renewsOn: "2026-11-01", askUsed: 124 },
    dated: dated.filter((r) => !finished.some((f) => f.projectId === r.projectId)),
    areas: areaRows,
    quickTasks: quickTasksRow,
    finished,
    counts: { openTasks: taskRows.filter((r) => r.bucket !== "done_today").length, repeating: 10 },
    starters,
    actions: { ask: true, create: !teammate, createTask: true },
  });

  // ---- Ask Morrow: the conversation is computed from what was asked and answered.
  const card = (ask: AskState): PlanCardView => {
    const product = ask.product?.label ?? "Linen Shirt";
    const endsOn = ask.endsOn ?? ask.end?.on ?? "2026-12-04";
    const view = projectCard({
      messageId: `msg-card-${ask.id}`,
      revision: ask.revision,
      product,
      endsOn,
      title: ask.title ?? `${product} in AI answers`,
      dayLabel: dayLabel(endsOn),
      dropGoals: ask.dropGoals,
      dropSteps: ask.dropSteps,
      teammate,
    });
    return ask.started
      ? {
          ...view,
          started: { projectId: ask.started, note: `Started by ${asker.name} · just now` },
        }
      : view;
  };
  const messagesOf = (ask: AskState): AskMessageView[] => {
    const list: AskMessageView[] = [
      { kind: "request", id: `${ask.id}-request`, author: asker, at: "10:30 am", text: ask.request },
      {
        kind: "reply",
        id: `${ask.id}-hello`,
        at: "10:30 am",
        text: "Happy to set this up. Two quick questions so the plan fits.",
      },
      {
        kind: "choice",
        id: `${ask.id}-product`,
        at: "10:30 am",
        position: "1 of 2",
        question: "Which product?",
        hint: null,
        options: productOptions,
        answered: ask.product?.label ?? null,
        canAnswer: true,
      },
    ];
    if (ask.product)
      list.push({
        kind: "choice",
        id: `${ask.id}-end`,
        at: "10:31 am",
        position: "2 of 2",
        question: "When should this end?",
        hint: "We check results then.",
        options: endOptions,
        answered: ask.end?.label ?? null,
        canAnswer: true,
      });
    if (ask.product && ask.end)
      list.push({
        kind: "plan",
        id: `${ask.id}-card`,
        at: "10:31 am",
        intro: `Here’s a plan. I can’t promise that AI assistants will name the ${ask.product.label}. No one can. What helps most is a page with complete, specific facts and clear answers to what shoppers ask, then checking every month. Nothing starts until you press Start project.`,
        card: card(ask),
      });
    return list;
  };
  const askView = (ask: AskState): AskConversationView => ({
    conversationId: ask.id,
    messages: messagesOf(ask),
    cost: "This conversation: about 2 credits",
    canPost: true,
  });
  const cardOwner = (messageId: Id) =>
    [...asks.values()].find((ask) => `msg-card-${ask.id}` === messageId) ?? null;
  const changeOwner = (messageId: Id) => {
    for (const [projectId, list] of conversations)
      for (const message of list)
        if (message.kind === "plan_change" && message.card.messageId === messageId)
          return { projectId, message };
    return null;
  };

  const issue = (
    kind: DocumentState["kind"],
    ref: Id,
    target: string,
    draftDigest: string | null,
    projectId: Id | null,
    keep = false,
  ): PlanStartDocumentView => {
    counter++;
    const view: PlanStartDocumentView = {
      documentDigest: digestOf(`document-${counter}-${ref}`),
      nonce: digestOf(`nonce-${counter}`).slice(0, 32),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      target,
      draftDigest,
      projectId,
    };
    documents.set(view.documentDigest, { view, kind, ref, keep, used: false });
    return view;
  };

  const startFromCard = (ask: AskState): PlanStartResultView => {
    const view = card(ask);
    counter++;
    const projectId = `project-new-${counter}`;
    const goalId = `goal-pj-new-${counter}`;
    const endsOn = view.endsOn ?? "2026-12-04";
    const row: ProjectRowView = {
      projectId,
      goalId,
      title: view.title,
      endsOn,
      note: "Started today",
      mainGoal: view.goals[0] ? { title: view.goals[0].title, value: view.goals[0].line } : null,
      moreGoals: view.goals.slice(1).map((g) => g.title),
      health: health("not_checked_yet"),
      members: [members.morrow, asker, members.listings, members.analyst],
      credits: { used: 0, planned: "About 60 to 100 planned" },
    };
    dated.push(row);
    goalOf.set(projectId, goalId);
    const detail: ProjectDetailView = {
      ...details.get("project-tote")!,
      projectId,
      goalId,
      revision: 1,
      title: view.title,
      endsOn,
      health: health("not_checked_yet"),
      scope: [
        "Started today",
        `Ends ${dayLabel(endsOn)}`,
        "First update Mon, Oct 26, 8:00 am",
        "Credits: 0 used, about 60 to 100 planned",
      ],
      sinceLastVisit: null,
      goals: view.goals.map((g) => ({
        key: g.key,
        title: g.title,
        measure: g.checks.length ? "checklist" : "manual",
        value: g.checks.length ? `${g.checks.filter((c) => c.done).length} of 12 facts` : null,
        target: g.line,
        start: null,
        source: g.source,
        health: health(g.checks.length ? "starting_point" : "not_checked_yet"),
        how: null,
        checks: g.checks,
        questions: g.checks.length ? [] : view.questions,
        rows: [],
        steps: [],
      })),
      plan: view.steps.map((s) => ({
        index: s.index,
        title: s.title,
        owner: s.owner,
        status: s.index === 1 ? "to_do" : "not_started",
        detail: s.when,
        repeats: s.repeats,
        taskId: null,
      })),
      credits: {
        used: 0,
        planned: "about 60 to 100",
        byHelper: [],
        balance: "You have 1,202 credits left until Nov 1.",
        note: null,
      },
      brief: {
        ...details.get("project-tote")!.brief!,
        byline: `Written by Morrow from ${asker.name}’s request · started by ${asker.name} · Oct 23, 2026`,
        questions: view.questions,
      },
      files: [],
      activity: [
        {
          at: "Just now",
          text: `${asker.name} started this project from Ask Morrow, with ${view.goals.length} goals and ${view.steps.length} steps.`,
        },
      ],
    };
    details.set(projectId, detail);
    conversations.set(projectId, [
      { kind: "line", id: `${projectId}-1`, at: "Just now", text: `${asker.name} started this project from Ask Morrow` },
      {
        kind: "message",
        id: `${projectId}-2`,
        author: asker,
        at: "10:30 am",
        text: ask.request,
        restricted: null,
        written: false,
      },
      {
        kind: "line",
        id: `${projectId}-3`,
        at: "Just now",
        text: "Next: check the AI channel (step 1) and start the check-up (step 2). Only Maya can start it.",
      },
    ]);
    ask.started = projectId;
    return {
      projectId,
      runs: [
        {
          step: "Check the page against the 5 buying questions",
          outcome: teammate ? "refused" : "admitted",
          note: teammate
            ? "Only Maya (Owner) can set up the check-up. She gets an Inbox item."
            : "Morrow is setting up the check-up card for you to start.",
        },
      ],
    };
  };

  const projects: WorkspacePort["projects"] = {
    overview: (id) => reply("projects.overview", () => (ws(id) ? ok(overview()) : notFound)),
    tasks: (id) => reply("projects.tasks", () => (ws(id) ? ok({ rows: taskRows }) : notFound)),
    repeating: (id) => reply("projects.repeating", () => (ws(id) ? ok(repeatingView) : notFound)),
    get: (id, projectId) =>
      reply("projects.get", () => {
        const detail = details.get(projectId);
        return ws(id) && detail ? ok(detail) : notFound;
      }),
    messages: (id, projectId) =>
      reply("projects.messages", () =>
        ws(id) && details.has(projectId)
          ? ok({ messages: [...(conversations.get(projectId) ?? [])] })
          : notFound,
      ),
    post: (id, projectId, c) =>
      command("projects.post", c, () => {
        const detail = details.get(projectId);
        if (!ws(id) || !detail) return notFound;
        if (!detail.actions.post) return { kind: "denied", message: "", reference: null };
        counter++;
        const list = conversations.get(projectId) ?? [];
        list.push({
          kind: "message",
          id: `${projectId}-post-${counter}`,
          author: asker,
          at: "Just now",
          text: c.body.mentionMorrow ? `@Morrow ${c.body.text}` : c.body.text,
          restricted: null,
          written: false,
        });
        if (c.body.mentionMorrow && detail.actions.mentionMorrow)
          list.push(planChangeCard(counter, projectId));
        conversations.set(projectId, list);
        return ok({ messageId: `${projectId}-post-${counter}` });
      }),
    planNextSteps: (id, projectId, c) =>
      command("projects.planNextSteps", c, () => {
        const detail = details.get(projectId);
        if (!ws(id) || !detail) return notFound;
        if (c.body.expectedRevision !== detail.revision) return stale;
        counter++;
        const list = conversations.get(projectId) ?? [];
        list.push({
          kind: "line",
          id: `${projectId}-ask-${counter}`,
          at: "Just now",
          text: `${asker.name} asked Morrow to plan next steps`,
        });
        list.push(planChangeCard(counter, projectId));
        conversations.set(projectId, list);
        return ok({ messageId: `${projectId}-ask-${counter}` });
      }),
    stopSteps: (id, projectId, c) =>
      command("projects.stopSteps", c, () => {
        const detail = details.get(projectId);
        if (!ws(id) || !detail) return notFound;
        if (c.body.expectedRevision !== detail.revision) return stale;
        const cancelled = detail.plan.filter(
          (s) => s.status === "to_do" || s.status === "not_started",
        ).length;
        const turnedOff =
          detail.repeating.filter((r) => r.status === "active").length +
          detail.plan.filter((s) => s.repeats).length;
        details.set(projectId, {
          ...detail,
          revision: detail.revision + 1,
          stopped: `Steps stopped by ${asker.name} · just now. Repeating tasks are off and steps that hadn’t started were cancelled. Changes waiting for approval stay in your Inbox.`,
          plan: detail.plan.map((s) =>
            s.repeats
              ? { ...s, status: "paused" }
              : s.status === "to_do" || s.status === "not_started"
                ? { ...s, status: "cancelled" }
                : s,
          ),
          repeating: detail.repeating.map((r) => (r.status === "active" ? { ...r, status: "off" } : r)),
          alerts: detail.alerts.map((r) => (r.status === "active" ? { ...r, status: "off" } : r)),
          actions: { ...detail.actions, stopSteps: false },
        });
        const list = conversations.get(projectId) ?? [];
        list.push({ kind: "line", id: `${projectId}-stop`, at: "Just now", text: `Steps stopped by ${asker.name}` });
        conversations.set(projectId, list);
        return ok({ turnedOff, cancelled });
      }),
    extend: (id, projectId, c) =>
      command("projects.extend", c, () => {
        const detail = details.get(projectId);
        if (!ws(id) || !detail) return notFound;
        if (c.body.expectedRevision !== detail.revision) return stale;
        if (detail.extendTo !== c.body.endsOn) return { kind: "invalid", field: "endsOn" };
        details.set(projectId, {
          ...detail,
          revision: detail.revision + 1,
          state: "active",
          endsOn: c.body.endsOn,
          extendTo: null,
          health: health("on_track"),
          scope: ["Started Sep 1", `Ends ${dayLabel(c.body.endsOn)}`, "Credits: 88 used, about 80 to 120 planned"],
          actions: { ...detail.actions, finish: false, extend: false },
        });
        const index = dated.findIndex((r) => r.projectId === projectId);
        if (index >= 0)
          dated[index] = { ...dated[index]!, endsOn: c.body.endsOn, note: null, health: health("on_track") };
        return ok({ revision: detail.revision + 1 });
      }),
    finishDocument: (id, projectId, c) =>
      command("projects.finishDocument", c, () => {
        const detail = details.get(projectId);
        if (!ws(id) || !detail) return notFound;
        if (c.body.expectedRevision !== detail.revision) return stale;
        if (!detail.actions.finish) return { kind: "denied", message: "", reference: null };
        return ok(issue("finish", projectId, "finish", null, projectId, c.body.keepRepeating));
      }),
    create: (id, c) =>
      command("projects.create", c, () => {
        if (!ws(id)) return notFound;
        if (teammate) return { kind: "denied", message: "", reference: null };
        counter++;
        const projectId = `project-own-${counter}`;
        const goalId = `goal-pj-own-${counter}`;
        const row: ProjectRowView = {
          projectId,
          goalId,
          title: c.body.title,
          endsOn: c.body.endsOn,
          note: "Started today",
          mainGoal: { title: c.body.goal, value: null },
          moreGoals: [],
          health: health("not_measured"),
          members: [members.morrow, asker],
          credits: { used: 0, planned: null },
        };
        dated.push(row);
        goalOf.set(projectId, goalId);
        details.set(projectId, {
          ...details.get("project-bfcm")!,
          projectId,
          goalId,
          revision: 1,
          title: c.body.title,
          endsOn: c.body.endsOn,
          health: health("not_measured"),
          scope: ["Started today", `Ends ${dayLabel(c.body.endsOn)}`, "Credits: 0 used"],
          goals: [
            {
              key: "goal_1",
              title: c.body.goal,
              measure: "none",
              value: null,
              target: null,
              start: null,
              source: "Add how it’s measured inside the project.",
              health: health("not_measured"),
              how: null,
              checks: [],
              questions: [],
              rows: [],
              steps: [],
            },
          ],
          plan: [],
          credits: null,
          brief: null,
          activity: [{ at: "Just now", text: `${asker.name} created this project.` }],
          members: [{ member: members.morrow, note: null }, { member: asker, note: null }],
        });
        return ok({ projectId });
      }),
  };

  const plans: WorkspacePort["plans"] = {
    ask: (id, c) =>
      command("plans.ask", c, () => {
        if (!ws(id)) return notFound;
        if (c.body.conversationId !== null) {
          const ask = asks.get(c.body.conversationId);
          return ask ? ok({ conversationId: ask.id }) : notFound;
        }
        counter++;
        const conversationId = `conv-new-${counter}`;
        asks.set(conversationId, {
          id: conversationId,
          request: c.body.text,
          product: null,
          end: null,
          revision: 1,
          title: null,
          endsOn: null,
          dropGoals: [],
          dropSteps: [],
          started: null,
        });
        return ok({ conversationId });
      }),
    conversation: (id, conversationId) =>
      reply("plans.conversation", () => {
        const ask = asks.get(conversationId);
        return ws(id) && ask ? ok(askView(ask)) : notFound;
      }),
    answer: (id, conversationId, c) =>
      command("plans.answer", c, () => {
        const ask = asks.get(conversationId);
        if (!ws(id) || !ask) return notFound;
        const answer: ChoiceAnswer = c.body.answer;
        const label =
          answer.kind === "option"
            ? [...productOptions, ...endOptions].find((o) => o.id === answer.optionId)?.label
            : answer.kind === "other"
              ? answer.text
              : "You decide";
        if (label === undefined) return { kind: "invalid", field: "answer" };
        if (c.body.messageId === `${ask.id}-product` && ask.product === null)
          ask.product = {
            id: answer.kind === "option" ? answer.optionId : "other",
            label: answer.kind === "option" ? label : answer.kind === "other" ? label : "Linen Shirt",
          };
        else if (c.body.messageId === `${ask.id}-end` && ask.product !== null && ask.end === null)
          ask.end = {
            id: answer.kind === "option" ? answer.optionId : "other",
            label,
            on: answer.kind === "option" ? (endOn[answer.optionId] ?? "2026-12-04") : "2026-12-04",
          };
        else return stale;
        return ok({ messageId: c.body.messageId });
      }),
    revise: (id, conversationId, c) =>
      command("plans.revise", c, () => {
        const ask = asks.get(conversationId);
        if (!ws(id) || !ask || `msg-card-${ask.id}` !== c.body.messageId) return notFound;
        if (ask.started !== null || card(ask).draftDigest !== c.body.draftDigest) return stale;
        const edits: PlanEdits = c.body.edits;
        ask.revision++;
        ask.title = edits.title;
        ask.endsOn = edits.endsOn;
        ask.dropGoals = edits.dropGoals;
        ask.dropSteps = edits.dropSteps;
        return ok({ draftDigest: card(ask).draftDigest, revision: ask.revision });
      }),
    startDocument: (id, c) =>
      command("plans.startDocument", c, () => {
        if (!ws(id)) return notFound;
        const ask = cardOwner(c.body.messageId);
        if (ask) {
          if (ask.started !== null || card(ask).draftDigest !== c.body.draftDigest) return stale;
          return ok(issue("card", ask.id, "project", c.body.draftDigest, null));
        }
        const change = changeOwner(c.body.messageId);
        if (change && change.message.kind === "plan_change") {
          if (change.message.card.started !== null || change.message.card.draftDigest !== c.body.draftDigest)
            return stale;
          return ok(issue("change", c.body.messageId, "plan_change", c.body.draftDigest, change.projectId));
        }
        return notFound;
      }),
    start: (id, c) =>
      command("plans.start", c, () => {
        if (!ws(id)) return notFound;
        const document = documents.get(c.body.documentDigest);
        if (!document || document.used || document.view.nonce !== c.body.nonce) return stale;
        if (Date.parse(document.view.expiresAt) <= Date.now()) return stale;
        document.used = true;
        if (document.kind === "card") {
          const ask = asks.get(document.ref);
          if (!ask || ask.started !== null) return stale;
          return ok(startFromCard(ask));
        }
        if (document.kind === "change") {
          const change = changeOwner(document.ref);
          if (!change || change.message.kind !== "plan_change") return stale;
          const list = conversations.get(change.projectId) ?? [];
          const index = list.indexOf(change.message);
          list[index] = {
            ...change.message,
            card: { ...change.message.card, started: { note: `Applied by ${asker.name} · just now` } },
          };
          list.push({
            kind: "line",
            id: `${change.projectId}-applied-${counter}`,
            at: "Just now",
            text: `Plan changed by ${asker.name}: step 6 is due Fri, Nov 6`,
          });
          const detail = details.get(change.projectId)!;
          details.set(change.projectId, {
            ...detail,
            revision: detail.revision + 1,
            plan: detail.plan.map((s) =>
              s.index === 6 ? { ...s, detail: "Due Fri, Nov 6 · the last page fact · from the check-up" } : s,
            ),
          });
          return ok({ projectId: change.projectId, runs: [] });
        }
        const detail = details.get(document.ref)!;
        const met = detail.goals.filter((g) => g.health.word === "done").length;
        details.set(document.ref, {
          ...detail,
          revision: detail.revision + 1,
          state: "finished",
          health: health("done"),
          scope: ["Started Sep 1", "Finished today", "Credits: 88 used, about 80 to 120 planned"],
          actions: { ...detail.actions, finish: false, extend: false, stopSteps: false, planNextSteps: false },
        });
        finished.push({
          projectId: detail.projectId,
          title: detail.title,
          finishedOn: "2026-10-23",
          goalsMet: met,
          goalsTotal: detail.goals.length,
          health: health("done"),
        });
        return ok({ projectId: detail.projectId, runs: [] });
      }),
  };
  return { projects, plans };
}
