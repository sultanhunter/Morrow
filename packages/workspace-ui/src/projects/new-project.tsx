// New project: "Tell Morrow what you want to achieve" sends the person's request to a new
// Ask (Morrow drafts a card; nothing starts until a person taps Start), and "Set it up
// yourself" is the ordinary form, created as the person's own commands. Either opens only
// where the server's `actions` allow it, and the server checks again.
import { useId, useState, type FormEvent } from "react";
import { buildWorkspacePath, workspaceRoutes } from "@morrow/contracts/routes";
import type { Id } from "../model";
import { useCommand, useDirty, useServices } from "../services";
import { Button, Dialog, TextArea, TextField } from "../components/controls";
import { CommandFeedback } from "../screens/entry";
import { projectsCopy } from "./copy";
import { parseDay } from "./format";
import { useNavigateWhenClean } from "./hooks";

export const askTextLimit = 16384;
export const titleLimit = 120;
export const goalLimit = 2048;
const nulFree = (value: string) => !value.includes("\0");
/** A person's request: 1 to 16,384 characters with something besides spaces. */
export const validAsk = (text: string) =>
  text.trim() !== "" && text.length <= askTextLimit && nulFree(text);
export const validTitle = (title: string) =>
  title.trim() !== "" && title.length <= titleLimit && nulFree(title);
export const validGoal = (goal: string) =>
  goal.trim() !== "" && goal.length <= goalLimit && nulFree(goal);
/** The person's local today, `YYYY-MM-DD`. */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
/** An end date: a real day after today (the server checks again). */
export const validEnd = (day: string, today: string = localToday()) =>
  parseDay(day) !== null && day > today;

export function TellMorrowDialog({
  ws,
  open,
  onClose,
  starters,
  canAsk,
  canCreate,
  onSetUpYourself,
}: {
  readonly ws: Id;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly starters: readonly string[];
  readonly canAsk: boolean;
  readonly canCreate: boolean;
  readonly onSetUpYourself: () => void;
}) {
  const services = useServices();
  const c = projectsCopy.newProject;
  const [text, setText] = useState("");
  const [checked, setChecked] = useState(false);
  const askComposed = services.composed["plans.ask"] && canAsk;
  const command = useCommand<{ conversationId: Id | null; text: string }, { conversationId: Id }>(
    {
      marker: { workspaceId: ws, kind: "plan" },
      send: (cmd) => services.port.plans.ask(ws, cmd),
      onOutcome: (outcome, sent) => {
        if (outcome.kind !== "ok" || !sent.current) return;
        setText("");
        setChecked(false);
        navigate(
          buildWorkspacePath(workspaceRoutes, "ask_conversation", {
            workspaceId: ws,
            conversationId: outcome.value.conversationId,
          }),
        );
      },
    },
  );
  useDirty(open && (text !== "" || command.busy));
  const navigate = useNavigateWhenClean();
  const valid = validAsk(text);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (!valid || command.busy || !askComposed) return;
    void command.submit({ conversationId: null, text });
  };
  const close = () => {
    if (command.busy) return;
    command.reset();
    setChecked(false);
    onClose();
  };
  const formId = useId();
  return (
    <Dialog
      open={open}
      title={c.title}
      onClose={close}
      footer={
        <>
          {canCreate ? (
            <Button variant="quiet" onClick={onSetUpYourself} disabled={command.busy}>
              {c.yourself}
            </Button>
          ) : null}
          <Button onClick={close} disabled={command.busy}>
            {c.cancel}
          </Button>
          {askComposed ? (
            <Button type="submit" variant="primary" form={formId} disabled={command.busy}>
              {command.busy ? c.sending : c.send}
            </Button>
          ) : null}
        </>
      }
    >
      {askComposed ? (
        <form id={formId} onSubmit={submit} noValidate className="pj-form">
          <TextArea
            label={c.label}
            value={text}
            onChange={setText}
            error={checked && !valid ? c.invalid : null}
            disabled={command.busy}
            maxLength={askTextLimit}
            required
          />
          {starters.length ? (
            <div className="pj-chips" role="group" aria-label={c.try}>
              <span className="pj-meta">{c.try}</span>
              {starters.map((starter) => (
                <Button key={starter} onClick={() => setText(starter)} disabled={command.busy}>
                  <span dir="auto">{starter}</span>
                </Button>
              ))}
            </div>
          ) : null}
          <p className="muted">{c.how}</p>
          <p className="muted small">{c.privacy}</p>
          <CommandFeedback
            phase={command.phase}
            onCheckAgain={command.checkAgain}
            onRetry={command.retry}
          />
        </form>
      ) : (
        <div role="status" className="notice notice-info">
          <p>{c.askUnavailable}</p>
        </div>
      )}
    </Dialog>
  );
}

