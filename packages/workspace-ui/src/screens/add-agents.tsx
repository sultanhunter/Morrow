// T7 PR 16: Add agents (the AgentStore board): the agents Morrow offers, one agent's
// details, and adding it. Adding asks the server for the install document, shows exactly
// that document, and confirms it by its fingerprint and single-use value: the screen never
// writes the permission it shows (the build order's PR 16 safety tests). Shopify access an
// agent needs is asked for, never assumed; a teammate who shares that access reviews first.
import { useEffect, useId, useState } from "react";
import { Button, Dialog, RouteLink } from "../components/controls";
import { StateView, outcomeState } from "../components/feedback";
import type { Id, WorkspaceView } from "../model";
import { useCommand, useDirty, useRead, useServices } from "../services";
import {
  monthlyLimitRange,
  thinkingEfforts,
  thinkingModels,
  type AddDocumentView,
  type AddResultView,
  type AgentCategory,
  type CatalogueEntryView,
  type CatalogueView,
} from "../team-model";
import { AgentAvatar } from "../sunrise/avatars";
import { sunriseCopy } from "../sunrise/copy";
import {
  AgentPill,
  Badge,
  Banner,
  CanCannot,
  Card,
  PageHeader,
  PermissionList,
  SrIcon,
} from "../sunrise/parts";
import { choiceText, effortName, modelName } from "../sunrise/thinking";
import { CommandFeedback } from "./entry";

const c = sunriseCopy.add;
type Filter = "all" | AgentCategory;
const filters: readonly Filter[] = [
  "all",
  "product_pages",
  "sales",
  "stock",
  "customer_emails",
  "promotions",
];

function GalleryCard({
  workspaceId,
  entry,
  selected,
  current,
}: {
  readonly workspaceId: Id;
  readonly entry: CatalogueEntryView;
  readonly selected: boolean;
  /** The address names this agent (not only shown by default). */
  readonly current: boolean;
}) {
  return (
    <li>
      <RouteLink
        route="agent_listing"
        params={{ workspaceId, releaseId: entry.releaseId }}
        current={current}
        className={`sr-gallery-card${selected ? " is-selected" : ""}`}
      >
        <span className="sr-gallery-head">
          <AgentAvatar character={entry.character} size={56} />
          <span>
            <span className="sr-row-title sr-block">{entry.name}</span>
            <span className="sr-meta sr-block">{c.byMorrow}</span>
          </span>
        </span>
        <span className="sr-reading sr-block">{entry.summary}</span>
        <span className="sr-meta sr-block sr-with-icon">
          <SrIcon name="folder" size={16} />
          {entry.worksIn}
        </span>
        <span className="sr-gallery-foot">
          {entry.addedAs !== null ? (
            <Badge kind="added" />
          ) : entry.waitingReview ? (
            <Badge kind="waiting_review" />
          ) : (
            <span className="sr-link-text">{c.view}</span>
          )}
          <SrIcon name="chevronRight" size={18} />
        </span>
      </RouteLink>
    </li>
  );
}

