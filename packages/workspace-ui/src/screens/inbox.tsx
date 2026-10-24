// The Inbox (v1 PR 15; the Inbox, EmptyStates, MemberHome and Phone boards) and the question
// detail (P14.T01a §4.10). One read, GET /work/inbox, lists what waits for this person:
// changes to review, questions for them, changes Morrow couldn't confirm or didn't apply,
// and a store that isn't connected. The server filtered every item for this person; this
// screen decides nothing. It filters what it was given, counts the open items (the same
// count as Home and the sidebar, from the same read) and links each item to its own screen:
// a change to the review screen (which keeps its own approve controls), a question to its
// answer form, a problem to its exception screen, a connection to Shopify connection.
// Questions and other text are always shown as text. The kinds whose backend isn't built
// yet show only from fixtures behind the default-off `samples.inbox`.
// The question detail's answer form appears for anyone who can view an open question; the
// server decides, and its 403 or 409 is rendered.
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { copy } from "../copy";
import {
  byInboxUrgency,
  inboxComplete,
  inboxDate,
  inboxCountLabel,
  inboxTab,
  inboxTabCount,
  inboxTabs,
  openItems,
  type InboxItemView,
  type InboxSamplesView,
  type InboxTab,
  type InboxView,
} from "../inbox-model";
import type { ConnectionsView, Id, QuestionView, WorkspaceView } from "../model";
import { useCommand, useDirty, useRead, useServices, type ReadState } from "../services";
import { useConnections, useInbox, useInboxSamples } from "../workspace-data";
import { Button, RouteLink, TextArea } from "../components/controls";
import { AgentAvatar, AgentName } from "../components/avatars";
import { Icon, PersonLabel, RecordText, StatusTag, Tag, Time } from "../components/display";
import { Banner, StateView, StatusRegion, outcomeState } from "../components/feedback";
import { AskMorrowButton } from "../components/shell";
import { inboxCopy } from "../sunrise/inbox-copy";
import { CommandFeedback } from "./entry";

const t = inboxCopy;

/** The shop's domain for a store id, when the connections read named it. */
export function shopName(connections: ReadState<ConnectionsView>, storeId: Id | null): string {
  if (storeId === null || connections.kind !== "ok") return t.shopFallback;
  const found = connections.value.installations.find((i) => i.storeId === storeId);
  return found ? found.shopDomain : t.shopFallback;
}

/**
 * One Inbox item as a row that opens its own screen: the title, who or what it is about,
 * when, and a badge of a glyph and a word (never colour alone).
 */
export function InboxRow({
  ws,
  item,
  shop,
}: {
  readonly ws: Id;
  readonly item: InboxItemView;
  readonly shop: string;
}) {
  const row = (
    lead: ReactNode,
    title: ReactNode,
    sub: ReactNode,
    badge: ReactNode,
    route: string,
    params: Readonly<Record<string, string>>,
  ) => (
    <RouteLink route={route} params={{ workspaceId: ws, ...params }} className="row row-link">
      <span className="row-lead" aria-hidden="true">
        {lead}
      </span>
      <span className="row-text">
        {title}
        <span className="row-sub">{sub}</span>
      </span>
      {badge}
      <Icon name="forward" />
    </RouteLink>
  );
  switch (item.kind) {
    case "approval":
      return row(
        <AgentAvatar agent="listings" size={40} />,
        <span className="row-title">{t.approval.title(item.targetCount)}</span>,
        <>
          <AgentName agent="listings" />
          {" · "}
          {item.storeLinked ? t.approval.expires(inboxDate(item.expiresAt)) : t.approval.blocked}
        </>,
        item.storeLinked ? (
          <Tag tone="caution" glyph="ring">
            {t.approval.badge}
          </Tag>
        ) : (
          <Tag tone="neutral" glyph="minus">
            {t.approval.blockedBadge}
          </Tag>
        ),
        "review",
        { proposalId: item.proposalId },
      );
    case "question":
      return row(
        <Icon name="question" />,
        <RecordText className="row-title">{item.prompt}</RecordText>,
        t.question.sub(inboxDate(item.createdAt)),
        <Tag tone="caution" glyph="ring">
          {t.question.badge}
        </Tag>,
        "question",
        { questionId: item.id },
      );
    case "exception": {
      const uncertain = item.reason === "uncertain_operation";
      const reason =
        item.reasonCode !== null ? (copy.review.reasons[item.reasonCode] ?? null) : null;
      return row(
        <Icon name="store" />,
        <span className="row-title">
          {uncertain ? t.exception.uncertainTitle : t.exception.failedTitle}
        </span>,
        `${uncertain ? t.exception.uncertainSub : (reason ?? copy.status.operation.failed)} · ${t.exception.when(inboxDate(item.updatedAt))}`,
        uncertain ? (
          <Tag tone="warning" glyph="dots">
            {t.exception.uncertainBadge}
          </Tag>
        ) : (
          <Tag tone="neutral" glyph="minus">
            {t.exception.failedBadge}
          </Tag>
        ),
        "exception",
        { operationId: item.id },
      );
    }
    case "connection":
      return row(
        <Icon name="store" />,
        <span className="row-title" dir="auto">
          {t.connection[item.reason](shop)}
        </span>,
        t.connection.sub(inboxDate(item.since)),
        <Tag tone="caution" glyph="ring">
          {t.connection.badge}
        </Tag>,
        "connection",
        { connectionId: item.id },
      );
  }
}

