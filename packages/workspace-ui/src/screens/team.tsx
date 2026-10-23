// T7 PR 16: Team (the Team board): Morrow, the added agents, the one-time specialists and
// the people, each with what it may do. "Change" opens how a helper thinks; only someone the
// server allows sees it. Fixture data only in this build (team.overview is uncomposed over
// HTTP, so the page shows "not built yet").
import { useState, type ReactNode } from "react";
import { RouteLink } from "../components/controls";
import { StatusRegion, outcomeState } from "../components/feedback";
import type { WorkspaceView } from "../model";
import { useRead, useServices } from "../services";
import type {
  ActivityLineView,
  AgentSummaryView,
  TeamPersonView,
  TeamView,
  ThinkingChoice,
  ThinkingView,
} from "../team-model";
import { AgentAvatar, PersonAvatar } from "../sunrise/avatars";
import { number, sunriseCopy } from "../sunrise/copy";
import { AgentPill, Badge, Card, PageHeader, Progress, SrIcon } from "../sunrise/parts";
import {
  ThinkingDialog,
  ThinkingSummary,
  choiceText,
  type ThinkingTarget,
} from "../sunrise/thinking";

const c = sunriseCopy.team;

export function Lines({ lines }: { readonly lines: readonly ActivityLineView[] }) {
  return (
    <dl className="sr-lines">
      {lines.map((line) => (
        <div key={line.label + line.text}>
          <dt>{c.lines[line.label]}</dt>
          <dd dir="auto">{line.text}</dd>
        </div>
      ))}
    </dl>
  );
}

function ThinkingCell({
  choice,
  canChange,
  label,
  onChange,
}: {
  readonly choice: ThinkingChoice;
  readonly canChange: boolean;
  readonly label: string;
  readonly onChange: () => void;
}) {
  return (
    <div className="sr-figure">
      <p className="sr-figure-label">{c.model}</p>
      <p className="sr-figure-text">
        <ThinkingSummary choice={choice} />
        {canChange ? (
          <>
            {" "}
            <button type="button" className="sr-text-button" aria-label={label} onClick={onChange}>
              {sunriseCopy.thinking.change}
            </button>
          </>
        ) : null}
      </p>
    </div>
  );
}

function CreditsCell({ used, limit }: { readonly used: number; readonly limit: number | null }) {
  return (
    <div className="sr-figure">
      <p className="sr-figure-label">{c.creditsThisMonth}</p>
      <p className="sr-figure-value">
        {limit === null ? number(used) : sunriseCopy.agent.of(used, limit)}
      </p>
      {limit === null ? null : <Progress value={used} max={limit} />}
    </div>
  );
}

function Who({
  avatar,
  name,
  tags,
  about,
  status,
  worksIn,
}: {
  readonly avatar: ReactNode;
  readonly name: ReactNode;
  readonly tags: ReactNode;
  readonly about: string;
  readonly status: ReactNode;
  readonly worksIn: ReactNode;
}) {
  return (
    <div className="sr-who">
      {avatar}
      <div className="sr-who-text">
        <p className="sr-who-name">
          {name}
          {tags}
        </p>
        <p className="sr-reading" dir="auto">
          {about}
        </p>
        <div className="sr-who-status">{status}</div>
        <p className="sr-meta">
          <span className="sr-meta-label">{c.worksIn}</span> {worksIn}
        </p>
      </div>
    </div>
  );
}

