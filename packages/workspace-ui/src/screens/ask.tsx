// M3 PR-2: Ask (/w/:ws/ask). A merchant asks the Listings agent to draft better listings:
// the request text, a linked store, up to 25 products (by product number until M2 PR-3
// brings the catalog picker), the listing fields, and a model and thinking effort from the
// catalogue (the workspace default, or an entry within the member's ceiling; credits per
// product and the run's product limit shown). Starting is three commands in order, each with
// its own key and the usual uncertain handling: the goal, the task (the request is its
// objective) and the run's admission on that task; then the task opens (on its Brief tab:
// task routes carry no tab; its Runs tab shows the run).
// Nothing is written unless a run could be admitted: while GET /models says drafting is not
// available the form is not shown, and only stores whose Listings agent is active (and not
// stopped or blocked) are offered. A refusal after the task was saved says so.
// The body names only a store id, product ids, field paths and opaque catalogue keys.
import { buildWorkspacePath, workspaceRoutes } from "@morrow/contracts/routes";
import { useId, useMemo, useRef, useState } from "react";
import { copy } from "../copy";
import type {
  Id,
  ListingsAgentView,
  ModelEntryView,
  RunAdmittedView,
  WorkspaceView,
} from "../model";
import type { Outcome } from "../port";
import { useCommand, useDirty, useRead, useServices } from "../services";
import { Button, TextArea } from "../components/controls";
import { outcomeState } from "../components/feedback";
import { CommandFeedback } from "./entry";
import { useConnections } from "../workspace-data";

const label = (key: string) => copy.models.labels[key] ?? key;
const entryKey = (e: { readonly model: string; readonly effort: string }) =>
  `${e.model}|${e.effort}`;
const fieldChoices = [
  { id: "title", fields: ["title"], label: copy.agents.fieldLabels.title! },
  {
    id: "descriptionHtml",
    fields: ["descriptionHtml"],
    label: copy.agents.fieldLabels.descriptionHtml!,
  },
  { id: "seo", fields: ["seo.description", "seo.title"], label: copy.ask.seoPair },
  { id: "tags", fields: ["tags"], label: copy.agents.fieldLabels.tags! },
] as const;

/** One product per line: a Shopify product number or product:<number>; null if any is invalid. */
export function parseProducts(text: string): readonly string[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const out: string[] = [];
  for (const line of lines) {
    const m = /^(?:product:)?([1-9][0-9]{0,19})$/.exec(line);
    if (!m) return null;
    const id = "product:" + m[1];
    if (out.includes(id)) return null;
    out.push(id);
  }
  return out;
}

/**
 * The stores a run can be admitted on: linked, and whose Listings agent is active, not
 * stopped and not blocked by a platform or connection stop (each store's status read).
 */
export function runnableStoreIds(agents: readonly ListingsAgentView[]): ReadonlySet<Id> {
  return new Set(
    agents
      .filter(
        (a) =>
          a.linked && !a.blocked && a.installation?.status === "active" && !a.installation.stopped,
      )
      .map((a) => a.storeId),
  );
}
/**
 * What Ask shows once its reads are in: the form only when a run could be admitted, so no
 * goal or task is written while drafting is unavailable or no store can run. A form whose
 * task is already saved stays, to report the admission's outcome.
 */
export function askGate(
  draftingAvailable: boolean,
  runnableStores: number,
  taskSaved: boolean,
): "form" | "unavailable" | "no_stores" {
  if (taskSaved) return "form";
  if (!draftingAvailable) return "unavailable";
  return runnableStores === 0 ? "no_stores" : "form";
}

type RunBody = {
  storeId: Id;
  products: readonly string[];
  fields: readonly string[];
  selection: { readonly model: string; readonly effort: string } | null;
};

