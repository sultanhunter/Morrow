// Home (ADR-0032, the Sunrise Home board): "What needs me today, what happens next, and
// how is the shop doing?" Built on the data that exists today: what waits for you in the
// Inbox (open questions), recent work, and the store connection. Each card owns its
// denied, unavailable and empty states, so Home never fails as a whole. It carries the
// ADR-0015 pre-payment notice, which names no checkout or store route and so stays true
// on both billing routes. The board's other sections show only from fixtures, behind the
// default-off `samples.home` switch (home-samples.tsx). Home decides nothing: every link
// opens a screen whose actions the server checks.
import { useMemo } from "react";
import { copy } from "../copy";
import type { GoalView, Id, QuestionView, WorkspaceView } from "../model";
import { useRead, useServices } from "../services";
import {
  primaryStore,
  useConnections,
  useHomeSamples,
  useOpenQuestions,
  waitingCount,
} from "../workspace-data";
import { RouteLink } from "../components/controls";
import { BadgeGlyph, Icon, RecordText, StatusTag, Tag } from "../components/display";
import { Banner, StateView, outcomeState } from "../components/feedback";
import { AskMorrowButton } from "../components/shell";
import { AskPanel, GlanceCard, IdeasCard, ProjectsCard, TodayCard } from "./home-samples";

