// T7 PR 16: one agent's page (the Agent board): what it does, what it works toward and
// in, how it thinks, what it may do, its recent work, and in the aside its status, credits,
// permission and renewal, Shopify access, schedule and notes. Pause, Remove, Renew and
// editing notes wait for their backends and are not drawn as working buttons.
import { RouteLink } from "../components/controls";
import { StateView, outcomeState } from "../components/feedback";
import type { Id, WorkspaceView } from "../model";
import { useRead, useServices } from "../services";
import type { AgentDetailView } from "../team-model";
import { AgentAvatar } from "../sunrise/avatars";
import { number, sunriseCopy } from "../sunrise/copy";
import {
  AgentPill,
  Badge,
  Card,
  PageHeader,
  PermissionList,
  Progress,
  SrIcon,
  type SrIconName,
} from "../sunrise/parts";
import { ThinkingEditor, effortName, modelName } from "../sunrise/thinking";

const a = sunriseCopy.agent;
const scheduleIcon: Readonly<Record<AgentDetailView["schedule"][number]["icon"], SrIconName>> = {
  calendar: "calendar",
  repeat: "repeat",
  store: "store",
  task: "task",
  mention: "mention",
  idea: "idea",
};

function Main({
  workspaceId,
  view,
  reload,
}: {
  readonly workspaceId: Id;
  readonly view: AgentDetailView;
  readonly reload: () => void;
}) {
  return (
    <div className="sr-detail-main">
      <Card title={a.whatItDoes}>
        <p className="sr-reading" dir="auto">
          {view.about}
        </p>
      </Card>
      {view.worksToward ? (
        <Card title={a.worksToward}>
          <div className="sr-goal">
            <SrIcon name="tag" />
            <div className="sr-goal-text">
              <p className="sr-row-title" dir="auto">
                {view.worksToward.area} · {view.worksToward.goal} · {view.worksToward.percent}%
              </p>
              <p className="sr-meta">{view.worksToward.target}</p>
            </div>
            <Badge kind={view.worksToward.health} />
          </div>
          <Progress value={view.worksToward.percent} max={100} />
          <p className="sr-figure-text">
            {a.progress(view.worksToward.percent, view.worksToward.target)}
          </p>
          <p className="sr-meta">{view.worksToward.measuredBy}</p>
          <p className="sr-help">{a.goalNote}</p>
        </Card>
      ) : null}
      <Card title={a.worksIn} flush>
        <ul className="sr-rows">
          {view.worksIn.map((place) => (
            <li key={place.name} className="sr-list-row sr-list-row-status">
              <SrIcon name={place.status === "active" ? "tag" : "folder"} />
              <div className="sr-list-text">
                <p className="sr-row-title" dir="auto">
                  {place.name}
                </p>
                <p className="sr-meta" dir="auto">
                  {place.detail}
                </p>
              </div>
              <Badge kind={place.status} />
            </li>
          ))}
        </ul>
      </Card>
      <Card title={sunriseCopy.thinking.title}>
        <p className="sr-help">
          {sunriseCopy.thinking.intro(
            view.name,
            `${modelName(view.thinking.usual.model)} · ${effortName(view.thinking.usual.effort)}`,
          )}
        </p>
        <ThinkingEditor
          workspaceId={workspaceId}
          target={{ kind: "agent", id: view.agentId, name: view.name }}
          thinking={view.thinking}
          ownerName={view.ownerName}
          variant="card"
          onSaved={reload}
          onStale={reload}
        />
      </Card>
      <Card title={a.allowed}>
        <PermissionList permissions={view.permissions} />
        <p className="sr-help sr-rule-above">{a.stricter}</p>
      </Card>
      <Card title={a.recent} flush>
        {view.recentWork.length === 0 ? (
          <p className="sr-card-intro sr-muted">{a.recentEmpty}</p>
        ) : (
          <div className="sr-table-scroll" role="region" aria-label={a.recent} tabIndex={0}>
            <table className="sr-table">
              <thead>
                <tr>
                  <th scope="col">{a.columns.what}</th>
                  <th scope="col">{a.columns.where}</th>
                  <th scope="col">{a.columns.when}</th>
                  <th scope="col">{a.columns.result}</th>
                  <th scope="col" className="sr-num">
                    {a.columns.credits}
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.recentWork.map((row) => (
                  <tr key={row.what + row.when}>
                    <th scope="row" dir="auto">
                      {row.what}
                    </th>
                    <td dir="auto">{row.where}</td>
                    <td>{row.when}</td>
                    <td dir="auto">{row.result}</td>
                    <td className="sr-num">{number(row.credits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Aside({ view }: { readonly view: AgentDetailView }) {
  return (
    <div className="sr-detail-aside">
      <Card title={a.status} headingLevel={2}>
        <Badge kind={view.status} />
        <p className="sr-reading">{view.now}</p>
        <dl className="sr-lines sr-lines-stacked">
          {view.lastJob ? (
            <div>
              <dt>{a.lastJob}</dt>
              <dd dir="auto">{view.lastJob}</dd>
            </div>
          ) : null}
          {view.next ? (
            <div>
              <dt>{a.next}</dt>
              <dd dir="auto">{view.next}</dd>
            </div>
          ) : null}
        </dl>
      </Card>
      <Card title={a.credits}>
        <div className="sr-meter">
          <p className="sr-meter-row">
            <span>{a.thisMonth}</span>
            <span className="sr-figure-value">
              {view.creditsMonth.limit === null
                ? number(view.creditsMonth.used)
                : a.of(view.creditsMonth.used, view.creditsMonth.limit)}
            </span>
          </p>
          {view.creditsMonth.limit === null ? null : (
            <Progress value={view.creditsMonth.used} max={view.creditsMonth.limit} />
          )}
          <p className="sr-meta">{a.resets(view.creditsResetOn)}</p>
        </div>
        <div className="sr-meter">
          <p className="sr-meter-row">
            <span>{a.today}</span>
            <span className="sr-figure-value">
              {view.creditsToday.limit === null
                ? number(view.creditsToday.used)
                : a.of(view.creditsToday.used, view.creditsToday.limit)}
            </span>
          </p>
          {view.creditsToday.limit === null ? null : (
            <Progress value={view.creditsToday.used} max={view.creditsToday.limit} />
          )}
        </div>
        {view.creditsToday.limit !== null && view.creditsMonth.limit !== null ? (
          <p className="sr-help">
            {a.limitText(view.creditsToday.limit, view.creditsMonth.limit, view.name)}
          </p>
        ) : null}
      </Card>
      <Card title={a.permission}>
        <p className="sr-reading">
          {a.permissionFrom(view.permission.grantedBy, view.permission.grantedOn)}
        </p>
        <p className="sr-reading">{a.renewEvery}</p>
        <p className="sr-reading">
          {a.nextRenewal(view.permission.nextRenewal, view.permission.daysLeft)}
        </p>
        <p className="sr-help sr-with-icon">
          <SrIcon name="lock" size={16} />
          {a.renewBy(view.ownerName)}
        </p>
      </Card>
      <Card title={a.access}>
        {view.shopifyAccess.length === 0 ? (
          <p className="sr-help">{a.noAccess}</p>
        ) : (
          <ul className="sr-icon-list">
            {view.shopifyAccess.map((item) => (
              <li key={item.text}>
                <SrIcon name={item.has ? "check" : "slash"} size={18} />
                <span dir="auto">{item.text}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={a.when}>
        <ul className="sr-icon-list">
          {view.schedule.map((item) => (
            <li key={item.title}>
              <SrIcon name={scheduleIcon[item.icon]} size={18} />
              <span>
                <span className="sr-row-title" dir="auto">
                  {item.title}
                </span>
                {item.detail ? (
                  <span className="sr-meta sr-block" dir="auto">
                    {item.detail}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        <p className="sr-help">{a.whenNote}</p>
      </Card>
      <Card title={a.notes}>
        <p className="sr-help">{a.notesIntro(view.name)}</p>
        {view.notes.length === 0 ? (
          <p className="sr-help">{a.notesEmpty}</p>
        ) : (
          <ul className="sr-note-list">
            {view.notes.map((note) => (
              <li key={note} dir="auto">
                {note}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function AgentScreen({
  workspace,
  agentId,
}: {
  readonly workspace: WorkspaceView;
  readonly agentId: Id;
}) {
  const services = useServices();
  const ws = workspace.id;
  const [agent, reload] = useRead(`${ws}|team.agent|${agentId}`, () =>
    services.port.team.agent(ws, agentId),
  );
  const parent = { route: "agents", label: a.breadcrumb };
  if (agent.kind !== "ok")
    return (
      <div className="sr">
        <PageHeader workspaceId={ws} parent={parent} title={sunriseCopy.team.title} />
        {agent.kind === "not_found" ? <StateView kind="not_found" /> : outcomeState(agent, reload)}
      </div>
    );
  const view = agent.value;
  // Ask is the Listings agent's run on picked products today (M3 PR-2).
  const giveTask =
    view.character === "listings" && services.composed["runs.admit"] ? (
      <RouteLink route="ask" params={{ workspaceId: ws }} className="sr-button sr-button-primary">
        {a.giveTask(view.name)}
      </RouteLink>
    ) : null;
  return (
    <div className="sr">
      <PageHeader
        workspaceId={ws}
        parent={parent}
        title={view.name}
        lead={<AgentAvatar character={view.character} size={56} />}
        after={
          <>
            <AgentPill character={view.character} />
            <Badge kind={view.status} />
          </>
        }
        actions={giveTask}
        scope={a.addedBy(view.addedBy, view.addedOn, view.worksIn.length)}
      />
      <div className="sr-detail-layout">
        <Main workspaceId={ws} view={view} reload={reload} />
        <Aside view={view} />
      </div>
    </div>
  );
}
