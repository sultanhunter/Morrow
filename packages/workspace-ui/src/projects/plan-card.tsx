// Morrow's plan cards (ADR-0034): the project card in an Ask and the plan-change card in
// a project conversation. A card creates nothing; "Written by Morrow" says who wrote it,
// the taint sentence sits above Start when the server derived one, and Start is the
// person-bound plan start of exactly the revision shown. Edit makes a new revision with
// a new digest (the server keeps the original's taint), so a card is never changed in
// place. Every value, estimate and permission line on a card is code's, per viewer.
import { useId, useState, type FormEvent } from "react";
import { buildWorkspacePath, workspaceRoutes } from "@morrow/contracts/routes";
import type { Id } from "../model";
import { useCommand, useDirty, useServices } from "../services";
import { Button, Dialog, RouteLink, TextField } from "../components/controls";
import { CommandFeedback } from "../screens/entry";
import { projectsCopy } from "./copy";
import { formatDay } from "./format";
import type { PlanCardView, PlanChangeCardView, PlanEdits } from "./model";
import { validTitle, titleLimit } from "./new-project";
import { MemberName, WordBadge } from "./parts";
import { PlanStartButton, PlanStartFeedback, usePlanStart } from "./plan-start";

const c = projectsCopy.card;

function StartedNote({
  ws,
  projectId,
  note,
}: {
  readonly ws: Id;
  readonly projectId: Id | null;
  readonly note: string;
}) {
  return (
    <div className="pj-started">
      <WordBadge style={{ label: c.started, tone: "success", glyph: "check" }} />
      <span dir="auto">{note}</span>
      {projectId ? (
        <RouteLink route="project" params={{ workspaceId: ws, projectId }} className="text-link">
          {c.openProject}
        </RouteLink>
      ) : null}
    </div>
  );
}