function AgentRow({
  workspaceId,
  agent,
  onChange,
}: {
  readonly workspaceId: string;
  readonly agent: AgentSummaryView;
  readonly onChange: () => void;
}) {
  return (
    <li className="sr-team-row">
      <Who
        avatar={<AgentAvatar character={agent.character} size={40} />}
        name={
          <RouteLink
            route="agent"
            params={{ workspaceId, installationId: agent.agentId }}
            className="sr-name-link"
          >
            {agent.name}
          </RouteLink>
        }
        tags={<AgentPill character={agent.character} />}
        about={agent.summary}
        status={<Badge kind={agent.status} />}
        worksIn={agent.worksIn.join(", ")}
      />
      <Lines lines={agent.lines} />
      <div className="sr-figures">
        <CreditsCell used={agent.credits.used} limit={agent.credits.limit} />
        <ThinkingCell
          choice={agent.thinking}
          canChange={agent.thinking.canChange}
          label={sunriseCopy.thinking.changeLabel(agent.name)}
          onChange={onChange}
        />
      </div>
    </li>
  );
}

export function PersonRow({ person }: { readonly person: TeamPersonView }) {
  return (
    <li className="sr-team-row sr-person-row">
      <div className="sr-who">
        <PersonAvatar initials={person.initials} presence={person.presence} />
        <div className="sr-who-text">
          <p className="sr-who-name">
            <span dir="auto">{person.name}</span>
            {person.isViewer ? <span className="sr-muted"> {c.you}</span> : null}
          </p>
          <p className="sr-meta">
            {sunriseCopy.roles[person.role]} · {sunriseCopy.presence[person.presence]}
          </p>
        </div>
      </div>
      <dl className="sr-lines">
        <div>
          <dt>{c.canApprove}</dt>
          <dd dir="auto">
            {person.canApprove}
            {person.approveGivenBy ? ` · ${c.givenBy(person.approveGivenBy)}` : ""}
          </dd>
        </div>
      </dl>
    </li>
  );
}

interface Editing {
  readonly target: ThinkingTarget;
  readonly thinking: ThinkingView;
}

