// Home (ADR-0032, the Sunrise Home board): "What needs me today, what happens next, and
// how is the shop doing?" Built on the data that exists today: what waits for you in the
// Inbox (v1 PR 15: the one Inbox read, so Home, the sidebar and the Inbox count the same
// items), recent work, and the store connection. Each card owns its
// denied, unavailable and empty states, so Home never fails as a whole. It carries the
// ADR-0015 pre-payment notice, which names no checkout or store route and so stays true
// on both billing routes. The board's other sections show only from fixtures, behind the
// default-off `samples.home` switch (home-samples.tsx). Home decides nothing: every link
// opens a screen whose actions the server checks.
import { useMemo } from "react";
import { copy } from "../copy";
import {
  inboxComplete,
  inboxCountLabel,
  inboxTab,
  openItems,
  type InboxView,
} from "../inbox-model";
import type { ConnectionsView, GoalView, HomeSamplesView, Id, WorkspaceView } from "../model";
import { useRead, useServices, type ReadState } from "../services";
import { primaryStore, useConnections, useHomeSamples, useInbox } from "../workspace-data";
import { RouteLink } from "../components/controls";
import { BadgeGlyph, Icon, RecordText, StatusTag, Tag } from "../components/display";
import { Banner, StateView, outcomeState } from "../components/feedback";
import { AskMorrowButton } from "../components/shell";
import { AskPanel, GlanceCard, IdeasCard, ProjectsCard, TodayCard } from "./home-samples";
import { InboxRow, PartNotice, needsYouItems, shopName } from "./inbox";
import { inboxCopy } from "../sunrise/inbox-copy";

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

/** The most recently updated first. */
export function byRecent(goals: readonly GoalView[]): GoalView[] {
  const at = (g: GoalView) => {
    const t = Date.parse(g.updatedAt);
    return Number.isNaN(t) ? 0 : t;
  };
  return [...goals].sort((a, b) => at(b) - at(a));
}

/**
 * What Home's header says. Nothing is "clear" unless every section of the Inbox read
 * answered: when a section was denied, or the read failed, was rate limited or offline,
 * the scope line stays neutral, no "all clear" primary is offered, and the Needs you card
 * carries that state. A false all-clear would hide work that waits (the AC26 first-run
 * Home is governance-only, so its questions are denied). Sample counts exist only in the
 * default-off preview.
 */
export function homeSummary(
  inbox: ReadState<InboxView>,
  samples: HomeSamplesView | null,
): {
  readonly action: "review" | "ask" | null;
  readonly total: string;
  readonly open: number;
  readonly clear: boolean;
} {
  if (inbox.kind === "loading") return { action: null, total: "0", open: 0, clear: false };
  const known = inbox.kind === "ok";
  const open = known ? openItems(inbox.value).length : 0;
  const extra = samples ? samples.waiting.review + samples.waiting.tasks : 0;
  const count = open + extra;
  const total = known && inbox.value.more ? `${count}+` : String(count);
  const clear = known && inboxComplete(inbox.value) && count === 0;
  return { action: count > 0 ? "review" : clear ? "ask" : null, total, open, clear };
}
/** Home's waiting chips, from the same read: per kind, the open items. */
export function homeChips(view: InboxView): {
  readonly review: number;
  readonly questions: number;
  readonly problems: number;
} {
  const open = openItems(view);
  const of = (tab: "review" | "questions" | "problems") =>
    open.filter((i) => inboxTab(i) === tab).length;
  return { review: of("review"), questions: of("questions"), problems: of("problems") };
}

function NeedsYouCard({
  ws,
  inbox,
  reload,
  connections,
}: {
  readonly ws: Id;
  readonly inbox: ReadState<InboxView>;
  readonly reload: () => void;
  readonly connections: ReadState<ConnectionsView>;
}) {
  const count = inbox.kind === "ok" ? openItems(inbox.value).length : 0;
  const shown = inbox.kind === "ok" ? needsYouItems(inbox.value) : [];
  // A section the server didn't answer for this person: never "nothing waits".
  const denied = inbox.kind === "ok" && !inboxComplete(inbox.value);
  return (
    <section className="card panel" data-card="needs" aria-labelledby="home-needs-title">
      <div className="card-head">
        <h2 id="home-needs-title">{copy.home.needsTitle}</h2>
        {count > 0 ? (
          <RouteLink route="inbox" params={{ workspaceId: ws }} className="card-link">
            {copy.home.seeAllInbox(inboxCountLabel(inbox.value))}
          </RouteLink>
        ) : null}
      </div>
      {inbox.kind === "ok" ? (
        <>
          <PartNotice view={inbox.value} />
          {shown.length ? (
            <ul className="row-list">
              {shown.map((item) => (
                <li key={item.kind + ":" + item.id}>
                  <InboxRow
                    ws={ws}
                    item={item}
                    shop={shopName(connections, "storeId" in item ? item.storeId : null)}
                  />
                </li>
              ))}
            </ul>
          ) : denied ? null : (
            <StateView kind="empty" compact message={copy.home.nothingWaiting} />
          )}
        </>
      ) : (
        outcomeState(inbox, reload, { compact: true })
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
  const [inbox, reloadInbox] = useInbox(ws);
  const [connections] = useConnections(ws);
  const samples = useHomeSamples(ws);
  const now = useMemo(() => new Date(), []);
  const header = homeHeader(now);
  const { action, total, clear } = homeSummary(inbox, samples);
  const waiting = action === "review";
  const chips =
    inbox.kind === "ok" ? homeChips(inbox.value) : { review: 0, questions: 0, problems: 0 };
  const review = chips.review + (samples ? samples.waiting.review : 0);
  return (
    <div className={samples ? "page home has-panel" : "page home"}>
      <div className="home-main">
        <header className="page-header">
          <p className="page-date">
            <time dateTime={isoDay(now)}>{header.date}</time>
          </p>
          <div className="title-row">
            <h1>{header.greeting}</h1>
            {action === "review" ? (
              <RouteLink
                route="inbox"
                params={{ workspaceId: ws }}
                className="button button-primary"
              >
                {copy.home.review(total)}
              </RouteLink>
            ) : action === "ask" ? (
              <AskMorrowButton workspaceId={ws} variant="primary" />
            ) : null}
          </div>
          <p className="scope-line" dir="auto">
            {clear
              ? copy.home.scopeClear(workspace.displayName)
              : copy.home.scope(workspace.displayName)}
          </p>
          {waiting ? (
            <div className="chips-row">
              <ul className="chips" aria-label={copy.home.waitingLabel}>
                {review > 0 ? (
                  <li>
                    <RouteLink route="inbox" params={{ workspaceId: ws }} className="chip">
                      <BadgeGlyph glyph="ring" />
                      {copy.home.reviewChip(review)}
                    </RouteLink>
                  </li>
                ) : null}
                {chips.questions > 0 ? (
                  <li>
                    <RouteLink route="inbox" params={{ workspaceId: ws }} className="chip">
                      <BadgeGlyph glyph="ring" />
                      {copy.home.questionsChip(String(chips.questions))}
                    </RouteLink>
                  </li>
                ) : null}
                {chips.problems > 0 ? (
                  <li>
                    <RouteLink route="inbox" params={{ workspaceId: ws }} className="chip">
                      <BadgeGlyph glyph="ring" />
                      {inboxCopy.home.problemsChip(chips.problems)}
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
        <NeedsYouCard ws={ws} inbox={inbox} reload={reloadInbox} connections={connections} />
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