const longDate = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const shortDate = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const dayMonth = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
/** A server time as the shop's admin shows dates ("Mon, Oct 26"); text if unparseable. */
export function homeDate(value: string, format: "weekday" | "plain" = "weekday"): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return (format === "weekday" ? shortDate : dayMonth).format(date);
}
/** The date line and greeting, from the viewer's own clock. */
export function homeHeader(now: Date): { readonly date: string; readonly greeting: string } {
  return { date: longDate.format(now), greeting: copy.home.greeting(now.getHours()) };
}
const isoDay = (now: Date) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** The most urgent first: the soonest expiry, then those that don't expire. */
export function byUrgency(questions: readonly QuestionView[]): QuestionView[] {
  const at = (q: QuestionView) => {
    const t = q.expiresAt === null ? Number.NaN : Date.parse(q.expiresAt);
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  return [...questions].sort((a, b) => at(a) - at(b));
}
/** The most recently updated first. */
export function byRecent(goals: readonly GoalView[]): GoalView[] {
  const at = (g: GoalView) => {
    const t = Date.parse(g.updatedAt);
    return Number.isNaN(t) ? 0 : t;
  };
  return [...goals].sort((a, b) => at(b) - at(a));
}

function NeedsYouCard({
  ws,
  questions,
  reload,
}: {
  readonly ws: Id;
  readonly questions: ReturnType<typeof useOpenQuestions>[0];
  readonly reload: () => void;
}) {
  const count = questions.kind === "ok" ? waitingCount(questions.value) : null;
  return (
    <section className="card panel" data-card="needs" aria-labelledby="home-needs-title">
      <div className="card-head">
        <h2 id="home-needs-title">{copy.home.needsTitle}</h2>
        {count !== null && count !== "0" ? (
          <RouteLink route="inbox" params={{ workspaceId: ws }} className="card-link">
            {copy.home.seeAllInbox(count)}
          </RouteLink>
        ) : null}
      </div>
      {questions.kind === "ok" ? (
        questions.value.items.length ? (
          <ul className="row-list">
            {byUrgency(questions.value.items)
              .slice(0, 3)
              .map((q) => (
                <li key={q.id}>
                  <RouteLink
                    route="question"
                    params={{ workspaceId: ws, questionId: q.id }}
                    className="row row-link"
                  >
                    <span className="row-lead" aria-hidden="true">
                      <Icon name="question" />
                    </span>
                    <span className="row-text">
                      <RecordText className="row-title">{q.prompt}</RecordText>
                      <span className="row-sub">
                        {q.expiresAt
                          ? `${copy.home.questionLine} · ${copy.home.expires(homeDate(q.expiresAt))}`
                          : copy.home.questionLine}
                      </span>
                    </span>
                    <Tag tone="caution" glyph="ring">
                      {copy.home.needsYou}
                    </Tag>
                    <Icon name="forward" />
                  </RouteLink>
                </li>
              ))}
          </ul>
        ) : (
          <StateView kind="empty" compact message={copy.home.nothingWaiting} />
        )
      ) : (
        outcomeState(questions, reload, { compact: true })
      )}
    </section>
  );
}

function RecentWorkCard({ ws }: { readonly ws: Id }) {
  const services = useServices();
  const [goals, reload] = useRead(`${ws}|goals|first`, () =>
    services.port.work.listGoals(ws, null),
  );
  return (
    <section className="card panel" data-card="work" aria-labelledby="home-work-title">
      <div className="card-head">
        <h2 id="home-work-title">{copy.home.recentTitle}</h2>
        <RouteLink route="work" params={{ workspaceId: ws }} className="card-link">
          {copy.home.seeAllProjects}
        </RouteLink>
      </div>
      {goals.kind === "ok" ? (
        goals.value.items.length ? (
          <ul className="row-list">
            {byRecent(goals.value.items)
              .slice(0, 5)
              .map((g) => (
                <li key={g.id} className="row">
                  <span className="row-text">
                    <RecordText className="row-title">{g.objective}</RecordText>
                    <span className="row-sub">
                      {copy.home.updated(homeDate(g.updatedAt, "plain"))}
                    </span>
                  </span>
                  <StatusTag family="goal" status={g.status} />
                </li>
              ))}
          </ul>
        ) : (
          <StateView kind="empty" compact message={copy.home.noWork} />
        )
      ) : (
        outcomeState(goals, reload, { compact: true })
      )}
    </section>
  );
}

function StoreCard({ ws }: { readonly ws: Id }) {
  const [connections, reload] = useConnections(ws);
  const store = connections.kind === "ok" ? primaryStore(connections.value) : null;
  return (
    <section className="card" data-card="store" aria-labelledby="home-store-title">
      <div className="card-head">
        <h2 id="home-store-title">{copy.home.storeTitle}</h2>
        {connections.kind === "ok" ? (
          store ? (
            <RouteLink
              route="connection"
              params={{ workspaceId: ws, connectionId: store.connectionId }}
              className="card-link"
            >
              {copy.home.storeOpen}
            </RouteLink>
          ) : (
            <RouteLink route="connections" params={{ workspaceId: ws }} className="card-link">
              {copy.home.storeConnect}
            </RouteLink>
          )
        ) : null}
      </div>
      {connections.kind === "ok" ? (
        store ? (
          <div className="row store-row">
            <span className="row-lead" aria-hidden="true">
              <Icon name="store" />
            </span>
            <span className="row-text">
              <span className="row-title" dir="auto">
                {store.shopDomain}
              </span>
            </span>
            <StatusTag family="installation" status={store.status} />
          </div>
        ) : (
          <StateView kind="empty" compact message={copy.home.noStore} />
        )
      ) : (
        outcomeState(connections, reload, { compact: true })
      )}
    </section>
  );
}

export function HomeScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const ws = workspace.id;
  const [questions, reloadQuestions] = useOpenQuestions(ws);
  const samples = useHomeSamples(ws);
  const now = useMemo(() => new Date(), []);
  const header = homeHeader(now);
  const open = questions.kind === "ok" ? questions.value.items.length : 0;
  const extra = samples ? samples.waiting.review + samples.waiting.tasks : 0;
  const total =
    questions.kind === "ok" && questions.value.next !== null ? "50+" : String(open + extra);
  const waiting = total !== "0";
  const settled = questions.kind !== "loading";
  return (
    <div className={samples ? "page home has-panel" : "page home"}>
      <div className="home-main">
        <header className="page-header">
          <p className="page-date">
            <time dateTime={isoDay(now)}>{header.date}</time>
          </p>
          <div className="title-row">
            <h1>{header.greeting}</h1>
            {!settled ? null : waiting ? (
              <RouteLink
                route="inbox"
                params={{ workspaceId: ws }}
                className="button button-primary"
              >
                {copy.home.review(total)}
              </RouteLink>
            ) : (
              <AskMorrowButton workspaceId={ws} variant="primary" />
            )}
          </div>
          <p className="scope-line" dir="auto">
            {settled && !waiting
              ? copy.home.scopeClear(workspace.displayName)
              : copy.home.scope(workspace.displayName)}
          </p>
          {waiting ? (
            <div className="chips-row">
              <ul className="chips" aria-label={copy.home.waitingLabel}>
                {samples && samples.waiting.review > 0 ? (
                  <li>
                    <RouteLink route="inbox" params={{ workspaceId: ws }} className="chip">
                      <BadgeGlyph glyph="ring" />
                      {copy.home.reviewChip(samples.waiting.review)}
                    </RouteLink>
                  </li>
                ) : null}
                {open > 0 && questions.kind === "ok" ? (
                  <li>
                    <RouteLink route="inbox" params={{ workspaceId: ws }} className="chip">
                      <BadgeGlyph glyph="ring" />
                      {copy.home.questionsChip(waitingCount(questions.value))}
                    </RouteLink>
                  </li>
                ) : null}
                {samples && samples.waiting.tasks > 0 ? (
                  <li>
                    <RouteLink route="inbox" params={{ workspaceId: ws }} className="chip">
                      <BadgeGlyph glyph="ring" />
                      {copy.home.tasksChip(samples.waiting.tasks)}
                    </RouteLink>
                  </li>
                ) : null}
              </ul>
              {samples && samples.waiting.alerts > 0 ? (
                <RouteLink route="inbox" params={{ workspaceId: ws }} className="chip chip-alert">
                  <BadgeGlyph glyph="alert" />
                  {copy.home.alertChip(samples.waiting.alerts)}
                </RouteLink>
              ) : null}
            </div>
          ) : null}
        </header>
        <Banner tone="info" title={copy.home.prepaymentTitle}>
          <p>{copy.home.prepayment}</p>
        </Banner>
        <NeedsYouCard ws={ws} questions={questions} reload={reloadQuestions} />
        {samples ? (
          <>
            <TodayCard samples={samples} />
            <ProjectsCard ws={ws} samples={samples} />
          </>
        ) : null}
        <RecentWorkCard ws={ws} />
        <StoreCard ws={ws} />
        {samples ? (
          <>
            <GlanceCard samples={samples} />
            <IdeasCard samples={samples} />
          </>
        ) : null}
        <p className="page-footer">{copy.home.footer}</p>
      </div>
      {samples ? <AskPanel ws={ws} samples={samples} /> : null}
    </div>
  );
}
