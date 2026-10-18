// Inbox and question detail (P14.T01a §4.10). The answer form appears for anyone who
// can view an open question; the server decides, and its 403 or 409 is rendered.
import { useCallback, useState, type FormEvent } from "react";
import { copy } from "../copy";
import type { Id, QuestionView, WorkspaceView } from "../model";
import { useCommand, useDirty, useRead, useServices } from "../services";
import { Button, RouteLink, TextArea } from "../components/controls";
import { PersonLabel, RecordText, StatusTag, Time } from "../components/display";
import { StateView, StatusRegion, outcomeState } from "../components/feedback";
import { CommandFeedback } from "./entry";
import { usePaged } from "./work";

export function InboxScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const loadPage = useCallback(
    (after: string | null) => services.port.work.listMyOpenQuestions(ws, after),
    [services, ws],
  );
  const paged = usePaged<QuestionView>(`${ws}|questions.mine`, loadPage);
  return (
    <div className="page">
      <header className="page-header">
        <h1>{copy.inbox.title}</h1>
      </header>
      <section className="panel" aria-labelledby="inbox-questions-title">
        <h2 id="inbox-questions-title">{copy.inbox.questionsTitle}</h2>
        {paged.first.kind !== "ok" ? (
          outcomeState(paged.first, paged.reload)
        ) : paged.items.length ? (
          <>
            <ul className="item-list">
              {paged.items.map((q) => (
                <li key={q.id} className="item">
                  <RouteLink
                    route="question"
                    params={{ workspaceId: ws, questionId: q.id }}
                    className="item-link"
                  >
                    <RecordText>{q.prompt}</RecordText>
                  </RouteLink>
                  <StatusTag family="question" status={q.status} />
                </li>
              ))}
            </ul>
            {paged.next !== null ? (
              <Button onClick={paged.loadMore} disabled={paged.loadingMore}>
                {copy.work.loadMore}
              </Button>
            ) : null}
          </>
        ) : (
          <StateView kind="empty" message={copy.inbox.noQuestions} />
        )}
      </section>
      <section className="panel" aria-labelledby="inbox-other-title">
        <h2 id="inbox-other-title">{copy.inbox.otherTitle}</h2>
        <StateView kind="not_in_build" compact />
      </section>
    </div>
  );
}

const answerLimit = 8192;
function AnswerForm({
  ws,
  question,
  onAnswered,
}: {
  readonly ws: Id;
  readonly question: QuestionView;
  readonly onAnswered: (sent: boolean) => void;
}) {
  const services = useServices();
  const [text, setText] = useState("");
  const [checked, setChecked] = useState(false);
  const command = useCommand<
    { text: string; expectedRevision: number },
    { readonly answerRevision: number }
  >({
    marker: { workspaceId: ws, kind: "answer" },
    send: (c) => services.port.work.answer(ws, question.id, c),
    onOutcome: (outcome) => {
      if (outcome.kind === "ok") {
        setText("");
        onAnswered(true);
      } else if (outcome.kind === "conflict" && outcome.recheck) onAnswered(false);
    },
  });
  useDirty(text !== "" || command.busy);
  const valid = text.trim() !== "" && text.length <= answerLimit && !text.includes("\0");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (!valid || command.busy) return;
    void command.submit({ text, expectedRevision: question.revision });
  };
  return (
    <form className="answer-form" onSubmit={submit} noValidate>
      <TextArea
        label={copy.question.answerLabel}
        value={text}
        onChange={setText}
        hint={copy.question.answerHint}
        error={checked && !valid ? copy.outcome.invalid : null}
        disabled={command.busy}
        maxLength={answerLimit}
        required
      />
      <p className="muted">{copy.question.answerNote}</p>
      <CommandFeedback
        phase={command.phase}
        onCheckAgain={command.checkAgain}
        onRetry={command.retry}
      />
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={command.busy}>
          {copy.question.send}
        </Button>
      </div>
    </form>
  );
}

function Answer({ ws, questionId }: { readonly ws: Id; readonly questionId: Id }) {
  const services = useServices();
  const [answer, reload] = useRead(`${ws}|answer|${questionId}`, () =>
    services.port.work.getAnswer(ws, questionId),
  );
  if (answer.kind !== "ok") return <>{outcomeState(answer, reload, { compact: true })}</>;
  return (
    <section className="answer" aria-labelledby="answer-title">
      <h2 id="answer-title">{copy.question.answerLabel}</h2>
      <RecordText as="p" className="reading">
        {answer.value.text}
      </RecordText>
      <p className="meta">
        <span>{copy.question.answeredBy}</span>
        <PersonLabel person={answer.value.answeredBy} />
        <Time value={answer.value.createdAt} />
      </p>
    </section>
  );
}

export function QuestionScreen({
  workspace,
  questionId,
}: {
  readonly workspace: WorkspaceView;
  readonly questionId: Id;
}) {
  const services = useServices();
  const ws = workspace.id;
  const [question, reload] = useRead(`${ws}|question|${questionId}`, () =>
    services.port.work.getQuestion(ws, questionId),
  );
  // Shown once, after the confirmed reply; the form itself unmounts once answered.
  const [confirmation, setConfirmation] = useState<string | null>(null);
  return (
    <div className="page">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <RouteLink route="inbox" params={{ workspaceId: ws }}>
          {copy.question.back}
        </RouteLink>
      </nav>
      <header className="page-header">
        <h1>{copy.question.title}</h1>
      </header>
      <StatusRegion message={confirmation} />
      {question.kind !== "ok" ? (
        outcomeState(question, reload)
      ) : (
        <article className="question">
          <RecordText as="p" className="reading">
            {question.value.prompt}
          </RecordText>
          <p className="meta">
            <StatusTag family="question" status={question.value.status} />
            {question.value.respondent ? <PersonLabel person={question.value.respondent} /> : null}
          </p>
          {question.value.status === "open" ? (
            <AnswerForm
              ws={ws}
              question={question.value}
              onAnswered={(sent) => {
                if (sent) setConfirmation(copy.question.sent);
                reload();
              }}
            />
          ) : question.value.status === "answered" ? (
            <Answer ws={ws} questionId={questionId} />
          ) : question.value.status === "cancelled" ? (
            <p>{copy.question.cancelled}</p>
          ) : question.value.status === "expired" ? (
            <p>{copy.question.expired}</p>
          ) : null}
        </article>
      )}
    </div>
  );
}