function DateField({
  label,
  value,
  onChange,
  hint,
  error,
  disabled,
  min,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint: string;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly min: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="date"
        value={value}
        min={min}
        disabled={disabled}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={[id + "-hint", error ? id + "-error" : null].filter(Boolean).join(" ")}
        onChange={(event) => onChange(event.target.value)}
      />
      <small id={id + "-hint"}>{hint}</small>
      {error ? (
        <p id={id + "-error"} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SetUpProjectDialog({
  ws,
  open,
  onClose,
  canAsk,
  onAskInstead,
}: {
  readonly ws: Id;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly canAsk: boolean;
  readonly onAskInstead: () => void;
}) {
  const services = useServices();
  const c = projectsCopy.setUp;
  const [title, setTitle] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [goal, setGoal] = useState("");
  const [checked, setChecked] = useState(false);
  const today = localToday();
  const command = useCommand<
    { title: string; endsOn: string; goal: string },
    { readonly projectId: Id }
  >({
    marker: { workspaceId: ws, kind: "project" },
    send: (cmd) => services.port.projects.create(ws, cmd),
    onOutcome: (outcome, sent) => {
      if (outcome.kind !== "ok" || !sent.current) return;
      setTitle("");
      setEndsOn("");
      setGoal("");
      setChecked(false);
      navigate(
        buildWorkspacePath(workspaceRoutes, "project", {
          workspaceId: ws,
          projectId: outcome.value.projectId,
        }),
      );
    },
  });
  useDirty(open && (title !== "" || endsOn !== "" || goal !== "" || command.busy));
  const navigate = useNavigateWhenClean();
  const valid = { title: validTitle(title), endsOn: validEnd(endsOn, today), goal: validGoal(goal) };
  const formId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (!valid.title || !valid.endsOn || !valid.goal || command.busy) return;
    void command.submit({ title, endsOn, goal });
  };
  const close = () => {
    if (command.busy) return;
    command.reset();
    setChecked(false);
    onClose();
  };
  return (
    <Dialog
      open={open}
      title={c.title}
      onClose={close}
      footer={
        <>
          {canAsk ? (
            <Button variant="quiet" onClick={onAskInstead} disabled={command.busy}>
              {c.askInstead}
            </Button>
          ) : null}
          <Button onClick={close} disabled={command.busy}>
            {projectsCopy.newProject.cancel}
          </Button>
          <Button type="submit" variant="primary" form={formId} disabled={command.busy}>
            {command.busy ? c.creating : c.create}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="pj-form">
        <TextField
          label={c.name}
          value={title}
          onChange={setTitle}
          hint={c.nameHint}
          error={checked && !valid.title ? c.invalidName : null}
          disabled={command.busy}
          maxLength={titleLimit}
          required
        />
        <DateField
          label={c.ends}
          value={endsOn}
          onChange={setEndsOn}
          hint={c.endsHint}
          error={checked && !valid.endsOn ? c.invalidDate : null}
          disabled={command.busy}
          min={today}
        />
        <TextArea
          label={c.goal}
          value={goal}
          onChange={setGoal}
          hint={c.goalHint}
          error={checked && !valid.goal ? c.invalidGoal : null}
          disabled={command.busy}
          maxLength={goalLimit}
          required
        />
        <p className="muted small">{c.note}</p>
        <CommandFeedback
          phase={command.phase}
          onCheckAgain={command.checkAgain}
          onRetry={command.retry}
          success={c.created}
        />
      </form>
    </Dialog>
  );
}
