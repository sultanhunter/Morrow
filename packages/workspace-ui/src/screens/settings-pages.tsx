// T7 PR 16: Settings (the PlanCredits and EmailAddresses boards): the Settings home, Plan
// and credits, Email addresses and People and roles, each beside the Settings menu. They
// show; they change nothing: limits, the plan, the sender name and the support address
// change only through their own backends (T13, T11), and linking a mailbox is "Coming soon"
// (ADR-0030 item 10). Fixture data only in this build.
import { useState, type ReactNode } from "react";
import { RouteLink } from "../components/controls";
import { Icon } from "../components/display";
import { settingsItems, type SettingsPage as SettingsPageId } from "../components/settings-frame";
import { StatusRegion, outcomeState } from "../components/feedback";
import type { WorkspaceView } from "../model";
import { useRead, useServices } from "../services";
import type { EmailAddressesView, PlanView } from "../team-model";
import { AgentAvatar } from "../sunrise/avatars";
import { number, sunriseCopy } from "../sunrise/copy";
import {
  AgentPill,
  Badge,
  Card,
  ComingSoon,
  PageHeader,
  Progress,
  SrIcon,
  SrTabs,
} from "../sunrise/parts";
import { ThinkingSummary } from "../sunrise/thinking";
import { PersonRow } from "./team";

const s = sunriseCopy.settings;

/**
 * A settings page's header and body. The app puts every settings page inside the shell's
 * Settings frame (its menu); the home has no parent.
 */
export function SettingsPage({
  workspaceId,
  current,
  title,
  scope,
  actions,
  children,
}: {
  readonly workspaceId: string;
  readonly current: SettingsPageId | null;
  readonly title?: string;
  readonly scope?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="sr">
      {title ? (
        <PageHeader
          workspaceId={workspaceId}
          parent={current === null ? undefined : { route: "settings", label: s.title }}
          title={title}
          scope={scope}
          actions={actions}
        />
      ) : null}
      <div className="sr-settings-content">{children}</div>
    </div>
  );
}

export function SettingsHomeScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const ws = workspace.id;
  return (
    <SettingsPage
      workspaceId={ws}
      current={null}
      title={s.title}
      scope={s.intro(workspace.displayName)}
    >
      <Card title={s.title} flush>
        <ul className="sr-rows">
          {settingsItems.map((item) => (
            <li key={item.key}>
              <RouteLink
                route={item.route}
                params={
                  item.route === "connections"
                    ? { workspaceId: ws }
                    : { workspaceId: ws, section: item.key }
                }
                className="sr-list-row sr-list-link"
              >
                <Icon name={item.icon} />
                <span className="sr-list-text">
                  <span className="sr-row-title sr-block">{item.label}</span>
                  <span className="sr-meta sr-block">{s.about[item.page]}</span>
                </span>
                <SrIcon name="chevronRight" size={18} />
              </RouteLink>
            </li>
          ))}
        </ul>
      </Card>
    </SettingsPage>
  );
}