export function PlanCard({
  ws,
  conversationId,
  card,
  onChanged,
}: {
  readonly ws: Id;
  readonly conversationId: Id;
  readonly card: PlanCardView;
  /** Re-read the conversation: the card changed, or a start was refused as stale. */
  readonly onChanged: () => void;
}) {
  const services = useServices();
  const headingId = useId();
  const planId = useId();
  const [showPlan, setShowPlan] = useState(false);
  const [checksOf, setChecksOf] = useState<string | null>(null);
  const [notNow, setNotNow] = useState(false);
  const [editing, setEditing] = useState(false);
  const flow = usePlanStart<{ messageId: Id; draftDigest: string }>({
    ws,
    request: (cmd) => services.port.plans.startDocument(ws, cmd),
    expected: { target: "project", draftDigest: card.draftDigest, projectId: null },
    onStarted: (result) =>
      services.navigate(
        buildWorkspacePath(workspaceRoutes, "project", {
          workspaceId: ws,
          projectId: result.projectId,
        }),
      ),
    onStale: onChanged,
  });
  const startable =
    card.started === null && card.canStart && services.composed["plans.startDocument"];
  return (
    <article className="pj-plan-card" aria-labelledby={headingId}>
      <p className="pj-eyebrow">{card.kind === "project" ? c.suggestsProject : c.suggestsChange}</p>
      <h3 id={headingId} dir="auto">
        {card.title}
      </h3>
      <p className="pj-meta" dir="auto">
        {card.scope}
      </p>
      {card.why ? <p dir="auto">{card.why}</p> : null}

      {card.goals.length ? (
        <>
          <h4>{c.goals}</h4>
          <ol className="pj-card-list">
            {card.goals.map((goal) => (
              <li key={goal.key}>
                <span dir="auto">
                  <strong>{goal.title}</strong> · {goal.line}
                </span>
                <span className="pj-meta" dir="auto">
                  {goal.source}
                </span>
                {goal.checks.length ? (
                  <>
                    <Button
                      variant="quiet"
                      aria-expanded={checksOf === goal.key}
                      onClick={() => setChecksOf(checksOf === goal.key ? null : goal.key)}
                    >
                      {c.whatsChecked}
                    </Button>
                    {checksOf === goal.key ? (
                      <ul className="pj-checks">
                        {goal.checks.map((check) => (
                          <li key={check.label} className={check.done ? "is-done" : ""}>
                            <span dir="auto">{check.label}</span>
                            <span className="pj-meta">
                              {check.done
                                ? projectsCopy.project.checkDone
                                : projectsCopy.project.checkNotYet}
                              {check.note ? ` · ${check.note}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {card.helpers.length ? (
        <>
          <h4>{c.who}</h4>
          <ul className="pj-card-list pj-helpers">
            {card.helpers.map((helper) => (
              <li key={helper.member.kind + helper.member.name}>
                <MemberName member={helper.member} />
                <span dir="auto">{helper.does}</span>
                {helper.note ? (
                  <span className="pj-meta" dir="auto">
                    {helper.note}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <dl className="pj-facts">
        {card.needsYou ? (
          <>
            <dt>{c.needsYou}</dt>
            <dd dir="auto">{card.needsYou}</dd>
          </>
        ) : null}
        {card.credits ? (
          <>
            <dt>{c.credits}</dt>
            <dd dir="auto">{card.credits}</dd>
          </>
        ) : null}
        {card.youllHear ? (
          <>
            <dt>{c.youllHear}</dt>
            <dd dir="auto">{card.youllHear}</dd>
          </>
        ) : null}
      </dl>
      {card.shortfall ? (
        <div role="status" className="notice notice-warning">
          <p dir="auto">{card.shortfall}</p>
        </div>
      ) : null}

      {card.steps.length || card.questions.length || card.cannotDo.length || card.related ? (
        <>
          <Button variant="quiet" aria-expanded={showPlan} aria-controls={planId} onClick={() => setShowPlan((s) => !s)}>
            {showPlan ? c.hidePlan : c.seePlan}
          </Button>
          <div id={planId} hidden={!showPlan} className="pj-full-plan">
            {card.steps.length ? (
              <>
                <h4>{c.plan}</h4>
                <ol className="pj-card-list">
                  {card.steps.map((step) => (
                    <li key={step.index}>
                      <span dir="auto">{step.title}</span>
                      <span className="pj-meta">
                        <MemberName member={step.owner} /> · <span dir="auto">{step.when}</span>
                        {step.repeats ? ` · ${projectsCopy.project.repeats}` : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
            {card.questions.length ? (
              <>
                <h4>{c.questions}</h4>
                <ol className="pj-card-list">
                  {card.questions.map((q) => (
                    <li key={q} dir="auto">
                      {q}
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
            {card.cannotDo.length ? (
              <>
                <h4>{c.cannotDo}</h4>
                <ul className="pj-card-list">
                  {card.cannotDo.map((line) => (
                    <li key={line} dir="auto">
                      {line}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {card.related ? (
              <>
                <h4>{c.related}</h4>
                <p dir="auto">{card.related}</p>
              </>
            ) : null}
          </div>
        </>
      ) : null}

      <p className="pj-meta" dir="auto">
        {card.visibility}
      </p>
      {card.tainted && card.started === null ? (
        <div role="status" className="notice notice-warning">
          <p dir="auto">{card.tainted}</p>
        </div>
      ) : null}

      {card.started ? (
        <StartedNote ws={ws} projectId={card.started.projectId} note={card.started.note} />
      ) : notNow ? (
        <div className="pj-card-actions">
          <p className="pj-meta">{c.notNowDone}</p>
          <Button onClick={() => setNotNow(false)}>{c.seePlan}</Button>
        </div>
      ) : (
        <>
          {!card.canStart && card.startNote ? (
            <p className="pj-meta" dir="auto">
              {card.startNote}
            </p>
          ) : null}
          <div className="pj-card-actions">
            <Button onClick={() => setNotNow(true)} disabled={flow.busy}>
              {c.notNow}
            </Button>
            {card.canEdit && services.composed["plans.revise"] ? (
              <Button onClick={() => setEditing(true)} disabled={flow.busy}>
                {c.edit}
              </Button>
            ) : null}
            {startable ? (
              <PlanStartButton
                label={card.kind === "project" ? c.start : c.startGeneric}
                flow={flow}
                onStart={() =>
                  flow.begin({ messageId: card.messageId, draftDigest: card.draftDigest })
                }
              />
            ) : null}
          </div>
          <PlanStartFeedback flow={flow} />
        </>
      )}
      {card.canEdit && services.composed["plans.revise"] ? (
        <EditPlanDialog
          ws={ws}
          conversationId={conversationId}
          card={card}
          open={editing}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      ) : null}
    </article>
  );
}

/** Closed edits: a name, an end date the card offers, and which goals and steps to keep. */
export function planEdits(
  card: PlanCardView,
  form: {
    readonly title: string;
    readonly endsOn: string | null;
    readonly keepGoals: readonly string[];
    readonly keepSteps: readonly number[];
  },
): PlanEdits {
  return {
    title: form.title,
    endsOn: card.endChoices.some((choice) => choice.on === form.endsOn) ? form.endsOn : card.endsOn,
    dropGoals: card.goals.map((g) => g.key).filter((key) => !form.keepGoals.includes(key)),
    dropSteps: card.steps.map((s) => s.index).filter((index) => !form.keepSteps.includes(index)),
  };
}

function EditPlanDialog({
  ws,
  conversationId,
  card,
  open,
  onClose,
  onSaved,
}: {
  readonly ws: Id;
  readonly conversationId: Id;
  readonly card: PlanCardView;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const services = useServices();
  const e = projectsCopy.editCard;
  const [title, setTitle] = useState(card.title);
  const [endsOn, setEndsOn] = useState<string | null>(card.endsOn);
  const [keepGoals, setKeepGoals] = useState<readonly string[]>(card.goals.map((g) => g.key));
  const [keepSteps, setKeepSteps] = useState<readonly number[]>(card.steps.map((s) => s.index));
  const [checked, setChecked] = useState(false);
  const formId = useId();
  const command = useCommand<
    { messageId: Id; draftDigest: string; edits: PlanEdits },
    { readonly draftDigest: string; readonly revision: number }
  >({
    marker: { workspaceId: ws, kind: "plan" },
    send: (cmd) => services.port.plans.revise(ws, conversationId, cmd),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") onSaved();
      else if (outcome.kind === "conflict" && outcome.recheck) onSaved();
    },
  });
  const edited =
    title !== card.title ||
    endsOn !== card.endsOn ||
    keepGoals.length !== card.goals.length ||
    keepSteps.length !== card.steps.length;
  useDirty(open && (edited || command.busy));
  const valid = {
    title: validTitle(title),
    goals: card.goals.length === 0 || keepGoals.length > 0,
    steps: card.steps.length === 0 || keepSteps.length > 0,
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (!valid.title || !valid.goals || !valid.steps || command.busy) return;
    void command.submit({
      messageId: card.messageId,
      draftDigest: card.draftDigest,
      edits: planEdits(card, { title, endsOn, keepGoals, keepSteps }),
    });
  };
  const close = () => {
    if (command.busy) return;
    command.reset();
    setTitle(card.title);
    setEndsOn(card.endsOn);
    setKeepGoals(card.goals.map((g) => g.key));
    setKeepSteps(card.steps.map((s) => s.index));
    setChecked(false);
    onClose();
  };
  const toggle = <T,>(list: readonly T[], value: T, on: boolean): readonly T[] =>
    on ? [...list, value] : list.filter((v) => v !== value);
  return (
    <Dialog
      open={open}
      title={e.title}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={command.busy}>
            {e.cancel}
          </Button>
          <Button type="submit" variant="primary" form={formId} disabled={command.busy}>
            {command.busy ? e.saving : e.save}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="pj-form">
        <p className="muted">{e.intro}</p>
        <TextField
          label={e.name}
          value={title}
          onChange={setTitle}
          error={checked && !valid.title ? e.invalidName : null}
          disabled={command.busy}
          maxLength={titleLimit}
          required
        />
        {card.endChoices.length ? (
          <fieldset className="pj-fieldset">
            <legend>{e.ends}</legend>
            {card.endChoices.map((choice) => {
              const id = `${formId}-end-${choice.on}`;
              return (
                <div key={choice.on} className="pj-check">
                  <input
                    id={id}
                    type="radio"
                    name={`${formId}-end`}
                    checked={endsOn === choice.on}
                    disabled={command.busy}
                    onChange={() => setEndsOn(choice.on)}
                  />
                  <label htmlFor={id}>
                    {formatDay(choice.on)}
                    {choice.recommended ? ` · ${e.recommended}` : ""}
                  </label>
                </div>
              );
            })}
            <p className="pj-meta">{e.endsHint}</p>
          </fieldset>
        ) : null}
        {card.goals.length ? (
          <fieldset className="pj-fieldset">
            <legend>{e.keepGoals}</legend>
            {card.goals.map((goal) => {
              const id = `${formId}-goal-${goal.key}`;
              return (
                <div key={goal.key} className="pj-check">
                  <input
                    id={id}
                    type="checkbox"
                    checked={keepGoals.includes(goal.key)}
                    disabled={command.busy}
                    onChange={(event) =>
                      setKeepGoals(toggle(keepGoals, goal.key, event.target.checked))
                    }
                  />
                  <label htmlFor={id} dir="auto">
                    {goal.title}
                  </label>
                </div>
              );
            })}
            {checked && !valid.goals ? <p className="field-error">{e.needsGoal}</p> : null}
          </fieldset>
        ) : null}
        {card.steps.length ? (
          <fieldset className="pj-fieldset">
            <legend>{e.keepSteps}</legend>
            {card.steps.map((step) => {
              const id = `${formId}-step-${step.index}`;
              return (
                <div key={step.index} className="pj-check">
                  <input
                    id={id}
                    type="checkbox"
                    checked={keepSteps.includes(step.index)}
                    disabled={command.busy}
                    onChange={(event) =>
                      setKeepSteps(toggle(keepSteps, step.index, event.target.checked))
                    }
                  />
                  <label htmlFor={id} dir="auto">
                    {step.title}
                  </label>
                </div>
              );
            })}
            {checked && !valid.steps ? <p className="field-error">{e.needsStep}</p> : null}
          </fieldset>
        ) : null}
        <CommandFeedback
          phase={command.phase}
          onCheckAgain={command.checkAgain}
          onRetry={command.retry}
          success={e.saved}
          messages={{ conflict: () => e.changed }}
        />
      </form>
    </Dialog>
  );
}

export function PlanChangeCard({
  ws,
  projectId,
  card,
  onChanged,
}: {
  readonly ws: Id;
  readonly projectId: Id;
  readonly card: PlanChangeCardView;
  readonly onChanged: () => void;
}) {
  const services = useServices();
  const headingId = useId();
  const [notNow, setNotNow] = useState(false);
  const flow = usePlanStart<{ messageId: Id; draftDigest: string }>({
    ws,
    request: (cmd) => services.port.plans.startDocument(ws, cmd),
    expected: { target: "plan_change", draftDigest: card.draftDigest, projectId },
    onStarted: onChanged,
    onStale: onChanged,
  });
  const startable =
    card.started === null && card.canStart && services.composed["plans.startDocument"];
  return (
    <article className="pj-plan-card pj-plan-change" aria-labelledby={headingId}>
      <p className="pj-eyebrow">{c.written}</p>
      <h3 id={headingId} dir="auto">
        {card.title}
      </h3>
      {card.intro ? <p dir="auto">{card.intro}</p> : null}
      <ul className="pj-card-list">
        {card.changes.map((change, index) => (
          <li key={`${index}-${change.title}`}>
            <span dir="auto">
              <strong>
                {Object.hasOwn(c.changeKinds, change.kind)
                  ? c.changeKinds[change.kind]
                  : change.kind}
                :
              </strong>{" "}
              {change.title}
            </span>
            {change.owner ? <MemberName member={change.owner} /> : null}
            {change.detail ? (
              <span className="pj-meta" dir="auto">
                {change.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {card.because ? (
        <p dir="auto">
          <strong>{c.because}</strong> {card.because}
        </p>
      ) : null}
      {card.credits ? (
        <p className="pj-meta" dir="auto">
          {card.credits}
        </p>
      ) : null}
      {card.tainted && card.started === null ? (
        <div role="status" className="notice notice-warning">
          <p dir="auto">{card.tainted}</p>
        </div>
      ) : null}
      {card.started ? (
        <StartedNote ws={ws} projectId={null} note={card.started.note} />
      ) : notNow ? (
        <p className="pj-meta">{c.notNowDone}</p>
      ) : (
        <>
          {!card.canStart && card.startNote ? (
            <p className="pj-meta" dir="auto">
              {card.startNote}
            </p>
          ) : null}
          <div className="pj-card-actions">
            <Button onClick={() => setNotNow(true)} disabled={flow.busy}>
              {c.notNow}
            </Button>
            {startable ? (
              <PlanStartButton
                label={c.apply}
                flow={flow}
                onStart={() =>
                  flow.begin({ messageId: card.messageId, draftDigest: card.draftDigest })
                }
              />
            ) : null}
          </div>
          <PlanStartFeedback flow={flow} />
        </>
      )}
    </article>
  );
}