export function AskScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const ids = { request: useId(), store: useId(), model: useId(), fields: useId() };
  // The shell's connections read: the sidebar's connection line and this list agree.
  const [connections, reloadConnections] = useConnections(ws);
  const [models, reloadModels] = useRead(`${ws}|models`, () => services.port.models.list(ws));
  const [request, setRequest] = useState("");
  const [storeId, setStoreId] = useState("");
  const [productsText, setProductsText] = useState("");
  const [chosen, setChosen] = useState<readonly string[]>(["descriptionHtml", "title"]);
  const [selection, setSelection] = useState("default");
  const [started, setStarted] = useState(false);
  const linked =
    connections.kind === "ok"
      ? connections.value.installations.filter((i) => i.status === "linked" && i.storeId !== null)
      : [];
  // Each linked store's Listings agent: only an active, unstopped, unblocked one can run.
  const [agents, reloadAgents] = useRead(
    connections.kind === "ok" ? `${ws}|ask-agents|${linked.map((s) => s.storeId).join(",")}` : null,
    async (): Promise<Outcome<readonly ListingsAgentView[]>> => {
      const outcomes = await Promise.all(
        linked.map((s) => services.port.agents.listingsStatus(ws, s.storeId ?? "")),
      );
      const views: ListingsAgentView[] = [];
      for (const o of outcomes) {
        if (o.kind === "ok") views.push(o.value);
        else if (o.kind !== "not_found" && o.kind !== "denied") return o;
      }
      return { kind: "ok", value: views, replayed: false };
    },
  );
  const runnable = runnableStoreIds(agents.kind === "ok" ? agents.value : []);
  const stores = linked.filter((s) => s.storeId !== null && runnable.has(s.storeId));
  const products = parseProducts(productsText);
  const fields = useMemo(
    () =>
      fieldChoices
        .filter((c) => chosen.includes(c.id))
        .flatMap((c) => c.fields)
        .sort(),
    [chosen],
  );
  const catalogue = models.kind === "ok" ? models.value : null;
  const entry: ModelEntryView | null = catalogue
    ? (catalogue.entries.find(
        (e) =>
          entryKey(e) ===
          (selection === "default" ? entryKey(catalogue.workspaceDefault) : selection),
      ) ?? null)
    : null;
  const count = products?.length ?? 0;
  const overLimit = entry !== null && count > entry.runProductLimit;
  const valid =
    request.trim() !== "" &&
    storeId !== "" &&
    products !== null &&
    count >= 1 &&
    count <= 25 &&
    fields.length >= 1 &&
    entry !== null &&
    !overLimit;
  useDirty(!started && (request !== "" || productsText !== ""));

  const openTask = (taskId: Id) =>
    services.navigate(buildWorkspacePath(workspaceRoutes, "task", { workspaceId: ws, taskId }));
  // The task the run is admitted on: a ref, so the admission sent right after the task's
  // reply names it before the next render; the state disables the request text.
  const taskRef = useRef<Id | null>(null);
  const [taskId, setTaskId] = useState<Id | null>(null);
  const run = useCommand<RunBody, RunAdmittedView>({
    marker: { workspaceId: ws, kind: "run" },
    send: (c) => services.port.runs.admit(ws, taskRef.current ?? "", c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok" && taskRef.current) {
        setStarted(true);
        openTask(taskRef.current);
      }
    },
  });
  const runBody = (): RunBody => ({
    storeId,
    products: products ?? [],
    fields,
    selection:
      selection === "default" || !entry ? null : { model: entry.model, effort: entry.effort },
  });
  const task = useCommand<{ goalId: Id; objective: string }, { readonly taskId: Id }>({
    marker: { workspaceId: ws, kind: "task" },
    send: (c) => services.port.work.createTask(ws, c),
    onOutcome: (outcome, sent) => {
      if (outcome.kind === "ok" && sent.current) {
        // The run's admission names the task the server just created.
        taskRef.current = outcome.value.taskId;
        setTaskId(outcome.value.taskId);
        void run.submit(runBody());
      }
    },
  });
  const goal = useCommand<
    { objective: string; criteria: readonly string[] },
    { readonly goalId: Id }
  >({
    marker: { workspaceId: ws, kind: "goal" },
    send: (c) => services.port.work.createGoal(ws, c),
    onOutcome: (outcome, sent) => {
      if (outcome.kind === "ok" && sent.current)
        void task.submit({ goalId: outcome.value.goalId, objective: request.trim() });
    },
  });
  const busy = goal.busy || task.busy || run.busy;
  const step =
    goal.phase.phase === "sending"
      ? copy.ask.stepGoal
      : task.phase.phase === "sending"
        ? copy.ask.stepTask
        : run.phase.phase === "sending"
          ? copy.ask.stepRun
          : null;

  return (
    <div className="page">
      <header className="page-header">
        <h1>{copy.ask.title}</h1>
      </header>
      <p>{copy.ask.intro}</p>
      {connections.kind !== "ok" ? (
        outcomeState(connections, reloadConnections)
      ) : models.kind !== "ok" ? (
        outcomeState(models, reloadModels)
      ) : !models.value.draftingAvailable && taskId === null ? (
        // askGate's "unavailable": no store status is needed to know nothing can run.
        <div role="status" className="notice notice-warning">
          <p>{copy.ask.unavailable}</p>
        </div>
      ) : agents.kind !== "ok" ? (
        outcomeState(agents, reloadAgents)
      ) : askGate(models.value.draftingAvailable, stores.length, taskId !== null) !== "form" ? (
        <p className="muted">{copy.ask.noStores}</p>
      ) : (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || busy) return;
            if (taskId !== null) void run.submit(runBody());
            else
              void goal.submit({ objective: request.trim(), criteria: [copy.ask.goalCriterion] });
          }}
        >
          <TextArea
            label={copy.ask.request}
            value={request}
            onChange={setRequest}
            hint={copy.ask.requestHint}
            maxLength={8192}
            disabled={busy || taskId !== null}
            required
          />
          <div className="field">
            <label htmlFor={ids.store}>{copy.ask.store}</label>
            <select
              id={ids.store}
              value={storeId}
              disabled={busy}
              onChange={(e) => setStoreId(e.target.value)}
            >
              <option value="">—</option>
              {stores.map((s) => (
                <option key={s.installationId} value={s.storeId ?? ""}>
                  {s.shopDomain}
                </option>
              ))}
            </select>
          </div>
          <TextArea
            label={copy.ask.products}
            value={productsText}
            onChange={setProductsText}
            hint={copy.ask.productsHint}
            {...(products === null ? { error: copy.ask.invalidProducts } : {})}
            maxLength={25 * 30}
            disabled={busy}
            required
          />
          <fieldset className="field" aria-describedby={ids.fields}>
            <legend>{copy.ask.fields}</legend>
            {fieldChoices.map((c) => (
              <label key={c.id} className="check">
                <input
                  type="checkbox"
                  checked={chosen.includes(c.id)}
                  disabled={busy}
                  onChange={(e) =>
                    setChosen((now) =>
                      e.target.checked ? [...now, c.id] : now.filter((x) => x !== c.id),
                    )
                  }
                />
                {c.label}
              </label>
            ))}
            <small id={ids.fields}>{copy.ask.fieldsHint}</small>
          </fieldset>
          <div className="field">
            <label htmlFor={ids.model}>{copy.ask.model}</label>
            <select
              id={ids.model}
              value={selection}
              disabled={busy}
              onChange={(e) => setSelection(e.target.value)}
            >
              <option value="default">
                {copy.ask.modelDefault(
                  `${label(models.value.workspaceDefault.model)} · ${label(models.value.workspaceDefault.effort)}`,
                )}
              </option>
              {models.value.entries.map((e) => (
                <option key={entryKey(e)} value={entryKey(e)} disabled={!e.allowedForMember}>
                  {`${label(e.model)} · ${label(e.effort)} · ${copy.models.credits(e.creditsPerProduct)} · ${copy.models.limit(e.runProductLimit)}${e.allowedForMember ? "" : ` (${copy.ask.modelNotAllowed})`}`}
                </option>
              ))}
            </select>
          </div>
          {entry && count > 0 ? (
            <p className="muted" role="status">
              {overLimit
                ? copy.ask.overLimit(entry.runProductLimit)
                : copy.ask.estimate(entry.creditsPerProduct * count, count)}
            </p>
          ) : null}
          <Button variant="primary" type="submit" disabled={!valid || busy || started}>
            {busy ? (step ?? copy.ask.starting) : copy.ask.submit}
          </Button>
          <CommandFeedback phase={goal.phase} onCheckAgain={goal.checkAgain} onRetry={goal.retry} />
          <CommandFeedback phase={task.phase} onCheckAgain={task.checkAgain} onRetry={task.retry} />
          <CommandFeedback
            phase={run.phase}
            onCheckAgain={run.checkAgain}
            onRetry={run.retry}
            success={copy.ask.started}
            messages={{
              unavailable: copy.ask.refusals.unavailable,
              invalid: copy.ask.refusals.invalid,
            }}
          />
          {taskId !== null && run.phase.phase === "settled" && run.phase.outcome.kind !== "ok" ? (
            <div role="status" className="notice">
              <p>{copy.ask.taskSaved}</p>
              <Button type="button" onClick={() => openTask(taskId)}>
                {copy.ask.openTask}
              </Button>
            </div>
          ) : null}
        </form>
      )}
    </div>
  );
}
