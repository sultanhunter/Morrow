// Ask Morrow with a plan card (route `ask_conversation`; ADR-0034 items 2, 4 and 7): the
// person's request, at most two tap-to-answer questions, then a card that creates nothing
// until the person who asked taps Start. The conversation is private to its owner; admins'
// reads are audited (ADR-0016 item 5). Each tapped answer starts a new run as the
// person's act, so it is a command with its own key.
import { useId, useState, type FormEvent } from "react";
import type { Id, WorkspaceView } from "../model";
import { useCommand, useDirty, useRead, useServices } from "../services";
import { Button, TextArea, TextField } from "../components/controls";
import { StateView, outcomeState } from "../components/feedback";
import { CommandFeedback } from "../screens/entry";
import { projectsCopy } from "./copy";
import type { AskMessageView, ChoiceAnswer } from "./model";
import { askTextLimit, validAsk } from "./new-project";
import { MemberName } from "./parts";
import { PlanCard } from "./plan-card";

const a = projectsCopy.ask;
const morrow = { kind: "morrow", name: "Morrow", role: null } as const;

function ChoiceQuestion({
  ws,
  conversationId,
  message,
  onAnswered,
}: {
  readonly ws: Id;
  readonly conversationId: Id;
  readonly message: Extract<AskMessageView, { kind: "choice" }>;
  readonly onAnswered: () => void;
}) {
  const services = useServices();
  const headingId = useId();
  const [other, setOther] = useState<string | null>(null);
  // Set when the person tries to send "Something else…": an empty answer says why.
  const [otherChecked, setOtherChecked] = useState(false);
  const command = useCommand<{ messageId: Id; answer: ChoiceAnswer }, { readonly messageId: Id }>({
    marker: { workspaceId: ws, kind: "plan" },
    send: (cmd) => services.port.plans.answer(ws, conversationId, cmd),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok" || (outcome.kind === "conflict" && outcome.recheck)) {
        setOther(null);
        setOtherChecked(false);
        onAnswered();
      }
    },
  });
  useDirty(other !== null && other !== "");
  const answer = (value: ChoiceAnswer) =>
    void command.submit({ messageId: message.id, answer: value });
  const otherValid = other !== null && validAsk(other) && other.length <= 2048;
  const submitOther = (event: FormEvent) => {
    event.preventDefault();
    setOtherChecked(true);
    if (!otherValid || command.busy || other === null) return;
    answer({ kind: "other", text: other });
  };
  return (
    <section className="pj-choice" aria-labelledby={headingId}>
      <p className="pj-meta">{message.position}</p>
      <h3 id={headingId} dir="auto">
        {message.question}
      </h3>
      {message.hint ? (
        <p className="pj-meta" dir="auto">
          {message.hint}
        </p>
      ) : null}
      {message.answered !== null ? (
        <p>
          {a.youSaid}: <strong dir="auto">{message.answered}</strong>
        </p>
      ) : message.canAnswer && services.composed["plans.answer"] ? (
        <>
          <ul className="pj-options">
            {message.options.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  className="pj-option"
                  disabled={command.busy}
                  onClick={() => answer({ kind: "option", optionId: option.id })}
                >
                  <span dir="auto" className="pj-option-label">
                    {option.label}
                  </span>
                  {option.detail ? (
                    <span dir="auto" className="pj-meta">
                      {option.detail}
                    </span>
                  ) : null}
                  {option.recommended ? <span className="pj-pill">{a.recommended}</span> : null}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className="pj-option"
                aria-expanded={other !== null}
                disabled={command.busy}
                onClick={() => {
                  setOtherChecked(false);
                  setOther(other === null ? "" : null);
                }}
              >
                <span className="pj-option-label">{a.somethingElse}</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="pj-option"
                disabled={command.busy}
                onClick={() => answer({ kind: "skip" })}
              >
                <span className="pj-option-label">{a.skip}</span>
              </button>
            </li>
          </ul>
          {other !== null ? (
            <form className="pj-other" onSubmit={submitOther} noValidate>
              <TextField
                label={a.otherLabel}
                value={other}
                onChange={setOther}
                error={otherChecked && !otherValid ? a.otherInvalid : null}
                disabled={command.busy}
                maxLength={2048}
                required
              />
              <Button type="submit" disabled={command.busy}>
                {a.send}
              </Button>
            </form>
          ) : null}
          <CommandFeedback
            phase={command.phase}
            onCheckAgain={command.checkAgain}
            onRetry={command.retry}
          />
        </>
      ) : null}
    </section>
  );
}