const p = sunriseCopy.plan;
function PlanBody({ view }: { readonly view: PlanView }) {
  const [by, setBy] = useState<"project" | "helper">("project");
  const groupsProject = ["dated", "everyday", "none"] as const;
  const groupsHelper = ["agents", "specialists"] as const;
  const totalProject = view.byProject.reduce((n, r) => n + r.credits, 0);
  const totalHelper = view.byHelper.reduce((n, r) => n + r.used, 0);
  return (
    <>
      <Card title={p.thisMonth} action={<span className="sr-meta">{view.asOf}</span>}>
        <p className="sr-big">
          <span className="sr-metric">{number(view.creditsLeft)}</span> {p.left}
        </p>
        <Progress value={view.used} max={view.monthly} />
        <p className="sr-meta">{p.usedOf(view.used, view.monthly, view.renewsOn)}</p>
        <div className="sr-tiles">
          <div className="sr-tile">
            <p className="sr-figure-label">{p.usedSoFar}</p>
            <p className="sr-metric">{number(view.used)}</p>
            <p className="sr-meta">{view.dailyAverage}</p>
          </div>
          <div className="sr-tile">
            <p className="sr-figure-label">{p.projected(view.projectedOn)}</p>
            <p className="sr-metric">{view.projectedLeft}</p>
            <p className="sr-meta">{view.carryOver}</p>
          </div>
          <div className="sr-tile">
            <p className="sr-figure-label">{p.extra}</p>
            <p className="sr-metric">
              {view.extraCredits.enabled && view.extraCredits.upTo !== null
                ? p.extraOn(view.extraCredits.upTo)
                : p.extraOff}
            </p>
            <p className="sr-meta">{view.extraCredits.enabled ? "" : p.extraOffSub}</p>
          </div>
        </div>
        <p className="sr-help">{p.cameBack}</p>
      </Card>
      <Card title={p.yourPlan} action={<Badge kind="active" />}>
        <dl className="sr-pairs sr-pairs-wide">
          <div>
            <dt>{p.plan}</dt>
            <dd dir="auto">{view.planName}</dd>
          </div>
          <div>
            <dt>{p.paidThrough}</dt>
            <dd>{view.paidThrough === "shopify" ? p.paidShopify : p.paidMorrow}</dd>
          </div>
          <div>
            <dt>{p.creditsRow}</dt>
            <dd>{p.creditsEvery(view.monthly)}</dd>
          </div>
          <div>
            <dt>{p.renews}</dt>
            <dd>{view.renewsOn}</dd>
          </div>
          <div>
            <dt>{p.unused}</dt>
            <dd>{view.carryOver}</dd>
          </div>
        </dl>
        <p className="sr-help sr-with-icon">
          <SrIcon name="lock" size={16} />
          {p.ownerOnly(view.ownerName)} {p.extraNote}
        </p>
      </Card>
      <Card
        title={p.where}
        action={
          <SrTabs
            label={p.viewLabel}
            idPrefix="spend"
            tabs={[
              { id: "project", label: p.byProject },
              { id: "helper", label: p.byHelper },
            ]}
            selected={by}
            onSelect={(id) => setBy(id === "helper" ? "helper" : "project")}
          />
        }
        flush
      >
        <p className="sr-card-intro sr-meta">
          {p.whereSub(view.periodStart, view.used, view.asOf)}
        </p>
        <div
          id={`spend-panel-${by}`}
          role="tabpanel"
          aria-labelledby={`spend-tab-${by}`}
          className="sr-table-scroll"
          tabIndex={0}
        >
          {by === "project" ? (
            <table className="sr-table">
              <thead>
                <tr>
                  <th scope="col">{p.columns.project}</th>
                  <th scope="col">{p.columns.who}</th>
                  <th scope="col" className="sr-num">
                    {p.columns.used}
                  </th>
                </tr>
              </thead>
              {groupsProject.map((group) => (
                <tbody key={group}>
                  <tr className="sr-group-row">
                    <th scope="colgroup" colSpan={3}>
                      {p.groups[group]}
                    </th>
                  </tr>
                  {view.byProject
                    .filter((r) => r.group === group)
                    .map((r) => (
                      <tr key={r.name}>
                        <th scope="row">
                          <span className="sr-row-title sr-block" dir="auto">
                            {r.name}
                          </span>
                          <span className="sr-meta sr-block">{r.detail}</span>
                        </th>
                        <td dir="auto">{r.who}</td>
                        <td className="sr-num">
                          <span className="sr-row-title sr-block">{number(r.credits)}</span>
                          {r.planned ? <span className="sr-meta sr-block">{r.planned}</span> : null}
                        </td>
                      </tr>
                    ))}
                </tbody>
              ))}
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2}>
                    {p.total}
                  </th>
                  <td className="sr-num">
                    <span className="sr-row-title sr-block">{number(totalProject)}</span>
                    <span className="sr-meta sr-block">{p.totalOf(view.monthly)}</span>
                  </td>
                </tr>
              </tfoot>
            </table>
          ) : (
            <table className="sr-table">
              <thead>
                <tr>
                  <th scope="col">{p.columns.helper}</th>
                  <th scope="col">{p.columns.thinking}</th>
                  <th scope="col" className="sr-num">
                    {p.columns.ofLimit}
                  </th>
                </tr>
              </thead>
              {groupsHelper.map((group) => (
                <tbody key={group}>
                  <tr className="sr-group-row">
                    <th scope="colgroup" colSpan={3}>
                      {p.groups[group]}
                    </th>
                  </tr>
                  {view.byHelper
                    .filter((r) => r.group === group)
                    .map((r) => (
                      <tr key={r.name}>
                        <th scope="row">
                          <span className="sr-owner-cell">
                            <AgentAvatar
                              character={r.character}
                              size={32}
                              {...(r.prop ? { prop: r.prop } : {})}
                            />
                            <span>
                              <span className="sr-row-title">{r.name}</span>{" "}
                              <AgentPill character={r.character} />
                              <span className="sr-meta sr-block" dir="auto">
                                {r.where}
                              </span>
                            </span>
                          </span>
                        </th>
                        <td>
                          <ThinkingSummary choice={r.thinking} />
                        </td>
                        <td className="sr-num">
                          <span className="sr-row-title sr-block">
                            {r.limit === null ? number(r.used) : p.ofLimit(r.used, r.limit)}
                          </span>
                          {r.note ? <span className="sr-meta sr-block">{r.note}</span> : null}
                        </td>
                      </tr>
                    ))}
                </tbody>
              ))}
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2}>
                    {p.total}
                  </th>
                  <td className="sr-num">
                    <span className="sr-row-title sr-block">{number(totalHelper)}</span>
                    <span className="sr-meta sr-block">{p.totalOf(view.monthly)}</span>
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
        <p className="sr-footnote">{by === "project" ? p.projectNote : p.helperNote}</p>
      </Card>
      <Card title={p.uses}>
        <div className="sr-two-lists">
          <div>
            <h3 className="sr-subheading sr-with-icon">
              <span className="sr-glyph-tile sr-tone-neutral">
                <SrIcon name="coins" size={18} />
              </span>
              {p.usesYes}
            </h3>
            <ul className="sr-bullets">
              {p.usesList.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="sr-subheading sr-with-icon">
              <span className="sr-glyph-tile sr-tone-success">
                <SrIcon name="check" size={18} />
              </span>
              {p.usesNo}
            </h3>
            <ul className="sr-bullets">
              {p.freeList.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        </div>
      </Card>
      <Card title={p.limits}>
        <ul className="sr-bullets">
          {p.limitsList.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </Card>
    </>
  );
}

export function PlanCreditsScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const [plan, reload] = useRead(`${ws}|settings.plan`, () => services.port.settings.plan(ws));
  return (
    <SettingsPage
      workspaceId={ws}
      current="plan"
      title={p.title}
      scope={p.intro(workspace.displayName)}
    >
      {plan.kind === "ok" ? <PlanBody view={plan.value} /> : outcomeState(plan, reload)}
    </SettingsPage>
  );
}

const e = sunriseCopy.email;
function EmailBody({
  workspaceId,
  view,
}: {
  readonly workspaceId: string;
  readonly view: EmailAddressesView;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const fallback = view.addresses.find((x) => x.isDefault) ?? view.addresses[0] ?? null;
  const copy = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(e.copied);
    } catch {
      setCopied(e.copyFailed);
    }
  };
  return (
    <>
      <Card title={e.yours} flush>
        <ul className="sr-rows">
          {view.addresses.map((x) => (
            <li key={x.id} className="sr-address">
              <span className="sr-glyph-tile sr-tone-morrow">
                <SrIcon name="mail" size={18} />
              </span>
              <div className="sr-address-body">
                <p className="sr-address-line">
                  <span className="sr-row-title sr-address-text" dir="auto">
                    {x.address}
                  </span>
                  {x.isDefault ? <Badge kind="default" /> : null}
                  <Badge kind={x.status === "active" ? "ready" : "paused"} />
                </p>
                <p className="sr-reading">{e.morrowMade}</p>
                <p className="sr-meta">
                  <span className="sr-meta-label">{e.usedFor}</span> {e.usedForValue}
                </p>
                <dl className="sr-pairs">
                  <div>
                    <dt>{e.senderName}</dt>
                    <dd>
                      <span className="sr-block" dir="auto">
                        {x.displayName}
                      </span>
                      <span className="sr-help sr-block">{e.senderNameHint}</span>
                    </dd>
                  </div>
                  <div>
                    <dt>{e.answersGoTo}</dt>
                    <dd>
                      <span className="sr-block sr-address-text" dir="auto">
                        {view.supportAddress ?? e.answersNotSet}
                      </span>
                      <span className="sr-help sr-block">{e.answersHint}</span>
                    </dd>
                  </div>
                </dl>
                <p className="sr-help">{e.noDirect}</p>
              </div>
              <button
                type="button"
                className="sr-button sr-button-secondary"
                onClick={() => void copy(x.address)}
              >
                <SrIcon name="copy" size={18} />
                {e.copy}
              </button>
            </li>
          ))}
        </ul>
        <StatusRegion message={copied} />
      </Card>
      <Card title={e.link}>
        <p className="sr-reading">{e.linkIntro}</p>
        <ul className="sr-link-grid">
          {view.linkable.map((kind) => (
            <li key={kind} className="sr-inner">
              <p className="sr-row-title sr-with-icon">
                <SrIcon name={kind === "merchant_domain" ? "globe" : "mail"} size={18} />
                {e.linkable[kind]!.title}
              </p>
              <p className="sr-meta">{e.linkable[kind]!.body}</p>
              <ComingSoon label={e.linkable[kind]!.title} />
            </li>
          ))}
        </ul>
        {fallback ? <p className="sr-help">{e.until(fallback.address)}</p> : null}
      </Card>
      <Card title={e.defaultTitle}>
        <p className="sr-reading">{e.defaultIntro}</p>
        <fieldset className="sr-fieldset">
          <legend className="sr-label">{e.sendFrom}</legend>
          <div className="sr-options">
            {view.addresses.map((x) => (
              <label key={x.id} className={`sr-option${x.isDefault ? " is-checked" : ""}`}>
                <input
                  type="radio"
                  className="sr-radio"
                  name="default-sender"
                  checked={x.isDefault}
                  readOnly
                  disabled={!view.viewerIsOwner}
                />
                <span className="sr-option-text">
                  <span className="sr-option-name sr-address-text" dir="auto">
                    {x.address}
                  </span>
                  <span className="sr-option-about">{e.morrowAddress}</span>
                </span>
              </label>
            ))}
            <label className="sr-option is-off">
              <input type="radio" className="sr-radio" name="default-sender" disabled />
              <span className="sr-option-text">
                <span className="sr-option-name">{e.ownAddress}</span>
                <span className="sr-option-about">{e.ownAddressSoon}</span>
              </span>
            </label>
          </div>
        </fieldset>
        {view.viewerIsOwner ? null : (
          <p className="sr-help sr-with-icon">
            <SrIcon name="lock" size={16} />
            {e.defaultOwner(view.ownerName)}
          </p>
        )}
      </Card>
      <Card
        title={e.waiting}
        action={
          <RouteLink route="inbox" params={{ workspaceId }} className="sr-link">
            {e.seeInbox}
          </RouteLink>
        }
        flush
      >
        {view.waiting.length === 0 ? (
          <p className="sr-card-intro sr-muted">{e.waitingEmpty}</p>
        ) : (
          <ul className="sr-rows">
            {view.waiting.map((w) => (
              <li key={w.title} className="sr-list-row sr-list-row-status">
                <AgentAvatar character={w.character} size={32} />
                <div className="sr-list-text">
                  <p className="sr-row-title" dir="auto">
                    {w.title}
                  </p>
                  <p className="sr-meta">
                    {w.agentName} <AgentPill character={w.character} /> {w.where} · {w.expires}
                  </p>
                  <p className="sr-meta sr-address-text">{e.sendsFrom(w.sender)}</p>
                </div>
                <Badge kind="needs_review" />
              </li>
            ))}
          </ul>
        )}
        <p className="sr-footnote">{e.never}</p>
      </Card>
    </>
  );
}

export function EmailAddressesScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const [emails, reload] = useRead(`${ws}|settings.emailAddresses`, () =>
    services.port.settings.emailAddresses(ws),
  );
  return (
    <SettingsPage
      workspaceId={ws}
      current="email"
      title={e.title}
      scope={
        emails.kind === "ok" && !emails.value.viewerIsOwner
          ? e.memberIntro(emails.value.ownerName)
          : e.intro
      }
    >
      {emails.kind === "ok" ? (
        <EmailBody workspaceId={ws} view={emails.value} />
      ) : (
        outcomeState(emails, reload)
      )}
    </SettingsPage>
  );
}

export function PeopleRolesScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const [team, reload] = useRead(`${ws}|team`, () => services.port.team.overview(ws));
  return (
    <SettingsPage
      workspaceId={ws}
      current="people"
      title={sunriseCopy.people.title}
      scope={sunriseCopy.people.intro(workspace.displayName)}
    >
      {team.kind === "ok" ? (
        <Card title={sunriseCopy.team.people} flush>
          <ul className="sr-rows">
            {team.value.people.map((person) => (
              <PersonRow key={person.name} person={person} />
            ))}
          </ul>
          <p className="sr-footnote sr-with-icon">
            <SrIcon name="lock" size={16} />
            {sunriseCopy.team.ownerOnly}
          </p>
        </Card>
      ) : (
        outcomeState(team, reload)
      )}
    </SettingsPage>
  );
}
