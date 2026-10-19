// Home (P14.T01a §4.10): each panel owns its denied, unavailable and empty states, so
// Home never fails as a whole. It carries the ADR-0015 pre-payment notice, which names
// no checkout or store route and so stays true on both billing routes.
import { copy } from "../copy";
import type { WorkspaceView } from "../model";
import { useRead, useServices } from "../services";
import { RouteLink } from "../components/controls";
import { RecordText, StatusTag } from "../components/display";
import { StateView, outcomeState } from "../components/feedback";

export function HomeScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const [questions, reloadQuestions] = useRead(`${ws}|questions.mine|first`, () =>
    services.port.work.listMyOpenQuestions(ws, null),
  );
  const [goals, reloadGoals] = useRead(`${ws}|goals|first`, () =>
    services.port.work.listGoals(ws, null),
  );
  const count =
    questions.kind === "ok"
      ? questions.value.next !== null
        ? "50+"
        : String(questions.value.items.length)
      : null;
  return (
    <div className="page">
      <header className="page-header">
        <h1 dir="auto">{workspace.displayName}</h1>
      </header>
      <section className="notice notice-info" aria-labelledby="prepayment-title">
        <h2 id="prepayment-title" className="notice-title">
          {copy.home.prepaymentTitle}
        </h2>
        <p>{copy.home.prepayment}</p>
      </section>
      <div className="panels">
        <section className="panel" aria-labelledby="home-questions-title">
          <div className="panel-head">
            <h2 id="home-questions-title">{copy.home.questionsTitle}</h2>
            {count !== null && count !== "0" ? (
              <span className="tag tag-warning">{copy.home.questionsCount(count)}</span>
            ) : null}
          </div>
          {questions.kind === "ok" ? (
            questions.value.items.length ? (
              <ul className="item-list">
                {questions.value.items.slice(0, 5).map((q) => (
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
            ) : (
              <StateView kind="empty" compact message={copy.home.noQuestions} />
            )
          ) : (
            outcomeState(questions, reloadQuestions, { compact: true })
          )}
          <RouteLink route="inbox" params={{ workspaceId: ws }} className="text-link">
            {copy.home.goToInbox}
          </RouteLink>
        </section>
        <section className="panel" aria-labelledby="home-goals-title">
          <div className="panel-head">
            <h2 id="home-goals-title">{copy.home.goalsTitle}</h2>
          </div>
          {goals.kind === "ok" ? (
            goals.value.items.length ? (
              <ul className="item-list">
                {goals.value.items.slice(0, 5).map((g) => (
                  <li key={g.id} className="item">
                    <RecordText>{g.objective}</RecordText>
                    <StatusTag family="goal" status={g.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <StateView kind="empty" compact message={copy.home.noGoals} />
            )
          ) : (
            outcomeState(goals, reloadGoals, { compact: true })
          )}
          <RouteLink route="work" params={{ workspaceId: ws }} className="text-link">
            {copy.home.goToWork}
          </RouteLink>
        </section>
      </div>
    </div>
  );
}