/** The confirm dialog: exactly the document the server built, confirmed by its digest. */
function ConsentDialog({
  workspaceId,
  shopName,
  document,
  onClose,
  onDone,
}: {
  readonly workspaceId: Id;
  readonly shopName: string;
  readonly document: AddDocumentView;
  readonly onClose: () => void;
  readonly onDone: (result: AddResultView, document: AddDocumentView) => void;
}) {
  const services = useServices();
  const confirm = useCommand<{ documentDigest: string; nonce: string }, AddResultView>({
    marker: { workspaceId, kind: "add_agent" },
    send: (cmd) => services.port.team.addConfirm(workspaceId, document.releaseId, cmd),
    onOutcome: (outcome, sent) => {
      if (outcome.kind === "ok" && sent.current) onDone(outcome.value, document);
    },
  });
  const settled = confirm.phase.phase === "settled" ? confirm.phase.outcome : null;
  // A refused or stale document can't be confirmed again: the person starts over. (Nothing
  // ran on unavailable or rate_limited, so the same document may be sent again.)
  const spent =
    settled !== null &&
    ["denied", "not_found", "conflict", "invalid", "not_in_build"].includes(settled.kind);
  // While a confirmation (or its Check again) is in flight, the dialog stays: its reply
  // decides. Once the outcome is unknown the dialog may close: its "add_agent" marker stays,
  // and the shell says the agent may have been added.
  const inFlight =
    confirm.phase.phase === "sending" ||
    (confirm.phase.phase === "uncertain" && confirm.phase.checking);
  const close = () => {
    if (!inFlight) onClose();
  };
  return (
    <Dialog
      open
      title={c.dialogTitle(document.name, shopName)}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={inFlight}>
            {c.cancel}
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              void confirm.submit({
                documentDigest: document.documentDigest,
                nonce: document.nonce,
              })
            }
            disabled={confirm.busy || spent}
          >
            {confirm.busy
              ? c.adding
              : document.reviewer
                ? c.confirmReview(document.reviewer)
                : c.confirm}
          </Button>
        </>
      }
    >
      <div className="sr sr-dialog-body">
        <div className="sr-who">
          <AgentAvatar character={document.character} size={48} />
          <div className="sr-who-text">
            <p className="sr-who-name">
              {document.name}
              <AgentPill character={document.character} />
            </p>
            <p className="sr-meta" dir="auto">
              {c.byMorrow} · {document.summary}
            </p>
          </div>
        </div>
        <CanCannot
          can={document.willBeAbleTo}
          cannot={document.willNotBeAbleTo}
          canTitle={c.willBeAble(document.name)}
          cannotTitle={c.willNotBeAble(document.name)}
        />
        <dl className="sr-pairs">
          <div>
            <dt>{c.everydayWork}</dt>
            <dd dir="auto">{document.worksIn}</dd>
          </div>
          <div>
            <dt>{c.thinking}</dt>
            <dd>{choiceText(document.thinking)}</dd>
          </div>
          <div>
            <dt>{c.creditLimit}</dt>
            <dd>{c.creditLimitValue(document.monthlyCreditLimit)}</dd>
          </div>
          {document.shopifyAccess.length ? (
            <div>
              <dt>{c.access}</dt>
              <dd>
                <ul className="sr-bullets">
                  {document.shopifyAccess.map((item) => (
                    <li key={item} dir="auto">
                      {item}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
        </dl>
        <div className="sr-morrow-strip">
          <SrIcon name="info" />
          <p>
            {document.reviewer ? c.nextReview(document.reviewer) + " " : ""}
            {document.shopifyAccess.length ? c.nextShopify : ""}
          </p>
        </div>
        <p className="sr-help">{c.renewal}</p>
        <p className="sr-help">{c.exact}</p>
        <CommandFeedback
          phase={confirm.phase}
          onCheckAgain={() => void confirm.checkAgain()}
          onRetry={() => void confirm.retry()}
          messages={{ conflict: () => c.expired }}
        />
      </div>
    </Dialog>
  );
}

function Detail({
  workspaceId,
  view,
  entry,
  onAdded,
}: {
  readonly workspaceId: Id;
  readonly view: CatalogueView;
  readonly entry: CatalogueEntryView;
  readonly onAdded: (result: AddResultView, document: AddDocumentView) => void;
}) {
  const services = useServices();
  const ids = useId();
  const [model, setModel] = useState<string>(entry.startsOn.model);
  const [effort, setEffort] = useState<string>(entry.startsOn.effort);
  const [limit, setLimit] = useState(String(entry.defaultMonthlyLimit));
  const [document, setDocument] = useState<AddDocumentView | null>(null);
  useEffect(() => {
    setModel(entry.startsOn.model);
    setEffort(entry.startsOn.effort);
    setLimit(String(entry.defaultMonthlyLimit));
    setDocument(null);
  }, [entry.releaseId, entry.startsOn.model, entry.startsOn.effort, entry.defaultMonthlyLimit]);
  const limitValue = /^[1-9][0-9]{0,4}$/.test(limit) ? Number(limit) : null;
  const limitOk =
    limitValue !== null &&
    limitValue >= monthlyLimitRange.min &&
    limitValue <= monthlyLimitRange.max;
  const dirty =
    model !== entry.startsOn.model ||
    effort !== entry.startsOn.effort ||
    limit !== String(entry.defaultMonthlyLimit);
  const addable = entry.addedAs === null && !entry.waitingReview;
  // Once the agent is added, or sent to a teammate to review, nothing here is unsent.
  useDirty(dirty && addable);
  const prepare = useCommand<
    { model: string; effort: string; monthlyCreditLimit: number },
    AddDocumentView
  >({
    marker: null,
    send: (cmd) => services.port.team.addDocument(workspaceId, entry.releaseId, cmd),
    onOutcome: (outcome, sent) => {
      if (outcome.kind === "ok" && sent.current) setDocument(outcome.value);
    },
  });
  const head = (
    <div className="sr-detail-head">
      <AgentAvatar character={entry.character} size={64} />
      <div>
        <h2 className="sr-detail-title">
          {entry.name} <AgentPill character={entry.character} />
        </h2>
        <p className="sr-meta">{c.byMorrow}</p>
      </div>
    </div>
  );
  const action = !addable ? (
    entry.addedAs !== null ? (
      <div className="sr-stack">
        <Badge kind="added" />
        <RouteLink
          route="agent"
          params={{ workspaceId, installationId: entry.addedAs }}
          className="sr-button sr-button-secondary"
        >
          {c.openPage(entry.name)}
        </RouteLink>
      </div>
    ) : (
      <div className="sr-stack">
        <Badge kind="waiting_review" />
        {entry.reviewer ? <p className="sr-help">{c.reviewBody(entry.reviewer)}</p> : null}
      </div>
    )
  ) : view.canAdd ? (
    <div className="sr-stack">
      <Button variant="primary" type="submit" disabled={!limitOk || prepare.busy}>
        {prepare.busy ? c.preparing : c.addButton(entry.name)}
      </Button>
      <p className="sr-help">{entry.reviewer ? c.addNoteReview(entry.reviewer) : c.addNote}</p>
      <CommandFeedback
        phase={prepare.phase}
        onCheckAgain={() => void prepare.checkAgain()}
        onRetry={() => void prepare.retry()}
      />
    </div>
  ) : (
    <p className="sr-help sr-with-icon">
      <SrIcon name="lock" size={16} />
      {c.cannotAdd(view.ownerName)}
    </p>
  );
  return (
    <form
      className="sr-detail-pane"
      aria-labelledby={ids + "-title"}
      onSubmit={(event) => {
        event.preventDefault();
        if (!addable || !view.canAdd || !limitOk || limitValue === null) return;
        void prepare.submit({ model, effort, monthlyCreditLimit: limitValue });
      }}
    >
      <span id={ids + "-title"} className="visually-hidden">
        {entry.name}
      </span>
      {head}
      <p className="sr-reading" dir="auto">
        {entry.summary}
      </p>
      {action}
      <section className="sr-pane-section">
        <h3 className="sr-subheading">{c.whatItDoes}</h3>
        <ul className="sr-bullets">
          {entry.does.map((item) => (
            <li key={item} dir="auto">
              {item}
            </li>
          ))}
        </ul>
      </section>
      <section className="sr-pane-section">
        <h3 className="sr-subheading">{c.whereItWorks}</h3>
        <p className="sr-reading sr-with-icon" dir="auto">
          <SrIcon name="folder" size={18} />
          {entry.worksIn}
        </p>
      </section>
      <section className="sr-pane-section">
        <h3 className="sr-subheading">{c.when}</h3>
        <ul className="sr-icon-list">
          {entry.schedule.map((item) => (
            <li key={item}>
              <SrIcon name="calendar" size={18} />
              <span dir="auto">{item}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="sr-pane-section">
        <h3 className="sr-subheading">{c.allowed}</h3>
        <PermissionList permissions={entry.permissions} />
      </section>
      <section className="sr-pane-section">
        <h3 className="sr-subheading">{c.access}</h3>
        {entry.shopifyAccess.length ? (
          <ul className="sr-icon-list">
            {entry.shopifyAccess.map((item) => (
              <li key={item}>
                <SrIcon name="store" size={18} />
                <span dir="auto">{item}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sr-help">{c.noAccess}</p>
        )}
        {entry.accessNote ? <p className="sr-help">{entry.accessNote}</p> : null}
      </section>
      {addable && view.canAdd ? (
        <>
          <section className="sr-pane-section">
            <h3 className="sr-subheading">{c.thinking}</h3>
            <p className="sr-help">{c.startsOn(choiceText(entry.startsOn))}</p>
            <div className="sr-field">
              <label htmlFor={ids + "-model"}>{sunriseCopy.thinking.model}</label>
              <select
                id={ids + "-model"}
                className="sr-select"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {thinkingModels.map((key) => (
                  <option key={key} value={key}>
                    {`${modelName(key)} · ${sunriseCopy.models[key]!.about}`}
                  </option>
                ))}
              </select>
            </div>
            <fieldset className="sr-fieldset">
              <legend className="sr-label">{sunriseCopy.thinking.effort}</legend>
              <div className="sr-segmented">
                {thinkingEfforts.map((key) => (
                  <label key={key} className={`sr-segment${effort === key ? " is-checked" : ""}`}>
                    <input
                      type="radio"
                      className="sr-segment-input"
                      name={ids + "-effort"}
                      value={key}
                      checked={effort === key}
                      onChange={() => setEffort(key)}
                    />
                    {effortName(key)}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="sr-help">{c.thinkingNote}</p>
          </section>
          <section className="sr-pane-section">
            <h3 className="sr-subheading">{c.credits}</h3>
            <p className="sr-reading">{entry.usualCredits}</p>
            <div className="sr-field">
              <label htmlFor={ids + "-limit"}>{c.limit}</label>
              <span className="sr-suffix-field">
                <input
                  id={ids + "-limit"}
                  className="sr-input"
                  inputMode="numeric"
                  maxLength={5}
                  value={limit}
                  aria-invalid={limitOk ? undefined : true}
                  aria-describedby={
                    ids + "-limit-hint" + (limitOk ? "" : " " + ids + "-limit-error")
                  }
                  onChange={(event) => setLimit(event.target.value)}
                />
                <span className="sr-suffix" aria-hidden="true">
                  {c.limitSuffix}
                </span>
              </span>
              <p id={ids + "-limit-hint"} className="sr-help">
                {c.limitHint(entry.name, view.creditsLeft, view.creditsRenewOn)}
              </p>
              {limitOk ? null : (
                <p id={ids + "-limit-error"} className="sr-error">
                  {c.limitError(monthlyLimitRange.min, monthlyLimitRange.max)}
                </p>
              )}
            </div>
          </section>
        </>
      ) : null}
      {entry.example ? (
        <section className="sr-pane-section">
          <h3 className="sr-subheading">{c.example}</h3>
          <div className="sr-inner">
            <p className="sr-row-title">{entry.example.title}</p>
            <ul className="sr-bullets">
              {entry.example.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            <p className="sr-help">{c.exampleNote}</p>
          </div>
        </section>
      ) : null}
      {document ? (
        <ConsentDialog
          workspaceId={workspaceId}
          shopName={view.shopName}
          document={document}
          onClose={() => {
            setDocument(null);
            prepare.reset();
          }}
          onDone={(result, doc) => {
            setDocument(null);
            prepare.reset();
            onAdded(result, doc);
          }}
        />
      ) : null}
    </form>
  );
}

export function AddAgentsScreen({
  workspace,
  releaseId,
}: {
  readonly workspace: WorkspaceView;
  readonly releaseId: Id | null;
}) {
  const services = useServices();
  const ws = workspace.id;
  const [catalogue, reload] = useRead(`${ws}|team.catalogue`, () =>
    services.port.team.catalogue(ws),
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [result, setResult] = useState<{
    readonly status: AddResultView["status"];
    readonly name: string;
    readonly reviewer: string | null;
  } | null>(null);
  const header = (
    <PageHeader
      workspaceId={ws}
      parent={{ route: "agents", label: c.breadcrumb }}
      title={c.title}
      scope={c.intro}
    />
  );
  if (catalogue.kind !== "ok")
    return (
      <div className="sr">
        {header}
        {outcomeState(catalogue, reload)}
      </div>
    );
  const view = catalogue.value;
  const selected =
    (releaseId === null
      ? (view.entries.find((e) => e.addedAs === null) ?? view.entries[0])
      : view.entries.find((e) => e.releaseId === releaseId)) ?? null;
  const shown = view.entries.filter((e) => filter === "all" || e.category === filter);
  const yours = shown.filter((e) => e.addedAs !== null);
  const more = shown.filter((e) => e.addedAs === null);
  // An address that names an agent puts its details first (above the gallery once the
  // card wraps on a narrow screen, so they are what a phone shows first).
  const detailFirst = releaseId !== null;
  const detail = selected ? (
    <Detail
      key={selected.releaseId}
      workspaceId={ws}
      view={view}
      entry={selected}
      onAdded={(added, doc) => {
        setResult({ status: added.status, name: doc.name, reviewer: doc.reviewer });
        reload();
      }}
    />
  ) : (
    <div className="sr-detail-pane">
      <StateView kind="not_found" />
    </div>
  );
  return (
    <div className="sr">
      {header}
      <div className="sr-chips" role="group" aria-label={c.filterLabel}>
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            className="sr-chip"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {c.filters[f]}
          </button>
        ))}
      </div>
      {result ? (
        <Banner
          tone="success"
          title={
            result.status === "added"
              ? c.addedTitle(result.name)
              : c.reviewTitle(result.name, result.reviewer ?? "")
          }
          onDismiss={() => setResult(null)}
        >
          <p>{result.status === "added" ? c.addedBody : c.reviewBody(result.reviewer ?? "")}</p>
        </Banner>
      ) : null}
      <div className={`sr-card sr-split${detailFirst ? " is-detail-first" : ""}`}>
        {detailFirst ? detail : null}
        <div className="sr-gallery">
          {shown.length === 0 ? <p className="sr-help">{c.noMatch}</p> : null}
          {yours.length ? (
            <section aria-labelledby="add-yours">
              <h2 id="add-yours" className="sr-section-title">
                {c.yours}
              </h2>
              <p className="sr-help">{c.yoursIntro(view.shopName)}</p>
              <ul className="sr-gallery-grid">
                {yours.map((entry) => (
                  <GalleryCard
                    key={entry.releaseId}
                    workspaceId={ws}
                    entry={entry}
                    selected={entry.releaseId === selected?.releaseId}
                    current={entry.releaseId === releaseId}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {more.length ? (
            <section aria-labelledby="add-more">
              <h2 id="add-more" className="sr-section-title">
                {c.more}
              </h2>
              <p className="sr-help">{c.moreIntro}</p>
              <ul className="sr-gallery-grid">
                {more.map((entry) => (
                  <GalleryCard
                    key={entry.releaseId}
                    workspaceId={ws}
                    entry={entry}
                    selected={entry.releaseId === selected?.releaseId}
                    current={entry.releaseId === releaseId}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          <section className="sr-inner" aria-labelledby="add-how">
            <h2 id="add-how" className="sr-section-title">
              {c.how}
            </h2>
            <ol className="sr-steps">
              {c.steps.map((step, index) => (
                <li key={step.title}>
                  <span className="sr-step-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span>
                    <span className="sr-row-title sr-block">{step.title}</span>
                    <span className="sr-meta sr-block">{step.body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
        {detailFirst ? null : detail}
      </div>
      <p className="sr-footnote sr-centered">{c.footnote}</p>
    </div>
  );
}