function TeamBody({
  workspaceId,
  view,
  reload,
}: {
  readonly workspaceId: string;
  readonly view: TeamView;
  readonly reload: () => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const open = (target: ThinkingTarget, thinking: ThinkingView) => {
    setMessage(null);
    setEditing({ target, thinking });
  };
  const saved = (choice: ThinkingChoice) => {
    const target = editing?.target;
    setEditing(null);
    reload();
    if (target)
      setMessage(
        target.kind === "specialists"
          ? sunriseCopy.thinking.savedSpecialists(choiceText(choice))
          : sunriseCopy.thinking.saved(target.name, choiceText(choice)),
      );
  };
  const morrow = view.morrow;
  return (
    <>
      <StatusRegion message={message} />
      <Card title={c.mainAgent} flush>
        <ul className="sr-rows">
          <li className="sr-team-row">
            <Who
              avatar={<AgentAvatar character="morrow" size={40} />}
              name={<span>Morrow</span>}
              tags={
                <>
                  <AgentPill character="morrow" />
                  <span className="sr-muted sr-small">{c.mainAgentTag}</span>
                </>
              }
              about={c.morrowAbout}
              status={<Badge kind={morrow.status} />}
              worksIn={c.morrowWorksIn}
            />
            <Lines lines={morrow.lines} />
            <div className="sr-figures">
              <CreditsCell used={morrow.creditsThisMonth} limit={null} />
              <ThinkingCell
                choice={morrow.thinking}
                canChange={morrow.thinking.canChange}
                label={sunriseCopy.thinking.changeLabel("Morrow")}
                onChange={() => open({ kind: "morrow", name: "Morrow" }, morrow.thinking)}
              />
            </div>
          </li>
        </ul>
      </Card>
      <Card
        title={
          <>
            {c.agents} <span className="sr-count">{view.agents.length}</span>
          </>
        }
        action={
          <RouteLink
            route="settings_section"
            params={{ workspaceId, section: "usage" }}
            className="sr-link"
          >
            {c.spending}
          </RouteLink>
        }
        flush
      >
        {view.agents.length === 0 ? (
          <div className="sr-empty">
            <AgentAvatar character="listings" size={72} />
            <h3 className="sr-empty-title">{c.agentsEmpty}</h3>
            <p className="sr-empty-body">{c.agentsEmptyBody}</p>
          </div>
        ) : (
          <ul className="sr-rows">
            {view.agents.map((agent) => (
              <AgentRow
                key={agent.agentId}
                workspaceId={workspaceId}
                agent={agent}
                onChange={() =>
                  open({ kind: "agent", id: agent.agentId, name: agent.name }, agent.thinking)
                }
              />
            ))}
          </ul>
        )}
        <p className="sr-footnote sr-with-icon">
          <SrIcon name="info" size={16} />
          {c.titleNote}
        </p>
      </Card>
      <Card
        title={
          <>
            {c.specialists} <span className="sr-count">{view.specialists.length}</span>
          </>
        }
        flush
      >
        <p className="sr-card-intro">{c.specialistsIntro}</p>
        {view.specialists.length === 0 ? (
          <p className="sr-card-intro sr-muted">{c.specialistsEmpty}</p>
        ) : (
          <ul className="sr-rows">
            {view.specialists.map((s) => (
              <li key={s.name} className="sr-team-row">
                <Who
                  avatar={<AgentAvatar character="specialist" prop={s.prop} size={40} />}
                  name={<span dir="auto">{s.name}</span>}
                  tags={<AgentPill character="specialist" />}
                  about={s.summary}
                  status={<Badge kind={s.status} />}
                  worksIn={s.worksIn}
                />
                <Lines lines={s.lines} />
                <div className="sr-figures">
                  <div className="sr-figure">
                    <p className="sr-figure-label">{c.model}</p>
                    <p className="sr-figure-text">
                      <ThinkingSummary choice={s.thinking} />
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="sr-team-row sr-default-row">
          <div className="sr-who-text">
            <h3 className="sr-subheading">{c.newSpecialists}</h3>
            <p className="sr-help">{c.newSpecialistsIntro}</p>
          </div>
          <ThinkingCell
            choice={view.specialistDefault}
            canChange={view.specialistDefault.canChange}
            label={sunriseCopy.thinking.dialogTitleSpecialists}
            onChange={() =>
              open({ kind: "specialists", name: c.newSpecialists }, view.specialistDefault)
            }
          />
        </div>
      </Card>
      <Card
        title={
          <>
            {c.people} <span className="sr-count">{view.people.length}</span>
          </>
        }
        flush
      >
        <ul className="sr-rows">
          {view.people.map((person) => (
            <PersonRow key={person.name} person={person} />
          ))}
        </ul>
        <p className="sr-footnote sr-with-icon">
          <SrIcon name="lock" size={16} />
          {c.ownerOnly}
        </p>
      </Card>
      {editing ? (
        <ThinkingDialog
          open
          workspaceId={workspaceId}
          target={editing.target}
          thinking={editing.thinking}
          ownerName={view.ownerName}
          onClose={() => setEditing(null)}
          onSaved={saved}
          onStale={reload}
        />
      ) : null}
    </>
  );
}

export function TeamScreen({ workspace }: { readonly workspace: WorkspaceView }) {
  const services = useServices();
  const ws = workspace.id;
  const [team, reload] = useRead(`${ws}|team`, () => services.port.team.overview(ws));
  return (
    <div className="sr">
      <PageHeader
        workspaceId={ws}
        title={c.title}
        actions={
          team.kind === "ok" && team.value.canAddAgents ? (
            <RouteLink
              route="agent_store"
              params={{ workspaceId: ws }}
              className="sr-button sr-button-primary"
            >
              <SrIcon name="plus" />
              {c.addAgents}
            </RouteLink>
          ) : null
        }
        scope={c.intro(team.kind === "ok" ? team.value.shopName : workspace.displayName)}
      />
      {team.kind === "ok" ? (
        <TeamBody workspaceId={ws} view={team.value} reload={reload} />
      ) : (
        outcomeState(team, reload)
      )}
    </div>
  );
}