export function AskConversationScreen({
  workspace,
  conversationId,
}: {
  readonly workspace: WorkspaceView;
  readonly conversationId: Id;
}) {
  const services = useServices();
  const ws = workspace.id;
  const [conversation, reload] = useRead(`${ws}|plans.conversation|${conversationId}`, () =>
    services.port.plans.conversation(ws, conversationId),
  );
  const [text, setText] = useState("");
  const [checked, setChecked] = useState(false);
  const command = useCommand<{ conversationId: Id | null; text: string }, { conversationId: Id }>({
    marker: { workspaceId: ws, kind: "plan" },
    send: (cmd) => services.port.plans.ask(ws, cmd),
    onOutcome: (outcome, sent) => {
      if (outcome.kind !== "ok") return;
      if (sent.current) {
        setText("");
        setChecked(false);
      }
      reload();
    },
  });
  useDirty(text !== "" || command.busy);
  const valid = validAsk(text);
  const view = conversation.kind === "ok" ? conversation.value : null;
  const canPost = view !== null && view.canPost && services.composed["plans.ask"];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (!valid || command.busy || !canPost) return;
    void command.submit({ conversationId, text });
  };
  return (
    <div className="page pj-page pj-ask">
      <header className="page-header pj-header">
        <div>
          <h1>{a.title}</h1>
          <p className="muted">{a.privacy}</p>
        </div>
        <Button variant="quiet" onClick={reload}>
          {a.refresh}
        </Button>
      </header>
      {view === null ? (
        outcomeState(conversation, reload)
      ) : (
        <>
          <section className="pj-ask-thread" aria-labelledby="pj-ask-thread-title">
            <h2 id="pj-ask-thread-title" className="visually-hidden">
              {projectsCopy.conversation.title}
            </h2>
            {view.messages.length ? (
              <ol className="pj-messages">
                {view.messages.map((message) => {
                  switch (message.kind) {
                    case "request":
                      return (
                        <li key={message.id} className="pj-message pj-message-request">
                          <p className="pj-message-head">
                            <MemberName member={message.author} />
                            <span className="pj-meta">{message.at}</span>
                          </p>
                          <p dir="auto" className="pj-message-text">
                            {message.text}
                          </p>
                        </li>
                      );
                    case "working":
                      return (
                        <li key={message.id} className="pj-message">
                          <p className="pj-message-head">
                            <MemberName member={morrow} />
                          </p>
                          <p role="status" dir="auto">
                            {message.text}
                          </p>
                        </li>
                      );
                    case "choice":
                      return (
                        <li key={message.id} className="pj-message">
                          <p className="pj-message-head">
                            <MemberName member={morrow} />
                            <span className="pj-meta">{message.at}</span>
                          </p>
                          <ChoiceQuestion
                            ws={ws}
                            conversationId={conversationId}
                            message={message}
                            onAnswered={reload}
                          />
                        </li>
                      );
                    case "plan":
                      return (
                        <li key={message.id} className="pj-message">
                          <p className="pj-message-head">
                            <MemberName member={morrow} />
                            <span className="pj-meta">{message.at}</span>
                          </p>
                          {message.intro ? (
                            <p dir="auto" className="pj-message-text">
                              {message.intro}
                            </p>
                          ) : null}
                          <p className="pj-meta">{projectsCopy.card.written}</p>
                          <PlanCard
                            ws={ws}
                            conversationId={conversationId}
                            card={message.card}
                            onChanged={reload}
                          />
                        </li>
                      );
                    default:
                      return (
                        <li key={message.id} className="pj-message">
                          <p className="pj-message-head">
                            <MemberName member={morrow} />
                            <span className="pj-meta">{message.at}</span>
                          </p>
                          <p dir="auto" className="pj-message-text">
                            {message.text}
                          </p>
                          <p className="pj-meta">{projectsCopy.card.written}</p>
                        </li>
                      );
                  }
                })}
              </ol>
            ) : (
              <StateView kind="empty" compact message={projectsCopy.conversation.empty} />
            )}
          </section>
          {canPost ? (
            <form className="pj-composer" onSubmit={submit} noValidate>
              <TextArea
                label={a.messageLabel}
                value={text}
                onChange={setText}
                error={checked && !valid ? a.invalid : null}
                disabled={command.busy}
                maxLength={askTextLimit}
                required
              />
              <CommandFeedback
                phase={command.phase}
                onCheckAgain={command.checkAgain}
                onRetry={command.retry}
              />
              <div className="pj-composer-actions">
                {view.cost ? (
                  <p className="pj-meta" dir="auto">
                    {view.cost}
                  </p>
                ) : null}
                <Button type="submit" variant="primary" disabled={command.busy}>
                  {command.busy ? a.sending : projectsCopy.conversation.send}
                </Button>
              </div>
            </form>
          ) : (
            <p className="pj-meta">{a.cannotPost}</p>
          )}
        </>
      )}
    </div>
  );
}