/** The page's one banner: the store isn't connected, so its waiting changes can't apply. */
function ConnectionBanner({ ws, view }: { readonly ws: Id; readonly view: InboxView }) {
  const problem = view.items.find((i) => i.kind === "connection");
  if (!problem) return null;
  return (
    <Banner tone="warning" title={t.banner.title}>
      <p>{t.banner.body}</p>
      <RouteLink
        route="connection"
        params={{ workspaceId: ws, connectionId: problem.id }}
        className="text-link"
      >
        {t.banner.open}
      </RouteLink>
    </Banner>
  );
}

/** A section the server didn't answer for this person: never shown as "nothing waits". */
function PartNotice({ view }: { readonly view: InboxView }) {
  const missing = (Object.keys(view.sections) as (keyof InboxView["sections"])[]).filter(
    (k) => view.sections[k] !== "ok",
  );
  if (missing.length === 0) return null;
  return (
    <StateView
      kind="denied"
      title={t.partTitle}
      message={missing.map((k) => t.part[k]).join(" ")}
      compact
    />
  );
}

function Filters({
  view,
  filter,
  onFilter,
}: {
  readonly view: InboxView;
  readonly filter: InboxTab;
  readonly onFilter: (tab: InboxTab) => void;
}) {
  return (
    <ul className="inbox-filters" aria-label={t.filtersLabel}>
      {inboxTabs.map((tab) => {
        const n = inboxTabCount(view, tab);
        return (
          <li key={tab}>
            <button
              type="button"
              className="inbox-filter"
              aria-pressed={filter === tab}
              onClick={() => onFilter(tab)}
            >
              {t.tabs[tab]}
              {tab !== "all" || n > 0 ? (
                <span className="inbox-filter-count" aria-hidden="true">
                  {n}
                </span>
              ) : null}
              <span className="visually-hidden">{`, ${n}`}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The preview of kinds whose backend isn't built yet; every row says it is sample data. */
function SamplesCard({ samples }: { readonly samples: InboxSamplesView }) {
  const titleId = useId();
  return (
    <section className="card inbox-samples" aria-labelledby={titleId}>
      <div className="card-head">
        <h2 id={titleId}>{t.samples.title}</h2>
        <p className="card-caption">{t.samples.tag}</p>
      </div>
      <p className="sample-note">{t.samples.intro}</p>
      <ul className="row-list">
        {samples.items.map((s) => (
          <li key={s.id} className="row">
            {s.kind === "run_question" ? (
              <>
                <AgentAvatar agent={s.agent} size={40} />
                <span className="row-text">
                  <RecordText className="row-title">{s.prompt}</RecordText>
                  <span className="row-sub">
                    <AgentName agent={s.agent} name={t.samples.agents[s.agent]} />
                    {` · ${t.samples.choices(s.choices)}`}
                  </span>
                </span>
              </>
            ) : (
              <>
                <span className="row-lead" aria-hidden="true">
                  <Icon name="store" />
                </span>
                <span className="row-text">
                  <span className="row-title">{t.samples.reconnectTitle}</span>
                  <span className="row-sub">
                    {t.samples.reconnectSub(s.missingPermissions, s.stoppedAgents)}
                  </span>
                </span>
              </>
            )}
            <span className="nav-sample-tag">
              <span aria-hidden="true">{t.samples.tag}</span>
              <span className="visually-hidden">{t.samples.tagHidden}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InboxList({
  ws,
  view,
  connections,
}: {
  readonly ws: Id;
  readonly view: InboxView;
  readonly connections: ReadState<ConnectionsView>;
}) {
  const [filter, setFilter] = useState<InboxTab>("all");
  const shown = byInboxUrgency(
    view.items.filter((i) => filter === "all" || inboxTab(i) === filter),
  );
  const complete = inboxComplete(view);
  const nothing = view.items.length === 0;
  return (
    <>
      <PartNotice view={view} />
      <ConnectionBanner ws={ws} view={view} />
      <Filters view={view} filter={filter} onFilter={setFilter} />
      <p className="inbox-count-note">{t.countNote(inboxCountLabel(view))}</p>
      <section className="card inbox-card" aria-label={t.listLabel}>
        {shown.length ? (
          <ul className="row-list" data-testid="inbox-items">
            {shown.map((item) => (
              <li key={item.kind + ":" + item.id} data-kind={item.kind} data-open={item.open}>
                <InboxRow
                  ws={ws}
                  item={item}
                  shop={shopName(connections, "storeId" in item ? item.storeId : null)}
                />
              </li>
            ))}
          </ul>
        ) : nothing && complete ? (
          <div className="inbox-empty">
            <h2>{t.emptyTitle}</h2>
            <p>{t.emptyBody}</p>
            <AskMorrowButton workspaceId={ws} />
          </div>
        ) : !nothing ? (
          <div className="inbox-empty">
            <h2>{t.filterEmptyTitle}</h2>
            <p>{t.filterEmptyBody}</p>
            <Button onClick={() => setFilter("all")}>{t.showEverything}</Button>
          </div>
        ) : null}
      </section>
      {view.more ? <p className="inbox-count-note">{t.more}</p> : null}
    </>
  );
}

export function InboxScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const ws = workspace.id;
  const [inbox, reload] = useInbox(ws);
  const [connections] = useConnections(ws);
  const samples = useInboxSamples(ws);
  return (
    <div className="page inbox">
      <header className="page-header">
        <div className="title-row">
          <h1>{t.title}</h1>
        </div>
        <p className="scope-line">{t.intro}</p>
      </header>
      {inbox.kind === "ok" ? (
        <InboxList ws={ws} view={inbox.value} connections={connections} />
      ) : inbox.kind === "loading" ? (
        <StateView kind="loading" message={t.loading} />
      ) : inbox.kind === "unavailable" ? (
        <div role="alert" className="inbox-failed">
          <StateView
            kind={inbox.offline ? "offline" : "unavailable"}
            title={inbox.offline ? t.offlineTitle : t.failedTitle}
            message={inbox.offline ? t.offlineBody : t.failedBody}
            onRetry={reload}
          />
        </div>
      ) : (
        outcomeState(inbox, reload)
      )}
      {samples ? <SamplesCard samples={samples} /> : null}
    </div>
  );
}

/** Home's Needs you rows: the open items, most urgent first (the same read as the count). */
export function needsYouItems(view: InboxView, max = 3): readonly InboxItemView[] {
  return byInboxUrgency(openItems(view)).slice(0, max);
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

/**
 * The answer to an answered question. `compact` is the inline form in a task's question
 * list: no landmark and no heading (the row's Show answer button names it), so a page of
 * answered questions adds no unnamed regions and skips no heading level.
 */
export function Answer({
  ws,
  questionId,
  compact = false,
}: {
  readonly ws: Id;
  readonly questionId: Id;
  readonly compact?: boolean;
}) {
  const services = useServices();
  const titleId = useId();
  const [answer, reload] = useRead(`${ws}|answer|${questionId}`, () =>
    services.port.work.getAnswer(ws, questionId),
  );
  if (answer.kind !== "ok") return <>{outcomeState(answer, reload, { compact: true })}</>;
  // The answer's author is an opaque label, never "you" (§4.10).
  const body = (
    <>
      <RecordText as="p" className="reading">
        {answer.value.text}
      </RecordText>
      <p className="meta">
        <span>{copy.question.answeredBy}</span>
        <PersonLabel person={answer.value.answeredBy} />
        <Time value={answer.value.createdAt} />
      </p>
    </>
  );
  if (compact) return <div className="answer is-compact">{body}</div>;
  return (
    <section className="answer" aria-labelledby={titleId}>
      <h2 id={titleId}>{copy.question.answerTitle}</h2>
      {body}
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
